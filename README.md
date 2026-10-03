# agent-peers

[![CI](https://github.com/ThomasMarcelis/agent-peers/actions/workflows/ci.yml/badge.svg)](https://github.com/ThomasMarcelis/agent-peers/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/agent-peers)](https://www.npmjs.com/package/agent-peers)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Let **Claude Code, Codex, and Hermes conversations message each other** on one machine. Discover a session, send a message, and receive its reply in the conversation that asked. No broker, task board, or polling loop.

[Hermes plugin](docs/hermes.md) · [Compatibility](docs/compatibility.md) · [Protocol and configuration](docs/reference.md)

## Install

Requires **Node.js 22+** on Linux or macOS. Agent integration compatibility is version-sensitive; see the [tested configurations](docs/compatibility.md).

```sh
npm install -g agent-peers@0.1.0
codex mcp add agent-peers -- codex-peer
```

Start a new Codex session. Ask it to call `list_peers` once to open its inbox. Codex must use its shared app-server; sessions started with `-c` overrides or `--no-daemon` are unsupported.

Claude Code already provides messaging. Add this to its instructions:

> Run `agent-peers list` to discover Codex and Claude sessions. Use `SendMessage` with a listed `uds:` address as `to`. Replies arrive in this conversation. Keep coordination concise and relevant to the user's task.

## Use

Ask your agent:

> Find the agent working on the API, ask which response shape it chose, and use its answer for the client.

Or inspect discovery yourself:

```sh
agent-peers list
agent-peers list --json
agent-peers doctor
```

| Tool | Purpose |
| --- | --- |
| `list_peers()` | Discover sessions and their exact messaging targets. Codex also identifies reachable native subagents. |
| `send_peer(to, message)` | Send to a listed name, inbox address, or an incoming message's reply address. |

Messages are framed as coming from another agent, with a reply address. They carry no user approval. A successful send means the recipient's inbox accepted the message, not that its model read or answered it.

## Hermes

Install as a native plugin; the standalone tools remain independent of Hermes:

```sh
hermes plugins install ThomasMarcelis/agent-peers --enable
```

**Automatic replies require the documented Hermes fork.** Stock Hermes can discover peers but lacks the conversation-routing APIs needed for automatic replies; sending fails clearly. See [Hermes setup](docs/hermes.md) for dependencies, the explicit injection grant, and the exact tested host revision.

Hermes stays hidden from discovery. Each conversation creates a private reply inbox on its first send; replies return to that conversation and Discord thread, including when another tab is active.

## Boundaries

- Same machine and OS user, using owner-controlled Unix sockets. Sender identities are not cryptographically authenticated.
- No offline mailbox or automatic delivery retry. Closed conversations become unreachable.
- Claude's inbound approval rules still apply. Rate limits and duplicate suppression reduce accidental chatter; they do not guarantee an agent conversation ends.

## Development

```sh
npm ci
npm run check
npm test
npm run test:package
```

These checks use local fixtures and no model credentials. Python and real-host checks are described in [CONTRIBUTING.md](CONTRIBUTING.md). Live model tests are separate and consume your agent subscriptions.

MIT. See [LICENSE](LICENSE).
