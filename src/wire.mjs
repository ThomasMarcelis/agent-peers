// Claude Code's cross-session inbox protocol, spoken by every agent-peers participant.
//
// One newline-delimited JSON line per message on a Unix socket in Claude's socket
// directory. The content is a <cross-session-message> envelope whose `from` is the
// sender's own socket, so the receiver replies by writing to that address.
// Claude Code does not document this line format; test/contract.mjs pins it.

import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync } from "node:fs";
import { connect } from "node:net";
import { homedir, tmpdir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";

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

function claudeRecords() {
  const dir = join(claudeHome(), "sessions");
  let files;
  try { safeDirectory(dir); files = readdirSync(dir); } catch { return []; }
  const out = [];
  for (const f of files.filter((f) => /^[1-9]\d*\.json$/.test(f))) {
    try {
      const s = readPeerRecord(join(dir, f));
      if (!validPid(s.pid) || String(s.pid) !== f.slice(0, -5) || !alive(s.pid) || !validSocketPath(s.messagingSocketPath)) continue;
      if (s.name !== undefined && !safeText(s.name, 128)) continue;
      if (s.cwd !== undefined && !safeText(s.cwd, 4096)) continue;
      safeDirectory(dirname(s.messagingSocketPath), true);
      out.push(s);
    } catch {}
  }
  return out;
}

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
function verifiedSocketDirectories() {
  refreshDirectoryScope();
  const live = new Set(claudeRecords().map((session) => dirname(session.messagingSocketPath)));
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
export function socketDirectories() {
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

// Live Claude sessions from Claude's public session registry (never its key files).
export function claudeSessions() {
  return claudeRecords().flatMap((s) => {
    if (!peerSocket(address(s.messagingSocketPath))) return [];
    return [{ kind: "claude", name: `claude:${s.name ?? s.pid}`, address: address(s.messagingSocketPath),
      socket: s.messagingSocketPath, cwd: s.cwd, status: safeText(s.status, 64) ? s.status : undefined, pid: s.pid }];
  });
}

export function isSafePeerRecord(p) {
  return !!p && validPid(p.pid) && safeText(p.name, 160) && p.name.startsWith("codex:") &&
    validThreadId(p.threadId) && (p.cwd === undefined || safeText(p.cwd, 4096)) && !!peerSocket(p.address);
}

export function codexPeers() {
  const dir = resolve(peersHome());
  let files;
  try { safeDirectory(dir, true); files = readdirSync(dir); } catch { return []; }
  const out = [];
  for (const f of files.filter((f) => /^codex-[A-Za-z0-9_-]+\.json$/.test(f))) {
    try {
      const p = readPeerRecord(join(dir, f));
      if (!isSafePeerRecord(p) || !alive(p.pid)) continue;
      out.push({ kind: "codex", name: p.name, address: p.address, socket: peerSocket(p.address), cwd: p.cwd,
        threadId: p.threadId, pid: p.pid, startedAt: p.startedAt,
        addresses: Array.isArray(p.addresses) ? p.addresses.slice(0, 16).filter((addr) => peerSocket(addr)) : [p.address] });
    } catch {}
  }
  return out;
}

export const allPeers = () => [...claudeSessions(), ...codexPeers()];

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

export function messageLine({ from, fromName, fromMode, body }) {
  return {
    msgV: 1,
    msg_id: randomUUID(),
    type: "user",
    message: { role: "user", content: envelope({ from, fromName, fromMode, body }) },
    priority: "next",
    from,
  };
}

// Write one line to a peer inbox. Open the connection only once the line is ready:
// Claude closes connections that send no complete line within 30 seconds.
export function post(socket, line) {
  if (typeof socket !== "string" || peerSocket(address(socket)) !== socket) {
    return Promise.reject(new Error("invalid peer inbox socket"));
  }
  const data = JSON.stringify(line) + "\n";
  const bytes = Buffer.byteLength(data);
  if (bytes > MAX_LINE) return Promise.reject(new Error(`message too large (${bytes} bytes)`));
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
    const timer = setTimeout(() => finish(new Error("peer inbox did not accept the message within 5 s")), 5000);
    c.on("error", finish);
    c.on("connect", () => c.end(data, () => finish()));
    c.on("close", () => finish(new Error("peer inbox closed before accepting the message")));
  });
}

// Count bytes per frame, including its newline, rather than per incoming chunk. Buffering bytes
// until the complete line also preserves UTF-8 codepoints split across arbitrary socket writes.
export function readLines(conn, onLine) {
  let buffer = Buffer.allocUnsafe(4096), bytes = 0;
  conn.setTimeout(30_000, () => conn.destroy());
  conn.on("data", (data) => {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
    let offset = 0;
    while (offset < chunk.length) {
      const end = chunk.indexOf(10, offset);
      const stop = end < 0 ? chunk.length : end + 1;
      const part = chunk.subarray(offset, stop);
      const nextBytes = bytes + part.length;
      if (nextBytes > MAX_LINE || (end < 0 && nextBytes >= MAX_LINE)) return conn.destroy();
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
      try { onLine(JSON.parse(raw)); } catch {}
      if (conn.destroyed) return;
    }
  });
  conn.on("error", () => {});
}

export const slug = (s) => basename(s).replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
