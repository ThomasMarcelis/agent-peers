// Explicit, scoped stable names (docs/reference.md, "Names"). One session or conversation claims
// <kind>:<scope>/<claim>; a sender resolves it when it sends, to whoever holds it at that moment. A
// name nobody claimed is not-found and a holder that stopped is not-running: never anyone else.
//
// One file per name under $AGENT_PEERS_HOME/names/. A new file is published with link(), which fails
// if the name exists; a replacement or removal renames the file aside and checks it is still the
// inode that was read (compare-and-swap). There is no lock and no daemon.

import { createHash, randomUUID } from "node:crypto";
import { linkSync, lstatSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { CLAIMED_NAME, SendFailure } from "./status.mjs";
import {
  alive, claudeSessions, codexPeers, ensurePrivateDir, generation, inDiscoveryScope, peerSocket, peersHome, processStarts, readPeerFile,
  safeDirectory, safeText, scoped, validPid, validSocketPath, validThreadId,
} from "./wire.mjs";

const KINDS = ["claude", "codex", "hermes"];
export const SCOPE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const CLAIM = /^[a-z0-9][a-z0-9_.-]{0,63}$/, HEX16 = /^[a-f0-9]{16}$/, FILE = /^n-[a-f0-9]{32}\.json$/;
const HERMES_SOCKET = /^hermes-[a-f0-9]{32}\.sock$/;
const NAMES_PER_OWNER = 8, SCAN_MAX = 1024, ATTEMPTS = 3;
const GRAMMAR = "<kind>:<scope>/<claim>, with kind claude, codex or hermes, scope [a-z0-9][a-z0-9_-]{0,63} and claim [a-z0-9][a-z0-9_.-]{0,63}";
const HOLDER = { claude: "a Claude session", codex: "a Codex session", hermes: "a Hermes conversation" };

// A `to` that names a claim rather than an inbox address or an automatic name.
export const isClaimedTarget = (to) => typeof to === "string" && !to.startsWith("uds:") && to.includes("/");

// A full or kind-elided name, checked against the grammar exactly: no case folding, one "/", no
// ":" in the scope or claim. `kind` fills in an elided kind.
export function parseName(text, kind) {
  const invalid = () => new SendFailure("invalid-request",
    `${JSON.stringify(String(text).slice(0, 200))} is not a claimed name; a claimed name is ${GRAMMAR}`);
  if (typeof text !== "string" || text.length > 200) throw invalid();
  const colon = text.indexOf(":"), named = colon < 0 ? undefined : text.slice(0, colon);
  if (named !== undefined && !KINDS.includes(named)) throw invalid();
  const parts = (named === undefined ? text : text.slice(colon + 1)).split("/");
  if (parts.length !== 2 || !SCOPE.test(parts[0]) || !CLAIM.test(parts[1])) throw invalid();
  const resolved = named ?? kind;
  return { kind: resolved, scope: parts[0], claim: parts[1], elided: named === undefined,
    name: resolved ? `${resolved}:${parts[0]}/${parts[1]}` : undefined };
}

const directory = () => join(resolve(peersHome()), "names");
const fileName = (name) => `n-${createHash("sha256").update(name).digest("hex").slice(0, 32)}.json`;

// The fields agent-peers keeps about a holder, in one order, so two holders compare as text.
const holderFields = (kind, h) => ({
  pid: h.pid, ...(h.procStart !== undefined ? { procStart: h.procStart } : {}), autoName: h.autoName,
  ...(kind === "claude" ? { socket: h.socket } : {}), ...(kind === "codex" ? { threadId: h.threadId } : {}), addresses: h.addresses,
});

// A record as written, or undefined when it does not belong in this file or has invalid fields.
// Unknown fields are ignored.
function validRecord(value, file) {
  const h = value?.holder, kind = typeof value?.name === "string" ? value.name.slice(0, value.name.indexOf(":")) : undefined;
  if (!Number.isInteger(value.v) || value.v < 1 || !CLAIMED_NAME.test(value.name ?? "") || fileName(value.name) !== basename(file) ||
      value.kind !== kind || !HEX16.test(value.owner ?? "") || !HEX16.test(value.generation ?? "") ||
      !Number.isSafeInteger(value.claimedAt) || value.claimedAt < 0 ||
      !h || typeof h !== "object" || Array.isArray(h) || !validPid(h.pid) || !safeText(h.autoName, 160) ||
      (h.procStart !== undefined && !safeText(h.procStart, 64)) || !Array.isArray(h.addresses) || h.addresses.length > 16 ||
      !h.addresses.every((addr) => typeof addr === "string" && addr.startsWith("uds:") && addr.length <= 1004) ||
      (kind === "claude" && !validSocketPath(h.socket)) || (kind === "codex" && !validThreadId(h.threadId))) return undefined;
  return { name: value.name, kind, owner: value.owner, generation: value.generation, claimedAt: value.claimedAt, holder: holderFields(kind, h) };
}

// The names directory when it exists and is private; undefined when it does not exist yet.
function existingDirectory() {
  const dir = directory();
  try { return safeDirectory(dir, true); }
  catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
}

function readName(name) {
  let dir;
  try { dir = existingDirectory(); } catch { return undefined; }
  if (!dir) return undefined;
  const file = join(dir, fileName(name));
  try { return validRecord(readPeerFile(file).record, file); } catch { return undefined; }
}

// Every valid record, at most SCAN_MAX files, read once per discovery scope.
const scan = () => scoped("claims", () => {
  let dir, files = [];
  try { dir = existingDirectory(); if (dir) files = readdirSync(dir).filter((f) => FILE.test(f)).sort().slice(0, SCAN_MAX); } catch {}
  return files.flatMap((f) => {
    try { const record = validRecord(readPeerFile(join(dir, f)).record, join(dir, f)); return record ? [record] : []; }
    catch { return []; }
  });
});

// The running holder of a record, as { name, addresses }, or undefined. Claude and Codex holders
// are checked against their live registries, which also give their current addresses; a Hermes
// holder has no registry, so its bridge must still run and every recorded inbox must still exist.
function live(record) {
  const h = record.holder;
  if (record.kind === "claude") {
    const s = claudeSessions().find((peer) => peer.pid === h.pid && peer.generation === record.generation);
    return s && { name: s.name, addresses: [s.address] };
  }
  if (record.kind === "codex") {
    const p = codexPeers().find((peer) => peer.threadId === h.threadId && peer.generation === record.generation);
    return p && { name: p.name, addresses: [...new Set([p.address, ...p.addresses])] };
  }
  if (!alive(h.pid) || !h.addresses.length) return undefined;
  const start = processStarts([h.pid]).get(h.pid);
  if (h.procStart !== undefined && start !== undefined && start !== h.procStart) return undefined;
  const inboxes = h.addresses.every((addr) => {
    const path = peerSocket(addr);
    if (!path || !HERMES_SOCKET.test(basename(path))) return false;
    try { return lstatSync(path).isSocket(); } catch { return false; }
  });
  return inboxes ? { name: h.autoName, addresses: h.addresses } : undefined;
}

// The record in a name's file and that file's identity; `record` is undefined for an invalid file,
// which a claim may replace.
function slot(file) {
  let st;
  try { st = lstatSync(file); } catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
  if (!st.isFile() && !st.isSymbolicLink()) throw new Error(`unsafe names entry ${file}`);
  try {
    const { record, dev, ino } = readPeerFile(file);
    return { dev, ino, record: validRecord(record, file) };
  } catch { return { dev: st.dev, ino: st.ino, record: undefined }; }
}

function temporaryRecord(dir, record) {
  const path = join(dir, `.t-${randomUUID()}.json`);
  writeFileSync(path, JSON.stringify(record), { mode: 0o600, flag: "wx" });
  return path;
}

// Publish a new file; "retry" when a name file appeared meanwhile.
function create(file, record) {
  const temporary = temporaryRecord(dirname(file), record);
  try { linkSync(temporary, file); return "done"; }
  catch (error) { if (error.code === "EEXIST") return "retry"; throw error; }
  finally { rmSync(temporary, { force: true }); }
}

// Replace (or, without `next`, remove) the file that was read as `expected`. "retry" when it is
// gone; "conflict" when someone replaced it after it was read, whose record is put back.
function swap(file, expected, next) {
  const dir = dirname(file), reaped = join(dir, `.reap-${randomUUID()}.json`), temporary = next && temporaryRecord(dir, next);
  try {
    try { renameSync(file, reaped); }
    catch (error) { if (error.code === "ENOENT") return "retry"; throw error; }
    const st = lstatSync(reaped);
    if (st.dev !== expected.dev || st.ino !== expected.ino) {
      try { linkSync(reaped, file); } catch {}
      return "conflict";
    }
    if (!temporary) return "done";
    try { linkSync(temporary, file); return "done"; }
    catch (error) { if (error.code === "EEXIST") return "conflict"; throw error; }
  } finally {
    rmSync(reaped, { force: true });
    if (temporary) rmSync(temporary, { force: true });
  }
}

// One result for claims and releases: status is claimed, refreshed, taken-over, released or refused.
export const claimResult = (status, fields = {}) => ({ status, reason: null, name: null, kind: null, generation: null, address: null,
  previous: null, text: "", ...fields });
export const claimRefusal = (reason, text, fields = {}) => claimResult("refused", { ...fields, reason, text });

// A Claude session claims for its process (claudeSessionAt): the owner is its PID and start, and
// the generation is the core one, which adds its socket, so the claim survives /clear and /resume.
export const claudeClaimant = (s) => ({ kind: "claude", owner: generation("claude", s.pid, s.procStart), generation: s.generation,
  address: s.address, holder: { pid: s.pid, procStart: s.procStart, autoName: s.name, socket: s.socket, addresses: [s.address] } });

const previousOf = (record) => {
  const holder = live(record);
  return { holder: holder?.name ?? record.holder.autoName, generation: record.generation, running: Boolean(holder) };
};

// Claim a name for `claimant`: { kind, owner, generation, address, holder, scope? }. The owner is the
// stable claimant (a Claude process, a Codex thread, a Hermes profile conversation) and the
// generation is the process holding the name now. The same owner or generation refreshes; another
// owner takes the name only from a holder that is not running.
export function claim(text, claimant) {
  return inDiscoveryScope(() => {
    const parsed = parseName(text, claimant.kind), fields = { name: parsed.name, kind: parsed.kind };
    if (parsed.kind !== claimant.kind) {
      return claimRefusal("scope-denied", `${HOLDER[claimant.kind]} can claim only ${claimant.kind}: names, not ${parsed.name}.`, fields);
    }
    if (claimant.scope !== undefined && parsed.scope !== claimant.scope) {
      return claimRefusal("scope-denied", `Names claimed in this Hermes profile are hermes:${claimant.scope}/<claim>, not ${parsed.name}.`, fields);
    }
    ensurePrivateDir(peersHome());
    const file = join(ensurePrivateDir(directory()), fileName(parsed.name));
    const next = { v: 1, name: parsed.name, kind: parsed.kind, owner: claimant.owner, generation: claimant.generation,
      claimedAt: Date.now(), holder: holderFields(parsed.kind, claimant.holder) };
    const mine = { ...fields, generation: claimant.generation, address: claimant.address };
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const current = slot(file), record = current?.record;
      const ours = Boolean(record) && (record.owner === claimant.owner || record.generation === claimant.generation);
      const previous = record ? previousOf(record) : null;
      if (record && !ours && previous.running) {
        return claimRefusal("name-held", `${parsed.name} is held by ${previous.holder}, which is running; only its holder can release it.`,
          { ...fields, generation: record.generation, previous });
      }
      if (!ours && scan().filter((r) => r.owner === claimant.owner && r.name !== parsed.name).length >= NAMES_PER_OWNER) {
        return claimRefusal("too-many-names", `This session already holds ${NAMES_PER_OWNER} names; release one before claiming another.`, fields);
      }
      if (ours && record.owner === next.owner && record.generation === next.generation &&
          JSON.stringify(record.holder) === JSON.stringify(next.holder)) {
        return claimResult("refreshed", { ...mine, previous, text: `${parsed.name} already names this session.` });
      }
      const outcome = current ? swap(file, current, next) : create(file, next);
      if (outcome === "retry") continue;
      if (outcome === "conflict") break;
      if (ours) return claimResult("refreshed", { ...mine, previous, text: `Refreshed ${parsed.name}; it names this session again.` });
      if (record) {
        return claimResult("taken-over", { ...mine, previous,
          text: `Took over ${parsed.name} from ${previous.holder} (generation ${previous.generation}), which is no longer running.` });
      }
      return claimResult("claimed", { ...mine, text: `Claimed ${parsed.name}; senders now reach this session by that name.` });
    }
    return claimRefusal("conflict", `${parsed.name} changed while this claim ran; try again.`, fields);
  });
}

// Remove a name: its holder (the same owner or generation) may, and anyone may once the holder is
// not running. `claimant` is undefined outside a session; `kind` fills in an elided kind.
export function release(text, claimant, kind = claimant?.kind) {
  return inDiscoveryScope(() => {
    const parsed = parseName(text, kind), fields = { name: parsed.name, kind: parsed.kind };
    const dir = existingDirectory(), file = dir && join(dir, fileName(parsed.name));
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const current = file && slot(file), record = current?.record;
      if (!current) return claimRefusal("not-found", `No session has claimed ${parsed.name}.`, fields);
      const ours = Boolean(claimant && record) && (record.owner === claimant.owner || record.generation === claimant.generation);
      const previous = record ? previousOf(record) : null;
      if (record && !ours && previous.running) {
        return claimRefusal("not-holder", `${parsed.name} is held by ${previous.holder}, which is running; only its holder can release it.`,
          { ...fields, generation: record.generation, previous });
      }
      const outcome = swap(file, current, undefined);
      if (outcome === "retry") continue;
      if (outcome === "conflict") break;
      return claimResult("released", { ...fields, generation: record?.generation ?? null, previous, text: `Released ${parsed.name}.` });
    }
    return claimRefusal("conflict", `${parsed.name} changed while this release ran; nothing was removed. Try again.`, fields);
  });
}

// The live holder of a claimed name at send time: its address in `directory` when it has one there,
// else its first address. A kind-elided name resolves only when exactly one kind has a record, live
// or not.
export function resolveClaim(to, { directory: preferred } = {}) {
  return inDiscoveryScope(() => {
    const parsed = parseName(to);
    const found = parsed.elided ? KINDS.map((kind) => readName(`${kind}:${parsed.scope}/${parsed.claim}`)).filter(Boolean) : [readName(parsed.name)].filter(Boolean);
    if (found.length > 1) throw new SendFailure("ambiguous", `"${to}" is ambiguous: ${found.map((r) => r.name).join(", ")}; use the full name`);
    const [record] = found;
    if (!record) {
      throw new SendFailure("not-found", `No session has claimed ${parsed.name ?? `"${to}"`}. Its holder must claim it ` +
        "(Claude: agent-peers claim; Codex or Hermes: claim_name). Nothing was sent.");
    }
    const holder = live(record);
    if (!holder) {
      throw new SendFailure("not-running", `${record.name} is claimed by ${record.holder.autoName}, ${HOLDER[record.kind]} that is no longer running ` +
        `(claimed ${new Date(record.claimedAt).toISOString()}, generation ${record.generation}). Nothing was sent. The new session must claim it.`);
    }
    const usable = holder.addresses.filter((addr) => peerSocket(addr));
    const target = (preferred && usable.find((addr) => dirname(peerSocket(addr)) === preferred)) || usable[0];
    if (!target) throw new SendFailure("inbox-unavailable", `${record.name} is held by ${holder.name}, which has no usable inbox address. Nothing was sent.`);
    return { kind: record.kind, name: record.name, address: target, socket: peerSocket(target), addresses: usable, generation: record.generation,
      holder: holder.name, claimed: true };
  });
}

// Every claimed name, running or not, for listings. Dead names stay until claimed again or released.
export const claimRows = ({ directory: preferred } = {}) => inDiscoveryScope(() => scoped(`claimRows\0${preferred ?? ""}`, () => scan().map((r) => {
  const holder = live(r), addresses = holder ? holder.addresses.filter((addr) => peerSocket(addr)) : [];
  return { name: r.name, kind: r.kind, running: Boolean(holder),
    address: (preferred && addresses.find((addr) => dirname(peerSocket(addr)) === preferred)) || addresses[0] || null,
    addresses, generation: r.generation, holder: holder?.name ?? null, claimedAt: r.claimedAt };
}).sort((a, b) => (a.name < b.name ? -1 : 1))));

// The names a running session of this kind and generation holds.
export const heldBy = (kind, gen) => claimRows().filter((row) => row.running && row.kind === kind && row.generation === gen).map((row) => row.name);

// Listing rows with the names each session holds.
export const withClaims = (rows) => inDiscoveryScope(() => rows.map((row) => ({ ...row, claims: heldBy(row.kind, row.generation) })));

// The name a verified, running claim holds at this inbox address, for a recipient's frame. A record
// that names the address but whose holder is not running is ignored.
export const claimAt = (addr) => claimRows().find((row) => row.running && row.addresses.includes(addr))?.name;

// Whether the record for `name` is held by this generation: a recipient checking a name a sender
// says it used. The recipient is that generation, so it is running.
export const holds = (name, gen) => readName(name)?.generation === gen;

// The names an owner or a generation holds on disk, running or not: what a restarted claimant
// refreshes, and what a Hermes route still holds after its conversation's id changed.
export const claimsOf = ({ owner, generation }) => inDiscoveryScope(() => scan()
  .filter((r) => r.owner === owner || (generation !== undefined && r.generation === generation)).map((r) => r.name));
