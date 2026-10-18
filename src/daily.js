// Daily challenge rules. Ranked races do not import this module.
// The passage pick is pure so the Worker and the page choose the same text.

import { isMode } from "./modes.js";
import { MAX_KEYSTROKES_PER_SECOND, RATE_WINDOW_MS, validateProgress } from "./progress.js";
import { accuracy, wpm } from "./score.js";
import { poolFor } from "./sentences.js";

export const DAILY_LENGTH = "set";
export const DAILY_MAX_ATTEMPT_MS = 240_000;
export const DAILY_GRACE_MS = 240_000;
export const DAILY_RESULT_RETENTION_DAYS = 90;
export const DAILY_ATTEMPT_RETENTION_MS = 24 * 60 * 60 * 1000;
export const DAILY_BOARD_DEFAULT_LIMIT = 25;
export const DAILY_BOARD_MAX_LIMIT = 100;
export const DAILY_CARD_LIMIT = 10;
export const DAILY_CACHE_SECONDS = 30;
export const DAILY_MAX_STEPS = 800;
export const DAILY_MAX_BODY_CHARS = 64_000;
export const DAILY_STARTS_PER_DAY = 12;
export const DAILY_CLEANUP_BATCH = 100;
export const DAILY_CLEANUP_ROUNDS = 10;

const DAY_MS = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function utcDayStart(nowMs) {
  const now = Number(nowMs);
  if (!Number.isFinite(now)) return null;
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

export function utcDayString(nowMs) {
  const start = utcDayStart(nowMs);
  if (start == null) return "";
  const date = new Date(start);
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${date.getUTCFullYear()}-${month}-${day}`;
}

export function nextUtcMidnight(nowMs) {
  const start = utcDayStart(nowMs);
  if (start == null) return null;
  return start + DAY_MS;
}

export function parseUtcDay(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map((part) => Number(part));
  const startMs = Date.UTC(year, month - 1, day);
  const date = new Date(startMs);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return { day: value, startMs };
}

export function formatUtcDay(day) {
  const parsed = parseUtcDay(day);
  if (!parsed) return "";
  const date = new Date(parsed.startMs);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()} UTC`;
}

export function countdownLabel(remainingMs) {
  const left = Number(remainingMs);
  const total = Number.isFinite(left) && left > 0 ? Math.floor(left / 1000) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

export function dayAllowed(day, nowMs, retentionDays = DAILY_RESULT_RETENTION_DAYS) {
  const parsed = parseUtcDay(day);
  const today = utcDayStart(nowMs);
  if (!parsed || today == null) return { ok: false, error: "day" };
  if (parsed.startMs > today) return { ok: false, error: "future" };
  const keep = Number(retentionDays);
  const windowDays = Number.isFinite(keep) && keep > 0 ? Math.floor(keep) : DAILY_RESULT_RETENTION_DAYS;
  const oldest = today - (windowDays - 1) * DAY_MS;
  if (parsed.startMs < oldest) return { ok: false, error: "old" };
  return { ok: true, day: parsed.day, startMs: parsed.startMs };
}

function whole(value) {
  if (value == null || value === "") return null;
  if (!/^\d+$/.test(String(value))) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return null;
  return parsed;
}

export function parseDailyQuery(params, nowMs) {
  const ladder = params.get("ladder") || "desktop";
  if (!isMode(ladder)) return { ok: false, error: "ladder" };
  const dayRaw = params.get("day");
  const day = dayRaw == null || dayRaw === "" ? utcDayString(nowMs) : dayRaw;
  const allowed = dayAllowed(day, nowMs);
  if (!allowed.ok) return allowed;
  const limitRaw = params.get("limit");
  const limit = limitRaw == null || limitRaw === "" ? DAILY_BOARD_DEFAULT_LIMIT : whole(limitRaw);
  if (limit == null || limit < 1 || limit > DAILY_BOARD_MAX_LIMIT) return { ok: false, error: "limit" };
  return { ok: true, ladder, day: allowed.day, limit };
}

export function dailySeed(dayNumber, ladder) {
  const salt = ladder === "mobile" ? 0x6d6f62 : ladder === "cursor" ? 0x637572 : 0x646573;
  let x = (Number(dayNumber) + 1) >>> 0;
  x = Math.imul(x ^ salt, 0x9e3779b1);
  x ^= x >>> 16;
  return x >>> 0;
}

export function pickDailyPassage(pool, dayNumber, ladder) {
  const rows = (Array.isArray(pool) ? pool : []).filter((row) => row && row.id);
  rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (!rows.length) return null;
  const count = rows.length;
  if (count === 1) return rows[0];
  const end = Math.floor(Number(dayNumber));
  if (!Number.isFinite(end)) return null;
  // A bump has to skip the passage that was shown, not the raw index from the
  // day before. The chain starts at day 0 so that choice stays deterministic.
  const origin = end < 0 ? end : 0;
  let previousId = "";
  let chosen = null;
  for (let day = origin; day <= end; day += 1) {
    let index = dailySeed(day, ladder) % count;
    if (previousId && rows[index].id === previousId) index = (index + 1) % count;
    chosen = rows[index];
    previousId = chosen.id;
  }
  return chosen;
}

export function dailyPassage(ladder, day) {
  const parsed = parseUtcDay(day);
  if (!parsed || !isMode(ladder)) return null;
  const pool = poolFor(ladder, DAILY_LENGTH);
  const dayNumber = Math.floor(parsed.startMs / DAY_MS);
  return pickDailyPassage(pool, dayNumber, ladder);
}

export function passageForAttempt(ladder, passageId) {
  if (!isMode(ladder) || typeof passageId !== "string" || !passageId) return null;
  return poolFor(ladder, DAILY_LENGTH).find((row) => row.id === passageId) || null;
}

// The attempt belongs to the UTC day it started. A finish after midnight is
// still that day while it is inside the grace window and the attempt limit.
export function submissionWindow({
  startedAt,
  now,
  maxMs = DAILY_MAX_ATTEMPT_MS,
  graceMs = DAILY_GRACE_MS,
} = {}) {
  const start = Number(startedAt);
  const at = Number(now);
  if (!Number.isFinite(start) || !Number.isFinite(at)) return { ok: false, reason: "malformed" };
  if (at < start) return { ok: false, reason: "early" };
  const day = utcDayString(start);
  const dayEnd = utcDayStart(start) + DAY_MS;
  if (at > dayEnd + graceMs) return { ok: false, reason: "expired", day };
  const elapsedMs = at - start;
  if (elapsedMs > maxMs) return { ok: false, reason: "duration", day, elapsedMs };
  return { ok: true, day, elapsedMs };
}

export function stepsForPassage(text) {
  const value = typeof text === "string" ? text : "";
  const steps = [];
  for (let i = 1; i <= value.length; i += 1) steps.push(value.slice(0, i));
  return steps;
}

// Replay each typed string through the ranked progress check. elapsedMs is
// the server clock. Client timestamps, WPM, and accuracy are not inputs.
export function replayDaily({ passage, steps, elapsedMs }) {
  if (typeof passage !== "string" || !passage) return { ok: false, reason: "malformed" };
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > DAILY_MAX_STEPS) {
    return { ok: false, reason: "malformed" };
  }
  if (!Number.isFinite(elapsedMs)) return { ok: false, reason: "malformed" };
  let previous = "";
  let ok = 0;
  let err = 0;
  let total = 0;
  for (let i = 0; i < steps.length; i += 1) {
    const next = steps[i];
    if (typeof next !== "string") return { ok: false, reason: "malformed" };
    const recent = elapsedMs < RATE_WINDOW_MS ? total : 0;
    const verdict = validateProgress({
      passage,
      previous,
      next,
      elapsedMs,
      recentStrokes: recent,
      priorStrokes: total,
      kind: next === passage ? "fin" : "prog",
    });
    if (!verdict.ok) return { ok: false, reason: verdict.reason, disqualify: verdict.disqualify };
    previous = verdict.text;
    ok += verdict.okDelta;
    err += verdict.errDelta;
    total += 1;
    if (verdict.finished && i !== steps.length - 1) return { ok: false, reason: "malformed" };
  }
  if (previous !== passage) return { ok: false, reason: "unfinished" };
  return {
    ok: true,
    text: previous,
    okCount: ok,
    errCount: err,
    strokes: total,
    wpm: wpm(passage.length, elapsedMs),
    accuracy: accuracy(ok, err),
  };
}

export function scoreDecision({ existing, consumed }) {
  if (consumed) return { ok: false, status: 409, error: "used" };
  if (existing) return { ok: false, status: 409, error: "scored" };
  return { ok: true, status: 200 };
}

export function isUniqueViolation(error) {
  const parts = [error?.message, error?.cause?.message, error?.cause?.cause?.message];
  return parts.some((part) => typeof part === "string" && part.includes("UNIQUE constraint failed"));
}

export function shapeDailyRow(input) {
  const id = input?.id == null ? "" : String(input.id);
  let avatar = typeof input?.avatar === "string" && input.avatar ? input.avatar : null;
  if (avatar && id && avatar.includes(id)) avatar = null;
  const color = Number(input?.color);
  const row = {
    rank: Number(input?.rank) || 0,
    name: String(input?.name || "Racer"),
    avatar,
    color: Number.isFinite(color) ? color : null,
    wpm: Number(input?.wpm) || 0,
    accuracy: Number(input?.accuracy) || 0,
  };
  if (input?.self) row.self = true;
  if (Number.isFinite(Number(input?.ms))) row.ms = Number(input.ms);
  return row;
}

export function parseSubmitBody(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "body" };
  const attemptId = value.attemptId;
  if (typeof attemptId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(attemptId)) {
    return { ok: false, error: "attempt" };
  }
  if (!Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > DAILY_MAX_STEPS) {
    return { ok: false, error: "steps" };
  }
  const steps = [];
  for (const step of value.steps) {
    if (typeof step !== "string" || step.length > 500) return { ok: false, error: "steps" };
    steps.push(step);
  }
  return { ok: true, attemptId, steps };
}

export function strokeGapMs() {
  return RATE_WINDOW_MS / MAX_KEYSTROKES_PER_SECOND;
}
