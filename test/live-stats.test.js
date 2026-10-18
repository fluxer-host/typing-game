import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { accuracy, wpm } from "../src/score.js";
import {
  LIVE_DASH,
  LIVE_FIX_HINT,
  LIVE_WARMING_TEXT,
  emptyLiveTrack,
  liveStatsModel,
  officialResultNote,
  stepLiveTrack,
  typingBlocked,
} from "../public/live-stats.js";

const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

function feed(points) {
  let track = emptyLiveTrack();
  for (const point of points) track = stepLiveTrack(track, point);
  return track;
}

function steady(ms, charsPerSecond) {
  const points = [];
  for (let t = 0; t <= ms; t += 200) {
    points.push({ elapsedMs: t, correctChars: Math.round((t / 1000) * charsPerSecond) });
  }
  return points;
}

test("the live pace stays blank until the first keystroke", () => {
  const model = liveStatsModel({ elapsedMs: 0, correctChars: 0, ok: 0, err: 0, started: true });
  assert.equal(model.phase, "dash");
  assert.equal(model.wpmText, LIVE_DASH);
  assert.equal(model.accuracyText, LIVE_DASH);
  assert.equal(model.wpmValue, null);
  const countdown = liveStatsModel({ elapsedMs: -500, started: false });
  assert.equal(countdown.phase, "dash");
  assert.equal(countdown.clockText, "ready");
});

test("a short burst stays hidden instead of showing an early spike", () => {
  const track = feed([
    { elapsedMs: 0, correctChars: 0 },
    { elapsedMs: 500, correctChars: 5 },
  ]);
  const model = liveStatsModel({
    elapsedMs: 500,
    correctChars: 5,
    ok: 5,
    err: 0,
    track,
    started: true,
  });
  assert.equal(model.phase, "warming");
  assert.equal(model.wpmText, LIVE_WARMING_TEXT);
  assert.equal(model.wpmValue, null);
  assert.equal(model.accuracyText, "100%");
  const faster = feed([
    { elapsedMs: 0, correctChars: 0 },
    { elapsedMs: 600, correctChars: 9 },
  ]);
  const spike = liveStatsModel({
    elapsedMs: 600,
    correctChars: 9,
    ok: 9,
    err: 0,
    track: faster,
    started: true,
  });
  assert.equal(spike.phase, "warming");
  assert.equal(spike.wpmValue, null);
});

test("a steady half minute settles on the true pace", () => {
  const points = steady(30_000, 5);
  const track = feed(points);
  const model = liveStatsModel({
    elapsedMs: 30_000,
    correctChars: 150,
    ok: 150,
    err: 0,
    track,
    started: true,
  });
  assert.equal(model.phase, "live");
  assert.ok(Math.abs(model.wpmValue - 60) <= 1, String(model.wpmValue));
  assert.equal(model.wpmText, model.wpmValue.toFixed(1));
  const midway = feed(steady(8_000, 5));
  const early = liveStatsModel({
    elapsedMs: 8_000,
    correctChars: 40,
    ok: 40,
    err: 0,
    track: midway,
    started: true,
  });
  assert.equal(early.phase, "live");
  assert.ok(Math.abs(early.wpmValue - wpm(40, 8_000)) <= 1, String(early.wpmValue));
});

test("a pause lowers the live pace and a backspace cannot make it negative", () => {
  const points = steady(10_000, 5);
  for (let t = 10_200; t <= 15_000; t += 200) points.push({ elapsedMs: t, correctChars: 50 });
  const paused = liveStatsModel({
    elapsedMs: 15_000,
    correctChars: 50,
    ok: 50,
    err: 0,
    track: feed(points),
    started: true,
  });
  assert.equal(paused.phase, "live");
  assert.ok(paused.wpmValue < 50, String(paused.wpmValue));
  assert.ok(paused.wpmValue > 0, String(paused.wpmValue));

  const typedPoints = steady(4_000, 5);
  typedPoints.push({ elapsedMs: 4_500, correctChars: 15 });
  const typed = feed(typedPoints);
  const undone = liveStatsModel({
    elapsedMs: 4_500,
    correctChars: 15,
    ok: 20,
    err: 0,
    typed: "hel",
    sentence: "hello world",
    track: typed,
    started: true,
  });
  assert.equal(undone.phase, "live");
  assert.ok(undone.wpmValue >= 0);
  assert.ok(undone.wpmValue < 60, String(undone.wpmValue));
  assert.equal(undone.accuracyText, `${accuracy(20, 0)}%`);
  assert.equal(undone.blocked, false);
});

test("accuracy is blank before input and stays on the keystroke count after a miss", () => {
  const clean = liveStatsModel({ elapsedMs: 200, correctChars: 0, ok: 0, err: 0, started: true });
  assert.equal(clean.accuracyText, LIVE_DASH);
  assert.equal(clean.blocked, false);
  const missed = liveStatsModel({
    elapsedMs: 800,
    correctChars: 3,
    ok: 3,
    err: 1,
    typed: "helo",
    sentence: "hello",
    track: feed([
      { elapsedMs: 0, correctChars: 0 },
      { elapsedMs: 800, correctChars: 3 },
    ]),
    started: true,
  });
  assert.equal(missed.phase, "warming");
  assert.equal(missed.accuracyValue, accuracy(3, 1));
  assert.equal(missed.accuracyText, "75%");
  assert.equal(missed.blocked, true);
  assert.equal(missed.hint, LIVE_FIX_HINT);
  assert.equal(typingBlocked("hel", "hello"), false);
  assert.equal(typingBlocked("helo", "hello"), true);
});

test("a reload mid-race warms up again instead of inventing a spike", () => {
  const reloaded = stepLiveTrack(emptyLiveTrack(), { elapsedMs: 20_000, correctChars: 80 });
  const atReload = liveStatsModel({
    elapsedMs: 20_000,
    correctChars: 80,
    ok: 80,
    err: 0,
    track: reloaded,
    started: true,
  });
  assert.equal(atReload.phase, "warming");
  assert.equal(atReload.wpmValue, null);
  let track = reloaded;
  for (let step = 200; step <= 3_000; step += 200) {
    track = stepLiveTrack(track, { elapsedMs: 20_000 + step, correctChars: 80 + Math.round(step / 200) });
  }
  const resumed = liveStatsModel({
    elapsedMs: 23_000,
    correctChars: 95,
    ok: 95,
    err: 0,
    track,
    started: true,
  });
  assert.equal(resumed.phase, "live");
  assert.ok(resumed.wpmValue > 30 && resumed.wpmValue < 80, String(resumed.wpmValue));
});

test("a stalled clock resets the warm-up and the official note explains a different finish", () => {
  let track = feed(steady(4_000, 5));
  track = stepLiveTrack(track, { elapsedMs: 8_000, correctChars: 40 });
  const stalled = liveStatsModel({
    elapsedMs: 8_000,
    correctChars: 40,
    ok: 40,
    err: 0,
    track,
    started: true,
  });
  assert.equal(stalled.phase, "warming");
  assert.equal(stalled.wpmValue, null);
  assert.equal(officialResultNote(null, 61.2), "Official result. The live pace was still warming up.");
  assert.equal(officialResultNote(60, 61.2).includes("Official result 61.2"), true);
  assert.equal(officialResultNote(61.2, 61.2), "");
  assert.equal(officialResultNote(61.1, 61.2), "");
  assert.equal(officialResultNote(40, Number.NaN), "");
});

test("the race stats are labelled and stay out of the live region", () => {
  const view = app.slice(app.indexOf("function raceView"), app.indexOf("function keyboard"));
  const paint = app.slice(app.indexOf("function paintStats"), app.indexOf("function paintLocked"));
  assert.match(view, /aria-label": "Live pace"/);
  assert.equal(view.includes("aria-live"), false);
  assert.equal(paint.includes("announce("), false);
  assert.match(app, /officialResultNote\(/);
});
