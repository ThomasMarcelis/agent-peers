// Runtime observations only. No item, prompt, message or free-form error text crosses this boundary.
// Protocol: Codex 0.163.0 generated ThreadStatus, Turn and CodexErrorInfo schemas.
export const RECENT_EXIT_MS = 60 * 60_000;
export const RECONCILE_MS = 15_000;
const ACTIVE_FLAGS = new Set(["waitingOnApproval", "waitingOnUserInput"]);
const STATUSES = new Set(["active", "idle", "notLoaded", "systemError", "unknown"]);
const SOURCES = new Set(["thread/read", "thread/status/changed", "thread/loaded/list", "app-server-unavailable"]);
const TURN_SOURCES = new Set(["thread/turns/list", "turn/started", "turn/completed"]);
const OUTCOMES = new Set(["completed", "failed", "interrupted"]);
const NOTIFICATIONS = new Set(["thread/status/changed", "turn/started", "turn/completed"]);
const ERRORS = new Set(["contextWindowExceeded", "sessionBudgetExceeded", "usageLimitExceeded", "rateLimitExceeded",
  "flexUnavailable", "serverOverloaded", "cyberPolicy", "misalignmentPolicyViolation", "tooManyDenials",
  "internalServerError", "unauthorized", "badRequest", "threadRollbackFailed", "sandboxError", "other"]);
const HTTP_ERRORS = ["httpConnectionFailed", "responseStreamConnectionFailed", "responseStreamDisconnected", "responseTooManyFailedAttempts"];
const snake = (s) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const time = (n) => Number.isSafeInteger(n) && n > 0 && n <= 8_640_000_000_000_000;
const runtimeTime = (n) => time(n) && time(n * 1000) ? n * 1000 : undefined;
const turnId = (s) => typeof s === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(s);
const flagsOf = (flags) => Array.isArray(flags) ? [...new Set(flags.filter((flag) => ACTIVE_FLAGS.has(flag)))] : [];

export function errorClass(info) {
  if (ERRORS.has(info)) return snake(info);
  if (!info || typeof info !== "object") return undefined;
  for (const key of HTTP_ERRORS) {
    if (!Object.hasOwn(info, key)) continue;
    const code = info[key]?.httpStatusCode;
    return Number.isInteger(code) && code >= 100 && code <= 599 ? `http_${code}` : snake(key);
  }
  return undefined;
}

// Also used when reading the registry: unknown future fields and malformed optional evidence
// never make a peer disappear, and arbitrary strings cannot become error classes or text.
export function statusFields(p) {
  const out = {};
  if (STATUSES.has(p?.status) && time(p.statusObservedAt) && SOURCES.has(p.statusSource)) {
    Object.assign(out, { status: p.status, statusObservedAt: p.statusObservedAt, statusSource: p.statusSource });
    const flags = p.status === "active" ? flagsOf(p.activeFlags) : [];
    if (flags.length) out.activeFlags = flags;
  }
  const a = p?.lastActivity;
  if (a && turnId(a.turnId) && time(a.at) && time(a.observedAt) && TURN_SOURCES.has(a.source) &&
      ["started", "completed"].includes(a.event) && ["runtime", "observed"].includes(a.timeSource)) {
    out.lastActivity = { turnId: a.turnId, at: a.at, observedAt: a.observedAt, source: a.source, event: a.event, timeSource: a.timeSource };
  }
  const t = p?.lastTurn;
  if (t && turnId(t.id) && OUTCOMES.has(t.status) && time(t.observedAt) && TURN_SOURCES.has(t.source)) {
    out.lastTurn = { id: t.id, status: t.status, observedAt: t.observedAt, source: t.source,
      ...(time(t.completedAt) ? { completedAt: t.completedAt } : {}) };
    const classes = [...ERRORS, ...HTTP_ERRORS].map(snake);
    if (t.status === "failed" && typeof t.errorClass === "string" &&
        (classes.includes(t.errorClass) || /^http_[1-5][0-9]{2}$/.test(t.errorClass))) {
      out.lastTurn.errorClass = t.errorClass;
    }
  }
  if (p?.turnOutcome?.status === "unknown" && p.turnOutcome.source === "thread/turns/list" && time(p.turnOutcome.observedAt)) {
    out.turnOutcome = { status: "unknown", source: "thread/turns/list", observedAt: p.turnOutcome.observedAt };
  }
  return out;
}

export function observeStatus(data, status, source, now) {
  if (!STATUSES.has(status?.type) || !SOURCES.has(source)) return data;
  const { activeFlags, ...rest } = data;
  const flags = status.type === "active" ? flagsOf(status.activeFlags) : [];
  return { ...rest, status: status.type, statusObservedAt: now, statusSource: source,
    ...(flags.length ? { activeFlags: flags } : {}) };
}

// Status and turn history are independent evidence. A live read can refresh the former
// while retaining the sidecar's terminal outcome and activity timestamps.
export function newerStatusFields(a, b) {
  const left = statusFields(a), right = statusFields(b);
  const latest = (right.statusObservedAt ?? 0) >= (left.statusObservedAt ?? 0) ? right : left;
  const { status, statusObservedAt, statusSource, activeFlags, ...history } = { ...left, ...right };
  const out = { ...history };
  if (latest.statusObservedAt) Object.assign(out, { status: latest.status, statusObservedAt: latest.statusObservedAt, statusSource: latest.statusSource,
    ...(latest.activeFlags ? { activeFlags: latest.activeFlags } : {}) });
  if (left.lastActivity && (left.lastActivity.at > (right.lastActivity?.at ?? 0))) out.lastActivity = left.lastActivity;
  if (left.lastTurn && (left.lastTurn.observedAt > (right.lastTurn?.observedAt ?? 0))) out.lastTurn = left.lastTurn;
  return out;
}

export function observeTurn(data, turn, source, now) {
  if (!turnId(turn?.id) || !TURN_SOURCES.has(source)) return data;
  const done = OUTCOMES.has(turn.status);
  if (!done && turn.status !== "inProgress") return data;
  const at = runtimeTime(done ? turn.completedAt : turn.startedAt);
  // A historical summary with no timestamp proves an outcome, but not when activity occurred.
  if (at || source !== "thread/turns/list") {
    const activity = { turnId: turn.id, at: at ?? now, observedAt: now, source, event: done ? "completed" : "started", timeSource: at ? "runtime" : "observed" };
    if (!data.lastActivity || activity.at > data.lastActivity.at || (activity.at === data.lastActivity.at &&
        (activity.turnId !== data.lastActivity.turnId || activity.event !== data.lastActivity.event))) data = { ...data, lastActivity: activity };
  }
  const previous = data.lastTurn;
  const completedAt = at ?? (previous?.id === turn.id ? previous.completedAt : undefined);
  const failure = turn.status === "failed" ? errorClass(turn.error?.codexErrorInfo) : undefined;
  // The runtime can revise a summary of the same turn as it persists completion (observed
  // live: interrupted without timestamps, then failed/http_409). Keep the latest evidence.
  const revised = previous?.id === turn.id && (previous.status !== turn.status || previous.completedAt !== completedAt || previous.errorClass !== failure);
  if (done && (revised || !previous || (previous.id !== turn.id && (!at || !previous.completedAt || at >= previous.completedAt)))) {
    data = { ...data, lastTurn: { id: turn.id, status: turn.status, observedAt: now, source,
      ...(completedAt ? { completedAt } : {}), ...(failure ? { errorClass: failure } : {}) } };
  }
  return data;
}

// Poll summaries because observer clients receive status changes but may not receive turn
// notifications. Reads run in the background, with at most one pair in flight per bound root.
export class CodexStatus {
  #app; #changed; #entries = new Map(); #timer; #polling = false; #owns;
  constructor(app, changed, { intervalMs = RECONCILE_MS, owns = () => true } = {}) {
    this.#app = app; this.#changed = changed; this.#owns = owns;
    this.#timer = setInterval(() => { void this.refresh(); }, intervalMs).unref();
  }
  watch(id, thread) {
    const entry = { data: observeStatus({}, thread.status, "thread/read", Date.now()), revision: 0 };
    this.#entries.set(id, entry);
    this.#emit(id, entry, entry.data);
    void this.#turns(id, entry);
  }
  forget(id) { this.#entries.delete(id); }
  close() { clearInterval(this.#timer); this.#entries.clear(); }
  #current(id, entry) {
    if (this.#entries.get(id) !== entry) return false;
    const owned = this.#owns(id);
    // Unknown ownership pauses observation; only a readable replacement proves takeover.
    if (owned === false) this.forget(id);
    return owned === true;
  }
  #emit(id, entry, data) {
    if (!this.#current(id, entry)) return;
    entry.data = data;
    this.#changed(id, data);
  }
  unavailable() {
    for (const [id, entry] of this.#entries) {
      entry.revision++;
      this.#emit(id, entry, observeStatus(entry.data, { type: "unknown" }, "app-server-unavailable", Date.now()));
    }
  }
  notification(message) {
    if (Object.hasOwn(message, "id") || !NOTIFICATIONS.has(message.method)) return;
    const p = message.params, entry = this.#entries.get(p?.threadId);
    if (!entry || !this.#current(p.threadId, entry)) return;
    if (message.method === "thread/status/changed") {
      entry.revision++;
      this.#emit(p.threadId, entry, observeStatus(entry.data, p.status, message.method, Date.now()));
      void this.#turns(p.threadId, entry);
    } else if (["turn/started", "turn/completed"].includes(message.method)) {
      entry.turnRevision = (entry.turnRevision ?? 0) + 1;
      this.#emit(p.threadId, entry, observeTurn(entry.data, p.turn, message.method, Date.now()));
    }
    // An error notification (including willRetry:false) alone is not a terminal turn outcome.
  }
  async #turns(id, entry) {
    if (!this.#current(id, entry)) return;
    if (entry.busy) { entry.again = true; return; }
    entry.busy = true;
    try {
      const revision = entry.turnRevision;
      const turns = await this.#app.latestTurns(id);
      if (revision !== entry.turnRevision) return;
      // Descending order: record the previous terminal outcome before a new active turn.
      const { turnOutcome, ...known } = entry.data;
      let data = turnOutcome ? known : entry.data;
      const terminal = turns.find((t) => OUTCOMES.has(t.status));
      if (terminal) data = observeTurn(data, terminal, "thread/turns/list", Date.now());
      if (turns[0]?.status === "inProgress") data = observeTurn(data, turns[0], "thread/turns/list", Date.now());
      if (data !== entry.data) this.#emit(id, entry, data);
    } catch {
      this.#emit(id, entry, { ...entry.data, turnOutcome: { status: "unknown", source: "thread/turns/list", observedAt: Date.now() } });
    }
    finally {
      entry.busy = false;
      if (entry.again && this.#current(id, entry)) { entry.again = false; void this.#turns(id, entry); }
    }
  }
  async refresh() {
    if (this.#polling || !this.#entries.size) return;
    for (const [id, entry] of this.#entries) this.#current(id, entry);
    if (!this.#entries.size) return;
    this.#polling = true;
    try {
      const revisions = new Map([...this.#entries].map(([id, entry]) => [id, entry.revision]));
      const loaded = new Set(await this.#app.loadedThreads(1000));
      await Promise.allSettled([...this.#entries].map(async ([id, entry]) => {
        if (!this.#current(id, entry)) return;
        const revision = revisions.get(id);
        if (!loaded.has(id)) {
          if (revision === entry.revision) this.#emit(id, entry, observeStatus(entry.data, { type: "notLoaded" }, "thread/loaded/list", Date.now()));
          return;
        }
        try {
          const thread = await this.#app.readThread(id, 1000);
          if (revision === entry.revision) this.#emit(id, entry, observeStatus(entry.data, thread.status, "thread/read", Date.now()));
        } catch {
          if (revision === entry.revision) this.#emit(id, entry, observeStatus(entry.data, { type: "unknown" }, "app-server-unavailable", Date.now()));
        }
        await this.#turns(id, entry);
      }));
    } catch { this.unavailable(); }
    finally { this.#polling = false; }
  }
}
