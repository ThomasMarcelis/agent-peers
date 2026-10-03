# Release verification

This page records sanitized evidence for 0.1.0. Raw live transcripts are deliberately excluded from the repository and package.

## Automated checks

The release runs the offline JavaScript transport, Codex MCP, CLI and discovery suite; portable Python subprocess/plugin tests; and real discovery and Discord routing tests on the pinned Hermes fork. The package test installs an npm tarball in a temporary directory and checks the installed launchers and MCP handshake.

CI covers Linux and macOS on Node 22, 24 and 26, Python 3.11–3.13, and a separate pinned-Hermes job. See the [CI runs](https://github.com/ThomasMarcelis/agent-peers/actions/workflows/ci.yml) for exact commit results.

## Agent compatibility

Tested versions and host constraints are in [compatibility](compatibility.md). Live tests launch disposable sessions with isolated peer registries. They verify message delivery and actual model/tool replies; deterministic Discord tests exercise the real adapter path with fake model and network calls, so they are not a claim of a production Discord API test.

The public release requires fresh passing live evidence for its advertised Claude and Codex paths. An upstream-host claim additionally requires the conversation-route extension; its local preparation does not make stock Hermes supported.
