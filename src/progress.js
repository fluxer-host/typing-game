// Sustained typing faster than this is rejected. 25 characters per second
// is about 300 words per minute, past recorded human bursts.
export const MAX_KEYSTROKES_PER_SECOND = 25;

// The rolling half of the same limit. The other half is the average from
// the start, so a short passage cannot be dumped in one instant either.
export const RATE_WINDOW_MS = 1000;

// Raw race socket payload cap. A passage is a few hundred characters.
export const MAX_RACE_MESSAGE_CHARS = 2000;

function reject(reason, disqualify) {
  return { ok: false, reason, disqualify };
}

function correctIndex(typed, passage) {
  const limit = Math.min(typed.length, passage.length);
  let index = 0;
  while (index < limit && typed[index] === passage[index]) index += 1;
  return index;
}

// previous is the typed text the server already accepted. next is the
// client's new typed text. elapsedMs is the server clock minus the race
// start, so a negative value is still the countdown. recentStrokes and
// priorStrokes are server counts. Client timestamps are not an input.
export function validateProgress({ passage, previous, next, elapsedMs, recentStrokes, priorStrokes, kind }) {
  if (typeof passage !== "string" || typeof previous !== "string") return reject("malformed", false);
  if (kind !== "prog" && kind !== "fin") return reject("malformed", false);
  if (typeof next !== "string") return reject("malformed", false);
  if (!Number.isFinite(elapsedMs)) return reject("malformed", false);
  if (elapsedMs < 0) return reject("early", false);
  if (next.length > passage.length) return reject("overshoot", true);
  if (next === previous) return reject("malformed", false);

  const typed = next.length === previous.length + 1 && next.startsWith(previous);
  const erased = previous.length === next.length + 1 && previous.startsWith(next);
  if (!typed && !erased) {
    const backwards = previous.startsWith(next);
    return reject(backwards ? "backwards" : "jump", true);
  }

  const prior = Number.isFinite(priorStrokes) && priorStrokes > 0 ? Math.floor(priorStrokes) : 0;
  const recent = Number.isFinite(recentStrokes) && recentStrokes > 0 ? Math.floor(recentStrokes) : 0;
  const minElapsed = prior * (RATE_WINDOW_MS / MAX_KEYSTROKES_PER_SECOND);
  if (recent >= MAX_KEYSTROKES_PER_SECOND || elapsedMs < minElapsed) return reject("rate", true);

  const correct = typed && next[previous.length] === passage[previous.length];
  return {
    ok: true,
    text: next,
    index: correctIndex(next, passage),
    finished: next === passage,
    okDelta: correct ? 1 : 0,
    errDelta: typed && !correct ? 1 : 0,
  };
}
