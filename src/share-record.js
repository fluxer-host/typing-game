// Build a card from a saved race row or from an unverified practice run.
// Ranked numbers come only from the race row. The client cannot supply them.

import { punctuationAllowed } from "./formats.js";
import { isLength } from "./lengths.js";
import { isMode } from "./modes.js";
import { displayName } from "./profile.js";
import { PUNCTUATION_PASSAGES } from "../public/punctuation-passages.js";
import { publicCardName } from "./share-name.js";
import { SHARE_VERSION } from "./share-token.js";
import { lengthOfText, poolFor } from "./sentences.js";

export function describeSavedSentence(mode, sentence) {
  const text = typeof sentence === "string" ? sentence : "";
  const length = lengthOfText(text);
  if (length) return { format: "passage", length };
  if (punctuationAllowed(mode)) {
    const row = PUNCTUATION_PASSAGES.find((item) => item.text === text);
    if (row && isLength(row.length)) return { format: "punctuation", length: row.length };
  }
  if (looksTimed(mode, text)) return { format: "timed", length: "" };
  return { format: "", length: "" };
}

function looksTimed(mode, text) {
  if (!isMode(mode) || text.length < 80) return false;
  for (const row of poolFor(mode)) {
    if (!row?.text || row.text === text) continue;
    if (row.text.startsWith(text) || text.startsWith(`${row.text} `)) return true;
  }
  return false;
}

function round1(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 10) / 10;
}

export function cardFromSavedRace(row, user, showName) {
  if (!row || !isMode(row.mode)) return null;
  const wpm = round1(row.wpm);
  const accuracy = round1(row.accuracy);
  const ms = Math.round(Number(row.ms));
  const at = Math.round(Number(row.finished_at));
  if (wpm == null || wpm < 0 || wpm > 1000) return null;
  if (accuracy == null || accuracy < 0 || accuracy > 100) return null;
  if (!Number.isInteger(ms) || ms < 0 || ms > 30 * 60 * 1000) return null;
  if (!Number.isInteger(at) || at <= 0) return null;
  const ranked = row.ranked === true || Number(row.ranked) === 1;
  const described = describeSavedSentence(row.mode, row.sentence);
  const format = ranked ? "passage" : described.format;
  const length = format === "timed" ? "" : (format === described.format && isLength(described.length) ? described.length : "");
  const place = Number(row.place);
  return {
    v: SHARE_VERSION,
    kind: "race",
    ladder: row.mode,
    format,
    length,
    wpm,
    accuracy,
    ms,
    at,
    name: showName ? publicCardName(displayName(user || {})) : "Anonymous",
    ranked,
    place: Number.isInteger(place) && place > 0 && place < 100 ? place : 0,
  };
}

export function cardFromPractice(body, user, now = Date.now()) {
  const ladder = isMode(body?.ladder) ? body.ladder : "";
  const format = body?.format === "passage" || body?.format === "timed" || body?.format === "punctuation" ? body.format : "";
  if (!ladder || !format) return null;
  if (format === "punctuation" && !punctuationAllowed(ladder)) return null;
  const length = format === "timed" ? "" : (isLength(body?.length) ? body.length : "");
  if (format !== "timed" && !length) return null;
  const wpm = round1(body?.wpm);
  const accuracy = round1(body?.accuracy);
  const ms = Math.round(Number(body?.ms));
  if (wpm == null || wpm < 0 || wpm > 400) return null;
  if (accuracy == null || accuracy < 0 || accuracy > 100) return null;
  if (!Number.isInteger(ms) || ms < 1 || ms > 30 * 60 * 1000) return null;
  if (format === "timed" && ms !== 30000 && ms !== 60000 && ms !== 120000) return null;
  const at = Number.isInteger(now) ? now : Date.now();
  return {
    v: SHARE_VERSION,
    kind: "practice",
    ladder,
    format,
    length,
    wpm,
    accuracy,
    ms,
    at,
    name: body?.showName && user ? publicCardName(displayName(user)) : "Anonymous",
    ranked: false,
    place: 0,
  };
}
