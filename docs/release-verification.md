# Release verification

Raw live transcripts are excluded from the repository and package.

## 1.0.0-rc.3

Verified on 2026-10-17 on Linux with Node 22.23.1, Claude Code 2.1.302 and Codex CLI 0.162.1.

- Platforms: there is no macOS machine for this project. macOS is covered by CI only (the deterministic suites on Node 22, 24 and 26). Live interoperability with real Claude Code, Codex and Hermes sessions is verified on Linux only.
- Hermes bridge live harness (`npm run test:live:hermes`), updated for the 1.0 protocol and run for the first time against it. The bridge ran as Hermes profile `live`. All four round trips passed: idle and busy Codex, and idle and busy Claude. Every `send_peer` result had exactly the 1.0 fields. Codex reported `accepted` and Claude `unconfirmed` (`no-receipt`). Codex's own replies stopped at `queued`, because the harness plays the plugin and reports no `delivery_result`. Stable names also passed:
  - A conversation claimed `hermes:live/<claim>`. A claim for another profile's scope was refused `scope-denied`.
  - The name was listed as running with the conversation's inbox in the bridge, MCP and CLI listings. Hermes was still never a peer row.
  - The real Claude session reached the name with `agent-peers resolve` and SendMessage. The holder answered with `in_reply_to` set.
  - After `release_name`, the name resolved `not-found`. Codex then sent to the released, now unclaimed inbox, whose owner never gave it that address, and got `dropped` / `not-a-reply-target` (#28). The message never reached the conversation.
  - Every private inbox was retired on `close_session`. No product bugs were found.
  - The `--codex-only` mode passed too: two Codex round trips, then the claim, release and guessed-inbox refusal.
- The four-session live matrix (`npm run test:live`) gained a stable-name check: a Claude session claims `claude:<scope>/<claim>` with `agent-peers claim`, and a Codex session reaches it by name with `send_peer` (`unconfirmed`, with the holder's name, inbox and generation). The check passed with `node test/live-matrix.mjs --names-only`, which starts all four sessions and runs only that check. The full matrix was not re-run here.
- Steering, live on private app-servers (Codex 0.162.1, gpt-6.1-sol at `xhigh`; 310 trials including gpt-6-astra checks). A lead's correction sent mid-turn landed in the running turn every time.
  - With the brief sentence in [compatibility](compatibility.md#headless-codex-on-a-private-app-server), the worker applied the correction before the turn ended in 26 of 26 runs. With a neutral brief, it applied none (0 of 30).
  - 0.3.0 and 1.0.0-rc.2 behaved the same.
  - With the new frame wording, the contract's busy and idle steps were answered 15 of 16 and 16 of 16 times on gpt-6.1-sol and gpt-6-astra, against 0 of 16 and 0 of 16 with the old wording.
- Live contract (`node test/contract.mjs --codex-only`) on Codex 0.162.1 with gpt-6-astra at `max` and this frame, run twice: busy and idle delivery, answered both times.

## 1.0.0-rc.2

Verified on 2026-10-17 on Linux with Node 22.23.1. CI on Linux and macOS gates the release job.

- Deterministic suites: 161 JavaScript tests and 35 Python tests, including the stable-name scenarios from `docs/design/names.md` §10: claim, refresh, takeover of a stopped holder, refusal of a running holder, profile scoping, Hermes re-claim after a restart, the name-based exception to the #28 reply-target rule, and storage races.
- The Hermes integration tests pass against the deployed fork build `0d7c749` with the new `--hermes-profile` bridge argument.
- The four-session live matrix from rc.1 was not re-run. Names add no change to unnamed delivery. Live use of names happens on the maintainer's machine during the candidate period.

## 1.0.0-rc.1

Verified on 2026-10-17 on Linux with Node 22.23.1. CI on Linux and macOS gates the release job.

- Deterministic suites: 137 JavaScript tests and 31 Python tests. They include regression tests for every finding of an independent review of the 1.0 core: per-conversation pins, late drop notices after a Hermes conversation closes, no per-message process lookups, bridge input bounds, receipt `from` checks, and never answering app-server requests.
- The Hermes integration tests pass against the deployed fork build `0d7c749`.
- Live contract (`node test/contract.mjs`) on Claude Code 2.1.302 and Codex 0.162.1: idle Codex delivery and reply, Claude acceptance of the `agent_peers` line extension, and Codex → Claude results reported as `unconfirmed` (Claude sends no receipt on acceptance). A peer message sent into a busy Codex turn is always delivered into that turn. Whether the model answers it mid-turn varied between runs, and the contract records that rather than requiring it.
- Still to do before 1.0.0: the four-session live matrix, and real use by local Claude, Codex and Hermes sessions on this candidate.

## 0.3.0

Verified on 2026-10-16 on Linux with Node 22.23.1. CI on Linux and macOS gates the release job:

- Deterministic suites: 113 JavaScript tests, including new transport edge cases (post timeout, refused and closed-before-accept connections, idle timeout, oversized app-server frames); 27 Python tests; the packed npm artifact installed and completed an MCP handshake.
- Live on the maintainer's machine: `agent-peers whoami` identified the calling Claude Code session; `agent-peers list` probed four live Claude inboxes.

Transport behaviour otherwise matches 0.2.0. That release was deployed locally and verified end to end, including a Hermes ↔ Claude round trip through a fresh 0.2.0 bridge.

## 0.2.0

Verified on 2026-10-16 with Node 22.23.1 and Codex CLI 0.162.1 on Linux, plus CI on Linux and macOS:

- Deterministic suites: 101 JavaScript transport, MCP, discovery, CLI and retry tests; 27 Python plugin and subprocess tests; the packed npm artifact installed and completed an MCP handshake.
- Live, on a private `codex app-server` running `codex-peer` from the 0.2.0 branch with gpt-6.1-sol: the worker's inbox opened in about 7 seconds; peer messages steered a running turn and woke an idle one; `thread/resume` restored the thread on a fresh server after its process group was killed.
- `agent-peers doctor` reported Codex's restarted shared daemon as answering. Its stale-link and non-answering reports are covered by the deterministic suite.

The four-session live matrix was not re-run for 0.2.0. The model in the live run declined to reply to a peer when its brief did not authorize replies; see [compatibility](compatibility.md#headless-codex-on-a-private-app-server).

## 0.1.0 and 0.1.1

Version 0.1.1 changes documentation, package metadata, and diagnostic wording only. Its transport is unchanged from the live-verified 0.1.0 release.

## 0.1.0 automated checks (2026-10-03)

| Check | Result |
| --- | --- |
| JavaScript transport, MCP, discovery and CLI | 62 tests |
| Portable Python plugin and subprocess | 25 tests |
| Pinned Hermes loader and Discord routing | 5 tests |
| Packed npm artifact | 29 files; installed CLI and MCP handshake passed |
| Production dependency audit | 0 known vulnerabilities |

Regressions cover concurrent socket directories, destination-specific reply addresses, legacy sidecar takeover, missing-inbox repair, and an injected replacement race between validation and socket publication. An independent Opus 5.5 review identified lifecycle issues addressed by these changes.

All ten jobs in the [transport validation run](https://github.com/ThomasMarcelis/agent-peers/actions/runs/37149288716) passed: Linux/macOS on Node 22, 24 and 26, Python 3.11–3.13, and the pinned-Hermes integration. See [CI](https://github.com/ThomasMarcelis/agent-peers/actions/workflows/ci.yml) for the release commit. A credential-pattern scan of reachable Git history found no potential credentials.

## Agent compatibility

Live verification used Node 22.23.1, Codex CLI 0.160.0, and Claude Code 2.1.288 on Linux, with disposable sessions and isolated peer registries:

- All 12 directed request/reply routes among two Claude and two Codex sessions passed.
- All four sessions discovered their expected peers.
- Native Codex subagent discovery and messaging passed.
- All four Hermes bridge round trips passed: idle and busy Codex, and idle and busy Claude, with private-inbox lifecycle and discovery checks.
- A shared design task negotiated ownership, completed independent drafts, and coordinated a changed requirement. No peer messages were sent during the independent phase; this is an observation, not a quota.

Deterministic Discord tests exercise the real adapter path with fake model and network calls. They do not claim a production Discord API test. Host requirements and experimental Hermes surfaces are listed in [compatibility](compatibility.md).

The generic Hermes host extension remains separate and unsubmitted. Its local preparation does not make stock upstream Hermes supported.
