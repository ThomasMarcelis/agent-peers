// Startup binding retries quickly, then backs off to a slow cap: a session whose app-server is
// down or that runs in an embedded server should not poll and log every minute forever.
export const START_RETRY_MS = [0, 250, 500, 1000, 2000, 4000, 8000, 15000, 30000];
export const RETRY_MS = 60_000, RETRY_MAX_MS = 600_000;

export function bindDelayMs(attempt) {
  if (attempt < START_RETRY_MS.length) return START_RETRY_MS[attempt];
  return Math.min(RETRY_MS * 2 ** (attempt - START_RETRY_MS.length), RETRY_MAX_MS);
}

// Report a failure reason when it first appears or changes, and once, when the quick schedule
// is spent, that the session is unreachable for now. Returns the event to log, or undefined.
export function bindReporter() {
  let last, reportedUnreachable = false;
  return (attempt, reason) => {
    if (!reason) { last = undefined; return; }
    if (attempt >= START_RETRY_MS.length - 1 && !reportedUnreachable) {
      reportedUnreachable = true;
      last = reason;
      return { outcome: "unreachable", reason, count: attempt + 1 };
    }
    if (reason === last) return;
    last = reason;
    return { outcome: "failed", reason };
  };
}
