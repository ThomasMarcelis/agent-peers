#!/usr/bin/env node
import { dirname } from "node:path";
import { allPeers, ancestorPids, claudeSessionAt, inDiscoveryScope, post, probePeers, whoami } from "../src/wire.mjs";
import { formatName, formatSessionPeer } from "../src/discovery.mjs";
import { SCOPE, claim, claimRefusal, claimRows, claudeClaimant, heldBy, parseName, release, withClaims } from "../src/names.mjs";
import { resolveTarget } from "../src/outbox.mjs";
import { SendFailure, nameResolvedLine } from "../src/status.mjs";
import { VERSION } from "../src/version.mjs";

const usage = `agent-peers ${VERSION} — local agent messaging

Usage: agent-peers <command> [options]

  list [--json] [--no-probe]  Discover running Claude Code and Codex inboxes and claimed names; rows that refuse connections are marked stale
  whoami [--json]   Print the calling session's name and address (found through process ancestry)
  claim <name> [--json]     Claim a stable name, claude:<scope>/<claim>, for the calling Claude session
  release <name> [--json]   Release a name this session holds, or one whose holder is not running
  resolve <target> [--json] Print the one uds: address to send to for a claimed name, peer name or address
  doctor [--json]   Check local prerequisites and whether the Codex app-server answers
  logs [--json]     Summarize retained local diagnostic events
  hermes-bridge    Start the plugin-managed JSON-lines subprocess
  --version       Print the installed version
  --help          Show this help

Codex MCP server: codex-peer
Documentation: https://github.com/ThomasMarcelis/agent-peers`;

process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
  console.error(`agent-peers: ${error.message}`);
  process.exit(1);
});

// The calling Claude session: the nearest ancestor with a live Claude registry record. Codex shell
// commands never have codex-peer as an ancestor, so Codex claims go through its claim_name tool.
const claudeCaller = () => inDiscoveryScope(() => {
  for (const pid of ancestorPids()) {
    const session = claudeSessionAt(pid);
    if (session) return session;
  }
  return undefined;
});

function report(result, json, ok) {
  if (json) console.log(JSON.stringify(result, null, 2));
  else if (ok) console.log(result.text);
  else console.error(`agent-peers: ${result.text}`);
  if (!ok) process.exitCode = result.reason === "invalid-request" ? 2 : 1;
}

function claimCommand(cmd, name, json) {
  let result;
  try {
    parseName(name, "claude");
    const caller = claudeCaller();
    if (cmd === "release") result = release(name, caller && claudeClaimant(caller), "claude");
    else if (caller) result = claim(name, claudeClaimant(caller));
    else {
      result = claimRefusal("no-session", "no Claude Code session found in this process's ancestry; run agent-peers claim from inside a Claude " +
        "session. Codex and Hermes sessions claim names with their claim_name tool.");
    }
  } catch (error) {
    if (!(error instanceof SendFailure)) throw error;
    result = claimRefusal(error.reason, error.message);
  }
  report(result, json, result.status !== "refused");
}

// One uds: line for SendMessage, in the caller's socket directory when it has an inbox there. A
// Hermes holder accepts only senders it wrote to or that used its name, so resolve tells it which
// Claude session is about to send.
async function resolveCommand(to, json) {
  const caller = claudeCaller();
  let result;
  try {
    const target = resolveTarget(to, undefined, { directory: caller && dirname(caller.socket) });
    if (target.claimed && target.kind === "hermes") {
      if (!caller) process.stderr.write("agent-peers: no Claude session in this process's ancestry; a Hermes holder refuses a message sent to this address without one.\n");
      else {
        try { await post(target.socket, nameResolvedLine({ from: caller.address, name: target.name })); }
        catch { throw new SendFailure("not-running", `${target.name} is not running: nothing is listening at its inbox.`); }
      }
    }
    result = { status: "resolved", reason: null, name: target.name ?? null, kind: target.kind ?? null, address: target.address,
      generation: target.generation ?? null, text: target.address };
  } catch (error) {
    if (!(error instanceof SendFailure)) throw error;
    result = { status: "failed", reason: error.reason, text: error.message };
  }
  report(result, json, result.status === "resolved");
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || ["--help", "-h", "help"].includes(cmd)) {
    if (args.length) throw new SyntaxError("unexpected arguments");
    console.log(usage);
    return;
  }
  if (["--version", "-v", "version"].includes(cmd) && !args.length) {
    console.log(VERSION);
    return;
  }
  if (["claim", "release", "resolve"].includes(cmd)) {
    const values = args.filter((a) => !a.startsWith("--")), flags = args.filter((a) => a.startsWith("--"));
    if (values.length !== 1 || flags.length > 1 || flags.some((f) => f !== "--json")) {
      throw new SyntaxError(`usage: agent-peers ${cmd} <${cmd === "resolve" ? "target" : "name"}> [--json]`);
    }
    if (cmd === "resolve") await resolveCommand(values[0], flags.length > 0);
    else claimCommand(cmd, values[0], flags.length > 0);
    return;
  }
  if (cmd === "hermes-bridge") {
    // The plugin appends its profile, which scopes every name the bridge claims.
    if (args.length && (args.length !== 2 || args[0] !== "--hermes-profile" || !SCOPE.test(args[1]))) {
      throw new SyntaxError("usage: agent-peers hermes-bridge [--hermes-profile <profile>]");
    }
    const { runHermesBridge } = await import("../src/hermes-bridge.mjs");
    runHermesBridge({ profile: args[1] });
    return;
  }
  const allowed = cmd === "list" ? ["--json", "--no-probe"] : ["doctor", "logs", "whoami"].includes(cmd) ? ["--json"] : [];
  if (!["list", "doctor", "logs", "whoami"].includes(cmd) || args.length > allowed.length ||
      new Set(args).size !== args.length || args.some((a) => !allowed.includes(a))) {
    throw new SyntaxError("unknown command or option; run agent-peers --help");
  }
  if (cmd === "doctor") {
    const { diagnose } = await import("../src/diagnostics.mjs");
    const result = await diagnose();
    if (args.includes("--json")) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`agent-peers ${VERSION}`);
      for (const check of result.checks) console.log(`${check.status.toUpperCase()} ${check.name}: ${check.message}`);
    }
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (cmd === "logs") {
    const { summarizeLogs } = await import("../src/logging.mjs");
    const result = summarizeLogs();
    if (args.includes("--json")) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`Logging ${result.config.enabled ? "enabled" : "disabled"}: ${result.config.location}`);
      console.log(`${result.events} events in ${result.files} files (${result.bytes} bytes); ${result.corruptLines} malformed lines; ${result.skippedFiles} skipped files; ${result.truncatedFiles} files read partially.`);
      if (result.firstEventAt) console.log(`Observed: ${result.firstEventAt} to ${result.lastEventAt}`);
      for (const [method, tool] of Object.entries(result.tools)) console.log(`${method}: ${tool.calls} completed calls; ${JSON.stringify(tool.outcomes)}`);
      console.log(`Delivery: ${result.delivery.inboxWrites} inbox writes; ${result.delivery.receipts} receipts; ${result.delivery.appServerInputAccepted} app-server inputs accepted; ${result.delivery.emittedToHost} emitted to host.`);
      console.log(`Operations: ${result.operations.started} started; ${result.operations.completed} completed; ${result.operations.incomplete} incomplete.`);
      if (Object.keys(result.reasons).length) console.log(`Reasons: ${JSON.stringify(result.reasons)}`);
      console.log(result.scope);
      for (const warning of result.warnings) console.log(`WARNING ${warning}`);
    }
    return;
  }
  if (cmd === "whoami") {
    const me = whoami();
    if (!me) throw new Error("no Claude Code or Codex session found in this process's ancestry; run whoami from inside a session");
    const { name, address, kind, cwd, pid, generation } = me;
    if (args.includes("--json")) console.log(JSON.stringify({ name, address, kind, cwd, pid, generation, claims: heldBy(kind, generation) }, null, 2));
    else console.log(`${name}\n${address}`);
    return;
  }
  const caller = claudeCaller();
  const { found, names } = inDiscoveryScope(() => ({ found: withClaims(allPeers()), names: claimRows({ directory: caller && dirname(caller.socket) }) }));
  const peers = args.includes("--no-probe") ? found : await probePeers(found);
  if (args.includes("--json")) console.log(JSON.stringify({ peers, names }, null, 2));
  else {
    if (!peers.length) console.log("No peer inboxes found. A Codex session opens its inbox a few seconds after it starts; if one is missing, call list_peers in it.");
    for (const peer of peers) console.log(formatSessionPeer(peer));
    if (peers.length) console.log("Codex native reachability depends on your session; call list_peers there for native targets.");
    if (names.length) console.log(`Claimed names:\n${names.map((row) => `  ${formatName(row)}`).join("\n")}`);
  }
}

try { await main(); }
catch (error) {
  console.error(`agent-peers: ${error.message}`);
  process.exitCode = error instanceof SyntaxError ? 2 : 1;
}
