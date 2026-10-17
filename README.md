# agent-peers

[![CI](https://github.com/ThomasMarcelis/agent-peers/actions/workflows/ci.yml/badge.svg)](https://github.com/ThomasMarcelis/agent-peers/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/agent-peers)](https://www.npmjs.com/package/agent-peers)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Agent-to-agent messaging for Claude Code and Codex.** Independent sessions working in different tools and projects can ask each other questions, coordinate changes, and return answers to the conversation that asked. Each keeps its own context and workflow.

Ask Codex:

> Find the Claude session working on the API. Ask which response shape it chose, then use its answer for the client.

[Get started](#get-started) · [Hermes plugin](#hermes-experimental) · [Compatibility](docs/compatibility.md) · [Reference](docs/reference.md)

## Why agent-peers

- **Coordinate independent sessions.** Claude ↔ Codex, Claude ↔ Claude, and Codex ↔ Codex, across repositories.
- **Replies arrive in context.** Agents receive messages while idle or busy, through their host's normal conversation handling.
- **Local transport.** Direct Unix sockets on the same machine and OS user. No extra service to run or account to configure.

Backed by [live Claude/Codex round trips, Hermes routing tests, and Linux/macOS CI](docs/release-verification.md).

## Get started

Requires **Node.js 22+**, Linux or macOS, and [compatible agent versions](docs/compatibility.md#tested-agent-builds).

```sh
npm install -g agent-peers@0.3.0
```

### Codex (MCP server)

```sh
codex mcp add agent-peers -- codex-peer
```

Start a new Codex session; its inbox opens within seconds, without a tool call, and it is listed as `codex:<folder>-<id>`. It can use `send_peer(to, message)` to contact a listed peer and receive replies automatically. Keep the server name `agent-peers`: under another name, the inbox opens only on the session's first `list_peers` or `send_peer`.

A Codex session is reachable on the app-server agent-peers uses: Codex's shared daemon by default, or a [private app-server](docs/compatibility.md#headless-codex-on-a-private-app-server) for headless workers. `codex exec`, `-c` overrides and `--no-daemon` run an embedded server that peers cannot reach.

### Claude Code

Uses Claude's native `SendMessage`; no MCP server is needed. Add this to your agent instructions:

> Run `agent-peers list` to discover peers. Use `SendMessage` with a listed `uds:` address as `to`. Replies arrive in this conversation. Keep coordination useful and brief. Send what's new; link existing detail rather than repeating it. Reply when it adds value.

Inspect available peers or check your installation:

```sh
agent-peers list
agent-peers doctor
```

For local development diagnostics, start the integration with `AGENT_PEERS_DEBUG=1` and inspect retained activity with `agent-peers logs --json`. Logs contain bounded metadata, timings, correlation IDs and failure categories; message bodies and raw errors are excluded. See [logging configuration and limits](docs/reference.md#local-diagnostic-logging). Existing processes need a normal restart to inherit the setting.

### Hermes (experimental)

A native plugin lets Hermes contact Claude and Codex, with private replies to the originating conversation. **Sending requires the [documented Hermes fork](docs/compatibility.md#tested-agent-builds); stock Hermes supports discovery only.**

```sh
hermes plugins install ThomasMarcelis/agent-peers --enable
```

Complete the [dependency setup and injection grant](docs/hermes.md). A Hermes conversation stays unlisted and opens a private reply inbox on its first send; it becomes reachable by others only through a [stable name](docs/reference.md#names) it claims (experimental), scoped to its profile. Discord routing is verified; CLI/Desktop lifecycle behavior remains experimental.

## Scope

Messages are peer input, never user approval. Host approval rules still apply. Delivery confirms inbox acceptance, not a model response. There is no offline mailbox; closed conversations become unreachable. See [delivery and troubleshooting](docs/reference.md) and the [security boundary](SECURITY.md).

[Stability](docs/stability.md) · [Contributing and tests](CONTRIBUTING.md) · [Changelog](CHANGELOG.md) · [MIT license](LICENSE)
