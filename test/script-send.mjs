// `agent-peers send`: one-way notices from scripts, from a temporary inbox that exists only for
// the receipt window. The fake Claude sessions here are a live process with a registry record and
// a socket that reads lines and can answer with Claude's receipts.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { claim, claudeClaimant } from "../src/names.mjs";
import { receiptLine } from "../src/status.mjs";
import { MAX_LINE, address, claudeSessionAt, messageLine, parseEnvelope, post, processStart, readLines, socketPath } from "../src/wire.mjs";

const cli = fileURLToPath(new URL("../bin/agent-peers.mjs", import.meta.url));
const NAME = "claude:gladiator-game/director";
const BODY = "story-event 3f2a story-7 queued->running run-1 started\nresult: /tmp/run-1.md\nDiscussion: hermes:gaming/gladiator";

function fixture(t) {
  const dir = mkdtempSync(join(realpathSync("/tmp"), "ap-send-"));
  const claude = join(dir, "claude"), peers = join(dir, "peers"), sockets = join(dir, "s");
  for (const path of [join(claude, "sessions"), sockets]) mkdirSync(path, { recursive: true, mode: 0o700 });
  const env = { CLAUDE_CONFIG_DIR: claude, AGENT_PEERS_HOME: peers };
  const before = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, AGENT_PEERS_HOME: process.env.AGENT_PEERS_HOME };
  Object.assign(process.env, env);
  const cleanup = [];
  t.after(async () => {
    for (const step of cleanup.reverse()) await step();
    for (const [key, value] of Object.entries(before)) value === undefined ? delete process.env[key] : process.env[key] = value;
    rmSync(dir, { recursive: true, force: true });
  });
  // A Claude session: its own process, a registry record with its start, and an inbox socket that
  // records every line and answers a message with `answer(line)`'s receipt, if any.
  const session = async (name, { answer, server: options = {} } = {}) => {
    const child = spawn("sleep", ["60"], { stdio: "ignore" });
    await once(child, "spawn");
    const socket = join(sockets, `${name}.sock`), lines = [], connections = [];
    const server = createServer(options, (conn) => {
      connections.push(conn);
      readLines(conn, (line) => {
        lines.push(line);
        const receipt = line?.type === "user" && answer?.(line);
        if (receipt) post(socketPath(line.from), receiptLine({ from: address(socket), ids: [line.msg_id], ...receipt })).catch(() => {});
      });
    });
    server.listen(socket);
    await once(server, "listening");
    writeFileSync(join(claude, "sessions", `${child.pid}.json`), JSON.stringify({ pid: child.pid, name, messagingSocketPath: socket,
      procStart: processStart(child.pid) }));
    const stop = async () => {
      if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }
      for (const conn of connections) conn.destroy();
      if (server.listening) await new Promise((resolve) => server.close(resolve));
    };
    cleanup.push(stop);
    return { child, socket, address: address(socket), lines, connections, stop, claimant: () => claudeClaimant(claudeSessionAt(child.pid)) };
  };
  // Run `agent-peers send` with `body` on stdin. `detached` puts it in a session of its own
  // (setsid), with no agent in its ancestry, as a job a script started and left running does.
  const send = (args, body = BODY, { detached = false, onSpawn } = {}) => new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, "send", ...args], { env: { ...process.env, ...env }, detached, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.stdin.on("error", () => {});
    child.stdin.end(body);
    onSpawn?.(child);
    child.on("close", (status, signal) => resolve({ status, signal, stdout, stderr, json: (() => { try { return JSON.parse(stdout); } catch { return undefined; } })() }));
  });
  const leftovers = () => readdirSync(sockets).filter((file) => !file.endsWith(".sock") || file.startsWith("script-") || file.startsWith(".ap-"));
  return { dir, sockets, env, session, send, leftovers };
}

test("a detached script reaches a claimed Claude name one way, as script:<label>, and leaves no inbox behind", async (t) => {
  const f = fixture(t), director = await f.session("director");
  assert.equal(claim(NAME, director.claimant()).status, "claimed");
  const result = await f.send([NAME, "--stdin", "--label", "gladiator", "--json"], BODY + "\n", { detached: true });
  assert.equal(result.status, 0, result.stderr);
  const { message_id: id, from, text, ...rest } = result.json;
  assert.deepEqual(rest, { status: "unconfirmed", reason: "no-receipt", in_reply_to: null, to: director.address, name: NAME,
    generation: director.claimant().generation, outcome: "sent", reply: false });
  assert.match(from, new RegExp(`^uds:${f.sockets}/script-[0-9a-f]{32}\\.sock$`), "a temporary address beside the target's inbox");
  assert.match(text, /Claude reports only held or dropped messages/);
  assert.equal(director.lines.length, 1);
  const [line] = director.lines, envelope = parseEnvelope(line.message.content);
  assert.deepEqual([line.msg_id, line.from, envelope.from, envelope.fromName], [id, from, from, "script:gladiator"]);
  assert.equal(line.agent_peers.to_name, NAME, "a holder that checks names can tell the name was used");
  assert.ok(envelope.body.startsWith(`${BODY}\n\n(One-way notice from script:gladiator, sent with agent-peers send. Replying to its address does nothing;`),
    "the body is kept as given, without the trailing newline, and the footer follows it");
  assert.deepEqual(f.leftovers(), [], "the temporary inbox is gone once the command exits");

  // Without --json the text goes to stdout; without --label the sender is plain "script".
  const plain = await f.send([director.address, "--stdin"], "ping");
  assert.deepEqual([plain.status, plain.stderr], [0, ""]);
  assert.match(plain.stdout, /^Sent to /);
  assert.equal(parseEnvelope(director.lines[1].message.content).fromName, "script");
});

test("Claude's receipts map to sent, retry and rejected, with exit codes 0, 3 and 1", async (t) => {
  const f = fixture(t);
  const cases = [
    [{ status: "held" }, "held", "sent", 0],
    [{ status: "dropped", reason: "rate-limited" }, "dropped", "retry", 3],
    [{ status: "dropped", reason: "queue-full" }, "dropped", "retry", 3],
    [{ status: "dropped", reason: "not-a-reply-target" }, "dropped", "rejected", 1],
    [{ status: "denied" }, "denied", "rejected", 1],
    [{ status: "dropped", reason: "inbox-closed" }, "dropped", "unreachable", 4],
  ];
  for (const [receipt, status, outcome, exit] of cases) {
    const target = await f.session(`t${cases.findIndex((c) => c[0] === receipt)}`, { answer: () => receipt });
    const result = await f.send([target.address, "--stdin", "--json"]);
    assert.deepEqual([result.status, result.json.status, result.json.outcome], [exit, status, outcome], JSON.stringify(receipt));
    assert.equal(result.json.reason, receipt.reason ?? null);
    assert.equal(target.lines.length, 1, "written exactly once; nothing is retried");
  }
  assert.deepEqual(f.leftovers(), []);
});

test("a name whose holder is not running, or that nobody claimed, is unreachable (exit 4) and nothing is written", async (t) => {
  const f = fixture(t), director = await f.session("director");
  assert.equal(claim(NAME, director.claimant()).status, "claimed");
  await director.stop();
  const stopped = await f.send([NAME, "--stdin", "--json"]);
  assert.deepEqual([stopped.status, stopped.json.status, stopped.json.reason, stopped.json.outcome, stopped.json.message_id],
    [4, "failed", "not-running", "unreachable", null]);
  const missing = await f.send(["claude:gladiator-game/nobody", "--stdin", "--json"]);
  assert.deepEqual([missing.status, missing.json.reason, missing.json.outcome], [4, "not-found", "unreachable"]);
  // A live session whose socket is gone: the write itself finds nobody listening.
  const gone = await f.session("gone");
  rmSync(gone.socket);
  const refused = await f.send([gone.address, "--stdin", "--json"]);
  assert.deepEqual([refused.status, refused.json.reason, refused.json.outcome], [4, "not-running", "unreachable"]);
  assert.equal(director.lines.length + gone.lines.length, 0);
  assert.deepEqual(f.leftovers(), []);
});

test("a write that times out is uncertain (exit 5): it may have arrived, so the text says not to resend blindly", { timeout: 30_000 }, async (t) => {
  const f = fixture(t);
  // The inbox accepts the connection but never reads; the line is larger than any socket buffer.
  const stalled = await f.session("stalled", { server: { pauseOnConnect: true } });
  const result = await f.send([stalled.address, "--stdin", "--json"], "x".repeat(MAX_LINE - 4096));
  assert.deepEqual([result.status, result.json.status, result.json.reason, result.json.outcome], [5, "failed", "write-timeout", "uncertain"]);
  assert.match(result.json.text, /did not accept the message within 5 s\. It may still have arrived, so it is not retried; ask the recipient before sending it again\./);
  assert.doesNotMatch(result.json.text, /was not delivered/, "regression: a timed-out write is never reported as certainly undelivered");
  assert.deepEqual(f.leftovers(), []);
});

test("a reply that reaches the temporary inbox gets dropped/inbox-closed instead of waiting for nobody", async (t) => {
  const f = fixture(t);
  let target;
  target = await f.session("chatty", {
    answer: (line) => {
      const reply = messageLine({ from: target.address, fromName: "chatty", body: "thanks" });
      post(socketPath(line.from), reply).catch(() => {});
      target.replyId = reply.msg_id;
    },
  });
  const result = await f.send([target.address, "--stdin", "--json"]);
  assert.equal(result.json.outcome, "sent");
  for (let i = 0; i < 100 && target.lines.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 20));
  const receipt = target.lines.find((line) => line.type === "control");
  assert.deepEqual([receipt?.action, receipt?.status, receipt?.drop_reason, receipt?.orig_msg_id, receipt?.from],
    ["peer_message_status", "dropped", "inbox-closed", target.replyId, result.json.from]);
  assert.deepEqual(f.leftovers(), []);
});

test("SIGTERM during the receipt window removes the temporary inbox", async (t) => {
  const f = fixture(t), target = await f.session("quiet");
  const result = await f.send([target.address, "--stdin", "--json"], BODY, {
    onSpawn: async (child) => {
      for (let i = 0; i < 200 && !target.lines.length; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(readdirSync(f.sockets).filter((file) => file.startsWith("script-")).length, 1, "the inbox exists during the window");
      child.kill("SIGTERM");
    },
  });
  assert.deepEqual([result.status, result.stdout], [143, ""]);
  assert.equal(target.lines.length, 1);
  assert.deepEqual(f.leftovers(), []);
});

test("usage errors exit 2 and an oversized stdin is refused unsent", async (t) => {
  const f = fixture(t), target = await f.session("target");
  for (const args of [[target.address], [target.address, "--stdin", "--label"], [target.address, "--stdin", "--label", "claude:proj"],
    [target.address, "--stdin", "--label", "Gladiator"], [target.address, "--stdin", "--stdin"], [target.address, "--stdin", "--reply-to", "x"],
    [target.address, "other", "--stdin"], ["--stdin"]]) {
    const result = await f.send(args);
    assert.equal(result.status, 2, args.join(" "));
    assert.doesNotMatch(result.stderr, /\n\s+at /);
  }
  const empty = await f.send([target.address, "--stdin", "--json"], " \n\n");
  assert.deepEqual([empty.status, empty.json.reason], [2, "invalid-request"]);
  const huge = await f.send([target.address, "--stdin", "--json"], "x".repeat(MAX_LINE + 1));
  assert.deepEqual([huge.status, huge.json.status, huge.json.reason, huge.json.outcome], [1, "failed", "too-large", "rejected"]);
  assert.equal(target.lines.length, 0);
  assert.deepEqual(f.leftovers(), []);
});
