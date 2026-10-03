# Release verification

Verified on 2026-10-03 for 0.1.0. Raw live transcripts are excluded from the repository and package.

## Automated checks

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
