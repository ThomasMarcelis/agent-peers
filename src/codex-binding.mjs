// Which root Codex threads this codex-peer process serves, their registry records and their reply
// inboxes. One process can serve several roots: Codex TUI /new and resume keep one MCP process
// across threads, so a call from one root never closes another root's inbox.

import { randomUUID } from "node:crypto";
import { lstatSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { AppServer, daemonSocket } from "./app-server.mjs";
import { bindDelayMs, bindReporter } from "./bind-retry.mjs";
import { Admission, checkSocketPath, closeInbox, listenInbox, ownsSocket } from "./inbox.mjs";
import { errorFields, logEvent, logIdentity } from "./logging.mjs";
import { VERSION } from "./version.mjs";
import {
  address, codexPeers, ensurePrivateDir, generation, isSafePeerRecord, peerSocket, peersHome, processStart, readPeerRecord,
  recordRunning, slug, socketDir, socketDirectories, validThreadId,
} from "./wire.mjs";

export { ownsSocket };
const log = (event, fields = {}) => logEvent("codex-peer", event, fields);
export const app = new AppServer();

const INBOXES_MAX = 16, ROOTS_MAX = 8, CONNECTION_MAX = 32;
const START = processStart(process.pid);
const replaced = () => new Error("this inbox was replaced; restart this MCP connection");

// root threadId -> { threadId, rootId, name, subagent: false, registry, token, socket, address, identity, inboxes, ... }
export const roots = new Map();
export const isCurrent = (root) => roots.get(root?.threadId) === root;
let handler = () => {};
export const onInboxLine = (fn) => { handler = fn; };

let binding = Promise.resolve();
export const bind = (meta) => (binding = binding.then(() => bindNow(meta), () => bindNow(meta)));

// Codex names the thread in each tool call's _meta.threadId; bindAtStart finds it earlier from
// the daemon's report of which thread runs this process. Guessing, say by cwd, can bind to
// another session's thread.
async function bindNow(meta) {
  const threadId = meta?.threadId;
  if (!validThreadId(threadId)) throw new Error("Codex did not identify this session with a valid thread ID");
  const bound = roots.get(threadId);
  if (bound) {
    await inboxFor(bound, dirname(bound.socket));
    for (const directory of bound.inboxes.keys()) await inboxFor(bound, directory);
    return bound;
  }
  const { t, rootId, name, loaded } = await resolveThread(threadId);
  if (rootId !== threadId) {
    // Codex refuses input for sub-agent threads, so a sub-agent sends under its root session's
    // address and replies land there, as with Claude sub-agents.
    if (!roots.has(rootId)) log("inbox.bound", { threadId: logIdentity(threadId), rootId: logIdentity(rootId), outcome: "native_only" });
    return { threadId, rootId, name, subagent: true };
  }
  if (roots.size >= ROOTS_MAX) {
    // Room for another root comes only from roots whose threads the app-server no longer has.
    for (const root of [...roots.values()]) if (!loaded.has(root.threadId)) unbind(root);
    if (roots.size >= ROOTS_MAX) throw new Error(`this agent-peers process already serves ${ROOTS_MAX} Codex sessions; restart its MCP server`);
  }
  ensurePrivateDir(peersHome());
  const registry = join(peersHome(), `codex-${threadId}.json`);
  const filename = `codex-${threadId.replace(/-/g, "").slice(-16)}.sock`;
  let previous;
  try {
    const entry = readPeerRecord(registry);
    if (entry.threadId === threadId && isSafePeerRecord(entry) && recordRunning(entry) && basename(peerSocket(entry.address)) === filename) previous = entry;
  } catch {}
  if (previous && !Array.isArray(previous.addresses)) {
    throw new Error("legacy agent-peers inbox still running; retry after it exits");
  }
  dropDeadOwners();
  // An MCP refresh preserves the primary public address even if a newer Claude changed
  // the preferred directory. Additional deterministic aliases preserve older reply paths.
  const directory = previous ? dirname(peerSocket(previous.address)) : socketDir();
  const root = {
    threadId, rootId, name, subagent: false, registry, token: randomUUID(), cwd: t.cwd, startedAt: Date.now(), filename,
    procStart: START, generation: generation("codex", threadId, START), inboxes: new Map(), aliasBinding: Promise.resolve(),
    takeover: new Set(previous ? [previous.address, ...(Array.isArray(previous.addresses) ? previous.addresses : [])] : []),
    admission: new Admission(), chain: Promise.resolve(), queued: 0, queuedBytes: 0,
  };
  const primary = await createInbox(root, directory);
  setPrimary(root, primary);
  root.inboxes.set(directory, primary);
  roots.set(threadId, root);
  try { publishRegistry(root); }
  catch (error) { unbind(root); throw error; }
  const previousDirectories = (previous?.addresses ?? []).flatMap((addr) => {
    const socket = peerSocket(addr);
    return socket ? [dirname(socket)] : [];
  });
  for (const dir of [...new Set([...previousDirectories, ...socketDirectories()])].slice(0, INBOXES_MAX)) {
    try { await inboxFor(root, dir); }
    catch (error) { log("inbox.alias", { threadId: logIdentity(threadId), outcome: "failed", ...errorFields(error) }); }
  }
  log("inbox.bound", { threadId: logIdentity(threadId), rootId: logIdentity(rootId), outcome: "succeeded" });
  return root;
}

async function resolveThread(threadId) {
  // Delivery goes through the app-server at daemonSocket(). codex exec, and a Codex started with -c
  // overrides or --no-daemon, hosts its thread in its own embedded server, which peers cannot
  // reach. thread/read would load a thread from disk, so check the server has it live.
  const loaded = new Set(await app.loadedThreads());
  if (!loaded.has(threadId)) {
    throw new Error(`this Codex thread is not loaded on the app-server agent-peers uses (${daemonSocket()}). ` +
      "codex exec and sessions started with -c or --no-daemon run their own embedded app-server, which peers cannot reach. " +
      "Start codex on the shared daemon, or run it on a private app-server and point AGENT_PEERS_CODEX_APP_SERVER at its socket");
  }
  const t = await app.readThread(threadId);
  let rootId = threadId, parentId = t.parentThreadId;
  const ancestors = new Set([threadId]);
  while (parentId !== undefined && parentId !== null) {
    if (!validThreadId(parentId)) throw new Error("app-server returned an invalid parent thread ID");
    if (ancestors.has(parentId)) throw new Error("app-server returned cyclic thread ancestry");
    if (ancestors.size > 16) throw new Error("app-server thread ancestry exceeds 16 parents");
    // Reading an unloaded ancestor would restore historical state as a side effect.
    if (!loaded.has(parentId)) throw new Error("this Codex session has an unloaded parent; its root inbox cannot be resolved safely");
    ancestors.add(parentId);
    rootId = parentId;
    parentId = (await app.readThread(parentId)).parentThreadId;
  }
  const short = threadId.replace(/-/g, "").slice(-4);
  // A root session is named after its folder, as Claude sessions are; the thread title is only a
  // fallback. AGENT_PEERS_NAME in the server's Codex config env replaces both. The short thread
  // ID stays, because one config, and so one name, can serve several sessions.
  const label = slug(process.env.AGENT_PEERS_NAME ?? "") || slug(t.cwd || "") || slug(t.name || t.agentNickname || "") || "session";
  const name = rootId !== threadId ? `codex:${slug(t.name || t.agentNickname || "") || slug(t.cwd || "session")}-${short}`
    : `codex:${label.slice(0, 64)}-${short}`;
  return { t, rootId, name, loaded };
}

// Codex sends a session's thread ID only with tool calls, but the daemon reports the serverInfo
// of each loaded thread's MCP connections. This process advertises a random instance ID there
// and binds every root thread whose "agent-peers" connection carries it, so sessions are
// reachable before their first tool call. A thread in an embedded app-server, or a server
// configured under another name, is never found here and binds on its first call as before.
export const serverInfo = { name: "agent-peers", version: VERSION, description: `agent-peers inbox ${randomUUID()}` };
const SCAN_MS = 20_000;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref());
const ownedBy = async (id) => (await app.mcpServers(id, "agent-peers")).some((s) => s?.serverInfo?.description === serverInfo.description);

// An app-server that refuses, closes or times out is unavailable; a scan that completes without
// this process's thread means the thread is hosted elsewhere, such as an embedded server.
const unavailable = (error) => ["ENOENT", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"].includes(error?.code) ||
  /app-server .*(?:closed|timed out)|socket hang up/.test(String(error?.message));

// Retries quickly, then backs off to every 10 minutes, until a scan or a tool call binds a root.
// Each failure reason is logged once, plus one "unreachable" event and stderr line.
export async function bindAtStart() {
  const report = bindReporter();
  for (let attempt = 0; !roots.size; attempt++) {
    await delay(bindDelayMs(attempt) * (0.8 + Math.random() * 0.4));
    if (roots.size) return;
    let failure;
    try {
      const found = await findOwnThreads();
      // A sub-agent's own process never gets an inbox.
      if (found === "subagent") return log("inbox.bind", { outcome: "skipped", reason: "unsupported" });
      if (found === null) failure = { reason: "unloaded_thread" };
      for (const id of found ?? []) {
        // Recheck inside the binding chain: a tool call may have bound it meanwhile, or a
        // replacement process may now serve the thread and own its inbox.
        const bindFound = async () => {
          if (roots.has(id) || !(await ownedBy(id)) || otherLiveOwner(id)) return;
          return bindNow({ threadId: id });
        };
        await (binding = binding.then(bindFound, bindFound));
      }
    } catch (e) {
      failure = unavailable(e) ? { reason: "app_server_unavailable", errorCode: errorFields(e).errorCode } : errorFields(e);
    }
    if (roots.size) return;
    const event = report(attempt, failure?.reason);
    if (!event) continue;
    log("inbox.bind", { ...event, errorCode: failure.errorCode });
    if (event.outcome === "unreachable") {
      try {
        process.stderr.write(`agent-peers: no inbox yet; ${event.reason === "app_server_unavailable"
          ? `the Codex app-server at ${daemonSocket()} is not answering`
          : "this thread is not on the app-server agent-peers uses (codex exec, -c and --no-daemon sessions run their own)"}. ` +
          "Retrying every few minutes; a list_peers or send_peer call also opens it.\n");
      } catch {}
    }
  }
}

// The root threads this process serves; "subagent" when it serves only sub-agents; null when a
// complete scan found nothing; undefined when the scan could not complete, because an
// unanswered thread is unknown, not "not ours".
async function findOwnThreads() {
  const deadline = Date.now() + SCAN_MS, ids = await app.loadedThreads(), owners = [];
  for (let i = 0; i < ids.length; i += 16) {
    if (roots.size || Date.now() > deadline) return undefined;
    const results = await Promise.allSettled(ids.slice(i, i + 16).map(async (id) => ((await ownedBy(id)) ? id : null)));
    // A thread unloaded since the list is simply gone.
    if (results.some((r) => r.status === "rejected" && !/thread not found/.test(r.reason?.message))) return undefined;
    owners.push(...results.flatMap((r) => (r.status === "fulfilled" && validThreadId(r.value) ? [r.value] : [])));
  }
  if (!owners.length) return null;
  const found = [];
  for (const id of owners) if ((await app.readThread(id)).parentThreadId == null) found.push(id);
  return found.length ? found : "subagent";
}

function otherLiveOwner(threadId) {
  try {
    const entry = readPeerRecord(join(peersHome(), `codex-${threadId}.json`));
    return isSafePeerRecord(entry) && entry.pid !== process.pid && recordRunning(entry);
  } catch { return false; }
}

function publishRegistry(root) {
  const temporary = join(peersHome(), `.codex-${randomUUID()}.json`);
  try {
    writeFileSync(temporary, JSON.stringify({
      name: root.name, address: root.address, addresses: [...root.inboxes.values()].map((inbox) => inbox.address),
      cwd: root.cwd, threadId: root.threadId, pid: process.pid, ...(root.procStart ? { procStart: root.procStart } : {}),
      generation: root.generation, startedAt: root.startedAt, token: root.token,
    }), { mode: 0o600, flag: "wx" });
    renameSync(temporary, root.registry);
  } finally { rmSync(temporary, { force: true }); }
}

export function ownsRegistry(root) {
  try {
    const entry = readPeerRecord(root.registry);
    return entry.pid === process.pid && entry.token === root.token &&
      entry.threadId === root.threadId && entry.address === root.address;
  } catch { return false; }
}

const setPrimary = (root, inbox) => Object.assign(root, { socket: inbox.socket, address: inbox.address, identity: inbox.identity });

async function createInbox(root, directory, { requireMissing = false } = {}) {
  const socket = join(directory, root.filename);
  checkSocketPath(socket);
  const inboxAddress = address(socket);
  if (!peerSocket(inboxAddress)) throw new Error("unsafe existing Codex inbox path");
  try {
    lstatSync(socket);
    if (!root.takeover.has(inboxAddress)) throw new Error("Codex inbox path is already occupied by an unverified listener");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (codexPeers().some((peer) => peer.threadId !== root.threadId &&
      [peer.address, ...(peer.addresses ?? [])].includes(inboxAddress))) {
    throw new Error("Codex inbox path belongs to a different thread");
  }
  return listenInbox(socket, {
    takeover: !requireMissing && root.takeover.has(inboxAddress), maxConnections: CONNECTION_MAX,
    onRefused: (reason) => log("message.receive", { outcome: "dropped", reason }),
    onError: (error) => log("inbox.error", { outcome: "failed", ...errorFields(error) }),
    onLine: (line, inbox) => {
      if (isCurrent(root) && ownsRegistry(root) && ownsSocket(root) && ownsSocket(inbox)) handler(root, inbox, line);
    },
    // A repair publishes only a genuinely missing endpoint while this sidecar's registry token is current.
    beforePublish: requireMissing ? () => {
      if (!ownsRegistry(root)) throw replaced();
      try { lstatSync(socket); throw replaced(); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    } : undefined,
  });
}

async function repairInbox(root, directory) {
  const existing = root.inboxes.get(directory);
  if (!existing) return undefined;
  if (ownsSocket(existing)) return existing;
  // A replaced socket belongs to another listener. Only a genuinely missing endpoint,
  // with this sidecar's registry token still current, is eligible for repair.
  if (!isCurrent(root) || !ownsRegistry(root)) throw replaced();
  try { lstatSync(existing.socket); throw replaced(); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  void closeInbox(existing);
  const repaired = await createInbox(root, directory, { requireMissing: true });
  if (!isCurrent(root) || !ownsRegistry(root)) {
    void closeInbox(repaired);
    throw replaced();
  }
  const primary = directory === dirname(root.socket);
  root.inboxes.set(directory, repaired);
  if (primary) setPrimary(root, repaired);
  try { publishRegistry(root); }
  catch (error) {
    void closeInbox(repaired);
    root.inboxes.set(directory, existing);
    if (primary) setPrimary(root, existing);
    throw error;
  }
  log("inbox.repaired", { threadId: logIdentity(root.threadId), outcome: "succeeded" });
  return repaired;
}

// The root's inbox in a destination's directory, created or repaired as needed: Claude accepts
// reply addresses only in its own socket directory.
export function inboxFor(root, directory) {
  const bindAlias = async () => {
    if (!isCurrent(root) || !ownsRegistry(root)) throw replaced();
    await repairInbox(root, dirname(root.socket));
    if (!ownsSocket(root)) throw replaced();
    const existing = await repairInbox(root, directory);
    if (existing) return existing;
    if (root.inboxes.size >= INBOXES_MAX) throw new Error("too many Codex reply inbox directories");
    const inbox = await createInbox(root, directory);
    if (!isCurrent(root) || !ownsSocket(root) || !ownsRegistry(root)) {
      void closeInbox(inbox);
      throw replaced();
    }
    root.inboxes.set(directory, inbox);
    try { publishRegistry(root); }
    catch (error) { root.inboxes.delete(directory); void closeInbox(inbox); throw error; }
    return inbox;
  };
  return root.aliasBinding = root.aliasBinding.then(bindAlias, bindAlias);
}

function unbind(root) {
  if (!isCurrent(root)) return;
  roots.delete(root.threadId);
  log("inbox.unbound", { threadId: logIdentity(root.threadId), outcome: "closed" });
  for (const inbox of root.inboxes.values()) void closeInbox(inbox);
  try {
    if (readPeerRecord(root.registry).token === root.token) rmSync(root.registry, { force: true });
  } catch {}
  root.admission.clear();
}
export const unbindAll = () => { for (const root of [...roots.values()]) unbind(root); };

// A hard-killed codex-peer leaves files behind. A record may only clean its own deterministic
// inbox; a forged dead record must not remove some other peer's socket.
function dropDeadOwners() {
  for (const f of readdirSync(peersHome()).filter((f) => /^codex-[A-Za-z0-9_-]+\.json$/.test(f))) {
    try {
      const entry = readPeerRecord(join(peersHome(), f));
      if (!isSafePeerRecord(entry) || f !== `codex-${entry.threadId}.json` || recordRunning(entry)) continue;
      const expected = `codex-${entry.threadId.replace(/-/g, "").slice(-16)}.sock`;
      const addresses = [entry.address, ...(Array.isArray(entry.addresses) ? entry.addresses.slice(0, INBOXES_MAX) : [])];
      for (const addr of addresses) {
        const socket = peerSocket(addr);
        if (socket && basename(socket) === expected) rmSync(socket, { force: true });
      }
      rmSync(join(peersHome(), f), { force: true });
    } catch {}
  }
}
