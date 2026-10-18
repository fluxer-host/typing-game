import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { applyElo, eloDelta, eloDeltas, expectedScore, PAIR_RATED_LIMIT, PAIR_WINDOW_MS, pairFactor, pairKey } from "../src/elo.js";
import { MODE_COLUMNS } from "../src/modes.js";
import { applyRaceEvent, IDLE_MS, nextAlarmAt, RECONNECT_GRACE_MS, resultsHeadline } from "../src/race-end.js";
import { buildResults, countsAsWin } from "../src/results.js";
import { accuracy, wpm } from "../src/score.js";
import { readPayload, signPayload } from "../src/session.js";
import { LENGTHS, lengthList } from "../src/lengths.js";
import { validateProgress } from "../src/progress.js";
import { rankedFor, summarizeRooms } from "../src/lobby.js";
import {
  MATCH_WINDOW_CAP,
  MATCH_WINDOW_INTERVAL_MS,
  MATCH_WINDOW_START,
  MATCH_WINDOW_STEP,
  matchWindow,
  nextMatchAt,
  nextQueuedAt,
  pickGroup,
  pickOpponent,
  waitForWindow,
} from "../src/match.js";
import { commitRating, pairCountsFromRows, planRating, standingLabel } from "../src/rating.js";
import { saveStatements } from "../src/db.js";
import { CHARSET, CURSOR_KEYS, cursorCanType, findPassageIssues, isKnownSentence, normalizeCursorText, PASSAGES, passageOk, pickPassage, pickSentence, poolFor } from "../src/sentences.js";
import {
  applyTyping,
  consumeInput,
  correctLength,
  emptyInputSession,
  settleInput,
  textUnits,
} from "../public/input.js";
import {
  RETRY_BASE_MS,
  RETRY_CAP_MS,
  RETRY_LIMIT,
  RACE_RECONNECT_BASE_MS,
  RACE_RECONNECT_GRACE_MS,
  backoffDelay,
  classifyMe,
  lobbyDrop,
  nextRaceRetry,
  headerSignIn,
  sessionShell,
  shouldAutoRetry,
} from "../public/net.js";

test("passages stay inside each ladder's character set", () => {
  assert.deepEqual(findPassageIssues(PASSAGES), []);
  assert.ok(poolFor("cursor").length >= 150);
  assert.ok(poolFor("desktop").length >= 300);
  assert.ok(poolFor("desktop").length > poolFor("cursor").length);
  const desktopIds = poolFor("desktop").map((row) => row.id).sort();
  assert.deepEqual(poolFor("mobile").map((row) => row.id).sort(), desktopIds);
  for (let i = 0; i < 20; i++) {
    assert.equal(isKnownSentence(pickSentence("cursor")), true);
    assert.equal(isKnownSentence(pickSentence("desktop")), true);
  }
});

test("a passage is one known text for the sprint, set, or long tier", () => {
  assert.deepEqual(lengthList().map((row) => row.sentences), [1, 3, 5]);
  for (const [id, spec] of Object.entries(LENGTHS)) {
    for (const mode of ["desktop", "mobile", "cursor"]) {
      const text = pickPassage(mode, spec.sentences);
      assert.equal(passageOk(mode, spec.sentences, text), true, `${mode} ${id}`);
      assert.equal(passageOk(mode, spec.sentences, `${text} extra`), false);
      if (mode === "cursor") assert.equal(cursorCanType(text), true);
    }
  }
  assert.equal(pickPassage("desktop", 2), "");
  assert.equal(passageOk("desktop", 1, "I love Fluxer"), false);
  assert.equal(passageOk("cursor", 1, "Fluxer started as a high school project."), false);
  const sprint = pickPassage("desktop", 1);
  assert.equal(passageOk("desktop", 5, sprint), false);
  assert.equal(passageOk("cursor", 1, pickSentence("cursor")), true);
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

test("every character in a ladder pool is typable on that ladder", () => {
  for (const mode of ["desktop", "mobile", "cursor"]) {
    const seen = new Set();
    for (const row of poolFor(mode)) {
      assert.equal(typeof row.text, "string");
      for (const ch of row.text) seen.add(ch);
      if (mode === "cursor") assert.equal(cursorCanType(row.text), true, row.text);
      else assert.match(row.text, CHARSET, row.text);
    }
    for (const ch of seen) {
      if (mode === "cursor") {
        const key = ch >= "A" && ch <= "Z" ? ch.toLowerCase() : ch;
        assert.equal(CURSOR_KEYS.includes(key), true, `${mode} pool uses ${JSON.stringify(ch)}`);
      } else {
        assert.match(ch, CHARSET, `${mode} pool uses ${JSON.stringify(ch)}`);
      }
    }
    assert.ok(seen.has(" "), `${mode} pool includes a space`);
  }
  assert.equal(normalizeCursorText("\u201CHi\u201D \u2014 it\u2019s\u00A0ok"), '"Hi" - it\'s ok');
  assert.equal(cursorCanType("it\u2019s fine\u2014really"), true);
  assert.equal(cursorCanType("\u2014"), true);
  assert.equal(cursorCanType("!"), false);
  assert.equal(cursorCanType(";"), false);
  assert.equal(cursorCanType(":"), false);
  assert.equal(cursorCanType('"'), false);
  assert.equal(cursorCanType("("), false);
  assert.equal(cursorCanType(")"), false);
  assert.equal(cursorCanType("é"), false);
  assert.equal(cursorCanType("\u201C"), false);
  const served = pickPassage("cursor", 5);
  assert.equal(cursorCanType(served), true);
  assert.equal(passageOk("cursor", 5, served), true);
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

test("verified typing accepts one character at a time and counts mistakes", () => {
  const passage = "I love Fluxer";
  let previous = "";
  let prior = 0;
  for (let i = 1; i <= passage.length; i++) {
    const verdict = validateProgress({
      passage,
      previous,
      next: passage.slice(0, i),
      elapsedMs: (i - 1) * 50,
      recentStrokes: 0,
      priorStrokes: prior,
      kind: i === passage.length ? "fin" : "prog",
    });
    assert.equal(verdict.ok, true, verdict.reason);
    assert.equal(verdict.index, i);
    assert.equal(verdict.okDelta, 1);
    assert.equal(verdict.errDelta, 0);
    assert.equal(verdict.finished, i === passage.length);
    previous = verdict.text;
    prior += 1;
  }

  const wrong = validateProgress({
    passage: "ab",
    previous: "a",
    next: "ax",
    elapsedMs: 80,
    recentStrokes: 1,
    priorStrokes: 1,
    kind: "prog",
  });
  assert.equal(wrong.ok, true);
  assert.equal(wrong.index, 1);
  assert.equal(wrong.errDelta, 1);
  assert.equal(wrong.finished, false);
  const back = validateProgress({
    passage: "ab",
    previous: "ax",
    next: "a",
    elapsedMs: 160,
    recentStrokes: 2,
    priorStrokes: 2,
    kind: "prog",
  });
  assert.equal(back.ok, true);
  assert.equal(back.index, 1);
  assert.equal(back.okDelta, 0);
  assert.equal(back.errDelta, 0);
});

test("an instant finish, a jump, and an overshoot are disqualified", () => {
  const passage = "I love Fluxer";
  const instant = validateProgress({
    passage,
    previous: "",
    next: passage,
    elapsedMs: 0,
    recentStrokes: 0,
    priorStrokes: 0,
    kind: "fin",
  });
  assert.equal(instant.ok, false);
  assert.equal(instant.reason, "jump");
  assert.equal(instant.disqualify, true);

  const swapped = validateProgress({
    passage,
    previous: "I love",
    next: "Fluxer",
    elapsedMs: 5000,
    recentStrokes: 0,
    priorStrokes: 6,
    kind: "prog",
  });
  assert.equal(swapped.reason, "jump");
  assert.equal(swapped.disqualify, true);

  const overshoot = validateProgress({
    passage,
    previous: "I",
    next: `${passage}!`,
    elapsedMs: 5000,
    recentStrokes: 0,
    priorStrokes: 1,
    kind: "fin",
  });
  assert.equal(overshoot.reason, "overshoot");
  assert.equal(overshoot.disqualify, true);
});

test("impossible speed is disqualified and a single correction is kept", () => {
  const burst = validateProgress({
    passage: "I love Fluxer",
    previous: "I",
    next: "I ",
    elapsedMs: 0,
    recentStrokes: 1,
    priorStrokes: 1,
    kind: "prog",
  });
  assert.equal(burst.ok, false);
  assert.equal(burst.reason, "rate");
  assert.equal(burst.disqualify, true);

  const flooded = validateProgress({
    passage: "I love Fluxer",
    previous: "I love",
    next: "I love ",
    elapsedMs: 10_000,
    recentStrokes: 25,
    priorStrokes: 6,
    kind: "prog",
  });
  assert.equal(flooded.reason, "rate");
  assert.equal(flooded.disqualify, true);

  const stepBack = validateProgress({
    passage: "I love Fluxer",
    previous: "I love",
    next: "I lov",
    elapsedMs: 400,
    recentStrokes: 0,
    priorStrokes: 6,
    kind: "prog",
  });
  assert.equal(stepBack.ok, true);
  assert.equal(stepBack.index, 5);

  const rewind = validateProgress({
    passage: "I love Fluxer",
    previous: "I love",
    next: "I",
    elapsedMs: 400,
    recentStrokes: 0,
    priorStrokes: 6,
    kind: "prog",
  });
  assert.equal(rewind.ok, false);
  assert.equal(rewind.reason, "backwards");
  assert.equal(rewind.disqualify, true);
});

test("early and malformed progress is ignored", () => {
  const early = validateProgress({
    passage: "I love Fluxer",
    previous: "",
    next: "I",
    elapsedMs: -1,
    recentStrokes: 0,
    priorStrokes: 0,
    kind: "prog",
  });
  assert.equal(early.ok, false);
  assert.equal(early.reason, "early");
  assert.equal(early.disqualify, false);

  const earlyDump = validateProgress({
    passage: "I love Fluxer",
    previous: "",
    next: "I love Fluxer",
    elapsedMs: -30,
    recentStrokes: 0,
    priorStrokes: 0,
    kind: "fin",
  });
  assert.equal(earlyDump.reason, "early");
  assert.equal(earlyDump.disqualify, false);

  for (const input of [
    { passage: "ab", previous: "", next: null, elapsedMs: 10, kind: "prog" },
    { passage: "ab", previous: "", next: 2, elapsedMs: 10, kind: "prog" },
    { passage: "ab", previous: "", next: "a", elapsedMs: 10, kind: "finish" },
    { passage: "ab", previous: "", next: "a", elapsedMs: Number.NaN, kind: "prog" },
    { passage: null, previous: "", next: "a", elapsedMs: 10, kind: "prog" },
  ]) {
    const verdict = validateProgress({ recentStrokes: 0, priorStrokes: 0, ...input });
    assert.equal(verdict.ok, false, JSON.stringify(input));
    assert.equal(verdict.reason, "malformed");
    assert.equal(verdict.disqualify, false);
  }
});

test("a disqualified player does not take the win or the elo change", () => {
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
        a: { at: start + 8000, ok: sentence.length, err: 0 },
      },
      progress: {
        b: { i: 0, ok: 0, err: 0, text: "", dq: true },
      },
    },
    start + 8000,
  );
  const ada = results.rows.find((row) => row.id === "a");
  const bea = results.rows.find((row) => row.id === "b");
  assert.equal(ada.place, 1);
  assert.equal(ada.finished, true);
  assert.equal(ada.ms, 8000);
  assert.equal(ada.wpm, wpm(sentence.length, 8000));
  assert.equal(ada.eloAfter, 1016);
  assert.equal(bea.finished, false);
  assert.equal(bea.ms, null);
  assert.equal(bea.eloAfter, 1000);
  assert.notEqual(bea.place, 1);
});

function racer(id, extra = {}) {
  return {
    id,
    finished: false,
    forfeit: false,
    dnf: false,
    dnfReason: null,
    forfeitWin: false,
    lastActivity: null,
    connected: true,
    disconnectedAt: null,
    ...extra,
  };
}

function race(players, extra = {}) {
  return { startAt: 1_000_000, limitMs: 120000, ranked: true, players, ...extra };
}

function resultState(players, ranked = true) {
  const presence = {};
  for (const player of players) {
    presence[player.id] = {
      forfeit: player.forfeit,
      forfeitWin: player.forfeitWin,
      dnf: player.dnf,
      dnfReason: player.dnfReason,
    };
  }
  return {
    ranked,
    mode: "desktop",
    sentence: "I love Fluxer",
    startAt: 1_000_000,
    players: players.map((player) => ({
      id: player.id,
      name: player.id === "a" ? "Ada" : "Bea",
      tag: player.id,
      eloAtStart: 1000,
    })),
    finishes: {},
    progress: {},
    presence,
  };
}

test("a ranked forfeit is a loss and the opponent wins immediately", () => {
  const start = race([racer("a"), racer("b")]);
  const left = applyRaceEvent(start, { type: "forfeit", playerId: "a" }, start.startAt + 1000);
  assert.equal(left.ok, true);
  assert.equal(left.end, "results");
  assert.equal(left.players.find((player) => player.id === "a").forfeit, true);
  assert.equal(left.players.find((player) => player.id === "b").forfeitWin, true);
  const results = buildResults(resultState(left.players, true), start.startAt + 1000);
  const winner = results.rows.find((row) => row.id === "b");
  const leaver = results.rows.find((row) => row.id === "a");
  assert.equal(winner.place, 1);
  assert.equal(winner.outcome, "forfeit-win");
  assert.equal(winner.ms, null);
  assert.equal(winner.eloAfter, 1016);
  assert.equal(countsAsWin(winner), true);
  assert.equal(leaver.place, 2);
  assert.equal(leaver.outcome, "forfeit");
  assert.equal(leaver.ms, null);
  assert.equal(leaver.eloAfter, 984);
  assert.equal(countsAsWin(leaver), false);
  assert.equal(resultsHeadline(results.rows, "b", false).title, "Opponent forfeited, you win");
  assert.equal(resultsHeadline(results.rows, "a", false).title, "You forfeited");
});

test("practice forfeits do not change elo", () => {
  const solo = applyRaceEvent(race([racer("a")], { ranked: false }), { type: "forfeit", playerId: "a" }, 1_000_000);
  assert.equal(solo.end, "cancel");
  assert.equal(solo.players[0].forfeitWin, false);

  const duel = applyRaceEvent(race([racer("a"), racer("b")], { ranked: false }), { type: "forfeit", playerId: "a" }, 1_000_000);
  assert.equal(duel.end, "results");
  const results = buildResults(resultState(duel.players, false), 1_000_000);
  assert.equal(results.ranked, false);
  assert.ok(results.rows.every((row) => row.eloAfter == null));
  assert.equal(results.rows.find((row) => row.id === "b").outcome, "forfeit-win");
});

test("a second forfeit cancels the race with no winner", () => {
  const start = race([racer("a"), racer("b")]);
  const first = applyRaceEvent(start, { type: "forfeit", playerId: "a" }, start.startAt);
  const second = applyRaceEvent({ ...start, players: first.players }, { type: "forfeit", playerId: "b" }, start.startAt + 10);
  assert.equal(second.end, "cancel");
  assert.ok(second.players.every((player) => player.forfeit));
  assert.ok(second.players.every((player) => player.forfeitWin === false));
  assert.equal(resultsHeadline([], "a", true).title, "Room closed");
});

test("a repeated forfeit and a stranger's forfeit do not change the race", () => {
  const start = race([racer("a"), racer("b")]);
  const first = applyRaceEvent(start, { type: "forfeit", playerId: "a" }, start.startAt);
  const again = applyRaceEvent({ ...start, players: first.players }, { type: "forfeit", playerId: "a" }, start.startAt + 5);
  assert.equal(again.ok, false);
  assert.equal(again.reason, "repeated");
  assert.equal(again.players, first.players);
  const stranger = applyRaceEvent(start, { type: "forfeit", playerId: "nope" }, start.startAt);
  assert.equal(stranger.ok, false);
  assert.equal(stranger.reason, "not-participant");
  assert.equal(stranger.players, start.players);
});

test("idle players are DNF only after the deadline", () => {
  const start = race([racer("a"), racer("b")]);
  const before = applyRaceEvent(start, { type: "tick" }, start.startAt - 1);
  assert.equal(before.end, null);
  assert.ok(before.players.every((player) => player.dnf === false));

  const active = applyRaceEvent(start, { type: "activity", playerId: "a" }, start.startAt + 1000);
  assert.equal(active.players.find((player) => player.id === "a").lastActivity, start.startAt + 1000);
  const early = applyRaceEvent(start, { type: "activity", playerId: "a" }, start.startAt - 1);
  assert.equal(early.players, start.players);

  const one = applyRaceEvent({ ...start, players: active.players }, { type: "tick" }, start.startAt + IDLE_MS);
  assert.equal(one.end, null);
  assert.equal(one.players.find((player) => player.id === "b").dnfReason, "idle");
  assert.equal(one.players.find((player) => player.id === "a").dnf, false);
  assert.equal(one.notices.some((notice) => notice.playerId === "b" && notice.kind === "timeout"), true);

  const both = applyRaceEvent(start, { type: "tick" }, start.startAt + IDLE_MS);
  assert.equal(both.end, "results");
  assert.ok(both.players.every((player) => player.dnfReason === "idle"));
  const results = buildResults(resultState(both.players, true), start.startAt + IDLE_MS);
  assert.ok(results.rows.every((row) => row.outcome === "timeout" && row.ms == null));
  assert.ok(results.rows.every((row) => countsAsWin(row) === false));
  assert.equal(resultsHeadline(results.rows, "a", false).title, "Timed out");
});

test("a drop during the race starts the grace at the drop", () => {
  const start = race([racer("a", { lastActivity: 1_000_000 + 14_000 }), racer("b")]);
  const dropped = applyRaceEvent(start, { type: "disconnect", playerId: "a" }, start.startAt + 16_000);
  assert.equal(dropped.players.find((player) => player.id === "a").disconnectedAt, start.startAt + 16_000);
  const back = applyRaceEvent(
    { ...start, players: dropped.players },
    { type: "reconnect", playerId: "a" },
    start.startAt + 17_000,
  );
  assert.equal(back.resumed, true);
  assert.equal(back.players.find((player) => player.id === "a").dnf, false);
  assert.equal(back.players.find((player) => player.id === "a").lastActivity, start.startAt + 14_000);
});

test("a disconnect can resume inside the grace period and is DNF after it", () => {
  const start = race([racer("a"), racer("b")]);
  const dropped = applyRaceEvent(start, { type: "disconnect", playerId: "a" }, start.startAt + 5000);
  assert.equal(dropped.end, null);
  assert.equal(dropped.players.find((player) => player.id === "a").disconnectedAt, start.startAt + 5000);
  const again = applyRaceEvent({ ...start, players: dropped.players }, { type: "disconnect", playerId: "a" }, start.startAt + 9000);
  assert.equal(again.players.find((player) => player.id === "a").disconnectedAt, start.startAt + 5000);

  const back = applyRaceEvent(
    { ...start, players: dropped.players },
    { type: "reconnect", playerId: "a" },
    start.startAt + 5000 + RECONNECT_GRACE_MS - 1,
  );
  assert.equal(back.resumed, true);
  assert.equal(back.players.find((player) => player.id === "a").dnf, false);
  assert.equal(back.players.find((player) => player.id === "a").disconnectedAt, null);

  const late = applyRaceEvent(
    { ...start, players: dropped.players },
    { type: "reconnect", playerId: "a" },
    start.startAt + 5000 + RECONNECT_GRACE_MS,
  );
  assert.equal(late.resumed, false);
  assert.equal(late.players.find((player) => player.id === "a").dnfReason, "disconnect");
  assert.equal(late.end, null);

  const waiting = applyRaceEvent({ ...start, players: dropped.players }, { type: "tick" }, start.startAt + 5000 + 10_000);
  assert.equal(waiting.players.find((player) => player.id === "a").dnf, false);

  let players = dropped.players;
  players = applyRaceEvent({ ...start, players }, { type: "disconnect", playerId: "b" }, start.startAt + 5000).players;
  const abandoned = applyRaceEvent({ ...start, players }, { type: "tick" }, start.startAt + 5000 + RECONNECT_GRACE_MS);
  assert.equal(abandoned.end, "cancel");
  assert.ok(abandoned.players.every((player) => player.dnfReason === "disconnect"));
});

test("the next alarm is the soonest idle, grace, or start deadline", () => {
  const start = race([racer("a"), racer("b")]);
  assert.equal(nextAlarmAt(start, start.startAt - 500), start.startAt);
  const active = applyRaceEvent(start, { type: "activity", playerId: "a" }, start.startAt + 1000);
  const moved = { ...start, players: active.players };
  assert.equal(nextAlarmAt(moved, start.startAt + 1000), start.startAt + IDLE_MS);
  const dropped = applyRaceEvent(moved, { type: "disconnect", playerId: "b" }, start.startAt + 1000);
  assert.equal(
    nextAlarmAt({ ...start, players: dropped.players }, start.startAt + 1000),
    start.startAt + 1000 + RECONNECT_GRACE_MS,
  );
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

test("backoff grows from the base and then stays at the cap", () => {
  assert.equal(backoffDelay(0), RETRY_BASE_MS);
  assert.equal(backoffDelay(1), RETRY_BASE_MS * 2);
  assert.equal(backoffDelay(2), RETRY_BASE_MS * 4);
  assert.equal(backoffDelay(20), RETRY_CAP_MS);
  assert.equal(backoffDelay(-3), RETRY_BASE_MS);
  assert.equal(backoffDelay(Number.NaN), RETRY_BASE_MS);
  assert.equal(backoffDelay(0, 300, 4_000), 300);
  assert.equal(backoffDelay(4, 300, 4_000), 4_000);
  assert.ok(RETRY_LIMIT >= 1);
});

test("session state follows /api/me and ignores config", () => {
  assert.equal(classifyMe({ ok: true, user: { id: "a" } }), "in");
  assert.equal(classifyMe({ ok: true, user: null }), "out");
  assert.equal(classifyMe({ ok: true }), "out");
  assert.equal(classifyMe({ ok: false, status: 401 }), "out");
  assert.equal(classifyMe({ ok: false, status: 500 }), "error");
  assert.equal(classifyMe({ ok: false, status: 503 }), "error");
  assert.equal(classifyMe({ ok: false, status: 404 }), "error");
  assert.equal(classifyMe({ ok: false }), "error");
  assert.equal(classifyMe(null), "error");
  assert.equal(sessionShell({ session: "unknown", phase: "lobby", lobbyOpen: false }), "loading");
  assert.equal(sessionShell({ session: "error", phase: "lobby", lobbyOpen: false }), "boot-error");
  assert.equal(sessionShell({ session: "out", phase: "race", lobbyOpen: true }), "auth");
  assert.equal(sessionShell({ session: "in", phase: "lobby", lobbyOpen: false }), "lobby");
  assert.equal(sessionShell({ session: "in", phase: "queue", lobbyOpen: false }), "lobby");
  assert.equal(sessionShell({ session: "in", phase: "queue", lobbyOpen: true }), "queue");
  assert.equal(sessionShell({ session: "in", phase: "room", lobbyOpen: false }), "lobby");
  assert.equal(sessionShell({ session: "in", phase: "browse", lobbyOpen: true }), "browse");
  assert.equal(sessionShell({ session: "in", phase: "race", lobbyOpen: false }), "race");
  assert.equal(sessionShell({ session: "in", phase: "countdown", lobbyOpen: false }), "race");
  assert.equal(sessionShell({ session: "in", phase: "results", lobbyOpen: false }), "results");
  assert.equal(sessionShell({ session: "out", phase: "race", lobbyOpen: true, solo: true }), "race");
  assert.equal(sessionShell({ session: "out", phase: "results", lobbyOpen: false, solo: true }), "solo-results");
  assert.equal(sessionShell({ session: "out", phase: "lobby", lobbyOpen: false, view: "stats" }), "stats");
  assert.equal(sessionShell({ session: "out", phase: "race", lobbyOpen: true, view: "stats" }), "auth");
  assert.equal(sessionShell({ session: "in", phase: "lobby", lobbyOpen: false, view: "stats" }), "stats");
  assert.equal(sessionShell({ session: "in", phase: "queue", lobbyOpen: true, view: "stats" }), "queue");
  assert.equal(sessionShell({ session: "out", phase: "results", lobbyOpen: false, solo: true, view: "stats" }), "stats");
  assert.equal(sessionShell({ session: "in", phase: "results", lobbyOpen: false, view: "stats" }), "stats");
  assert.equal(sessionShell({ session: "in", phase: "race", lobbyOpen: false, view: "stats" }), "race");
  assert.equal(headerSignIn({ session: "unknown", oauth: true }), "pending");
  assert.equal(headerSignIn({ session: "in", oauth: true }), "account");
  assert.equal(headerSignIn({ session: "out", oauth: true }), "oauth");
  assert.equal(headerSignIn({ session: "error", oauth: true, devLogin: true }), "oauth");
  assert.equal(headerSignIn({ session: "out", devLogin: true }), "dev");
  assert.equal(headerSignIn({ session: "out" }), "hidden");
  assert.equal(headerSignIn({ session: "error" }), "hidden");
});

test("automatic retries cover network failures and server errors", () => {
  for (const status of [null, undefined, 0, 408, 429, 500, 503, 599]) {
    assert.equal(shouldAutoRetry(status), true, String(status));
  }
  for (const status of [200, 400, 401, 403, 404, 422]) {
    assert.equal(shouldAutoRetry(status), false, String(status));
  }
});

test("a lobby drop clears queue and room membership", () => {
  assert.deepEqual(lobbyDrop("queue"), { phase: "lobby", clearQueue: true, clearRoom: false, notice: "requeue" });
  assert.deepEqual(lobbyDrop("room"), { phase: "lobby", clearQueue: false, clearRoom: true, notice: "room" });
  assert.deepEqual(lobbyDrop("browse"), { phase: "lobby", clearQueue: false, clearRoom: false, notice: "reconnect" });
  const race = lobbyDrop("race");
  assert.equal(race.phase, "race");
  assert.equal(race.clearQueue, false);
  assert.equal(race.notice, "reconnect");
  const lobby = lobbyDrop("lobby");
  assert.equal(lobby.phase, "lobby");
  assert.equal(lobby.notice, "reconnect");
});

test("race reconnect keeps trying inside the server grace window", () => {
  assert.equal(RACE_RECONNECT_GRACE_MS, RECONNECT_GRACE_MS);
  let elapsed = 0;
  let attempt = 0;
  const delays = [];
  while (attempt < 20) {
    const delay = nextRaceRetry(attempt, elapsed);
    if (delay == null) break;
    delays.push(delay);
    elapsed += delay;
    attempt += 1;
  }
  assert.ok(delays.length > 3, `only ${delays.length} attempts`);
  assert.ok(elapsed < RACE_RECONNECT_GRACE_MS);
  assert.equal(nextRaceRetry(attempt, elapsed), null);
  assert.equal(delays[0], RACE_RECONNECT_BASE_MS);
  assert.equal(nextRaceRetry(0, RACE_RECONNECT_GRACE_MS), null);
  assert.equal(nextRaceRetry(0, -1), null);
  assert.equal(nextRaceRetry(0, 0, 0), null);
});

function legacyCorrectLength(typed, sentence) {
  const limit = Math.min(typed.length, sentence.length);
  let index = 0;
  while (index < limit && typed[index] === sentence[index]) index += 1;
  return index;
}

test("typed text grows by one character and stops on a mismatch", () => {
  const sentence = "I love Fluxer";
  const first = applyTyping(
    { typed: "", sentence, ok: 0, err: 0 },
    consumeInput(emptyInputSession(), { type: "beforeinput", inputType: "insertText", data: "I" }).effect,
  );
  assert.equal(first.typed, "I");
  assert.equal(first.ok, 1);
  assert.equal(first.err, 0);
  assert.equal(first.steps.length, 1);
  assert.equal(first.steps[0].kind, "prog");
  assert.equal(first.steps[0].text, "I");

  const wrong = applyTyping({ ...first, sentence }, { effect: "insert", chars: ["x"] });
  assert.equal(wrong.typed, "Ix");
  assert.equal(wrong.ok, 1);
  assert.equal(wrong.err, 1);
  const stopped = applyTyping({ ...wrong, sentence }, { effect: "insert", chars: ["l"] });
  assert.equal(stopped.typed, "Ix");
  assert.equal(stopped.changed, false);
  assert.equal(stopped.err, 1);

  const erased = applyTyping(
    { ...wrong, sentence },
    consumeInput(emptyInputSession(), { type: "beforeinput", inputType: "deleteContentBackward" }).effect,
  );
  assert.equal(erased.typed, "I");
  assert.equal(erased.ok, 1);
  assert.equal(erased.err, 1);
  assert.equal(erased.steps[0].text, "I");

  const word = applyTyping(
    { typed: "hello", sentence: "hello", ok: 5, err: 0 },
    consumeInput(emptyInputSession(), { type: "beforeinput", inputType: "deleteWordBackward" }).effect,
  );
  assert.equal(word.typed, "hell");
  assert.equal(word.ok, 5);
  assert.equal(word.steps.length, 1);
});

test("accented input matches the passage after NFC and finishes once", () => {
  const sentence = "caf\u00e9";
  const typed = applyTyping(
    { typed: "caf", sentence, ok: 3, err: 0 },
    { effect: "insert", chars: textUnits("e\u0301") },
  );
  assert.deepEqual(textUnits("e\u0301"), ["\u00e9"]);
  assert.equal(typed.typed, sentence);
  assert.equal(typed.ok, 4);
  assert.equal(typed.err, 0);
  assert.equal(typed.finished, true);
  assert.equal(typed.steps.at(-1).kind, "fin");
  assert.equal(correctLength(typed.typed, "cafe\u0301"), 4);
  assert.equal(correctLength("I love", "I love Fluxer"), legacyCorrectLength("I love", "I love Fluxer"));
  assert.equal(correctLength("Ix", "I love"), legacyCorrectLength("Ix", "I love"));
});

test("composition end commits once and a following insert is ignored", () => {
  let session = emptyInputSession();
  session = consumeInput(session, { type: "compositionstart" }).session;
  const partial = consumeInput(session, { type: "beforeinput", inputType: "insertCompositionText", data: "e" });
  assert.equal(partial.effect.effect, "defer");
  session = partial.session;
  const ended = consumeInput(session, { type: "compositionend", data: "e\u0301" });
  assert.equal(ended.effect.effect, "insert");
  assert.deepEqual(ended.effect.chars, ["\u00e9"]);
  const repeat = consumeInput(ended.session, { type: "beforeinput", inputType: "insertText", data: "\u00e9" });
  assert.equal(repeat.effect.effect, "ignore");
  const trailed = consumeInput(repeat.session, { type: "input", inputType: "insertText", data: "\u00e9", value: "\u00e9" });
  assert.equal(trailed.effect.effect, "ignore");
  const typed = applyTyping({ typed: "", sentence: "\u00e9", ok: 0, err: 0 }, ended.effect);
  assert.equal(typed.typed, "\u00e9");
  assert.equal(typed.ok, 1);
  const after = consumeInput(settleInput(trailed.session), { type: "beforeinput", inputType: "insertText", data: "!" });
  assert.equal(after.effect.effect, "insert");
  assert.deepEqual(after.effect.chars, ["!"]);
});

test("paste and drop do not change the typed text", () => {
  const start = { typed: "I", sentence: "I love", ok: 1, err: 0 };
  for (const inputType of ["insertFromPaste", "insertFromDrop", "insertReplacementText"]) {
    const consumed = consumeInput(emptyInputSession(), { type: "beforeinput", inputType, data: "love" });
    assert.equal(consumed.effect.effect, "reject");
    const next = applyTyping(start, consumed.effect);
    assert.equal(next.changed, false);
    assert.equal(next.typed, "I");
    const trailed = consumeInput(consumed.session, { type: "input", inputType, data: "love", value: "love" });
    assert.equal(trailed.effect.effect, "ignore");
  }
});

test("keydown and input do not count the same character twice", () => {
  let session = emptyInputSession();
  const key = consumeInput(session, { type: "keydown", key: "a" });
  assert.equal(key.effect.effect, "ignore");
  const typed = consumeInput(key.session, { type: "beforeinput", inputType: "insertText", data: "a" });
  assert.equal(typed.effect.effect, "insert");
  assert.deepEqual(typed.effect.chars, ["a"]);
  const again = consumeInput(typed.session, { type: "input", inputType: "insertText", data: "a", value: "a" });
  assert.equal(again.effect.effect, "ignore");
  const state = applyTyping({ typed: "", sentence: "a", ok: 0, err: 0 }, typed.effect);
  assert.equal(state.typed, "a");
  assert.equal(state.ok, 1);
  assert.equal(state.steps.length, 1);

  const back = consumeInput(emptyInputSession(), { type: "keydown", key: "Backspace" });
  assert.equal(back.effect.effect, "backspace");
  const extra = consumeInput(back.session, { type: "beforeinput", inputType: "deleteContentBackward" });
  assert.equal(extra.effect.effect, "ignore");
  const once = applyTyping({ typed: "ab", sentence: "ab", ok: 2, err: 0 }, back.effect);
  assert.equal(once.typed, "a");
  const released = consumeInput(settleInput(back.session), { type: "beforeinput", inputType: "deleteContentBackward" });
  assert.equal(released.effect.effect, "backspace");
});

test("an input event supplies the character when beforeinput has no data", () => {
  let session = emptyInputSession();
  const pending = consumeInput(session, { type: "beforeinput", inputType: "insertText", data: null });
  assert.equal(pending.effect.effect, "defer");
  const typed = consumeInput(pending.session, { type: "input", inputType: "insertText", data: null, value: "\u00e9" });
  assert.deepEqual(typed.effect.chars, ["\u00e9"]);
  const state = applyTyping({ typed: "", sentence: "\u00e9", ok: 0, err: 0 }, typed.effect);
  assert.equal(state.ok, 1);
  assert.equal(state.typed, "\u00e9");
});

test("the page keeps a signed-in shell independent of config and guards a second start", () => {
  const src = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(src, /Promise\.allSettled\(\[pullMe\(\), pullConfig\(\), pullBoard\(\), pullDaily\(\)\]\)/);
  assert.equal(src.includes("raceTries > 3"), false);
  assert.match(src, /playLock/);
  assert.match(src, /nextRaceRetry/);
  assert.match(src, /role: "alert"/);
  assert.match(src, /Connection lost, reconnecting\.\.\./);
  assert.match(src, /Unranked/);
});

function duelRows() {
  return [
    { id: "a", place: 1, wpm: 80, accuracy: 100, ms: 5000, progress: 13, finished: true, outcome: "finished", dq: false },
    { id: "b", place: 2, wpm: 60, accuracy: 100, ms: 8000, progress: 13, finished: true, outcome: "finished", dq: false },
  ];
}

test("private rooms are unranked and practice stays a solo unrated race", () => {
  assert.equal(rankedFor("room"), false);
  assert.equal(rankedFor("practice"), false);
  assert.equal(rankedFor("queue"), true);
  const room = buildResults(
    {
      ranked: false,
      kind: "room",
      mode: "desktop",
      sentence: "I love Fluxer",
      startAt: 0,
      players: [
        { id: "a", name: "Ada", tag: "ada", eloAtStart: 1200 },
        { id: "b", name: "Bea", tag: "bea", eloAtStart: 1400 },
      ],
      finishes: {
        a: { at: 4000, ok: 13, err: 0 },
        b: { at: 5000, ok: 13, err: 0 },
      },
      progress: {},
    },
    5000,
  );
  assert.equal(room.ranked, false);
  assert.equal(room.kind, "room");
  assert.equal(room.rows[0].eloBefore, null);
  assert.equal(room.rows[0].eloAfter, null);
  assert.equal(room.rows[1].eloAfter, null);
  const plan = planRating(room.rows, { ranked: false, elos: { a: 1200, b: 1400 }, pairCounts: {} });
  assert.deepEqual(plan.map((row) => row.delta), [0, 0]);
  assert.equal(plan.every((row) => row.countRace === false), true);
  assert.equal(standingLabel({ ranked: false, racers: 2 }), "Unranked");
  assert.equal(standingLabel({ ranked: false, kind: "room", racers: 0 }), "Unranked");
  assert.equal(standingLabel({ ranked: false, racers: 1 }), "practice");
  assert.equal(standingLabel({ ranked: true, racers: 2 }), "rated");
});

test("expected score and a single pair use the same 400-point curve", () => {
  assert.equal(expectedScore(1000, 1000), 0.5);
  assert.ok(Math.abs(expectedScore(1200, 1000) - (1 / (1 + 10 ** (-200 / 400)))) < 1e-12);
  const swing = eloDelta({ id: "a", elo: 1000, place: 1 }, { id: "b", elo: 1000, place: 2 });
  assert.equal(swing, 16);
  assert.equal(PAIR_WINDOW_MS, 60 * 60 * 1000);
  assert.equal(PAIR_RATED_LIMIT, 2);
  assert.equal(pairFactor(0), 1);
  assert.equal(pairFactor(1), 1);
  assert.equal(pairFactor(2), 0);
  assert.equal(pairFactor(9), 0);
});

test("a repeated pair stops moving elo while a new opponent still does", () => {
  const rows = [
    { id: "a", place: 1, dq: false, ms: 1, finished: true, outcome: "finished" },
    { id: "b", place: 2, dq: false, ms: 2, finished: true, outcome: "finished" },
    { id: "c", place: 3, dq: false, ms: null, finished: false, outcome: "dnf" },
  ];
  const open = planRating(rows, { ranked: true, elos: { a: 1000, b: 1000, c: 1000 }, pairCounts: {} });
  assert.equal(open.find((row) => row.id === "a").delta, 16);
  assert.equal(open.find((row) => row.id === "b").delta, 0);
  assert.equal(open.find((row) => row.id === "c").delta, -16);
  const capped = planRating(rows, {
    ranked: true,
    elos: { a: 1000, b: 1000, c: 1000 },
    pairCounts: { [pairKey("a", "b")]: PAIR_RATED_LIMIT },
  });
  assert.equal(capped.find((row) => row.id === "a").delta, 8);
  assert.equal(capped.find((row) => row.id === "b").delta, 8);
  assert.equal(capped.find((row) => row.id === "c").delta, -16);
  const history = pairCountsFromRows([
    { raceId: "r1", userId: "a" },
    { raceId: "r1", userId: "b" },
    { raceId: "r2", userId: "a" },
    { raceId: "r2", userId: "b" },
    { raceId: "r3", userId: "a" },
    { raceId: "r3", userId: "c" },
  ], ["a", "b", "c"]);
  assert.equal(history[pairKey("b", "a")], 2);
  assert.equal(history[pairKey("a", "c")], 1);
  assert.equal(history[pairKey("b", "c")], 0);
});

test("the rating window starts at 100 and then matches anyone", () => {
  assert.equal(MATCH_WINDOW_START, 100);
  assert.equal(MATCH_WINDOW_STEP, 50);
  assert.equal(MATCH_WINDOW_INTERVAL_MS, 5000);
  assert.equal(MATCH_WINDOW_CAP, 400);
  assert.equal(matchWindow(0), 100);
  assert.equal(matchWindow(4999), 100);
  assert.equal(matchWindow(5000), 150);
  assert.equal(matchWindow(20000), 300);
  assert.equal(matchWindow(29999), 350);
  assert.equal(matchWindow(30000), Infinity);
  assert.equal(waitForWindow(80), 0);
  assert.equal(waitForWindow(300), 20000);
  assert.equal(waitForWindow(5000), 30000);
});

test("matchmaking prefers a close opponent and widens with the longer wait", () => {
  const me = { userId: "a", elo: 1000, queuedAt: 0 };
  const near = { userId: "b", elo: 1090, queuedAt: 0 };
  const far = { userId: "c", elo: 1200, queuedAt: 0 };
  assert.equal(pickOpponent([me, near, far], me, 0).userId, "b");
  assert.equal(pickOpponent([me, far], me, 0), null);
  assert.equal(pickOpponent([me, far], me, 10000).userId, "c");
  const late = { userId: "c", elo: 1200, queuedAt: 10000 };
  assert.equal(pickOpponent([me, late], me, 10000).userId, "c");
  assert.equal(pickOpponent([late], { ...me, queuedAt: 10000 }, 10000), null);
  const group = pickGroup([
    { userId: "far", elo: 1000, queuedAt: 0 },
    { userId: "b", elo: 2000, queuedAt: 1000 },
    { userId: "c", elo: 2010, queuedAt: 1000 },
  ], 1000, 4);
  assert.deepEqual(group.map((row) => row.userId), ["b", "c"]);
});

test("a player cannot match their other tab, and a wide gap still starts", () => {
  const twin = [
    { userId: "a", elo: 1000, queuedAt: 0 },
    { userId: "a", elo: 1000, queuedAt: 50 },
  ];
  assert.equal(pickOpponent(twin, twin[0], 0), null);
  assert.equal(pickGroup(twin, 0), null);
  const mixed = pickGroup([...twin, { userId: "b", elo: 1000, queuedAt: 10 }], 0, 4);
  assert.deepEqual(mixed.map((row) => row.userId).sort(), ["a", "b"]);
  const apart = [
    { userId: "a", elo: 1000, queuedAt: 0 },
    { userId: "b", elo: 9000, queuedAt: 0 },
  ];
  assert.equal(pickOpponent(apart, apart[0], 0), null);
  assert.equal(pickGroup(apart, 29999), null);
  assert.equal(pickOpponent(apart, apart[0], 30000).userId, "b");
  assert.equal(pickGroup(apart, 30000).length, 2);
  assert.equal(nextQueuedAt({ status: "queue", mode: "desktop", length: "sprint", queuedAt: 50 }, "desktop", "sprint", 90), 50);
  assert.equal(nextQueuedAt({ status: "queue", mode: "desktop", length: "sprint", queuedAt: 50 }, "mobile", "sprint", 90), 90);
  assert.equal(nextQueuedAt({ status: "idle", mode: "desktop", length: "sprint", queuedAt: 50 }, "desktop", "sprint", 90), 90);
});

test("the next match time agrees with the window and does not starve a pair", () => {
  const queue = [
    { userId: "a", elo: 1000, queuedAt: 0 },
    { userId: "b", elo: 1300, queuedAt: 0 },
  ];
  assert.equal(nextMatchAt(queue, 0), 20000);
  assert.equal(pickGroup(queue, 19999), null);
  assert.equal(pickGroup(queue, 20000).length, 2);
  assert.equal(nextMatchAt([{ userId: "a", elo: 1000, queuedAt: 5 }], 5), null);
  const clocks = [0, 4999, 5000, 20000, 30000, 60000];
  const samples = [
    queue,
    [
      { userId: "a", elo: 1000, queuedAt: 0 },
      { userId: "b", elo: 1000, queuedAt: 0 },
      { userId: "c", elo: 2500, queuedAt: 1000 },
    ],
    [
      { userId: "a", elo: 1500, queuedAt: 10 },
      { userId: "a", elo: 1500, queuedAt: 99 },
      { userId: "b", elo: 1900, queuedAt: 10 },
    ],
  ];
  for (const sample of samples) {
    for (const now of clocks) {
      const group = pickGroup(sample, now);
      const at = nextMatchAt(sample, now);
      if (group) assert.ok(at <= now, `matched pair still waiting at ${now}`);
      else assert.ok(at > now, `unmatched pair has no later time at ${now}`);
    }
  }
});

test("overlapping races both add and the same race applies once", () => {
  const plan = planRating(duelRows(), { ranked: true, elos: { a: 1000, b: 1000 }, pairCounts: {} });
  assert.equal(plan.find((row) => row.id === "a").delta, 16);
  assert.equal(plan.find((row) => row.id === "b").delta, -16);
  const fresh = { users: { a: { desktop: { elo: 1000, races: 0, wins: 0 }, mobile: { elo: 1000, races: 0, wins: 0 } }, b: { desktop: { elo: 1000, races: 0, wins: 0 } } }, applied: [] };
  const once = commitRating(fresh, plan, "race-1", "desktop");
  assert.equal(once.users.a.desktop.elo, 1016);
  assert.equal(once.users.a.desktop.races, 1);
  assert.equal(once.users.a.desktop.wins, 1);
  assert.equal(once.users.b.desktop.elo, 984);
  assert.equal(once.users.a.mobile.elo, 1000);
  const twice = commitRating(once, plan, "race-1", "desktop");
  assert.equal(twice.users.a.desktop.elo, 1016);
  assert.equal(twice.users.a.desktop.races, 1);
  const both = commitRating(twice, plan, "race-2", "desktop");
  assert.equal(both.users.a.desktop.elo, 1032);
  assert.equal(both.users.b.desktop.elo, 968);
  assert.equal(both.users.a.desktop.races, 2);
  const absolute = { a: 1016, b: 984 };
  for (const row of plan) absolute[row.id] = row.eloAfter;
  assert.equal(absolute.a, 1016);
  assert.equal(both.users.a.desktop.elo, 1032);
  const low = commitRating(
    { users: { a: { desktop: { elo: 100, races: 0, wins: 0 } }, b: { desktop: { elo: 100, races: 0, wins: 0 } } }, applied: [] },
    planRating(duelRows(), { ranked: true, elos: { a: 100, b: 100 }, pairCounts: {} }),
    "race-low",
    "desktop",
  );
  assert.equal(low.users.b.desktop.elo, 100);
  const dq = planRating([
    { id: "a", place: 1, dq: false, ms: 1000, finished: true, outcome: "finished" },
    { id: "b", place: 2, dq: true, ms: null, finished: false, outcome: "dnf" },
  ], { ranked: true, elos: { a: 1000, b: 1100 }, pairCounts: {} });
  assert.equal(dq.find((row) => row.id === "b").delta, 0);
  assert.equal(dq.find((row) => row.id === "b").countRace, true);
  assert.ok(dq.find((row) => row.id === "a").delta > 0);
});

test("ranked saves add the delta and unranked saves leave elo columns alone", () => {
  const rows = duelRows();
  const rankedPlan = planRating(rows, { ranked: true, elos: { a: 1000, b: 1000 }, pairCounts: {} });
  const rankedSql = saveStatements({
    id: "race-1",
    mode: "desktop",
    sentence: "I love Fluxer",
    ranked: true,
    startedAt: 1,
    finishedAt: 2,
    rows,
  }, rankedPlan);
  const update = rankedSql.find((statement) => statement.sql.includes("MAX(100"));
  assert.ok(update);
  assert.match(update.sql, /elo_desktop = MAX\(100, elo_desktop \+ \?\)/);
  assert.match(update.sql, /NOT EXISTS/);
  assert.equal(update.sql.includes("elo_desktop = ?"), false);
  assert.equal(update.binds[0], 16);
  assert.match(rankedSql[0].sql, /ON CONFLICT\(id\) DO NOTHING/);
  assert.ok(rankedSql.some((statement) => statement.sql.includes("ON CONFLICT(race_id, user_id) DO NOTHING")));
  const roomPlan = planRating(rows, { ranked: false, elos: { a: 1000, b: 1000 }, pairCounts: {} });
  const roomSql = saveStatements({
    id: "room-1",
    mode: "desktop",
    sentence: "I love Fluxer",
    ranked: false,
    startedAt: 1,
    finishedAt: 2,
    rows,
  }, roomPlan).map((statement) => statement.sql).join("\n");
  assert.equal(roomSql.includes("elo_desktop"), false);
  assert.match(roomSql, /ON CONFLICT\(race_id, user_id\) DO NOTHING/);
});
