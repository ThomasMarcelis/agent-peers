// Plugin-adapter tests: the opencode/server.mjs module registers the four static tools
// immediately, forwards instance/sessionID/args, executes only host.session/host.synthetic,
// shares one stdio child per server, forwards events, and restarts lazily with hello for every
// instance. The fake bridge isolates the adapter; test/opencode-e2e.mjs runs the real bridge.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import plugin, { BridgeClient, cachedNode, findNode, nodeCandidates, subscribeEvents } from "../opencode/server.mjs";
import { VERSION } from "../src/version.mjs";
import { peerInstructions } from "../src/frame.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fakeBridge = join(root, "test", "opencode-fake-bridge.mjs");
const definitions = JSON.parse(readFileSync(join(root, "src", "peer-tool-definitions.json"), "utf8"));
const KEY = Symbol.for("agent-peers.opencode.bridge.v1");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, description = "condition", tries = 300) {
  for (let i = 0; i < tries; i++) {
    const value = check();
    if (value) return value;
    await delay(10);
  }
  assert.fail(`timed out waiting for ${description}`);
}

// The tags opencode v2.0.32's plugin host raises (packages/core/src/session/error.ts).
const tagged = (tag, message, fields = {}) => Object.assign(new Error(message), { _tag: tag, ...fields });
const notFound = (sessionID) => tagged("Session.NotFoundError", `session ${sessionID} not found`, { sessionID });

function context(dir, sessions) {
  const ctx = {
    location: { directory: join(dir, "repo") },
    options: undefined,
    tools: [], gets: [], synth: [], unsubscribed: false,
    session: {
      // Match the real promise adapter: path params arrive as an object, and errors are tagged.
      get: async ({ sessionID } = {}) => {
        ctx.gets.push(sessionID);
        if (!sessions.has(sessionID)) throw notFound(sessionID);
        return sessions.get(sessionID);
      },
      synthetic: async (params) => { ctx.synth.push(params); return { admitted: true }; },
    },
    tool: {
      transform(fn) {
        const tools = [];
        fn({ add: (definition) => tools.push(definition) });
        ctx.tools = tools;
        return Promise.resolve({ dispose() {} });
      },
    },
    event: {
      subscribe({ signal } = {}) {
        let queue = [], waiting = [], ended = false;
        const close = () => {
          if (ended) return;
          ended = true;
          ctx.unsubscribed = true;
          for (const resolve of waiting) resolve({ done: true, value: undefined });
          waiting = [];
        };
        signal?.addEventListener("abort", close, { once: true });
        if (signal?.aborted) close();
        const iterator = {
          next() {
            if (queue.length) return Promise.resolve({ done: false, value: queue.shift() });
            if (ended) return Promise.resolve({ done: true, value: undefined });
            return new Promise((resolve) => waiting.push(resolve));
          },
          return() { close(); return Promise.resolve({ done: true, value: undefined }); },
        };
        ctx.emit = (event) => {
          if (ended) return;
          const waiter = waiting.shift();
          if (waiter) waiter({ done: false, value: event });
          else queue.push(event);
        };
        return { [Symbol.asyncIterator]() { return iterator; } };
      },
    },
  };
  return ctx;
}

async function fixture(t, { mode = "echo", version = VERSION, command, sessions = new Map([["ses_root", { id: "ses_root", location: { directory: "/repo" } }]]) } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ap-ocp-"));
  const log = join(dir, "bridge.jsonl");
  const ctx = context(dir, sessions);
  ctx.options = { bridge_command: command ?? [process.execPath, fakeBridge, "--log", log, "--mode", mode, "--version", version] };
  const cleanup = await plugin.setup(ctx);
  const messages = () => {
    try { return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
    catch { return []; }
  };
  const waitFor = (check, description) => until(() => check(messages()), description);
  t.after(async () => { await cleanup(); delete globalThis[KEY]; rmSync(dir, { recursive: true, force: true }); });
  return { dir, log, ctx, cleanup, messages, waitFor };
}

test("setup registers the four definitions immediately, before the bridge, and execute forwards instance/sessionID/args", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(f.ctx.tools.map((tool) => tool.name), ["list_peers", "send_peer", "claim_name", "release_name"]);
  for (const tool of f.ctx.tools) {
    assert.deepEqual({ name: tool.name, description: tool.description, input: tool.input }, {
      ...definitions[tool.name],
      description: definitions[tool.name].description + (tool.name === "send_peer" ? " " + peerInstructions : ""),
    });
    assert.equal(typeof tool.execute, "function");
    // opencode 2.x offers only codemode:false tools to the model directly (core/src/tool.ts).
    assert.deepEqual(tool.options, { codemode: false });
  }
  const result = await f.ctx.tools.find((tool) => tool.name === "send_peer").execute(
    { to: "uds:/tmp/x.sock", message: "hello", in_reply_to: "m-1" }, { sessionID: "ses_root" });
  assert.equal("output" in result, false);
  assert.equal(result.content.length, 2);
  assert.equal(result.content[0].type, "text");
  assert.equal(result.metadata.isError, true);
  assert.deepEqual(result.metadata.structuredContent, { status: "failed", reason: "invalid-request" });
  assert.deepEqual(JSON.parse(result.content[1].text), result.metadata.structuredContent);
  const request = await f.waitFor((messages) => messages.find((message) => message.method === "tool"), "the tool request");
  assert.equal(typeof request.params.instance, "string");
  assert.equal(request.params.sessionID, "ses_root");
  assert.deepEqual(request.params.args, { to: "uds:/tmp/x.sock", message: "hello", in_reply_to: "m-1" });
});

test("host.session is executed by the plugin and its Session.Info is returned to the bridge", async (t) => {
  const f = await fixture(t, { mode: "host-session" });
  const result = await f.ctx.tools[0].execute({}, { sessionID: "ses_root" });
  assert.equal(result.content[0].text, "host:ses_root");
  assert.deepEqual(result.metadata.structuredContent, { id: "ses_root", location: { directory: "/repo" } });
});

test("a tagged host Session.NotFoundError is classified as not-found, not by message text", async (t) => {
  const f = await fixture(t, { mode: "host-missing" });
  const result = await f.ctx.tools[0].execute({}, { sessionID: "ses_root" });
  assert.equal(result.metadata.isError, true);
  assert.equal(result.metadata.structuredContent.code, "not-found");
  assert.equal(f.ctx.gets[0], "ses_missing");
});

test("host errors are classified by their opencode tag, never by message text", async (t) => {
  const f = await fixture(t, { mode: "host-missing" });
  const cases = [
    [tagged("Session.NotFoundError", "lookup failed"), "not-found"],
    [tagged("Session.BusyError", "session ses_missing not found"), "host-rejected"],
    [tagged("SchemaError", "session not found"), "host-lost"],
    [new Error("session ses_missing not found"), "host-lost"],
  ];
  for (const [error, code] of cases) {
    f.ctx.session.get = async () => { throw error; };
    const result = await f.ctx.tools[0].execute({}, { sessionID: "ses_root" });
    assert.equal(result.metadata.structuredContent.code, code, `${error._tag ?? "untagged"}: ${error.message}`);
  }
});

test("a host Session.SyntheticConflictError is host-rejected", async (t) => {
  const f = await fixture(t, { mode: "host-synthetic" });
  f.ctx.session.synthetic = async () => { throw tagged("Session.SyntheticConflictError", "conflict", { inputID: "msg_1" }); };
  const result = await f.ctx.tools[0].execute({}, { sessionID: "ses_root" });
  assert.equal(result.metadata.structuredContent.error.code, "host-rejected");
});

test("host.synthetic is executed by the plugin with the bridge's delivery fields", async (t) => {
  const synthetic = await fixture(t, { mode: "host-synthetic" });
  const answered = await synthetic.ctx.tools[0].execute({}, { sessionID: "ses_root" });
  assert.deepEqual(answered.metadata.structuredContent.result, { admitted: true });
  assert.deepEqual(synthetic.ctx.synth[0], {
    sessionID: "ses_root", text: "synthetic from bridge", delivery: "steer", resume: true,
    description: "agent-peers peer message", metadata: { source: "agent-peers" },
  });
});

test("two plugin instances share one child; closing one unbinds only it; closing the last ends stdin", async (t) => {
  const first = await fixture(t);
  const secondCtx = context(first.dir, new Map([["ses_b", { id: "ses_b", location: { directory: "/repo-b" } }]]));
  secondCtx.options = first.ctx.options;
  const secondCleanup = await plugin.setup(secondCtx);
  t.after(() => secondCleanup());
  await first.waitFor((messages) => messages.filter((message) => message.method === "hello").length >= 2, "both hellos");
  const hellos = first.messages().filter((message) => message.method === "hello");
  assert.equal(new Set(hellos.map((message) => message._child)).size, 1, "one child serves both instances");
  assert.equal(new Set(hellos.map((message) => message.params.instance)).size, 2);
  const firstInstance = first.messages().find((message) => message.method === "hello").params.instance;
  await first.cleanup();
  await first.waitFor((messages) => messages.some((message) => message.method === "event" && message.params.type === "closed" &&
    message.params.instance === firstInstance), "the closed event");
  assert.equal(first.ctx.unsubscribed, true);
  const result = await secondCtx.tools[0].execute({}, { sessionID: "ses_b" });
  assert.equal(result.metadata.structuredContent.status, "failed", "the shared child is still alive");
  await secondCleanup();
  await until(() => globalThis[KEY]?.client === null, "the child to stop");
});

test("a bridge crash reports bridge-unavailable, the next call starts a child and hellos every instance again", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ap-ocp-"));
  const log = join(dir, "bridge.jsonl"), crashFile = join(dir, "crashed");
  const sessions = new Map([["ses_root", { id: "ses_root", location: { directory: "/repo" } }]]);
  const a = context(dir, sessions), b = context(dir, sessions);
  const options = { bridge_command: [process.execPath, fakeBridge, "--log", log, "--mode", "crash-once", "--crash-file", crashFile] };
  a.options = b.options = options;
  const cleanupA = await plugin.setup(a);
  const cleanupB = await plugin.setup(b);
  t.after(async () => { await cleanupA(); await cleanupB(); delete globalThis[KEY]; rmSync(dir, { recursive: true, force: true }); });
  const messages = () => {
    try { return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
    catch { return []; }
  };
  await until(() => messages().filter((message) => message.method === "hello").length >= 2, "the first child's hellos");
  const failed = await a.tools[0].execute({}, { sessionID: "ses_root" });
  assert.equal(failed.metadata.isError, true);
  assert.equal(failed.metadata.structuredContent.status, "failed");
  assert.equal(failed.metadata.structuredContent.reason, "bridge-unavailable");
  assert.match(failed.content[0].text, /bridge_command|AGENT_PEERS_NODE/);
  // The next call starts a new child, which hellos both instances before serving the tool.
  const next = await b.tools[0].execute({}, { sessionID: "ses_root" });
  assert.equal(next.content[0].text, "echo");
  await until(() => {
    const children = new Map();
    for (const message of messages()) {
      if (message.method === "hello") children.set(message._child, (children.get(message._child) ?? 0) + 1);
    }
    return [...children.values()].some((count) => count === 2);
  }, "the restarted child's hellos for both instances");
  const groups = new Map();
  for (const message of messages()) if (message.method === "hello") groups.set(message._child, (groups.get(message._child) ?? 0) + 1);
  assert.deepEqual([...groups.values()].sort(), [2, 2], "each child hellos both instances");
});

test("Node lookup stops at the first working candidate, and a cached failure is not reprobed within 30 s", async () => {
  const env = { HOME: "/home/test", PATH: "/nonexistent-path", AGENT_PEERS_NODE: "/nvm/node" };
  const candidates = nodeCandidates(env);
  assert.equal(candidates[0], "/nvm/node");
  assert.ok(candidates.length >= 2);
  const second = candidates[1];
  const seen = [];
  const probe = (path) => { seen.push(path); return path === second ? path : undefined; };
  assert.equal(await findNode({ env, probe }), second);
  assert.deepEqual(seen, ["/nvm/node", second], "it stops at the first working Node 22+");
  const state = {};
  let probes = 0;
  const failing = () => { probes++; return undefined; };
  const noNode = { HOME: "/none", PATH: "" };
  const candidateCount = nodeCandidates(noNode).length;
  await assert.rejects(cachedNode(state, { env: noNode, probe: failing, now: () => 1000 }), /no working Node 22/);
  assert.equal(probes, candidateCount);
  await assert.rejects(cachedNode(state, { env: noNode, probe: failing, now: () => 20_000 }));
  assert.equal(probes, candidateCount, "a failure is cached for 30 s");
  await assert.rejects(cachedNode(state, { env: noNode, probe: failing, now: () => 31_001 }));
  assert.equal(probes, candidateCount * 2, "after 30 s it retries once");
});

test("bridge_command wins over AGENT_PEERS_NODE; a failed command is not silently replaced by Node", async (t) => {
  const previous = process.env.AGENT_PEERS_NODE;
  process.env.AGENT_PEERS_NODE = "/definitely/missing-node";
  let first;
  try {
    first = await fixture(t);
    const result = await first.ctx.tools[0].execute({}, { sessionID: "ses_root" });
    assert.equal(result.content[0].text, "echo", "the configured fake bridge served the request");
  } finally {
    await first?.cleanup();
    delete globalThis[KEY];
    if (previous === undefined) delete process.env.AGENT_PEERS_NODE; else process.env.AGENT_PEERS_NODE = previous;
  }
  const missing = await fixture(t, { command: ["/definitely/missing-agent-peers-bridge"], mode: "echo" });
  const failed = await missing.ctx.tools[0].execute({}, { sessionID: "ses_root" });
  assert.equal(failed.metadata.isError, true);
  assert.equal(failed.metadata.structuredContent.status, "failed");
  assert.equal(failed.metadata.structuredContent.reason, "bridge-unavailable");
  assert.match(failed.content[0].text, /bridge_command/);
  await missing.cleanup();
});

test("prompt, deleted and moved events are forwarded; closed is sent on cleanup", async (t) => {
  const f = await fixture(t);
  // Wait for this instance's hello so its id is visible in the log.
  const hello = await f.waitFor((messages) => messages.find((message) => message.method === "hello"), "the hello");
  f.ctx.emit({ type: "session.inbox.enqueued", data: { sessionID: "ses_root", item: { type: "user" } } });
  f.ctx.emit({ type: "session.deleted", data: { sessionID: "ses_root" } });
  f.ctx.emit({ type: "session.moved", data: { sessionID: "ses_root" } });
  f.ctx.emit({ type: "session.inbox.enqueued", data: { sessionID: "ses_root", item: { type: "synthetic" } } });
  await f.waitFor((messages) => messages.filter((message) => message.method === "event").length >= 3, "the three forwarded events");
  const events = f.messages().filter((message) => message.method === "event" && message.params.instance === hello.params.instance);
  assert.deepEqual(events.map((message) => message.params.type), ["prompt", "deleted", "moved"]);
  assert.ok(events.every((message) => message.params.sessionID === "ses_root"));
  await f.cleanup();
  await f.waitFor((messages) => messages.some((message) => message.method === "event" && message.params.type === "closed" &&
    message.params.instance === hello.params.instance), "the closed event");
});

test("a send whose bridge is lost after the request was written is unconfirmed/bridge-lost, not a definite failure", async (t) => {
  const f = await fixture(t, { mode: "crash" });
  await f.waitFor((messages) => messages.some((message) => message.method === "hello"), "the hello");
  const result = await f.ctx.tools.find((tool) => tool.name === "send_peer").execute(
    { to: "uds:/tmp/peer.sock", message: "lost" }, { sessionID: "ses_root" });
  assert.equal(result.metadata.isError, false);
  assert.equal(result.metadata.structuredContent.status, "unconfirmed");
  assert.equal(result.metadata.structuredContent.reason, "bridge-lost");
  assert.match(result.content[0].text, /Delivery is unknown/);
});

test("a send aborted before the request is written is a definite failure, and nothing reaches the bridge", async (t) => {
  const f = await fixture(t);
  await f.waitFor((messages) => messages.some((message) => message.method === "hello"), "the hello");
  const controller = new AbortController();
  controller.abort();
  const result = await f.ctx.tools.find((tool) => tool.name === "send_peer").execute(
    { to: "uds:/tmp/peer.sock", message: "aborted" }, { sessionID: "ses_root", signal: controller.signal });
  assert.equal(result.metadata.isError, true);
  assert.equal(result.metadata.structuredContent.status, "failed");
  assert.equal(result.metadata.structuredContent.reason, "bridge-unavailable");
  assert.match(result.content[0].text, /nothing was sent/);
  assert.equal(f.messages().some((message) => message.method === "tool"), false);
  const listing = await f.ctx.tools.find((tool) => tool.name === "list_peers").execute({},
    { sessionID: "ses_root", signal: controller.signal });
  assert.deepEqual(listing.metadata.structuredContent.recentlyExited, []);
  assert.equal(listing.metadata.structuredContent.namesNotRunning, 0);
  assert.ok(listing.metadata.structuredContent.now);
});

test("a send aborted after the request is written is unconfirmed/bridge-lost", async (t) => {
  const f = await fixture(t, { mode: "hang" });
  const controller = new AbortController();
  const pending = f.ctx.tools.find((tool) => tool.name === "send_peer").execute(
    { to: "uds:/tmp/peer.sock", message: "aborted" }, { sessionID: "ses_root", signal: controller.signal });
  await f.waitFor((messages) => messages.some((message) => message.method === "tool"), "the written request");
  controller.abort();
  const result = await pending;
  assert.equal(result.metadata.isError, false);
  assert.equal(result.metadata.structuredContent.status, "unconfirmed");
  assert.equal(result.metadata.structuredContent.reason, "bridge-lost");
});

test("an unanswered request rejects as bridge-timeout, the code a send reports as unconfirmed", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ap-ocp-"));
  const client = new BridgeClient({
    command: process.execPath, args: [fakeBridge, "--log", join(dir, "bridge.jsonl"), "--mode", "hang"], env: process.env,
    onRequest: () => ({}),
  }).start();
  t.after(async () => { await client.stop(); rmSync(dir, { recursive: true, force: true }); });
  await assert.rejects(client.request("tool", { name: "send_peer" }, 50), { code: "bridge-timeout" });
});

test("a mixed bridge version logs a warning but the tools still work", async (t) => {
  const f = await fixture(t, { version: "1.0.0-rc.5" });
  const result = await f.ctx.tools[0].execute({}, { sessionID: "ses_root" });
  assert.equal(result.metadata.structuredContent.status, "failed");
  assert.ok(f.messages().length > 0);
});

test("a cached Node that can no longer be spawned is forgotten and retried only after the 30 s backoff", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ap-ocp-"));
  const missing = join(dir, "missing-node");
  globalThis[KEY] = { client: null, starting: null, instances: new Map(), helloed: new Set(), options: undefined, node: missing, nodeFailure: undefined };
  const ctx = context(dir, new Map([["ses_root", { id: "ses_root" }]]));
  ctx.options = {};
  const cleanup = await plugin.setup(ctx);
  t.after(async () => { await cleanup(); delete globalThis[KEY]; rmSync(dir, { recursive: true, force: true }); });
  const failed = await ctx.tools[0].execute({}, { sessionID: "ses_root" });
  assert.equal(failed.metadata.structuredContent.reason, "bridge-unavailable");
  const state = globalThis[KEY];
  assert.equal(state.node, undefined, "the stale path is cleared");
  assert.match(state.nodeFailure?.message ?? "", /could not be started \(ENOENT\)/);
  const again = await ctx.tools[0].execute({}, { sessionID: "ses_root" });
  assert.match(again.content[0].text, /could not be started \(ENOENT\)/, "the next call within 30 s does not reprobe");
});

test("AGENT_PEERS_NODE picks the Node on the startup path, though the child's environment omits it", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ap-ocp-"));
  const log = join(dir, "bridge.jsonl"), argv = join(dir, "argv");
  // A Node wrapper outside every default location: it answers the version probe and otherwise
  // records what it was asked to run and serves the fake bridge.
  const wrapper = join(dir, "custom-node");
  writeFileSync(wrapper, `#!/bin/sh\nif [ "$1" = --version ]; then exec "${process.execPath}" --version; fi\n` +
    `printf '%s\\n' "$@" > "${argv}"\nexec "${process.execPath}" "${fakeBridge}" --log "${log}" --mode echo\n`);
  chmodSync(wrapper, 0o700);
  const saved = { AGENT_PEERS_NODE: process.env.AGENT_PEERS_NODE, AGENT_PEERS_HOME: process.env.AGENT_PEERS_HOME };
  process.env.AGENT_PEERS_NODE = wrapper;
  process.env.AGENT_PEERS_HOME = join(dir, "peers");
  delete globalThis[KEY];
  const ctx = context(dir, new Map([["ses_root", { id: "ses_root", location: { directory: "/repo" } }]]));
  ctx.options = {};
  const cleanup = await plugin.setup(ctx);
  t.after(async () => {
    await cleanup();
    delete globalThis[KEY];
    for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value;
    rmSync(dir, { recursive: true, force: true });
  });
  const result = await ctx.tools[0].execute({}, { sessionID: "ses_root" });
  assert.equal(result.content[0].text, "echo");
  assert.equal(globalThis[KEY].node, wrapper);
  assert.match(readFileSync(argv, "utf8"), /agent-peers\.mjs\nopencode-bridge\n/);
});

test("stopping the client rejects a written, unanswered request at once as bridge-lost", async (t) => {
  const client = new BridgeClient({
    command: process.execPath, args: ["-e", "process.stdin.resume()"], env: process.env, onRequest: () => ({}),
  }).start();
  t.after(() => client.stop());
  const rejected = assert.rejects(client.request("tool", { name: "send_peer" }, 60_000), { code: "bridge-lost" });
  const started = Date.now();
  await client.stop();
  await rejected;
  assert.ok(Date.now() - started < 3000);
});

test("a request over the 4 MiB line limit is refused unwritten as a definite too-large failure", async (t) => {
  const f = await fixture(t);
  await f.waitFor((messages) => messages.some((message) => message.method === "hello"), "the hello");
  // Control characters escape to six bytes each, so 700k of them exceed 4 MiB.
  const result = await f.ctx.tools.find((tool) => tool.name === "send_peer").execute(
    { to: "uds:/tmp/peer.sock", message: "\u0001".repeat(700_000) }, { sessionID: "ses_root" });
  assert.equal(result.metadata.isError, true);
  assert.equal(result.metadata.structuredContent.status, "failed");
  assert.equal(result.metadata.structuredContent.reason, "too-large");
  assert.match(result.content[0].text, /nothing was sent/);
  assert.equal(f.messages().some((message) => message.method === "tool"), false);
});

test("an instance that sets up while the last one's child stops keeps its bridge_command", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ap-ocp-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = await fixture(t, { command: [process.execPath, fakeBridge, "--log", join(dir, "bridge.jsonl"), "--exit-delay", "1000"] });
  await until(() => globalThis[KEY]?.client?.alive, "the first child");
  const closing = first.cleanup();
  // The old child takes a second to exit; the reload sets up inside that window.
  await until(() => globalThis[KEY]?.client === null, "the old child to start stopping");
  const reload = context(first.dir, new Map([["ses_root", { id: "ses_root", location: { directory: "/repo" } }]]));
  reload.options = first.ctx.options;
  const cleanup = await plugin.setup(reload);
  t.after(() => cleanup());
  await closing;
  assert.deepEqual(globalThis[KEY].options?.bridge_command, first.ctx.options.bridge_command);
  const result = await reload.tools[0].execute({}, { sessionID: "ses_root" });
  assert.equal(result.content[0].text, "echo");
});

function eventState(subscribe) {
  const instance = "instance-1";
  return { instance, state: { instances: new Map([[instance, { ctx: { event: { subscribe } } }]]) } };
}

test("a failing event stream resubscribes with 1 s to 30 s backoff, logs sparsely, and resets after an event", async () => {
  let calls = 0;
  const { instance, state } = eventState(() => {
    calls++;
    // The fifth stream delivers one event and ends; every other one fails at once.
    if (calls === 5) return (async function* () { yield { type: "unrelated" }; })();
    throw new Error("stream down");
  });
  let clock = 0;
  const waits = [], reports = [];
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  const delay = async (ms) => {
    waits.push(ms);
    clock += ms;
    if (waits.length === 14) { state.instances.delete(instance); finish(); }
  };
  const disposers = [];
  subscribeEvents(state, instance, disposers, { delay, now: () => clock, report: (event, fields) => reports.push({ at: clock, ...fields }) });
  await done;
  await disposers[0]();
  assert.deepEqual(waits, [1000, 2000, 4000, 8000, 1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000]);
  assert.deepEqual(reports.map((r) => [r.at, r.reason]), [
    [0, "stream"], [15_000, "stream-ended"], [46_000, "stream"], [76_000, "stream"], [106_000, "stream"], [136_000, "stream"],
    [166_000, "stream"],
  ]);
});

test("cleanup does not hang on an event stream that ignores the abort", async () => {
  const { instance, state } = eventState(() => ({ [Symbol.asyncIterator]() { return { next: () => new Promise(() => {}) }; } }));
  const disposers = [];
  subscribeEvents(state, instance, disposers);
  const started = Date.now();
  await disposers[0]();
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 900 && elapsed < 3000, `cleanup took ${elapsed} ms`);
});
