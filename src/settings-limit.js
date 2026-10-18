// Per-isolate cap for settings writes. A new isolate starts the window over.
// There is no shared rate-limit binding.

import { SETTINGS_PUT_LIMIT, SETTINGS_PUT_WINDOW_MS } from "./settings.js";

const buckets = new Map();

export function allowSettingsWrite(key, now = Date.now()) {
  if (!key) return false;
  const row = buckets.get(key);
  if (!row || now - row.start >= SETTINGS_PUT_WINDOW_MS) {
    buckets.set(key, { start: now, count: 1 });
    prune(now);
    return true;
  }
  if (row.count >= SETTINGS_PUT_LIMIT) return false;
  row.count += 1;
  return true;
}

function prune(now) {
  if (buckets.size < 400) return;
  for (const [key, row] of buckets) {
    if (now - row.start >= SETTINGS_PUT_WINDOW_MS) buckets.delete(key);
  }
}

export function clearSettingsLimits() {
  buckets.clear();
}
