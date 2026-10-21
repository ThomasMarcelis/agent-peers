import assert from "node:assert/strict";
import { test } from "node:test";
import { CodexStatus, errorClass, observeStatus, observeTurn, statusFields } from "../src/codex-status.mjs";

const delay = () => new Promise((resolve) => setImmediate(resolve));
const turn = (status, extra = {}) => ({ id: "turn-1", status, startedAt: 100, completedAt: status === "inProgress" ? null : 110, ...extra });

test("error classes use only runtime variants and HTTP codes, including upstream capacity", () => {
  assert.equal(errorClass("serverOverloaded"), "server_overloaded");
  assert.equal(errorClass({ httpConnectionFailed: { httpStatusCode: 409 } }), "http_409");
  assert.equal(errorClass({ responseStreamDisconnected: { httpStatusCode: 503 } }), "http_503");
  assert.equal(errorClass({ httpConnectionFailed: { httpStatusCode: null } }), "http_connection_failed");
  for (const info of ["SECRET_MESSAGE", { message: "Selected model is at capacity" }, { SECRET_KEY: {} }]) assert.equal(errorClass(info), undefined);
});

test("active waiting flags are allowlisted, retained and cleared by subsequent status", () => {
  let data = observeStatus({}, { type: "active", activeFlags: ["waitingOnUserInput", "waitingOnApproval", "SECRET", "waitingOnUserInput"] }, "thread/read", 1000);
  assert.deepEqual(data.activeFlags, ["waitingOnUserInput", "waitingOnApproval"]);
  assert.deepEqual(statusFields(data).activeFlags, data.activeFlags);
  data = observeStatus(data, { type: "idle" }, "thread/status/changed", 2000);
  assert.equal(data.activeFlags, undefined);
  assert.equal(statusFields(data).activeFlags, undefined);
});

test("status and activity have separate evidence; a completed/failed turn does not imply idle", () => {
  let data = observeStatus({}, { type: "active" }, "thread/status/changed", 1000);
  data = observeTurn(data, turn("failed", { error: { message: "SECRET_PROMPT", codexErrorInfo: "serverOverloaded" }, items: ["SECRET_ITEM"] }), "turn/completed", 2000);
  assert.equal(data.status, "active");
  assert.equal(data.statusObservedAt, 1000);
  assert.deepEqual(data.lastActivity, { turnId: "turn-1", at: 110_000, observedAt: 2000, source: "turn/completed", event: "completed", timeSource: "runtime" });
  assert.deepEqual(data.lastTurn, { id: "turn-1", status: "failed", completedAt: 110_000, observedAt: 2000, source: "turn/completed", errorClass: "server_overloaded" });
  assert.doesNotMatch(JSON.stringify(data), /SECRET/);
  assert.deepEqual(statusFields(data), data);
  assert.deepEqual(statusFields({ status: "idle" }), {}, "legacy status alone adds no observation fields");
  assert.deepEqual(statusFields({ status: "SECRET", lastTurn: { status: "failed", errorClass: "SECRET" } }), {});
  const malformed = { ...data, lastTurn: { ...data.lastTurn, errorClass: { toString: null, valueOf: null }, completedAt: Number.MAX_SAFE_INTEGER } };
  assert.equal(statusFields(malformed).lastTurn.errorClass, undefined);
  assert.equal(statusFields(malformed).lastTurn.completedAt, undefined);
});

test("missing runtime timestamps stay absent for historical reads; notification receipt is typed", () => {
  const historical = observeTurn({}, turn("completed", { completedAt: null }), "thread/turns/list", 1000);
  assert.equal(historical.lastActivity, undefined);
  assert.equal(historical.lastTurn.completedAt, undefined);
  const notification = observeTurn({}, turn("interrupted", { completedAt: null }), "turn/completed", 2000);
  assert.equal(notification.lastActivity.at, 2000);
  assert.equal(notification.lastActivity.timeSource, "observed");
});

test("later runtime summaries can revise the same turn's outcome and add completion evidence", () => {
  let data = observeTurn({}, turn("interrupted", { completedAt: null }), "thread/turns/list", 1000);
  data = observeTurn(data, turn("failed", { error: { codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 409 } } } }), "thread/turns/list", 2000);
  assert.equal(data.lastTurn.status, "failed");
  assert.equal(data.lastTurn.errorClass, "http_409");
  assert.equal(data.lastTurn.completedAt, 110_000);
  assert.equal(data.lastTurn.observedAt, 2000);
  const unchanged = observeTurn(data, turn("failed", { error: { codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 409 } } } }), "thread/turns/list", 3000);
  assert.equal(unchanged.lastTurn.observedAt, 2000, "a repeated summary does not pretend the turn just ended");
});

test("observer recovers outcomes from bounded turn summaries, preserves them on loss, and ignores retry errors", async (t) => {
  let data, loaded = ["root"], status = "idle", summaries = [turn("failed", { error: { codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 409 } } } })];
  const calls = [];
  const app = {
    loadedThreads: async () => loaded,
    readThread: async (id) => { calls.push(id); return { status: { type: status } }; },
    latestTurns: async () => summaries,
  };
  const monitor = new CodexStatus(app, (_id, value) => { data = value; });
  t.after(() => monitor.close());
  monitor.watch("root", { status: { type: "idle" } });
  await delay();
  assert.equal(data.lastTurn.errorClass, "http_409");
  assert.equal(data.status, "idle");
  monitor.notification({ method: "error", params: { threadId: "root", turnId: "later", willRetry: false, error: { codexErrorInfo: "serverOverloaded" } } });
  assert.equal(data.lastTurn.id, "turn-1");
  summaries = [turn("inProgress", { id: "turn-2", startedAt: 120 }), summaries[0]];
  monitor.notification({ method: "thread/status/changed", params: { threadId: "root", status: { type: "active" } } });
  await delay();
  assert.equal(data.status, "active");
  assert.equal(data.lastActivity.at, 120_000);
  monitor.unavailable();
  assert.equal(data.status, "unknown");
  assert.equal(data.lastTurn.status, "failed");
  loaded = [];
  await monitor.refresh();
  assert.equal(data.status, "notLoaded");
  assert.deepEqual(calls, [], "unloaded threads are never read or restored");
  loaded = ["root"]; status = "idle";
  await monitor.refresh();
  assert.equal(data.status, "idle");
});

test("a delayed read cannot overwrite a newer runtime notification", async (t) => {
  let data, resolveRead;
  const app = { loadedThreads: async () => ["root"], latestTurns: async () => [],
    readThread: () => new Promise((resolve) => { resolveRead = resolve; }) };
  const monitor = new CodexStatus(app, (_id, value) => { data = value; });
  t.after(() => monitor.close());
  monitor.watch("root", { status: { type: "idle" } });
  const pending = monitor.refresh();
  await delay();
  monitor.notification({ method: "thread/status/changed", params: { threadId: "root", status: { type: "active" } } });
  resolveRead({ status: { type: "idle" } });
  await pending;
  assert.equal(data.status, "active");
});

test("a turn-summary failure records uncertainty with its source and later recovery clears it", async (t) => {
  let data, failed = false;
  const app = { loadedThreads: async () => ["root"], readThread: async () => ({ status: { type: "idle" } }),
    latestTurns: async () => { if (failed) throw new Error("SECRET_FAILURE"); return [turn("completed")]; } };
  const monitor = new CodexStatus(app, (_id, value) => { data = value; });
  t.after(() => monitor.close());
  monitor.watch("root", { status: { type: "idle" } });
  await delay();
  failed = true;
  await monitor.refresh();
  assert.deepEqual(data.turnOutcome, { status: "unknown", source: "thread/turns/list", observedAt: data.turnOutcome.observedAt });
  assert.ok(data.turnOutcome.observedAt);
  assert.equal(data.lastTurn.status, "completed", "the previous observation remains identified as historical evidence");
  assert.doesNotMatch(JSON.stringify(data), /SECRET/);
  failed = false;
  await monitor.refresh();
  assert.equal(data.turnOutcome, undefined);
});

test("lost registry ownership stops polling, notifications and pending observation results", async (t) => {
  let owned = true, resolveTurns, writes = 0, reads = 0;
  const app = { loadedThreads: async () => { reads++; return ["root"]; },
    latestTurns: () => new Promise((resolve) => { resolveTurns = resolve; }),
    readThread: async () => { reads++; return { status: { type: "idle" } }; } };
  const monitor = new CodexStatus(app, () => { writes++; }, { owns: () => owned });
  t.after(() => monitor.close());
  monitor.watch("root", { status: { type: "idle" } });
  assert.equal(writes, 1);
  owned = false;
  resolveTurns([turn("failed")]);
  await delay();
  monitor.notification({ method: "thread/status/changed", params: { threadId: "root", status: { type: "active" } } });
  await monitor.refresh();
  assert.equal(writes, 1);
  assert.equal(reads, 0);
});
