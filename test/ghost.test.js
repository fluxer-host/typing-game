import assert from "node:assert/strict";
import test from "node:test";
import {
  GHOST_KEY,
  compactTimeline,
  considerGhost,
  finishTrace,
  ghostHint,
  loadGhosts,
  noteSample,
  parseGhosts,
  saveGhosts,
  scaleGhost,
} from "../public/ghost.js";
import { wpm } from "../src/score.js";

function ghost(over = {}) {
  return {
    mode: "desktop",
    length: "sprint",
    wpm: 40,
    accuracy: 90,
    ms: 12_000,
    chars: 10,
    passageId: "p",
    samples: [{ t: 0, i: 0 }, { t: 12_000, i: 10 }],
    ...over,
  };
}

function memoryBox() {
  const memory = new Map();
  return {
    memory,
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => memory.set(key, value),
  };
}

test("timeline compaction keeps a steady gap and the finish point", () => {
  const points = [];
  for (let t = 0; t <= 1000; t += 50) points.push({ t, i: t / 50 });
  const compact = compactTimeline(points, 200);
  assert.equal(compact[0].t, 0);
  assert.equal(compact[0].i, 0);
  assert.equal(compact.at(-1).t, 1000);
  assert.equal(compact.at(-1).i, 20);
  assert.ok(compact.length < points.length);
  for (let n = 1; n < compact.length - 1; n += 1) {
    assert.ok(compact[n].t - compact[n - 1].t >= 200);
    assert.ok(compact[n].i >= compact[n - 1].i);
  }
  let samples = [];
  for (let t = 0; t <= 1000; t += 50) samples = noteSample(samples, t, t / 50, 200);
  samples = noteSample(samples, 40, 0, 200);
  const done = finishTrace(samples, 1000, 20, 200);
  assert.equal(done[0].i, 0);
  assert.equal(done.at(-1).i, 20);
  assert.ok(done.at(-1).t >= 1000);
  assert.equal(finishTrace([], 1500, 8).at(-1).i, 8);
});

test("the best run wins and a worse run leaves the store alone", () => {
  const first = considerGhost({}, ghost({ wpm: 50, accuracy: 90, ms: 8000 }));
  assert.equal(first.kept, true);
  assert.equal(first.bests["desktop|sprint"].wpm, 50);
  const slower = considerGhost(first.bests, ghost({ wpm: 40 }));
  assert.equal(slower.kept, false);
  assert.equal(slower.bests, first.bests);
  const sharper = considerGhost(first.bests, ghost({ wpm: 50, accuracy: 99, ms: 9000 }));
  assert.equal(sharper.kept, true);
  assert.equal(sharper.bests["desktop|sprint"].accuracy, 99);
  const quicker = considerGhost(sharper.bests, ghost({ wpm: 50, accuracy: 99, ms: 7000 }));
  assert.equal(quicker.kept, true);
  assert.equal(quicker.bests["desktop|sprint"].ms, 7000);
  const same = considerGhost(quicker.bests, ghost({ wpm: 50, accuracy: 99, ms: 7000 }));
  assert.equal(same.kept, false);
  const other = considerGhost(quicker.bests, ghost({ mode: "cursor", length: "long", wpm: 20, chars: 4, samples: [{ t: 0, i: 0 }, { t: 4000, i: 4 }] }));
  assert.equal(other.kept, true);
  assert.equal(Object.keys(other.bests).length, 2);
  assert.equal(considerGhost(other.bests, ghost({ samples: [{ t: 0, i: 0 }] })).kept, false);
});

test("missing, private, and corrupt ghost storage stays empty", () => {
  const throwing = {
    getItem() {
      throw new Error("private");
    },
    setItem() {
      throw new Error("quota");
    },
  };
  assert.deepEqual(loadGhosts(throwing), {});
  assert.equal(saveGhosts({ "desktop|sprint": ghost() }, throwing), false);
  assert.deepEqual(loadGhosts({}), {});
  assert.deepEqual(parseGhosts("{"), {});
  assert.deepEqual(parseGhosts(null), {});
  assert.deepEqual(parseGhosts(""), {});
  assert.deepEqual(parseGhosts(JSON.stringify({ v: 2, bests: {} })), {});
  assert.deepEqual(parseGhosts(JSON.stringify({ v: 1, bests: [] })), {});
  const mixed = parseGhosts(JSON.stringify({
    v: 1,
    bests: {
      "desktop|sprint": {
        mode: "desktop",
        length: "sprint",
        wpm: 40,
        accuracy: 99,
        ms: 10_000,
        chars: 20,
        passageId: "p",
        samples: [0, 0, 10_000, 20],
      },
      broken: { mode: "keyboard", length: "sprint", wpm: 10, accuracy: 10, ms: 10, chars: 1, samples: [0, 0] },
      "mobile|set": { mode: "mobile", length: "set", wpm: 10, accuracy: 10, ms: 10, chars: 5, samples: [1, 2, 3] },
    },
  }));
  assert.deepEqual(Object.keys(mixed), ["desktop|sprint"]);
  assert.equal(mixed["desktop|sprint"].samples.at(-1).i, 20);
  const box = memoryBox();
  assert.equal(saveGhosts(mixed, box), true);
  const saved = JSON.parse(box.memory.get(GHOST_KEY));
  assert.equal(saved.v, 1);
  assert.ok(saved.bests["desktop|sprint"].samples.every((value) => Number.isInteger(value)));
  assert.deepEqual(loadGhosts(box)["desktop|sprint"].samples, mixed["desktop|sprint"].samples);
  assert.equal(ghostHint("desktop", "sprint", null), "Finish a Sprint on Desktop to race your best.");
  assert.equal(ghostHint("mobile", "long", { wpm: 72.2 }), "Your best is 72 WPM.");
});

test("a ghost replay keeps pace when the passage length changes", () => {
  const samples = [{ t: 0, i: 0 }, { t: 200, i: 10 }, { t: 1000, i: 50 }];
  const same = scaleGhost(samples, 50, 50);
  assert.equal(same.at(-1).t, 1000);
  assert.equal(same.at(-1).i, 50);
  const scaled = scaleGhost(samples, 50, 100);
  assert.equal(scaled.at(-1).i, 100);
  assert.equal(scaled.at(-1).t, 2000);
  assert.equal(wpm(50, 1000), wpm(100, scaled.at(-1).t));
  let prev = scaled[0];
  for (const sample of scaled.slice(1)) {
    assert.ok(sample.t >= prev.t);
    assert.ok(sample.i >= prev.i);
    prev = sample;
  }
  const awkward = scaleGhost(samples, 50, 73);
  assert.equal(awkward.at(-1).i, 73);
  prev = awkward[0];
  for (const sample of awkward.slice(1)) {
    assert.ok(sample.t >= prev.t);
    assert.ok(sample.i >= prev.i);
    prev = sample;
  }
});
