// Minimal JSON-RPC client for the Codex app-server that hosts interactive Codex threads.
// Connections may reconnect after failure, but requests are never replayed: turn/start may
// already have taken effect even when the acknowledgement is lost.
import { VERSION } from "./version.mjs";
import { randomUUID } from "node:crypto";
import { errorFields, logEvent, logIdentity } from "./logging.mjs";
import { homedir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

// Requests the app-server sends only to the client that registered dynamic tools, supplied
// login tokens or attestation. agent-peers does none of these, so nobody else will answer them.
const UNSUPPORTED_REQUESTS = new Set(["item/tool/call", "account/chatgptAuthTokens/refresh", "attestation/generate"]);

export const daemonSocket = () =>
  process.env.AGENT_PEERS_CODEX_APP_SERVER ||
  join(process.env.CODEX_HOME || join(homedir(), ".codex"), "app-server-control", "app-server-control.sock");

export class AppServer {
  #connection;
  #closed = false;
  #next = 0;
  #onNotification;
  #options;

  constructor(onNotification, options = {}) {
    this.#onNotification = onNotification;
    this.#options = { handshakeTimeoutMs: 10_000, connectTimeoutMs: 5000, log: logEvent, ...options };
  }

  async request(method, params, timeoutMs = 15_000, context = {}) {
    const started = performance.now();
    const trace = { operationId: context.operationId ?? randomUUID(), method,
      threadId: logIdentity(params?.threadId) };
    this.#options.log("app-server", "rpc.request", { ...trace, outcome: "started" });
    try {
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("invalid app-server request timeout");
      const connection = this.#connect();
      await connection.ready;
      if (connection.failed || this.#closed) throw new Error("app-server connection closed");
      if (connection.pending.size >= 256) throw new Error("too many pending app-server requests");
      const result = await this.#request(connection, method, params, timeoutMs);
      this.#options.log("app-server", "rpc.request", { ...trace, outcome: "succeeded", durationMs: performance.now() - started });
      return result;
    } catch (error) {
      this.#options.log("app-server", "rpc.request", { ...trace, outcome: "failed", durationMs: performance.now() - started, ...errorFields(error) });
      throw error;
    }
  }

  #request(connection, method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      const id = ++this.#next;
      const settle = (error, result) => {
        clearTimeout(timer);
        connection.pending.delete(id);
        error ? reject(error) : resolve(result);
      };
      const timer = setTimeout(() => settle(new Error(`app-server ${method} timed out`)), timeoutMs);
      connection.pending.set(id, { resolve: (value) => settle(null, value), reject: (error) => settle(error) });
      try {
        connection.ws.send(JSON.stringify({ id, method, params }), (error) => {
          if (error) connection.fail(error);
        });
      } catch (error) { connection.fail(error); }
    });
  }

  #connect() {
    if (this.#closed) throw new Error("app-server client is closed");
    if (this.#connection) return this.#connection;
    const connection = { pending: new Map(), failed: false };
    this.#connection = connection;
    let resolveReady, rejectReady;
    connection.ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    connection.fail = (error) => {
      if (connection.failed) return;
      connection.failed = true;
      this.#options.log("app-server", "connection.closed", { outcome: this.#closed ? "closed" : "failed", ...errorFields(error) });
      if (this.#connection === connection) this.#connection = undefined;
      for (const pending of connection.pending.values()) pending.reject(error);
      connection.pending.clear();
      rejectReady(error);
      connection.ws?.terminate();
    };
    try {
      const ws = connection.ws = new WebSocket(`ws+unix://${daemonSocket()}:/`, {
        handshakeTimeout: this.#options.connectTimeoutMs, maxPayload: 4 * 1024 * 1024,
      });
      ws.on("open", async () => {
        try {
          await this.#request(connection, "initialize", {
            clientInfo: { name: "agent_peers", title: "agent-peers", version: VERSION },
          }, this.#options.handshakeTimeoutMs);
          if (connection.failed || this.#closed) return;
          ws.send(JSON.stringify({ method: "initialized" }), (error) => {
            if (error) connection.fail(error);
            else {
              this.#options.log("app-server", "connection.ready", { outcome: "succeeded" });
              resolveReady();
            }
          });
        } catch (error) { connection.fail(error); }
      });
      ws.on("message", (data) => {
        let message;
        try {
          message = JSON.parse(data.toString());
          if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error();
        } catch { connection.fail(new Error("invalid app-server JSON response")); return; }
        if (typeof message.method === "string") {
          if (Object.hasOwn(message, "id")) this.#answer(connection, message);
          try { this.#onNotification?.(message); } catch { /* Consumer callbacks cannot break RPC cleanup. */ }
          return;
        }
        const pending = connection.pending.get(message.id);
        if (!pending) return;
        if (message.error && typeof message.error === "object") {
          pending.reject(Object.assign(new Error(String(message.error.message ?? "app-server request failed")), { code: message.error.code }));
        } else if (Object.hasOwn(message, "result")) pending.resolve(message.result);
        else connection.fail(new Error("invalid app-server RPC response"));
      });
      ws.on("error", connection.fail);
      ws.on("close", () => connection.fail(new Error("app-server connection closed")));
    } catch (error) { connection.fail(error); }
    return connection;
  }

  // Server-to-client requests fan out to every client subscribed to a thread, and the first
  // answer wins (the server then sends serverRequest/resolved). Approvals and user input are
  // therefore never answered here: a turn that needs approval waits for a human's client, and
  // a fast refusal from us would override them. Only requests for capabilities this client
  // never sets up (dynamic tools, login tokens, attestation) are answered, as unsupported.
  #answer(connection, message) {
    const unsupported = UNSUPPORTED_REQUESTS.has(message.method);
    this.#options.log("app-server", "server_request", { method: unsupported ? message.method : "unknown",
      outcome: unsupported ? "rejected" : "skipped" });
    if (!unsupported) return;
    try {
      connection.ws.send(JSON.stringify({ id: message.id, error: { code: -32601, message: `agent-peers does not provide ${message.method}` } }),
        (error) => { if (error) connection.fail(error); });
    } catch (error) { connection.fail(error); }
  }

  close() {
    this.#closed = true;
    this.#connection?.fail(new Error("app-server client is closed"));
  }

  async loadedThreads() {
    const ids = [], cursors = new Set();
    let cursor;
    do {
      const result = await this.request("thread/loaded/list", cursor ? { cursor } : {});
      if (!result || !Array.isArray(result.data) || result.data.some((id) => typeof id !== "string")) {
        throw new Error("invalid app-server loaded-thread list");
      }
      ids.push(...result.data);
      cursor = result.nextCursor;
      if (ids.length > 10_000 || cursors.size >= 1000 || (cursor && (typeof cursor !== "string" || cursors.has(cursor)))) {
        throw new Error("invalid app-server loaded-thread pagination");
      }
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return [...new Set(ids)];
  }

  // A loaded thread's live MCP connections, each with the serverInfo its server advertised.
  async mcpServers(threadId, serverName) {
    const result = await this.request("mcpServerStatus/list", { threadId, serverName, detail: "toolsAndAuthOnly" }, 5000);
    if (!result || !Array.isArray(result.data)) throw new Error("invalid app-server MCP status response");
    return result.data;
  }

  async readThread(threadId) {
    const result = await this.request("thread/read", { threadId });
    if (!result?.thread || typeof result.thread !== "object" || Array.isArray(result.thread)) {
      throw new Error("invalid app-server thread response");
    }
    return result.thread;
  }
}
