// Helpers the race Durable Object calls for timed and punctuation init.
// Passage races do not come through here.

import { punctuationAllowed, readDurationMs, readFormat } from "./formats.js";
import { isLength, LENGTHS } from "./lengths.js";
import { normalizeKind } from "./match.js";
import { isMode } from "./modes.js";
import { punctuationOk } from "./punctuation.js";
import { poolFor } from "./sentences.js";
import { extendStream, openStream, revealFor, TIMED_CHUNK_CHARS, TIMED_REVEAL_REMAINING } from "./timed.js";

export function freshSeed() {
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return bytes[0];
}

export function timedPool(mode) {
  return poolFor(mode).map((row) => ({ id: row.id, text: row.text }));
}

export function prepareUnrankedInit(body) {
  const format = readFormat(body?.format);
  const length = isLength(body?.length) ? body.length : "sprint";
  const players = Array.isArray(body?.players) ? body.players.length : 0;
  const kind = normalizeKind(body?.kind, Boolean(body?.ranked), players);
  if (format === "passage") return { error: "race" };
  if (kind === "queue") return { error: "ranked" };
  if (!isMode(body?.mode)) return { error: "race" };
  if (format === "punctuation") {
    if (!punctuationAllowed(body.mode)) return { error: "cursor" };
    if (!punctuationOk(body.mode, LENGTHS[length].sentences, body.sentence)) return { error: "race" };
    return {
      format,
      length,
      limitMs: LENGTHS[length].limitMs,
      sentence: body.sentence,
      extra: { format },
    };
  }
  const durationMs = readDurationMs(body.durationMs);
  const seed = Number.isFinite(Number(body.seed)) ? Number(body.seed) >>> 0 : 1;
  const opened = openStream(timedPool(body.mode), seed);
  if (!opened.sentence) return { error: "race" };
  return {
    format,
    length,
    limitMs: durationMs,
    sentence: opened.sentence,
    extra: {
      format: "timed",
      durationMs,
      seed: opened.seed,
      stream: opened.text,
      pieceIndex: opened.pieceIndex,
      revealed: opened.revealed,
      ids: opened.ids,
      timeUp: false,
    },
  };
}

function streamState(state) {
  return {
    seed: state.seed,
    pieceIndex: state.pieceIndex || 0,
    text: typeof state.stream === "string" ? state.stream : "",
    revealed: state.revealed || 0,
    ids: Array.isArray(state.ids) ? state.ids : [],
  };
}

function writeStream(state, built) {
  state.stream = built.text;
  state.pieceIndex = built.pieceIndex;
  state.revealed = built.revealed;
  state.ids = built.ids;
}

export function ensureTimedStream(state, nextLength) {
  if (!state || state.format !== "timed") return;
  const pool = timedPool(state.mode);
  const built = streamState(state);
  const need = Math.max(0, Number(nextLength) || 0) + TIMED_REVEAL_REMAINING + TIMED_CHUNK_CHARS;
  extendStream(built, need, pool);
  writeStream(state, built);
}

export function pullTimedReveal(state, cursor) {
  if (!state || state.format !== "timed") return null;
  const built = streamState(state);
  const result = revealFor(built, cursor, timedPool(state.mode));
  writeStream(state, built);
  if (!result.grew) return null;
  state.sentence = result.sentence;
  return result.sentence;
}

export function timedLimitAction(standing) {
  if (standing === "cancel") return "cancel";
  return "finalize";
}
