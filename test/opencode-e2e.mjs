// End-to-end deterministic opencode tests: the real plugin, the real stdio bridge child, the real
// registry/inbox/names code, and a fake opencode host in this process. No opencode binary and no
// model turn are involved.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import plugin from "../opencode/server.mjs";
import { post, peerSocket } from "../src/wire.mjs";
import { opencodeFixture, peerLine, session, until, FakeHost } from "./opencode-host.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bridge = join(root, "bin", "agent-peers.mjs");
const KEY = Symbol.for("agent-peers.opencode.bridge.v1");

function context(dir, host) {
  const ctx = {
    location: { directory: join(dir, "repo") },
    options: { bridge_command: [process.execPath, bridge, "opencode-bridge"] },
    tools: [], synth: [],
    session: {
      get: async ({ sessionID } = {}) => {
        const info = host.sessions.get(sessionID);
        if (!info) throw Object.assign(new Error(`session ${sessionID} not found`), { _tag: "SessionNotFoundError", sessionID });
        return info;
      },
      synthetic: async (params) => { ctx.synth.push(params); return { admitted: true }; },
    },
    tool: {
      transform(fn) {
        const tools = [];
        fn({ add: (definition) => tools.push(definition) });
        ctx.tools = tools;
        return Promise.resolve({ dispose() {} });
      },
    },
    event: {
      subscribe({ signal } = {}) {
        let queue = [], waiting = [], ended = false;
        const close = () => {
          if (ended) return;
          ended = true;
          for (const resolve of waiting) resolve({ done: true, value: undefined });
          waiting = [];
        };
        signal?.addEventListener("abort", close, { once: true });
        if (signal?.aborted) close();
        const iterator = {
          next() {
            if (queue.length) return Promise.resolve({ done: false, value: queue.shift() });
            if (ended) return Promise.resolve({ done: true, value: undefined });
            return new Promise((resolve) => waiting.push(resolve));
          },
          return() { close(); return Promise.resolve({ done: true, value: undefined }); },
        };
        ctx.emit = (event) => {
          if (ended) return;
          const waiter = waiting.shift();
          if (waiter) waiter({ done: false, value: event });
          else queue.push(event);
        };
        return { [Symbol.asyncIterator]() { return iterator; } };
      },
    },
  };
  return ctx;
}

test("the real plugin and bridge list, claim, send, receive and clean up through one child", { timeout: 60_000 }, async (t) => {
  const f = opencodeFixture(t);
  const host = new FakeHost();
  host.add(session({ id: "ses_root", directory: join(f.dir, "repo"), title: "Root", updated: 1, idle: 1 }));
  host.add(session({ id: "ses_two", directory: join(f.dir, "repo-two"), title: "Two", updated: 1, idle: 1 }));
  const first = context(f.dir, host), second = context(f.dir, host);
  const closeFirst = await plugin.setup(first);
  const closeSecond = await plugin.setup(second);
  t.after(async () => {
    await closeFirst(); await closeSecond();
    delete globalThis[KEY];
  });
  // A prompt event binds before any tool call.
  first.emit({ type: "session.inbox.enqueued", data: { sessionID: "ses_root", item: { type: "user" } } });
  await until(() => existsSync(join(f.peers, "opencode-ses_root.json")), "the prompt bind");
  const listed = await first.tools.find((tool) => tool.name === "list_peers").execute({}, { sessionID: "ses_root" });
  assert.equal(listed.metadata.isError, false, listed.content[0].text);
  const self = listed.metadata.structuredContent.self;
  assert.equal(self.threadId, "ses_root");
  assert.equal(self.sessionID, "ses_root");
  assert.match(self.name, /^opencode:repo-[a-f0-9]{6}$/);
  const record = JSON.parse(readFileSync(join(f.peers, "opencode-ses_root.json"), "utf8"));
  assert.equal(record.address, self.address);
  assert.equal(record.pid, globalThis[KEY].client.pid, "the record names the bridge child");
  const pid = globalThis[KEY].client.pid;
  // A second instance joins the same child.
  const listedTwo = await second.tools[0].execute({}, { sessionID: "ses_two" });
  assert.equal(listedTwo.metadata.isError, false, listedTwo.content[0].text);
  assert.equal(globalThis[KEY].client.pid, pid, "one bridge child per server process");
  assert.equal(existsSync(join(f.peers, "opencode-ses_two.json")), true);
  // Claim through the real bridge.
  const claimed = await first.tools.find((tool) => tool.name === "claim_name").execute({ name: "proj/lead" }, { sessionID: "ses_root" });
  assert.equal(claimed.metadata.structuredContent.status, "claimed");
  assert.equal(claimed.metadata.structuredContent.generation, self.generation);
  // A peer sends by the claimed name; the bridge admits and delivers through synthetic.
  const sender = await f.peer("sender");
  const line = peerLine(sender.address, "hello over the real bridge", { toName: "opencode:proj/lead", receipts: ["queued", "accepted"] });
  await post(peerSocket(self.address), line);
  await until(() => sender.lines.some((l) => l.type === "control" && l.status === "accepted"), "the real-bridge acceptance");
  assert.equal(first.synth.length, 1);
  assert.match(first.synth[0].text, /peer_message from="claude:sender"/);
  // A real send reaches the peer inbox from the root address.
  const target = await f.peer("target");
  const sent = await first.tools.find((tool) => tool.name === "send_peer").execute({ to: target.address, message: "outbound" }, { sessionID: "ses_root" });
  assert.equal(sent.metadata.isError, false, sent.content[0].text);
  await until(() => target.lines.length === 1, "the outbound line");
  assert.ok(target.lines[0].message.content.includes(`from="${self.address}"`));
  // Closing both instances removes both records and sockets and stops the child.
  await closeFirst();
  await closeSecond();
  await until(() => globalThis[KEY]?.client === null, "the child to stop");
  assert.equal(existsSync(join(f.peers, "opencode-ses_root.json")), false);
  assert.equal(existsSync(join(f.peers, "opencode-ses_two.json")), false);
});

test("a staged revert through the real bridge drops host-rejected and leaves the revert untouched", async (t) => {
  const f = opencodeFixture(t);
  const host = new FakeHost();
  const info = host.add(session({ id: "ses_root", directory: join(f.dir, "repo"), updated: 1, idle: 1 }));
  info.revert = { messageID: "staged" };
  const ctx = context(f.dir, host);
  const close = await plugin.setup(ctx);
  t.after(async () => { await close(); delete globalThis[KEY]; });
  const listed = await ctx.tools[0].execute({}, { sessionID: "ses_root" });
  const self = listed.metadata.structuredContent.self;
  const sender = await f.peer("revert-sender");
  await post(peerSocket(self.address), peerLine(sender.address, "must drop", { receipts: ["queued", "accepted"] }));
  await until(() => sender.lines.some((l) => l.type === "control" && l.status === "dropped"), "the revert drop");
  assert.equal(sender.lines.find((l) => l.status === "dropped").drop_reason, "host-rejected");
  assert.deepEqual(info.revert, { messageID: "staged" });
  assert.deepEqual(info.texts, []);
  assert.equal(host.count("host.synthetic"), 0);
});
