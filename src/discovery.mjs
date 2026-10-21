// Discovery describes routes from the caller's point of view. A Codex thread UUID alone
// does not make it a native send_message target: it must belong to the caller's agent tree.
import { observeStatus, observeTurn, statusFields } from "./codex-status.mjs";

function threadEvidence(t) {
  if (!t) return {};
  let data = observeStatus({}, t.status, "thread/read", t.statusObservedAt ?? Date.now());
  for (const turn of t.turns ?? []) data = observeTurn(data, turn, "thread/turns/list", t.statusObservedAt ?? Date.now());
  return data;
}

// The reason a non-native peer has no native route. The label follows the peer's kind, never
// "everything that is not Codex": Hermes and opencode rows have distinct recipients, and an
// unknown future kind stays a plain separate session.
const ROUTE_REASON = {
  claude: "Claude recipient",
  codex: "separate Codex session",
  hermes: "Hermes recipient",
  opencode: "opencode recipient",
};
export const routeReason = (kind) => ROUTE_REASON[kind] ?? "separate session";

export function codexDiscovery(peers, threads, self) {
  const loaded = new Map(threads.map((t) => [t.id, t]));
  const rows = new Map();
  for (const p of peers) {
    if (self && (p.threadId === self.threadId || (self.address && p.address === self.address))) continue;
    const t = loaded.get(p.threadId);
    const sameTree = self && (p.threadId === self.rootId || t?.sessionId === self.rootId);
    rows.set(p.threadId || p.address, {
      name: p.name, kind: p.kind, cwd: p.cwd, status: p.status ?? t?.status?.type,
      ...threadEvidence(t), ...statusFields(p),
      threadId: p.threadId, generation: p.generation ?? null, claims: p.claims ?? [],
      native: { reachable: !self || sameTree ? null : false, reason: !self ? "caller session unknown"
        : sameTree ? "native target unavailable; check list_agents"
        : routeReason(p.kind) },
      // A subagent sends under its root inbox, so send_peer cannot target that same inbox.
      bridge: self && p.threadId === self.rootId ? null : { tool: "send_peer", to: p.address },
    });
  }
  if (!self) return [...rows.values()];

  for (const t of threads) {
    if (t.id === self.threadId || t.sessionId !== self.rootId || t.status?.type === "notLoaded") continue;
    const target = t.id === self.rootId ? "/root" : t.source?.subAgent?.thread_spawn?.agent_path;
    const old = rows.get(t.id);
    if (!target) {
      if (old) old.native = { reachable: null, reason: "native target unavailable; check list_agents" };
      continue;
    }
    rows.set(t.id, {
      name: old?.name ?? `codex:${t.agentNickname || target}`,
      kind: "codex", cwd: t.cwd, status: t.status?.type, threadId: t.id, generation: old?.generation ?? null, claims: old?.claims ?? [],
      ...statusFields(old), ...threadEvidence(t),
      native: { reachable: true, tool: "send_message", target },
      // Inbox addresses belong to roots; do not present the root's inbox as a way to
      // deliver directly to one of its subagents.
      bridge: old?.bridge ?? null,
    });
  }
  return [...rows.values()];
}

// Explain a route mismatch without sending anything or treating a nickname as a bridge
// address. Exact names, native targets and thread ids only, matched against all discovered
// peers, so a fragment never points at one native agent.
export function nativeRouteError(to, peers) {
  if (typeof to !== "string" || !to || to.startsWith("uds:")) return null;
  const matches = peers.filter((p) => p.name === to || p.name === `codex:${to}` || p.name === `claude:${to}` ||
    p.native?.target === to || p.threadId === to);
  if (matches.length !== 1) return null;
  const p = matches[0];
  if (p.native?.reachable !== true || !p.native.target || p.bridge) return null;
  const subagent = p.native.target !== "/root";
  let message = `${JSON.stringify(p.name)} is a native Codex ${subagent ? "subagent" : "agent"} without a bridge route; ` +
    `send_peer cannot address it. Use native ${p.native.tool} ${JSON.stringify({ target: p.native.target })}.`;
  if (p.status === "idle") {
    message += subagent
      ? ` It is idle; use native followup_task ${JSON.stringify({ target: p.native.target })} to start a turn; send_message only queues a message.`
      : " Native send_message does not start an idle turn for the root agent.";
  }
  if (subagent) message += " Direct app-server input, including codex_tui.send_message_to_thread, is unsupported for subagents.";
  return message;
}

export function formatCodexPeer(p) {
  const native = p.native.reachable === true
    ? `yes — ${p.native.tool} ${JSON.stringify({ target: p.native.target })}`
    : `${p.native.reachable === false ? "no" : "unknown"} (${p.native.reason})`;
  const subagent = p.native.reachable === true && p.native.target !== "/root";
  const bridge = p.bridge ? `${p.bridge.tool} ${JSON.stringify({ to: p.bridge.to })}`
    : subagent ? "none (use native messaging; send_peer and direct app-server input cannot target this subagent)"
    : p.native.reachable === true ? "none (use native messaging)" : "none (check list_agents for a native target)";
  const wake = subagent && p.status === "idle"
    ? `\n  start idle turn: followup_task ${JSON.stringify({ target: p.native.target })} (send_message only queues a message)` : "";
  const claims = p.claims?.length ? `\n  claimed names: ${p.claims.join(", ")}` : "";
  return `${p.name}  ${formatPeerStatus(p)}  cwd=${p.cwd}\n  native: ${native}\n  bridge: ${bridge}${wake}${claims}`;
}

// The CLI is also used outside Codex, where there is no caller thread to compare.
// Name the platform explicitly rather than implying Claude's SendMessage is a Codex tool.
export function formatSessionPeer(p) {
  // Claude and Codex rows keep the rc.4 bytes, including the four-space gap when there is no status;
  // opencode rows join only the fields present, so they never carry a doubled gap.
  const stale = p.reachable === false ? "  stale" : "";
  const activity = formatPeerStatus(p);
  const status = [activity, p.reachable === false ? "stale" : ""].filter(Boolean).join("  ");
  const head = p.kind === "opencode"
    ? `${p.name}${status ? `  ${status}` : ""}  cwd=${p.cwd}\n`
    : `${p.name}  ${activity}${stale}  cwd=${p.cwd}\n`;
  const staleLine = p.reachable === false ? "  stale: the socket refused a connection; the record is kept\n" : "";
  const claims = p.claims?.length ? `  claimed names: ${p.claims.join(", ")}\n` : "";
  if (p.kind === "opencode") {
    return head + staleLine + claims + `  OpenCode bridge: send_peer ${JSON.stringify({ to: p.address })}`;
  }
  return head + staleLine + claims +
    `  Claude native: SendMessage ${JSON.stringify({ to: p.address })}\n` +
    `  Codex bridge: send_peer ${JSON.stringify({ to: p.address })}`;
}

// A claimed name, from a Claude sender's side (the CLI) or a Codex or Hermes sender's (send_peer,
// which resolves the name itself). A Hermes holder accepts a Claude sender only after it ran resolve.
export function formatName(row, { sendPeer = false } = {}) {
  if (!row.running) return `${row.name}  not running  (its holder stopped; the new session must claim it)`;
  if (!row.address) return `${row.name}  running  (no inbox this session can reach: its holder uses a session registry or socket directory this session does not)`;
  if (sendPeer) return `${row.name}  running  send_peer ${JSON.stringify({ to: row.name })}`;
  if (row.kind === "hermes") return `${row.name}  running  agent-peers resolve ${row.name}, then SendMessage to the printed address`;
  return `${row.name}  running  SendMessage ${JSON.stringify({ to: row.address })}`;
}

const age = (at, now) => {
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 3600)}h`;
};
const clock = (at) => new Date(at).toISOString().slice(11, 16) + "Z";
const outcomeText = (turn) => turn ? `last turn ${turn.status} ${turn.completedAt ? clock(turn.completedAt) : `observed ${clock(turn.observedAt)}`}` +
  (turn.errorClass ? ` (${turn.errorClass})` : "") : "";

export function formatPeerStatus(p, now = Date.now()) {
  const fields = statusFields(p);
  if (!fields.statusObservedAt) return p.status ?? "";
  const label = { active: "busy", notLoaded: "not loaded", systemError: "system error" }[fields.status] ?? fields.status;
  return [`${label} · seen ${age(fields.statusObservedAt, now)} ago`, outcomeText(fields.lastTurn)].filter(Boolean).join(" · ");
}

export function formatNames(names, { allNames = false, sendPeer = false } = {}) {
  if (!names.length) return [];
  const shown = allNames ? names : names.filter((row) => row.running);
  const hidden = names.length - shown.length;
  return ["Claimed names:", ...shown.map((row) => `  ${formatName(row, { sendPeer })}`),
    ...(hidden ? [`  +${hidden} reserved names not running`] : [])];
}

export function formatExited(rows) {
  if (!rows.length) return [];
  return ["Recently exited Codex sidecars (last seen within 60m):", ...rows.map((p) =>
    `  ${p.name}  exit observed ${clock(p.exitObservedAt)}${p.lastTurn ? ` · ${outcomeText(p.lastTurn)}` : ""}`)];
}
