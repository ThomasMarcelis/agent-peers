import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { HermesBridge } from "../src/hermes-bridge.mjs";
import { MAX_LINE, address, allPeers, messageLine, parseEnvelope, peerSocket, post, readLines } from "../src/wire.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, description = "condition") {
  for (let i = 0; i < 200; i++) {
    const value = check();
    if (value) return value;
    await delay(10);
  }
  assert.fail(`timed out waiting for ${description}`);
}

async function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "hermes-peer-"));
  const claude = join(dir, "claude"), peers = join(dir, "peers"), sockets = join(dir, "socks");
  for (const path of [join(claude, "sessions"), peers, sockets]) mkdirSync(path, { recursive: true });
  const before = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, AGENT_PEERS_HOME: process.env.AGENT_PEERS_HOME };
  process.env.CLAUDE_CONFIG_DIR = claude;
  process.env.AGENT_PEERS_HOME = peers;
  const messages = [], servers = [];
  for (const kind of ["claude", "codex"]) {
    const socket = join(sockets, `${kind}-test.sock`);
    const server = createServer((conn) => readLines(conn, (line) => {
      messages.push({ kind, line });
      if (line.type === "user" && options.receipts !== false) {
        const sender = peerSocket(parseEnvelope(line.message.content).from);
        void post(sender, { type: "control", action: "peer_message_status", orig_msg_id: line.msg_id,
          status: options.status ?? "delivered" }).catch(() => {});
      }
    }));
    server.listen(socket);
    await once(server, "listening");
    servers.push(server);
    if (kind === "claude") writeFileSync(join(claude, "sessions", `${process.pid}.json`), JSON.stringify({
      pid: process.pid, name: "test", cwd: dir, status: "busy", messagingSocketPath: socket,
    }));
    else writeFileSync(join(peers, "codex-test.json"), JSON.stringify({
      pid: process.pid, name: "codex:test", address: address(socket), cwd: dir, threadId: "live-thread",
    }));
  }
  const events = [], reads = [];
  const app = options.app ?? {
    loadedThreads: async () => ["live-thread"],
    readThread: async (id) => { reads.push(id); return { id, status: { type: "idle" } }; },
  };
  const bridge = new HermesBridge({ app, emit: options.emit ?? (async (event) => { events.push(event); }), log: () => {} });
  t.after(async () => {
    await bridge.close();
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const send = (session, to = "codex:test", message = "hello", name = "hermes:JD") =>
    bridge.request("send_peer", { session, name, to, message });
  return { bridge, dir, peers, sockets, claude, events, reads, messages, send };
}

test("listing sees Claude and live Codex status without creating a Hermes inbox", async (t) => {
  const f = await fixture(t);
  const listed = await f.bridge.request("list_peers");
  assert.deepEqual(listed.peers.map((p) => [p.name, p.kind, p.status]), [
    ["claude:test", "claude", "busy"], ["codex:test", "codex", "idle"],
  ]);
  assert.deepEqual(f.reads, ["live-thread"]);
  assert.equal(readdirSync(f.sockets).length, 2);
  assert.deepEqual(readdirSync(f.peers), ["codex-test.json"]);
});

test("a missing daemon keeps discoverable inboxes; historical threads are never read", async (t) => {
  let read = false;
  const f = await fixture(t, { app: { loadedThreads: async () => [], readThread: async () => { read = true; } } });
  assert.equal((await f.bridge.request("list_peers")).peers.length, 2);
  assert.equal(read, false);
  const offline = new HermesBridge({ app: { loadedThreads: async () => { throw new Error("offline"); } } });
  const result = await offline.request("list_peers");
  assert.equal(result.peers.length, 2);
  assert.match(result.note, /offline/);
  await offline.close();
});

test("private sessions send, receive replies, and remain absent from every registry", async (t) => {
  const f = await fixture(t);
  const first = await f.send("conversation-a", "claude:test", "hello Claude");
  const second = await f.send("conversation-b", "codex:test", "hello Codex");
  assert.notEqual(first.address, second.address);
  assert.equal(first.status, "delivered");
  const outbound = f.messages.map((entry) => parseEnvelope(entry.line.message.content));
  assert.match(outbound[0].body, /hello Claude[\s\S]*Hermes profile/);
  assert.equal(outbound[0].fromName, "hermes:JD");
  assert.equal(outbound[1].body, "hello Codex");
  assert.equal(peerSocket(first.address), join(f.sockets, first.address.split("/").at(-1)));
  assert.deepEqual(allPeers().map((p) => p.kind), ["claude", "codex"]);
  assert.deepEqual(readdirSync(f.peers), ["codex-test.json"]);
  assert.equal(readdirSync(join(f.claude, "sessions")).length, 1);
  for (const [index, sent] of [first, second].entries()) {
    const sender = address(join(f.sockets, `${index ? "codex" : "claude"}-test.sock`));
    await post(peerSocket(sent.address), messageLine({ from: sender, fromName: `${index ? "codex" : "claude"}:test`, body: `reply-${index}` }));
  }
  await until(() => f.events.length === 2, "both replies");
  assert.deepEqual(f.events.map((e) => [e.method, e.params.session, e.params.message]), [
    ["peer_message", "conversation-a", "reply-0"], ["peer_message", "conversation-b", "reply-1"],
  ]);
  assert.ok(f.events.every((e) => typeof e.params.message_id === "string"));
  const again = await f.send("conversation-a", second.address, "private to private");
  assert.equal(again.address, first.address);
  await until(() => f.events.length === 3);
  assert.equal(f.events[2].params.session, "conversation-b");
  assert.match(f.events[2].params.message, /private to private/);
  assert.equal((await f.bridge.request("list_peers")).peers.length, 2);
});

test("receipt controls never become chat, and held delivery status is preserved", async (t) => {
  const f = await fixture(t, { status: "held" });
  const sent = await f.send("held");
  assert.equal(sent.status, "held");
  assert.match(sent.text, /holding it for its user's approval/);
  assert.equal(f.events.length, 0);
});

test("close retires only its conversation and reopening gets a fresh reply address", async (t) => {
  const f = await fixture(t);
  const one = await f.send("one"), two = await f.send("two", "codex:test", "two");
  assert.deepEqual(await f.bridge.request("close_session", { session: "one" }), { closed: true });
  assert.equal(existsSync(peerSocket(one.address)), false);
  assert.equal(existsSync(peerSocket(two.address)), true);
  assert.deepEqual(await f.bridge.request("close_session", { session: "one" }), { closed: false });
  const reopened = await f.send("one", "codex:test", "new");
  assert.notEqual(reopened.address, one.address);
  await assert.rejects(f.send("one", "codex:test", "wrong profile", "hermes:Other"), /different Hermes identity/);
  await f.bridge.close();
  assert.equal(existsSync(peerSocket(two.address)), false);
  assert.equal(existsSync(peerSocket(reopened.address)), false);
});

test("stale cleanup does not unlink a replacement at a former socket path", async (t) => {
  const f = await fixture(t);
  const sent = await f.send("stale");
  const socket = peerSocket(sent.address);
  unlinkSync(socket);
  writeFileSync(socket, "new owner");
  await f.bridge.request("close_session", { session: "stale" });
  assert.equal(readFileSync(socket, "utf8"), "new owner");
});

test("malformed messages, invalid reply targets, duplicate bodies and ids are suppressed", async (t) => {
  const f = await fixture(t);
  const sent = await f.send("safe");
  const socket = peerSocket(sent.address), sender = address(join(f.sockets, "codex-test.sock"));
  await post(socket, { type: "user", message: { content: "unframed" } });
  await post(socket, messageLine({ from: "uds:/outside/invalid.sock", fromName: "evil", body: "bad" }));
  await post(socket, messageLine({ from: sent.address, body: "self" }));
  const line = messageLine({ from: sender, fromName: "codex:test", body: "one safe reply" });
  await post(socket, line);
  await post(socket, line);
  await post(socket, { ...line, message: messageLine({ from: sender, body: "changed body, same id" }).message });
  await post(socket, messageLine({ from: sender, body: "one safe reply" }));
  await until(() => f.events.length === 1);
  await delay(30);
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].params.message, "one safe reply");
  await assert.rejects(f.send("safe", "uds:/outside/invalid.sock"), /invalid peer inbox/);
  await assert.rejects(f.send("safe", sent.address), /own inbox/);
  await assert.rejects(f.send("safe", "test"), /ambiguous/);
});

test("per-inbox flood limits preserve the other conversation", async (t) => {
  const f = await fixture(t);
  const one = await f.send("one"), two = await f.send("two", "codex:test", "two");
  const sender = address(join(f.sockets, "codex-test.sock"));
  for (let i = 0; i < 40; i++) await post(peerSocket(one.address), messageLine({ from: sender, body: `flood-${i}` }));
  await post(peerSocket(two.address), messageLine({ from: sender, body: "other conversation" }));
  await until(() => f.events.some((e) => e.params.session === "two"));
  assert.equal(f.events.filter((e) => e.params.session === "one").length, 30);
  assert.equal(f.events.filter((e) => e.params.session === "two").length, 1);
  const conn = connect(peerSocket(one.address));
  conn.on("error", () => {});
  await once(conn, "connect");
  conn.write("x".repeat(MAX_LINE + 1));
  await once(conn, "close");
  assert.equal(f.events.length, 31);
});

test("backpressure bounds the inbox queue across senders and recovers after a delivery failure", async (t) => {
  const delivered = [];
  let release, first = true;
  const gate = new Promise((resolve) => { release = resolve; });
  const f = await fixture(t, { emit: async (event) => {
    if (first) {
      first = false;
      await gate;
      throw new Error("consumer temporarily unavailable");
    }
    delivered.push(event);
  } });
  const sent = await f.send("backpressure");
  for (let i = 0; i < 70; i++) {
    await post(peerSocket(sent.address), messageLine({
      from: address(join(f.sockets, `source-${i}.sock`)), body: `message-${i}`,
    }));
  }
  await delay(30);
  assert.equal(delivered.length, 0);
  release();
  await until(() => delivered.length === 49);
  await delay(30);
  assert.equal(delivered.length, 49);
  await post(peerSocket(sent.address), messageLine({ from: address(join(f.sockets, "fresh.sock")), body: "recovered" }));
  await until(() => delivered.length === 50);
  assert.equal(delivered.at(-1).params.message, "recovered");
});

for (const ending of ["EOF", "SIGTERM", "shutdown"]) test(`stdout IPC and owned socket cleanup on ${ending}`, async (t) => {
  const f = await fixture(t);
  const child = spawn(process.execPath, [join(root, "bin", "agent-peers.mjs"), "hermes-bridge"], {
    env: { ...process.env, AGENT_PEERS_CODEX_APP_SERVER: join(f.dir, "missing.sock") }, stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const replies = [];
  let buffer = "", stderr = "";
  child.stderr.on("data", (data) => { stderr += data; });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (data) => {
    buffer += data;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      replies.push(JSON.parse(buffer.slice(0, newline)));
      buffer = buffer.slice(newline + 1);
    }
  });
  child.stdin.write("bad json\n");
  child.stdin.write(JSON.stringify({ id: 1, method: "list_peers" }) + "\n");
  child.stdin.write(JSON.stringify({ id: 2, method: "send_peer", params: {
    session: "ipc-conversation", name: "hermes:JD", to: "claude:test", message: "IPC hello",
  } }) + "\n");
  const response = await until(() => replies.find((r) => r.id === 2), "IPC send reply");
  assert.ok(replies[0].error);
  assert.equal(replies.find((r) => r.id === 1).result.peers.length, 2);
  const socket = peerSocket(response.result.address);
  await post(socket, messageLine({ from: address(join(f.sockets, "claude-test.sock")), body: "IPC reply" }));
  const event = await until(() => replies.find((r) => r.method === "peer_message"));
  assert.equal(event.params.session, "ipc-conversation");
  assert.equal(event.params.message, "IPC reply");
  const closed = once(child, "exit");
  if (ending === "EOF") child.stdin.end();
  else if (ending === "SIGTERM") child.kill("SIGTERM");
  else child.stdin.write(JSON.stringify({ id: 3, method: "shutdown" }) + "\n");
  assert.deepEqual(await closed, [0, null]);
  if (ending === "shutdown") assert.equal(replies.find((r) => r.id === 3).result.closed, true);
  assert.equal(existsSync(socket), false);
  assert.equal(stderr, "");
});
