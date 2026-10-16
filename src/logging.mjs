// Opt-in local diagnostics. Never pass message bodies, names, paths or raw errors.
// This module is independent of the transports so instrumentation cannot create
// connections, discover peers or interfere with their stdout protocols.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, parse } from "node:path";
import { VERSION } from "./version.mjs";

const FILE_BYTES = 1024 * 1024;
const TOTAL_BYTES = 16 * FILE_BYTES;
const FILE_COUNT = 32;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_LINE = 4096;
const uid = process.getuid?.();
const instanceId = randomUUID();
const installationId = createHash("sha256").update(new URL("../", import.meta.url).href).digest("hex").slice(0, 24);
const processFiles = new Map();
const lastPruned = new Map();
const reasons = new Set(["not_found", "ambiguous_target", "native_route_required", "subagent_input_forbidden", "timeout",
  "connection_closed", "permission_denied", "invalid_input", "rate_limit", "unknown", "malformed", "duplicate", "queue_full",
  "closed", "receipt_rejected", "self_send", "no_reply_route", "unloaded_thread", "unsafe_path", "replaced", "unsupported", "message_too_large",
  "connection_limit", "sender_limit", "queue_limit", "queue_bytes_limit", "malformed_envelope", "inbox_replaced", "app_server_unavailable", "held", "delivered",
  "rejected", "other_status", "unconfirmed", "idle_timeout", "frame_too_large", "invalid_json", "incomplete_frame"]);
const outcomes = new Set(["started", "succeeded", "failed", "success", "error", "warning", "held", "receipt_delivered",
  "rejected", "inbox_written", "emitted_to_host", "receipt_received", "queued", "dropped", "app_server_input_accepted",
  "skipped", "closed", "accepted", "bound", "unbound", "native_only", "degraded", "receipt_unavailable", "unreachable"]);
const methods = new Set(["list_peers", "send_peer", "close_session", "shutdown", "initialize", "initialized", "thread/loaded/list",
  "thread/read", "thread/resume", "turn/start", "turn/steer", "mcpServerStatus/list", "unknown"]);
const codes = new Set(["ENOENT", "EACCES", "EPERM", "ELOOP", "ENOTDIR", "EISDIR", "ENOSPC", "EDQUOT", "EROFS", "EMFILE",
  "ENFILE", "EPIPE", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ERR_SOCKET_CLOSED", "ERR_INVALID_ARG_TYPE",
  "-32700", "-32600", "-32601", "-32602", "-32603", "-32000", "NATIVE_ROUTE_REQUIRED"]);
const ids = new Set(["operationId", "messageId", "threadId", "rootId", "targetId", "sessionId"]);
const numbers = new Set(["durationMs", "bytes", "count", "nativeCount", "bridgeCount", "queueDepth"]);
const token = (value) => typeof value === "string" && /^[a-z][a-z0-9_.-]{0,63}$/.test(value);
const fileName = (value) => /^agent-peers-\d+-\d+-[a-f0-9-]{36}\.jsonl$/.test(value);
let warned = false;

function failure(reason = "unavailable") {
  const error = new Error("diagnostic logging unavailable");
  error.reason = reason;
  return error;
}

function warn() {
  if (warned) return;
  warned = true;
  try { process.stderr.write("agent-peers: diagnostic logging could not write an event; check the private destination and size limit. Messaging continues.\n"); } catch {}
}

// A stable pseudonym allows correlation across local processes. It is not
// anonymization: somebody who knows a candidate identity can hash it too.
export function logIdentity(value) {
  if (typeof value !== "string" || !value) return undefined;
  return `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

export function errorFields(error) {
  let code, message = "", reason;
  try {
    code = String(error?.code ?? "");
    message = typeof error?.message === "string" ? error.message.slice(0, 8192).toLowerCase() : "";
    if (reasons.has(error?.reason)) reason = error.reason;
  } catch {}
  if (!reason) {
    if (/direct app-server input.*(?:not allowed|forbidden)|multi-agent v2 sub-agents/.test(message)) reason = "subagent_input_forbidden";
    else if (code === "NATIVE_ROUTE_REQUIRED" || /native.*(?:messaging|route|send_message|followup_task)|use.*(?:send_message|followup_task)/.test(message)) reason = "native_route_required";
    else if (/inbox was replaced/.test(message)) reason = "replaced";
    else if (/embedded app-server|unloaded parent|unloaded thread/.test(message)) reason = "unloaded_thread";
    else if (/ambiguous|matches multiple|more than one peer/.test(message)) reason = "ambiguous_target";
    else if (["ENOENT", "ECONNREFUSED"].includes(code) || /no live peer|not found|no peer named/.test(message)) reason = "not_found";
    else if (code === "ETIMEDOUT" || /timed out|timeout|did not accept.*within/.test(message)) reason = "timeout";
    else if (["EACCES", "EPERM", "EROFS"].includes(code) || /permission denied|unsafe.*(?:directory|file|path|socket)/.test(message)) reason = "permission_denied";
    else if (["EPIPE", "ECONNRESET", "ERR_SOCKET_CLOSED"].includes(code) || /closed|disconnected/.test(message)) reason = "connection_closed";
    else if (/too many|rate.?limit|queue.*full/.test(message)) reason = "rate_limit";
    else if (["-32700", "-32600", "-32601", "-32602", "ERR_INVALID_ARG_TYPE"].includes(code) || /invalid|malformed|must be|expected|too large|own inbox/.test(message)) reason = "invalid_input";
    else reason = "unknown";
  }
  return { errorCode: codes.has(code) ? code : "unknown", reason };
}

// Read configuration only; doctor and logs must not create any directories.
export function loggingConfig() {
  const explicit = process.env.AGENT_PEERS_LOG || undefined;
  const location = explicit || join(process.env.AGENT_PEERS_HOME || join(homedir(), ".agent-peers"), "logs");
  const enabled = process.env.AGENT_PEERS_DEBUG !== "0" && (process.env.AGENT_PEERS_DEBUG === "1" || !!explicit);
  return Object.freeze({ enabled, mode: explicit ? "file" : "directory", location,
    valid: isAbsolute(location) && normalize(location) === location && !location.endsWith("/") && !/[\x00-\x1f\x7f]/.test(location),
    maxFileBytes: FILE_BYTES, maxFiles: explicit ? 1 : FILE_COUNT, maxTotalBytes: explicit ? FILE_BYTES : TOTAL_BYTES,
    retentionDays: explicit ? null : 7 });
}

function directory(path, create) {
  // Check every ancestor: O_NOFOLLOW alone only protects a file's last component.
  const root = parse(path).root;
  let current = root;
  for (const part of path.slice(root.length).split("/").filter(Boolean)) {
    current = join(current, part);
    let stat;
    try { stat = lstatSync(current); }
    catch (error) {
      if (!create || error.code !== "ENOENT") throw error;
      try { mkdirSync(current, { mode: 0o700 }); }
      catch (mkdirError) { if (mkdirError.code !== "EEXIST") throw mkdirError; }
      stat = lstatSync(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure("unsafe_path");
    // A root-owned sticky temp directory is safe as an ancestor, never as the destination.
    const stickyTemp = stat.uid === 0 && (stat.mode & 0o1000);
    if ((stat.mode & 0o022) && !stickyTemp) throw failure("unsafe_path");
    if (current === path && ((uid !== undefined && stat.uid !== uid) || (stat.mode & 0o077))) throw failure("unsafe_path");
  }
  if (path === root) throw failure("unsafe_path");
}

function checkFile(stat) {
  if (!stat.isFile() || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o077) || stat.nlink !== 1) throw failure("unsafe_path");
}

function safeFields(fields) {
  const result = {};
  if (!fields || typeof fields !== "object") return result;
  for (const [key, value] of Object.entries(fields)) {
    if (ids.has(key) && typeof value === "string" && value) {
      result[key] = /^(?:sha256:[a-f0-9]{24}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test(value)
        ? value : logIdentity(value);
    } else if (numbers.has(key) && typeof value === "number" && Number.isFinite(value) && value >= 0) {
      result[key] = Math.min(Number.MAX_SAFE_INTEGER, Math.round(value * 1000) / 1000);
    } else if ((key === "receipt" || key === "subagent") && typeof value === "boolean") result[key] = value;
    else if (key === "reason") result.reason = reasons.has(value) ? value : "unknown";
    else if (key === "outcome") result.outcome = outcomes.has(value) ? value : "unknown";
    else if (key === "method") result.method = methods.has(value) ? value : "unknown";
    else if (key === "errorCode") result.errorCode = codes.has(String(value)) ? String(value) : "unknown";
  }
  return result;
}

function filesIn(path) {
  return readdirSync(path).filter(fileName).flatMap((name) => {
    const file = join(path, name);
    try { const stat = lstatSync(file); checkFile(stat); return [{ file, stat }]; }
    catch { return []; }
  }).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs || a.file.localeCompare(b.file));
}

function summaryFiles(path) {
  return readdirSync(path).filter(fileName).flatMap((name) => {
    const file = join(path, name);
    try { return [{ file, modified: lstatSync(file).mtimeMs }]; }
    catch { return [{ file, modified: 0 }]; }
  }).sort((a, b) => b.modified - a.modified || a.file.localeCompare(b.file));
}

function prune(path, current) {
  let bytes = 0, count = 0;
  const files = filesIn(path).sort((a, b) => a.file === current ? -1 : b.file === current ? 1 : 0);
  for (const { file, stat } of files) {
    const keep = file === current || (Date.now() - stat.mtimeMs <= RETENTION_MS && count < FILE_COUNT && bytes + stat.size <= TOTAL_BYTES);
    if (keep) { count++; bytes += stat.size; }
    else {
      // Only our private, correctly named regular files are retention candidates.
      try { unlinkSync(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
}

export function logEvent(component, event, fields = {}) {
  try {
    const config = loggingConfig();
    if (!config.enabled) return false;
    if (!config.valid || !token(component) || !token(event)) throw failure("invalid_input");
    const line = Buffer.from(JSON.stringify({ schemaVersion: 1, time: new Date().toISOString(), pid: process.pid,
      version: VERSION, nodeVersion: process.version, instanceId, installationId,
      component, event, ...safeFields(fields) }) + "\n");
    if (line.length > MAX_LINE) throw failure("invalid_input");
    const dir = config.mode === "file" ? dirname(config.location) : config.location;
    directory(dir, true);
    let file = config.location, fd, rotated = false;
    if (config.mode === "directory") {
      file = processFiles.get(dir);
      if (file) {
        try {
          const stat = lstatSync(file); checkFile(stat);
          if (stat.size + line.length > FILE_BYTES) file = undefined;
        } catch (error) { if (error.code === "ENOENT") file = undefined; else throw error; }
      }
      if (!file) {
        file = join(dir, `agent-peers-${Date.now()}-${process.pid}-${randomUUID()}.jsonl`);
        fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        processFiles.set(dir, file);
        rotated = true;
      }
    }
    if (fd === undefined) fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      const stat = fstatSync(fd); checkFile(stat);
      // Explicit files are append-only across processes. Never rename or truncate
      // another process's destination. Concurrent final appends can overshoot the
      // ceiling by one bounded record per writer; subsequent events are dropped.
      if (stat.size + line.length > FILE_BYTES) throw failure("size_limit");
      if (writeSync(fd, line) !== line.length) throw failure();
    } finally { closeSync(fd); }
    if (config.mode === "directory" && (rotated || Date.now() - (lastPruned.get(dir) || 0) >= 10_000)) {
      prune(dir, file);
      lastPruned.set(dir, Date.now());
    }
    return true;
  } catch { warn(); return false; }
}

function readBounded(file, maxBytes) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd); checkFile(stat);
    const buffer = Buffer.alloc(Math.min(maxBytes, stat.size));
    let length = 0, count;
    while (length < buffer.length && (count = readSync(fd, buffer, length, buffer.length - length, null))) length += count;
    return { content: buffer.toString("utf8", 0, length), bytes: length, truncated: stat.size > maxBytes };
  } finally { closeSync(fd); }
}

const increment = (counts, value) => { counts[value] = (counts[value] || 0) + 1; };

export function summarizeLogs() {
  const config = loggingConfig();
  const report = { config, files: 0, bytes: 0, events: 0, corruptLines: 0, skippedFiles: 0, truncatedFiles: 0,
    firstEventAt: null, lastEventAt: null, byEvent: {}, outcomes: {}, reasons: {}, tools: {},
    delivery: { inboxWrites: 0, receipts: 0, appServerInputAccepted: 0, emittedToHost: 0 },
    operations: { started: 0, completed: 0, incomplete: 0 }, warnings: [],
    scope: "Retained agent-peers events only. Inbox writes, receipts, host emission and app-server input acceptance do not prove model read or reply. No token or billing usage is collected." };
  const operations = new Map();
  let files;
  try {
    if (!config.valid) throw failure("invalid_input");
    directory(config.mode === "file" ? dirname(config.location) : config.location, false);
    files = config.mode === "file" ? [{ file: config.location }] : summaryFiles(config.location);
  } catch (error) {
    if (error.code !== "ENOENT") report.warnings.push("Log destination is unavailable or unsafe.");
    return report;
  }
  for (const { file } of files) {
    if (report.files >= config.maxFiles || report.bytes >= config.maxTotalBytes) { report.skippedFiles++; continue; }
    let data;
    try { data = readBounded(file, Math.min(FILE_BYTES, config.maxTotalBytes - report.bytes)); }
    catch (error) { if (error.code !== "ENOENT") report.skippedFiles++; continue; }
    report.files++; report.bytes += data.bytes;
    if (data.truncated) report.truncatedFiles++;
    for (const line of data.content.split("\n")) {
      if (!line) continue;
      let record;
      try {
        if (Buffer.byteLength(line) > MAX_LINE) throw failure();
        record = JSON.parse(line);
        if (record?.schemaVersion !== 1 || !token(record.component) || !token(record.event) ||
            typeof record.time !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(record.time) || !Number.isFinite(Date.parse(record.time))) throw failure();
      } catch { report.corruptLines++; continue; }
      const { component, event, time } = record;
      const fields = safeFields(record);
      report.events++;
      if (!report.firstEventAt || time < report.firstEventAt) report.firstEventAt = time;
      if (!report.lastEventAt || time > report.lastEventAt) report.lastEventAt = time;
      increment(report.byEvent, `${component}.${event}`);
      if (fields.outcome) increment(report.outcomes, fields.outcome);
      if (fields.reason) increment(report.reasons, fields.reason);
      if (["tool.call", "tool.result"].includes(event) && fields.outcome !== "started") {
        const tool = report.tools[fields.method || "unknown"] ??= { calls: 0, outcomes: {} };
        tool.calls++; increment(tool.outcomes, fields.outcome || "unknown");
      }
      if (event === "message.send" && fields.outcome === "inbox_written") report.delivery.inboxWrites++;
      if ((event === "message.send" && fields.outcome === "receipt_received") || (event === "send.result" && fields.receipt)) report.delivery.receipts++;
      if (fields.outcome === "app_server_input_accepted") report.delivery.appServerInputAccepted++;
      if (fields.outcome === "emitted_to_host") report.delivery.emittedToHost++;
      if (fields.operationId && ["tool.call", "tool.request", "tool.result", "rpc.request", "message.send", "send.started", "send.result"].includes(event)) {
        const category = event.startsWith("tool.") ? "tool" : event.startsWith("send.") ? "send" : event;
        const key = `${component}:${category}:${fields.operationId}`;
        const state = operations.get(key) || { started: false, completed: false };
        if (fields.outcome === "started" || ["tool.request", "send.started"].includes(event)) state.started = true;
        else state.completed = true;
        operations.set(key, state);
      }
    }
  }
  for (const { started, completed } of operations.values()) {
    if (started) report.operations.started++;
    if (completed) report.operations.completed++;
    if (started && !completed) report.operations.incomplete++;
  }
  if (report.skippedFiles) report.warnings.push("Some files were unsafe, unavailable or beyond the read limit.");
  if (report.truncatedFiles) report.warnings.push("Oversized files were read only up to the byte limit.");
  if (report.corruptLines) report.warnings.push("Malformed or legacy text lines were skipped.");
  if (report.operations.incomplete) report.warnings.push("Incomplete operations may be in flight, interrupted or missing events outside retention.");
  return report;
}
