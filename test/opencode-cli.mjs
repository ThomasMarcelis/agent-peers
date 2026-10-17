// CLI, doctor, discovery and interop for the opencode kind: rows, labels, the tool-only identity,
// and the shared send path a Codex or Hermes session uses to reach an opencode name.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { HermesBridge } from "../src/hermes-bridge.mjs";
import { claim } from "../src/names.mjs";
import { Pins, sendPeer } from "../src/outbox.mjs";
import { codexDiscovery } from "../src/discovery.mjs";
import { address, generation, post, processStart, readLines } from "../src/wire.mjs";
import { listen } from "./listeners.mjs";

const cli = fileURLToPath(new URL("../bin/agent-peers.mjs", import.meta.url));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function home(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ap-oc-cli-")));
  const claude = join(dir, "claude"), peers = join(dir, "peers"), sockets = join(dir, "s");
  for (const path of [join(claude, "sessions"), peers, sockets]) mkdirSync(path, { recursive: true, mode: 0o700 });
  const env = { CLAUDE_CONFIG_DIR: claude, AGENT_PEERS_HOME: peers, XDG_CONFIG_HOME: join(dir, "config"),
    AGENT_PEERS_CODEX_APP_SERVER: join(dir, "missing.sock") };
  writeFileSync(join(claude, "sessions", `${process.pid}.json`), JSON.stringify({
    pid: process.pid, name: "fixture", messagingSocketPath: join(sockets, "fixture.sock"), procStart: processStart(process.pid),
  }));
  const before = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const [key, value] of Object.entries(before)) value === undefined ? delete process.env[key] : process.env[key] = value;
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, claude, peers, sockets, env };
}

const run = (args, env) => new Promise((resolve) => execFile(process.execPath, [cli, ...args], {
  encoding: "utf8", timeout: 15_000, env: { ...process.env, ...env },
}, (error, stdout, stderr) => resolve({ status: error ? error.code ?? 1 : 0, stdout, stderr })));

function opencodeRecord(f, fields = {}) {
  const threadId = fields.threadId ?? "ses_cli";
  return writeFileSync(join(f.peers, `opencode-${threadId}.json`), JSON.stringify({
    name: "opencode:repo-abcdef", address: address(join(f.sockets, "opencode-cli.sock")),
    addresses: [address(join(f.sockets, "opencode-cli.sock"))], cwd: join(f.dir, "repo"), threadId,
    pid: process.pid, procStart: processStart(process.pid), generation: generation("opencode", threadId, processStart(process.pid)),
    startedAt: 1, ...fields,
  }), { mode: 0o600 });
}

test("list shows opencode rows and the OpenCode bridge route, and doctor reports the binary, plugin and records", async (t) => {
  const f = home(t);
  opencodeRecord(f);
  const listed = JSON.parse((await run(["list", "--json", "--no-probe"], f.env)).stdout);
  assert.deepEqual(listed.peers.filter((p) => p.kind === "opencode").map((p) => [p.kind, p.name, p.threadId]),
    [["opencode", "opencode:repo-abcdef", "ses_cli"]]);
  const text = (await run(["list", "--no-probe"], f.env)).stdout;
  assert.match(text, /OpenCode bridge: send_peer \{"to":"uds:/);
  // A fake opencode 2.x and a global config that lists agent-peers.
  const bin = join(f.dir, "bin");
  mkdirSync(bin, { mode: 0o700 });
  const fake = join(bin, "opencode");
  writeFileSync(fake, "#!/bin/sh\necho 2.0.32\n", { mode: 0o755 });
  chmodSync(fake, 0o755);
  const config = join(f.env.XDG_CONFIG_HOME, "opencode");
  mkdirSync(config, { recursive: true, mode: 0o700 });
  writeFileSync(join(config, "opencode.json"), JSON.stringify({ plugins: ["agent-peers"] }));
  const installed = join(config, "node_modules", "agent-peers");
  mkdirSync(installed, { recursive: true, mode: 0o700 });
  writeFileSync(join(installed, "package.json"), JSON.stringify({ name: "agent-peers", version: "1.0.0-rc.6" }));
  const env = { ...f.env, PATH: `${bin}:${process.env.PATH}` };
  const doctor = await run(["doctor", "--json"], env);
  assert.equal(doctor.status, 0, doctor.stderr);
  const checks = Object.fromEntries(JSON.parse(doctor.stdout).checks.map((check) => [check.name, check]));
  assert.equal(checks["opencode binary"].status, "ok");
  assert.match(checks["opencode binary"].message, /2\.0\.32/);
  assert.equal(checks["opencode plugin"].status, "ok");
  assert.match(checks["opencode records"].message, /1 live opencode bridge record/);
  // Version skew is a warning, not a failure, and the CLI still exits 0.
  writeFileSync(join(installed, "package.json"), JSON.stringify({ name: "agent-peers", version: "1.0.0-rc.5" }));
  const skew = await run(["doctor", "--json"], env);
  assert.equal(skew.status, 0, skew.stderr);
  const skewCheck = JSON.parse(skew.stdout).checks.find((check) => check.name === "opencode plugin");
  assert.equal(skewCheck.status, "warning");
  assert.match(skewCheck.message, /version skew: installed opencode plugin 1\.0\.0-rc\.5, CLI 1\.0\.0-rc\.6/);
  // No binary and no config: warnings, still a successful diagnostic.
  const bare = await run(["doctor", "--json"], { ...f.env, PATH: "/nonexistent-path", HOME: f.dir, XDG_CONFIG_HOME: join(f.dir, "absent-config") });
  assert.equal(bare.status, 0, bare.stderr);
  const bareChecks = Object.fromEntries(JSON.parse(bare.stdout).checks.map((check) => [check.name, check]));
  assert.equal(bareChecks["opencode binary"].status, "warning");
  assert.equal(bareChecks["opencode plugin"].status, "warning");
});

test("whoami has no opencode CLI identity and claim inside an opencode shell is no-session", async (t) => {
  const f = home(t);
  // Remove the fixture Claude record of this test process: it is an ancestor of the shell, and
  // whoami would (correctly) report it. Here the question is only whether OPENCODE_SESSION_ID is
  // treated as an identity. It is not.
  rmSync(join(f.claude, "sessions", `${process.pid}.json`), { force: true });
  const shell = join(f.dir, "opencode");
  symlinkSync("/bin/sh", shell);
  const script = `"${process.execPath}" "${cli}" whoami --json 2>&1; echo @@$?; "${process.execPath}" "${cli}" claim proj/lead --json; echo @@$?`;
  const result = await new Promise((resolve) => execFile(shell, ["-c", script], {
    encoding: "utf8", timeout: 15_000, env: { ...process.env, ...f.env, OPENCODE_SESSION_ID: "ses_should_not_matter" },
  }, (error, stdout, stderr) => resolve({ status: error?.code ?? 0, stdout, stderr })));
  const parts = result.stdout.split(/@@(\d+)\n/);
  assert.equal(parts[1], "1", "whoami exits 1");
  assert.match(parts[0], /no Claude Code or Codex session found/);
  assert.doesNotMatch(result.stdout, /opencode:/);
  const claimed = JSON.parse(parts[2]);
  assert.deepEqual([parts[3], claimed.status, claimed.reason], ["1", "refused", "no-session"]);
  assert.match(claimed.text, /nearest agent in this command's process ancestry is a opencode process|nearest agent in this command's process ancestry is an opencode process/);
  assert.match(claimed.text, /opencode identity is tool-only/);
});

test("discovery labels every peer kind by its own recipient, never by 'not Codex'", () => {
  const self = { threadId: "root", rootId: "root", address: "uds:/tmp/self.sock" };
  const peers = [
    { kind: "claude", name: "claude:a", address: "uds:/tmp/a.sock" },
    { kind: "codex", name: "codex:b", address: "uds:/tmp/b.sock", threadId: "b" },
    { kind: "hermes", name: "hermes:c", address: "uds:/tmp/c.sock" },
    { kind: "opencode", name: "opencode:d", address: "uds:/tmp/d.sock" },
    { kind: "future", name: "future:e", address: "uds:/tmp/e.sock" },
  ];
  const rows = codexDiscovery(peers, [], self);
  assert.deepEqual(rows.map((row) => row.native.reason),
    ["Claude recipient", "separate Codex session", "Hermes recipient", "opencode recipient", "separate session"]);
});

test("a Hermes listing includes an opencode row, and a Codex-style send reaches an opencode claimed name", async (t) => {
  const f = home(t);
  opencodeRecord(f);
  // A Hermes bridge lists the opencode row with the right kind and label.
  const bridge = new HermesBridge({ app: { loadedThreads: async () => [], readThread: async () => ({}) } });
  t.after(() => bridge.close());
  const listed = await bridge.request("list_peers");
  const row = listed.peers.find((peer) => peer.kind === "opencode");
  assert.ok(row, JSON.stringify(listed.peers));
  assert.equal(row.name, "opencode:repo-abcdef");
  // A Codex-style sender resolves an opencode claimed name and marks the line with to_name.
  const socket = join(f.sockets, "opencode-name.sock"), lines = [];
  const server = createServer((conn) => readLines(conn, (line) => lines.push(line)));
  await listen(server, socket, t);
  const holderAddress = address(socket);
  opencodeRecord(f, { threadId: "ses_name", name: "opencode:name-abcdef", address: holderAddress, addresses: [holderAddress],
    generation: generation("opencode", "ses_name", processStart(process.pid)) });
  const claimant = { kind: "opencode", owner: generation("opencode", "ses_name"), generation: generation("opencode", "ses_name", processStart(process.pid)),
    address: holderAddress, holder: { pid: process.pid, procStart: processStart(process.pid), autoName: "opencode:name-abcdef", threadId: "ses_name", addresses: [holderAddress] } };
  assert.equal(claim("opencode:proj/role", claimant).status, "claimed");
  const sent = await sendPeer({ to: "opencode:proj/role", message: "to the role", pins: new Pins(), fromName: "codex:sender",
    generation: generation("codex", "T", processStart(process.pid)),
    route: async () => ({ from: address(join(f.sockets, "sender.sock")),
      outbox: { send: async (target, line) => { await post(target, line); return { status: "unconfirmed", reason: "no-receipt" }; } } }) });
  assert.equal(sent.result.status, "unconfirmed");
  await delay(50);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].agent_peers.to_name, "opencode:proj/role");
  assert.match(lines[0].message.content, /to the role/);
});
