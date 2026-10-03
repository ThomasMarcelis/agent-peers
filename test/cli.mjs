import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { VERSION } from "../src/version.mjs";

const cli = fileURLToPath(new URL("../bin/agent-peers.mjs", import.meta.url));
function run(args, env = {}) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 10_000, env: { ...process.env, ...env } });
}

test("CLI help/version work and invalid options fail without a stack trace", () => {
  for (const args of [[], ["--help"], ["help"]]) {
    const result = run(args);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /list \[--json\]/);
    assert.equal(result.stderr, "");
  }
  assert.equal(run(["--version"]).stdout.trim(), VERSION);
  for (const args of [["nope"], ["list", "--wrong"], ["hermes-bridge", "--json"], ["--version", "extra"]]) {
    const result = run(args);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.doesNotMatch(result.stderr, /\n\s+at /);
  }
});

test("empty discovery and doctor are structured and do not create state", () => {
  const home = mkdtempSync(join(tmpdir(), "ap-cli-"));
  try {
    const env = { CLAUDE_CONFIG_DIR: join(home, "claude"), AGENT_PEERS_HOME: join(home, "peers"),
      AGENT_PEERS_CODEX_APP_SERVER: join(home, "missing.sock") };
    const listing = run(["list", "--json"], env);
    assert.equal(listing.status, 0, listing.stderr);
    assert.deepEqual(JSON.parse(listing.stdout), { peers: [] });
    const result = run(["doctor", "--json"], env);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.checks.find((c) => c.name === "codex daemon").status, "warning");
    assert.deepEqual(readdirSync(home), []);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("doctor reports invalid paths as errors", () => {
  const result = run(["doctor", "--json"], { AGENT_PEERS_HOME: "relative-peers" });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).checks.find((c) => c.name === "peer registry").status, "error");
});
