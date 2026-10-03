import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer as httpServer } from "node:http";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { WebSocketServer } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { address, messageLine, parseEnvelope, peerSocket, post, readLines } from "../src/wire.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const thread = "01900000-0000-0000-0000-123456789abc";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 300; i++) { const value = check(); if (value) return value; await delay(10); }
  assert.fail("timed out waiting for condition");
}

async function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ap-codex-"));
  const claude = join(dir, "claude"), peers = join(dir, "peers"), daemon = join(dir, "daemon.sock");
  const sockets = options.longSocketDir
    ? join(dir, "é".repeat(Math.max(1, Math.ceil((80 - Buffer.byteLength(dir) - 1) / 2))))
    : join(dir, "socks");
  for (const path of [join(claude, "sessions"), peers, sockets]) mkdirSync(path, { recursive: true, mode: 0o700 });
  const before = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, AGENT_PEERS_HOME: process.env.AGENT_PEERS_HOME };
  Object.assign(process.env, { CLAUDE_CONFIG_DIR: claude, AGENT_PEERS_HOME: peers });
  const inbox = join(sockets, "claude.sock"), messages = [], turns = [], reads = [], clients = [], held = [];
  const receiver = createServer((conn) => readLines(conn, (line) => {
    messages.push(line);
    void post(peerSocket(line.from), { type: "control", action: "peer_message_status", orig_msg_id: line.msg_id, status: "delivered" }).catch(() => {});
  }));
  receiver.listen(inbox); await once(receiver, "listening");
  writeFileSync(join(claude, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, name: "test", cwd: dir, messagingSocketPath: inbox }));
  const http = httpServer(), wss = new WebSocketServer({ server: http });
  const reply = (ws, message, result) => ws.send(JSON.stringify({ id: message.id, result }));
  let hold = !!options.hold;
  wss.on("connection", (ws) => ws.on("message", (data) => {
    const message = JSON.parse(data);
    if (message.method === "initialize") reply(ws, message, {});
    if (message.method === "thread/loaded/list") reply(ws, message, { data: options.loaded ?? [thread], nextCursor: null });
    if (message.method === "thread/read") {
      reads.push(message.params.threadId);
      reply(ws, message, { thread: { id: message.params.threadId, parentThreadId: options.parents?.[message.params.threadId],
        name: "fixture", cwd: dir, status: { type: "idle" } } });
    }
    if (message.method === "turn/start") {
      turns.push(message.params);
      if (hold) held.push(() => reply(ws, message, {}));
      else reply(ws, message, {});
    }
  }));
  http.listen(daemon); await once(http, "listening");
  const start = async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, "src", "codex-peer.mjs")],
      env: { ...process.env, CLAUDE_CONFIG_DIR: claude, AGENT_PEERS_HOME: peers, AGENT_PEERS_CODEX_APP_SERVER: daemon }, stderr: "pipe" });
    const client = new Client({ name: "test", version: "1" });
    transport.stderr.resume();
    await client.connect(transport);
    const close = () => client.close();
    clients.push({ client, close });
    return { client, transport, close, call: (name, args = {}, id = thread) => client.callTool({ name, arguments: args, _meta: { threadId: id } }) };
  };
  t.after(async () => {
    await Promise.all(clients.map(({ close }) => close()));
    for (const ws of wss.clients) ws.terminate();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => http.close(resolve));
    await new Promise((resolve) => receiver.close(resolve));
    for (const [key, value] of Object.entries(before)) value === undefined ? delete process.env[key] : process.env[key] = value;
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, peers, sockets, inbox, messages, turns, reads, start,
    registry: join(peers, `codex-${thread}.json`),
    release: () => { hold = false; held.splice(0).forEach((release) => release()); } };
}

test("MCP binds privately, discovers peers, sends and receives framed messages, then cleans up", async (t) => {
  const f = await fixture(t), peer = await f.start();
  const listed = await peer.call("list_peers");
  assert.match(listed.content[0].text, /claude:test/);
  const record = JSON.parse(readFileSync(f.registry, "utf8")), socket = peerSocket(record.address);
  assert.equal(lstatSync(socket).mode & 0o777, 0o600);
  assert.equal(lstatSync(f.registry).mode & 0o777, 0o600);
  const sent = await peer.call("send_peer", { to: "claude:test", message: "hello" });
  assert.match(sent.content[0].text, /Delivered/);
  assert.equal(parseEnvelope(f.messages[0].message.content).from, record.address);
  const incoming = messageLine({ from: address(f.inbox), fromName: "claude:test", body: "reply 😀" });
  await post(socket, incoming); await post(socket, incoming);
  await until(() => f.turns.length === 1); await delay(30);
  assert.equal(f.turns.length, 1);
  assert.equal(f.turns[0].threadId, thread);
  assert.match(f.turns[0].input[0].text, /reply 😀/);
  assert.match(f.turns[0].input[0].text, /not user approval/);
  await peer.close();
  assert.equal(existsSync(socket), false);
  assert.equal(existsSync(f.registry), false);
  assert.deepEqual(readdirSync(f.sockets), ["claude.sock"]);
});

test("closing a superseded MCP process preserves its replacement inbox and registry", async (t) => {
  const f = await fixture(t), old = await f.start();
  await old.call("list_peers");
  const first = JSON.parse(readFileSync(f.registry, "utf8")), socket = peerSocket(first.address);
  const original = lstatSync(socket);
  const current = await f.start(); await current.call("list_peers");
  assert.notEqual(lstatSync(socket).ino, original.ino);
  const replaced = await old.call("send_peer", { to: "claude:test", message: "stale" });
  assert.equal(replaced.isError, true);
  assert.match(replaced.content[0].text, /replaced/);
  await old.close();
  assert.equal(existsSync(socket), true);
  assert.equal(JSON.parse(readFileSync(f.registry, "utf8")).pid, current.transport.pid);
  await post(socket, messageLine({ from: address(f.inbox), body: "replacement still reachable" }));
  await until(() => f.turns.length === 1);
  await current.close();
  assert.equal(existsSync(socket), false);
});

test("invalid identities and embedded threads cannot create an inbox or trigger thread/read", async (t) => {
  const f = await fixture(t, { loaded: [] }), peer = await f.start();
  const malformed = await peer.call("list_peers", {}, "../../escape");
  assert.match(malformed.content[0].text, /valid thread ID/);
  const unloaded = await peer.call("send_peer", { to: "claude:test", message: "hello" });
  assert.equal(unloaded.isError, true);
  assert.match(unloaded.content[0].text, /embedded app-server/);
  assert.deepEqual(readdirSync(f.peers), []);
});

test("forged stale registry cannot remove another peer's socket", async (t) => {
  const f = await fixture(t), peer = await f.start();
  writeFileSync(join(f.peers, "codex-forged.json"), JSON.stringify({ pid: 0x7fffffff, threadId: "forged", name: "codex:forged", address: address(f.inbox) }));
  await peer.call("list_peers");
  assert.equal(existsSync(f.inbox), true);
  assert.equal(existsSync(join(f.peers, "codex-forged.json")), false);
});

test("queue saturation is bounded and idle connections cannot exceed the listener limit", async (t) => {
  const f = await fixture(t, { hold: true }), peer = await f.start();
  await peer.call("list_peers");
  const socket = peerSocket(JSON.parse(readFileSync(f.registry, "utf8")).address);
  for (let i = 0; i < 70; i++) {
    await post(socket, messageLine({ from: address(join(f.sockets, `sender-${i}.sock`)), body: `flood-${i}` }));
    await delay(3);
  }
  await until(() => f.turns.length === 1);
  f.release();
  await until(() => f.turns.length === 50);
  await delay(40); assert.equal(f.turns.length, 50);
  const connections = Array.from({ length: 40 }, () => connect(socket));
  t.after(() => connections.forEach((conn) => conn.destroy()));
  let closed = 0;
  for (const conn of connections) { conn.on("error", () => {}); conn.on("close", () => closed++); }
  await until(() => closed >= 8);
  connections.forEach((conn) => conn.destroy());
});


test("binding never reads a parent absent from the loaded-thread snapshot", async (t) => {
  const f = await fixture(t, { parents: { [thread]: "historical-parent" } }), peer = await f.start();
  const result = await peer.call("send_peer", { to: "claude:test", message: "hello" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /unloaded parent/);
  assert.deepEqual(f.reads, [thread]);
  assert.deepEqual(readdirSync(f.peers), []);
});

test("binding rejects cyclic ancestry before rereading an ancestor", async (t) => {
  const f = await fixture(t, { loaded: [thread, "parent"], parents: { [thread]: "parent", parent: thread } }), peer = await f.start();
  const result = await peer.call("send_peer", { to: "claude:test", message: "hello" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /cyclic thread ancestry/);
  assert.deepEqual(f.reads, [thread, "parent"]);
  assert.deepEqual(readdirSync(f.peers), []);
});

test("binding rejects an oversized UTF-8 pathname before creating or renaming a socket", async (t) => {
  const f = await fixture(t, { longSocketDir: true }), peer = await f.start();
  const result = await peer.call("send_peer", { to: "claude:test", message: "hello" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /103-byte Unix socket limit/);
  assert.deepEqual(readdirSync(f.sockets), ["claude.sock"]);
  assert.deepEqual(readdirSync(f.peers), []);
});
