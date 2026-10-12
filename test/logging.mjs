import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { errorFields, logEvent, logIdentity, loggingConfig, summarizeLogs } from "../src/logging.mjs";

const modulePath = new URL("../src/logging.mjs", import.meta.url).href;
const cli = fileURLToPath(new URL("../bin/agent-peers.mjs", import.meta.url));

function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ap-logging-")));
  const before = Object.fromEntries(["AGENT_PEERS_DEBUG", "AGENT_PEERS_LOG", "AGENT_PEERS_HOME"].map((key) => [key, process.env[key]]));
  delete process.env.AGENT_PEERS_DEBUG;
  delete process.env.AGENT_PEERS_LOG;
  process.env.AGENT_PEERS_HOME = join(dir, "peers");
  t.after(() => {
    for (const [key, value] of Object.entries(before)) value === undefined ? delete process.env[key] : process.env[key] = value;
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function child(code, env) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", `import { logEvent, loggingConfig, summarizeLogs } from ${JSON.stringify(modulePath)};\n${code}`],
    { env: { ...process.env, ...env }, encoding: "utf8", timeout: 10_000 });
}

test("logging and inspection are opt-in and read-only before the first event", (t) => {
  fixture(t);
  const config = loggingConfig();
  assert.equal(config.enabled, false);
  assert.equal(logEvent("test", "tool.call", { message: "private payload" }), false);
  assert.equal(summarizeLogs().events, 0);
  assert.equal(existsSync(dirname(config.location)), false);
  process.env.AGENT_PEERS_DEBUG = "1";
  assert.equal(loggingConfig().enabled, true);
  assert.equal(summarizeLogs().events, 0);
  assert.equal(existsSync(dirname(config.location)), false);
  process.env.AGENT_PEERS_LOG = join(dirname(config.location), "explicit.jsonl");
  process.env.AGENT_PEERS_DEBUG = "0";
  assert.equal(loggingConfig().enabled, false);
  logEvent("test", "tool.call");
  assert.equal(existsSync(dirname(config.location)), false);
});

test("JSONL events exclude payloads and raw errors while retaining safe correlation", (t) => {
  const dir = fixture(t);
  process.env.AGENT_PEERS_LOG = join(dir, "events.jsonl");
  const secret = "private body /home/private-user/token and password";
  const operationId = randomUUID();
  assert.equal(logEvent("test", "tool.call", { operationId, messageId: "untrusted message id",
    threadId: logIdentity("private-thread"), outcome: "failed", method: secret,
    body: secret, message: secret, error: new Error(secret), name: secret, path: secret,
    reason: secret, errorCode: secret, bytes: 42, durationMs: 1.56789,
    count: Infinity, nativeCount: -1, receipt: true }), true);
  const raw = readFileSync(process.env.AGENT_PEERS_LOG, "utf8");
  assert.ok(!raw.includes(secret));
  assert.ok(!raw.includes("private-thread"));
  assert.ok(!raw.includes("untrusted message id"));
  const record = JSON.parse(raw);
  assert.equal(record.operationId, operationId);
  assert.equal(record.threadId, logIdentity("private-thread"));
  assert.equal(record.messageId, logIdentity("untrusted message id"));
  assert.equal(record.reason, "unknown");
  assert.equal(record.errorCode, "unknown");
  assert.equal(record.method, "unknown");
  assert.equal(record.durationMs, 1.568);
  assert.equal(record.bytes, 42);
  assert.equal(record.receipt, true);
  assert.equal(record.count, undefined);
  assert.equal(record.nativeCount, undefined);
  assert.equal(lstatSync(process.env.AGENT_PEERS_LOG).mode & 0o777, 0o600);
  assert.deepEqual(errorFields({ message: secret, code: secret }), { errorCode: "unknown", reason: "unknown" });
});

test("error classification preserves bounded codes and actionable failure categories", () => {
  for (const [error, reason] of [
    [new Error("no live peer named secret-target; call list_peers"), "not_found"],
    [new Error("ambiguous target secret-target"), "ambiguous_target"],
    [new Error("use native send_message for this thread"), "native_route_required"],
    [Object.assign(new Error("direct app-server input is not allowed for multi-agent v2 sub-agents"), { code: -32600 }), "subagent_input_forbidden"],
    [new Error("app-server turn/start timed out"), "timeout"],
    [new Error("peer inbox closed before accepting the message"), "connection_closed"],
    [Object.assign(new Error("secret path"), { code: "EACCES" }), "permission_denied"],
    [new Error("invalid peer inbox address"), "invalid_input"],
    [new Error("too many pending peer sends"), "rate_limit"],
  ]) assert.equal(errorFields(error).reason, reason);
  assert.equal(errorFields({ code: -32600 }).errorCode, "-32600");
  assert.equal(errorFields({ code: "EACCES" }).errorCode, "EACCES");
  assert.equal(errorFields({ code: "secret" }).errorCode, "unknown");
});

test("default files are private, rotate and prune by age, file count and bytes", (t) => {
  fixture(t);
  process.env.AGENT_PEERS_DEBUG = "1";
  assert.equal(logEvent("test", "tool.call", { outcome: "started" }), true);
  const config = loggingConfig(), first = join(config.location, readdirSync(config.location)[0]);
  assert.equal(lstatSync(config.location).mode & 0o777, 0o700);
  assert.equal(lstatSync(first).mode & 0o777, 0o600);
  writeFileSync(first, "x".repeat(config.maxFileBytes), { mode: 0o600 });
  assert.equal(logEvent("test", "tool.call", { outcome: "succeeded" }), true);
  assert.equal(readdirSync(config.location).length, 2);
  assert.equal(lstatSync(first).size, config.maxFileBytes);
  const stale = join(config.location, `agent-peers-1-1-${randomUUID()}.jsonl`);
  writeFileSync(stale, "old\n", { mode: 0o600 });
  utimesSync(stale, 0, 0);
  const unrelated = join(config.location, "keep-my-notes.txt");
  writeFileSync(unrelated, "keep");
  for (let i = 0; i < 40; i++) writeFileSync(join(config.location, `agent-peers-${100 + i}-1-${randomUUID()}.jsonl`), "x".repeat(config.maxFileBytes), { mode: 0o600 });
  for (const file of readdirSync(config.location).filter((file) => file.endsWith(".jsonl"))) {
    if (file !== stale.split("/").at(-1)) writeFileSync(join(config.location, file), "x".repeat(config.maxFileBytes));
  }
  logEvent("test", "tool.call", { outcome: "succeeded" });
  assert.equal(existsSync(stale), false);
  assert.equal(readFileSync(unrelated, "utf8"), "keep");
  const retained = readdirSync(config.location).filter((file) => file.endsWith(".jsonl"));
  assert.ok(retained.length <= config.maxFiles);
  assert.ok(retained.reduce((size, file) => size + lstatSync(join(config.location, file)).size, 0) <= config.maxTotalBytes);
  for (let i = 0; i < 40; i++) writeFileSync(join(config.location, `agent-peers-${200 + i}-1-${randomUUID()}.jsonl`), "", { mode: 0o600 });
  // Fill the active file to trigger a rotation and its retention sweep.
  for (const file of readdirSync(config.location).filter((file) => file.startsWith("agent-peers-") && file.includes(`-${process.pid}-`))) {
    writeFileSync(join(config.location, file), "x".repeat(config.maxFileBytes));
  }
  logEvent("test", "tool.call", { outcome: "succeeded" });
  assert.ok(readdirSync(config.location).filter((file) => file.endsWith(".jsonl")).length <= config.maxFiles);
});

test("explicit file respects size ceiling and continues a quiet old file", (t) => {
  const dir = fixture(t), path = join(dir, "explicit.jsonl");
  process.env.AGENT_PEERS_LOG = path;
  writeFileSync(path, "old\n", { mode: 0o600 });
  utimesSync(path, 0, 0);
  assert.equal(logEvent("test", "tool.call"), true);
  assert.ok(readFileSync(path, "utf8").startsWith("old\n"));
  const original = "x".repeat(loggingConfig().maxFileBytes);
  writeFileSync(path, original);
  const result = child('logEvent("test", "tool.call"); logEvent("test", "tool.call");', { AGENT_PEERS_LOG: path });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.split("\n").filter(Boolean).length, 1);
  assert.equal(readFileSync(path, "utf8"), original);
});

test("unsafe, inaccessible and invalid destinations fail open once without leaking data", (t) => {
  const dir = fixture(t), safe = join(dir, "safe.jsonl");
  writeFileSync(safe, "unchanged", { mode: 0o600 });
  const link = join(dir, "link.jsonl");
  symlinkSync(safe, link);
  const hard = join(dir, "hard.jsonl");
  linkSync(safe, hard);
  const ancestor = join(dir, "ancestor");
  symlinkSync(dir, ancestor);
  const shared = join(dir, "shared");
  mkdirSync(shared, { mode: 0o755 });
  const sharedFile = join(dir, "shared.jsonl");
  writeFileSync(sharedFile, "unchanged", { mode: 0o644 });
  const blocked = join(dir, "blocked");
  writeFileSync(blocked, "unchanged", { mode: 0o600 });
  for (const location of [link, hard, join(ancestor, "new.jsonl"), join(shared, "new.jsonl"), sharedFile, join(blocked, "new.jsonl"), "relative/secret-location.jsonl"]) {
    const result = child('logEvent("test", "tool.call", { body: "secret-message" }); logEvent("test", "tool.call");', { AGENT_PEERS_LOG: location });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr.split("\n").filter(Boolean).length, 1);
    assert.ok(!result.stderr.includes(location));
    assert.ok(!result.stderr.includes("secret-message"));
  }
  assert.equal(readFileSync(safe, "utf8"), "unchanged");
  assert.equal(readFileSync(sharedFile, "utf8"), "unchanged");
  assert.equal(existsSync(join(dir, "new.jsonl")), false);
  chmodSync(shared, 0o700);
});

test("summary separates tool calls from RPCs, delivery stages and incomplete operations", (t) => {
  const dir = fixture(t);
  process.env.AGENT_PEERS_LOG = join(dir, "summary.jsonl");
  const operationId = randomUUID(), rpcId = randomUUID();
  logEvent("codex-peer", "tool.call", { operationId, method: "send_peer", outcome: "started" });
  logEvent("app-server", "rpc.request", { operationId: rpcId, method: "thread/read", outcome: "started" });
  logEvent("app-server", "rpc.request", { operationId: rpcId, method: "thread/read", outcome: "succeeded" });
  logEvent("codex-peer", "message.send", { operationId, outcome: "inbox_written" });
  logEvent("codex-peer", "message.send", { operationId, outcome: "receipt_received", receipt: true });
  logEvent("codex-peer", "tool.call", { operationId, method: "send_peer", outcome: "succeeded" });
  logEvent("codex-peer", "message.deliver", { operationId, outcome: "app_server_input_accepted" });
  logEvent("codex-peer", "tool.call", { operationId: randomUUID(), method: "list_peers", outcome: "started" });
  const hermesId = randomUUID();
  logEvent("hermes-bridge", "tool.request", { operationId: hermesId, method: "send_peer" });
  logEvent("hermes-bridge", "tool.result", { operationId: hermesId, method: "send_peer", outcome: "error", reason: "not_found" });
  appendFileSync(process.env.AGENT_PEERS_LOG, "old unstructured log\n{truncated\n" + JSON.stringify({ schemaVersion: 1, event: "tool.call", component: "codex-peer", time: "secret-date" }) + "\n");
  const before = readFileSync(process.env.AGENT_PEERS_LOG, "utf8");
  const report = summarizeLogs();
  assert.equal(report.events, 10);
  assert.equal(report.corruptLines, 3);
  assert.deepEqual(report.tools.send_peer, { calls: 2, outcomes: { succeeded: 1, error: 1 } });
  assert.equal(report.tools["thread/read"], undefined);
  assert.equal(report.tools.list_peers, undefined);
  assert.equal(report.delivery.inboxWrites, 1);
  assert.equal(report.delivery.receipts, 1);
  assert.equal(report.delivery.appServerInputAccepted, 1);
  assert.equal(report.operations.incomplete, 1);
  assert.equal(report.reasons.not_found, 1);
  assert.equal(report.byEvent["app-server.rpc.request"], 2);
  assert.equal(readFileSync(process.env.AGENT_PEERS_LOG, "utf8"), before);
  assert.match(report.scope, /No token or billing/);
});

test("summary counts one inbox write per Hermes send and includes held and rejected receipts", (t) => {
  const dir = fixture(t);
  process.env.AGENT_PEERS_LOG = join(dir, "receipts.jsonl");
  for (const outcome of ["inbox_written", "held", "rejected", "receipt_delivered"]) {
    const operationId = randomUUID();
    logEvent("hermes-bridge", "send.started", { operationId });
    logEvent("hermes-bridge", "message.send", { operationId, outcome: "inbox_written" });
    logEvent("hermes-bridge", "send.result", { operationId, outcome, receipt: outcome !== "inbox_written" });
  }
  const report = summarizeLogs();
  assert.equal(report.delivery.inboxWrites, 4);
  assert.equal(report.delivery.receipts, 3);
  assert.equal(report.operations.incomplete, 0);
});

test("summary bounds oversized input and skips unsafe log files without changing them", (t) => {
  const dir = fixture(t);
  process.env.AGENT_PEERS_DEBUG = "1";
  logEvent("test", "tool.call", { method: "list_peers", outcome: "succeeded" });
  const config = loggingConfig(), file = join(config.location, readdirSync(config.location)[0]);
  const first = readFileSync(file, "utf8");
  appendFileSync(file, "x".repeat(config.maxFileBytes + 100));
  const external = join(dir, "private-file");
  writeFileSync(external, "never read my secret", { mode: 0o600 });
  const linked = join(config.location, `agent-peers-1-1-${randomUUID()}.jsonl`);
  symlinkSync(external, linked);
  const report = summarizeLogs();
  assert.equal(report.events, 1);
  assert.equal(report.truncatedFiles, 1);
  assert.equal(report.skippedFiles, 1);
  assert.ok(report.bytes <= config.maxFileBytes);
  assert.equal(report.corruptLines, 1);
  assert.ok(!JSON.stringify(report).includes("never read my secret"));
  assert.equal(lstatSync(file).size, Buffer.byteLength(first) + config.maxFileBytes + 100);
  assert.equal(lstatSync(linked).isSymbolicLink(), true);
});

test("concurrent default writers keep separate files and complete readable records", async (t) => {
  fixture(t);
  process.env.AGENT_PEERS_DEBUG = "1";
  const producers = Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ["--input-type=module", "-e", `import {logEvent} from ${JSON.stringify(modulePath)}; for(let i=0;i<40;i++) logEvent("test", "tool.call", {method:"list_peers",outcome:"succeeded"});`], { env: process.env });
    let stdout = "", stderr = "";
    proc.stdout.on("data", (data) => { stdout += data; });
    proc.stderr.on("data", (data) => { stderr += data; });
    proc.on("error", reject);
    proc.on("close", (status) => resolve({ status, stdout, stderr }));
  }));
  for (const result of await Promise.all(producers)) assert.deepEqual(result, { status: 0, stdout: "", stderr: "" });
  const report = summarizeLogs();
  assert.equal(report.files, 4);
  assert.equal(report.events, 160);
  assert.equal(report.corruptLines, 0);
  assert.equal(report.tools.list_peers.calls, 160);
});

test("CLI log summary and doctor do not create state even when logging is enabled", (t) => {
  const dir = fixture(t);
  const env = { ...process.env, AGENT_PEERS_DEBUG: "1", CLAUDE_CONFIG_DIR: join(dir, "claude"), AGENT_PEERS_CODEX_APP_SERVER: join(dir, "missing.sock") };
  for (const command of ["logs", "doctor"]) {
    const result = spawnSync(process.execPath, [cli, command, "--json"], { env, encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    const report = JSON.parse(result.stdout);
    assert.equal(command === "logs" ? report.config.enabled : report.logging.enabled, true);
  }
  assert.deepEqual(readdirSync(dir), []);
});
