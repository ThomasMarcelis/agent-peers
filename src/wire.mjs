// Claude Code's cross-session inbox protocol, spoken by every agent-peers participant.
//
// One newline-delimited JSON line per message on a Unix socket in Claude's socket
// directory. The content is a <cross-session-message> envelope whose `from` is the
// sender's own socket, so the receiver replies by writing to that address.
// Claude Code does not document this line format; test/contract.mjs pins it.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir, userInfo } from "node:os";
import { basename, dirname, join } from "node:path";

export const TAG = "cross-session-message";
export const MAX_LINE = 1_000_000;
const uid = userInfo().uid;

export const claudeHome = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
export const peersHome = () => process.env.AGENT_PEERS_HOME || join(homedir(), ".agent-peers");

export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

// Claude vets reply targets to its own socket directory, so Codex inboxes live there too.
export function socketDir() {
  for (const s of claudeSessions()) return dirname(s.socket);
  const run = `/run/user/${uid}`;
  const dir = existsSync(run) ? join(run, "cc-socks") : `/tmp/cc-socks-${uid}`;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

// Claude's address encoding: percent-encode everything outside [A-Za-z0-9:_/.\-].
export const address = (path) =>
  "uds:" + path.replace(/[^A-Za-z0-9:_/.\\-]/gu, (c) =>
    [...Buffer.from(c)].map((b) => "%" + b.toString(16).toUpperCase().padStart(2, "0")).join(""));

// A reply address must name a socket in Claude's socket directory, as Claude itself requires.
export function peerSocket(addr) {
  if (typeof addr !== "string" || !/^uds:[A-Za-z0-9%:_/.\\-]{1,300}$/.test(addr)) return undefined;
  const path = socketPath(addr);
  return path.endsWith(".sock") && dirname(path) === socketDir() ? path : undefined;
}

export function socketPath(addr) {
  if (!addr.startsWith("uds:")) return undefined;
  try {
    return decodeURIComponent(addr.slice(4));
  } catch {
    return addr.slice(4);
  }
}

// Live Claude sessions from Claude's public session registry (never its key files).
export function claudeSessions() {
  const dir = join(claudeHome(), "sessions");
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => /^\d+\.json$/.test(f));
  } catch {}
  const out = [];
  for (const f of files) {
    try {
      const s = JSON.parse(readFileSync(join(dir, f), "utf8"));
      if (!s.messagingSocketPath || !alive(s.pid)) continue;
      out.push({
        kind: "claude",
        name: `claude:${s.name ?? s.pid}`,
        address: address(s.messagingSocketPath),
        socket: s.messagingSocketPath,
        cwd: s.cwd,
        status: s.status,
        pid: s.pid,
      });
    } catch {}
  }
  return out;
}

export function codexPeers() {
  let files = [];
  try {
    files = readdirSync(peersHome()).filter((f) => f.startsWith("codex-") && f.endsWith(".json"));
  } catch {}
  const out = [];
  for (const f of files) {
    try {
      const p = JSON.parse(readFileSync(join(peersHome(), f), "utf8"));
      if (alive(p.pid)) out.push({ kind: "codex", ...p });
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
  const data = JSON.stringify(line) + "\n";
  const bytes = Buffer.byteLength(data);
  if (bytes > MAX_LINE) return Promise.reject(new Error(`message too large (${bytes} bytes)`));
  return new Promise((resolve, reject) => {
    const c = connect(socket);
    c.setTimeout(5000, () => c.destroy(new Error("peer inbox did not accept the message within 5 s")));
    c.on("error", reject);
    c.on("connect", () => c.end(data, resolve));
  });
}

// Read newline-delimited JSON lines from an accepted inbox connection.
export function readLines(conn, onLine) {
  let buf = "";
  conn.setEncoding("utf8");
  conn.setTimeout(30_000, () => conn.destroy());
  conn.on("data", (d) => {
    buf += d;
    if (Buffer.byteLength(buf) > MAX_LINE) return conn.destroy();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!raw.trim()) continue;
      try {
        onLine(JSON.parse(raw));
      } catch {}
    }
  });
  conn.on("error", () => {});
}

export const slug = (s) => basename(s).replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
