#!/usr/bin/env node
// Paid, live integration test: two real Codex root sessions and two real Claude Code
// processes. Only these participants may exchange messages. No stand-in peer inboxes.
// Run with node test/live-matrix.mjs; retain transcripts and a JSON report in artifacts/.

import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { AppServer } from "../src/app-server.mjs";
import { address } from "../src/wire.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const codexOnly = process.argv.includes("--codex-only");
const coordinationOnly = process.argv.includes("--coordination-only");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const output = join(root, "artifacts", `live-${stamp}`);
const tmp = mkdtempSync(join(tmpdir(), "agent-peers-live-"));
const registry = join(tmp, "peers"), claudeRegistry = join(tmp, "claude-discovery");
const appSocket = join(tmp, "app.sock");
const nonce = randomUUID().slice(0, 8);
const processes = [], participants = [], codexEvents = [], checks = [];
const completed = new Map(), active = new Map();
let cancelled;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { cancelled = signal; });
const report = { startedAt: new Date().toISOString(), mode: codexOnly ? "codex-only" : "four-session", coordinationOnly, output, versions: {}, participants: [], checks, passed: false };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
const log = (s) => console.log(`${new Date().toISOString()} ${s}`);
const saveReport = () => writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
mkdirSync(output, { recursive: true });
mkdirSync(registry, { mode: 0o700 });
mkdirSync(join(claudeRegistry, "sessions"), { recursive: true, mode: 0o700 });

async function until(label, fn, timeoutMs = 240_000) {
  const end = Date.now() + timeoutMs;
  let progress = Date.now();
  while (Date.now() < end) {
    if (cancelled) throw new Error(`Test interrupted by ${cancelled}`);
    if (report.processError) throw new Error(report.processError);
    for (const p of participants) {
      const failure = p.events?.find((e) => e.type === "result" && e.is_error);
      if (failure) throw new Error(`${p.label}: ${failure.result ?? failure.terminal_reason}`);
    }
    const value = await fn();
    if (value) return value;
    for (const p of processes) if (p.exitCode != null || p.signalCode != null) {
      throw new Error(`${p.testLabel} exited during ${label}: ${p.exitCode ?? p.signalCode}`);
    }
    if (Date.now() - progress > 20_000) {
      log(`waiting: ${label}`);
      progress = Date.now();
    }
    await sleep(250);
  }
  throw new Error(`Timed out: ${label}`);
}

function launch(label, command, args, options = {}) {
  const p = spawn(command, args, { cwd: tmp, detached: true, stdio: ["pipe", "pipe", "pipe"], ...options });
  p.testLabel = label;
  processes.push(p);
  p.on("error", (e) => { report.processError = `${label}: ${e.message}`; });
  p.stdin.on("error", (e) => { report.processError ??= `${label} input: ${e.message}`; });
  p.stderr.on("data", (data) => appendFileSync(join(output, `${label}.stderr.log`), data));
  return p;
}

async function cleanup() {
  await app?.close?.();
  for (const p of [...processes].reverse()) {
    try { process.kill(-p.pid, "SIGTERM"); } catch {}
  }
  await sleep(1000);
  for (const p of processes) {
    try { process.kill(-p.pid, "SIGKILL"); } catch {}
  }
  // Only files belonging to this test's identities are eligible for cleanup.
  for (const p of participants) {
    if (p.address) rmSync(decodeURIComponent(p.address.slice(4)), { force: true });
    if (p.kind === "claude") rmSync(join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "sessions", `${p.process.pid}.json`), { force: true });
  }
  rmSync(tmp, { recursive: true, force: true });
}

const protocol =
  "You are participating in a user-requested local messaging integration test. " +
  "Only message the test participants explicitly identified in this conversation. " +
  "On receiving a peer message beginning PING followed by a token, reply to that sender with PONG and the same token. " +
  "On receiving PONG, print RECEIVED followed by its token to the user, and do not send another peer reply. " +
  "Handle incoming test messages even while you are carrying out a user instruction. " +
  "Finish each turn when its requests are complete; later peer messages may start new turns. ";

function claudeInput(p, text) {
  p.process.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n");
}

function toolSends(p) {
  if (p.kind === "codex") return codexEvents.filter((e) => e.method === "item/completed" && e.params.threadId === p.id)
    .map((e) => e.params.item).filter((i) => i.tool === "send_peer")
    .map((i) => ({ to: i.arguments?.to, message: i.arguments?.message, result: i.result, error: i.error }));
  return p.events.flatMap((e) => e.type === "assistant" ? e.message?.content ?? [] : [])
    .filter((b) => b.type === "tool_use" && b.name === "SendMessage")
    .map((b) => ({ to: b.input?.to, message: b.input?.message, id: b.id }));
}

function assistantText(p) {
  if (p.kind === "codex") return codexEvents.filter((e) => e.method === "item/completed" && e.params.threadId === p.id && e.params.item.type === "agentMessage")
    .map((e) => e.params.item.text).join("\n");
  return p.events.flatMap((e) => e.type === "assistant" ? e.message?.content ?? [] : [])
    .filter((b) => b.type === "text").map((b) => b.text).join("\n");
}

let app;
const turn = async (p, text) => {
  appendFileSync(join(output, "test-inputs.jsonl"), JSON.stringify({ at: new Date().toISOString(), participant: p.label, text }) + "\n");
  if (p.kind === "claude") return claudeInput(p, text);
  return (await app.request("turn/start", { threadId: p.id, input: [{ type: "text", text, text_elements: [] }] })).turn.id;
};

async function coordinationCheck() {
  const a = participants.find((p) => p.label === "C1");
  const b = participants.find((p) => p.label === "H1") ?? participants.find((p) => p.label === "C2");
  const pair = [a, b];
  const start = new Map(pair.map((p) => [p.label, toolSends(p).length]));
  const brief = "Jointly review a batch-import API. POST /imports accepts sourceUrl and returns 202 with jobId. " +
    "GET /imports/:jobId returns status queued, running, succeeded, or failed; failure details are {code,message}. " +
    "There are no automatic retries in v1. This is a design review; no repository edits are needed. ";
  await turn(b, brief + `You own worker lifecycle and background errors. Your teammate ${a.name} (inbox ${a.address}) owns the HTTP contract and will propose the initial interface agreement. ` +
    `Coordinate as needed, then give your user a concise draft ending DRAFT ${b.label}.`);
  await turn(a, brief + `You own the HTTP contract and request validation. Your teammate ${b.name} (inbox ${b.address}) owns worker lifecycle and background errors. ` +
    `Propose the initial ownership and interface agreement, coordinate as needed, then give your user a concise draft ending DRAFT ${a.label}.`);
  await until("scope agreement and drafts", () => pair.every((p) => assistantText(p).includes(`DRAFT ${p.label}`)), 300_000);
  await until("coordination settles", () => pair.every((p) => p.kind !== "codex" || !active.has(p.id)));
  await sleep(3000);
  const beforeLocal = new Map(pair.map((p) => [p.label, toolSends(p).length]));
  for (const p of pair) await turn(p,
    "Continue your own draft with two illustrative examples within your agreed scope. Requirements and interfaces are unchanged. " +
    `Return the examples to your user, ending LOCAL_DONE ${p.label}. Keep these as a draft for the final review.`);
  await until("independent draft work", () => pair.every((p) => assistantText(p).includes(`LOCAL_DONE ${p.label}`)), 240_000);
  await until("independent turns settle", () => pair.every((p) => p.kind !== "codex" || !active.has(p.id)));
  await sleep(3000);
  const local = pair.flatMap((p) => toolSends(p).slice(beforeLocal.get(p.label)).map((s) => ({ from: p.label, to: s.to, message: s.message })));
  const beforeChange = new Map(pair.map((p) => [p.label, toolSends(p).length]));
  await turn(a,
    "New requirement: clients must safely repeat POST after a network timeout without creating duplicate import jobs. " +
    "The HTTP contract should support Idempotency-Key. Coordinate any worker-side implications with your teammate, " +
    `then give your user a final recommendation ending CHANGE_DONE ${a.label}.`);
  await until("meaningful requirement change coordinated", () =>
    assistantText(a).includes(`CHANGE_DONE ${a.label}`) &&
    toolSends(a).slice(beforeChange.get(a.label)).some((s) => /idempotency|duplicate|retry/i.test(s.message ?? "")) &&
    toolSends(b).length > beforeChange.get(b.label), 300_000);
  const messages = pair.flatMap((p) => toolSends(p).slice(start.get(p.label)).map((s) => ({ from: p.label, to: s.to, message: s.message })));
  // Record behavior for review; do not turn a communication preference into a message quota.
  checks.push({ test: "coordination", participants: pair.map((p) => p.label), passed: true,
    independentPhaseMessages: local, messages });
  log(`PASS coordination task; ${local.length} peer messages during independent draft work (observation, not a quota)`);
  saveReport();
}

async function run() {
  report.versions = {
    codex: execFileSync("codex", ["--version"], { encoding: "utf8" }).trim(),
    ...(!codexOnly ? { claude: execFileSync("claude", ["--version"], { encoding: "utf8" }).trim() } : {}),
  };
  log(`evidence: ${output}`);
  const sourceClaudeHome = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  for (const label of codexOnly ? [] : ["H1", "H2"]) {
    const work = join(tmp, label);
    mkdirSync(work);
    const p = { label, kind: "claude", events: [] };
    p.process = launch(label, "claude", [
      "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
      "--name", `live-${nonce}-${label}`, "--no-session-persistence", "--disable-slash-commands",
      "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
      "--settings", JSON.stringify({ crossSessionInbound: "accept", disableAllHooks: true }),
      "--allowedTools", "Bash,SendMessage,ListAgents",
      "--append-system-prompt", readFileSync(join(root, "CLAUDE-snippet.md"), "utf8"),
    ], { cwd: work, env: { ...process.env, AGENT_PEERS_HOME: registry } });
    let buffer = "";
    p.process.stdout.on("data", (data) => {
      appendFileSync(join(output, `${label}.jsonl`), data);
      buffer += data;
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try { p.events.push(JSON.parse(line)); } catch {}
      }
    });
    participants.push(p);
    await turn(p, protocol + `Your test label is ${label}. For now, reply READY ${label}.`);
  }
  for (const p of participants) {
    const meta = await until(`${p.label} real inbox`, () => {
      try {
        const r = JSON.parse(readFileSync(join(sourceClaudeHome, "sessions", `${p.process.pid}.json`), "utf8"));
        return r.messagingSocketPath && r;
      } catch {}
    }, 90_000);
    // Mirror only these real session metadata entries for isolated discovery. The processes
    // and sockets are the real Claude sessions; no credentials are copied or changed.
    writeFileSync(join(claudeRegistry, "sessions", `${p.process.pid}.json`), JSON.stringify(meta), { mode: 0o600 });
    p.address = address(meta.messagingSocketPath);
    p.name = `claude:${meta.name ?? meta.pid}`;
    await until(`${p.label} ready`, () => assistantText(p).includes(`READY ${p.label}`));
    log(`${p.label} ready: ${p.name}`);
  }

  const configPath = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "config.toml");
  const config = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const disable = [...new Set([...config.matchAll(/^\s*\[\s*mcp_servers\s*\.\s*("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)(?:\s*\.[^\]\n]*)?\s*\]/gm)]
    .map((match) => `mcp_servers.${match[1]}.enabled=false`))];
  const overrides = [...disable, "features.hooks=false", "features.memories=false",
    'mcp_servers.agent-peers.enabled=true', `mcp_servers.agent-peers.command=${JSON.stringify(process.execPath)}`, 'mcp_servers.agent-peers.default_tools_approval_mode="approve"',
    `mcp_servers.agent-peers.args=[${JSON.stringify(join(root, "src/codex-peer.mjs"))}]`,
    `mcp_servers.agent-peers.env={AGENT_PEERS_CODEX_APP_SERVER=${JSON.stringify(appSocket)},AGENT_PEERS_HOME=${JSON.stringify(registry)},CLAUDE_CONFIG_DIR=${JSON.stringify(claudeRegistry)},AGENT_PEERS_LOG=${JSON.stringify(join(output, "codex-peer.log"))}}`,
  ];
  const daemon = launch("codex-app-server", "codex", [...overrides.flatMap((s) => ["-c", s]), "app-server", "--listen", `unix://${appSocket}`]);
  daemon.stdout.on("data", (data) => appendFileSync(join(output, "codex-app-server.stdout.log"), data));
  await until("private Codex app-server", () => existsSync(appSocket), 30_000);
  process.env.AGENT_PEERS_CODEX_APP_SERVER = appSocket;
  app = new AppServer((event) => {
    codexEvents.push(event);
    appendFileSync(join(output, "codex-events.jsonl"), JSON.stringify(event) + "\n");
    if (event.method === "turn/started") active.set(event.params.threadId, event.params.turn.id);
    if (event.method === "turn/completed") {
      completed.set(event.params.turn.id, event.params.turn);
      active.delete(event.params.threadId);
    }
  });
  const boot = [];
  for (const label of ["C1", "C2"]) {
    const work = join(tmp, label);
    mkdirSync(work);
    const { thread } = await app.request("thread/start", { cwd: work, ephemeral: true, approvalPolicy: "never", sandbox: "read-only" });
    const p = { label, kind: "codex", id: thread.id };
    participants.push(p);
    const turnId = await turn(p, protocol + `Your test label is ${label}. Call list_peers once, then reply READY ${label}.`);
    boot.push({ p, turnId });
  }
  for (const { p, turnId } of boot) {
    await until(`${p.label} ready`, () => completed.has(turnId));
    assert.equal(completed.get(turnId).status, "completed");
    const meta = JSON.parse(readFileSync(join(registry, `codex-${p.id}.json`), "utf8"));
    p.address = meta.address; p.name = meta.name;
    log(`${p.label} ready: ${p.name}`);
  }
  report.participants = participants.map(({ label, kind, id, name, address }) => ({ label, kind, id, name, address }));
  saveReport();
  if (coordinationOnly) {
    await coordinationCheck();
    report.passed = true;
    return;
  }

  const discoveryCommand = `CLAUDE_CONFIG_DIR=${quote(claudeRegistry)} AGENT_PEERS_HOME=${quote(registry)} ${quote(process.execPath)} ${quote(join(root, "bin/agent-peers.mjs"))} list`;
  const routes = participants.flatMap((from) => participants.filter((to) => to !== from)
    .map((to) => ({ from, to, token: `${nonce}-${from.label}-${to.label}` })));
  log(`${participants.length} real sessions are live; starting all ${routes.length} directed routes concurrently`);
  for (const p of participants) {
    const targets = routes.filter((r) => r.from === p).map((r) => ({ name: r.to.name, message: `PING ${r.token}` }));
    await turn(p,
      (p.kind === "codex" ? "Call list_peers to discover the other test participants. " : `Run this exact discovery command with Bash: ${discoveryCommand}. `) +
      "Use the route shown for your own platform to send each of these messages exactly once: " + JSON.stringify(targets) + ". " +
      "Only send to these test participants. Handle incoming PING and PONG messages using the established test protocol. " +
      `After sending your ${targets.length} requests, print SENT ${p.label}.`);
  }
  await until(`all ${routes.length} request/reply routes`, () => {
    let count = 0;
    for (const r of routes) {
      const request = toolSends(r.from).find((s) => s.message?.trim() === `PING ${r.token}` && [r.to.address, r.to.name].includes(s.to));
      const reply = toolSends(r.to).find((s) => s.message?.trim() === `PONG ${r.token}` && [r.from.address, r.from.name].includes(s.to));
      const received = assistantText(r.from).includes(`RECEIVED ${r.token}`);
      if (request && reply && received) count++;
      if (request && reply && received && !checks.some((c) => c.token === r.token)) {
        checks.push({ test: "roundtrip", from: r.from.label, to: r.to.label, token: r.token, passed: true });
        log(`PASS ${r.from.label} -> ${r.to.label} -> ${r.from.label}`);
        saveReport();
      }
    }
    return count === routes.length;
  }, 480_000);

  for (const p of participants.filter((p) => p.kind === "codex")) {
    const listings = codexEvents.filter((e) => e.method === "item/completed" && e.params.threadId === p.id && e.params.item.tool === "list_peers");
    const full = listings.map((e) => e.params.item.result?.structuredContent?.peers).find((peers) => peers?.length === participants.length - 1);
    assert.ok(full, `${p.label} discovered all other test sessions`);
    assert.ok(full.every((peer) => peer.native.reachable === false && peer.bridge?.tool === "send_peer"));
    checks.push({ test: "discovery", participant: p.label, native: 0, bridge: full.length, passed: true });
  }
  for (const p of participants.filter((p) => p.kind === "claude")) {
    const results = p.events.filter((e) => e.type === "user").flatMap((e) => e.message?.content ?? [])
      .filter((b) => b.type === "tool_result").map((b) => typeof b.content === "string" ? b.content : JSON.stringify(b.content));
    assert.ok(results.some((s) => participants.every((peer) => s.includes(peer.address)) && s.includes("Claude native: SendMessage")), `${p.label} saw native routes for all four inboxes`);
    checks.push({ test: "discovery", participant: p.label, native: 4, passed: true });
  }
  log("PASS discovery routes from every test session");

  const parent = participants.find((p) => p.label === "C1");
  await until("Codex C1 idle before native-agent check", () => !active.has(parent.id));
  const nativeToken = `${nonce}-NATIVE`;
  const nativeTurn = await turn(parent,
    "Test native discovery in your own session. Spawn one agent named native_probe. Its task: on a native message PING " + nativeToken +
    ", send PONG " + nativeToken + " to the parent using native send_message; then finish. Tell it to remain available using clock.sleep until it receives that message. " +
    "After spawning it, call agent-peers list_peers. Find native_probe in that output, then send PING " + nativeToken +
    " using the native tool and target shown there. Wait until the child replies. Finally print NATIVE_OK " + nativeToken + ". Do not send this token to any external session.");
  await until("native agent discovered and answered", () => completed.has(nativeTurn), 300_000);
  assert.equal(completed.get(nativeTurn).status, "completed");
  const nativeListing = codexEvents.filter((e) => e.method === "item/completed" && e.params.threadId === parent.id && e.params.item.tool === "list_peers")
    .map((e) => e.params.item.result?.structuredContent?.peers).find((peers) => peers?.some((p) => p.native.target === "/root/native_probe"));
  assert.ok(nativeListing, "native child appeared with its exact target");
  assert.ok(nativeListing.some((p) => p.native.reachable === true && p.native.target === "/root/native_probe"));
  assert.ok(assistantText(parent).includes(`NATIVE_OK ${nativeToken}`));
  assert.ok(!participants.flatMap(toolSends).some((s) => s.message?.includes(nativeToken)), "native exchange did not go through the bridge");
  checks.push({ test: "native-child", participant: parent.label, token: nativeToken, passed: true });
  log("PASS native child discovery and messaging");
  await coordinationCheck();
  report.passed = true;
}

try {
  await run();
} catch (e) {
  report.error = e.stack;
  console.error(e.stack);
  process.exitCode = 1;
} finally {
  report.participants = participants.map((p) => {
    const init = p.events?.find((e) => e.type === "system" && e.subtype === "init");
    return { label: p.label, kind: p.kind, id: p.id ?? init?.session_id, name: p.name,
      address: p.address ?? (init?.messaging_socket_path ? `uds:${init.messaging_socket_path}` : undefined),
      model: init?.model,
      failure: p.events?.find((e) => e.type === "result" && e.is_error)?.result };
  });
  report.finishedAt = new Date().toISOString();
  saveReport();
  await cleanup();
  log(`${report.passed ? "PASS" : "FAIL"}: ${join(output, "report.json")}`);
  process.exit(process.exitCode ?? 0);
}
