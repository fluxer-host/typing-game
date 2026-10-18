import { BOARD_CACHE_SECONDS, parseBoardQuery, rankWindow, shapeLadderRow } from "./board.js";
import { leaderboard, leaderboardCount, leaderboardRank, recentRaces } from "./db.js";
import { json } from "./http.js";
import { resolveUser } from "./identity.js";
import { lengthList } from "./lengths.js";
import { MODE_LIST } from "./modes.js";
import { avatarUrl, publicPlayer } from "./profile.js";
import { standingLabel } from "./rating.js";
import { shareEnabled } from "./share-token.js";
import { parseStoredSettings } from "./settings.js";

export function config(env) {
  return json({
    oauth: Boolean(env.FLUXER_CLIENT_ID && env.FLUXER_CLIENT_SECRET),
    devLogin: env.ALLOW_DEV_LOGIN === "true",
    modes: MODE_LIST,
    lengths: lengthList(),
    media: env.MEDIA_BASE || "https://fluxerusercontent.com",
    staticCdn: env.STATIC_CDN || "https://fluxerstatic.com",
    share: shareEnabled(env),
  }, { cache: "private, max-age=60" });
}

export async function health(env) {
  try {
    await env.DB.prepare("SELECT 1 AS ok").first();
    return json({ ok: true });
  } catch (error) {
    console.error("health check failed", error);
    return json({ ok: false, error: "database" }, { status: 500 });
  }
}

export async function me(request, env) {
  const resolved = await resolveUser(request, env);
  if (!resolved) return json({ user: null });
  const stored = parseStoredSettings(
    Object.prototype.hasOwnProperty.call(resolved.user, "settings") ? resolved.user.settings : null,
  );
  return json({
    user: publicPlayer(resolved.user, env),
    settings: stored.settings,
    settingsSaved: stored.saved,
  });
}

function ladderRow(env, row, mode, rank, caller) {
  const shaped = shapeLadderRow({ ...row, avatarUrl: avatarUrl(row, env) }, mode, rank);
  if (caller && row?.id != null && String(row.id) === String(caller.id)) shaped.self = true;
  return shaped;
}

export async function board(request, env) {
  const parsed = parseBoardQuery(new URL(request.url).searchParams);
  if (!parsed.ok) return json({ error: parsed.error }, { status: 400 });
  const resolved = await resolveUser(request, env);
  const caller = resolved?.user || null;
  const rows = await leaderboard(env, parsed.mode, parsed.limit, parsed.offset);
  const total = await leaderboardCount(env, parsed.mode);
  const body = {
    mode: parsed.mode,
    limit: parsed.limit,
    offset: parsed.offset,
    total,
    hasMore: parsed.offset + rows.length < total,
    rows: rows.map((row, index) => ladderRow(env, row, parsed.mode, parsed.offset + index + 1, caller)),
  };
  if (caller) {
    const rank = await leaderboardRank(env, parsed.mode, caller);
    body.you = ladderRow(env, caller, parsed.mode, rank, caller);
    const window = rankWindow(rank, total);
    if (window) {
      const around = await leaderboard(env, parsed.mode, window.limit, window.offset);
      body.around = around.map((row, index) => ladderRow(env, row, parsed.mode, window.offset + index + 1, caller));
    }
  }
  const cache = resolved
    ? `private, max-age=${BOARD_CACHE_SECONDS}`
    : `public, max-age=${BOARD_CACHE_SECONDS}`;
  return json(body, { cache });
}

export async function races(request, env) {
  const resolved = await resolveUser(request, env);
  if (!resolved) return json({ error: "unauthorized" }, { status: 401 });
  const rows = await recentRaces(env, resolved.user.id, 12);
  return json({
    races: rows.map((row) => ({
      id: row.id,
      mode: row.mode,
      sentence: row.sentence,
      ranked: Boolean(row.ranked),
      racers: Number(row.racers) || 0,
      label: standingLabel({ ranked: Boolean(row.ranked), racers: Number(row.racers) || 0 }),
      finishedAt: row.finished_at,
      place: row.place,
      wpm: row.wpm,
      accuracy: row.accuracy,
      ms: row.ms,
      eloBefore: row.elo_before,
      eloAfter: row.elo_after,
    })),
  });
}
