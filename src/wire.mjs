// Claude Code's cross-session inbox protocol, spoken by every agent-peers participant.
//
// One newline-delimited JSON line per message on a Unix socket in Claude's socket
// directory. The content is a <cross-session-message> envelope whose `from` is the
// sender's own socket, so the receiver replies by writing to that address.
// Claude Code does not document this line format; test/contract.mjs pins it.

import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { connect } from "node:net";
import { homedir, tmpdir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { errorFields, logEvent } from "./logging.mjs";

export const TAG = "cross-session-message";
export const MAX_LINE = 1_000_000;
export const MAX_SOCKET_PATH = 103;
const uid = userInfo().uid;

export const claudeHome = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
export const peersHome = () => process.env.AGENT_PEERS_HOME || join(homedir(), ".agent-peers");

// Process group identifiers (0 and negative numbers) are never peer identities.
export function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || pid > 0x7fffffff) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

// Process start tokens in the format Claude Code records as `procStart`: the starttime field of
// /proc/<pid>/stat on Linux, `ps -o lstart=` in the C locale and UTC elsewhere. A live PID whose
// token differs from its record's now belongs to a different process that reused the PID.
// Answers are kept a second per PID, so a burst of messages costs at most one ps per second on
// macOS; a PID reused within that second is not worth a process spawn per message.
const knownStarts = new Map(), STARTS_MS = 1000;
export function processStarts(pids) {
  const out = new Map(), missing = [], looked = [], now = Date.now();
  for (const pid of new Set(pids)) {
    const known = knownStarts.get(pid);
    if (known && now - known.at < STARTS_MS) {
      if (known.start !== undefined) out.set(pid, known.start);
      continue;
    }
    looked.push(pid);
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      out.set(pid, stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
    } catch { missing.push(pid); }
  }
  if (missing.length && process.platform !== "linux") {
    // One ps for the batch; it exits nonzero when some PIDs are gone, so read stdout regardless.
    const ps = spawnSync("ps", ["-o", "pid=,lstart=", "-p", missing.join(",")], { encoding: "utf8", timeout: 2000,
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" }, stdio: ["ignore", "pipe", "ignore"] });
    for (const row of (ps.stdout ?? "").split("\n")) {
      const match = /^\s*(\d+)\s+(\S.*?)\s*$/.exec(row);
      if (match) out.set(Number(match[1]), match[2]);
    }
  }
  if (knownStarts.size > 4096) knownStarts.clear();
  for (const pid of looked) knownStarts.set(pid, { start: out.get(pid), at: now });
  return out;
}
export const processStart = (pid) => processStarts([pid]).get(pid);

// A record's process runs when its PID is alive and, if the record carries a start token, the PID
// still has that start. Records without one (agent-peers 0.x, older Claude) rely on the PID alone.
function running(record, starts) {
  if (!alive(record.pid)) return false;
  if (record.procStart === undefined) return true;
  const current = starts.get(record.pid);
  return current === undefined || current === String(record.procStart);
}
export const recordRunning = (record) => running(record, processStarts(record.procStart === undefined ? [] : [record.pid]));

// The opaque identity of the process behind an inbox; a pin on it stops delivery to a different
// process that reused a PID or socket path. Claude: pid, start and socket path. Codex: thread and
// start. Hermes: its host route.
export const generation = (kind, ...parts) =>
  createHash("sha256").update([kind, ...parts.map((part) => String(part ?? ""))].join("\0")).digest("hex").slice(0, 16);

function safeDirectory(path, privateOnly = false) {
  const st = lstatSync(path);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== uid || (st.mode & (privateOnly ? 0o077 : 0o022))) {
    throw new Error(`unsafe peer directory ${path}: expected an owned ${privateOnly ? "0700 " : ""}directory without symlinks or shared write access`);
  }
  return path;
}

export function ensurePrivateDir(path) {
  if (typeof path !== "string" || !isAbsolute(path) || normalize(path) !== path) {
    throw new Error("peer directory must be an absolute normalized path");
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return safeDirectory(path, true);
}

// Read registry files without following a substituted symlink or allocating an unbounded file.
export function readPeerRecord(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== uid || (st.mode & 0o022) || st.size > 65_536) throw new Error("unsafe peer registry file");
    const buffer = Buffer.allocUnsafe(65_537);
    let bytes = 0, count;
    while (bytes < buffer.length && (count = readSync(fd, buffer, bytes, buffer.length - bytes, null))) bytes += count;
    if (bytes > 65_536) throw new Error("peer registry file is too large");
    const value = JSON.parse(buffer.toString("utf8", 0, bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid peer registry record");
    return value;
  } finally {
    closeSync(fd);
  }
}

const safeText = (s, limit = 512) => typeof s === "string" && s.length > 0 && s.length <= limit && !/[\x00-\x1f\x7f]/.test(s);
const validSocketPath = (path) => typeof path === "string" && Buffer.byteLength(path) <= MAX_SOCKET_PATH && isAbsolute(path) && normalize(path) === path &&
  path.endsWith(".sock") && !/[\x00-\x1f\x7f]/.test(path);
const validPid = (pid) => Number.isInteger(pid) && pid > 0 && pid <= 0x7fffffff;
export const validThreadId = (id) => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id);

// Every well-formed Claude record, marked `running`; read once per discovery scope. Without
// `starts`, records are not marked: socket-directory checks need only live PIDs, not start times.
function claudeRecordScan({ starts = true } = {}) {
  const out = discoveryScope?.claudeRecords ?? readClaudeRecords();
  if (discoveryScope) discoveryScope.claudeRecords = out;
  if (starts && !discoveryScope?.claudeMarked) {
    const current = processStarts(out.filter((s) => s.procStart !== undefined).map((s) => s.pid));
    for (const s of out) s.running = running(s, current);
    if (discoveryScope) discoveryScope.claudeMarked = true;
  }
  return out;
}
function readClaudeRecords() {
  const dir = join(claudeHome(), "sessions");
  let files = [];
  try { safeDirectory(dir); files = readdirSync(dir); } catch {}
  const out = [];
  for (const f of files.filter((f) => /^[1-9]\d*\.json$/.test(f))) {
    try {
      const s = readPeerRecord(join(dir, f));
      if (!validPid(s.pid) || String(s.pid) !== f.slice(0, -5) || !validSocketPath(s.messagingSocketPath)) continue;
      if (s.name !== undefined && !safeText(s.name, 128)) continue;
      if (s.cwd !== undefined && !safeText(s.cwd, 4096)) continue;
      if (s.procStart !== undefined && !safeText(String(s.procStart), 64)) continue;
      safeDirectory(dirname(s.messagingSocketPath), true);
      out.push(s);
    } catch {}
  }
  return out;
}
const claudeRecords = () => claudeRecordScan().filter((s) => s.running);

// The preferred directory is only for NEW inboxes. It must never invalidate an address
// created in another directory: Claude versions and launch environments may coexist.
function defaultSocketDir() {
  const base = process.env.XDG_RUNTIME_DIR || tmpdir();
  const dir = join(base, "cc-socks");
  return Buffer.byteLength(join(dir, `${process.pid}.sock`)) <= MAX_SOCKET_PATH ? dir : `/tmp/cc-socks-${uid}`;
}

function standardSocketDirectories() {
  return new Set([
    defaultSocketDir(), join(tmpdir(), "cc-socks"), "/tmp/cc-socks", `/tmp/cc-socks-${uid}`,
    `/run/user/${uid}/cc-socks`,
    ...(process.env.XDG_RUNTIME_DIR ? [join(process.env.XDG_RUNTIME_DIR, "cc-socks")] : []),
  ]);
}

// Hermes reply inboxes deliberately have no registry. Remember directories authorized by
// this profile's Claude records so their replies still work after a Claude registry expires.
// Keep the cache scoped to the configured registries, and recheck ownership and inode on use.
let directoryScope;
const observedDirectories = new Map();
function refreshDirectoryScope() {
  const scope = JSON.stringify([resolve(claudeHome()), resolve(peersHome()), process.env.XDG_RUNTIME_DIR, tmpdir()]);
  if (directoryScope !== scope) { directoryScope = scope; observedDirectories.clear(); }
}
// Rereading every Claude record per peerSocket call made a listing quadratic. Within one
// discovery call the verified set is scanned once and reused; nothing is cached across calls,
// and every permittedSocketDirectory use still rechecks the directory with safeDirectory.
let discoveryScope;
export function inDiscoveryScope(fn) {
  if (discoveryScope) return fn();
  discoveryScope = {};
  try { return fn(); } finally { discoveryScope = undefined; }
}
function verifiedSocketDirectories() {
  refreshDirectoryScope();
  if (!discoveryScope) return freshVerifiedDirectories();
  discoveryScope.live ??= freshVerifiedDirectories();
  return new Set(discoveryScope.live);
}
function freshVerifiedDirectories() {
  const live = new Set(claudeRecordScan({ starts: false }).filter((s) => alive(s.pid)).map((s) => dirname(s.messagingSocketPath)));
  for (const dir of live) {
    try {
      safeDirectory(dir, true);
      const st = lstatSync(dir);
      if (observedDirectories.has(dir) || observedDirectories.size < 256) {
        observedDirectories.set(dir, { dev: st.dev, ino: st.ino });
      }
    } catch { live.delete(dir); }
  }
  return live;
}

// Enumerate only directories verified in this registry scope. Standard host directories
// remain valid explicit destinations, but must not create cross-profile eager aliases.
export const socketDirectories = () => inDiscoveryScope(listSocketDirectories);
function listSocketDirectories() {
  const live = verifiedSocketDirectories();
  return [...new Set([...live, ...observedDirectories.keys()])].filter(permittedSocketDirectory);
}

export function socketDir({ create = true } = {}) {
  const live = verifiedSocketDirectories();
  if (live.size) return live.values().next().value;
  const dir = defaultSocketDir();
  if (create) return ensurePrivateDir(dir);
  try { safeDirectory(dir, true); } catch (error) { if (error.code !== "ENOENT") throw error; }
  return dir;
}

function permittedSocketDirectory(dir) {
  const live = verifiedSocketDirectories();
  try {
    safeDirectory(dir, true);
    if (standardSocketDirectories().has(dir) || live.has(dir)) return true;
    const previous = observedDirectories.get(dir), current = lstatSync(dir);
    return previous?.dev === current.dev && previous?.ino === current.ino;
  } catch { return false; }
}

// Claude's address encoding: percent-encode everything outside [A-Za-z0-9:_/.\-].
export const address = (path) =>
  "uds:" + path.replace(/[^A-Za-z0-9:_/.\\-]/gu, (c) =>
    [...Buffer.from(c)].map((b) => "%" + b.toString(16).toUpperCase().padStart(2, "0")).join(""));

// Missing paths remain valid reply addresses; a discovered or connected existing path must be a socket.
export function peerSocket(addr) {
  if (typeof addr !== "string" || !/^uds:[A-Za-z0-9%:_/.\\-]{1,1000}$/.test(addr)) return undefined;
  const path = socketPath(addr);
  if (!validSocketPath(path) || address(path) !== addr || !permittedSocketDirectory(dirname(path))) return undefined;
  try {
    const st = lstatSync(path);
    if (!st.isSocket() || st.isSymbolicLink() || st.uid !== uid) return undefined;
  } catch (e) {
    if (e.code !== "ENOENT") return undefined;
  }
  return path;
}

export function socketPath(addr) {
  if (typeof addr !== "string" || !addr.startsWith("uds:")) return undefined;
  try { return decodeURIComponent(addr.slice(4)); } catch { return undefined; }
}

// Automatic names never contain the characters reserved for explicit claims (`/`) or patterns.
export const nameLabel = (s) => String(s).replace(/[^\p{L}\p{N}_.:-]/gu, "-").slice(0, 128);

const claudeRow = (s) => ({ kind: "claude", name: `claude:${nameLabel(s.name ?? s.pid)}`, address: address(s.messagingSocketPath),
  socket: s.messagingSocketPath, cwd: s.cwd, status: safeText(s.status, 64) ? s.status : undefined, pid: s.pid,
  generation: generation("claude", s.pid, s.procStart, s.messagingSocketPath) });

// Live Claude sessions from Claude's public session registry (never its key files).
export const claudeSessions = () => inDiscoveryScope(listClaudeSessions);
function listClaudeSessions() {
  return claudeRecords().flatMap((s) => (peerSocket(address(s.messagingSocketPath)) ? [claudeRow(s)] : []));
}

export function isSafePeerRecord(p) {
  return !!p && validPid(p.pid) && safeText(p.name, 160) && p.name.startsWith("codex:") &&
    validThreadId(p.threadId) && (p.cwd === undefined || safeText(p.cwd, 4096)) && !!peerSocket(p.address);
}

// Every safe Codex record, marked `running`; read once per discovery scope.
function codexRecordScan() {
  if (discoveryScope?.codex) return discoveryScope.codex;
  const dir = resolve(peersHome());
  let files = [];
  try { safeDirectory(dir, true); files = readdirSync(dir); } catch {}
  const out = [];
  for (const f of files.filter((f) => /^codex-[A-Za-z0-9_-]+\.json$/.test(f))) {
    try {
      const p = readPeerRecord(join(dir, f));
      if (isSafePeerRecord(p) && (p.procStart === undefined || safeText(String(p.procStart), 64))) out.push(p);
    } catch {}
  }
  const starts = processStarts(out.filter((p) => p.procStart !== undefined).map((p) => p.pid));
  for (const p of out) p.running = running(p, starts);
  if (discoveryScope) discoveryScope.codex = out;
  return out;
}

const codexRow = (p) => ({ kind: "codex", name: p.name, address: p.address, socket: peerSocket(p.address), cwd: p.cwd,
  threadId: p.threadId, pid: p.pid, startedAt: p.startedAt, generation: generation("codex", p.threadId, p.procStart),
  addresses: Array.isArray(p.addresses) ? p.addresses.slice(0, 16).filter((addr) => peerSocket(addr)) : [p.address] });

export const codexPeers = () => inDiscoveryScope(() => codexRecordScan().filter((p) => p.running).map(codexRow));

// One listing shares a single directory scan across its rows.
export function allPeers() {
  return inDiscoveryScope(() => [...claudeSessions(), ...codexPeers()]);
}

// Registered sessions whose process exited or whose PID was reused. They are never listed, but
// a send to their name or address fails as "not running" instead of "not found".
export function stalePeers() {
  return inDiscoveryScope(() => [...claudeRecordScan().filter((s) => !s.running).map(claudeRow),
    ...codexRecordScan().filter((p) => !p.running).map(codexRow)]);
}

// Process ancestry of this process, nearest parent first. Linux reads /proc; elsewhere ps.
export function ancestorPids(start = process.ppid, limit = 64) {
  const out = [];
  let pid = start;
  while (validPid(pid) && pid > 1 && out.length < limit && !out.includes(pid)) {
    out.push(pid);
    pid = parentPid(pid);
  }
  return out;
}

function parentPid(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
  } catch {}
  try {
    const out = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] });
    return Number(out.trim());
  } catch { return NaN; }
}

// The calling session: the nearest ancestor that owns a live Claude registry record, else a
// Codex inbox record. Never guessed from the working directory.
export function whoami(ancestors = ancestorPids()) {
  const peers = allPeers();
  for (const pid of ancestors) {
    const found = peers.find((p) => p.pid === pid);
    if (found) return found;
  }
  return undefined;
}

// Connect without sending data: a refused or missing socket marks the row stale. A short
// timeout means a wedged listener is reported reachable only if it accepted the connection.
export function probe(socket, timeoutMs = 200) {
  return new Promise((resolve) => {
    let done = false;
    const c = connect(socket);
    const finish = (ok) => { if (!done) { done = true; clearTimeout(timer); c.destroy(); resolve(ok); } };
    const timer = setTimeout(() => finish(false), timeoutMs);
    c.on("connect", () => finish(true));
    c.on("error", () => finish(false));
  });
}

export async function probePeers(peers, timeoutMs = 200) {
  return Promise.all(peers.map(async (p) => ({ ...p, reachable: p.socket ? await probe(p.socket, timeoutMs) : false })));
}

// Claude rejects an envelope unless it re-renders byte for byte, and its renderer
// escapes any closing tag in the body as `<\`. Do the same, tolerating the
// separators and invisible fillers Claude's matcher tolerates.
const OPEN = "<＜﹤‹〈⟨❮˂";
const SLASH = "/∕⁄／⧸";
const FILL = "[\\s\\p{Cf}]*";
const closing = new RegExp(
  `[${OPEN}](?!\\\\)(?=${FILL}[${SLASH}]${FILL}` +
    [...TAG].map((c) => (c === "-" ? "[-_\\p{Pc}\\u2017\\u02cd\\u07fa\\u0640]" : c)).join(FILL) + ")",
  "giu",
);
export const escapeBody = (body) => body.replace(closing, "<\\");

const clean = (s) => s.replace(/[^A-Za-z0-9:_-]/g, "-").slice(0, 64);

export function envelope({ from, fromName, fromMode, body }) {
  const attrs = [`from="${from}"`];
  if (fromName) attrs.push(`from-name="${clean(fromName)}"`);
  if (fromMode) attrs.push(`from-mode="${fromMode}"`);
  return `<${TAG} ${attrs.join(" ")}>\n${escapeBody(body)}\n</${TAG}>`;
}

export function parseEnvelope(content) {
  const m = new RegExp(`^<${TAG}((?: [a-z-]+="[^"<>\\n\\r]*")*)>\\n([\\s\\S]*)\\n</${TAG}>$`).exec(content);
  if (!m) return undefined;
  const attrs = Object.fromEntries([...m[1].matchAll(/ ([a-z-]+)="([^"]*)"/g)].map((a) => [a[1], a[2]]));
  return { from: attrs.from, fromName: attrs["from-name"], fromMode: attrs["from-mode"], body: m[2] };
}

// `ext` is agent-peers' namespaced line extension (status.mjs); Claude Code and agent-peers 0.x
// read none of it, and the envelope itself never changes because Claude rejects new attributes.
export function messageLine({ from, fromName, fromMode, body, ext }) {
  return {
    msgV: 1,
    msg_id: randomUUID(),
    type: "user",
    message: { role: "user", content: envelope({ from, fromName, fromMode, body }) },
    priority: "next",
    from,
    ...(ext ? { agent_peers: ext } : {}),
  };
}

// Write one line to a peer inbox. Open the connection only once the line is ready:
// Claude closes connections that send no complete line within 30 seconds.
export function post(socket, line) {
  if (typeof socket !== "string" || inDiscoveryScope(() => peerSocket(address(socket))) !== socket) {
    return Promise.reject(new Error("invalid peer inbox socket"));
  }
  const data = JSON.stringify(line) + "\n";
  const bytes = Buffer.byteLength(data);
  if (bytes > MAX_LINE) return Promise.reject(Object.assign(new Error(`message too large (${bytes} bytes)`), { code: "E2BIG" }));
  return new Promise((resolve, reject) => {
    const c = connect(socket);
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      c.destroy();
      error ? reject(error) : resolve();
    };
    // Coded failures let senders say "not running" for a missing or refusing inbox. A timeout means
    // the final newline never left this process, so the inbox discards the partial line. If the
    // whole line already reached the kernel (an event-loop stall delayed only the callback), the
    // inbox has it: that is a completed write, not a timeout.
    const failed = (message, code) => Object.assign(new Error(message), { code });
    let ended = false;
    const timer = setTimeout(() => finish(ended && c.writableLength === 0 ? undefined
      : failed("peer inbox did not accept the message within 5 s", "ETIMEDOUT")), 5000);
    c.on("error", finish);
    // end() reports a failed write (EPIPE when the peer closes mid-write) to its callback
    // before the "error" event; ignoring it would report an undelivered line as delivered.
    c.on("connect", () => { ended = true; c.end(data, (error) => finish(error)); });
    c.on("close", () => finish(failed("peer inbox closed before accepting the message", "ERR_SOCKET_CLOSED")));
  });
}

// Count bytes per frame, including its newline, rather than per incoming chunk. Buffering bytes
// until the complete line also preserves UTF-8 codepoints split across arbitrary socket writes.
export function readLines(conn, onLine) {
  let buffer = Buffer.allocUnsafe(4096), bytes = 0;
  const dropped = (reason) => logEvent("wire", "frame.drop", { outcome: "dropped", reason, bytes });
  conn.setTimeout(30_000, () => { dropped("idle_timeout"); conn.destroy(); });
  conn.on("data", (data) => {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
    let offset = 0;
    while (offset < chunk.length) {
      const end = chunk.indexOf(10, offset);
      const stop = end < 0 ? chunk.length : end + 1;
      const part = chunk.subarray(offset, stop);
      const nextBytes = bytes + part.length;
      if (nextBytes > MAX_LINE || (end < 0 && nextBytes >= MAX_LINE)) {
        dropped("frame_too_large");
        return conn.destroy();
      }
      if (nextBytes > buffer.length) {
        const grown = Buffer.allocUnsafe(Math.min(MAX_LINE, Math.max(nextBytes, buffer.length * 2)));
        buffer.copy(grown, 0, 0, bytes);
        buffer = grown;
      }
      part.copy(buffer, bytes);
      bytes = nextBytes;
      offset = stop;
      if (end < 0) break;
      const raw = buffer.toString("utf8", 0, bytes);
      bytes = 0;
      if (!raw.trim()) continue;
      let line;
      try { line = JSON.parse(raw); }
      catch { dropped("invalid_json"); continue; }
      try { onLine(line); }
      catch (error) { logEvent("wire", "frame.handler", { outcome: "failed", ...errorFields(error) }); }
      if (conn.destroyed) return;
    }
  });
  conn.on("end", () => { if (bytes) dropped("incomplete_frame"); });
  conn.on("error", (error) => logEvent("wire", "connection.error", { outcome: "failed", ...errorFields(error) }));
}

export const slug = (s) => basename(s).replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
