import assert from "node:assert/strict";
import test from "node:test";
import { CURSOR_PUNCTUATION_NOTE, punctuationAllowed } from "../src/formats.js";
import { CURSOR_KEYS } from "../src/sentences.js";
import {
  PUNCTUATION_PASSAGES,
  findPunctuationIssues,
  pickPunctuationRecord,
  punctuationOk,
} from "../src/punctuation.js";

test("the punctuation pool is original, unique, and typable on desktop and mobile", () => {
  const issues = findPunctuationIssues();
  assert.deepEqual(issues, []);
  assert.ok(PUNCTUATION_PASSAGES.length >= 60);
  const ids = new Set(PUNCTUATION_PASSAGES.map((row) => row.id));
  assert.equal(ids.size, PUNCTUATION_PASSAGES.length);
  for (const row of PUNCTUATION_PASSAGES) {
    assert.equal(row.text, row.text.trim());
    assert.equal(row.text.startsWith(" "), false);
    assert.equal(row.text.endsWith(" "), false);
    assert.deepEqual(row.ladders, ["desktop", "mobile"]);
  }
});

test("punctuation is unavailable on cursor because the keys omit required marks", () => {
  assert.equal(punctuationAllowed("cursor"), false);
  assert.equal(punctuationAllowed("desktop"), true);
  assert.equal(punctuationAllowed("mobile"), true);
  assert.equal(pickPunctuationRecord("cursor", 1), null);
  assert.equal(punctuationOk("cursor", 1, PUNCTUATION_PASSAGES[0].text), false);
  assert.equal(punctuationOk("desktop", 1, PUNCTUATION_PASSAGES[0].text), true);
  const sample = pickPunctuationRecord("mobile", 3, { random: () => 0 });
  assert.equal(sample.length, "set");
  for (const mark of ["\"", "(", ")", ":", ";"]) {
    assert.equal(CURSOR_KEYS.includes(mark), false, mark);
  }
  assert.match(CURSOR_PUNCTUATION_NOTE, /Cursor/);
});
