import assert from "node:assert/strict";
import { test } from "node:test";
import { codexDiscovery, formatCodexPeer, formatSessionPeer } from "../src/discovery.mjs";

const self = { threadId: "root-a", rootId: "root-a", address: "uds:/tmp/root-a.sock" };
const peer = (id) => ({ kind: "codex", name: `codex:${id}`, threadId: id, address: `uds:/tmp/${id}.sock`, cwd: "/work" });
const root = (id) => ({ id, sessionId: id, cwd: "/work", status: { type: "active" } });
const child = (id, sessionId, path) => ({
  id, sessionId, cwd: "/work", status: { type: "idle" },
  source: { subAgent: { thread_spawn: { agent_path: path } } },
});
const claude = { kind: "claude", name: "claude:one", address: "uds:/tmp/claude.sock", cwd: "/work" };

test("a loaded external root is bridge-only, even on the same daemon and cwd", () => {
  const rows = codexDiscovery([peer("root-a"), peer("root-b"), claude], [root("root-a"), root("root-b")], self);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].native.reachable, false);
  assert.equal(rows[0].native.reason, "separate Codex session");
  assert.deepEqual(rows[0].bridge, { tool: "send_peer", to: "uds:/tmp/root-b.sock" });
  assert.equal(rows[1].native.reachable, false);
  assert.equal(rows[1].native.reason, "Claude recipient");
});

test("native agents are discoverable without ever registering a bridge inbox", () => {
  const rows = codexDiscovery([], [root("root-a"), child("worker", "root-a", "/root/worker")], self);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].native, { reachable: true, tool: "send_message", target: "/root/worker" });
  assert.equal(rows[0].status, "idle");
  assert.equal(rows[0].bridge, null);
});

test("an identically named agent in another tree is not advertised as reachable", () => {
  const rows = codexDiscovery([], [child("mine", "root-a", "/root/worker"), child("other", "root-b", "/root/worker")], self);
  assert.deepEqual(rows.map((p) => p.threadId), ["mine"]);
});

test("a subagent can discover its root, siblings and nested relatives, excluding itself", () => {
  const threads = [root("root-a"), child("caller", "root-a", "/root/caller"),
    child("sibling", "root-a", "/root/sibling"), child("nested", "root-a", "/root/sibling/nested")];
  const rows = codexDiscovery([peer("root-a")], threads, { ...self, threadId: "caller", address: undefined });
  assert.deepEqual(rows.map((p) => p.native.target), ["/root", "/root/sibling", "/root/sibling/nested"]);
  assert.equal(rows[0].bridge, null);
  assert.equal(rows.filter((p) => p.threadId === "root-a").length, 1);
});

test("failed binding keeps all inboxes but reports unknown native reachability", () => {
  const rows = codexDiscovery([peer("root-a"), claude], [root("root-a")], undefined);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((p) => p.native.reachable === null && p.bridge.to));
});

test("missing native metadata does not turn a same-tree root into an external session", () => {
  const rows = codexDiscovery([peer("root-a")], [], { ...self, threadId: "caller", address: undefined });
  assert.equal(rows[0].native.reachable, null);
  assert.equal(rows[0].bridge, null);
});

test("unloaded or unidentified agents are not advertised as native targets", () => {
  const threads = [
    { ...child("unloaded", "root-a", "/root/old"), status: { type: "notLoaded" } },
    child("no-path", "root-a", undefined),
    { ...child("no-session", "root-a", "/root/unknown"), sessionId: undefined },
  ];
  assert.deepEqual(codexDiscovery([], threads, self), []);
});

test("display provides usable arguments and labels Claude's native tool by platform", () => {
  const rows = codexDiscovery([peer("root-b")], [child("worker", "root-a", "/root/worker")], self);
  assert.match(formatCodexPeer(rows[0]), /native: no \(separate Codex session\)/);
  assert.match(formatCodexPeer(rows[0]), /bridge: send_peer \{"to":"uds:\/tmp\/root-b.sock"\}/);
  assert.match(formatCodexPeer(rows[1]), /native: yes — send_message \{"target":"\/root\/worker"\}/);
  assert.match(formatSessionPeer(claude), /Claude native: SendMessage \{"to":"uds:\/tmp\/claude.sock"\}/);
  assert.match(formatSessionPeer(claude), /Codex bridge: send_peer/);
});
