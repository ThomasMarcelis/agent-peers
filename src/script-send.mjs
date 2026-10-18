// One-way sends from scripts (`agent-peers send`). Each call is its own short-lived sender: a
// private inbox in the target's socket directory, open only for the receipt window, so its address
// is dead once the command exits. It never sends as a session, and its from-name says it is a script.

import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { Receipts, checkSocketPath, closeInbox, listenInbox, readMessage } from "./inbox.mjs";
import { Outbox, sendPeer } from "./outbox.mjs";
import { SendFailure } from "./status.mjs";
import { address, generation, inDiscoveryScope, peerSocket } from "./wire.mjs";

// The from-name is `script:<label>`: no second ":" or "/", so it never reads as a session or a claimed name.
export const LABEL = /^[a-z0-9][a-z0-9_-]{0,55}$/;

// What a script may do next. `retry`: definitely not delivered, and a later attempt may succeed.
// `unreachable`: no running holder or inbox to write to. `uncertain`: the line may have arrived, so
// sending again can duplicate it. `rejected`: not delivered, and repeating it will not help.
const SENT = new Set(["accepted", "queued", "unconfirmed", "held", "delivered"]);
const UNREACHABLE = new Set(["not-found", "not-running", "inbox-unavailable", "inbox-closed"]);
const UNCERTAIN = new Set(["write-timeout", "write-failed"]);
const RETRY = new Set(["rate-limited", "queue-full"]);
export function outcome({ status, reason }) {
  if (SENT.has(status)) return "sent";
  if ((status === "failed" || status === "dropped") && UNREACHABLE.has(reason)) return "unreachable";
  if (status === "failed" && UNCERTAIN.has(reason)) return "uncertain";
  if (status === "dropped" && RETRY.has(reason)) return "retry";
  return "rejected";
}
export const EXIT = { sent: 0, rejected: 1, retry: 3, unreachable: 4, uncertain: 5 };

const footer = (fromName) => `\n\n(One-way notice from ${fromName}, sent with agent-peers send. Replying to its address does nothing; ` +
  "if the message names a discussion peer, message that peer instead.)";

export async function scriptSend({ to, body, label }) {
  const fromName = label ? `script:${label}` : "script";
  const outbox = new Outbox(), receipts = new Receipts();
  let inbox;
  const onSignal = (signal) => {
    if (inbox) closeInbox(inbox);
    process.exit(128 + (signal === "SIGINT" ? 2 : signal === "SIGHUP" ? 1 : 15));
  };
  try {
    const { result, text } = await sendPeer({
      to, message: body.trim() ? body + footer(fromName) : body, fromName, generation: generation("script", randomUUID()),
      route: async (target) => {
        // Claude accepts reply addresses only in its own socket directory.
        const socket = join(dirname(target.socket), `script-${randomUUID().replaceAll("-", "")}.sock`);
        try {
          checkSocketPath(socket);
          if (!inDiscoveryScope(() => peerSocket(address(socket)))) throw new Error("unsafe socket directory");
          inbox = await listenInbox(socket, {
            maxConnections: 16,
            onLine: (line) => {
              if (line?.type === "control") return outbox.receive(line);
              // A reply during the receipt window has nowhere to go: tell its sender now.
              const message = inDiscoveryScope(() => readMessage(line, [inbox.address]));
              if (message) receipts.send({ to: message.from, from: inbox.address, id: message.id, status: "dropped", reason: "inbox-closed" });
            },
          });
        } catch (error) {
          throw new SendFailure("inbox-unavailable", `could not open this command's temporary inbox next to ${target.name}: ${error.message}. Nothing was sent.`);
        }
        for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(signal, onSignal);
        return { from: inbox.address, outbox };
      },
    });
    return { ...result, outcome: outcome(result), reply: false, text };
  } finally {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.off(signal, onSignal);
    if (inbox) await closeInbox(inbox);
  }
}
