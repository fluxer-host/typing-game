import { leaderboard, recentRaces } from "./db.js";
import { json } from "./http.js";
import { resolveUser } from "./identity.js";
import { isMode, MODE_LIST } from "./modes.js";
import { publicPlayer } from "./profile.js";

export function config(env) {
  return json({
    oauth: Boolean(env.FLUXER_CLIENT_ID && env.FLUXER_CLIENT_SECRET),
    devLogin: env.ALLOW_DEV_LOGIN === "true",
    modes: MODE_LIST,
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
  const mode = new URL(request.url).searchParams.get("mode") || "desktop";
  if (!isMode(mode)) return json({ error: "mode" }, { status: 400 });
  const rows = await leaderboard(env, mode, 25);
  return json({ mode, rows: rows.map((row) => publicPlayer(row, env)) });
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
