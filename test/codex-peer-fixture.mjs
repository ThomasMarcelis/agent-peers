import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer as httpServer } from "node:http";
import { connect, createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { address, claudeSessionAt, codexPeers, generation, messageLine, parseEnvelope, peerSocket, post, processStart, readLines, recentlyExitedCodex } from "../src/wire.mjs";
import { closeServer, listen } from "./listeners.mjs";

export const root = dirname(dirname(fileURLToPath(import.meta.url)));
export const thread = "01900000-0000-0000-0000-123456789abc";
export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function until(check) {
  for (let i = 0; i < 300; i++) { const value = check(); if (value) return value; await delay(10); }
  assert.fail("timed out waiting for condition");
}

export async function fixture(t, options = {}) {
  // The real path keeps logging's symlink checks meaningful; /tmp keeps macOS socket paths short.
  const dir = mkdtempSync(join(realpathSync("/tmp"), "ap-codex-"));
  const claude = join(dir, "claude"), peers = join(dir, "peers"), daemon = join(dir, "daemon.sock");
  const sockets = options.longSocketDir
    ? join(dir, "é".repeat(Math.max(1, Math.ceil((80 - Buffer.byteLength(dir) - 1) / 2))))
    : join(dir, "socks");
  for (const path of [join(claude, "sessions"), peers, sockets]) mkdirSync(path, { recursive: true, mode: 0o700 });
  const before = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, AGENT_PEERS_HOME: process.env.AGENT_PEERS_HOME };
  Object.assign(process.env, { CLAUDE_CONFIG_DIR: claude, AGENT_PEERS_HOME: peers });
  const inbox = join(sockets, "claude.sock"), messages = [], controls = [], turns = [], reads = [], clients = [], held = [], mcpServers = {},
    statusCalls = [], injected = [], summaryCalls = [], turnData = options.turnData ?? {};
  // A fast inbox that accepts at once, unless the test supplies another receipt or none (null, as Claude does for accepted input).
  const receiver = createServer((conn) => readLines(conn, (line) => {
    if (line.type !== "user") return controls.push(line);
    messages.push(line);
    if (options.receipt !== null) void post(peerSocket(line.from), { type: "control", action: "peer_message_status", orig_msg_id: line.msg_id,
      from: address(inbox), status: "accepted", ...options.receipt }).catch(() => {});
  }));
  const http = httpServer(), wss = new WebSocketServer({ server: http });
  // Registered before anything listens, so a failure below cannot leave a handle open.
  t.after(async () => {
    await Promise.all(clients.map(({ close }) => close()));
    for (const ws of wss.clients) ws.terminate();
    await new Promise((resolve) => wss.close(resolve));
    await closeServer(http);
    await closeServer(receiver);
    for (const [key, value] of Object.entries(before)) value === undefined ? delete process.env[key] : process.env[key] = value;
    rmSync(dir, { recursive: true, force: true });
  });
  await listen(receiver, inbox);
  writeFileSync(join(claude, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, name: "test", cwd: dir, messagingSocketPath: inbox,
    procStart: processStart(process.pid) }));
  const reply =(ws, message, result) => ws.send(JSON.stringify({ id: message.id, result }));
  let hold = !!options.hold;
  wss.on("connection", (ws) => ws.on("message", (data) => {
    const message = JSON.parse(data);
    if (message.method === "initialize") reply(ws, message, {});
    if (message.method === "thread/loaded/list") reply(ws, message, { data: options.loaded ?? [thread], nextCursor: null });
    if (message.method === "thread/read") {
      reads.push(message.params.threadId);
      const respond = () => reply(ws, message, { thread: { id: message.params.threadId, parentThreadId: options.parents?.[message.params.threadId],
        name: "fixture", cwd: dir, status: { type: "idle" }, ...options.threadData?.[message.params.threadId] } });
      if (options.readDelay) setTimeout(respond, options.readDelay);
      else respond();
    }
    if (message.method === "thread/turns/list") {
      summaryCalls.push(message.params);
      if (options.summaryDisconnect) { ws.terminate(); return; }
      if (!options.holdSummaries) reply(ws, message, { data: turnData[message.params.threadId] ?? [] });
    }
    if (message.method === "mcpServerStatus/list") {
      statusCalls.push(message.params.threadId);
      const servers = mcpServers[message.params.threadId];
      if (servers === "error") ws.send(JSON.stringify({ id: message.id, error: { code: -32603, message: "transient" } }));
      else reply(ws, message, { data: servers ?? [] });
    }
    if (message.method === "turn/start") {
      turns.push(message.params);
      if (options.turnError) {
        ws.send(JSON.stringify({ id: message.id, error: options.turnError }));
        return;
      }
      if (hold) held.push(() => reply(ws, message, {}));
      else reply(ws, message, {});
    }
    if (message.method === "thread/inject_items") {
      injected.push(message.params);
      reply(ws, message, {});
    }
  }));
  await listen(http, daemon);
  const start = async (extraEnv = {}) => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, "src", "codex-peer.mjs")],
      env: { ...process.env, CLAUDE_CONFIG_DIR: claude, AGENT_PEERS_HOME: peers, AGENT_PEERS_CODEX_APP_SERVER: daemon,
        AGENT_PEERS_DEBUG: options.logging ? "1" : "0", AGENT_PEERS_LOG: "", ...extraEnv }, stderr: "pipe" });
    const client = new Client({ name: "test", version: "1" });
    transport.stderr.resume();
    const close = () => client.close();
    // Tracked before connecting: a failed handshake must still stop the child process.
    clients.push({ client, close });
    await client.connect(transport);
    return { client, transport, close, call: (name, args = {}, id = thread) => client.callTool({ name, arguments: args, _meta: { threadId: id } }) };
  };
  return { dir, peers, sockets, inbox, claude, messages, controls, turns, reads, injected, start, mcpServers, statusCalls,
    registry: join(peers, `codex-${thread}.json`), turnData, summaryCalls,
    notify: (method, params) => { for (const ws of wss.clients) ws.send(JSON.stringify({ method, params })); },
    disconnect: async () => { for (const ws of wss.clients) ws.terminate(); await closeServer(http); },
    release: () => { hold = false; held.splice(0).forEach((release) => release()); } };
}

