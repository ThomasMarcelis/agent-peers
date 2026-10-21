import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WebSocketServer } from "ws";
import { AppServer } from "../src/app-server.mjs";
import { closeServer, listen } from "./listeners.mjs";

async function fixture(t, handler, onNotification, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ap-app-")), path = join(dir, "daemon.sock");
  const http = createServer(), wss = new WebSocketServer({ server: http });
  const before = process.env.AGENT_PEERS_CODEX_APP_SERVER;
  process.env.AGENT_PEERS_CODEX_APP_SERVER = path;
  const calls = [];
  let connections = 0;
  wss.on("connection", (ws) => {
    connections++;
    ws.on("message", (data) => {
      const message = JSON.parse(data);
      calls.push(message);
      handler?.(ws, message, connections);
    });
  });
  const app = new AppServer(onNotification, { handshakeTimeoutMs: 60, ...options });
  // Registered before listening, so a failed assertion cannot leave the daemon open.
  t.after(async () => {
    app.close();
    for (const ws of wss.clients) ws.terminate();
    await new Promise((resolve) => wss.close(resolve));
    await closeServer(http);
    before === undefined ? delete process.env.AGENT_PEERS_CODEX_APP_SERVER : process.env.AGENT_PEERS_CODEX_APP_SERVER = before;
    rmSync(dir, { recursive: true, force: true });
  });
  await listen(http, path);
  return { app, calls, wss };
}
const reply = (ws, message, result) => ws.send(JSON.stringify({ id: message.id, result }));

test("handshake precedes concurrent requests and notifications do not consume responses", async (t) => {
  const f = await fixture(t, (ws, message) => {
    if (message.method === "initialize") reply(ws, message, {});
    else if (message.id) { ws.send(JSON.stringify({ method: "event" })); reply(ws, message, message.params); }
  });
  const results = await Promise.all([f.app.request("one", { x: 1 }), f.app.request("two", { x: 2 })]);
  assert.deepEqual(results, [{ x: 1 }, { x: 2 }]);
  assert.deepEqual(f.calls.map((m) => m.method), ["initialize", "initialized", "one", "two"]);
});

test("failed initialization clears its timeout and permits a later fresh connection", async (t) => {
  const f = await fixture(t, (ws, message, connection) => {
    if (message.method === "initialize" && connection === 1) ws.send(JSON.stringify({ id: message.id, error: { code: 9, message: "unsupported" } }));
    else if (message.id) reply(ws, message, "ok");
  });
  await assert.rejects(f.app.request("probe", {}), /unsupported/);
  assert.equal(await f.app.request("probe", {}), "ok");
});

test("handshake timeout rejects and reconnects without replaying requests", async (t) => {
  const f = await fixture(t, (ws, message, connection) => {
    if (connection > 1 && message.id) reply(ws, message, "fresh");
  });
  await assert.rejects(f.app.request("probe", {}), /initialize timed out/);
  assert.equal(await f.app.request("probe", {}), "fresh");
  assert.equal(f.calls.filter((m) => m.method === "probe").length, 1);
});

test("malformed server frames reject pending work and a later call reconnects", async (t) => {
  const f = await fixture(t, (ws, message, connection) => {
    if (message.method === "initialize") reply(ws, message, {});
    else if (message.id && connection === 1) ws.send("null");
    else if (message.id) reply(ws, message, "ok");
  });
  await assert.rejects(f.app.request("write", {}), /invalid app-server JSON response/);
  assert.equal(await f.app.request("read", {}), "ok");
  assert.equal(f.calls.filter((m) => m.method === "write").length, 1);
});

test("request timeout never retries; close rejects pending and future requests", async (t) => {
  const f = await fixture(t, (ws, message) => { if (message.method === "initialize") reply(ws, message, {}); });
  await assert.rejects(f.app.request("write", {}, 20), /write timed out/);
  assert.equal(f.calls.filter((m) => m.method === "write").length, 1);
  const pending = f.app.request("pending", {});
  await new Promise((resolve) => setTimeout(resolve, 10));
  f.app.close();
  await assert.rejects(pending, /client is closed/);
  await assert.rejects(f.app.request("next", {}), /client is closed/);
});

test("discovery rejects malformed data and repeated pagination cursors", async (t) => {
  const f = await fixture(t, (ws, message) => {
    if (message.method === "initialize") reply(ws, message, {});
    else if (message.method === "thread/loaded/list") reply(ws, message, { data: ["a"], nextCursor: "repeat" });
    else if (message.id) reply(ws, message, { thread: null });
  });
  await assert.rejects(f.app.loadedThreads(), /pagination/);
  await assert.rejects(f.app.readThread("a"), /invalid app-server thread/);
});

test("turn status reads request only the latest two turns with no items", async (t) => {
  const f = await fixture(t, (ws, message) => {
    if (message.method === "initialize") reply(ws, message, {});
    else if (message.method === "thread/turns/list") reply(ws, message, { data: [{ id: "last", status: "failed" }] });
  });
  assert.deepEqual(await f.app.latestTurns("root"), [{ id: "last", status: "failed" }]);
  assert.deepEqual(f.calls.at(-1).params, { threadId: "root", limit: 2, sortDirection: "desc", itemsView: "notLoaded" });
});

test("a JSON-RPC request from the server reaches the notification callback and cannot settle a pending call", async (t) => {
  const seen = [];
  let request;
  const f = await fixture(t, (ws, message) => {
    if (message.method === "initialize") reply(ws, message, {});
    else if (message.method === "slow") {
      // A server-initiated request that reuses the pending call's id, sent before the real answer.
      request = { id: message.id, method: "item/tool/requestUserInput", params: { prompt: "approve?" } };
      ws.send(JSON.stringify(request));
      setTimeout(() => reply(ws, message, "answer"), 20);
    } else if (message.id) reply(ws, message, "ok");
  }, (message) => seen.push(message));
  assert.equal(await f.app.request("slow", {}), "answer");
  assert.deepEqual(seen, [request]);
  // User input and approvals wait for a human's client: agent-peers never answers them.
  assert.deepEqual(f.calls.map((m) => m.method), ["initialize", "initialized", "slow"]);
  assert.equal(await f.app.request("next", {}), "ok", "the connection stays usable");
});

// Server requests fan out and the first answer wins, so any answer, even "unsupported", could
// override the client that owns the request (openai/codex#35894).
test("server requests are logged by method and never answered", async (t) => {
  const answers = [], logged = [];
  const log = (component, event, fields) => { if (event === "server_request") logged.push(fields.method); };
  const methods = ["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "mcpServer/elicitation/request",
    "item/tool/call", "account/chatgptAuthTokens/refresh", "attestation/generate", "execCommandApproval"];
  const f = await fixture(t, (ws, message) => {
    if (message.method === "initialize") reply(ws, message, {});
    else if (message.method === "go") {
      for (const [index, method] of methods.entries()) ws.send(JSON.stringify({ id: 900 + index, method, params: { threadId: "t", turnId: "u" } }));
      setTimeout(() => reply(ws, message, "done"), 30);
    } else if (!message.method) answers.push(message);
  }, undefined, { log });
  assert.equal(await f.app.request("go", {}), "done");
  assert.deepEqual(answers, []);
  assert.deepEqual(logged, methods);
});

test("a frame over the 4 MiB maxPayload fails pending work promptly and a later call reconnects", async (t) => {
  const f = await fixture(t, (ws, message, connection) => {
    if (message.method === "initialize") reply(ws, message, {});
    else if (message.id && connection === 1) reply(ws, message, "x".repeat(4 * 1024 * 1024));
    else if (message.id) reply(ws, message, "ok");
  });
  const started = performance.now();
  await assert.rejects(f.app.request("huge", {}, 10_000), /Max payload size exceeded/);
  assert.ok(performance.now() - started < 5000, "failed on the frame, not on the request timeout");
  assert.equal(await f.app.request("small", {}), "ok");
  assert.equal(f.calls.filter((m) => m.method === "huge").length, 1, "the failed request is not replayed");
});
