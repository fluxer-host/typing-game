// Local practice history. Ranked rows from the server are merged only for display.

export const HISTORY_KEY = "tg_history_v1";
export const HISTORY_VERSION = 1;
export const HISTORY_LIMIT = 200;

export const LADDER_NAMES = { desktop: "Desktop", mobile: "Mobile", cursor: "Cursor" };
export const LENGTH_NAMES = { sprint: "Sprint", set: "Set", long: "Long" };

const LADDERS = ["desktop", "mobile", "cursor"];
const LENGTHS = ["sprint", "set", "long"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function ladderName(mode) {
  return LADDER_NAMES[mode] || "";
}

export function lengthName(length) {
  return LENGTH_NAMES[length] || "";
}

export function normalizeRun(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (!LADDER_NAMES[raw.mode] || !LENGTH_NAMES[raw.length]) return null;
  const wpm = Number(raw.wpm);
  const accuracy = Number(raw.accuracy);
  const ms = Number(raw.ms);
  const at = Number(raw.at);
  if (!Number.isFinite(wpm) || !Number.isFinite(accuracy) || !Number.isFinite(ms) || ms <= 0) return null;
  if (!Number.isFinite(at)) return null;
  const errors = Number(raw.errors);
  return {
    at,
    mode: raw.mode,
    length: raw.length,
    passageId: typeof raw.passageId === "string" ? raw.passageId : "",
    wpm,
    accuracy,
    ms,
    errors: Number.isFinite(errors) && errors > 0 ? errors : 0,
    ranked: false,
    opponent: raw.opponent === "bot" || raw.opponent === "ghost" ? raw.opponent : "",
    source: "local",
  };
}

export function capHistory(runs, limit = HISTORY_LIMIT) {
  const list = (Array.isArray(runs) ? runs : []).map(normalizeRun).filter(Boolean);
  list.sort((a, b) => a.at - b.at);
  const cap = Number.isInteger(limit) && limit > 0 ? limit : HISTORY_LIMIT;
  return list.slice(-cap);
}

export function parseHistory(raw) {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const data = JSON.parse(raw);
    if (!data || data.v !== HISTORY_VERSION || !Array.isArray(data.runs)) return [];
    return capHistory(data.runs);
  } catch {
    return [];
  }
}

export function historyPayload(runs) {
  return { v: HISTORY_VERSION, runs: capHistory(runs) };
}

export function loadHistory(storage) {
  try {
    const box = storage || globalThis.localStorage;
    if (!box || typeof box.getItem !== "function") return [];
    return parseHistory(box.getItem(HISTORY_KEY));
  } catch {
    return [];
  }
}

export function saveHistory(runs, storage) {
  try {
    const box = storage || globalThis.localStorage;
    if (!box || typeof box.setItem !== "function") return false;
    box.setItem(HISTORY_KEY, JSON.stringify(historyPayload(runs)));
    return true;
  } catch {
    return false;
  }
}

export function appendRun(runs, run) {
  return capHistory([...(Array.isArray(runs) ? runs : []), run]);
}

export function historyExport(runs) {
  return JSON.stringify(historyPayload(runs), null, 2);
}

function finiteRuns(runs) {
  return (Array.isArray(runs) ? runs : []).filter((run) => run && Number.isFinite(Number(run.wpm)));
}

export function personalBests(runs) {
  const best = {};
  for (const run of Array.isArray(runs) ? runs : []) {
    if (!LADDER_NAMES[run?.mode] || !LENGTH_NAMES[run?.length]) continue;
    const wpm = Number(run.wpm);
    if (!Number.isFinite(wpm)) continue;
    const accuracy = Number(run.accuracy);
    const key = `${run.mode}|${run.length}`;
    const prev = best[key];
    const prevAccuracy = Number(prev?.accuracy);
    if (!prev || wpm > Number(prev.wpm) || (wpm === Number(prev.wpm) && accuracy > prevAccuracy)) best[key] = run;
  }
  return best;
}

export function averageWpm(runs) {
  const list = finiteRuns(runs);
  if (!list.length) return 0;
  const sum = list.reduce((total, run) => total + Number(run.wpm), 0);
  return Math.round((sum / list.length) * 10) / 10;
}

export function averageAccuracy(runs) {
  const list = (Array.isArray(runs) ? runs : []).filter((run) => Number.isFinite(Number(run?.accuracy)));
  if (!list.length) return 0;
  const sum = list.reduce((total, run) => total + Number(run.accuracy), 0);
  return Math.round((sum / list.length) * 10) / 10;
}

export function bestByPassage(runs, passageIdForText) {
  const map = new Map();
  for (const run of Array.isArray(runs) ? runs : []) {
    const wpm = Number(run?.wpm);
    if (!Number.isFinite(wpm)) continue;
    const fromText = typeof passageIdForText === "function" ? passageIdForText(run.sentence) : "";
    const id = run?.passageId || fromText || "";
    if (!id) continue;
    const prev = map.get(id);
    if (!prev || wpm > Number(prev.wpm)) map.set(id, { ...run, passageId: id });
  }
  return [...map.values()].sort((a, b) => Number(b.wpm) - Number(a.wpm) || Number(a.at) - Number(b.at));
}

export function displayStanding(run) {
  if (!run || typeof run !== "object") return "";
  if (run.ranked === true || run.label === "rated") return "Ranked";
  if (run.label === "Unranked") return "Unranked";
  return "Practice";
}

export function practiceTitle(run) {
  if (run?.opponent === "bot") return "Practice vs bot";
  if (run?.opponent === "ghost") return "Practice vs ghost";
  return "Practice";
}

export function runKind(run) {
  const standing = displayStanding(run);
  if (standing === "Practice") return practiceTitle(run);
  return standing;
}

export function recentLabel(run) {
  const standing = runKind(run);
  const parts = [];
  if (standing === "Ranked" || standing === "Unranked") {
    if (run?.ms == null) parts.push("DNF");
    else if (run?.place != null) parts.push(`#${run.place}`);
  }
  parts.push(ladderName(run?.mode) || "Desktop");
  const length = lengthName(run?.length);
  if (length) parts.push(length);
  if (standing) parts.push(standing);
  return parts.join(" · ");
}

export function formatRunDate(at) {
  const date = new Date(Number(at));
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

export function serverRaceRow(race, lengthForText) {
  const sentence = typeof race?.sentence === "string" ? race.sentence : "";
  const length = typeof lengthForText === "function" ? lengthForText(sentence) : "";
  const at = Number(race?.finishedAt);
  const ms = race?.ms == null ? null : Number(race.ms);
  return {
    at: Number.isFinite(at) ? at : 0,
    mode: race?.mode || "",
    length: length || "",
    passageId: "",
    sentence,
    wpm: Number(race?.wpm) || 0,
    accuracy: Number(race?.accuracy) || 0,
    ms: Number.isFinite(ms) ? ms : null,
    errors: 0,
    ranked: Boolean(race?.ranked),
    label: race?.label || "",
    place: race?.place,
    racers: Number(race?.racers) || 0,
    source: "server",
  };
}

export function mergeRuns(localRuns, serverRuns) {
  const local = capHistory(localRuns).map((run) => ({ ...run, source: "local", ranked: false, label: "practice" }));
  const server = (Array.isArray(serverRuns) ? serverRuns : []).filter((run) => run && run.source === "server");
  return [...local, ...server].sort((a, b) => Number(a.at) - Number(b.at));
}

export function buildStatsModel({ local, server, passageIdForText, limit = 30 } = {}) {
  const localRuns = capHistory(local);
  const serverRuns = (Array.isArray(server) ? server : []).filter((run) => run && run.source === "server");
  const merged = mergeRuns(localRuns, serverRuns);
  const cap = Number.isInteger(limit) && limit > 0 ? limit : 30;
  const trend = merged.slice(-cap);
  return {
    localCount: localRuns.length,
    serverCount: serverRuns.length,
    total: merged.length,
    averageWpm: averageWpm(merged),
    averageAccuracy: averageAccuracy(merged),
    bests: personalBests(merged),
    recent: trend.slice().reverse(),
    trend,
    passages: bestByPassage(merged, passageIdForText).slice(0, 20),
    ladders: LADDERS,
    lengths: LENGTHS,
  };
}

export function excerpt(text, limit = 72) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  const cap = Number.isInteger(limit) && limit > 8 ? limit : 72;
  if (value.length <= cap) return value;
  return `${value.slice(0, cap - 3).trimEnd()}...`;
}
