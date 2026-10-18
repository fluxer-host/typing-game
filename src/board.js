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

export const LADDER_PAGE_SIZE = BOARD_DEFAULT_LIMIT;
export const LADDER_RANK_RADIUS = 2;

export function parseBoardQuery(params) {
  const mode = params.get("mode");
  if (!isMode(mode)) return { ok: false, error: "mode" };
  // Rating is one number per ladder. A length or a week would look like a
  // filter and still return the combined board, so those values are rejected.
  const length = params.get("length");
  if (length != null && length !== "") return { ok: false, error: "length" };
  const period = params.get("period");
  if (period != null && period !== "" && period !== "all") return { ok: false, error: "period" };
  const limitRaw = params.get("limit");
  const offsetRaw = params.get("offset");
  const limit = limitRaw == null || limitRaw === "" ? BOARD_DEFAULT_LIMIT : whole(limitRaw);
  const offset = offsetRaw == null || offsetRaw === "" ? 0 : whole(offsetRaw);
  if (limit == null || limit < 1 || limit > BOARD_MAX_LIMIT) return { ok: false, error: "limit" };
  if (offset == null || offset < 0 || offset > BOARD_MAX_OFFSET) return { ok: false, error: "offset" };
  return { ok: true, mode, limit, offset };
}

export function pageWindow(total, page, pageSize = LADDER_PAGE_SIZE) {
  const size = Number.isInteger(pageSize) && pageSize > 0 ? pageSize : LADDER_PAGE_SIZE;
  const count = Number.isFinite(Number(total)) && Number(total) > 0 ? Math.floor(Number(total)) : 0;
  const pages = count === 0 ? 1 : Math.ceil(count / size);
  let current = Number.isInteger(page) && page > 0 ? page : 1;
  if (current > pages) current = pages;
  const offset = (current - 1) * size;
  const start = count === 0 ? 0 : offset + 1;
  const end = count === 0 ? 0 : Math.min(offset + size, count);
  return {
    page: current,
    pages,
    offset,
    start,
    end,
    total: count,
    hasPrev: current > 1,
    hasNext: current < pages,
  };
}

export function pageLabel(window) {
  if (!window || window.total === 0) return "Page 1 of 1.";
  return `Page ${window.page} of ${window.pages}, showing ${window.start} to ${window.end} of ${window.total}.`;
}

export function rankWindow(rank, total, radius = LADDER_RANK_RADIUS) {
  const place = Number(rank);
  const count = Number(total);
  if (!Number.isInteger(place) || place < 1) return null;
  if (!Number.isFinite(count) || place > count) return null;
  const span = Number.isInteger(radius) && radius >= 0 ? radius : LADDER_RANK_RADIUS;
  const from = Math.max(1, place - span);
  const to = Math.min(Math.floor(count), place + span);
  return { from, to, offset: from - 1, limit: to - from + 1 };
}

export function winRate(wins, races) {
  const played = Number(races);
  const won = Number(wins);
  if (!Number.isFinite(played) || played <= 0) return null;
  if (!Number.isFinite(won) || won <= 0) return 0;
  return Math.min(1, won / played);
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

// Public ladder row. `avatarUrl` is already resolved. A custom avatar URL
// contains the account id, so that URL is dropped before the response.
export function shapeLadderRow(user, mode, rank) {
  const entry = boardEntry(user, mode, rank);
  const id = user?.id == null ? "" : String(user.id);
  let avatar = typeof user?.avatarUrl === "string" && user.avatarUrl ? user.avatarUrl : null;
  if (avatar && id && avatar.includes(id)) avatar = null;
  const color = Number(user?.avatar_color ?? user?.color);
  return {
    rank: entry.rank,
    name: entry.name,
    avatar,
    color: Number.isFinite(color) ? color : null,
    rating: entry.rating,
    races: entry.races,
    wins: entry.wins,
  };
}
