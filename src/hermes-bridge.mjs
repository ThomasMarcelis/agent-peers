// Private reply inboxes for Hermes. This process never writes a discovery registry entry: a
// conversation becomes reachable by sharing its address with a recipient, or by claiming a name.

import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { AppServer } from "./app-server.mjs";
import { Admission, Receipts, checkSocketPath, closeInbox, listenInbox, readMessage } from "./inbox.mjs";
import { errorFields, logEvent, logIdentity } from "./logging.mjs";
import { SCOPE, claim, claimAt, claimRefusal, claimRows, claimsOf, heldBy, holds, parseName, release, withClaims } from "./names.mjs";
import { Outbox, Pins, sendPeer } from "./outbox.mjs";
import { SendFailure, isError, readNameResolved } from "./status.mjs";
import {
  MAX_LINE, address, allPeers, claudeSessions, generation, inDiscoveryScope, peerSocket, processStart, socketDir, socketDirectories,
} from "./wire.mjs";

const QUEUE_MAX = 50, TOTAL_QUEUE_MAX = 200, SOURCES_MAX = 256, SESSIONS_MAX = 256, HANDOFFS_MAX = 256, CONTACTS_MAX = 256,
  CONVERSATIONS_MAX = 2 * SESSIONS_MAX, RETIRED_HANDOFF_MS = 60_000, NAME_INBOXES_MAX = 16;
const IDENTITY = /^hermes:[A-Za-z0-9:_-]+$/;
const START = processStart(process.pid);
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
  // The Hermes profile every name this bridge claims is scoped to; without one it claims none.
  #profile;

  constructor({ app = new AppServer(), emit = async () => {}, log = logger, profile } = {}) {
    this.#app = app;
    this.#emit = emit;
    this.#log = log;
    this.#profile = typeof profile === "string" && SCOPE.test(profile) ? profile : undefined;
  }

  #introduce(key) {
    if (this.#introduced.size >= 4096) this.#introduced.clear();
    this.#introduced.add(key);
  }

  #conversation(session) {
    let state = this.#conversations.get(session);
    if (state) return state;
    if (this.#conversations.size >= CONVERSATIONS_MAX) {
      // Only conversations without an inbox or a send in flight are evicted; those with an inbox
      // are bounded by SESSIONS_MAX, and a send keeps the pins it resolved against.
      const open = new Set([...this.#routes.values()].map((route) => route.session));
      for (const [key, value] of this.#conversations) if (!open.has(key) && !value.sending) { this.#conversations.delete(key); break; }
    }
    state = { pins: new Pins(), contacts: new Set(), admission: new Admission({ senders: SOURCES_MAX }), sending: 0 };
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
    const named = method === "claim_name" || method === "release_name";
    const fields = {
      operationId, method: ["list_peers", "send_peer", "claim_name", "release_name", "close_session"].includes(method) ? method : "unknown",
      ...(typeof params?.session === "string" ? { sessionId: logIdentity(params.session) } : {}),
      ...(typeof params?.to === "string" ? { targetId: logIdentity(params.to) } : {}),
      ...(named && typeof params?.name === "string" ? { targetId: logIdentity(params.name) } : {}),
      ...(typeof params?.message === "string" ? { bytes: Buffer.byteLength(params.message) } : {}),
    };
    event("tool.request", fields);
    try {
      const result = await this.#request(method, params, operationId);
      // A send Claude refused is a warning, as before; a refused claim or release failed.
      const failed = result.status === "failed" || (named && result.status === "refused");
      event("tool.result", {
        ...fields, durationMs: performance.now() - started,
        outcome: failed ? "error" : result.note || isError(result.status) ? "warning" : "success",
        ...(failed ? { reason: code(result.reason) } : {}),
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
    // A listing pins only the conversation that asked for it. It waits for that conversation's
    // other requests only when it has names to take back (#touch).
    if (method === "list_peers") {
      const session = params.session === undefined ? undefined : requiredString(params.session, "session", 512);
      if (session && this.#untouched(session, params)) await this.#serialized(session, () => this.#touch(session, params));
      return this.#listPeers(session);
    }
    if (!["send_peer", "claim_name", "release_name", "close_session"].includes(method)) throw new Error(`unknown method: ${method}`);
    const session = requiredString(params.session, "session", 512);
    return this.#serialized(session, async () => {
      if (method === "send_peer") {
        await this.#touch(session, { owner: params.owner, identity: params.name });
        return this.#send(session, params, operationId);
      }
      if (method !== "close_session") return this.#claimRequest(method, session, params);
      const routes = [...this.#routes.values()].filter((route) => route.session === session);
      await Promise.all(routes.map((route) => this.#retire(route)));
      this.#conversations.delete(session);
      return { closed: routes.length > 0 };
    });
  }

  // One conversation's requests run in order, so a close cannot race a send or a claim creating the
  // same route. Other conversations run concurrently.
  async #serialized(session, fn) {
    const previous = this.#locks.get(session) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(() => {
      if (this.#closed) throw new Error("Hermes bridge is closed");
      return fn();
    });
    this.#locks.set(session, operation);
    try {
      return await operation;
    } finally {
      if (this.#locks.get(session) === operation) this.#locks.delete(session);
    }
  }

  // Who claims for a conversation: the owner is its Hermes profile and conversation id, which
  // survive a gateway restart; the generation is its route, which does not. Its inboxes are
  // whichever this route has open.
  #claimant(session, owner, identity) {
    const addresses = [...this.#routes.values()].filter((route) => route.session === session).map((route) => route.address).slice(0, NAME_INBOXES_MAX);
    return { kind: "hermes", scope: this.#profile, owner: generation("hermes", this.#profile, owner), generation: generation("hermes", session),
      address: addresses[0] ?? null, holder: { pid: process.pid, procStart: START, autoName: identity, addresses } };
  }

  #untouched(session, { owner, identity } = {}) {
    return Boolean(this.#profile) && typeof owner === "string" && owner.length > 0 && owner.length <= 512 && typeof identity === "string" &&
      IDENTITY.test(identity) && identity.length <= 80 && this.#conversations.get(session)?.touched !== owner;
  }

  // The lazy re-claim. Route ids change at every gateway restart, so a conversation's next
  // agent-peers call takes back the names its conversation claimed (the same owner); and while a
  // route lives, its names follow the conversation id it now has, so compression cannot orphan
  // them. Once per route and conversation id.
  async #touch(session, params) {
    if (!this.#untouched(session, params)) return;
    const { owner, identity } = params, claimant = this.#claimant(session, owner, identity);
    let settled = true;
    for (const name of claimsOf({ owner: claimant.owner, generation: claimant.generation })) {
      // A name that cannot be refreshed now must never fail the call that triggered it.
      let result;
      try { result = await this.#claimName(session, owner, identity, name); }
      catch (error) { result = claimRefusal("conflict", safeError(error)); }
      if (result.status === "refused") settled = false;
      event("names.refresh", { sessionId: logIdentity(session), targetId: logIdentity(name),
        outcome: result.status === "refused" ? "failed" : "succeeded", ...(result.reason ? { reason: code(result.reason) } : {}) });
    }
    if (settled) this.#conversation(session).touched = owner;
  }

  // Claiming opens this route's inboxes in every verified socket directory first and records them,
  // because a Hermes conversation has no registry: the claim is the only way it is ever listed. A
  // directory that refuses an inbox is left out; with none at all, the claim is refused.
  async #claimName(session, owner, identity, name) {
    const refused = (text) => claimRefusal("inbox-unavailable", text, { name, kind: "hermes" });
    if ([...this.#routes.values()].some((route) => route.session === session && route.name !== identity)) {
      return refused("this conversation already belongs to a different Hermes identity");
    }
    this.#conversation(session);
    let failure;
    const directories = socketDirectories().slice(0, NAME_INBOXES_MAX);
    for (const directory of directories.length ? directories : [socketDir()]) {
      try { await this.#bind(session, identity, directory); }
      catch (error) { failure ??= error; }
    }
    const claimant = this.#claimant(session, owner, identity);
    if (!claimant.holder.addresses.length) return refused(failure?.message ?? "no socket directory is available for an inbox");
    return claim(name, claimant);
  }

  async #claimRequest(method, session, params) {
    const owner = requiredString(params.owner, "owner", 512), identity = requiredString(params.identity, "identity", 80);
    if (!IDENTITY.test(identity)) throw new Error("identity must identify a Hermes profile as hermes:<profile>");
    const name = requiredString(params.name, "name", 200);
    if (!this.#profile) return claimRefusal("scope-denied", "this agent-peers bridge was started without a Hermes profile, so it claims no names");
    try {
      // The scope is the profile, enforced here as well as in the plugin.
      const parsed = parseName(name, "hermes");
      await this.#touch(session, params);
      if (method === "release_name") {
        // Not even a dead name of another profile: it may be one that profile takes back after a restart.
        if (parsed.kind !== "hermes" || parsed.scope !== this.#profile) {
          return claimRefusal("scope-denied", `This Hermes profile releases only hermes:${this.#profile}/<claim> names, not ${parsed.name}.`,
            { name: parsed.name, kind: parsed.kind });
        }
        return release(name, this.#claimant(session, owner, identity));
      }
      if (parsed.kind !== "hermes" || parsed.scope !== this.#profile) return claim(name, this.#claimant(session, owner, identity));
      return await this.#claimName(session, owner, identity, parsed.name);
    } catch (error) {
      if (error instanceof SendFailure) return claimRefusal(error.reason, error.message);
      throw error;
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
    // Claimed names are the one way Hermes conversations appear here, with every other claim.
    const { rows, names } = inDiscoveryScope(() => ({ rows: withClaims(peers), names: claimRows() }));
    return {
      peers: rows.map((p) => ({
        name: p.name, kind: p.kind, cwd: p.cwd ?? null,
        status: live.get(p.threadId)?.status?.type ?? p.status ?? null, address: p.address, generation: p.generation, claims: p.claims,
      })),
      names,
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
    let added = false, introducing;
    const conversation = this.#conversation(session);
    conversation.sending++;
    const { result, text } = await sendPeer({
      to: params.to, message: params.message, inReplyTo: params.in_reply_to ?? undefined, pins: conversation.pins, fromName: name,
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
      // per conversation and recipient (the recipient keeps it in context), counted only once a
      // send wrote something.
      introduction: (target) => {
        const key = `${session}\0${target.address}`;
        if (this.#introduced.has(key)) return undefined;
        introducing = key;
        const names = heldBy("hermes", generation("hermes", session));
        return "(Hermes profile; notify_when_idle unavailable.)" +
          (names.length ? ` (Stable name${names.length > 1 ? "s" : ""}: ${names.join(", ")}.)` : "");
      },
    }).finally(() => { conversation.sending--; });
    // Claude saw the introduction only if the message was not refused or dropped.
    if (introducing && !isError(result.status)) this.#introduce(introducing);
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
      const resolved = readNameResolved(line);
      if (resolved) return this.#nameResolved(route, resolved);
      if (!route.outbox.receive(line)) drop("malformed");
      return;
    }
    const message = inDiscoveryScope(() => {
      const read = readMessage(line, [route.address]);
      // Only a claim this bridge verifies names the sender; a name the sender asserts is never shown.
      if (read) read.replyName = claimAt(read.from);
      return read;
    });
    if (!message) return drop("malformed");
    // The host needs an id even for a line without one; such a line cannot be deduplicated.
    const id = message.id ?? randomUUID();
    const fields = { sessionId, messageId: logIdentity(id), targetId: logIdentity(message.from), bytes: Buffer.byteLength(message.body) };
    const reply = (status, reason) => this.#receipts.send({ to: message.from, from: route.address, id: message.id, status, reason, optIn: message.ext.receipts });
    // Only peers this conversation wrote to may write to it (issue #28), and senders that used a name
    // it holds: they join its reply targets. Anyone else found the inbox in the socket directory.
    const conversation = this.#conversations.get(route.session);
    if (!conversation?.contacts.has(message.from)) {
      if (!conversation || !message.ext.toName || !holds(message.ext.toName, generation("hermes", route.session))) {
        reply("dropped", "not-a-reply-target");
        return drop("not_a_reply_target", fields);
      }
      this.#contact(route.session, message.from);
    }
    const notification = { method: "peer_message", params: {
      session: route.session, message_id: id, from: message.from, from_name: message.sender, message: message.body,
      ...(message.replyName ? { reply_name: message.replyName } : {}),
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

  // `agent-peers resolve`, run by the Claude session at `from` for a name this conversation holds:
  // that session may write first, as a send_peer to the name may. Nothing answers it.
  #nameResolved(route, { from, name }) {
    const sessionId = logIdentity(route.session), conversation = this.#conversations.get(route.session);
    const valid = conversation && inDiscoveryScope(() => from !== route.address && peerSocket(from) &&
      claudeSessions().some((session) => session.address === from) && holds(name, generation("hermes", route.session)));
    if (!valid) return event("receive.dropped", { sessionId, reason: "malformed" });
    this.#contact(route.session, from);
    event("receive.name_resolved", { sessionId, targetId: logIdentity(from) });
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
export function runHermesBridge({ profile } = {}) {
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
  const bridge = new HermesBridge({ emit: write, profile });
  const inFlight = new Set();
  let buffer = "", stopping = false, requests = 0;
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
  const handle = async (raw, parsed) => {
    let request, id = null;
    try {
      request = parsed ?? JSON.parse(raw);
      if (!request || typeof request !== "object" || Array.isArray(request) || typeof request.method !== "string" || request.method.length > 80) {
        throw new Error("expected {id, method, params}");
      }
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
      if (Buffer.byteLength(raw) + 1 > MAX_LINE) {
        event("bridge.error", { reason: "message_too_large", queueDepth: requests });
        logger("bridge input limit exceeded");
        void stop(1);
        return;
      }
      if (!raw.trim()) continue;
      let parsed;
      try { parsed = JSON.parse(raw); } catch {}
      const notification = parsed && typeof parsed === "object" && !Array.isArray(parsed) && !Object.hasOwn(parsed, "id");
      // The plugin's one notification needs no response and is handled at once, so a burst of
      // them never counts toward the limit on requests awaiting a response.
      if (notification && parsed.method === "delivery_result") {
        bridge.deliveryResult(parsed.params);
        continue;
      }
      const counted = Boolean(parsed && typeof parsed === "object" && Object.hasOwn(parsed, "id"));
      if (counted && requests >= IPC_QUEUE_MAX) {
        event("bridge.error", { reason: "queue_full", queueDepth: requests });
        logger("bridge input limit exceeded");
        void stop(1);
        return;
      }
      if (counted) requests++;
      const task = handle(raw, parsed)
        .catch((error) => { event("bridge.error", errorFields(error)); logger(safeError(error)); void stop(1); })
        .finally(() => { inFlight.delete(task); if (counted) requests--; });
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
