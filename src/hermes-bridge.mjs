// Private reply inboxes for Hermes. This process never writes a discovery registry entry:
// a conversation becomes reachable only by sharing its address with a recipient.

import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { AppServer } from "./app-server.mjs";
import { Admission, Receipts, checkSocketPath, closeInbox, listenInbox, readMessage } from "./inbox.mjs";
import { errorFields, logEvent, logIdentity } from "./logging.mjs";
import { Outbox, Pins, sendPeer } from "./outbox.mjs";
import { SendFailure, isError } from "./status.mjs";
import { MAX_LINE, address, allPeers, generation, inDiscoveryScope, peerSocket } from "./wire.mjs";

const QUEUE_MAX = 50, TOTAL_QUEUE_MAX = 200, SOURCES_MAX = 256, SESSIONS_MAX = 256, HANDOFFS_MAX = 256, CONTACTS_MAX = 256,
  CONVERSATIONS_MAX = 2 * SESSIONS_MAX, RETIRED_HANDOFF_MS = 60_000;
const IPC_QUEUE_MAX = 128, IPC_WRITE_TIMEOUT_MS = 5000;
const logger = (message) => console.error(`[hermes-bridge ${process.pid}] ${message}`);
const event = (name, fields) => logEvent("hermes-bridge", name, fields);
const code = (reason) => reason?.replaceAll("-", "_");
const safeError = (error) => {
  const { reason, errorCode } = errorFields(error);
  return errorCode && errorCode !== "unknown" ? `${reason} (${errorCode})` : reason;
};

function requiredString(value, field, max = MAX_LINE) {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(`${field} must be a nonempty string of at most ${max} characters`);
  }
  return value;
}

export class HermesBridge {
  #app;
  #emit;
  #log;
  #routes = new Map();
  #locks = new Map();
  #closed = false;
  #closing;
  #queued = 0;
  #receipts = new Receipts(event);
  #introduced = new Set();
  // Per conversation, shared by its inboxes in every socket directory: the generations it saw
  // (pins), the addresses it has written to (the only senders its inboxes accept; anyone else
  // guessed the address), and its dedup and token buckets. Cleared when it closes.
  #conversations = new Map();
  #retiredHandoffs = new Map();

  constructor({ app = new AppServer(), emit = async () => {}, log = logger } = {}) {
    this.#app = app;
    this.#emit = emit;
    this.#log = log;
  }

  #firstContact(key) {
    if (this.#introduced.has(key)) return false;
    if (this.#introduced.size >= 4096) this.#introduced.clear();
    this.#introduced.add(key);
    return true;
  }

  #conversation(session) {
    let state = this.#conversations.get(session);
    if (state) return state;
    if (this.#conversations.size >= CONVERSATIONS_MAX) {
      // Only conversations without an inbox are evicted; those with one are bounded by SESSIONS_MAX.
      const open = new Set([...this.#routes.values()].map((route) => route.session));
      for (const key of this.#conversations.keys()) if (!open.has(key)) { this.#conversations.delete(key); break; }
    }
    state = { pins: new Pins(), contacts: new Set(), admission: new Admission({ senders: SOURCES_MAX }) };
    this.#conversations.set(session, state);
    return state;
  }

  // Returns whether `to` is new, so a send that wrote nothing can take it back.
  #contact(session, to) {
    const { contacts } = this.#conversation(session), added = !contacts.delete(to);
    contacts.add(to);
    if (contacts.size > CONTACTS_MAX) contacts.delete(contacts.values().next().value);
    return added;
  }

  async request(method, params = {}) {
    const operationId = randomUUID(), started = performance.now();
    const fields = {
      operationId, method: ["list_peers", "send_peer", "close_session"].includes(method) ? method : "unknown",
      ...(typeof params?.session === "string" ? { sessionId: logIdentity(params.session) } : {}),
      ...(typeof params?.to === "string" ? { targetId: logIdentity(params.to) } : {}),
      ...(typeof params?.message === "string" ? { bytes: Buffer.byteLength(params.message) } : {}),
    };
    event("tool.request", fields);
    try {
      const result = await this.#request(method, params, operationId);
      event("tool.result", {
        ...fields, durationMs: performance.now() - started,
        outcome: result.status === "failed" ? "error" : result.note || isError(result.status) ? "warning" : "success",
        ...(result.status === "failed" ? { reason: code(result.reason) } : {}),
        ...(Array.isArray(result.peers) ? { bridgeCount: result.peers.length } : {}),
      });
      return result;
    } catch (error) {
      event("tool.result", { ...fields, outcome: "error", durationMs: performance.now() - started, ...errorFields(error) });
      throw error;
    }
  }

  async #request(method, params, operationId) {
    if (this.#closed) throw new Error("Hermes bridge is closed");
    if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("params must be an object");
    // A listing pins only the conversation that asked for it.
    if (method === "list_peers") return this.#listPeers(params.session === undefined ? undefined : requiredString(params.session, "session", 512));
    if (method !== "send_peer" && method !== "close_session") throw new Error(`unknown method: ${method}`);
    const session = requiredString(params.session, "session", 512);
    // One conversation's requests run in order, so a close cannot race a send creating the same
    // route. Other conversations run concurrently.
    const previous = this.#locks.get(session) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      if (this.#closed) throw new Error("Hermes bridge is closed");
      if (method === "send_peer") return this.#send(session, params, operationId);
      const routes = [...this.#routes.values()].filter((route) => route.session === session);
      await Promise.all(routes.map((route) => this.#retire(route)));
      this.#conversations.delete(session);
      return { closed: routes.length > 0 };
    });
    this.#locks.set(session, operation);
    try {
      return await operation;
    } finally {
      if (this.#locks.get(session) === operation) this.#locks.delete(session);
    }
  }

  async #listPeers(session) {
    const peers = allPeers().filter((p) => p.kind === "claude" || p.kind === "codex");
    let note;
    const live = new Map();
    if (peers.some((p) => p.kind === "codex")) {
      let timer, expired = false;
      const read = async () => {
        // Never thread/read a historical thread: it would load it into the daemon.
        const ids = new Set(await this.#app.loadedThreads());
        if (expired) return;
        const results = await Promise.allSettled(peers.filter((p) => p.kind === "codex" && ids.has(p.threadId))
          .map(async (p) => ({ id: p.threadId, thread: await this.#app.readThread(p.threadId) })));
        if (expired) return;
        for (const r of results) if (r.status === "fulfilled") live.set(r.value.id, r.value.thread);
        if (results.some((r) => r.status === "rejected")) note = "Some live Codex statuses are unavailable.";
      };
      try {
        await Promise.race([read(), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("status lookup timed out")), 3000);
        })]);
      } catch (error) {
        note = `Live Codex status unavailable: ${error.message}. Registered inboxes are still listed.`;
      } finally {
        expired = true;
        clearTimeout(timer);
      }
    }
    if (session) this.#conversation(session).pins.noteRows(peers);
    return {
      peers: peers.map((p) => ({
        name: p.name, kind: p.kind, cwd: p.cwd ?? null,
        status: live.get(p.threadId)?.status?.type ?? p.status ?? null, address: p.address, generation: p.generation,
      })),
      ...(note ? { note } : {}),
    };
  }

  async #bind(session, name, directory) {
    // Claude only accepts reply addresses in its own runtime directory. A
    // conversation needs one private endpoint per destination directory.
    const key = JSON.stringify([session, directory]);
    for (const route of this.#routes.values()) {
      if (route.session === session && route.name !== name) {
        throw new Error("this conversation already belongs to a different Hermes identity");
      }
    }
    const previous = this.#routes.get(key);
    if (previous) return previous;
    if (this.#routes.size >= SESSIONS_MAX) throw new Error("too many open Hermes conversation inboxes");
    const socket = join(directory, `hermes-${randomUUID().replaceAll("-", "")}.sock`);
    const sessionId = logIdentity(session);
    const route = {
      key, session, name, socket, address: address(socket), closed: false, queued: 0, chain: Promise.resolve(),
      handoffs: new Map(),
      // Late outcomes are logged only: 1.0 injects nothing into a Hermes conversation unasked.
      outbox: new Outbox({ log: (name, fields) => event(name, { sessionId, ...fields }) }),
    };
    checkSocketPath(socket);
    if (!peerSocket(route.address)) throw new Error("unsafe Hermes reply inbox directory");
    route.inbox = await listenInbox(socket, {
      maxConnections: QUEUE_MAX, onLine: (line) => this.#receive(route, line),
      onRefused: (reason) => event("receive.dropped", { sessionId, reason: reason === "closed" ? "closed" : "queue_full" }),
      onError: (error) => {
        event("inbox.error", { sessionId, ...errorFields(error) });
        this.#log(`inbox error: ${safeError(error)}`);
      },
    });
    this.#routes.set(key, route);
    event("inbox.bound", { sessionId, targetId: logIdentity(route.address) });
    return route;
  }

  async #send(session, params, operationId) {
    const started = performance.now();
    const name = requiredString(params.name, "name", 80);
    if (!/^hermes:[A-Za-z0-9:_-]+$/.test(name)) throw new Error("name must identify a Hermes profile as hermes:<profile>");
    const fields = {
      operationId, sessionId: logIdentity(session),
      ...(typeof params.to === "string" ? { targetId: logIdentity(params.to) } : {}),
      ...(typeof params.message === "string" ? { bytes: Buffer.byteLength(params.message) } : {}),
    };
    event("send.started", fields);
    let added = false;
    const { result, text } = await sendPeer({
      to: params.to, message: params.message, inReplyTo: params.in_reply_to ?? undefined, pins: this.#conversation(session).pins, fromName: name,
      generation: generation("hermes", session),
      route: async (target) => {
        let route;
        try { route = await this.#bind(session, name, dirname(target.socket)); }
        catch (error) { throw new SendFailure("inbox-unavailable", error.message); }
        // Recorded before the write, because a reply can arrive before this send's result does;
        // taken back below if nothing was written, so a later owner of a dead address gets no pass.
        added = this.#contact(session, target.address);
        return { from: route.address, outbox: route.outbox };
      },
      // Claude labels every external envelope as another Claude session. Correct that frame once
      // per conversation and recipient: the recipient keeps it in context.
      introduction: (target) => (this.#firstContact(`${session}\0${target.address}`) ? "(Hermes profile; notify_when_idle unavailable.)" : undefined),
    });
    if (added && result.status === "failed") this.#conversations.get(session)?.contacts.delete(result.to);
    if (result.message_id) {
      if (result.status !== "failed") event("message.send", { ...fields, messageId: logIdentity(result.message_id), outcome: "inbox_written" });
      event("send.result", { ...fields, messageId: logIdentity(result.message_id), durationMs: performance.now() - started,
        outcome: result.status, receipt: !["unconfirmed", "failed"].includes(result.status) });
    }
    return { ...result, text };
  }

  #receive(route, line) {
    const sessionId = logIdentity(route.session);
    const drop = (reason, fields = {}) => event("receive.dropped", { sessionId, reason, ...fields });
    if (route.closed) return drop("closed");
    if (!line || typeof line !== "object") return drop("malformed");
    if (line.type === "control") {
      if (!route.outbox.receive(line)) drop("malformed");
      return;
    }
    const message = inDiscoveryScope(() => readMessage(line, [route.address]));
    if (!message) return drop("malformed");
    // The host needs an id even for a line without one; such a line cannot be deduplicated.
    const id = message.id ?? randomUUID();
    const fields = { sessionId, messageId: logIdentity(id), targetId: logIdentity(message.from), bytes: Buffer.byteLength(message.body) };
    const reply = (status, reason) => this.#receipts.send({ to: message.from, from: route.address, id: message.id, status, reason, optIn: message.ext.receipts });
    // Only peers this conversation wrote to may write to it; the sender learns it was refused.
    const conversation = this.#conversations.get(route.session);
    if (!conversation?.contacts.has(message.from)) {
      reply("dropped", "not-a-reply-target");
      return drop("not_a_reply_target", fields);
    }
    const notification = { method: "peer_message", params: {
      session: route.session, message_id: id, from: message.from, from_name: message.sender, message: message.body,
      ...(message.ext.inReplyTo ? { in_reply_to: message.ext.inReplyTo } : {}),
    } };
    // The host reads at most MAX_LINE per line and restarts the bridge on a longer one; a frame
    // that fits the inbox can exceed that once re-encoded with session and message IDs.
    if (Buffer.byteLength(JSON.stringify(notification)) + 1 > MAX_LINE) {
      reply("dropped", "too-large");
      return drop("message_too_large", fields);
    }
    const reason = conversation.admission.admit(message.from, message.id, { full: route.queued >= QUEUE_MAX || this.#queued >= TOTAL_QUEUE_MAX });
    // A repeated id gets no receipt: the first copy's outcome stands.
    if (reason === "duplicate") return drop(reason, fields);
    if (reason) {
      reply("dropped", reason);
      return drop(code(reason), fields);
    }
    conversation.pins.noteSender(message.from, message.ext.generation);
    reply("queued");
    // The plugin reports the host's answer with delivery_result; only then is it accepted.
    if (message.id) {
      if (route.handoffs.size >= HANDOFFS_MAX) route.handoffs.delete(route.handoffs.keys().next().value);
      route.handoffs.set(message.id, reply);
    }
    route.queued++;
    this.#queued++;
    event("receive.queued", { ...fields, queueDepth: route.queued });
    const started = performance.now();
    route.chain = route.chain.then(async () => {
      if (route.closed) {
        if (message.id) this.#takeHandoff(route.session, message.id);
        reply("dropped", "inbox-closed");
        return drop("closed", fields);
      }
      await this.#emit(notification);
      event("delivery.result", { ...fields, outcome: "emitted_to_host", durationMs: performance.now() - started });
    }).catch((error) => {
      event("delivery.result", { ...fields, outcome: "error", durationMs: performance.now() - started, ...errorFields(error) });
      this.#log(`incoming message delivery failed: ${safeError(error)}`);
    })
      .finally(() => { route.queued--; this.#queued--; });
  }

  // The receipt callback for a message handed to the plugin, removed so it answers once. A
  // retired route's handoffs stay a minute, so the plugin's late inbox-closed still reaches them.
  #takeHandoff(session, id) {
    for (const route of this.#routes.values()) {
      const reply = route.session === session && route.handoffs.get(id);
      if (reply) {
        route.handoffs.delete(id);
        return reply;
      }
    }
    const key = `${session}\0${id}`, kept = this.#retiredHandoffs.get(key);
    this.#retiredHandoffs.delete(key);
    return kept && kept.expires > Date.now() ? kept.reply : undefined;
  }

  // The plugin's report of what the host did with a peer_message: accepted, or why not.
  deliveryResult(params) {
    if (!params || typeof params.session !== "string" || typeof params.message_id !== "string") return;
    const reply = this.#takeHandoff(params.session, params.message_id);
    if (!reply) return;
    const reason = ["queue-full", "inbox-closed"].includes(params.reason) ? params.reason : "host-rejected";
    event("delivery.host", { sessionId: logIdentity(params.session), messageId: logIdentity(params.message_id),
      outcome: params.accepted === true ? "accepted" : "rejected" });
    return params.accepted === true ? reply("accepted") : reply("dropped", reason);
  }

  async #retire(route) {
    route.closed = true;
    this.#routes.delete(route.key);
    // listenInbox bound a private temporary name, so closing never unlinks a replacement at the
    // public path, and the socket is removed only while this route still owns it.
    await closeInbox(route.inbox);
    for (const [id, reply] of route.handoffs) {
      const key = `${route.session}\0${id}`;
      this.#retiredHandoffs.delete(key);
      this.#retiredHandoffs.set(key, { reply, expires: Date.now() + RETIRED_HANDOFF_MS });
      if (this.#retiredHandoffs.size > HANDOFFS_MAX) this.#retiredHandoffs.delete(this.#retiredHandoffs.keys().next().value);
    }
    route.handoffs.clear();
    event("inbox.closed", { sessionId: logIdentity(route.session), targetId: logIdentity(route.address), queueDepth: route.queued });
  }

  close() {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#closing = (async () => {
      try {
        await Promise.allSettled([...this.#locks.values()]);
        await Promise.all([...this.#routes.values()].map((route) => this.#retire(route)));
      } finally {
        await this.#app.close?.();
      }
    })();
    return this.#closing;
  }
}

// The subprocess protocol is newline-delimited JSON. Stdout is reserved for protocol
// messages and respects stream backpressure; diagnostic text goes to stderr. Requests run
// concurrently (HermesBridge keeps each conversation in order) and responses carry their id.
export function runHermesBridge() {
  const write = (message) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      event("bridge.error", { reason: "timeout" });
      reject(new Error("bridge output timed out"));
      void stop(1);
    }, IPC_WRITE_TIMEOUT_MS);
    process.stdout.write(JSON.stringify(message) + "\n", (error) => {
      clearTimeout(timer);
      if (error) reject(error); else resolve();
    });
  });
  const bridge = new HermesBridge({ emit: write });
  const inFlight = new Set();
  let buffer = "", stopping = false;
  const stop = async (code = 0) => {
    if (stopping) return;
    stopping = true;
    process.stdin.pause();
    // A blocked parent or daemon must not keep an unloaded plugin alive indefinitely.
    const deadline = setTimeout(() => process.exit(code || 1), IPC_WRITE_TIMEOUT_MS);
    deadline.unref();
    try {
      await bridge.close();
    } catch (error) {
      event("bridge.error", errorFields(error));
      logger(`bridge shutdown failed: ${safeError(error)}`);
      code = 1;
    }
    process.exit(code);
  };
  const handle = async (raw) => {
    let request, id = null;
    try {
      request = JSON.parse(raw);
      if (!request || typeof request !== "object" || Array.isArray(request) || typeof request.method !== "string" || request.method.length > 80) {
        throw new Error("expected {id, method, params}");
      }
      // The plugin's one notification: no id, no response.
      if (request.method === "delivery_result" && !Object.hasOwn(request, "id")) return bridge.deliveryResult(request.params);
      if (!(typeof request.id === "string" && request.id.length > 0 && request.id.length <= 256 || Number.isSafeInteger(request.id))) {
        throw new Error("expected {id, method, params}");
      }
      id = request.id;
      if (request.method === "shutdown") {
        // Only earlier requests are in flight here: this one is added after its first await.
        await Promise.allSettled([...inFlight]);
        await write({ id, result: { closed: true } });
        await stop();
        return;
      }
      const result = await bridge.request(request.method, request.params);
      await write({ id, result });
    } catch (error) {
      if (id === null) event("bridge.error", { reason: "malformed" });
      await write({ id, error: { message: error.message } });
    }
  };
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (data) => {
    if (stopping) return;
    buffer += data;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const raw = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (Buffer.byteLength(raw) + 1 > MAX_LINE || inFlight.size >= IPC_QUEUE_MAX) {
        event("bridge.error", { reason: inFlight.size >= IPC_QUEUE_MAX ? "queue_full" : "message_too_large", queueDepth: inFlight.size });
        logger("bridge input limit exceeded");
        void stop(1);
        return;
      }
      if (!raw.trim()) continue;
      const task = handle(raw)
        .catch((error) => { event("bridge.error", errorFields(error)); logger(safeError(error)); void stop(1); })
        .finally(() => inFlight.delete(task));
      inFlight.add(task);
    }
    if (Buffer.byteLength(buffer) >= MAX_LINE) {
      event("bridge.error", { reason: "message_too_large" });
      logger("bridge input line too large");
      void stop(1);
    }
  });
  process.stdin.on("end", () => {
    if (buffer.trim()) {
      event("bridge.error", { reason: "malformed" });
      logger("incomplete bridge input at EOF");
      void stop(1);
    } else void Promise.allSettled([...inFlight]).finally(() => stop());
  });
  process.stdin.on("error", (error) => { event("bridge.error", errorFields(error)); void stop(1); });
  process.stdout.on("error", (error) => { event("bridge.error", errorFields(error)); void stop(1); });
  process.once("SIGINT", () => { void stop(); });
  process.once("SIGTERM", () => { void stop(); });
  process.on("uncaughtException", (error) => { event("bridge.error", errorFields(error)); logger(safeError(error)); void stop(1); });
  return bridge;
}
