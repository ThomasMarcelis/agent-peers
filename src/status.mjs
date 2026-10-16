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

// The extension a 1.0 sender adds to each message line. Claude Code and agent-peers 0.x ignore it.
export const extension = ({ generation, inReplyTo }) => ({
  v: 1, receipts: OPT_IN, ...(generation ? { generation } : {}), ...(inReplyTo ? { in_reply_to: inReplyTo } : {}),
});

// A line's extension, validated; empty for Claude, agent-peers 0.x and anything malformed.
export function readExtension(line) {
  const ext = line?.agent_peers;
  if (!ext || typeof ext !== "object" || Array.isArray(ext) || !Number.isInteger(ext.v) || ext.v < 1) return { receipts: new Set() };
  return {
    receipts: new Set(Array.isArray(ext.receipts) ? ext.receipts.filter((status) => OPT_IN.includes(status)) : []),
    generation: typeof ext.generation === "string" && GENERATION.test(ext.generation) ? ext.generation : undefined,
    inReplyTo: validMessageId(ext.in_reply_to) ? ext.in_reply_to : undefined,
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
