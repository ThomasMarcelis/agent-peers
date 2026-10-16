import assert from "node:assert/strict";
import { test } from "node:test";
import { bindDelayMs, bindReporter, RETRY_MAX_MS, START_RETRY_MS } from "../src/bind-retry.mjs";

test("startup binding retries quickly, then backs off to a ten-minute cap", () => {
  assert.deepEqual(START_RETRY_MS.map((_, i) => bindDelayMs(i)), START_RETRY_MS);
  const later = [0, 1, 2, 3, 4, 10, 1000].map((n) => bindDelayMs(START_RETRY_MS.length + n));
  assert.deepEqual(later, [60_000, 120_000, 240_000, 480_000, 600_000, 600_000, 600_000]);
  assert.equal(RETRY_MAX_MS, 600_000);
});

test("a persistent bind failure is reported once, then once as unreachable, not on every retry", () => {
  const report = bindReporter(), events = [];
  for (let attempt = 0; attempt < 40; attempt++) {
    const event = report(attempt, "app_server_unavailable");
    if (event) events.push({ attempt, ...event });
  }
  assert.deepEqual(events, [
    { attempt: 0, outcome: "failed", reason: "app_server_unavailable" },
    { attempt: START_RETRY_MS.length - 1, outcome: "unreachable", reason: "app_server_unavailable", count: START_RETRY_MS.length },
  ]);
});

test("a changed or recurring failure reason is reported again after a clean attempt", () => {
  const report = bindReporter();
  assert.equal(report(0, "unloaded_thread").outcome, "failed");
  assert.equal(report(1, "unloaded_thread"), undefined);
  assert.equal(report(2, "app_server_unavailable").outcome, "failed");
  assert.equal(report(3, undefined), undefined);
  assert.equal(report(4, "app_server_unavailable").outcome, "failed");
});
