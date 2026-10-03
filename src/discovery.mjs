// Discovery describes routes from the caller's point of view. A Codex thread UUID alone
// does not make it a native send_message target: it must belong to the caller's agent tree.

export function codexDiscovery(peers, threads, self) {
  const loaded = new Map(threads.map((t) => [t.id, t]));
  const rows = new Map();
  for (const p of peers) {
    if (self && (p.threadId === self.threadId || (self.address && p.address === self.address))) continue;
    const t = loaded.get(p.threadId);
    const sameTree = self && (p.threadId === self.rootId || t?.sessionId === self.rootId);
    rows.set(p.threadId || p.address, {
      name: p.name, kind: p.kind, cwd: p.cwd, status: t?.status?.type ?? p.status,
      threadId: p.threadId,
      native: { reachable: !self || sameTree ? null : false, reason: !self ? "caller session unknown"
        : sameTree ? "native target unavailable; check list_agents"
        : p.kind === "claude" ? "Claude recipient" : "separate Codex session" },
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
      kind: "codex", cwd: t.cwd, status: t.status?.type, threadId: t.id,
      native: { reachable: true, tool: "send_message", target },
      // Inbox addresses belong to roots; do not present the root's inbox as a way to
      // deliver directly to one of its subagents.
      bridge: old?.bridge ?? null,
    });
  }
  return [...rows.values()];
}

export function formatCodexPeer(p) {
  const native = p.native.reachable === true
    ? `yes — ${p.native.tool} ${JSON.stringify({ target: p.native.target })}`
    : `${p.native.reachable === false ? "no" : "unknown"} (${p.native.reason})`;
  const bridge = p.bridge ? `${p.bridge.tool} ${JSON.stringify({ to: p.bridge.to })}` : "none (use native messaging)";
  return `${p.name}  ${p.status ?? ""}  cwd=${p.cwd}\n  native: ${native}\n  bridge: ${bridge}`;
}

// The CLI is also used outside Codex, where there is no caller thread to compare.
// Name the platform explicitly rather than implying Claude's SendMessage is a Codex tool.
export function formatSessionPeer(p) {
  return `${p.name}  ${p.status ?? ""}  cwd=${p.cwd}\n` +
    `  Claude native: SendMessage ${JSON.stringify({ to: p.address })}\n` +
    `  Codex bridge: send_peer ${JSON.stringify({ to: p.address })}`;
}
