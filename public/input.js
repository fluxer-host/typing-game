// Shared by the page and the unit tests. The page loads this as a module.
//
// The race server accepts one UTF-16 code unit added or removed per message.
// These helpers stay on that step size. NFC is applied to the incoming text
// and to the passage before they are compared, so a composed accent and its
// decomposed form count as the same character.

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
  return { composing: false, suppressInsert: false, skipInput: false, ignoreDelete: false };
}

// Drops one-shot guards after the events that belong to the same keystroke.
export function settleInput(session) {
  return {
    composing: Boolean(session?.composing),
    suppressInsert: false,
    skipInput: false,
    ignoreDelete: false,
  };
}

const WORD_OR_CHAR_DELETE = new Set(["deleteContentBackward", "deleteWordBackward"]);

function sessionFrom(session) {
  return {
    composing: Boolean(session?.composing),
    suppressInsert: Boolean(session?.suppressInsert),
    skipInput: Boolean(session?.skipInput),
    ignoreDelete: Boolean(session?.ignoreDelete),
  };
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
    const next = { ...current, composing: false };
    if (!chars.length) return outcome(next, { effect: "defer" });
    next.suppressInsert = true;
    next.skipInput = true;
    return outcome(next, { effect: "insert", chars });
  }

  if (type === "keydown") {
    // Letters arrive through beforeinput or input. keydown is only a
    // fallback for Backspace when the browser does not emit a delete event.
    if (event.key === "Backspace" && !current.composing && !event.isComposing) {
      return outcome({ ...current, ignoreDelete: true }, { effect: "backspace" });
    }
    return outcome(current, { effect: "ignore" });
  }

  if (type === "beforeinput") {
    const inputType = event.inputType || "";
    if (current.composing || inputType === "insertCompositionText") {
      return outcome(current, { effect: "defer" });
    }
    if (current.suppressInsert && isPlainInsert(inputType)) {
      return outcome({ ...current, skipInput: true }, { effect: "ignore" });
    }
    if (WORD_OR_CHAR_DELETE.has(inputType)) {
      if (current.ignoreDelete) return outcome({ ...current, ignoreDelete: false }, { effect: "ignore" });
      return outcome({ ...current, skipInput: true, ignoreDelete: false }, { effect: "backspace" });
    }
    if (inputType === "insertText") {
      const chars = textUnits(event.data || "");
      if (!chars.length) return outcome(current, { effect: "defer" });
      return outcome({ ...current, skipInput: true }, { effect: "insert", chars });
    }
    return outcome({ ...current, skipInput: true }, { effect: "reject" });
  }

  if (type === "input") {
    if (current.composing) return outcome(current, { effect: "defer" });
    if (current.suppressInsert || current.skipInput) {
      return outcome({ ...current, suppressInsert: false, skipInput: false }, { effect: "ignore" });
    }
    const inputType = event.inputType || "";
    if (WORD_OR_CHAR_DELETE.has(inputType)) {
      if (current.ignoreDelete) return outcome({ ...current, ignoreDelete: false }, { effect: "ignore" });
      return outcome({ ...current, ignoreDelete: false }, { effect: "backspace" });
    }
    if (inputType && !isPlainInsert(inputType)) {
      return outcome(current, { effect: "reject" });
    }
    const chars = textUnits(event.data || event.value || "");
    if (!chars.length) return outcome(current, { effect: "ignore" });
    return outcome(current, { effect: "insert", chars });
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
    if (ch.length !== 1) break;
    const good = correctLength(current, sentence);
    if (current.length > good || good >= target.length) break;
    const expected = target[good];
    current += ch;
    const match = ch === expected;
    if (match) nextOk += 1;
    else nextErr += 1;
    const finished = current === sentence;
    steps.push({ kind: finished ? "fin" : "prog", text: current });
    if (!match || finished) break;
  }
  if (!steps.length) return idle;
  return {
    typed: current,
    ok: nextOk,
    err: nextErr,
    changed: true,
    finished: steps[steps.length - 1].kind === "fin",
    steps,
  };
}
