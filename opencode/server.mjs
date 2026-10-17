// The opencode v2 plugin. It is deliberately only an RPC and lifecycle adapter: it registers the
// four tool definitions from src/peer-tool-definitions.json, forwards the caller's session id and
// arguments to one stdio bridge child per opencode server, forwards prompt/deleted/moved/closed
// events, and executes host.session/host.synthetic requests. All routing, names, delivery,
// receipts, dedup, pins and registry state live in src/opencode-bridge.mjs.
//
// One child is shared by every location plugin instance in this server process through a
// version-keyed globalThis handle. The child's stdin is its lifecycle: the last instance closes
// it, and a killed server closes the pipe.

import { spawn } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { claimRefusal } from "../src/names.mjs";
import { logEvent } from "../src/logging.mjs";
import { sendResult } from "../src/status.mjs";
import { VERSION } from "../src/version.mjs";

const PACKAGE = dirname(dirname(fileURLToPath(import.meta.url)));
const HANDLE_KEY = Symbol.for("agent-peers.opencode.bridge.v1");
const PROTOCOL = 1;
const PLUGIN_ID = "agent-peers";
const TOOL_TIMEOUT_MS = 120_000, HELLO_TIMEOUT_MS = 10_000;
const NODE_FAILURE_MS = 30_000;
// The bridge's protocol line limit (src/opencode-bridge.mjs PROTOCOL_MAX_LINE).
const MAX_LINE = 4 * 1024 * 1024;
const DEFINITIONS = JSON.parse(readFileSync(new URL("../src/peer-tool-definitions.json", import.meta.url), "utf8"));
const HINT = "set AGENT_PEERS_NODE to a Node 22+ executable, or set the plugin option bridge_command to the bridge executable and its arguments";

const log = (event, fields = {}) => logEvent("opencode-plugin", event, fields);

class BridgeUnavailable extends Error {
  constructor(message, code = "bridge-unavailable") { super(message); this.code = code; }
}

export class BridgeClient {
  #command;
  #args;
  #env;
  #onRequest;
  #onExit;
  #child;
  #buffer = "";
  #pending = new Map();
  #sequence = 0;
  alive = false;

  constructor({ command, args, env, onRequest, onExit }) {
    this.#command = command;
    this.#args = args;
    this.#env = env;
    this.#onRequest = onRequest;
    this.#onExit = onExit;
  }

  start() {
    const child = spawn(this.#command, this.#args, { stdio: ["pipe", "pipe", "pipe"], env: this.#env });
    this.#child = child;
    this.alive = true;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (data) => this.#read(data));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (data) => {
      const text = data.trim();
      if (text) log("bridge.stderr", { outcome: "failed", reason: "other" });
    });
    child.once("error", (error) => this.#exit(error));
    // "close" fires after the child's stdio is closed too, so no buffered response is lost.
    child.once("close", (code, signal) => this.#exit(Object.assign(new Error(`bridge exited (${code ?? signal})`), { code: "bridge-closed" })));
    child.stdin.on("error", () => {});
    return this;
  }

  get pid() { return this.#child?.pid; }

  #read(data) {
    this.#buffer += data;
    let newline;
    while ((newline = this.#buffer.indexOf("\n")) >= 0) {
      const raw = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!raw.trim()) continue;
      let message;
      try { message = JSON.parse(raw); } catch { log("bridge.message", { outcome: "dropped", reason: "invalid_input" }); continue; }
      const id = message?.id;
      if (typeof id === "string" && id.startsWith("p-")) {
        const pending = this.#pending.get(id);
        if (!pending) continue;
        clearTimeout(pending.timer);
        this.#pending.delete(id);
        if (message.error) pending.reject(Object.assign(new Error(message.error.message ?? message.error.code ?? "bridge error"),
          { code: message.error.code ?? "bridge-unavailable" }));
        else pending.resolve(message.result);
        continue;
      }
      if (typeof id === "string" && id.startsWith("b-")) {
        Promise.resolve()
          .then(() => this.#onRequest(message))
          .then((result) => this.#write({ v: PROTOCOL, id, result }))
          .catch((error) => this.#write({ v: PROTOCOL, id, error: {
            code: typeof error?.code === "string" && error.code.includes("-") ? error.code : "host-rejected",
            message: error?.message ?? "the plugin could not serve the request",
          } }))
          .catch(() => {});
        continue;
      }
      log("bridge.message", { outcome: "dropped", reason: "invalid_input" });
    }
  }

  #write(message) {
    if (!this.alive || !this.#child?.stdin.writable) return Promise.reject(new BridgeUnavailable("the opencode bridge is not running"));
    return new Promise((resolve, reject) => {
      this.#child.stdin.write(JSON.stringify(message) + "\n", (error) => error ? reject(error) : resolve());
    });
  }

  request(method, params, timeoutMs = TOOL_TIMEOUT_MS, { signal } = {}) {
    const id = `p-${++this.#sequence}`;
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(pending.timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        this.#pending.delete(id);
        fn(value);
      };
      const onAbort = () => settle(reject, new BridgeUnavailable("the tool call was aborted after the request was written", "bridge-lost"));
      const pending = {
        resolve: (value) => settle(resolve, value),
        reject: (error) => settle(reject, error),
        timer: undefined,
      };
      pending.timer = setTimeout(() => {
        settle(reject, Object.assign(new Error(`the opencode bridge did not answer ${method}`), { code: "bridge-timeout" }));
      }, timeoutMs);
      pending.timer.unref?.();
      // Aborted before the write: nothing reached the bridge, so this is a definite failure.
      if (signal?.aborted) {
        return settle(reject, new BridgeUnavailable("the tool call was aborted before the request was written; nothing was sent", "bridge-aborted"));
      }
      // The bridge answers an oversized line without an id, so it is refused here, unwritten.
      const message = { v: PROTOCOL, id, method, params };
      if (Buffer.byteLength(JSON.stringify(message)) + 1 > MAX_LINE) {
        return settle(reject, new BridgeUnavailable("the request exceeds the 4 MiB bridge line limit; nothing was sent", "too-large"));
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#pending.set(id, pending);
      this.#write(message).catch((error) => {
        settle(reject, new BridgeUnavailable(error?.message ?? "the opencode bridge is not running"));
      });
    });
  }

  notify(method, params) {
    this.#write({ v: PROTOCOL, method, params }).catch(() => {});
  }

  async stop() {
    if (!this.alive) return;
    this.alive = false;
    this.#rejectPending();
    try { this.#child.stdin.end(); } catch {}
    await new Promise((resolve) => {
      if (!this.#child || this.#child.exitCode !== null) return resolve();
      const timer = setTimeout(() => { try { this.#child.kill("SIGKILL"); } catch {} resolve(); }, 2000);
      this.#child.once("close", () => { clearTimeout(timer); resolve(); });
    });
  }

  #exit(error) {
    if (!this.alive) return;
    this.alive = false;
    this.#rejectPending();
    this.#onExit?.(error);
  }

  #rejectPending() {
    for (const pending of [...this.#pending.values()]) {
      clearTimeout(pending.timer);
      // The request was written to the child; delivery is now unknown, not definitely failed.
      pending.reject(new BridgeUnavailable("the opencode bridge was lost after the request was written", "bridge-lost"));
    }
    this.#pending.clear();
  }
}

function handle() {
  let current = globalThis[HANDLE_KEY];
  if (!current) {
    current = globalThis[HANDLE_KEY] = {
      client: null, starting: null, instances: new Map(), helloed: new Set(), options: undefined,
      node: undefined, nodeFailure: undefined,
    };
  }
  return current;
}

const normalizeLocation = (location) => {
  if (typeof location === "string") return { directory: location };
  if (location && typeof location === "object" && typeof location.directory === "string") return { directory: location.directory };
  return {};
};

// Only the variables the bridge needs. Provider credentials and opencode passwords are never
// inherited by the child.
export function bridgeEnvironment(env = process.env) {
  const out = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "CLAUDE_CONFIG_DIR", "AGENT_PEERS_HOME", "AGENT_PEERS_DEBUG", "AGENT_PEERS_LOG", "LANG", "LC_ALL", "TZ"]) {
    if (env[key] !== undefined) out[key] = env[key];
  }
  for (const [key, value] of Object.entries(env)) if (key.startsWith("XDG_") && value !== undefined) out[key] = value;
  return out;
}

// Candidate Node executables, in the designed order: AGENT_PEERS_NODE, node on PATH, then the
// common version-manager and agent paths, newest first. Each candidate is probed once.
export function nodeCandidates(env = process.env) {
  const home = env.HOME || homedir();
  const candidates = [];
  if (env.AGENT_PEERS_NODE) candidates.push(env.AGENT_PEERS_NODE);
  // Resolve PATH without a child process: this runs during plugin setup, so it must not block the
  // opencode event loop.
  const onPath = (() => {
    try {
      if (typeof Bun !== "undefined" && typeof Bun.which === "function") return Bun.which("node");
    } catch {}
    const name = process.platform === "win32" ? "node.exe" : "node";
    for (const directory of String(env.PATH ?? "").split(delimiter)) {
      if (!directory) continue;
      const candidate = join(directory, name);
      try { if (statSync(candidate).isFile()) return candidate; } catch {}
    }
    return undefined;
  })();
  if (onPath) candidates.push(onPath);
  const versioned = (root) => {
    let entries = [];
    try { entries = readdirSync(root); } catch { return []; }
    return entries.filter((name) => /^v?\d+\.\d+\.\d+$/.test(name)).sort((a, b) => {
      const parse = (v) => v.replace(/^v/, "").split(".").map(Number);
      const [x, y, z] = parse(a), [p, q, r] = parse(b);
      return p - x || q - y || r - z;
    }).map((name) => join(root, name, "bin", "node"));
  };
  for (const root of new Set([env.NVM_DIR && join(env.NVM_DIR, "versions", "node"), join(home, ".nvm", "versions", "node")].filter(Boolean))) {
    candidates.push(...versioned(root));
  }
  candidates.push(...versioned(join(home, ".local", "share", "fnm", "node-versions")).map((path) => path.replace(/\/bin\/node$/, "/installation/bin/node")));
  candidates.push(join(home, ".volta", "bin", "node"), join(home, ".asdf", "shims", "node"), join(home, ".local", "share", "mise", "shims", "node"));
  if (env.HERMES_HOME) candidates.push(join(env.HERMES_HOME, "node", "bin", "node"));
  candidates.push(join(home, ".hermes", "node", "bin", "node"));
  return [...new Set(candidates.filter(Boolean))];
}

export function probeNode(path, env = process.env) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(path, ["--version"], { stdio: ["ignore", "pipe", "ignore"], env });
    } catch {
      resolve(undefined);
      return;
    }
    let output = "", done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      finish(undefined);
    }, 1000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (data) => { output += data; });
    child.once("error", () => finish(undefined));
    child.once("close", (code) => {
      const match = /^v(\d+)\./.exec(output.trim());
      finish(code === 0 && match && Number(match[1]) >= 22 ? path : undefined);
    });
  });
}

// Candidates come from `env`; each is probed with `probeEnv`, the child's filtered environment.
export async function findNode({ env = process.env, probe = probeNode, probeEnv = env } = {}) {
  for (const candidate of nodeCandidates(env)) {
    if (await probe(candidate, probeEnv)) return candidate;
  }
  throw new BridgeUnavailable(`no working Node 22+ executable found; ${HINT}`);
}

// Success is cached for the server lifetime. A failure is retried at most every 30 s, so a
// missing Node never makes every tool call rerun the probes.
export async function cachedNode(state, { env = process.env, probe = probeNode, probeEnv = env, now = Date.now } = {}) {
  if (state.node) return state.node;
  if (state.nodeFailure && now() - state.nodeFailure.at < NODE_FAILURE_MS) throw new BridgeUnavailable(state.nodeFailure.message);
  try {
    state.node = await findNode({ env, probe, probeEnv });
    state.nodeFailure = undefined;
    return state.node;
  } catch (error) {
    state.nodeFailure = { at: now(), message: error.message };
    throw error;
  }
}

// A cached Node that can no longer be spawned (removed or no longer executable) is forgotten, so
// the next start re-resolves it after the same 30 s failure backoff.
export function forgetNode(state, command, error, now = Date.now) {
  if (!state.node || state.node !== command || !["ENOENT", "EACCES"].includes(error?.code)) return;
  state.node = undefined;
  state.nodeFailure = { at: now(), message: `the cached Node executable could not be started (${error.code})` };
}

async function commandFor(state, env) {
  const configured = state.options?.bridge_command;
  if (configured !== undefined) {
    if (!Array.isArray(configured) || !configured.length || configured.some((part) => typeof part !== "string" || !part)) {
      throw new BridgeUnavailable(`bridge_command must be a nonempty array of strings; ${HINT}`);
    }
    return { command: configured[0], args: configured.slice(1) };
  }
  // AGENT_PEERS_NODE, NVM_DIR and HERMES_HOME pick the Node, so the lookup reads the server's own
  // environment; the probes and the child get only the filtered one.
  const node = await cachedNode(state, { env: process.env, probeEnv: env });
  return { command: node, args: [join(PACKAGE, "bin", "agent-peers.mjs"), "opencode-bridge"] };
}

function ensureBridge(state) {
  if (state.client?.alive) return Promise.resolve(state.client);
  if (state.starting) return state.starting;
  state.starting = (async () => {
    if (!state.instances.size) throw new BridgeUnavailable("no opencode plugin instance is registered");
    const env = bridgeEnvironment();
    const { command, args } = await commandFor(state, env);
    const client = new BridgeClient({
      command, args, env,
      onRequest: (message) => hostRequest(state, message),
      onExit: (error) => {
        forgetNode(state, command, error);
        if (state.client === client) {
          state.client = null;
          state.helloed.clear();
          for (const entry of state.instances.values()) entry.helloing = undefined;
          log("bridge.exit", { outcome: "closed" });
        }
      },
    });
    client.start();
    state.client = client;
    state.helloed.clear();
    for (const entry of state.instances.values()) entry.helloing = undefined;
    try {
      for (const instance of state.instances.keys()) await helloInstance(state, client, instance);
    } catch (error) {
      state.client = null;
      state.helloed.clear();
      await client.stop().catch(() => {});
      throw error instanceof BridgeUnavailable ? error : new BridgeUnavailable(error.message);
    }
    log("bridge.start", { outcome: "succeeded" });
    return client;
  })().finally(() => { state.starting = null; });
  return state.starting;
}

// One hello per instance per child, shared by the start loop, setup and the first tool call. The
// instance is marked helloed before the request so two callers never send it twice.
async function helloInstance(state, client, instance) {
  const entry = state.instances.get(instance);
  if (!entry) return;
  // A second caller must wait for an in-flight hello, not just see that one was started. Otherwise
  // a tool call can reach the bridge before the instance is registered there.
  if (state.helloed.has(instance)) {
    if (entry.helloing) await entry.helloing;
    return;
  }
  if (!entry.helloing) {
    state.helloed.add(instance);
    entry.helloing = client.request("hello", { instance, location: entry.location }, HELLO_TIMEOUT_MS)
      .then((hello) => {
        if (hello?.version && hello.version !== VERSION) {
          log("bridge.version", { outcome: "warning", reason: "other" });
          console.error(`agent-peers: opencode plugin ${VERSION} uses an agent-peers bridge ${hello.version}; pin one package version`);
        }
      })
      .catch((error) => { state.helloed.delete(instance); throw error; })
      .finally(() => { entry.helloing = undefined; });
  }
  await entry.helloing;
}

// The plugin executes only these two host methods. It does not check session state, frame text,
// route messages or write records.
async function hostRequest(state, message) {
  const { instance } = message.params ?? {};
  const target = state.instances.get(instance);
  if (!target) throw Object.assign(new Error("this opencode plugin instance is no longer registered"), { code: "not-found" });
  if (message.method === "host.session") {
    const sessionID = message.params?.sessionID;
    if (typeof sessionID !== "string") throw Object.assign(new Error("sessionID is required"), { code: "invalid-request" });
    let value;
    try { value = await target.ctx.session.get({ sessionID }); }
    catch (error) {
      throw Object.assign(new Error(error?.message ?? "the opencode host does not have this session"),
        { code: hostErrorCode(error, "host-lost") });
    }
    const info = value?.session ?? value?.data ?? value;
    if (!info || info.id !== sessionID) throw Object.assign(new Error("the opencode host does not have this session"), { code: "not-found" });
    return { ...info, location: info.location ?? target.location };
  }
  if (message.method === "host.synthetic") {
    const { sessionID, text, delivery, resume, description, metadata } = message.params ?? {};
    if (typeof sessionID !== "string" || typeof text !== "string") {
      throw Object.assign(new Error("sessionID and text are required"), { code: "invalid-request" });
    }
    // A host-side bound, not delivery policy: the frame wrapper and escaping can take a body that
    // fits the 1 MB wire line past 1 MB of text.
    if (Buffer.byteLength(text) > 1_000_000) throw Object.assign(new Error("the synthetic text is too large"), { code: "too-large" });
    try {
      await target.ctx.session.synthetic({
        sessionID, text, ...(delivery !== undefined ? { delivery } : {}), ...(resume !== undefined ? { resume } : {}),
        ...(description ? { description } : {}), ...(metadata ? { metadata } : {}),
      });
    } catch (error) {
      throw Object.assign(new Error(error?.message ?? "the opencode host refused the synthetic input"),
        { code: hostErrorCode(error, "host-lost") });
    }
    return { admitted: true };
  }
  throw Object.assign(new Error(`unknown host method ${String(message.method).slice(0, 80)}`), { code: "unknown-method" });
}

// opencode's errors are tagged Effect errors that the promise adapter rejects with unchanged.
// Classify them by tag; message matching hid a wrong session.get call and would turn unrelated
// failures into "no session". The plugin host raises the core Session.* tags; the protocol tags
// are what the HTTP client raises for the same endpoints. SchemaError is both the input decode and
// the output encode, which runs after a synthetic was admitted, so it leaves delivery unknown.
const NOT_FOUND = new Set(["Session.NotFoundError", "SessionNotFoundError"]);
const REJECTED = new Set(["Session.SyntheticConflictError", "Session.PromptConflictError", "Session.BusyError",
  "ConflictError", "SessionBusyError", "InvalidRequestError", "MessageNotFoundError"]);
const LOST = new Set(["SchemaError", "ServiceUnavailableError", "UnknownError", "AbortError"]);
function hostErrorCode(error, fallback) {
  const tag = error?._tag ?? error?.tag;
  if (NOT_FOUND.has(tag)) return "not-found";
  if (REJECTED.has(tag)) return "host-rejected";
  if (LOST.has(tag)) return "host-lost";
  log("host.error", { outcome: "failed", reason: tag ? "other" : "unknown" });
  return fallback;
}

async function toolsOf(ctx, instance) {
  if (!ctx?.tool?.transform) throw new Error("opencode v2 plugin context has no tool.transform");
  // v2's transform is synchronous inside an async registration. Await the registration so setup
  // does not finish (and opencode does not serve the agent) before the four tools exist.
  await ctx.tool.transform((editor) => {
    for (const definition of Object.values(DEFINITIONS)) {
      editor.add({
        name: definition.name,
        description: definition.description,
        input: definition.input,
        // Direct tools under their exact names, as the peer frame's send_peer(to=reply_to) assumes;
        // without this opencode 2.x offers plugin tools only inside CodeMode's `execute`.
        options: { codemode: false },
        execute: (args, tool) => executeTool(instance, definition.name, args, tool),
      });
    }
  });
}

function resultOf(text, structuredContent, isError) {
  // No output schema and no output key: opencode's tool runtime treats output on a schema-less
  // tool as a defect. The model sees both text blocks: the human result and a JSON mirror.
  return {
    content: [{ type: "text", text: String(text ?? "") }, { type: "text", text: JSON.stringify(structuredContent ?? null) }],
    metadata: { structuredContent, isError: Boolean(isError) },
  };
}

function failure(name, reason, text) {
  if (name === "send_peer") return resultOf(text, sendResult({ reason }), true);
  if (name === "claim_name" || name === "release_name") return resultOf(text, claimRefusal(reason, text), true);
  return resultOf(text, { status: "failed", reason, text, peers: [], self: null, names: [] }, true);
}

async function executeTool(instance, name, args, tool) {
  const state = handle();
  if (!state.instances.has(instance)) return failure(name, "bridge-unavailable", `this opencode plugin instance closed; ${HINT}`);
  let client;
  try {
    client = await ensureBridge(state);
    await helloInstance(state, client, instance);
  } catch (error) { return failure(name, "bridge-unavailable", `${error.message}; ${HINT}`); }
  try {
    const result = await client.request("tool", { instance, name, sessionID: tool?.sessionID, args: args ?? {} },
      TOOL_TIMEOUT_MS, { signal: tool?.signal });
    return resultOf(result?.text, result?.structuredContent ?? null, result?.isError);
  } catch (error) {
    // Once the request is written, a lost bridge, timeout or host abort leaves delivery unknown.
    // A send that may have landed must not be retried by the model as a definite failure.
    if (name === "send_peer" && ["bridge-lost", "bridge-timeout"].includes(error?.code)) {
      return resultOf("Delivery is unknown: the opencode bridge did not confirm the send; it is not retried.",
        sendResult({ status: "unconfirmed", reason: "bridge-lost" }), false);
    }
    if (error?.code === "bridge-aborted") return failure(name, "bridge-unavailable", error.message);
    if (error?.code === "too-large") return failure(name, "too-large", error.message);
    // A claim or release may also have been applied; both are idempotent, so say so and let the
    // model check with list_peers instead of reading a definite failure.
    if ((name === "claim_name" || name === "release_name") && ["bridge-lost", "bridge-timeout"].includes(error?.code)) {
      return failure(name, "bridge-unavailable",
        `the opencode bridge did not confirm ${name}; it may have been applied, so check with list_peers before retrying; ${HINT}`);
    }
    return failure(name, "bridge-unavailable", `the opencode bridge is unavailable: ${error.message}; ${HINT}`);
  }
}

async function closeInstance(state, instance) {
  state.instances.delete(instance);
  state.helloed.delete(instance);
  if (state.starting) await state.starting.catch(() => {});
  const client = state.client;
  if (!client?.alive) {
    if (state.instances.size === 0) {
      state.options = undefined;
      state.node = undefined;
      state.nodeFailure = undefined;
      state.helloed.clear();
    }
    return;
  }
  try { client.notify("event", { instance, type: "closed" }); } catch {}
  if (state.instances.size === 0) {
    state.client = null;
    await client.stop();
    // A reload's new instance may have set up while the child stopped; its options stand.
    if (state.instances.size !== 0) return;
    // The last instance defines the server lifetime. A later instance reload may carry new
    // options and must not reuse a stale Node success or a bridge_command from the old setup.
    state.options = undefined;
    state.node = undefined;
    state.nodeFailure = undefined;
    state.helloed.clear();
  }
}

// Event shapes differ slightly between opencode builds; only the surfaces this plugin needs are
// read. A user prompt binds; deleted/moved unbind. Synthetic peer input does not bind or loop.
export function forwardEvent(state, instance, event) {
  const type = event?.type ?? event?.event?.type;
  const data = event?.data ?? event?.event?.data ?? event?.properties ?? {};
  let forwarded;
  if (type === "session.deleted") forwarded = "deleted";
  else if (type === "session.moved") forwarded = "moved";
  else if (type === "session.inbox.enqueued" && data.item?.type === "user") forwarded = "prompt";
  if (!forwarded || typeof data.sessionID !== "string") return;
  if (!state.instances.has(instance)) return;
  // Never await bridge I/O inside the event stream: a slow bridge would overflow opencode's
  // volatile event stream. It is enough to start the child and write the notification.
  void ensureBridge(state)
    .then((client) => client.notify("event", { instance, type: forwarded, sessionID: data.sessionID }))
    .catch((error) => log("bridge.event", { outcome: "failed", reason: error.code === "bridge-unavailable" ? "bridge_unavailable" : "other" }));
}

const RESUBSCRIBE_MIN_MS = 1000, RESUBSCRIBE_MAX_MS = 30_000, DISPOSE_WAIT_MS = 1000;
const sleep = (ms, signal) => new Promise((resolve) => {
  const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
  const timer = setTimeout(done, ms);
  signal?.addEventListener("abort", done, { once: true });
});

// opencode's EventDomain.subscribe returns an AsyncIterable, not a callback registration. Keep
// one loop per plugin instance, abort it on cleanup, and resubscribe if the volatile stream ends.
// Resubscribing backs off from 1 s to 30 s and resets once a stream delivers an event; a failing
// stream is logged on its first failure and then at most once per 30 s.
export function subscribeEvents(state, instance, disposers, { delay = sleep, now = Date.now, report = log } = {}) {
  if (!state.instances.get(instance)?.ctx?.event?.subscribe) return;
  const controller = new AbortController();
  const live = () => !controller.signal.aborted && state.instances.has(instance);
  const loop = (async () => {
    let wait = RESUBSCRIBE_MIN_MS, reported;
    while (live()) {
      let failed;
      try {
        const stream = state.instances.get(instance)?.ctx.event.subscribe({ signal: controller.signal });
        for await (const event of stream) {
          if (!live()) break;
          wait = RESUBSCRIBE_MIN_MS;
          reported = undefined;
          forwardEvent(state, instance, event);
        }
        if (live()) failed = { outcome: "closed", reason: "stream-ended" };
      } catch {
        if (controller.signal.aborted) break;
        failed = { outcome: "failed", reason: "stream" };
      }
      if (!live()) break;
      if (reported === undefined || now() - reported >= RESUBSCRIBE_MAX_MS) {
        reported = now();
        report("bridge.event", failed);
      }
      await delay(wait, controller.signal);
      wait = Math.min(wait * 2, RESUBSCRIBE_MAX_MS);
    }
  })();
  disposers.push(async () => {
    controller.abort();
    // A host stream that ignores the abort must not hang plugin unload.
    let timer;
    await Promise.race([loop.catch(() => {}), new Promise((resolve) => { timer = setTimeout(resolve, DISPOSE_WAIT_MS); })]);
    clearTimeout(timer);
  });
}

export const plugin = {
  id: PLUGIN_ID,
  // Registration completes before the bridge is started: if Node or the bridge is missing the
  // tools still exist and report bridge-unavailable.
  async setup(ctx) {
    const state = handle();
    const instance = randomUUID();
    state.instances.set(instance, { ctx, location: normalizeLocation(ctx?.location) });
    const options = ctx?.options ?? {};
    // The first instance's options hold until the last instance closes. A later instance (a hot
    // reload) can only add a bridge_command when none was set, and that applies at the next child
    // start; a running child is never restarted for new options.
    if (state.options === undefined) state.options = options;
    else if (state.options.bridge_command === undefined && options.bridge_command !== undefined) state.options = { ...state.options, ...options };
    try {
      await toolsOf(ctx, instance);
    } catch (error) {
      state.instances.delete(instance);
      if (state.instances.size === 0) {
        state.options = undefined;
        state.node = undefined;
        state.nodeFailure = undefined;
      }
      throw error;
    }
    const disposers = [];
    subscribeEvents(state, instance, disposers);
    // Start in the background. A missing Node leaves the tools registered.
    void ensureBridge(state)
      .then((client) => {
        // A new instance that joined while the child was starting gets its one hello here.
        if (state.instances.has(instance)) return helloInstance(state, client, instance);
      })
      .catch((error) => {
        log("bridge.start", { outcome: "failed", reason: error.code === "bridge-unavailable" ? "bridge_unavailable" : "other" });
        console.error(`agent-peers: opencode bridge unavailable: ${error.message}`);
      });
    let closed = false;
    return async () => {
      if (closed) return;
      closed = true;
      for (const dispose of disposers) { try { await dispose(); } catch {} }
      await closeInstance(state, instance);
    };
  },
};

export default plugin;
