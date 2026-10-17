import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

test("phone cursor keys stay at least 32px and lobby controls at least 44px", () => {
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(32px,\s*1fr\)\)/);
  assert.match(css, /\.btn \{ min-height: 44px; \}/);
  assert.match(css, /\.mode, \.length \{[^}]*min-height:\s*44px/);
  assert.match(css, /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(html, /id="you" class="panel panel-you"/);
  assert.match(html, /id="board" class="panel panel-board"/);
  assert.match(html, /id="recent" class="panel panel-recent"/);
  assert.match(css, /\.panel-you \{ min-height: 168px; \}/);
  assert.match(css, /\.panel-board \{ min-height: 220px; \}/);
  assert.match(css, /\.panel-recent \{ min-height: 140px; \}/);
  assert.equal(html.includes("style="), false);
});
