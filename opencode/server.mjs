// The opencode v2 plugin. It is deliberately only an RPC and lifecycle adapter: it registers the
// four tool definitions from src/peer-tool-definitions.json, forwards the caller's session id and
// arguments to one stdio bridge child per opencode server, forwards prompt/deleted/moved/closed
// events, and executes host.session/host.synthetic requests. All routing, names, delivery,
// receipts, dedup, pins and registry state live in src/opencode-bridge.mjs.
//
// One child is shared by every location plugin instance in this server process through a
// version-keyed globalThis handle. The child's stdin is its lifecycle: the last instance closes
// it, and a killed server closes the pipe.

import { spawn, spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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
    child.once("exit", (code, signal) => this.#exit(Object.assign(new Error(`bridge exited (${code ?? signal})`), { code: "bridge-closed" })));
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

  request(method, params, timeoutMs = TOOL_TIMEOUT_MS) {
    const id = `p-${++this.#sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(Object.assign(new Error(`the opencode bridge did not answer ${method}`), { code: "bridge-unavailable" }));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#write({ v: PROTOCOL, id, method, params }).catch((error) => {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(new BridgeUnavailable(error?.message ?? "the opencode bridge is not running"));
      });
    });
  }

  notify(method, params) {
    this.#write({ v: PROTOCOL, method, params }).catch(() => {});
  }

  async stop() {
    if (!this.alive) return;
    this.alive = false;
    try { this.#child.stdin.end(); } catch {}
    await new Promise((resolve) => {
      if (!this.#child || this.#child.exitCode !== null) return resolve();
      const timer = setTimeout(() => { try { this.#child.kill("SIGKILL"); } catch {} resolve(); }, 2000);
      this.#child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }

  #exit(error) {
    if (!this.alive) return;
    this.alive = false;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      // The request was written to the child; delivery is now unknown, not definitely failed.
      pending.reject(Object.assign(new BridgeUnavailable("the opencode bridge was lost after the request was written", "bridge-lost")));
    }
    this.#pending.clear();
    this.#onExit?.(error);
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
  const onPath = (() => {
    try {
      if (typeof Bun !== "undefined" && typeof Bun.which === "function") return Bun.which("node");
    } catch {}
    try {
      const result = spawnSync("sh", ["-c", "command -v node"], { encoding: "utf8", timeout: 1000, env });
      return result.status === 0 ? result.stdout.trim() : undefined;
    } catch { return undefined; }
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
  try {
    const result = spawnSync(path, ["--version"], { encoding: "utf8", timeout: 1000, env });
    if (result.status !== 0) return undefined;
    const match = /^v(\d+)\./.exec(String(result.stdout).trim());
    return match && Number(match[1]) >= 22 ? path : undefined;
  } catch { return undefined; }
}

export function findNode({ env = process.env, probe = probeNode } = {}) {
  for (const candidate of nodeCandidates(env)) {
    if (probe(candidate, env)) return candidate;
  }
  throw new BridgeUnavailable(`no working Node 22+ executable found; ${HINT}`);
}

// Success is cached for the server lifetime. A failure is retried at most every 30 s, so a
// missing Node never makes every tool call rerun the probes.
export function cachedNode(state, { env = process.env, probe = probeNode, now = Date.now } = {}) {
  if (state.node) return state.node;
  if (state.nodeFailure && now() - state.nodeFailure.at < NODE_FAILURE_MS) throw new BridgeUnavailable(state.nodeFailure.message);
  try {
    state.node = findNode({ env, probe });
    state.nodeFailure = undefined;
    return state.node;
  } catch (error) {
    state.nodeFailure = { at: now(), message: error.message };
    throw error;
  }
}

function commandFor(state, env) {
  const configured = state.options?.bridge_command;
  if (configured !== undefined) {
    if (!Array.isArray(configured) || !configured.length || configured.some((part) => typeof part !== "string" || !part)) {
      throw new BridgeUnavailable(`bridge_command must be a nonempty array of strings; ${HINT}`);
    }
    return { command: configured[0], args: configured.slice(1) };
  }
  const node = cachedNode(state, { env });
  return { command: node, args: [join(PACKAGE, "bin", "agent-peers.mjs"), "opencode-bridge"] };
}

function ensureBridge(state) {
  if (state.client?.alive) return Promise.resolve(state.client);
  if (state.starting) return state.starting;
  state.starting = (async () => {
    if (!state.instances.size) throw new BridgeUnavailable("no opencode plugin instance is registered");
    const env = bridgeEnvironment();
    const { command, args } = commandFor(state, env);
    const client = new BridgeClient({
      command, args, env,
      onRequest: (message) => hostRequest(state, message),
      onExit: () => {
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
    try { value = await target.ctx.session.get(sessionID); }
    catch (error) {
      throw Object.assign(new Error(error?.message ?? "the opencode host does not have this session"),
        { code: hostErrorCode(error, "not-found") });
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
    if (Buffer.byteLength(text) > 1_000_000) throw Object.assign(new Error("the synthetic text is too large"), { code: "too-large" });
    try {
      await target.ctx.session.synthetic({
        sessionID, text, delivery: delivery === "steer" ? "steer" : delivery, resume: resume !== false,
        ...(description ? { description } : {}), ...(metadata ? { metadata } : {}),
      });
    } catch (error) {
      throw Object.assign(new Error(error?.message ?? "the opencode host refused the synthetic input"),
        { code: hostErrorCode(error, "host-rejected") });
    }
    return { admitted: true, delivery: delivery ?? "steer" };
  }
  throw Object.assign(new Error(`unknown host method ${String(message.method).slice(0, 80)}`), { code: "unknown-method" });
}

const isNotFound = (error) => /not.?found|no such session|session.*(?:does not exist|missing|deleted)/i.test(String(error?.message ?? ""));
function hostErrorCode(error, fallback) {
  if (error?.code === "not-found" || isNotFound(error)) return "not-found";
  if (error?.code === "too-large" || /too.?large/i.test(String(error?.message ?? ""))) return "too-large";
  return fallback;
}

function toolsOf(ctx, instance) {
  if (!ctx?.tool?.transform) throw new Error("opencode v2 plugin context has no tool.transform");
  ctx.tool.transform((editor) => {
    for (const definition of Object.values(DEFINITIONS)) {
      editor.add({
        name: definition.name,
        description: definition.description,
        input: definition.input,
        execute: (args, tool) => executeTool(instance, definition.name, args, tool),
      });
    }
  });
}

function resultOf(text, structuredContent, isError) {
  // No output schema and no output key: opencode's tool runtime treats output on a schema-less
  // tool as a defect. The model sees the first text; the second carries the structured result.
  return {
    content: [{ type: "text", text: String(text ?? "") }, { type: "text", text: JSON.stringify(structuredContent) }],
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
    const result = await client.request("tool", { instance, name, sessionID: tool?.sessionID, args: args ?? {} });
    return resultOf(result?.text, result?.structuredContent ?? null, result?.isError);
  } catch (error) {
    // The request reached the bridge but its answer did not: a send may already have landed.
    if (name === "send_peer" && error?.code === "bridge-lost") {
      return resultOf("Delivery is unknown: the opencode bridge was lost after the request was written; it is not retried.",
        sendResult({ status: "unconfirmed", reason: "bridge-lost" }), false);
    }
    return failure(name, "bridge-unavailable", `the opencode bridge is unavailable: ${error.message}; ${HINT}`);
  }
}

async function closeInstance(state, instance) {
  state.instances.delete(instance);
  state.helloed.delete(instance);
  if (state.starting) await state.starting.catch(() => {});
  const client = state.client;
  if (!client?.alive) return;
  try { client.notify("event", { instance, type: "closed" }); } catch {}
  if (state.instances.size === 0) {
    state.client = null;
    await client.stop();
  }
}

// Event shapes differ slightly between opencode builds; only the four surfaces this plugin needs
// are read. A prompt binds; deleted/moved unbind. closed is this plugin's own lifecycle event.
export function forwardEvent(state, instance, event) {
  const type = event?.type ?? event?.event?.type;
  const data = event?.data ?? event?.event?.data ?? event?.properties ?? {};
  let forwarded;
  if (type === "session.deleted") forwarded = "deleted";
  else if (type === "session.moved") forwarded = "moved";
  else if (type === "session.inbox.enqueued" && data.item?.type === "user") forwarded = "prompt";
  else if (type === "session.prompt") forwarded = "prompt";
  if (!forwarded || typeof data.sessionID !== "string") return;
  if (!state.instances.has(instance)) return;
  void ensureBridge(state)
    .then((client) => client.notify("event", { instance, type: forwarded, sessionID: data.sessionID }))
    .catch((error) => log("bridge.event", { outcome: "failed", reason: error.code === "bridge-unavailable" ? "bridge_unavailable" : "other" }));
}

export const plugin = {
  id: PLUGIN_ID,
  // Registration happens synchronously, before the bridge is started: if Node or the bridge is
  // missing the tools still exist and report bridge-unavailable.
  setup(ctx) {
    const state = handle();
    const instance = randomUUID();
    state.instances.set(instance, { ctx, location: normalizeLocation(ctx?.location) });
    const options = ctx?.options ?? {};
    if (state.options === undefined) state.options = options;
    else if (state.options.bridge_command === undefined && options.bridge_command !== undefined) state.options = { ...state.options, ...options };
    toolsOf(ctx, instance);
    const disposers = [];
    if (ctx?.event?.subscribe) {
      const off = ctx.event.subscribe((event) => forwardEvent(state, instance, event));
      if (typeof off === "function") disposers.push(off);
      else if (typeof off?.dispose === "function") disposers.push(() => off.dispose());
    }
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
      for (const dispose of disposers) { try { dispose(); } catch {} }
      await closeInstance(state, instance);
    };
  },
};

export default plugin;
