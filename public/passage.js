import { MISSED } from "./input.js";

// Maps one passage index to its state class.
// `expected` is the full sentence and `typed` is the raw input. A miss stays
// marked, and the caret sits on the next untyped character.
export function characterClass(expected, typed, index) {
  const sentence = typeof expected === "string" ? expected : "";
  const input = typeof typed === "string" ? typed : "";
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= sentence.length) return "ch";
  const names = ["ch"];
  if (sentence[i] === "\n") names.push("br");
  if (i < input.length) names.push(input[i] === sentence[i] ? "ok" : "bad");
  if (i === input.length) names.push("cur");
  return names.join(" ");
}

// The passage always shows the expected character. `typed` is accepted so the
// call site passes the same triple as characterClass, and a miss cannot swap
// the glyph for the key that was pressed.
export function characterText(expected, typed, index) {
  const sentence = typeof expected === "string" ? expected : "";
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= sentence.length) return "";
  // `typed` is the same argument as characterClass. It never replaces the glyph.
  void typed;
  return sentence[i];
}

export function typedMiss(expected, typed, index) {
  const sentence = typeof expected === "string" ? expected : "";
  const input = typeof typed === "string" ? typed : "";
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= sentence.length || i >= input.length) return "";
  if (input[i] === sentence[i] || input[i] === MISSED) return "";
  return input[i];
}

export function missLabel(ch) {
  if (ch === " ") return "space";
  if (ch === "\n") return "new line";
  return ch || "";
}

// Shared races count 3, 2, 1, then show "go" for 650ms after startAt.
// A local run has no shared start. The clock waits for the first key, so
// the overlay stays hidden.
export function countCue(leftMs, local) {
  if (local) return "";
  const left = Number(leftMs);
  if (!Number.isFinite(left)) return "";
  if (left > 2000) return "3";
  if (left > 1000) return "2";
  if (left > 0) return "1";
  if (left > -650) return "go";
  return "";
}

export function pageTitle(phase) {
  if (phase === "countdown") return "Typing race, countdown";
  if (phase === "race" || phase === "finishing") return "Typing race, racing";
  if (phase === "results") return "Typing race, results";
  if (phase === "stats") return "Typing race, stats";
  if (phase === "ladder") return "Typing race, ladder";
  return "Typing race";
}
