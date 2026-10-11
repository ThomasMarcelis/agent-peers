# Agent observatory: seeing agent communication

Status: design draft, 2026-10-11. Nothing here is implemented.

## Goal

Tom wants one live view of all agent work on this machine, across Claude Code, Codex and Hermes, including **who is talking to whom**. Usefulness comes first and visuals second. pixtuoid (v0.19.0, MIT, Rust) is the chosen base: it already draws Claude Code, Codex and Hermes sessions as desks, with per-repo outfits, tool activity, waiting state, token use and a sub-agent tree. Its one big gap is communication.

## Non-goals

- No orchestration. The observatory never sends, steers or approves anything.
- No message bodies by default (see Privacy).
- No network service. The design is local, same-user and read-only toward the agents.
- No changes to how agent-peers delivers messages.

## Verified facts (2026-10-11)

- pixtuoid has a strict producer → reducer → renderer pipeline. Agent events use one `(Transport, AgentEvent)` channel, and daemon presence uses a separate sibling channel that bypasses the reducer. `AgentEvent` has no message concept. (`docs/ARCHITECTURE.md`, `crates/pixtuoid-core/src/source/mod.rs`)
- pixtuoid's Hermes source is hook-only and keyed by `session_id`. It ignores Hermes profiles; we connect it with `HERMES_HOME=~/.hermes/profiles/gaming`. Hermes `delegate_task` children are not shown because shell hooks don't carry a child id. (`source/hermes.rs` header)
- Claude Code transcripts record `SendMessage` tool calls with a `to` address. That can be a `uds:` agent-peers inbox, for example a Hermes inbox `uds:/run/user/1000/cc-socks/hermes-<id>.sock`, or a native teammate.
- Codex rollouts record native collaboration as function calls: `spawn_agent` (task name + type), `send_message` / `followup_task` (target name), `wait`, `list_agents` and `interrupt_agent`. **Message bodies are encrypted** (`gAAAAA…`), but targets are plaintext. The rollout also contains `inter_agent_communication_metadata` entries.
- agent-peers debug logging (`AGENT_PEERS_DEBUG=1`) already records `send_peer` start and outcome, with **hashed** thread and target ids. It can't be joined to pixtuoid desks, and it is deliberately unsuitable for that.
- The agent-peers registry (`~/.agent-peers/codex-*.json`) maps a session's name, address, cwd and threadId to its pid. `agent-peers list --json` exposes this mapping.
- Hermes inboxes are private (not in the registry), so a Hermes address can only be resolved by the Hermes process that owns it.

## Design

Two message producers feed one lane in pixtuoid, which renders it.

```
agent-peers sends ──► comms ledger (JSONL) ─┐
                                            ├─► pixtuoid comms lane ─► arrows/couriers + Tab "talks to"
CC/Codex transcripts (native messaging) ────┘           ▲
                          address book (agent-peers list --json + ledger identity rows)
```

### 1. Comms ledger (agent-peers, new)

A separate stream from the diagnostic log, with its own contract.

- Location: `$AGENT_PEERS_HOME/comms/` with the same private-dir rules as `logs/` (`0700`/`0600`, symlinks rejected, rotation and retention reused from `logging.mjs`).
- Enabled by `AGENT_PEERS_COMMS=1`. Off by default, like debug logging.
- One record per line, `schemaVersion: 1`:

```json
{"schemaVersion":1,"kind":"message","time":"…","messageId":"…",
 "from":{"runtime":"codex","session":"<threadId>","address":"uds:…","cwd":"…"},
 "to":{"runtime":"hermes","address":"uds:…","session":null},
 "route":"bridge","stage":"inbox_written","bytes":716,"replyTo":"<messageId|null>"}
```

- `kind: "identity"` rows are written when an inbox is bound (on first send or `list_peers`). Each maps `address → runtime, session id, cwd, pid`. This is how private Hermes inboxes become resolvable without being published in discovery.
- Stages reuse the existing vocabulary (`inbox_written`, `receipt_delivered`, `held`, `rejected`, `failed`). One `messageId` can have several stage rows; consumers keep the latest.
- **Raw session ids, not hashes.** That is the point of the ledger and why it is kept separate from the diagnostics privacy contract. The ledger lives in the same private, same-user directory the agents' own transcripts already occupy, so it reveals nothing new to the local user.
- No bodies. An opt-in `AGENT_PEERS_COMMS_PREVIEW=1` (first 80 chars) is a later decision, not v1.

Emission points: the existing `send_peer` paths in `codex-peer.mjs` and `hermes-bridge.mjs`, plus the receive path, which writes a `received` stage so one-sided failures are visible. The Claude Code side sends through its own `SendMessage`, so it is covered by transcript decoding (§2), not by the ledger.

### 2. Native messaging decode (pixtuoid side)

There is no new transport here. Existing sources learn to recognise messaging tool calls:

- Claude Code: `SendMessage {to}` becomes a message event. If `to` is `uds:…`, it is resolved through the address book; otherwise it's a native teammate name, resolved within the same team/session tree.
- Codex: `send_message` / `followup_task {target}` becomes a message event resolved against the sender's native sub-agent tree. `spawn_agent` stays a sub-agent start (already modelled).
- Dedup: an agent-peers send from Claude Code shows up both in its transcript and, on the receiving side, in the ledger. Pair them by (sender session, address, ±2 s) and let the ledger win, because it carries delivery stage.

### 3. Address book

A pure function owned by the comms lane: `address|native-name → desk AgentId`. Inputs are `agent-peers list --json` (refreshed on change of the registry dir, not polled), ledger identity rows, and pixtuoid's own session map (Codex threadId and Claude session id are already desk keys). An address that can't be resolved becomes an explicit **"unknown peer"** endpoint. Gaps stay visible and are never silently dropped.

### 4. pixtuoid comms lane

- A new sibling channel, `CommsMsg { from: Endpoint, to: Endpoint, route, stage, at }`, mirroring the daemon presence lane. It does **not** enter `Reducer::apply`, so the agent lifecycle code is untouched.
- `SceneState.comms`: a bounded ring of recent edges plus per-desk-pair counters, with a TTL decay.
- Rendering:
  - A short-lived arrow or courier sprite between two desks. Colour follows the route: native vs agent-peers bridge. Failed or held stages are drawn distinctly.
  - The Tab tree gets a "talks to" line per agent: recent peers and counts.
  - No message text.
- Ingest: the ledger is tailed with pixtuoid's existing `JsonlWatcher` machinery. The native decode reuses the CC/Codex transcript decoders.

### 5. Hermes coverage

- **Done today:** the shell hooks are installed in the gaming profile config, so desks appear for Hermes sessions there. The default/JD profiles are not hooked, and are a separate decision.
- **Next:** a small Hermes plugin (in-process `subagent_start`/`subagent_stop`, which do carry the child id) forwards `delegate_task` children to the pixtuoid hook socket in the existing hook envelope. That fills the gap noted in `source/hermes.rs` without pixtuoid modelling Python plugin callbacks. It could ship inside the agent-peers Hermes plugin or separately. Decide at implementation.

## Fork and upstream strategy

- Fork pixtuoid. All of our code goes in a new `source/comms` module, the sibling channel, and one render layer. There are no edits to the reducer or the existing decoders beyond the messaging-tool recognition in §2.
- Pitch upstream as a generic "inter-agent messaging" lane. Claude Code `SendMessage` and Codex native messaging aren't specific to us, and the agent-peers ledger is just one more producer. Upstream rules to respect: TDD, recorded (not composed) fixtures, no magic numbers, `just preflight`.
- If upstream declines, our rebase surface is one module plus two small hook points.

## Delivery order

1. Ledger in agent-peers, with tests: schema, permissions, rotation, identity rows, and failure stages. Ship behind `AGENT_PEERS_COMMS=1`.
2. pixtuoid fork: an address book plus a comms lane that reads the ledger only, with Tab-tree text first and arrows second.
3. Native decode for CC `SendMessage` and Codex `send_message`/`followup_task`, built on recorded fixtures.
4. Hermes `delegate_task` sub-agent plugin.
5. Upstream PR.

## Acceptance

- A live session with a Codex worker, a Claude Code session and a Hermes chat (gaming profile) exchanging agent-peers messages shows an edge for every successful send within 2 s. A failed send shows as a failed edge.
- Codex native `send_message` between sub-agents shows as edges inside that agent's tree.
- No message body appears in any artefact. Ledger files are `0600` in a `0700` directory.
- Removing `AGENT_PEERS_COMMS` stops recording with no effect on delivery.
- pixtuoid with no ledger present behaves exactly as upstream.

## Open questions

- Should Claude Code → agent-peers sends also be ledgered at send time? That needs a Claude-side hook, because CC uses native `SendMessage`. For now the receive-side `received` row covers it.
- Should Hermes's own `send_peer` calls also appear as tool activity on the Hermes desk? They do via hooks already. Check for double rendering with the edge.
- Retention for the ledger: reuse the 7-day / 16 MiB defaults, or keep longer for replay?
