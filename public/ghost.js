// Personal bests stay in localStorage. The server does not store ghost samples.

import { ladderName, lengthName } from "./history.js";

export const GHOST_KEY = "tg_ghosts_v1";
export const GHOST_VERSION = 1;
export const GHOST_SAMPLE_MS = 200;

const LADDERS = new Set(["desktop", "mobile", "cursor"]);
const LENGTHS = new Set(["sprint", "set", "long"]);

export function ghostKey(mode, length) {
  return `${mode}|${length}`;
}

function clampGap(sampleMs) {
  const n = Math.round(Number(sampleMs));
  if (!Number.isFinite(n)) return GHOST_SAMPLE_MS;
  if (n < 100) return 100;
  if (n > 250) return 250;
  return n;
}

export function compactTimeline(points, sampleMs = GHOST_SAMPLE_MS) {
  const gap = clampGap(sampleMs);
  const clean = [];
  for (const point of Array.isArray(points) ? points : []) {
    const t = Math.round(Number(point?.t));
    const i = Math.round(Number(point?.i));
    if (!Number.isFinite(t) || !Number.isFinite(i) || t < 0 || i < 0) continue;
    const last = clean[clean.length - 1];
    if (last && (t < last.t || i < last.i)) continue;
    if (last && t === last.t) {
      last.i = i;
      continue;
    }
    clean.push({ t, i });
  }
  if (clean.length <= 1) return clean;
  const out = [clean[0]];
  for (let n = 1; n < clean.length - 1; n += 1) {
    const prev = out[out.length - 1];
    if (clean[n].t - prev.t >= gap) out.push(clean[n]);
  }
  const end = clean[clean.length - 1];
  const prev = out[out.length - 1];
  if (prev.t !== end.t || prev.i !== end.i) {
    if (end.t <= prev.t) out.push({ t: prev.t + 1, i: end.i });
    else out.push(end);
  }
  return out;
}

export function noteSample(samples, elapsedMs, index, sampleMs = GHOST_SAMPLE_MS) {
  const list = Array.isArray(samples) ? samples : [];
  const time = Math.max(0, Math.round(Number(elapsedMs) || 0));
  const at = Math.max(0, Math.round(Number(index) || 0));
  if (!list.length) return [{ t: time, i: at }];
  const last = list[list.length - 1];
  if (time < last.t || at < last.i) return list;
  if (time - last.t < clampGap(sampleMs)) return list;
  return list.concat([{ t: time, i: at }]);
}

export function finishTrace(samples, ms, chars, sampleMs = GHOST_SAMPLE_MS) {
  const endT = Math.max(1, Math.round(Number(ms) || 0));
  const endI = Math.max(0, Math.round(Number(chars) || 0));
  const compact = compactTimeline([...(Array.isArray(samples) ? samples : []), { t: endT, i: endI }], sampleMs);
  if (!compact.length) return [{ t: 0, i: 0 }, { t: endT, i: endI }];
  if (compact[0].t !== 0 || compact[0].i !== 0) compact.unshift({ t: 0, i: 0 });
  const last = compact[compact.length - 1];
  if (last.i !== endI || last.t < endT) compact.push({ t: Math.max(last.t + 1, endT), i: endI });
  return compact;
}

export function progressAt(samples, elapsedMs, length) {
  const list = Array.isArray(samples) ? samples : [];
  const hasCap = length != null && Number.isFinite(Number(length)) && Number(length) >= 0;
  const cap = hasCap ? Math.round(Number(length)) : null;
  if (!list.length) return 0;
  const time = Number(elapsedMs);
  let index = 0;
  if (!Number.isFinite(time) || time <= 0) index = Math.max(0, Math.round(Number(list[0].i) || 0));
  else {
    for (const sample of list) {
      const t = Number(sample?.t);
      if (!Number.isFinite(t)) continue;
      if (t > time) break;
      index = Math.max(index, Math.round(Number(sample.i) || 0));
    }
  }
  if (cap != null) return Math.min(cap, index);
  return index;
}

function unpackPairs(flat) {
  if (!Array.isArray(flat) || !flat.length || flat.length % 2 !== 0) return [];
  const points = [];
  for (let n = 0; n < flat.length; n += 2) {
    const t = flat[n];
    const i = flat[n + 1];
    if (!Number.isInteger(t) || !Number.isInteger(i) || t < 0 || i < 0) return [];
    points.push({ t, i });
  }
  return compactTimeline(points);
}

export function readSamples(value) {
  if (!Array.isArray(value) || !value.length) return [];
  if (typeof value[0] === "number") return unpackPairs(value);
  return compactTimeline(value);
}

export function normalizeGhost(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (!LADDERS.has(raw.mode) || !LENGTHS.has(raw.length)) return null;
  const wpm = Number(raw.wpm);
  const accuracy = Number(raw.accuracy);
  const ms = Number(raw.ms);
  const chars = Math.round(Number(raw.chars));
  if (!Number.isFinite(wpm) || wpm < 0) return null;
  if (!Number.isFinite(accuracy)) return null;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  if (!Number.isInteger(chars) || chars <= 0) return null;
  const samples = readSamples(raw.samples);
  const last = samples[samples.length - 1];
  if (!last || last.i !== chars) return null;
  return {
    mode: raw.mode,
    length: raw.length,
    wpm,
    accuracy,
    ms,
    chars,
    passageId: typeof raw.passageId === "string" ? raw.passageId : "",
    samples,
  };
}

function betterGhost(next, prev) {
  if (next.wpm !== prev.wpm) return next.wpm > prev.wpm;
  if (next.accuracy !== prev.accuracy) return next.accuracy > prev.accuracy;
  return next.ms < prev.ms;
}

export function considerGhost(bests, run) {
  const source = bests && typeof bests === "object" && !Array.isArray(bests) ? bests : {};
  const next = normalizeGhost(run);
  if (!next) return { bests: source, kept: false };
  const key = ghostKey(next.mode, next.length);
  const prev = normalizeGhost(source[key]);
  if (!prev || betterGhost(next, prev)) return { bests: { ...source, [key]: next }, kept: true };
  return { bests: source, kept: false };
}

export function ghostFor(bests, mode, length) {
  if (!bests || typeof bests !== "object") return null;
  return normalizeGhost(bests[ghostKey(mode, length)]);
}

export function parseGhosts(raw) {
  if (typeof raw !== "string" || !raw) return {};
  try {
    const data = JSON.parse(raw);
    if (!data || data.v !== GHOST_VERSION || !data.bests || typeof data.bests !== "object" || Array.isArray(data.bests)) return {};
    const bests = {};
    for (const value of Object.values(data.bests)) {
      const ghost = normalizeGhost(value);
      if (!ghost) continue;
      bests[ghostKey(ghost.mode, ghost.length)] = ghost;
    }
    return bests;
  } catch {
    return {};
  }
}

function packSamples(samples) {
  const flat = [];
  for (const sample of samples) flat.push(sample.t, sample.i);
  return flat;
}

export function saveGhosts(bests, storage) {
  try {
    const box = storage || globalThis.localStorage;
    if (!box || typeof box.setItem !== "function") return false;
    const packed = {};
    for (const value of Object.values(bests || {})) {
      const ghost = normalizeGhost(value);
      if (!ghost) continue;
      packed[ghostKey(ghost.mode, ghost.length)] = {
        mode: ghost.mode,
        length: ghost.length,
        wpm: ghost.wpm,
        accuracy: ghost.accuracy,
        ms: ghost.ms,
        chars: ghost.chars,
        passageId: ghost.passageId,
        samples: packSamples(ghost.samples),
      };
    }
    box.setItem(GHOST_KEY, JSON.stringify({ v: GHOST_VERSION, bests: packed }));
    return true;
  } catch {
    return false;
  }
}

export function loadGhosts(storage) {
  try {
    const box = storage || globalThis.localStorage;
    if (!box || typeof box.getItem !== "function") return {};
    return parseGhosts(box.getItem(GHOST_KEY));
  } catch {
    return {};
  }
}

export function scaleGhost(samples, fromChars, toChars) {
  const from = Math.max(0, Math.round(Number(fromChars) || 0));
  const to = Math.max(0, Math.round(Number(toChars) || 0));
  const source = readSamples(samples);
  if (!to) return [{ t: 0, i: 0 }];
  if (!from || !source.length) return [{ t: 0, i: 0 }, { t: 1, i: to }];
  if (from === to) {
    const copy = source.map((sample) => ({ t: sample.t, i: Math.min(to, sample.i) }));
    if (copy[0].t !== 0 || copy[0].i !== 0) copy.unshift({ t: 0, i: 0 });
    const last = copy[copy.length - 1];
    if (last.i !== to) copy.push({ t: last.t + 1, i: to });
    return copy;
  }
  const ratio = to / from;
  const out = [];
  for (let n = 0; n < source.length; n += 1) {
    const lastPoint = n === source.length - 1;
    let t = Math.round(source[n].t * ratio);
    let i = lastPoint ? to : Math.round(source[n].i * ratio);
    if (i > to) i = to;
    if (i < 0) i = 0;
    if (t < 0) t = 0;
    const prev = out[out.length - 1];
    if (prev) {
      if (i < prev.i) i = prev.i;
      if (t < prev.t) t = prev.t;
      if (t === prev.t && i === prev.i) continue;
      if (t === prev.t) t = prev.t + 1;
    }
    out.push({ t, i });
  }
  if (!out.length || out[0].t !== 0 || out[0].i !== 0) out.unshift({ t: 0, i: 0 });
  const end = out[out.length - 1];
  if (end.i !== to) out.push({ t: end.t + 1, i: to });
  return out;
}

export function ghostLaneName(value) {
  const wpm = Number(value);
  const shown = Number.isFinite(wpm) ? Math.round(wpm) : 0;
  return `Your best, ${shown} WPM`;
}

export function ghostHint(mode, length, best) {
  if (best) return `Your best is ${Math.round(Number(best.wpm) || 0)} WPM.`;
  const ladder = ladderName(mode) || "this ladder";
  const span = lengthName(length) || "this length";
  return `Finish a ${span} on ${ladder} to race your best.`;
}
