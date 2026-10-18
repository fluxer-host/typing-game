import { board, config, health, me, races } from "./api.js";
import { callback, devLogin, login, logout } from "./auth.js";
import { dailyBoard, dailyStart, dailySubmit } from "./daily-http.js";
import { purgeDaily } from "./daily-store.js";
import { purgeExpiredSessions } from "./db.js";
import { json } from "./http.js";
import { Lobby } from "./lobby.js";
import { websocketOriginAllowed } from "./origin.js";
import { Race } from "./race.js";

export { Lobby, Race };

async function websocket(request, env) {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return json({ error: "expected_websocket" }, { status: 426 });
  }
  if (!websocketOriginAllowed(request.headers.get("origin"), request.url, env.ALLOWED_ORIGINS)) {
    return json({ error: "origin" }, { status: 403 });
  }
  const raceId = new URL(request.url).searchParams.get("race");
  if (raceId) {
    if (!/^[0-9a-f-]{36}$/i.test(raceId)) return json({ error: "race" }, { status: 400 });
    return env.RACE.get(env.RACE.idFromName(raceId)).fetch(request);
  }
  return env.LOBBY.get(env.LOBBY.idFromName("global")).fetch(request);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (request.method === "GET" && path === "/api/health") return health(env);
      if (request.method === "GET" && path === "/api/config") return config(env);
      if (request.method === "GET" && path === "/api/me/races") return races(request, env);
      if (request.method === "GET" && path === "/api/me") return me(request, env);
      if (request.method === "GET" && path === "/api/leaderboard") return board(request, env);
      if (request.method === "GET" && path === "/api/daily") return dailyBoard(request, env);
      if (request.method === "POST" && path === "/api/daily/start") return dailyStart(request, env);
      if (request.method === "POST" && path === "/api/daily/submit") return dailySubmit(request, env);
      if (request.method === "GET" && path === "/auth/login") return login(request, env);
      if (request.method === "GET" && path === "/auth/callback") return callback(request, env);
      if (request.method === "POST" && path === "/auth/logout") return logout(request, env);
      if (request.method === "POST" && path === "/auth/dev") return devLogin(request, env);
      if (path === "/ws") return websocket(request, env);
      if (path.startsWith("/api/") || path.startsWith("/auth/")) return json({ error: "not_found" }, { status: 404 });
      if ((request.method === "GET" || request.method === "HEAD") && path === "/index.html") {
        return new Response(null, {
          status: 301,
          headers: { location: "/", "cache-control": "public, max-age=3600" },
        });
      }
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return new Response("not found", { status: 404 });
    } catch (error) {
      console.error(error);
      return json({ error: "server_error" }, { status: 500 });
    }
  },

  async scheduled(_controller, env) {
    try {
      const removed = await purgeExpiredSessions(env);
      console.log(JSON.stringify({ event: "sessions_purged", removed }));
    } catch (error) {
      console.error("session purge failed", error);
    }
    try {
      const daily = await purgeDaily(env);
      console.log(JSON.stringify({ event: "daily_purged", ...daily }));
    } catch (error) {
      console.error("daily purge failed", error);
    }
  },
};
