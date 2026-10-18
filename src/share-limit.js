// Per-isolate cap. There is no shared rate-limit binding, and a new table
// would be a schema change. The counters reset when the isolate restarts.

const WINDOW_MS = 10 * 60 * 1000;
const LIMIT = 20;
const buckets = new Map();

export function allowShare(key, now = Date.now()) {
  if (!key) return false;
  const row = buckets.get(key);
  if (!row || now - row.start >= WINDOW_MS) {
    buckets.set(key, { start: now, count: 1 });
    prune(now);
    return true;
  }
  if (row.count >= LIMIT) return false;
  row.count += 1;
  return true;
}

function prune(now) {
  if (buckets.size < 400) return;
  for (const [key, row] of buckets) {
    if (now - row.start >= WINDOW_MS) buckets.delete(key);
  }
}

export function clearShareLimits() {
  buckets.clear();
}

export const SHARE_LIMIT = LIMIT;
export const SHARE_WINDOW_MS = WINDOW_MS;
