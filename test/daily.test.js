import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { MISSED, wordSkipText } from "../src/progress.js";
import { wpm } from "../src/score.js";
import { poolFor } from "../src/sentences.js";
import {
  CHAT_DAILY_FROM,
  DAILY_BOARD_DEFAULT_LIMIT,
  DAILY_MAX_ATTEMPT_MS,
  DAILY_MAX_STEPS,
  DAILY_STARTS_PER_DAY,
  dailyPassage,
  dailyScoreElapsed,
  dailyScoringInstant,
  dailySpanWindow,
  dayAllowed,
  isBetterDailyScore,
  isUniqueViolation,
  parseDailyQuery,
  passageForAttempt,
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
import { dailyBoard, dailyInput, dailyStart, dailySubmit } from "../src/daily-http.js";
import {
  insertDailyAttempt,
  insertDailyResult,
  loadDailyBoard,
  markDailyFirstInput,
  purgeDaily,
  replaceDailyResult,
  startDailyAttempt,
  submitDailyAttempt,
} from "../src/daily-store.js";
import { signPayload } from "../src/session.js";
import {
  dailyAnnounce,
  dailyCardNumbers,
  dailyKeptCopy,
  loadDailyLocal,
  noteDailyStep,
  rememberDailyLocal,
} from "../public/daily.js";

const INIT = readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8");
const DAILY_SQL = readFileSync(new URL("../migrations/0002_daily.sql", import.meta.url), "utf8");
const FIRST_SQL = readFileSync(new URL("../migrations/0004_daily_first_input.sql", import.meta.url), "utf8");
const DAY_MS = 86_400_000;
const SECRET = "test-session-secret";

function sqliteEnv() {
  const db = new DatabaseSync(":memory:");
  db.exec(INIT);
  db.exec(DAILY_SQL);
  db.exec(FIRST_SQL);
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
  const before = dailyPassage("desktop", "2026-11-22");
  const first = dailyPassage("desktop", CHAT_DAILY_FROM);
  assert.equal(CHAT_DAILY_FROM, "2026-11-23");
  assert.equal(before.text.includes("\n"), false);
  assert.equal(first.text.includes("\n"), true);
  assert.equal(first.text, first.text.toLowerCase());
  assert.equal(/[.,?'"!():;\-]/.test(first.text), false);
  const lines = first.text.split("\n");
  assert.ok(lines.length === 3 || lines.length === 4);
  assert.equal(passageForAttempt("desktop", first.id)?.text, first.text);
  assert.equal(passageForAttempt("desktop", before.id)?.text, before.text);
  let previous = "";
  for (let i = 0; i < 40; i += 1) {
    const day = utcDayString(Date.parse(`${CHAT_DAILY_FROM}T00:00:00.000Z`) + i * DAY_MS);
    for (const ladder of ["desktop", "mobile", "cursor"]) {
      const picked = dailyPassage(ladder, day);
      assert.equal(picked.text.includes("\n"), true, `${ladder} ${day}`);
      assert.ok(picked.text.split("\n").length === 3 || picked.text.split("\n").length === 4);
    }
    const desktop = dailyPassage("desktop", day);
    if (previous) assert.notEqual(desktop.id, previous, day);
    previous = desktop.id;
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
  assert.equal(today.span, "day");
  assert.equal(parseDailyQuery(params("span=nope"), now).error, "span");
  const weekQuery = parseDailyQuery(params("span=week&day=2020-01-01"), now);
  assert.equal(weekQuery.ok, true);
  assert.equal(weekQuery.span, "week");
  assert.equal(weekQuery.day, "2026-10-18");
  assert.deepEqual(dailySpanWindow("week", now), { span: "week", from: "2026-10-12", to: "2026-10-18" });
  assert.deepEqual(dailySpanWindow("month", now), { span: "month", from: "2026-09-19", to: "2026-10-18" });
  assert.deepEqual(dailySpanWindow("month", Date.parse("2026-03-01T00:00:00.000Z")), {
    span: "month",
    from: "2026-01-31",
    to: "2026-03-01",
  });
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
  assert.equal(parsed.finishedAt, undefined);
  assert.deepEqual(parsed.steps, ["a", "ab"]);
  const claimed = parseSubmitBody({ attemptId: id, steps: ["a"], finishedAt: 1_700_000_000_000, wpm: 9 });
  assert.equal(claimed.finishedAt, 1_700_000_000_000);
  assert.equal(claimed.wpm, undefined);
  assert.equal(parseSubmitBody({ attemptId: id, steps: ["a"], finishedAt: "soon" }).finishedAt, undefined);
  assert.equal(parseSubmitBody({ attemptId: id, steps: ["a"], finishedAt: null }).finishedAt, undefined);
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
  assert.equal(wrong.ok, true);
  assert.equal(wrong.wpm, wpm(3, 10_000));
  assert.ok(wrong.accuracy < 100);

  const missed = replayDaily({ passage: "ab", steps: ["x", "", "a", "ab"], elapsedMs: 200 });
  assert.equal(missed.ok, true);
  assert.ok(missed.accuracy < 100);
  assert.equal(missed.wpm, wpm(2, 200));

  const clean = replayDaily({ passage, steps, elapsedMs: 10_000 });
  assert.equal(clean.ok, true);
  assert.equal(clean.wpm, wpm(passage.length, 10_000));
  assert.equal(clean.accuracy, 100);

  const quote = "ab cd";
  const skip = wordSkipText(quote, "a");
  assert.equal(skip, `a${MISSED} `);
  const moved = replayDaily({
    passage: quote,
    steps: ["a", skip, `${skip}c`, `${skip}cd`],
    elapsedMs: 10_000,
  });
  assert.equal(moved.ok, true);
  assert.equal(moved.wpm, wpm(4, 10_000));
  assert.ok(moved.accuracy < 100);
  const copied = replayDaily({ passage: quote, steps: ["ab "], elapsedMs: 10_000 });
  assert.equal(copied.reason, "jump");
});

test("the first completed attempt is the score and a used attempt is rejected", async () => {
  const { env } = sqliteEnv();
  const user = { id: "ada", username: "ada", global_name: "Ada" };
  await addUser(env, user.id, { globalName: "Ada" });
  const startedAt = Date.parse("2026-10-18T12:00:00.000Z");
  const first = await played(env, user, "desktop", startedAt);
  assert.equal(first.submitted.status, 200);
  assert.equal(first.submitted.body.saved, true);
  assert.equal(first.submitted.body.scored, true);
  assert.equal(first.submitted.body.improved, true);
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
  assert.equal(retry.status, 200);
  assert.equal(retry.body.result.wpm, first.submitted.body.wpm);
  assert.equal(retry.body.attemptId === first.started.body.attemptId, false);

  assert.equal(scoreDecision({ consumed: false }).status, 200);
  assert.equal(scoreDecision({ consumed: true }).error, "used");
});

function storedScore(db, userId, ladder, day) {
  return db.prepare(
    "SELECT wpm, accuracy, duration_ms, created_at FROM daily_results WHERE user_id = ? AND ladder = ? AND day = ?",
  ).get(userId, ladder, day);
}

test("a better daily finish replaces the score and a slower or equal finish leaves it", async () => {
  const { env, db } = sqliteEnv();
  const user = { id: "ada", username: "ada", global_name: "Ada" };
  await addUser(env, user.id, { globalName: "Ada" });
  const startedAt = Date.parse("2026-10-18T12:00:00.000Z");
  const slowStart = await startDailyAttempt(env, { user, ladder: "desktop", now: startedAt });
  assert.equal(slowStart.status, 200);
  assert.equal(slowStart.body.result, undefined);
  const steps = stepsForPassage(slowStart.body.passage);
  const slowNow = legalNow(startedAt, steps) + 30_000;
  const slow = await submitDailyAttempt(env, {
    user,
    attemptId: slowStart.body.attemptId,
    steps,
    now: slowNow,
  });
  assert.equal(slow.status, 200);
  assert.equal(slow.body.improved, true);
  const standing = storedScore(db, user.id, "desktop", "2026-10-18");
  assert.equal(standing.wpm, slow.body.wpm);
  assert.equal(standing.created_at, slowNow);

  const equalAt = slowNow + 1000;
  const equalStart = await startDailyAttempt(env, { user, ladder: "desktop", now: equalAt });
  assert.equal(equalStart.status, 200);
  assert.equal(equalStart.body.result.wpm, slow.body.wpm);
  const equalNow = equalAt + (slowNow - startedAt);
  const equal = await submitDailyAttempt(env, {
    user,
    attemptId: equalStart.body.attemptId,
    steps,
    now: equalNow,
  });
  assert.equal(equal.status, 200);
  assert.equal(equal.body.improved, false);
  assert.equal(equal.body.saved, false);
  assert.equal(equal.body.scored, false);
  assert.equal(equal.body.wpm, slow.body.wpm);
  assert.equal(storedScore(db, user.id, "desktop", "2026-10-18").created_at, slowNow);

  const fastAt = equalNow + 1000;
  const fastStart = await startDailyAttempt(env, { user, ladder: "desktop", now: fastAt });
  const fastNow = legalNow(fastAt, steps);
  const fast = await submitDailyAttempt(env, {
    user,
    attemptId: fastStart.body.attemptId,
    steps,
    now: fastNow,
  });
  assert.equal(fast.status, 200);
  assert.equal(fast.body.improved, true);
  assert.equal(fast.body.scored, true);
  assert.ok(fast.body.wpm > slow.body.wpm);
  const replaced = storedScore(db, user.id, "desktop", "2026-10-18");
  assert.equal(replaced.wpm, fast.body.wpm);
  assert.equal(replaced.created_at, fastNow);

  const worseAt = fastNow + 1000;
  const worseStart = await startDailyAttempt(env, { user, ladder: "desktop", now: worseAt });
  const worse = await submitDailyAttempt(env, {
    user,
    attemptId: worseStart.body.attemptId,
    steps,
    now: legalNow(worseAt, steps) + 15_000,
  });
  assert.equal(worse.status, 200);
  assert.equal(worse.body.improved, false);
  assert.equal(worse.body.wpm, fast.body.wpm);
  assert.equal(storedScore(db, user.id, "desktop", "2026-10-18").created_at, fastNow);
});

test("the daily clock starts at the first key and the attempt still expires from Play", async () => {
  assert.equal(dailyScoreElapsed({ startedAt: 1_000, firstInputAt: 4_000, now: 9_000 }), 5_000);
  assert.equal(dailyScoreElapsed({ startedAt: 1_000, firstInputAt: null, now: 9_000 }), 8_000);
  assert.equal(dailyScoreElapsed({ startedAt: 1_000, firstInputAt: 500, now: 9_000 }), 8_000);
  assert.equal(dailyScoreElapsed({ startedAt: 1_000, firstInputAt: 9_500, now: 9_000 }), 8_000);

  const { env, db } = sqliteEnv();
  const user = { id: "ada", username: "ada", global_name: "Ada" };
  await addUser(env, user.id, { globalName: "Ada" });
  const startedAt = Date.parse("2026-10-18T12:00:00.000Z");
  const started = await startDailyAttempt(env, { user, ladder: "desktop", now: startedAt });
  const steps = stepsForPassage(started.body.passage);
  const typedMs = (steps.length - 1) * gap() + 50;
  const firstAt = startedAt + 20_000;
  const marked = await markDailyFirstInput(env, { user, attemptId: started.body.attemptId, now: firstAt });
  assert.equal(marked.status, 200);
  assert.equal(marked.body.firstInputAt, firstAt);
  const again = await markDailyFirstInput(env, { user, attemptId: started.body.attemptId, now: firstAt + 5_000 });
  assert.equal(again.body.firstInputAt, firstAt);
  const submitted = await submitDailyAttempt(env, {
    user,
    attemptId: started.body.attemptId,
    steps,
    now: firstAt + typedMs,
  });
  assert.equal(submitted.status, 200);
  assert.equal(submitted.body.improved, true);
  assert.equal(submitted.body.ms, typedMs);
  assert.equal(submitted.body.attemptMs, typedMs);
  assert.equal(submitted.body.attemptWpm, submitted.body.wpm);
  assert.equal(submitted.body.wpm, wpm(started.body.passage.length, typedMs));
  const row = db.prepare(
    "SELECT duration_ms, first_input_at FROM daily_results r JOIN daily_attempts a ON a.user_id = r.user_id AND a.ladder = r.ladder AND a.day = r.day WHERE a.id = ?",
  ).get(started.body.attemptId);
  assert.equal(row.duration_ms, typedMs);
  assert.equal(row.first_input_at, firstAt);

  const lateStart = await startDailyAttempt(env, { user, ladder: "mobile", now: startedAt });
  const lateMark = await markDailyFirstInput(env, {
    user,
    attemptId: lateStart.body.attemptId,
    now: startedAt + DAILY_MAX_ATTEMPT_MS - 1_000,
  });
  assert.equal(lateMark.status, 200);
  const expired = await submitDailyAttempt(env, {
    user,
    attemptId: lateStart.body.attemptId,
    steps: stepsForPassage(lateStart.body.passage),
    now: startedAt + DAILY_MAX_ATTEMPT_MS + 1,
  });
  assert.equal(expired.status, 400);
  assert.equal(expired.body.reason, "duration");
  const used = await markDailyFirstInput(env, { user, attemptId: started.body.attemptId, now: firstAt + typedMs + 1 });
  assert.equal(used.status, 409);
  assert.equal(used.body.error, "used");
});

test("the official daily clock stops at a last-key claim inside the stamp window", async () => {
  const origin = 10_000;
  const arrival = 13_000;
  assert.equal(dailyScoringInstant({ origin, arrival, claimed: arrival - 400, strokes: 20 }), arrival - 400);
  assert.equal(dailyScoringInstant({ origin, arrival, claimed: arrival + 1, strokes: 20 }), arrival);
  assert.equal(dailyScoringInstant({ origin, arrival, claimed: origin - 1, strokes: 20 }), arrival);
  assert.equal(dailyScoringInstant({ origin, arrival, claimed: origin + 10, strokes: 20 }), arrival);
  assert.equal(dailyScoringInstant({ origin: null, arrival, claimed: origin + 800, strokes: 20 }), arrival);
  assert.equal(dailyScoringInstant({ origin, arrival, claimed: "soon", strokes: 20 }), arrival);
  assert.equal(dailyScoringInstant({ origin, arrival, strokes: 20 }), arrival);

  const { env, db } = sqliteEnv();
  const user = { id: "ada", username: "ada", global_name: "Ada" };
  await addUser(env, user.id, { globalName: "Ada" });

  async function stamped(ladder, startedAt, { readMs, extraMs, finishedAt }) {
    const started = await startDailyAttempt(env, { user, ladder, now: startedAt });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    const steps = stepsForPassage(started.body.passage);
    const firstAt = startedAt + readMs;
    const marked = await markDailyFirstInput(env, { user, attemptId: started.body.attemptId, now: firstAt });
    assert.equal(marked.status, 200);
    const arrivalAt = firstAt + (steps.length - 1) * gap() + extraMs;
    const claimed = typeof finishedAt === "function" ? finishedAt({ firstAt, arrivalAt, steps }) : finishedAt;
    const submitted = await submitDailyAttempt(env, {
      user,
      attemptId: started.body.attemptId,
      steps,
      now: arrivalAt,
      finishedAt: claimed,
    });
    return { started, steps, firstAt, arrivalAt, submitted };
  }

  const slow = await stamped("desktop", Date.parse("2026-10-18T12:00:00.000Z"), {
    readMs: 20_000,
    extraMs: 8_000,
  });
  assert.equal(slow.submitted.status, 200);
  assert.equal(slow.submitted.body.improved, true);
  const slowElapsed = slow.arrivalAt - slow.firstAt;
  assert.equal(slow.submitted.body.attemptMs, slowElapsed);
  assert.equal(slow.submitted.body.ms, slowElapsed);

  const fast = await stamped("desktop", slow.arrivalAt + 1_000, {
    readMs: 4_000,
    extraMs: 400,
    finishedAt: ({ arrivalAt }) => arrivalAt - 400,
  });
  const fastElapsed = (fast.steps.length - 1) * gap();
  assert.equal(fast.submitted.status, 200);
  assert.equal(fast.submitted.body.improved, true);
  assert.equal(fast.submitted.body.attemptMs, fastElapsed);
  assert.equal(fast.submitted.body.ms, fastElapsed);
  assert.equal(fast.submitted.body.attemptWpm, wpm(fast.started.body.passage.length, fastElapsed));
  assert.equal(fast.submitted.body.wpm, fast.submitted.body.attemptWpm);
  assert.equal(fast.submitted.body.attemptAccuracy, fast.submitted.body.accuracy);
  assert.ok(fast.submitted.body.wpm > slow.submitted.body.wpm);
  const saved = db.prepare(
    "SELECT duration_ms, finished_at, created_at FROM daily_results WHERE user_id = ? AND ladder = ? AND day = ?",
  ).get(user.id, "desktop", "2026-10-18");
  assert.equal(saved.duration_ms, fastElapsed);
  assert.equal(saved.finished_at, fast.arrivalAt - 400);
  assert.equal(saved.created_at, fast.arrivalAt);

  const future = await stamped("desktop", fast.arrivalAt + 1_000, {
    readMs: 3_000,
    extraMs: 10_000,
    finishedAt: ({ arrivalAt }) => arrivalAt + 500,
  });
  assert.equal(future.submitted.status, 200);
  assert.equal(future.submitted.body.improved, false);
  assert.equal(future.submitted.body.wpm, fast.submitted.body.wpm);
  assert.equal(future.submitted.body.attemptMs, future.arrivalAt - future.firstAt);

  const before = await stamped("desktop", future.arrivalAt + 1_000, {
    readMs: 3_000,
    extraMs: 10_000,
    finishedAt: ({ firstAt }) => firstAt - 10,
  });
  assert.equal(before.submitted.status, 200);
  assert.equal(before.submitted.body.improved, false);
  assert.equal(before.submitted.body.attemptMs, before.arrivalAt - before.firstAt);

  const rushed = await stamped("desktop", before.arrivalAt + 1_000, {
    readMs: 3_000,
    extraMs: 10_000,
    finishedAt: ({ firstAt, steps }) => firstAt + (steps.length - 1) * gap() - 1,
  });
  assert.equal(rushed.submitted.status, 200);
  assert.equal(rushed.submitted.body.improved, false);
  assert.equal(rushed.submitted.body.attemptMs, rushed.arrivalAt - rushed.firstAt);
  assert.equal(storedScore(db, user.id, "desktop", "2026-10-18").duration_ms, fastElapsed);
  assert.equal(storedScore(db, user.id, "desktop", "2026-10-18").created_at, fast.arrivalAt);

  const bareStart = rushed.arrivalAt + 1_000;
  const bare = await startDailyAttempt(env, { user, ladder: "mobile", now: bareStart });
  assert.equal(bare.status, 200);
  const bareSteps = stepsForPassage(bare.body.passage);
  const bareArrival = bareStart + 30_000;
  const bareClaim = bareStart + (bareSteps.length - 1) * gap() + 1_000;
  const bareSubmit = await submitDailyAttempt(env, {
    user,
    attemptId: bare.body.attemptId,
    steps: bareSteps,
    now: bareArrival,
    finishedAt: bareClaim,
  });
  assert.equal(bareSubmit.status, 200);
  assert.equal(bareSubmit.body.improved, true);
  assert.equal(bareSubmit.body.attemptMs, 30_000);
  assert.equal(bareSubmit.body.ms, 30_000);
  const bareRow = db.prepare(
    "SELECT duration_ms, finished_at, created_at FROM daily_results WHERE user_id = ? AND ladder = ? AND day = ?",
  ).get(user.id, "mobile", "2026-10-18");
  assert.equal(bareRow.duration_ms, 30_000);
  assert.equal(bareRow.finished_at, bareArrival);
  assert.equal(bareRow.created_at, bareArrival);

  const plainStart = bareArrival + 1_000;
  const plain = await startDailyAttempt(env, { user, ladder: "cursor", now: plainStart });
  assert.equal(plain.status, 200);
  const plainSteps = stepsForPassage(plain.body.passage);
  const plainFirst = plainStart + 6_000;
  const plainMark = await markDailyFirstInput(env, { user, attemptId: plain.body.attemptId, now: plainFirst });
  assert.equal(plainMark.status, 200);
  const plainElapsed = (plainSteps.length - 1) * gap() + 50;
  const plainSubmit = await submitDailyAttempt(env, {
    user,
    attemptId: plain.body.attemptId,
    steps: plainSteps,
    now: plainFirst + plainElapsed,
  });
  assert.equal(plainSubmit.status, 200);
  assert.equal(plainSubmit.body.ms, plainElapsed);
  assert.equal(plainSubmit.body.attemptMs, plainElapsed);
  assert.equal(plainSubmit.body.wpm, wpm(plain.body.passage.length, plainElapsed));
});

test("a submit request stops the clock at a last-key claim", async () => {
  const { env } = sqliteEnv();
  const user = { id: "acct-zz9f3e", username: "ada", global_name: "Ada" };
  await addUser(env, user.id, { globalName: "Ada" });
  const sid = crypto.randomUUID();
  const exp = Date.now() + DAY_MS;
  await env.DB.prepare(
    "INSERT INTO sessions (id, user_id, refresh_token, expires_at) VALUES (?, ?, NULL, ?)",
  ).bind(sid, user.id, exp).run();
  const token = await signPayload({ sid, exp }, SECRET);
  const now = Date.parse("2026-10-18T15:00:00.000Z");
  const start = await dailyStart(new Request("https://typing.example/api/daily/start", {
    method: "POST",
    headers: { cookie: `tg_session=${token}`, "content-type": "application/json" },
    body: JSON.stringify({ ladder: "desktop" }),
  }), env, now);
  assert.equal(start.status, 200);
  const started = await start.json();
  const steps = stepsForPassage(started.passage);
  const firstAt = now + 4_000;
  const marked = await dailyInput(new Request("https://typing.example/api/daily/input", {
    method: "POST",
    headers: { cookie: `tg_session=${token}`, "content-type": "application/json" },
    body: JSON.stringify({ attemptId: started.attemptId }),
  }), env, firstAt);
  assert.equal(marked.status, 200);
  const elapsed = (steps.length - 1) * gap() + 400;
  const arrival = firstAt + elapsed + 400;
  const submit = await dailySubmit(new Request("https://typing.example/api/daily/submit", {
    method: "POST",
    headers: { cookie: `tg_session=${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      attemptId: started.attemptId,
      steps,
      finishedAt: arrival - 400,
      wpm: 9999,
      accuracy: 1,
    }),
  }), env, arrival);
  assert.equal(submit.status, 200);
  const saved = await submit.json();
  assert.equal(saved.attemptMs, elapsed);
  assert.equal(saved.ms, elapsed);
  assert.equal(saved.wpm, wpm(started.passage.length, elapsed));
  assert.equal(saved.attemptWpm, saved.wpm);
  assert.notEqual(saved.wpm, 9999);
});

test("the results card shows the official attempt after the save", () => {
  const local = { wpm: 238.5, accuracy: 100, ms: 2_400 };
  const pending = dailyCardNumbers({
    pending: true,
    local,
    attempt: { wpm: 200, accuracy: 100, ms: 2_900, rank: 2 },
  });
  assert.equal(pending.wpm, 238.5);
  assert.equal(pending.ms, 2_400);
  assert.equal(pending.rank, null);
  const saved = dailyCardNumbers({
    pending: false,
    local,
    attempt: { wpm: 238.5, accuracy: 100, ms: 2_400, rank: 1 },
  });
  assert.equal(saved.wpm, 238.5);
  assert.equal(saved.ms, 2_400);
  assert.equal(saved.accuracy, 100);
  assert.equal(saved.rank, 1);
  const kept = dailyCardNumbers({
    pending: false,
    local,
    attempt: { wpm: 200, accuracy: 100, ms: 2_900, rank: 4 },
  });
  assert.equal(kept.wpm, 200);
  assert.equal(kept.accuracy, 100);
  assert.equal(kept.ms, 2_900);
  assert.equal(kept.rank, 4);
  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(app, /dailyCardNumbers\(/);
  assert.match(app, /steps: daily\.steps\.slice\(\), finishedAt/);
});

test("the stored daily score changes only when the finish is strictly better", async () => {
  const { env, db } = sqliteEnv();
  const user = { id: "ada", username: "ada", global_name: "Ada" };
  await addUser(env, user.id, { globalName: "Ada" });
  const base = {
    userId: user.id,
    ladder: "desktop",
    day: "2026-10-18",
    passageId: "p",
    wpm: 80,
    accuracy: 99,
    durationMs: 20_000,
    startedAt: 1,
    finishedAt: 20_001,
    createdAt: 20_001,
  };
  assert.equal(isBetterDailyScore({ wpm: 81, accuracy: 1, durationMs: 99_999 }, base), true);
  assert.equal(isBetterDailyScore({ wpm: 80, accuracy: 100, durationMs: 99_999 }, base), true);
  assert.equal(isBetterDailyScore({ wpm: 80, accuracy: 99, durationMs: 19_999 }, base), true);
  assert.equal(isBetterDailyScore({ wpm: 80, accuracy: 99, duration_ms: 19_999 }, { wpm: 80, accuracy: 99, duration_ms: 20_000 }), true);
  assert.equal(isBetterDailyScore(base, base), false);
  assert.equal(isBetterDailyScore({ wpm: 79, accuracy: 100, durationMs: 1 }, base), false);
  assert.equal(isBetterDailyScore({ wpm: 80, accuracy: 98, durationMs: 1 }, base), false);
  assert.equal(isBetterDailyScore({ wpm: Number.NaN, accuracy: 100, durationMs: 1 }, base), false);

  assert.equal((await insertDailyResult(env, base)).saved, true);
  const worse = { ...base, wpm: 70, accuracy: 100, durationMs: 1000, finishedAt: 30_000, createdAt: 30_000 };
  assert.equal(await replaceDailyResult(env, worse), false);
  assert.equal(storedScore(db, user.id, "desktop", "2026-10-18").created_at, 20_001);

  const same = { ...base, finishedAt: 40_000, createdAt: 40_000 };
  assert.equal(await replaceDailyResult(env, same), false);
  assert.equal(storedScore(db, user.id, "desktop", "2026-10-18").wpm, 80);

  const quicker = { ...base, durationMs: 19_000, finishedAt: 50_000, createdAt: 50_000 };
  assert.equal(await replaceDailyResult(env, quicker), true);
  assert.equal(storedScore(db, user.id, "desktop", "2026-10-18").duration_ms, 19_000);

  const accurate = { ...base, accuracy: 100, durationMs: 25_000, finishedAt: 60_000, createdAt: 60_000 };
  assert.equal(await replaceDailyResult(env, accurate), true);
  assert.equal(storedScore(db, user.id, "desktop", "2026-10-18").accuracy, 100);

  const slower = { ...accurate, durationMs: 30_000, finishedAt: 70_000, createdAt: 70_000 };
  assert.equal(await replaceDailyResult(env, slower), false);
  assert.equal(storedScore(db, user.id, "desktop", "2026-10-18").created_at, 60_000);

  const faster = { ...base, wpm: 90, accuracy: 50, durationMs: 40_000, finishedAt: 80_000, createdAt: 80_000 };
  assert.equal(await replaceDailyResult(env, faster), true);
  const row = storedScore(db, user.id, "desktop", "2026-10-18");
  assert.equal(row.wpm, 90);
  assert.equal(row.created_at, 80_000);
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
  assert.equal(started.status, 200);
  assert.equal(started.body.result.wpm, 80);
  const steps = stepsForPassage(started.body.passage);
  const submitted = await submitDailyAttempt(env, {
    user,
    attemptId: started.body.attemptId,
    steps,
    now: legalNow(startedAt, steps),
  });
  assert.equal(submitted.status, 200);
  assert.equal(submitted.body.improved, true);
  assert.ok(submitted.body.wpm > 80);
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

test("a week sums saved days and a missing day adds nothing", async () => {
  const { env } = sqliteEnv();
  const now = Date.parse("2026-10-18T15:00:00.000Z");
  const people = [
    ["ada-secret", "Ada"],
    ["bea-secret", "Bea"],
    ["cal-secret", "Cal"],
    ["dee-secret", "Dee"],
    ["eve-secret", "Eve"],
    ["fay-secret", "Fay"],
  ];
  for (const [id, name] of people) {
    await addUser(env, id, { username: id, globalName: name, avatar: "abc123" });
  }
  const insert = (id, day, wpm, accuracy, created, ladder = "desktop") => env.DB.prepare(
    `INSERT INTO daily_results (
       user_id, ladder, day, passage_id, wpm, accuracy, duration_ms, started_at, finished_at, created_at
     ) VALUES (?, ?, ?, 'passage', ?, ?, 1000, 1, 2, ?)`,
  ).bind(id, ladder, day, wpm, accuracy, created).run();
  await insert("ada-secret", "2026-10-12", 50, 90, 1);
  await insert("ada-secret", "2026-10-18", 50, 90, 8);
  await insert("bea-secret", "2026-10-18", 100, 100, 2);
  await insert("cal-secret", "2026-10-17", 40, 80, 3);
  await insert("cal-secret", "2026-10-18", 60, 100, 10);
  await insert("dee-secret", "2026-10-16", 50, 95, 4);
  await insert("dee-secret", "2026-10-18", 50, 95, 20);
  await insert("eve-secret", "2026-10-15", 50, 90, 5);
  await insert("eve-secret", "2026-10-18", 50, 90, 5);
  await insert("fay-secret", "2026-10-14", 50, 90, 6);
  await insert("fay-secret", "2026-10-18", 50, 90, 9);
  await insert("ada-secret", "2026-10-11", 200, 100, 1);
  await insert("bea-secret", "2026-10-18", 80, 100, 1, "mobile");

  const board = await loadDailyBoard(env, {
    ladder: "desktop",
    day: "2020-01-01",
    span: "week",
    limit: 25,
    user: { id: "ada-secret", username: "ada-secret", global_name: "Ada", avatar: "abc123" },
    now,
  });
  assert.equal(board.span, "week");
  assert.equal(board.from, "2026-10-12");
  assert.equal(board.to, "2026-10-18");
  assert.equal(board.day, "2026-10-18");
  assert.deepEqual(board.rows.map((row) => row.name), ["Dee", "Eve", "Ada", "Fay", "Cal", "Bea"]);
  assert.equal(board.rows[2].wpm, 100);
  assert.equal(board.rows[2].days, 2);
  assert.equal(board.rows[2].accuracy, 90);
  assert.equal(board.you.rank, 3);
  assert.equal(board.you.days, 2);
  assert.equal("id" in board.rows[2], false);
  const packed = JSON.stringify(board).replaceAll(board.rows[2].avatar, "");
  assert.equal(packed.includes("ada-secret"), false);

  const month = await loadDailyBoard(env, {
    ladder: "desktop",
    span: "month",
    limit: 1,
    offset: 0,
    user: null,
    now,
  });
  assert.equal(month.from, "2026-09-19");
  assert.equal(month.rows[0].name, "Ada");
  assert.equal(month.rows[0].wpm, 300);
  assert.equal(month.rows[0].days, 3);
  assert.equal(month.total, 6);
  assert.equal(month.hasMore, true);
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

test("starts past the daily cap are limited and old rows are purged", async () => {
  const { env } = sqliteEnv();
  const user = { id: "ada", username: "ada", global_name: "Ada" };
  await addUser(env, user.id, { globalName: "Ada" });
  const now = Date.parse("2026-10-18T12:00:00.000Z");
  for (let i = 0; i < DAILY_STARTS_PER_DAY; i += 1) {
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

test("a kept daily finish names the standing score", () => {
  assert.equal(dailyKeptCopy(81.2), "Today's score stays at 81.2 WPM. This run does not replace it.");
  const kept = dailyAnnounce({
    kept: true,
    standingWpm: 81.2,
    wpm: 70,
    accuracy: 100,
    ms: 12_000,
    signedIn: true,
  });
  assert.match(kept, /Today's score stays at 81\.2 WPM\. This run does not replace it\./);
  assert.match(kept, /70\.0 words per minute/);
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

test("the daily first-key migration adds one nullable column", () => {
  assert.match(FIRST_SQL, /ALTER TABLE daily_attempts ADD COLUMN first_input_at INTEGER/);
  assert.doesNotMatch(FIRST_SQL, /DROP TABLE/i);
  assert.doesNotMatch(FIRST_SQL, /daily_results/);
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
