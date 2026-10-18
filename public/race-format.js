// Lobby format controls, the timed clock, and local labels.
// The ladder is still "mode". This file is the passage, timed, or punctuation choice.

import { CURSOR_PUNCTUATION_NOTE, punctuationAllowed, readDurationMs, readFormat } from "../src/formats.js";
import { timedHeadline } from "../src/timed.js";

// Legacy device keys. Account preferences live in src/settings.js.
// A browser that still has these keys is read once into the guest settings.
export const FORMAT_KEY = "tg_format";
export const TIMED_KEY = "tg_timed";
export const RACE_META_KEY = "tg_race_meta_v1";
export const RACE_META_LIMIT = 40;

export { CURSOR_PUNCTUATION_NOTE, timedHeadline };

export const FORMAT_CHOICES = [
  { id: "passage", format: "passage", durationMs: 0, title: "Passage", blurb: "Finish the passage." },
  { id: "timed-30", format: "timed", durationMs: 30000, title: "Timed 30", blurb: "Unranked. 30 seconds." },
  { id: "timed-60", format: "timed", durationMs: 60000, title: "Timed 60", blurb: "Unranked. 60 seconds." },
  { id: "timed-120", format: "timed", durationMs: 120000, title: "Timed 120", blurb: "Unranked. 120 seconds." },
  { id: "punctuation", format: "punctuation", durationMs: 0, title: "Punctuation", blurb: "Unranked. Marks and capitals." },
];

export function choiceFor(format, durationMs) {
  const id = readFormat(format);
  if (id === "timed") {
    const ms = readDurationMs(durationMs);
    return FORMAT_CHOICES.find((row) => row.format === "timed" && row.durationMs === ms) || FORMAT_CHOICES[2];
  }
  return FORMAT_CHOICES.find((row) => row.id === id) || FORMAT_CHOICES[0];
}

export function loadFormatChoice(storage) {
  try {
    const box = storage || globalThis.localStorage;
    if (!box || typeof box.getItem !== "function") return choiceFor("passage", 0);
    return choiceFor(box.getItem(FORMAT_KEY), Number(box.getItem(TIMED_KEY)));
  } catch {
    return choiceFor("passage", 0);
  }
}

export function saveFormatChoice(storage, format, durationMs) {
  try {
    const box = storage || globalThis.localStorage;
    if (!box || typeof box.setItem !== "function") return false;
    const choice = choiceFor(format, durationMs);
    box.setItem(FORMAT_KEY, choice.format);
    if (choice.format === "timed") box.setItem(TIMED_KEY, String(choice.durationMs));
    else if (!box.getItem(TIMED_KEY)) box.setItem(TIMED_KEY, "60000");
    return true;
  } catch {
    return false;
  }
}

export function formatLabel(format, durationMs) {
  if (format === "timed") return `Timed ${Math.round(readDurationMs(durationMs) / 1000)}`;
  if (format === "punctuation") return "Punctuation";
  return "Passage";
}

export function formatSummary(format, durationMs, lengthTitle) {
  if (format === "timed") return `${formatLabel(format, durationMs)}s · Unranked`;
  if (format === "punctuation") return `Punctuation · ${lengthTitle} · Unranked`;
  return `${lengthTitle}`;
}

export function appendFormatChoices(parent, h, options) {
  const group = h("div", { class: "modes format-modes", role: "group", "aria-labelledby": "format-label" });
  group.append(h("span", { id: "format-label", class: "visually-hidden", text: "Race mode" }));
  const cursor = options.mode === "cursor";
  for (const info of FORMAT_CHOICES) {
    const selected = options.choiceId === info.id;
    const blocked = info.format === "punctuation" && !punctuationAllowed(options.mode);
    const button = h("button", {
      class: `format-choice${selected ? " selected" : ""}`,
      type: "button",
      "data-choice": info.id,
      "aria-pressed": selected ? "true" : "false",
      disabled: blocked ? true : null,
      onclick: () => options.onChoice(info),
    });
    button.append(h("strong", { text: info.title }));
    button.append(h("span", { text: info.blurb }));
    group.append(button);
  }
  parent.append(group);
  parent.append(h("p", {
    id: "format-note",
    class: "hint",
    hidden: cursor ? null : true,
    text: CURSOR_PUNCTUATION_NOTE,
  }));
  parent.append(h("p", {
    id: "format-queue-note",
    class: "hint",
    hidden: options.format === "passage" ? true : null,
    text: "Queue still starts a ranked Passage race on the selected length. Timed and Punctuation are unranked, in Practice and private rooms.",
  }));
}

export function remainingMs(startAt, durationMs, now) {
  const duration = Number(durationMs);
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  if (!Number.isFinite(startAt) || !Number.isFinite(now) || now < startAt) return duration;
  return Math.max(0, duration - (now - startAt));
}

export function timerModel(leftMs, durationMs) {
  const duration = Number(durationMs) || 0;
  const left = Math.max(0, Number(leftMs) || 0);
  const fraction = duration > 0 ? Math.min(1, left / duration) : 0;
  const seconds = Math.ceil(left / 1000);
  return {
    label: `${seconds}s`,
    percent: Math.round(fraction * 1000) / 10,
    done: left <= 0,
  };
}

export function applyChunk(current, next) {
  if (typeof next !== "string" || typeof current !== "string") return current;
  if (next.length >= current.length && next.startsWith(current)) return next;
  return current;
}

export function presentTimedSteps(steps) {
  return (steps || []).map((step) => (step?.kind === "fin" ? { ...step, kind: "prog" } : step));
}

export function resultFormatLine(results) {
  if (!results || results.cancelled) return "";
  if (results.format === "timed") {
    const seconds = Math.round((Number(results.durationMs) || 0) / 1000);
    return `Timed ${seconds}s · Unranked. Official result over ${seconds} seconds.`;
  }
  if (results.format === "punctuation") return "Punctuation · Unranked. Official result from the server.";
  return "";
}

export function rememberRaceMeta(storage, raceId, meta) {
  try {
    if (!raceId || !meta) return false;
    const box = storage || globalThis.localStorage;
    if (!box || typeof box.getItem !== "function") return false;
    const parsed = JSON.parse(box.getItem(RACE_META_KEY) || "{}");
    const races = parsed && typeof parsed.races === "object" && parsed.races ? parsed.races : {};
    races[raceId] = {
      format: readFormat(meta.format),
      durationMs: Number(meta.durationMs) || 0,
      length: typeof meta.length === "string" ? meta.length : "",
    };
    const ids = Object.keys(races);
    if (ids.length > RACE_META_LIMIT) {
      for (const id of ids.slice(0, ids.length - RACE_META_LIMIT)) delete races[id];
    }
    box.setItem(RACE_META_KEY, JSON.stringify({ v: 1, races }));
    return true;
  } catch {
    return false;
  }
}

export function raceMetaFor(storage, raceId) {
  try {
    const box = storage || globalThis.localStorage;
    if (!box || typeof box.getItem !== "function" || !raceId) return null;
    const parsed = JSON.parse(box.getItem(RACE_META_KEY) || "{}");
    const row = parsed?.races?.[raceId];
    if (!row) return null;
    return {
      format: readFormat(row.format),
      durationMs: Number(row.durationMs) || 0,
      length: row.length || "",
    };
  } catch {
    return null;
  }
}

export function bestKey(run) {
  const mode = run?.mode;
  const format = run?.format === "timed" || run?.format === "punctuation" ? run.format : "passage";
  if (format === "timed") {
    const duration = Number(run.durationMs);
    if (duration !== 30000 && duration !== 60000 && duration !== 120000) return "";
    return `${mode}|timed|${duration}`;
  }
  if (format === "punctuation") return `${mode}|punctuation|${run.length}`;
  return `${mode}|${run.length}`;
}
