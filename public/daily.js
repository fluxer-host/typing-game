// Daily challenge on this browser. Scored attempts are checked by the Worker.

import { countdownLabel, formatUtcDay, utcDayString } from "../src/daily.js";
import { ladderName } from "./history.js";

export const DAILY_LOCAL_KEY = "tg_daily_v1";
export const DAILY_LOCAL_VERSION = 1;

const DIFFICULTY = { easy: "Easy", medium: "Medium", hard: "Hard" };

export function difficultyName(value) {
  return DIFFICULTY[value] || "";
}

export function browserStorage() {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

export function emptyDailyLocal() {
  return { v: DAILY_LOCAL_VERSION, runs: {} };
}

export function dailyLocalKey(ladder, day) {
  return `${ladder}|${day}`;
}

export function loadDailyLocal(storage) {
  if (!storage || typeof storage.getItem !== "function") return emptyDailyLocal();
  try {
    const raw = storage.getItem(DAILY_LOCAL_KEY);
    if (!raw) return emptyDailyLocal();
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.v !== DAILY_LOCAL_VERSION || !parsed.runs || typeof parsed.runs !== "object") {
      return emptyDailyLocal();
    }
    return { v: DAILY_LOCAL_VERSION, runs: parsed.runs };
  } catch {
    return emptyDailyLocal();
  }
}

export function rememberDailyLocal(storage, store, run) {
  const next = store && store.v === DAILY_LOCAL_VERSION && store.runs ? store : emptyDailyLocal();
  const key = dailyLocalKey(run?.ladder, run?.day);
  if (!key || key.startsWith("|") || key.endsWith("|")) return { store: next, saved: false };
  if (next.runs[key]) return { store: next, saved: true, kept: false };
  const row = {
    ladder: run.ladder,
    day: run.day,
    wpm: Number(run.wpm) || 0,
    accuracy: Number(run.accuracy) || 0,
    ms: Number(run.ms) || 0,
    passageId: run.passageId || "",
  };
  const runs = { ...next.runs, [key]: row };
  const saved = { v: DAILY_LOCAL_VERSION, runs };
  if (!storage || typeof storage.setItem !== "function") return { store: saved, saved: false, kept: true };
  try {
    storage.setItem(DAILY_LOCAL_KEY, JSON.stringify(saved));
    return { store: saved, saved: true, kept: true };
  } catch {
    return { store: saved, saved: false, kept: true };
  }
}

export function noteDailyStep(steps, text, limit) {
  if (!Array.isArray(steps) || typeof text !== "string") return steps || [];
  if (steps.length && steps[steps.length - 1] === text) return steps;
  if (steps.length >= limit) return steps;
  steps.push(text);
  return steps;
}

export function countdownText(nowMs, nextDayAt) {
  const next = Number(nextDayAt);
  const now = Number(nowMs);
  if (!Number.isFinite(next) || !Number.isFinite(now)) return "Next challenge in 00:00:00";
  return `Next challenge in ${countdownLabel(next - now)}`;
}

export function dailyClockDay(nowMs) {
  return utcDayString(nowMs);
}

export function dailyBoardPath(ladder, limit) {
  return `/api/daily?ladder=${encodeURIComponent(ladder)}&limit=${limit}`;
}

export async function fetchDaily(path, body) {
  const options = {
    credentials: "same-origin",
    cache: "no-store",
  };
  if (body !== undefined) {
    options.method = "POST";
    options.headers = { "content-type": "application/json" };
    options.body = JSON.stringify(body);
  }
  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, data };
}

export function dailyYouText({ signedIn, serverYou, localRun }) {
  if (serverYou) {
    const rank = serverYou.rank ? `, rank ${serverYou.rank}` : "";
    return `Your score: ${Number(serverYou.wpm).toFixed(1)} WPM, ${Number(serverYou.accuracy)}% accuracy${rank}.`;
  }
  if (!signedIn && localRun) {
    return `On this browser: ${Number(localRun.wpm).toFixed(1)} WPM, ${Number(localRun.accuracy)}% accuracy. Sign in to submit a score.`;
  }
  if (signedIn) return "You have not finished today's challenge.";
  return "You have not finished today's challenge. Sign in to submit a score.";
}

export function dailyMeta(ladder, difficulty, day) {
  const name = ladderName(ladder) || "Desktop";
  const skill = difficultyName(difficulty);
  const when = formatUtcDay(day);
  return [name, "Set", skill, when].filter(Boolean).join(" · ");
}

export function dailyAnnounce({ practice, pending, rejected, wpm, accuracy, ms, rank, signedIn }) {
  if (pending) return "Saving today's score.";
  const seconds = (Number(ms) / 1000).toFixed(1);
  const pace = `${Number(wpm).toFixed(1)} words per minute, ${Number(accuracy)}% accuracy, ${seconds} seconds`;
  if (rejected) return `Daily challenge. This finish was not saved. ${pace}.`;
  if (practice) {
    const tail = signedIn ? " Practice does not change today's score." : " Sign in to submit a score.";
    return `Daily challenge. Practice. ${pace}.${tail}`;
  }
  const place = rank ? `, rank ${rank}` : "";
  return `Daily challenge. Scored attempt. ${pace}${place}.`;
}

export function rejectCopy(reason) {
  if (reason === "rate") return "That finish was faster than the allowed pace.";
  if (reason === "jump" || reason === "backwards") return "The passage has to be typed one character at a time.";
  if (reason === "unfinished" || reason === "text") return "The passage did not match.";
  if (reason === "duration") return "The attempt ran longer than the time limit.";
  if (reason === "expired") return "That attempt has closed.";
  if (reason === "used") return "That attempt was already submitted.";
  if (reason === "scored") return "Today's score is already saved. This run is practice.";
  return "This finish was not saved.";
}
