import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { WebSocketServer } from "ws";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { VERSION } from "../src/version.mjs";

const cli = fileURLToPath(new URL("../bin/agent-peers.mjs", import.meta.url));
// For tests whose fake servers live in this process: spawnSync would block their event loop.
function runAsync(args, env = {}) {
  return new Promise((resolve) => execFile(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 10_000,
    env: { ...process.env, ...env } }, (error, stdout, stderr) => resolve({ status: error ? error.code ?? 1 : 0, stdout, stderr })));
}
function run(args, env = {}) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 10_000, env: { ...process.env, ...env } });
}

test("CLI help/version work and invalid options fail without a stack trace", () => {
  for (const args of [[], ["--help"], ["help"]]) {
    const result = run(args);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /list \[--json\]/);
    assert.equal(result.stderr, "");
  }
  assert.equal(run(["--version"]).stdout.trim(), VERSION);
  for (const args of [["nope"], ["list", "--wrong"], ["hermes-bridge", "--json"], ["--version", "extra"]]) {
    const result = run(args);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.doesNotMatch(result.stderr, /\n\s+at /);
  }
});

test("empty discovery and doctor are structured and do not create state", () => {
  const home = mkdtempSync(join(tmpdir(), "ap-cli-"));
  try {
    const env = { CLAUDE_CONFIG_DIR: join(home, "claude"), AGENT_PEERS_HOME: join(home, "peers"),
      AGENT_PEERS_CODEX_APP_SERVER: join(home, "missing.sock") };
    const listing = run(["list", "--json"], env);
    assert.equal(listing.status, 0, listing.stderr);
    assert.deepEqual(JSON.parse(listing.stdout), { peers: [] });
    const result = run(["doctor", "--json"], env);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.checks.find((c) => c.name === "codex daemon").status, "warning");
    assert.deepEqual(readdirSync(home), []);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("doctor reports invalid paths as errors", () => {
  const result = run(["doctor", "--json"], { AGENT_PEERS_HOME: "relative-peers" });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).checks.find((c) => c.name === "peer registry").status, "error");
});

// A minimal app-server: it completes the handshake and reports the given loaded threads.
async function answeringDaemon(path, threads = []) {
  const http = createHttpServer(), wss = new WebSocketServer({ server: http });
  wss.on("connection", (ws) => ws.on("message", (data) => {
    const message = JSON.parse(data);
    if (message.method === "initialize") ws.send(JSON.stringify({ id: message.id, result: {} }));
    else if (message.method === "thread/loaded/list") ws.send(JSON.stringify({ id: message.id, result: { data: threads } }));
  }));
  http.listen(path); await once(http, "listening");
  return async () => {
    for (const ws of wss.clients) ws.terminate();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => http.close(resolve));
  };
}

test("doctor accepts Codex's owned daemon symlink but rejects unsafe target directories", async () => {
  const home = mkdtempSync(join(tmpdir(), "ap-doctor-"));
  const directory = join(home, "runtime"), link = join(home, "daemon.sock"), socket = join(directory, "actual.sock");
  mkdirSync(directory, { mode: 0o700 });
  let stop;
  try {
    stop = await answeringDaemon(socket, ["019a0000-0000-7000-8000-000000000001"]);
    symlinkSync(socket, link);
    const env = { CLAUDE_CONFIG_DIR: join(home, "claude"), AGENT_PEERS_HOME: join(home, "peers"), AGENT_PEERS_CODEX_APP_SERVER: link };
    const result = await runAsync(["doctor", "--json"], env);
    assert.equal(result.status, 0, result.stdout);
    const daemon = JSON.parse(result.stdout).checks.find((c) => c.name === "codex daemon");
    assert.equal(daemon.status, "ok");
    assert.match(daemon.message, /answering; 1 loaded threads/);
    chmodSync(directory, 0o777);
    const unsafe = await runAsync(["doctor", "--json"], env);
    assert.equal(unsafe.status, 1);
    assert.equal(JSON.parse(unsafe.stdout).checks.find((c) => c.name === "codex daemon").status, "error");
  } finally {
    await stop?.();
    rmSync(home, { recursive: true, force: true });
  }
});

test("doctor warns when a daemon socket exists but its server does not answer, or its link is stale", async () => {
  const home = mkdtempSync(join(tmpdir(), "ap-doctor-"));
  const socket = join(home, "silent.sock"), stale = join(home, "stale.sock");
  // Accepts connections but never speaks the app-server protocol, like a socket left behind.
  const server = createServer((connection) => connection.destroy());
  try {
    server.listen(socket);
    await once(server, "listening");
    const base = { CLAUDE_CONFIG_DIR: join(home, "claude"), AGENT_PEERS_HOME: join(home, "peers") };
    const silent = await runAsync(["doctor", "--json"], { ...base, AGENT_PEERS_CODEX_APP_SERVER: socket });
    assert.equal(silent.status, 0, silent.stderr);
    const check = JSON.parse(silent.stdout).checks.find((c) => c.name === "codex daemon");
    assert.equal(check.status, "warning");
    assert.match(check.message, /is not answering .*configured app-server is not running/);

    symlinkSync(join(home, "gone", "daemon.sock"), stale);
    const text = await runAsync(["doctor"], { ...base, AGENT_PEERS_CODEX_APP_SERVER: stale });
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /WARNING codex daemon: .*stale\.sock links to a missing socket .*codex app-server daemon start/);
    assert.deepEqual(readdirSync(home).sort(), ["silent.sock", "stale.sock"]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(home, { recursive: true, force: true });
  }
});
