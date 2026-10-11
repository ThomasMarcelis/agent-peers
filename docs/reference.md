# Reference

## CLI

| Command | Output |
| --- | --- |
| `agent-peers list` | Sessions with exact Claude `SendMessage` and Codex `send_peer` targets |
| `agent-peers list --json` | `{ "peers": [...] }`; no status text mixed into stdout |
| `agent-peers doctor [--json]` | Runtime, dependency, and local path checks; does not modify configuration or send messages |
| `agent-peers logs [--json]` | Read-only summary of retained local diagnostic events |
| `agent-peers --version` | Package version |
| `agent-peers --help` | Usage |
| `codex-peer` | Codex MCP server over stdio |
| `agent-peers hermes-bridge` | Plugin-managed JSON-lines subprocess |

Exit codes: `0` success, `1` runtime/diagnostic failure, `2` invalid CLI usage. Missing agent state is a diagnostic warning because running only one integration is valid. A present socket does not prove compatibility or model readiness.

## Tools

`list_peers()` takes no arguments. Codex's structured result contains `peers`, each with its name, kind, working directory, available activity status, and native/bridge route. Native reachability is caller-relative: another root is bridge-only even on the same daemon. Discovery does not load historical Codex threads.

`send_peer({to, message})` accepts an exact peer name, unambiguous abbreviated name, or a valid inbox address. Prefer returned exact targets. Empty messages, ambiguous targets, self-sends, and invalid addresses fail clearly. Hermes host handlers return JSON text as required by its dispatcher; Codex uses MCP text content and error results.

A successful socket write confirms only inbox acceptance. Claude delivery receipts can report held/rejected input; not every recipient sends a receipt. No receipt is not proof of model consumption. Timed-out delivery is not automatically retried because it may already have arrived.

## Environment

| Variable | Purpose |
| --- | --- |
| `CLAUDE_CONFIG_DIR` | Claude configuration directory used to locate session registry metadata |
| `CODEX_HOME` | Codex home used to locate its shared daemon |
| `AGENT_PEERS_HOME` | agent-peers registry directory |
| `AGENT_PEERS_CODEX_APP_SERVER` | Explicit absolute path to an app-server Unix socket |
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

Requests are newline-delimited JSON objects `{id, method, params}`. Responses are `{id, result}` or `{id, error}`. Methods:

- `list_peers`: no parameters.
- `send_peer`: `session`, `name` (a `hermes:` identity), `to`, `message`.
- `close_session`: `session`.
- `shutdown`: close owned state and exit.

`peer_message` notifications identify the private session, message ID, sender, reply address, and body. Hermes creates no public registry entry. EOF and termination remove owned sockets. Standard output carries protocol data only; diagnostics go to standard error.

Messages use Claude's `<cross-session-message>` envelope. Incoming agent input is reframed with sender identity, a reply address, and a reminder that it carries no user approval. Closing tags in message bodies are escaped. A frame is bounded to 1,000,000 bytes. Resource bounds, token buckets, and duplicate suppression limit accidental floods; see the source constants for precise limits.

## Troubleshooting

- **No Codex inbox:** it should open within seconds of the session starting. Check that the server is registered as `agent-peers` and the session uses the shared daemon; a `list_peers` call in that session also opens it.
- **Wrong native target:** rediscover from the sending Codex session. A thread UUID alone does not establish native reachability.
- **Held Claude delivery:** review its inbound-message policy; agent-peers does not bypass it.
- **Hermes unsupported route:** use the documented host revision. Upstream `inject_message` is not an equivalent fallback.
- **Missing plugin dependencies:** run the exact install command in the plugin error, then reload through the host's supported lifecycle.
- **Permission failure:** inspect directory ownership and modes. Do not make the socket directory globally writable.
- **Old reply address:** ask the peer to discover or send again after the original conversation closes; addresses are not durable mailboxes.

## Updating active integrations

Keep production launchers pointed at a tested installed snapshot, separate from development checkouts. Running Node processes cache their modules: changing a file does not update an existing sidecar.

Use the agent host's supported MCP refresh with the new snapshot's launcher. Codex can preserve conversations and active work while replacing an MCP connection; an already captured tool step may still use the previous connection. A live legacy inbox owner blocks unsafe takeover. Verify the new registry owner, all inbox paths, and a real reply before considering an update complete.

Missing Codex inboxes repair on the next tool call only while the sidecar still owns its registry token. An inbox owned by a replacement is never reclaimed. A Hermes bridge restart retires its private reply addresses, so the Hermes conversation must send again to establish a fresh return route.
