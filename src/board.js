import { MODE_COLUMNS, isMode } from "./modes.js";
import { displayName } from "./profile.js";

export const BOARD_DEFAULT_LIMIT = 25;
export const BOARD_MAX_LIMIT = 100;
export const BOARD_MAX_OFFSET = 10_000;
export const BOARD_CACHE_SECONDS = 30;

function whole(value) {
  if (value == null || value === "") return null;
  if (!/^\d+$/.test(String(value))) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return null;
  return parsed;
}

export function parseBoardQuery(params) {
  const mode = params.get("mode");
  if (!isMode(mode)) return { ok: false, error: "mode" };
  const limitRaw = params.get("limit");
  const offsetRaw = params.get("offset");
  const limit = limitRaw == null || limitRaw === "" ? BOARD_DEFAULT_LIMIT : whole(limitRaw);
  const offset = offsetRaw == null || offsetRaw === "" ? 0 : whole(offsetRaw);
  if (limit == null || limit < 1 || limit > BOARD_MAX_LIMIT) return { ok: false, error: "limit" };
  if (offset == null || offset < 0 || offset > BOARD_MAX_OFFSET) return { ok: false, error: "offset" };
  return { ok: true, mode, limit, offset };
}

function finite(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// One ladder's numbers. SQL NULL best sorts last in DESC, matching -1 here.
export function modeStats(user, mode) {
  const cols = MODE_COLUMNS[mode];
  const bestRaw = user[cols.best] ?? user.best;
  const best = bestRaw == null || bestRaw === "" ? null : Number(bestRaw);
  return {
    elo: finite(user[cols.elo] ?? user.elo, 1000),
    races: finite(user[cols.races] ?? user.races, 0),
    wins: finite(user[cols.wins] ?? user.wins, 0),
    best: Number.isFinite(best) ? best : null,
  };
}

// Negative when `a` ranks above `b`. Ties break on id so the page is stable.
// The leaderboard COUNT query uses the same order.
export function compareBoard(a, b, mode) {
  const left = modeStats(a, mode);
  const right = modeStats(b, mode);
  if (left.elo !== right.elo) return right.elo - left.elo;
  const leftBest = left.best == null ? -1 : left.best;
  const rightBest = right.best == null ? -1 : right.best;
  if (leftBest !== rightBest) return rightBest - leftBest;
  const leftId = String(a.id);
  const rightId = String(b.id);
  if (leftId < rightId) return -1;
  if (leftId > rightId) return 1;
  return 0;
}

export function placedRank(user, field, mode) {
  const stats = modeStats(user, mode);
  if (stats.races <= 0) return null;
  let ahead = 0;
  for (const other of field) {
    if (String(other.id) === String(user.id)) continue;
    if (modeStats(other, mode).races <= 0) continue;
    if (compareBoard(other, user, mode) < 0) ahead += 1;
  }
  return ahead + 1;
}

export function boardEntry(user, mode, rank) {
  const stats = modeStats(user, mode);
  return {
    rank,
    name: displayName(user),
    rating: stats.elo,
    races: stats.races,
    wins: stats.wins,
  };
}
