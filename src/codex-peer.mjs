#!/usr/bin/env node
// codex-peer: gives Codex sessions a Claude-compatible inbox and the tools to message peers.
//
// Codex starts one copy per session, which may then serve several root threads. Each root binds
// <claude socket dir>/codex-<id>.sock and receives each inbound line into its thread as a framed
// peer message, mid-turn or waking an idle thread. Outbound messages use the same line format,
// so Claude replies with SendMessage.
//
// codex-binding.mjs: roots, registry, inboxes. codex-inbox.mjs: inbound delivery and receipts.
// codex-tools.mjs: the MCP tools.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { app, bindAtStart, onInboxLine, unbindAll } from "./codex-binding.mjs";
import { receive } from "./codex-inbox.mjs";
import { mcp } from "./codex-tools.mjs";

onInboxLine(receive);
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => process.exit(0));
process.on("exit", () => { unbindAll(); app.close(); });
process.stdin.on("end", () => process.exit(0));

mcp.server.oninitialized = () => { void bindAtStart(); };
await mcp.connect(new StdioServerTransport());
