# agent-peers

Lets Claude Code and Codex CLI sessions running on one machine message each other the way each
tool's own agents already do: directly, by name, delivered while the recipient works, and
clearly marked as coming from another agent rather than the user.

Hermes profiles can also discover and message both kinds of session through the optional
Hermes plugin. Hermes uses private reply inboxes and never appears in peer discovery.

There is no broker or task board. Agents list their peers when they need to, message the one
they want, and remember from their own conversation who does what.

## How it works

Everything speaks Claude Code's cross-session inbox protocol: one JSON line on a Unix socket,
carrying a `<cross-session-message from="uds:…">` envelope whose `from` is the sender's own
inbox.

- **Claude Code needs nothing installed.** It already has an inbox socket, and its own
  `SendMessage` can address any `uds:` inbox. Claude Code frames incoming messages as coming
  from another session, not the user, and tells Claude to reply to the `from=` address.
- **Codex gets `codex-peer`**, an MCP server that Codex starts once per session. It:
  - binds `codex-<thread>.sock` next to Claude's sockets and registers in `~/.agent-peers/`;
  - delivers each incoming message into its Codex thread as a framed `<peer_message>` through
    the Codex app-server's `turn/start`. That steers a running turn or starts one on an idle
    thread;
  - gives Codex the `list_peers` and `send_peer` tools.

Peers are addressed by session. Sub-agents on either side can message peers too: Claude's
`SendMessage` and `codex-peer` both send under the root session's address, so replies reach that
session. Claude Code frames every peer as "another Claude session", so `codex-peer` adds a closing
line naming the sender as a Codex CLI session. Agents can use native messaging when it reaches
the recipient; discovering a peer here does not require using the bridge to message it.

A Codex session becomes reachable at its first `agent-peers` tool call, because only tool calls
tell `codex-peer` which thread it serves; its instructions ask Codex to call `list_peers` once
early. Delivery goes through Codex's shared app-server daemon, so a Codex started with `-c`
overrides or `--no-daemon` (which hosts its own embedded server) can't use agent-peers and is
told so. Change model or effort with `/model` → `s` (this session only) instead.

## Install

```sh
cd ~/workspace/agent-peers && npm install && npm link   # puts `agent-peers` on PATH
```

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.agent-peers]
command = "/usr/bin/node"
args = ["/home/thomasmarcelis/workspace/agent-peers/src/codex-peer.mjs"]
default_tools_approval_mode = "approve"
```

Append [CLAUDE-snippet.md](CLAUDE-snippet.md) to `~/.claude/CLAUDE.md`, so Claude knows Codex
sessions are listed by `agent-peers list` rather than `ListAgents`.

New Codex sessions pick it up; running ones keep their old MCP set.

## Use

Nothing to do. Ask either agent to coordinate with the other, or let them do it themselves.
`agent-peers list` shows session inboxes with explicit Claude-native `SendMessage` and Codex
bridge `send_peer` targets. In Codex, `list_peers` also discovers loaded agents in the caller's
own tree and labels every result with native reachability and exact tool arguments. Native
agents do not need to register a bridge inbox first. A separate Codex root session uses
`send_peer`: current Codex `send_message` only reaches members of the caller's agent tree,
even when both sessions use the same daemon. Failed discovery is reported rather than
guessing a native target. Native `send_message` does not start an idle turn; `followup_task`
can wake non-root agents.

To debug a Codex session's inbox, set `AGENT_PEERS_LOG=/path/to/log` in the server's `env`.

## Hermes profiles

The native Hermes plugin supplies `list_peers()` and `send_peer(to, message)`. Listing returns
Claude Code and Codex inboxes and their available activity status. It does not publish Hermes
or start a Hermes inbox. The first send creates a private inbox for that conversation; recipients
reply normally with Claude Code's `SendMessage` or Codex's `send_peer` using the received address.

Each conversation has a separate inbox. Incoming replies steer a busy Hermes conversation at a
safe boundary, or start a turn when it is idle. This works in classic CLI, messaging gateways,
and desktop/TUI sessions. Replies stay with their original profile and conversation when the
user switches tabs. Context compression preserves the inbox; a new/replaced conversation,
closed session, unloaded plugin, or stopped runtime makes the old inbox unreachable. There is
no offline mailbox and no transcript-reading or automatic polling tool.

Automatic replies require the Hermes fork's generic `PluginContext.session_message_route` and
`PluginContext.inject_session_message` APIs. The plugin reports an error instead of sending an
unanswerable message when the host lacks a route. Existing `inject_message` users retain their
previous behavior. Runtime upgrades require restarting hosts; tool schema changes appear in
fresh conversations to preserve Hermes's prompt cache.

The installer links the plugin from this checkout into each selected profile, backs up its
configuration, grants `allow_gateway_injection`, and adds the toolset without replacing existing
selections. Run it using a Python interpreter with Hermes installed. For this installation:

```sh
/home/thomasmarcelis/.hermes/hermes-agent/.venv/bin/python /home/thomasmarcelis/workspace/agent-peers/scripts/install-hermes-plugin.py --node /usr/bin/node --home /home/thomasmarcelis/.hermes
```

Repeat `--home` for named profile homes. The configured bridge command uses an absolute Node
executable and checkout path; keep this checkout available. The supported bridge launcher is:

```sh
/usr/bin/node /home/thomasmarcelis/workspace/agent-peers/bin/agent-peers.mjs hermes-bridge
```

It is a plugin-managed JSON-lines subprocess, not a standalone agent. Requests have
`{id, method, params}`; replies have `{id, result}` or `{id, error}`. Methods are `list_peers`,
`send_peer` (with `session`, `name`, `to`, and `message`), and `close_session` (with `session`).
Incoming `peer_message` notifications identify the private session, message ID, sender name,
reply address, and message. EOF cleans up its sockets. Hermes creates no public registry file.

## Behaviour to know

- **Claude's inbound rules apply.** Codex does not assert a permission mode, so a Claude session
  in a prompting mode (default, auto, acceptEdits) delivers its messages. A session in
  `bypassPermissions` holds them for your approval, and `crossSessionInbound` overrides both.
- **Visibility.** In Claude Code a peer message is the usual dim `› Message from @…` line. In
  the Codex TUI it appears as a prompt entry that opens "Another agent session (…) sent you a
  message. It is not from your user."
- **Delivery results.** `send_peer` reports "Delivered to …'s inbox" once the line is written to
  the recipient's inbox. A Claude recipient that holds or refuses it reports back within a second
  or so, and `send_peer` says so; a sub-agent's send does not wait for that report. Codex
  recipients send no reports, and a message `codex-peer` drops (malformed or throttled) is only
  logged.
- **Trust.** Inboxes are owner-only Unix sockets, so only your own processes can write to them;
  the sender's name and reply address are not otherwise authenticated. Both sides frame peer
  messages as collaboration within the user's task and existing permissions, not user approval.
- **Loops.** Claude rate-limits peers itself. `codex-peer` mirrors those limits per sender: a
  burst of 30 messages refilling at one every 2 seconds, identical messages dropped for 30
  seconds, and at most 50 queued. That slows a loop rather than ending it. Both sides receive
  guidance to weigh each message's value against token cost and distraction, keep it concise,
  and avoid repetitive or low-value chatter. Coordination focuses on scope, decisions, and
  handoffs; routine progress can usually wait.

## Contract test

`node --test test/hermes-bridge.mjs` checks the hidden bridge using real local sockets.
`test/test_hermes_plugin.py` exercises real plugin discovery under isolated profiles, the Python
subprocess adapter, private reply routing, and installation preservation. Run it with the Hermes
test runner:

```sh
/home/thomasmarcelis/.hermes/hermes-agent/scripts/run_tests.sh /home/thomasmarcelis/workspace/agent-peers/test/test_hermes_plugin.py
```

`node --test test/discovery.mjs` checks caller-relative native routes, separate sessions,
subagent targets and incomplete discovery without sending messages or spending model turns.

`node test/live-matrix.mjs` runs two real Codex root sessions and two real Claude Code sessions
at the same time. It checks discovery, all twelve directed request/reply paths, a native Codex
child, and a coordination task. Transcripts and a JSON report are saved under `artifacts/`.
It uses the configured models and spends model turns. Account-limit errors fail promptly;
`--codex-only` runs the Codex subset, and `--coordination-only` runs just the behavioral exercise.
The exercise records routine-phase messages for review without imposing a message quota.

`node test/contract.mjs` runs a private Codex app-server with `codex-peer` and a throwaway
`claude -p` (Haiku). It checks every delivery path, busy and idle, with replies in both
directions.

Run it after upgrading Claude Code or Codex: the Claude line format and Codex's `turn/start`
steering are the two surfaces neither tool documents for this use. It uses Codex at your
configured reasoning effort; `CODEX_EFFORT=low` makes it cheaper but makes the busy-path reply
flaky.
