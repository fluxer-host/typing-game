import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { applyElo, eloDeltas } from "../src/elo.js";
import { MODE_COLUMNS } from "../src/modes.js";
import { applyRaceEvent, IDLE_MS, nextAlarmAt, RECONNECT_GRACE_MS, resultsHeadline } from "../src/race-end.js";
import { buildResults, countsAsWin } from "../src/results.js";
import { accuracy, wpm } from "../src/score.js";
import { readPayload, signPayload } from "../src/session.js";
import { LENGTHS, lengthList } from "../src/lengths.js";
import { validateProgress } from "../src/progress.js";
import { summarizeRooms } from "../src/lobby.js";
import { CHARSET, CURSOR_KEYS, cursorCanType, isKnownSentence, passageOk, pickPassage, pickSentence, poolFor, SENTENCES } from "../src/sentences.js";
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
  sessionShell,
  shouldAutoRetry,
} from "../public/net.js";

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
  assert.match(src, /Promise\.allSettled\(\[pullMe\(\), pullConfig\(\), pullBoard\(\)\]\)/);
  assert.equal(src.includes("raceTries > 3"), false);
  assert.match(src, /playLock/);
  assert.match(src, /nextRaceRetry/);
  assert.match(src, /role: "alert"/);
  assert.match(src, /Connection lost, reconnecting\.\.\./);
});
