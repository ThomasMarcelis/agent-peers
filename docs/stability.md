# Stability

From 1.0.0, agent-peers follows [semantic versioning](https://semver.org) for the surfaces listed here. A breaking change to any of them requires a new major version. New commands, fields, statuses and reason codes are minor changes, so consumers should ignore what they do not recognise.

## Covered

- **CLI:** command names (`list`, `whoami`, `claim`, `release`, `resolve`, `doctor`, `logs`, `hermes-bridge`, plus the `codex-peer` binary), flags, exit codes (`0` success, `1` runtime or diagnostic failure or a refused claim, `2` invalid usage), the `--json` schemas of `list` (`peers[]` and `names[]`), `whoami`, `claim`, `release`, `resolve` and `doctor`, and the single `uds:` line `resolve` prints. For `logs --json`, only the top-level summary.
- **Codex MCP server:** the server name `agent-peers`, the tool names `list_peers`, `send_peer`, `claim_name` and `release_name`, their input schemas, their `structuredContent` schemas (`peers[]`, `self`, `names[]`, the send result and the claim result), the rule for `isError`, and the delivery status, claim status and reason vocabularies.
- **Hermes plugin:** tool names, input schemas and JSON results, and the plugin setting `bridge_command`.
- **Wire format emitted and read by agent-peers:** the message-line fields, the `agent_peers` v1 extension (including `to_name`), the receipt format, the `name_resolved` control line, and the peer-frame element and attribute names (`peer_message`, `from`, `reply_to`, `reply_name`, `id`, `in_reply_to`).
- **Registry:** its location, file permissions, and the record fields `name`, `address`, `addresses`, `cwd`, `threadId`, `pid`, `procStart`, `generation` and `startedAt`.
- **Claimed names:** the `names/` directory under the registry, its file naming and permissions, and the record fields `v`, `name`, `kind`, `owner`, `generation`, `claimedAt` and `holder` (`pid`, `procStart`, `autoName`, `socket`, `threadId`, `addresses`); the rules for who may claim, refresh, take over and release a name; and the rule that a Hermes conversation admits a first message only from senders that used its name.
- **Addressing:** the `uds:` address encoding; the name grammar, automatic `<kind>:<label>` and claimed `<kind>:<scope>/<claim>`; and `generation` as an opaque string compared only for equality.
- **Environment variables** listed in the [reference](reference.md#environment).

## Not covered

- Human-readable text: tool result `text`, frame wording and footers, CLI table layout and messages. Parse the JSON or `structuredContent` fields instead.
- Timings and limits, such as receipt windows, retry schedules, rate limits, queue sizes and size bounds. They may change in a minor release to keep the transport safe.
- Diagnostic log event names and fields.
- Socket filenames and directory choices, apart from the `uds:` encoding.
- Internal module layout, and the JSON-lines protocol between the Hermes plugin and its bridge subprocess. Both ship together in one package version.
- The protocols of the hosts agent-peers connects to. Claude Code's inbox protocol is undocumented, the Codex app-server protocol changes between releases, and Hermes sending needs the documented host fork. Only the builds in [compatibility](compatibility.md#tested-agent-builds) are supported; a host upgrade can break interoperation without any agent-peers change.

## Experimental

Hermes support remains experimental in 1.x: its plugin surface follows this policy, but compatibility depends on the host fork. Experimental features are labelled as such in the reference and changelog, and may change in a minor release.

## Deprecation

A covered surface that will be removed in the next major version stays functional and is marked deprecated in the changelog for at least one minor release first.
