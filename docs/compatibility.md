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
| opencode | opencode **2.x** with the v2 plugin/session API (`setup`, `ctx.tool.transform`, `ctx.session.get`, `ctx.session.synthetic`); tested against 2.0.32. opencode 1.x's plugin API is not supported |

Windows is not supported. WSL must run all participating agents inside the same Linux environment. CI on macOS verifies the transport and package; live agent interoperability was exercised on Linux.

## Tested agent builds

- Codex CLI **0.162.1**: `node test/contract.mjs` (busy and idle delivery, replies) and startup binding. Earlier releases were verified on 0.160.0.
- Claude Code **2.1.302**: the same contract run, including a message line that carries the `agent_peers` extension and a Codex reply that Claude accepts without a receipt. Earlier releases were verified on 2.1.288.
- Hermes fork [ThomasMarcelis/hermes-agent](https://github.com/ThomasMarcelis/hermes-agent) at [`0d7c749cff42cd4791e0342da226c6d499de5aeb`](https://github.com/ThomasMarcelis/hermes-agent/commit/0d7c749cff42cd4791e0342da226c6d499de5aeb) (branch `jd/thin-v0.22.2`: Hermes v0.22.2 plus a minimal host patch). CI runs the Hermes integration tests against this build, and the maintainer's gateways run it; agent-peers 0.2.0 was verified end to end on it. It replaces the earlier pin `1afb5d16`, which is a different line of history.
- opencode **2.0.32**: the v2 plugin/session API described in [the design](https://github.com/ThomasMarcelis/agent-peers/blob/main/docs/design/opencode.md) was inspected against this build. The plugin, bridge, registry, names and delivery are covered by deterministic tests. For 1.0.0-rc.7 a private `opencode serve` with this tree's plugin and `deepseek/deepseek-flash` passed a live smoke run (bind, `list_peers`, `claim_name`, idle synthetic wake with no prompt fallback, staged-revert drop, restart rebind) and a three-host run with Claude Code on `claude-haiku-5-5` and Codex on `gpt-6-luna` (discovery from all three, all six directed request/reply routes, a claimed `opencode:` name reached by name). After release, the published package was also exercised on the maintainer's opencode **background service** (`opencode serve --service`) with three locations loaded at once: the plugin's bridge child ran under the service, each location's session bound through its own location and kept its bind while the others were prompted, a Claude Code `SendMessage` woke an idle session after its `opencode run` had exited and it answered with `send_peer` (no approval needed), and a claimed name resolved. The design's 16+16 busy/idle and 6+6 task-change steering runs, the two-server run, a service restart rebind, and the `--standalone` and TUI modes were not run; see [release verification](release-verification.md#100-rc7).

The pinned Hermes host is reproducible in CI. It is a fork dependency, not a claim that any upstream version with the same version number includes these APIs.

Upstream Hermes was inspected at [`5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662`](https://github.com/NousResearch/hermes-agent/commit/5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662). Its public `inject_message` API cannot atomically pin a late reply to the original conversation across reset and compression. Gateway and TUI injection queue busy-session input rather than steering it. The plugin therefore rejects sends on that host instead of weakening its routing contract.

## What to expect

A Codex inbox opens when the session starts: the MCP server finds its own thread through the daemon's `mcpServerStatus/list`, which requires the server to be registered as `agent-peers`. Otherwise, or if the daemon does not report it, the inbox opens on the session's first `list_peers` or `send_peer` call. A root session is named `codex:<folder>-<id>`, or after its thread title when it has no folder. Threads hosted in embedded servers, including `codex exec` and sessions started with `-c` or `--no-daemon`, are not reachable; a private app-server is (below). A subagent sends under its root's address; replies return to the root. Native targets only refer to agents in the caller's own tree. One MCP server process can serve up to eight root sessions, as after `/new` or resume in the Codex TUI; each keeps its own inbox.

Claude's inbox protocol is undocumented. Inbound messages may be held for approval or rejected according to Claude settings. In particular, `bypassPermissions` does not imply accepting external messages. The package does not change that policy.

Hermes support is experimental. Tests verify plugin loading, profile isolation, and busy/idle replies to the originating Discord thread on the pinned fork. CLI and Desktop/TUI reset/compression behavior is not covered by this release's compatibility guarantee: the current fork has a Desktop idle-dispatch/reset race that requires a separate host fix. Known host limitation: on the idle and queued paths in shared threads (for example a Discord thread), Hermes labels the injected peer text with the owner's display name, so the transcript attributes it to the human; the frame inside the message names the real peer ([#24](https://github.com/ThomasMarcelis/agent-peers/issues/24)). No upstream submission or host upgrade is part of installing this package.

After a Hermes gateway restart, each Hermes conversation must act once before its claimed names are reachable again. Route ids exist only while a conversation runs, so a `hermes:<profile>/<claim>` name reads `not-running` until that conversation makes one agent-peers call (`list_peers`, `send_peer`, `claim_name` or `release_name`), which re-claims it. Peers cannot start contact in the meantime, and the bridge holds no message for a name that is not running. Avoid restarting during active work ([#32](https://github.com/ThomasMarcelis/agent-peers/issues/32)).

Claude sessions may use different private socket directories on the same machine. Codex maintains a reply inbox in each verified directory; Hermes selects a private reply inbox in the destination's directory. An opencode session has one inbox, in the first verified directory, so its `send_peer` to a Claude session in another directory is refused `inbox-unavailable` (nothing is sent) rather than lost. Existing owned inboxes survive discovery changes, and a missing Codex inbox can be repaired on the next tool call without resetting the conversation.

## opencode (experimental)

opencode support is experimental: the plugin, its four tools, the bridge protocol, `opencode:` names, opencode registry rows and the read-only `doctor` checks may change in a minor release. It requires opencode 2.x's v2 plugin and session APIs; 1.x is not supported. The plugin uses the in-process host client, so it is intended to work with the background service, `--standalone` and `--server <url>` alike; agent-peers never reads the service registration or password. A private `opencode serve` and the background service have been exercised live; `--standalone` and `--server <url>` have not.

A location's plugin registers the tools immediately and starts one bridge child for the whole server process. A root session is reachable after its first prompt or its first agent-peers tool call. opencode gives every location's plugin every session event, so a prompt binds only through the session's own location and never moves a root that another location serves; only a tool call, which runs in its session's location, moves a root; a child (subagent) session sends under its root and holds no names. A bridge serves at most 64 roots. At the cap it evicts only an idle root (no idle timestamp or `time.idle < time.updated` means busy) that holds no claimed names; if none qualifies, the new bind is refused `inbox-unavailable` and the session's next tool call says so. A session left after a server or bridge restart is `not-running` until its next prompt or tool call, exactly as a Hermes name after a gateway restart; there is no automatic disk rebind and no offline mailbox. The same happens when opencode unloads a location after 60 minutes with no session events there (opencode's location inactivity timeout): its plugin instance closes, its sessions read `not-running` and their names stay claimed but unreachable until their next prompt or tool call, and when the last location unloads the bridge exits. A session waiting for a peer reply is not kept bound by that wait.

**Do not run one opencode session in two servers.** The background service and a `--standalone` or `--server` process share `$XDG_DATA_HOME/opencode/opencode.db` by default, and each has a process-local runner with no cross-process runner lock. The first live bridge binds the session and owns its inbox and name; the second bridge refuses with `inbox-unavailable`. But if server B's TUI is already running that same session, a peer delivery through server A's bridge calls `session.synthetic` with `resume: true`, which wakes **A's** runner while B may already be running the session. That can start a second runner on a session that is already running. agent-peers cannot choose the UI's server, so running one session in two servers is unsupported: stop one server, or keep each session to a single server.

`--auto` auto-approves permissions that are not explicitly denied, so a peer message can cause tool calls with no human approval step. The frame's “grants no approval” is a model instruction, not a host permission boundary. Do not use `--auto` with untrusted peers or sensitive repositories; configure permissions explicitly. The reverse also holds: `opencode run --auto` approves only while that `run` is attached. A turn that a peer message starts after the `run` has exited has no approver, so a tool call that needs a permission waits until someone answers it in a TUI or through the API.

A local plugin entry must be the package **directory** (for example `"plugins": ["/path/to/agent-peers/opencode"]`); opencode 2.x skips a file path with "configured plugin path must be a directory", and `doctor` warns about it. The tools are registered as direct tools (`codemode: false`) under their exact names, as the peer frame's `send_peer(to=reply_to)` assumes.

`opencode plugin add agent-peers@next` installs the plugin's own copy of the package, which can differ from the global CLI; `agent-peers doctor` prints both and warns on skew. Pin one package version. Live results for this build are listed above; no steering rate is claimed for opencode.

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
