// Accepted progress stays in memory and is written on this interval. A crash
// or an eviction inside the interval can drop those keystrokes. Hibernation
// is about 10 seconds, so the checkpoint alarm flushes before that.
export const PROGRESS_CHECKPOINT_MS = 2_000;

// Ignore alarm resets that move the same deadline by less than this.
export const ALARM_COALESCE_MS = 1_000;

// Results stay in the race object long enough for a reload to read them.
export const RACE_RETAIN_MS = 120_000;

// After a wake, a short forward gap is the unsaved tail of the last
// checkpoint. The server syncs the client back and does not count the gap.
export const WAKE_SYNC_MS = 15_000;

// Rematch offers expire on this clock. The lobby deletes the record after it.
export const REMATCH_TTL_MS = 180_000;

export const SESSION_CLEANUP_BATCH = 100;
export const SESSION_CLEANUP_ROUNDS = 10;

// reason is start, progress, finish, forfeit, dnf, disconnect, reconnect, or results.
export function shouldWriteProgress({ reason, now, lastWrite, checkpointMs, dirty }) {
  if (reason === "start" || reason === "finish" || reason === "forfeit" || reason === "dnf" || reason === "disconnect" || reason === "reconnect" || reason === "results" || reason === "chunk") {
    return true;
  }
  if (reason !== "progress" || !dirty) return false;
  const previous = Number(lastWrite) || 0;
  if (!Number.isFinite(now)) return false;
  return now - previous >= checkpointMs;
}

// A reload restores the checkpoint. A socket that stays open across a wake
// can be a few characters ahead. That gap is synced back, not disqualified,
// and it is not applied as progress.
export function recoverableGap({ previous, next, bootedAgeMs, checkpointMs, wakeMs }) {
  if (typeof previous !== "string" || typeof next !== "string") return false;
  if (!Number.isFinite(bootedAgeMs) || bootedAgeMs < 0 || bootedAgeMs > wakeMs) return false;
  if (!next.startsWith(previous)) return false;
  const extra = next.length - previous.length;
  if (extra <= 1) return false;
  const cap = Math.floor(Number(checkpointMs) / 40) + 1;
  return extra <= cap;
}

export function sessionExpired(expiresAt, now) {
  const expires = Number(expiresAt);
  return !Number.isFinite(expires) || expires < now;
}

export function rematchExpired(record, now) {
  const until = Number(record?.until);
  return !Number.isFinite(until) || until <= now;
}

export function raceReadyToPurge(state, now) {
  if (!state?.results) return false;
  if (!state.saved && !state.results.cancelled) return false;
  const at = Number(state.purgeAt);
  return Number.isFinite(at) && now >= at;
}
