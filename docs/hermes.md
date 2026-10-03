# Hermes plugin (experimental)

The repository is a native Hermes plugin and an npm package. Both use the same Node transport. Hermes starts its own bridge subprocess lazily; a separate standalone daemon is unnecessary.

## Prerequisites

Use the [verified Hermes fork](compatibility.md#tested-agent-builds), Python 3.11–3.13, and Node.js 22+. Stock Hermes currently lacks the exact-conversation route APIs. Discovery remains available there, but sending returns an unsupported-host error.

## Install

```sh
hermes plugins install ThomasMarcelis/agent-peers --enable
```

For a reproducible release install, add `--ref` followed by the full 40-character commit from the [GitHub release](https://github.com/ThomasMarcelis/agent-peers/releases/tag/v0.1.1). Hermes does not accept tag names for this flag. Use `hermes --profile NAME plugins install ...` for a named profile. Current Hermes installers can offer to install the plugin's Node dependencies; accept that step. Older fork installers need a separate install in the plugin directory printed by Hermes:

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

`list_peers()` returns Claude Code and Codex inboxes without publishing Hermes. The first `send_peer(to, message)` creates a private inbox for that conversation. Peers reply to its received address through their normal messaging tools.

- Every conversation and profile has an independent reply route.
- Busy conversations receive input through the host's steering boundary; idle conversations start a turn.
- Routes belong to the originating host conversation. Unload or host shutdown closes their inboxes; Hermes must send again to establish fresh return addresses.
- Discord replies return to the original thread. Switching chats does not change the return destination.
- There is no transcript scraping, history polling, offline mailbox, or automatic retry of an ambiguous send.

Discord gateway routing is the verified surface. CLI and Desktop/TUI lifecycle behavior remains experimental on the current fork; see the [host limitation](compatibility.md#what-to-expect).

## Configuration

An optional `bridge_command` list under `plugins.entries.agent-peers.settings` overrides the executable and arguments. Use absolute paths. Normal installs resolve Node and the bridge within the installed plugin; no checkout path is required.

The bridge inherits only environment needed for discovery and execution. Provider credentials are not passed to it. It reads Claude session registry metadata and agent-peers registry entries, communicates over local sockets, and keeps no transcript archive. Agent replies may themselves invoke the model providers configured in those agents.

## Update and remove

Use Hermes's native plugin manager to update or remove the plugin. For an explicitly pinned release, reinstall with the new release ref after reviewing its compatibility notes. The legacy Python installer is a compatibility helper; native installation is the supported path.

The optional generic Hermes host extension is separate from this package. It adds conversation-route capabilities for any plugin; peer discovery and messaging remain entirely here.
