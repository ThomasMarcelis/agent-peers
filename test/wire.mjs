import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { Socket, connect, createServer } from "node:net";
import { once } from "node:events";
import { join } from "node:path";
import { test } from "node:test";
import { MAX_LINE, address, alive, ancestorPids, inDiscoveryScope, whoami, claudeSessions, codexPeers, ensurePrivateDir, generation,
  messageLine, nameLabel, peerSocket, post, processStart, readLines, recentlyExitedCodex, recordRunning, socketDir, socketPath, stalePeers } from "../src/wire.mjs";
import { closeServer, listen } from "./listeners.mjs";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { Receipts, readMessage } from "../src/inbox.mjs";
import { Pins } from "../src/outbox.mjs";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "ap-wire-"));
  const claude = join(dir, "claude"), peers = join(dir, "peers"), sockets = join(dir, "sockets");
  for (const path of [join(claude, "sessions"), peers, sockets]) mkdirSync(path, { recursive: true, mode: 0o700 });
  const before = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, AGENT_PEERS_HOME: process.env.AGENT_PEERS_HOME,
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, TMPDIR: process.env.TMPDIR };
  Object.assign(process.env, { CLAUDE_CONFIG_DIR: claude, AGENT_PEERS_HOME: peers });
  writeFileSync(join(claude, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, name: "fixture", messagingSocketPath: join(sockets, "claude.sock") }));
  t.after(() => {
    for (const [key, value] of Object.entries(before)) value === undefined ? delete process.env[key] : process.env[key] = value;
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, claude, peers, sockets };
}

class Connection extends EventEmitter {
  destroyed = false;
  setTimeout() {}
  destroy() { this.destroyed = true; }
}

test("invalid transport frames are diagnosed without leaking their raw contents", (t) => {
  // Diagnostics refuse symlinked log paths, and macOS tmpdir() sits under the /var symlink.
  const f = fixture(t), logfile = join(realpathSync(f.dir), "wire.jsonl");
  const before = { AGENT_PEERS_DEBUG: process.env.AGENT_PEERS_DEBUG, AGENT_PEERS_LOG: process.env.AGENT_PEERS_LOG };
  Object.assign(process.env, { AGENT_PEERS_DEBUG: "1", AGENT_PEERS_LOG: logfile });
  t.after(() => {
    for (const [key, value] of Object.entries(before)) value === undefined ? delete process.env[key] : process.env[key] = value;
  });
  const conn = new Connection(), received = [];
  readLines(conn, (line) => received.push(line));
  conn.emit("data", Buffer.from('SECRET_BROKEN_JSON\n{"ok":true}\nSECRET_PARTIAL'));
  conn.emit("end");
  assert.deepEqual(received, [{ ok: true }]);
  const text = readFileSync(logfile, "utf8");
  assert.doesNotMatch(text, /SECRET_/);
  const rows = text.trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(rows.some((e) => e.event === "frame.drop" && e.reason === "invalid_json"));
  assert.ok(rows.some((e) => e.event === "frame.drop" && e.reason === "incomplete_frame"));
});

test("private directories reject shared modes and symlinks", (t) => {
  const f = fixture(t);
  assert.equal(ensurePrivateDir(f.peers), f.peers);
  assert.equal(lstatSync(ensurePrivateDir(join(f.dir, "new"))).mode & 0o777, 0o700);
  chmodSync(f.peers, 0o755);
  assert.throws(() => ensurePrivateDir(f.peers), /unsafe peer directory/);
  symlinkSync(f.sockets, join(f.dir, "link"));
  assert.throws(() => ensurePrivateDir(join(f.dir, "link")), /unsafe peer directory/);
});

test("addresses reject escapes, traversal, invalid encoding, and substituted symlinks", (t) => {
  const f = fixture(t), target = join(f.sockets, "peer.sock");
  assert.equal(peerSocket(address(target)), target);
  assert.equal(peerSocket(address(join(f.sockets, "é".repeat(50) + ".sock"))), undefined);
  for (const invalid of ["uds:/outside/a.sock", `uds:${f.sockets}/../x.sock`, `uds:${f.sockets}/%00.sock`, `uds:${f.sockets}/%ZZ.sock`, `uds:${f.sockets}/%70eer.sock`]) {
    assert.equal(peerSocket(invalid), undefined);
  }
  assert.equal(socketPath(null), undefined);
  assert.equal(socketPath("uds:%ZZ"), undefined);
  writeFileSync(join(f.dir, "file"), "not a socket");
  symlinkSync(join(f.dir, "file"), target);
  assert.equal(peerSocket(address(target)), undefined);
});

test("registry records reject process groups, malformed identities, untrusted paths, and symlinks", (t) => {
  const f = fixture(t), path = join(f.peers, "codex-test.json");
  const valid = { pid: process.pid, name: "codex:test", threadId: "thread-id", address: address(join(f.sockets, "codex-test.sock")), kind: "evil" };
  writeFileSync(path, JSON.stringify(valid));
  assert.equal(codexPeers()[0].kind, "codex");
  for (const pid of [0, -1, "123", 1.5, 0x80000000]) {
    assert.equal(alive(pid), false);
    writeFileSync(path, JSON.stringify({ ...valid, pid }));
    assert.deepEqual(codexPeers(), []);
  }
  for (const patch of [{ name: {} }, { name: "codex:\nspoof" }, { threadId: "../escape" }, { address: "uds:/outside/a.sock" }]) {
    writeFileSync(path, JSON.stringify({ ...valid, ...patch }));
    assert.deepEqual(codexPeers(), []);
  }
  rmSync(path); symlinkSync(join(f.claude, "sessions", `${process.pid}.json`), path);
  assert.deepEqual(codexPeers(), []);
  writeFileSync(join(f.claude, "sessions", "1.json"), JSON.stringify({ pid: process.pid, messagingSocketPath: join(f.sockets, "forged.sock") }));
  assert.equal(claudeSessions().length, 1);
});

test("registry status is additive; recent exits are bounded, confirmed and separate from routing", (t) => {
  const f = fixture(t), now = Date.now();
  const base = { pid: process.pid, name: "codex:test", threadId: "test", address: address(join(f.sockets, "codex-test.sock")) };
  const path = join(f.peers, "codex-test.json");
  writeFileSync(path, JSON.stringify(base));
  assert.equal(codexPeers()[0].statusObservedAt, undefined);
  assert.deepEqual(recentlyExitedCodex(now), []);
  const status = { status: "idle", statusObservedAt: now, statusSource: "thread/read", statusRecordedAt: now - 1000,
    lastTurn: { id: "turn", status: "failed", observedAt: now, completedAt: now - 2000, source: "thread/turns/list", errorClass: "server_overloaded" } };
  writeFileSync(path, JSON.stringify({ ...base, ...status }));
  assert.equal(codexPeers()[0].lastTurn.errorClass, "server_overloaded");
  assert.deepEqual(recentlyExitedCodex(now), [], "a running process is never classified as exited");
  writeFileSync(path, JSON.stringify({ ...base, ...status, inboxClosedAt: now }));
  assert.deepEqual(codexPeers(), [], "a retained closed inbox cannot reappear, even with no process-start evidence");
  assert.deepEqual(recentlyExitedCodex(now), [], "inbox closure alone does not prove process exit");
  writeFileSync(path, JSON.stringify({ ...base, ...status, procStart: "different-process" }));
  assert.deepEqual(codexPeers(), []);
  const [exited] = recentlyExitedCodex(now);
  assert.equal(exited.lastTurn.errorClass, "server_overloaded");
  assert.equal(exited.exitObservedAt, now);
  assert.equal(exited.lastSeenAt, now - 1000);
  assert.equal(exited.address, undefined, "exited rows have no message route");
  assert.deepEqual(recentlyExitedCodex(now + 60 * 60_000), []);
  writeFileSync(path, JSON.stringify({ ...base, ...status, pid: 0x7fffffff }));
  assert.equal(recentlyExitedCodex(now).length, 1, "a gone PID also proves exit");
  writeFileSync(path, JSON.stringify({ ...base, ...status, procStart: "different-process", statusRecordedAt: now + 1000 }));
  assert.deepEqual(recentlyExitedCodex(now), [], "future timestamps do not prove a recent exit");
});

test("framing applies the byte limit to each line, including its newline", () => {
  const conn = new Connection(), lines = [];
  readLines(conn, (line) => lines.push(line));
  const large = JSON.stringify("a".repeat(MAX_LINE - 3)) + "\n";
  assert.equal(Buffer.byteLength(large), MAX_LINE);
  conn.emit("data", Buffer.from(large + large));
  assert.equal(lines.length, 2);
  assert.equal(conn.destroyed, false);
  const invalid = new Connection();
  readLines(invalid, () => assert.fail("oversized frame delivered"));
  invalid.emit("data", Buffer.from('"' + "a".repeat(MAX_LINE - 1)));
  assert.equal(invalid.destroyed, true);
});

test("framing preserves split UTF-8 and recovers after malformed complete JSON", () => {
  const conn = new Connection(), lines = [];
  readLines(conn, (line) => lines.push(line));
  const data = Buffer.from('null\ninvalid\n{"message":"😀日本語"}\n');
  for (const byte of data) conn.emit("data", Buffer.from([byte]));
  assert.deepEqual(lines, [null, { message: "😀日本語" }]);
  assert.equal(conn.destroyed, false);
});

test("posting validates paths and size before opening a connection", async (t) => {
  const f = fixture(t);
  await assert.rejects(post("/outside/a.sock", {}), /invalid peer inbox/);
  await assert.rejects(post(join(f.sockets, "missing.sock"), { text: "x".repeat(MAX_LINE) }), /message too large/);
  await assert.rejects(post(join(f.sockets, "missing.sock"), {}), /ENOENT/);
});

// Larger than any Unix socket send buffer, so the write can only complete if the peer reads.
const unreadable = () => ({ text: "x".repeat(MAX_LINE - 100) });

test("posting times out when the peer accepts but never reads, and closes its connection", { timeout: 20_000 }, async (t) => {
  const f = fixture(t), socket = join(f.sockets, "stalled.sock");
  let accepted;
  const connection = new Promise((resolve) => { accepted = resolve; });
  // pauseOnConnect: the listener accepts the connection but never reads from it.
  await listen(createServer({ pauseOnConnect: true }, accepted), socket, t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let settled = false;
  const sending = post(socket, unreadable());
  sending.then(() => { settled = true; }, () => { settled = true; });
  const conn = await connection;
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "the write is still pending on the unread connection");
  t.mock.timers.tick(4999);
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "no rejection before the 5 s deadline");
  t.mock.timers.tick(1);
  await assert.rejects(sending, /peer inbox did not accept the message within 5 s/);
  // The sender destroyed its end: once the peer reads, it sees the end of the stream, not a line.
  const lines = [];
  readLines(conn, (line) => lines.push(line));
  conn.resume();
  await once(conn, "close");
  assert.deepEqual(lines, []);
});

test("a line already handed to the kernel is written, even if the deadline passes before its callback", { timeout: 20_000 }, async (t) => {
  const f = fixture(t), socket = join(f.sockets, "late-callback.sock"), lines = [];
  await listen(createServer((conn) => readLines(conn, (line) => lines.push(line))), socket, t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const end = Socket.prototype.end;
  t.after(() => { Socket.prototype.end = end; });
  // As after a 5 s event-loop stall: end() wrote the line, then the deadline fires first.
  Socket.prototype.end = function (...args) {
    Socket.prototype.end = end;
    const out = end.apply(this, args);
    t.mock.timers.tick(5000);
    return out;
  };
  await post(socket, { type: "user", msg_id: "m1" });
  t.mock.timers.reset();
  for (let i = 0; i < 200 && !lines.length; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(lines.map((line) => line.msg_id), ["m1"]);
});

test("posting rejects promptly when the peer closes before accepting the message", {
  timeout: 20_000,
}, async (t) => {
  const f = fixture(t), socket = join(f.sockets, "closing.sock");
  await listen(createServer({ pauseOnConnect: true }, (conn) => conn.destroy()), socket, t);
  // With setTimeout mocked and never advanced, the 5 s timeout cannot be what rejects.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await assert.rejects(post(socket, unreadable()), /EPIPE|ECONNRESET|closed before accepting/);
});

test("posting to an inbox whose listener is gone is refused at once", { timeout: 20_000 }, async (t) => {
  const f = fixture(t), stale = join(f.sockets, "stale.sock");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  // A peer that exited without unlinking its inbox leaves a socket nobody listens on.
  const child = spawnSync(process.execPath, ["-e",
    `require("node:net").createServer().listen(${JSON.stringify(stale)}, () => process.exit(0))`]);
  assert.equal(child.status, 0);
  assert.equal(lstatSync(stale).isSocket(), true);
  await assert.rejects(post(stale, {}), /ECONNREFUSED/);
});

test("an idle connection is dropped after 30 s, discarding its incomplete frame", (t) => {
  const f = fixture(t), logfile = join(realpathSync(f.dir), "idle.jsonl");
  const before = { AGENT_PEERS_DEBUG: process.env.AGENT_PEERS_DEBUG, AGENT_PEERS_LOG: process.env.AGENT_PEERS_LOG };
  Object.assign(process.env, { AGENT_PEERS_DEBUG: "1", AGENT_PEERS_LOG: logfile });
  t.after(() => {
    for (const [key, value] of Object.entries(before)) value === undefined ? delete process.env[key] : process.env[key] = value;
  });
  // readLines arms the idle timeout through the connection it is given, so a stand-in
  // connection captures it; node:test mock timers do not reach socket timeouts.
  const conn = new Connection(), lines = [], armed = [];
  conn.setTimeout = (ms, callback) => armed.push({ ms, callback });
  readLines(conn, (line) => lines.push(line));
  assert.deepEqual(armed.map(({ ms }) => ms), [30_000]);
  conn.emit("data", Buffer.from('{"complete":true}\n{"partial":'));
  assert.equal(conn.destroyed, false);
  armed[0].callback();
  assert.equal(conn.destroyed, true);
  assert.deepEqual(lines, [{ complete: true }]);
  const drop = readFileSync(logfile, "utf8").trim().split("\n").map((line) => JSON.parse(line))
    .find((e) => e.event === "frame.drop");
  assert.equal(drop.reason, "idle_timeout");
  assert.equal(drop.bytes, Buffer.byteLength('{"partial":'));
});

test("the idle timeout is armed on the real socket and closes a silent peer's connection", { timeout: 20_000 }, async (t) => {
  const f = fixture(t), socket = join(f.sockets, "idle.sock"), lines = [], armed = [];
  // Scale the 30 s timeout on the real server-side socket so the test does not wait for it.
  await listen(createServer((conn) => {
    const setTimeout = conn.setTimeout.bind(conn);
    conn.setTimeout = (ms, callback) => { armed.push(ms); return setTimeout(ms / 1000, callback); };
    readLines(conn, (line) => lines.push(line));
  }), socket, t);
  const client = connect(socket);
  t.after(() => client.destroy());
  client.on("error", () => {});
  await once(client, "connect");
  client.write('{"before":"idle"}\n{"never":');
  await once(client, "close");
  assert.deepEqual(armed, [30_000]);
  assert.deepEqual(lines, [{ before: "idle" }]);
});


test("peers started before Claude retain their inbox when Claude publishes its first registry record", async (t) => {
  const f = fixture(t);
  rmSync(join(f.claude, "sessions", `${process.pid}.json`));
  delete process.env.XDG_RUNTIME_DIR;
  process.env.TMPDIR = f.dir;
  const before = socketDir();
  assert.equal(before, join(f.dir, "cc-socks"));
  const socket = join(before, "codex-early.sock"), messages = [];
  const server = createServer((connection) => readLines(connection, (line) => messages.push(line)));
  try {
    await listen(server, socket);
    writeFileSync(join(f.peers, "codex-early.json"), JSON.stringify({
      pid: process.pid, name: "codex:early", threadId: "early", address: address(socket),
    }));
    assert.equal(codexPeers()[0].address, address(socket));
    await post(socket, { text: "before Claude" });
    // This is Claude 2.1.288's directory rule: XDG_RUNTIME_DIR || os.tmpdir(), then cc-socks.
    writeFileSync(join(f.claude, "sessions", `${process.pid}.json`), JSON.stringify({
      pid: process.pid, name: "late", messagingSocketPath: join(f.dir, "cc-socks", `${process.pid}.sock`),
    }));
    assert.equal(socketDir(), before);
    assert.equal(peerSocket(address(socket)), socket);
    assert.equal(codexPeers()[0].address, address(socket));
    await post(socket, { text: "after Claude" });
    for (let i = 0; messages.length < 2 && i < 100; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(messages, [{ text: "before Claude" }, { text: "after Claude" }]);
  } finally { await closeServer(server); }
});

test("Claude's runtime-directory preference and long-path fallback apply before it starts", (t) => {
  const f = fixture(t);
  rmSync(join(f.claude, "sessions", `${process.pid}.json`));
  process.env.TMPDIR = join(f.dir, "temp");
  process.env.XDG_RUNTIME_DIR = join(f.dir, "runtime");
  assert.equal(socketDir({ create: false }), join(f.dir, "runtime", "cc-socks"));
  process.env.XDG_RUNTIME_DIR = join(f.dir, "x".repeat(110));
  assert.equal(socketDir({ create: false }), `/tmp/cc-socks-${userInfo().uid}`);
});


test("mixed Claude directories preserve old Codex and unregistered Hermes reply addresses through churn", async (t) => {
  const f = fixture(t), newer = join(f.dir, "new-socks"), untrusted = join(f.dir, "untrusted");
  mkdirSync(newer, { mode: 0o700 }); mkdirSync(untrusted, { mode: 0o700 });
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await once(child, "spawn");
  t.after(async () => { const exited = once(child, "exit"); child.kill(); await exited; });
  const [newPid, oldPid] = [process.pid, child.pid].sort((a, b) => String(a).localeCompare(String(b)));
  const record = (pid, dir) => writeFileSync(join(f.claude, "sessions", `${pid}.json`), JSON.stringify({
    pid, name: String(pid), messagingSocketPath: join(dir, `${pid}.sock`),
  }));
  rmSync(join(f.claude, "sessions", `${process.pid}.json`));
  record(oldPid, f.sockets);
  const codex = join(f.sockets, "codex-existing.sock"), hermes = join(f.sockets, "hermes-hidden.sock");
  const messages = [], servers = [];
  try {
    for (const path of [codex, hermes]) {
      const server = createServer((connection) => readLines(connection, (line) => messages.push(line)));
      servers.push(server);
      await listen(server, path);
    }
    writeFileSync(join(f.peers, "codex-existing.json"), JSON.stringify({
      pid: process.pid, name: "codex:existing", threadId: "existing", address: address(codex),
    }));
    assert.equal(socketDir(), f.sockets);
    await post(hermes, { phase: "before" });
    record(newPid, newer);
    assert.equal(socketDir(), newer, "new lowest registry PID changes the preferred bind directory");
    assert.equal(claudeSessions().length, 2);
    assert.equal(codexPeers()[0].address, address(codex));
    assert.equal(peerSocket(address(hermes)), hermes);
    await post(codex, { phase: "mixed" });
    rmSync(join(f.claude, "sessions", `${oldPid}.json`));
    assert.equal(codexPeers()[0].address, address(codex));
    assert.equal(peerSocket(address(hermes)), hermes);
    await post(hermes, { phase: "retired registry" });
    assert.equal(peerSocket(address(join(untrusted, "hermes-forged.sock"))), undefined);
    for (let i = 0; messages.length < 3 && i < 100; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(messages.map((message) => message.phase), ["before", "mixed", "retired registry"]);
    chmodSync(f.sockets, 0o777);
    assert.equal(peerSocket(address(hermes)), undefined);
    chmodSync(f.sockets, 0o700);
    assert.equal(peerSocket(address(hermes)), hermes);
  } finally { await Promise.all(servers.map(closeServer)); }
});

test("remembered directories require the same owned inode and are scoped to the configured registries", (t) => {
  const f = fixture(t), target = address(join(f.sockets, "hermes-hidden.sock"));
  assert.equal(peerSocket(target), join(f.sockets, "hermes-hidden.sock"));
  rmSync(join(f.claude, "sessions", `${process.pid}.json`));
  assert.equal(peerSocket(target), join(f.sockets, "hermes-hidden.sock"));
  const saved = join(f.dir, "saved");
  renameSync(f.sockets, saved); symlinkSync(saved, f.sockets);
  assert.equal(peerSocket(target), undefined);
  rmSync(f.sockets); mkdirSync(f.sockets, { mode: 0o700 });
  assert.equal(peerSocket(target), undefined);
  rmSync(f.sockets, { recursive: true }); renameSync(saved, f.sockets);
  assert.equal(peerSocket(target), join(f.sockets, "hermes-hidden.sock"));
  process.env.CLAUDE_CONFIG_DIR = join(f.dir, "different-profile");
  assert.equal(peerSocket(target), undefined);
});

test("both configured runtime and temp socket directories allow unregistered replies without Claude records", (t) => {
  const f = fixture(t);
  rmSync(join(f.claude, "sessions", `${process.pid}.json`));
  process.env.TMPDIR = f.dir;
  // Leave room for a long TMPDIR without turning this into a pathname-limit test.
  process.env.XDG_RUNTIME_DIR = join(f.dir, "r");
  const runtime = join(process.env.XDG_RUNTIME_DIR, "cc-socks"), temp = join(f.dir, "cc-socks");
  ensurePrivateDir(runtime); ensurePrivateDir(temp);
  for (const directory of [runtime, temp]) {
    const path = join(directory, "h.sock");
    assert.equal(peerSocket(address(path)), path);
  }
});

test("one discovery scope scans the registry once but rechecks directory safety on every call", async (t) => {
  const { sockets, claude } = fixture(t);
  const dir = realpathSync(sockets);
  writeFileSync(join(claude, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, name: "fixture", messagingSocketPath: join(dir, "claude.sock") }));
  const server = createServer();
  server.listen(join(dir, "claude.sock"));
  t.after(() => server.close());
  await once(server, "listening");
  const addr = address(join(dir, "claude.sock"));
  inDiscoveryScope(() => {
    assert.equal(socketDir({ create: false }), dir);
    rmSync(join(claude, "sessions"), { recursive: true });
    assert.equal(socketDir({ create: false }), dir, "registry was not reread inside the scope");
    assert.ok(peerSocket(addr));
    chmodSync(dir, 0o777);
    assert.equal(peerSocket(addr), undefined, "directory mode is never cached");
    chmodSync(dir, 0o700);
  });
  assert.notEqual(socketDir({ create: false }), dir, "nothing is cached after the scope ends");
});

test("ancestorPids walks real process ancestry and whoami matches only an ancestor", (t) => {
  const { sockets } = fixture(t);
  const chain = ancestorPids();
  assert.equal(chain[0], process.ppid);
  assert.ok(new Set(chain).size === chain.length);
  assert.equal(whoami([process.pid])?.name, "claude:fixture");
  assert.equal(whoami([]), undefined);
  assert.equal(whoami([process.pid + 1_000_000]), undefined);
  assert.ok(sockets);
});

test("a record whose PID now belongs to another process is stale, never live", (t) => {
  const { claude, peers, sockets } = fixture(t);
  const start = processStart(process.pid), socket = join(sockets, "claude.sock");
  assert.match(start, /\S/);
  assert.equal(processStart(process.pid), start, "stable for one process");
  const record = (procStart) => writeFileSync(join(claude, "sessions", `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, name: "fixture", messagingSocketPath: socket, procStart }));
  record(start);
  assert.deepEqual(claudeSessions().map((p) => [p.name, p.generation]), [["claude:fixture", generation("claude", process.pid, start, socket)]]);
  assert.deepEqual(stalePeers(), []);
  record("a-different-start");
  assert.deepEqual(claudeSessions(), [], "the PID was reused: not this session any more");
  assert.deepEqual(stalePeers().map((p) => p.name), ["claude:fixture"]);
  record(undefined);
  assert.equal(claudeSessions().length, 1, "records without a start token fall back to the PID");
  const codex = (procStart) => writeFileSync(join(peers, "codex-t.json"), JSON.stringify({ pid: process.pid, name: "codex:t",
    address: address(join(sockets, "codex-t.sock")), threadId: "t", procStart }));
  codex(start);
  assert.deepEqual(codexPeers().map((p) => p.generation), [generation("codex", "t", start)]);
  codex("a-different-start");
  assert.deepEqual(codexPeers(), []);
  assert.ok(stalePeers().some((p) => p.name === "codex:t"));
  assert.equal(recordRunning({ pid: process.pid, procStart: start }), true);
  assert.equal(recordRunning({ pid: process.pid, procStart: "other" }), false);
});

test("automatic Claude names drop characters reserved for claims and patterns; lines carry the extension", (t) => {
  const { claude, sockets } = fixture(t);
  writeFileSync(join(claude, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, name: "api/v2 lead@home",
    messagingSocketPath: join(sockets, "claude.sock") }));
  assert.equal(claudeSessions()[0].name, "claude:api-v2-lead-home");
  assert.equal(nameLabel("Überprüfung_1.x:y"), "Überprüfung_1.x:y");
  assert.equal(messageLine({ from: "uds:/a.sock", body: "x" }).agent_peers, undefined);
  assert.deepEqual(messageLine({ from: "uds:/a.sock", body: "x", ext: { v: 1 } }).agent_peers, { v: 1 });
});

// Each start-time lookup is a ps spawn on macOS, so none may run per post or receipt, and inbound
// lines share one lookup per second. Every lookup first tries /proc/<pid>/stat, which is counted.
test("posts and receipts look up no process start times; inbound senders share one per second", async (t) => {
  const { claude, sockets } = fixture(t);
  const sleeper = spawn("sleep", ["30"], { stdio: "ignore" });
  t.after(() => sleeper.kill());
  const socket = join(sockets, "counted.sock");
  await listen(createServer((conn) => readLines(conn, () => {})), socket, t);
  writeFileSync(join(claude, "sessions", `${sleeper.pid}.json`), JSON.stringify({ pid: sleeper.pid, procStart: "1", name: "counted", messagingSocketPath: socket }));
  let lookups = 0;
  const original = fs.readFileSync;
  fs.readFileSync = function (path, ...rest) {
    if (typeof path === "string" && /^\/proc\/\d+\/stat$/.test(path)) lookups++;
    return original.call(this, path, ...rest);
  };
  syncBuiltinESMExports();
  t.after(() => { fs.readFileSync = original; syncBuiltinESMExports(); });
  const counted = async (fn) => { const before = lookups; await fn(); return lookups - before; };
  assert.equal(await counted(() => post(socket, { type: "user" })), 0, "one post");
  assert.equal(await counted(async () => {
    new Receipts().send({ to: address(socket), from: address(socket), id: "a", status: "dropped", reason: "rate-limited" });
    await new Promise((resolve) => setTimeout(resolve, 50));
  }), 0, "one receipt");
  const line = messageLine({ from: address(socket), fromName: "counted", body: "hi" }), pins = new Pins();
  assert.ok(await counted(() => {
    for (let i = 0; i < 2; i++) {
      assert.ok(inDiscoveryScope(() => readMessage(line, [])));
      pins.noteSender(address(socket));
    }
  }) <= 1, "two inbound lines");
});
