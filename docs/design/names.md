# agent-peers stable names (#13)

> **Maintainer decisions (2026-10-16), overriding anything below:**
> - Ships in **1.1** as an additive release. 1.0 reserves the grammar (`<kind>:<scope>/<claim>`, lowercase ASCII, exactly one `/`) and the `names/` directory.
> - Claims must contain `/`.
> - The same owner refreshes without any flag.
> - **No `--takeover` flag.** Claiming a name whose holder is not running takes it over and reports the previous holder. A running holder is always refused.
> - Generation follows the core spec as shipped: Claude is pid + procStart + socket (survives `/clear` and `/resume`), Codex is threadId + procStart, Hermes is the route id.
> - A lazy Hermes re-claim on the conversation's next agent-peers call is enough for 1.1; a host hook can come later.
> - Dead claims stay listed and do not expire; `release` removes them.

Design for explicit, scoped stable names. It builds on the 1.0 protocol (`docs/design/1.0-protocol.md`, §8 generation and liveness, §9 reserved grammar). It is not packaged yet. Normative words: **must**, **never**. Numbers are constants in code, not contract.

It assumes the process-based generation from the brief (Claude `pid+procStart+socket`, Codex `threadId+procStart`, Hermes route id). The worktree draft of §8 still says Claude `sessionId` and Codex `threadId`. This spec compares generations only as opaque strings, so it works with either; open question 5 covers how the meaning differs.

Principles (from the maintainer): (1) one session or conversation claims a name explicitly; (2) names are scoped; (3) a name resolves at send time; (4) an unclaimed or dead name fails with a clear routing error; (5) never any fallback, so no "most recent", no profile default, no broadcast and no fuzzy match; (6) no daemon; (7) simple and recoverable over clever.

## 1. Grammar and scopes

- A claimed name is `<kind>:<scope>/<claim>`, with exactly one `/`:
  - kind: `claude|codex|hermes`
  - scope: `[a-z0-9][a-z0-9_-]{0,63}` (this is exactly Hermes's profile-id rule)
  - claim: `[a-z0-9][a-z0-9_.-]{0,63}`
- Matching is exact and case-sensitive. There is no folding: an uppercase letter, a second `/`, a `:` in the scope or claim, or a non-ASCII character gives `invalid-request`, and the error text quotes the grammar. Automatic names never contain `/` (core §9), so claimed and automatic names can never collide.
- **Pushback on the brief's example.** `claude:marketsimulator-lead` must be written `claude:marketsimulator/lead`. Without the `/`, a claim would share the namespace of Claude's automatic names. Claude registry names are user-settable, so the same string could then be both an automatic name and a claim, and resolving it would be ambiguous.
- **What the scope means**:
  - `hermes`: the scope is the claimant's Hermes profile id. This is enforced (§4), so the user's example becomes `hermes:gaming/marketsimulator` (profile `gaming`, project `marketsimulator`).
  - `claude` and `codex`: the scope is a project namespace the owner chooses. It organizes names; it is not a security boundary, because all of these sessions run as the same OS user.
- **Kind-elided form** `<scope>/<claim>`:
  - It resolves only when exactly one kind has a record (live or dead) for that exact scope and claim. Otherwise the result is `ambiguous`, which lists the full names and never picks one.
  - Claim commands accept the elided form and fill in the caller's own kind.

## 2. Owner, generation, liveness

| kind | owner (stable claimant) | generation (core §8) | holder is running when |
| --- | --- | --- | --- |
| claude | `pid:procStart` of the Claude process | `pid+procStart+socket` | the live Claude registry record for `pid` has the same `procStart` and the same `messagingSocketPath` |
| codex | `threadId` (a root thread only) | `threadId+procStart` | `codex-<threadId>.json` is running (pid plus procStart) and its generation equals the claim's |
| hermes | `profile` + Hermes `session_id`; while the route is live, it follows compression (§4) | route id | the bridge's pid plus procStart are live, and every recorded `hermes-<32hex>.sock` exists, is owned by this user and sits in a permitted directory |

- `owner` and `generation` are stored as `sha256("<kind>\0<identity>")[:16]`, never as raw ids, which matches the logging rules.
- Same owner with a new generation means the same claimant restarted (a Codex MCP replacement, a Hermes route restored after a gateway restart). That is a **refresh**, not a takeover.
- The new claim checks (holder liveness, generation comparison) run inside `inDiscoveryScope`, together with the core's `procStart` batching.

## 3. Storage

- **Directory**: `$AGENT_PEERS_HOME/names/`, created with `ensurePrivateDir` (owned by this user, mode `0700`, no symlinks).
- **Files**: one per name, `n-<sha256(name)[:32]>.json`, mode `0600`, created with `wx`. Files are read only with `readPeerRecord`, so a reader never follows a symlink and refuses a file that is foreign, group- or world-writable, or over 64 KiB.
- **Validation on read**: a reader drops a record whose `sha256(name)` does not match its filename, whose kind differs from the name's kind, or which has invalid fields. Unknown fields are ignored.
- **Record**:
  ```json
  { "v": 1, "name": "hermes:gaming/marketsimulator", "kind": "hermes", "owner": "<16hex>", "generation": "<16hex>", "claimedAt": 1760600000000,
    "holder": { "pid": 4242, "procStart": "…", "autoName": "hermes:gaming:ab12cd34",
                "socket": "<claude only>", "threadId": "<codex only>", "addresses": ["uds:…"] } }
  ```
- **What resolution reads**:
  - claude: the socket from the live Claude registry record
  - codex: the addresses from the live `codex-<threadId>.json`, which is fresher about aliases than the claim
  - hermes: `holder.addresses`, because Hermes keeps no other registry
- **Create**:
  1. Write a temporary file `.t-<uuid>.json` in the same directory.
  2. `link(temp, final)`. If that fails with `EEXIST`, go to §5.
  3. `unlink(temp)`.
- **Replace or remove** (compare-and-swap by inode, with no lock and no daemon):
  1. Read the record and note its `(dev, ino)`.
  2. Decide what to do (§5).
  3. `rename(final, .reap-<uuid>)`. If that fails with `ENOENT`, retry from the start, at most 3 times.
  4. Check the reaped file's inode against the one read in step 1. If it differs, `link` it back and report `conflict`.
  5. Otherwise `link(new, final)` (skipped for a release) and `unlink` the reaped file.
- **Worst case**: a three-way race within microseconds can lose a claim, and then sends fail `not-found` until the holder claims again. It can never produce two holders or misroute a message.
- **Caps**: at most 8 names per owner, and at most 1024 files read per scan. Claude's registry is never written, and Codex registry files keep their current schema.

## 4. How each kind claims

**Claude: the CLI, run by the session.**
- Commands: `agent-peers claim <name> [--json]` and `agent-peers release <name> [--json]`.
- The caller is the nearest process ancestor that has a live Claude registry record (as in `whoami`, but Claude only).
  - With no Claude ancestor, the command exits 1 with `no-session`.
  - Codex is not covered: `codex-peer` is never an ancestor of a Codex shell command, so Codex claims go through its MCP tool.
- A Claude session may claim only `claude:` names. Any other kind gives `scope-denied`.
- Nothing runs when Claude exits, so the claim dies with the process (§6).
- Recipe for an agent's instructions or brief: "At start, run `agent-peers claim marketsimulator/lead`."

**Codex: an MCP tool.**
- Tools: `claim_name({name})` and `release_name({name})`. Each root in a multi-root process has its own claims.
- Subagents get `no-session`, because they send under their root.
- `AGENT_PEERS_NAME` stays an automatic label and **does not** become a claim. It is per-config, and "one config, and so one name, can serve several sessions" (the comment in `codex-peer.mjs`), so an automatic claim from it would break the one-claimant rule.
- There is no environment-variable claim. A headless worker's brief makes `claim_name` its first step.
- **Re-claim on restore**: after `publishRegistry` in `bindNow` (startup, MCP replacement), codex-peer refreshes claims whose owner is its own `threadId`. It never touches any other owner's claims.

**Hermes: a plugin tool that a conversation calls.**
- Tools: `claim_name({name})` and `release_name({name})`.
- `name` is either `<claim>` or a full name. The scope always comes from `ctx.profile_name` and never from the model; a full name with another profile gives `scope-denied`.
- The bridge is started with `--hermes-profile <id>` (appended by the plugin) and also refuses other scopes.
- A claim needs a live conversation route, just as `send_peer` does.
- Claiming binds that route's inboxes eagerly, in every verified socket directory (at most 16), and records their addresses. This is the only way a Hermes conversation appears in discovery, and it publishes nothing beyond that name.
- Bridge methods (additive):
  - `claim_name {session, owner, name}`
  - `release_name {session, owner, name}`
  - `list_peers` and `send_peer` gain `owner`, and `list_peers` also gains `session`
- **Gateway restarts.**
  - Route ids are in-memory `uuid4` tokens, minted again at every registration, and gateways register a route only when a turn runs (`hermes_cli/session_messages.py`, `gateway/run_session_messages.py`). So no claim can stay live across a restart.
  - The record stays on disk. The holder is now dead, so senders get `not-running`.
  - Re-claim happens on restore: the same conversation's **next agent-peers tool call** (list, send or claim) refreshes claims whose owner is `(profile, current session_id)`. This is the same owner, so no flag is needed.
  - While a route is live, any tool call also rewrites the owner of claims it holds to the route's current `session_id`, so compression cannot orphan them.
  - `/new` or a reset creates a new owner, which takes the name over once the old owner is no longer running.

## 5. Conflicts

| existing record | claim |
| --- | --- |
| none | `claimed` |
| same generation | `refreshed` (idempotent) |
| same owner, other generation | `refreshed` |
| other owner, holder not running | `taken-over` (the result names the previous holder) |
| other owner, holder running | refused: `name-held`; only the holder can release it |

- **Result**: `{status, reason, name, kind, generation, address, previous:{generation, running}|null, text}`. `status` is one of `claimed`, `refreshed`, `taken-over`, `released`, `refused`.
- **CLI exit codes**: 0 on success, 1 on refusal, 2 for bad usage or an invalid grammar.
- **New reasons**: `name-held`, `scope-denied`, `no-session`, `not-holder`, `conflict`, `too-many-names`. Adding codes is a minor change (§13).

## 6. Release and exit

- `release` removes a record only for its holder (same owner), or for anyone when the holder is not running. Otherwise it gives `not-holder`.
- **Exit never deletes a record**, for any kind. Claude has no exit hook, and Codex and Hermes cannot tell a restart from an ending. A dead record keeps the error precise (`not-running` rather than `not-found`) until a new claim or a release replaces it. Records do not expire in the MVP; a dead record is one small file.

## 7. Resolution, send_peer, list, resolve

- **send_peer** resolves inside `inDiscoveryScope`:
  1. `uds:` address
  2. name containing `/`
  3. exact automatic name (core §9)

  For a claimed name:
  1. Grammar → `invalid-request`.
  2. No record → `failed`/`not-found`: "No session has claimed `X`. Its holder must claim it (Claude: `agent-peers claim`; Codex or Hermes: `claim_name`). Nothing was sent."
  3. Holder not running → `failed`/`not-running`: "`X` is claimed by a Claude session that is no longer running (claimed …, gen …). Nothing was sent. The new session must claim it."
  4. Pick the holder's address in the needed directory, or give `inbox-unavailable`.
  5. Post as in core §3–5. In the result, `name` is the claimed name and `generation` is the holder's.
- **Pins (core §8)**:
  - A claimed name deliberately follows its holder, so a changed generation is **never** a pin failure. The text adds "held by a different session than at your last send (gen a → b)".
  - The address pin is refreshed from the verified claim.
  - Automatic names and addresses keep the core pins.
- **`agent-peers resolve <target> [--json]`** works for any exact target: an address, an automatic name or a claimed name.
  - It prints exactly one `uds:` line. That is the address in the caller's Claude socket directory when the caller is known by ancestry, and otherwise the primary address.
  - Exit codes: 0 when resolved, 1 for `not-found`, `not-running`, `ambiguous` or `inbox-unavailable` (the JSON gives `{status, reason, text}`), 2 for bad usage.
  - Claude senders run it just before `SendMessage`. There is a window between resolving and sending in which the holder can change. A dead socket fails at Claude; a reused PID on the same socket is the residual race, and it is the same as with any `uds:` address today.
- **list**:
  - `list --json` and the Codex and Hermes `list_peers` gain `names[]`: `{name, kind, running, address, addresses, generation, holder:<autoName>|null, claimedAt}`.
  - Dead names are included with `running:false`. They are explicit roles, unlike the core's stale index.
  - Peer rows gain `claims[]`, Codex `self` and `whoami` gain `claims`, and text rows read `hermes:gaming/marketsimulator  running  SendMessage {"to":"uds:…"}`.
- **Frames**:
  - A recipient adds the attribute `reply_name="<name>"` only when its own reverse lookup finds a live claim held at the incoming `from` address. Self-asserted names are never displayed.
  - `from-name` is unchanged: Claude's alphabet has no `/`.
  - For Claude recipients, the sender's first-contact footer adds `(Stable name: <name>.)`, using claims its own tooling holds.

## 8. Security

- **Same-user scope.** The registry is advisory, as Claude's is: any process running as the same user can write it, and that is not a boundary (SECURITY.md). Validation limits a forged record to pointing at a live session of the stated kind, through a socket that `peerSocket` already permits, so it adds no new destinations.
- **Kind binding.** The tools refuse a claim whose kind differs from the claimant's kind. Hermes's profile scope is enforced twice: in the plugin, from `ctx.profile_name`, and in the bridge, through `--hermes-profile`. A conversation in profile `casa` can never claim `hermes:gaming/…`.
- **Project isolation within one profile.** Separate projects in one profile stay apart by owner. Conversation A can never take B's live name. Reaching another project takes its exact full name, which is a deliberate act, and there is no broadcast or fallback path at all.
- **Names are not authority.** A claim grants nothing: frames still say "peer input, not user approval", host approval and held-message rules are unchanged, and a name found in a peer message is data, never an instruction to contact it.
- **Logging and bounds.** Logs record name identities as hashes (`logIdentity`), never raw names. Claims are bounded by the caps in §3.

## 9. Migration from current names

- Automatic names, `AGENT_PEERS_NAME`, Hermes `hermes:<profile>:<route8>` identities and the envelope are all unchanged, and nothing old gets renamed.
- Older readers never open `names/`. 0.3.0 senders find nothing for a name containing `/` (Hermes is unlisted, and substring matching cannot reach across a `/`), so the send fails harmlessly. 1.0 senders return `reserved-name`.
- To use names, the claimant and the sender each need ≥ the claims release; recipients need nothing new.
- Docs: `CLAUDE-snippet.md` adds two lines: "If your brief names you, run `agent-peers claim <scope>/<claim>` at start. To reach a named peer, run `agent-peers resolve <name>` and SendMessage to the printed address." `docs/hermes.md` explains `claim_name` and the re-claim after a restart.

## 10. Tests to write

1. **Grammar**: valid and invalid tables, case, limits, kind elision (exact match, `ambiguous` across kinds, never the live one over the dead one).
2. **Create race**: 8 child processes claim the same name, and exactly one succeeds while the rest get `name-held`.
3. **Takeover race**: 8 processes take over a dead claim; at most one succeeds, and there are never two holders.
4. **Inode compare-and-swap**: if a record is replaced between read and rename, it is restored and the result is `conflict`.
5. **Conflict table**, every row:
   - dead holder: a killed PID, and a reused PID (procStart mismatch)
   - same owner with a new generation: a refresh with no flag
   - live other owner: refused
6. **Release**: holder only, or a dead holder; a release that loses to a takeover never deletes the new record.
7. **File safety**: symlink, foreign mode, `022`, oversize, filename-hash mismatch, kind mismatch; the directory is `0700`.
8. **Resolution**: the `not-found` and `not-running` texts name the holder; the address comes from the caller's directory; otherwise `inbox-unavailable`.
9. **Pins**: a claim follows its holder, and the result notes the change; an automatic name still fails on a pin mismatch.
10. **CLI**:
    - exit 1 (`no-session`) outside a session
    - inside a session, using the `whoami` fake-ancestry harness in `test/cli.mjs`
    - `resolve`, `list --json` with `names[]`, and exit codes 0, 1 and 2
11. **Codex**: `claim_name`; a rebind in a new process refreshes only its own thread's claims; multiple roots each keep their own claims; a subagent gets `no-session`.
12. **Hermes**, in `test/test_hermes_plugin.py` and `test/hermes-bridge.mjs`:
    - The scope is forced to the profile, and a foreign scope gives `scope-denied` in both the plugin and the bridge.
    - A claim binds an inbox in every verified directory; a claim without a route gives `no-session`.
    - After a route closes, the name is `not-running`.
    - After a bridge restart, the same `session_id` refreshes on its next tool call; a different conversation in the same profile cannot take over a live claim.
    - After compression, the owner follows the route's current `session_id`.
13. **Frames**: `reply_name` appears only when the reverse lookup verifies the claim; a stale or forged record shows no name.
14. **Live (opt-in)**:
    1. A Claude lead claims through Bash.
    2. A Hermes relay sends by name.
    3. Claude restarts and runs `claim`.
    4. The relay's next send by name arrives without anyone exchanging an address.

## 11. In 1.0 vs later

- **1.0 (core, as approved)**: reserve the grammar from core §9. Tighten it to the exact grammar in §1, so that 1.0 gives `reserved-name` for grammar-valid claimed names and `invalid-request` for everything else. Also reserve `$AGENT_PEERS_HOME/names/`, which 1.0 neither creates nor reads. Nothing else, so claims stay a purely additive minor release.
- **1.1 (claims MVP, all three kinds)**: everything in §2–§7 (Hermes takes back the name lazily, on its next tool call), plus the docs and the snippet.
- **Later**:
  - Eager Hermes restore through a fork hook, `on_session_message_route_opened(route_id, session_id)`, so a relay is reachable after a restart before its next turn.
  - A Claude `SessionStart` hook recipe, once it is verified that the registry record exists when the hook runs.
  - A `--scope` filter on list.
  - Pruning or expiry of dead claims.

## 12. Open questions

1. Ship claims in 1.1 (recommended: they are additive and depend on the core's generation, stale index and pins), or pull them into 1.0?
2. Confirm that a claim requires a `/` (`claude:marketsimulator/lead`, not `claude:marketsimulator-lead`).
3. A refresh by the same owner needs no flag (Codex rebind, Hermes restore). Is that acceptable, given that the brief's wording could be read as requiring `--takeover` for the same owner too?
4. Taking over from a dead holder requires `--takeover`, so every restart instruction carries the flag. Keep that friction, or make a dead holder takeable without the flag?
5. Generation: under the core draft's Claude `sessionId` identity, a Claude claim dies on `/clear` and `/resume` while the process lives on, and a Claude claim has no automatic refresh. The process-based generation in the brief avoids that. Which does core ship?
6. Is a lazy Hermes restore (on the next tool call) enough for the MVP, or should the fork's route-opened hook be required before 1.1?
7. Dead claims are listed and never expire. Acceptable, or prune after N days?
8. Are lowercase-only ASCII claims, stricter than the automatic labels, acceptable?
