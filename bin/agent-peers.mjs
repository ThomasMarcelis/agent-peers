#!/usr/bin/env node
// Lists the agent sessions that can be messaged. Claude's ListAgents shows only Claude
// sessions; Codex sessions appear here, addressed for Claude's SendMessage.

import { allPeers } from "../src/wire.mjs";
import { formatSessionPeer } from "../src/discovery.mjs";

const [cmd] = process.argv.slice(2);
if (cmd === "hermes-bridge") {
  const { runHermesBridge } = await import("../src/hermes-bridge.mjs");
  runHermesBridge();
} else if (cmd === "list") {
  const peers = allPeers();
  if (!peers.length) console.log("No agent sessions are running.");
  for (const p of peers) console.log(formatSessionPeer(p));
  if (peers.length) console.log("Codex native reachability depends on your session; call list_peers there for native targets.");
} else {
  console.error("usage: agent-peers list | hermes-bridge");
  process.exit(2);
}
