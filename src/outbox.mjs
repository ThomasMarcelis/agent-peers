// The outbound half shared by Codex sessions and Hermes conversations: exact target resolution
// with generation pins, and one send with its receipt window and late outcomes.

import {
  SendFailure, describe, extension, isError, isTerminal, lateNotice, readReceipt, sendResult, validMessageId,
} from "./status.mjs";
import { MAX_LINE, allPeers, inDiscoveryScope, messageLine, peerSocket, post, stalePeers } from "./wire.mjs";

const WINDOW_MS = 1500, PENDING_MAX = 128, OUTSTANDING_MAX = 256, OUTSTANDING_MS = 30 * 60_000, PINS_MAX = 1024;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref());

// The generation this process last saw behind each exact name and address: from listings, from
// incoming messages' senders, and from the first send. A send whose target now runs as a different
// process, because a PID or socket path was reused, fails instead of reaching the wrong session.
export class Pins {
  #map = new Map();

  note(key, generation) {
    if (!key || !generation) return;
    this.#map.delete(key);
    this.#map.set(key, generation);
    if (this.#map.size > PINS_MAX) this.#map.delete(this.#map.keys().next().value);
  }

  noteRows(rows) {
    for (const row of rows) for (const key of [row.name, row.address, row.bridge?.to, ...(row.addresses ?? [])]) this.note(key, row.generation);
  }

  // The sender of an incoming message: its own report, else its registry record.
  noteSender(from, generation) {
    this.note(from, generation ?? inDiscoveryScope(() => allPeers().find((p) => p.address === from || p.addresses?.includes(from)))?.generation);
  }

  check(keys, target) {
    for (const key of keys) {
      const pinned = this.#map.get(key);
      if (pinned && target.generation && pinned !== target.generation) {
        throw new SendFailure("not-running", `the session you saw at ${key} is no longer running; ${target.name} is now a different process ` +
          `(generation ${target.generation}). Call list_peers to confirm before sending.`);
      }
    }
    for (const key of keys) this.note(key, target.generation);
  }
}

const notRunning = (peer) => new SendFailure("not-running", `${peer.name} is no longer running; its inbox address is obsolete. Call list_peers.`);

// Exact routing only: an inbox address, an exact name, or an exact name without its kind prefix
// when exactly one kind has it. Never a fragment, a most-recent guess, a default or a broadcast.
export function resolveTarget(to, pins) {
  return inDiscoveryScope(() => {
    const peers = allPeers();
    let target;
    if (to.startsWith("uds:")) {
      const socket = peerSocket(to);
      if (!socket) throw new SendFailure("invalid-address", `"${to}" is not a peer inbox address; use one from list_peers`);
      const owner = peers.find((p) => p.address === to || p.addresses?.includes(to));
      if (!owner) {
        const stale = stalePeers().find((p) => p.address === to || p.addresses?.includes(to));
        if (stale) throw notRunning(stale);
      }
      target = owner ? { ...owner, address: to, socket } : { address: to, socket, name: to };
    } else {
      if (to.includes("/")) throw new SendFailure("reserved-name", `"${to}": names containing "/" are reserved for explicit claims, which this version does not support`);
      if (/[@*?,\s]/u.test(to)) throw new SendFailure("invalid-request", `"${to}" is not a peer name; names never contain patterns or lists`);
      let matches = peers.filter((p) => p.name === to);
      if (!matches.length) matches = peers.filter((p) => p.name === `claude:${to}` || p.name === `codex:${to}`);
      if (matches.length > 1) {
        throw new SendFailure("ambiguous", `"${to}" is ambiguous: ${matches.map((p) => `${p.name} (${p.address})`).join(", ")}`);
      }
      if (!matches.length) {
        const stale = stalePeers().find((p) => p.name === to || p.name === `claude:${to}` || p.name === `codex:${to}`);
        if (stale) throw notRunning(stale);
        const needle = to.toLowerCase();
        const near = peers.map((p) => p.name).filter((name) => name.toLowerCase().includes(needle)).slice(0, 5);
        throw new SendFailure("not-found", `no live peer named "${to}"; ${near.length ? `exact names: ${near.join(", ")}` : "call list_peers"}`);
      }
      target = { ...matches[0], socket: peerSocket(matches[0].address) };
    }
    pins?.check([to, target.address], target);
    return target;
  });
}

const writeFailure = (error, name) => {
  if (["ENOENT", "ECONNREFUSED"].includes(error.code)) return new SendFailure("not-running", `${name} is not running: nothing is listening at its inbox.`);
  if (error.code === "ETIMEDOUT") return new SendFailure("write-timeout", `${name}'s inbox did not accept the message within 5 s; it was not delivered and is not retried.`);
  if (error.code === "E2BIG") return new SendFailure("too-large", `the message is too large for a peer inbox (${MAX_LINE} bytes per line)`);
  return new SendFailure("write-failed", `the message could not be written to ${name}'s inbox: ${error.message}`);
};

// Sends and the receipts that answer them, for one owner of reply inboxes.
export class Outbox {
  #sends = new Map(); // msg_id -> { to, name, reported?, outcome?, queued, settle }
  #waiting = 0;

  constructor({ onLate = () => {}, log = () => {} } = {}) { Object.assign(this, { onLate, log }); }

  // Write one line and report what was observed. The receipt window opens only once the write has
  // completed, so a slow inbox never turns into a confirmation; no receipt is "unconfirmed".
  async send(socket, line, { to, name, receipts = true }) {
    if (receipts && this.#waiting >= PENDING_MAX) throw new SendFailure("too-many-pending", "too many peer sends are waiting for receipts");
    const entry = { to, name, queued: false };
    const terminal = new Promise((resolve) => { entry.settle = resolve; });
    // Registered before writing: a receipt can arrive before the write callback.
    if (receipts) this.#track(line.msg_id, entry);
    try { await post(socket, line); }
    catch (error) { this.#sends.delete(line.msg_id); throw writeFailure(error, name); }
    if (!receipts) return { status: "unconfirmed", reason: "no-receipt" };
    this.#waiting++;
    try {
      const outcome = await Promise.race([terminal, delay(WINDOW_MS)]);
      const result = outcome ?? (entry.queued ? { status: "queued", reason: null } : { status: "unconfirmed", reason: "no-receipt" });
      entry.reported = result.status;
      if (isError(result.status)) this.#sends.delete(line.msg_id);
      return result;
    } finally { this.#waiting--; }
  }

  // True for every peer_message_status line, so a receipt is never delivered as chat.
  receive(line) {
    if (line?.type !== "control" || line.action !== "peer_message_status") return false;
    const receipt = readReceipt(line);
    for (const id of receipt?.ids ?? []) {
      const entry = this.#sends.get(id);
      // Only the inbox the message was written to may report on it; Claude's receipts name it too.
      if (!entry || receipt.from !== entry.to) continue;
      if (!entry.reported) {
        if (receipt.status === "queued") entry.queued = true;
        else if (!entry.outcome) entry.settle(entry.outcome = { status: receipt.status, reason: receipt.reason });
        continue;
      }
      // After the result: tell the sender what was not delivered, never a late success.
      if (isTerminal(receipt.status) && receipt.status !== "held") this.#sends.delete(id);
      if (lateNotice(receipt.status) && receipt.status !== entry.reported) {
        entry.reported = receipt.status;
        this.onLate({ id, to: entry.to, name: entry.name, status: receipt.status, reason: receipt.reason });
      }
      this.log("receipt.late", { messageId: id, outcome: receipt.status });
    }
    return true;
  }

  #track(id, entry) {
    entry.at = Date.now();
    for (const [old, sent] of this.#sends) {
      if (this.#sends.size < OUTSTANDING_MAX && entry.at - sent.at < OUTSTANDING_MS) break;
      if (sent.reported) this.#sends.delete(old);
      else break;
    }
    this.#sends.set(id, entry);
  }
}

// One send_peer end to end, returning the result object with its text. `route(target)` gives the
// sender's reply address for that target and the outbox that owns it. Footers go only to known
// Claude recipients, which cannot show attributes: Claude's model knows its own msg_ids.
export async function sendPeer({ to, message, inReplyTo, pins, fromName, generation, route, introduction }) {
  const result = sendResult({ in_reply_to: validMessageId(inReplyTo) ? inReplyTo : null });
  let options = {};
  try {
    if (typeof to !== "string" || !to.trim() || to.length > 1000) throw new SendFailure("invalid-request", "to must be a peer name or inbox address");
    if (typeof message !== "string" || !message.trim()) throw new SendFailure("invalid-request", "message must be nonempty text");
    if (inReplyTo !== undefined && !validMessageId(inReplyTo)) {
      throw new SendFailure("invalid-request", "in_reply_to must be the id of a message you received (letters, digits, - and _)");
    }
    const target = resolveTarget(to, pins);
    Object.assign(result, { to: target.address, name: target.name, generation: target.generation ?? null });
    const { from, outbox, receipts = true, subagent = false } = await route(target);
    result.from = from;
    if (target.address === from) throw new SendFailure("self-send", "that address is this session's own inbox");
    options = { claude: target.kind === "claude", subagent };
    let body = message;
    if (options.claude && inReplyTo) body += `\n\n(In reply to ${inReplyTo}.)`;
    const intro = options.claude ? introduction?.(target) : undefined;
    if (intro) body += `\n\n${intro}`;
    const line = messageLine({ from, fromName, body, ext: extension({ generation, inReplyTo }) });
    result.message_id = line.msg_id;
    Object.assign(result, await outbox.send(target.socket, line, { to: target.address, name: target.name, receipts }));
    return { result, text: describe(result, options), bytes: Buffer.byteLength(body) };
  } catch (error) {
    if (!(error instanceof SendFailure)) throw error;
    Object.assign(result, { status: "failed", reason: error.reason });
    return { result, text: error.message };
  }
}
