import { BOARD_CACHE_SECONDS, boardEntry, parseBoardQuery } from "./board.js";
import { leaderboard, leaderboardRank, recentRaces } from "./db.js";
import { json } from "./http.js";
import { resolveUser } from "./identity.js";
import { lengthList } from "./lengths.js";
import { MODE_LIST } from "./modes.js";
import { publicPlayer } from "./profile.js";
import { standingLabel } from "./rating.js";

export function config(env) {
  return json({
    oauth: Boolean(env.FLUXER_CLIENT_ID && env.FLUXER_CLIENT_SECRET),
    devLogin: env.ALLOW_DEV_LOGIN === "true",
    modes: MODE_LIST,
    lengths: lengthList(),
    media: env.MEDIA_BASE || "https://fluxerusercontent.com",
    staticCdn: env.STATIC_CDN || "https://fluxerstatic.com",
  });
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
  return json({ user: publicPlayer(resolved.user, env) });
}

export async function board(request, env) {
  const parsed = parseBoardQuery(new URL(request.url).searchParams);
  if (!parsed.ok) return json({ error: parsed.error }, { status: 400 });
  const resolved = await resolveUser(request, env);
  const rows = await leaderboard(env, parsed.mode, parsed.limit, parsed.offset);
  const body = {
    mode: parsed.mode,
    limit: parsed.limit,
    offset: parsed.offset,
    rows: rows.map((row, index) => boardEntry(row, parsed.mode, parsed.offset + index + 1)),
  };
  if (resolved?.user) {
    body.you = boardEntry(resolved.user, parsed.mode, await leaderboardRank(env, parsed.mode, resolved.user));
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
