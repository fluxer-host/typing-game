import assert from "node:assert/strict";
import test from "node:test";
import {
  findPassageIssues,
  PASSAGES,
  pickPassage,
  pickPassageRecord,
  rememberIds,
  selectPassage,
  unionAvoid,
} from "../src/sentences.js";

test("the shipped pool has unique ids, clean text, and legal characters", () => {
  assert.deepEqual(findPassageIssues(PASSAGES), []);
});

test("a bad pool reports ids, spaces, characters, and bounds", () => {
  const bad = [
    { id: "a", text: " hello", ladders: ["desktop", "mobile"], length: "sprint", difficulty: "easy", chars: 6 },
    { id: "a", text: "Hello there.", ladders: ["desktop", "mobile"], length: "sprint", difficulty: "easy", chars: 12 },
    { id: "b", text: "Hello there.", ladders: ["desktop", "mobile"], length: "sprint", difficulty: "easy", chars: 12 },
    { id: "c", text: "Hello!", ladders: ["cursor"], length: "sprint", difficulty: "easy", chars: 6 },
    { id: "d", text: "x", ladders: ["desktop", "mobile"], length: "sprint", difficulty: "easy", chars: 1 },
    { id: "e", text: "  spaced  ", ladders: ["desktop"], length: "set", difficulty: "easy", chars: 10 },
  ];
  const errors = findPassageIssues(bad, { requireCounts: false });
  assert.ok(errors.some((line) => line.startsWith("duplicate id")));
  assert.ok(errors.some((line) => line.startsWith("trimmed")));
  assert.ok(errors.some((line) => line.startsWith("duplicate text")));
  assert.ok(errors.some((line) => line.startsWith("cursor keys")));
  assert.ok(errors.some((line) => line.startsWith("bounds")));
  assert.ok(errors.some((line) => line.startsWith("ladders")));
});

test("selection is uniform inside the pool and falls back when every id is avoided", () => {
  const pool = [
    { id: "one", text: "one" },
    { id: "two", text: "two" },
    { id: "three", text: "three" },
  ];
  assert.equal(selectPassage(pool, [], () => 0).id, "one");
  assert.equal(selectPassage(pool, [], () => 0.999).id, "three");
  assert.equal(selectPassage(pool, ["one", "three"], () => 0).id, "two");
  assert.equal(selectPassage(pool, ["one", "two", "three"], () => 0).id, "one");
  assert.equal(selectPassage([], [], () => 0), null);
});

test("a caller can ask for one difficulty, and an unknown count picks nothing", () => {
  const easy = pickPassageRecord("desktop", 1, { difficulty: "easy", random: () => 0 });
  assert.equal(easy.difficulty, "easy");
  assert.equal(easy.length, "sprint");
  assert.equal(pickPassage("cursor", 2, { random: () => 0 }), "");
  assert.equal(pickPassageRecord("desktop", 4), null);
});

test("recent passage ids stay capped and a room shares the avoided list", () => {
  let ids = [];
  for (let n = 1; n <= 10; n += 1) ids = rememberIds(ids, `p${n}`);
  assert.deepEqual(ids, ["p3", "p4", "p5", "p6", "p7", "p8", "p9", "p10"]);
  ids = rememberIds(ids, "p8");
  assert.equal(ids.at(-1), "p8");
  assert.equal(ids.filter((id) => id === "p8").length, 1);
  assert.equal(ids.length, 8);
  assert.deepEqual(unionAvoid([["a", "b"], ["b", "c"], []]), ["a", "b", "c"]);
  assert.deepEqual(unionAvoid(null), []);
});
