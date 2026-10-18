// Share links. POST /api/share signs a card. GET /s/<token> renders it.
// Nothing new is stored. A missing signing secret fails closed.

import { json, sameOrigin } from "./http.js";
import { resolveUser } from "./identity.js";
import { allowShare } from "./share-limit.js";
import { renderCardPng } from "./share-png.js";
import {
  SHARE_CACHE,
  cardSvg,
  securityHeaders,
  shareDescription,
  sharePage,
  shareTitle,
} from "./share-card.js";
import { cardFromPractice, cardFromSavedRace } from "./share-record.js";
import { encodeShareToken, readShareToken, shareEnabled, shareSecrets } from "./share-token.js";

const assetBytesCache = new Map();
let cssHref = "";
let wasmModulePromise = null;

function loadWasmModule() {
  if (!wasmModulePromise) {
    wasmModulePromise = import("./share-wasm.js").then((mod) => mod.default).catch((error) => {
      wasmModulePromise = null;
      throw error;
    });
  }
  return wasmModulePromise;
}

export async function shareIssue(request, env, deps = {}) {
  if (!shareEnabled(env)) return json({ error: "share_unavailable" }, { status: 503 });
  const origin = request.headers.get("origin");
  if (!origin || !sameOrigin(request)) return json({ error: "origin" }, { status: 403 });
  let body;
  try {
    const text = await request.text();
    if (text.length > 2000) return json({ error: "share" }, { status: 400 });
    body = JSON.parse(text);
  } catch {
    return json({ error: "share" }, { status: 400 });
  }
  const lookup = deps.resolveUser || resolveUser;
  const load = deps.loadRace || loadSavedRace;
  const resolved = await lookup(request, env);
  const user = resolved?.user || null;
  const key = user?.id ? `user:${user.id}` : `ip:${clientIp(request)}`;
  if (!allowShare(key)) return json({ error: "limit" }, { status: 429 });
  let card = null;
  if (body?.raceId) {
    if (!user) return json({ error: "unauthorized" }, { status: 401 });
    if (typeof body.raceId !== "string" || !/^[0-9a-f-]{36}$/i.test(body.raceId)) {
      return json({ error: "race" }, { status: 400 });
    }
    const row = await load(env, body.raceId, user.id);
    if (!row || row.ms == null) return json({ error: "race" }, { status: 404 });
    card = cardFromSavedRace(row, user, Boolean(body.showName));
  } else if (body?.kind === "practice") {
    card = cardFromPractice(body, user);
  }
  if (!card) return json({ error: "share" }, { status: 400 });
  const token = await encodeShareToken(card, shareSecrets(env).current);
  if (!token) return json({ error: "share_unavailable" }, { status: 503 });
  const root = new URL(request.url).origin;
  return json({
    url: `${root}/s/${token}`,
    image: `${root}/s/${token}/card.png`,
    title: shareTitle(card),
    text: shareDescription(card),
  });
}

export async function loadSavedRace(env, raceId, userId) {
  const row = await env.DB.prepare(
    `SELECT r.mode, r.sentence, r.ranked, r.finished_at,
            rr.place, rr.wpm, rr.accuracy, rr.ms,
            (SELECT COUNT(*) FROM race_results c WHERE c.race_id = r.id) AS racers
     FROM race_results rr
     JOIN races r ON r.id = rr.race_id
     WHERE r.id = ? AND rr.user_id = ?`,
  )
    .bind(raceId, userId)
    .first();
  return row || null;
}

function clientIp(request) {
  const header = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "local";
  return header.split(",")[0].trim().slice(0, 80) || "local";
}

export async function shareGet(request, env) {
  const url = new URL(request.url);
  const parsed = parseSharePath(url.pathname);
  if (!parsed) return notFound(request, env);
  const card = await readShareToken(parsed.token, shareSecrets(env));
  if (!card) return notFound(request, env);
  if (parsed.image) return shareImage(request, env, card);
  return shareHtml(request, env, card, parsed.token);
}

function parseSharePath(pathname) {
  if (!pathname.startsWith("/s/")) return null;
  let rest = pathname.slice(3);
  let image = false;
  if (rest.endsWith("/card.png")) {
    image = true;
    rest = rest.slice(0, -"/card.png".length);
  }
  if (!rest || rest.includes("/")) return null;
  return { token: rest, image };
}

async function shareHtml(request, env, card, token) {
  const stylesheet = await stylesheetPath(request, env);
  const html = sharePage({
    card,
    origin: new URL(request.url).origin,
    token,
    stylesheet,
  });
  const headers = securityHeaders(SHARE_CACHE);
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("x-robots-tag", "noindex");
  if (request.method === "HEAD") return new Response(null, { status: 200, headers });
  return new Response(html, { status: 200, headers });
}

async function shareImage(request, env, card) {
  try {
    const response = await cachedImage(request, async () => {
      const [wasm, regular, bold] = await Promise.all([
        loadWasmModule(),
        fontBytes(request, env, "/fonts/LiberationSans-Regular.ttf"),
        fontBytes(request, env, "/fonts/LiberationSans-Bold.ttf"),
      ]);
      if (!wasm || !regular || !bold) {
        const headers = securityHeaders("no-store");
        headers.set("content-type", "text/plain; charset=utf-8");
        return new Response("The result image is unavailable.", { status: 503, headers });
      }
      const rendered = await renderCardPng(cardSvg(card), { wasm, regular, bold });
      const headers = securityHeaders(SHARE_CACHE);
      headers.set("content-type", "image/png");
      return new Response(rendered.png, { status: 200, headers });
    });
    if (request.method === "HEAD") return new Response(null, { status: response.status, headers: response.headers });
    return response;
  } catch (error) {
    console.error("share image failed", error);
    const headers = securityHeaders("no-store");
    headers.set("content-type", "text/plain; charset=utf-8");
    return new Response("The result image is unavailable.", { status: 503, headers });
  }
}

async function cachedImage(request, create) {
  const cache = globalThis.caches?.default;
  const key = new Request(new URL(request.url).toString(), { method: "GET" });
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) return hit;
    } catch {
      // The cache is a fast path. A miss still renders.
    }
  }
  const response = await create();
  if (cache && response.ok) {
    try {
      await cache.put(key, response.clone());
    } catch {
      // Local dev can refuse a cache write. The response is still valid.
    }
  }
  return response;
}

async function notFound(request, env) {
  const headers = securityHeaders("no-store");
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("x-robots-tag", "noindex");
  if (env.ASSETS?.fetch) {
    const url = new URL(request.url);
    url.pathname = "/404.html";
    url.search = "";
    try {
      const asset = await env.ASSETS.fetch(new Request(url, { method: "GET" }));
      if (asset.status === 200 || asset.status === 404) {
        const type = asset.headers.get("content-type");
        if (type) headers.set("content-type", type);
        if (request.method === "HEAD") return new Response(null, { status: 404, headers });
        return new Response(asset.body, { status: 404, headers });
      }
    } catch (error) {
      console.error("share 404 page failed", error);
    }
  }
  if (request.method === "HEAD") return new Response(null, { status: 404, headers });
  return new Response("not found", { status: 404, headers });
}

async function readAsset(request, env, pathname) {
  if (assetBytesCache.has(pathname)) return assetBytesCache.get(pathname);
  if (!env.ASSETS?.fetch) return null;
  const url = new URL(request.url);
  url.pathname = pathname;
  url.search = "";
  const response = await env.ASSETS.fetch(new Request(url, { method: "GET" }));
  if (!response.ok) return null;
  const bytes = new Uint8Array(await response.arrayBuffer());
  assetBytesCache.set(pathname, bytes);
  return bytes;
}

async function fontBytes(request, env, pathname) {
  const bytes = await readAsset(request, env, pathname);
  if (!bytes || bytes.length < 100) {
    assetBytesCache.delete(pathname);
    return null;
  }
  return bytes;
}

async function stylesheetPath(request, env) {
  if (cssHref) return cssHref;
  const bytes = await readAsset(request, env, "/index.html");
  if (!bytes) return "";
  const html = new TextDecoder().decode(bytes);
  const match = html.match(/href="(\/a\/styles\.[a-f0-9]{8}\.css)"/);
  cssHref = match ? match[1] : "";
  return cssHref;
}
