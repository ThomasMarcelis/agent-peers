import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { WebSocketServer } from "ws";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { VERSION } from "../src/version.mjs";
import { generation } from "../src/wire.mjs";

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

function sessionHome() {
  const home = mkdtempSync(join(tmpdir(), "ap-who-"));
  const sockets = join(home, "s");
  mkdirSync(join(home, "claude", "sessions"), { recursive: true });
  mkdirSync(sockets, { mode: 0o700 });
  return { home, sockets, env: { CLAUDE_CONFIG_DIR: join(home, "claude"), AGENT_PEERS_HOME: join(home, "peers") } };
}

test("whoami finds the calling Claude session through process ancestry and fails outside one", async () => {
  const { home, sockets, env } = sessionHome();
  const socket = join(sockets, "me.sock");
  try {
    // The shell is the "session": it owns the record and is the CLI's ancestor.
    const shell = execFile("sh", ["-c", `read go; "${process.execPath}" "${cli}" whoami --json; echo ---; "${process.execPath}" "${cli}" whoami; true`],
      { encoding: "utf8", env: { ...process.env, ...env } });
    let out = "";
    shell.stdout.on("data", (d) => { out += d; });
    writeFileSync(join(home, "claude", "sessions", `${shell.pid}.json`),
      JSON.stringify({ pid: shell.pid, name: "worker", cwd: "/tmp", messagingSocketPath: socket }));
    const server = createServer();
    server.listen(socket);
    await once(server, "listening");
    shell.stdin.end("go\n");
    await once(shell, "close");
    server.close();
    const [json, text] = out.split("---\n");
    assert.deepEqual(JSON.parse(json), { name: "claude:worker", address: `uds:${socket}`, kind: "claude", cwd: "/tmp", pid: shell.pid,
      generation: generation("claude", shell.pid, undefined, socket) });
    assert.equal(text.trim(), `claude:worker\nuds:${socket}`);

    const outside = run(["whoami"], env);
    assert.equal(outside.status, 1);
    assert.match(outside.stderr, /no Claude Code or Codex session found/);
    assert.equal(outside.stdout, "");
    assert.equal(run(["whoami", "--no-probe"], env).status, 2);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("list marks a refusing socket stale without removing the record; --no-probe skips the check", async () => {
  const { home, sockets, env } = sessionHome();
  const live = join(sockets, "live.sock"), dead = join(sockets, "dead.sock");
  const server = createServer();
  try {
    server.listen(live);
    await once(server, "listening");
    // A killed listener leaves its socket file behind, as a crashed session does.
    const orphan = execFile(process.execPath, ["-e", `require("net").createServer().listen(${JSON.stringify(dead)},()=>console.log("up"))`]);
    await once(orphan.stdout, "data");
    orphan.kill("SIGKILL");
    await once(orphan, "close");
    // Any live pid will do for a record; use this test process and its parent.
    for (const [pid, name, sock] of [[process.pid, "alive", live], [process.ppid, "gone", dead]]) {
      writeFileSync(join(home, "claude", "sessions", `${pid}.json`), JSON.stringify({ pid, name, messagingSocketPath: sock }));
    }
    const listed = JSON.parse((await runAsync(["list", "--json"], env)).stdout).peers;
    assert.deepEqual(listed.map((p) => [p.name, p.reachable]).sort(), [["claude:alive", true], ["claude:gone", false]]);
    const text = (await runAsync(["list"], env)).stdout;
    assert.match(text, /claude:gone\s+stale/);
    assert.doesNotMatch(text, /claude:alive\s+stale/);
    const unprobed = JSON.parse((await runAsync(["list", "--json", "--no-probe"], env)).stdout).peers;
    assert.equal(unprobed.length, 2);
    assert.ok(unprobed.every((p) => !("reachable" in p)));
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});
