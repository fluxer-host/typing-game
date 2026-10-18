// Shared by the page and the unit tests. The page loads this as a module.

// Automatic retries for config, the ladder, recent races, and the session check.
export const RETRY_BASE_MS = 500;
export const RETRY_CAP_MS = 8_000;
export const RETRY_LIMIT = 5;

// Lobby socket retries. After the cap, the page keeps a Reconnect button.
export const LOBBY_RETRY_BASE_MS = 400;
export const LOBBY_RETRY_CAP_MS = 8_000;
export const LOBBY_RETRY_LIMIT = 6;

// Same window the race Durable Object allows for a dropped socket.
export const RACE_RECONNECT_GRACE_MS = 15_000;
export const RACE_RECONNECT_BASE_MS = 300;
export const RACE_RECONNECT_CAP_MS = 4_000;

export function backoffDelay(attempt, base = RETRY_BASE_MS, cap = RETRY_CAP_MS) {
  const start = Number(base);
  const limit = Number(cap);
  if (!Number.isFinite(start) || start < 0) return 0;
  if (!Number.isFinite(limit) || limit < 0) return 0;
  const step = Number.isFinite(Number(attempt)) && Number(attempt) > 0 ? Math.floor(Number(attempt)) : 0;
  const delay = start * 2 ** step;
  if (!Number.isFinite(delay)) return Math.min(limit, start);
  return Math.min(limit, delay);
}

// Config and the ladder are not inputs. A signed-in player stays signed in
// when those requests fail. Queue, room, and browse need a live lobby socket.
export function sessionShell({ session, phase, lobbyOpen, solo = false, view = "" }) {
  if (session === "unknown") return "loading";
  if (session === "error") return "boot-error";
  const racing = phase === "countdown" || phase === "race" || phase === "finishing";
  const holding = phase === "queue" || phase === "room" || phase === "browse";
  if (solo && racing) return "race";
  if ((view === "stats" || view === "ladder") && !racing && !holding) return view;
  if (view === "invite" && !racing && !holding) return "invite";
  if (solo && phase === "results") return "solo-results";
  if (session !== "in") return "auth";
  if (phase === "results") return "results";
  if (racing) return "race";
  if (!lobbyOpen && (phase === "queue" || phase === "room" || phase === "browse")) return "lobby";
  if (phase === "queue") return "queue";
  if (phase === "room") return "room";
  if (phase === "browse") return "browse";
  return "lobby";
}

// Header control. "account" is the signed-in name. "pending" waits for the
// session check so a signed-in player does not flash a Sign in button.
export function headerSignIn({ session, oauth = false, devLogin = false } = {}) {
  if (session === "in") return "account";
  if (session !== "out" && session !== "error") return "pending";
  if (oauth) return "oauth";
  if (devLogin) return "dev";
  return "hidden";
}

// "in" and "out" are settled. "error" means the session is still unknown.
export function classifyMe(result) {
  if (!result || typeof result !== "object") return "error";
  if (result.ok === true) return result.user ? "in" : "out";
  if (result.status === 401) return "out";
  return "error";
}

export function shouldAutoRetry(status) {
  if (status == null || status === 0) return true;
  if (status === 408 || status === 429) return true;
  return status >= 500 && status <= 599;
}

// Queue, room, and browse membership live on the lobby socket.
// A drop makes those views stale, so the page leaves them immediately.
export function lobbyDrop(phase) {
  if (phase === "queue") return { phase: "lobby", clearQueue: true, clearRoom: false, notice: "requeue" };
  if (phase === "room") return { phase: "lobby", clearQueue: false, clearRoom: true, notice: "room" };
  if (phase === "browse") return { phase: "lobby", clearQueue: false, clearRoom: false, notice: "reconnect" };
  return { phase, clearQueue: false, clearRoom: false, notice: "reconnect" };
}

// Delay until the next race-socket attempt, or null when the grace window is over.
// The attempt must land before the server closes the resume window.
export function nextRaceRetry(attempt, elapsedMs, grace = RACE_RECONNECT_GRACE_MS) {
  const elapsed = Number(elapsedMs);
  const windowMs = Number(grace);
  if (!Number.isFinite(elapsed) || elapsed < 0) return null;
  if (!Number.isFinite(windowMs) || windowMs <= 0) return null;
  const delay = backoffDelay(attempt, RACE_RECONNECT_BASE_MS, RACE_RECONNECT_CAP_MS);
  if (elapsed + delay >= windowMs) return null;
  return delay;
}
