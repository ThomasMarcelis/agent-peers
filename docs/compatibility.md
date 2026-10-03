# Compatibility

agent-peers 0.1.x is the initial release line. Its CLI and MCP tools are small, but the agent runtimes it connects expose version-sensitive interfaces. A newer agent release is not automatically compatible.

## Runtime requirements

| Component | Requirement |
| --- | --- |
| Node.js | 22 or later; CI covers 22, 24, and 26 |
| Operating system | Linux and macOS; local Unix sockets are required |
| Python (Hermes only) | 3.11–3.13, as supported by the tested Hermes host |
| Claude Code | Cross-session inbox and `SendMessage` support |
| Codex | Shared app-server daemon, thread identity in MCP call metadata, and live `turn/start` delivery |
| Hermes | Native plugin loader plus `session_message_route`, `inject_session_message`, and route-retirement hook |

Windows is not supported. WSL must run all participating agents inside the same Linux environment. CI on macOS verifies the transport and package; live agent interoperability was exercised on Linux.

## Tested agent builds

- Codex CLI **0.160.0**.
- Claude Code **2.1.288**.
- Hermes fork [ThomasMarcelis/hermes-agent](https://github.com/ThomasMarcelis/hermes-agent) at [`1afb5d16d2d25e1d8e13703c1ce946e3ca0adc0d`](https://github.com/ThomasMarcelis/hermes-agent/commit/1afb5d16d2d25e1d8e13703c1ce946e3ca0adc0d).

The pinned Hermes host is reproducible in CI. It is a fork dependency, not a claim that any upstream version with the same version number includes these APIs.

Upstream Hermes was inspected at [`5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662`](https://github.com/NousResearch/hermes-agent/commit/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662). Its public `inject_message` API cannot atomically pin a late reply to the original conversation across reset and compression. Gateway and TUI injection queue busy-session input rather than steering it. The plugin therefore rejects sends on that host instead of weakening its routing contract.

## What to expect

A Codex inbox binds on the session's first `list_peers` or `send_peer` call. Threads hosted in embedded servers, including sessions started with `-c` or `--no-daemon`, are not reachable through the shared daemon. A subagent sends under its root's address; replies return to the root. Native targets only refer to agents in the caller's own tree.

Claude's inbox protocol is undocumented. Inbound messages may be held for approval or rejected according to Claude settings. In particular, `bypassPermissions` does not imply accepting external messages. The package does not change that policy.

Hermes support is experimental. Tests verify plugin loading, profile isolation, and busy/idle replies to the originating Discord thread on the pinned fork. CLI and Desktop/TUI reset/compression behavior is not covered by this release's compatibility guarantee: the current fork has a Desktop idle-dispatch/reset race that requires a separate host fix. No upstream submission or host upgrade is part of installing this package.

Claude sessions may use different private socket directories on the same machine. Codex maintains a reply inbox in each verified directory; Hermes selects a private reply inbox in the destination's directory. Existing owned inboxes survive discovery changes, and a missing Codex inbox can be repaired on the next tool call without resetting the conversation.

Run the opt-in live checks after upgrading an agent. See [contribution guidance](../CONTRIBUTING.md) and [release verification](release-verification.md).
