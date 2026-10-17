import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { HermesBridge } from "../src/hermes-bridge.mjs";
import { claim, claudeClaimant, resolveClaim } from "../src/names.mjs";
import { MAX_LINE, address, allPeers, claudeSessionAt, generation, messageLine, parseEnvelope, peerSocket, post, readLines } from "../src/wire.mjs";
import { closeServer, listen } from "./listeners.mjs";

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
  // macOS TMPDIR can already consume half of sun_path; keep transport fixtures short.
  const dir = realpathSync(mkdtempSync("/tmp/ap-hermes-"));
  const claude = join(dir, "claude"), peers = join(dir, "peers");
  const sockets = join(dir, options.longSockets ? "s".repeat(69 - Buffer.byteLength(dir)) : "socks");
  for (const path of [join(claude, "sessions"), peers, sockets]) mkdirSync(path, { recursive: true, mode: 0o700 });
  const before = Object.fromEntries(["CLAUDE_CONFIG_DIR", "AGENT_PEERS_HOME", "AGENT_PEERS_DEBUG", "AGENT_PEERS_LOG"]
    .map((key) => [key, process.env[key]]));
  process.env.CLAUDE_CONFIG_DIR = claude;
  process.env.AGENT_PEERS_HOME = peers;
  process.env.AGENT_PEERS_DEBUG = options.logging ? "1" : "0";
  const logPath = join(dir, "diagnostics.jsonl");
  process.env.AGENT_PEERS_LOG = logPath;
  const messages = [], controls = [], servers = [];
  let bridge;
  // Registered before anything listens, so a failure below cannot leave a handle open.
  t.after(async () => {
    await bridge?.close();
    await Promise.all(servers.map(closeServer));
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  for (const kind of ["claude", "codex"]) {
    const socket = join(sockets, `${kind}-test.sock`);
    const server = createServer((conn) => readLines(conn, (line) => {
      if (line.type !== "user") return void controls.push({ kind, line });
      messages.push({ kind, line });
      if (options.receipts !== false) {
        const sender = peerSocket(parseEnvelope(line.message.content).from);
        void post(sender, { type: "control", action: "peer_message_status", orig_msg_id: line.msg_id,
          from: address(socket), status: options.status ?? "accepted", ...options.receipt }).catch(() => {});
      }
    }));
    servers.push(server);
    await listen(server, socket);
    if (kind === "claude") writeFileSync(join(claude, "sessions", `${process.pid}.json`), JSON.stringify({
      pid: process.pid, name: "test", cwd: dir, status: "busy", messagingSocketPath: socket,
    }));
    else writeFileSync(join(peers, "codex-test.json"), JSON.stringify({
      pid: process.pid, name: "codex:test", address: address(socket), cwd: dir, threadId: "live-thread",
    }));
  }
  const events = [], reads = [], diagnostics = [];
  const app = options.app ?? {
    loadedThreads: async () => ["live-thread"],
    readThread: async (id) => { reads.push(id); return { id, status: { type: "idle" } }; },
  };
  const emit = options.emit ?? (async (event) => { events.push(event); });
  bridge = new HermesBridge({ app, emit, log: (message) => diagnostics.push(message), profile: options.profile });
  const send = (session, to = "codex:test", message = "hello", name = "hermes:JD") =>
    bridge.request("send_peer", { session, name, to, message });
  // Another bridge on the same registries, as after a gateway restart.
  const restart = (profile = options.profile) => {
    const next = new HermesBridge({ app, emit, log: (message) => diagnostics.push(message), profile });
    t.after(() => next.close());
    return next;
  };
  return { bridge, dir, peers, sockets, claude, events, reads, messages, controls, send, logPath, diagnostics, restart };
}

test("long inbox paths fail before listening and leave no sockets or live handles", async (t) => {
  const f = await fixture(t, { longSockets: true });
  const before = readdirSync(f.sockets).sort();
  const result = await f.send("too-long");
  assert.deepEqual([result.status, result.reason, result.message_id], ["failed", "inbox-unavailable", null]);
  assert.match(result.text, /103-byte Unix socket limit/);
  await f.bridge.close();
  assert.deepEqual(readdirSync(f.sockets).sort(), before);
});

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

test("closing releases the app-server once and rejects further bridge requests", async (t) => {
  let closed = 0;
  const f = await fixture(t, { app: { close: () => { closed++; } } });
  await f.send("closing");
  const first = f.bridge.close();
  assert.equal(f.bridge.close(), first);
  await first;
  assert.equal(closed, 1);
  await assert.rejects(f.bridge.request("list_peers"), /closed/);
  await assert.rejects(f.send("closed"), /closed/);
});

test("private sessions send, receive replies, and remain absent from every registry", async (t) => {
  const f = await fixture(t);
  // A failed first send does not use up the introduction.
  assert.equal((await f.send("conversation-a", "claude:test", "x".repeat(MAX_LINE))).reason, "too-large");
  const first = await f.send("conversation-a", "claude:test", "hello Claude");
  const second = await f.send("conversation-b", "codex:test", "hello Codex");
  assert.notEqual(first.from, second.from);
  assert.deepEqual(first, { status: "accepted", reason: null, message_id: f.messages[0].line.msg_id, in_reply_to: null,
    to: address(join(f.sockets, "claude-test.sock")), name: "claude:test",
    generation: generation("claude", process.pid, undefined, join(f.sockets, "claude-test.sock")), from: first.from, text: "Accepted by claude:test." });
  assert.equal(second.text, "Accepted by codex:test.");
  assert.deepEqual(f.messages[0].line.agent_peers, { v: 1, receipts: ["queued", "accepted"], generation: generation("hermes", "conversation-a") });
  const outbound = f.messages.map((entry) => parseEnvelope(entry.line.message.content));
  assert.equal(outbound[0].body, "hello Claude\n\n(Hermes profile; notify_when_idle unavailable.)");
  assert.equal(outbound[0].fromName, "hermes:JD");
  assert.equal(outbound[1].body, "hello Codex");
  await f.send("conversation-a", "claude:test", "again");
  await f.send("conversation-b", "claude:test", "other conversation");
  assert.deepEqual(f.messages.slice(2).map((entry) => parseEnvelope(entry.line.message.content).body),
    ["again", "other conversation\n\n(Hermes profile; notify_when_idle unavailable.)"]);
  assert.equal(peerSocket(first.from), join(f.sockets, first.from.split("/").at(-1)));
  assert.deepEqual(allPeers().map((p) => p.kind), ["claude", "codex"]);
  assert.deepEqual(readdirSync(f.peers), ["codex-test.json"]);
  assert.equal(readdirSync(join(f.claude, "sessions")).length, 1);
  for (const [index, sent] of [first, second].entries()) {
    const sender = address(join(f.sockets, `${index ? "codex" : "claude"}-test.sock`));
    await post(peerSocket(sent.from), messageLine({ from: sender, fromName: `${index ? "codex" : "claude"}:test`, body: `reply-${index}` }));
  }
  await until(() => f.events.length === 2, "both replies");
  assert.deepEqual(f.events.map((e) => [e.method, e.params.session, e.params.message]), [
    ["peer_message", "conversation-a", "reply-0"], ["peer_message", "conversation-b", "reply-1"],
  ]);
  assert.ok(f.events.every((e) => typeof e.params.message_id === "string"));
  // conversation-b never wrote to conversation-a, so its inbox refuses it (issue #28) ...
  const refused = await f.send("conversation-a", second.from, "private to private");
  assert.equal(refused.from, first.from);
  assert.deepEqual([refused.status, refused.reason], ["dropped", "not-a-reply-target"]);
  // ... while conversation-a, which did write to conversation-b, accepts its answer.
  assert.equal((await f.send("conversation-b", first.from, "b answers a")).status, "queued");
  await until(() => f.events.length === 3);
  assert.deepEqual([f.events[2].params.session, f.events[2].params.message], ["conversation-a", "b answers a"]);
  assert.equal((await f.send("conversation-a", second.from, "now a reply")).status, "queued");
  await until(() => f.events.length === 4);
  assert.equal(f.events[3].params.session, "conversation-b");
  assert.equal((await f.bridge.request("list_peers")).peers.length, 2);
});

test("one conversation keeps reply inboxes in each peer directory and closes them together", async (t) => {
  const f = await fixture(t);
  const otherDir = join(f.dir, "other");
  mkdirSync(otherDir, { mode: 0o700 });
  const otherSocket = join(otherDir, "claude-other.sock");
  const other = createServer((conn) => readLines(conn, (line) => {
    const sender = peerSocket(parseEnvelope(line.message.content).from);
    assert.equal(dirname(sender), otherDir, "Claude can reply only within its own directory");
    void post(sender, { type: "control", action: "peer_message_status", orig_msg_id: line.msg_id, from: address(otherSocket), status: "accepted" });
  }));
  await listen(other, otherSocket, t);
  const first = await f.send("mixed", "claude:test");
  // A registry change must not invalidate the existing conversation's first endpoint.
  writeFileSync(join(f.claude, "sessions", `${process.pid}.json`), JSON.stringify({
    pid: process.pid, name: "other", messagingSocketPath: otherSocket,
  }));
  const second = await f.send("mixed", "claude:other");
  assert.notEqual(first.from, second.from);
  assert.equal(second.status, "accepted");
  for (const [sent, source] of [[first, join(f.sockets, "claude-test.sock")], [second, otherSocket]]) {
    await post(peerSocket(sent.from), messageLine({ from: address(source), body: source }));
  }
  await until(() => f.events.length === 2);
  assert.ok(f.events.every((e) => e.params.session === "mixed"));
  assert.equal((await f.send("mixed", address(join(f.sockets, "claude-test.sock")))).from, first.from);
  await f.bridge.request("close_session", { session: "mixed" });
  assert.equal(existsSync(first.from.slice(4)), false);
  assert.equal(existsSync(second.from.slice(4)), false);
});

// A Claude session that lost its Hermes address once picked another conversation's inbox from the
// socket directory, and its report reached an unrelated Discord thread.
test("a conversation's inboxes accept only peers it wrote to, in every directory, until it closes (issue #28)", async (t) => {
  const f = await fixture(t);
  const recorder = async (socket) => {
    const lines = [];
    await listen(createServer((conn) => readLines(conn, (line) => lines.push(line))), socket, t);
    return lines;
  };
  const strangerSocket = join(f.sockets, "stranger.sock"), stranger = await recorder(strangerSocket);
  const sent = await f.send("guarded", "codex:test");
  const codex = address(join(f.sockets, "codex-test.sock"));
  await post(peerSocket(sent.from), messageLine({ from: address(strangerSocket), fromName: "claude:lost", body: "report for another project" }));
  await until(() => stranger.length === 1, "the refusal");
  assert.deepEqual([stranger[0].status, stranger[0].drop_reason, stranger[0].from], ["dropped", "not-a-reply-target", sent.from]);
  // A send that wrote nothing grants nothing, even once a process owns that address.
  const gone = join(f.sockets, "gone.sock");
  assert.equal((await f.send("guarded", address(gone))).reason, "not-running");
  const later = await recorder(gone);
  await post(peerSocket(sent.from), messageLine({ from: address(gone), body: "new owner" }));
  await until(() => later.length === 1, "the second refusal");
  assert.equal(later[0].drop_reason, "not-a-reply-target");
  // A peer in another directory adds an inbox there; earlier contacts stay allowed.
  const otherDir = join(f.dir, "other");
  mkdirSync(otherDir, { mode: 0o700 });
  const otherSocket = join(otherDir, "claude-other.sock");
  await recorder(otherSocket);
  writeFileSync(join(f.claude, "sessions", `${process.pid}.json`), JSON.stringify({
    pid: process.pid, name: "other", messagingSocketPath: otherSocket,
  }));
  const second = await f.send("guarded", "claude:other");
  assert.equal(dirname(peerSocket(second.from)), otherDir);
  const replyOne = messageLine({ from: codex, body: "reply one" });
  await post(peerSocket(sent.from), replyOne);
  await post(peerSocket(second.from), messageLine({ from: address(otherSocket), body: "reply two" }));
  await until(() => f.events.length === 2, "both replies");
  // Dedup is per conversation: the same id at its other directory's inbox is a duplicate.
  await post(peerSocket(second.from), replyOne);
  await delay(30);
  assert.deepEqual(f.events.map((e) => e.params.message), ["reply one", "reply two"]);
  // Closing forgets every contact: the reopened conversation has written only to the stranger.
  await f.bridge.request("close_session", { session: "guarded" });
  const reopened = await f.send("guarded", address(strangerSocket));
  await post(peerSocket(reopened.from), messageLine({ from: codex, body: "stale reply" }));
  await until(() => f.controls.some(({ kind, line }) => kind === "codex" && line.drop_reason === "not-a-reply-target"), "the refusal after close");
  assert.equal(f.events.length, 2);
});

test("pins belong to each conversation: no other listing re-pins a name this one saw", async (t) => {
  const f = await fixture(t);
  const api = async (label) => {
    const proc = spawn("sleep", ["60"], { stdio: "ignore" }), socket = join(f.sockets, `${label}.sock`), lines = [];
    t.after(() => proc.kill());
    await listen(createServer((conn) => readLines(conn, (line) => { if (line.type === "user") lines.push(line); })), socket, t);
    const record = join(f.claude, "sessions", `${proc.pid}.json`);
    writeFileSync(record, JSON.stringify({ pid: proc.pid, name: "api", messagingSocketPath: socket }));
    return { proc, lines, record };
  };
  const old = await api("api-old");
  assert.notEqual((await f.send("C1", "claude:api", "hi")).status, "failed");
  // That session exits, and an unrelated one with the same name starts.
  old.proc.kill();
  await once(old.proc, "exit");
  rmSync(old.record);
  const fresh = await api("api-new");
  await f.bridge.request("list_peers");
  await f.bridge.request("list_peers", { session: "C2" });
  const follow = await f.send("C1", "claude:api", "follow-up");
  assert.deepEqual([follow.status, follow.reason], ["failed", "not-running"]);
  assert.equal(fresh.lines.length, 0, "nothing reached the different process");
  await f.bridge.request("list_peers", { session: "C1" });
  assert.notEqual((await f.send("C1", "claude:api", "after listing")).status, "failed");
  assert.equal(fresh.lines.length, 1);
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
  assert.equal(existsSync(peerSocket(one.from)), false);
  assert.equal(existsSync(peerSocket(two.from)), true);
  assert.deepEqual(await f.bridge.request("close_session", { session: "one" }), { closed: false });
  const reopened = await f.send("one", "codex:test", "new");
  assert.notEqual(reopened.from, one.from);
  const wrong = await f.send("one", "codex:test", "wrong profile", "hermes:Other");
  assert.deepEqual([wrong.status, wrong.reason], ["failed", "inbox-unavailable"]);
  assert.match(wrong.text, /different Hermes identity/);
  await f.bridge.close();
  assert.equal(existsSync(peerSocket(two.from)), false);
  assert.equal(existsSync(peerSocket(reopened.from)), false);
});

test("stale cleanup does not unlink a replacement at a former socket path", async (t) => {
  const f = await fixture(t);
  const sent = await f.send("stale");
  const socket = peerSocket(sent.from);
  unlinkSync(socket);
  writeFileSync(socket, "new owner");
  await f.bridge.request("close_session", { session: "stale" });
  assert.equal(readFileSync(socket, "utf8"), "new owner");
});

test("malformed messages, invalid reply targets and duplicate ids are suppressed; repeated bodies are not", async (t) => {
  const f = await fixture(t);
  const sent = await f.send("safe");
  const socket = peerSocket(sent.from), sender = address(join(f.sockets, "codex-test.sock"));
  await post(socket, { type: "user", message: { content: "unframed" } });
  await post(socket, messageLine({ from: "uds:/outside/invalid.sock", fromName: "evil", body: "bad" }));
  await post(socket, messageLine({ from: sent.from, body: "self" }));
  const line = messageLine({ from: sender, fromName: "codex:test", body: "one safe reply" });
  await post(socket, line);
  await post(socket, line);
  await post(socket, { ...line, message: messageLine({ from: sender, body: "changed body, same id" }).message });
  // The same "done" again under a new id is a new message.
  await post(socket, messageLine({ from: sender, body: "one safe reply" }));
  await until(() => f.events.length === 2);
  await delay(30);
  assert.deepEqual(f.events.map((e) => e.params.message), ["one safe reply", "one safe reply"]);
  assert.deepEqual(f.controls, [], "a duplicate id gets no receipt; successes go only to senders that opt in");
  for (const [to, reason, text] of [["uds:/outside/invalid.sock", "invalid-address", /not a peer inbox address/],
    [sent.from, "self-send", /own inbox/], ["test", "ambiguous", /"test" is ambiguous: claude:test .*, codex:test/],
    ["tes", "not-found", /exact names: claude:test, codex:test/], ["hermes:jd/project", "not-found", /No session has claimed hermes:jd\/project\. Its holder must claim it/],
    ["hermes:JD/project", "invalid-request", /is not a claimed name/]]) {
    const result = await f.send("safe", to);
    assert.deepEqual([result.status, result.reason], ["failed", reason]);
    assert.match(result.text, text);
  }
});

test("receipts back to senders: opted-in senders hear queued, then the host's answer through delivery_result", async (t) => {
  const f = await fixture(t);
  const sent = await f.send("receipts");
  const socket = peerSocket(sent.from), sender = address(join(f.sockets, "codex-test.sock"));
  const optedIn = (body, extra = {}) => ({ ...messageLine({ from: sender, body }), agent_peers: { v: 1, receipts: ["queued", "accepted"], ...extra } });
  const accepted = optedIn("one", { in_reply_to: sent.message_id }), refused = optedIn("two"), plain = messageLine({ from: sender, body: "three" });
  for (const line of [accepted, refused, plain]) await post(socket, line);
  await until(() => f.events.length === 3);
  assert.equal(f.events[0].params.in_reply_to, sent.message_id);
  f.bridge.deliveryResult({ session: "receipts", message_id: accepted.msg_id, accepted: true });
  f.bridge.deliveryResult({ session: "receipts", message_id: refused.msg_id, accepted: false, reason: "queue-full" });
  f.bridge.deliveryResult({ session: "receipts", message_id: plain.msg_id, accepted: true });
  f.bridge.deliveryResult({ session: "other", message_id: accepted.msg_id, accepted: false });
  await until(() => f.controls.length === 4);
  await delay(50);
  assert.deepEqual(f.controls.map(({ line }) => [line.orig_msg_id, line.status, line.drop_reason ?? null]).sort(), [
    [accepted.msg_id, "queued", null], [accepted.msg_id, "accepted", null], [refused.msg_id, "queued", null], [refused.msg_id, "dropped", "queue-full"],
  ].sort(), "the plain sender heard nothing, and each answer counts once");
  assert.ok(f.controls.every(({ line }) => line.from === sent.from));
});

test("a conversation that closes while the plugin holds a message still reports dropped/inbox-closed to its sender", async (t) => {
  const f = await fixture(t);
  const sent = await f.send("closing");
  const line = { ...messageLine({ from: address(join(f.sockets, "codex-test.sock")), body: "reply" }), agent_peers: { v: 1, receipts: ["queued", "accepted"] } };
  await post(peerSocket(sent.from), line);
  await until(() => f.events.length === 1 && f.controls.length === 1, "the handoff");
  await f.bridge.request("close_session", { session: "closing" });
  f.bridge.deliveryResult({ session: "closing", message_id: line.msg_id, accepted: false, reason: "inbox-closed" });
  f.bridge.deliveryResult({ session: "closing", message_id: line.msg_id, accepted: true });
  await until(() => f.controls.length === 2, "the drop receipt");
  await delay(30);
  assert.deepEqual(f.controls.map(({ line: receipt }) => [receipt.orig_msg_id, receipt.status, receipt.drop_reason ?? null]),
    [[line.msg_id, "queued", null], [line.msg_id, "dropped", "inbox-closed"]], "answered once");
});

test("an inbox frame that would exceed the host's line limit once re-encoded is dropped, not emitted", async (t) => {
  const f = await fixture(t);
  // Hermes route IDs are opaque and may be long; the notification repeats them.
  const sent = await f.send("s".repeat(256));
  const socket = peerSocket(sent.from), sender = address(join(f.sockets, "codex-test.sock"));
  // The largest body whose frame the inbox still accepts.
  const overhead = Buffer.byteLength(JSON.stringify(messageLine({ from: sender, fromName: "codex:test", body: "" }))) + 1;
  await post(socket, messageLine({ from: sender, fromName: "codex:test", body: "x".repeat(MAX_LINE - overhead) }));
  await post(socket, messageLine({ from: sender, fromName: "codex:test", body: "still reachable" }));
  await until(() => f.events.length === 1);
  await delay(30);
  assert.deepEqual(f.events.map((e) => e.params.message.length), ["still reachable".length]);
});

test("per-inbox flood limits preserve the other conversation", async (t) => {
  const f = await fixture(t);
  const one = await f.send("one"), two = await f.send("two", "codex:test", "two");
  const sender = address(join(f.sockets, "codex-test.sock"));
  for (let i = 0; i < 40; i++) await post(peerSocket(one.from), messageLine({ from: sender, body: `flood-${i}` }));
  await post(peerSocket(two.from), messageLine({ from: sender, body: "other conversation" }));
  await until(() => f.events.some((e) => e.params.session === "two"));
  assert.equal(f.events.filter((e) => e.params.session === "one").length, 30);
  assert.equal(f.events.filter((e) => e.params.session === "two").length, 1);
  const conn = connect(peerSocket(one.from));
  t.after(() => conn.destroy());
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
  // Two peers the conversation wrote to, 30 messages each: within each sender's bucket, past the queue.
  const sent = await f.send("backpressure");
  await f.send("backpressure", "claude:test");
  const senders = ["codex", "claude"].map((kind) => address(join(f.sockets, `${kind}-test.sock`)));
  for (let i = 0; i < 60; i++) {
    await post(peerSocket(sent.from), messageLine({ from: senders[i % 2], body: `message-${i}` }));
  }
  await delay(30);
  assert.equal(delivered.length, 0);
  release();
  await until(() => delivered.length === 49);
  await delay(30);
  assert.equal(delivered.length, 49);
  await post(peerSocket(sent.from), messageLine({ from: senders[0], body: "recovered" }));
  await until(() => delivered.length === 50);
  assert.equal(delivered.at(-1).params.message, "recovered");
});

for (const [status, outcome] of [
  ["accepted", "accepted"], ["held", "held"], ["dropped", "dropped"], [undefined, "unconfirmed"],
]) test(`diagnostics report ${outcome} without claiming model consumption`, async (t) => {
  const f = await fixture(t, { logging: true, status, receipts: status !== undefined });
  await f.bridge.request("list_peers");
  const sent = await f.send("private-session-sentinel", "codex:test", "private-body-sentinel");
  await f.bridge.request("close_session", { session: "private-session-sentinel" });
  const raw = readFileSync(f.logPath, "utf8");
  const records = raw.trim().split("\n").map(JSON.parse).filter((record) => record.component === "hermes-bridge");
  const request = records.find((record) => record.event === "tool.request" && record.method === "send_peer");
  const started = records.find((record) => record.event === "send.started");
  const result = records.find((record) => record.event === "send.result");
  const completed = records.find((record) => record.event === "tool.result" && record.method === "send_peer");
  assert.equal(result.outcome, outcome);
  assert.equal(result.receipt, status !== undefined);
  assert.match(result.messageId, /^sha256:[a-f0-9]{24}$/);
  assert.notEqual(result.messageId, sent.message_id);
  assert.equal(started.operationId, request.operationId);
  assert.equal(started.messageId, undefined, "the id exists only once the line is built");
  assert.equal(result.operationId, request.operationId);
  assert.equal(completed.operationId, request.operationId);
  assert.ok(records.some((record) => record.event === "message.send" && record.outcome === "inbox_written" && record.messageId === result.messageId));
  assert.equal(completed.outcome, status === "dropped" ? "warning" : "success");
  assert.equal(result.bytes, Buffer.byteLength("private-body-sentinel"));
  assert.ok(result.durationMs >= 0);
  assert.ok(records.some((record) => record.event === "inbox.bound"));
  assert.ok(records.some((record) => record.event === "inbox.closed"));
  for (const secret of ["private-session-sentinel", "private-body-sentinel", "codex:test", f.dir, sent.from]) {
    assert.equal(raw.includes(secret), false);
  }
});

test("diagnostics classify dropped and failed incoming delivery without retaining message or error text", async (t) => {
  let fail = true;
  const f = await fixture(t, { logging: true, emit: async () => {
    if (fail) { fail = false; throw new Error("secret-consumer-error-sentinel"); }
  } });
  const sent = await f.send("private-session-sentinel");
  const sender = address(join(f.sockets, "codex-test.sock"));
  const socket = peerSocket(sent.from);
  await post(socket, { type: "user", message: { content: "secret-malformed-sentinel" } });
  const line = { ...messageLine({ from: sender, body: "secret-first-body-sentinel" }), msg_id: "secret-id-sentinel" };
  await post(socket, line);
  await post(socket, line);
  await post(socket, messageLine({ from: sender, body: "secret-second-body-sentinel" }));
  const records = () => readFileSync(f.logPath, "utf8").trim().split("\n").map(JSON.parse)
    .filter((record) => record.component === "hermes-bridge");
  await until(() => records().some((record) => record.event === "delivery.result" && record.outcome === "emitted_to_host"));
  assert.equal((await f.send("private-session-sentinel", "secret-missing-target-sentinel")).reason, "not-found");
  const result = records();
  assert.ok(result.some((record) => record.event === "receive.dropped" && record.reason === "malformed"));
  assert.ok(result.some((record) => record.event === "receive.dropped" && record.reason === "duplicate"));
  assert.ok(result.some((record) => record.event === "receive.queued" && record.queueDepth >= 1));
  assert.ok(result.some((record) => record.event === "delivery.result" && record.outcome === "error"));
  assert.ok(result.some((record) => record.event === "tool.result" && record.reason === "not_found"));
  const queued = result.find((record) => record.event === "receive.queued");
  assert.equal(result.find((record) => record.event === "delivery.result").messageId, queued.messageId);
  assert.equal(readFileSync(f.logPath, "utf8").includes("sentinel"), false);
  assert.ok(f.diagnostics.some((text) => text.startsWith("incoming message delivery failed:")));
  assert.equal(f.diagnostics.join("\n").includes("sentinel"), false);
});

test("diagnostics distinguish rate and queue limits", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const f = await fixture(t, { logging: true, emit: () => gate });
  t.after(() => release());
  const sent = await f.send("bounded");
  await f.send("bounded", "claude:test");
  const socket = peerSocket(sent.from);
  const sender = address(join(f.sockets, "codex-test.sock")), other = address(join(f.sockets, "claude-test.sock"));
  for (let i = 0; i < 31; i++) await post(socket, messageLine({ from: sender, body: `rate-${i}` }));
  for (let i = 0; i < 21; i++) await post(socket, messageLine({ from: other, body: `queue-${i}` }));
  await until(() => readFileSync(f.logPath, "utf8").includes('"queue_full"'));
  const records = readFileSync(f.logPath, "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(records.some((record) => record.event === "receive.dropped" && record.reason === "rate_limited"));
  assert.ok(records.some((record) => record.event === "receive.dropped" && record.reason === "queue_full"));
  release();
});

test("Hermes diagnostics stay disabled with DEBUG=0 even with a configured path", async (t) => {
  const f = await fixture(t);
  await f.send("disabled");
  await f.bridge.close();
  assert.equal(existsSync(f.logPath), false);
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
  const socket = peerSocket(response.result.from);
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

test("IPC serves conversations concurrently while each conversation stays in order (issue #17)", { timeout: 15_000 }, async (t) => {
  // No receipts: every send waits out its 1.5 s window, like a send to an unresponsive peer.
  const f = await fixture(t, { receipts: false });
  const child = spawn(process.execPath, [join(root, "bin", "agent-peers.mjs"), "hermes-bridge"], {
    env: { ...process.env, AGENT_PEERS_CODEX_APP_SERVER: join(f.dir, "missing.sock") }, stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  child.stderr.resume();
  const replies = [];
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (data) => {
    buffer += data;
    for (let newline; (newline = buffer.indexOf("\n")) >= 0; buffer = buffer.slice(newline + 1)) replies.push(JSON.parse(buffer.slice(0, newline)));
  });
  const request = (id, method, params) => child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  const send = (id, session, message) => request(id, "send_peer", { session, name: "hermes:JD", to: "claude:test", message });
  send(1, "a", "first in a");
  send(2, "a", "second in a");
  request(3, "list_peers");
  send(4, "b", "only in b");
  for (let i = 0; i < 1000 && replies.length < 4; i++) await delay(10);
  const order = replies.map((reply) => reply.id);
  assert.equal(order[0], 3, "listing does not wait for anyone's receipt window");
  assert.equal(order.at(-1), 2, "a's second send waits for its first; b waits for neither");
  assert.deepEqual(replies.filter((reply) => reply.result?.status).map((reply) => reply.result.status), ["unconfirmed", "unconfirmed", "unconfirmed"]);
  assert.deepEqual(f.messages.map(({ line }) => parseEnvelope(line.message.content).body.split("\n")[0]).filter((body) => body.endsWith("in a")),
    ["first in a", "second in a"]);
  const closed = once(child, "exit");
  child.stdin.end(JSON.stringify({ id: 5, method: "shutdown" }) + "\n");
  assert.deepEqual(await closed, [0, null]);
});

test("IPC rejects malformed request ids without echoing untrusted objects", async (t) => {
  const f = await fixture(t);
  const child = spawn(process.execPath, [join(root, "bin", "agent-peers.mjs"), "hermes-bridge"], {
    env: { ...process.env, AGENT_PEERS_CODEX_APP_SERVER: join(f.dir, "missing.sock") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (data) => { output += data; });
  const closed = once(child, "exit");
  for (const id of [{ nested: true }, [], "x".repeat(257), 1e30, "", null]) {
    child.stdin.write(JSON.stringify({ id, method: "list_peers" }) + "\n");
  }
  child.stdin.end(JSON.stringify({ id: "done", method: "shutdown" }) + "\n");
  assert.deepEqual(await closed, [0, null]);
  const lines = output.trim().split("\n").map(JSON.parse);
  assert.equal(lines.length, 7);
  for (const line of lines.slice(0, -1)) {
    assert.equal(line.id, null);
    assert.match(line.error.message, /expected/);
  }
  assert.deepEqual(lines.at(-1), { id: "done", result: { closed: true } });
});

test("IPC delivery_result notifications never count toward the request limit", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const child = spawn(process.execPath, [join(root, "bin", "agent-peers.mjs"), "hermes-bridge"], {
    env: { ...process.env, AGENT_PEERS_CODEX_APP_SERVER: join(f.dir, "missing.sock") }, stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  child.stderr.resume();
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (data) => { output += data; });
  const notifications = Array.from({ length: 300 }, (_, i) =>
    JSON.stringify({ method: "delivery_result", params: { session: "s", message_id: `m${i}`, accepted: true } })).join("\n");
  child.stdin.write(`${notifications}\n${JSON.stringify({ id: 1, method: "list_peers", params: {} })}\n`);
  for (let i = 0; i < 500 && !output.includes("\n"); i++) await delay(10);
  assert.deepEqual(Object.keys(JSON.parse(output.split("\n")[0])), ["id", "result"]);
  const closed = once(child, "exit");
  child.stdin.end(JSON.stringify({ id: 2, method: "shutdown" }) + "\n");
  assert.deepEqual(await closed, [0, null]);
});

for (const [label, data, expected, reason] of [
  ["oversized frame", "x".repeat(MAX_LINE), /input line too large/, "message_too_large"],
  ["request flood", `${JSON.stringify({ id: 1, method: "list_peers" })}\n`.repeat(129), /input limit exceeded/, "queue_full"],
  ["truncated frame", '{"id":1', /incomplete bridge input/, "malformed"],
]) test(`IPC terminates promptly on ${label}`, { timeout: 10_000 }, async (t) => {
  const f = await fixture(t, { logging: true });
  const child = spawn(process.execPath, [join(root, "bin", "agent-peers.mjs"), "hermes-bridge"], {
    env: { ...process.env, AGENT_PEERS_CODEX_APP_SERVER: join(f.dir, "missing.sock") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  child.stdin.on("error", () => {});
  child.stdout.resume();
  let errors = "";
  child.stderr.on("data", (chunk) => { errors += chunk; });
  const closed = once(child, "exit");
  child.stdin.end(data);
  assert.deepEqual(await closed, [1, null]);
  assert.match(errors, expected);
  const records = readFileSync(f.logPath, "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(records.some((record) => record.event === "bridge.error" && record.reason === reason));
});

test("a parent that stops reading notifications cannot keep the bridge alive", { timeout: 12_000 }, async (t) => {
  const f = await fixture(t, { logging: true });
  const child = spawn(process.execPath, [join(root, "bin", "agent-peers.mjs"), "hermes-bridge"], {
    env: { ...process.env, AGENT_PEERS_CODEX_APP_SERVER: join(f.dir, "missing.sock") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  child.stderr.resume();
  const output = once(child.stdout, "data");
  child.stdin.write(JSON.stringify({ id: 1, method: "send_peer", params: {
    session: "blocked-parent", name: "hermes:test", to: "claude:test", message: "hello",
  } }) + "\n");
  const [chunk] = await output;
  const sent = JSON.parse(chunk.toString()).result;
  assert.ok(sent.from);
  child.stdout.pause();
  const socket = peerSocket(sent.from);
  const closed = once(child, "exit");
  await post(socket, messageLine({ from: address(join(f.sockets, "claude-test.sock")),
    body: "x".repeat(MAX_LINE - 1000) }));
  assert.deepEqual(await closed, [1, null]);
  assert.equal(existsSync(socket), false);
  const records = readFileSync(f.logPath, "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(records.some((record) => record.event === "bridge.error" && record.reason === "timeout"));
});

test("a Claude introduction dropped by the recipient is sent again with the next message", async (t) => {
  const f = await fixture(t, { status: "dropped" });
  await f.send("intro", "claude:test", "first");
  await f.send("intro", "claude:test", "second");
  const bodies = f.messages.filter((m) => m.kind === "claude").map((m) => parseEnvelope(m.line.message.content).body);
  assert.deepEqual(bodies.map((b) => b.endsWith("(Hermes profile; notify_when_idle unavailable.)")), [true, true]);
});

// Claimed names. The identity is the conversation's automatic name, as the plugin derives it.
const named = (bridge, method, session, owner, name) => bridge.request(method, { session, owner, identity: "hermes:JD", name });
const nameFile = (f, name) => join(f.peers, "names", `n-${createHash("sha256").update(name).digest("hex").slice(0, 32)}.json`);
const notRunning = (error) => error.reason === "not-running" && /a Hermes conversation that is no longer running/.test(error.message);

test("a claim is scoped to the bridge's Hermes profile and opens an inbox in every verified directory", async (t) => {
  const f = await fixture(t, { profile: "jd" }), otherDir = join(f.dir, "other");
  mkdirSync(otherDir, { mode: 0o700 });
  // A second live Claude session makes its socket directory a verified one.
  const other = spawn("sleep", ["60"], { stdio: "ignore" });
  t.after(() => other.kill());
  await once(other, "spawn");
  writeFileSync(join(f.claude, "sessions", `${other.pid}.json`), JSON.stringify({ pid: other.pid, name: "other", messagingSocketPath: join(otherDir, "c.sock") }));
  const hermesSockets = () => [f.sockets, otherDir].flatMap((dir) => readdirSync(dir).filter((name) => name.startsWith("hermes-")));
  for (const name of ["hermes:gaming/relay", "codex:jd/relay"]) {
    const denied = await named(f.bridge, "claim_name", "route-alpha", "conversation-alpha", name);
    assert.deepEqual([denied.status, denied.reason], ["refused", "scope-denied"], name);
  }
  assert.deepEqual(hermesSockets(), [], "a refused claim opens no inbox");
  const claimed = await named(f.bridge, "claim_name", "route-alpha", "conversation-alpha", "jd/relay");
  assert.deepEqual([claimed.status, claimed.name, claimed.kind, claimed.generation], ["claimed", "hermes:jd/relay", "hermes", generation("hermes", "route-alpha")]);
  const record = JSON.parse(readFileSync(nameFile(f, "hermes:jd/relay"), "utf8"));
  assert.deepEqual(record.holder.addresses.map((addr) => dirname(peerSocket(addr))).sort(), [f.sockets, otherDir].sort());
  assert.equal(hermesSockets().length, 2);
  assert.equal(record.owner, generation("hermes", "jd", "conversation-alpha"));
  assert.doesNotMatch(JSON.stringify(record), /route-alpha|conversation-alpha/, "conversation and route ids are stored only as hashes");
  // The claim is the one way this conversation is listed.
  const listed = await f.bridge.request("list_peers");
  assert.deepEqual(listed.names.map((row) => [row.name, row.kind, row.running, row.holder, row.addresses.length]),
    [["hermes:jd/relay", "hermes", true, "hermes:JD", 2]]);
  assert.ok(listed.peers.every((peer) => peer.kind !== "hermes"));
  const unscoped = f.restart(null);
  assert.equal((await named(unscoped, "claim_name", "route-beta", "conversation-beta", "jd/other")).reason, "scope-denied");
  // Closing the conversation leaves the name, now not running.
  await f.bridge.request("close_session", { session: "route-alpha" });
  assert.throws(() => resolveClaim("hermes:jd/relay"), notRunning);
  assert.equal((await f.bridge.request("list_peers")).names[0].running, false);
});

test("after a restart the conversation's next call takes its names back, they follow compression, and nobody else takes a live one", async (t) => {
  const f = await fixture(t, { profile: "jd" }), name = "hermes:jd/relay";
  assert.equal((await named(f.bridge, "claim_name", "route-1", "conversation-1", name)).status, "claimed");
  // The gateway restarts: every route and inbox goes, and routes get new ids.
  await f.bridge.close();
  assert.throws(() => resolveClaim(name), notRunning);
  const next = f.restart();
  await next.request("list_peers", { session: "route-2", owner: "conversation-1", identity: "hermes:JD" });
  assert.equal(resolveClaim(name).generation, generation("hermes", "route-2"), "the same conversation refreshes on its next call");
  const taken = await named(next, "claim_name", "route-3", "conversation-2", name);
  assert.deepEqual([taken.status, taken.reason, taken.previous.running], ["refused", "name-held", true]);
  // Compression gives the live route a new conversation id; the name's owner follows it.
  await next.request("list_peers", { session: "route-2", owner: "conversation-1b", identity: "hermes:JD" });
  assert.equal(JSON.parse(readFileSync(nameFile(f, name), "utf8")).owner, generation("hermes", "jd", "conversation-1b"));
  await next.close();
  const third = f.restart();
  await third.request("list_peers", { session: "route-4", owner: "conversation-1", identity: "hermes:JD" });
  assert.throws(() => resolveClaim(name), notRunning, "the old conversation id no longer owns it");
  await third.request("send_peer", { session: "route-5", owner: "conversation-1b", name: "hermes:JD", to: "codex:test", message: "back" });
  assert.equal(resolveClaim(name).generation, generation("hermes", "route-5"));
});

// The reply-target allowlist (issue #28) with claims: a sender that addressed the conversation by
// its claimed name may write first; one that found its inbox in the socket directory may not.
test("a claimed name admits senders that used the name, never one that found the inbox", async (t) => {
  const f = await fixture(t, { profile: "jd" });
  const inbox = peerSocket((await named(f.bridge, "claim_name", "named", "conversation", "jd/relay")).address);
  const codex = address(join(f.sockets, "codex-test.sock"));
  const refusedIds = () => f.controls.filter(({ kind, line }) => kind === "codex" && line.drop_reason === "not-a-reply-target")
    .flatMap(({ line }) => line.dropped_msg_ids);
  const guessed = messageLine({ from: codex, body: "found the socket" });
  const wrong = { ...messageLine({ from: codex, body: "another name" }), agent_peers: { v: 1, to_name: "hermes:jd/other" } };
  await post(inbox, guessed);
  await post(inbox, wrong);
  await until(() => refusedIds().includes(guessed.msg_id) && refusedIds().includes(wrong.msg_id), "both refusals");
  await post(inbox, { ...messageLine({ from: codex, body: "by name" }), agent_peers: { v: 1, to_name: "hermes:jd/relay" } });
  await post(inbox, messageLine({ from: codex, body: "follow-up" }));
  await until(() => f.events.length === 2, "the named sender's messages");
  assert.deepEqual(f.events.map((e) => [e.params.session, e.params.message]), [["named", "by name"], ["named", "follow-up"]]);
  // Another Hermes conversation sends to the name; send_peer marks the line with it.
  const sent = await f.send("caller", "hermes:jd/relay", "from another conversation");
  assert.deepEqual([sent.status, sent.name, sent.generation], ["queued", "hermes:jd/relay", generation("hermes", "named")]);
  await until(() => f.events.length === 3);
  assert.deepEqual([f.events[2].params.session, f.events[2].params.message], ["named", "from another conversation"]);
});

test("a Claude session that ran agent-peers resolve may write first; another Claude session may not", async (t) => {
  const f = await fixture(t, { profile: "jd" });
  await named(f.bridge, "claim_name", "named", "conversation", "jd/relay");
  const lead = join(f.sockets, "lead.sock");
  await listen(createServer((conn) => readLines(conn, () => {})), lead, t);
  // The shell is the Claude session that runs resolve through its Bash tool.
  const shell = execFile("sh", ["-c", `read go; "${process.execPath}" "${join(root, "bin", "agent-peers.mjs")}" resolve hermes:jd/relay; read done`],
    { encoding: "utf8", env: { ...process.env } });
  t.after(() => shell.kill());
  let out = "";
  shell.stdout.on("data", (data) => { out += data; });
  writeFileSync(join(f.claude, "sessions", `${shell.pid}.json`), JSON.stringify({ pid: shell.pid, name: "lead", messagingSocketPath: lead }));
  shell.stdin.write("go\n");
  const resolved = (await until(() => out.includes("\n") && out, "the resolved address")).trim();
  assert.match(resolved, /^uds:.*\/hermes-[a-f0-9]{32}\.sock$/);
  await post(peerSocket(resolved), messageLine({ from: address(lead), fromName: "claude:lead", body: "from the lead" }));
  await until(() => f.events.length === 1, "the lead's message");
  // The fixture's other Claude session never resolved the name.
  await post(peerSocket(resolved), messageLine({ from: address(join(f.sockets, "claude-test.sock")), body: "guessed" }));
  await until(() => f.controls.some(({ kind, line }) => kind === "claude" && line.drop_reason === "not-a-reply-target"), "the refusal");
  assert.deepEqual(f.events.map((e) => e.params.message), ["from the lead"]);
  shell.stdin.end();
});

test("arrivals carry reply_name only for a verified claim, and first messages to Claude name this conversation", async (t) => {
  const f = await fixture(t, { profile: "jd" });
  await named(f.bridge, "claim_name", "conversation-a", "conversation", "jd/relay");
  const sent = await f.send("conversation-a", "claude:test", "hello");
  assert.equal(parseEnvelope(f.messages.at(-1).line.message.content).body,
    "hello\n\n(Hermes profile; notify_when_idle unavailable.) (Stable name: hermes:jd/relay.)");
  await f.send("conversation-a", "codex:test", "hello codex");
  claim("claude:proj/test", claudeClaimant(claudeSessionAt(process.pid)));
  assert.deepEqual((await f.bridge.request("list_peers")).peers.map((peer) => [peer.name, peer.claims]),
    [["claude:test", ["claude:proj/test"]], ["codex:test", []]]);
  await post(peerSocket(sent.from), messageLine({ from: address(join(f.sockets, "claude-test.sock")), fromName: "claude:test", body: "named" }));
  await post(peerSocket(sent.from), messageLine({ from: address(join(f.sockets, "codex-test.sock")), fromName: "codex:test", body: "unnamed" }));
  await until(() => f.events.length === 2);
  assert.deepEqual(f.events.map((e) => [e.params.message, e.params.reply_name]), [["named", "claude:proj/test"], ["unnamed", undefined]]);
});
