# Changelog

## Unreleased

### Changed

- Claimed names are [experimental](docs/stability.md#experimental) in 1.x. Their commands, fields and storage may change in a minor release. Their safety rules stay fixed: no misrouting, no displacing a running holder, profile scoping, and the Hermes first-message rule. Sessions that do not claim names depend on covered surfaces only.

## 1.0.0-rc.2 — 2026-10-17

Second release candidate for 1.0.0, on the npm `next` tag. Adds explicit, scoped stable names (#13), part of the covered 1.0 surface ([stability](docs/stability.md)). See [names](docs/reference.md#names).

### Added

- A session or conversation claims a name of the form `<kind>:<scope>/<claim>`, such as `claude:marketsimulator/lead`, so peers reach whoever holds that role now: `agent-peers claim` and `agent-peers release` for Claude sessions, `claim_name` and `release_name` tools for Codex and Hermes. A Hermes name is always scoped to its profile, enforced by the plugin and the bridge.
- A running holder keeps its name. A holder that is not running is taken over, and the result names it; the same claimant refreshes without any flag. A Codex session takes back its names when its MCP server binds again, and a Hermes conversation on its next agent-peers call after a gateway restart.
- `send_peer` takes a claimed name, resolved when it sends: `not-found` when nobody claimed it, `not-running` when its holder stopped, never another session. `agent-peers resolve <name>` prints the one `uds:` address a Claude session should `SendMessage` to.
- `list --json` and `list_peers` return `names[]`, including dead names until they are released; peer rows, Codex `self` and `whoami --json` gain `claims`. Frames add `reply_name` when the recipient verified the sender's claim.
- A Hermes conversation that claims a name accepts a first message from senders that used that name: `send_peer` to the name marks the line with `agent_peers.to_name`, and `agent-peers resolve` tells the holder which Claude session is about to send. A sender that only found its inbox in the socket directory is still refused `not-a-reply-target` (#28).
- Names are stored as one private file each under `$AGENT_PEERS_HOME/names/`, replaced by compare-and-swap, with no lock and no daemon.

### Changed

- A name containing `/` is now resolved as a claimed name instead of failing `reserved-name`, which is no longer returned; names outside the grammar fail `invalid-request`.
- The Hermes plugin starts its bridge with `--hermes-profile <profile id>`. A custom `bridge_command` must pass its arguments on.

## 1.0.0-rc.1 — 2026-10-17

Release candidate for 1.0.0, published to the npm `next` tag (`npm install -g agent-peers@next`). From 1.0.0, the [stability policy](docs/stability.md) defines what semver covers. One delivery protocol for Codex, Hermes and Claude Code peers. See [the reference](docs/reference.md#send_peer-result).

### Breaking

- `send_peer` returns one result on both hosts: `{status, reason, message_id, in_reply_to, to, name, generation, from}`. Codex's `structuredContent.receipt` is now `status`. Hermes's `address` is now `from`, and Hermes failures return the full result with `error` instead of `{error}` alone. There are no aliases.
- A send to a Claude Code session reports `unconfirmed` instead of "Delivered", because Claude sends no receipt for an accepted message. A write that times out is `failed`/`write-timeout`.
- Peer names resolve exactly. Unique-substring abbreviations are gone; an exact name without its `claude:` or `codex:` prefix still works when only one kind has it. `not-found` lists exact names to choose from.
- Names containing `/` are reserved for explicit claims (`<kind>:<scope>/<claim>`) and fail `reserved-name`; `@ * ? ,` and whitespace fail `invalid-request`. Claude session names and Codex labels with other characters are listed with `-` in their place.
- Inboxes dedup by sender and message id only. Repeated identical bodies are delivered.
- A Hermes conversation's inboxes accept messages only from peers that conversation has sent to; others get `dropped`/`not-a-reply-target`. A session that lost its Hermes address could otherwise pick another conversation's inbox from the socket directory and post into an unrelated chat (#28).

### Added

- Receipts from agent-peers inboxes in Claude Code's own format. Every sender gets `dropped` with a reason; agent-peers 1.0 senders opt in to `queued` and `accepted` through an `agent_peers` line extension that Claude Code and 0.x ignore (#8).
- `send_peer` takes `in_reply_to`, shown on the recipient's frame; Claude recipients get `(In reply to <id>.)` instead (#10).
- A `generation` on every listed session. A record whose PID now belongs to another process is not listed, and a send to a name or address that a different process has taken over fails `not-running` instead of reaching it (#12).
- A negative receipt that arrives after `send_peer` returned is appended to the Codex session's history without starting a turn. Hermes logs it only (#18).
- Codex `list_peers` reports the caller as `self` (#14).

### Changed

- One Codex MCP process serves up to eight root sessions, each with its own inbox, instead of rebinding to the latest (#19). `codex-peer` is split into binding, inbox and tool modules (#16).
- The Hermes bridge handles requests concurrently, keeping order per conversation (#17).
- agent-peers never answers an app-server request (approvals, user input, dynamic tools, token refresh, attestation). These fan out to every client and the first answer wins, so an answer could override the client that owns the request. Each is logged by method (#25).
- Tested on Claude Code 2.1.302 and Codex 0.162.1. CI's Hermes integration job runs against the deployed fork build `0d7c749` (Hermes v0.22.2 plus a minimal host patch).
- Receipts are unauthenticated between same-user processes; a receipt must name the inbox the message was written to, which rejects stray ones (see [SECURITY.md](SECURITY.md)).

## 0.3.0 — 2026-10-16

First npm release since 0.1.0. Versions 0.1.1 and 0.2.0 were released on GitHub only, and their changes are included here. From this version on, npm releases are published from CI with provenance.

- `agent-peers whoami [--json]` reports the calling Claude Code session's name and address, found through process ancestry rather than guessed from the working directory.
- `agent-peers list` probes each peer socket and marks refusing sockets `stale` / `reachable: false` without deleting records; `--no-probe` skips this.
- Peer discovery scans Claude session records once per listing instead of once per peer (about 110 ms to 5 ms for 120 peers).
- A delivery to a peer that closes its connection mid-write is reported as failed instead of delivered.
- Releases publish from a single CI job on version tags, after the tagged commit has passed CI; CI runs five jobs instead of ten.

## 0.2.0 — 2026-10-16

GitHub release only; not published to npm.

- `agent-peers doctor` asks the Codex app-server one read-only question instead of trusting socket presence, and reports a stale daemon link or a server that does not answer, with the start command.
- Startup binding backs off to every 10 minutes after its quick retries and logs each failure reason once, plus one `unreachable` event and stderr line, instead of every minute forever.
- Documented headless Codex workers on a private app-server; the unreachable-thread error now names the app-server in use and the alternatives.
- Hermes frames carry the message `id` like Codex frames; Hermes sender names are sanitized for any route ID; the dependency recovery command uses `npm install` when the package has no lockfile.
- The Hermes bridge drops an inbound message whose re-encoded notification would exceed the host's line limit instead of restarting the bridge.
- The Claude compatibility footer is sent once per sender and recipient instead of on every message.
- `send_peer` results carry a message ID that matches the `id` on the recipient's frame.
- `@modelcontextprotocol/sdk` 1.32.1.
- Startup-binding scans log `mcpServerStatus/list` instead of an unknown method. The internal observatory design draft is no longer packaged.

- Shorter coordination guidance, incoming peer frames, Claude-only compatibility footers and delivery receipts. Message bodies, permission boundaries, reply routing and receipt metadata remain intact; private reply inboxes no longer receive Claude-specific footers.
- Codex sessions open their inbox when they start instead of on their first agent-peers tool call, and are named after their working folder (`codex:<folder>-<id>`); `AGENT_PEERS_NAME` overrides the folder. A subagent's tool call no longer closes its root's inbox.
- Opt-in, bounded local JSONL diagnostics for Codex, Hermes, app-server requests and socket framing, with content exclusion and a read-only usage summary.
- Native-only targets now explain the exact native messaging route when mistakenly passed to `send_peer`; idle subagents advertise `followup_task`.
- Codex discovery limits concurrent thread reads so sessions with more than 256 loaded agents remain discoverable.
- Explicit negative delivery receipts are marked as MCP tool errors.
- Read-only diagnostics accept Codex's owned daemon-socket symlink while rejecting unsafe link and target directories.

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
