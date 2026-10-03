// Private reply inboxes for Hermes. This process never writes a discovery registry entry:
// a conversation becomes reachable only by sharing its address with a recipient.

import { createHash, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { AppServer } from "./app-server.mjs";
import {
  MAX_LINE, MAX_SOCKET_PATH, address, allPeers, messageLine, parseEnvelope, peerSocket, post, readLines,
} from "./wire.mjs";

const BUCKET = 30, REFILL_PER_S = 0.5, DEDUP_MS = 30_000, IDLE_MS = 600_000;
const QUEUE_MAX = 50, TOTAL_QUEUE_MAX = 200, SOURCES_MAX = 256, SESSIONS_MAX = 256;
const IPC_QUEUE_MAX = 128, IPC_WRITE_TIMEOUT_MS = 5000;
const logger = (message) => console.error(`[hermes-bridge ${process.pid}] ${message}`);

function requiredString(value, field, max = MAX_LINE) {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(`${field} must be a nonempty string of at most ${max} characters`);
  }
  return value;
}

function resolveTarget(to) {
  const peers = allPeers();
  if (to.startsWith("uds:")) {
    const socket = peerSocket(to);
    if (!socket) throw new Error("invalid peer inbox address; use an address from list_peers or a received message");
    return peers.find((p) => p.address === to) ?? { address: to, socket, name: to };
  }
  const exact = peers.filter((p) => p.name === to || p.name === `claude:${to}` || p.name === `codex:${to}`);
  const matches = exact.length ? exact : peers.filter((p) => p.name.includes(to));
  if (matches.length === 1) return matches[0];
  throw new Error(matches.length
    ? `"${to}" is ambiguous: ${matches.map((p) => `${p.name} (${p.address})`).join(", ")}`
    : `no live peer named "${to}"; call list_peers`);
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

  constructor({ app = new AppServer(), emit = async () => {}, log = logger } = {}) {
    this.#app = app;
    this.#emit = emit;
    this.#log = log;
  }

  async request(method, params = {}) {
    if (this.#closed) throw new Error("Hermes bridge is closed");
    if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("params must be an object");
    if (method === "list_peers") return this.#listPeers();
    if (method !== "send_peer" && method !== "close_session") throw new Error(`unknown method: ${method}`);
    const session = requiredString(params.session, "session", 512);
    // A close cannot race a send creating the same route. Other conversations remain independent.
    const previous = this.#locks.get(session) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      if (this.#closed) throw new Error("Hermes bridge is closed");
      if (method === "send_peer") return this.#send(session, params);
      const routes = [...this.#routes.values()].filter((route) => route.session === session);
      await Promise.all(routes.map((route) => this.#retire(route)));
      return { closed: routes.length > 0 };
    });
    this.#locks.set(session, operation);
    try {
      return await operation;
    } finally {
      if (this.#locks.get(session) === operation) this.#locks.delete(session);
    }
  }

  async #listPeers() {
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
    return {
      peers: peers.map((p) => ({
        name: p.name, kind: p.kind, cwd: p.cwd ?? null,
        status: live.get(p.threadId)?.status?.type ?? p.status ?? null, address: p.address,
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
    if (previous) {
      if (previous.name !== name) throw new Error("this conversation already belongs to a different Hermes identity");
      return previous;
    }
    if (this.#routes.size >= SESSIONS_MAX) throw new Error("too many open Hermes conversation inboxes");
    const socket = join(directory, `hermes-${randomUUID().replaceAll("-", "")}.sock`);
    if (Buffer.byteLength(socket) > MAX_SOCKET_PATH) {
      throw new Error("peer socket path exceeds the 103-byte Unix limit; use a shorter XDG_RUNTIME_DIR for all participating agents");
    }
    if (!peerSocket(address(socket))) throw new Error("unsafe Hermes reply inbox directory");
    const route = {
      key, session, name, socket, address: address(socket), closed: false, connections: new Set(),
      buckets: new Map(), recent: new Map(), pending: new Map(), queued: 0, chain: Promise.resolve(),
    };
    route.server = createServer((conn) => {
      if (route.closed || route.connections.size >= QUEUE_MAX) return conn.destroy();
      route.connections.add(conn);
      conn.once("close", () => route.connections.delete(conn));
      readLines(conn, (line) => this.#receive(route, line));
    });
    route.server.on("error", (error) => this.#log(`inbox error: ${error.message}`));
    try {
      await new Promise((resolve, reject) => {
        route.server.once("error", reject);
        // Never unlink before binding, even in the unlikely event of an address collision.
        route.server.listen(socket, () => { route.server.off("error", reject); resolve(); });
      });
      route.owner = lstatSync(socket);
      chmodSync(socket, 0o600);
      this.#routes.set(key, route);
    } catch (error) {
      route.closed = true;
      for (const conn of route.connections) conn.destroy();
      // Binding is not yet published in #routes: clean the listener even if stat or
      // chmod fails, otherwise close() cannot find it and the process stays alive.
      await new Promise((resolve) => route.server.close(resolve));
      throw error;
    }
    return route;
  }

  async #send(session, params) {
    const name = requiredString(params.name, "name", 80);
    if (!/^hermes:[A-Za-z0-9:_-]+$/.test(name)) throw new Error("name must identify a Hermes profile as hermes:<profile>");
    const to = requiredString(params.to, "to", 512);
    const message = requiredString(params.message, "message");
    const target = resolveTarget(to);
    const targetSocket = peerSocket(target.address);
    if (!targetSocket) throw new Error("the peer registry contains an invalid inbox address; call list_peers again");
    const route = await this.#bind(session, name, dirname(targetSocket));
    if (target.address === route.address) throw new Error("that address is this conversation's own inbox");
    // Claude labels every external envelope as another Claude session. Correct that frame.
    const body = target.kind === "codex" ? message : `${message}\n\n` +
      `(From ${name}, a Hermes profile with a private reply inbox. Use your peer messaging tool ` +
      `to reply to the sender address. Claude's notify_when_idle is unavailable for this peer.)`;
    const line = messageLine({ from: route.address, fromName: name, body });
    let finish, timer;
    const receipt = new Promise((resolve) => {
      finish = resolve;
      route.pending.set(line.msg_id, resolve);
      timer = setTimeout(() => resolve(undefined), 1500);
    });
    try {
      await post(targetSocket, line);
      const status = await receipt;
      const text = status === "held"
        ? `Delivered to ${target.name}'s inbox; its session is holding it for its user's approval.`
        : status && status !== "delivered" ? `Not delivered to ${target.name}: ${status}.`
          : `Delivered to ${target.name}'s inbox. Any reply arrives in this Hermes conversation.`;
      return { text, address: route.address, message_id: line.msg_id, ...(status ? { status } : {}) };
    } finally {
      clearTimeout(timer);
      route.pending.delete(line.msg_id);
      finish(undefined);
    }
  }

  #admit(route, from, body, id) {
    const now = Date.now();
    for (const [key, bucket] of route.buckets) if (now - bucket.at > IDLE_MS) route.buckets.delete(key);
    for (const [key, time] of route.recent) if (now - time > DEDUP_MS) route.recent.delete(key);
    if (!route.buckets.has(from) && route.buckets.size >= SOURCES_MAX) return false;
    const bucket = route.buckets.get(from) ?? { tokens: BUCKET, at: now };
    bucket.tokens = Math.min(BUCKET, bucket.tokens + (now - bucket.at) / 1000 * REFILL_PER_S);
    bucket.at = now;
    route.buckets.set(from, bucket);
    const bodyKey = createHash("sha256").update(from).update("\0").update(body).digest("hex");
    const idKey = `${from}\0${id}`;
    if (bucket.tokens < 1 || route.recent.has(bodyKey) || route.recent.has(idKey) ||
        route.queued >= QUEUE_MAX || this.#queued >= TOTAL_QUEUE_MAX) return false;
    bucket.tokens--;
    route.recent.set(bodyKey, now);
    route.recent.set(idKey, now);
    return true;
  }

  #receive(route, line) {
    if (route.closed || !line || typeof line !== "object") return;
    if (line.type === "control" && line.action === "peer_message_status") {
      if (typeof line.status === "string" && line.status.length <= 128) route.pending.get(line.orig_msg_id)?.(line.status);
      return;
    }
    if (line.type !== "user" || typeof line.message?.content !== "string") return;
    const env = parseEnvelope(line.message.content);
    if (!env || !peerSocket(env.from) || env.from === route.address || (line.from && line.from !== env.from)) return;
    const id = typeof line.msg_id === "string" && line.msg_id.length <= 256 && line.msg_id ? line.msg_id : randomUUID();
    if (!this.#admit(route, env.from, env.body, id)) return;
    route.queued++;
    this.#queued++;
    route.chain = route.chain.then(async () => {
      if (route.closed) return;
      await this.#emit({ method: "peer_message", params: {
        session: route.session, message_id: id, from: env.from,
        from_name: /^[A-Za-z0-9:_ .-]{1,80}$/.test(env.fromName ?? "") ? env.fromName : "an unnamed peer",
        message: env.body,
      } });
    }).catch((error) => this.#log(`incoming message delivery failed: ${error.message}`))
      .finally(() => { route.queued--; this.#queued--; });
  }

  async #retire(route) {
    route.closed = true;
    this.#routes.delete(route.key);
    for (const resolve of route.pending.values()) resolve("closed");
    route.pending.clear();
    for (const conn of route.connections) conn.destroy();
    let owned = false;
    try {
      const current = lstatSync(route.socket);
      owned = current.dev === route.owner.dev && current.ino === route.owner.ino;
    } catch (error) {
      if (error.code !== "ENOENT") this.#log(`cannot inspect inbox ownership: ${error.message}`);
    }
    if (owned) {
      // Node closes and unlinks a Unix listener by pathname; do not close it if somebody
      // replaced that pathname, because Node would also unlink their replacement.
      await new Promise((resolve) => route.server.close(resolve));
      try {
        const current = lstatSync(route.socket);
        if (current.dev === route.owner.dev && current.ino === route.owner.ino) rmSync(route.socket, { force: true });
      } catch {}
    } else {
      // No longer discoverable at our address; retain the inactive handle until process
      // exit rather than delete another owner's socket. It cannot keep the process alive.
      route.server.unref();
    }
    route.buckets.clear();
    route.recent.clear();
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
// messages and respects stream backpressure; diagnostic text goes to stderr.
export function runHermesBridge() {
  const write = (message) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("bridge output timed out"));
      void stop(1);
    }, IPC_WRITE_TIMEOUT_MS);
    process.stdout.write(JSON.stringify(message) + "\n", (error) => {
      clearTimeout(timer);
      if (error) reject(error); else resolve();
    });
  });
  const bridge = new HermesBridge({ emit: write });
  let buffer = "", queued = 0, chain = Promise.resolve(), stopping = false;
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
      logger(`bridge shutdown failed: ${error.message}`);
      code = 1;
    }
    process.exit(code);
  };
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (data) => {
    if (stopping) return;
    buffer += data;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const raw = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (Buffer.byteLength(raw) + 1 > MAX_LINE || queued >= IPC_QUEUE_MAX) {
        logger("bridge input limit exceeded");
        void stop(1);
        return;
      }
      if (!raw.trim()) continue;
      queued++;
      chain = chain.then(async () => {
        if (stopping) return;
        let request, id = null;
        try {
          request = JSON.parse(raw);
          if (!request || typeof request !== "object" || Array.isArray(request) ||
              !(typeof request.id === "string" && request.id.length > 0 && request.id.length <= 256 ||
                Number.isSafeInteger(request.id)) || typeof request.method !== "string" ||
              request.method.length > 80) {
            throw new Error("expected {id, method, params}");
          }
          id = request.id;
          if (request.method === "shutdown") {
            await write({ id, result: { closed: true } });
            await stop();
            return;
          }
          const result = await bridge.request(request.method, request.params);
          await write({ id, result });
        } catch (error) {
          await write({ id, error: { message: error.message } });
        }
      }).catch((error) => { logger(error.message); void stop(1); }).finally(() => queued--);
    }
    if (Buffer.byteLength(buffer) >= MAX_LINE) {
      logger("bridge input line too large");
      void stop(1);
    }
  });
  process.stdin.on("end", () => {
    if (buffer.trim()) {
      logger("incomplete bridge input at EOF");
      void stop(1);
    } else void chain.finally(() => stop());
  });
  process.stdin.on("error", () => { void stop(1); });
  process.stdout.on("error", () => { void stop(1); });
  process.once("SIGINT", () => { void stop(); });
  process.once("SIGTERM", () => { void stop(); });
  process.on("uncaughtException", (error) => { logger(error.message); void stop(1); });
  return bridge;
}
