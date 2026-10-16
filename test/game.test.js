import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { applyElo, eloDeltas } from "../src/elo.js";
import { MODE_COLUMNS } from "../src/modes.js";
import { buildResults } from "../src/results.js";
import { accuracy, wpm } from "../src/score.js";
import { readPayload, signPayload } from "../src/session.js";
import { LENGTHS, lengthList } from "../src/lengths.js";
import { summarizeRooms } from "../src/lobby.js";
import { CHARSET, CURSOR_KEYS, cursorCanType, isKnownSentence, passageOk, pickPassage, pickSentence, poolFor, SENTENCES } from "../src/sentences.js";

test("sentences stay on the shared keyboard", () => {
  assert.ok(SENTENCES.some((row) => row.text === "I love Fluxer" && row.cursor));
  assert.ok(poolFor("cursor").length >= 12);
  assert.ok(poolFor("desktop").length > poolFor("cursor").length);
  for (const row of SENTENCES) {
    assert.match(row.text, CHARSET);
    assert.equal(isKnownSentence(row.text), true);
    if (row.cursor) assert.equal(cursorCanType(row.text), true);
  }
  for (let i = 0; i < 30; i++) {
    assert.equal(isKnownSentence(pickSentence("cursor")), true);
    assert.equal(isKnownSentence(pickSentence("desktop")), true);
  }
});

test("a passage is one, three, or five known sentences", () => {
  assert.deepEqual(lengthList().map((row) => row.sentences), [1, 3, 5]);
  for (const [id, spec] of Object.entries(LENGTHS)) {
    for (const mode of ["desktop", "cursor"]) {
      const text = pickPassage(mode, spec.sentences);
      assert.equal(passageOk(mode, spec.sentences, text), true, `${mode} ${id}`);
      assert.equal(passageOk(mode, spec.sentences, `${text} extra`), false);
      if (mode === "cursor") assert.equal(cursorCanType(text), true);
    }
  }
  assert.equal(passageOk("cursor", 1, pickSentence("cursor")), true);
  assert.equal(passageOk("desktop", 1, "I love Fluxer"), true);
  assert.equal(passageOk("cursor", 1, "Fluxer started as a high school project."), false);
  const joined = ["I love Fluxer", "Flux means change.", "Chat is motion."].join(" ");
  assert.equal(passageOk("cursor", 3, joined), true);
  assert.equal(passageOk("cursor", 1, joined), false);
});

test("the open room list counts racers who are still waiting", () => {
  const rooms = summarizeRooms([
    { status: "room", room: "ABCD", host: true, mode: "desktop", length: "sprint", openedAt: 10, user: { id: "a", name: "Ada", tag: "Ada", elo: { desktop: 1000 } } },
    { status: "room", room: "WXYZ", host: true, mode: "cursor", length: "long", openedAt: 20, user: { id: "c", name: "Cam", tag: "Cam" } },
    { status: "room", room: "WXYZ", host: false, mode: "cursor", length: "long", openedAt: 20, user: { id: "d", name: "Dee", tag: "Dee" } },
    { status: "matched", room: "WXYZ", host: false, mode: "cursor", length: "long", openedAt: 20, user: { id: "e", name: "Eve" } },
    { status: "queue", room: null, mode: "desktop", length: "sprint", user: { id: "b", name: "Bea" } },
  ]);
  assert.equal(rooms.map((room) => room.code).join(","), "WXYZ,ABCD");
  assert.equal(rooms[0].players.length, 2);
  assert.equal(rooms[0].mode, "cursor");
  assert.equal(rooms[0].length, "long");
  assert.equal(rooms[0].players.find((player) => player.host).name, "Cam");
  assert.equal(rooms[1].players[0].name, "Ada");
  assert.equal(Object.hasOwn(rooms[0].players[0], "elo"), false);
});

test("the cursor keyboard in the page covers every cursor key", () => {
  const src = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  for (const ch of CURSOR_KEYS) {
    if (ch === " ") assert.match(src, /keyButton\(" ", "space"/);
    else assert.ok(src.includes(JSON.stringify(ch)), ch);
  }
  assert.match(src, /keyButton\("shift"/);
  assert.match(src, /keyButton\("back"/);
});

test("mode columns are plain sqlite identifiers", () => {
  for (const cols of Object.values(MODE_COLUMNS)) {
    for (const name of Object.values(cols)) assert.match(name, /^[a-z_]+$/);
  }
});

test("elo is 16 points for an even duel and averaged across a field", () => {
  const duel = eloDeltas([
    { id: "a", elo: 1000, place: 1 },
    { id: "b", elo: 1000, place: 2 },
  ]);
  assert.deepEqual(duel, { a: 16, b: -16 });
  const field = eloDeltas([
    { id: "a", elo: 1000, place: 1 },
    { id: "b", elo: 1000, place: 2 },
    { id: "c", elo: 1000, place: 3 },
  ]);
  assert.deepEqual(field, { a: 16, b: 0, c: -16 });
  assert.equal(applyElo(100, -40), 100);
});

test("wpm uses five characters per word", () => {
  assert.equal(wpm(0, 5000), 0);
  assert.equal(wpm(13, 5000), 31.2);
  assert.equal(accuracy(8, 2), 80);
  assert.equal(accuracy(0, 0), 100);
});

test("finish order and elo come from the server clock", () => {
  const sentence = "I love Fluxer";
  const start = 1_000_000;
  const results = buildResults(
    {
      ranked: true,
      mode: "desktop",
      sentence,
      startAt: start,
      players: [
        { id: "a", name: "Ada", tag: "ada", eloAtStart: 1000 },
        { id: "b", name: "Bea", tag: "bea", eloAtStart: 1000 },
      ],
      finishes: {
        b: { at: start + 5000, ok: sentence.length, err: 0 },
        a: { at: start + 8000, ok: sentence.length, err: 1 },
      },
      progress: {},
    },
    start + 8000,
  );
  assert.equal(results.rows[0].id, "b");
  assert.equal(results.rows[0].place, 1);
  assert.equal(results.rows[0].ms, 5000);
  assert.equal(results.rows[0].wpm, 31.2);
  assert.equal(results.rows[0].eloAfter, 1016);
  assert.equal(results.rows[1].eloAfter, 984);
  assert.equal(results.rows[1].accuracy, 92.9);
});

test("a solo practice race does not write elo", () => {
  const results = buildResults(
    {
      ranked: false,
      mode: "cursor",
      sentence: "I love Fluxer",
      startAt: 0,
      players: [{ id: "a", name: "Ada", tag: "ada", eloAtStart: 1000 }],
      finishes: { a: { at: 4000, ok: 13, err: 0 } },
      progress: {},
    },
    4000,
  );
  assert.equal(results.rows[0].eloAfter, null);
  assert.equal(results.rows[0].finished, true);
});

function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, name);
  let depth = 0;
  let seen = false;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "{") {
      depth += 1;
      seen = true;
    } else if (src[i] === "}") {
      depth -= 1;
      if (seen && depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unclosed ${name}`);
}

function loadStyleHelpers() {
  const src = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const names = ["cssColor", "safeHex", "lanePercent", "applyLaneWidth", "applyAvatarColor"];
  const body = names.map((name) => extractFunction(src, name)).join("\n");
  return new Function(`${body}\nreturn { cssColor, safeHex, lanePercent, applyLaneWidth, applyAvatarColor };`)();
}

test("lane width and avatar colour stay inside the CSSOM", () => {
  const { cssColor, safeHex, lanePercent, applyLaneWidth, applyAvatarColor } = loadStyleHelpers();
  assert.equal(lanePercent(0, 40), 0);
  assert.equal(lanePercent(1, 3), 33);
  assert.equal(lanePercent(2, 3), 67);
  assert.equal(lanePercent(4, 3), 100);
  assert.equal(lanePercent(-4, 10), 0);
  assert.equal(lanePercent(5, 0), 0);
  assert.equal(lanePercent(Number.NaN, 8), 0);
  assert.equal(lanePercent(1, Number.POSITIVE_INFINITY), 0);
  assert.equal(cssColor(0xff0000), "#ff0000");
  assert.equal(cssColor(0x000000), "#4641d9");
  assert.equal(cssColor("nope"), "#4641d9");
  assert.equal(safeHex("#3dd68c"), "#3dd68c");
  assert.equal(safeHex("#fff"), null);
  assert.equal(safeHex("#3dd68c;width:100%"), null);
  assert.equal(safeHex("red"), null);
  assert.equal(safeHex("rgb(61, 214, 140)"), null);

  const fill = { style: {}, attrs: {}, setAttribute(name, value) { this.attrs[name] = value; } };
  applyLaneWidth(fill, 1, 2);
  assert.equal(fill.style.width, "50%");
  applyLaneWidth(fill, 9, 2);
  assert.equal(fill.style.width, "100%");
  assert.equal(fill.attrs.style, undefined);

  const chip = { style: {} };
  applyAvatarColor(chip, 0x3dd68c);
  assert.equal(chip.style.backgroundColor, "#3dd68c");
  const fallback = { style: {} };
  applyAvatarColor(fallback, null);
  assert.equal(fallback.style.backgroundColor, "#4641d9");
});

test("the front end does not use CSP-blocked inline styles", () => {
  const root = new URL("../public/", import.meta.url);
  const blocked = [
    /setAttribute\s*\(\s*['"]style['"]/i,
    /style\s*=\s*["'`]/,
    /\.cssText\s*=/,
    /<style\b/i,
    /(?:^|[{,])\s*style\s*:/m,
  ];
  const files = readdirSync(root).filter((name) => /\.(js|html|svg)$/.test(name));
  assert.ok(files.includes("app.js"));
  for (const name of files) {
    const src = readFileSync(new URL(name, root), "utf8");
    for (const pattern of blocked) {
      assert.equal(pattern.test(src), false, `${name} matches ${pattern}`);
    }
  }
});

test("session tokens are signed and expire", async () => {
  const secret = "local-dev-secret-change-me-please-32";
  const token = await signPayload({ sid: "abc", exp: Date.now() + 60_000 }, secret);
  const payload = await readPayload(token, secret);
  assert.equal(payload.sid, "abc");
  assert.equal(await readPayload(`${token}x`, secret), null);
  const stale = await signPayload({ sid: "abc", exp: Date.now() - 1000 }, secret);
  assert.equal(await readPayload(stale, secret), null);
  assert.equal(await readPayload(token, "a-different-secret-value"), null);
});
