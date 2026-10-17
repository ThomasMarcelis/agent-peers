# Compatibility

agent-peers' own interfaces follow the [stability policy](stability.md). The agent runtimes it connects expose version-sensitive interfaces, so a newer agent release is not automatically compatible; the builds below are the ones verified.

## Runtime requirements

| Component | Requirement |
| --- | --- |
| Node.js | 22 or later; CI covers 22, 24, and 26 |
| Operating system | Linux and macOS; local Unix sockets are required |
| Python (Hermes only) | The plugin supports 3.11–3.14; the tested Hermes build requires 3.14 |
| Claude Code | Cross-session inbox and `SendMessage` support |
| Codex | Shared app-server daemon, thread identity in MCP call metadata or MCP server status, and live `turn/start` delivery |
| Hermes | Native plugin loader plus `session_message_route`, `inject_session_message`, and route-retirement hook |

Windows is not supported. WSL must run all participating agents inside the same Linux environment. CI on macOS verifies the transport and package; live agent interoperability was exercised on Linux.

## Tested agent builds

- Codex CLI **0.162.1**: `node test/contract.mjs` (busy and idle delivery, replies) and startup binding. Earlier releases were verified on 0.160.0.
- Claude Code **2.1.302**: the same contract run, including a message line that carries the `agent_peers` extension and a Codex reply that Claude accepts without a receipt. Earlier releases were verified on 2.1.288.
- Hermes fork [ThomasMarcelis/hermes-agent](https://github.com/ThomasMarcelis/hermes-agent) at [`0d7c749cff42cd4791e0342da226c6d499de5aeb`](https://github.com/ThomasMarcelis/hermes-agent/commit/0d7c749cff42cd4791e0342da226c6d499de5aeb) (branch `jd/thin-v0.22.2`: Hermes v0.22.2 plus a minimal host patch). CI runs the Hermes integration tests against this build, and the maintainer's gateways run it; agent-peers 0.2.0 was verified end to end on it. It replaces the earlier pin `1afb5d16`, which is a different line of history.

The pinned Hermes host is reproducible in CI. It is a fork dependency, not a claim that any upstream version with the same version number includes these APIs.

Upstream Hermes was inspected at [`5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662`](https://github.com/NousResearch/hermes-agent/commit/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662). Its public `inject_message` API cannot atomically pin a late reply to the original conversation across reset and compression. Gateway and TUI injection queue busy-session input rather than steering it. The plugin therefore rejects sends on that host instead of weakening its routing contract.

## What to expect

A Codex inbox opens when the session starts: the MCP server finds its own thread through the daemon's `mcpServerStatus/list`, which requires the server to be registered as `agent-peers`. Otherwise, or if the daemon does not report it, the inbox opens on the session's first `list_peers` or `send_peer` call. A root session is named `codex:<folder>-<id>`, or after its thread title when it has no folder. Threads hosted in embedded servers, including `codex exec` and sessions started with `-c` or `--no-daemon`, are not reachable; a private app-server is (below). A subagent sends under its root's address; replies return to the root. Native targets only refer to agents in the caller's own tree. One MCP server process can serve up to eight root sessions, as after `/new` or resume in the Codex TUI; each keeps its own inbox.

Claude's inbox protocol is undocumented. Inbound messages may be held for approval or rejected according to Claude settings. In particular, `bypassPermissions` does not imply accepting external messages. The package does not change that policy.

Hermes support is experimental. Tests verify plugin loading, profile isolation, and busy/idle replies to the originating Discord thread on the pinned fork. CLI and Desktop/TUI reset/compression behavior is not covered by this release's compatibility guarantee: the current fork has a Desktop idle-dispatch/reset race that requires a separate host fix. Known host limitation: on the idle and queued paths in shared threads (for example a Discord thread), Hermes labels the injected peer text with the owner's display name, so the transcript attributes it to the human; the frame inside the message names the real peer ([#24](https://github.com/ThomasMarcelis/agent-peers/issues/24)). No upstream submission or host upgrade is part of installing this package.

After a Hermes gateway restart, each Hermes conversation must act once before its claimed names are reachable again. Route ids exist only while a conversation runs, so a `hermes:<profile>/<claim>` name reads `not-running` until that conversation makes one agent-peers call (`list_peers`, `send_peer`, `claim_name` or `release_name`), which re-claims it. Peers cannot start contact in the meantime, and the bridge holds no message for a name that is not running. Avoid restarting during active work ([#32](https://github.com/ThomasMarcelis/agent-peers/issues/32)).

Claude sessions may use different private socket directories on the same machine. Codex maintains a reply inbox in each verified directory; Hermes selects a private reply inbox in the destination's directory. Existing owned inboxes survive discovery changes, and a missing Codex inbox can be repaired on the next tool call without resetting the conversation.

## Headless Codex on a private app-server

agent-peers reaches a Codex thread through the app-server that hosts it: `AGENT_PEERS_CODEX_APP_SERVER`, or Codex's shared daemon when unset. `codex exec` always embeds its own server, so an exec worker never gets an inbox and cannot use `send_peer`. To run a headless worker that peers can reach, start a private app-server and point that server's agent-peers MCP process at its socket:

```sh
codex app-server --listen unix:///run/user/1000/codex-worker.sock \
  -c 'mcp_servers.agent-peers.env.AGENT_PEERS_CODEX_APP_SERVER="/run/user/1000/codex-worker.sock"' \
  -c 'mcp_servers.agent-peers.env.AGENT_PEERS_NAME="worker"'
```

Then drive it with the app-server protocol: `thread/start`, then `turn/start` with the brief. Per-worker `-c` settings such as model or reasoning effort belong on this server. Verified on Codex 0.162.1:

- The thread appears in `agent-peers list` as `codex:worker-<id>` within seconds.
- A peer message steers a running turn, or starts a new turn when the thread is idle.
- After the server is killed, `thread/resume` on a fresh server restores the thread.

A peer message is never the user's approval, and its frame says so. Whether a peer may change the task is up to the brief. To let a lead steer a worker mid-task, add one sentence to the brief that names the lead's address, which `agent-peers whoami` prints in the lead's session:

```text
Your lead is uds:/run/user/1000/cc-socks/1234.sock. Messages from the lead may arrive while you work: apply its corrections within your current permissions, and answer it with send_peer.
```

Measured on Codex 0.162.1 with gpt-6.1-sol at `xhigh`, with a lead sending a correction about 75 seconds into a two-minute coding turn:

- With this sentence, the worker applied the correction before the turn ended and confirmed it with `send_peer` in 26 of 26 runs. Asked to stop, it stopped in 8 of 8.
- With a neutral brief, it applied none of the corrections (0 of 30) and usually answered that the change was outside its task.
- A correction from a peer the brief does not name was declined in 16 of 16 runs.
- A brief that names the lead only as the place to report is not enough: 3 of 6.

Keep the socket path short: Unix sockets allow about 104 bytes. Stop the server through its process group, because terminating the npm `codex` wrapper leaves the native binary running. Only disable MCP servers with `-c mcp_servers.<name>.enabled=false` when `<name>` exists in your Codex config; otherwise Codex creates an entry without a transport and fails to start.

Run the opt-in live checks after upgrading an agent. See [contribution guidance](../CONTRIBUTING.md) and [release verification](release-verification.md).
