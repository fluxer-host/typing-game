// D1 rows for the daily challenge. Scoring uses src/daily.js.

import { rankWindow } from "./board.js";
import { avatarUrl, displayName } from "./profile.js";
import {
  parseUtcDay,
  DAILY_ATTEMPT_RETENTION_MS,
  DAILY_CLEANUP_BATCH,
  DAILY_CLEANUP_ROUNDS,
  DAILY_LENGTH,
  DAILY_RESULT_RETENTION_DAYS,
  DAILY_STARTS_PER_DAY,
  dailyPassage,
  isUniqueViolation,
  passageForAttempt,
  replayDaily,
  shapeDailyRow,
  submissionWindow,
  utcDayString,
} from "./daily.js";

const DAY_MS = 86_400_000;

function changes(result) {
  return Number(result?.meta?.changes || 0);
}

export async function countDailyStarts(env, userId, ladder, day) {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM daily_attempts WHERE user_id = ? AND ladder = ? AND day = ?",
  ).bind(userId, ladder, day).first();
  return Number(row?.n || 0);
}

export async function insertDailyAttempt(env, row) {
  await env.DB.prepare(
    `INSERT INTO daily_attempts
      (id, user_id, ladder, day, passage_id, started_at, consumed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
  ).bind(row.id, row.userId, row.ladder, row.day, row.passageId, row.startedAt, row.createdAt).run();
}

export async function getDailyAttempt(env, id) {
  return env.DB.prepare(
    `SELECT id, user_id, ladder, day, passage_id, started_at, consumed_at, created_at
     FROM daily_attempts WHERE id = ?`,
  ).bind(id).first();
}

export async function consumeDailyAttempt(env, id, userId, at) {
  const result = await env.DB.prepare(
    `UPDATE daily_attempts SET consumed_at = ?
     WHERE id = ? AND user_id = ? AND consumed_at IS NULL`,
  ).bind(at, id, userId).run();
  return changes(result) === 1;
}

export async function getDailyResult(env, userId, ladder, day) {
  return env.DB.prepare(
    `SELECT user_id, ladder, day, passage_id, wpm, accuracy, duration_ms, started_at, finished_at, created_at
     FROM daily_results WHERE user_id = ? AND ladder = ? AND day = ?`,
  ).bind(userId, ladder, day).first();
}

export async function insertDailyResult(env, row) {
  try {
    await env.DB.prepare(
      `INSERT INTO daily_results
        (user_id, ladder, day, passage_id, wpm, accuracy, duration_ms, started_at, finished_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      row.userId,
      row.ladder,
      row.day,
      row.passageId,
      row.wpm,
      row.accuracy,
      row.durationMs,
      row.startedAt,
      row.finishedAt,
      row.createdAt,
    ).run();
    return { saved: true };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return { saved: false };
  }
}

export async function rankDailyResult(env, row) {
  const ahead = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM daily_results
     WHERE ladder = ? AND day = ?
       AND (
         wpm > ?
         OR (wpm = ? AND accuracy > ?)
         OR (wpm = ? AND accuracy = ? AND duration_ms < ?)
         OR (wpm = ? AND accuracy = ? AND duration_ms = ? AND created_at < ?)
       )`,
  ).bind(
    row.ladder,
    row.day,
    row.wpm,
    row.wpm,
    row.accuracy,
    row.wpm,
    row.accuracy,
    row.duration_ms,
    row.wpm,
    row.accuracy,
    row.duration_ms,
    row.created_at,
  ).first();
  return Number(ahead?.n || 0) + 1;
}

function publicScore(user, row, rank, env) {
  return shapeDailyRow({
    id: user.id,
    name: displayName(user),
    avatar: avatarUrl(user, env),
    color: user.avatar_color,
    wpm: row.wpm,
    accuracy: row.accuracy,
    ms: row.duration_ms,
    rank,
    self: true,
  });
}

export async function startDailyAttempt(env, { user, ladder, now }) {
  const day = utcDayString(now);
  const passage = dailyPassage(ladder, day);
  if (!passage) return { status: 400, body: { error: "passage" } };
  const existing = await getDailyResult(env, user.id, ladder, day);
  if (existing) {
    const rank = await rankDailyResult(env, existing);
    return {
      status: 409,
      body: {
        error: "scored",
        passage: passage.text,
        passageId: passage.id,
        difficulty: passage.difficulty,
        length: DAILY_LENGTH,
        day,
        serverNow: now,
        result: publicScore(user, existing, rank, env),
      },
    };
  }
  const starts = await countDailyStarts(env, user.id, ladder, day);
  if (starts >= DAILY_STARTS_PER_DAY) return { status: 429, body: { error: "limit" } };
  const id = crypto.randomUUID();
  await insertDailyAttempt(env, {
    id,
    userId: user.id,
    ladder,
    day,
    passageId: passage.id,
    startedAt: now,
    createdAt: now,
  });
  return {
    status: 200,
    body: {
      attemptId: id,
      passage: passage.text,
      passageId: passage.id,
      difficulty: passage.difficulty,
      length: DAILY_LENGTH,
      ladder,
      day,
      serverNow: now,
      startedAt: now,
    },
  };
}

export async function submitDailyAttempt(env, { user, attemptId, steps, now }) {
  const attempt = await getDailyAttempt(env, attemptId);
  if (!attempt || attempt.user_id !== user.id) return { status: 404, body: { error: "attempt" } };
  if (attempt.consumed_at != null) return { status: 409, body: { error: "used" } };
  const window = submissionWindow({ startedAt: Number(attempt.started_at), now });
  if (!window.ok) {
    const status = window.reason === "expired" ? 409 : 400;
    return { status, body: { error: window.reason === "expired" ? "expired" : "rejected", reason: window.reason } };
  }
  const existing = await getDailyResult(env, user.id, attempt.ladder, attempt.day);
  if (existing) {
    await consumeDailyAttempt(env, attempt.id, user.id, now);
    const rank = await rankDailyResult(env, existing);
    return { status: 409, body: { error: "scored", result: publicScore(user, existing, rank, env) } };
  }
  const record = passageForAttempt(attempt.ladder, attempt.passage_id);
  if (!record) return { status: 400, body: { error: "passage" } };
  const replay = replayDaily({ passage: record.text, steps, elapsedMs: window.elapsedMs });
  if (!replay.ok) {
    console.log(JSON.stringify({
      event: "daily_rejected",
      reason: replay.reason,
      ladder: attempt.ladder,
      userId: user.id,
    }));
    return { status: 400, body: { error: "rejected", reason: replay.reason } };
  }
  const consumed = await consumeDailyAttempt(env, attempt.id, user.id, now);
  if (!consumed) return { status: 409, body: { error: "used" } };
  const stored = {
    userId: user.id,
    ladder: attempt.ladder,
    day: attempt.day,
    passageId: record.id,
    wpm: replay.wpm,
    accuracy: replay.accuracy,
    durationMs: window.elapsedMs,
    startedAt: Number(attempt.started_at),
    finishedAt: now,
    createdAt: now,
  };
  const inserted = await insertDailyResult(env, stored);
  const row = inserted.saved
    ? {
      ...stored,
      wpm: stored.wpm,
      accuracy: stored.accuracy,
      duration_ms: stored.durationMs,
      created_at: stored.createdAt,
      ladder: stored.ladder,
      day: stored.day,
    }
    : await getDailyResult(env, user.id, attempt.ladder, attempt.day);
  const rank = await rankDailyResult(env, row);
  const body = {
    saved: inserted.saved,
    scored: inserted.saved,
    rank,
    wpm: row.wpm,
    accuracy: row.accuracy,
    ms: row.duration_ms,
    day: row.day,
    ladder: row.ladder,
    serverNow: now,
    result: publicScore(user, row, rank, env),
  };
  if (!inserted.saved) return { status: 409, body: { error: "scored", ...body } };
  return { status: 200, body };
}

function boardUser(row) {
  return {
    id: row.id,
    username: row.username,
    global_name: row.global_name,
    avatar: row.avatar,
    avatar_color: row.avatar_color,
  };
}

const DAILY_PAGE_SQL = `SELECT id, username, global_name, avatar, avatar_color, wpm, accuracy, rank
 FROM (
   SELECT u.id, u.username, u.global_name, u.avatar, u.avatar_color,
          r.wpm, r.accuracy,
          ROW_NUMBER() OVER (
            ORDER BY r.wpm DESC, r.accuracy DESC, r.duration_ms ASC, r.created_at ASC
          ) AS rank
   FROM daily_results r
   JOIN users u ON u.id = r.user_id
   WHERE r.ladder = ? AND r.day = ?
 ) AS ranked
 WHERE rank > ? AND rank <= ?
 ORDER BY rank ASC`;

function presentDaily(env, row, user) {
  return shapeDailyRow({
    id: row.id,
    name: displayName(boardUser(row)),
    avatar: avatarUrl(boardUser(row), env),
    color: row.avatar_color,
    wpm: row.wpm,
    accuracy: row.accuracy,
    rank: Number(row.rank),
    self: Boolean(user && row.id === user.id),
  });
}

async function dailyPage(env, ladder, day, offset, limit) {
  const listed = await env.DB.prepare(DAILY_PAGE_SQL).bind(ladder, day, offset, offset + limit).all();
  return listed.results || [];
}

export async function loadDailyBoard(env, { ladder, day, limit, offset = 0, user, now }) {
  const passage = dailyPassage(ladder, day);
  const counted = await env.DB.prepare(
    "SELECT COUNT(*) AS total FROM daily_results WHERE ladder = ? AND day = ?",
  ).bind(ladder, day).first();
  const total = Number(counted?.total || 0);
  const start = Number(offset) > 0 ? Number(offset) : 0;
  const listed = await dailyPage(env, ladder, day, start, limit);
  const rows = listed.map((row) => presentDaily(env, row, user));
  let you = null;
  if (user) {
    const mine = await getDailyResult(env, user.id, ladder, day);
    if (mine) {
      const rank = await rankDailyResult(env, mine);
      you = publicScore(user, mine, rank, env);
    }
  }
  const body = {
    ladder,
    day,
    serverNow: now,
    nextDayAt: (parseUtcDay(day)?.startMs ?? 0) + DAY_MS,
    length: DAILY_LENGTH,
    difficulty: passage?.difficulty || "",
    passageId: passage?.id || "",
    passage: passage?.text || "",
    limit,
    offset: start,
    total,
    hasMore: start + rows.length < total,
    rows,
    you,
  };
  const window = you?.rank ? rankWindow(you.rank, total) : null;
  if (window) {
    const around = await dailyPage(env, ladder, day, window.offset, window.limit);
    body.around = around.map((row) => presentDaily(env, row, user));
  }
  return body;
}

async function deleteBatch(env, sql, cutoff) {
  let removed = 0;
  for (let round = 0; round < DAILY_CLEANUP_ROUNDS; round += 1) {
    const result = await env.DB.prepare(sql).bind(cutoff, DAILY_CLEANUP_BATCH).run();
    const count = changes(result);
    removed += count;
    if (count < DAILY_CLEANUP_BATCH) break;
  }
  return removed;
}

export async function purgeDaily(env, now = Date.now()) {
  const attempts = await deleteBatch(
    env,
    `DELETE FROM daily_attempts WHERE id IN (
       SELECT id FROM daily_attempts WHERE started_at < ? LIMIT ?
     )`,
    now - DAILY_ATTEMPT_RETENTION_MS,
  );
  const results = await deleteBatch(
    env,
    `DELETE FROM daily_results WHERE rowid IN (
       SELECT rowid FROM daily_results WHERE created_at < ? LIMIT ?
     )`,
    now - DAILY_RESULT_RETENTION_DAYS * DAY_MS,
  );
  return { attempts, results };
}
