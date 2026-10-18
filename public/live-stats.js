// Display-only pace for the race screen. Ranked and practice results keep
// using wpm() and accuracy() from src/score.js.

import { accuracy } from "../src/score.js";
import { correctLength } from "./input.js";

export const LIVE_WARMUP_MS = 3000;
export const LIVE_WARMUP_CHARS = 10;
export const LIVE_MIN_SPAN_MS = 1000;
export const LIVE_WINDOW_MS = 5000;
export const LIVE_WINDOW_WEIGHT = 0.45;
export const LIVE_RESUME_GAP_MS = 2000;
export const LIVE_DASH = "\u2014";
export const LIVE_WARMING_TEXT = "Warming up";
export const LIVE_FIX_HINT = "Fix the error with Backspace";

export function emptyLiveTrack() {
  return { samples: [], anchorMs: null, anchorChars: 0 };
}

function rawRate(chars, ms) {
  if (!Number.isFinite(chars) || !Number.isFinite(ms) || chars <= 0 || ms <= 0) return 0;
  return chars / 5 / (ms / 60000);
}

function roundTenth(value) {
  return Math.round(value * 10) / 10;
}

function trimSamples(samples, now) {
  const cutoff = now - LIVE_WINDOW_MS;
  let index = 0;
  while (index < samples.length - 1 && samples[index + 1].t <= cutoff) index += 1;
  return index > 0 ? samples.slice(index) : samples;
}

export function stepLiveTrack(track, { elapsedMs, correctChars } = {}) {
  const prev = track && Array.isArray(track.samples) ? track : emptyLiveTrack();
  const t = Number(elapsedMs);
  const chars = Number.isFinite(Number(correctChars)) ? Math.max(0, Number(correctChars)) : 0;
  if (!Number.isFinite(t) || t < 0) return prev;
  const last = prev.samples[prev.samples.length - 1];
  const lateStart = prev.samples.length === 0 && chars > 0 && t > LIVE_WARMUP_MS;
  const gap = Boolean(last) && t - last.t > LIVE_RESUME_GAP_MS;
  if (lateStart || gap) {
    return { samples: [{ t, chars }], anchorMs: t, anchorChars: chars };
  }
  let samples = prev.samples.slice();
  if (!last) samples = [{ t, chars }];
  else if (t < last.t) return prev;
  else if (t === last.t) samples[samples.length - 1] = { t, chars };
  else samples.push({ t, chars });
  return {
    samples: trimSamples(samples, t),
    anchorMs: prev.anchorMs,
    anchorChars: prev.anchorChars || 0,
  };
}

function rollingRate(samples, now) {
  if (!Array.isArray(samples) || samples.length < 2) return { rate: null, span: 0 };
  const cutoff = now - LIVE_WINDOW_MS;
  let anchor = samples[0];
  for (const sample of samples) {
    if (sample.t <= cutoff) anchor = sample;
    else break;
  }
  const latest = samples[samples.length - 1];
  const span = latest.t - anchor.t;
  if (span < LIVE_MIN_SPAN_MS) return { rate: null, span };
  const delta = latest.chars - anchor.chars;
  return { rate: delta <= 0 ? 0 : rawRate(delta, span), span };
}

export function typingBlocked(typed, sentence) {
  const target = typeof sentence === "string" ? sentence : "";
  const input = typeof typed === "string" ? typed : "";
  if (!target) return false;
  const good = correctLength(input, target);
  return input.length > good && good < target.length;
}

export function liveStatsModel({
  elapsedMs = 0,
  correctChars = 0,
  ok = 0,
  err = 0,
  typed = "",
  sentence = "",
  track = emptyLiveTrack(),
  started = true,
} = {}) {
  const elapsed = Number.isFinite(Number(elapsedMs)) ? Number(elapsedMs) : 0;
  const chars = Number.isFinite(Number(correctChars)) ? Math.max(0, Number(correctChars)) : 0;
  const good = Number.isFinite(Number(ok)) && Number(ok) > 0 ? Number(ok) : 0;
  const bad = Number.isFinite(Number(err)) && Number(err) > 0 ? Number(err) : 0;
  const keystrokes = good + bad;
  const blocked = started && typingBlocked(typed, sentence);
  const clockText = !started || elapsed < 0 ? "ready" : `${(Math.max(0, elapsed) / 1000).toFixed(1)}s`;
  const base = {
    clockText,
    blocked,
    hint: blocked ? LIVE_FIX_HINT : "",
    wpmValue: null,
    accuracyValue: null,
  };
  if (!started || (keystrokes <= 0 && chars <= 0)) {
    return {
      ...base,
      phase: "dash",
      wpmText: LIVE_DASH,
      accuracyText: LIVE_DASH,
    };
  }
  const accuracyValue = accuracy(good, bad);
  const accuracyText = `${accuracyValue}%`;
  const anchorMs = Number.isFinite(track?.anchorMs) ? track.anchorMs : null;
  const anchorChars = Number.isFinite(track?.anchorChars) ? track.anchorChars : 0;
  const since = anchorMs == null ? Math.max(0, elapsed) : Math.max(0, elapsed - anchorMs);
  const gained = anchorMs == null ? chars : chars - anchorChars;
  const ready = since >= LIVE_WARMUP_MS || (gained >= LIVE_WARMUP_CHARS && since >= LIVE_MIN_SPAN_MS);
  if (!ready) {
    return {
      ...base,
      phase: "warming",
      wpmText: LIVE_WARMING_TEXT,
      accuracyText,
      accuracyValue,
    };
  }
  const overall = rawRate(chars, Math.max(elapsed, 1));
  const window = rollingRate(track?.samples, elapsed);
  const weight = window.rate == null ? 0 : LIVE_WINDOW_WEIGHT * Math.min(1, window.span / LIVE_WINDOW_MS);
  const blended = roundTenth(window.rate == null ? overall : window.rate * weight + overall * (1 - weight));
  return {
    ...base,
    phase: "live",
    wpmText: blended.toFixed(1),
    accuracyText,
    wpmValue: blended,
    accuracyValue,
  };
}

export function officialResultNote(liveWpm, officialWpm) {
  const official = Number(officialWpm);
  if (!Number.isFinite(official)) return "";
  if (liveWpm == null || liveWpm === "") return "Official result. The live pace was still warming up.";
  const live = Number(liveWpm);
  if (!Number.isFinite(live)) return "Official result. The live pace was still warming up.";
  if (Math.abs(live - official) < 0.15) return "";
  return `Official result ${official.toFixed(1)} WPM. The live pace was a smoothed ${live.toFixed(1)}.`;
}
