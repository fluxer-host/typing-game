// Room codes and invite decisions. Shared by the lobby and the page.
// A code is 4 characters from the unambiguous alphabet used at creation.

export const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const ROOM_CODE_LENGTH = 4;

// How long a room code remembered for sign-in stays valid.
// This matches the OAuth cookie lifetime so a normal sign-in still joins.
export const PENDING_ROOM_MS = 10 * 60 * 1000;
export const PENDING_ROOM_KEY = "tg_room";

// The joining screen stays up long enough to read and to cancel.
export const JOIN_PAUSE_MS = 1000;

// Failed joins, per user and per IP, inside one Lobby isolate.
export const JOIN_FAIL_LIMIT = 8;
export const JOIN_FAIL_WINDOW_MS = 60 * 1000;

const ALPHABET = new Set(ROOM_ALPHABET);

export function normalizeRoomCode(value) {
  const text = String(value ?? "").trim().toUpperCase();
  if (text.length !== ROOM_CODE_LENGTH) return "";
  for (const char of text) {
    if (!ALPHABET.has(char)) return "";
  }
  return text;
}

export function parseRoomSearch(search) {
  const raw = String(search ?? "");
  const query = raw.includes("?") ? raw.slice(raw.indexOf("?") + 1).split("#")[0] : raw.split("#")[0];
  const params = new URLSearchParams(query);
  if (!params.has("room")) return { present: false, code: "" };
  return { present: true, code: normalizeRoomCode(params.get("room")) };
}

export function addressWithoutRoom(href) {
  const url = new URL(String(href || "/"), "https://typing.local");
  url.searchParams.delete("room");
  const search = url.searchParams.toString();
  const path = url.pathname || "/";
  return `${path}${search ? `?${search}` : ""}${url.hash}`;
}

export function inviteLink(origin, code) {
  const normalized = normalizeRoomCode(code);
  if (!normalized) return "";
  let root = String(origin || "").trim();
  if (root.endsWith("/")) root = root.slice(0, -1);
  return `${root}/?room=${normalized}`;
}

export function savePendingRoom(storage, code, now = Date.now()) {
  const normalized = normalizeRoomCode(code);
  if (!normalized || !storage || typeof storage.setItem !== "function") return false;
  try {
    storage.setItem(PENDING_ROOM_KEY, JSON.stringify({ v: 1, code: normalized, at: Number(now) }));
    return true;
  } catch {
    return false;
  }
}

export function readPendingRoom(storage, now = Date.now(), ttl = PENDING_ROOM_MS) {
  if (!storage || typeof storage.getItem !== "function") return "";
  let raw = "";
  try {
    raw = storage.getItem(PENDING_ROOM_KEY) || "";
  } catch {
    return "";
  }
  if (!raw) return "";
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "";
  }
  const code = normalizeRoomCode(parsed?.code);
  const at = Number(parsed?.at);
  const life = Number(ttl);
  if (!code || !Number.isFinite(at) || !Number.isFinite(life) || life < 0) return "";
  if (now - at > life) return "";
  if (at - now > 60 * 1000) return "";
  return code;
}

export function clearPendingRoom(storage) {
  if (!storage || typeof storage.removeItem !== "function") return;
  try {
    storage.removeItem(PENDING_ROOM_KEY);
  } catch {
    // Storage can throw in private mode. The in-memory code still works.
  }
}

// Read the saved code once. A stale or broken value is dropped too.
export function takePendingRoom(storage, now = Date.now(), ttl = PENDING_ROOM_MS) {
  const code = readPendingRoom(storage, now, ttl);
  clearPendingRoom(storage);
  return code;
}

// session is "unknown", "error", "in", or "out".
// roomStatus is "" until the lobby answers, then "full" or "closed".
export function joinDecision({ session, code, inRace = false, roomStatus = "" } = {}) {
  const normalized = normalizeRoomCode(code);
  if (!normalized) return { action: "invalid", code: "" };
  if (session !== "in" && session !== "out") return { action: "wait", code: normalized };
  if (roomStatus === "invalid") return { action: "invalid", code: "" };
  if (session === "out") return { action: "prompt", code: normalized };
  if (inRace) return { action: "busy", code: normalized };
  if (roomStatus === "full") return { action: "full", code: normalized };
  if (roomStatus === "closed") return { action: "closed", code: normalized };
  if (roomStatus === "limit") return { action: "limit", code: normalized };
  return { action: "join", code: normalized };
}

export function classifyRoomJoin(code, memberCount, limit = 6) {
  const normalized = normalizeRoomCode(code);
  if (!normalized) return { ok: false, reason: "room_invalid" };
  const count = Number(memberCount);
  const seats = Number(limit);
  if (!Number.isFinite(count) || count <= 0) return { ok: false, reason: "room_closed" };
  if (!Number.isFinite(seats) || count >= seats) return { ok: false, reason: "room_full" };
  return { ok: true, code: normalized };
}

export function roomOccupancy(count, max) {
  const players = Number.isFinite(Number(count)) && Number(count) > 0 ? Math.floor(Number(count)) : 0;
  const seats = Number.isFinite(Number(max)) && Number(max) > 0 ? Math.floor(Number(max)) : 0;
  if (!seats) return `${players} players`;
  return `${players} of ${seats} players`;
}

export function joinBlocked(book, keys, now = Date.now()) {
  const list = Array.isArray(keys) ? keys : [keys];
  for (const key of list) {
    if (!key || !book || typeof book.get !== "function") continue;
    const row = book.get(key);
    if (!row) continue;
    if (now - row.start >= JOIN_FAIL_WINDOW_MS) continue;
    if (row.count >= JOIN_FAIL_LIMIT) return true;
  }
  return false;
}

export function noteJoinFailure(book, keys, now = Date.now()) {
  if (!book || typeof book.get !== "function" || typeof book.set !== "function") return;
  const list = Array.isArray(keys) ? keys : [keys];
  for (const key of list) {
    if (!key) continue;
    const row = book.get(key);
    if (!row || now - row.start >= JOIN_FAIL_WINDOW_MS) book.set(key, { start: now, count: 1 });
    else row.count += 1;
  }
  if (book.size < 400 || typeof book.delete !== "function") return;
  for (const [key, row] of book) {
    if (now - row.start >= JOIN_FAIL_WINDOW_MS) book.delete(key);
  }
}

export function inviteStatusForReason(reason) {
  if (reason === "room_full") return "full";
  if (reason === "room_closed") return "closed";
  if (reason === "room_invalid") return "invalid";
  if (reason === "room_limit") return "limit";
  return "failed";
}
