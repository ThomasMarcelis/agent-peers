import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { claudeSessionAt, codexPeers, messageLine, address, peerSocket, post, recentlyExitedCodex } from "../src/wire.mjs";
import { claim, claudeClaimant } from "../src/names.mjs";
import { thread, until, fixture } from "./codex-peer-fixture.mjs";

for (const [label, runtimeStatus, outcome, info, expectedClass, flags] of [
  ["failed conflict", "systemError", "failed", { httpConnectionFailed: { httpStatusCode: 409 } }, "http_409"],
  ["failed capacity", "systemError", "failed", "serverOverloaded", "server_overloaded"],
  ["idle completed", "idle", "completed", null, undefined],
  ["active", "active", "inProgress", null, undefined],
  ["waiting on input", "active", "inProgress", null, undefined, ["waitingOnUserInput"]],
  ["waiting on approval", "active", "inProgress", null, undefined, ["waitingOnApproval"]],
]) test(`bound worker registry and list_peers expose ${label} without item content`, async (t) => {
  const other = "observer", now = Math.floor(Date.now() / 1000);
  const f = await fixture(t, { loaded: [thread, other], threadData: { [thread]: { status: { type: runtimeStatus, ...(flags ? { activeFlags: flags } : {}) } } },
    turnData: { [thread]: [{ id: "observed-turn", status: outcome, startedAt: now - 10,
      completedAt: outcome === "inProgress" ? null : now, error: { message: "SECRET_ERROR", codexErrorInfo: info }, items: ["SECRET_ITEM"] }] } });
  const peer = await f.start();
  await peer.call("list_peers");
  await until(() => JSON.parse(readFileSync(f.registry, "utf8")).lastActivity);
  const record = JSON.parse(readFileSync(f.registry, "utf8"));
  assert.equal(record.status, runtimeStatus);
  assert.ok(record.statusObservedAt);
  assert.equal(record.lastActivity.at, (outcome === "inProgress" ? now - 10 : now) * 1000);
  assert.equal(record.lastTurn?.errorClass, expectedClass);
  const listed = await peer.call("list_peers", {}, other);
  const row = listed.structuredContent.peers.find((p) => p.threadId === thread);
  assert.equal(row.status, runtimeStatus);
  assert.deepEqual(record.activeFlags, flags);
  assert.deepEqual(row.activeFlags, flags);
  if (flags) assert.ok(listed.content[0].text.includes(label));
  assert.equal(row.lastTurn?.status, outcome === "inProgress" ? undefined : outcome);
  assert.doesNotMatch(JSON.stringify(record) + JSON.stringify(listed), /SECRET_/);
  assert.deepEqual(f.summaryCalls[0], { threadId: thread, limit: 2, sortDirection: "desc", itemsView: "notLoaded" });
});

test("runtime status changes refresh turn outcome; lost app-server means unknown, with last failure retained", async (t) => {
  const f = await fixture(t), peer = await f.start();
  await peer.call("list_peers");
  const record = () => JSON.parse(readFileSync(f.registry, "utf8"));
  f.notify("thread/status/changed", { threadId: thread, status: { type: "active" } });
  await until(() => record().status === "active");
  f.turnData[thread] = [{ id: "failed", status: "failed", startedAt: 100, completedAt: 110,
    error: { codexErrorInfo: "serverOverloaded", message: "Selected model is at capacity" } }];
  f.notify("thread/status/changed", { threadId: thread, status: { type: "systemError" } });
  await until(() => record().lastTurn?.errorClass === "server_overloaded");
  await f.disconnect();
  await until(() => record().status === "unknown");
  assert.equal(record().statusSource, "app-server-unavailable");
  assert.equal(record().lastTurn.status, "failed");
  assert.equal(codexPeers().length, 1, "loss of the app-server does not imply sidecar process exit");
  await peer.close();
  assert.equal(recentlyExitedCodex().length, 1, "graceful sidecar exit preserves the last observation");
});

test("a pending status summary never delays inbound delivery", async (t) => {
  const f = await fixture(t, { holdSummaries: true }), peer = await f.start();
  await peer.call("list_peers");
  await until(() => f.summaryCalls.length);
  const started = performance.now();
  const record = JSON.parse(readFileSync(f.registry, "utf8"));
  await post(peerSocket(record.address), messageLine({ from: address(f.inbox), body: "deliver during pending summary" }));
  await until(() => f.turns.length === 1);
  assert.ok(performance.now() - started < 800, "delivery completed within 800 ms while the eight-second summary read was pending");
});

test("a failed status transport cannot close the connection used for delivery", async (t) => {
  const f = await fixture(t, { summaryDisconnect: true }), peer = await f.start();
  await peer.call("list_peers");
  const record = () => JSON.parse(readFileSync(f.registry, "utf8"));
  await until(() => record().status === "unknown");
  await post(peerSocket(record().address), messageLine({ from: address(f.inbox), body: "deliver after status transport loss" }));
  await until(() => f.turns.length === 1);
  assert.equal(f.turns[0].threadId, thread);
});

test("MCP all_names expands text and structured names; default gives the inactive count", async (t) => {
  const f = await fixture(t), peer = await f.start();
  const claimant = claudeClaimant(claudeSessionAt(process.pid));
  claimant.holder.pid = 0x7ffffffe;
  claim("claude:proj/reserved", claimant);
  rmSync(join(f.claude, "sessions", `${process.pid}.json`));
  const compact = await peer.call("list_peers");
  const expanded = await peer.call("list_peers", { all_names: true });
  assert.match(compact.content[0].text, /\+1 reserved names not running/);
  assert.doesNotMatch(compact.content[0].text, /claude:proj\/reserved/);
  assert.match(expanded.content[0].text, /claude:proj\/reserved  not running/);
  assert.deepEqual(compact.structuredContent.names, []);
  assert.equal(compact.structuredContent.namesNotRunning, 1);
  assert.equal(expanded.structuredContent.names.length, 1);
  assert.equal(expanded.structuredContent.names[0].name, "claude:proj/reserved");
  assert.equal(expanded.structuredContent.names[0].running, false);
  assert.equal(expanded.structuredContent.namesNotRunning, 1);
});

