import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { saveStatements } from "../src/db.js";
import { ensureTimedStream, pullTimedReveal } from "../src/timed-race.js";
import { settingsForKind } from "../src/formats.js";
import { planRating } from "../src/rating.js";
import {
  TIMED_CHUNK_CHARS,
  TIMED_REVEAL_REMAINING,
  buildTimedResults,
  extendStream,
  openStream,
  revealFor,
  reviewTimedSubmission,
  timedAlarmPlan,
} from "../src/timed.js";

const pool = [
  { id: "a", text: "a".repeat(100) },
  { id: "b", text: "b".repeat(100) },
  { id: "c", text: "c".repeat(100) },
];

function idsOf(text) {
  return text.split(" ").filter(Boolean).map((part) => part[0]);
}

test("a timed stream is seeded, deterministic, and does not repeat a passage immediately", () => {
  const first = openStream(pool, 42);
  const second = openStream(pool, 42);
  const other = openStream(pool, 99);
  assert.equal(first.text, second.text);
  assert.equal(first.ids.join(","), second.ids.join(","));
  assert.notEqual(first.text, other.text);
  const state = {
    seed: first.seed,
    pieceIndex: 0,
    text: "",
    revealed: 0,
    ids: [],
  };
  extendStream(state, 5000, pool);
  assert.ok(state.text.length >= 5000);
  const ids = state.ids;
  assert.ok(ids.length > pool.length);
  for (let i = 1; i < ids.length; i += 1) assert.notEqual(ids[i], ids[i - 1]);
  const marks = idsOf(state.text);
  for (let i = 1; i < marks.length; i += 1) assert.notEqual(marks[i], marks[i - 1]);
});

test("a race record grows stream and leaves the text field unused", () => {
  const state = {
    format: "timed",
    mode: "desktop",
    seed: 7,
    stream: "Hello there",
    pieceIndex: 0,
    revealed: 11,
    ids: [],
    sentence: "Hello there",
  };
  ensureTimedStream(state, 40);
  assert.equal(state.text, undefined);
  assert.equal(state.stream.startsWith("Hello there"), true);
  assert.ok(state.stream.length > 200);
  const chunk = pullTimedReveal(state, 40);
  assert.equal(typeof chunk, "string");
  assert.equal(chunk.startsWith("Hello there"), true);
  assert.equal(state.sentence, chunk);
  assert.ok(state.revealed > 11);
});

test("chunks stay hidden until the cursor is inside the reveal threshold", () => {
  const state = openStream(pool, 7, { chunk: TIMED_CHUNK_CHARS });
  assert.equal(state.revealed, TIMED_CHUNK_CHARS);
  assert.ok(state.text.length >= TIMED_CHUNK_CHARS);
  const held = revealFor(state, 40, pool);
  assert.equal(held.grew, false);
  assert.equal(state.revealed, TIMED_CHUNK_CHARS);
  const cursor = TIMED_CHUNK_CHARS - TIMED_REVEAL_REMAINING + 1;
  const grown = revealFor(state, cursor, pool);
  assert.equal(grown.grew, true);
  assert.ok(state.revealed >= cursor + TIMED_REVEAL_REMAINING);
  assert.equal(grown.sentence, state.text.slice(0, state.revealed));
  assert.ok(state.text.length >= state.revealed);
});

test("timed results use the full clock, then accuracy, then a shared place", () => {
  const durationMs = 30000;
  const state = {
    format: "timed",
    timeUp: true,
    durationMs,
    startAt: 0,
    mode: "desktop",
    kind: "room",
    sentence: "shown",
    players: [
      { id: "ada", name: "Ada", tag: "ada" },
      { id: "bea", name: "Bea", tag: "bea" },
      { id: "cam", name: "Cam", tag: "cam" },
    ],
    progress: {
      ada: { i: 100, ok: 90, err: 10 },
      bea: { i: 100, ok: 95, err: 5 },
      cam: { i: 40, ok: 40, err: 0 },
    },
    presence: {},
  };
  const ranked = buildTimedResults(state, durationMs);
  assert.equal(ranked.ranked, false);
  assert.equal(ranked.format, "timed");
  assert.equal(ranked.draw, false);
  assert.equal(ranked.rows[0].id, "bea");
  assert.equal(ranked.rows[0].place, 1);
  assert.equal(ranked.rows[0].wpm, 40);
  assert.equal(ranked.rows[0].ms, durationMs);
  assert.equal(ranked.rows[0].eloBefore, null);
  assert.equal(ranked.rows[0].eloAfter, null);
  assert.equal(ranked.rows[1].id, "ada");
  assert.equal(ranked.rows[1].place, 2);
  assert.equal(ranked.rows[2].place, 3);
  state.progress.ada = { i: 100, ok: 95, err: 5 };
  const draw = buildTimedResults(state, durationMs);
  assert.equal(draw.draw, true);
  assert.equal(draw.rows[0].place, 1);
  assert.equal(draw.rows[1].place, 1);
  assert.equal(draw.rows[2].place, 3);
});

test("forged timed input is rejected, and a real character still counts", () => {
  const stream = "hello world, friend";
  const startAt = 1_000_000;
  const durationMs = 30000;
  const burst = reviewTimedSubmission({
    stream,
    previous: "",
    next: stream.slice(0, 12),
    elapsedMs: 20,
    recentStrokes: 0,
    priorStrokes: 0,
    kind: "prog",
    now: startAt + 20,
    startAt,
    durationMs,
    ended: false,
  });
  assert.equal(burst.ok, false);
  assert.equal(burst.reason, "jump");
  assert.equal(burst.disqualify, true);

  const fast = reviewTimedSubmission({
    stream,
    previous: "h",
    next: "he",
    elapsedMs: 80,
    recentStrokes: 25,
    priorStrokes: 25,
    kind: "prog",
    now: startAt + 80,
    startAt,
    durationMs,
    ended: false,
  });
  assert.equal(fast.ok, false);
  assert.equal(fast.reason, "rate");
  assert.equal(fast.disqualify, true);

  const miss = reviewTimedSubmission({
    stream,
    previous: "",
    next: "x",
    elapsedMs: 200,
    recentStrokes: 0,
    priorStrokes: 0,
    kind: "prog",
    now: startAt + 200,
    startAt,
    durationMs,
    ended: false,
  });
  assert.equal(miss.ok, true);
  assert.equal(miss.index, 0);
  assert.equal(miss.errDelta, 1);
  assert.equal(miss.finished, false);

  const late = reviewTimedSubmission({
    stream,
    previous: "",
    next: "h",
    elapsedMs: durationMs + 5,
    recentStrokes: 0,
    priorStrokes: 0,
    kind: "prog",
    now: startAt + durationMs + 5,
    startAt,
    durationMs,
    ended: false,
  });
  assert.equal(late.ok, false);
  assert.equal(late.reason, "closed");

  const afterEnd = reviewTimedSubmission({
    stream,
    previous: "",
    next: "h",
    elapsedMs: 500,
    recentStrokes: 0,
    priorStrokes: 0,
    kind: "prog",
    now: startAt + 500,
    startAt,
    durationMs,
    ended: true,
  });
  assert.equal(afterEnd.reason, "ended");

  const good = reviewTimedSubmission({
    stream,
    previous: "",
    next: "h",
    elapsedMs: 200,
    recentStrokes: 0,
    priorStrokes: 0,
    kind: "prog",
    now: startAt + 200,
    startAt,
    durationMs,
    ended: false,
  });
  assert.equal(good.ok, true);
  assert.equal(good.index, 1);
  assert.equal(good.okDelta, 1);
});

test("a late timed alarm does not seal a race that already ended", () => {
  const live = { format: "timed", startAt: 1000, durationMs: 30000, results: null };
  assert.equal(timedAlarmPlan(live, 1000), "continue");
  assert.equal(timedAlarmPlan(live, 31000), "seal");
  live.results = { rows: [] };
  assert.equal(timedAlarmPlan(live, 40000), "ended");
  assert.equal(timedAlarmPlan({ format: "passage", results: null, startAt: 0, durationMs: 30000 }, 99999), "ignore");
});

test("the ranked queue ignores a timed or punctuation request", () => {
  assert.deepEqual(settingsForKind("queue", { format: "timed", durationMs: 30000 }), {
    format: "passage",
    durationMs: 0,
    ranked: true,
  });
  assert.deepEqual(settingsForKind("room", { format: "timed", durationMs: 30000 }), {
    format: "timed",
    durationMs: 30000,
    ranked: false,
  });
  assert.equal(settingsForKind("practice", { format: "punctuation" }).ranked, false);
});

test("the race save passes format through so a timed finish can skip best pace", () => {
  const src = readFileSync(new URL("../src/race.js", import.meta.url), "utf8");
  const call = src.slice(src.indexOf("saveRace(this.env"));
  assert.match(call.slice(0, 600), /format:\s*this\.state\.format/);
});

test("a timed save does not touch elo or best pace", () => {
  const race = {
    id: "race-1",
    mode: "desktop",
    format: "timed",
    sentence: "hello",
    ranked: false,
    startedAt: 1,
    finishedAt: 2,
    rows: [{ id: "ada", place: 1, wpm: 80, accuracy: 100, ms: 30000, progress: 40 }],
  };
  const plan = planRating(race.rows, { ranked: false });
  const sql = saveStatements(race, plan).map((row) => row.sql).join("\n");
  assert.equal(sql.includes("best_wpm"), false);
  assert.equal(sql.includes("elo_desktop"), false);
  const passage = saveStatements({ ...race, format: "passage" }, plan).map((row) => row.sql).join("\n");
  assert.equal(passage.includes("best_wpm_desktop"), true);
});
