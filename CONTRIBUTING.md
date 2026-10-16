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
npm run test:python
```

`npm run test:python` uses `$AGENT_PEERS_PYTHON`, else `.venv/bin/python`, else `python3`, and fails with setup instructions when pytest or pytest-asyncio is missing. `npm publish` runs it through `prepublishOnly`, together with `check`, `test` and `test:package`.

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

### Releasing

GitHub Actions ([`release.yml`](.github/workflows/release.yml)) publishes to npm when a `v*.*.*` tag is pushed. Do not run `npm publish` locally.

1. On a branch, set the same version in `package.json`, `package-lock.json`, `plugin.yaml` and `hermes-plugin/plugin.yaml`, and add a `## <version> — <date>` section to `CHANGELOG.md`. That section becomes the GitHub release notes.
2. Run the local checks and the live checks for advertised integrations. Audit `npm pack --dry-run` and the history for unintended files or secrets.
3. Merge the pull request, wait for CI to pass on the resulting `main` commit, then tag that commit and push the tag: `git tag v<version> <commit> && git push origin v<version>`.
4. The release job requires a successful CI run for the tagged commit and does not re-run the matrix. If there is none (CI skipped a docs-only commit, or a newer push cancelled it), run `gh workflow run ci.yml --ref v<version>`, wait for it to pass, and re-run the release job.
5. The job checks the tag against the package and plugin versions, runs `npm run test:package`, publishes with npm provenance through trusted publishing (no npm token), waits until `npm view agent-peers@<version> version` answers, and creates the GitHub release from the changelog section unless one already exists. Versions with a prerelease suffix go to the `next` dist-tag and become GitHub prereleases. Re-running the job after a partial failure skips what already happened.
6. Verify a fresh install from npm and record compatibility evidence. Do not claim an untested agent build is supported.

A Hermes catalog entry is separate from a GitHub/npm release and requires upstream review. Do not submit one while required host APIs are unavailable upstream.
