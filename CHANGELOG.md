# Changelog

## Unreleased

- Codex sessions open their inbox when they start instead of on their first agent-peers tool call, and are named after their working folder (`codex:<folder>-<id>`); `AGENT_PEERS_NAME` overrides the folder. A subagent's tool call no longer closes its root's inbox.
- Opt-in, bounded local JSONL diagnostics for Codex, Hermes, app-server requests and socket framing, with content exclusion and a read-only usage summary.
- Native-only targets now explain the exact native messaging route when mistakenly passed to `send_peer`; idle subagents advertise `followup_task`.
- Codex discovery limits concurrent thread reads so sessions with more than 256 loaded agents remain discoverable.
- Explicit negative delivery receipts are marked as MCP tool errors.
- Codex `send_peer` returns the delivered message ID as structured content, and incoming Codex peer messages carry the same ID, so observers such as Agent Standup can pair a send with its arrival exactly. The ID proves delivery to the inbox, not that the model read it.
- Read-only diagnostics accept Codex's owned daemon-socket symlink while rejecting unsafe link and target directories.

## 0.1.0 — 2026-10-03

First public release.

- Local discovery and direct messaging between Claude Code and Codex sessions.
- Native Hermes plugin with private, conversation-specific reply inboxes and exact Discord thread routing on the documented host fork.
- Standalone CLI and Codex MCP server, with help, version, JSON discovery, and read-only diagnostics.
- Hardened socket ownership, registry validation, framing, resource bounds, reconnects, and subprocess cleanup.
- Mixed socket-directory support, per-destination reply inboxes, safe MCP replacement, and automatic repair of missing owned inboxes.
- Deterministic transport/MCP tests, native Hermes integration tests, package-installation checks, and Linux/macOS CI.

Requires Node.js 22+. Hermes automatic replies require the fork APIs listed in the [compatibility guide](docs/compatibility.md); stock Hermes is not yet supported for sending. Agent protocols are version-sensitive.
