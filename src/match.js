// Ranked queue window on one ladder and one length. The window starts at
// +/- MATCH_WINDOW_START and grows by MATCH_WINDOW_STEP every
// MATCH_WINDOW_INTERVAL_MS. Once it reaches MATCH_WINDOW_CAP, anyone left
// in that lane can match, so a thin queue still starts.
export const MATCH_WINDOW_START = 100;
export const MATCH_WINDOW_STEP = 50;
export const MATCH_WINDOW_INTERVAL_MS = 5_000;
export const MATCH_WINDOW_CAP = 400;

export function matchWindow(waitMs) {
  const waited = Math.max(0, Number(waitMs) || 0);
  const steps = Math.floor(waited / MATCH_WINDOW_INTERVAL_MS);
  const width = MATCH_WINDOW_START + steps * MATCH_WINDOW_STEP;
  if (width >= MATCH_WINDOW_CAP) return Infinity;
  return width;
}

// How long the earlier arrival must have waited before a rating gap fits.
export function waitForWindow(gap) {
  const distance = Math.abs(Number(gap) || 0);
  if (distance <= MATCH_WINDOW_START) return 0;
  const capped = Math.min(distance, MATCH_WINDOW_CAP);
  const steps = Math.ceil((capped - MATCH_WINDOW_START) / MATCH_WINDOW_STEP);
  return steps * MATCH_WINDOW_INTERVAL_MS;
}

function asNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function dedupe(queue) {
  const byId = new Map();
  for (const entry of queue || []) {
    if (!entry || entry.userId == null || entry.userId === "") continue;
    const row = {
      ...entry,
      userId: String(entry.userId),
      elo: asNumber(entry.elo, 1000),
      queuedAt: asNumber(entry.queuedAt, 0),
    };
    const prev = byId.get(row.userId);
    if (!prev || row.queuedAt < prev.queuedAt) byId.set(row.userId, row);
  }
  return [...byId.values()];
}

function pairWindow(a, b, now) {
  return Math.max(matchWindow(now - a.queuedAt), matchWindow(now - b.queuedAt));
}

function inWindow(a, b, now) {
  if (a.userId === b.userId) return false;
  const width = pairWindow(a, b, now);
  if (width === Infinity) return true;
  return Math.abs(a.elo - b.elo) <= width;
}

function byCloseness(anchor) {
  return (a, b) => {
    const gap = Math.abs(a.elo - anchor.elo) - Math.abs(b.elo - anchor.elo);
    if (gap) return gap;
    if (a.queuedAt !== b.queuedAt) return a.queuedAt - b.queuedAt;
    return a.userId.localeCompare(b.userId);
  };
}

export function pickOpponent(queue, player, now) {
  const clock = asNumber(now, 0);
  const self = {
    userId: String(player?.userId ?? ""),
    elo: asNumber(player?.elo, 1000),
    queuedAt: asNumber(player?.queuedAt, clock),
  };
  const eligible = dedupe(queue)
    .filter((entry) => entry.userId !== self.userId && inWindow(self, entry, clock))
    .sort(byCloseness(self));
  return eligible[0] || null;
}

// Longest waiter who can see someone inside the window anchors the group.
// A far-away arrival does not block two closer players behind them.
export function pickGroup(queue, now, limit = 4) {
  const clock = asNumber(now, 0);
  const size = Math.max(2, asNumber(limit, 4));
  const people = dedupe(queue).sort((a, b) => a.queuedAt - b.queuedAt || a.userId.localeCompare(b.userId));
  for (const anchor of people) {
    const candidates = people
      .filter((entry) => entry.userId !== anchor.userId && inWindow(anchor, entry, clock))
      .sort(byCloseness(anchor));
    if (!candidates.length) continue;
    return [anchor, ...candidates.slice(0, size - 1)];
  }
  return null;
}

// Earliest time any pair in the lane becomes legal. Null when fewer than
// two distinct players are waiting.
export function nextMatchAt(queue, now) {
  const people = dedupe(queue);
  if (people.length < 2) return null;
  let soonest = null;
  for (let i = 0; i < people.length; i++) {
    for (let j = i + 1; j < people.length; j++) {
      const readyAt = Math.min(people[i].queuedAt, people[j].queuedAt) + waitForWindow(people[i].elo - people[j].elo);
      if (soonest == null || readyAt < soonest) soonest = readyAt;
    }
  }
  return soonest == null ? null : Math.max(soonest, asNumber(now, 0));
}

// Re-queue on the same lane keeps the original wait clock.
export function nextQueuedAt(att, mode, length, now) {
  const same = Boolean(
    att
    && att.status === "queue"
    && att.mode === mode
    && att.length === length
    && Number.isFinite(Number(att.queuedAt)),
  );
  return same ? Number(att.queuedAt) : now;
}

export function normalizeKind(kind, ranked, racers) {
  if (kind === "room" || kind === "practice" || kind === "queue") return kind;
  if (ranked) return "queue";
  return Number(racers) >= 2 ? "room" : "practice";
}
