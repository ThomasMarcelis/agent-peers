// A fake opencode host for the deterministic opencode tests. It models the parts the bridge uses:
// Session.Info (location, parentID, title, time, revert), session.get, and synthetic/prompt with
// the source's revert rule (prompt commits a staged revert; synthetic never does). test/opencode-*
// also use the real bridge and the real plugin with this host, so inboxes, names and records run
// unchanged.
import assert from "node:assert/strict";
import { realpathSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { readLines, messageLine, address, post, peerSocket, processStart } from "../src/wire.mjs";
import { OpencodeBridge } from "../src/opencode-bridge.mjs";
import { listen } from "./listeners.mjs";

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function until(check, description = "condition", tries = 300) {
  for (let i = 0; i < tries; i++) {
    const value = check();
    if (value) return value;
    await delay(10);
  }
  assert.fail(`timed out waiting for ${description}`);
}

// A short isolated environment. /tmp directly keeps the deterministic opencode socket path under
// the 103-byte Unix limit on macOS too.
export function opencodeFixture(t) {
  const dir = realpathSync(mkdtempSync("/tmp/ap-oc-"));
  const claude = join(dir, "claude"), peers = join(dir, "peers"), sockets = join(dir, "s");
  for (const path of [join(claude, "sessions"), peers, sockets]) mkdirSync(path, { recursive: true, mode: 0o700 });
  const before = Object.fromEntries(["CLAUDE_CONFIG_DIR", "AGENT_PEERS_HOME", "AGENT_PEERS_DEBUG", "AGENT_PEERS_LOG"]
    .map((key) => [key, process.env[key]]));
  Object.assign(process.env, { CLAUDE_CONFIG_DIR: claude, AGENT_PEERS_HOME: peers, AGENT_PEERS_DEBUG: "0" });
  const children = [];
  const servers = [];
  // A live Claude session (this test process) makes the socket directory verified and lets
  // receipts and sends reach a peer without inventing a second registry.
  writeFileSync(join(claude, "sessions", `${process.pid}.json`), JSON.stringify({
    pid: process.pid, name: "fixture", messagingSocketPath: join(sockets, "fixture.sock"),
    procStart: processStart(process.pid),
  }));
  t.after(async () => {
    for (const child of children) child.kill("SIGKILL");
    for (const server of servers) server.close();
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir, claude, peers, sockets, children,
    async peer(name = "peer", options = {}) {
      const socket = join(sockets, `${name}.sock`), lines = [];
      const server = createServer((conn) => readLines(conn, (line) => {
        if (line.type === "control") lines.push(line);
        else {
          lines.push(line);
          if (options.receipt) {
            const sender = peerSocket(line.message.content.match(/from="([^"]+)"/)?.[1] ?? "");
            if (sender) {
              setTimeout(() => {
                void post(sender, { type: "control", action: "peer_message_status", orig_msg_id: line.msg_id,
                  from: address(socket), status: options.receipt, ...(options.receiptReason ? { drop_reason: options.receiptReason } : {}) });
              }, options.receiptDelay ?? 0).unref();
            }
          }
        }
      }));
      servers.push(server);
      await listen(server, socket);
      return { socket, address: address(socket), lines, server };
    },
  };
}

export function session({ id, parentID, directory, title = "session", updated = Date.now(), idle, revert } = {}) {  return {
    id, ...(parentID ? { parentID } : {}), location: { directory }, title,
    time: { created: 1, updated, ...(idle === undefined ? {} : { idle }) }, ...(revert ? { revert } : {}),
    texts: [], wakes: 0, steers: 0, wakesSuppressed: 0, revertCommits: 0,
  };
}

export class FakeHost {
  constructor({ latency = 0 } = {}) {
    this.sessions = new Map();
    this.calls = [];
    this.latency = latency;
    this.failSynthetic = undefined;
    this.hangSynthetic = false;
  }

  add(info) {
    this.sessions.set(info.id, info);
    return info;
  }

  async #wait() { if (this.latency) await delay(this.latency); }

  // One bridge request → { v, id, result } or { v, id, error }. The bridge's #host interprets this.
  async handle(message) {
    this.calls.push(message);
    await this.#wait();
    if (message.method === "host.session") {
      const info = this.sessions.get(message.params?.sessionID);
      if (!info) return { v: 1, id: message.id, error: { code: "not-found", message: "no such session" } };
      return { v: 1, id: message.id, result: structuredClone(info) };
    }
    if (message.method === "host.synthetic") {
      if (this.hangSynthetic) return new Promise(() => {});
      const info = this.sessions.get(message.params?.sessionID);
      if (!info) return { v: 1, id: message.id, error: { code: "not-found", message: "no such session" } };
      if (this.failSynthetic) return { v: 1, id: message.id, error: { code: this.failSynthetic, message: "scripted host failure" } };
      if (Buffer.byteLength(message.params.text ?? "") > 1_000_000) return { v: 1, id: message.id, error: { code: "too-large", message: "too large" } };
      info.texts.push(message.params.text);
      if (message.params.resume === false) {
        // A late notice: no wake, and never a commit.
      } else if (info.revert) {
        info.wakesSuppressed++;
      } else {
        // session.synthetic wakes unless resume:false or a revert is staged. It does not choose
        // wake vs steer from the idle timestamp; the runner coalesces or steers a busy session.
        info.wakes++;
      }
      return { v: 1, id: message.id, result: { admitted: true, delivery: message.params.delivery ?? "steer" } };
    }
    return { v: 1, id: message.id, error: { code: "unknown-method", message: "unknown host method" } };
  }

  // The fake's prompt path, for the synthetic-vs-prompt comparison only. The bridge never calls it.
  prompt(sessionID) {
    const info = this.sessions.get(sessionID);
    if (info.revert) { info.revertCommits++; delete info.revert; }
    else info.wakes++;
  }

  count(method) { return this.calls.filter((call) => call.method === method).length; }
}

export function bridgeFor(host, { instance = "i-1", location = { directory: "/tmp" }, timeoutMs = 500, admission, queueMax, queueBytesMax, publishHook } = {}) {
  const logs = [];
  const bridge = new OpencodeBridge({
    send: (message) => Promise.race([
      host.handle(message),
      new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error("host timeout"), { code: "ETIMEDOUT" })), timeoutMs).unref()),
    ]),
    log: (event, fields) => logs.push({ event, fields }),
    hostTimeoutMs: timeoutMs,
    ...(admission ? { admission } : {}),
    ...(queueMax === undefined ? {} : { queueMax }),
    ...(queueBytesMax === undefined ? {} : { queueBytesMax }),
    ...(publishHook ? { publishHook } : {}),
  });
  bridge.hello({ instance, location });
  return { bridge, logs };
}

export function peerLine(from, body = "hello", { id, fromName = "claude:sender", receipts, toName, inReplyTo, generation: gen } = {}) {
  const line = messageLine({ from, fromName, body });
  if (id) line.msg_id = id;
  if (receipts || toName || inReplyTo || gen) {
    line.agent_peers = { v: 1, ...(receipts ? { receipts } : {}), ...(toName ? { to_name: toName } : {}), ...(inReplyTo ? { in_reply_to: inReplyTo } : {}), ...(gen ? { generation: gen } : {}) };
  }
  return line;
}

// A peer inbox in this process that records messages and optionally answers with a receipt.
export async function peerInbox(t, socket, { receipt, receiptDelay = 0, receiptReason } = {}) {
  const lines = [];
  const server = createServer((conn) => readLines(conn, (line) => {
    lines.push(line);
    if (line.type === "control" || !receipt) return;
    const sender = peerSocket(line.message.content.match(/from="([^"]+)"/)?.[1] ?? "");
    if (!sender) return;
    setTimeout(() => {
      void post(sender, { type: "control", action: "peer_message_status", orig_msg_id: line.msg_id,
        from: address(socket), status: receipt, ...(receiptReason ? { drop_reason: receiptReason } : {}) });
    }, receiptDelay).unref();
  }));
  await listen(server, socket, t);
  return { socket, address: address(socket), lines, server };
}
