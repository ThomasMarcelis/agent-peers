// Deterministic opencode bridge tests: the exclusive bind record, single-flight binds, the cap,
// child sessions, synthetic delivery and its revert guard, receipts, names and lifecycle.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { test } from "node:test";
import { frame } from "../src/frame.mjs";
import { claimRows } from "../src/names.mjs";
import { generation, allPeers, stalePeers, processStart, address } from "../src/wire.mjs";
import {
  FakeHost, bridgeFor, delay, opencodeFixture, peerLine, session, until,
} from "./opencode-host.mjs";

const registry = (dir, id) => join(dir, "peers", `opencode-${id}.json`);
const sockets = (dir) => readdirSync(join(dir, "s")).filter((name) => name.startsWith("opencode-"));
const records = (dir) => readdirSync(join(dir, "peers")).filter((name) => /^opencode-.*\.json$/.test(name));

async function bound(t, f, { id = "ses_root", directory = join(f.dir, "repo"), title = "Repo", updated = 1, idle = 1, instance = "i-1" } = {}) {
  const host = new FakeHost();
  host.add(session({ id, directory, title, updated, idle }));
  const { bridge } = bridgeFor(host, { instance });
  t.after(() => bridge.close());
  const result = await bridge.tool({ instance, name: "list_peers", sessionID: id, args: {} });
  assert.equal(result.isError, false, result.text);
  return { host, bridge, result, instance, id };
}

test("a root binds once, publishes an exclusive record with no server fields, and a second call rebinds idempotently", async (t) => {
  const f = opencodeFixture(t);
  const { host, bridge, result } = await bound(t, f);
  const record = JSON.parse(readFileSync(registry(f.dir, "ses_root"), "utf8"));
  assert.deepEqual(Object.keys(record).sort(),
    ["address", "addresses", "cwd", "generation", "name", "pid", "procStart", "startedAt", "threadId"].sort());
  assert.equal(record.pid, process.pid);
  assert.equal(record.procStart, processStart(process.pid));
  assert.equal(record.threadId, "ses_root");
  assert.equal(record.cwd, join(f.dir, "repo"));
  assert.equal(record.name, result.structuredContent.self.name);
  assert.match(record.name, /^opencode:repo-[a-f0-9]{6}$/);
  assert.equal(record.generation, generation("opencode", "ses_root", processStart(process.pid)));
  assert.equal(record.address, result.structuredContent.self.address);
  assert.equal(result.structuredContent.self.sessionID, "ses_root");
  assert.equal(result.structuredContent.self.threadId, "ses_root");
  assert.deepEqual(record.addresses, [record.address]);
  assert.equal(record.serverPid, undefined);
  assert.equal(record.serverProcStart, undefined);
  assert.equal(sockets(f.dir).length, 1);
  // list_peers uses Codex's row shape: native/bridge fields and self excluded.
  const listedPeer = result.structuredContent.peers.find((peer) => peer.kind === "claude");
  assert.ok(listedPeer, "the fixture Claude peer is listed");
  assert.equal(listedPeer.native.reason, "Claude recipient");
  assert.equal(listedPeer.bridge.tool, "send_peer");
  assert.equal(result.structuredContent.peers.some((peer) => peer.kind === "opencode" && peer.threadId === "ses_root"), false);
  const second = await bridge.tool({ instance: "i-1", name: "list_peers", sessionID: "ses_root", args: {} });
  assert.equal(second.isError, false);
  assert.equal(second.structuredContent.self.address, record.address);
  assert.equal(records(f.dir).length, 1);
  assert.equal(sockets(f.dir).length, 1);
  assert.equal(host.count("host.session"), 2, "a root re-reads its session, but binds once");
  await bridge.close();
  assert.equal(records(f.dir).length, 0);
  assert.equal(sockets(f.dir).length, 0);
});

test("two bridges racing for one root: exactly one publishes, the other refuses and can never claim or send", async (t) => {
  const f = opencodeFixture(t);
  const hostA = new FakeHost(), hostB = new FakeHost();
  hostA.add(session({ id: "ses_root", directory: join(f.dir, "repo"), updated: 1, idle: 1 }));
  hostB.add(session({ id: "ses_root", directory: join(f.dir, "repo"), updated: 1, idle: 1 }));
  const a = bridgeFor(hostA, { instance: "a" }), b = bridgeFor(hostB, { instance: "b" });
  t.after(async () => { await a.bridge.close(); await b.bridge.close(); });
  const [ra, rb] = await Promise.all([
    a.bridge.tool({ instance: "a", name: "list_peers", sessionID: "ses_root", args: {} }),
    b.bridge.tool({ instance: "b", name: "list_peers", sessionID: "ses_root", args: {} }),
  ]);
  assert.equal([ra.isError, rb.isError].filter(Boolean).length, 1, `${ra.text} / ${rb.text}`);
  const loser = ra.isError ? a : b, loserResult = ra.isError ? ra : rb;
  assert.equal(loserResult.structuredContent.reason, "inbox-unavailable");
  assert.match(loserResult.text, /already served by another opencode server/);
  assert.equal(records(f.dir).length, 1);
  assert.equal(sockets(f.dir).length, 1);
  // A refused bind never reaches a claim.
  const claimed = await loser.bridge.tool({ instance: loser === a ? "a" : "b", name: "claim_name", sessionID: "ses_root", args: { name: "proj/lead" } });
  assert.equal(claimed.isError, true);
  assert.equal(claimed.structuredContent.reason, "inbox-unavailable");
  assert.equal(existsSync(join(f.peers, "names")), false);
  // Nor a send.
  const peer = await f.peer("target");
  const sent = await loser.bridge.tool({ instance: loser === a ? "a" : "b", name: "send_peer", sessionID: "ses_root", args: { to: peer.address, message: "hi" } });
  assert.equal(sent.isError, true);
  assert.equal(sent.structuredContent.reason, "inbox-unavailable");
  assert.deepEqual(peer.lines, []);
});

test("the prompt event and the first tool call share one bind; a child's prompt binds nothing", async (t) => {
  const f = opencodeFixture(t);
  const host = new FakeHost({ latency: 20 });
  host.add(session({ id: "ses_root", directory: join(f.dir, "repo"), updated: 1, idle: 1 }));
  host.add(session({ id: "ses_child", parentID: "ses_root", directory: join(f.dir, "repo"), updated: 1, idle: 1 }));
  const { bridge } = bridgeFor(host);
  t.after(() => bridge.close());
  await Promise.all([
    bridge.event({ instance: "i-1", type: "prompt", sessionID: "ses_root" }),
    bridge.tool({ instance: "i-1", name: "list_peers", sessionID: "ses_root", args: {} }),
  ]);
  assert.equal(records(f.dir).length, 1);
  assert.equal(sockets(f.dir).length, 1);
  assert.equal(records(f.dir).includes("opencode-ses_child.json"), false);
  await delay(50);
  await bridge.event({ instance: "i-1", type: "prompt", sessionID: "ses_child" });
  await delay(50);
  assert.equal(records(f.dir).length, 1, "a child prompt does not bind");
  assert.equal(records(f.dir).includes("opencode-ses_child.json"), false);
});

test("at 64 roots an idle unnamed LRU root is evicted; a busy or named root never is; with no candidate the bind is refused", { timeout: 60_000 }, async (t) => {
  const f = opencodeFixture(t);
  const host = new FakeHost();
  const ids = Array.from({ length: 64 }, (_, i) => `ses_${String(i).padStart(3, "0")}`);
  for (const [i, id] of ids.entries()) host.add(session({ id, directory: join(f.dir, `repo-${i}`), updated: 1, idle: 1 }));
  const { bridge } = bridgeFor(host);
  t.after(() => bridge.close());
  for (const id of ids) {
    const result = await bridge.tool({ instance: "i-1", name: "list_peers", sessionID: id, args: {} });
    assert.equal(result.isError, false, `${id}: ${result.text}`);
  }
  assert.equal(records(f.dir).length, 64);
  // Root 0 is oldest, but busy. Root 1 is idle but holds a name.
  delete host.sessions.get(ids[0]).time.idle;
  const claimed = await bridge.tool({ instance: "i-1", name: "claim_name", sessionID: ids[1], args: { name: "proj/lead" } });
  assert.equal(claimed.structuredContent.status, "claimed");
  host.add(session({ id: "ses_064", directory: join(f.dir, "repo-64"), updated: 1, idle: 1 }));
  const added = await bridge.tool({ instance: "i-1", name: "list_peers", sessionID: "ses_064", args: {} });
  assert.equal(added.isError, false, added.text);
  assert.ok(existsSync(registry(f.dir, ids[0])), "the busy oldest root stays");
  assert.ok(existsSync(registry(f.dir, ids[1])), "the named root stays");
  assert.equal(existsSync(registry(f.dir, ids[2])), false, "the oldest idle unnamed root is evicted");
  assert.equal(records(f.dir).length, 64);
  assert.match(added.text, /You are opencode:repo-64-/);
  // Every remaining root busy: the new bind is refused with the cap text.
  for (const info of host.sessions.values()) delete info.time.idle;
  host.add(session({ id: "ses_065", directory: join(f.dir, "repo-65"), updated: 1, idle: 1, }));
  const refused = await bridge.tool({ instance: "i-1", name: "list_peers", sessionID: "ses_065", args: {} });
  assert.equal(refused.isError, true);
  assert.equal(refused.structuredContent.reason, "inbox-unavailable");
  assert.match(refused.text, /none is idle without claimed names/);
  assert.equal(existsSync(registry(f.dir, "ses_065")), false);
  assert.equal(records(f.dir).length, 64);
});

test("a child resolves to the root once, sends from the root address, holds no names, and reports subagent true", async (t) => {
  const f = opencodeFixture(t);
  const host = new FakeHost();
  host.add(session({ id: "ses_root", directory: join(f.dir, "repo"), title: "Root", updated: 1, idle: 1 }));
  host.add(session({ id: "ses_child", parentID: "ses_root", directory: join(f.dir, "repo"), title: "Child", updated: 1, idle: 1 }));
  const { bridge } = bridgeFor(host);
  t.after(() => bridge.close());
  const first = await bridge.tool({ instance: "i-1", name: "list_peers", sessionID: "ses_child", args: {} });
  assert.equal(first.isError, false, first.text);
  const { self } = first.structuredContent;
  assert.equal(self.subagent, true);
  assert.equal(self.threadId, "ses_root");
  assert.equal(self.sessionID, "ses_child");
  assert.match(self.name, /^opencode:repo-[a-f0-9]{6}$/);
  assert.equal(host.count("host.session"), 2, "the child and its root are read once");
  const boundRoot = JSON.parse(readFileSync(registry(f.dir, "ses_root"), "utf8"));
  assert.equal(self.address, boundRoot.address);
  assert.equal(existsSync(registry(f.dir, "ses_child")), false);
  await bridge.tool({ instance: "i-1", name: "list_peers", sessionID: "ses_child", args: {} });
  assert.equal(host.count("host.session"), 2, "the child→root result is cached");
  for (const name of ["claim_name", "release_name"]) {
    const result = await bridge.tool({ instance: "i-1", name, sessionID: "ses_child", args: { name: "proj/child" } });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.reason, "no-session");
    assert.match(result.text, /subagent sends under its root/);
  }
  const peer = await f.peer("child-target");
  const sent = await bridge.tool({ instance: "i-1", name: "send_peer", sessionID: "ses_child", args: { to: peer.address, message: "from child" } });
  assert.equal(sent.isError, false, sent.text);
  await until(() => peer.lines.length === 1, "the child's send");
  const envelope = peer.lines[0].message.content;
  assert.ok(envelope.includes(`from="${boundRoot.address}"`), envelope);
});

test("an inbound line is queued then accepted through synthetic with steer and no turn restart", async (t) => {
  const f = opencodeFixture(t);
  const { host, bridge } = await bound(t, f, { updated: 1, idle: 0 });
  const sender = await f.peer("sender");
  const self = (await bridge.tool({ instance: "i-1", name: "list_peers", sessionID: "ses_root", args: {} })).structuredContent.self;
  const line = peerLine(sender.address, "hello there", { receipts: ["queued", "accepted"] });
  const { post, peerSocket } = await import("../src/wire.mjs");
  await post(peerSocket(self.address), line);
  await until(() => sender.lines.some((l) => l.type === "control" && l.status === "accepted"), "accepted");
  assert.deepEqual(sender.lines.filter((l) => l.type === "control").map((l) => l.status), ["queued", "accepted"]);
  const info = host.sessions.get("ses_root");
  assert.equal(info.steers, 1);
  assert.equal(info.wakes, 0);
  assert.equal(info.texts.length, 1);
  const expected = frame({ sender: "claude:sender", from: sender.address, replyName: undefined, id: line.msg_id, ext: {}, body: "hello there" });
  assert.equal(info.texts[0], expected);
  assert.equal(host.calls.find((c) => c.method === "host.synthetic").params.delivery, "steer");
  assert.equal(host.calls.find((c) => c.method === "host.synthetic").params.resume, true);
});

test("an idle session is woken by resume:true", async (t) => {
  const f = opencodeFixture(t);
  const { host, bridge } = await bound(t, f, { updated: 5, idle: 5 });
  const sender = await f.peer("idle-sender");
  const self = (await bridge.tool({ instance: "i-1", name: "list_peers", sessionID: "ses_root", args: {} })).structuredContent.self;
  const { post, peerSocket } = await import("../src/wire.mjs");
  await post(peerSocket(self.address), peerLine(sender.address, "wake up", { receipts: ["accepted"] }));
  await until(() => host.sessions.get("ses_root").wakes === 1, "the idle wake");
  const info = host.sessions.get("ses_root");
  assert.equal(info.steers, 0);
  assert.equal(host.calls.find((c) => c.method === "host.synthetic").params.resume, true);
});

test("prompt commits a staged revert while synthetic never does; a staged revert drops before host.synthetic", async (t) => {
  const f = opencodeFixture(t);
  const { host, bridge } = await bound(t, f);
  const info = host.sessions.get("ses_root");
  info.revert = { messageID: "undo-me" };
  // The fake's prompt path demonstrates the difference; the bridge never calls prompt.
  host.prompt("ses_root");
  assert.equal(info.revertCommits, 1);
  assert.deepEqual(info.revert, undefined);
  info.revert = { messageID: "still-staged" };
  const sender = await f.peer("revert-sender");
  const self = (await bridge.tool({ instance: "i-1", name: "list_peers", sessionID: "ses_root", args: {} })).structuredContent.self;
  const { post, peerSocket } = await import("../src/wire.mjs");
  await post(peerSocket(self.address), peerLine(sender.address, "should drop", { receipts: ["queued", "accepted"] }));
  await until(() => sender.lines.some((l) => l.type === "control" && l.status === "dropped"), "the revert drop");
  const dropped = sender.lines.find((l) => l.type === "control" && l.status === "dropped");
  assert.equal(dropped.drop_reason, "host-rejected");
  assert.deepEqual(info.revert, { messageID: "still-staged" }, "the revert is untouched");
  assert.deepEqual(info.texts, [], "host.synthetic was never called");
});

test("tool and handoff not-found mapping, ordinary target not-found, duplicates, and no receipt on a lost host call", async (t) => {
  const f = opencodeFixture(t);
  const { host, bridge } = await bound(t, f);
  // Caller session gone: a tool gets no-session.
  host.sessions.delete("ses_root");
  const missing = await bridge.tool({ instance: "i-1", name: "list_peers", sessionID: "ses_root", args: {} });
  assert.equal(missing.isError, true);
  assert.equal(missing.structuredContent.reason, "no-session");
  host.add(session({ id: "ses_root", directory: join(f.dir, "repo"), updated: 1, idle: 1 }));
  await bridge.tool({ instance: "i-1", name: "list_peers", sessionID: "ses_root", args: {} });
  // A missing target peer stays the ordinary send result.
  const target = await bridge.tool({ instance: "i-1", name: "send_peer", sessionID: "ses_root", args: { to: "codex:missing", message: "hi" } });
  assert.equal(target.structuredContent.status, "failed");
  assert.equal(target.structuredContent.reason, "not-found");
  // Duplicate ids get no second receipt.
  const sender = await f.peer("dupe");
  const self = (await bridge.tool({ instance: "i-1", name: "list_peers", sessionID: "ses_root", args: {} })).structuredContent.self;
  const { post, peerSocket } = await import("../src/wire.mjs");
  const line = peerLine(sender.address, "once", { id: "fixed-id-1", receipts: ["queued", "accepted"] });
  await post(peerSocket(self.address), line);
  await post(peerSocket(self.address), line);
  await until(() => sender.lines.filter((l) => l.type === "control" && l.status === "accepted").length === 1, "the first acceptance");
  await delay(100);
  assert.deepEqual(sender.lines.filter((l) => l.type === "control").map((l) => l.status), ["queued", "accepted"]);
  // A host call that never answers sends no receipt, not inbox-closed.
  host.hangSynthetic = true;
  const hung = peerLine(sender.address, "lost", { receipts: ["queued", "accepted"] });
  await post(peerSocket(self.address), hung);
  await until(() => sender.lines.some((l) => l.type === "control" && l.status === "queued" && l.orig_msg_id === hung.msg_id), "queued before the lost host call");
  await delay(900);
  assert.equal(sender.lines.some((l) => l.type === "control" && l.orig_msg_id === hung.msg_id && l.status !== "queued"), false);
});

test("inbox guards: rate limit, queue full, host too-large, and not-a-reply-target", async (t) => {
  const f = opencodeFixture(t);
  const host = new FakeHost();
  host.add(session({ id: "ses_root", directory: join(f.dir, "repo"), updated: 1, idle: 1 }));
  const { bridge } = bridgeFor(host, { admission: { capacity: 1, refillPerS: 0 }, queueMax: 0 });
  t.after(() => bridge.close());
  const listed = await bridge.tool({ instance: "i-1", name: "list_peers", sessionID: "ses_root", args: {} });
  const self = listed.structuredContent.self;
  const sender = await f.peer("guards");
  const { post, peerSocket } = await import("../src/wire.mjs");
  await post(peerSocket(self.address), peerLine(sender.address, "first", { receipts: ["queued", "accepted"] }));
  await until(() => sender.lines.some((l) => l.type === "control" && l.status === "dropped"), "queue full");
  assert.equal(sender.lines.find((l) => l.status === "dropped").drop_reason, "queue-full");
  await bridge.close();
  // A new bridge with room: the token bucket admits one, then rate-limits the next.
  const second = bridgeFor(host, { admission: { capacity: 1, refillPerS: 0 } });
  t.after(() => second.bridge.close());
  await second.bridge.tool({ instance: "i-1", name: "list_peers", sessionID: "ses_root", args: {} });
  const sender2 = await f.peer("guards-2");
  const self2 = (await second.bridge.tool({ instance: "i-1", name: "list_peers", sessionID: "ses_root", args: {} })).structuredContent.self;
  await post(peerSocket(self2.address), peerLine(sender2.address, "one", { receipts: ["accepted"] }));
  await post(peerSocket(self2.address), peerLine(sender2.address, "two", { receipts: ["accepted"] }));
  await until(() => sender2.lines.some((l) => l.type === "control" && l.status === "dropped"), "rate limited");
  assert.equal(sender2.lines.find((l) => l.status === "dropped").drop_reason, "rate-limited");
  // Host rejects the synthetic as too large.
  host.failSynthetic = "too-large";
  const sender3 = await f.peer("guards-3");
  await post(peerSocket(self2.address), peerLine(sender3.address, "large", { receipts: ["accepted"] }));
  await until(() => sender3.lines.some((l) => l.type === "control" && l.status === "dropped"), "too-large drop");
  assert.equal(sender3.lines.find((l) => l.status === "dropped").drop_reason, "too-large");
  host.failSynthetic = undefined;
  // A line marked with a name this root does not hold is refused.
  const sender4 = await f.peer("guards-4");
  await post(peerSocket(self2.address), peerLine(sender4.address, "wrong name", { toName: "opencode:proj/other", receipts: ["accepted"] }));
  await until(() => sender4.lines.some((l) => l.type === "control" && l.status === "dropped"), "not a reply target");
  assert.equal(sender4.lines.find((l) => l.status === "dropped").drop_reason, "not-a-reply-target");
});

test("a held to_name is admitted and a released one is refused", async (t) => {
  const f = opencodeFixture(t);
  const { bridge } = await bound(t, f);
  const claimed = await bridge.tool({ instance: "i-1", name: "claim_name", sessionID: "ses_root", args: { name: "proj/lead" } });
  assert.equal(claimed.structuredContent.status, "claimed");
  const self = (await bridge.tool({ instance: "i-1", name: "list_peers", sessionID: "ses_root", args: {} })).structuredContent.self;
  const sender = await f.peer("name-sender");
  const { post, peerSocket } = await import("../src/wire.mjs");
  await post(peerSocket(self.address), peerLine(sender.address, "by name", { toName: "opencode:proj/lead", receipts: ["accepted"] }));
  await until(() => sender.lines.some((l) => l.type === "control" && l.status === "accepted"), "held name accepted");
  const released = await bridge.tool({ instance: "i-1", name: "release_name", sessionID: "ses_root", args: { name: "proj/lead" } });
  assert.equal(released.structuredContent.status, "released");
  const sender2 = await f.peer("name-sender-2");
  await post(peerSocket(self.address), peerLine(sender2.address, "after release", { toName: "opencode:proj/lead", receipts: ["accepted"] }));
  await until(() => sender2.lines.some((l) => l.type === "control" && l.status === "dropped"), "released name refused");
  assert.equal(sender2.lines.find((l) => l.status === "dropped").drop_reason, "not-a-reply-target");
});

test("a late negative receipt is appended with synthetic resume:false and never commits a revert", async (t) => {
  const f = opencodeFixture(t);
  const { host, bridge } = await bound(t, f);
  const info = host.sessions.get("ses_root");
  info.revert = { messageID: "staged" };
  const peer = await f.peer("slow", { receipt: "dropped", receiptReason: "rate-limited", receiptDelay: 1600 });
  const sent = await bridge.tool({ instance: "i-1", name: "send_peer", sessionID: "ses_root", args: { to: peer.address, message: "slow target" } });
  assert.deepEqual([sent.structuredContent.status, sent.structuredContent.reason], ["unconfirmed", "no-receipt"]);
  await until(() => host.calls.some((c) => c.method === "host.synthetic"), "the late notice", 500);
  const notice = host.calls.find((c) => c.method === "host.synthetic");
  assert.equal(notice.params.resume, false);
  assert.match(notice.params.text, /^agent-peers delivery notice, not user input:/);
  assert.match(notice.params.text, /not delivered \(dropped: rate-limited\)/);
  assert.deepEqual(info.revert, { messageID: "staged" });
  assert.equal(info.revertCommits, 0);
});

test("opencode names: claim, refresh, dead takeover, live refusal, cross-kind scope, and a bridge-restart refresh", async (t) => {
  const f = opencodeFixture(t);
  const { bridge } = await bound(t, f);
  const call = (name, args) => bridge.tool({ instance: "i-1", name, sessionID: "ses_root", args });
  const claimed = await call("claim_name", { name: "proj/lead" });
  assert.deepEqual([claimed.structuredContent.status, claimed.structuredContent.name, claimed.structuredContent.kind],
    ["claimed", "opencode:proj/lead", "opencode"]);
  assert.equal((await call("claim_name", { name: "opencode:proj/lead" })).structuredContent.status, "refreshed");
  assert.equal((await call("claim_name", { name: "codex:proj/lead" })).structuredContent.reason, "scope-denied");
  assert.equal((await call("release_name", { name: "claude:proj/lead" })).structuredContent.reason, "scope-denied");
  assert.equal((await call("claim_name", { name: "Proj/lead" })).structuredContent.reason, "invalid-request");
  // A live opencode holder with another owner keeps its name.
  const root = JSON.parse(readFileSync(registry(f.dir, "ses_root"), "utf8"));
  writeFileSync(registry(f.dir, "ses_other"), JSON.stringify({ name: "opencode:other-aaaaaa", address: root.address, addresses: [root.address],
    cwd: root.cwd, threadId: "ses_other", pid: process.pid, procStart: processStart(process.pid), generation: generation("opencode", "ses_other", processStart(process.pid)), startedAt: 1 }), { mode: 0o600 });
  const other = { kind: "opencode", owner: generation("opencode", "ses_other"), generation: generation("opencode", "ses_other", processStart(process.pid)),
    address: root.address, holder: { pid: process.pid, procStart: processStart(process.pid), autoName: "opencode:other-aaaaaa", threadId: "ses_other", addresses: [root.address] } };
  const { claim } = await import("../src/names.mjs");
  assert.equal(claim("opencode:proj/other", other).status, "claimed");
  assert.equal((await call("claim_name", { name: "opencode:proj/other" })).structuredContent.reason, "name-held");
  // A dead opencode name can be released by this opencode session.
  const dead = { kind: "opencode", owner: generation("opencode", "ses_dead"), generation: generation("opencode", "ses_dead", "old"),
    address: root.address, holder: { pid: 0x7ffffffe, procStart: "old", autoName: "opencode:dead-bbbbbb", threadId: "ses_dead", addresses: [root.address] } };
  assert.equal(claim("opencode:proj/dead", dead).status, "claimed");
  assert.equal((await call("release_name", { name: "opencode:proj/dead" })).structuredContent.status, "released");
  // The bridge restart refresh: a record for the same owner with an old generation.
  const nameFile = join(f.peers, "names", `n-${(await import("node:crypto")).createHash("sha256").update("opencode:proj/restart").digest("hex").slice(0, 32)}.json`);
  writeFileSync(nameFile, JSON.stringify({ v: 1, name: "opencode:proj/restart", kind: "opencode", owner: generation("opencode", "ses_root"),
    generation: "0123456789abcdef", claimedAt: 1,
    holder: { pid: 0x7ffffffd, procStart: "old", autoName: "opencode:old-cccccc", threadId: "ses_root", addresses: [root.address] } }), { mode: 0o600 });
  const again = bridgeFor(hostOf(f), { instance: "i-1" });
  t.after(() => again.bridge.close());
  // The registry is still bound to the first bridge, so close it before the restart bind.
  await bridge.close();
  const rebind = await again.bridge.tool({ instance: "i-1", name: "list_peers", sessionID: "ses_root", args: {} });
  assert.equal(rebind.isError, false, rebind.text);
  const stored = JSON.parse(readFileSync(nameFile, "utf8"));
  assert.equal(stored.generation, JSON.parse(readFileSync(registry(f.dir, "ses_root"), "utf8")).generation);
  assert.equal(stored.holder.pid, process.pid);
  assert.equal(stored.holder.threadId, "ses_root");
});

function hostOf(f) {
  const host = new FakeHost();
  host.add(session({ id: "ses_root", directory: join(f.dir, "repo"), updated: 1, idle: 1 }));
  return host;
}

test("a handoff to a session the host lost is dropped inbox-closed and unbinds; a synthetic not-found does the same", async (t) => {
  const f = opencodeFixture(t);
  const { host, bridge } = await bound(t, f);
  const sender = await f.peer("closed-sender");
  const self = (await bridge.tool({ instance: "i-1", name: "list_peers", sessionID: "ses_root", args: {} })).structuredContent.self;
  const { post, peerSocket } = await import("../src/wire.mjs");
  host.sessions.delete("ses_root");
  await post(peerSocket(self.address), peerLine(sender.address, "session gone", { receipts: ["accepted"] }));
  await until(() => sender.lines.some((l) => l.type === "control" && l.status === "dropped"), "the inbox-closed drop");
  assert.equal(sender.lines.find((l) => l.status === "dropped").drop_reason, "inbox-closed");
  assert.equal(existsSync(registry(f.dir, "ses_root")), false);
  assert.equal(sockets(f.dir).length, 0);
  // synthetic not-found after a successful host.session: the record is removed too.
  const second = await bound(t, f, { id: "ses_second" });
  const self2 = (await second.bridge.tool({ instance: "i-1", name: "list_peers", sessionID: "ses_second", args: {} })).structuredContent.self;
  second.host.failSynthetic = "not-found";
  const sender2 = await f.peer("closed-sender-2");
  await post(peerSocket(self2.address), peerLine(sender2.address, "synthetic gone", { receipts: ["accepted"] }));
  await until(() => sender2.lines.some((l) => l.type === "control" && l.status === "dropped"), "the synthetic not-found drop");
  assert.equal(sender2.lines.find((l) => l.status === "dropped").drop_reason, "inbox-closed");
  assert.equal(existsSync(registry(f.dir, "ses_second")), false);
});

test("deleted, moved and closed unbind only the affected roots; a late move from an old instance is ignored", async (t) => {
  const f = opencodeFixture(t);
  const host = new FakeHost();
  for (const id of ["ses_a", "ses_b", "ses_c"]) host.add(session({ id, directory: join(f.dir, id), updated: 1, idle: 1 }));
  const { bridge } = bridgeFor(host);
  t.after(() => bridge.close());
  bridge.hello({ instance: "i-2", location: { directory: join(f.dir, "two") } });
  const bind = async (id, instance) => {
    const result = await bridge.tool({ instance, name: "list_peers", sessionID: id, args: {} });
    assert.equal(result.isError, false, result.text);
    return result.structuredContent.self;
  };
  await bind("ses_a", "i-1");
  await bind("ses_b", "i-2");
  await bridge.event({ instance: "i-1", type: "deleted", sessionID: "ses_a" });
  assert.equal(existsSync(registry(f.dir, "ses_a")), false);
  assert.equal(existsSync(registry(f.dir, "ses_b")), true);
  await bridge.event({ instance: "i-2", type: "moved", sessionID: "ses_b" });
  assert.equal(existsSync(registry(f.dir, "ses_b")), false);
  // Rebind at the new location; the deterministic socket path and the registry are recreated.
  host.sessions.get("ses_b").location.directory = join(f.dir, "moved");
  const self = await bind("ses_b", "i-2");
  assert.equal(JSON.parse(readFileSync(registry(f.dir, "ses_b"), "utf8")).cwd, join(f.dir, "moved"));
  // A late move from the instance that no longer owns it must not close the newer bind.
  await bridge.event({ instance: "i-1", type: "moved", sessionID: "ses_b" });
  assert.equal(existsSync(registry(f.dir, "ses_b")), true);
  assert.equal(JSON.parse(readFileSync(registry(f.dir, "ses_b"), "utf8")).address, self.address);
  // closed unregisters one instance's roots and keeps the other instance's.
  await bind("ses_c", "i-1");
  await bridge.event({ instance: "i-1", type: "closed" });
  assert.equal(existsSync(registry(f.dir, "ses_c")), false);
  assert.equal(existsSync(registry(f.dir, "ses_b")), true);
});

test("two servers: the first live bridge owns the root, the second refuses, and after the first exits the second binds", async (t) => {
  const f = opencodeFixture(t);
  const hostA = new FakeHost(), hostB = new FakeHost();
  for (const host of [hostA, hostB]) host.add(session({ id: "ses_root", directory: join(f.dir, "repo"), updated: 1, idle: 1 }));
  const a = bridgeFor(hostA, { instance: "a" }), b = bridgeFor(hostB, { instance: "b" });
  t.after(async () => { await a.bridge.close(); await b.bridge.close(); });
  const first = await a.bridge.tool({ instance: "a", name: "list_peers", sessionID: "ses_root", args: {} });
  assert.equal(first.isError, false, first.text);
  const refused = await b.bridge.tool({ instance: "b", name: "list_peers", sessionID: "ses_root", args: {} });
  assert.equal(refused.isError, true);
  assert.equal(refused.structuredContent.reason, "inbox-unavailable");
  assert.equal(records(f.dir).length, 1);
  assert.equal(sockets(f.dir).length, 1);
  // A delivery reaches only the first server's host.
  const sender = await f.peer("two-server");
  const self = first.structuredContent.self;
  const { post, peerSocket } = await import("../src/wire.mjs");
  await post(peerSocket(self.address), peerLine(sender.address, "to the first", { receipts: ["accepted"] }));
  await until(() => sender.lines.some((l) => l.type === "control" && l.status === "accepted"), "the first bridge's acceptance");
  assert.equal(hostA.sessions.get("ses_root").texts.length, 1);
  assert.equal(hostB.sessions.get("ses_root").texts.length, 0);
  // After the first bridge exits, its record and socket are gone and the second binds.
  await a.bridge.close();
  assert.equal(records(f.dir).length, 0);
  assert.equal(sockets(f.dir).length, 0);
  const second = await b.bridge.tool({ instance: "b", name: "list_peers", sessionID: "ses_root", args: {} });
  assert.equal(second.isError, false, second.text);
  assert.equal(records(f.dir).length, 1);
  const self2 = second.structuredContent.self;
  const sender2 = await f.peer("two-server-2");
  await post(peerSocket(self2.address), peerLine(sender2.address, "to the second", { receipts: ["accepted"] }));
  await until(() => sender2.lines.some((l) => l.type === "control" && l.status === "accepted"), "the second bridge's acceptance");
  assert.equal(hostB.sessions.get("ses_root").texts.length, 1);
  assert.equal(hostA.sessions.get("ses_root").texts.length, 1);
});

test("two bridges racing to replace a dead record: at most one takes the seat", async (t) => {
  const f = opencodeFixture(t);
  const start = processStart(process.pid);
  writeFileSync(registry(f.dir, "ses_root"), JSON.stringify({
    name: "opencode:old-aaaaaa", address: address(join(f.sockets, "opencode-old.sock")),
    addresses: [address(join(f.sockets, "opencode-old.sock"))], cwd: join(f.dir, "old"), threadId: "ses_root",
    pid: 0x7ffffff0, procStart: "old", generation: generation("opencode", "ses_root", "old"), startedAt: 1,
  }), { mode: 0o600 });
  const hostA = new FakeHost(), hostB = new FakeHost();
  for (const host of [hostA, hostB]) host.add(session({ id: "ses_root", directory: join(f.dir, "repo"), updated: 1, idle: 1 }));
  const a = bridgeFor(hostA, { instance: "a" }), b = bridgeFor(hostB, { instance: "b" });
  t.after(async () => { await a.bridge.close(); await b.bridge.close(); });
  const [ra, rb] = await Promise.all([
    a.bridge.tool({ instance: "a", name: "list_peers", sessionID: "ses_root", args: {} }),
    b.bridge.tool({ instance: "b", name: "list_peers", sessionID: "ses_root", args: {} }),
  ]);
  assert.equal([ra.isError, rb.isError].filter(Boolean).length, 1, `${ra.text} / ${rb.text}`);
  assert.equal(records(f.dir).length, 1);
  assert.equal(sockets(f.dir).length, 1);
  const record = JSON.parse(readFileSync(registry(f.dir, "ses_root"), "utf8"));
  assert.equal(record.pid, process.pid);
  assert.equal(record.procStart, start);
  assert.equal(record.name.startsWith("opencode:repo-"), true);
});

test("a new bridge removes only dead opencode records and their deterministic sockets, never a live owner", async (t) => {
  const f = opencodeFixture(t);
  const start = processStart(process.pid), liveSocket = join(f.sockets, "opencode-live.sock");
  const deadId = "ses_dead", deadHash = createHash("sha256").update(deadId).digest("hex").slice(0, 16);
  const deadSocket = join(f.sockets, `opencode-${deadHash}.sock`);
  // A killed listener leaves its socket file behind, as a hard-killed bridge does.
  const orphan = spawn(process.execPath, ["-e", `require("net").createServer().listen(${JSON.stringify(deadSocket)},()=>console.log("up"))`]);
  await new Promise((resolve) => orphan.stdout.once("data", resolve));
  orphan.kill("SIGKILL");
  await new Promise((resolve) => orphan.once("close", resolve));
  const write = (id, socket, pid, procStart) => writeFileSync(registry(f.dir, id), JSON.stringify({
    name: `opencode:${id}-aaaaaa`, address: address(socket), addresses: [address(socket)], cwd: f.dir, threadId: id,
    pid, procStart, generation: generation("opencode", id, procStart), startedAt: 1,
  }), { mode: 0o600 });
  write("ses_live", liveSocket, process.pid, start);
  write(deadId, deadSocket, 0x7ffffff0, "old");
  assert.ok(existsSync(deadSocket));
  const host = new FakeHost();
  host.add(session({ id: "ses_new", directory: join(f.dir, "new"), updated: 1, idle: 1 }));
  const { bridge } = bridgeFor(host);
  t.after(() => bridge.close());
  const result = await bridge.tool({ instance: "i-1", name: "list_peers", sessionID: "ses_new", args: {} });
  assert.equal(result.isError, false, result.text);
  assert.equal(existsSync(registry(f.dir, deadId)), false);
  assert.equal(existsSync(deadSocket), false);
  assert.equal(existsSync(registry(f.dir, "ses_live")), true, "a live owner is never touched");
  assert.equal(basename(liveSocket), "opencode-live.sock");
});

test("registry liveness: dead, reused and missing records are stale; a live record is not taken over", async (t) => {
  const f = opencodeFixture(t);
  const root = join(f.dir, "repo"), start = processStart(process.pid);
  const socket = address(join(f.sockets, "opencode-live.sock"));
  const write = (id, fields = {}) => writeFileSync(registry(f.dir, id), JSON.stringify({
    name: `opencode:${id}-aaaaaa`, address: socket, addresses: [socket],
    cwd: root, threadId: id, pid: process.pid, procStart: start, generation: generation("opencode", id, start), startedAt: 1, ...fields,
  }), { mode: 0o600 });
  write("ses_live");
  write("ses_dead", { pid: 0x7ffffff0, procStart: "old" });
  write("ses_reused", { procStart: "an-older-start" });
  assert.deepEqual(allPeers().filter((p) => p.kind === "opencode").map((p) => p.threadId), ["ses_live"]);
  assert.deepEqual(stalePeers().filter((p) => p.kind === "opencode").map((p) => p.threadId).sort(), ["ses_dead", "ses_reused"]);
  assert.deepEqual(claimRows(), [], "no names yet");
  // A name whose opencode registry file is gone counts as stopped.
  const { claim, resolveClaim } = await import("../src/names.mjs");
  const holder = { kind: "opencode", owner: generation("opencode", "ses_gone"), generation: generation("opencode", "ses_gone", start),
    address: socket, holder: { pid: process.pid, procStart: start, autoName: "opencode:gone-aaaaaa", threadId: "ses_gone", addresses: [socket] } };
  assert.equal(claim("opencode:proj/gone", holder).status, "claimed");
  assert.throws(() => resolveClaim("opencode:proj/gone"), (error) => error.reason === "not-running");
  write("ses_gone");
  const rebind = claim("opencode:proj/gone", { ...holder, generation: generation("opencode", "ses_gone", start) });
  assert.equal(rebind.status, "refreshed");
});
