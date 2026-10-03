// Minimal JSON-RPC client for the Codex app-server that hosts interactive Codex threads.
// The daemon speaks WebSocket over a Unix socket; messages omit the "jsonrpc" field.

import { homedir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

export const daemonSocket = () =>
  process.env.AGENT_PEERS_CODEX_APP_SERVER ||
  join(process.env.CODEX_HOME || join(homedir(), ".codex"), "app-server-control", "app-server-control.sock");

export class AppServer {
  #ws;
  #ready;
  #next = 0;
  #pending; // pending requests of the current connection only
  #onNotification;

  constructor(onNotification) {
    this.#onNotification = onNotification;
  }

  request(method, params, timeoutMs = 15_000) {
    return this.#connect().then(
      () =>
        new Promise((resolve, reject) => {
          const id = ++this.#next;
          const pending = this.#pending;
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`app-server ${method} timed out`));
          }, timeoutMs);
          pending.set(id, { resolve: (v) => (clearTimeout(timer), resolve(v)), reject: (e) => (clearTimeout(timer), reject(e)) });
          this.#ws.send(JSON.stringify({ id, method, params }));
        }),
    );
  }

  #connect() {
    if (this.#ready) return this.#ready;
    const pending = new Map();
    const ready = (this.#ready = new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws+unix://${daemonSocket()}:/`, { handshakeTimeout: 5000 });
      ws.on("open", () => {
        this.#ws = ws;
        this.#pending = pending;
        const handshake = setTimeout(() => ws.terminate(), 10_000);
        const id = ++this.#next;
        pending.set(id, {
          resolve: () => {
            clearTimeout(handshake);
            ws.send(JSON.stringify({ method: "initialized" }));
            resolve();
          },
          reject,
        });
        ws.send(JSON.stringify({
          id,
          method: "initialize",
          params: { clientInfo: { name: "agent_peers", title: "agent-peers", version: "0.1.0" } },
        }));
      });
      ws.on("message", (data) => {
        let m;
        try {
          m = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (m.method) return void this.#onNotification?.(m);
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        if (m.error) p.reject(Object.assign(new Error(m.error.message), { code: m.error.code }));
        else p.resolve(m.result);
      });
      const fail = (err) => {
        if (this.#ready === ready) this.#ready = undefined;
        for (const p of pending.values()) p.reject(err);
        pending.clear();
        reject(err);
      };
      ws.on("error", fail);
      ws.on("close", () => fail(new Error("app-server connection closed")));
    }));
    return ready;
  }

  async loadedThreads() {
    const ids = [];
    let cursor;
    do {
      const r = await this.request("thread/loaded/list", cursor ? { cursor } : {});
      ids.push(...r.data);
      cursor = r.nextCursor;
    } while (cursor);
    return ids;
  }

  readThread(threadId) {
    return this.request("thread/read", { threadId }).then((r) => r.thread);
  }
}
