import { createSession, deleteSession, upsertUser } from "./db.js";
import { json, redirect, sameOrigin } from "./http.js";
import { publicPlayer } from "./profile.js";
import {
  clearOauthCookie,
  clearSessionCookie,
  codeChallenge,
  oauthCookie,
  randomToken,
  readCookie,
  readPayload,
  secretOk,
  sessionCookie,
  signPayload,
} from "./session.js";
import { resolveUser } from "./identity.js";

const PALETTE = [0x4641d9, 0x7d7bff, 0x3dd68c, 0xe6b450, 0xff5d73, 0x5cc8ff];

function apiBase(env) {
  return String(env.FLUXER_API || "https://api.fluxer.app").replace(/\/$/, "");
}

export function redirectUri(request, env) {
  if (env.FLUXER_REDIRECT_URI) return String(env.FLUXER_REDIRECT_URI).trim();
  return `${new URL(request.url).origin}/auth/callback`;
}

function oauthReady(env) {
  return Boolean(env.FLUXER_CLIENT_ID && env.FLUXER_CLIENT_SECRET);
}

export async function login(request, env) {
  if (!secretOk(env)) return json({ error: "session_secret_missing" }, { status: 500 });
  if (!oauthReady(env)) return redirect("/?auth_error=not_configured");
  const state = randomToken(16);
  const verifier = randomToken(32);
  const challenge = await codeChallenge(verifier);
  const redirectTo = redirectUri(request, env);
  const token = await signPayload({ state, verifier, redirect: redirectTo, exp: Date.now() + 10 * 60 * 1000 }, env.SESSION_SECRET);
  const authorize = new URL(`${apiBase(env)}/v1/oauth2/authorize`);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", env.FLUXER_CLIENT_ID);
  authorize.searchParams.set("redirect_uri", redirectTo);
  authorize.searchParams.set("scope", "identify");
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  return redirect(authorize.toString(), [oauthCookie(token, request)]);
}

export async function callback(request, env) {
  const url = new URL(request.url);
  const fail = (code) => redirect(`/?auth_error=${code}`, [clearOauthCookie(request)]);
  if (!secretOk(env) || !oauthReady(env)) return fail("not_configured");
  if (url.searchParams.get("error")) return fail("denied");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return fail("denied");
  const pending = await readPayload(readCookie(request, "tg_oauth") || "", env.SESSION_SECRET);
  if (!pending || pending.state !== state || !pending.verifier || !pending.redirect) return fail("state");

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: pending.redirect,
    client_id: env.FLUXER_CLIENT_ID,
    client_secret: env.FLUXER_CLIENT_SECRET,
    code_verifier: pending.verifier,
  });
  let tokenResponse;
  try {
    tokenResponse = await fetch(`${apiBase(env)}/v1/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch (error) {
    console.error("oauth token fetch failed", error);
    return fail("token");
  }
  if (!tokenResponse.ok) {
    console.error("oauth token rejected", tokenResponse.status);
    return fail("token");
  }
  const issued = await tokenResponse.json();
  if (!issued.access_token) return fail("token");

  const profileResponse = await fetch(`${apiBase(env)}/v1/oauth2/userinfo`, {
    headers: { authorization: `Bearer ${issued.access_token}` },
  });
  if (!profileResponse.ok) return fail("profile");
  const profile = await profileResponse.json();
  if (profile.bot) return fail("bot");
  const id = String(profile.id || profile.sub || "");
  if (!/^\d{2,32}$/.test(id) || !profile.username) return fail("profile");

  const user = await upsertUser(env, {
    id,
    username: String(profile.username).slice(0, 32),
    discriminator: String(profile.discriminator ?? "0").slice(0, 8),
    global_name: profile.global_name ? String(profile.global_name).slice(0, 64) : null,
    avatar: profile.avatar ? String(profile.avatar).slice(0, 64) : null,
    avatar_color: Number.isFinite(Number(profile.avatar_color)) ? Number(profile.avatar_color) : null,
  });
  const session = await createSession(env, user.id, issued.refresh_token || null);
  const cookie = await signPayload({ sid: session.id, exp: session.expiresAt }, env.SESSION_SECRET);
  return redirect("/", [sessionCookie(cookie, request), clearOauthCookie(request)]);
}

function cleanName(raw) {
  const name = String(raw || "").trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 24) return null;
  if (!/^[\p{L}\p{N} ._-]+$/u.test(name)) return null;
  return name;
}

export async function devLogin(request, env) {
  if (env.ALLOW_DEV_LOGIN !== "true") return json({ error: "disabled" }, { status: 404 });
  if (!sameOrigin(request)) return json({ error: "origin" }, { status: 403 });
  if (!secretOk(env)) return json({ error: "session_secret_missing" }, { status: 500 });
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "name" }, { status: 400 });
  }
  const name = cleanName(body?.name);
  if (!name) return json({ error: "name" }, { status: 400 });
  const stamp = randomToken(9);
  const ascii = name.normalize("NFKD").replace(/[^A-Za-z0-9]+/g, "").slice(0, 16);
  const bytes = new Uint8Array(1);
  crypto.getRandomValues(bytes);
  const user = await upsertUser(env, {
    id: `dev_${stamp}`,
    username: ascii || "racer",
    discriminator: "0",
    global_name: name,
    avatar: null,
    avatar_color: PALETTE[bytes[0] % PALETTE.length],
  });
  const session = await createSession(env, user.id, null);
  const cookie = await signPayload({ sid: session.id, exp: session.expiresAt }, env.SESSION_SECRET);
  return json({ user: publicPlayer(user, env) }, { cookies: [sessionCookie(cookie, request)] });
}

export async function logout(request, env) {
  if (!sameOrigin(request)) return json({ error: "origin" }, { status: 403 });
  const resolved = await resolveUser(request, env);
  if (resolved?.session) {
    await deleteSession(env, resolved.session.id);
    if (resolved.session.refresh_token && oauthReady(env)) {
      const body = new URLSearchParams({
        token: resolved.session.refresh_token,
        token_type_hint: "refresh_token",
        client_id: env.FLUXER_CLIENT_ID,
        client_secret: env.FLUXER_CLIENT_SECRET,
      });
      try {
        await fetch(`${apiBase(env)}/v1/oauth2/token/revoke`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body,
        });
      } catch (error) {
        console.error("oauth revoke failed", error);
      }
    }
  }
  return json({ ok: true }, { cookies: [clearSessionCookie(request)] });
}
