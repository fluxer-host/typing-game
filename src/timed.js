// Timed races: a seeded passage stream, chunk reveal, and a clock-based result.
// Scoring uses wpm and accuracy from score.js. Keystroke checks use validateProgress.

import { validateProgress } from "./progress.js";
import { accuracy, wpm } from "./score.js";

export const TIMED_CHUNK_CHARS = 180;
export const TIMED_REVEAL_REMAINING = 80;

export function mixSeed(text) {
  let hash = 2166136261;
  const value = String(text ?? "");
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffleItems(items, seed) {
  const list = items.slice();
  const rng = mulberry32(seed >>> 0);
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const swap = list[i];
    list[i] = list[j];
    list[j] = swap;
  }
  return list;
}

function cycleSeed(seed, cycle) {
  return (seed + Math.imul(cycle + 1, 0x9E3779B9)) >>> 0;
}

// Each cycle is a shuffle of the pool. The first id of a new cycle is swapped
// when it would repeat the last id of the previous cycle.
export function cycleOrder(pool, seed, cycle) {
  const order = shuffleItems(pool, cycleSeed(seed, cycle));
  if (cycle > 0 && order.length > 1) {
    const prev = shuffleItems(pool, cycleSeed(seed, cycle - 1));
    if (order[0]?.id === prev[prev.length - 1]?.id) {
      const first = order[0];
      order[0] = order[1];
      order[1] = first;
    }
  }
  return order;
}

export function pieceAt(pool, seed, index) {
  if (!Array.isArray(pool) || !pool.length || index < 0) return null;
  const cycle = Math.floor(index / pool.length);
  const offset = index % pool.length;
  return cycleOrder(pool, seed >>> 0, cycle)[offset] || null;
}

export function numericSeed(seed) {
  if (typeof seed === "number" && Number.isFinite(seed)) return seed >>> 0;
  return mixSeed(seed);
}

function appendPiece(state, pool) {
  const piece = pieceAt(pool, state.seed, state.pieceIndex);
  state.pieceIndex += 1;
  if (!piece || typeof piece.text !== "string" || !piece.text) return false;
  const last = state.ids[state.ids.length - 1];
  if (piece.id === last) return false;
  state.ids.push(piece.id);
  state.text = state.text ? `${state.text} ${piece.text}` : piece.text;
  return true;
}

export function extendStream(state, minChars, pool) {
  if (!state || typeof state !== "object") return state;
  if (typeof state.text !== "string") state.text = "";
  const target = Math.max(0, Number(minChars) || 0);
  let guard = 0;
  const cap = Math.max(1000, (pool?.length || 1) * 20);
  while (state.text.length < target && guard < cap) {
    const before = state.text.length;
    appendPiece(state, pool);
    guard += 1;
    if (state.text.length === before && state.pieceIndex > cap) break;
  }
  return state;
}

export function openStream(pool, seed, options = {}) {
  const chunk = Number.isFinite(options.chunk) ? options.chunk : TIMED_CHUNK_CHARS;
  const state = {
    seed: numericSeed(seed),
    pieceIndex: 0,
    text: "",
    revealed: 0,
    ids: [],
  };
  extendStream(state, Math.max(1, chunk), pool);
  state.revealed = Math.min(state.text.length, Math.max(0, chunk));
  return {
    seed: state.seed,
    pieceIndex: state.pieceIndex,
    text: state.text,
    revealed: state.revealed,
    sentence: state.text.slice(0, state.revealed),
    ids: state.ids,
  };
}

// Reveal another chunk when the cursor is inside the threshold of the revealed end.
// The underlying stream grows first, so validation never sees the end of the text.
export function revealFor(state, cursor, pool, options = {}) {
  const remaining = Number.isFinite(options.remaining) ? options.remaining : TIMED_REVEAL_REMAINING;
  const chunk = Number.isFinite(options.chunk) ? options.chunk : TIMED_CHUNK_CHARS;
  const cursorIndex = Math.max(0, Number(cursor) || 0);
  if (state.revealed > 0 && state.revealed - cursorIndex >= remaining) {
    return { grew: false, sentence: state.text.slice(0, state.revealed) };
  }
  const goal = state.revealed <= 0 ? chunk : state.revealed + chunk;
  const need = Math.max(goal, cursorIndex + remaining);
  extendStream(state, need, pool);
  const next = Math.min(state.text.length, Math.max(state.revealed, need));
  const grew = next !== state.revealed;
  state.revealed = next;
  return { grew, sentence: state.text.slice(0, state.revealed) };
}

export function timedInputOpen({ now, startAt, durationMs, ended }) {
  if (ended) return false;
  if (!Number.isFinite(now) || !Number.isFinite(startAt) || !Number.isFinite(durationMs)) return false;
  return now <= startAt + durationMs;
}

// Same validator as a passage race. The passage is the server stream.
// Input after the clock, or after the race has ended, is closed.
export function reviewTimedSubmission({
  stream,
  previous,
  next,
  elapsedMs,
  recentStrokes,
  priorStrokes,
  kind,
  now,
  startAt,
  durationMs,
  ended,
}) {
  if (ended) return { ok: false, reason: "ended", disqualify: false };
  if (!timedInputOpen({ now, startAt, durationMs, ended: false })) {
    return { ok: false, reason: "closed", disqualify: false };
  }
  return validateProgress({
    passage: stream,
    previous,
    next,
    elapsedMs,
    recentStrokes,
    priorStrokes,
    kind,
  });
}

export function timedAlarmPlan(state, now) {
  if (!state || state.format !== "timed") return "ignore";
  if (state.results) return "ended";
  const duration = Number(state.durationMs || state.limitMs);
  if (Number.isFinite(state.startAt) && Number.isFinite(duration) && now >= state.startAt + duration) return "seal";
  return "continue";
}

function bandOf(row) {
  if (row.forfeitWin) return 0;
  if (row.outcome === "time") return 1;
  if (row.outcome === "timeout" || row.outcome === "disconnect" || row.outcome === "dnf") return 2;
  return 3;
}

function outcomeForTimed(presence, dq, timeUp) {
  if (dq) return "dnf";
  if (presence.forfeitWin) return "forfeit-win";
  if (presence.forfeit) return "forfeit";
  if (presence.dnfReason === "idle") return "timeout";
  if (presence.dnfReason === "disconnect") return "disconnect";
  if (timeUp) return "time";
  return "dnf";
}

// Most correct characters, then higher accuracy. Equal scores share a place.
// The next distinct score takes the following index (1, 1, 3).
export function rankTimed(rows) {
  const list = (rows || []).map((row) => ({ ...row }));
  list.sort((a, b) => {
    const band = bandOf(a) - bandOf(b);
    if (band) return band;
    if (a.correct !== b.correct) return b.correct - a.correct;
    if (a.accuracy !== b.accuracy) return b.accuracy - a.accuracy;
    return String(a.name).localeCompare(String(b.name));
  });
  let place = 1;
  return list.map((row, index) => {
    if (index > 0) {
      const prev = list[index - 1];
      const same = bandOf(prev) === bandOf(row) && prev.correct === row.correct && prev.accuracy === row.accuracy;
      if (!same) place = index + 1;
    }
    return { ...row, place };
  });
}

export function buildTimedResults(state, now) {
  const durationMs = Number(state.durationMs || state.limitMs) || 0;
  const timeUp = Boolean(state.timeUp) || (Number.isFinite(now) && Number.isFinite(state.startAt) && now >= state.startAt + durationMs);
  const prepared = (state.players || []).map((player) => {
    const progress = state.progress?.[player.id] || { i: 0, ok: 0, err: 0 };
    const presence = state.presence?.[player.id] || {};
    const dq = Boolean(progress.dq);
    const outcome = outcomeForTimed(presence, dq, timeUp);
    const correct = Math.max(0, Number(progress.i) || 0);
    const ok = Number(progress.ok) || 0;
    const err = Number(progress.err) || 0;
    const typed = ok + err;
    return {
      player,
      dq,
      outcome,
      forfeitWin: outcome === "forfeit-win",
      correct,
      ok,
      err,
      accuracy: typed > 0 ? accuracy(ok, err) : accuracy(0, 0),
    };
  });
  const ranked = rankTimed(prepared);
  const completers = ranked.filter((row) => row.outcome === "time" && row.place === 1);
  return {
    cancelled: false,
    ranked: false,
    kind: state.kind || "room",
    mode: state.mode,
    format: "timed",
    durationMs,
    draw: completers.length > 1,
    sentence: state.sentence || "",
    rows: ranked.map((row) => {
      const completed = row.outcome === "time" || row.outcome === "forfeit-win";
      return {
        id: row.player.id,
        name: row.player.name,
        tag: row.player.tag,
        avatar: row.player.avatar || null,
        color: row.player.color ?? null,
        place: row.place,
        finished: completed,
        outcome: row.outcome,
        wpm: wpm(row.correct, durationMs),
        accuracy: row.accuracy,
        ms: completed ? durationMs : null,
        progress: row.correct,
        dq: row.dq,
        eloBefore: null,
        eloAfter: null,
      };
    }),
  };
}

export function timedHeadline(rows, meId) {
  const me = (rows || []).find((row) => row.id === meId);
  if (!me) return { title: "Time is up", detail: "The clock ran out." };
  if (me.outcome === "forfeit") return { title: "You left", detail: "This race does not change rating." };
  if (me.outcome === "timeout" || me.outcome === "disconnect") return { title: "Timed out", detail: "The race moved on without you." };
  const winners = (rows || []).filter((row) => row.place === 1 && row.outcome === "time");
  if (winners.length > 1 && me.outcome === "time" && me.place === 1) {
    return { title: "Draw", detail: "You tied on correct characters and accuracy." };
  }
  if (me.place === 1 && me.outcome === "time") {
    return { title: "You win", detail: "You typed the most correct characters." };
  }
  if (me.outcome === "forfeit-win" || (me.place === 1 && me.finished)) {
    return { title: "You win", detail: "The other racer left." };
  }
  return { title: "Time is up", detail: "Correct characters decide the order." };
}
