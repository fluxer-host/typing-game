// Local practice only. Ranked matchmaking never sees this timeline.

export const BOT_WPM_MIN = 20;
export const BOT_WPM_MAX = 140;
export const BOT_PRESETS = [
  { id: "slow", label: "Slow", wpm: 30 },
  { id: "average", label: "Average", wpm: 55 },
  { id: "fast", label: "Fast", wpm: 90 },
];

const MISTAKE_P = 0.02;
const PAUSE_P = 0.035;
const JITTER_MIN = 0.94;
const JITTER_SPAN = 0.12;
const MISTAKE_EXTRA = 0.55;
const PAUSE_MIN_MS = 40;
const PAUSE_SPAN_MS = 80;

export function clampBotWpm(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 55;
  if (n < BOT_WPM_MIN) return BOT_WPM_MIN;
  if (n > BOT_WPM_MAX) return BOT_WPM_MAX;
  return n;
}

export function hashSeed(text) {
  let hash = 2166136261;
  const value = String(text ?? "");
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function normalizeSeed(seed) {
  const n = Number(seed);
  if (Number.isFinite(n)) return n >>> 0;
  return hashSeed(seed);
}

function unit(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n >= 1) return 0.999999;
  return n;
}

// One character of delay. A mistake adds time and does not move the index backward.
export function stepDelay(targetWpm, jitterUnit, eventUnit, pauseUnit) {
  const base = 12000 / clampBotWpm(targetWpm);
  const jitter = JITTER_MIN + unit(jitterUnit) * JITTER_SPAN;
  let delay = base * jitter;
  const event = unit(eventUnit);
  if (event < MISTAKE_P) delay += base * MISTAKE_EXTRA;
  else if (event < MISTAKE_P + PAUSE_P) delay += PAUSE_MIN_MS + unit(pauseUnit) * PAUSE_SPAN_MS;
  return delay;
}

export function mulberry32(seed) {
  let state = normalizeSeed(seed);
  return function next() {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function botLaneName(targetWpm) {
  return `Bot, ${clampBotWpm(targetWpm)} WPM`;
}

export function botTimeline(text, targetWpm, seed, random) {
  const passage = typeof text === "string" ? text : "";
  const target = clampBotWpm(targetWpm);
  const rand = typeof random === "function" ? random : mulberry32(seed);
  const samples = [{ t: 0, i: 0 }];
  if (!passage.length) return { targetWpm: target, finishMs: 0, samples };
  let elapsed = 0;
  for (let index = 1; index <= passage.length; index += 1) {
    elapsed += stepDelay(target, rand(), rand(), rand());
    let t = Math.round(elapsed);
    const prev = samples[samples.length - 1];
    if (t <= prev.t) t = prev.t + 1;
    samples.push({ t, i: index });
  }
  return { targetWpm: target, finishMs: samples[samples.length - 1].t, samples };
}
