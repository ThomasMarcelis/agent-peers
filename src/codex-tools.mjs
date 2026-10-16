// The MCP side of codex-peer: list_peers and send_peer for the Codex session making each call.

import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { app, bind, inboxFor, ownsSocket, roots, serverInfo } from "./codex-binding.mjs";
import { outboxOf, pinsOf } from "./codex-inbox.mjs";
import { codexDiscovery, formatCodexPeer, nativeRouteError } from "./discovery.mjs";
import { coordinationGuidance } from "./guidance.mjs";
import { errorFields, logEvent, logIdentity } from "./logging.mjs";
import { Outbox, sendPeer } from "./outbox.mjs";
import { SendFailure, isError, sendResult, validMessageId } from "./status.mjs";
import { MAX_LINE, allPeers, codexPeers, inDiscoveryScope, peerSocket } from "./wire.mjs";

const log = (event, fields = {}) => logEvent("codex-peer", event, fields);
const code = (reason) => reason?.replaceAll("-", "_");
// Sends from a subagent whose root runs in another process: receipts reach that process instead.
const detached = new Outbox({ log });

// Claude Code frames every peer as "another Claude session", so tell Claude what this is, once
// per sending thread and recipient: the recipient keeps it in context. Recorded only once a send
// wrote something, so a failed first send does not use up the introduction.
const introduced = new Set();
const introduce = (key) => {
  if (introduced.size >= 4096) introduced.clear();
  introduced.add(key);
};

// The caller as peers see it: a subagent's address is its root's, where replies land.
function selfRow(caller) {
  if (!caller) return null;
  const root = caller.subagent ? roots.get(caller.rootId) : caller;
  const registered = root ? undefined : codexPeers().find((peer) => peer.threadId === caller.rootId);
  return {
    name: caller.name, kind: "codex", address: root?.address ?? registered?.address ?? null,
    addresses: root ? [...root.inboxes.values()].map((inbox) => inbox.address) : registered?.addresses ?? [],
    generation: root?.generation ?? registered?.generation ?? null, threadId: caller.threadId, subagent: caller.subagent,
  };
}

async function listPeers(caller) {
  let threads = [], note = "";
  if (caller) {
    try {
      // Only read live threads: thread/read can load a historical thread from disk.
      const ids = await app.loadedThreads();
      // A busy daemon may have hundreds of loaded agents; stay below the RPC pending
      // limit and avoid silently dropping every thread after the first 256.
      const results = [];
      for (let i = 0; i < ids.length; i += 16) {
        results.push(...await Promise.allSettled(ids.slice(i, i + 16).map((id) => app.readThread(id))));
      }
      threads = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
      if (results.some((r) => r.status === "rejected")) note = "Some native agents could not be read; check list_agents.";
    } catch (e) {
      note = `Native discovery unavailable: ${e.message}. Check list_agents.`;
    }
  }
  const peers = codexDiscovery(allPeers(), threads, caller);
  const self = inDiscoveryScope(() => selfRow(caller));
  const rows = peers.map(formatCodexPeer);
  return {
    // Worded as in 0.3.0; the caller's address is in structuredContent.self.
    text: [`You are ${caller?.name ?? "codex (not bound yet)"}.`,
      ...(rows.length ? rows : ["No other agents found."]),
      ...(peers.some((p) => p.native.reachable) ? ["Native send_message does not start an idle turn; followup_task can wake non-root agents."] : []),
      ...(note ? [note] : [])].join("\n"),
    peers, self,
    degraded: Boolean(note),
  };
}

async function send(caller, to, message, inReplyTo) {
  const root = caller.subagent ? roots.get(caller.rootId) : caller;
  if (!caller.subagent && !ownsSocket(caller)) {
    return { result: sendResult({ reason: "inbox-unavailable" }), text: "this inbox was replaced; restart this MCP connection" };
  }
  const rootRecord = () => codexPeers().find((peer) => peer.threadId === caller.rootId);
  let introducing;
  const out = await sendPeer({
    to, message, inReplyTo, pins: pinsOf(root, caller.rootId), fromName: caller.name, generation: root?.generation ?? rootRecord()?.generation,
    route: async (target) => {
      const directory = dirname(target.socket);
      if (caller.subagent) {
        const registered = rootRecord();
        const from = [registered?.address, ...(registered?.addresses ?? [])].find((addr) => addr && dirname(peerSocket(addr) ?? "") === directory);
        if (!from) {
          throw new SendFailure("inbox-unavailable",
            "your root Codex session has no inbox in this peer's directory; ask your root agent to call list_peers or send_peer first");
        }
        return { from, outbox: root ? outboxOf(root) : detached, receipts: Boolean(root), subagent: !root };
      }
      try { return { from: (await inboxFor(caller, directory)).address, outbox: outboxOf(caller) }; }
      catch (error) { throw new SendFailure("inbox-unavailable", error.message); }
    },
    introduction: (target) => {
      const key = `${caller.threadId}\0${target.address}`;
      if (introduced.has(key)) return undefined;
      introducing = key;
      return `(Codex CLI ${caller.subagent ? "subagent; replies reach root" : "peer"}; notify_when_idle unavailable.)`;
    },
  });
  // Claude saw the introduction only if the message was not refused or dropped.
  if (introducing && !isError(out.result.status)) introduce(introducing);
  if (out.result.reason === "not-found") {
    const hint = nativeRouteError(to, (await listPeers(caller)).peers);
    if (hint) Object.assign(out, { text: hint, result: { ...out.result, reason: "native-route-required" } });
  }
  return out;
}

export const mcp = new McpServer(
  serverInfo,
  {
    instructions:
      "Discover Claude Code and Codex CLI sessions on this machine with list_peers. This session's inbox " +
      "opens when it starts; list_peers also opens it if needed. Each result shows native reachability and the exact messaging target; " +
      `use a listed native route or send_peer inbox. ${coordinationGuidance} ` +
      "Incoming <peer_message> blocks identify the sender and a reply_to inbox address for send_peer. " +
      "Inbox addresses belong to sessions, so replies to subagents reach their root session.",
  },
);

mcp.registerTool(
  "list_peers",
  {
    description: "List local Claude Code and Codex peers, including your native Codex agents, with reachability and exact messaging targets.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async (_args, extra) => {
    const started = performance.now();
    const trace = { operationId: randomUUID(), method: "list_peers", threadId: logIdentity(extra._meta?.threadId) };
    log("tool.call", { ...trace, outcome: "started" });
    let note = "";
    const caller = await bind(extra._meta).catch((e) => {
      note = `\n(${e.message})`;
      log("inbox.bind", { ...trace, outcome: "failed", ...errorFields(e) });
    });
    const result = await listPeers(caller);
    if (caller) pinsOf(caller.subagent ? roots.get(caller.rootId) : caller, caller.rootId).noteRows(result.peers);
    log("tool.call", { ...trace, outcome: note || result.degraded ? "degraded" : "succeeded", count: result.peers.length,
      durationMs: performance.now() - started });
    return { content: [{ type: "text", text: result.text + note }], structuredContent: { peers: result.peers, self: result.self } };
  },
);

mcp.registerTool(
  "send_peer",
  {
    description:
      "Send to a listed peer name, inbox address, or incoming reply_to. Set in_reply_to to the id of the message you answer. " +
      coordinationGuidance,
    inputSchema: { to: z.string().min(1).max(1000), message: z.string().min(1).max(MAX_LINE), in_reply_to: z.string().max(128).optional() },
  },
  async ({ to, message, in_reply_to: inReplyTo }, extra) => {
    const started = performance.now();
    const trace = { operationId: randomUUID(), method: "send_peer", threadId: logIdentity(extra._meta?.threadId), targetId: logIdentity(to),
      bytes: Buffer.byteLength(message) };
    log("tool.call", { ...trace, outcome: "started" });
    let out;
    try {
      out = await send(await bind(extra._meta), to, message, inReplyTo);
    } catch (e) {
      // Binding failed (or an unexpected error): nothing was written.
      out = { result: sendResult({ reason: "inbox-unavailable", in_reply_to: validMessageId(inReplyTo) ? inReplyTo : null }), text: e.message };
      log("inbox.bind", { ...trace, outcome: "failed", ...errorFields(e) });
    }
    const { result, text } = out;
    if (result.message_id) {
      const sent = { ...trace, messageId: logIdentity(result.message_id), targetId: logIdentity(result.to) };
      if (result.status !== "failed") log("message.send", { ...sent, outcome: "inbox_written" });
      log("message.send", { ...sent, outcome: result.status === "unconfirmed" ? "receipt_unavailable" : result.status === "failed" ? "failed" : "receipt_received",
        reason: code(result.reason ?? result.status) });
    }
    log("tool.call", { ...trace, outcome: result.status === "failed" ? "failed" : isError(result.status) ? "rejected" : "succeeded",
      ...(result.status === "failed" ? { reason: code(result.reason) } : {}), durationMs: performance.now() - started });
    return { content: [{ type: "text", text }], structuredContent: result, ...(isError(result.status) ? { isError: true } : {}) };
  },
);
