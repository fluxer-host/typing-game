import { correctLength } from "./input.js";

// Maps one passage index to its state class.
// `expected` is the full sentence and `typed` is the raw input, including a
// single wrong character when the racer is stopped on a miss.
export function characterClass(expected, typed, index) {
  const sentence = typeof expected === "string" ? expected : "";
  const input = typeof typed === "string" ? typed : "";
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= sentence.length) return "ch";
  const good = correctLength(input, sentence);
  const wrong = input.length > good;
  const names = ["ch"];
  if (i < good) names.push("ok");
  else if (wrong && i === good) names.push("bad");
  if ((!wrong && i === input.length) || (wrong && i === good)) names.push("cur");
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
  if (!Number.isInteger(i) || i < 0 || i >= sentence.length) return "";
  const good = correctLength(input, sentence);
  if (input.length > good && i === good) return input[good] || "";
  return "";
}

export function missLabel(ch) {
  if (ch === " ") return "space";
  if (ch === "\n") return "new line";
  return ch || "";
}

export function pageTitle(phase) {
  if (phase === "countdown") return "Typing race, countdown";
  if (phase === "race" || phase === "finishing") return "Typing race, racing";
  if (phase === "results") return "Typing race, results";
  if (phase === "stats") return "Typing race, stats";
  if (phase === "ladder") return "Typing race, ladder";
  return "Typing race";
}
