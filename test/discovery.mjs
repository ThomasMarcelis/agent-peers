import assert from "node:assert/strict";
import { test } from "node:test";
import { codexDiscovery, formatCodexPeer, formatExited, formatNames, formatPeerStatus, formatSessionPeer, modelListing, nativeRouteError } from "../src/discovery.mjs";

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

test("session rows keep the rc.4 text for Claude and Codex, and opencode rows have single gaps", () => {
  const codex = { name: "codex:foo", cwd: "/x", address: "uds:/tmp/foo.sock" };
  assert.equal(formatSessionPeer(codex),
    'codex:foo    cwd=/x\n' +
    '  Claude native: SendMessage {"to":"uds:/tmp/foo.sock"}\n' +
    '  Codex bridge: send_peer {"to":"uds:/tmp/foo.sock"}');
  assert.equal(formatSessionPeer({ ...codex, status: "idle" }).split("\n")[0], "codex:foo  idle  cwd=/x");
  assert.equal(formatSessionPeer({ ...codex, reachable: false }).split("\n")[0], "codex:foo    stale  cwd=/x");
  const opencode = { kind: "opencode", name: "opencode:bar", cwd: "/y", address: "uds:/tmp/bar.sock" };
  assert.equal(formatSessionPeer(opencode),
    'opencode:bar  cwd=/y\n' +
    '  OpenCode bridge: send_peer {"to":"uds:/tmp/bar.sock"}');
  assert.equal(formatSessionPeer({ ...opencode, status: "busy", reachable: false }).split("\n")[0],
    "opencode:bar  busy  stale  cwd=/y");
});

test("native-only route errors explain the exact native target and idle wake route", () => {
  const threads = [{ ...child("zeno-thread", "root-a", "/root/accepted_content"), agentNickname: "Zeno" }];
  const rows = codexDiscovery([], threads, self);
  for (const to of ["codex:Zeno", "Zeno", "/root/accepted_content", "zeno-thread"]) {
    const error = nativeRouteError(to, rows);
    assert.match(error, /native Codex subagent without a bridge route; send_peer cannot address it/);
    assert.match(error, /send_message \{"target":"\/root\/accepted_content"\}/);
    assert.match(error, /followup_task \{"target":"\/root\/accepted_content"\}/);
    assert.match(error, /codex_tui\.send_message_to_thread, is unsupported for subagents/);
  }
  assert.equal(nativeRouteError("Zen", rows), null, "exact names only, never a fragment");
  const display = formatCodexPeer(rows[0]);
  assert.match(display, /send_peer and direct app-server input cannot target this subagent/);
  assert.match(display, /start idle turn: followup_task \{"target":"\/root\/accepted_content"\}/);
});

test("native route errors do not guess unknown, ambiguous, or bridge-capable targets", () => {
  const rows = codexDiscovery([peer("Zeno-other")], [
    { ...child("zeno-thread", "root-a", "/root/accepted_content"), agentNickname: "Zeno" },
    { ...child("zenobia-thread", "root-a", "/root/other"), agentNickname: "Zenobia" },
  ], self);
  for (const to of ["missing", "", "Zen", "codex:Zeno-other", "uds:/tmp/Zeno-other.sock"]) {
    assert.equal(nativeRouteError(to, rows), null);
  }
  assert.match(nativeRouteError("Zeno", rows), /"codex:Zeno" is a native/);
  assert.equal(nativeRouteError("root-a", codexDiscovery([peer("root-a")], [], {
    ...self, threadId: "caller", address: undefined,
  })), null);
  const duplicates = [rows[1], { ...rows[2], name: rows[1].name }];
  assert.equal(nativeRouteError("Zeno", duplicates), null);
});

test("only idle non-root agents advertise followup_task", () => {
  const rows = codexDiscovery([peer("root-a")], [
    { ...root("root-a"), status: { type: "idle" } },
    { ...child("busy", "root-a", "/root/busy"), status: { type: "active" } },
  ], { ...self, threadId: "caller", address: undefined });
  for (const row of rows) {
    assert.doesNotMatch(formatCodexPeer(row), /followup_task/);
    assert.doesNotMatch(nativeRouteError(row.name, rows), /followup_task/);
  }
  assert.match(nativeRouteError("/root", rows), /does not start an idle turn for the root agent/);
  assert.doesNotMatch(nativeRouteError("/root", rows), /unsupported for subagents/);
});

test("list rows compactly show proven status, observation age and the last failed turn", () => {
  const now = Date.parse("2026-10-21T14:14:00Z");
  const p = { ...peer("worker"), status: "idle", statusObservedAt: now - 5000, statusSource: "thread/status/changed",
    lastActivity: { turnId: "turn", at: now - 12 * 60_000, observedAt: now - 12 * 60_000,
      source: "thread/turns/list", event: "completed", timeSource: "runtime" },
    lastTurn: { id: "turn", status: "failed", completedAt: now - 12 * 60_000, observedAt: now - 12 * 60_000,
      source: "thread/turns/list", errorClass: "http_409" } };
  assert.equal(formatPeerStatus(p, now), "idle 12m · last turn failed (http_409)");
  assert.match(formatSessionPeer(p), /idle .* · last turn failed.*\(http_409\)/);
  const [row] = codexDiscovery([p], [], self);
  assert.deepEqual(row.lastTurn, p.lastTurn);
  assert.match(formatCodexPeer(row), /idle .* · last turn failed.*\(http_409\)/);
  assert.equal(formatPeerStatus({ ...p, lastTurn: { ...p.lastTurn, completedAt: now - 14 * 60_000 } }, now),
    "idle 12m · last turn failed 14m ago (http_409)");
  assert.equal(formatPeerStatus({ ...p, lastTurn: { ...p.lastTurn, status: "completed", errorClass: undefined } }, now),
    "idle 12m · last turn completed");
  assert.equal(formatPeerStatus({ ...p, turnOutcome: { status: "unknown", source: "thread/turns/list", observedAt: now } }, now),
    "idle · last turn failed 12m ago (http_409) · turn outcome unknown (thread/turns/list)");
  assert.equal(formatPeerStatus({ ...p, status: "active" }, now).split(" · ")[0], "busy");
  assert.equal(formatPeerStatus(peer("legacy"), now), "");
  assert.match(formatExited([{ ...p, lastSeenAt: now - 12 * 60_000 }], now).join("\n"), /last seen 12m ago · last turn failed 12m ago/);
});

test("state duration needs the matching activity event; waiting and stale observations stay explicit", () => {
  const now = Date.now(), base = { ...peer("worker"), status: "active", statusObservedAt: now - 5000, statusSource: "thread/read",
    lastActivity: { turnId: "t", at: now - 40 * 60_000, observedAt: now - 40 * 60_000,
      source: "thread/turns/list", event: "started", timeSource: "runtime" } };
  assert.equal(formatPeerStatus(base, now), "busy 40m");
  assert.equal(formatPeerStatus({ ...base, lastActivity: { ...base.lastActivity, timeSource: "observed" } }, now), "busy ≥40m");
  assert.equal(formatPeerStatus({ ...base, activeFlags: ["waitingOnUserInput"] }, now), "waiting on input");
  assert.equal(formatPeerStatus({ ...base, activeFlags: ["waitingOnApproval"] }, now), "waiting on approval");
  assert.equal(formatPeerStatus({ ...base, statusObservedAt: now - 60_000 }, now), "busy 40m (seen 1m ago)");
  assert.equal(formatPeerStatus({ ...base, lastActivity: { ...base.lastActivity, event: "completed" } }, now), "busy");
  const old = { id: "old", status: "failed", completedAt: now - 2 * 86400_000, observedAt: now,
    source: "thread/turns/list", errorClass: "http_409" };
  assert.match(formatPeerStatus({ ...base, lastTurn: old }, now), /last turn failed 2d ago \(\d{4}-\d{2}-\d{2}\) \(http_409\)/);
  assert.match(formatPeerStatus({ ...base, lastTurn: { ...old, completedAt: undefined } }, now), /failed observed 0s ago/);
});

test("newer live status wins in both discovery passes, with registry history retained", () => {
  const p = { ...peer("root-b"), status: "active", activeFlags: ["waitingOnUserInput"], statusObservedAt: 1000,
    statusSource: "thread/read", lastTurn: { id: "t", status: "failed", completedAt: 500, observedAt: 900, source: "turn/completed" } };
  const t = { ...root("root-b"), status: { type: "idle" }, statusObservedAt: 2000 };
  for (const caller of [self, { threadId: "child", rootId: "root-b" }]) {
    const [fresh] = codexDiscovery([p], [t], caller);
    assert.equal(fresh.status, "idle");
    assert.equal(fresh.statusObservedAt, 2000);
    assert.equal(fresh.activeFlags, undefined);
    assert.equal(fresh.lastTurn.status, "failed");
    const [cached] = codexDiscovery([{ ...p, statusObservedAt: 3000 }], [t], caller);
    assert.equal(cached.status, "active");
    assert.deepEqual(cached.activeFlags, ["waitingOnUserInput"]);
  }
});

test("model listings retain actionable facts and filter names without changing full source rows", () => {
  const now = Date.now(), p = { ...peer("worker"), status: "active", activeFlags: ["waitingOnApproval"],
    statusObservedAt: now, statusSource: "thread/read", lastActivity: { turnId: "current", at: now - 1000, observedAt: now, timeSource: "runtime", event: "started", source: "turn/started" },
    lastTurn: { id: "t", status: "failed", completedAt: now - 5000, observedAt: now, source: "thread/turns/list", errorClass: "server_overloaded" } };
  const source = { peers: [p], names: [{ name: "codex:p/live", running: true, claimedAt: now }, { name: "codex:p/reserved", running: false }] };
  const result = modelListing(source, { now });
  assert.equal(Object.hasOwn(result, "now"), false);
  assert.equal(result.namesNotRunning, 1);
  assert.deepEqual(result.names, [{ name: "codex:p/live", running: true }]);
  assert.deepEqual(result.peers[0].activeFlags, ["waitingOnApproval"]);
  assert.equal(result.peers[0].statusText, formatPeerStatus(p, now));
  assert.equal(result.peers[0].statusText, "waiting on approval · last turn failed 5s ago (server_overloaded)");
  assert.deepEqual(result.peers[0].lastTurn, { status: "failed", errorClass: "server_overloaded" });
  assert.doesNotMatch(JSON.stringify(result), /statusObservedAt|statusSource|lastActivity|activityAt|activityEvent|observedAt|completedAt|claimedAt/);
  assert.equal(modelListing(source, { allNames: true }).names.length, 2);
  assert.equal(source.peers[0].lastTurn.id, "t");
  assert.equal(source.names.length, 2);
  const observed = modelListing({ peers: [{ ...p, lastActivity: { ...p.lastActivity, timeSource: "observed" } }] }, { now });
  assert.equal(observed.peers[0].statusText, result.peers[0].statusText, "waiting never guesses a duration from turn start");
  assert.equal(modelListing({ peers: [{ ...p, activeFlags: [], lastActivity: { ...p.lastActivity, timeSource: "observed" } }] }, { now }).peers[0].statusText,
    "busy ≥1s · last turn failed 5s ago (server_overloaded)");
  const legacy = modelListing({ peers: [{ name: "old", status: null, activeFlags: [], lastTurn: null, turnOutcome: null }] });
  assert.deepEqual(legacy.peers, [{ name: "old" }]);
  const recent = modelListing({ recentlyExited: [{ ...p, lastSeenAt: now - 60_000, exitObservedAt: now, exitBasis: "pid-gone-or-reused" }] }, { now }).recentlyExited[0];
  assert.equal(recent.statusText, "last seen 1m ago · last turn failed 5s ago (server_overloaded)");
  assert.doesNotMatch(JSON.stringify(recent), /At|Source|exitBasis/);
});

test("names text hides only non-running holders, with an explicit all_names escape hatch", () => {
  const names = [{ name: "codex:proj/live", running: true, address: "uds:/tmp/live.sock" },
    { name: "codex:proj/reserved", running: false }];
  const compact = formatNames(names, { sendPeer: true }).join("\n");
  assert.match(compact, /codex:proj\/live/);
  assert.match(compact, /\+1 reserved names not running/);
  assert.doesNotMatch(compact, /codex:proj\/reserved/);
  assert.match(formatNames(names, { allNames: true }).join("\n"), /codex:proj\/reserved  not running/);
  assert.equal(names.length, 2, "formatting does not mutate durable reservations");
});
