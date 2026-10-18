import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { board } from "../src/api.js";
import {
  LADDER_PAGE_SIZE,
  LADDER_RANK_RADIUS,
  compareBoard,
  pageLabel,
  pageWindow,
  parseBoardQuery,
  rankWindow,
  shapeLadderRow,
  winRate,
} from "../src/board.js";
import { DAILY_BOARD_MAX_OFFSET, parseDailyQuery } from "../src/daily.js";
import { loadDailyBoard } from "../src/daily-store.js";
import { leaderboard, leaderboardCount, leaderboardRank } from "../src/db.js";
import { signPayload } from "../src/session.js";
import { sessionShell } from "../public/net.js";
import { pageTitle } from "../public/passage.js";
import {
  avatarDisc,
  dailyPagePath,
  focusAfterPaint,
  freshLadder,
  ladderAnnounce,
  ladderHash,
  ladderViewModel,
  maxLadderPage,
  oldestDailyDay,
  pageOffset,
  parseLadderHash,
  ratingPagePath,
  routeFromHash,
  shiftUtcDay,
  tabMove,
} from "../public/ladder.js";

const INIT = readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8");
const DAILY_SQL = readFileSync(new URL("../migrations/0002_daily.sql", import.meta.url), "utf8");
const SECRET = "ladder-test-secret-value";

function query(search) {
  return new URLSearchParams(search);
}

function sqliteEnv() {
  const db = new DatabaseSync(":memory:");
  db.exec(INIT);
  db.exec(DAILY_SQL);
  const env = {
    DB: {
      prepare(sql) {
        const stmt = db.prepare(sql);
        const wrapped = (args) => ({
          async run() {
            const info = stmt.run(...args);
            return { meta: { changes: Number(info.changes || 0) } };
          },
          async first() {
            return stmt.get(...args) ?? null;
          },
          async all() {
            return { results: stmt.all(...args) };
          },
        });
        return {
          bind(...args) {
            return wrapped(args);
          },
          ...wrapped([]),
        };
      },
    },
    MEDIA_BASE: "https://fluxerusercontent.com",
    STATIC_CDN: "https://fluxerstatic.com",
    SESSION_SECRET: SECRET,
  };
  return { env, db };
}

async function addUser(env, id, fields = {}) {
  await env.DB.prepare(
    `INSERT INTO users (
       id, username, discriminator, global_name, avatar, avatar_color,
       elo_desktop, elo_mobile, elo_cursor,
       races_desktop, races_mobile, races_cursor,
       wins_desktop, wins_mobile, wins_cursor,
       best_wpm_desktop, best_wpm_mobile, best_wpm_cursor,
       created_at, updated_at
     ) VALUES (?, ?, '0', ?, ?, ?, ?, 1000, 1000, ?, 0, 0, ?, 0, 0, ?, NULL, NULL, 1, 1)`,
  ).bind(
    id,
    fields.username || "racer",
    fields.globalName ?? null,
    fields.avatar ?? null,
    fields.color ?? null,
    fields.elo ?? 1000,
    fields.races ?? 0,
    fields.wins ?? 0,
    fields.best ?? null,
  ).run();
}

async function sessionCookie(env, userId) {
  const sid = crypto.randomUUID();
  const exp = Date.now() + 86_400_000;
  await env.DB.prepare(
    "INSERT INTO sessions (id, user_id, refresh_token, expires_at) VALUES (?, ?, NULL, ?)",
  ).bind(sid, userId, exp).run();
  const token = await signPayload({ sid, exp }, SECRET);
  return `tg_session=${token}`;
}

test("leaderboard query rejects length, period, and a bad page", () => {
  assert.deepEqual(parseBoardQuery(query("mode=desktop")), { ok: true, mode: "desktop", limit: 25, offset: 0 });
  assert.deepEqual(parseBoardQuery(query("mode=desktop&period=all")), { ok: true, mode: "desktop", limit: 25, offset: 0 });
  assert.deepEqual(parseBoardQuery(query("mode=desktop&length=")), { ok: true, mode: "desktop", limit: 25, offset: 0 });
  assert.equal(parseBoardQuery(query("mode=nope")).error, "mode");
  assert.equal(parseBoardQuery(query("mode=desktop&limit=0")).error, "limit");
  assert.equal(parseBoardQuery(query("mode=desktop&limit=101")).error, "limit");
  assert.equal(parseBoardQuery(query("mode=desktop&limit=1.5")).error, "limit");
  assert.equal(parseBoardQuery(query("mode=desktop&offset=-1")).error, "offset");
  assert.equal(parseBoardQuery(query("mode=desktop&offset=10001")).error, "offset");
  assert.equal(parseBoardQuery(query("mode=desktop&offset=nope")).error, "offset");
  assert.equal(parseBoardQuery(query("mode=desktop&length=sprint")).error, "length");
  assert.equal(parseBoardQuery(query("mode=desktop&length=nope")).error, "length");
  assert.equal(parseBoardQuery(query("mode=desktop&period=week")).error, "period");
  assert.equal(parseBoardQuery(query("mode=desktop&period=today")).error, "period");
});

test("page windows cover the last page and an empty ladder", () => {
  assert.equal(LADDER_PAGE_SIZE, 25);
  const empty = pageWindow(0, 4);
  assert.deepEqual(empty, {
    page: 1, pages: 1, offset: 0, start: 0, end: 0, total: 0, hasPrev: false, hasNext: false,
  });
  assert.equal(pageLabel(empty), "Page 1 of 1.");
  const middle = pageWindow(80, 2);
  assert.equal(middle.offset, 25);
  assert.equal(middle.start, 26);
  assert.equal(middle.end, 50);
  assert.equal(middle.pages, 4);
  assert.equal(middle.hasPrev, true);
  assert.equal(middle.hasNext, true);
  assert.equal(pageLabel(middle), "Page 2 of 4, showing 26 to 50 of 80.");
  const last = pageWindow(80, 4);
  assert.equal(last.start, 76);
  assert.equal(last.end, 80);
  assert.equal(last.hasNext, false);
  assert.equal(pageWindow(80, 9).page, 4);
  assert.equal(pageWindow(25, 1).hasNext, false);
  assert.equal(pageOffset(1), 0);
  assert.equal(pageOffset(401), 10_000);
  assert.equal(pageOffset(402), null);
  assert.equal(maxLadderPage(), 401);
});

test("the rank window stays inside the ladder", () => {
  assert.equal(LADDER_RANK_RADIUS, 2);
  assert.equal(rankWindow(null, 10), null);
  assert.equal(rankWindow(0, 10), null);
  assert.equal(rankWindow(1.5, 10), null);
  assert.equal(rankWindow(11, 10), null);
  assert.deepEqual(rankWindow(1, 10), { from: 1, to: 3, offset: 0, limit: 3 });
  assert.deepEqual(rankWindow(10, 10), { from: 8, to: 10, offset: 7, limit: 3 });
  assert.deepEqual(rankWindow(5, 10), { from: 3, to: 7, offset: 2, limit: 5 });
  assert.deepEqual(rankWindow(1, 1), { from: 1, to: 1, offset: 0, limit: 1 });
  assert.equal(winRate(0, 0), null);
  assert.equal(winRate(0, 4), 0);
  assert.equal(winRate(1, 4), 0.25);
  assert.equal(winRate(5, 4), 1);
});

test("a public ladder row keeps a custom Fluxer picture and drops the account id field", () => {
  const hidden = shapeLadderRow({
    id: "user-secret",
    username: "ada",
    global_name: "Ada",
    avatarUrl: "https://fluxerusercontent.com/avatars/user-secret/abc.png",
    avatar_color: 0x111111,
    elo_desktop: 1100,
    races_desktop: 4,
    wins_desktop: 1,
    elo_mobile: 1400,
  }, "desktop", 2);
  assert.deepEqual(Object.keys(hidden).sort(), ["avatar", "color", "name", "races", "rank", "rating", "wins"]);
  assert.equal(hidden.avatar, "https://fluxerusercontent.com/avatars/user-secret/abc.png");
  assert.equal("id" in hidden, false);
  assert.equal(hidden.rank, 2);
  assert.equal(hidden.rating, 1100);
  assert.equal(JSON.stringify(hidden).includes("1400"), false);
  const shown = shapeLadderRow({
    id: "9100001",
    username: "bea",
    avatarUrl: "https://fluxerstatic.com/avatars/5.png",
    elo_desktop: 1000,
    races_desktop: 1,
    wins_desktop: 0,
  }, "desktop", 4);
  assert.equal(shown.avatar, "https://fluxerstatic.com/avatars/5.png");
  assert.equal(JSON.stringify(shown).includes("9100001"), false);
});

test("hash routes keep the tab, the page, and the daily day", () => {
  assert.deepEqual(routeFromHash("#/stats"), { route: "stats", ladder: null });
  assert.equal(routeFromHash("").route, "");
  const samples = [
    "#/ladder",
    "#/ladder/desktop",
    "#/ladder/mobile?page=2",
    "#/ladder/cursor",
    "#/ladder/daily",
    "#/ladder/daily?ladder=mobile&day=2026-10-17&page=2",
  ];
  for (const hash of samples) {
    const parsed = parseLadderHash(hash);
    const again = parseLadderHash(ladderHash(parsed));
    assert.equal(again.tab, parsed.tab);
    assert.equal(again.page, parsed.page);
    assert.equal(again.ladder, parsed.tab === "daily" ? parsed.ladder : "desktop");
    assert.equal(again.day, parsed.tab === "daily" ? parsed.day : "");
    assert.equal(again.invalid, false);
  }
  assert.equal(parseLadderHash("#/ladder").tab, "desktop");
  assert.equal(parseLadderHash("#/ladder/desktop").tab, "desktop");
  assert.equal(parseLadderHash("#/ladder/nope").invalid, true);
  assert.equal(parseLadderHash("#/ladder/nope").tab, "desktop");
  assert.equal(ladderHash(parseLadderHash("#/ladder/nope")), "#/ladder");
  assert.equal(parseLadderHash("#/ladder?page=0").invalid, true);
  assert.equal(parseLadderHash("#/ladder?page=402").page, 1);
  assert.equal(parseLadderHash("#/ladder/daily?day=2026-02-31").invalid, true);
  assert.equal(parseLadderHash("#/ladder/daily?day=2026-02-31").day, "");
  assert.equal(routeFromHash("#/ladder/cursor").route, "ladder");
  const ids = ["desktop", "mobile", "cursor", "daily"];
  assert.equal(tabMove(ids, "desktop", "ArrowRight"), "mobile");
  assert.equal(tabMove(ids, "desktop", "ArrowLeft"), "daily");
  assert.equal(tabMove(ids, "daily", "ArrowDown"), "desktop");
  assert.equal(focusAfterPaint("loading", "tab"), "now");
  assert.equal(focusAfterPaint("loading", ""), "later");
  assert.equal(focusAfterPaint("ready", "tab"), "now-clear");
  assert.equal(focusAfterPaint("empty", ""), "now-clear");
  assert.equal(focusAfterPaint("error", "tab"), "now-clear");
  assert.equal(tabMove(ids, "mobile", "Home"), "desktop");
  assert.equal(tabMove(ids, "mobile", "End"), "daily");
  assert.equal(tabMove(ids, "mobile", "Tab"), null);
  assert.equal(tabMove(ids, "mobile", "Enter"), null);
  assert.equal(shiftUtcDay("2026-10-18", -1), "2026-10-17");
  assert.equal(shiftUtcDay("2026-10-18", 1), "2026-10-19");
  assert.equal(shiftUtcDay("2026-03-01", -1), "2026-02-28");
  assert.equal(shiftUtcDay("nope", 1), "");
  assert.equal(oldestDailyDay("2026-10-18"), "2026-07-21");
  assert.equal(ratingPagePath({ mode: "mobile", page: 2 }), "/api/leaderboard?mode=mobile&limit=25&offset=25");
  assert.equal(dailyPagePath({ ladder: "cursor", day: "2026-10-17", page: 3 }), "/api/daily?ladder=cursor&limit=25&offset=50&day=2026-10-17");
  assert.equal(dailyPagePath({ ladder: "desktop", page: 1 }).includes("day="), false);
  assert.equal(pageTitle("ladder"), "Typing race, ladder");
  assert.equal(sessionShell({ session: "out", phase: "lobby", lobbyOpen: false, view: "ladder" }), "ladder");
  assert.equal(sessionShell({ session: "in", phase: "race", lobbyOpen: false, view: "ladder" }), "race");
  assert.equal(sessionShell({ session: "in", phase: "queue", lobbyOpen: true, view: "ladder" }), "queue");
  assert.equal(sessionShell({ session: "out", phase: "results", lobbyOpen: false, solo: true, view: "ladder" }), "ladder");
});

test("the ladder model hides filters the tables cannot answer", () => {
  const empty = ladderViewModel({ ...freshLadder(null), status: "empty", tab: "mobile" });
  assert.equal(empty.showLength, false);
  assert.equal(empty.showPeriod, false);
  assert.equal(empty.emptyText, "No rated races on this ladder yet.");
  assert.equal(empty.pageLabel, "Page 1 of 1.");
  assert.equal(empty.hasPrev, false);
  assert.equal(empty.hasNext, false);
  assert.equal(empty.jump, false);
  assert.equal(ladderViewModel(freshLadder(null)).caption, "Loading the ladder.");
  assert.equal(ladderViewModel(freshLadder(null)).busy, true);
  assert.deepEqual(empty.columns.map((column) => column.label), ["Rank", "Racer", "Rating", "Races", "Win rate"]);
  const daily = ladderViewModel({
    tab: "daily",
    page: 1,
    ladder: "mobile",
    day: "2026-07-21",
    status: "ready",
    error: "",
    data: {
      total: 3,
      day: "2026-07-21",
      serverNow: Date.parse("2026-10-18T12:00:00.000Z"),
      rows: [{ rank: 1, name: "Ada", wpm: 80.2, accuracy: 99.5 }],
      you: { rank: 2, name: "Bea" },
      around: [{ rank: 2, name: "Bea", self: true, wpm: 70, accuracy: 100 }],
    },
  });
  assert.equal(daily.showDay, true);
  assert.equal(daily.showLength, false);
  assert.equal(daily.dayPrevDisabled, true);
  assert.equal(daily.dayNextDisabled, false);
  assert.equal(daily.rows[0].primary, "80.2");
  assert.equal(daily.rows[0].secondary, "99.5%");
  assert.equal(daily.youText, "Your rank is 2.");
  assert.equal(daily.around[0].self, true);
  assert.deepEqual(daily.columns.map((column) => column.label), ["Rank", "Racer", "WPM", "Accuracy"]);
  const today = ladderViewModel({
    tab: "daily",
    page: 2,
    ladder: "desktop",
    day: "",
    status: "ready",
    data: {
      total: 40,
      day: "2026-10-18",
      serverNow: Date.parse("2026-10-18T12:00:00.000Z"),
      rows: [],
    },
  });
  assert.equal(today.dayNextDisabled, true);
  assert.equal(today.dayPrevDisabled, false);
  assert.equal(today.pageLabel, "Page 2 of 2, showing 26 to 40 of 40.");
  const rated = ladderViewModel({
    tab: "desktop",
    page: 1,
    status: "ready",
    data: {
      total: 1,
      rows: [{ rank: 1, name: "Ada", rating: 1100.4, races: 4, wins: 1, self: true }],
      you: { rank: 1 },
    },
  });
  assert.equal(rated.rows[0].primary, "1100");
  assert.equal(rated.rows[0].secondary, "4");
  assert.equal(rated.rows[0].extra, "25.0%");
  assert.equal(rated.rows[0].self, true);
  assert.equal(ladderAnnounce({ tab: "desktop", status: "loading" }), "Loading the ladder.");
  assert.equal(avatarDisc(0xffffff), null);
  assert.equal(avatarDisc(0x000000), "#000000");
  assert.equal(avatarDisc(0x4641d9), "#4641d9");
  assert.equal(avatarDisc(null), null);
});

test("paged elo rows stay stable across ties", async () => {
  const { env } = sqliteEnv();
  const field = [];
  field.push({ id: "9100001", username: "num", global_name: "Num", elo_desktop: 1700, races_desktop: 2, wins_desktop: 2, best_wpm_desktop: 90 });
  for (let i = 1; i <= 25; i += 1) {
    field.push({
      id: `p${String(i).padStart(2, "0")}`,
      username: "racer",
      global_name: `Racer ${i}`,
      elo_desktop: 1600,
      races_desktop: 2,
      wins_desktop: 1,
      best_wpm_desktop: 50,
    });
  }
  field.push({
    id: "user-secret",
    username: "ada",
    global_name: "Secret Racer",
    avatar: "abc123",
    elo_desktop: 1500,
    races_desktop: 4,
    wins_desktop: 1,
    best_wpm_desktop: 40,
  });
  field.push({ id: "tail-a", username: "racer", global_name: "Tail A", elo_desktop: 1400, races_desktop: 1, wins_desktop: 0, best_wpm_desktop: 10 });
  field.push({ id: "tail-b", username: "racer", global_name: "Tail B", elo_desktop: 1400, races_desktop: 1, wins_desktop: 0, best_wpm_desktop: null });
  field.push({ id: "tail-c", username: "racer", global_name: "Tail C", elo_desktop: 1400, races_desktop: 1, wins_desktop: 0, best_wpm_desktop: 10 });
  field.push({ id: "unranked", username: "racer", global_name: "Sitting out", elo_desktop: 5000, races_desktop: 0, wins_desktop: 0, best_wpm_desktop: 200 });
  for (const row of field) {
    await addUser(env, row.id, {
      username: row.username,
      globalName: row.global_name,
      avatar: row.avatar,
      elo: row.elo_desktop,
      races: row.races_desktop,
      wins: row.wins_desktop,
      best: row.best_wpm_desktop,
    });
  }
  const expected = field
    .filter((row) => row.races_desktop > 0)
    .sort((left, right) => compareBoard(left, right, "desktop"))
    .map((row) => row.id);
  const first = await leaderboard(env, "desktop", 25, 0);
  const second = await leaderboard(env, "desktop", 25, 25);
  const ids = [...first, ...second].map((row) => row.id);
  assert.deepEqual(ids, expected);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(first.at(-1).id, "p24");
  assert.equal(second[0].id, "p25");
  assert.equal(second[1].id, "user-secret");
  assert.equal(await leaderboardCount(env, "desktop"), expected.length);
  assert.equal(await leaderboardRank(env, "desktop", { id: "user-secret", elo_desktop: 1500, races_desktop: 4, best_wpm_desktop: 40 }), 27);
  assert.equal(await leaderboardRank(env, "desktop", { id: "unranked", elo_desktop: 5000, races_desktop: 0, best_wpm_desktop: 200 }), null);
  const past = await leaderboard(env, "desktop", 25, 100);
  assert.equal(past.length, 0);

  const anonymous = await board(new Request("https://typing.example/api/leaderboard?mode=desktop&limit=25&offset=0"), env);
  assert.equal(anonymous.status, 200);
  assert.match(anonymous.headers.get("cache-control"), /^public, max-age=30$/);
  const body = await anonymous.json();
  assert.equal(body.total, expected.length);
  assert.equal(body.hasMore, true);
  assert.equal("you" in body, false);
  assert.equal("around" in body, false);
  assert.equal(body.rows[0].name, "Num");
  assert.match(body.rows[0].avatar, /\/avatars\/5\.png$/);
  assert.equal(body.rows.some((row) => row.self), false);
  const packed = JSON.stringify(body);
  for (const row of field) assert.equal(packed.includes(row.id), false, row.id);

  const length = await board(new Request("https://typing.example/api/leaderboard?mode=desktop&length=sprint"), env);
  assert.equal(length.status, 400);
  assert.equal((await length.json()).error, "length");
  const unknownLength = await board(new Request("https://typing.example/api/leaderboard?mode=desktop&length=nope"), env);
  assert.equal((await unknownLength.json()).error, "length");
  const week = await board(new Request("https://typing.example/api/leaderboard?mode=desktop&period=week"), env);
  assert.equal((await week.json()).error, "period");
  const allTime = await board(new Request("https://typing.example/api/leaderboard?mode=desktop&period=all"), env);
  assert.equal(allTime.status, 200);

  const cookie = await sessionCookie(env, "user-secret");
  const signed = await board(new Request("https://typing.example/api/leaderboard?mode=desktop&limit=25&offset=0", {
    headers: { cookie },
  }), env);
  assert.match(signed.headers.get("cache-control"), /^private, max-age=30$/);
  const mine = await signed.json();
  assert.equal(mine.you.rank, 27);
  assert.equal(mine.you.self, true);
  assert.equal(mine.you.avatar, "https://fluxerusercontent.com/avatars/user-secret/abc123.png");
  assert.equal("id" in mine.you, false);
  assert.equal(mine.you.races, 4);
  assert.equal(mine.you.wins, 1);
  assert.deepEqual(mine.around.map((row) => row.rank), [25, 26, 27, 28, 29]);
  assert.equal(mine.around.find((row) => row.rank === 27).self, true);
  assert.equal(mine.around.find((row) => row.rank === 27).avatar, mine.you.avatar);
  assert.equal(mine.around.filter((row) => row.self).length, 1);
  const signedPacked = JSON.stringify(mine).replaceAll(mine.you.avatar, "");
  for (const row of field) assert.equal(signedPacked.includes(row.id), false, row.id);

  const idleCookie = await sessionCookie(env, "unranked");
  const idle = await board(new Request("https://typing.example/api/leaderboard?mode=mobile", {
    headers: { cookie: idleCookie },
  }), env);
  const idleBody = await idle.json();
  assert.equal(idleBody.total, 0);
  assert.equal(idleBody.hasMore, false);
  assert.equal(idleBody.rows.length, 0);
  assert.equal(idleBody.you.rank, null);
  assert.equal("around" in idleBody, false);
  assert.match(idle.headers.get("cache-control"), /private/);
});

test("daily pages keep a tied finish on one page", async () => {
  const { env } = sqliteEnv();
  const day = "2026-10-18";
  const now = Date.parse("2026-10-18T15:00:00.000Z");
  const rows = [
    { id: "secret-c", name: "Cee", wpm: 100, accuracy: 100, duration: 900, created: 5 },
    { id: "secret-a", name: "Ada", wpm: 100, accuracy: 100, duration: 1000, created: 1 },
    { id: "secret-b", name: "Bea", wpm: 100, accuracy: 100, duration: 1000, created: 2 },
    { id: "secret-d", name: "Dee", wpm: 100, accuracy: 90, duration: 1000, created: 1 },
    { id: "secret-e", name: "Eve", wpm: 90, accuracy: 100, duration: 1000, created: 1 },
    { id: "secret-f", name: "Fay", wpm: 80, accuracy: 100, duration: 1000, created: 1 },
  ];
  for (const row of rows) {
    await addUser(env, row.id, { username: row.id, globalName: row.name, avatar: "abc123", elo: 1000, races: 0 });
    await env.DB.prepare(
      `INSERT INTO daily_results (
         user_id, ladder, day, passage_id, wpm, accuracy, duration_ms, started_at, finished_at, created_at
       ) VALUES (?, 'desktop', ?, 'passage', ?, ?, ?, 1, 2, ?)`,
    ).bind(row.id, day, row.wpm, row.accuracy, row.duration, row.created).run();
  }
  const order = ["Cee", "Ada", "Bea", "Dee", "Eve", "Fay"];
  const pageOne = await loadDailyBoard(env, { ladder: "desktop", day, limit: 2, user: null, now });
  const pageTwo = await loadDailyBoard(env, { ladder: "desktop", day, limit: 2, offset: 2, user: null, now });
  const pageThree = await loadDailyBoard(env, { ladder: "desktop", day, limit: 2, offset: 4, user: null, now });
  assert.deepEqual(pageOne.rows.map((row) => row.name), order.slice(0, 2));
  assert.deepEqual(pageTwo.rows.map((row) => row.name), order.slice(2, 4));
  assert.deepEqual(pageThree.rows.map((row) => row.name), order.slice(4));
  assert.equal(pageOne.total, 6);
  assert.equal(pageOne.hasMore, true);
  assert.equal(pageTwo.hasMore, true);
  assert.equal(pageThree.hasMore, false);
  assert.equal(pageOne.you, null);
  assert.equal("around" in pageOne, false);
  const caller = { id: "secret-b", username: "secret-b", global_name: "Bea", avatar: "abc123" };
  const around = await loadDailyBoard(env, { ladder: "desktop", day, limit: 2, offset: 0, user: caller, now });
  assert.equal(around.you.rank, 3);
  assert.equal(around.you.avatar, "https://fluxerusercontent.com/avatars/secret-b/abc123.png");
  assert.deepEqual(around.around.map((row) => row.rank), [1, 2, 3, 4, 5]);
  assert.equal(around.around.find((row) => row.rank === 3).self, true);
  assert.equal(around.around.find((row) => row.rank === 1).avatar, "https://fluxerusercontent.com/avatars/secret-c/abc123.png");
  const packed = JSON.stringify(around).replace(/https:\/\/fluxerusercontent\.com\/avatars\/[^"\\]+/g, "");
  for (const row of rows) assert.equal(packed.includes(row.id), false, row.id);
  assert.equal(parseDailyQuery(query(""), now).offset, 0);
  assert.equal(parseDailyQuery(query("offset=10"), now).offset, 10);
  assert.equal(parseDailyQuery(query("offset=-1"), now).error, "offset");
  assert.equal(parseDailyQuery(query("offset=10001"), now).error, "offset");
  assert.equal(parseDailyQuery(query("offset=1.5"), now).error, "offset");
  assert.equal(DAILY_BOARD_MAX_OFFSET, 10_000);
});
