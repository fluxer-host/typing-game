// HTTP for the daily challenge. Ranked matchmaking does not call these routes.

import {
  DAILY_CACHE_SECONDS,
  DAILY_MAX_BODY_CHARS,
  parseDailyQuery,
  parseSubmitBody,
} from "./daily.js";
import { loadDailyBoard, startDailyAttempt, submitDailyAttempt } from "./daily-store.js";
import { json, sameOrigin } from "./http.js";
import { resolveUser } from "./identity.js";
import { isMode } from "./modes.js";

async function readJson(request, maxChars) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxChars) return { ok: false, error: "body" };
  let raw = "";
  try {
    raw = await request.text();
  } catch {
    return { ok: false, error: "body" };
  }
  if (raw.length > maxChars) return { ok: false, error: "body" };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, error: "body" };
  }
}

export async function dailyBoard(request, env, now = Date.now()) {
  const url = new URL(request.url);
  const parsed = parseDailyQuery(url.searchParams, now);
  if (!parsed.ok) return json({ error: parsed.error }, { status: 400 });
  const resolved = await resolveUser(request, env);
  const body = await loadDailyBoard(env, {
    ladder: parsed.ladder,
    day: parsed.day,
    limit: parsed.limit,
    offset: parsed.offset,
    user: resolved?.user || null,
    now,
  });
  const cache = resolved
    ? `private, max-age=${DAILY_CACHE_SECONDS}`
    : `public, max-age=${DAILY_CACHE_SECONDS}`;
  return json(body, { cache });
}

export async function dailyStart(request, env, now = Date.now()) {
  if (!sameOrigin(request)) return json({ error: "origin" }, { status: 403 });
  const resolved = await resolveUser(request, env);
  if (!resolved?.user) return json({ error: "unauthorized" }, { status: 401 });
  const body = await readJson(request, 2_000);
  if (!body.ok) return json({ error: body.error }, { status: 400 });
  const ladder = body.value?.ladder;
  if (!isMode(ladder)) return json({ error: "ladder" }, { status: 400 });
  const outcome = await startDailyAttempt(env, { user: resolved.user, ladder, now });
  return json(outcome.body, { status: outcome.status });
}

export async function dailySubmit(request, env, now = Date.now()) {
  if (!sameOrigin(request)) return json({ error: "origin" }, { status: 403 });
  const resolved = await resolveUser(request, env);
  if (!resolved?.user) return json({ error: "unauthorized" }, { status: 401 });
  const body = await readJson(request, DAILY_MAX_BODY_CHARS);
  if (!body.ok) return json({ error: body.error }, { status: 400 });
  const parsed = parseSubmitBody(body.value);
  if (!parsed.ok) return json({ error: parsed.error }, { status: 400 });
  const outcome = await submitDailyAttempt(env, {
    user: resolved.user,
    attemptId: parsed.attemptId,
    steps: parsed.steps,
    now,
  });
  return json(outcome.body, { status: outcome.status });
}
