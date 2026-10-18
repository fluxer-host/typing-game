import assert from "node:assert/strict";
import test from "node:test";
import { botTimeline, clampBotWpm, stepDelay } from "../public/bot.js";
import { progressAt } from "../public/ghost.js";
import { wpm } from "../src/score.js";

function scripted(values) {
  let index = 0;
  return () => (index < values.length ? values[index++] : 0.5);
}

test("the same seed replays the same timeline and another seed does not", () => {
  const text = "The quick brown fox jumps over the lazy dog. ".repeat(4);
  const first = botTimeline(text, 60, 1);
  const again = botTimeline(text, 60, 1);
  assert.deepEqual(again, first);
  assert.deepEqual(botTimeline(text, 60, "replay"), botTimeline(text, 60, "replay"));
  assert.notDeepEqual(botTimeline(text, 60, 1).samples, botTimeline(text, 60, 2).samples);
});

test("a bot timeline stays monotonic and finishes the whole passage", () => {
  const text = "Pack the yellow kayak before the tide turns. ".repeat(8);
  const timeline = botTimeline(text, 55, 7);
  assert.equal(timeline.samples[0].t, 0);
  assert.equal(timeline.samples[0].i, 0);
  assert.equal(timeline.samples.length, text.length + 1);
  for (let n = 0; n < timeline.samples.length; n += 1) {
    assert.equal(timeline.samples[n].i, n);
    if (n > 0) assert.ok(timeline.samples[n].t > timeline.samples[n - 1].t);
  }
  assert.equal(timeline.samples.at(-1).i, text.length);
  assert.equal(timeline.finishMs, timeline.samples.at(-1).t);
  assert.equal(progressAt(timeline.samples, 0, text.length), 0);
  assert.equal(progressAt(timeline.samples, timeline.finishMs, text.length), text.length);
  assert.equal(progressAt(timeline.samples, timeline.samples[10].t - 1, text.length), 9);
  assert.equal(botTimeline("", 60, 1).finishMs, 0);
  assert.equal(clampBotWpm(5), 20);
  assert.equal(clampBotWpm(400), 140);
  assert.equal(botTimeline("hello", 5, 1).targetWpm, 20);
});

test("average pace stays within 10 percent of the target on a long passage", () => {
  const text = "a".repeat(420);
  const seeds = [1, 2, 3, 99, 1000, 2 ** 32 - 1];
  for (const target of [30, 55, 90, 140]) {
    for (const seed of seeds) {
      const timeline = botTimeline(text, target, seed);
      const pace = wpm(text.length, timeline.finishMs);
      const gap = Math.abs(pace - target) / target;
      assert.ok(gap <= 0.1, `target ${target} seed ${seed} finished at ${pace}`);
    }
  }
});

test("a mistake costs time and still reaches the end of the passage", () => {
  const text = "a".repeat(10);
  const rolls = (mistake) => {
    const values = [];
    for (let n = 0; n < text.length; n += 1) values.push(0.5, mistake ? 0 : 0.5, 0.5);
    return scripted(values);
  };
  const clean = botTimeline(text, 60, 1, rolls(false));
  const slow = botTimeline(text, 60, 1, rolls(true));
  assert.ok(slow.finishMs > clean.finishMs);
  assert.ok(slow.finishMs - clean.finishMs >= 1000);
  assert.equal(slow.samples.at(-1).i, text.length);
  assert.equal(clean.samples.at(-1).i, text.length);
  assert.ok(stepDelay(60, 0.5, 0, 0.5) > stepDelay(60, 0.5, 0.5, 0.5));
});
