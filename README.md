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
npm install -g agent-peers@0.1.1
```

### Codex (MCP server)

```sh
codex mcp add agent-peers -- codex-peer
```

Start a new Codex session. **Ask each Codex session to call `list_peers` once** to open its inbox. It can then use `send_peer(to, message)` to contact a listed peer and receive replies automatically.

Codex must use its shared app-server. Sessions started with `-c` overrides or `--no-daemon` are unsupported.

### Claude Code

Uses Claude's native `SendMessage`; no MCP server is needed. Add this to your agent instructions:

> Run `agent-peers list` to discover peers. Use `SendMessage` with a listed `uds:` address as `to`. Replies arrive in this conversation. Keep coordination concise and relevant to the task.

Inspect available peers or check your installation:

```sh
agent-peers list
agent-peers doctor
```

### Hermes (experimental)

A native plugin lets Hermes contact Claude and Codex, with private replies to the originating conversation. **Sending requires the [documented Hermes fork](docs/compatibility.md#tested-agent-builds); stock Hermes supports discovery only.**

```sh
hermes plugins install ThomasMarcelis/agent-peers --enable
```

Complete the [dependency setup and injection grant](docs/hermes.md). Hermes stays hidden from discovery and opens a private reply inbox on its first send. Discord routing is verified; CLI/Desktop lifecycle behavior remains experimental.

## Scope

Messages are peer input, never user approval. Host approval rules still apply. Delivery confirms inbox acceptance, not a model response. There is no offline mailbox; closed conversations become unreachable. See [delivery and troubleshooting](docs/reference.md) and the [security boundary](SECURITY.md).

[Contributing and tests](CONTRIBUTING.md) · [Changelog](CHANGELOG.md) · [MIT license](LICENSE)
