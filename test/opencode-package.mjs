// Golden parity and package entrypoints: Codex's tools/list input schemas are the source for the
// opencode/bridge JSON copy, and the package exports `./server` without making the package root
// the plugin.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { VERSION } from "../src/version.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const definitions = JSON.parse(readFileSync(join(root, "src", "peer-tool-definitions.json"), "utf8"));
const golden = JSON.parse(readFileSync(join(root, "test", "fixtures", "codex-tools.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

test("Codex's tools/list is unchanged from the rc.4 surface", async (t) => {
  const client = new Client({ name: "tools-golden", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [join(root, "src", "codex-peer.mjs")],
    env: { ...process.env, AGENT_PEERS_CODEX_APP_SERVER: join(root, "missing.sock") }, stderr: "pipe",
  }));
  const { tools } = await client.listTools();
  assert.deepEqual(tools, golden);
});

test("Codex's tools/list input schemas equal src/peer-tool-definitions.json", async (t) => {
  const client = new Client({ name: "schema-parity", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [join(root, "src", "codex-peer.mjs")],
    env: { ...process.env, AGENT_PEERS_CODEX_APP_SERVER: join(root, "missing.sock") }, stderr: "pipe",
  }));
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), Object.keys(definitions).sort());
  for (const tool of tools) {
    const expected = definitions[tool.name];
    const { $schema, ...input } = tool.inputSchema;
    assert.deepEqual(input, expected.input, `${tool.name} input schema`);
    assert.equal("outputSchema" in tool, false, `${tool.name} has no output schema`);
  }
});

test("the package exports ./server, ./package.json and ./*, and never the package root", async () => {
  assert.deepEqual(pkg.exports, { "./server": "./opencode/server.mjs", "./package.json": "./package.json", "./*": "./*" });
  assert.equal(pkg.version, VERSION);
  assert.ok(pkg.files.includes("opencode/"));
  assert.ok(pkg.files.includes("src/peer-tool-definitions.json"));
  assert.ok(pkg.keywords.includes("opencode"));
  const server = await import("agent-peers/server");
  assert.equal(server.default.id, "agent-peers");
  assert.equal(typeof server.default.setup, "function");
  assert.equal((await import("agent-peers/package.json", { with: { type: "json" } })).default.version, VERSION);
  assert.equal(typeof (await import("agent-peers/src/wire.mjs")).allPeers, "function");
  await assert.rejects(import("agent-peers"), (error) => error.code === "ERR_PACKAGE_PATH_NOT_EXPORTED");
});

test("the plugin definition exposes no output schema and keeps the two text blocks contract", () => {
  const server = readFileSync(join(root, "opencode", "server.mjs"), "utf8");
  assert.match(server, /Symbol\.for\("agent-peers\.opencode\.bridge\.v1"\)/);
  assert.match(server, /return \{[^}]*content: \[\{ type: "text", text: String\(text \?\? ""\) \}, \{ type: "text", text: JSON\.stringify\(structuredContent \?\? null\) \}\],/s);
  assert.doesNotMatch(server, /^\s*output:/m);
  for (const definition of Object.values(definitions)) {
    assert.equal("output" in definition, false, `${definition.name} has no output`);
    assert.equal(typeof definition.description, "string");
  }
});
