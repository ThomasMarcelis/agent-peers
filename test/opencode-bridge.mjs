// Deterministic opencode bridge tests: the exclusive bind record, single-flight binds, the cap,
// child sessions, synthetic delivery and its revert guard, receipts, names and lifecycle.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { basename, join } from "node:path";
import { test } from "node:test";
import { frame } from "../src/frame.mjs";
import { claimRows } from "../src/names.mjs";
import { generation, allPeers, stalePeers, processStart, address, socketDirectories, socketPath } from "../src/wire.mjs";
import { listen } from "./listeners.mjs";
import {
  FakeHost, bridgeFor, delay, opencodeFixture, peerLine, session, until,
} from "./opencode-host.mjs";

const registry = (dir, id) => join(dir, "peers", `opencode-${id}.json`);
const sockets = (dir) => readdirSync(join(dir, "s")).filter((name) => name.startsWith("opencode-"));
const records = (dir) => readdirSync(join(dir, "peers")).filter((name) => /^opencode-.*\.json$/.test(name));
const socketName = (id) => `opencode-${createHash("sha256").update(id).digest("hex").slice(0, 16)}.sock`;
const deadRecord = (id, socket, fields = {}) => JSON.stringify({
  name: "opencode:old-aaaaaa", address: address(socket), addresses: [address(socket)], cwd: "/old", threadId: id,
  pid: 0x7ffffff0, procStart: "old", generation: generation("opencode", id, "old"), startedAt: 1, ...fields,
});
// A gate a test holds a host or publish step on, with a count of the callers that reached it.
function gate() {
  let release = () => {};
  const opened = new Promise((resolve) => { release = resolve; });
  const held = { count: 0, release, wait: async () => { held.count++; await opened; } };
  return held;
}
// A socket file left by a hard-killed listener.
async function orphanSocket(path) {
  const orphan = spawn(process.execPath, ["-e", `require("net").createServer().listen(${JSON.stringify(path)},()=>console.log("up"))`]);
  await new Promise((resolve) => orphan.stdout.once("data", resolve));
  orphan.kill("SIGKILL");
  await new Promise((resolve) => orphan.once("close", resolve));
}

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
    ["address", "addresses", "cwd", "generation", "name", "pid", "procStart", "startedAt", "threadId", "token"].sort());
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
  assert.match(loserResult.text, /already served by another opencode server|another bridge published this opencode session first/);
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

test("a forced interleaving between the bind read and link still publishes exactly one record", async (t) => {
  const f = opencodeFixture(t);
  const hostA = new FakeHost(), hostB = new FakeHost();
  for (const host of [hostA, hostB]) host.add(session({ id: "ses_root", directory: join(f.dir, "repo"), updated: 1, idle: 1 }));
  let reached = 0, release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  const publishHook = async () => { reached++; if (reached <= 2) await gate; };
  const a = bridgeFor(hostA, { instance: "a", publishHook });
  const b = bridgeFor(hostB, { instance: "b", publishHook });
  t.after(async () => { await a.bridge.close(); await b.bridge.close(); });
  const pendingA = a.bridge.tool({ instance: "a", name: "list_peers", sessionID: "ses_root", args: {} });
  const pendingB = b.bridge.tool({ instance: "b", name: "list_peers", sessionID: "ses_root", args: {} });
  await until(() => reached >= 2, "both binders paused before link");
  release();
  const [ra, rb] = await Promise.all([pendingA, pendingB]);
  assert.equal([ra.isError, rb.isError].filter(Boolean).length, 1, `${ra.text} / ${rb.text}`);
  assert.equal(records(f.dir).length, 1);
  assert.equal(sockets(f.dir).length, 1);
});

test("a forced interleaving replacing a dead record: one binder moves it aside, the other rereads the winner's live record and refuses without moving it", async (t) => {
  const f = opencodeFixture(t);
  const hostA = new FakeHost(), hostB = new FakeHost();
  // The two hosts give the root different directories, so the record's name says who won.
  hostA.add(session({ id: "ses_root", directory: join(f.dir, "repo-a"), updated: 1, idle: 1 }));
  hostB.add(session({ id: "ses_root", directory: join(f.dir, "repo-b"), updated: 1, idle: 1 }));
  for (const [host, id] of [[hostA, "ses_warm_a"], [hostB, "ses_warm_b"], [hostA, "ses_later"], [hostB, "ses_later"]]) {
    host.add(session({ id, directory: join(f.dir, id), updated: 1, idle: 1 }));
  }
  const held = gate(), hookLog = [];
  const publishHook = (bridge) => async ({ root, existing, attempt }) => {
    if (root.sessionID !== "ses_root") return;
    hookLog.push({ bridge, attempt, existingPid: existing?.pid });
    await held.wait();
  };
  const a = { ...bridgeFor(hostA, { instance: "a", publishHook: publishHook("a") }), instance: "a" };
  const b = { ...bridgeFor(hostB, { instance: "b", publishHook: publishHook("b") }), instance: "b" };
  t.after(async () => { await a.bridge.close(); await b.bridge.close(); });
  const list = (x, sessionID) => x.bridge.tool({ instance: x.instance, name: "list_peers", sessionID, args: {} });
  // Each bridge's first bind sweeps dead records; the dead record is written after both sweeps
  // so that both binders find it in place.
  assert.equal((await list(a, "ses_warm_a")).isError, false);
  assert.equal((await list(b, "ses_warm_b")).isError, false);
  writeFileSync(registry(f.dir, "ses_root"), deadRecord("ses_root", join(f.sockets, "opencode-old.sock")), { mode: 0o600 });
  const pendingA = list(a, "ses_root"), pendingB = list(b, "ses_root");
  await until(() => held.count >= 2, "both binders paused after reading the dead record");
  held.release();
  const [ra, rb] = await Promise.all([pendingA, pendingB]);
  // Both read the dead record on their first attempt.
  assert.deepEqual(hookLog.slice(0, 2).map((entry) => [entry.attempt, entry.existingPid]), [[0, 0x7ffffff0], [0, 0x7ffffff0]]);
  assert.equal([ra.isError, rb.isError].filter(Boolean).length, 1, `${ra.text} / ${rb.text}`);
  const [winnerResult, loser, loserResult] = ra.isError ? [rb, a, ra] : [ra, b, rb];
  // The second binder saw the inode change before moving anything, read the winner's live record
  // and refused; the winner's record never left its path, so its names were never freed.
  assert.equal(loserResult.structuredContent.reason, "inbox-unavailable");
  assert.match(loserResult.text, /already served by another opencode server/);
  assert.deepEqual(hookLog.map((entry) => entry.attempt), [0, 0, 1], "the loser read the record a second time");
  const record = JSON.parse(readFileSync(registry(f.dir, "ses_root"), "utf8"));
  assert.equal(record.name, winnerResult.structuredContent.self.name);
  assert.equal(record.address, winnerResult.structuredContent.self.address);
  assert.equal(lstatSync(socketPath(record.address)).isSocket(), true, "the winner's socket exists");
  assert.deepEqual(readdirSync(f.peers).filter((name) => name.startsWith(".opencode-")), [], "no aside or temporary record is left");
  for (const file of records(f.dir)) {
    const entry = JSON.parse(readFileSync(join(f.peers, file), "utf8"));
    assert.equal(lstatSync(socketPath(entry.address)).isSocket(), true, `${file} names a root with a socket`);
  }
  assert.equal(records(f.dir).length, 3);
  assert.equal(sockets(f.dir).length, 3);
  const later = await list(loser, "ses_later");
  assert.equal(later.isError, false, later.text);
});

test("the prompt event and the first tool call share one bind; a child's prompt binds nothing", async (t) => {
  const f = opencodeFixture(t);
  const host = new FakeHost({ latency: 20 });
  host.add(session({ id: "ses_root", directory: join(f.dir, "repo"), updated: 1, idle: 1 }));
  host.add(session({ id: "ses_child", parentID: "ses_root", directory: join(f.dir, "repo"), updated: 1, idle: 1 }));
  const { bridge } = bridgeFor(host);
  t.after(() => bridge.close());
  const [eventResult, toolResult] = await Promise.all([
    bridge.event({ instance: "i-1", type: "prompt", sessionID: "ses_root" }),
    bridge.tool({ instance: "i-1", name: "list_peers", sessionID: "ses_root", args: {} }),
  ]);
  assert.equal(eventResult, undefined);
  assert.equal(toolResult.isError, false, toolResult.text);
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
  // Root 0 is oldest, but busy. Root 1 is idle but holds a name. Root 2 is idle but has a
  // delivery acknowledged queued; eviction must not drop it.
  delete host.sessions.get(ids[0]).time.idle;
  const claimed = await bridge.tool({ instance: "i-1", name: "claim_name", sessionID: ids[1], args: { name: "proj/lead" } });
  assert.equal(claimed.structuredContent.status, "claimed");
  const queuedSelf = (await bridge.tool({ instance: "i-1", name: "list_peers", sessionID: ids[2], args: {} })).structuredContent.self;
  const queuedSender = await f.peer("cap-queued");
  const { post, peerSocket } = await import("../src/wire.mjs");
  host.hangSynthetic = true;
  await post(peerSocket(queuedSelf.address), peerLine(queuedSender.address, "do not evict", { receipts: ["queued"] }));
  await until(() => queuedSender.lines.some((line) => line.type === "control" && line.status === "queued"), "queued delivery before eviction");
  host.add(session({ id: "ses_064", directory: join(f.dir, "repo-64"), updated: 1, idle: 1 }));
  const added = await bridge.tool({ instance: "i-1", name: "list_peers", sessionID: "ses_064", args: {} });
  assert.equal(added.isError, false, added.text);
  assert.ok(existsSync(registry(f.dir, ids[0])), "the busy oldest root stays");
  assert.ok(existsSync(registry(f.dir, ids[1])), "the named root stays");
  assert.ok(existsSync(registry(f.dir, ids[2])), "a root with a queued delivery stays");
  assert.equal(existsSync(registry(f.dir, ids[3])), false, "the oldest evictable idle unnamed root is evicted");
  assert.equal(records(f.dir).length, 64);
  assert.match(added.text, /You are opencode:repo-64-/);
  // Every idle root now holds a name; the busy root is not evictable. The new bind is refused.
  for (const id of [...ids, "ses_064"]) {
    if (id === ids[0] || !existsSync(registry(f.dir, id))) continue;
    const result = await bridge.tool({ instance: "i-1", name: "claim_name", sessionID: id, args: { name: `proj/root-${id}` } });
    assert.equal(result.structuredContent.status === "claimed" || result.structuredContent.status === "refreshed", true, result.text);
  }
  host.add(session({ id: "ses_065", directory: join(f.dir, "repo-65"), updated: 1, idle: 1, }));
  const refused = await bridge.tool({ instance: "i-1", name: "list_peers", sessionID: "ses_065", args: {} });
  assert.equal(refused.isError, true);
  assert.equal(refused.structuredContent.reason, "inbox-unavailable");
  assert.match(refused.text, /none is idle without claimed names/);
  assert.equal(existsSync(registry(f.dir, "ses_065")), false);
  assert.equal(records(f.dir).length, 64);
});

// A bridge serving 64 idle roots, bound in order, so ses_000 has the oldest lastActivity.
async function capped(t, f) {
  const host = new FakeHost();
  const ids = Array.from({ length: 64 }, (_, i) => `ses_${String(i).padStart(3, "0")}`);
  for (const [i, id] of [...ids, "ses_064", "ses_065"].entries()) host.add(session({ id, directory: join(f.dir, `repo-${i}`), updated: 1, idle: 1 }));
  const { bridge, logs } = bridgeFor(host);
  t.after(() => bridge.close());
  for (const id of ids) {
    const result = await bridge.tool({ instance: "i-1", name: "list_peers", sessionID: id, args: {} });
    assert.equal(result.isError, false, `${id}: ${result.text}`);
  }
  const list = (sessionID) => bridge.tool({ instance: "i-1", name: "list_peers", sessionID, args: {} });
  const reads = (from) => host.calls.slice(from).filter((call) => call.method === "host.session").map((call) => call.params.sessionID);
  const evicted = () => logs.filter((entry) => entry.event === "opencode.bind.cap" && entry.fields.outcome === "evicted").length;
  return { host, bridge, ids, list, reads, evicted };
}

test("at the cap, eviction reads the host only until the first evictable root", { timeout: 60_000 }, async (t) => {
  const f = opencodeFixture(t);
  const { host, bridge, ids, list, reads } = await capped(t, f);
  // ses_000 is busy, ses_001 holds a name (skipped without a read), ses_002 is idle.
  delete host.sessions.get(ids[0]).time.idle;
  const claimed = await bridge.tool({ instance: "i-1", name: "claim_name", sessionID: ids[1], args: { name: "proj/lead" } });
  assert.equal(claimed.structuredContent.status, "claimed");
  const mark = host.calls.length;
  const added = await list("ses_064");
  assert.equal(added.isError, false, added.text);
  assert.deepEqual(reads(mark), ["ses_064", ids[0], ids[2]], "one read for the new root, then one per candidate up to the first evicted");
  assert.ok(existsSync(registry(f.dir, ids[0])));
  assert.ok(existsSync(registry(f.dir, ids[1])));
  assert.equal(existsSync(registry(f.dir, ids[2])), false);
  assert.ok(existsSync(registry(f.dir, ids[3])));
  assert.equal(records(f.dir).length, 64);
});

test("a root idle when a cap bind selected it, but busy by its fresh read, is not evicted", { timeout: 60_000 }, async (t) => {
  const f = opencodeFixture(t);
  const { host, ids, list, reads, evicted } = await capped(t, f);
  // The first cap bind's read of ses_000 is held inside ses_000's bind task.
  const held = gate();
  host.beforeSession = async (id) => { if (id === ids[0] && !held.count) await held.wait(); };
  const first = list("ses_064");
  await until(() => held.count === 1, "the first cap bind reading ses_000");
  // The second cap bind selects ses_000 while it is still idle and queues on its bind task.
  const mark = host.calls.length;
  const second = list("ses_065");
  await until(() => reads(mark).includes("ses_065"), "the second cap bind's own read");
  await delay(20);
  assert.deepEqual(reads(mark), ["ses_065"], "the second bind has not read ses_000 before waiting for its bind task");
  // ses_000 turns busy before either eviction read is answered.
  delete host.sessions.get(ids[0]).time.idle;
  held.release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.isError, false, a.text);
  assert.equal(b.isError, false, b.text);
  assert.ok(existsSync(registry(f.dir, ids[0])), "the root that turned busy stays bound");
  assert.equal(existsSync(registry(f.dir, ids[1])), false);
  assert.equal(existsSync(registry(f.dir, ids[2])), false);
  assert.ok(existsSync(registry(f.dir, ids[3])));
  assert.equal(reads(mark).filter((id) => id === ids[0]).length, 1, "the second bind read ses_000 fresh, after the first bind's read");
  assert.equal(evicted(), 2);
  assert.equal(records(f.dir).length, 64);
});

test("two concurrent new binds at the cap with two idle candidates both succeed, each evicting one", { timeout: 60_000 }, async (t) => {
  const f = opencodeFixture(t);
  const { host, ids, list, evicted } = await capped(t, f);
  for (const id of ids.slice(2)) delete host.sessions.get(id).time.idle;
  const [a, b] = await Promise.all([list("ses_064"), list("ses_065")]);
  assert.equal(a.isError, false, a.text);
  assert.equal(b.isError, false, b.text);
  assert.equal(existsSync(registry(f.dir, ids[0])), false);
  assert.equal(existsSync(registry(f.dir, ids[1])), false);
  for (const id of [...ids.slice(2), "ses_064", "ses_065"]) assert.ok(existsSync(registry(f.dir, id)), id);
  assert.equal(evicted(), 2);
  assert.equal(records(f.dir).length, 64);
  assert.equal(sockets(f.dir).length, 64);
});

test("a seat freed by a delete during the eviction reads is taken, not refused", { timeout: 60_000 }, async (t) => {
  const f = opencodeFixture(t);
  const { host, bridge, ids, list, evicted } = await capped(t, f);
  for (const id of ids) delete host.sessions.get(id).time.idle;
  const held = gate();
  host.beforeSession = async (id) => { if (id === ids[0] && held.count === 0) await held.wait(); };
  const pending = list("ses_064");
  await until(() => held.count === 1, "the eviction read of ses_000");
  await bridge.event({ instance: "i-1", type: "deleted", sessionID: ids[10] });
  held.release();
  const result = await pending;
  assert.equal(result.isError, false, result.text);
  assert.equal(evicted(), 0);
  assert.equal(records(f.dir).length, 64);
});

test("a delete queued ahead of an eviction frees the seat, so no second idle root is evicted", { timeout: 60_000 }, async (t) => {
  const f = opencodeFixture(t);
  const { host, bridge, ids, list, evicted } = await capped(t, f);
  for (const id of ids) delete host.sessions.get(id).time.idle;
  host.sessions.get(ids[1]).time.idle = 1;
  host.sessions.get(ids[2]).time.idle = 1;
  const held = gate();
  host.beforeSession = async (id) => { if (id === ids[0] && held.count === 0) await held.wait(); };
  const a = list("ses_064");
  await until(() => held.count === 1, "A's eviction read of ses_000");
  const deleted = bridge.event({ instance: "i-1", type: "deleted", sessionID: ids[0] });
  const b = list("ses_065");
  await delay(50);
  held.release();
  const [ra, rb] = await Promise.all([a, b]);
  await deleted;
  assert.equal(ra.isError, false, ra.text);
  assert.equal(rb.isError, false, rb.text);
  // The delete freed one seat and one idle root was evicted for the other bind; never two.
  assert.equal(evicted(), 1);
  assert.equal(records(f.dir).length, 64);
});

test("a root deleted while its own bind is evicting gives up its bind without costing a seat", { timeout: 60_000 }, async (t) => {
  const f = opencodeFixture(t);
  const { host, bridge, ids, list, evicted } = await capped(t, f);
  for (const id of ids.slice(1)) delete host.sessions.get(id).time.idle;
  const held = gate();
  host.beforeSession = async (id) => { if (id === ids[0] && held.count === 0) await held.wait(); };
  const pending = list("ses_064");
  await until(() => held.count === 1, "the eviction read of ses_000");
  await bridge.event({ instance: "i-1", type: "deleted", sessionID: "ses_064" });
  held.release();
  const result = await pending;
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.reason, "no-session", result.text);
  assert.equal(existsSync(registry(f.dir, "ses_064")), false);
  assert.equal(evicted(), 0);
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
  assert.equal(info.wakes, 1, "synthetic wakes a busy session; the runner steers it");
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
  assert.equal(info.wakes, 1);
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
  assert.deepEqual(missing.structuredContent.recentlyExited, []);
  assert.equal(missing.structuredContent.namesNotRunning, 0);
  assert.ok(missing.structuredContent.now);
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
  const compact = await call("list_peers", {});
  assert.match(compact.text, /\+1 reserved names not running/);
  assert.doesNotMatch(compact.text, /opencode:proj\/dead/);
  const expanded = await call("list_peers", { all_names: true });
  assert.match(expanded.text, /opencode:proj\/dead  not running/);
  assert.deepEqual(compact.structuredContent.names, expanded.structuredContent.names.filter((row) => row.running));
  assert.equal(compact.structuredContent.namesNotRunning, 1);
  assert.equal(expanded.structuredContent.names.find((row) => row.name === "opencode:proj/dead").running, false);
  assert.equal((await call("list_peers", { all_names: "true" })).structuredContent.reason, "invalid-request");
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

test("a delete during a tool call's session read unbinds the root, and nothing rebinds or publishes it afterwards", async (t) => {
  const f = opencodeFixture(t);
  const host = new FakeHost();
  host.add(session({ id: "ses_root", directory: join(f.dir, "repo"), updated: 1, idle: 1 }));
  host.add(session({ id: "ses_child", parentID: "ses_root", directory: join(f.dir, "repo"), updated: 1, idle: 1 }));
  const { bridge, logs } = bridgeFor(host);
  t.after(() => bridge.close());
  const call = (sessionID) => bridge.tool({ instance: "i-1", name: "list_peers", sessionID, args: {} });
  assert.equal((await call("ses_root")).isError, false);
  assert.ok(existsSync(registry(f.dir, "ses_root")));
  // A root call and a child call both read ses_root; both reads are held until after the delete,
  // and then answer with the session as it was before it was deleted.
  const held = gate();
  host.beforeSession = async (id) => { if (id === "ses_root") await held.wait(); };
  const pendingRoot = call("ses_root"), pendingChild = call("ses_child");
  await until(() => held.count === 2, "both reads of ses_root in flight");
  await bridge.event({ instance: "i-1", type: "deleted", sessionID: "ses_root" });
  assert.equal(existsSync(registry(f.dir, "ses_root")), false);
  assert.equal(sockets(f.dir).length, 0);
  host.beforeSession = undefined;
  held.release();
  for (const result of await Promise.all([pendingRoot, pendingChild])) {
    assert.equal(result.isError, true, result.text);
    assert.equal(result.structuredContent.reason, "no-session");
  }
  // The host still answers for the session here, so only the bridge's deleted set refuses it.
  await bridge.event({ instance: "i-1", type: "prompt", sessionID: "ses_root" });
  for (const id of ["ses_root", "ses_child"]) assert.equal((await call(id)).structuredContent.reason, "no-session");
  await delay(50);
  assert.equal(records(f.dir).length, 0);
  assert.equal(sockets(f.dir).length, 0);
  assert.equal(logs.filter((entry) => entry.event === "inbox.bound").length, 1, "only the first bind published");
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

test("a registry write failure is inbox-unavailable, not invalid-request", async (t) => {
  const f = opencodeFixture(t);
  chmodSync(f.peers, 0o500);
  t.after(() => { try { chmodSync(f.peers, 0o700); } catch {} });
  const host = new FakeHost();
  host.add(session({ id: "ses_root", directory: join(f.dir, "repo"), updated: 1, idle: 1 }));
  const { bridge } = bridgeFor(host);
  t.after(() => bridge.close());
  const result = await bridge.tool({ instance: "i-1", name: "list_peers", sessionID: "ses_root", args: {} });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.reason, "inbox-unavailable");
});

test("a bridge reclaims its own pid/START record left by a failed publish instead of locking itself out", async (t) => {
  const f = opencodeFixture(t);
  const start = processStart(process.pid);
  writeFileSync(registry(f.dir, "ses_root"), JSON.stringify({
    name: "opencode:old-aaaaaa", address: address(join(f.sockets, "opencode-retired.sock")),
    addresses: [address(join(f.sockets, "opencode-retired.sock"))], cwd: join(f.dir, "old"), threadId: "ses_root",
    pid: process.pid, procStart: start, token: "retired", generation: generation("opencode", "ses_root", start), startedAt: 1,
  }), { mode: 0o600 });
  const host = new FakeHost();
  host.add(session({ id: "ses_root", directory: join(f.dir, "repo"), updated: 1, idle: 1 }));
  const { bridge } = bridgeFor(host);
  t.after(() => bridge.close());
  const result = await bridge.tool({ instance: "i-1", name: "list_peers", sessionID: "ses_root", args: {} });
  assert.equal(result.isError, false, result.text);
  const record = JSON.parse(readFileSync(registry(f.dir, "ses_root"), "utf8"));
  assert.notEqual(record.token, "retired");
  assert.equal(sockets(f.dir).length, 1);
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

test("replacing a dead record removes its old socket in another socket directory only when a connect is refused", async (t) => {
  const f = opencodeFixture(t);
  // A Claude record that once named s2 makes it a permitted socket directory; new inboxes stay in s.
  const other = join(f.dir, "s2");
  mkdirSync(other, { mode: 0o700 });
  const sessionFile = join(f.claude, "sessions", `${process.pid}.json`), original = readFileSync(sessionFile, "utf8");
  writeFileSync(sessionFile, JSON.stringify({ ...JSON.parse(original), messagingSocketPath: join(other, "fixture.sock") }));
  assert.ok(socketDirectories().includes(other));
  writeFileSync(sessionFile, original);
  const host = new FakeHost();
  for (const id of ["ses_warm", "ses_dead", "ses_live"]) host.add(session({ id, directory: join(f.dir, id), updated: 1, idle: 1 }));
  const { bridge } = bridgeFor(host);
  t.after(() => bridge.close());
  const call = (sessionID) => bridge.tool({ instance: "i-1", name: "list_peers", sessionID, args: {} });
  // The first bind's sweep runs before the dead records exist.
  assert.equal((await call("ses_warm")).isError, false);
  const deadSocket = join(other, socketName("ses_dead")), liveSocket = join(other, socketName("ses_live"));
  await orphanSocket(deadSocket);
  const listener = createServer((conn) => conn.destroy());
  await listen(listener, liveSocket, t);
  writeFileSync(registry(f.dir, "ses_dead"), deadRecord("ses_dead", deadSocket), { mode: 0o600 });
  writeFileSync(registry(f.dir, "ses_live"), deadRecord("ses_live", liveSocket), { mode: 0o600 });
  assert.equal((await call("ses_dead")).isError, false);
  assert.equal(existsSync(deadSocket), false, "a refused old socket is removed");
  assert.ok(existsSync(join(f.sockets, socketName("ses_dead"))), "the new inbox is in the current socket directory");
  assert.equal((await call("ses_live")).isError, false);
  assert.equal(lstatSync(liveSocket).isSocket(), true, "a socket that still accepts is never removed");
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

test("server-wide events: a prompt binds only through the session's own location and never moves a root another instance serves", async (t) => {
  const f = opencodeFixture(t);
  const host = new FakeHost();
  host.add(session({ id: "ses_a", directory: join(f.dir, "a"), updated: 1, idle: 1 }));
  host.add(session({ id: "ses_b", directory: join(f.dir, "b"), updated: 1, idle: 1 }));
  const { bridge, logs } = bridgeFor(host, { instance: "i-a", location: { directory: join(f.dir, "a") } });
  t.after(() => bridge.close());
  bridge.hello({ instance: "i-b", location: { directory: join(f.dir, "b") } });
  // opencode gives every location's instance every event; the other location's copy comes first.
  await bridge.event({ instance: "i-b", type: "prompt", sessionID: "ses_a" });
  assert.equal(existsSync(registry(f.dir, "ses_a")), false, "another location's prompt does not bind");
  await bridge.event({ instance: "i-a", type: "prompt", sessionID: "ses_a" });
  const token = JSON.parse(readFileSync(registry(f.dir, "ses_a"), "utf8")).token;
  for (const instance of ["i-b", "i-a", "i-b"]) await bridge.event({ instance, type: "prompt", sessionID: "ses_a" });
  assert.equal(JSON.parse(readFileSync(registry(f.dir, "ses_a"), "utf8")).token, token, "the bind is never replaced");
  assert.equal(logs.filter((entry) => entry.event === "inbox.bound").length, 1);
  // The other instance closing (a reload or an idle location) keeps a root it never served.
  await bridge.event({ instance: "i-b", type: "closed" });
  assert.equal(JSON.parse(readFileSync(registry(f.dir, "ses_a"), "utf8")).token, token);
});

test("a lookup in flight across a move or a close never undoes the move or binds for the closed instance", async (t) => {
  const f = opencodeFixture(t);
  const host = new FakeHost();
  host.add(session({ id: "ses_root", directory: join(f.dir, "one"), updated: 1, idle: 1 }));
  host.add(session({ id: "ses_other", directory: join(f.dir, "one"), updated: 1, idle: 1 }));
  const { bridge } = bridgeFor(host, { instance: "i-1" });
  t.after(() => bridge.close());
  bridge.hello({ instance: "i-2", location: {} });
  const call = (instance, sessionID) => bridge.tool({ instance, name: "list_peers", sessionID, args: {} });
  assert.equal((await call("i-1", "ses_root")).isError, false);
  // i-1's next lookup is held; the session moves away from i-1 and i-2 binds it.
  const held = gate();
  host.beforeSession = async (id) => { if (id === "ses_root" && held.count === 0) await held.wait(); };
  const stale = call("i-1", "ses_root");
  await until(() => held.count === 1, "i-1's read in flight");
  await bridge.event({ instance: "i-1", type: "moved", sessionID: "ses_root" });
  const moved = await call("i-2", "ses_root");
  assert.equal(moved.isError, false, moved.text);
  const record = JSON.parse(readFileSync(registry(f.dir, "ses_root"), "utf8"));
  held.release();
  const late = await stale;
  assert.equal(late.isError, true);
  assert.equal(late.structuredContent.reason, "inbox-unavailable");
  assert.deepEqual(JSON.parse(readFileSync(registry(f.dir, "ses_root"), "utf8")), record, "i-2 still serves the session");
  // A fresh call from i-1 after the move may move it back: that one is current.
  assert.equal((await call("i-1", "ses_root")).isError, false);
  // A lookup held across its instance's close publishes nothing.
  const closing = gate();
  host.beforeSession = async (id) => { if (id === "ses_other") await closing.wait(); };
  const orphan = call("i-1", "ses_other");
  await until(() => closing.count === 1, "the ses_other read in flight");
  await bridge.event({ instance: "i-1", type: "closed" });
  closing.release();
  const result = await orphan;
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.reason, "no-session");
  assert.equal(existsSync(registry(f.dir, "ses_other")), false);
  assert.equal(existsSync(registry(f.dir, "ses_root")), false, "close unbound i-1's roots");
});

test("a delete while the root's record is being published refuses the claim that waited on the bind", async (t) => {
  const f = opencodeFixture(t);
  const host = new FakeHost();
  host.add(session({ id: "ses_root", directory: join(f.dir, "repo"), updated: 1, idle: 1 }));
  const held = gate();
  const { bridge } = bridgeFor(host, { publishHook: async () => held.wait() });
  t.after(() => bridge.close());
  const pending = bridge.tool({ instance: "i-1", name: "claim_name", sessionID: "ses_root", args: { name: "opencode:team/lead" } });
  await until(() => held.count === 1, "the publish in flight");
  const deleting = bridge.event({ instance: "i-1", type: "deleted", sessionID: "ses_root" });
  held.release();
  const result = await pending;
  await deleting;
  assert.equal(result.isError, true, result.text);
  assert.equal(result.structuredContent.reason, "no-session");
  assert.deepEqual(claimRows().filter((row) => row.name === "opencode:team/lead"), []);
  assert.equal(existsSync(registry(f.dir, "ses_root")), false);
  assert.equal(sockets(f.dir).length, 0);
});

test("a move during the delivery's session read drops the message inbox-closed instead of handing it to the old instance", async (t) => {
  const f = opencodeFixture(t);
  const { host, bridge } = await bound(t, f);
  const sender = await f.peer("move-sender");
  const self = (await bridge.tool({ instance: "i-1", name: "list_peers", sessionID: "ses_root", args: {} })).structuredContent.self;
  const held = gate();
  host.beforeSession = async () => held.wait();
  const { post, peerSocket } = await import("../src/wire.mjs");
  await post(peerSocket(self.address), peerLine(sender.address, "moving", { receipts: ["queued", "accepted"] }));
  await until(() => held.count === 1, "the delivery's read in flight");
  await bridge.event({ instance: "i-1", type: "moved", sessionID: "ses_root" });
  held.release();
  await until(() => sender.lines.some((l) => l.type === "control" && l.status === "dropped"), "the inbox-closed drop");
  assert.equal(sender.lines.find((l) => l.status === "dropped").drop_reason, "inbox-closed");
  assert.equal(host.calls.some((c) => c.method === "host.synthetic"), false, "nothing reached the old instance");
});

test("send_peer refuses a Claude peer in another socket directory, which could never reply to this inbox", async (t) => {
  const f = opencodeFixture(t);
  const { bridge } = await bound(t, f);
  const other = join(f.dir, "s2");
  mkdirSync(other, { mode: 0o700 });
  const socket = join(other, "elsewhere.sock");
  const server = createServer(() => {});
  t.after(() => server.close());
  await listen(server, socket);
  const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
  f.children.push(sleeper);
  await until(() => processStart(sleeper.pid), "the second Claude process");
  writeFileSync(join(f.claude, "sessions", `${sleeper.pid}.json`), JSON.stringify({
    pid: sleeper.pid, name: "elsewhere", messagingSocketPath: socket, procStart: processStart(sleeper.pid),
  }));
  const result = await bridge.tool({ instance: "i-1", name: "send_peer", sessionID: "ses_root", args: { to: address(socket), message: "hi" } });
  assert.equal(result.isError, true, result.text);
  assert.equal(result.structuredContent.status, "failed");
  assert.equal(result.structuredContent.reason, "inbox-unavailable");
  assert.match(result.text, /Claude replies only within its own socket directory; nothing was sent/);
});
