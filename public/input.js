// Shared by the page and the unit tests. The page loads this as a module.
//
// The race server accepts one UTF-16 code unit added or removed per message,
// or one word skip from Space. These helpers stay on that step size. NFC is
// applied to the incoming text and to the passage before they are compared,
// so a composed accent and its decomposed form count as the same character.

import { MISSED, wordSkipText } from "../src/progress.js";

export { MISSED, matchCount } from "../src/progress.js";

export function nfc(value) {
  return typeof value === "string" ? value.normalize("NFC") : "";
}

export function textUnits(value) {
  const text = nfc(value);
  const units = [];
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        units.push(text.slice(i, i + 2));
        i += 1;
        continue;
      }
    }
    units.push(text[i]);
  }
  return units;
}

export function correctLength(typed, sentence) {
  const left = nfc(typed);
  const right = nfc(sentence);
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  return index;
}

export function emptyInputSession() {
  return {
    composing: false,
    suppressInsert: false,
    pendingInput: 0,
    needInput: false,
    ignoreDelete: false,
    ignoreLine: false,
    buffer: "",
  };
}

// Drops one-shot guards after the events that belong to the same keystroke.
// `buffer` stays. It is the field text already accounted for, so a later
// snapshot can contribute only its new suffix.
export function settleInput(session) {
  return {
    composing: Boolean(session?.composing),
    suppressInsert: false,
    pendingInput: 0,
    needInput: false,
    ignoreDelete: false,
    ignoreLine: false,
    buffer: typeof session?.buffer === "string" ? session.buffer : "",
  };
}

const WORD_OR_CHAR_DELETE = new Set(["deleteContentBackward", "deleteWordBackward"]);

function pendingCount(value) {
  const count = Number(value);
  if (!Number.isFinite(count) || count <= 0) return 0;
  return Math.min(32, Math.floor(count));
}

function sessionFrom(session) {
  return {
    composing: Boolean(session?.composing),
    suppressInsert: Boolean(session?.suppressInsert),
    pendingInput: pendingCount(session?.pendingInput),
    needInput: Boolean(session?.needInput),
    ignoreDelete: Boolean(session?.ignoreDelete),
    ignoreLine: Boolean(session?.ignoreLine),
    buffer: typeof session?.buffer === "string" ? session.buffer : "",
  };
}

// `previous` is field text already turned into keystrokes. A growing field
// value contributes only the new suffix. A cleared field contributes its
// whole value, which is the text typed since the clear.
function snapshotDelta(previous, value) {
  const prev = typeof previous === "string" ? previous : "";
  const next = typeof value === "string" ? value : "";
  if (prev && next.startsWith(prev)) return { buffer: next, text: next.slice(prev.length) };
  return { buffer: next, text: next };
}

function unitsBefore(value, count) {
  const units = textUnits(value);
  return units.slice(0, Math.max(0, units.length - count)).join("");
}

function outcome(session, effect) {
  return { session, effect };
}

function isPlainInsert(inputType) {
  return inputType === "insertText" || inputType === "insertCompositionText";
}

export function consumeInput(session, event) {
  const current = sessionFrom(session);
  const type = event?.type;

  if (type === "compositionstart" || type === "compositionupdate") {
    return outcome({ ...current, composing: true }, { effect: "defer" });
  }

  if (type === "compositionend") {
    const chars = textUnits(event?.data || "");
    const next = { ...current, composing: false, needInput: false };
    if (!chars.length) return outcome(next, { effect: "defer" });
    // The browser often emits the committed text once more. Swallow that
    // one follow-up without forgetting earlier keystrokes still in flight.
    next.suppressInsert = true;
    next.pendingInput = pendingCount(current.pendingInput + 1);
    next.buffer = current.buffer + chars.join("");
    return outcome(next, { effect: "insert", chars });
  }

  if (type === "keydown") {
    // Letters arrive through beforeinput or input. keydown is only a
    // fallback for Backspace when the browser does not emit a delete event,
    // and for Enter, which a single-line field does not insert on its own.
    if (event.key === "Enter" && !current.composing && !event.isComposing) {
      return outcome({
        ...current,
        ignoreLine: true,
        pendingInput: pendingCount(current.pendingInput + 1),
      }, { effect: "insert", chars: ["\n"] });
    }
    if (event.key === "Backspace" && !current.composing && !event.isComposing) {
      return outcome({
        ...current,
        ignoreDelete: true,
        buffer: unitsBefore(current.buffer, 1),
      }, { effect: "backspace" });
    }
    return outcome(current, { effect: "ignore" });
  }

  if (type === "beforeinput") {
    const inputType = event.inputType || "";
    if (current.composing || inputType === "insertCompositionText") {
      return outcome(current, { effect: "defer" });
    }
    if (current.suppressInsert && isPlainInsert(inputType)) {
      return outcome(current, { effect: "ignore" });
    }
    if (inputType === "insertLineBreak" || inputType === "insertParagraph") {
      if (current.ignoreLine) return outcome({ ...current, ignoreLine: false }, { effect: "ignore" });
      return outcome({
        ...current,
        pendingInput: pendingCount(current.pendingInput + 1),
        needInput: false,
        ignoreLine: false,
      }, { effect: "insert", chars: ["\n"] });
    }
    if (WORD_OR_CHAR_DELETE.has(inputType)) {
      if (current.ignoreDelete) return outcome({ ...current, ignoreDelete: false }, { effect: "ignore" });
      return outcome({
        ...current,
        pendingInput: pendingCount(current.pendingInput + 1),
        ignoreDelete: false,
        needInput: false,
        buffer: unitsBefore(current.buffer, 1),
      }, { effect: "backspace" });
    }
    if (inputType === "insertText") {
      const chars = textUnits(event.data || "");
      // Some browsers leave `data` empty and put the text on the following
      // input event. Remember that, or a pending duplicate swallows it.
      if (!chars.length) return outcome({ ...current, needInput: true }, { effect: "defer" });
      return outcome({
        ...current,
        pendingInput: pendingCount(current.pendingInput + 1),
        needInput: false,
        buffer: current.buffer + chars.join(""),
      }, { effect: "insert", chars });
    }
    return outcome({
      ...current,
      pendingInput: pendingCount(current.pendingInput + 1),
      needInput: false,
    }, { effect: "reject" });
  }

  if (type === "input") {
    if (current.composing) return outcome(current, { effect: "defer" });
    const inputType = event.inputType || "";
    const data = typeof event.data === "string" ? event.data : "";
    const value = typeof event.value === "string" ? event.value : "";
    const snap = data ? null : snapshotDelta(current.buffer, value);
    const text = data || snap?.text || "";
    // `data` is the new text. A value without data is the whole field.
    const appliedBuffer = data ? (value || current.buffer + data) : (snap ? snap.buffer : current.buffer);
    const seenBuffer = value || current.buffer;
    if (current.needInput) {
      const chars = textUnits(text);
      const next = { ...current, buffer: appliedBuffer, pendingInput: 0, needInput: false, suppressInsert: false };
      if (!chars.length) return outcome(next, { effect: "ignore" });
      return outcome(next, { effect: "insert", chars });
    }
    if (current.ignoreLine || current.suppressInsert || current.pendingInput > 0) {
      return outcome({
        ...current,
        buffer: seenBuffer,
        suppressInsert: false,
        ignoreLine: false,
        pendingInput: current.pendingInput > 0 ? current.pendingInput - 1 : 0,
        needInput: false,
      }, { effect: "ignore" });
    }
    if (WORD_OR_CHAR_DELETE.has(inputType)) {
      if (current.ignoreDelete) return outcome({ ...current, buffer: seenBuffer, ignoreDelete: false }, { effect: "ignore" });
      return outcome({ ...current, buffer: unitsBefore(seenBuffer, 1), ignoreDelete: false }, { effect: "backspace" });
    }
    if (inputType && !isPlainInsert(inputType)) {
      return outcome({ ...current, buffer: seenBuffer }, { effect: "reject" });
    }
    const chars = textUnits(text);
    if (!chars.length) return outcome({ ...current, buffer: seenBuffer }, { effect: "ignore" });
    return outcome({ ...current, buffer: appliedBuffer }, { effect: "insert", chars });
  }

  return outcome(current, { effect: "ignore" });
}

export function applyTyping(state, effect) {
  const sentence = typeof state?.sentence === "string" ? state.sentence : "";
  const typed = typeof state?.typed === "string" ? state.typed : "";
  const ok = Number.isFinite(state?.ok) ? state.ok : 0;
  const err = Number.isFinite(state?.err) ? state.err : 0;
  const idle = { typed, ok, err, changed: false, finished: false, steps: [] };
  if (!effect || effect.effect === "ignore" || effect.effect === "defer" || effect.effect === "reject") {
    return idle;
  }

  if (effect.effect === "backspace") {
    if (!typed) return idle;
    // One code unit, matching the server. A word delete is the same step:
    // several units in one message are rejected as a jump.
    const next = typed.slice(0, -1);
    return { typed: next, ok, err, changed: true, finished: false, steps: [{ kind: "prog", text: next }] };
  }

  if (effect.effect !== "insert") return idle;
  const target = nfc(sentence);
  let current = typed;
  let nextOk = ok;
  let nextErr = err;
  const steps = [];
  for (const ch of effect.chars || []) {
    if (ch.length !== 1) continue;
    if (current.length >= target.length) break;
    const at = target[current.length];
    if (ch === "\n" && at !== "\n") {
      nextErr += 1;
      continue;
    }
    if (at === "\n" && (ch === " " || ch === "\n")) {
      current += "\n";
      nextOk += 1;
      steps.push(stepFor(current, target));
      if (current === target) break;
      continue;
    }
    const skip = ch === " " ? wordSkipText(target, current) : null;
    if (skip) {
      for (const unit of skip.slice(current.length)) {
        if (unit === MISSED) nextErr += 1;
        else nextOk += 1;
      }
      current = skip;
      steps.push(stepFor(current, target));
      // A burst can hold the rest of the line after the space. Keep going
      // so those characters land on the next word instead of being dropped.
      continue;
    }
    // A letter does not spill into the next word or the next message.
    // Space is what moves on. Dropping the leftover letters here used to
    // discard the space that followed them in the same burst, so the line
    // never lined up again.
    if ((at === " " || at === "\n") && ch !== " " && ch !== "\n") {
      nextErr += 1;
      continue;
    }
    const expected = target[current.length];
    current += ch;
    if (ch === expected) nextOk += 1;
    else nextErr += 1;
    steps.push(stepFor(current, target));
    if (current === target) break;
  }
  if (!steps.length) return idle;
  const last = steps[steps.length - 1];
  return {
    typed: current,
    ok: nextOk,
    err: nextErr,
    changed: true,
    finished: last.kind === "fin",
    reached: last.reached,
    steps,
  };
}

function stepFor(current, target) {
  return {
    kind: current === target ? "fin" : "prog",
    text: current,
    reached: current.length === target.length,
  };
}
