// The stdio protocol contract: v1, p-/b- request ids, hello, tool, unknown/bind/shutdown refusal,
// malformed and oversized lines, host error mapping, and EOF cleanup. The bridge runs as the real
// bin subcommand; the fake opencode host is this test's stdin/stdout peer.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { VERSION } from "../src/version.mjs";
import { opencodeFixture, until } from "./opencode-host.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bridgeBin = join(root, "bin", "agent-peers.mjs");

function start(t) {
  const child = spawn(process.execPath, [bridgeBin, "opencode-bridge"], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } });
  const messages = [];
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (data) => {
    buffer += data;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const raw = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!raw.trim()) continue;
      try { messages.push(JSON.parse(raw)); } catch { messages.push({ raw }); }
    }
  });
  t.after(() => { try { child.kill("SIGKILL"); } catch {} });
  return {
    child, messages,
    send(message) { child.stdin.write((typeof message === "string" ? message : JSON.stringify(message)) + "\n"); },
    async waitFor(check, description = "message", tries = 300) {
      return until(() => messages.find(check), description, tries);
    },
  };
}

test("protocol v1: hello, p-/b- namespaces, unknown methods, malformed JSON and oversized lines", { timeout: 30_000 }, async (t) => {
  const f = start(t);
  f.send({ v: 1, id: "p-1", method: "hello", params: { instance: "i-1", location: { directory: "/tmp" } } });
  const hello = await f.waitFor((m) => m.id === "p-1");
  assert.equal(hello.result.v, 1);
  assert.equal(hello.result.version, VERSION);
  assert.deepEqual(hello.result.limits, { roots: 64, lineBytes: 4 * 1024 * 1024 });
  // A second hello for the same instance is accepted and does not change the protocol version.
  f.send({ v: 1, id: "p-2", method: "hello", params: { instance: "i-1", location: { directory: "/elsewhere" } } });
  assert.equal((await f.waitFor((m) => m.id === "p-2")).result.version, VERSION);
  f.send({ v: 2, id: "p-3", method: "hello", params: { instance: "i-1" } });
  assert.equal((await f.waitFor((m) => m.id === "p-3")).error.code, "version-mismatch");
  for (const method of ["bind", "unbind", "shutdown", "host.notice"]) {
    const id = `p-${method}`;
    f.send({ v: 1, id, method, params: {} });
    assert.equal((await f.waitFor((m) => m.id === id)).error.code, "unknown-method", method);
  }
  f.send({ v: 1, id: "x-1", method: "hello", params: { instance: "i-1" } });
  assert.equal((await f.waitFor((m) => m.id === "x-1")).error.code, "invalid-request");
  f.send("not json");
  assert.equal((await f.waitFor((m) => m.id === null && m.error?.code === "invalid-request")).error.code, "invalid-request");
  f.send({ v: 1, id: "p-large", method: "hello", params: { instance: "i-1", location: { directory: "/x", padding: "x".repeat(4 * 1024 * 1024) } } });
  assert.equal((await f.waitFor((m) => m.error?.code === "too-large")).error.code, "too-large");
  // The connection still answers after each refusal.
  f.send({ v: 1, id: "p-after", method: "hello", params: { instance: "i-after" } });
  assert.equal((await f.waitFor((m) => m.id === "p-after")).result.v, 1);
});

test("the bridge answers host.session on the same wire and cleans up its record on stdin EOF", { timeout: 30_000 }, async (t) => {
  const fixture = opencodeFixture(t);
  const f = start(t);
  f.send({ v: 1, id: "p-hello", method: "hello", params: { instance: "i-1", location: { directory: fixture.dir } } });
  await f.waitFor((m) => m.id === "p-hello");
  f.send({ v: 1, id: "p-list", method: "tool", params: { instance: "i-1", name: "list_peers", sessionID: "ses_root", args: {} } });
  const request = await f.waitFor((m) => typeof m.id === "string" && m.id.startsWith("b-") && m.method === "host.session", "host.session");
  assert.equal(request.params.instance, "i-1");
  assert.equal(request.params.sessionID, "ses_root");
  f.send({ v: 1, id: request.id, result: { id: "ses_root", location: { directory: join(fixture.dir, "repo") }, title: "Repo", time: { updated: 1, idle: 1 } } });
  const listed = await f.waitFor((m) => m.id === "p-list");
  assert.equal(listed.result.isError, false, listed.result.text);
  assert.equal(listed.result.structuredContent.self.threadId, "ses_root");
  assert.equal(existsSync(join(fixture.peers, "opencode-ses_root.json")), true);
  // A host not-found is a tool-level failed/no-session, not a protocol error.
  f.send({ v: 1, id: "p-missing", method: "tool", params: { instance: "i-1", name: "list_peers", sessionID: "ses_missing", args: {} } });
  const missingRequest = await f.waitFor((m) => typeof m.id === "string" && m.id.startsWith("b-") && m.method === "host.session" && m.params.sessionID === "ses_missing");
  f.send({ v: 1, id: missingRequest.id, error: { code: "not-found", message: "no such session" } });
  const missing = await f.waitFor((m) => m.id === "p-missing");
  assert.equal(missing.result.structuredContent.reason, "no-session");
  assert.equal(missing.result.isError, true);
  const exited = new Promise((resolve) => f.child.once("exit", (code) => resolve(code)));
  f.child.stdin.end();
  assert.equal(await exited, 0);
  assert.equal(existsSync(join(fixture.peers, "opencode-ses_root.json")), false);
  assert.deepEqual(readdirSync(fixture.sockets).filter((name) => name.startsWith("opencode-")), []);
});
