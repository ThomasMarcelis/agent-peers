// A fake opencode bridge for plugin-adapter tests. It speaks the v1 JSON-lines protocol, records
// every message it sees, and can call back into the plugin with host.session/host.synthetic. It
// never touches the registry, names or sockets: the real bridge is covered by test/opencode-*.mjs.
import { appendFileSync, existsSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};
const logPath = option("--log");
const mode = option("--mode", "echo");
const version = option("--version", "1.0.0-rc.6");
const crashFile = option("--crash-file");
const child = `${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
const write = (message) => process.stdout.write(JSON.stringify({ v: 1, ...message }) + "\n");
const record = (message) => appendFileSync(logPath, JSON.stringify({ _child: child, ...message }) + "\n");
record({ boot: true, mode });

let sequence = 0, buffer = "";
const pending = new Map();
const request = (method, params) => new Promise((resolve) => {
  const id = `b-${++sequence}`;
  pending.set(id, resolve);
  write({ id, method, params });
});

const handle = async (message) => {
  if (message.id && String(message.id).startsWith("b-")) {
    const resolve = pending.get(message.id);
    if (resolve) { pending.delete(message.id); resolve(message); }
    return;
  }
  if (!message.id && message.method === "event") {
    if (mode === "crash-event" && message.params?.type === "closed") process.exit(0);
    return;
  }
  if (message.method === "hello") {
    write({ id: message.id, result: { v: 1, version, limits: { roots: 64 } } });
    return;
  }
  if (message.method === "tool") {
    if (mode === "crash" || (mode === "crash-once" && crashFile && !existsSync(crashFile))) {
      if (crashFile) writeFileSync(crashFile, "crashed");
      process.exit(3);
    }
    if (mode === "host-session") {
      const answer = await request("host.session", { instance: message.params.instance, sessionID: message.params.sessionID });
      write({ id: message.id, result: { text: `host:${answer.result?.id}`, structuredContent: answer.result, isError: false } });
      return;
    }
    if (mode === "host-synthetic") {
      const answer = await request("host.synthetic", {
        instance: message.params.instance, sessionID: message.params.sessionID, text: "synthetic from bridge",
        delivery: "steer", resume: true, description: "agent-peers peer message", metadata: { source: "agent-peers" },
      });
      write({ id: message.id, result: { text: JSON.stringify(answer), structuredContent: answer, isError: false } });
      return;
    }
    if (mode === "host-fail") {
      const answer = await request("host.session", { instance: message.params.instance, sessionID: message.params.sessionID });
      write({ id: message.id, result: { text: JSON.stringify(answer), structuredContent: answer, isError: false } });
      return;
    }
    write({ id: message.id, result: { text: "echo", structuredContent: { status: "failed", reason: "invalid-request" }, isError: true } });
    return;
  }
  write({ id: message.id, error: { code: "unknown-method", message: "unknown method" } });
};

process.stdin.setEncoding("utf8");
process.stdin.on("data", (data) => {
  buffer += data;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const raw = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!raw.trim()) continue;
    let message;
    try { message = JSON.parse(raw); } catch { continue; }
    record(message);
    handle(message).catch((error) => {
      record({ handlerError: error.message });
      if (message.id) write({ id: message.id, error: { code: "host-rejected", message: error.message } });
    });
  }
});
process.stdin.on("end", () => process.exit(0));
