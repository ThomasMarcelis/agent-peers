# Contributing

Small, focused changes with a reproducible failure case are welcome. Keep the transport shared across integrations and keep Hermes-specific behavior behind public host APIs. Do not add runtime patches to agent cores.

## Local checks

Use Node.js 22+ on Linux or macOS:

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run test:package
npm audit --omit=dev
```

The default tests use local sockets, temporary registries, and a fake Codex app-server. They do not call models or use agent credentials. Package tests pack and install the actual distributable in a temporary directory, then exercise the installed CLI and MCP server.

Portable Python checks need Python 3.11–3.13:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install 'pytest>=8,<10' 'pytest-asyncio>=0.24,<2'
.venv/bin/python -m pytest -q
```

For host integration, use the exact fork revision in [compatibility](docs/compatibility.md), install its test prerequisites, and run its `scripts/run_tests.sh` with the absolute path to this repository's `test/test_hermes_host.py` with `-m hermes_integration`. CI does this against a separate checkout. Tests cover real discovery, profile isolation, native dispatcher result serialization, and Discord thread returns.

## Live checks

These consume configured Codex/Claude model subscriptions. They create disposable sessions and isolated discovery registries; they must never message unrelated running conversations.

```sh
npm run test:live
npm run test:live:hermes
```

Use `-- --codex-only` for the Codex subset. `node test/contract.mjs` exercises the lower-level delivery contract. Results and transcripts stay under ignored `artifacts/`; never commit raw transcripts or credentials. Publish only sanitized counts, tested versions, and limitations.

## Pull requests

Explain the concrete behavior change and include the checks you ran. Add a regression test for protocol, routing, lifecycle, or permissions changes. Use capability checks for host integration and preserve unsupported-host errors. Changes that alter public tool arguments or transport behavior need a compatibility note.

## Releases

Treat installed integrations as production infrastructure. Develop and test in a separate checkout, with isolated discovery registries. Never edit a checkout referenced by live MCP commands, global npm links, or Hermes plugin symlinks. Deploy a tested snapshot through the host's supported lifecycle; preserve agent conversations and verify real replies after a transport update.

1. Synchronize package and plugin versions and update the changelog.
2. Run local checks, the CI matrix, and live checks for advertised integrations.
3. Audit `npm pack --dry-run` and repository history for unintended files or secrets.
4. Publish the reviewed commit to npm and tag the same revision on GitHub.
5. Attach the packed artifact and SHA-256 checksum; verify a fresh install from npm.
6. Record compatibility evidence. Do not claim an untested agent build is supported.

A Hermes catalog entry is separate from a GitHub/npm release and requires upstream review. Do not submit one while required host APIs are unavailable upstream.
