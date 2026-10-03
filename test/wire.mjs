import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { createServer } from "node:net";
import { once } from "node:events";
import { join } from "node:path";
import { test } from "node:test";
import { MAX_LINE, address, alive, claudeSessions, codexPeers, ensurePrivateDir, peerSocket, post, readLines, socketDir, socketPath } from "../src/wire.mjs";

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


test("peers started before Claude retain their inbox when Claude publishes its first registry record", async (t) => {
  const f = fixture(t);
  rmSync(join(f.claude, "sessions", `${process.pid}.json`));
  delete process.env.XDG_RUNTIME_DIR;
  process.env.TMPDIR = f.dir;
  const before = socketDir();
  assert.equal(before, join(f.dir, "cc-socks"));
  const socket = join(before, "codex-early.sock"), messages = [];
  const server = createServer((connection) => readLines(connection, (line) => messages.push(line)));
  server.listen(socket); await once(server, "listening");
  try {
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
  } finally { await new Promise((resolve) => server.close(resolve)); }
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
  for (const path of [codex, hermes]) {
    const server = createServer((connection) => readLines(connection, (line) => messages.push(line)));
    server.listen(path); await once(server, "listening"); servers.push(server);
  }
  try {
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
  } finally { await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve)))); }
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
  process.env.XDG_RUNTIME_DIR = join(f.dir, "runtime");
  const runtime = join(process.env.XDG_RUNTIME_DIR, "cc-socks"), temp = join(f.dir, "cc-socks");
  ensurePrivateDir(runtime); ensurePrivateDir(temp);
  for (const directory of [runtime, temp]) {
    const path = join(directory, "hermes-in-flight.sock");
    assert.equal(peerSocket(address(path)), path);
  }
});
