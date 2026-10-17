import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { boardEntry, compareBoard, parseBoardQuery, placedRank } from "../src/board.js";
import { allowedOriginList, websocketOriginAllowed } from "../src/origin.js";
import {
  PROGRESS_CHECKPOINT_MS,
  RACE_RETAIN_MS,
  WAKE_SYNC_MS,
  raceReadyToPurge,
  recoverableGap,
  rematchExpired,
  sessionExpired,
  shouldWriteProgress,
} from "../src/retention.js";
import { openToken, sealToken } from "../src/token-box.js";

const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const api = readFileSync(new URL("../src/api.js", import.meta.url), "utf8");
const db = readFileSync(new URL("../src/db.js", import.meta.url), "utf8");
const race = readFileSync(new URL("../src/race.js", import.meta.url), "utf8");
const wrangler = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");

function query(search) {
  return new URLSearchParams(search);
}

test("leaderboard query rejects a missing, unknown, or oversized page", () => {
  assert.deepEqual(parseBoardQuery(query("mode=desktop")), { ok: true, mode: "desktop", limit: 25, offset: 0 });
  assert.deepEqual(parseBoardQuery(query("mode=cursor&limit=10&offset=25")), { ok: true, mode: "cursor", limit: 10, offset: 25 });
  assert.equal(parseBoardQuery(query("")).ok, false);
  assert.equal(parseBoardQuery(query("mode=Desktop")).error, "mode");
  assert.equal(parseBoardQuery(query("mode=keyboard")).error, "mode");
  assert.equal(parseBoardQuery(query("mode=desktop&limit=0")).error, "limit");
  assert.equal(parseBoardQuery(query("mode=desktop&limit=101")).error, "limit");
  assert.equal(parseBoardQuery(query("mode=desktop&limit=1.5")).error, "limit");
  assert.equal(parseBoardQuery(query("mode=desktop&limit=-1")).error, "limit");
  assert.equal(parseBoardQuery(query("mode=desktop&offset=-1")).error, "offset");
  assert.equal(parseBoardQuery(query("mode=desktop&offset=10001")).error, "offset");
  assert.equal(parseBoardQuery(query("mode=desktop&offset=nope")).error, "offset");
});

test("a ladder row keeps the display fields and drops the account id", () => {
  const user = {
    id: "123456789",
    username: "ada",
    discriminator: "0042",
    global_name: "Ada Lovelace",
    avatar: "a_secret",
    elo_desktop: 1200,
    races_desktop: 4,
    wins_desktop: 2,
    best_wpm_desktop: 90,
    elo_mobile: 1400,
  };
  const row = boardEntry(user, "desktop", 3);
  assert.deepEqual(row, { rank: 3, name: "Ada Lovelace", rating: 1200, races: 4, wins: 2 });
  assert.equal(Object.hasOwn(row, "id"), false);
  assert.equal(Object.hasOwn(row, "tag"), false);
  assert.equal(Object.hasOwn(row, "avatar"), false);
  assert.equal(JSON.stringify(row).includes("123456789"), false);
  assert.equal(JSON.stringify(row).includes("1400"), false);
});

test("rank follows elo, then best, then id, and skips an unraced player", () => {
  const field = [
    { id: "b", elo_desktop: 1100, races_desktop: 2, wins_desktop: 1, best_wpm_desktop: 80 },
    { id: "a", elo_desktop: 1100, races_desktop: 3, wins_desktop: 1, best_wpm_desktop: 80 },
    { id: "c", elo_desktop: 1100, races_desktop: 1, wins_desktop: 0, best_wpm_desktop: null },
    { id: "d", elo_desktop: 900, races_desktop: 1, wins_desktop: 0, best_wpm_desktop: 200 },
    { id: "e", elo_desktop: 2000, races_desktop: 0, wins_desktop: 0, best_wpm_desktop: 200 },
  ];
  const ordered = field.filter((row) => row.races_desktop > 0).sort((left, right) => compareBoard(left, right, "desktop"));
  assert.deepEqual(ordered.map((row) => row.id), ["a", "b", "c", "d"]);
  assert.equal(placedRank(field[1], field, "desktop"), 1);
  assert.equal(placedRank(field[0], field, "desktop"), 2);
  assert.equal(placedRank(field[2], field, "desktop"), 3);
  assert.equal(placedRank(field[4], field, "desktop"), null);
});

test("refresh tokens round-trip and plaintext rows stay readable", async () => {
  const secret = "abcdefghijklmnopqrstuvwxyz012345";
  const sealed = await sealToken("refresh-token-value", secret);
  assert.equal(sealed.startsWith("v1:"), true);
  assert.equal(sealed.includes("refresh-token-value"), false);
  const opened = await openToken(sealed, secret);
  assert.deepEqual(opened, { token: "refresh-token-value", legacy: false });
  assert.deepEqual(await openToken("legacy-token", secret), { token: "legacy-token", legacy: true });
  assert.deepEqual(await openToken(sealed, "different-key-that-is-long"), { token: null, legacy: false });
  assert.deepEqual(await openToken(sealed, null), { token: null, legacy: false });
  assert.deepEqual(await openToken("v1:not-valid", secret), { token: null, legacy: false });
  assert.deepEqual(await openToken("", secret), { token: null, legacy: false });
  assert.equal(await sealToken("", secret), null);
  assert.equal(await sealToken("refresh-token-value", "short"), null);
});

test("websocket origin allows this host and a configured extra", () => {
  const url = "https://typing.fluxer.my/ws";
  assert.deepEqual(allowedOriginList(url, " https://preview.example ,"), [
    "https://typing.fluxer.my",
    "https://preview.example",
  ]);
  assert.equal(websocketOriginAllowed("https://typing.fluxer.my", url, ""), true);
  assert.equal(websocketOriginAllowed("https://preview.example", url, "https://preview.example"), true);
  assert.equal(websocketOriginAllowed("https://evil.example", url, "https://preview.example"), false);
  assert.equal(websocketOriginAllowed(null, url, ""), false);
  assert.equal(websocketOriginAllowed("", url, ""), false);
  assert.equal(websocketOriginAllowed("https://typing.fluxer.my", "not a url", ""), false);
});

test("progress writes, wake gaps, and retention deadlines", () => {
  const base = { now: 10_000, lastWrite: 9_000, checkpointMs: PROGRESS_CHECKPOINT_MS, dirty: true };
  assert.equal(shouldWriteProgress({ ...base, reason: "progress" }), false);
  assert.equal(shouldWriteProgress({ ...base, reason: "progress", now: 11_000 }), true);
  assert.equal(shouldWriteProgress({ ...base, reason: "progress", dirty: false, now: 20_000 }), false);
  assert.equal(shouldWriteProgress({ ...base, reason: "finish" }), true);
  assert.equal(shouldWriteProgress({ ...base, reason: "forfeit", dirty: false }), true);
  assert.equal(shouldWriteProgress({ ...base, reason: "start" }), true);
  assert.equal(shouldWriteProgress({ ...base, reason: "other" }), false);

  const gap = { previous: "The", next: "The quick", bootedAgeMs: 1000, checkpointMs: PROGRESS_CHECKPOINT_MS, wakeMs: WAKE_SYNC_MS };
  assert.equal(recoverableGap(gap), true);
  assert.equal(recoverableGap({ ...gap, next: "he quick" }), false);
  assert.equal(recoverableGap({ ...gap, next: "Then" }), false);
  assert.equal(recoverableGap({ ...gap, bootedAgeMs: WAKE_SYNC_MS + 1 }), false);
  assert.equal(recoverableGap({ ...gap, next: `The ${"x".repeat(80)}` }), false);

  assert.equal(sessionExpired(999, 1000), true);
  assert.equal(sessionExpired(1000, 1000), false);
  assert.equal(sessionExpired("nope", 1000), true);
  assert.equal(rematchExpired({ until: 50 }, 50), true);
  assert.equal(rematchExpired({ until: 51 }, 50), false);
  assert.equal(rematchExpired(null, 50), true);

  const kept = { results: { cancelled: false }, saved: true, purgeAt: 5000 };
  assert.equal(raceReadyToPurge(kept, 4999), false);
  assert.equal(raceReadyToPurge(kept, 5000), true);
  assert.equal(raceReadyToPurge({ results: { cancelled: false }, saved: false, purgeAt: 1 }, 10), false);
  assert.equal(raceReadyToPurge({ results: { cancelled: true }, saved: false, purgeAt: 1 }, 10), true);
  assert.equal(raceReadyToPurge({ results: null, saved: true, purgeAt: 1 }, 10), false);
  assert.equal(RACE_RETAIN_MS, 120_000);
});

test("the public ladder and the cron are wired without storing progress on every key", () => {
  assert.match(api, /parseBoardQuery/);
  assert.match(api, /private, max-age=/);
  assert.match(api, /public, max-age=/);
  assert.equal(api.includes("publicPlayer(row"), false);
  assert.match(db, /LIMIT \? OFFSET \?/);
  assert.match(db, /SELECT id, username, global_name/);
  assert.equal(/SELECT \* FROM users\s+WHERE \$\{cols\.races\}/.test(db), false);
  assert.match(race, /noteProgress\("progress"/);
  assert.match(race, /schedulePurge/);
  assert.match(wrangler, /"crons": \["17 \* \* \* \*"\]/);
  assert.match(app, /row\.rating/);
  assert.match(app, /row\.rank/);
});
