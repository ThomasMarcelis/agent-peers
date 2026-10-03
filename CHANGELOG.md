# Changelog

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
