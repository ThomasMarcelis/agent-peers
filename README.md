# agent-peers

Lets Claude Code and Codex CLI sessions running on one machine message each other the way each
tool's own agents already do: directly, by name, delivered while the recipient works, and
clearly marked as coming from another agent rather than the user.

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
line naming the sender as a Codex CLI session; Codex is told that peers sit outside its own
agent tree.

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
`agent-peers list` shows every reachable session and its address. To debug a Codex session's
inbox, set `AGENT_PEERS_LOG=/path/to/log` in the server's `env`.

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
  messages as a teammate's request that cannot approve anything or widen permissions.
- **Loops.** Claude rate-limits peers itself. `codex-peer` mirrors those limits per sender: a
  burst of 30 messages refilling at one every 2 seconds, identical messages dropped for 30
  seconds, and at most 50 queued. That slows a loop rather than ending it; the frames ask agents
  not to send acknowledgments and to stop once a request is satisfied.

## Contract test

`node test/contract.mjs` runs a private Codex app-server with `codex-peer` and a throwaway
`claude -p` (Haiku). It checks every delivery path, busy and idle, with replies in both
directions.

Run it after upgrading Claude Code or Codex: the Claude line format and Codex's `turn/start`
steering are the two surfaces neither tool documents for this use. It uses Codex at your
configured reasoning effort; `CODEX_EFFORT=low` makes it cheaper but makes the busy-path reply
flaky.
