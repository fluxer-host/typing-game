import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { wpm } from "../src/score.js";
import { poolFor } from "../src/sentences.js";
import {
  DAILY_BOARD_DEFAULT_LIMIT,
  DAILY_MAX_ATTEMPT_MS,
  DAILY_MAX_STEPS,
  dailyPassage,
  dayAllowed,
  isUniqueViolation,
  parseDailyQuery,
  parseSubmitBody,
  parseUtcDay,
  pickDailyPassage,
  replayDaily,
  scoreDecision,
  shapeDailyRow,
  stepsForPassage,
  strokeGapMs,
  submissionWindow,
  utcDayString,
} from "../src/daily.js";
import { dailyBoard, dailyStart, dailySubmit } from "../src/daily-http.js";
import {
  insertDailyAttempt,
  insertDailyResult,
  loadDailyBoard,
  purgeDaily,
  startDailyAttempt,
  submitDailyAttempt,
} from "../src/daily-store.js";
import { signPayload } from "../src/session.js";
import {
  loadDailyLocal,
  noteDailyStep,
  rememberDailyLocal,
} from "../public/daily.js";

const INIT = readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8");
const DAILY_SQL = readFileSync(new URL("../migrations/0002_daily.sql", import.meta.url), "utf8");
const DAY_MS = 86_400_000;
const SECRET = "test-session-secret";

function sqliteEnv() {
  const db = new DatabaseSync(":memory:");
  db.exec(INIT);
  db.exec(DAILY_SQL);
  const env = {
    DB: {
      prepare(sql) {
        return {
          bind(...args) {
            const stmt = db.prepare(sql);
            return {
              async run() {
                const info = stmt.run(...args);
                return { meta: { changes: Number(info.changes || 0) } };
              },
              async first() {
                return stmt.get(...args) ?? null;
              },
              async all() {
                return { results: stmt.all(...args) };
              },
            };
          },
        };
      },
    },
    MEDIA_BASE: "https://fluxerusercontent.com",
    STATIC_CDN: "https://fluxerstatic.com",
    SESSION_SECRET: SECRET,
  };
  return { env, db };
}

async function addUser(env, id, extra = {}) {
  await env.DB.prepare(
    `INSERT INTO users (id, username, discriminator, global_name, avatar, avatar_color, created_at, updated_at)
     VALUES (?, ?, '0', ?, ?, ?, 1, 1)`,
  ).bind(id, extra.username || "ada", extra.globalName ?? null, extra.avatar ?? null, extra.color ?? null).run();
}

function gap() {
  return strokeGapMs();
}

function legalNow(startedAt, steps) {
  return startedAt + (steps.length - 1) * gap() + 50;
}

async function played(env, user, ladder, startedAt) {
  const started = await startDailyAttempt(env, { user, ladder, now: startedAt });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const steps = stepsForPassage(started.body.passage);
  const now = legalNow(startedAt, steps);
  const submitted = await submitDailyAttempt(env, {
    user,
    attemptId: started.body.attemptId,
    steps,
    now,
  });
  return { started, submitted, steps, now };
}

test("the same UTC day picks one passage and the next midnight picks another", () => {
  const noon = Date.parse("2026-10-18T12:00:00.000Z");
  const late = Date.parse("2026-10-18T23:59:59.000Z");
  const morning = dailyPassage("desktop", utcDayString(noon));
  const evening = dailyPassage("desktop", utcDayString(late));
  assert.equal(morning.id, evening.id);
  assert.equal(morning.text, evening.text);
  const next = utcDayString(late + 1000);
  assert.equal(next, "2026-10-19");
  assert.notEqual(dailyPassage("desktop", next).id, morning.id);
  assert.ok(["easy", "medium", "hard"].includes(morning.difficulty));
  assert.ok(morning.text.length >= 140 && morning.text.length <= 240);
});

test("consecutive days do not repeat a passage when the pool has more than one", () => {
  const start = Date.parse("2026-01-01T00:00:00.000Z");
  for (const ladder of ["desktop", "mobile", "cursor"]) {
    let previous = "";
    for (let i = 0; i < 120; i += 1) {
      const day = utcDayString(start + i * DAY_MS);
      const picked = dailyPassage(ladder, day);
      assert.ok(picked?.id, ladder);
      if (previous) assert.notEqual(picked.id, previous, `${ladder} ${day}`);
      previous = picked.id;
    }
  }
  const only = [{ id: "only", text: "Hello." }];
  assert.equal(pickDailyPassage(only, 10, "desktop").id, "only");
  assert.equal(pickDailyPassage(only, 11, "desktop").id, "only");
  const pair = [{ id: "b", text: "B" }, { id: "a", text: "A" }];
  let last = "";
  for (let day = 0; day < 40; day += 1) {
    const picked = pickDailyPassage(pair, day, "cursor");
    if (last) assert.notEqual(picked.id, last);
    last = picked.id;
  }
});

test("a finish after midnight still belongs to the start day inside the grace window", () => {
  const start = Date.parse("2026-10-18T23:59:00.000Z");
  const finish = Date.parse("2026-10-19T00:01:00.000Z");
  const open = submissionWindow({ startedAt: start, now: finish });
  assert.equal(open.ok, true);
  assert.equal(open.day, "2026-10-18");
  assert.equal(open.elapsedMs, 120_000);

  const afterGrace = submissionWindow({
    startedAt: start,
    now: Date.parse("2026-10-19T00:10:00.000Z"),
    maxMs: 24 * 60 * 60 * 1000,
    graceMs: 60_000,
  });
  assert.equal(afterGrace.ok, false);
  assert.equal(afterGrace.reason, "expired");

  const noon = Date.parse("2026-10-18T12:00:00.000Z");
  const tooLong = submissionWindow({ startedAt: noon, now: noon + DAILY_MAX_ATTEMPT_MS + 1 });
  assert.equal(tooLong.reason, "duration");
  assert.equal(submissionWindow({ startedAt: noon, now: noon - 1 }).reason, "early");

  const yesterday = Date.parse("2026-10-17T15:00:00.000Z");
  const nextAfternoon = Date.parse("2026-10-18T15:00:00.000Z");
  assert.equal(submissionWindow({ startedAt: yesterday, now: nextAfternoon }).reason, "expired");
});

test("query parsing rejects a bad ladder, a bad day, and a bad limit", () => {
  const now = Date.parse("2026-10-18T12:00:00.000Z");
  const params = (query) => new URLSearchParams(query);
  assert.equal(parseDailyQuery(params("ladder=nope"), now).error, "ladder");
  assert.equal(parseDailyQuery(params("day=2026-02-31"), now).error, "day");
  assert.equal(parseDailyQuery(params("day=2026-10-19"), now).error, "future");
  assert.equal(parseDailyQuery(params("day=2020-01-01"), now).error, "old");
  assert.equal(dayAllowed("2026-07-21", now).ok, true);
  assert.equal(dayAllowed("2026-07-20", now).error, "old");
  const today = parseDailyQuery(params(""), now);
  assert.equal(today.ok, true);
  assert.equal(today.day, "2026-10-18");
  assert.equal(today.limit, DAILY_BOARD_DEFAULT_LIMIT);
  assert.equal(parseDailyQuery(params("limit=100"), now).limit, 100);
  assert.equal(parseDailyQuery(params("limit=101"), now).error, "limit");
  assert.equal(parseDailyQuery(params("limit=1.5"), now).error, "limit");
  assert.equal(parseDailyQuery(params("limit=0"), now).error, "limit");
  assert.equal(parseUtcDay("2026-02-31"), null);
});

test("a submit body keeps the typed steps and drops a client wpm", () => {
  const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const parsed = parseSubmitBody({ attemptId: id, steps: ["a", "ab"], wpm: 9999, accuracy: 1 });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.wpm, undefined);
  assert.deepEqual(parsed.steps, ["a", "ab"]);
  assert.equal(parseSubmitBody({ attemptId: "nope", steps: ["a"] }).error, "attempt");
  assert.equal(parseSubmitBody({ attemptId: id, steps: Array(DAILY_MAX_STEPS + 1).fill("a") }).error, "steps");
  assert.equal(parseSubmitBody({ attemptId: id, steps: ["x".repeat(501)] }).error, "steps");
});

test("replay uses the server elapsed time and rejects forged finishes", () => {
  const passage = "abcd";
  const steps = stepsForPassage(passage);
  const instant = replayDaily({ passage, steps, elapsedMs: 1 });
  assert.equal(instant.ok, false);
  assert.equal(instant.reason, "rate");

  const burst = replayDaily({ passage: "a".repeat(40), steps: stepsForPassage("a".repeat(30)), elapsedMs: 800 });
  assert.equal(burst.ok, false);
  assert.equal(burst.reason, "rate");

  const dumped = replayDaily({ passage, steps: [passage], elapsedMs: 10_000 });
  assert.equal(dumped.reason, "jump");

  const wrong = replayDaily({ passage, steps: ["a", "ab", "abc", "abcx"], elapsedMs: 10_000 });
  assert.equal(wrong.reason, "unfinished");

  const missed = replayDaily({ passage: "ab", steps: ["x", "", "a", "ab"], elapsedMs: 200 });
  assert.equal(missed.ok, true);
  assert.ok(missed.accuracy < 100);
  assert.equal(missed.wpm, wpm(2, 200));

  const clean = replayDaily({ passage, steps, elapsedMs: 10_000 });
  assert.equal(clean.ok, true);
  assert.equal(clean.wpm, wpm(passage.length, 10_000));
  assert.equal(clean.accuracy, 100);
});

test("the first completed attempt is the score and a second one is rejected", async () => {
  const { env } = sqliteEnv();
  const user = { id: "ada", username: "ada", global_name: "Ada" };
  await addUser(env, user.id, { globalName: "Ada" });
  const startedAt = Date.parse("2026-10-18T12:00:00.000Z");
  const first = await played(env, user, "desktop", startedAt);
  assert.equal(first.submitted.status, 200);
  assert.equal(first.submitted.body.saved, true);
  assert.equal(first.submitted.body.scored, true);
  assert.equal(first.submitted.body.wpm, wpm(first.started.body.passage.length, first.now - startedAt));
  assert.equal(first.submitted.body.result.name, "Ada");
  assert.equal("id" in first.submitted.body.result, false);

  const again = await submitDailyAttempt(env, {
    user,
    attemptId: first.started.body.attemptId,
    steps: first.steps,
    now: first.now + 1000,
  });
  assert.equal(again.status, 409);
  assert.equal(again.body.error, "used");

  const retry = await startDailyAttempt(env, { user, ladder: "desktop", now: first.now + 2000 });
  assert.equal(retry.status, 409);
  assert.equal(retry.body.error, "scored");
  assert.equal(retry.body.result.wpm, first.submitted.body.wpm);

  const decision = scoreDecision({ existing: true, consumed: false });
  assert.equal(decision.status, 409);
  assert.equal(decision.error, "scored");
  assert.equal(scoreDecision({ existing: false, consumed: true }).error, "used");
});

test("a unique daily result is returned instead of failing the request", async () => {
  const { env, db } = sqliteEnv();
  const user = { id: "ada", username: "ada", global_name: "Ada" };
  await addUser(env, user.id, { globalName: "Ada" });
  const row = {
    userId: user.id,
    ladder: "desktop",
    day: "2026-10-18",
    passageId: "d-sp-e-001",
    wpm: 80,
    accuracy: 99,
    durationMs: 20_000,
    startedAt: 10,
    finishedAt: 20_010,
    createdAt: 20_010,
  };
  assert.equal((await insertDailyResult(env, row)).saved, true);
  assert.equal((await insertDailyResult(env, { ...row, wpm: 10 })).saved, false);
  let thrown = null;
  try {
    db.prepare(
      `INSERT INTO daily_results
        (user_id, ladder, day, passage_id, wpm, accuracy, duration_ms, started_at, finished_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(user.id, "desktop", "2026-10-18", "x", 1, 1, 1, 1, 2, 2);
  } catch (error) {
    thrown = error;
  }
  assert.equal(isUniqueViolation(thrown), true);

  const startedAt = Date.parse("2026-10-18T12:00:00.000Z");
  const started = await startDailyAttempt(env, { user, ladder: "desktop", now: startedAt });
  assert.equal(started.status, 409);
  assert.equal(started.body.result.wpm, 80);
});

test("forged, expired, and overlong attempts do not become scores", async () => {
  const { env } = sqliteEnv();
  const user = { id: "ada", username: "ada", global_name: "Ada" };
  await addUser(env, user.id, { globalName: "Ada" });
  const noon = Date.parse("2026-10-18T12:00:00.000Z");
  const started = await startDailyAttempt(env, { user, ladder: "desktop", now: noon });
  const steps = stepsForPassage(started.body.passage);
  const instant = await submitDailyAttempt(env, {
    user,
    attemptId: started.body.attemptId,
    steps,
    now: noon + 1,
  });
  assert.equal(instant.status, 400);
  assert.equal(instant.body.error, "rejected");
  assert.equal(instant.body.reason, "rate");

  const dumped = await submitDailyAttempt(env, {
    user,
    attemptId: started.body.attemptId,
    steps: [started.body.passage],
    now: legalNow(noon, steps),
  });
  assert.equal(dumped.body.reason, "jump");

  const over = await submitDailyAttempt(env, {
    user,
    attemptId: started.body.attemptId,
    steps,
    now: noon + DAILY_MAX_ATTEMPT_MS + 1,
  });
  assert.equal(over.status, 400);
  assert.equal(over.body.reason, "duration");

  const saved = await submitDailyAttempt(env, {
    user,
    attemptId: started.body.attemptId,
    steps,
    now: legalNow(noon, steps),
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.wpm, wpm(started.body.passage.length, legalNow(noon, steps) - noon));
  assert.notEqual(saved.body.wpm, 9999);

  const staleStart = Date.parse("2026-10-17T15:00:00.000Z");
  const stale = await startDailyAttempt(env, { user, ladder: "mobile", now: staleStart });
  assert.equal(stale.status, 200);
  const expired = await submitDailyAttempt(env, {
    user,
    attemptId: stale.body.attemptId,
    steps: stepsForPassage(stale.body.passage),
    now: Date.parse("2026-10-18T15:00:00.000Z"),
  });
  assert.equal(expired.status, 409);
  assert.equal(expired.body.error, "expired");

  const missing = await submitDailyAttempt(env, {
    user,
    attemptId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    steps: ["a"],
    now: noon,
  });
  assert.equal(missing.status, 404);
});

test("a midnight grace finish is stored on the day the attempt started", async () => {
  const { env } = sqliteEnv();
  const user = { id: "ada", username: "ada", global_name: "Ada" };
  await addUser(env, user.id, { globalName: "Ada" });
  const startedAt = Date.parse("2026-10-18T23:59:00.000Z");
  const started = await startDailyAttempt(env, { user, ladder: "cursor", now: startedAt });
  const steps = stepsForPassage(started.body.passage);
  const now = Date.parse("2026-10-19T00:01:00.000Z");
  const submitted = await submitDailyAttempt(env, {
    user,
    attemptId: started.body.attemptId,
    steps,
    now,
  });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  assert.equal(submitted.body.day, "2026-10-18");
  const board = await loadDailyBoard(env, {
    ladder: "cursor",
    day: "2026-10-18",
    limit: 25,
    user,
    now,
  });
  assert.equal(board.rows.length, 1);
  assert.equal(board.you.rank, 1);
});

test("the faster score ranks first and the board hides internal ids", async () => {
  const { env } = sqliteEnv();
  const ada = { id: "user-secret", username: "ada", global_name: "Ada", avatar: "abc123", avatar_color: 4 };
  const bea = { id: "4242424242", username: "bea", global_name: "Bea" };
  await addUser(env, ada.id, { username: "ada", globalName: "Ada", avatar: "abc123", color: 4 });
  await addUser(env, bea.id, { username: "bea", globalName: "Bea" });
  const startedAt = Date.parse("2026-10-18T08:00:00.000Z");
  const adaStart = await startDailyAttempt(env, { user: ada, ladder: "desktop", now: startedAt });
  assert.equal(adaStart.status, 200);
  const steps = stepsForPassage(adaStart.body.passage);
  const quick = (steps.length - 1) * gap() + 50;
  const adaSubmit = await submitDailyAttempt(env, {
    user: ada,
    attemptId: adaStart.body.attemptId,
    steps,
    now: startedAt + quick + 8_000,
  });
  assert.equal(adaSubmit.status, 200);
  const beaAt = startedAt + 60_000;
  const beaStart = await startDailyAttempt(env, { user: bea, ladder: "desktop", now: beaAt });
  const beaSubmit = await submitDailyAttempt(env, {
    user: bea,
    attemptId: beaStart.body.attemptId,
    steps: stepsForPassage(beaStart.body.passage),
    now: beaAt + quick,
  });
  assert.equal(beaSubmit.status, 200, JSON.stringify(beaSubmit.body));
  assert.ok(beaSubmit.body.wpm > adaSubmit.body.wpm);
  const fastNow = beaAt + quick;
  const board = await loadDailyBoard(env, {
    ladder: "desktop",
    day: "2026-10-18",
    limit: 25,
    user: ada,
    now: fastNow,
  });
  assert.equal(board.rows[0].name, "Bea");
  assert.equal(board.rows[0].rank, 1);
  assert.equal(board.rows[1].name, "Ada");
  assert.equal(board.rows[1].self, true);
  assert.equal(board.you.name, "Ada");
  assert.equal(board.you.rank, 2);
  const packed = JSON.stringify(board);
  assert.equal(board.rows[1].avatar, "https://fluxerusercontent.com/avatars/user-secret/abc123.png");
  assert.equal(board.you.avatar, board.rows[1].avatar);
  assert.equal(packed.replaceAll(board.rows[1].avatar, "").includes("user-secret"), false);
  assert.equal(packed.includes("4242424242"), false);
  assert.match(board.rows[0].avatar, /\/avatars\/[0-5]\.png$/);
  for (const row of [...board.rows, board.you]) {
    assert.equal("id" in row, false);
    assert.equal("user_id" in row, false);
  }
});

test("a custom Fluxer picture URL stays on the daily row without an id field", () => {
  const row = shapeDailyRow({
    id: "user-secret",
    name: "Ada",
    avatar: "https://fluxerusercontent.com/avatars/user-secret/abc123.png",
    color: 4,
    wpm: 80,
    accuracy: 99,
    rank: 3,
    self: true,
    ms: 12000,
  });
  assert.equal(row.avatar, "https://fluxerusercontent.com/avatars/user-secret/abc123.png");
  assert.equal(row.name, "Ada");
  assert.equal(row.self, true);
  assert.equal("id" in row, false);
  const plain = shapeDailyRow({
    id: "4242424242",
    name: "Bea",
    avatar: "https://fluxerstatic.com/avatars/2.png",
    color: null,
    wpm: 70,
    accuracy: 100,
    rank: 1,
  });
  assert.equal(plain.avatar, "https://fluxerstatic.com/avatars/2.png");
});

test("thirteen starts in one day are limited and old rows are purged", async () => {
  const { env } = sqliteEnv();
  const user = { id: "ada", username: "ada", global_name: "Ada" };
  await addUser(env, user.id, { globalName: "Ada" });
  const now = Date.parse("2026-10-18T12:00:00.000Z");
  for (let i = 0; i < 12; i += 1) {
    const started = await startDailyAttempt(env, { user, ladder: "desktop", now: now + i });
    assert.equal(started.status, 200);
  }
  const limited = await startDailyAttempt(env, { user, ladder: "desktop", now: now + 20 });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error, "limit");

  await insertDailyAttempt(env, {
    id: "old-attempt",
    userId: user.id,
    ladder: "mobile",
    day: "2026-10-16",
    passageId: "x",
    startedAt: now - 2 * DAY_MS,
    createdAt: now - 2 * DAY_MS,
  });
  await insertDailyAttempt(env, {
    id: "fresh-attempt",
    userId: user.id,
    ladder: "mobile",
    day: "2026-10-18",
    passageId: "x",
    startedAt: now - 60 * 60 * 1000,
    createdAt: now - 60 * 60 * 1000,
  });
  await insertDailyResult(env, {
    userId: user.id,
    ladder: "cursor",
    day: "2026-07-01",
    passageId: "x",
    wpm: 50,
    accuracy: 100,
    durationMs: 1000,
    startedAt: now - 91 * DAY_MS,
    finishedAt: now - 91 * DAY_MS,
    createdAt: now - 91 * DAY_MS,
  });
  await insertDailyResult(env, {
    userId: user.id,
    ladder: "cursor",
    day: "2026-10-17",
    passageId: "x",
    wpm: 50,
    accuracy: 100,
    durationMs: 1000,
    startedAt: now - DAY_MS,
    finishedAt: now - DAY_MS,
    createdAt: now - DAY_MS,
  });
  const purged = await purgeDaily(env, now);
  assert.equal(purged.attempts >= 1, true);
  assert.equal(purged.results, 1);
  const oldAttempt = await env.DB.prepare("SELECT id FROM daily_attempts WHERE id = ?").bind("old-attempt").first();
  const freshAttempt = await env.DB.prepare("SELECT id FROM daily_attempts WHERE id = ?").bind("fresh-attempt").first();
  assert.equal(oldAttempt, null);
  assert.equal(freshAttempt.id, "fresh-attempt");
  const oldScore = await env.DB.prepare(
    "SELECT day FROM daily_results WHERE ladder = ? AND day = ?",
  ).bind("cursor", "2026-07-01").first();
  const keptScore = await env.DB.prepare(
    "SELECT day FROM daily_results WHERE ladder = ? AND day = ?",
  ).bind("cursor", "2026-10-17").first();
  assert.equal(oldScore, null);
  assert.equal(keptScore.day, "2026-10-17");
});

test("daily HTTP routes validate auth, origin, and the query", async () => {
  const { env } = sqliteEnv();
  const evil = new Request("https://typing.example/api/daily/start", {
    method: "POST",
    headers: { origin: "http://evil.example", "content-type": "application/json" },
    body: JSON.stringify({ ladder: "desktop" }),
  });
  assert.equal((await dailyStart(evil, env)).status, 403);

  const anonymous = new Request("https://typing.example/api/daily/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ladder: "desktop" }),
  });
  assert.equal((await dailyStart(anonymous, env)).status, 401);
  const forged = new Request("https://typing.example/api/daily/submit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ attemptId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", steps: ["hi"], wpm: 9999 }),
  });
  assert.equal((await dailySubmit(forged, env)).status, 401);

  const now = Date.parse("2026-10-18T12:00:00.000Z");
  const badLadder = await dailyBoard(new Request("https://typing.example/api/daily?ladder=nope"), env, now);
  assert.equal(badLadder.status, 400);
  const future = await dailyBoard(new Request("https://typing.example/api/daily?day=2026-10-19"), env, now);
  assert.equal(future.status, 400);
  const huge = await dailyBoard(new Request("https://typing.example/api/daily?limit=101"), env, now);
  assert.equal(huge.status, 400);

  const board = await dailyBoard(new Request("https://typing.example/api/daily?ladder=desktop"), env, now);
  assert.equal(board.status, 200);
  assert.match(board.headers.get("cache-control"), /public, max-age=30/);
  const body = await board.json();
  assert.equal(body.rows.length, 0);
  assert.equal(body.you, null);
  assert.equal(body.limit, 25);
  assert.equal(body.passage, dailyPassage("desktop", "2026-10-18").text);
  assert.equal(body.serverNow, now);
});

test("a signed-in daily response is private and ignores a forged wpm", async () => {
  const { env } = sqliteEnv();
  const user = { id: "acct-zz9f3e", username: "ada", global_name: "Ada" };
  await addUser(env, user.id, { globalName: "Ada" });
  const sid = crypto.randomUUID();
  const exp = Date.now() + DAY_MS;
  await env.DB.prepare(
    "INSERT INTO sessions (id, user_id, refresh_token, expires_at) VALUES (?, ?, NULL, ?)",
  ).bind(sid, user.id, exp).run();
  const token = await signPayload({ sid, exp }, SECRET);
  const now = Date.parse("2026-10-18T12:00:00.000Z");
  const start = await dailyStart(new Request("https://typing.example/api/daily/start", {
    method: "POST",
    headers: { cookie: `tg_session=${token}`, "content-type": "application/json" },
    body: JSON.stringify({ ladder: "desktop" }),
  }), env, now);
  assert.equal(start.status, 200);
  const started = await start.json();
  const steps = stepsForPassage(started.passage);
  const finishAt = legalNow(now, steps);
  const submit = await dailySubmit(new Request("https://typing.example/api/daily/submit", {
    method: "POST",
    headers: { cookie: `tg_session=${token}`, "content-type": "application/json" },
    body: JSON.stringify({ attemptId: started.attemptId, steps, wpm: 9999, accuracy: 1, ms: 1 }),
  }), env, finishAt);
  assert.equal(submit.status, 200);
  const saved = await submit.json();
  assert.equal(saved.wpm, wpm(started.passage.length, finishAt - now));
  assert.equal(saved.scored, true);
  const listed = await dailyBoard(new Request("https://typing.example/api/daily?ladder=desktop", {
    headers: { cookie: `tg_session=${token}` },
  }), env, finishAt);
  assert.match(listed.headers.get("cache-control"), /private, max-age=30/);
  const board = await listed.json();
  assert.equal(board.you.wpm, saved.wpm);
  assert.equal(JSON.stringify(board).includes(user.id), false);
});

test("this browser keeps the first local daily result", () => {
  const map = new Map();
  const storage = {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
  };
  const first = rememberDailyLocal(storage, loadDailyLocal(storage), {
    ladder: "desktop",
    day: "2026-10-18",
    wpm: 70,
    accuracy: 98,
    ms: 20000,
    passageId: "p",
  });
  assert.equal(first.saved, true);
  assert.equal(first.kept, true);
  const second = rememberDailyLocal(storage, first.store, {
    ladder: "desktop",
    day: "2026-10-18",
    wpm: 10,
    accuracy: 10,
    ms: 90000,
    passageId: "p",
  });
  assert.equal(second.kept, false);
  assert.equal(loadDailyLocal(storage).runs["desktop|2026-10-18"].wpm, 70);
  map.set("tg_daily_v1", "{");
  assert.deepEqual(loadDailyLocal(storage).runs, {});
  map.set("tg_daily_v1", JSON.stringify({ v: 0, runs: { a: 1 } }));
  assert.deepEqual(loadDailyLocal(storage).runs, {});
  const throwing = {
    getItem: () => null,
    setItem: () => {
      throw new Error("private");
    },
  };
  const failed = rememberDailyLocal(throwing, null, {
    ladder: "mobile",
    day: "2026-10-18",
    wpm: 40,
    accuracy: 100,
    ms: 1000,
  });
  assert.equal(failed.saved, false);
  assert.equal(failed.kept, true);
  const steps = [];
  noteDailyStep(steps, "a", 2);
  noteDailyStep(steps, "a", 2);
  noteDailyStep(steps, "ab", 2);
  noteDailyStep(steps, "abc", 2);
  assert.deepEqual(steps, ["a", "ab"]);
});

test("the daily migration adds tables and leaves the account table alone", () => {
  assert.match(DAILY_SQL, /CREATE TABLE daily_results/);
  assert.match(DAILY_SQL, /CREATE TABLE daily_attempts/);
  assert.match(DAILY_SQL, /PRIMARY KEY \(user_id, ladder, day\)/);
  assert.doesNotMatch(DAILY_SQL, /ALTER TABLE/i);
  assert.doesNotMatch(DAILY_SQL, /DROP TABLE/i);
  assert.ok(poolFor("desktop", "set").length > 1);
  assert.ok(poolFor("cursor", "set").length > 1);
});
