import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { compositeHex, contrastRatio, relativeLuminance } from "../public/contrast.js";
import { characterClass, characterText, missLabel, pageTitle, typedMiss } from "../public/passage.js";

const css = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const ladders = readFileSync(new URL("../public/ladder-picker.js", import.meta.url), "utf8");

function cssVars(source) {
  const block = source.match(/:root\s*\{([\s\S]*?)\}/);
  assert.ok(block, "stylesheet defines :root variables");
  const vars = {};
  for (const match of block[1].matchAll(/--([a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    vars[match[1]] = match[2].toLowerCase();
  }
  return vars;
}

function assertContrast(foreground, background, minimum, label) {
  const ratio = contrastRatio(foreground, background);
  assert.ok(ratio >= minimum, `${label}: ${foreground} on ${background} is ${ratio?.toFixed(2)}, need ${minimum}`);
}

test("contrast ratio follows the WCAG luminance formula", () => {
  assert.equal(contrastRatio("#000000", "#ffffff"), 21);
  assert.equal(contrastRatio("#ffffff", "#000000"), 21);
  assert.equal(contrastRatio("#ffffff", "#ffffff"), 1);
  assert.equal(contrastRatio("#000", "#fff"), 21);
  assert.equal(contrastRatio("nope", "#ffffff"), null);
  assert.equal(relativeLuminance("#000000"), 0);
  assert.ok(Math.abs(relativeLuminance("#ffffff") - 1) < 1e-12);
  const oldDim = contrastRatio("#626274", "#16161d");
  assert.ok(oldDim < 4.5 && oldDim > 2.9);
  assert.equal(compositeHex("#ff5d73", "#16161d", 0.12), "#321f27");
  assert.equal(compositeHex("#fff", "#000", 2), null);
});

test("a wrong key keeps the expected character and marks that one cell", () => {
  const sentence = "The";
  assert.equal(characterText(sentence, "z", 0), "T");
  assert.equal(characterClass(sentence, "z", 0), "ch bad cur");
  assert.equal(typedMiss(sentence, "z", 0), "z");
  assert.equal(missLabel("z"), "z");
  assert.equal(characterText(sentence, "z", 1), "h");
  assert.equal(characterClass(sentence, "z", 1), "ch");
  assert.equal(typedMiss(sentence, "z", 1), "");
  assert.equal(characterText(sentence, "z", 2), "e");
  assert.notEqual(characterText(sentence, "z", 0), "z");
});

test("correct characters, the caret, and a space miss stay distinct", () => {
  assert.equal(characterClass("The", "Th", 0), "ch ok");
  assert.equal(characterClass("The", "Th", 1), "ch ok");
  assert.equal(characterClass("The", "Th", 2), "ch cur");
  assert.equal(characterText("The", "Th", 2), "e");
  assert.equal(characterClass("The", "", 0), "ch cur");
  assert.equal(characterClass("The", "The", 2), "ch ok");
  assert.equal(characterClass("The", "The", 3), "ch");
  assert.equal(characterText("A B", "A", 1), " ");
  assert.equal(typedMiss("A B", "Ax", 1), "x");
  assert.equal(typedMiss("AB", "A ", 1), " ");
  assert.equal(missLabel(" "), "space");
  assert.equal(missLabel("\n"), "new line");
  assert.equal(characterClass("", "a", 0), "ch");
  assert.equal(characterText(null, "a", 0), "");
  assert.equal(characterClass("The", "T", -1), "ch");
  assert.equal(characterClass("The", "T", 1.5), "ch");
});

test("the page title follows the race phase and not the hostname", () => {
  assert.equal(pageTitle("countdown"), "Typing race, countdown");
  assert.equal(pageTitle("race"), "Typing race, racing");
  assert.equal(pageTitle("finishing"), "Typing race, racing");
  assert.equal(pageTitle("results"), "Typing race, results");
  assert.equal(pageTitle("stats"), "Typing race, stats");
  assert.equal(pageTitle("lobby"), "Typing race");
  assert.equal(pageTitle(""), "Typing race");
  assert.equal(app.includes("document.title = host"), false);
  assert.match(app, /pageTitle\(state\.phase\)/);
});

test("every text colour in the palette clears WCAG AA", () => {
  const vars = cssVars(css);
  const textPairs = [
    ["text", "bg", 4.5, "body text on page"],
    ["text", "bg-2", 4.5, "correct passage and body text on a card"],
    ["text", "bg-3", 4.5, "button label on a raised control"],
    ["text", "flux", 4.5, "letter avatar on brand purple"],
    ["on-flux", "flux", 4.5, "primary button and Shift on"],
    ["muted", "bg", 4.5, "secondary text on the page"],
    ["muted", "bg-2", 4.5, "sidebar and hint text on a card"],
    ["muted", "bg-3", 4.5, "mode blurb on a mode card"],
    ["dim", "bg-2", 4.5, "untyped passage and empty sidebar text"],
    ["bad", "bg-2", 4.5, "wrong character"],
    ["good", "bg-2", 4.5, "gain and locked-in text"],
    ["good", "bg-3", 4.5, "gain text on a raised card"],
    ["warn", "bg-2", 4.5, "warning text"],
    ["flux-2", "bg", 4.5, "brand accent on the page"],
    ["flux-2", "bg-2", 4.5, "current character and live pace"],
    ["flux-2", "bg-3", 4.5, "mode rating on a mode card"],
  ];
  for (const [fg, bg, minimum, label] of textPairs) {
    assert.ok(vars[fg], `missing --${fg}`);
    assert.ok(vars[bg], `missing --${bg}`);
    assertContrast(vars[fg], vars[bg], minimum, label);
  }

  const wash = compositeHex(vars.bad, vars["bg-2"], 0.12);
  assertContrast(vars.bad, wash, 4.5, "wrong character on its tint");
  const mine = compositeHex(vars.flux, vars["bg-2"], 0.16);
  assertContrast(vars.text, mine, 4.5, "your result row");
  assertContrast(vars.bad, mine, 4.5, "rating loss on your row");
  assertContrast(vars.good, mine, 4.5, "rating gain on your row");
  assertContrast(vars.muted, mine, 4.5, "muted text on your row");

  const peak = compositeHex(vars.flux, vars.bg, 0.38);
  const card = compositeHex(vars["bg-2"], peak, 0.92);
  assertContrast(vars.dim, card, 4.5, "untyped text over the header glow");
  assertContrast(vars.text, card, 4.5, "body text over the header glow");
  assertContrast(vars["flux-2"], peak, 4.5, "brand accent over the header glow");

  const toast = css.match(/\.toast\s*\{[^}]*background:\s*(#[0-9a-fA-F]{6})/);
  assert.ok(toast, "toast background is a hex colour");
  assertContrast(vars.text, toast[1], 4.5, "toast text");

  const states = [vars.dim, vars.text, vars.bad, vars["flux-2"]];
  assert.equal(new Set(states).size, states.length);
  assert.match(css, /\.ch\.ok\s*\{[^}]*text-decoration-line:\s*underline/);
  assert.match(css, /\.ch\.bad\s*\{[^}]*text-decoration-style:\s*wavy/);
  assert.match(css, /\.ch\.cur\s*\{[^}]*box-shadow:\s*-2px 0 0 var\(--flux-2\)/);
  assert.match(css, /\.btn\.primary\s*\{[^}]*color:\s*var\(--on-flux\)/);
});

test("ui boundaries and focus marks clear the 3 to 1 bar", () => {
  const vars = cssVars(css);
  const uiPairs = [
    ["line", "bg", 3, "border on the page"],
    ["line", "bg-2", 3, "border on a card"],
    ["line", "bg-3", 3, "border on a button"],
    ["flux-edge", "bg-2", 3, "selected ladder border on a card"],
    ["flux-edge", "bg-3", 3, "selected ladder border on the control"],
    ["flux-2", "bg-2", 3, "focus ring and caret"],
    ["flux-2", "bg-3", 3, "focus ring on a button"],
    ["track", "bg-2", 3, "empty progress track"],
    ["fill", "track", 3, "progress fill on the track"],
    ["on-flux", "flux", 3, "Shift bar on the purple key"],
  ];
  for (const [fg, bg, minimum, label] of uiPairs) {
    assertContrast(vars[fg], vars[bg], minimum, label);
  }
});

test("the page exposes one polite live region, a heading, and named controls", () => {
  assert.match(html, /<title>Typing race<\/title>/);
  assert.match(html, /<h1 class="visually-hidden">Typing race<\/h1>/);
  assert.match(html, /id="live"[^>]*aria-live="polite"/);
  assert.equal(html.includes("role=\"alert\""), false);
  assert.match(css, /\.visually-hidden\s*\{/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /animation-duration:\s*0\.01ms/);
  assert.match(css, /\.passage-wrap:focus-within/);
  assert.match(css, /button:focus-visible/);
  assert.match(app, /aria-describedby": "race-hint"/);
  assert.match(ladders, /aria-labelledby": "ladder-label"/);
  assert.match(ladders, /aria-labelledby": "length-label"/);
  assert.match(app, /aria-pressed/);
  assert.match(app, /scope: "col"/);
  assert.match(app, /caption/);
  assert.match(app, /role: "alert"/);
  assert.match(app, /role: "region"/);
  assert.match(app, /"aria-label": "Connection"/);
  assert.match(app, /id: "live"|getElementById\("live"\)/);
  assert.equal(app.includes("state.typed[good]"), false);
  assert.match(app, /characterText\(sentence, typed, i\)/);
  assert.equal((html.match(/aria-live="polite"/g) || []).length, 1);
});
