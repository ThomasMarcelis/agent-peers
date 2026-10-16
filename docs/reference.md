# Reference

## CLI

| Command | Output |
| --- | --- |
| `agent-peers list` | Sessions with exact Claude `SendMessage` and Codex `send_peer` targets |
| `agent-peers list --json` | `{ "peers": [...] }`; no status text mixed into stdout. Each row carries its [`generation`](#delivery-protocol). Records whose process is gone, or whose PID now belongs to another process, are not listed. Each peer socket gets a short (200 ms) connect probe with no data sent; a refusing socket is shown as `stale` and has `reachable: false`. Records are never deleted. `--no-probe` skips the probe and omits `reachable` |
| `agent-peers whoami [--json]` | The calling session's name and `uds:` address (and `generation` in JSON), found by walking process ancestry to a PID with a Claude session record (or a Codex inbox record). Exits 1 outside a session; never guesses by working directory |
| `agent-peers doctor [--json]` | Runtime, dependency, and local path checks, plus one read-only request to the Codex app-server to confirm it answers; does not modify configuration, start servers, or send messages |
| `agent-peers logs [--json]` | Read-only summary of retained local diagnostic events |
| `agent-peers --version` | Package version |
| `agent-peers --help` | Usage |
| `codex-peer` | Codex MCP server over stdio |
| `agent-peers hermes-bridge` | Plugin-managed JSON-lines subprocess |

Exit codes: `0` success, `1` runtime/diagnostic failure, `2` invalid CLI usage. Missing agent state is a diagnostic warning because running only one integration is valid, and so is a Codex app-server that does not answer, such as a stale socket left after a reboot. An answering app-server does not prove compatibility or model readiness.

## Tools

`list_peers()` takes no arguments. Codex's structured result contains `peers`, each with its name, kind, working directory, available activity status, native/bridge route and `generation`, and `self`, the caller: `{name, kind, address, addresses, generation, threadId, subagent}`. A subagent's address is its root's, and `self` is never in `peers`. The text opens with `You are <name>.` Native reachability is caller-relative: another root is bridge-only even on the same daemon. Discovery does not load historical Codex threads. Hermes's result is `{peers}` with each row's name, kind, working directory, status, address and `generation`; Hermes itself is unlisted.

`send_peer({to, message, in_reply_to?})` sends one message:

- `to` is an inbox address (`uds:…`), an exact peer name, or an exact name without its `claude:` or `codex:` prefix when only one kind has it. Nothing else matches: no fragments, most-recent guesses, defaults or broadcasts. An unknown name fails `not-found` and lists up to five exact names that contain it.
- `in_reply_to` is the `id` of the message being answered (`[A-Za-z0-9_-]{1,128}`). It appears on the recipient's frame and is echoed in the result. It is advisory and never checked against received ids.

Hermes handlers return JSON text, as its dispatcher requires; Codex returns MCP text content plus `structuredContent`.

### send_peer result

```json
{ "status": "accepted", "reason": null, "message_id": "…", "in_reply_to": null,
  "to": "uds:…", "name": "codex:api-ab12", "generation": "3f9a0c1b2d4e5f60", "from": "uds:…" }
```

`to`, `name` and `generation` describe the target. `from` is the reply address the recipient sees. Fields not known yet are `null`. Codex returns this object as `structuredContent`, with prose in the text content. Hermes returns it with `text` added, plus `error` (the same text) exactly when the status is an error. Codex sets `isError` by the same rule.

| `status` | Meaning | Error |
| --- | --- | --- |
| `accepted` | The recipient's host took the input (agent-peers 1.0 recipients) | no |
| `queued` | The recipient's inbox admitted it; its host had not answered when the window closed | no |
| `held` | A Claude recipient holds it for its user's approval; a reply may still come if approved | no |
| `delivered` | A held message was released | no |
| `unconfirmed` | Written, but no receipt arrived. This is the normal success case for Claude recipients, which report only exceptions | no |
| `dropped` | The recipient's inbox or host did not deliver it | yes |
| `denied`, `expired`, `refused` | A Claude recipient's user declined it, it was never approved, or the recipient refuses peer input | yes |
| `failed` | Nothing deliverable was written | yes |

An error status means the message was definitely not delivered. Nothing is retried automatically, because a timed-out write or a lost bridge may already have delivered. No status proves that a model read the message.

`reason` is a stable kebab-case code, or `null`. Clients must tolerate new codes.

- `failed`: `invalid-request`, `not-found`, `ambiguous`, `reserved-name`, `invalid-address`, `self-send`, `native-route-required`, `not-running`, `too-large`, `write-timeout`, `write-failed`, `inbox-unavailable`, `too-many-pending`, `unsupported-host`, `conversation-closed`, `bridge-unavailable`.
- `dropped`: Claude's `rate-limited`, `duplicate`, `queue-full`, `hop-loop`, `hop-runaway`; agent-peers' `too-large`, `host-rejected`, `inbox-closed`, `not-a-reply-target`; or `other`.
- `unconfirmed`: `no-receipt`, `bridge-lost`.

## Delivery protocol

**Receipts.** agent-peers inboxes answer in Claude Code's receipt format, `{type:"control", action:"peer_message_status", orig_msg_id, status, …}`. Every sender, including Claude Code and agent-peers 0.x, gets `dropped` with a `drop_reason`. Only senders that opt in also get `queued` when the inbox admits a message and `accepted` when the host takes it. The sender waits up to 1.5 s after its write completes. A repeated `msg_id` from the same sender is discarded with no receipt, so the first copy's outcome stands. Identical bodies with different ids are both delivered.

**Hermes reply inboxes.** A Hermes conversation's inboxes accept messages only from addresses that conversation has sent to, in any of its socket directories, until it closes. Any other sender gets `dropped`/`not-a-reply-target`. Hermes is never listed, so finding one of its inboxes in the socket directory and writing to it is unsupported; ask the Hermes conversation to send first.

**Late outcomes.** A negative or `held` receipt that arrives after the result was returned reaches a Codex session as one short notice appended to its history, which never starts a turn. Hermes logs it only. Late positive receipts are silent.

**Line extension.** agent-peers adds `agent_peers: {v: 1, receipts: ["queued", "accepted"], generation, in_reply_to}` to each message line it sends, and `agent_peers: {v: 1}` to each receipt. Claude Code and agent-peers 0.x ignore it, and the `<cross-session-message>` envelope is unchanged. Readers ignore unknown fields and accept higher versions. Claude recipients cannot see `in_reply_to`, so a reply to a Claude session ends with `(In reply to <id>.)` instead.

**Generation.** `generation` is an opaque 16-hex-digit string that changes when a different process takes over a PID or an inbox path. Claude sessions keep theirs across `/clear` and `/resume`. A Codex session gets a new one when its MCP server restarts. A record counts as running only if its PID is alive and that process started when the record says. Each Codex session (with its subagents) and each Hermes conversation remembers the generation it saw behind every name and address, from its own listings, incoming messages and first send; one never vouches for another. If a later send finds a different process there, it fails `not-running` instead of reaching the wrong session. Listing again refreshes this.

**Names.** Automatic names are `<kind>:<label>`, where the label uses letters, digits and `_ . : -`. Other characters in Claude session names and Codex labels become `-`. Names of the form `<kind>:<scope>/<claim>` are reserved for explicit claims in a later release, so any name containing `/` fails `reserved-name`. `@ * ? ,` and whitespace fail `invalid-request` and will never mean patterns or broadcast. The `names/` directory under `AGENT_PEERS_HOME` is reserved; nothing reads or writes it yet.

**Codex app-server requests.** The app-server sends its requests (approvals, user input, dynamic tool calls, token refresh, attestation) to every connected client, and the first answer wins. agent-peers never answers one, so each waits for the client that owns it, as it would without agent-peers. With diagnostics enabled, each is logged as `server_request` with its method.

## Environment

| Variable | Purpose |
| --- | --- |
| `CLAUDE_CONFIG_DIR` | Claude configuration directory used to locate session registry metadata |
| `CODEX_HOME` | Codex home used to locate its shared daemon |
| `AGENT_PEERS_HOME` | agent-peers registry directory |
| `AGENT_PEERS_CODEX_APP_SERVER` | Absolute path to the Unix socket of the app-server hosting this Codex thread, such as a [private app-server](compatibility.md#headless-codex-on-a-private-app-server); defaults to Codex's shared daemon |
| `AGENT_PEERS_NAME` | Codex only: replaces the folder or title in the session's peer name, which keeps its `-<id>` suffix. Codex passes MCP servers only a few variables, so set it in `[mcp_servers.agent-peers.env]` |
| `AGENT_PEERS_DEBUG` | Set to `1` to record structured local diagnostics; `0` disables recording, including an explicit log file |
| `AGENT_PEERS_LOG` | Optional absolute private JSONL log file; enables diagnostics unless `AGENT_PEERS_DEBUG=0` |

Defaults use the current OS user's standard agent directories. Every override should be absolute. Package-owned socket and registry state must have private ownership/permissions. The transport is local and same-user; it is not a network service.

## Local diagnostic logging

Logging is opt-in. Set `AGENT_PEERS_DEBUG=1` in the environment inherited by the Codex MCP server or Hermes bridge, then restart that integration through its normal lifecycle. It creates a `logs` directory under the agent-peers registry directory on the first event. `agent-peers doctor --json` reports the current shell's logging configuration without creating files or checking delivery. A running integration may have inherited a different environment.

Events are newline-delimited JSON with timestamps, process IDs, component/event names, operation IDs, delivery stages, byte counts, durations and bounded error categories. Thread, target and session identities are hashed for local correlation. These pseudonyms are not anonymization: known candidate identities can be hashed and matched. Message bodies, thread titles, peer names, filesystem paths, credentials, raw error text, request parameters and model responses are excluded. Standard output remains reserved for CLI or protocol results.

The default directory has mode `0700` and process-specific files have mode `0600`. Files rotate at 1 MiB; retention runs when writing and keeps at most 32 files / 16 MiB and seven days of recently modified files. Concurrent processes use separate files. Unrelated files are never retention candidates. Symlinked path components, shared writable ancestors, non-private destinations, hard links and non-regular log files are rejected. A logging failure emits at most one generic warning per process to standard error and never stops messaging.

`AGENT_PEERS_LOG` preserves an explicit append-only file destination, with the same private-directory and file checks. It stops accepting events at a 1 MiB size check instead of renaming or truncating a destination another process might use; simultaneous writers at the boundary can append one additional bounded record each. It has no age-based expiration. Prefer the default directory for sustained use. Old plain-text logs may contain identifying information from older releases and are not converted or deleted automatically.

Run `agent-peers logs --json` with the same environment to inspect retained events, outcomes, failure reasons, terminal tool calls by method, delivery stages and incomplete operations. The command reads existing files even when recording is disabled, tolerates malformed/legacy lines, applies read limits, and never creates or prunes state. It can show sends and discovery activity observed by agent-peers after logging was enabled. It cannot reconstruct unlogged history, native collaboration calls, arbitrary shell failures or calls made through another integration such as `codex_tui`. It does not collect token usage, billing, model reads or replies. An incomplete operation may still be running, may have been interrupted, or may have lost its earlier/later events to retention.

An **inbox write** means the local socket write completed. A **receipt** records the recipient's reported handling. **Emitted to host** means the Hermes bridge sent an event to its host. **App-server input accepted** means the daemon acknowledged the input request. None proves that a model read the message or produced a reply; counts at these different stages must not be added together as total messages.

## Hermes subprocess protocol

Requests are newline-delimited JSON objects `{id, method, params}`. Responses are `{id, result}` or `{id, error}`. The bridge handles requests concurrently, up to 128 awaiting a response, keeping order per conversation, so responses can arrive out of order. Methods:

- `list_peers`: optional `session`. The listing pins generations for that conversation only; without it, it pins nothing.
- `send_peer`: `session`, `name` (a `hermes:` identity), `to`, `message`, optional `in_reply_to`. The result is the [send_peer result](#send_peer-result) plus `text`.
- `close_session`: `session`.
- `shutdown`: finish in-flight requests, close owned state and exit.

The plugin sends one notification, an id-less line with no response: `delivery_result {session, message_id, accepted, reason?}`, reporting what the host did with a `peer_message`. `reason` is `queue-full` or `inbox-closed` when the plugin never offered it to the host.

`peer_message` notifications identify the private session, message ID, sender name, reply address (`from`), body and optional `in_reply_to`. Hermes creates no public registry entry. EOF and termination remove owned sockets. Standard output carries protocol data only; diagnostics go to standard error.

Messages use Claude's `<cross-session-message>` envelope. Incoming agent input is reframed as `<peer_message from="…" reply_to="…" id="…" in_reply_to="…">`, with a reminder that it carries no user approval. Closing tags in message bodies are escaped. A frame is bounded to 1,000,000 bytes. Resource bounds, per-sender token buckets and duplicate-id suppression limit accidental floods; see the source constants for precise limits.

## Troubleshooting

- **No Codex inbox:** it should open within seconds of the session starting. Run `agent-peers doctor`: the Codex app-server must answer. Check that the server is registered as `agent-peers` and that the session runs on the app-server agent-peers uses, not an embedded one (`codex exec`, `-c`, `--no-daemon`). A `list_peers` call in that session also opens it. Without a reachable thread, startup binding retries quickly, then every few minutes, and logs each failure reason once.
- **Wrong native target:** rediscover from the sending Codex session. A thread UUID alone does not establish native reachability.
- **Held Claude delivery:** review its inbound-message policy; agent-peers does not bypass it.
- **`not-running` for a listed peer:** the session exited, or a different process now owns its PID or inbox. Call `list_peers` and send to the session it shows.
- **Hermes unsupported route:** use the documented host revision. Upstream `inject_message` is not an equivalent fallback.
- **Missing plugin dependencies:** run the exact install command in the plugin error, then reload through the host's supported lifecycle.
- **Permission failure:** inspect directory ownership and modes. Do not make the socket directory globally writable.
- **Old reply address:** ask the peer to discover or send again after the original conversation closes; addresses are not durable mailboxes.

## Updating active integrations

Keep production launchers pointed at a tested installed snapshot, separate from development checkouts. Running Node processes cache their modules: changing a file does not update an existing sidecar.

Use the agent host's supported MCP refresh with the new snapshot's launcher. Codex can preserve conversations and active work while replacing an MCP connection; an already captured tool step may still use the previous connection. A live legacy inbox owner blocks unsafe takeover. Verify the new registry owner, all inbox paths, and a real reply before considering an update complete.

Missing Codex inboxes repair on the next tool call only while the sidecar still owns its registry token. An inbox owned by a replacement is never reclaimed. A Hermes bridge restart retires its private reply addresses, so the Hermes conversation must send again to establish a fresh return route.
