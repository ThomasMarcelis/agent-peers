#!/usr/bin/env node
// Lists the agent sessions that can be messaged. Claude's ListAgents shows only Claude
// sessions; Codex sessions appear here, addressed for Claude's SendMessage.

import { allPeers } from "../src/wire.mjs";

const [cmd] = process.argv.slice(2);
if (cmd !== "list") {
  console.error("usage: agent-peers list");
  process.exit(2);
}
const peers = allPeers();
if (!peers.length) console.log("No agent sessions are running.");
for (const p of peers) console.log(`${p.name}  ${p.status ?? ""}  cwd=${p.cwd}\n  SendMessage to: ${p.address}`);
