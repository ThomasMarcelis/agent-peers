// One delivery vocabulary for receipts on the wire and send_peer results (docs/reference.md,
// "Delivery"). Claude Code emits held, delivered (a held message released), denied, expired,
// refused and dropped, and ignores every other status. agent-peers inboxes add queued and
// accepted, which go only to senders that opt in through the agent_peers line extension.

import { randomUUID } from "node:crypto";

const RECEIPTS = new Set(["queued", "accepted", "held", "delivered", "denied", "expired", "refused", "dropped"]);
const ERRORS = new Set(["failed", "dropped", "denied", "expired", "refused"]);
export const OPT_IN = ["queued", "accepted"];

// An error means the message was definitely not delivered.
export const isError = (status) => ERRORS.has(status);
// queued is the only receipt after which more news is expected inside the window.
export const isTerminal = (status) => RECEIPTS.has(status) && status !== "queued";
// Late news worth telling the sender: not delivered, or not yet (held). Late successes stay silent.
export const lateNotice = (status) => status === "held" || (ERRORS.has(status) && status !== "failed");

const MESSAGE_ID = /^[A-Za-z0-9_-]{1,128}$/;
export const validMessageId = (id) => typeof id === "string" && MESSAGE_ID.test(id);
const REASON = /^[a-z][a-z0-9-]{0,63}$/;
const GENERATION = /^[a-f0-9]{16}$/;
// A claimed name, <kind>:<scope>/<claim> (names.mjs): lowercase ASCII with exactly one "/".
export const CLAIMED_NAME = /^(claude|codex|hermes|opencode):[a-z0-9][a-z0-9_-]{0,63}\/[a-z0-9][a-z0-9_.-]{0,63}$/;

// The extension a 1.0 sender adds to each message line. Claude Code and agent-peers 0.x ignore it.
// `to_name` is the claimed name the sender resolved to reach this inbox.
export const extension = ({ generation, inReplyTo, toName }) => ({
  v: 1, receipts: OPT_IN, ...(generation ? { generation } : {}), ...(inReplyTo ? { in_reply_to: inReplyTo } : {}),
  ...(toName ? { to_name: toName } : {}),
});

// A line's extension, validated; empty for Claude, agent-peers 0.x and anything malformed.
export function readExtension(line) {
  const ext = line?.agent_peers;
  if (!ext || typeof ext !== "object" || Array.isArray(ext) || !Number.isInteger(ext.v) || ext.v < 1) return { receipts: new Set() };
  return {
    receipts: new Set(Array.isArray(ext.receipts) ? ext.receipts.filter((status) => OPT_IN.includes(status)) : []),
    generation: typeof ext.generation === "string" && GENERATION.test(ext.generation) ? ext.generation : undefined,
    inReplyTo: validMessageId(ext.in_reply_to) ? ext.in_reply_to : undefined,
    toName: typeof ext.to_name === "string" && CLAIMED_NAME.test(ext.to_name) ? ext.to_name : undefined,
  };
}

// A peer_message_status line as { status, reason, ids, from }, or undefined when this version does
// not understand it. Claude sends refused as expired with status_detail "refused" for older builds.
export function readReceipt(line) {
  if (typeof line?.status !== "string") return undefined;
  const status = line.status === "expired" && line.status_detail === "refused" ? "refused" : line.status;
  if (!RECEIPTS.has(status)) return undefined;
  const ids = [...new Set([line.orig_msg_id, ...(Array.isArray(line.dropped_msg_ids) ? line.dropped_msg_ids.slice(0, 256) : [])]
    .filter(validMessageId))];
  if (!ids.length) return undefined;
  return { status, ids, from: typeof line.from === "string" ? line.from : undefined,
    reason: status === "dropped" ? (REASON.test(line.drop_reason ?? "") ? line.drop_reason : "other") : null };
}

const RECEIPT_TEXT = {
  queued: "admitted to the inbox; waiting for its host",
  accepted: "the recipient's host took the message",
  dropped: "dropped at the recipient's inbox; not delivered",
};

// The receipt line an agent-peers inbox sends, in Claude's own format so every sender reads one shape.
export function receiptLine({ from, ids, status, reason }) {
  return {
    type: "control", action: "peer_message_status", msgV: 1, msg_id: randomUUID(), from, orig_msg_id: ids[0], status,
    reason: RECEIPT_TEXT[status], ...(status === "dropped" ? { drop_reason: reason, dropped_msg_ids: ids } : {}), agent_peers: { v: 1 },
  };
}

// Claude's SendMessage cannot mark a line with the name it was sent to, so `agent-peers resolve`
// tells a Hermes holder that the Claude session at `from` resolved its name, just before that
// session sends. Without it the holder cannot tell that sender from one that found its inbox.
export const nameResolvedLine = ({ from, name }) => ({ type: "control", action: "name_resolved", msgV: 1, msg_id: randomUUID(), from, name,
  agent_peers: { v: 1 } });
export const readNameResolved = (line) => line?.type === "control" && line.action === "name_resolved" && typeof line.from === "string" &&
  typeof line.name === "string" && CLAIMED_NAME.test(line.name)
  ? { from: line.from, name: line.name, id: validMessageId(line.msg_id) ? line.msg_id : undefined } : undefined;

// The holder's answer to name_resolved, on the same connection: whether it admitted the session at
// `from` of the name_resolved line, or why not (`not-holder`, `unknown-sender`, `inbox-closed`).
// Bridges before this answer nothing, which resolve takes as admitted.
export const nameResolvedStatusLine = ({ from, id, admitted, reason }) => ({ type: "control", action: "name_resolved_status", msgV: 1,
  msg_id: randomUUID(), from, orig_msg_id: id, status: admitted ? "admitted" : "dropped", ...(admitted ? {} : { drop_reason: reason }),
  agent_peers: { v: 1 } });
export const readNameResolvedStatus = (line, id) => line?.type === "control" && line.action === "name_resolved_status" && line.orig_msg_id === id &&
  ["admitted", "dropped"].includes(line.status)
  ? { admitted: line.status === "admitted", reason: line.status === "admitted" ? null : REASON.test(line.drop_reason ?? "") ? line.drop_reason : "other" }
  : undefined;

// A send that never produced a deliverable line, with a stable reason code.
export class SendFailure extends Error {
  constructor(reason, message) {
    super(message);
    this.reason = reason;
  }
}

// The one send_peer result: Codex structuredContent, and the JSON Hermes returns with `text` added.
export const sendResult = ({ status = "failed", reason = null, message_id = null, in_reply_to = null, to = null, name = null,
  generation = null, from = null } = {}) => ({ status, reason, message_id, in_reply_to, to, name, generation, from });

export function describe(result, { claude = false, subagent = false } = {}) {
  const name = result.name ?? result.to ?? "the peer";
  switch (result.status) {
    case "accepted": return `Accepted by ${name}.`;
    case "queued": return `Queued in ${name}'s inbox; its host has not taken it yet.`;
    case "held": return `${name} is holding it for its user's approval; not delivered yet. A reply may still come if it is approved.`;
    case "delivered": return `Delivered to ${name} after its user approved it.`;
    case "unconfirmed": return (claude ? `Sent to ${name}. Claude reports only held or dropped messages, and none was reported.`
      : `Written to ${name}'s inbox; no receipt arrived, so delivery is unconfirmed.`) + (subagent ? " Receipts go to your root session." : "");
    case "dropped": return `Not delivered: ${name} dropped it (${result.reason}). Do not wait for a reply.`;
    case "denied": return `Not delivered: ${name}'s user declined it.`;
    case "expired": return `Not delivered: ${name} held it, and it expired without approval.`;
    case "refused": return `Not delivered: ${name} does not accept peer messages.`;
    default: return "Not sent.";
  }
}
