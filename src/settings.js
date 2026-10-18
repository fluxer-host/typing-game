// Shared lobby preferences. The client and the Worker both use this module.
// Unknown keys are dropped. A wrong type falls back to the default.
// The stored object is not allowed to change race scoring or matchmaking.

import { DEFAULT_TIMED_MS, FORMAT_IDS, TIMED_DURATIONS_MS, punctuationAllowed } from "./formats.js";
import { isLength } from "./lengths.js";
import { isMode } from "./modes.js";

export const SETTINGS_VERSION = 1;
export const SETTINGS_MAX_BYTES = 2048;
export const SETTINGS_SAVE_MS = 500;
export const SETTINGS_RETRY_BASE_MS = 1000;
export const SETTINGS_RETRY_CAP_MS = 8000;
export const SETTINGS_FAIL_NOTICE_AFTER = 3;
export const SETTINGS_PUT_LIMIT = 30;
export const SETTINGS_PUT_WINDOW_MS = 60_000;

export const GUEST_SETTINGS_KEY = "typing:v1:guest-settings";
export const ACCOUNT_SETTINGS_KEY = "typing:v1:account-settings";
export const SETTINGS_CHANNEL = "typing-settings-v1";
export const SETTINGS_FAIL_MESSAGE = "Settings could not be saved. This browser will keep trying.";

export const LEGACY_LADDER_KEY = "tg_mode";
export const LEGACY_LENGTH_KEY = "tg_length";
export const LEGACY_FORMAT_KEY = "tg_format";
export const LEGACY_TIMED_KEY = "tg_timed";

const encoder = new TextEncoder();

export function defaultSettings() {
  return {
    v: SETTINGS_VERSION,
    ladder: "desktop",
    length: "sprint",
    format: "passage",
    durationMs: DEFAULT_TIMED_MS,
  };
}

export function settingsByteLength(value) {
  const text = typeof value === "string" ? value : settingsJson(value);
  return encoder.encode(text).length;
}

export function withinSettingsLimit(value) {
  return settingsByteLength(value) <= SETTINGS_MAX_BYTES;
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// One allowlist. Legacy "mode" is the ladder. Legacy "timed" is the duration.
export function normalizeSettings(input) {
  const source = plainObject(input) ? input : {};
  const ladderSource = typeof source.ladder === "string"
    ? source.ladder
    : typeof source.mode === "string"
      ? source.mode
      : "";
  const ladder = isMode(ladderSource) ? ladderSource : "desktop";
  const length = typeof source.length === "string" && isLength(source.length) ? source.length : "sprint";
  let format = typeof source.format === "string" && FORMAT_IDS.includes(source.format) ? source.format : "passage";
  if (format === "punctuation" && !punctuationAllowed(ladder)) format = "passage";
  let durationMs = DEFAULT_TIMED_MS;
  if (typeof source.durationMs === "number" && TIMED_DURATIONS_MS.includes(source.durationMs)) {
    durationMs = source.durationMs;
  } else if (typeof source.timed === "number" && TIMED_DURATIONS_MS.includes(source.timed)) {
    durationMs = source.timed;
  }
  return {
    v: SETTINGS_VERSION,
    ladder,
    length,
    format,
    durationMs,
  };
}

export function settingsJson(settings) {
  const clean = normalizeSettings(settings);
  return JSON.stringify({
    v: clean.v,
    ladder: clean.ladder,
    length: clean.length,
    format: clean.format,
    durationMs: clean.durationMs,
  });
}

// NULL means this account has never saved settings. Any other stored value
// counts as saved, and an unreadable blob falls back to the defaults.
export function parseStoredSettings(value) {
  if (value == null) return { saved: false, settings: defaultSettings() };
  if (typeof value !== "string" || !withinSettingsLimit(value)) {
    return { saved: true, settings: defaultSettings() };
  }
  try {
    const parsed = JSON.parse(value);
    if (!plainObject(parsed)) return { saved: true, settings: defaultSettings() };
    return { saved: true, settings: normalizeSettings(parsed) };
  } catch {
    return { saved: true, settings: defaultSettings() };
  }
}

export function mergeOnSignIn({ serverSaved, serverSettings, guest }) {
  if (serverSaved) return { settings: normalizeSettings(serverSettings), upload: false };
  if (guest) return { settings: normalizeSettings(guest), upload: true };
  return { settings: defaultSettings(), upload: false };
}

export function liveFields(settings) {
  const clean = normalizeSettings(settings);
  return {
    mode: clean.ladder,
    length: clean.length,
    format: clean.format,
    durationMs: clean.format === "timed" ? clean.durationMs : 0,
    settings: clean,
  };
}

function storageGet(storage, key) {
  try {
    if (!storage || typeof storage.getItem !== "function") return null;
    const value = storage.getItem(key);
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

function timedFromLegacy(value) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return TIMED_DURATIONS_MS.includes(parsed) ? parsed : undefined;
}

// null when none of the old keys are present. A present key is migrated once.
export function readLegacySettings(storage) {
  const mode = storageGet(storage, LEGACY_LADDER_KEY);
  const length = storageGet(storage, LEGACY_LENGTH_KEY);
  const format = storageGet(storage, LEGACY_FORMAT_KEY);
  const timed = storageGet(storage, LEGACY_TIMED_KEY);
  if (mode == null && length == null && format == null && timed == null) return null;
  return normalizeSettings({
    ladder: mode || undefined,
    length: length || undefined,
    format: format || undefined,
    durationMs: timedFromLegacy(timed),
  });
}

// null when the guest key is absent. Invalid JSON still counts as present.
export function readGuestSettings(storage) {
  const raw = storageGet(storage, GUEST_SETTINGS_KEY);
  if (raw == null) return null;
  try {
    return normalizeSettings(JSON.parse(raw));
  } catch {
    return defaultSettings();
  }
}

export function openingSettings(storage) {
  return readGuestSettings(storage) || readLegacySettings(storage) || defaultSettings();
}

export function guestForUpload(storage) {
  return readGuestSettings(storage) || readLegacySettings(storage);
}

export function raceInProgress(view) {
  const phase = view?.phase || "";
  return phase === "countdown" || phase === "race" || phase === "finishing" || phase === "queue" || phase === "room";
}

export function controlsLocked(view) {
  if (raceInProgress(view)) return true;
  const shell = view?.shell || "";
  return shell === "race" || shell === "queue" || shell === "room";
}

export function remoteIsNewer(localAt, remoteAt) {
  const remote = Number(remoteAt);
  const local = Number(localAt);
  if (!Number.isFinite(remote)) return true;
  if (!Number.isFinite(local) || local <= 0) return true;
  return remote >= local;
}

export function crossTabAction({ racing, signedIn, accountId, event }) {
  if (!event || typeof event !== "object") return "ignore";
  if (event.type === "guest") {
    if (signedIn) return "ignore";
    return racing ? "defer" : "apply";
  }
  if (event.type === "signed-out") {
    if (!signedIn) return "ignore";
    if (event.accountId && accountId && event.accountId !== accountId) return "ignore";
    return racing ? "reload-later" : "reload";
  }
  if (event.type === "account") {
    if (!signedIn || !accountId || event.accountId !== accountId) {
      return racing ? "reload-later" : "reload";
    }
    return racing ? "defer" : "apply";
  }
  return "ignore";
}

export function parseNotice(value) {
  if (!plainObject(value)) return null;
  const at = Number(value.at) || 0;
  if (value.type === "guest") {
    return { type: "guest", settings: normalizeSettings(value.settings), at };
  }
  if (value.type === "signed-out") {
    return { type: "signed-out", accountId: String(value.accountId || ""), at };
  }
  if (value.type === "account") {
    return {
      type: "account",
      accountId: String(value.accountId || ""),
      settings: normalizeSettings(value.settings),
      at,
    };
  }
  return null;
}

export function accountNotice(accountId, settings, at) {
  return {
    type: "account",
    accountId: String(accountId || ""),
    settings: normalizeSettings(settings),
    at: Number(at) || 0,
  };
}

export function freshSave() {
  return {
    latest: null,
    rev: 0,
    ackedRev: 0,
    sendingRev: 0,
    dueAt: 0,
    retryAt: 0,
    failures: 0,
    noticed: false,
  };
}

function retryDelay(failures) {
  const step = Math.max(0, Number(failures) - 1);
  const delay = SETTINGS_RETRY_BASE_MS * 2 ** step;
  if (!Number.isFinite(delay)) return SETTINGS_RETRY_CAP_MS;
  return Math.min(SETTINGS_RETRY_CAP_MS, delay);
}

function finish(state, send = null, announce = "", clearNotice = false) {
  return { state, send, announce, clearNotice };
}

// Latest edit wins. A burst keeps one payload. A failed save waits, then sends that payload.
export function reduceSave(state, event) {
  const next = { ...state };
  if (!event || typeof event !== "object") return finish(next);
  if (event.type === "change") {
    next.rev += 1;
    next.latest = event.settings;
    next.retryAt = 0;
    next.failures = 0;
    next.noticed = false;
    if (!next.sendingRev) next.dueAt = Number(event.now) + SETTINGS_SAVE_MS;
    return finish(next, null, "", true);
  }
  if (event.type === "tick") {
    if (next.sendingRev || !next.latest || next.rev === next.ackedRev) return finish(next);
    const now = Number(event.now);
    const due = next.dueAt > 0 && now >= next.dueAt;
    const retry = next.retryAt > 0 && now >= next.retryAt;
    if (!due && !retry) return finish(next);
    next.sendingRev = next.rev;
    next.dueAt = 0;
    next.retryAt = 0;
    return finish(next, { settings: next.latest, rev: next.rev });
  }
  if (event.type === "flush") {
    if (!next.latest || next.rev === next.ackedRev || next.sendingRev === next.rev) return finish(next);
    next.dueAt = 0;
    next.retryAt = 0;
    next.sendingRev = next.rev;
    return finish(next, { settings: next.latest, rev: next.rev });
  }
  if (event.type === "ack" || event.type === "fail") {
    if (event.rev !== next.sendingRev) return finish(next);
    next.sendingRev = 0;
    if (event.type === "ack") {
      next.ackedRev = event.rev;
      next.failures = 0;
      next.noticed = false;
      next.dueAt = 0;
      next.retryAt = 0;
      if (next.latest && next.rev !== next.ackedRev) {
        next.sendingRev = next.rev;
        return finish(next, { settings: next.latest, rev: next.rev }, "", true);
      }
      return finish(next, null, "", true);
    }
    next.failures += 1;
    next.retryAt = Number(event.now) + retryDelay(next.failures);
    next.dueAt = 0;
    if (next.failures >= SETTINGS_FAIL_NOTICE_AFTER && !next.noticed) {
      next.noticed = true;
      return finish(next, null, SETTINGS_FAIL_MESSAGE);
    }
    return finish(next);
  }
  return finish(next);
}
