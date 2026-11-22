// Chat passages stay out of the ranked pool.
// Desktop, mobile, and cursor share them. Each line is one short message.

import { CHAT_PASSAGES } from "../public/chat-passages.js";
import { lengthForCount, selectPassage } from "./sentences.js";

export { CHAT_PASSAGES };

const LENGTHS = ["sprint", "set", "long"];
const DIFFICULTIES = ["easy", "medium", "hard"];
const LINE_COUNTS = { sprint: 3, set: 4, long: 6 };
const BOUNDS = {
  sprint: { easy: [20, 34], medium: [35, 52], hard: [53, 140] },
  set: { easy: [40, 58], medium: [59, 78], hard: [79, 220] },
  long: { easy: [80, 110], medium: [111, 130], hard: [131, 360] },
};

const BY_ID = new Map(CHAT_PASSAGES.map((row) => [row.id, row]));
const BY_TEXT = new Map(CHAT_PASSAGES.map((row) => [row.text, row]));

export function chatDailyPool() {
  return CHAT_PASSAGES.filter((row) => row.length === "sprint" || row.length === "set");
}

export function chatPool(mode, length) {
  if (mode !== "desktop" && mode !== "mobile" && mode !== "cursor") return [];
  return CHAT_PASSAGES.filter((row) => !length || row.length === length);
}

export function pickChatRecord(mode, count, options = {}) {
  const length = lengthForCount(count);
  if (!length) return null;
  let pool = chatPool(mode, length);
  if (options.difficulty) pool = pool.filter((row) => row.difficulty === options.difficulty);
  return selectPassage(pool, options.avoid || [], options.random || Math.random);
}

export function chatOk(mode, count, sentence) {
  const length = lengthForCount(count);
  if (!length || typeof sentence !== "string" || !sentence) return false;
  return chatPool(mode, length).some((row) => row.text === sentence);
}

export function chatById(id) {
  return BY_ID.get(id) || null;
}

export function chatByText(text) {
  return BY_TEXT.get(text) || null;
}

function ladderShape(row) {
  const ladders = Array.isArray(row?.ladders) ? row.ladders : [];
  return ladders.length === 3
    && ladders.includes("desktop")
    && ladders.includes("mobile")
    && ladders.includes("cursor");
}

export function findChatIssues(list = CHAT_PASSAGES) {
  const errors = [];
  if (!Array.isArray(list)) return ["pool is not a list"];
  const ids = new Set();
  const texts = new Set();
  const counts = {};
  for (const row of list) {
    if (!row || typeof row !== "object") {
      errors.push("missing row");
      continue;
    }
    if (typeof row.id !== "string" || !/^c-(sp|se|lg)-[emh]-\d{3}$/.test(row.id)) errors.push(`id ${row.id || ""}`);
    else if (ids.has(row.id)) errors.push(`duplicate id ${row.id}`);
    else ids.add(row.id);
    if (typeof row.text !== "string" || !row.text) {
      errors.push(`empty text ${row.id || ""}`);
      continue;
    }
    if (texts.has(row.text)) errors.push(`duplicate text ${row.id}`);
    else texts.add(row.text);
    if (row.text !== row.text.toLowerCase()) errors.push(`case ${row.id}`);
    if (/[.,?'"!():;\-]/.test(row.text)) errors.push(`punctuation ${row.id}`);
    const lines = row.text.split("\n");
    if (lines.some((line) => !line || line !== line.trim() || /\s{2,}/.test(line) || !/^[a-z0-9 ]+$/.test(line))) {
      errors.push(`line ${row.id}`);
    }
    if (!LENGTHS.includes(row.length) || !DIFFICULTIES.includes(row.difficulty)) {
      errors.push(`tier ${row.id}`);
      continue;
    }
    if (lines.length !== LINE_COUNTS[row.length]) errors.push(`lines ${row.id} ${lines.length}`);
    if (row.chars !== row.text.length) errors.push(`chars ${row.id}`);
    const [min, max] = BOUNDS[row.length][row.difficulty];
    if (row.text.length < min || row.text.length > max) errors.push(`bounds ${row.id} ${row.text.length}`);
    if (!ladderShape(row)) errors.push(`ladders ${row.id}`);
    counts[row.length] = (counts[row.length] || 0) + 1;
  }
  if ((counts.sprint || 0) < 24) errors.push(`sprint ${counts.sprint || 0}`);
  if ((counts.set || 0) < 24) errors.push(`set ${counts.set || 0}`);
  if ((counts.long || 0) < 12) errors.push(`long ${counts.long || 0}`);
  return errors;
}
