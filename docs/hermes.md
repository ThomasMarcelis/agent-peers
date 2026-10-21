# Hermes plugin (experimental)

The repository is a native Hermes plugin and an npm package. Both use the same Node transport. Hermes starts its own bridge subprocess lazily; a separate standalone daemon is unnecessary.

## Prerequisites

Use the [verified Hermes fork](compatibility.md#tested-agent-builds), Python 3.11–3.13, and Node.js 22+. Stock Hermes currently lacks the exact-conversation route APIs. Discovery remains available there, but sending returns an unsupported-host error.

## Install

```sh
hermes plugins install ThomasMarcelis/agent-peers --enable
```

For a reproducible release install, add `--ref` followed by the full 40-character commit from the [GitHub release](https://github.com/ThomasMarcelis/agent-peers/releases/tag/v0.3.0). Hermes does not accept tag names for this flag. Use `hermes --profile NAME plugins install ...` for a named profile. Current Hermes installers can offer to install the plugin's Node dependencies; accept that step. Older fork installers need a separate install in the plugin directory printed by Hermes:

```sh
npm --prefix /absolute/plugin/directory ci --omit=dev --ignore-scripts
```

Replace `/absolute/plugin/directory` with the actual installed directory. The plugin reports the exact recovery command if Node or dependencies are unavailable. There are no install-time scripts in agent-peers.

Grant injection explicitly for each selected profile using Hermes configuration:

```sh
hermes config set plugins.entries.agent-peers.allow_gateway_injection true
```

This allows automatic peer messages to start or steer the original conversation. For messaging gateways, an agent response may be posted to its existing chat/thread. The plugin does not grant this permission itself. New hosts/conversations may be needed to load changed plugin tools; follow your host's normal restart workflow.

If saved platform tool selections exclude new plugins, enable the `agent-peers` toolset for the intended platform using `hermes tools`. Preserve other platform selections.

## Behavior

`list_peers()` returns Claude Code and Codex inboxes and claimed names, without publishing Hermes except through names it [claimed](#stable-names). `send_peer` also takes a claimed name as `to`. The first `send_peer(to, message)` creates a private inbox for that conversation. Peers reply to its received address through their normal messaging tools. `send_peer` returns the [shared result](reference.md#send_peer-result); an `error` field means the message was not delivered. Pass `in_reply_to` with the `id` of the message being answered.

- Every conversation and profile has an independent reply route.
- A conversation's inbox accepts messages only from peers that conversation has sent to, and from senders that addressed it by a name it claimed (below). Another sender is refused with `not-a-reply-target`, even if it finds the inbox in the socket directory.
- Busy conversations receive input through the host's steering boundary; idle conversations start a turn.
- Routes belong to the originating host conversation. Unload or host shutdown closes their inboxes; Hermes must send again to establish fresh return addresses.
- Discord replies return to the original thread. Switching chats does not change the return destination.
- There is no transcript scraping, history polling, offline mailbox, or automatic retry of an ambiguous send.
- A delivery outcome that arrives after `send_peer` returned is logged, never injected into the conversation.

Discord gateway routing is the verified surface. CLI and Desktop/TUI lifecycle behavior remains experimental on the current fork; see the [host limitation](compatibility.md#what-to-expect).

## Stable names

A conversation that peers should reach without first hearing from it, such as a relay, claims a name with `claim_name({name: "relay"})`. The name is always `hermes:<profile id>/<claim>`: the profile comes from Hermes, never from the model, and both the plugin and its bridge refuse another profile's scope with `scope-denied`. A profile id outside `[a-z0-9][a-z0-9_-]{0,63}` cannot claim names. Claiming needs a live conversation route, as sending does, and opens the conversation's inboxes in every verified socket directory at once. A refused claim closes the inboxes it opened again; inboxes the conversation already had, for its own sends or another name, stay open. The name is then the only way this conversation appears in `list` and `list_peers`; nothing else about it is published. See [names](reference.md#names) for the grammar, results and resolution.

- **Who can write first.** A claimed name admits senders that addressed the conversation by that name, from a socket that exists: a Codex or Hermes `send_peer` to the name, or a Claude session that ran `agent-peers resolve <name>` just before its `SendMessage`. The conversation answers `resolve`, which fails when it will not admit that Claude session, for example because the bridge and the session use different `CLAUDE_CONFIG_DIR`s (`unknown-sender`). Admitted senders then stay reply targets until the conversation closes, even if it releases the name, up to the latest 64 such senders. They are kept apart from the 256 peers it wrote to, with rate limits of their own, so they can never push one of those out or use up their limits. A sender that writes to the same inbox without the name still gets `not-a-reply-target`, as does a line sent to a name this conversation does not hold now ([details](reference.md#names-and-the-reply-target-allowlist)).
- **Running.** A name is running while its bridge process runs and at least one inbox its record names exists. The record follows the inboxes: when a send opens one in another socket directory, the conversation's next agent-peers call records it. Which Claude sessions or socket directories a reader can see never decides whether the holder runs, so nobody takes over a name whose conversation still has an inbox.
- **Another conversation.** A different conversation in the same profile cannot take a name while its holder runs (`name-held`). Once the holder's route closes, the reservation remains and counts toward `namesNotRunning`; `list_peers({all_names: true})` shows it as not running. A new conversation (after `/new` or a reset) takes it over with `claim_name`; the result names the previous holder.
- **Gateway restarts.** Route ids change at every restart, so a claimed name is `not-running` after one. Each Hermes conversation must act once after a restart before its names are reachable again: its next agent-peers tool call (`list_peers`, `send_peer`, `claim_name` or `release_name`) takes them back. A relay that should be reachable right after a restart needs one such call, so avoid restarts during active work; there is no host route-restore hook yet. A name it cannot take back, such as one a newer agent-peers rewrote, is tried again at most once a minute.
- **Compression** keeps the route and changes the conversation id; the names follow the new id on the conversation's next agent-peers call, which rewrites their owner.
- **Compression, then a restart.** A name's owner is the conversation id it was last refreshed under. If compression changes the id and the gateway restarts before the conversation's next agent-peers call, its names still carry the old id, and after the restart the conversation (now known by the new id) does not take them back automatically. They stay `not-running` until it claims them again with `claim_name`, which takes them over because their holder stopped; until then another conversation in the profile could claim them first. Any agent-peers call between the compression and the restart avoids this; there is no host hook yet that refreshes names when a conversation is compressed.
- `release_name({name})` removes a name this conversation holds, or one of this profile's `hermes:` names whose holder is not running. Any other name, of another profile or kind, is `scope-denied`, even when dead, because its own claimant may take it back after a restart; equally, no Codex or Claude session can release this profile's names. Non-running reservations never expire; the default listing counts them, and `all_names: true` displays them.

## Configuration

An optional `bridge_command` list under `plugins.entries.agent-peers.settings` overrides the executable and arguments. Use absolute paths. Normal installs resolve Node and the bridge within the installed plugin; no checkout path is required. The plugin appends `--hermes-profile <profile id>` to the bridge command, so a custom command must pass its arguments on to `agent-peers hermes-bridge`.

The bridge inherits only environment needed for discovery and execution. Provider credentials are not passed to it. It reads Claude session registry metadata and agent-peers registry entries, communicates over local sockets, and keeps no transcript archive. Agent replies may themselves invoke the model providers configured in those agents.

## Update and remove

Use Hermes's native plugin manager to update or remove the plugin. For an explicitly pinned release, reinstall with the new release ref after reviewing its compatibility notes. The legacy Python installer is a compatibility helper; native installation is the supported path.

The optional generic Hermes host extension is separate from this package. It adds conversation-route capabilities for any plugin; peer discovery and messaging remain entirely here.
