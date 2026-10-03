// Verify the distributable, not the linked development checkout.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { VERSION } from "../src/version.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const scratch = mkdtempSync(join(tmpdir(), "ap-pack-"));
let client;
try {
  const [pack] = JSON.parse(execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", scratch], { cwd: root, encoding: "utf8" }));
  const files = new Set(pack.files.map((file) => file.path));
  for (const name of ["LICENSE", "README.md", "package.json", "plugin.yaml", "__init__.py", "bin/agent-peers.mjs", "src/codex-peer.mjs", "src/version.mjs"]) {
    assert.ok(files.has(name), `missing package file: ${name}`);
  }
  for (const file of files) assert.ok(!/(^|\/)(artifacts|test|node_modules|__pycache__|\.git|\.pytest_cache)(\/|$)|\.pyc$|\.env(?:\.|$)/.test(file), `unexpected package content: ${file}`);
  const install = join(scratch, "install");
  mkdirSync(install);
  execFileSync("npm", ["install", "--prefix", install, "--no-audit", "--no-fund", "--ignore-scripts", join(scratch, pack.filename)], { stdio: "pipe" });
  const installed = join(install, "node_modules", "agent-peers");
  const env = { ...process.env, CLAUDE_CONFIG_DIR: join(scratch, "claude"), AGENT_PEERS_HOME: join(scratch, "peers"), AGENT_PEERS_CODEX_APP_SERVER: join(scratch, "missing.sock") };
  const launch = (args) => execFileSync(join(install, "node_modules", ".bin", "agent-peers"), args, { env, encoding: "utf8" });
  assert.equal(launch(["--version"]).trim(), VERSION);
  assert.deepEqual(JSON.parse(launch(["list", "--json"])), { peers: [] });
  assert.equal(JSON.parse(launch(["doctor", "--json"])).ok, true);
  const pkg = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  assert.equal(pkg.version, VERSION);
  client = new Client({ name: "package-smoke", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: join(install, "node_modules", ".bin", "codex-peer"), env, stderr: "pipe" }));
  assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), ["list_peers", "send_peer"]);
  await client.close();
  client = undefined;
  console.log(`Installed and verified agent-peers ${VERSION}: CLI, MCP handshake, package contents (${files.size} files).`);
} finally {
  await client?.close();
  rmSync(scratch, { recursive: true, force: true });
}
