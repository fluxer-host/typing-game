// Punctuation passages stay out of the ranked pool.
// Desktop and mobile share them. Cursor cannot type the full mark set.

import { PUNCTUATION_PASSAGES } from "../public/punctuation-passages.js";
import { punctuationAllowed } from "./formats.js";
import { CHARSET, DIFFICULTY_BOUNDS, cursorCanType, lengthForCount, selectPassage } from "./sentences.js";

export { PUNCTUATION_PASSAGES };

// First phone-keyboard layer: letters and space.
// Second layer: digits and . , ? ' " ! ( ) : ; -
// Marks outside that set (for example @ # /) are not used.
export const MOBILE_CHARSET = CHARSET;

const LENGTHS = ["sprint", "set", "long"];
const DIFFICULTIES = ["easy", "medium", "hard"];
const REQUIRED_MARKS = [",", ".", "'", "\"", "(", ")", ":", ";", "-"];

const BY_ID = new Map(PUNCTUATION_PASSAGES.map((row) => [row.id, row]));

export function punctuationPool(mode, length) {
  if (!punctuationAllowed(mode)) return [];
  return PUNCTUATION_PASSAGES.filter((row) => !length || row.length === length);
}

export function pickPunctuationRecord(mode, count, options = {}) {
  if (!punctuationAllowed(mode)) return null;
  const length = lengthForCount(count);
  if (!length) return null;
  let pool = punctuationPool(mode, length);
  if (options.difficulty) pool = pool.filter((row) => row.difficulty === options.difficulty);
  return selectPassage(pool, options.avoid || [], options.random || Math.random);
}

export function punctuationOk(mode, count, sentence) {
  const length = lengthForCount(count);
  if (!length || typeof sentence !== "string" || !sentence) return false;
  if (!punctuationAllowed(mode)) return false;
  return punctuationPool(mode, length).some((row) => row.text === sentence);
}

export function punctuationById(id) {
  return BY_ID.get(id) || null;
}

function ladderShape(row) {
  const ladders = Array.isArray(row?.ladders) ? row.ladders : [];
  return ladders.length === 2 && ladders.includes("desktop") && ladders.includes("mobile") && !ladders.includes("cursor");
}

export function findPunctuationIssues(list = PUNCTUATION_PASSAGES) {
  const errors = [];
  if (!Array.isArray(list)) return ["pool is not a list"];
  const ids = new Set();
  const texts = new Set();
  const seen = new Set();
  for (const row of list) {
    if (!row || typeof row !== "object") {
      errors.push("missing row");
      continue;
    }
    if (typeof row.id !== "string" || !row.id) errors.push("missing id");
    else if (ids.has(row.id)) errors.push(`duplicate id ${row.id}`);
    else ids.add(row.id);
    if (typeof row.text !== "string" || !row.text) {
      errors.push(`empty text ${row.id || ""}`);
      continue;
    }
    if (row.text !== row.text.trim() || row.text.startsWith(" ") || row.text.endsWith(" ")) {
      errors.push(`trimmed ${row.id}`);
    }
    if (/\s{2,}/.test(row.text)) errors.push(`double space ${row.id}`);
    if (texts.has(row.text)) errors.push(`duplicate text ${row.id}`);
    else texts.add(row.text);
    if (row.chars !== row.text.length) errors.push(`chars ${row.id}`);
    if (!LENGTHS.includes(row.length) || !DIFFICULTIES.includes(row.difficulty)) {
      errors.push(`tier ${row.id}`);
      continue;
    }
    const [min, max] = DIFFICULTY_BOUNDS[row.length][row.difficulty];
    if (row.text.length < min || row.text.length > max) errors.push(`bounds ${row.id} ${row.text.length}`);
    if (!ladderShape(row)) errors.push(`ladders ${row.id}`);
    if (!MOBILE_CHARSET.test(row.text)) errors.push(`charset ${row.id}`);
    for (const ch of row.text) seen.add(ch);
    if (!/[.,'"!?;:()\-0-9]/.test(row.text)) errors.push(`no mark ${row.id}`);
  }
  if (list.length < 60) errors.push(`count ${list.length}`);
  for (const mark of REQUIRED_MARKS) {
    if (!seen.has(mark)) errors.push(`missing mark ${mark}`);
  }
  if (![...seen].some((ch) => ch >= "A" && ch <= "Z")) errors.push("missing capital");
  if (![...seen].some((ch) => ch >= "0" && ch <= "9")) errors.push("missing digit");
  const blocked = [...seen].filter((ch) => !cursorCanType(ch));
  if (!blocked.length) errors.push("cursor could type the whole pool");
  return errors;
}
