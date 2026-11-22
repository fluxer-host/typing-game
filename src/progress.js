// Sustained typing faster than this is rejected. 25 characters per second
// is about 300 words per minute, past recorded human bursts.
export const MAX_KEYSTROKES_PER_SECOND = 25;

// The rolling half of the same limit. The other half is the average from
// the start, so a short passage cannot be dumped in one instant either.
export const RATE_WINDOW_MS = 1000;

// Raw race socket payload cap. A passage is a few hundred characters.
export const MAX_RACE_MESSAGE_CHARS = 2000;

// A skipped letter. It is not a passage character, so a word skip cannot
// copy the real letters into the typed text.
export const MISSED = "\u0001";

export function matchCount(typed, sentence) {
  const left = typeof typed === "string" ? typed : "";
  const right = typeof sentence === "string" ? sentence : "";
  const limit = Math.min(left.length, right.length);
  let count = 0;
  for (let i = 0; i < limit; i += 1) {
    if (left[i] === right[i]) count += 1;
  }
  return count;
}

// Space before the end of a word fills the untyped letters with MISSED and
// keeps the separator. A chat line ends at a newline, so that separator is
// the newline instead of a space.
export function wordSkipText(passage, previous) {
  if (typeof passage !== "string" || typeof previous !== "string") return null;
  if (previous.length >= passage.length) return null;
  let end = previous.length;
  while (end < passage.length && passage[end] !== " " && passage[end] !== "\n") end += 1;
  if (previous.length >= end) return null;
  let next = previous;
  for (let i = previous.length; i < end; i += 1) next += MISSED;
  if (end < passage.length) next += passage[end] === "\n" ? "\n" : " ";
  return next;
}

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
  const skip = !typed && !erased && next === wordSkipText(passage, previous);
  if (!typed && !erased && !skip) {
    const backwards = previous.startsWith(next);
    return reject(backwards ? "backwards" : "jump", true);
  }

  const prior = Number.isFinite(priorStrokes) && priorStrokes > 0 ? Math.floor(priorStrokes) : 0;
  const recent = Number.isFinite(recentStrokes) && recentStrokes > 0 ? Math.floor(recentStrokes) : 0;
  const minElapsed = prior * (RATE_WINDOW_MS / MAX_KEYSTROKES_PER_SECOND);
  if (recent >= MAX_KEYSTROKES_PER_SECOND || elapsedMs < minElapsed) return reject("rate", true);

  if (skip) {
    const added = next.slice(previous.length);
    let missed = 0;
    let space = 0;
    for (const ch of added) {
      if (ch === MISSED) missed += 1;
      else space += 1;
    }
    return {
      ok: true,
      text: next,
      index: correctIndex(next, passage),
      finished: false,
      okDelta: space,
      errDelta: missed,
    };
  }

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
