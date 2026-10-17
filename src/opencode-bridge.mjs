// The opencode bridge: one stdio child per opencode server process, shared by every plugin
// instance through opencode/server.mjs. It owns the opencode-specific parts only: resolving the
// caller's root session through the plugin's host client, the exclusive bind record and inbox,
// synthetic delivery with its revert guard, and the four tools. Framing, admission, receipts,
// names and discovery are the shared modules.
//
// The protocol is internal (docs/reference.md, "opencode subprocess protocol"): newline-delimited
// JSON, one message per line, maximum 4 MiB per line. Plugin requests use p- ids, bridge requests
// b- ids. There is no bind, unbind, shutdown or host.notice method: stdin is the lifecycle.

import { randomUUID, createHash } from "node:crypto";
import { linkSync, lstatSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { frame } from "./frame.mjs";
import { Admission, Receipts, checkSocketPath, closeInbox, listenInbox, ownsSocket, readMessage } from "./inbox.mjs";
import { errorFields, logEvent, logIdentity } from "./logging.mjs";
import {
  claim, claimAt, claimRefusal, claimRows, claimsOf, heldBy, holds, release, withClaims,
} from "./names.mjs";
import { Outbox, Pins, sendPeer } from "./outbox.mjs";
import { SendFailure, isError, sendResult } from "./status.mjs";
import { codexDiscovery, formatCodexPeer, formatName } from "./discovery.mjs";
import {
  allPeers, address, ensurePrivateDir, generation, inDiscoveryScope, peerSocket, peersHome,
  processStart, readPeerFile, readPeerRecord, recordRunning, socketDir, validSessionId,
} from "./wire.mjs";
import { VERSION } from "./version.mjs";

export const PROTOCOL = 1;
export const ROOTS_MAX = 64;
export const PROTOCOL_MAX_LINE = 4 * 1024 * 1024;
const CONNECTION_MAX = 32, QUEUE_MAX = 50, QUEUE_BYTES_MAX = 8_000_000, DEFAULT_HOST_TIMEOUT_MS = 20_000;
const START = processStart(process.pid);

// bridge token -> root, for bridges in this process. A record owned by this pid/start is stale
// only when its token is not in this map; another live bridge in the same process (tests, or a
// future host that loads two plugin servers in one process) is never mistaken for stale.
const liveBridges = new Map();

const log = (event, fields = {}) => logEvent("opencode-bridge", event, fields);
const code = (reason) => reason?.replaceAll("-", "_");
const shortHash = (id) => createHash("sha256").update(id).digest("hex");

// A protocol/host failure with the one error-code table of docs/design/opencode.md §6.2.
export class BridgeError extends Error {
  constructor(code, message, { retryable = false } = {}) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

// A root's automatic name: the directory, then the title, then "session"; at most 64 label
// characters; short is the first 6 hex digits of sha256(root session id). No "/" ever appears.
export function opencodeName(sessionID, info) {
  const label = slug(info?.location?.directory ?? "") || slug(info?.title ?? "") || "session";
  return `opencode:${label.slice(0, 64)}-${shortHash(sessionID).slice(0, 6)}`;
}

// The deterministic peer inbox path. The hash includes no session text in the path.
export const opencodeSocket = (sessionID) => join(socketDir(), `opencode-${shortHash(sessionID).slice(0, 16)}.sock`);

function slug(text) {
  return basename(String(text ?? "")).replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
}

const idle = (info) => {
  const time = info?.time;
  return Number.isFinite(time?.updated) && Number.isFinite(time?.idle) && time.idle >= time.updated;
};
const sameInode = (path, identity) => {
  try { const stat = lstatSync(path); return stat.dev === identity.dev && stat.ino === identity.ino; }
  catch { return false; }
};

// The plugin returns Session.Info; tolerate the SDK's small wrappers, but never guess a session.
function sessionInfo(value, expectedID) {
  const info = value?.session ?? value?.data ?? value;
  if (!info || typeof info !== "object" || Array.isArray(info) || info.id !== expectedID || !validSessionId(info.id)) return undefined;
  const location = typeof info.location === "string" ? { directory: info.location } : info.location;
  if (!location || typeof location !== "object" || typeof location.directory !== "string" || !location.directory) return undefined;
  if (info.parentID !== undefined && info.parentID !== null && !validSessionId(info.parentID)) return undefined;
  return { ...info, location };
}

const registryPath = (sessionID) => join(peersHome(), `opencode-${sessionID}.json`);

// A minimal JSON Schema check for the definitions in src/peer-tool-definitions.json: the four
// tool inputs are flat objects of bounded strings. Unknown arguments are refused.
export function validateToolArgs(definition, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return "arguments must be an object";
  const input = definition.input ?? {}, properties = input.properties ?? {};
  for (const key of Object.keys(args)) if (!Object.hasOwn(properties, key)) return `unknown argument ${JSON.stringify(key)}`;
  for (const key of input.required ?? []) if (args[key] === undefined) return `${key} is required`;
  for (const [key, schema] of Object.entries(properties)) {
    const value = args[key];
    if (value === undefined) continue;
    if (schema.type === "string" && typeof value !== "string") return `${key} must be a string`;
    if (typeof value !== "string") continue;
    if (schema.minLength !== undefined && value.length < schema.minLength) return `${key} must be at least ${schema.minLength} characters`;
    if (schema.maxLength !== undefined && value.length > schema.maxLength) return `${key} must be at most ${schema.maxLength} characters`;
  }
  return undefined;
}

export function loadToolDefinitions() {
  return JSON.parse(readFileSync(new URL("./peer-tool-definitions.json", import.meta.url), "utf8"));
}

export class OpencodeBridge {
  #send;
  #hostTimeoutMs;
  #admissionOptions;
  #queueMax;
  #queueBytesMax;
  #instances = new Map();
  #roots = new Map();
  #cache = new Map();
  #bindTasks = new Map();
  #room = Promise.resolve();
  #swept = false;
  #pending = new Map();
  #receipts;
  #closed = false;
  #closing;
  #sequence = 0;
  #definitions = loadToolDefinitions();
  #log;
  #publishHook;

  constructor({ send = async () => ({ result: undefined }), log: logger = log, hostTimeoutMs = DEFAULT_HOST_TIMEOUT_MS,
    admission = {}, queueMax = QUEUE_MAX, queueBytesMax = QUEUE_BYTES_MAX, publishHook } = {}) {
    this.#send = send;
    this.#log = logger;
    this.#hostTimeoutMs = hostTimeoutMs;
    this.#admissionOptions = admission;
    this.#queueMax = queueMax;
    this.#queueBytesMax = queueBytesMax;
    this.#publishHook = publishHook;
    this.#receipts = new Receipts(this.#log);
  }

  // hello is once per instance and does not update the location of an existing one.
  hello(params = {}) {
    const { instance, location } = params;
    if (typeof instance !== "string" || !instance || instance.length > 200) throw new BridgeError("invalid-request", "hello needs an instance id");
    if (!this.#instances.has(instance)) this.#instances.set(instance, { location: normalizeLocation(location) });
    this.#log("bridge.hello", { sessionId: logIdentity(instance) });
    return { v: PROTOCOL, version: VERSION, limits: { roots: ROOTS_MAX, lineBytes: PROTOCOL_MAX_LINE } };
  }

  // One tool call. The caller is resolved and its root bound before any tool logic runs, so a
  // refused bind can never reach a claim or a send.
  async tool(params = {}) {
    if (this.#closed) throw new BridgeError("bridge-closed", "the opencode bridge is closing");
    const { instance, name, sessionID, args } = params;
    try {
      if (typeof instance !== "string" || !this.#instances.has(instance)) throw new BridgeError("not-found", "this opencode plugin instance is no longer registered");
      if (typeof name !== "string" || !Object.hasOwn(this.#definitions, name)) {
        throw new BridgeError("invalid-request", `unknown tool ${JSON.stringify(String(name).slice(0, 80))}`);
      }
      if (!validSessionId(sessionID)) throw new BridgeError("invalid-request", "sessionID must be an opencode session id");
      const invalid = validateToolArgs(this.#definitions[name], args);
      if (invalid) throw new BridgeError("invalid-request", invalid);
      const caller = await this.#resolve(instance, sessionID);
      if (name === "list_peers") return await this.#list(caller);
      if (name === "send_peer") return await this.#sendPeer(caller, args);
      return this.#claimRequest(caller, name, args.name);
    } catch (error) {
      if (error instanceof BridgeError && ["invalid-request", "not-found", "host-rejected", "inbox-unavailable", "too-large", "host-lost"].includes(error.code)) {
        return this.#toolFailure(typeof name === "string" ? name : "", error.code, error.message);
      }
      throw error;
    }
  }

  // A notification: prompt binds roots, deleted/moved unbind, closed unregisters a plugin instance.
  async event(params = {}) {
    if (this.#closed) return;
    const { instance, type, sessionID } = params;
    if (typeof instance !== "string" || !this.#instances.has(instance)) return;
    if (type === "closed") {
      for (const root of [...this.#roots.values()]) if (root.instance === instance) await this.#unbind(root);
      this.#instances.delete(instance);
      this.#log("bridge.closed", { sessionId: logIdentity(instance) });
      return;
    }
    if (!validSessionId(sessionID)) return;
    if (type === "prompt") {
      // Only a root binds on its own prompt; a child's prompt binds nothing.
      try {
        const info = await this.#session(instance, sessionID);
        if (info.parentID != null) return;
        await this.#bind(sessionID, info, instance);
      } catch (error) {
        if (!(error instanceof BridgeError) || error.code !== "not-found") {
          this.#log("bridge.event", { sessionId: logIdentity(sessionID), outcome: "failed", reason: code(error.code ?? "host-lost") });
        }
      }
      return;
    }
    if (type === "deleted") {
      const root = this.#roots.get(sessionID);
      if (root) await this.#unbind(root);
      for (const [id, cached] of this.#cache) if (id === sessionID || cached.rootID === sessionID) this.#cache.delete(id);
      return;
    }
    if (type === "moved") {
      const root = this.#roots.get(sessionID);
      if (root) {
        // A late move from an instance that no longer owns the root never closes a newer bind.
        if (root.instance !== instance) return;
        await this.#unbind(root);
      }
      this.#cache.delete(sessionID);
      return;
    }
  }

  async close() {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#closing = (async () => {
      await Promise.allSettled([...this.#bindTasks.values()]);
      await Promise.all([...this.#roots.values()].map((root) => this.#unbind(root)));
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(Object.assign(new Error("the opencode bridge closed"), { code: "bridge-closed" }));
      }
      this.#pending.clear();
    })();
    return this.#closing;
  }

  // ---- identity and roots ----

  async #resolve(instance, sessionID) {
    let info, rootID, rootInfo;
    const cached = this.#cache.get(sessionID);
    if (cached) {
      info = cached.info;
      rootID = cached.rootID;
      rootInfo = cached.rootInfo;
    } else {
      info = await this.#session(instance, sessionID);
      let current = info, depth = 0;
      const seen = new Set([sessionID]);
      while (current.parentID != null) {
        if (++depth > 16) throw new BridgeError("not-found", "this opencode session has more than 16 parents");
        if (seen.has(current.parentID)) throw new BridgeError("not-found", "this opencode session has cyclic parentage");
        seen.add(current.parentID);
        current = await this.#session(instance, current.parentID);
      }
      rootID = current.id;
      rootInfo = current;
      if (rootID !== sessionID) this.#cache.set(sessionID, { rootID, info, rootInfo });
    }
    const root = await this.#bind(rootID, rootInfo, instance);
    root.lastActivity = Math.max(root.lastActivity, Date.now(), Number(rootInfo.time?.updated) || 0);
    return { session: info, root, subagent: rootID !== sessionID, name: rootID === sessionID ? root.name : opencodeName(sessionID, info) };
  }

  #bind(rootID, info, instance) {
    const previous = this.#bindTasks.get(rootID) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(() => this.#bindNow(rootID, info, instance));
    this.#bindTasks.set(rootID, task);
    return task.finally(() => {
      if (this.#bindTasks.get(rootID) === task) this.#bindTasks.delete(rootID);
    });
  }

  async #bindNow(rootID, info, instance) {
    if (this.#closed) throw new BridgeError("bridge-closed", "the opencode bridge is closing");
    if (!this.#swept) { this.#swept = true; this.#dropDeadOwners(); }
    for (let attempt = 0; attempt < 2; attempt++) {
      let root = this.#roots.get(rootID);
      if (root?.closing) {
        await root.closing;
        root = undefined;
      }
      if (root) {
        if (root.instance === instance && root.inbox && this.#owns(root) && ownsSocket(root.inbox)) {
          root.info = info;
          root.lastActivity = Math.max(root.lastActivity, Date.now(), Number(info.time?.updated) || 0);
          return root;
        }
        // Another location's plugin instance now serves this session: a move.
        await this.#unbind(root);
        root = undefined;
      }
      // Validate the deterministic path before evicting anything; a bad path must not cost
      // another root its bind.
      let socket;
      try {
        socket = opencodeSocket(rootID);
        checkSocketPath(socket);
      } catch (error) {
        throw new BridgeError("inbox-unavailable", error?.message ?? "the opencode inbox path is unusable");
      }
      // Host reads for eviction happen before the room lock; the lock then re-checks the cap and
      // only inserts, so a hung host never blocks every bind. Eviction itself uses the candidate
      // root's bind task and never holds the room lock while waiting for it.
      if (this.#roots.size >= ROOTS_MAX) {
        for (const candidate of await this.#findEviction(rootID)) {
          if (await this.#evictPrepared(candidate)) break;
        }
      }
      root = await this.#roomLock(async () => {
        if (this.#closed) throw new BridgeError("bridge-closed", "the opencode bridge is closing");
        const existing = this.#roots.get(rootID);
        if (existing) return existing;
        if (this.#roots.size >= ROOTS_MAX) {
          throw new BridgeError("inbox-unavailable",
            `this agent-peers bridge already serves ${ROOTS_MAX} opencode sessions and none is idle without claimed names; ` +
            "close idle sessions or release names, then retry");
        }
        const again = this.#roots.get(rootID);
        if (again) return again;
        const created = {
          sessionID: rootID, instance, name: opencodeName(rootID, info), cwd: info.location.directory, info,
          socket, address: address(socket), registry: registryPath(rootID), procStart: START,
          generation: generation("opencode", rootID, START), owner: generation("opencode", rootID), startedAt: Date.now(),
          token: randomUUID(),
          lastActivity: Math.max(Date.now(), Number(info.time?.updated) || 0), inbox: undefined, closing: undefined,
          publishing: true, admission: new Admission(this.#admissionOptions), pins: new Pins(), chain: Promise.resolve(),
          queued: 0, queuedBytes: 0,
        };
        created.outbox = new Outbox({ onLate: (late) => this.#notice(created, late), log: this.#log });
        this.#roots.set(rootID, created);
        return created;
      });
      if (root.instance !== instance) {
        await this.#unbind(root);
        continue;
      }
      if (root.inbox) {
        root.info = info;
        root.lastActivity = Math.max(root.lastActivity, Date.now(), Number(info.time?.updated) || 0);
        return root;
      }
      if (this.#closed) {
        this.#roots.delete(rootID);
        throw new BridgeError("bridge-closed", "the opencode bridge is closing");
      }
      try {
        await this.#publish(root);
        root.publishing = false;
        // The registry now names this process, so the session's names are refreshed right after it.
        this.#refreshClaims(root);
      } catch (error) {
        root.publishing = false;
        this.#roots.delete(rootID);
        throw error;
      }
      this.#log("inbox.bound", { sessionId: logIdentity(rootID), outcome: "succeeded" });
      return root;
    }
    throw new BridgeError("inbox-unavailable", "this opencode session is being moved by another plugin instance; retry");
  }

  // Serialize only the capacity decision and registry insertion, never the socket publish or a
  // host round trip.
  async #roomLock(fn) {
    const previous = this.#room;
    let release;
    this.#room = new Promise((resolve) => { release = resolve; });
    await previous;
    try { return await fn(); } finally { release(); }
  }

  // The exclusive bind seat. A missing record is created with link(); an existing one is replaced
  // only after its bridge is confirmed dead. The record is read back after publishing, and again
  // after the inbox is created; the socket exists only while this bridge's record does.
  async #publish(root) {
    const record = {
      name: root.name, address: root.address, addresses: [root.address], cwd: root.cwd, threadId: root.sessionID,
      pid: process.pid, procStart: root.procStart, token: root.token, generation: root.generation, startedAt: root.startedAt,
    };
    const temporary = join(peersHome(), `.opencode-${randomUUID()}.json`);
    let published = false, recordIdentity;
    liveBridges.set(root.token, root);
    try {
      ensurePrivateDir(peersHome());
      writeFileSync(temporary, JSON.stringify(record), { mode: 0o600, flag: "wx" });
      const temporaryStat = lstatSync(temporary);
      const publication = await this.#publishRecord(root, temporary, temporaryStat);
      published = true;
      recordIdentity = publication;
      const predecessor = publication.predecessor;
      if (!this.#owns(root)) throw new BridgeError("inbox-unavailable", "another bridge published this opencode session first; nothing was bound");
      let socketExists = false;
      try {
        const stat = lstatSync(root.socket);
        if (!stat.isSocket()) throw new BridgeError("inbox-unavailable", "the opencode inbox path exists but is not a socket; nothing was bound");
        socketExists = true;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      // A socket with no dead record behind it cannot be confirmed dead, so it is never replaced.
      if (socketExists && !predecessor) {
        throw new BridgeError("inbox-unavailable", "an unverified opencode inbox already exists at this path; remove it only after checking no opencode server uses it");
      }
      const inbox = await listenInbox(root.socket, {
        takeover: socketExists,
        maxConnections: CONNECTION_MAX,
        onRefused: (reason) => this.#log("message.receive", { outcome: "dropped", reason }),
        onError: (error) => this.#log("inbox.error", { outcome: "failed", ...errorFields(error) }),
        onLine: (line, current) => {
          if (this.#roots.get(root.sessionID) === root && !root.closing && this.#owns(root) && ownsSocket(current)) this.#receive(root, current, line);
        },
      });
      if (!this.#owns(root)) {
        await closeInbox(inbox);
        throw new BridgeError("inbox-unavailable", "the opencode registry changed while this bridge was binding; nothing was bound");
      }
      if (this.#roots.get(root.sessionID) !== root) {
        await closeInbox(inbox);
        throw new BridgeError("inbox-unavailable", "this opencode session was unbound while its inbox was being created");
      }
      root.inbox = inbox;
    } catch (error) {
      // Remove only the exact inode this bridge linked; a replacement record is never touched.
      if (published && recordIdentity && sameInode(root.registry, recordIdentity)) rmSync(root.registry, { force: true });
      if (liveBridges.get(root.token) === root) liveBridges.delete(root.token);
      if (error instanceof BridgeError) throw error;
      throw new BridgeError("inbox-unavailable", error?.message ?? "the opencode inbox could not be published");
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  // Publish the record without ever overwriting a live owner. A missing path is created with
  // link(); a dead record is moved aside and only replaced if its inode is still the one read,
  // then the replacement is linked in, which cannot overwrite a record another bridge published
  // meanwhile. A conflict leaves the other record in place and refuses.
  async #publishRecord(root, temporary, identity) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let existing, dev, ino, exists = false;
      try {
        const read = readPeerFile(root.registry);
        existing = read.record;
        dev = read.dev;
        ino = read.ino;
        exists = true;
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw new BridgeError("inbox-unavailable", "another process owns this opencode record and it cannot be verified; nothing was bound");
        }
      }
      // Test hook: lets a deterministic test hold two binders between the read and the link.
      if (this.#publishHook) await this.#publishHook({ root, existing, attempt });
      if (!exists) {
        try { linkSync(temporary, root.registry); }
        catch (error) { if (error.code === "EEXIST") continue; throw error; }
        return { predecessor: false, dev: identity.dev, ino: identity.ino };
      }
      if (recordRunning(existing)) {
        const sameProcess = existing.pid === process.pid && String(existing.procStart) === String(root.procStart);
        const liveOwner = sameProcess ? liveBridges.get(existing.token) : undefined;
        const anotherLiveBridge = liveOwner && liveOwner !== root && !liveOwner.closing;
        // This bridge's own live record may be replaced on a retry. A record from another live
        // bridge in this process is not stale, even though pid and procStart match.
        if (anotherLiveBridge || !sameProcess) {
          throw new BridgeError("inbox-unavailable",
            "this opencode session is already served by another opencode server; stop the other server or let it exit, then retry");
        }
      }
      const aside = join(peersHome(), `.opencode-${randomUUID()}.json`);
      try { renameSync(root.registry, aside); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      let stat;
      try { stat = lstatSync(aside); }
      catch (error) {
        rmSync(aside, { force: true });
        throw error;
      }
      if (stat.dev !== dev || stat.ino !== ino) {
        // The record changed after it was read; put the newer record back and refuse.
        try { linkSync(aside, root.registry); } catch {}
        rmSync(aside, { force: true });
        throw new BridgeError("inbox-unavailable", "another bridge replaced the opencode record while this bridge was binding; nothing was bound");
      }
      try {
        linkSync(temporary, root.registry);
      } catch (error) {
        try { rmSync(aside, { force: true }); } catch {}
        if (error.code === "EEXIST") {
          throw new BridgeError("inbox-unavailable", "another bridge published this opencode session first; nothing was bound");
        }
        throw error;
      }
      try { rmSync(aside, { force: true }); } catch {}
      return { predecessor: true, dev: identity.dev, ino: identity.ino };
    }
    throw new BridgeError("inbox-unavailable", "the opencode registry changed while this bridge was binding; nothing was bound");
  }

  #owns(root) {
    try {
      const entry = readPeerRecord(root.registry);
      return entry.pid === process.pid && String(entry.procStart) === String(root.procStart) && entry.token === root.token &&
        entry.threadId === root.sessionID && entry.generation === root.generation && entry.address === root.address;
    } catch { return false; }
  }

  // A hard-killed bridge leaves a record and its deterministic socket. A new bridge removes only
  // records whose process is confirmed dead, and only sockets whose name is the deterministic one
  // the record describes; a live owner is never touched.
  #dropDeadOwners() {
    let files;
    try { files = readdirSync(peersHome()); } catch { return; }
    for (const file of files.filter((name) => /^(?:\.opencode-[0-9a-f-]{36}|opencode-[A-Za-z0-9_-]+)\.json$/.test(name))) {
      const path = join(peersHome(), file);
      try {
        const read = readPeerFile(path);
        const entry = read.record;
        if (!validSessionId(entry.threadId) || recordRunning(entry)) continue;
        if (!file.startsWith(".") && file !== `opencode-${entry.threadId}.json`) continue;
        // Re-check this exact inode before removing anything. Another server starting at the same
        // time may have replaced the dead record after the read above.
        const stillOurs = () => {
          try { const stat = lstatSync(path); return stat.dev === read.dev && stat.ino === read.ino; }
          catch { return false; }
        };
        // A live registry for the same root owns the deterministic socket; an old aside copy must
        // not remove it.
        let liveRegistry = false;
        if (file.startsWith(".")) {
          try { liveRegistry = recordRunning(readPeerRecord(join(peersHome(), `opencode-${entry.threadId}.json`))); } catch {}
        }
        const expected = `opencode-${shortHash(entry.threadId).slice(0, 16)}.sock`;
        if (!liveRegistry) {
          const addresses = [entry.address, ...(Array.isArray(entry.addresses) ? entry.addresses.slice(0, 16) : [])];
          for (const addr of addresses) {
            const socket = peerSocket(addr);
            if (socket && basename(socket) === expected && stillOurs()) rmSync(socket, { force: true });
          }
        }
        if (stillOurs()) rmSync(path, { force: true });
      } catch {}
    }
  }

  #refreshClaims(root) {
    const claimant = this.#claimant(root);
    for (const name of claimsOf({ owner: claimant.owner })) {
      try {
        const result = claim(name, claimant);
        this.#log("names.refresh", { sessionId: logIdentity(root.sessionID), targetId: logIdentity(name),
          outcome: result.status === "refused" ? "failed" : "succeeded", ...(result.reason ? { reason: code(result.reason) } : {}) });
      } catch (error) {
        this.#log("names.refresh", { sessionId: logIdentity(root.sessionID), targetId: logIdentity(name), outcome: "failed", ...errorFields(error) });
      }
    }
  }

  #claimant(root) {
    return {
      kind: "opencode", owner: root.owner, generation: root.generation, address: root.address,
      holder: { pid: process.pid, procStart: root.procStart, autoName: root.name, threadId: root.sessionID, addresses: [root.address] },
    };
  }

  async #unbind(root) {
    if (root.closing) return root.closing;
    if (this.#roots.get(root.sessionID) === root) this.#roots.delete(root.sessionID);
    for (const [id, cached] of this.#cache) if (cached.rootID === root.sessionID) this.#cache.delete(id);
    root.closing = (async () => {
      if (root.inbox) await closeInbox(root.inbox);
      try { if (this.#owns(root)) rmSync(root.registry, { force: true }); } catch {}
      if (liveBridges.get(root.token) === root) liveBridges.delete(root.token);
      root.admission.clear();
      this.#log("inbox.unbound", { sessionId: logIdentity(root.sessionID), outcome: "closed" });
    })();
    return root.closing;
  }

  // At the cap, only an idle root (time.idle is present and >= time.updated), with no claimed
  // names and no queued delivery, is evictable. Host state is read outside the room lock; the
  // candidate's own bind task performs the final re-check and close.
  async #findEviction(incoming) {
    const candidates = [...this.#roots.values()].filter((root) => root.sessionID !== incoming && !root.closing && !root.publishing)
      .sort((a, b) => a.lastActivity - b.lastActivity);
    const prepared = [];
    for (const candidate of candidates) {
      if (candidate.queued > 0 || heldBy("opencode", candidate.generation).length) continue;
      try {
        const info = await this.#session(candidate.instance, candidate.sessionID);
        if (idle(info)) prepared.push({ candidate, info });
      } catch (error) {
        // A session the host no longer has is safe to close; an unanswered host is not evidence.
        if (error instanceof BridgeError && error.code === "not-found") prepared.push({ candidate, gone: true });
      }
    }
    return prepared;
  }

  #evictPrepared({ candidate, info, gone }) {
    const previous = this.#bindTasks.get(candidate.sessionID) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      if (this.#roots.get(candidate.sessionID) !== candidate || candidate.closing) return false;
      if (this.#roots.size < ROOTS_MAX) return true;
      if (candidate.queued > 0 || heldBy("opencode", candidate.generation).length) return false;
      if (!gone && !idle(info)) return false;
      if (!gone) {
        candidate.info = info;
        candidate.lastActivity = Math.max(candidate.lastActivity, Number(info.time?.updated) || 0);
      }
      await this.#unbind(candidate);
      this.#log("opencode.bind.cap", { sessionId: logIdentity(candidate.sessionID), outcome: "evicted" });
      return true;
    });
    this.#bindTasks.set(candidate.sessionID, task);
    return task.finally(() => {
      if (this.#bindTasks.get(candidate.sessionID) === task) this.#bindTasks.delete(candidate.sessionID);
    });
  }

  // ---- host calls ----

  async #session(instance, sessionID) {
    const value = await this.#host("host.session", { instance, sessionID });
    const info = sessionInfo(value, sessionID);
    if (!info) throw new BridgeError("not-found", "the opencode host does not have this session");
    return info;
  }

  async #host(method, params) {
    let response;
    try {
      response = await this.#send({ v: PROTOCOL, id: `b-${++this.#sequence}`, method, params });
    } catch (error) {
      if (error?.code === "ETIMEDOUT") throw new BridgeError("host-lost", "the opencode host did not answer; nothing was confirmed");
      throw new BridgeError("bridge-closed", error?.message ?? "the opencode host connection is closed", { retryable: true });
    }
    if (response?.error) {
      const failure = response.error;
      throw new BridgeError(failure.code ?? "host-rejected", failure.message ?? "the opencode host refused the request",
        { retryable: failure.retryable === true });
    }
    return response?.result;
  }

  // ---- tools ----

  #toolFailure(name, reason, message) {
    // Only a host not-found means this caller has no session. A timed-out/lost host call is
    // unavailability, not evidence that the session does not exist.
    const publicReason = reason === "not-found" ? "no-session" : reason === "host-lost" ? "bridge-unavailable" : reason;
    if (name === "send_peer") return { text: message, structuredContent: sendResult({ reason: publicReason }), isError: true };
    if (name === "claim_name" || name === "release_name") {
      return { text: message, structuredContent: claimRefusal(publicReason, message), isError: true };
    }
    return { text: message, structuredContent: { status: "failed", reason: publicReason, text: message, peers: [], self: null, names: [] }, isError: true };
  }

  async #list({ session, root, subagent, name }) {
    const self = {
      name, kind: "opencode", address: root.address, addresses: [root.address], generation: root.generation,
      threadId: root.sessionID, sessionID: session.id, subagent: subagent, claims: heldBy("opencode", root.generation),
    };
    const { peers, names } = inDiscoveryScope(() => ({
      // Same caller-relative discovery and row shape as Codex: native/bridge fields, self excluded.
      peers: codexDiscovery(withClaims(allPeers()), [], { ...self, rootId: root.sessionID }),
      names: claimRows(),
    }));
    root.pins.noteRows(peers);
    const lines = [`You are ${name}.`];
    for (const peer of peers) lines.push(formatCodexPeer(peer));
    if (!peers.length) lines.push("No other agents found.");
    if (names.length) lines.push("Claimed names:", ...names.map((row) => `  ${formatName(row, { sendPeer: true })}`));
    return {
      text: lines.join("\n"), isError: false,
      structuredContent: { peers, self, names },
    };
  }

  async #sendPeer({ root, name: callerName }, { to, message, in_reply_to: inReplyTo }) {
    if (!root.inbox || !this.#owns(root) || !ownsSocket(root.inbox)) {
      return { text: "this opencode inbox was replaced; call list_peers again", structuredContent: sendResult({ reason: "inbox-unavailable" }), isError: true };
    }
    const out = await sendPeer({
      to, message, inReplyTo,
      pins: root.pins, fromName: callerName, generation: root.generation,
      route: async () => ({ from: root.address, outbox: root.outbox }),
    });
    return { text: out.text, structuredContent: out.result, isError: isError(out.result.status) };
  }

  #claimRequest(caller, action, name) {
    const { root, subagent } = caller;
    // A child session sends under its root and holds no names of its own, exactly as a Codex
    // subagent does.
    if (subagent) {
      const text = "a subagent sends under its root session and holds no names; ask the root agent to claim it.";
      return { text, structuredContent: claimRefusal("no-session", text), isError: true };
    }
    let result;
    try {
      result = action === "claim_name" ? claim(name, this.#claimant(root)) : release(name, this.#claimant(root));
    } catch (error) {
      if (!(error instanceof SendFailure)) throw error;
      result = claimRefusal(error.reason, error.message);
    }
    return { text: result.text, structuredContent: result, isError: result.status === "refused" };
  }

  // ---- inbound delivery ----

  #receive(root, inbox, line) {
    if (!line || typeof line !== "object") return;
    if (line.type === "control") { root.outbox.receive(line); return; }
    const message = inDiscoveryScope(() => readMessage(line, [root.address]));
    if (!message) return this.#log("message.receive", { outcome: "dropped", reason: "malformed_envelope" });
    root.lastActivity = Math.max(root.lastActivity, Date.now());
    const bytes = Buffer.byteLength(message.body);
    const trace = { operationId: randomUUID(), messageId: logIdentity(message.id ?? undefined), sessionId: logIdentity(root.sessionID),
      targetId: logIdentity(message.from), bytes };
    const reply = (status, reason) => this.#receipts.send({
      to: message.from, from: inbox.address, id: message.id, status, reason, optIn: message.ext.receipts,
    });
    if (message.ext.toName && !inDiscoveryScope(() => holds(message.ext.toName, root.generation))) {
      reply("dropped", "not-a-reply-target");
      return this.#log("message.receive", { ...trace, outcome: "dropped", reason: "not_a_reply_target" });
    }
    const reason = root.admission.admit(message.from, message.id, {
      full: root.queued >= this.#queueMax || root.queuedBytes + bytes > this.#queueBytesMax,
    });
    // A repeated id gets no receipt: the first copy's outcome stands.
    if (reason === "duplicate") return this.#log("message.receive", { ...trace, outcome: "dropped", reason });
    if (reason) {
      reply("dropped", reason);
      return this.#log("message.receive", { ...trace, outcome: "dropped", reason: code(reason) });
    }
    message.replyName = inDiscoveryScope(() => claimAt(message.from));
    root.pins.noteSender(message.from, message.ext.generation);
    reply("queued");
    root.queued++;
    root.queuedBytes += bytes;
    this.#log("message.receive", { ...trace, outcome: "queued", count: root.queued });
    root.chain = root.chain.then(async () => {
      if (this.#roots.get(root.sessionID) !== root || root.closing || !this.#owns(root) || !ownsSocket(root.inbox)) {
        reply("dropped", "inbox-closed");
        return this.#log("message.deliver", { ...trace, outcome: "skipped", reason: "inbox_closed" });
      }
      // The bridge checks the staged revert itself: synthetic never commits a revert, but it is
      // also the only path that cannot. A host not-found is the caller's own session, not a peer.
      let info;
      try { info = await this.#session(root.instance, root.sessionID); }
      catch (error) {
        if (error instanceof BridgeError && error.code === "not-found") {
          reply("dropped", "inbox-closed");
          await this.#unbind(root);
        }
        // A lost or timed-out host call sends no receipt: the message may still land.
        return this.#log("message.deliver", { ...trace, outcome: "failed", ...errorFields(error) });
      }
      if (info.revert) {
        reply("dropped", "host-rejected");
        return this.#log("message.deliver", { ...trace, outcome: "dropped", reason: "host_rejected" });
      }
      try {
        await this.#host("host.synthetic", {
          instance: root.instance, sessionID: root.sessionID, text: frame(message), delivery: "steer", resume: true,
          description: "agent-peers peer message", metadata: { source: "agent-peers" },
        });
        reply("accepted");
        this.#log("message.deliver", { ...trace, outcome: "accepted" });
      } catch (error) {
        if (error instanceof BridgeError && error.code === "not-found") {
          reply("dropped", "inbox-closed");
          await this.#unbind(root);
        } else if (error instanceof BridgeError && (error.code === "host-rejected" || error.code === "too-large")) {
          reply("dropped", error.code);
        }
        // Everything else is a lost host call: no receipt, and never a retry.
        this.#log("message.deliver", { ...trace, outcome: "failed", ...errorFields(error) });
      }
    }).catch((error) => this.#log("message.deliver", { ...trace, outcome: "failed", ...errorFields(error) }))
      .finally(() => { root.queued--; root.queuedBytes -= bytes; });
  }

  // Late outcomes are appended without starting a turn. resume:false never commits or wakes, so
  // this path needs no revert guard and is never retried.
  #notice(root, late) {
    (root.notices ??= []).push(late);
    if (root.notices.length > 1) return;
    setTimeout(async () => {
      const batch = root.notices.splice(0);
      if (this.#roots.get(root.sessionID) !== root || root.closing) return;
      const items = batch.slice(0, 5).map((n) => `your message ${n.id} to ${n.name} ` + (n.status === "held"
        ? "is held for its user's approval and not delivered yet"
        : `was not delivered (${n.status}${n.reason ? `: ${n.reason}` : ""}); do not wait for a reply`));
      const text = `agent-peers delivery notice, not user input: ${items.join("; ")}${batch.length > 5 ? `; and ${batch.length - 5} more` : ""}.`;
      try {
        await this.#host("host.synthetic", {
          instance: root.instance, sessionID: root.sessionID, text, delivery: "steer", resume: false,
          description: "agent-peers delivery notice", metadata: { source: "agent-peers" },
        });
        this.#log("delivery.notice", { sessionId: logIdentity(root.sessionID), outcome: "succeeded", count: batch.length });
      } catch (error) {
        this.#log("delivery.notice", { sessionId: logIdentity(root.sessionID), outcome: "failed", count: batch.length, ...errorFields(error) });
      }
    }, 500).unref();
  }
}

function normalizeLocation(location) {
  if (typeof location === "string") return { directory: location };
  if (location && typeof location === "object" && typeof location.directory === "string") return { directory: location.directory };
  return {};
}

// ---- stdio protocol ----

class ProtocolWriter {
  #write;
  constructor(write) { this.#write = write; }
  response(id, result) { return this.#write({ v: PROTOCOL, id, result }); }
  error(id, code, message, retryable = false) {
    return this.#write({ v: PROTOCOL, id, error: { code, message, retryable } });
  }
}

// Run the bridge on stdin/stdout. stdout is protocol only; diagnostics go to stderr and the
// diagnostic log. Requests run concurrently; per-root bind tasks keep each root's order.
export function runOpencodeBridge({ hostTimeoutMs = DEFAULT_HOST_TIMEOUT_MS } = {}) {
  const pending = new Map();
  let buffer = "", discarding = false, stopping = false;
  const write = (message) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error("bridge output timed out"), { code: "ETIMEDOUT" })), 5000);
    process.stdout.write(JSON.stringify(message) + "\n", (error) => {
      clearTimeout(timer);
      if (error) reject(error); else resolve();
    });
  });
  const writer = new ProtocolWriter(write);
  const send = (message) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(message.id);
      reject(Object.assign(new Error("opencode host did not answer"), { code: "ETIMEDOUT" }));
    }, hostTimeoutMs);
    pending.set(message.id, { resolve, reject, timer, at: Date.now() });
    write(message).catch((error) => {
      clearTimeout(timer);
      pending.delete(message.id);
      reject(error);
    });
  });
  const bridge = new OpencodeBridge({ send, hostTimeoutMs, log: (event, fields) => logEvent("opencode-bridge", event, fields) });
  const stop = async (exitCode = 0) => {
    if (stopping) return;
    stopping = true;
    process.stdin.pause();
    const deadline = setTimeout(() => process.exit(exitCode || 1), 5000);
    deadline.unref();
    try { await bridge.close(); }
    catch (error) { logEvent("opencode-bridge", "bridge.error", errorFields(error)); process.stderr.write(`agent-peers opencode-bridge: shutdown failed: ${error.message}\n`); exitCode = 1; }
    process.exit(exitCode);
  };
  const handleRequest = async (message, id) => {
    try {
      if (message.method === "hello") await writer.response(id, bridge.hello(message.params));
      else if (message.method === "tool") await writer.response(id, await bridge.tool(message.params));
      else await writer.error(id, "unknown-method", `unknown method ${JSON.stringify(String(message.method).slice(0, 80))}`);
    } catch (error) {
      const failure = error instanceof BridgeError ? error : new BridgeError("invalid-request", error?.message ?? "invalid request");
      await writer.error(id, failure.code, failure.message, failure.retryable);
    }
  };
  const handleLine = (raw) => {
    let message;
    try { message = JSON.parse(raw); }
    catch {
      void writer.error(null, "invalid-request", "malformed JSON");
      return;
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      void writer.error(null, "invalid-request", "expected one JSON object per line");
      return;
    }
    const id = Object.hasOwn(message, "id") ? message.id : undefined;
    if (id !== undefined) {
      if (typeof id === "string" && id.startsWith("b-")) {
        const entry = pending.get(id);
        if (!entry) return;
        clearTimeout(entry.timer);
        pending.delete(id);
        entry.resolve(message);
        return;
      }
      if (typeof id !== "string" || !id.startsWith("p-") || id.length > 256) {
        void writer.error(typeof id === "string" ? id : null, "invalid-request", "plugin request ids start with p-");
        return;
      }
    }
    if (message.v !== PROTOCOL) {
      void writer.error(id ?? null, "version-mismatch", `this bridge speaks protocol v${PROTOCOL}`);
      return;
    }
    if (message.method === "event" && id === undefined) {
      bridge.event(message.params).catch((error) => logEvent("opencode-bridge", "bridge.error", errorFields(error)));
      return;
    }
    if (id === undefined) {
      void writer.error(null, "invalid-request", "notifications must be event messages without an id");
      return;
    }
    handleRequest(message, id).catch((error) => {
      logEvent("opencode-bridge", "bridge.error", errorFields(error));
      process.stderr.write(`agent-peers opencode-bridge: ${error.message}\n`);
      void stop(1);
    });
  };
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (data) => {
    if (stopping) return;
    buffer += data;
    if (discarding) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) { buffer = ""; return; }
      buffer = buffer.slice(newline + 1);
      discarding = false;
    }
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const raw = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (Buffer.byteLength(raw) + 1 > PROTOCOL_MAX_LINE) { void writer.error(null, "too-large", "bridge line exceeds 4 MiB"); continue; }
      if (!raw.trim()) continue;
      handleLine(raw);
    }
    if (Buffer.byteLength(buffer) > PROTOCOL_MAX_LINE) {
      buffer = "";
      discarding = true;
      void writer.error(null, "too-large", "bridge line exceeds 4 MiB");
    }
  });
  process.stdin.on("end", () => {
    if (buffer.trim()) logEvent("opencode-bridge", "bridge.error", { reason: "malformed", outcome: "incomplete_frame" });
    void stop();
  });
  process.stdin.on("error", (error) => { logEvent("opencode-bridge", "bridge.error", errorFields(error)); void stop(1); });
  process.stdout.on("error", (error) => { logEvent("opencode-bridge", "bridge.error", errorFields(error)); void stop(1); });
  process.once("SIGINT", () => { void stop(); });
  process.once("SIGTERM", () => { void stop(); });
  process.on("uncaughtException", (error) => {
    logEvent("opencode-bridge", "bridge.error", errorFields(error));
    process.stderr.write(`agent-peers opencode-bridge: ${error.message}\n`);
    void stop(1);
  });
  // A response the host never reads is a lost call, not a reason to leak the pending entry.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of pending) {
      if (now - entry.at > 4 * hostTimeoutMs) { clearTimeout(entry.timer); pending.delete(id); entry.reject(Object.assign(new Error("opencode host did not answer"), { code: "ETIMEDOUT" })); }
    }
  }, 30_000);
  sweep.unref();
  return bridge;
}
