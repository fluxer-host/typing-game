import assert from "node:assert/strict";
import test from "node:test";
import { chartPoints } from "../public/chart.js";
import {
  HISTORY_KEY,
  HISTORY_LIMIT,
  averageAccuracy,
  averageWpm,
  capHistory,
  formatRunDate,
  historyExport,
  loadHistory,
  mergeRuns,
  normalizeRun,
  parseHistory,
  personalBests,
  recentLabel,
  saveHistory,
} from "../public/history.js";
import { accuracy, wpm } from "../src/score.js";
import { soloFinish } from "../public/solo.js";
import { pickPassage } from "../src/sentences.js";

function run(over = {}) {
  return {
    at: 1_000,
    mode: "desktop",
    length: "sprint",
    passageId: "d-sp-e-001",
    wpm: 40,
    accuracy: 98,
    ms: 12_000,
    errors: 1,
    ...over,
  };
}

test("a run with a bad ladder, length, or clock is dropped", () => {
  assert.equal(normalizeRun(null), null);
  assert.equal(normalizeRun(run({ mode: "keyboard" })), null);
  assert.equal(normalizeRun(run({ length: "tiny" })), null);
  assert.equal(normalizeRun(run({ wpm: "fast" })), null);
  assert.equal(normalizeRun(run({ ms: 0 })), null);
  assert.equal(normalizeRun(run({ at: "yesterday" })), null);
  const kept = normalizeRun(run({ ranked: true, errors: -3 }));
  assert.equal(kept.ranked, false);
  assert.equal(kept.source, "local");
  assert.equal(kept.errors, 0);
  assert.equal(kept.opponent, "");
  assert.equal(normalizeRun(run({ opponent: "bot" })).opponent, "bot");
  assert.equal(normalizeRun(run({ opponent: "ghost" })).opponent, "ghost");
  assert.equal(normalizeRun(run({ opponent: "cpu" })).opponent, "");
});

test("history keeps the newest 200 runs and rejects a bad payload", () => {
  const runs = [];
  for (let n = 0; n < HISTORY_LIMIT + 5; n += 1) runs.push(run({ at: n + 1, wpm: n }));
  const capped = capHistory(runs);
  assert.equal(capped.length, HISTORY_LIMIT);
  assert.equal(capped[0].at, 6);
  assert.equal(capped.at(-1).at, HISTORY_LIMIT + 5);
  const mixed = parseHistory(JSON.stringify({
    v: 1,
    runs: [run(), { mode: "nope" }, run({ at: 2, wpm: 55 })],
  }));
  assert.equal(mixed.length, 2);
  assert.deepEqual(parseHistory('{"v":2,"runs":[]}'), []);
  assert.deepEqual(parseHistory("{"), []);
  assert.deepEqual(parseHistory(null), []);
  assert.deepEqual(parseHistory(""), []);
});

test("storage errors and private mode leave history empty", () => {
  const storage = {
    getItem() {
      throw new Error("private");
    },
    setItem() {
      throw new Error("private");
    },
  };
  assert.deepEqual(loadHistory(storage), []);
  assert.equal(saveHistory([run()], storage), false);
  assert.deepEqual(loadHistory({}), []);
  const memory = new Map();
  const box = {
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => memory.set(key, value),
  };
  assert.equal(saveHistory([run(), run({ mode: "bad" })], box), true);
  const saved = JSON.parse(memory.get(HISTORY_KEY));
  assert.equal(saved.v, 1);
  assert.equal(saved.runs.length, 1);
  assert.deepEqual(loadHistory(box), saved.runs);
  assert.match(historyExport([run()]), /"v": 1/);
});

test("personal bests and averages handle an empty list", () => {
  assert.deepEqual(personalBests([]), {});
  assert.equal(averageWpm([]), 0);
  assert.equal(averageAccuracy([]), 0);
  assert.equal(averageWpm(null), 0);
  const bests = personalBests([
    run({ wpm: 40, accuracy: 90 }),
    run({ wpm: 50, accuracy: 80 }),
    run({ wpm: 50, accuracy: 99, at: 2 }),
    run({ mode: "cursor", length: "long", wpm: 20, at: 3 }),
    run({ mode: "nope", wpm: 200 }),
  ]);
  assert.equal(bests["desktop|sprint"].accuracy, 99);
  assert.equal(bests["cursor|long"].wpm, 20);
  assert.equal(Object.keys(bests).length, 2);
  assert.equal(averageWpm([run({ wpm: 10 }), run({ wpm: 20 })]), 15);
  assert.equal(averageAccuracy([run({ accuracy: 80 }), run({ accuracy: 100 })]), 90);
});

test("recent labels name the ladder and hide a practice place", () => {
  const practice = recentLabel(run({ place: 1, ranked: false }));
  assert.equal(practice.includes("#"), false);
  assert.equal(practice.includes("Desktop"), true);
  assert.equal(practice.includes("Sprint"), true);
  assert.equal(practice.includes("Practice"), true);
  const ranked = recentLabel({ mode: "mobile", length: "set", ranked: true, label: "rated", place: 2, ms: 1000, wpm: 70 });
  assert.equal(ranked.includes("#2"), true);
  assert.equal(ranked.includes("Mobile"), true);
  assert.equal(ranked.includes("Set"), true);
  assert.equal(ranked.includes("Ranked"), true);
  const unknown = recentLabel({ mode: "cursor", length: "", label: "rated", place: 1, ms: 1000, wpm: 10 });
  assert.equal(unknown.includes("Sprint"), false);
  assert.equal(unknown.includes("Cursor"), true);
  const dnf = recentLabel({ mode: "desktop", length: "long", label: "rated", place: 1, ms: null, wpm: 0 });
  assert.equal(dnf.startsWith("DNF"), true);
  assert.equal(dnf.includes("#"), false);
  const bot = recentLabel(run({ opponent: "bot", place: 1 }));
  assert.equal(bot.includes("#"), false);
  assert.equal(bot.includes("Practice vs bot"), true);
  const ghost = recentLabel(run({ opponent: "ghost", place: 2, mode: "cursor", length: "long" }));
  assert.equal(ghost.includes("#"), false);
  assert.equal(ghost.includes("Practice vs ghost"), true);
  assert.equal(ghost.includes("Cursor"), true);
  assert.equal(formatRunDate(Date.UTC(2026, 9, 17)), "17 Oct 2026");
  assert.equal(formatRunDate("nope"), "");
});

test("local and server rows merge in time order", () => {
  const merged = mergeRuns(
    [run({ at: 20, passageId: "local" })],
    [{ source: "server", at: 10, mode: "desktop", wpm: 80, label: "rated" }, { source: "local", at: 30 }],
  );
  assert.deepEqual(merged.map((row) => row.at), [10, 20]);
  assert.equal(merged[0].source, "server");
  assert.equal(merged[1].ranked, false);
});

test("chart points stay empty, center a single run, and rise with pace", () => {
  const empty = chartPoints([]);
  assert.equal(empty.empty, true);
  assert.deepEqual(empty.points, []);
  assert.equal(empty.line, "");
  assert.equal(empty.max, 0);
  const one = chartPoints([run({ wpm: 42 })], { width: 320, height: 120 });
  assert.equal(one.points.length, 1);
  assert.equal(one.points[0].x, 160);
  assert.equal(one.line, "");
  const many = chartPoints([run({ wpm: 10 }), run({ wpm: 40 })], { width: 320, height: 120, pad: 12 });
  assert.ok(many.line.includes(" "));
  assert.ok(many.points[1].y < many.points[0].y);
  assert.equal(many.points[0].y, 84);
  assert.equal(many.points[1].y, 12);
  const extra = [];
  for (let n = 0; n < 40; n += 1) extra.push(run({ wpm: n, at: n }));
  assert.equal(chartPoints(extra).points.length, 30);
  assert.equal(chartPoints(null).empty, true);
});

test("a solo finish uses the shared words-per-minute formula", () => {
  const sentence = pickPassage("desktop", 1);
  const result = soloFinish({
    sentence,
    startAt: 1_000,
    now: 11_000,
    ok: sentence.length - 2,
    err: 2,
    mode: "desktop",
    length: "sprint",
    passageId: "d-sp-e-001",
  });
  assert.equal(result.wpm, wpm(sentence.length, 10_000));
  assert.equal(result.accuracy, accuracy(sentence.length - 2, 2));
  assert.equal(result.ms, 10_000);
  assert.equal(result.errors, 2);
  assert.equal(result.ranked, false);
  const instant = soloFinish({ sentence: "ab", startAt: 5, now: 5, ok: 0, err: 0 });
  assert.equal(instant.ms, 1);
  assert.equal(instant.wpm, wpm(2, 1));
});
