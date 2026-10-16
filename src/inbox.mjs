// The inbound half shared by Codex sessions and Hermes conversations: publishing a private inbox
// socket, admitting peer lines, and sending delivery receipts back to their senders.

import { randomUUID } from "node:crypto";
import { chmodSync, linkSync, lstatSync, renameSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { errorFields } from "./logging.mjs";
import { OPT_IN, readExtension, receiptLine, validMessageId } from "./status.mjs";
import { MAX_SOCKET_PATH, address, parseEnvelope, peerSocket, post, readLines } from "./wire.mjs";

export function checkSocketPath(socket) {
  if (Buffer.byteLength(join(dirname(socket), ".ap-00000000.sock")) > MAX_SOCKET_PATH || Buffer.byteLength(socket) > MAX_SOCKET_PATH) {
    throw new Error(`inbox path exceeds the ${MAX_SOCKET_PATH}-byte Unix socket limit; use a shorter XDG_RUNTIME_DIR for all participating agents`);
  }
}

const sameFile = (path, expected) => {
  try { const current = lstatSync(path); return current.dev === expected.dev && current.ino === expected.ino; }
  catch { return false; }
};
export const ownsSocket = (inbox) => !!inbox?.identity && sameFile(inbox.socket, inbox.identity);

// Listen without ever replacing a listener we have not verified: bind a private temporary name,
// then publish it by rename (taking over a known predecessor) or by link (a missing path). libuv
// owns only the temporary name, so closing never unlinks a replacement at the public path.
export async function listenInbox(socket, { takeover = false, maxConnections, onLine, onRefused, onError, beforePublish }) {
  checkSocketPath(socket);
  const temporary = join(dirname(socket), `.ap-${randomUUID().slice(0, 8)}.sock`);
  const connections = new Set();
  const inbox = { socket, address: address(socket), connections, closed: false };
  inbox.server = createServer((conn) => {
    if (inbox.closed || connections.size >= maxConnections) {
      onRefused?.(inbox.closed ? "closed" : "connection_limit");
      return conn.destroy();
    }
    connections.add(conn);
    conn.once("close", () => connections.delete(conn));
    readLines(conn, (line) => onLine(line, inbox));
  });
  inbox.server.maxConnections = maxConnections;
  inbox.server.on("error", (error) => onError?.(error));
  try {
    await new Promise((resolve, reject) => {
      inbox.server.once("error", reject);
      inbox.server.listen(temporary, () => { inbox.server.off("error", reject); resolve(); });
    });
    chmodSync(temporary, 0o600);
    inbox.identity = lstatSync(temporary);
    await beforePublish?.();
    if (takeover) renameSync(temporary, socket);
    else {
      try { linkSync(temporary, socket); }
      catch (error) {
        if (error.code === "EEXIST") throw new Error("this inbox was replaced; retry after the current owner is ready");
        throw error;
      }
      rmSync(temporary);
    }
    return inbox;
  } catch (error) {
    await closeInbox(inbox);
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function closeInbox(inbox) {
  inbox.closed = true;
  for (const connection of inbox.connections) connection.destroy();
  const closed = new Promise((resolve) => inbox.server.close(() => resolve()));
  if (ownsSocket(inbox)) rmSync(inbox.socket, { force: true });
  return closed;
}

// A peer message line, validated: a well-formed envelope whose reply address is a peer inbox and
// not one of ours. Anything else could not be answered and might not be framed safely.
export function readMessage(line, own) {
  if (line?.type !== "user" || typeof line.message?.content !== "string") return undefined;
  const env = parseEnvelope(line.message.content);
  if (!env || !peerSocket(env.from) || own.includes(env.from) || (line.from && line.from !== env.from)) return undefined;
  return {
    from: env.from, body: env.body, id: validMessageId(line.msg_id) ? line.msg_id : null, ext: readExtension(line),
    sender: /^[A-Za-z0-9:_ .-]{1,80}$/.test(env.fromName ?? "") ? env.fromName : "an unnamed peer",
  };
}

// Per-owner admission. A message id seen again is a duplicate; repeated identical bodies are
// legitimate. Floods stop at a token bucket per sender (Claude's own 30 tokens, 0.5/s refill).
export class Admission {
  #buckets = new Map();
  #seen = new Map();

  constructor({ capacity = 30, refillPerS = 0.5, senders = 1024, ids = 4096, dedupMs = 600_000, idleMs = 600_000 } = {}) {
    Object.assign(this, { capacity, refillPerS, senders, ids, dedupMs, idleMs });
  }

  // undefined when admitted; otherwise "duplicate", "rate-limited" or "queue-full". A refusal
  // spends no token and does not record the id, so a later retry of a dropped message is admitted.
  admit(from, id, { full = false } = {}) {
    const now = Date.now(), key = id && `${from}\0${id}`;
    for (const [sender, bucket] of this.#buckets) if (now - bucket.at > this.idleMs) this.#buckets.delete(sender);
    for (const [seen, at] of this.#seen) { if (now - at <= this.dedupMs) break; this.#seen.delete(seen); }
    if (key && this.#seen.has(key)) return "duplicate";
    if (!this.#buckets.has(from) && this.#buckets.size >= this.senders) return "queue-full";
    const bucket = this.#buckets.get(from) ?? { tokens: this.capacity, at: now };
    bucket.tokens = Math.min(this.capacity, bucket.tokens + ((now - bucket.at) / 1000) * this.refillPerS);
    bucket.at = now;
    this.#buckets.set(from, bucket);
    if (bucket.tokens < 1) return "rate-limited";
    if (full) return "queue-full";
    bucket.tokens -= 1;
    if (key) {
      if (this.#seen.size >= this.ids) this.#seen.delete(this.#seen.keys().next().value);
      this.#seen.set(key, now);
    }
    return undefined;
  }

  clear() { this.#buckets.clear(); this.#seen.clear(); }
}

// Best-effort receipts to senders: one attempt, never retried, at most 16 in flight. Everyone gets
// `dropped`; queued and accepted go only to senders that opted in. Drops coalesce per sender and
// reason for a second, as Claude's do, so a flood cannot multiply outbound connections.
export class Receipts {
  #batches = new Map();
  #inFlight = 0;

  constructor(log = () => {}) { this.log = log; }

  send({ to, from, id, status, reason, optIn }) {
    if (!id || (OPT_IN.includes(status) && !optIn?.has(status))) return;
    if (status !== "dropped") return this.#post(to, receiptLine({ from, ids: [id], status }));
    const key = `${to}\0${from}\0${reason}`, batch = this.#batches.get(key);
    if (batch) { if (batch.length < 256) batch.push(id); return; }
    this.#batches.set(key, []);
    setTimeout(() => {
      const ids = this.#batches.get(key);
      this.#batches.delete(key);
      if (ids?.length) this.#post(to, receiptLine({ from, ids, status, reason }));
    }, 1000).unref();
    this.#post(to, receiptLine({ from, ids: [id], status, reason }));
  }

  #post(to, line) {
    const socket = peerSocket(to);
    if (!socket || this.#inFlight >= 16) return this.log("receipt.send", { outcome: "skipped", reason: socket ? "queue_full" : "malformed" });
    this.#inFlight++;
    post(socket, line).then(() => this.log("receipt.send", { outcome: "succeeded" }),
      (error) => this.log("receipt.send", { outcome: "failed", ...errorFields(error) })).finally(() => { this.#inFlight--; });
  }
}
