import { MODE_COLUMNS, isMode } from "./modes.js";
import { countsAsWin } from "./results.js";

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
  await env.DB.prepare(
    "INSERT INTO sessions (id, user_id, refresh_token, expires_at) VALUES (?, ?, ?, ?)",
  )
    .bind(id, userId, refreshToken ?? null, expiresAt)
    .run();
  return { id, expiresAt };
}

export async function getSession(env, id) {
  return env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first();
}

export async function deleteSession(env, id) {
  await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(id).run();
}

export async function leaderboard(env, mode, limit = 25) {
  const cols = columns(mode);
  const result = await env.DB.prepare(
    `SELECT * FROM users
     WHERE ${cols.races} > 0
     ORDER BY ${cols.elo} DESC, ${cols.best} DESC
     LIMIT ?`,
  )
    .bind(limit)
    .all();
  return result.results || [];
}

export async function recentRaces(env, userId, limit = 12) {
  const result = await env.DB.prepare(
    `SELECT r.id, r.mode, r.sentence, r.ranked, r.finished_at,
            rr.place, rr.wpm, rr.accuracy, rr.ms, rr.elo_before, rr.elo_after
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

export async function saveRace(env, race) {
  const cols = columns(race.mode);
  const statements = [
    env.DB.prepare(
      `INSERT INTO races (id, mode, sentence, ranked, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(race.id, race.mode, race.sentence, race.ranked ? 1 : 0, race.startedAt, race.finishedAt),
  ];
  for (const row of race.rows) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO race_results (
           race_id, user_id, place, wpm, accuracy, ms, progress, elo_before, elo_after
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        race.id,
        row.id,
        row.place,
        row.wpm,
        row.accuracy,
        row.ms,
        row.progress,
        row.eloBefore,
        row.eloAfter,
      ),
    );
    if (race.ranked) {
      const won = countsAsWin(row) ? 1 : 0;
      const finished = row.ms != null ? 1 : 0;
      statements.push(
        env.DB.prepare(
          `UPDATE users SET
             ${cols.elo} = ?,
             ${cols.races} = ${cols.races} + 1,
             ${cols.wins} = ${cols.wins} + ?,
             ${cols.best} = CASE
               WHEN ? = 1 AND (${cols.best} IS NULL OR ? > ${cols.best}) THEN ?
               ELSE ${cols.best}
             END,
             updated_at = ?
           WHERE id = ?`,
        ).bind(row.eloAfter ?? row.eloBefore ?? 1000, won, finished, row.wpm, row.wpm, Date.now(), row.id),
      );
    } else if (row.ms != null) {
      statements.push(
        env.DB.prepare(
          `UPDATE users SET
             ${cols.best} = CASE
               WHEN ${cols.best} IS NULL OR ? > ${cols.best} THEN ?
               ELSE ${cols.best}
             END,
             updated_at = ?
           WHERE id = ?`,
        ).bind(row.wpm, row.wpm, Date.now(), row.id),
      );
    }
  }
  await env.DB.batch(statements);
}
