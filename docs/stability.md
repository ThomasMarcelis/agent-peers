# Stability

From 1.0.0, agent-peers follows [semantic versioning](https://semver.org) for the surfaces listed here. A breaking change to any of them requires a new major version. New commands, fields, statuses and reason codes are minor changes, so consumers should ignore what they do not recognise.

## Covered

- **CLI:** command names (`list`, `whoami`, `claim`, `release`, `resolve`, `doctor`, `logs`, `hermes-bridge`, plus the `codex-peer` binary), flags, exit codes (`0` success, `1` runtime or diagnostic failure or a refused claim, `2` invalid usage), the `--json` schemas of `list` (`peers[]` and `names[]`), `whoami`, `claim`, `release`, `resolve` and `doctor`, and the single `uds:` line `resolve` prints. For `logs --json`, only the top-level summary.
- **Codex MCP server:** the server name `agent-peers`, the tool names `list_peers`, `send_peer`, `claim_name` and `release_name`, their input schemas, their `structuredContent` schemas (`peers[]`, `self`, `names[]`, the send result and the claim result), the rule for `isError`, and the delivery status, claim status and reason vocabularies.
- **Hermes plugin:** tool names, input schemas and JSON results, and the plugin setting `bridge_command`.
- **Wire format emitted and read by agent-peers:** the message-line fields, the `agent_peers` v1 extension (including `to_name`), the receipt format, the `name_resolved` control line, and the peer-frame element and attribute names (`peer_message`, `from`, `reply_to`, `reply_name`, `id`, `in_reply_to`).
- **Registry:** its location, file permissions, and the record fields `name`, `address`, `addresses`, `cwd`, `threadId`, `pid`, `procStart`, `generation` and `startedAt`.
- **Addressing:** the `uds:` address encoding; the automatic `<kind>:<label>` names, and that names containing `/` are reserved for claimed names; and `generation` as an opaque string compared only for equality.
- **Environment variables** listed in the [reference](reference.md#environment).

## Not covered

- Human-readable text: tool result `text`, frame wording and footers, CLI table layout and messages. Parse the JSON or `structuredContent` fields instead.
- Timings and limits, such as receipt windows, retry schedules, rate limits, queue sizes and size bounds. They may change in a minor release to keep the transport safe.
- Diagnostic log event names and fields.
- Socket filenames and directory choices, apart from the `uds:` encoding.
- Internal module layout, and the JSON-lines protocols between the Hermes plugin and its bridge subprocess, and between the opencode plugin and its bridge subprocess. Each pair ships together in one package version.
- The protocols of the hosts agent-peers connects to. Claude Code's inbox protocol is undocumented, the Codex app-server protocol changes between releases, and Hermes sending needs the documented host fork. Only the builds in [compatibility](compatibility.md#tested-agent-builds) are supported; a host upgrade can break interoperation without any agent-peers change.

## Experimental

Experimental features are labelled as such in the reference and changelog, and may change in a minor release. Each change is listed in the changelog.

- **Hermes support:** its plugin surface follows this policy, but compatibility depends on the host fork.
- **opencode support:** the opencode plugin, its four tools, the bridge protocol, `opencode:` names, opencode registry rows, and the read-only `doctor` checks. Experimental; may change in a minor release. Covered surfaces listed above stay backward compatible.
- **Claimed names** (`<kind>:<scope>/<claim>`): the `claim`, `release` and `resolve` commands and their `--json` output, the `claim_name` and `release_name` tools, the `names[]`, `claims` and `reply_name` fields, the `agent_peers.to_name` extension, the `name_resolved` control line and its `name_resolved_status` answer, and the `names/` directory under the registry. The rules a later version must keep are the safety ones: a name never reaches anyone but its current holder, a running holder is never displaced, a Hermes name stays inside its profile, and a Hermes conversation admits a first message only from senders that used its name or that it contacted. Claimed names are new in 1.0 and are expected to settle with use; a minor release may change their commands, fields or storage.
- **Script sends:** the `agent-peers send` command, its flags and `--json` output, its `outcome` values and exit codes 3–5, the footer text and the `script:` from-name.

Sessions that do not claim names use only covered surfaces.

## Deprecation

A covered surface that will be removed in the next major version stays functional and is marked deprecated in the changelog for at least one minor release first.
