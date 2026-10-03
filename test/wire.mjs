import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MAX_LINE, address, alive, claudeSessions, codexPeers, ensurePrivateDir, peerSocket, post, readLines, socketPath } from "../src/wire.mjs";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "ap-wire-"));
  const claude = join(dir, "claude"), peers = join(dir, "peers"), sockets = join(dir, "sockets");
  for (const path of [join(claude, "sessions"), peers, sockets]) mkdirSync(path, { recursive: true, mode: 0o700 });
  const before = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, AGENT_PEERS_HOME: process.env.AGENT_PEERS_HOME };
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
