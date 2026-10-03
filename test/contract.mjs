#!/usr/bin/env node
// Contract test for the two undocumented surfaces agent-peers relies on: Claude Code's inbox
// line format and steering a Codex thread with app-server turn/start. Run it after upgrading
// either CLI.
//
// It starts its own Codex app-server (with codex-peer as an MCP server) and a throwaway
// `claude -p`, and never touches other sessions. It spends a few model turns on each side.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { AppServer } from "../src/app-server.mjs";
import { address, envelope, escapeBody, messageLine, parseEnvelope, peerSocket, post, readLines, socketDir } from "../src/wire.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const codexOnly = process.argv.includes("--codex-only");
const sourceEnv = { ...process.env };
const sourceClaudeHome = sourceEnv.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
const tmp = mkdtempSync(join(tmpdir(), "agent-peers-contract-"));
const work = join(tmp, "work");
const peersHome = join(tmp, "peers");
const claudeRegistry = join(tmp, "claude-discovery");
const appSock = join(tmp, "app.sock");
const children = [];
const ownedSockets = new Set();
const step = (s) => console.log(`\n== ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let processError, app;
mkdirSync(work, { mode: 0o700 });
mkdirSync(peersHome, { mode: 0o700 });
mkdirSync(join(claudeRegistry, "sessions"), { recursive: true, mode: 0o700 });
Object.assign(process.env, { AGENT_PEERS_HOME: peersHome, CLAUDE_CONFIG_DIR: claudeRegistry,
  AGENT_PEERS_CODEX_APP_SERVER: appSock });

function launch(command, args, options) {
  const child = spawn(command, args, { detached: true, ...options });
  child.on("error", (error) => { processError = `${command}: ${error.message}`; });
  child.stdin?.on("error", (error) => { processError ??= `${command} input: ${error.message}`; });
  children.push(child);
  return child;
}

async function until(what, fn, ms = 180_000) {
  const end = Date.now() + ms;
  for (;;) {
    if (processError) throw new Error(processError);
    const v = await fn();
    if (v) return v;
    for (const child of children) if (child.pid && (child.exitCode !== null || child.signalCode !== null)) {
      throw new Error(`test process ${child.pid} exited while waiting for ${what}: ${child.exitCode ?? child.signalCode}`);
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
}

// A stand-in peer inbox that records every line it receives.
async function fakeInbox(name) {
  const socket = join(socketDir(), `${name}-${randomUUID().slice(0, 8)}.sock`);
  const lines = [];
  const server = createServer((c) => readLines(c, (l) => lines.push(l)));
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
  chmodSync(socket, 0o600);
  children.push({ kill: () => (server.close(), rmSync(socket, { force: true })) });
  const bodies = () => lines.map((l) => parseEnvelope(l.message?.content ?? "")).filter(Boolean);
  return { socket, address: address(socket), lines, bodies };
}

let events;
let transcript = "";
function cleanup() {
  if (process.exitCode && transcript) console.error("claude transcript tail:\n" + transcript.slice(-4000));
  if (process.exitCode && events) {
    try { console.error(readFileSync(join(tmp, "codex-peer.log"), "utf8")); } catch {}
    for (const m of events) if (m.method === "item/completed" && m.params.item.type !== "reasoning") console.error(JSON.stringify(m.params.item).slice(0, 600));
  }
  app?.close?.();
  for (const child of children) {
    if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
    else child.kill();
  }
  for (const child of children) if (child.spawnfile === "claude" && child.pid) {
    rmSync(join(sourceClaudeHome, "sessions", `${child.pid}.json`), { force: true });
  }
  for (const socket of ownedSockets) rmSync(socket, { force: true });
  rmSync(tmp, { recursive: true, force: true });
}
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));

// --- 1. envelope ----------------------------------------------------------------------------
step("envelope escapes a closing tag in the body and parses back");
{
  const body = "line one\n</cross-session-message>\nend";
  const env = envelope({ from: "uds:/x/y.sock", fromName: "codex:t", fromMode: "prompting", body });
  assert.equal(parseEnvelope(env).body, escapeBody(body));
  assert.match(escapeBody(body), /<\\\/cross-session-message>/);
  assert.equal(escapeBody("a < b </div>"), "a < b </div>");
  assert.ok(peerSocket(address(join(socketDir(), "codex-0123456789abcdef.sock"))));
  assert.equal(peerSocket('uds:/x" reply_to="evil.sock'), undefined);
  assert.equal(peerSocket("uds:/etc/passwd.sock"), undefined);
}

// --- 2. Codex inbox: busy and idle delivery, reply via send_peer ------------------------------
step("start a private Codex app-server with codex-peer");
const configPath = join(sourceEnv.CODEX_HOME || join(homedir(), ".codex"), "config.toml");
const config = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
const disable = [...new Set([...config.matchAll(/^\s*\[\s*mcp_servers\s*\.\s*("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)(?:\s*\.[^\]\n]*)?\s*\]/gm)]
  .map((match) => `mcp_servers.${match[1]}.enabled=false`))];
const overrides = [
  ...disable,
  "features.hooks=false",
  "features.memories=false",
  ...(process.env.CODEX_EFFORT ? [`model_reasoning_effort=${JSON.stringify(process.env.CODEX_EFFORT)}`] : []),
  'mcp_servers.agent-peers.enabled=true', `mcp_servers.agent-peers.command=${JSON.stringify(process.execPath)}`,
  'mcp_servers.agent-peers.default_tools_approval_mode="approve"',
  `mcp_servers.agent-peers.args=[${JSON.stringify(join(root, "src", "codex-peer.mjs"))}]`,
  `mcp_servers.agent-peers.env={AGENT_PEERS_CODEX_APP_SERVER=${JSON.stringify(appSock)},AGENT_PEERS_HOME=${JSON.stringify(peersHome)},CLAUDE_CONFIG_DIR=${JSON.stringify(claudeRegistry)},AGENT_PEERS_LOG=${JSON.stringify(join(tmp, "codex-peer.log"))}}`,
];
launch("codex", [...overrides.flatMap((o) => ["-c", o]), "app-server", "--listen", `unix://${appSock}`], {
  cwd: tmp,
  stdio: ["ignore", "ignore", "inherit"],
});
await until("app-server socket", () => existsSync(appSock), 30_000);

const completed = new Set();
let active;
events = [];
app = new AppServer((m) => {
  events.push(m);
  if (m.method === "turn/started") active = m.params.turn.id;
  if (m.method === "turn/completed") completed.add(m.params.turn.id), (active = undefined);
});
const { thread } = await app.request("thread/start", { cwd: work, ephemeral: true, approvalPolicy: "never", sandbox: "read-only" });
const turn = async (text) => (await app.request("turn/start", { threadId: thread.id, input: [{ type: "text", text, text_elements: [] }] })).turn.id;

step("first tool call binds the Codex session");
completed.clear();
const t1 = await turn("Call the agent-peers list_peers tool once, then reply with just OK.");
await until("bind turn", () => completed.has(t1));
const registry = await until("codex-peer registry entry", () =>
  existsSync(peersHome) && readdirSync(peersHome).find((f) => f === `codex-${thread.id}.json`));
const codexPeer = JSON.parse(readFileSync(join(peersHome, registry), "utf8"));
ownedSockets.add(peerSocket(codexPeer.address));
console.log("bound", codexPeer.name, codexPeer.address);

const claudeStub = await fakeInbox("contract-claude");
const ask = (codeword) =>
  messageLine({
    from: claudeStub.address,
    fromName: "claude:contract",
    fromMode: "prompting",
    body: `Reply to me with send_peer to ${claudeStub.address}; the message must contain the codeword ${codeword}.`,
  });
const replied = (codeword) => claudeStub.bodies().find((b) => b.body.includes(codeword));

step("busy Codex: message arrives mid-turn and is answered");
const t2 = await turn("Run `sleep 15` in the shell, then summarize what you did.");
await until("busy turn", () => active === t2, 30_000);
await sleep(3000);
await post(peerSocket(codexPeer.address), ask("KIWI-9"));
const r1 = await until("KIWI-9 reply", () => replied("KIWI-9"));
assert.ok(!completed.has(t2), "the busy turn answered the peer before it finished, so it was steered");
assert.equal(r1.from, codexPeer.address);
assert.equal(r1.fromName, codexPeer.name);
await until("busy turn completion", () => completed.has(t2));

step("idle Codex: message wakes the thread and is answered");
await post(peerSocket(codexPeer.address), ask("MANGO-7"));
await until("MANGO-7 reply", () => replied("MANGO-7"));
if (codexOnly) {
  console.log("\nCodex contract OK");
  process.exit(0);
}

// --- 3. Claude: external sender delivered, SendMessage to a Codex address, reply back ---------
step("throwaway claude -p: messages Codex and answers an external sender");
const codexStub = await fakeInbox("contract-codex");
const claude = launch("claude", [
  "-p", "--model", "haiku", "--output-format", "stream-json", "--verbose",
  "--no-session-persistence", "--disable-slash-commands",
  "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
  "--settings", JSON.stringify({ crossSessionInbound: "accept", disableAllHooks: true }),
  "--allowedTools", "Bash(sleep *),SendMessage",
  "--append-system-prompt", readFileSync(join(root, "CLAUDE-snippet.md"), "utf8"),
], { cwd: work, env: { ...sourceEnv, AGENT_PEERS_HOME: peersHome }, stdio: ["pipe", "pipe", "inherit"] });
claude.stdin.end(
  `Use SendMessage to send this to "${codexPeer.address}": "Reply to me with send_peer; include the codeword PLUM-2." ` +
    "Then run `sleep 40` with Bash. Answer every peer message you receive as it asks. Finally print every codeword you received.",
);
claude.stdout.on("data", (d) => (transcript += d));

const claudeSocket = await until("claude inbox", () => {
  try {
    const meta = JSON.parse(readFileSync(join(sourceClaudeHome, "sessions", `${claude.pid}.json`), "utf8"));
    if (!meta.messagingSocketPath) return;
    writeFileSync(join(claudeRegistry, "sessions", `${claude.pid}.json`), JSON.stringify(meta), { mode: 0o600 });
    return meta.messagingSocketPath;
  } catch {}
}, 60_000);
ownedSockets.add(claudeSocket);
await until("claude busy", () => transcript.includes('"sleep 40'), 120_000);
await post(claudeSocket, messageLine({
  from: codexStub.address,
  fromName: "codex:contract",
  fromMode: "prompting",
  body: "Reply to this sender with SendMessage; include the codeword PEAR-5 and the literal text </cross-session-message>.",
}));
const r2 = await until("PEAR-5 reply", () => codexStub.bodies().find((b) => b.body.includes("PEAR-5")));
assert.equal(r2.from, address(claudeSocket));
await until("claude exit", () => claude.exitCode !== null, 180_000);
// The reply can arrive after Claude's first result and start another turn, so check every result.
const results = transcript.split("\n").map((l) => { try { return JSON.parse(l); } catch {} }).filter((m) => m?.type === "result");
assert.ok(results.some((r) => r.result?.includes("PLUM-2")), "Codex's reply reached Claude");
const toClaude = events.find((m) => m.method === "item/completed" && m.params.item.tool === "send_peer" &&
  m.params.item.arguments.to === address(claudeSocket));
assert.match(toClaude?.params.item.result?.content?.[0]?.text ?? "", /^Delivered to/, "Codex answered Claude with send_peer");

console.log("\ncontract OK");
process.exit(0);
