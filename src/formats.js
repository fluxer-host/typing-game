// Race format is separate from the ladder (mode) and the length.
// The ranked queue is always a passage race. Timed and punctuation are unranked.

export const FORMAT_IDS = ["passage", "timed", "punctuation"];

export const TIMED_DURATIONS_MS = [30000, 60000, 120000];

export const DEFAULT_TIMED_MS = 60000;

// Cursor on-screen keys omit quotes, parentheses, colons, and semicolons.
export const CURSOR_PUNCTUATION_NOTE = "Punctuation is unavailable on Cursor. The on-screen keys do not include quotes, parentheses, colons, or semicolons.";

export function readFormat(value) {
  return FORMAT_IDS.includes(value) ? value : "passage";
}

export function readDurationMs(value) {
  const n = Number(value);
  return TIMED_DURATIONS_MS.includes(n) ? n : DEFAULT_TIMED_MS;
}

export function punctuationAllowed(mode) {
  return mode === "desktop" || mode === "mobile";
}

// Queue ignores a requested format. Practice and rooms keep it, and they stay unranked.
export function settingsForKind(kind, requested = {}) {
  if (kind === "queue") return { format: "passage", durationMs: 0, ranked: true };
  const format = readFormat(requested.format);
  return {
    format,
    durationMs: format === "timed" ? readDurationMs(requested.durationMs) : 0,
    ranked: false,
  };
}
