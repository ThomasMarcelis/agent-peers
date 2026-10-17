# Reference

## CLI

| Command | Output |
| --- | --- |
| `agent-peers list` | Sessions with exact Claude `SendMessage` and Codex `send_peer` targets, then [claimed names](#names) |
| `agent-peers list --json` | `{ "peers": [...], "names": [...] }`; no status text mixed into stdout. Each peer row carries its [`generation`](#delivery-protocol) and `claims`, the names it holds. Records whose process is gone, or whose PID now belongs to another process, are not listed. Each peer socket gets a short (200 ms) connect probe with no data sent; a refusing socket is shown as `stale` and has `reachable: false`. Records are never deleted. `--no-probe` skips the probe and omits `reachable`. `names` lists every claimed name, running or not (see [names](#names)) |
| `agent-peers whoami [--json]` | The calling session's name and `uds:` address (and `generation` and `claims` in JSON), found by walking process ancestry to a PID with a Claude session record (or a Codex inbox record). Exits 1 outside a session; never guesses by working directory |
| `agent-peers claim <name> [--json]` | Claims `claude:<scope>/<claim>` (or `<scope>/<claim>`) for the calling Claude session, found by ancestry like `whoami` but Claude only. Prints the [claim result](#claim-and-release-results). Exits 1 when refused, including `no-session` outside a Claude session, and 2 for a name outside the grammar |
| `agent-peers release <name> [--json]` | Removes a name this session holds, or any name whose holder is not running (also outside a session). Exits 1 when refused |
| `agent-peers resolve <target> [--json]` | Prints exactly one `uds:` line for a claimed name, an exact peer name or an address: the holder's inbox in the calling Claude session's socket directory when it has one, else its primary inbox. JSON: `{status: "resolved", reason: null, name, kind, address, generation, text}`, or `{status: "failed", reason, text}`. Exits 1 for `not-found`, `not-running`, `ambiguous` or `inbox-unavailable`, and 2 for invalid usage or grammar. For a name a Hermes conversation holds, it also tells that conversation which Claude session is about to send ([names](#names)) |
| `agent-peers doctor [--json]` | Runtime, dependency, and local path checks, plus one read-only request to the Codex app-server to confirm it answers; does not modify configuration, start servers, or send messages |
| `agent-peers logs [--json]` | Read-only summary of retained local diagnostic events |
| `agent-peers --version` | Package version |
| `agent-peers --help` | Usage |
| `codex-peer` | Codex MCP server over stdio |
| `agent-peers hermes-bridge` | Plugin-managed JSON-lines subprocess |

Exit codes: `0` success, `1` runtime/diagnostic failure, `2` invalid CLI usage. Missing agent state is a diagnostic warning because running only one integration is valid, and so is a Codex app-server that does not answer, such as a stale socket left after a reboot. An answering app-server does not prove compatibility or model readiness.

## Tools

`list_peers()` takes no arguments. Codex's structured result contains `peers`, each with its name, kind, working directory, available activity status, native/bridge route, `generation` and `claims`; `self`, the caller: `{name, kind, address, addresses, generation, threadId, subagent, claims}`; and `names`, every [claimed name](#names). A subagent's address and claims are its root's, and `self` is never in `peers`. The text opens with `You are <name>.` Native reachability is caller-relative: another root is bridge-only even on the same daemon. Discovery does not load historical Codex threads. Hermes's result is `{peers, names}` with each peer row's name, kind, working directory, status, address, `generation` and `claims`; a Hermes conversation appears only through a name it claimed.

`send_peer({to, message, in_reply_to?})` sends one message:

- `to` is an inbox address (`uds:…`), a [claimed name](#names), an exact peer name, or an exact name without its kind prefix when only one kind has it. Nothing else matches: no fragments, most-recent guesses, defaults or broadcasts. An unknown name fails `not-found` and lists up to five exact names that contain it.
- `in_reply_to` is the `id` of the message being answered (`[A-Za-z0-9_-]{1,128}`); an empty string means none. It appears on the recipient's frame and is echoed in the result. It is advisory and never checked against received ids.

`claim_name({name})` claims a [stable name](#names) for the calling session, and `release_name({name})` removes one. Codex takes `codex:<scope>/<claim>` or `<scope>/<claim>`; a subagent gets `no-session`, because it sends under its root. Hermes takes `<claim>`, `<scope>/<claim>` or `hermes:<scope>/<claim>`, where the scope must be the conversation's own profile id; it needs a live conversation route, as `send_peer` does, and otherwise gets `no-session`. Both return the [claim result](#claim-and-release-results); Codex sets `isError` when it is `refused`, and Hermes adds `error`.

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

- `failed`: `invalid-request`, `not-found`, `ambiguous`, `invalid-address`, `self-send`, `native-route-required`, `not-running`, `too-large`, `write-timeout`, `write-failed`, `inbox-unavailable`, `too-many-pending`, `unsupported-host`, `conversation-closed`, `bridge-unavailable`.
- `dropped`: Claude's `rate-limited`, `duplicate`, `queue-full`, `hop-loop`, `hop-runaway`; agent-peers' `too-large`, `host-rejected`, `inbox-closed`, `not-a-reply-target`; or `other`.
- `unconfirmed`: `no-receipt`, `bridge-lost`.

For a claimed name, `name` is the claimed name and `generation` its current holder's. When the holder is a different session than at this sender's previous send to that name, the send still goes through and the text says so.

### Claim and release results

```json
{ "status": "taken-over", "reason": null, "name": "hermes:gaming/relay", "kind": "hermes", "generation": "…", "address": "uds:…",
  "previous": { "holder": "hermes:gaming:ab12cd34", "generation": "…", "running": false }, "text": "…" }
```

`agent-peers claim` and `release`, and the `claim_name` and `release_name` tools, return this object. `generation` and `address` describe the name's holder after the call: the claimant after a successful claim, `null` after a release or a refusal. `previous` describes the record that was there (its holder's automatic name, its generation and whether that holder was running), or is `null`.

| `status` | Meaning |
| --- | --- |
| `claimed` | The name was free; this session holds it now |
| `refreshed` | This session, or an earlier process of the same claimant (a restarted Codex MCP server, a Hermes conversation after a gateway restart), already held it; it now names this process |
| `taken-over` | Another claimant held it but is not running; this session holds it now, and `previous` names the old holder |
| `released` | The record was removed |
| `refused` | Nothing changed; `reason` says why |

Refusal reasons: `invalid-request` (outside the grammar), `name-held` (a running holder keeps its name; only it can release it), `not-holder` (a release of a running holder's name), `not-found` (a release of a name nobody claimed), `scope-denied` (another kind, or for Hermes another profile), `no-session` (no calling session: outside Claude for the CLI, a Codex subagent or replaced MCP process, a Hermes conversation without a route), `too-many-names` (8 per claimant), `conflict` (the record changed while this call ran; try again), `inbox-unavailable` (a Hermes conversation could not open its inboxes), `unsupported-host` (a Claude Code build whose session registry records no process start time; see [claiming](#names)) and `bridge-unavailable`.

## Delivery protocol

**Receipts.** agent-peers inboxes answer in Claude Code's receipt format, `{type:"control", action:"peer_message_status", orig_msg_id, status, …}`. Every sender, including Claude Code and agent-peers 0.x, gets `dropped` with a `drop_reason`. Only senders that opt in also get `queued` when the inbox admits a message and `accepted` when the host takes it. The sender waits up to 1.5 s after its write completes and counts a receipt only if its `from` is the inbox it wrote to. That check is not authentication: like names and addresses, receipts are unauthenticated between processes of the same user ([security](../SECURITY.md)). A repeated `msg_id` from the same sender is discarded with no receipt, so the first copy's outcome stands. Identical bodies with different ids are both delivered.

**Hermes reply inboxes.** A Hermes conversation's inboxes accept messages only from its reply targets: the addresses that conversation has sent to, in any of its socket directories, and the senders that addressed it by a name it holds (see [names and the reply-target allowlist](#names-and-the-reply-target-allowlist)). Both last until it closes, up to the latest 256 peers it sent to and, kept apart, the latest 64 senders by name. Any other sender gets `dropped`/`not-a-reply-target`. An unclaimed Hermes conversation is never listed, so finding one of its inboxes in the socket directory and writing to it is unsupported; ask the Hermes conversation to send first, or to claim a name.

**Late outcomes.** A negative or `held` receipt that arrives after the result was returned reaches a Codex session as one short notice appended to its history, which never starts a turn. Hermes logs it only. Late positive receipts are silent.

**Line extension.** agent-peers adds `agent_peers: {v: 1, receipts: ["queued", "accepted"], generation, in_reply_to, to_name}` to each message line it sends, and `agent_peers: {v: 1}` to each receipt. `to_name` is present only when `to` was a claimed name, and is that name. Claude Code and agent-peers 0.x ignore it, and the `<cross-session-message>` envelope is unchanged. Readers ignore unknown fields and accept higher versions. Claude recipients cannot see `in_reply_to`, so a reply to a Claude session ends with `(In reply to <id>.)` instead.

**Generation.** `generation` is an opaque 16-hex-digit string that changes when a different process takes over a PID or an inbox path. Claude sessions keep theirs across `/clear` and `/resume`. A Codex session gets a new one when its MCP server restarts. A record counts as running only if its PID is alive and that process started when the record says. Each Codex session (with its subagents) and each Hermes conversation remembers the generation it saw behind every name and address, from its own listings, incoming messages and first send; one never vouches for another. If a later send finds a different process there, it fails `not-running` instead of reaching the wrong session. Listing again refreshes this.

**Automatic names.** Automatic names are `<kind>:<label>`, where the label uses letters, digits and `_ . : -`. Other characters in Claude session names and Codex labels become `-`, so an automatic name never contains `/` and can never collide with a [claimed name](#names). `@ * ? ,` and whitespace fail `invalid-request` and will never mean patterns or broadcast.

**Codex app-server requests.** The app-server sends its requests (approvals, user input, dynamic tool calls, token refresh, attestation) to every connected client, and the first answer wins. agent-peers never answers one, so each waits for the client that owns it, as it would without agent-peers. With diagnostics enabled, each is logged as `server_request` with its method.

## Names

Claimed names are [experimental](stability.md#experimental) in 1.x: their commands, fields and storage may change in a minor release.

A session or conversation can claim a stable name, so that peers reach whoever holds the role now instead of an address that dies with a restart. A name is claimed explicitly, scoped, resolved at send time, and never falls back to anyone else.

**Grammar.** `<kind>:<scope>/<claim>` with exactly one `/`: kind `claude`, `codex` or `hermes`; scope `[a-z0-9][a-z0-9_-]{0,63}`; claim `[a-z0-9][a-z0-9_.-]{0,63}`. Matching is exact and case-sensitive; anything else, such as an uppercase letter, a second `/` or a `:` in the scope, is `invalid-request`. For Hermes the scope is the conversation's profile id, enforced by the plugin and by its bridge (`hermes:gaming/relay` in profile `gaming`); for Claude and Codex it is a project namespace the owner chooses, which organizes names and is not a security boundary. The kind-elided form `<scope>/<claim>` resolves only when exactly one kind has a record for it, running or not; otherwise it fails `ambiguous` and lists the full names. Claim commands fill in the caller's own kind.

**Claiming.** Claude runs `agent-peers claim <name>` from the session (its Bash tool); Codex and Hermes call `claim_name`. A session can claim only names of its own kind, at most 8. Who holds a name:

| Kind | Claimant (owner) | Holder is running when |
| --- | --- | --- |
| Claude | the Claude process (PID and start time) | its registry record still has the same PID, start and socket |
| Codex | the root thread | `codex-<threadId>.json` is running with the generation that claimed it |
| Hermes | the profile and Hermes conversation id | the bridge process still runs and every inbox the claim recorded still exists |

A Claude claim needs the session's start time in Claude's session registry, which current Claude Code records. Without it the claimant would be a PID alone, and a later session that reuses the PID and socket path could inherit the name, so such a claim is refused with `unsupported-host`; update Claude Code to claim names.

A claim on a free name is `claimed`. The same claimant refreshes its own name without any flag, also from a new process: a Codex MCP server takes back its thread's names when it binds, and a Hermes conversation takes back its names on its next agent-peers call after a gateway restart (`list_peers`, `send_peer`, `claim_name` or `release_name`). A name whose holder is not running is `taken-over`, and the result names the previous holder. A running holder is always refused with `name-held`; only it can release the name. A Hermes conversation's names also follow it through compression, which changes its conversation id while its route lives.

**Resolution.** A sender resolves a claimed name each time it sends: `send_peer({to: name})` for Codex and Hermes, and `agent-peers resolve <name>` followed by `SendMessage` to the printed address for Claude. No record fails `not-found`; a holder that is not running fails `not-running`, naming the holder and when it claimed the name. Nothing is ever sent to another session instead. A claimed name follows its holder, so a different generation behind it is not a pin failure. Between `resolve` and `SendMessage` the holder can change; a dead socket then fails at Claude.

**Listing.** `list --json` and `list_peers` return `names`: `{name, kind, running, address, addresses, generation, holder, claimedAt}`. Dead names stay listed with `running: false`, `address: null` and `holder: null` until a new claim or a `release` replaces them; they do not expire. `holder` is the running holder's automatic name, `addresses` its current inboxes (`address` the one in the calling Claude session's socket directory for the CLI, else the first), and `claimedAt` the time of the last claim in milliseconds. Peer rows carry `claims`, the names they hold.

**Frames.** A Codex or Hermes recipient adds `reply_name="<name>"` to `<peer_message …>` only when its own lookup finds a running claim held at the sender's address. A name a sender asserts is never shown. The first message from a Codex or Hermes session to a Claude session adds `(Stable name: <name>.)` when the sender holds one.

**Storage.** One file per name, `$AGENT_PEERS_HOME/names/n-<sha256(name)[:32]>.json`, mode `0600`, in a `0700` directory owned by the user, with the registry's rules: never read through a symlink, and dropped when foreign, group- or world-writable, over 64 KiB, or not matching its file name and kind. The record is `{v: 1, name, kind, owner, generation, claimedAt, holder: {pid, procStart, autoName, socket (Claude), threadId (Codex), addresses}}`; `owner` and `generation` are hashes, never raw conversation or route ids. A new name is published with a hard link, which fails if it exists; a running holder refreshing its own record replaces it in one rename; any other replacement or removal renames the file aside and checks it is still the file that was read, else puts it back and reports `conflict`. A file that cannot be read at that moment is refused with `conflict`, and a record with a higher `v` that this version cannot read with `name-held` (claim) or `not-holder` (release); neither is ever replaced or removed. There is no lock or daemon. Exit never removes a record. A claim or release that died midway can leave a `.reap-<uuid>.json` (a record moved aside) or `.t-<uuid>.json` (one never published) file; the next claim or release removes those that are this user's regular files and were last changed more than a minute ago.

**Races.** Concurrent claims of one name end with at most one record, and its holder is the only one any reader resolves. In the worst case, three claims of the same name within microseconds (two takeovers and a new claim), a claim that was reported successful can be lost: senders then reach the record that won, or get `not-found`, until the loser claims again. There are never two holders, and a message never goes to a session that does not hold the name.

### Names and the reply-target allowlist

A Hermes conversation's inboxes accept only its reply targets (#28). A claimed name opts that conversation into unsolicited messages addressed by its name, and only by its name:

- A Codex or Hermes `send_peer` to a claimed name marks the line with `agent_peers.to_name`. The receiving conversation admits the sender when it holds that name, and the sender becomes one of its reply targets. A conversation remembers the latest 64 senders admitted by name, apart from the up to 256 peers it wrote to, so senders by name never push out a peer it is talking to; a forgotten sender is admitted again by its next line that carries the name.
- Claude's `SendMessage` cannot mark a line, so `agent-peers resolve <name>`, run by the sending Claude session, tells the holding conversation which session resolved its name: a `{type: "control", action: "name_resolved", from, name, agent_peers: {v: 1}}` line to the inbox it printed, whose `from` is the calling session's address. The conversation admits that address if it is a live Claude session and the name is one it holds.
- A sender that writes to the same inbox without its name, for example after finding it in the socket directory, still gets `dropped`/`not-a-reply-target`, as does a line marked with a name this conversation does not hold.

Like every agent-peers name and address, this is not authentication: any process of the same user can write the same line ([security](../SECURITY.md)). It stops misrouting, not a malicious local process.

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

Internal: the plugin and its bridge ship together in one package version, so this protocol is not covered by semantic versioning ([stability](stability.md)) and may change in any release.

Requests are newline-delimited JSON objects `{id, method, params}`. Responses are `{id, result}` or `{id, error}`. The bridge handles requests concurrently, up to 128 awaiting a response, keeping order per conversation, so responses can arrive out of order. Methods:

- `list_peers`: optional `session`, with `owner` (the Hermes conversation id) and `identity` (its `hermes:` automatic name). The listing pins generations for that conversation only; without it, it pins nothing. With an owner it first takes back the conversation's names, once per route and owner.
- `send_peer`: `session`, `owner`, `name` (the `hermes:` identity), `to`, `message`, optional `in_reply_to`. The result is the [send_peer result](#send_peer-result) plus `text`.
- `claim_name`, `release_name`: `session`, `owner`, `identity`, `name` (a full claimed name). The result is the [claim result](#claim-and-release-results).
- `close_session`: `session`.
- `shutdown`: finish in-flight requests, close owned state and exit.

The plugin starts the bridge as `agent-peers hermes-bridge --hermes-profile <profile id>`; without that option, or with a profile id outside the scope grammar, the bridge claims no names.

The plugin sends one notification, an id-less line with no response: `delivery_result {session, message_id, accepted, reason?}`, reporting what the host did with a `peer_message`. `reason` is `queue-full` or `inbox-closed` when the plugin never offered it to the host.

`peer_message` notifications identify the private session, message ID, sender name, reply address (`from`), body and optional `in_reply_to`. Hermes creates no public registry entry. EOF and termination remove owned sockets. Standard output carries protocol data only; diagnostics go to standard error.

Messages use Claude's `<cross-session-message>` envelope. Incoming agent input is reframed as `<peer_message from="…" reply_to="…" id="…" in_reply_to="…">`, with a reminder that it carries no user approval. Closing tags in message bodies are escaped. A frame is bounded to 1,000,000 bytes. Resource bounds, per-sender token buckets and duplicate-id suppression limit accidental floods; see the source constants for precise limits.

## Troubleshooting

- **No Codex inbox:** it should open within seconds of the session starting. Run `agent-peers doctor`: the Codex app-server must answer. Check that the server is registered as `agent-peers` and that the session runs on the app-server agent-peers uses, not an embedded one (`codex exec`, `-c`, `--no-daemon`). A `list_peers` call in that session also opens it. Without a reachable thread, startup binding retries quickly, then every few minutes, and logs each failure reason once.
- **Wrong native target:** rediscover from the sending Codex session. A thread UUID alone does not establish native reachability.
- **Held Claude delivery:** review its inbound-message policy; agent-peers does not bypass it.
- **`not-running` for a listed peer:** the session exited, or a different process now owns its PID or inbox. Call `list_peers` and send to the session it shows.
- **`not-running` for a claimed name:** its holder stopped. The session that now has the role must claim the name (a Codex session and a Hermes conversation take back their own names automatically; a restarted Claude session runs `agent-peers claim` again). `not-found` means nobody claimed it.
- **`not-a-reply-target` from a claimed Hermes name:** a Claude sender must run `agent-peers resolve <name>` from its own session just before `SendMessage`, and use the address it prints.
- **Hermes unsupported route:** use the documented host revision. Upstream `inject_message` is not an equivalent fallback.
- **Missing plugin dependencies:** run the exact install command in the plugin error, then reload through the host's supported lifecycle.
- **Permission failure:** inspect directory ownership and modes. Do not make the socket directory globally writable.
- **Old reply address:** ask the peer to discover or send again after the original conversation closes; addresses are not durable mailboxes.

## Updating active integrations

Keep production launchers pointed at a tested installed snapshot, separate from development checkouts. Running Node processes cache their modules: changing a file does not update an existing sidecar.

Use the agent host's supported MCP refresh with the new snapshot's launcher. Codex can preserve conversations and active work while replacing an MCP connection; an already captured tool step may still use the previous connection. A live legacy inbox owner blocks unsafe takeover. Verify the new registry owner, all inbox paths, and a real reply before considering an update complete.

Missing Codex inboxes repair on the next tool call only while the sidecar still owns its registry token. An inbox owned by a replacement is never reclaimed. A Hermes bridge restart retires its private reply addresses, so the Hermes conversation must send again to establish a fresh return route; its claimed names are `not-running` until its next agent-peers call takes them back.
