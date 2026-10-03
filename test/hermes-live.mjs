#!/usr/bin/env node
// Paid live contract: a real Hermes bridge exchanges messages with disposable Codex and
// Claude sessions. Uses only isolated discovery registries and test-owned inbox addresses.
// Pass --codex-only to check Codex without installing or launching Claude.

import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AppServer } from "../src/app-server.mjs";
import { address, allPeers } from "../src/wire.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const codexOnly = process.argv.includes("--codex-only");
const output = join(root, "artifacts", "hermes-live", new Date().toISOString().replace(/[:.]/g, "-"));
const tmp = mkdtempSync(join(tmpdir(), "agent-peers-hermes-live-"));
const registry = join(tmp, "peers"), claudeRegistry = join(tmp, "claude-discovery");
const appSocket = join(tmp, "app.sock");
const sourceClaudeHome = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
const sourceEnv = { ...process.env };
const nonce = randomUUID().slice(0, 8);
const processes = [], participants = [], hidden = new Map(), notifications = [], codexEvents = [];
const completed = new Map(), active = new Map(), checks = [];
const report = { startedAt: new Date().toISOString(), mode: codexOnly ? "codex-only" : "codex-and-claude", output, passed: false, checks };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message) => console.log(`${new Date().toISOString()} ${message}`);
const saveReport = () => writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
let cancelled, app, bridge, client;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { cancelled = signal; });
mkdirSync(output, { recursive: true });
mkdirSync(registry, { mode: 0o700 });
mkdirSync(join(claudeRegistry, "sessions"), { recursive: true, mode: 0o700 });
const isolatedEnv = { ...sourceEnv, AGENT_PEERS_HOME: registry, CLAUDE_CONFIG_DIR: claudeRegistry,
  AGENT_PEERS_CODEX_APP_SERVER: appSocket };
Object.assign(process.env, { AGENT_PEERS_HOME: registry, CLAUDE_CONFIG_DIR: claudeRegistry,
  AGENT_PEERS_CODEX_APP_SERVER: appSocket });

async function until(label, fn, timeoutMs = 180_000) {
  const end = Date.now() + timeoutMs;
  let progress = Date.now();
  while (Date.now() < end) {
    if (cancelled) throw new Error(`Interrupted by ${cancelled}`);
    for (const p of participants) {
      const failure = p.events?.find((event) => event.type === "result" && event.is_error);
      if (failure) throw new Error(`${p.kind}: ${failure.result ?? failure.terminal_reason}`);
    }
    if (report.processError) throw new Error(report.processError);
    const value = await fn();
    if (value) return value;
    for (const p of processes) if (p.exitCode !== null || p.signalCode !== null) {
      throw new Error(`${p.testLabel} exited while waiting for ${label}: ${p.exitCode ?? p.signalCode}`);
    }
    if (Date.now() - progress > 20_000) { log(`waiting: ${label}`); progress = Date.now(); }
    await sleep(250);
  }
  throw new Error(`Timed out: ${label}`);
}

function launch(label, command, args, options = {}) {
  const child = spawn(command, args, { cwd: tmp, detached: true, stdio: ["pipe", "pipe", "pipe"],
    env: isolatedEnv, ...options });
  child.testLabel = label;
  child.on("error", (error) => { report.processError = `${label}: ${error.message}`; });
  child.stdin.on("error", (error) => { report.processError ??= `${label} input: ${error.message}`; });
  child.stderr.on("data", (data) => appendFileSync(join(output, `${label}.stderr.log`), data));
  processes.push(child);
  return child;
}

function lines(stream, filename, onLine) {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (data) => {
    appendFileSync(join(output, filename), data);
    buffer += data;
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (line.trim()) { try { onLine(JSON.parse(line)); } catch (error) { report.parseError ??= error.message; } }
    }
  });
}

function startBridge() {
  const child = launch("hermes-bridge", process.execPath, [join(root, "bin", "agent-peers.mjs"), "hermes-bridge"]);
  const pending = new Map();
  let next = 0;
  lines(child.stdout, "hermes-bridge.jsonl", (line) => {
    if (line.method === "peer_message") notifications.push(line.params);
    else if (pending.has(line.id)) {
      const request = pending.get(line.id); pending.delete(line.id); clearTimeout(request.timer);
      if (line.error) request.reject(new Error(line.error.message)); else request.resolve(line.result);
    }
  });
  const fail = (error) => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
  };
  child.on("exit", () => fail(new Error("Hermes bridge exited")));
  child.on("error", fail);
  child.stdin.on("error", fail);
  return { child, request: (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Hermes ${method} timed out`)); }, 15_000);
    pending.set(id, { resolve, reject, timer });
    const message = { id, method, params };
    appendFileSync(join(output, "hermes-requests.jsonl"), JSON.stringify(message) + "\n");
    child.stdin.write(JSON.stringify(message) + "\n");
  }) };
}

async function assertInvisible(phase) {
  const listings = [allPeers(), (await bridge.request("list_peers")).peers];
  const cli = execFileSync(process.execPath, [join(root, "bin", "agent-peers.mjs"), "list"],
    { cwd: tmp, env: isolatedEnv, encoding: "utf8" });
  const mcp = await client.callTool({ name: "list_peers", arguments: {} });
  assert.ok(Array.isArray(mcp.structuredContent?.peers), "real MCP list_peers returns structured peers");
  listings.push(mcp.structuredContent.peers);
  for (const peers of listings) {
    assert.ok(peers.every((peer) => peer.kind !== "hermes" && !peer.name?.startsWith("hermes:")), `${phase}: Hermes is not listed`);
    const text = JSON.stringify(peers);
    for (const inbox of hidden.values()) assert.ok(!text.includes(inbox), `${phase}: private inbox is absent`);
  }
  assert.ok(!cli.includes("hermes:"), `${phase}: CLI does not advertise Hermes`);
  for (const inbox of hidden.values()) assert.ok(!cli.includes(inbox), `${phase}: CLI has no private inbox`);
  for (const peer of participants.filter((p) => p.address)) {
    assert.ok(listings.every((peers) => JSON.stringify(peers).includes(peer.address)), `${phase}: every listing discovers ${peer.kind}`);
    assert.ok(cli.includes(peer.address), `${phase}: CLI discovers ${peer.kind}`);
  }
  checks.push({ test: "invisible", phase, interfaces: ["allPeers", "bridge", "CLI", "MCP"], passed: true });
  appendFileSync(join(output, "discovery.jsonl"), JSON.stringify({ phase, listings, cli, mcp }) + "\n");
  saveReport();
}

const protocol = "You are in a user-authorized local messaging integration test. " +
  "Reply only to the hidden Hermes test profile that messages you in this conversation, using its provided sender/reply_to address. " +
  "When it sends PING followed by a codeword, call your native peer messaging tool once with message PONG and that same codeword. " +
  "Do not message any other peer. Handle incoming messages while busy as well as when idle. " +
  "After sending the reply, finish your turn briefly. Never edit files or inspect unrelated user data. ";

async function codexTurn(peer, text) {
  appendFileSync(join(output, "test-inputs.jsonl"), JSON.stringify({ kind: "codex", text }) + "\n");
  return (await app.request("turn/start", { threadId: peer.id, input: [{ type: "text", text, text_elements: [] }] })).turn.id;
}

function claudeTurn(peer, text) {
  appendFileSync(join(output, "test-inputs.jsonl"), JSON.stringify({ kind: "claude", text }) + "\n");
  peer.process.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n");
}

async function roundtrip(peer, session, phase, busyTurn) {
  const token = `${nonce}-${peer.kind}-${phase}`;
  const sent = await bridge.request("send_peer", { session, name: `hermes:live-${session}`, to: peer.name,
    message: `PING ${token}\nReply once using ${peer.kind === "codex" ? "send_peer" : "SendMessage"} to this message's sender address with exactly PONG ${token}.` });
  assert.match(sent.text, /^Delivered to/);
  if (hidden.has(session)) assert.equal(sent.address, hidden.get(session), "conversation keeps its private address");
  hidden.set(session, sent.address);
  await assertInvisible(`${peer.kind}-${phase}-awaiting-reply`);
  const received = await until(`${peer.kind} ${phase} native reply`, () => notifications.find((message) => message.message.includes(`PONG ${token}`)));
  assert.equal(received.session, session, "reply returns to the originating Hermes conversation");
  assert.equal(received.from, peer.address, "reply has the real recipient's sender address");
  assert.ok(received.message_id, "reply has a deduplication ID");
  if (peer.kind === "codex") {
    const native = await until("Codex send_peer completed", () => codexEvents.find((event) =>
      event.method === "item/completed" && event.params.threadId === peer.id &&
      event.params.item.tool === "send_peer" && event.params.item.arguments?.message?.includes(token)));
    assert.equal(native.params.item.arguments.to, sent.address, "Codex replies to the unlisted private inbox");
    assert.match(native.params.item.result?.content?.[0]?.text ?? "", /^Delivered to/);
    if (busyTurn) assert.equal(native.params.turnId, busyTurn, "Codex handled the reply inside the busy turn");
    await until("Codex turn settled", () => !active.has(peer.id));
  } else {
    const native = peer.events.flatMap((event) => event.type === "assistant" ? event.message?.content ?? [] : [])
      .find((block) => block.type === "tool_use" && block.name === "SendMessage" && block.input?.message?.includes(token));
    assert.ok(native, "Claude answered through native SendMessage");
    assert.equal(native.input.to, sent.address, "Claude replies to the unlisted private inbox");
    await until("Claude reply turn settled", () => peer.events.slice(peer.turnStart)
      .some((event) => event.type === "result"));
  }
  checks.push({ test: "roundtrip", recipient: peer.kind, phase, session, token, nativeTool: peer.kind === "codex" ? "send_peer" : "SendMessage", passed: true });
  log(`PASS Hermes -> ${peer.kind} (${phase}) -> Hermes`);
  await assertInvisible(`${peer.kind}-${phase}-answered`);
}

async function run() {
  report.versions = { codex: execFileSync("codex", ["--version"], { encoding: "utf8" }).trim(),
    ...(!codexOnly ? { claude: execFileSync("claude", ["--version"], { encoding: "utf8" }).trim() } : {}) };
  log(`evidence: ${output}`);
  const configPath = join(sourceEnv.CODEX_HOME || join(homedir(), ".codex"), "config.toml");
  const config = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const disable = [...new Set([...config.matchAll(/^\s*\[\s*mcp_servers\s*\.\s*("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)(?:\s*\.[^\]\n]*)?\s*\]/gm)]
    .map((match) => `mcp_servers.${match[1]}.enabled=false`))];
  const overrides = [...disable, "features.hooks=false", "features.memories=false",
    'mcp_servers.agent-peers.enabled=true', `mcp_servers.agent-peers.command=${JSON.stringify(process.execPath)}`, 'mcp_servers.agent-peers.default_tools_approval_mode="approve"',
    `mcp_servers.agent-peers.args=[${JSON.stringify(join(root, "src", "codex-peer.mjs"))}]`,
    `mcp_servers.agent-peers.env={AGENT_PEERS_CODEX_APP_SERVER=${JSON.stringify(appSocket)},AGENT_PEERS_HOME=${JSON.stringify(registry)},CLAUDE_CONFIG_DIR=${JSON.stringify(claudeRegistry)},AGENT_PEERS_LOG=${JSON.stringify(join(output, "codex-peer.log"))}}`];
  const daemon = launch("codex-app-server", "codex", [...overrides.flatMap((value) => ["-c", value]), "app-server", "--listen", `unix://${appSocket}`]);
  daemon.stdout.on("data", (data) => appendFileSync(join(output, "codex-app-server.stdout.log"), data));
  await until("private Codex app-server", () => existsSync(appSocket), 30_000);
  app = new AppServer((event) => {
    codexEvents.push(event);
    appendFileSync(join(output, "codex-events.jsonl"), JSON.stringify(event) + "\n");
    if (event.method === "turn/started") active.set(event.params.threadId, event.params.turn.id);
    if (event.method === "turn/completed") { completed.set(event.params.turn.id, event.params.turn); active.delete(event.params.threadId); }
  });
  const work = join(tmp, "work"); mkdirSync(work);
  const { thread } = await app.request("thread/start", { cwd: work, ephemeral: true, approvalPolicy: "never", sandbox: "read-only" });
  const codex = { kind: "codex", id: thread.id }; participants.push(codex);
  const boot = await codexTurn(codex, protocol + "Call agent-peers list_peers once and then reply READY.");
  await until("Codex ready", () => completed.has(boot));
  assert.equal(completed.get(boot).status, "completed");
  const meta = JSON.parse(readFileSync(join(registry, `codex-${thread.id}.json`), "utf8"));
  codex.name = meta.name; codex.address = meta.address;

  bridge = startBridge();
  client = new Client({ name: "hermes-live-discovery", version: "1.0.0" });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [join(root, "src", "codex-peer.mjs")], cwd: tmp, env: isolatedEnv, stderr: "pipe" });
  await client.connect(transport);
  transport.stderr?.on("data", (data) => appendFileSync(join(output, "mcp-discovery.stderr.log"), data));
  await assertInvisible("before-first-message");
  await roundtrip(codex, "profile-a-conversation-a", "idle");
  const busy = await codexTurn(codex, "Run `sleep 12` using the shell, then reply DONE. Keep following the Hermes test reply protocol for incoming messages.");
  await until("Codex shell command running", () => codexEvents.some((event) => event.method === "item/started" &&
    event.params.turnId === busy && event.params.item.type === "commandExecution" && /sleep 12/.test(event.params.item.command)), 90_000);
  assert.ok(active.has(codex.id), "Codex is busy at send time");
  await roundtrip(codex, "profile-b-conversation-b", "busy", busy);
  assert.notEqual(hidden.get("profile-a-conversation-a"), hidden.get("profile-b-conversation-b"), "different Hermes conversations have different private inboxes");

  if (!codexOnly) {
    const claude = { kind: "claude", events: [] }; participants.push(claude);
    claude.process = launch("claude", "claude", ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
      "--name", `hermes-live-${nonce}`, "--no-session-persistence", "--disable-slash-commands",
      "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
      "--settings", JSON.stringify({ crossSessionInbound: "accept", disableAllHooks: true }),
      "--allowedTools", "Bash(sleep *),SendMessage,ListAgents",
      "--append-system-prompt", readFileSync(join(root, "CLAUDE-snippet.md"), "utf8")],
    { cwd: work, env: { ...sourceEnv, AGENT_PEERS_HOME: registry } });
    lines(claude.process.stdout, "claude.jsonl", (event) => claude.events.push(event));
    claudeTurn(claude, protocol + "For now, reply READY.");
    const claudeMeta = await until("Claude real inbox", () => {
      try { const value = JSON.parse(readFileSync(join(sourceClaudeHome, "sessions", `${claude.process.pid}.json`), "utf8")); return value.messagingSocketPath && value; } catch {}
    }, 90_000);
    // Mirror only this test-owned session's public registry entry. Never copy account or memory data.
    writeFileSync(join(claudeRegistry, "sessions", `${claude.process.pid}.json`), JSON.stringify(claudeMeta), { mode: 0o600 });
    claude.address = address(claudeMeta.messagingSocketPath); claude.name = `claude:${claudeMeta.name ?? claudeMeta.pid}`;
    await until("Claude ready", () => claude.events.some((event) => event.type === "result" && !event.is_error));
    claude.turnStart = claude.events.length;
    await roundtrip(claude, "profile-a-conversation-a", "idle");
    claude.turnStart = claude.events.length;
    claudeTurn(claude, "Run `sleep 12` with Bash, then reply DONE. Keep following the Hermes test reply protocol for incoming messages.");
    await until("Claude Bash sleep started", () => claude.events.slice(claude.turnStart).some((event) =>
      event.type === "assistant" && event.message?.content?.some((block) => block.type === "tool_use" && block.name === "Bash" && /sleep 12/.test(block.input?.command))), 90_000);
    assert.ok(!claude.events.slice(claude.turnStart).some((event) => event.type === "result"), "Claude is busy at send time");
    await roundtrip(claude, "profile-b-conversation-b", "busy");
  }
  for (const session of hidden.keys()) {
    assert.equal((await bridge.request("close_session", { session })).closed, true);
    assert.ok(!existsSync(decodeURIComponent(hidden.get(session).slice(4))), "closed private inbox is retired");
  }
  await assertInvisible("after-private-inboxes-retired");
  assert.equal(notifications.length, codexOnly ? 2 : 4, "each test message received one reply, without cross-conversation duplicates");
  report.passed = true;
}

async function cleanup() {
  await client?.close().catch(() => {});
  await app?.close?.();
  if (bridge?.child.exitCode === null) await bridge.request("shutdown").catch(() => {});
  for (const child of [...processes].reverse()) { try { process.kill(-child.pid, "SIGTERM"); } catch {} }
  await sleep(1000);
  for (const child of processes) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
  // All names below came from test-owned processes or the test's bridge responses.
  for (const peer of participants) {
    if (peer.address) rmSync(decodeURIComponent(peer.address.slice(4)), { force: true });
    if (peer.kind === "claude" && peer.process) rmSync(join(sourceClaudeHome, "sessions", `${peer.process.pid}.json`), { force: true });
  }
  for (const inbox of hidden.values()) rmSync(decodeURIComponent(inbox.slice(4)), { force: true });
  rmSync(tmp, { recursive: true, force: true });
}

try { await run(); }
catch (error) { report.error = error.stack; console.error(error.stack); process.exitCode = 1; }
finally {
  report.finishedAt = new Date().toISOString();
  report.participants = participants.map((peer) => ({ kind: peer.kind, id: peer.id, name: peer.name, address: peer.address,
    model: peer.events?.find((event) => event.type === "system" && event.subtype === "init")?.model,
    failure: peer.events?.find((event) => event.type === "result" && event.is_error)?.result }));
  report.hiddenConversations = Object.fromEntries(hidden);
  saveReport();
  await cleanup();
  log(`${report.passed ? "PASS" : "FAIL"}: ${join(output, "report.json")}`);
  process.exit(process.exitCode ?? 0);
}
