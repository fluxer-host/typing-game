import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { me } from "../src/api.js";
import { readSettingsColumn, upsertUser, writeSettingsColumn } from "../src/db.js";
import { board } from "../src/api.js";
import { publicPlayer } from "../src/profile.js";
import { signPayload } from "../src/session.js";
import { clearSettingsLimits } from "../src/settings-limit.js";
import { settingsGet, settingsPut } from "../src/settings-http.js";
import worker from "../src/index.js";
import {
  ACCOUNT_SETTINGS_KEY,
  GUEST_SETTINGS_KEY,
  SETTINGS_FAIL_MESSAGE,
  SETTINGS_FAIL_NOTICE_AFTER,
  SETTINGS_MAX_BYTES,
  SETTINGS_PUT_LIMIT,
  SETTINGS_SAVE_MS,
  SETTINGS_VERSION,
  crossTabAction,
  defaultSettings,
  freshSave,
  guestForUpload,
  liveFields,
  mergeOnSignIn,
  normalizeSettings,
  openingSettings,
  parseStoredSettings,
  raceInProgress,
  readGuestSettings,
  reduceSave,
  remoteIsNewer,
  settingsByteLength,
  settingsJson,
} from "../src/settings.js";

const INIT = readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8");
const DAILY_SQL = readFileSync(new URL("../migrations/0002_daily.sql", import.meta.url), "utf8");
const SETTINGS_SQL = readFileSync(new URL("../migrations/0003_settings.sql", import.meta.url), "utf8");
const SECRET = "test-session-secret";
const ORIGIN = "https://typing.example";

function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

function sqliteEnv() {
  const db = new DatabaseSync(":memory:");
  db.exec(INIT);
  db.exec(DAILY_SQL);
  db.exec(SETTINGS_SQL);
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

async function addUser(env, id, name = "Ada") {
  await env.DB.prepare(
    `INSERT INTO users (id, username, discriminator, global_name, avatar, avatar_color, created_at, updated_at)
     VALUES (?, ?, '0', ?, NULL, NULL, 1, 1)`,
  ).bind(id, name.toLowerCase(), name).run();
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

function putRequest(body, { cookie = "", origin = ORIGIN, type = "application/json" } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (origin) headers.origin = origin;
  if (type) headers["content-type"] = type;
  return new Request(`${ORIGIN}/api/settings`, {
    method: "PUT",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("settings constants and defaults stay small and versioned", () => {
  assert.equal(SETTINGS_VERSION, 1);
  assert.equal(SETTINGS_MAX_BYTES, 2048);
  assert.equal(SETTINGS_SAVE_MS, 500);
  assert.equal(SETTINGS_PUT_LIMIT, 30);
  const defaults = defaultSettings();
  assert.deepEqual(defaults, {
    v: 1,
    ladder: "desktop",
    length: "sprint",
    format: "passage",
    durationMs: 60000,
  });
  assert.ok(settingsByteLength(defaults) < SETTINGS_MAX_BYTES);
  assert.deepEqual(Object.keys(settingsJson(defaults) && normalizeSettings(defaults)), [
    "v",
    "ladder",
    "length",
    "format",
    "durationMs",
  ]);
});

test("validation drops unknown keys, rejects wrong types, and caps the stored size", () => {
  const huge = "x".repeat(SETTINGS_MAX_BYTES);
  const cleaned = normalizeSettings({
    v: "nope",
    ladder: "mobile",
    length: 3,
    format: "timed",
    durationMs: "30000",
    token: "secret",
    note: huge,
    html: "<script>alert(1)</script>",
  });
  assert.deepEqual(cleaned, {
    v: 1,
    ladder: "mobile",
    length: "sprint",
    format: "timed",
    durationMs: 60000,
  });
  assert.equal(JSON.stringify(cleaned).includes("secret"), false);
  assert.equal(JSON.stringify(cleaned).includes("<script>"), false);
  assert.ok(settingsByteLength(cleaned) < 200);
  assert.equal(normalizeSettings(["mobile"]).ladder, "desktop");
  assert.equal(normalizeSettings(null).format, "passage");
  assert.equal(normalizeSettings({ ladder: "cursor", format: "punctuation" }).format, "passage");
  assert.equal(normalizeSettings({ durationMs: 30000 }).durationMs, 30000);
  assert.equal(normalizeSettings({ durationMs: 45000 }).durationMs, 60000);
});

test("legacy objects migrate and a removed ladder falls back", () => {
  assert.deepEqual(normalizeSettings({ mode: "mobile", length: "long" }), {
    v: 1,
    ladder: "mobile",
    length: "long",
    format: "passage",
    durationMs: 60000,
  });
  assert.equal(normalizeSettings({ mode: "keyboard", ladder: "nope" }).ladder, "desktop");
  assert.deepEqual(normalizeSettings({ v: 1, ladder: "cursor", length: "set", format: "timed", timed: 120000 }), {
    v: 1,
    ladder: "cursor",
    length: "set",
    format: "timed",
    durationMs: 120000,
  });
  const storage = memoryStorage({
    tg_mode: "mobile",
    tg_length: "set",
    tg_format: "punctuation",
    tg_timed: "30000",
  });
  assert.equal(openingSettings(storage).ladder, "mobile");
  assert.equal(openingSettings(storage).format, "punctuation");
  assert.equal(openingSettings(storage).durationMs, 30000);
  storage.setItem(GUEST_SETTINGS_KEY, settingsJson({ ladder: "cursor", length: "long", format: "passage", durationMs: 120000 }));
  assert.equal(openingSettings(storage).ladder, "cursor");
  assert.equal(readGuestSettings(memoryStorage({ [GUEST_SETTINGS_KEY]: "{" })).ladder, "desktop");
  assert.equal(guestForUpload(memoryStorage()), null);
  assert.equal(guestForUpload(storage).ladder, "cursor");
});

test("the first sign-in uploads guest settings only when the server has none", () => {
  const guest = normalizeSettings({ ladder: "mobile", length: "long", format: "timed", durationMs: 30000 });
  const server = normalizeSettings({ ladder: "cursor", length: "set" });
  const fresh = mergeOnSignIn({ serverSaved: false, serverSettings: defaultSettings(), guest });
  assert.equal(fresh.upload, true);
  assert.equal(fresh.settings.ladder, "mobile");
  assert.equal(fresh.settings.durationMs, 30000);
  const kept = mergeOnSignIn({ serverSaved: true, serverSettings: server, guest });
  assert.equal(kept.upload, false);
  assert.equal(kept.settings.ladder, "cursor");
  const defaultsWin = mergeOnSignIn({ serverSaved: true, serverSettings: defaultSettings(), guest });
  assert.equal(defaultsWin.upload, false);
  assert.equal(defaultsWin.settings.ladder, "desktop");
  const empty = mergeOnSignIn({ serverSaved: false, serverSettings: null, guest: null });
  assert.equal(empty.upload, false);
  assert.deepEqual(empty.settings, defaultSettings());
  assert.equal(parseStoredSettings(null).saved, false);
  assert.equal(parseStoredSettings("{").saved, true);
  assert.equal(parseStoredSettings("{").settings.ladder, "desktop");
  assert.equal(parseStoredSettings(settingsJson(server)).saved, true);
  assert.equal(liveFields(guest).durationMs, 30000);
  assert.equal(liveFields(server).durationMs, 0);
});

test("debounce keeps the latest edit and a failed save waits before trying again", () => {
  let state = freshSave();
  let step = reduceSave(state, { type: "change", settings: { ladder: "mobile" }, now: 0 });
  state = step.state;
  assert.equal(step.send, null);
  assert.equal(state.dueAt, SETTINGS_SAVE_MS);
  step = reduceSave(state, { type: "change", settings: { ladder: "cursor" }, now: 200 });
  state = step.state;
  assert.equal(step.send, null);
  assert.equal(state.rev, 2);
  step = reduceSave(state, { type: "tick", now: SETTINGS_SAVE_MS + 199 });
  assert.equal(step.send, null);
  step = reduceSave(step.state, { type: "tick", now: SETTINGS_SAVE_MS + 200 });
  assert.equal(step.send.rev, 2);
  assert.equal(step.send.settings.ladder, "cursor");
  state = step.state;
  step = reduceSave(state, { type: "change", settings: { ladder: "desktop" }, now: 900 });
  state = step.state;
  assert.equal(step.send, null);
  step = reduceSave(state, { type: "ack", rev: 2, now: 1000 });
  assert.equal(step.send.rev, 3);
  assert.equal(step.send.settings.ladder, "desktop");
  state = step.state;
  step = reduceSave(state, { type: "ack", rev: 2, now: 1100 });
  assert.equal(step.send, null);
  step = reduceSave(step.state, { type: "fail", rev: 3, now: 1200 });
  state = step.state;
  assert.equal(step.announce, "");
  assert.equal(state.retryAt > 1200, true);
  for (let failure = 2; failure < SETTINGS_FAIL_NOTICE_AFTER; failure += 1) {
    state = { ...state, sendingRev: 3 };
    step = reduceSave(state, { type: "fail", rev: 3, now: 2000 + failure });
    state = step.state;
    assert.equal(step.announce, "");
  }
  state = { ...state, sendingRev: 3 };
  step = reduceSave(state, { type: "fail", rev: 3, now: 4000 });
  assert.equal(step.announce, SETTINGS_FAIL_MESSAGE);
  const early = freshSave();
  const armed = reduceSave(early, { type: "change", settings: { ladder: "mobile" }, now: 0 });
  const flushed = reduceSave(armed.state, { type: "flush", now: 10 });
  assert.equal(flushed.send.settings.ladder, "mobile");
  assert.equal(flushed.send.rev, 1);
});

test("another tab applies between races and an account change waits out the current race", () => {
  for (const phase of ["countdown", "race", "finishing", "queue", "room"]) {
    assert.equal(raceInProgress({ phase }), true, phase);
  }
  assert.equal(raceInProgress({ phase: "results" }), false);
  assert.equal(raceInProgress({ phase: "lobby" }), false);
  const same = { type: "account", accountId: "acct-a", settings: { ladder: "mobile" } };
  assert.equal(crossTabAction({ racing: true, signedIn: true, accountId: "acct-a", event: same }), "defer");
  assert.equal(crossTabAction({ racing: false, signedIn: true, accountId: "acct-a", event: same }), "apply");
  const other = { type: "account", accountId: "acct-b", settings: { ladder: "cursor" } };
  assert.equal(crossTabAction({ racing: true, signedIn: true, accountId: "acct-a", event: other }), "reload-later");
  assert.equal(crossTabAction({ racing: false, signedIn: true, accountId: "acct-a", event: other }), "reload");
  assert.equal(crossTabAction({ racing: false, signedIn: false, accountId: "", event: { type: "guest", settings: {} } }), "apply");
  assert.equal(crossTabAction({ racing: true, signedIn: false, accountId: "", event: { type: "guest", settings: {} } }), "defer");
  assert.equal(crossTabAction({ racing: false, signedIn: true, accountId: "acct-a", event: { type: "guest", settings: {} } }), "ignore");
  assert.equal(crossTabAction({
    racing: true,
    signedIn: true,
    accountId: "acct-a",
    event: { type: "signed-out", accountId: "acct-a" },
  }), "reload-later");
  assert.equal(crossTabAction({
    racing: false,
    signedIn: true,
    accountId: "acct-a",
    event: { type: "signed-out", accountId: "acct-a" },
  }), "reload");
  assert.equal(remoteIsNewer(100, 99), false);
  assert.equal(remoteIsNewer(100, 100), true);
  assert.equal(ACCOUNT_SETTINGS_KEY, "typing:v1:account-settings");
});

test("settings routes require a session, reject a bad body, and round-trip through D1", async () => {
  const { env, db } = sqliteEnv();
  const columns = db.prepare("PRAGMA table_info(users)").all();
  assert.equal(columns.some((column) => column.name === "settings" && column.notnull === 0), true);
  const userId = "acct-settings-1";
  await addUser(env, userId, "Ada One");
  const cookie = await sessionCookie(env, userId);

  const signedOut = await settingsGet(new Request(`${ORIGIN}/api/settings`), env);
  assert.equal(signedOut.status, 401);
  assert.equal(signedOut.headers.get("cache-control"), "no-store");
  assert.equal((await signedOut.json()).error, "unauthorized");

  const first = await settingsGet(new Request(`${ORIGIN}/api/settings`, { headers: { cookie } }), env);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("cache-control"), "no-store");
  assert.deepEqual(await first.json(), defaultSettings());

  const missingOrigin = await settingsPut(putRequest({ ladder: "mobile" }, { cookie, origin: "" }), env);
  assert.equal(missingOrigin.status, 403);
  const foreign = await settingsPut(putRequest({ ladder: "mobile" }, { cookie, origin: "https://evil.example" }), env);
  assert.equal(foreign.status, 403);
  assert.equal(await readSettingsColumn(env, userId), null);

  const tooBig = await settingsPut(putRequest("x".repeat(SETTINGS_MAX_BYTES + 1), { cookie }), env);
  assert.equal(tooBig.status, 413);
  const notJson = await settingsPut(putRequest("{", { cookie }), env);
  assert.equal(notJson.status, 400);
  const list = await settingsPut(putRequest("[]", { cookie }), env);
  assert.equal(list.status, 400);
  const emptyType = await settingsPut(putRequest({ ladder: "mobile" }, { cookie, type: "" }), env);
  assert.equal(emptyType.status, 400);
  const anonymous = await settingsPut(putRequest({ ladder: "mobile" }), env);
  assert.equal(anonymous.status, 401);

  const saved = await settingsPut(putRequest({
    ladder: "mobile",
    length: "long",
    format: "timed",
    durationMs: 30000,
    token: userId,
    extra: "<b>no</b>",
  }, { cookie }), env);
  assert.equal(saved.status, 200);
  assert.equal(saved.headers.get("cache-control"), "no-store");
  const body = await saved.json();
  assert.deepEqual(body, {
    v: 1,
    ladder: "mobile",
    length: "long",
    format: "timed",
    durationMs: 30000,
  });
  assert.equal(JSON.stringify(body).includes(userId), false);
  const again = await settingsGet(new Request(`${ORIGIN}/api/settings`, { headers: { cookie } }), env);
  assert.deepEqual(await again.json(), body);

  const profile = await me(new Request(`${ORIGIN}/api/me`, { headers: { cookie } }), env);
  const meBody = await profile.json();
  assert.equal(meBody.settingsSaved, true);
  assert.deepEqual(meBody.settings, body);
  assert.equal(Object.hasOwn(meBody.user, "settings"), false);
  assert.equal(meBody.user.id, userId);
  const player = publicPlayer({ id: userId, username: "ada", settings: settingsJson(body) }, env);
  assert.equal(Object.hasOwn(player, "settings"), false);

  await upsertUser(env, { id: userId, username: "ada", discriminator: "0", global_name: "Ada One" });
  assert.equal(await readSettingsColumn(env, userId), settingsJson(body));

  const listed = await board(new Request(`${ORIGIN}/api/leaderboard?mode=desktop`, { headers: { cookie } }), env);
  const boardBody = await listed.json();
  assert.equal(Object.hasOwn(boardBody, "settings"), false);
  assert.equal(JSON.stringify(boardBody).includes("30000"), false);
  assert.equal(JSON.stringify(boardBody).includes(userId), false);

  const routed = await worker.fetch(new Request(`${ORIGIN}/api/settings`, { headers: { cookie } }), env);
  assert.equal(routed.status, 200);
  assert.deepEqual(await routed.json(), body);

  await writeSettingsColumn(env, userId, "{");
  const recovered = await settingsGet(new Request(`${ORIGIN}/api/settings`, { headers: { cookie } }), env);
  const fallback = await recovered.json();
  assert.equal(fallback.ladder, "desktop");
  const brokenMe = await me(new Request(`${ORIGIN}/api/me`, { headers: { cookie } }), env);
  const brokenBody = await brokenMe.json();
  assert.equal(brokenBody.settingsSaved, true);
  assert.equal(brokenBody.settings.ladder, "desktop");
});

test("a settings write is limited per account", async () => {
  clearSettingsLimits();
  const { env } = sqliteEnv();
  const userId = "acct-settings-limit";
  await addUser(env, userId, "Bea Two");
  const cookie = await sessionCookie(env, userId);
  for (let i = 0; i < SETTINGS_PUT_LIMIT; i += 1) {
    const response = await settingsPut(putRequest({ ladder: i % 2 ? "mobile" : "desktop" }, { cookie }), env);
    assert.equal(response.status, 200, String(i));
  }
  const limited = await settingsPut(putRequest({ ladder: "cursor" }, { cookie }), env);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("cache-control"), "no-store");
});
