#!/usr/bin/env node
import { allPeers } from "../src/wire.mjs";
import { formatSessionPeer } from "../src/discovery.mjs";
import { VERSION } from "../src/version.mjs";

const usage = `agent-peers ${VERSION} — local agent messaging

Usage: agent-peers <command> [options]

  list [--json]     Discover running Claude Code and Codex inboxes
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
  if (!["list", "doctor", "logs", "hermes-bridge"].includes(cmd) || args.length > 1 ||
      (args.length && (args[0] !== "--json" || cmd === "hermes-bridge"))) {
    throw new SyntaxError("unknown command or option; run agent-peers --help");
  }
  if (cmd === "hermes-bridge") {
    const { runHermesBridge } = await import("../src/hermes-bridge.mjs");
    runHermesBridge();
    return;
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
  const peers = allPeers();
  if (args.includes("--json")) console.log(JSON.stringify({ peers }, null, 2));
  else {
    if (!peers.length) console.log("No peer inboxes found. A Codex session opens its inbox a few seconds after it starts; if one is missing, call list_peers in it.");
    for (const peer of peers) console.log(formatSessionPeer(peer));
    if (peers.length) console.log("Codex native reachability depends on your session; call list_peers there for native targets.");
  }
}

try { await main(); }
catch (error) {
  console.error(`agent-peers: ${error.message}`);
  process.exitCode = error instanceof SyntaxError ? 2 : 1;
}
