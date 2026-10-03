import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WebSocketServer } from "ws";
import { AppServer } from "../src/app-server.mjs";

async function fixture(t, handler) {
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
  http.listen(path); await once(http, "listening");
  const app = new AppServer(undefined, { handshakeTimeoutMs: 60 });
  t.after(async () => {
    app.close();
    for (const ws of wss.clients) ws.terminate();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => http.close(resolve));
    before === undefined ? delete process.env.AGENT_PEERS_CODEX_APP_SERVER : process.env.AGENT_PEERS_CODEX_APP_SERVER = before;
    rmSync(dir, { recursive: true, force: true });
  });
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
