import assert from "node:assert/strict";
import { test } from "node:test";
import { Admission } from "../src/inbox.mjs";
import { describe, extension, isError, nameResolvedLine, nameResolvedStatusLine, readExtension, readNameResolved, readNameResolvedStatus, readReceipt, receiptLine,
  sendResult } from "../src/status.mjs";

test("receipts normalize Claude's vocabulary and ignore what this version does not know", () => {
  const id = "4b0c9f7e-1d2a-4c3b-9e8f-0a1b2c3d4e5f", other = "5c1d0a8f-2e3b-4d4c-8f9a-1b2c3d4e5f60";
  assert.deepEqual(readReceipt({ status: "expired", status_detail: "refused", orig_msg_id: id, from: "uds:/a.sock" }),
    { status: "refused", ids: [id], from: "uds:/a.sock", reason: null });
  assert.deepEqual(readReceipt({ status: "dropped", drop_reason: "queue-full", orig_msg_id: id, dropped_msg_ids: [id, other, "<bad>"] }),
    { status: "dropped", ids: [id, other], from: undefined, reason: "queue-full" });
  assert.equal(readReceipt({ status: "dropped", drop_reason: "Bad Reason", orig_msg_id: id }).reason, "other");
  assert.equal(readReceipt({ status: "rejected", orig_msg_id: id }), undefined, "unknown statuses are ignored, as Claude ignores them");
  assert.equal(readReceipt({ status: "held" }), undefined, "nothing to correlate");
  const line = receiptLine({ from: "uds:/b.sock", ids: [id, other], status: "dropped", reason: "rate-limited" });
  assert.deepEqual([line.type, line.action, line.orig_msg_id, line.drop_reason, line.dropped_msg_ids], ["control", "peer_message_status", id, "rate-limited", [id, other]]);
  assert.deepEqual(readReceipt(line).ids, [id, other]);
  assert.equal(receiptLine({ from: "uds:/b.sock", ids: [id], status: "accepted" }).drop_reason, undefined);
});

test("the extension opts in to queued and accepted only, and carries a valid in_reply_to and claimed name", () => {
  const ext = extension({ generation: "0123456789abcdef", inReplyTo: "abc-1" });
  assert.deepEqual(ext, { v: 1, receipts: ["queued", "accepted"], generation: "0123456789abcdef", in_reply_to: "abc-1" });
  assert.deepEqual(readExtension({ agent_peers: ext }), { receipts: new Set(["queued", "accepted"]), generation: "0123456789abcdef", inReplyTo: "abc-1",
    toName: undefined });
  assert.deepEqual(readExtension({ agent_peers: { v: 2, receipts: ["dropped", "queued"], generation: "x", in_reply_to: 'a" b', to_name: "Hermes:x/y" } }),
    { receipts: new Set(["queued"]), generation: undefined, inReplyTo: undefined, toName: undefined }, "a higher version keeps the fields it knows");
  assert.equal(readExtension({ agent_peers: extension({ toName: "hermes:jd/relay" }) }).toName, "hermes:jd/relay");
  assert.deepEqual(readExtension({}), { receipts: new Set() });
});

test("a name_resolved line names a Claude sender and a claimed name; anything else is not one", () => {
  const line = nameResolvedLine({ from: "uds:/a.sock", name: "hermes:jd/relay" });
  assert.deepEqual([line.type, line.action, line.agent_peers], ["control", "name_resolved", { v: 1 }]);
  assert.deepEqual(readNameResolved(line), { from: "uds:/a.sock", name: "hermes:jd/relay", id: line.msg_id });
  for (const bad of [{ ...line, name: "hermes:jd" }, { ...line, from: 5 }, { ...line, action: "peer_message_status" }, { ...line, type: "user" }]) {
    assert.equal(readNameResolved(bad), undefined);
  }
  // The holder's answer names the line it answers; only that answer, admitted or dropped, counts.
  const admitted = nameResolvedStatusLine({ from: "uds:/h.sock", id: line.msg_id, admitted: true });
  const dropped = nameResolvedStatusLine({ from: "uds:/h.sock", id: line.msg_id, admitted: false, reason: "unknown-sender" });
  assert.deepEqual([admitted.type, admitted.action, admitted.orig_msg_id, admitted.status, admitted.drop_reason], ["control", "name_resolved_status", line.msg_id, "admitted", undefined]);
  assert.deepEqual(readNameResolvedStatus(admitted, line.msg_id), { admitted: true, reason: null });
  assert.deepEqual(readNameResolvedStatus(dropped, line.msg_id), { admitted: false, reason: "unknown-sender" });
  assert.deepEqual(readNameResolvedStatus({ ...dropped, drop_reason: "Not A Code" }, line.msg_id), { admitted: false, reason: "other" });
  for (const bad of [{ ...admitted, orig_msg_id: "another" }, { ...admitted, status: "queued" }, { ...admitted, action: "peer_message_status" }]) {
    assert.equal(readNameResolvedStatus(bad, line.msg_id), undefined);
  }
});

test("errors are exactly the statuses that were not delivered", () => {
  assert.deepEqual(["accepted", "queued", "held", "delivered", "unconfirmed", "dropped", "denied", "expired", "refused", "failed"].filter(isError),
    ["dropped", "denied", "expired", "refused", "failed"]);
  assert.deepEqual(Object.keys(sendResult()), ["status", "reason", "message_id", "in_reply_to", "to", "name", "generation", "from"]);
  assert.equal(describe({ status: "unconfirmed", name: "codex:x" }, { subagent: true }),
    "Written to codex:x's inbox; no receipt arrived, so delivery is unconfirmed. Receipts go to your root session.");
});

test("admission dedups by message id only; refusals record nothing; floods stop at the bucket", () => {
  const admission = new Admission({ capacity: 2, refillPerS: 0 });
  assert.equal(admission.admit("uds:/a.sock", "one"), undefined);
  assert.equal(admission.admit("uds:/a.sock", "one"), "duplicate");
  assert.equal(admission.admit("uds:/b.sock", "one"), undefined, "ids are per sender");
  assert.equal(admission.admit("uds:/a.sock", "two", { full: true }), "queue-full");
  assert.equal(admission.admit("uds:/a.sock", "two"), undefined, "a refused id was not recorded, and spent no token");
  assert.equal(admission.admit("uds:/a.sock", "three"), "rate-limited");
  assert.equal(admission.admit("uds:/a.sock", "three"), "rate-limited", "still not a duplicate");
  assert.equal(admission.admit("uds:/a.sock", null), "rate-limited");
  const unlimited = new Admission();
  for (let i = 0; i < 5; i++) assert.equal(unlimited.admit("uds:/c.sock", null), undefined, "identical id-less lines are not duplicates");
});
