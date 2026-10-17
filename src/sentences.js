// Passage pool shared by rated races and local practice.
// Keep CURSOR_KEYS in sync with the rows in public/app.js.
// A rated race still sends one string. Count 1, 3, or 5 selects the length tier.

import { PASSAGES } from "../public/passages.js";

export { PASSAGES };

export const CURSOR_KEYS = "1234567890-qwertyuiopasdfghjkl'zxcvbnm,.? ";

export const CHARSET = /^[A-Za-z0-9 .,?'"!():;-]+$/;

export const RECENT_AVOID = 8;

export const LENGTH_BOUNDS = {
  sprint: { min: 48, max: 96 },
  set: { min: 140, max: 240 },
  long: { min: 260, max: 460 },
};

export const DIFFICULTY_BOUNDS = {
  sprint: { easy: [48, 68], medium: [69, 84], hard: [85, 96] },
  set: { easy: [140, 170], medium: [171, 205], hard: [206, 240] },
  long: { easy: [260, 320], medium: [321, 390], hard: [391, 460] },
};

const COUNT_TO_LENGTH = { 1: "sprint", 3: "set", 5: "long" };
const LENGTHS = ["sprint", "set", "long"];
const DIFFICULTIES = ["easy", "medium", "hard"];

const BY_ID = new Map(PASSAGES.map((row) => [row.id, row]));
const BY_TEXT = new Map();
for (const row of PASSAGES) {
  BY_TEXT.set(row.text, row);
  if (row.ladders.includes("cursor")) BY_TEXT.set(normalizeCursorText(row.text), row);
}

export function lengthForCount(count) {
  return COUNT_TO_LENGTH[count] || "";
}

export function countForLength(length) {
  if (length === "sprint") return 1;
  if (length === "set") return 3;
  if (length === "long") return 5;
  return 0;
}

export function normalizeCursorText(text) {
  return String(text ?? "")
    .replace(/\u00A0/g, " ")
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-");
}

export function cursorCanType(text) {
  const normalized = normalizeCursorText(text);
  for (const ch of normalized) {
    if (ch >= "A" && ch <= "Z") {
      if (!CURSOR_KEYS.includes(ch.toLowerCase())) return false;
    } else if (!CURSOR_KEYS.includes(ch)) {
      return false;
    }
  }
  return true;
}

function ladderOf(mode) {
  if (mode === "cursor") return "cursor";
  if (mode === "desktop" || mode === "mobile") return "desktop";
  return "";
}

export function poolFor(mode, length) {
  const ladder = ladderOf(mode);
  if (!ladder) return [];
  return PASSAGES.filter((row) => row.ladders.includes(ladder) && (!length || row.length === length)).map((row) => {
    if (mode !== "cursor") return row;
    const text = normalizeCursorText(row.text);
    return text === row.text ? row : { ...row, text, chars: text.length };
  });
}

export function passageById(id) {
  return BY_ID.get(id) || null;
}

export function lengthOfText(text) {
  return BY_TEXT.get(text)?.length || "";
}

export function passageIdForText(text) {
  return BY_TEXT.get(text)?.id || "";
}

export function isKnownSentence(text) {
  return typeof text === "string" && BY_TEXT.has(text);
}

export function extraPunctuation(text) {
  const marks = String(text).match(/[.,'"!?;:()\-]/g);
  let count = marks ? marks.length : 0;
  if (String(text).endsWith(".")) count -= 1;
  return count;
}

export function selectPassage(pool, avoid = [], random = Math.random) {
  if (!Array.isArray(pool) || !pool.length) return null;
  const skip = new Set(Array.isArray(avoid) ? avoid : []);
  let choices = pool.filter((row) => row && !skip.has(row.id));
  if (!choices.length) choices = pool.filter(Boolean);
  if (!choices.length) return null;
  const roll = Number(random());
  const index = Number.isFinite(roll) ? Math.floor(roll * choices.length) : 0;
  const safe = Math.min(choices.length - 1, Math.max(0, index));
  return choices[safe];
}

export function pickPassageRecord(mode, count, options = {}) {
  const length = lengthForCount(count);
  if (!length) return null;
  let pool = poolFor(mode, length);
  if (options.difficulty) pool = pool.filter((row) => row.difficulty === options.difficulty);
  return selectPassage(pool, options.avoid || [], options.random || Math.random);
}

export function pickPassage(mode, count, options) {
  return pickPassageRecord(mode, count, options)?.text || "";
}

export function pickSentence(mode) {
  return pickPassage(mode, 1);
}

export function passageOk(mode, count, sentence) {
  const length = lengthForCount(count);
  if (!length || typeof sentence !== "string" || !sentence) return false;
  return poolFor(mode, length).some((row) => row.text === sentence);
}

export function unionAvoid(groups) {
  const out = [];
  const seen = new Set();
  for (const group of groups || []) {
    for (const id of group || []) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

export function rememberIds(previous, id, limit = RECENT_AVOID) {
  const next = (Array.isArray(previous) ? previous : []).filter((item) => item && item !== id);
  if (id) next.push(id);
  const cap = Number.isInteger(limit) && limit > 0 ? limit : RECENT_AVOID;
  return next.slice(-cap);
}

function ladderOk(row) {
  const ladders = Array.isArray(row?.ladders) ? row.ladders : [];
  const cursor = ladders.includes("cursor");
  const desktop = ladders.includes("desktop") && ladders.includes("mobile");
  if (cursor && desktop) return false;
  if (cursor) return ladders.length === 1;
  return desktop && ladders.length === 2;
}

export function findPassageIssues(list, options = {}) {
  const errors = [];
  const requireCounts = options.requireCounts !== false;
  if (!Array.isArray(list)) return ["pool is not a list"];
  const ids = new Set();
  const texts = new Set();
  const counts = { desktop: 0, cursor: 0 };
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
    if (row.text !== row.text.trim()) errors.push(`trimmed ${row.id}`);
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
    if (!ladderOk(row)) errors.push(`ladders ${row.id}`);
    const cursor = row.ladders?.includes("cursor");
    if (cursor) {
      if (!cursorCanType(row.text)) errors.push(`cursor keys ${row.id}`);
      counts.cursor += 1;
    } else if (!CHARSET.test(row.text)) {
      errors.push(`charset ${row.id}`);
    } else {
      counts.desktop += 1;
    }
    if (row.length === "sprint" && row.difficulty === "easy" && extraPunctuation(row.text) > 1) {
      errors.push(`easy punctuation ${row.id}`);
    }
    if (row.difficulty === "hard" && cursor && !/[0-9'?\-]/.test(row.text)) errors.push(`cursor variety ${row.id}`);
    if (row.difficulty === "hard" && !cursor && !/["!;:()]/.test(row.text)) errors.push(`desktop variety ${row.id}`);
  }
  if (requireCounts) {
    if (counts.desktop < 300) errors.push(`desktop count ${counts.desktop}`);
    if (counts.cursor < 150) errors.push(`cursor count ${counts.cursor}`);
  }
  return errors;
}
