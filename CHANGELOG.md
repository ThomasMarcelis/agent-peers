# Changelog

## Unreleased

- A delivery to a peer that closes its connection mid-write is reported as failed instead of delivered.

- `agent-peers whoami [--json]` reports the calling Claude Code (or Codex) session's name and address through process ancestry. Adding the caller to Codex `list_peers` is still to do.
- `agent-peers list` probes each peer socket and marks refusing sockets `stale` / `reachable: false` without deleting records; `--no-probe` skips this.
- Peer discovery scans Claude session records once per listing instead of once per peer (about 105 ms to 5 ms for 120 peers).

## 0.2.0 — 2026-10-16

First npm release since 0.1.0: 0.1.1 was tagged on GitHub but never published to npm, and its changes are included here.

- `agent-peers doctor` asks the Codex app-server one read-only question instead of trusting socket presence, and reports a stale daemon link or a server that does not answer, with the start command.
- Startup binding backs off to every 10 minutes after its quick retries and logs each failure reason once, plus one `unreachable` event and stderr line, instead of every minute forever.
- Documented headless Codex workers on a private app-server; the unreachable-thread error now names the app-server in use and the alternatives.
- Hermes frames carry the message `id` like Codex frames; Hermes sender names are sanitized for any route ID; the dependency recovery command uses `npm install` when the package has no lockfile.
- The Hermes bridge drops an inbound message whose re-encoded notification would exceed the host's line limit instead of restarting the bridge.
- The Claude compatibility footer is sent once per sender and recipient instead of on every message.
- `send_peer` results carry a message ID that matches the `id` on the recipient's frame.
- `@modelcontextprotocol/sdk` 1.32.1.
- Startup-binding scans log `mcpServerStatus/list` instead of an unknown method. The internal observatory design draft is no longer packaged.

- Shorter coordination guidance, incoming peer frames, Claude-only compatibility footers and delivery receipts. Message bodies, permission boundaries, reply routing and receipt metadata remain intact; private reply inboxes no longer receive Claude-specific footers.
- Codex sessions open their inbox when they start instead of on their first agent-peers tool call, and are named after their working folder (`codex:<folder>-<id>`); `AGENT_PEERS_NAME` overrides the folder. A subagent's tool call no longer closes its root's inbox.
- Opt-in, bounded local JSONL diagnostics for Codex, Hermes, app-server requests and socket framing, with content exclusion and a read-only usage summary.
- Native-only targets now explain the exact native messaging route when mistakenly passed to `send_peer`; idle subagents advertise `followup_task`.
- Codex discovery limits concurrent thread reads so sessions with more than 256 loaded agents remain discoverable.
- Explicit negative delivery receipts are marked as MCP tool errors.
- Read-only diagnostics accept Codex's owned daemon-socket symlink while rejecting unsafe link and target directories.

## 0.1.1 — 2026-10-03

- Clearer quick start for independent Claude Code and Codex sessions, with separate setup instructions and a practical coordination example.
- More descriptive npm search metadata and an MCP Registry ownership marker for a future listing.
- Empty discovery now explains how to open a Codex inbox instead of claiming no agents are running.
- Unsupported Hermes conversations link to the required host and setup instead of suggesting a stock Hermes update.

Documentation, package metadata, and diagnostic wording only; transport behavior is unchanged from 0.1.0.

## 0.1.0 — 2026-10-03

First public release.

- Local discovery and direct messaging between Claude Code and Codex sessions.
- Native Hermes plugin with private, conversation-specific reply inboxes and exact Discord thread routing on the documented host fork.
- Standalone CLI and Codex MCP server, with help, version, JSON discovery, and read-only diagnostics.
- Hardened socket ownership, registry validation, framing, resource bounds, reconnects, and subprocess cleanup.
- Mixed socket-directory support, per-destination reply inboxes, safe MCP replacement, and automatic repair of missing owned inboxes.
- Deterministic transport/MCP tests, native Hermes integration tests, package-installation checks, and Linux/macOS CI.

Requires Node.js 22+. Hermes automatic replies require the fork APIs listed in the [compatibility guide](docs/compatibility.md); stock Hermes is not yet supported for sending. Agent protocols are version-sensitive.
