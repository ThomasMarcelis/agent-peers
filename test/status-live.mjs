// Opt-in, zero-inference-cost contract: real Codex + repo sidecar, isolated home and local
// Responses fixture. No credentials, external services, installed MCPs or live peers are used.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { once } from "node:events";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AppServer } from "../src/app-server.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = mkdtempSync("/tmp/ap-status-live-");
for (const part of ["codex", "peers", "runtime", "claude"]) mkdirSync(join(dir, part), { mode: 0o700 });
const socket = join(dir, "app.sock"), peers = join(dir, "peers");
const originalSocket = process.env.AGENT_PEERS_CODEX_APP_SERVER;
process.env.AGENT_PEERS_CODEX_APP_SERVER = socket;
let failing = false, child, app, stderr = "", currentThread;
const provider = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    if (failing) {
      res.writeHead(409, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Local contract conflict", type: "conflict" } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    const message = { id: "msg_status", type: "message", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: "OK", annotations: [] }] };
    event("response.created", { response: { id: "resp_status", object: "response", status: "in_progress", output: [] } });
    setTimeout(() => {
      event("response.output_item.added", { output_index: 0, item: { ...message, status: "in_progress", content: [] } });
      event("response.output_text.delta", { item_id: message.id, output_index: 0, content_index: 0, delta: "OK" });
      event("response.output_item.done", { output_index: 0, item: message });
      event("response.completed", { response: { id: "resp_status", object: "response", status: "completed", output: [message],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
      res.end();
    }, 1000).unref();
  });
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(label, fn) {
  const end = Date.now() + 20_000;
  while (Date.now() < end) { const value = fn(); if (value) return value; await sleep(25); }
  if (currentThread) {
    console.error("diagnostic registry", readFileSync(join(peers, `codex-${currentThread}.json`), "utf8"));
    const thread = await app.readThread(currentThread);
    console.error("diagnostic status", thread.status);
    try { console.error("diagnostic turns", JSON.stringify((await app.latestTurns(currentThread)).map((t) => ({ id: t.id, status: t.status, errorInfo: t.error?.codexErrorInfo })))); }
    catch (error) { console.error("diagnostic summary error", error.message); }
  }
  throw new Error(`timed out: ${label}`);
}
try {
  console.log(execFileSync("codex", ["--version"], { encoding: "utf8" }).trim());
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const env = { ...process.env, CODEX_HOME: join(dir, "codex"), XDG_RUNTIME_DIR: join(dir, "runtime"),
    AGENT_PEERS_HOME: peers, CLAUDE_CONFIG_DIR: join(dir, "claude"), AGENT_PEERS_DEBUG: "0", AGENT_PEERS_LOG: "" };
  for (const key of Object.keys(env)) if (/API_KEY|TOKEN/i.test(key)) delete env[key];
  const overrides = [
    'model="status-test"', 'model_provider="local"',
    `model_providers.local={name="Local contract",base_url="http://127.0.0.1:${provider.address().port}/v1",wire_api="responses",requires_openai_auth=false,request_max_retries=0,stream_max_retries=0}`,
    'features.hooks=false', 'features.memories=false',
    `mcp_servers.agent-peers.command=${JSON.stringify(process.execPath)}`,
    `mcp_servers.agent-peers.args=[${JSON.stringify(join(root, "src", "codex-peer.mjs"))}]`,
    `mcp_servers.agent-peers.env={CODEX_HOME=${JSON.stringify(env.CODEX_HOME)},XDG_RUNTIME_DIR=${JSON.stringify(env.XDG_RUNTIME_DIR)},AGENT_PEERS_HOME=${JSON.stringify(peers)},CLAUDE_CONFIG_DIR=${JSON.stringify(env.CLAUDE_CONFIG_DIR)},AGENT_PEERS_CODEX_APP_SERVER=${JSON.stringify(socket)}}`,
  ];
  child = spawn("codex", [...overrides.flatMap((o) => ["-c", o]), "app-server", "--listen", `unix://${socket}`],
    { env, cwd: dir, stdio: ["ignore", "ignore", "pipe"], detached: true });
  child.stderr.on("data", (data) => { stderr = (stderr + data).slice(-4000); });
  await until("socket", () => {
    if (child.exitCode !== null) throw new Error(`private app-server exited: ${stderr}`);
    return existsSync(socket);
  });
  app = new AppServer();
  const { thread } = await app.request("thread/start", { cwd: dir, approvalPolicy: "never", sandbox: "read-only" });
  currentThread = thread.id;
  const registry = join(peers, `codex-${thread.id}.json`);
  const record = () => { try { return JSON.parse(readFileSync(registry, "utf8")); } catch { return {}; } };
  await until("sidecar bound", () => record().status === "idle");
  const turn = () => app.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "Reply OK.", text_elements: [] }] });
  await turn();
  await until("busy", () => record().status === "active");
  console.log("busy: real thread/status/changed recorded");
  await until("idle + completed", () => record().status === "idle" && record().lastTurn?.status === "completed");
  console.log("idle: real completed turn recovered via thread/turns/list (itemsView:notLoaded)");
  failing = true;
  await turn();
  await until("failed", () => record().lastTurn?.status === "failed");
  assert.equal(record().lastTurn.errorClass, "http_409");
  assert.equal(record().status, "systemError");
  assert.ok(record().lastActivity.at);
  console.log("failed: real systemError + failed/http_409, with runtime activity/completion timestamps");
  const listing = JSON.parse(execFileSync(process.execPath, [join(root, "bin", "agent-peers.mjs"), "list", "--json", "--no-probe"], { env, encoding: "utf8" }));
  assert.equal(listing.peers.find((p) => p.threadId === thread.id).lastTurn.errorClass, "http_409");
  console.log("CLI JSON: registry observation visible; no model service called");

  // Benchmark the real runtime's persisted-history reader in this throwaway home only.
  // Populate its history DB from its own turn/item templates, then restart to avoid caches.
  app.close();
  const stopped = once(child, "close");
  process.kill(-child.pid, "SIGKILL");
  await stopped;
  const sqlite = process.getBuiltinModule?.("node:sqlite");
  assert.ok(sqlite?.DatabaseSync, "large-history check requires Node's node:sqlite support");
  const { DatabaseSync } = sqlite;
  const database = join(dir, "codex", "thread_history_1.sqlite"), history = new DatabaseSync(database);
  const sample = history.prepare("SELECT * FROM thread_turns WHERE thread_id = ? AND status = 'completed' LIMIT 1").get(thread.id);
  assert.ok(sample, "runtime-generated completed-turn template");
  const items = history.prepare("SELECT * FROM thread_items WHERE thread_id = ? AND turn_id = ?").all(thread.id, sample.turn_id);
  assert.ok(items.length > 0);
  const insert = (table, row) => {
    const columns = Object.keys(row);
    return history.prepare(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`);
  };
  const putTurn = insert("thread_turns", sample), putItem = insert("thread_items", items[0]);
  let ordinal = Number(history.prepare("SELECT MAX(rollout_ordinal) AS n FROM thread_items").get().n) + 100;
  const count = 10_000;
  history.exec("BEGIN");
  for (let i = 0; i < count; i++) {
    const id = `10000000-0000-7000-8000-${String(i).padStart(12, "0")}`;
    const row = { ...sample, turn_id: id, root_turn_id: id, rollout_ordinal: ordinal++,
      started_at: Math.floor(Date.now() / 1000) + i, completed_at: Math.floor(Date.now() / 1000) + i };
    putTurn.run(...Object.values(row));
    for (const item of items) putItem.run(...Object.values({ ...item, turn_id: id, rollout_ordinal: ordinal++ }));
  }
  history.exec("COMMIT");
  assert.equal(Number(history.prepare("SELECT COUNT(*) AS n FROM thread_turns WHERE thread_id = ?").get(thread.id).n), count + 2);
  history.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  history.close();
  rmSync(socket, { force: true });
  currentThread = undefined;
  child = spawn("codex", [...overrides.flatMap((o) => ["-c", o]), "app-server", "--listen", `unix://${socket}`],
    { env, cwd: dir, stdio: ["ignore", "ignore", "pipe"], detached: true });
  child.stderr.resume();
  await until("benchmark socket", () => existsSync(socket));
  app = new AppServer();
  await app.loadedThreads();
  const began = performance.now(), summaries = await app.latestTurns(thread.id), elapsed = performance.now() - began;
  assert.equal(summaries.length, 2);
  assert.equal(summaries[0].id, `10000000-0000-7000-8000-${String(count - 1).padStart(12, "0")}`);
  assert.ok(summaries.every((t) => t.items.length === 0), "large history never returns item contents");
  console.log(`large history: ${count} synthetic turns, ${count * items.length} synthetic items, ${statSync(database).size} history DB bytes; cold thread/turns/list ${elapsed.toFixed(1)} ms; two item-free summaries`);
} finally {
  app?.close();
  if (child?.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
  provider.closeAllConnections();
  await new Promise((resolve) => provider.close(resolve));
  await sleep(300);
  rmSync(dir, { recursive: true, force: true });
  originalSocket === undefined ? delete process.env.AGENT_PEERS_CODEX_APP_SERVER : process.env.AGENT_PEERS_CODEX_APP_SERVER = originalSocket;
}
