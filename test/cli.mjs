import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { WebSocketServer } from "ws";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { VERSION } from "../src/version.mjs";
import { agentProcess, generation, processStart } from "../src/wire.mjs";

const cli = fileURLToPath(new URL("../bin/agent-peers.mjs", import.meta.url));
const sleepPath = ["/bin/sleep", "/usr/bin/sleep"].find((path) => existsSync(path));
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
    assert.deepEqual(JSON.parse(listing.stdout), { peers: [], names: [], recentlyExited: [] });
    for (const args of [["resolve", "claude:x/y"], ["release", "x/y"]]) assert.equal(run(args, env).status, 1);
    const result = run(["doctor", "--json"], env);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.checks.find((c) => c.name === "codex daemon").status, "warning");
    assert.deepEqual(readdirSync(home), []);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("CLI keeps recent exited status-aware sidecars separate from peers and routing", () => {
  const home = mkdtempSync(join(tmpdir(), "ap-cli-exit-")), now = Date.now();
  const peers = join(home, "peers"), sockets = join(home, "cc-socks");
  for (const path of [peers, sockets]) mkdirSync(path, { mode: 0o700 });
  const env = { AGENT_PEERS_HOME: peers, CLAUDE_CONFIG_DIR: join(home, "claude"), XDG_RUNTIME_DIR: home };
  try {
    writeFileSync(join(peers, "codex-exited.json"), JSON.stringify({ pid: 0x7ffffffe, name: "codex:exited", threadId: "exited",
      address: `uds:${join(sockets, "codex-exited.sock")}`, status: "systemError", statusSource: "thread/read",
      statusObservedAt: now - 1000, statusRecordedAt: now - 1000,
      lastTurn: { id: "turn", status: "failed", source: "thread/turns/list", observedAt: now - 2000,
        completedAt: now - 2000, errorClass: "server_overloaded" } }));
    const listed = JSON.parse(run(["list", "--json"], env).stdout);
    assert.deepEqual(listed.peers, []);
    assert.equal(listed.recentlyExited.length, 1);
    assert.equal(listed.recentlyExited[0].lastTurn.errorClass, "server_overloaded");
    assert.equal(listed.recentlyExited[0].address, undefined);
    const text = run(["list"], env).stdout;
    assert.match(text, /Recently exited Codex sidecars/);
    assert.match(text, /codex:exited  last seen .* ago · last turn failed .* ago \(server_overloaded\)/);
    assert.equal(JSON.parse(run(["resolve", "codex:exited", "--json"], env).stdout).reason, "not-running");
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
      generation: generation("claude", shell.pid, undefined, socket), claims: [] });
    assert.equal(text.trim(), `claude:worker\nuds:${socket}`);

    const outside = run(["whoami"], env);
    assert.equal(outside.status, 1);
    assert.match(outside.stderr, /no Claude Code or Codex session found/);
    assert.equal(outside.stdout, "");
    assert.equal(run(["whoami", "--no-probe"], env).status, 2);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// Runs CLI commands from a shell that is the Claude session, as Claude's Bash tool does, and returns
// each command's { status, stdout, stderr }.
// The shell is a Claude session whose registry record has its start, as current Claude Code
// writes; `procStart: false` stands for an older build that records none.
async function inSession({ home, env }, socket, commands, { procStart: recorded = true } = {}) {
  const steps = commands.map((args) => `out=$("${process.execPath}" "${cli}" ${args} 2>"${home}/err"); status=$?; ` +
    `printf '%s\\n' "$out"; printf 'E:'; cat "${home}/err"; echo "@@$status"`);
  const shell = execFile("sh", ["-c", `read go; ${steps.join("; ")}`], { encoding: "utf8", env: { ...process.env, ...env } });
  let out = "";
  shell.stdout.on("data", (d) => { out += d; });
  const procStart = recorded ? processStart(shell.pid) : undefined;
  writeFileSync(join(home, "claude", "sessions", `${shell.pid}.json`), JSON.stringify({ pid: shell.pid, name: "lead", cwd: "/tmp",
    messagingSocketPath: socket, procStart }));
  shell.stdin.end("go\n");
  await once(shell, "close");
  return { pid: shell.pid, procStart, results: out.split(/@@(\d+)\n/).reduce((acc, part, i, all) => {
    if (i % 2 === 0 && i + 1 < all.length) {
      const [stdout, stderr] = part.split("E:");
      acc.push({ stdout, stderr, status: Number(all[i + 1]) });
    }
    return acc;
  }, []) };
}

test("claim, resolve, list, whoami and release from inside a Claude session, with exit codes 0, 1 and 2", async () => {
  const session = sessionHome(), socket = join(session.sockets, "lead.sock"), addr = `uds:${socket}`;
  try {
    const { pid, procStart, results } = await inSession(session, socket, ["claim proj/lead --json", "claim proj/lead", "whoami --json",
      "resolve claude:proj/lead", "resolve proj/lead --json", "list --json --no-probe", "list --no-probe", "claim codex:proj/x --json",
      "claim Proj/x", "claim a/b c/d", "resolve proj/missing", "release proj/lead", "resolve proj/lead --json"]);
    const [claimed, again, me, resolved, resolvedJson, listed, text, denied, invalid, usage, missing, released, gone] = results;
    const gen = generation("claude", pid, procStart, socket);
    assert.equal(claimed.status, 0, claimed.stderr);
    assert.deepEqual(JSON.parse(claimed.stdout), { status: "claimed", reason: null, name: "claude:proj/lead", kind: "claude", generation: gen,
      address: addr, previous: null, text: "Claimed claude:proj/lead; senders now reach this session by that name." });
    assert.deepEqual([again.status, again.stdout.trim()], [0, "claude:proj/lead already names this session."]);
    assert.deepEqual(JSON.parse(me.stdout).claims, ["claude:proj/lead"]);
    assert.deepEqual([resolved.status, resolved.stdout, resolved.stderr], [0, `${addr}\n`, ""], "exactly one uds: line");
    assert.deepEqual(JSON.parse(resolvedJson.stdout), { status: "resolved", reason: null, name: "claude:proj/lead", kind: "claude", address: addr,
      generation: gen, text: addr });
    const { peers, names } = JSON.parse(listed.stdout);
    assert.deepEqual(peers.map((p) => [p.name, p.claims]), [["claude:lead", ["claude:proj/lead"]]]);
    assert.equal(names.length, 1);
    assert.deepEqual({ ...names[0], claimedAt: 0 }, { name: "claude:proj/lead", kind: "claude", running: true, address: addr, addresses: [addr],
      generation: gen, holder: "claude:lead", claimedAt: 0 });
    assert.match(text.stdout, /claimed names: claude:proj\/lead/);
    assert.match(text.stdout, new RegExp(`claude:proj/lead  running  SendMessage \\{"to":"${addr}"\\}`));
    assert.deepEqual([denied.status, JSON.parse(denied.stdout).reason], [1, "scope-denied"]);
    assert.deepEqual([invalid.status, invalid.stdout], [2, "\n"]);
    assert.match(invalid.stderr, /is not a claimed name/);
    assert.equal(usage.status, 2);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /No session has claimed "proj\/missing"/);
    assert.equal(released.status, 0);
    assert.deepEqual([gone.status, JSON.parse(gone.stdout).reason], [1, "not-found"]);

    // No Claude session of this registry here; run inside a real Claude session, that session is a
    // nested agent without a record in this test's registry. Either way, nothing is claimed.
    const outside = run(["claim", "proj/lead"], session.env);
    assert.equal(outside.status, 1);
    assert.match(outside.stderr, /no Claude Code session found in this process's ancestry|without a Claude session record/);
  } finally { rmSync(session.home, { recursive: true, force: true }); }
});

test("a dead claim stays listed as not running, and anyone may release it", async () => {
  const session = sessionHome(), socket = join(session.sockets, "lead.sock");
  try {
    const { results } = await inSession(session, socket, ["claim proj/lead"]);
    assert.equal(results[0].status, 0, results[0].stderr);
    // The shell has exited, so the claim's holder is not running.
    const listed = JSON.parse(run(["list", "--json"], session.env).stdout);
    assert.deepEqual(listed.names.map((row) => [row.name, row.running, row.address, row.holder]), [["claude:proj/lead", false, null, null]]);
    assert.match(run(["list"], session.env).stdout, /\+1 reserved names not running/);
    assert.doesNotMatch(run(["list"], session.env).stdout, /claude:proj\/lead/);
    assert.match(run(["list", "--all-names"], session.env).stdout, /claude:proj\/lead  not running/);
    const resolved = run(["resolve", "claude:proj/lead"], session.env);
    assert.equal(resolved.status, 1);
    assert.match(resolved.stderr, /is claimed by claude:lead, a Claude session that is no longer running/);
    // The CLI releases only claude: names, dead or not; other kinds are left to their own claimants.
    const foreign = run(["release", "hermes:jd/relay", "--json"], session.env);
    assert.deepEqual([foreign.status, JSON.parse(foreign.stdout).reason], [1, "scope-denied"]);
    assert.equal(run(["release", "proj/lead"], session.env).status, 0);
    assert.deepEqual(JSON.parse(run(["list", "--json"], session.env).stdout).names, []);
  } finally { rmSync(session.home, { recursive: true, force: true }); }
});

test("an agent process recognises claude, codex and hermes by name or script, and nothing else", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "ap-agent-")), children = [];
  t.after(() => { for (const child of children) child.kill(); rmSync(home, { recursive: true, force: true }); });
  symlinkSync(sleepPath, join(home, "claude"));
  symlinkSync(sleepPath, join(home, "hermes"));
  writeFileSync(join(home, "codex.js"), "setTimeout(() => {}, 60_000);");
  writeFileSync(join(home, "agent-peers.mjs"), "setTimeout(() => {}, 60_000);");
  const start = async (command, args) => {
    const child = spawn(command, args, { stdio: "ignore" });
    children.push(child);
    await once(child, "spawn");
    // The exec has happened once the process no longer runs this test's own command.
    for (let i = 0; i < 100 && agentProcess(child.pid) === agentProcess(process.pid); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    return child.pid;
  };
  const cases = [[join(home, "claude"), ["60"], "claude"], [join(home, "hermes"), ["60"], "hermes"], [process.execPath, [join(home, "codex.js")], "codex"],
    [sleepPath, ["60"], undefined], [process.execPath, [join(home, "agent-peers.mjs")], undefined]];
  for (const [command, args, expected] of cases) assert.equal(agentProcess(await start(command, args)), expected, `${command} ${args.join(" ")}`);
  assert.equal(agentProcess(process.pid), undefined, "a test runner is no agent");
});

test("a nested agent without a Claude session record never claims or releases for the Claude session above it", async () => {
  const session = sessionHome(), socket = join(session.sockets, "lead.sock"), worker = join(session.home, "codex");
  // A Codex worker the Claude lead started: a shell exec'd under the name codex, with no Claude record.
  symlinkSync("/bin/sh", worker);
  const run = (args) => `"${process.execPath}" "${cli}" ${args}`;
  try {
    const shell = execFile("sh", ["-c", `read go; ${run("claim proj/lead")} >/dev/null; ` +
      `"${worker}" -c '${run("claim proj/worker --json")}; echo @@; ${run("release proj/lead --json")}; echo @@; ${run("list --json --no-probe")}; true'; ` +
      `echo @@; ${run("whoami --json")}; true`], { encoding: "utf8", env: { ...process.env, ...session.env } });
    let out = "";
    shell.stdout.on("data", (d) => { out += d; });
    writeFileSync(join(session.home, "claude", "sessions", `${shell.pid}.json`), JSON.stringify({ pid: shell.pid, name: "lead", cwd: "/tmp",
      messagingSocketPath: socket, procStart: processStart(shell.pid) }));
    shell.stdin.end("go\n");
    await once(shell, "close");
    const [claimed, released, listed, me] = out.split("@@\n").map((part) => JSON.parse(part));
    assert.deepEqual([claimed.status, claimed.reason, claimed.name], ["refused", "no-session", "claude:proj/worker"]);
    assert.match(claimed.text, /nearest agent in this command's process ancestry is a codex process \(pid \d+\) without a Claude session record/);
    assert.deepEqual([released.status, released.reason], ["refused", "not-holder"], "the lead's running name is not released as the lead");
    assert.deepEqual(listed.names.map((row) => [row.name, row.running]), [["claude:proj/lead", true]]);
    assert.deepEqual(me.claims, ["claude:proj/lead"], "the lead still holds its name, and nothing else");
  } finally { rmSync(session.home, { recursive: true, force: true }); }
});

test("a Claude session whose registry records no start time cannot claim a name", async () => {
  const session = sessionHome(), socket = join(session.sockets, "lead.sock");
  try {
    const { results: [refused] } = await inSession(session, socket, ["claim proj/lead --json"], { procStart: false });
    const result = JSON.parse(refused.stdout);
    assert.deepEqual([refused.status, result.status, result.reason, result.name, result.generation], [1, "refused", "unsupported-host", "claude:proj/lead", null]);
    assert.match(result.text, /records no process start time .* Update Claude Code to claim names\. Nothing changed\.$/);
    assert.equal(existsSync(join(session.home, "peers", "names")), false, "nothing was written");
  } finally { rmSync(session.home, { recursive: true, force: true }); }
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
