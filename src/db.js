import { PAIR_WINDOW_MS } from "./elo.js";
import { MODE_COLUMNS, isMode } from "./modes.js";
import { pairCountsFromRows, planRating } from "./rating.js";
import { SESSION_CLEANUP_BATCH, SESSION_CLEANUP_ROUNDS } from "./retention.js";
import { countsAsWin } from "./results.js";
import { sealToken, tokenKeyOk } from "./token-box.js";

function columns(mode) {
  if (!isMode(mode)) throw new Error("bad mode");
  const cols = MODE_COLUMNS[mode];
  for (const value of Object.values(cols)) {
    if (!/^[a-z_]+$/.test(value)) throw new Error("bad column");
  }
  return cols;
}

export async function upsertUser(env, user) {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO users (
       id, username, discriminator, global_name, avatar, avatar_color, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       username = excluded.username,
       discriminator = excluded.discriminator,
       global_name = excluded.global_name,
       avatar = excluded.avatar,
       avatar_color = excluded.avatar_color,
       updated_at = excluded.updated_at`,
  )
    .bind(
      user.id,
      user.username,
      String(user.discriminator ?? "0"),
      user.global_name ?? null,
      user.avatar ?? null,
      user.avatar_color ?? null,
      now,
      now,
    )
    .run();
  return getUser(env, user.id);
}

export async function getUser(env, id) {
  return env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
}

export async function getUsers(env, ids) {
  if (!ids.length) return [];
  const marks = ids.map(() => "?").join(", ");
  const result = await env.DB.prepare(`SELECT * FROM users WHERE id IN (${marks})`)
    .bind(...ids)
    .all();
  return result.results || [];
}

export async function createSession(env, userId, refreshToken) {
  const id = crypto.randomUUID();
  const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
  let stored = null;
  if (refreshToken) {
    if (!tokenKeyOk(env.TOKEN_ENCRYPTION_KEY)) {
      console.error("refresh token dropped: TOKEN_ENCRYPTION_KEY missing");
    } else {
      stored = await sealToken(refreshToken, env.TOKEN_ENCRYPTION_KEY);
      if (!stored) console.error("refresh token dropped: encryption failed");
    }
  }
  await env.DB.prepare(
    "INSERT INTO sessions (id, user_id, refresh_token, expires_at) VALUES (?, ?, ?, ?)",
  )
    .bind(id, userId, stored, expiresAt)
    .run();
  return { id, expiresAt };
}

// Plaintext rows from before encryption are sealed on the next authenticated
// request. The compare-and-set leaves a concurrent seal in place.
export async function upgradeRefreshToken(env, session) {
  if (!session?.refresh_token || String(session.refresh_token).startsWith("v1:")) return session;
  if (!tokenKeyOk(env.TOKEN_ENCRYPTION_KEY)) return session;
  const sealed = await sealToken(session.refresh_token, env.TOKEN_ENCRYPTION_KEY);
  if (!sealed) return session;
  await env.DB.prepare(
    "UPDATE sessions SET refresh_token = ? WHERE id = ? AND refresh_token = ?",
  )
    .bind(sealed, session.id, session.refresh_token)
    .run();
  return { ...session, refresh_token: sealed };
}

export async function getSession(env, id) {
  return env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first();
}

export async function deleteSession(env, id) {
  await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(id).run();
}

export async function leaderboard(env, mode, limit = 25, offset = 0) {
  const cols = columns(mode);
  const result = await env.DB.prepare(
    `SELECT id, username, global_name, ${cols.elo}, ${cols.races}, ${cols.wins}, ${cols.best}
     FROM users
     WHERE ${cols.races} > 0
     ORDER BY ${cols.elo} DESC, ${cols.best} DESC, id ASC
     LIMIT ? OFFSET ?`,
  )
    .bind(limit, offset)
    .all();
  return result.results || [];
}

// Position in the same order as leaderboard(). Null when this ladder has no races.
export async function leaderboardRank(env, mode, user) {
  const cols = columns(mode);
  const races = Number(user[cols.races] || 0);
  if (races <= 0) return null;
  const elo = Number(user[cols.elo] ?? 1000);
  const best = user[cols.best] == null ? null : Number(user[cols.best]);
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS ahead FROM users
     WHERE ${cols.races} > 0
       AND (
         ${cols.elo} > ?
         OR (${cols.elo} = ? AND COALESCE(${cols.best}, -1) > COALESCE(?, -1))
         OR (${cols.elo} = ? AND COALESCE(${cols.best}, -1) = COALESCE(?, -1) AND id < ?)
       )`,
  )
    .bind(elo, elo, best, elo, best, user.id)
    .first();
  return Number(row?.ahead || 0) + 1;
}

export async function purgeExpiredSessions(env, now = Date.now()) {
  let removed = 0;
  for (let round = 0; round < SESSION_CLEANUP_ROUNDS; round += 1) {
    const result = await env.DB.prepare(
      `DELETE FROM sessions WHERE id IN (
         SELECT id FROM sessions WHERE expires_at < ? LIMIT ?
       )`,
    )
      .bind(now, SESSION_CLEANUP_BATCH)
      .run();
    const changes = Number(result?.meta?.changes || 0);
    removed += changes;
    if (changes < SESSION_CLEANUP_BATCH) break;
  }
  return removed;
}

export async function recentRaces(env, userId, limit = 12) {
  const result = await env.DB.prepare(
    `SELECT r.id, r.mode, r.sentence, r.ranked, r.finished_at,
            rr.place, rr.wpm, rr.accuracy, rr.ms, rr.elo_before, rr.elo_after,
            (SELECT COUNT(*) FROM race_results c WHERE c.race_id = r.id) AS racers
     FROM race_results rr
     JOIN races r ON r.id = rr.race_id
     WHERE rr.user_id = ?
     ORDER BY r.finished_at DESC
     LIMIT ?`,
  )
    .bind(userId, limit)
    .all();
  return result.results || [];
}

async function priorPairHistory(env, mode, raceId, ids) {
  if (ids.length < 2) return [];
  const marks = ids.map(() => "?").join(", ");
  const result = await env.DB.prepare(
    `SELECT rr.race_id AS raceId, rr.user_id AS userId
     FROM race_results rr
     JOIN races r ON r.id = rr.race_id
     WHERE r.ranked = 1
       AND r.mode = ?
       AND r.finished_at >= ?
       AND r.id <> ?
       AND rr.user_id IN (${marks})`,
  )
    .bind(mode, Date.now() - PAIR_WINDOW_MS, raceId, ...ids)
    .all();
  return result.results || [];
}

// One batch. Elo is `elo + delta` from the ratings read just above, and the
// user row changes only when this race has no result row yet. A retry or a
// second finish event therefore cannot apply the same race twice. Overlapping
// races each add their own delta.
export function saveStatements(race, plan) {
  const cols = columns(race.mode);
  const planById = new Map((plan || []).map((row) => [row.id, row]));
  const now = Date.now();
  const statements = [
    {
      sql: `INSERT INTO races (id, mode, sentence, ranked, started_at, finished_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING`,
      binds: [race.id, race.mode, race.sentence, race.ranked ? 1 : 0, race.startedAt, race.finishedAt],
    },
  ];
  for (const row of race.rows || []) {
    const planned = planById.get(row.id) || {
      eloBefore: null,
      eloAfter: null,
      delta: 0,
      countRace: false,
    };
    if (planned.countRace) {
      const won = countsAsWin(row) ? 1 : 0;
      const finished = row.ms != null ? 1 : 0;
      statements.push({
        sql: `UPDATE users SET
            ${cols.elo} = MAX(100, ${cols.elo} + ?),
            ${cols.races} = ${cols.races} + 1,
            ${cols.wins} = ${cols.wins} + ?,
            ${cols.best} = CASE
              WHEN ? = 1 AND (${cols.best} IS NULL OR ? > ${cols.best}) THEN ?
              ELSE ${cols.best}
            END,
            updated_at = ?
          WHERE id = ?
            AND NOT EXISTS (
              SELECT 1 FROM race_results WHERE race_id = ? AND user_id = ?
            )`,
        binds: [planned.delta, won, finished, row.wpm, row.wpm, now, row.id, race.id, row.id],
      });
    } else if (row.ms != null) {
      statements.push({
        sql: `UPDATE users SET
            ${cols.best} = CASE
              WHEN ${cols.best} IS NULL OR ? > ${cols.best} THEN ?
              ELSE ${cols.best}
            END,
            updated_at = ?
          WHERE id = ?
            AND NOT EXISTS (
              SELECT 1 FROM race_results WHERE race_id = ? AND user_id = ?
            )`,
        binds: [row.wpm, row.wpm, now, row.id, race.id, row.id],
      });
    }
    statements.push({
      sql: `INSERT INTO race_results (
          race_id, user_id, place, wpm, accuracy, ms, progress, elo_before, elo_after
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(race_id, user_id) DO NOTHING`,
      binds: [
        race.id,
        row.id,
        row.place,
        row.wpm,
        row.accuracy,
        row.ms,
        row.progress,
        planned.eloBefore,
        planned.eloAfter,
      ],
    });
  }
  return statements;
}

export async function saveRace(env, race) {
  const cols = columns(race.mode);
  const ids = (race.rows || []).map((row) => row.id);
  const rated = Boolean(race.ranked) && ids.length >= 2;
  let elos = {};
  let pairCounts = {};
  if (rated) {
    const users = await getUsers(env, ids);
    elos = Object.fromEntries(ids.map((id) => [id, 1000]));
    for (const user of users) elos[user.id] = Number(user[cols.elo] ?? 1000);
    pairCounts = pairCountsFromRows(await priorPairHistory(env, race.mode, race.id, ids), ids);
  }
  const plan = planRating(race.rows, { ranked: rated, elos, pairCounts });
  const statements = saveStatements(race, plan).map(({ sql, binds }) => env.DB.prepare(sql).bind(...binds));
  if (statements.length) await env.DB.batch(statements);
  const stored = await env.DB.prepare(
    `SELECT user_id AS id, elo_before AS eloBefore, elo_after AS eloAfter
     FROM race_results WHERE race_id = ?`,
  )
    .bind(race.id)
    .all();
  const byId = new Map((stored.results || []).map((row) => [row.id, row]));
  return {
    rows: (race.rows || []).map((row) => {
      const saved = byId.get(row.id);
      if (!saved) return { ...row, eloBefore: null, eloAfter: null };
      return {
        ...row,
        eloBefore: saved.eloBefore ?? saved.elo_before ?? null,
        eloAfter: saved.eloAfter ?? saved.elo_after ?? null,
      };
    }),
  };
}
