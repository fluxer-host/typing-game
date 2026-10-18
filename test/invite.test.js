import assert from "node:assert/strict";
import test from "node:test";
import { sessionShell } from "../public/net.js";
import {
  JOIN_FAIL_LIMIT,
  PENDING_ROOM_KEY,
  PENDING_ROOM_MS,
  addressWithoutRoom,
  classifyRoomJoin,
  clearPendingRoom,
  inviteLink,
  inviteStatusForReason,
  joinBlocked,
  joinDecision,
  noteJoinFailure,
  normalizeRoomCode,
  parseRoomSearch,
  readPendingRoom,
  roomOccupancy,
  savePendingRoom,
  takePendingRoom,
} from "../src/room-code.js";

function memoryStorage() {
  const data = new Map();
  return {
    setItem(key, value) { data.set(key, String(value)); },
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    removeItem(key) { data.delete(key); },
  };
}

test("room codes accept the alphabet in any case and reject everything else", () => {
  assert.equal(normalizeRoomCode("ABCD"), "ABCD");
  assert.equal(normalizeRoomCode("  abcd "), "ABCD");
  assert.equal(normalizeRoomCode("wxyz"), "WXYZ");
  assert.equal(normalizeRoomCode("2345"), "2345");
  assert.equal(normalizeRoomCode("ab1c"), "");
  assert.equal(normalizeRoomCode("AB0D"), "");
  assert.equal(normalizeRoomCode("ABCI"), "");
  assert.equal(normalizeRoomCode("ABCO"), "");
  assert.equal(normalizeRoomCode("ABC"), "");
  assert.equal(normalizeRoomCode("ABCDE"), "");
  assert.equal(normalizeRoomCode("AB CD"), "");
  assert.equal(normalizeRoomCode("AB-D"), "");
  assert.equal(normalizeRoomCode("AB/D"), "");
  assert.equal(normalizeRoomCode("<ABCD>"), "");
  assert.equal(normalizeRoomCode("abcd\n"), "ABCD");
  assert.equal(normalizeRoomCode("AB\nCD"), "");
  assert.equal(normalizeRoomCode(""), "");
  assert.equal(normalizeRoomCode(null), "");
});

test("a room query is parsed, then removed from the address", () => {
  assert.deepEqual(parseRoomSearch("?room=abcd"), { present: true, code: "ABCD" });
  assert.deepEqual(parseRoomSearch("?room=ab1d"), { present: true, code: "" });
  assert.deepEqual(parseRoomSearch("?room=abcde"), { present: true, code: "" });
  assert.deepEqual(parseRoomSearch("?room=ab%2Fd"), { present: true, code: "" });
  assert.deepEqual(parseRoomSearch(""), { present: false, code: "" });
  assert.deepEqual(parseRoomSearch("?mode=desktop"), { present: false, code: "" });
  assert.equal(
    addressWithoutRoom("https://typing.fluxer.my/?room=ABCD&x=1#/stats"),
    "/?x=1#/stats",
  );
  assert.equal(addressWithoutRoom("https://example.test/?room=ABCD"), "/");
  assert.equal(addressWithoutRoom("/?room=NOPE"), "/");
});

test("the invite link uses the page origin and a normalised code", () => {
  assert.equal(inviteLink("https://typing.fluxer.my", "abcd"), "https://typing.fluxer.my/?room=ABCD");
  assert.equal(inviteLink("https://typing.fluxer.my/", "WXYZ"), "https://typing.fluxer.my/?room=WXYZ");
  assert.equal(inviteLink("http://127.0.0.1:8787", "ab1d"), "");
});

test("a pending room expires and is read once", () => {
  const storage = memoryStorage();
  const start = 1_000_000;
  assert.equal(savePendingRoom(storage, "abcd", start), true);
  assert.equal(readPendingRoom(storage, start + PENDING_ROOM_MS), "ABCD");
  assert.equal(readPendingRoom(storage, start + PENDING_ROOM_MS + 1), "");
  assert.equal(takePendingRoom(storage, start + PENDING_ROOM_MS + 1), "");
  assert.equal(storage.getItem(PENDING_ROOM_KEY), null);

  assert.equal(savePendingRoom(storage, "wxyz", start), true);
  assert.equal(takePendingRoom(storage, start + 1000), "WXYZ");
  assert.equal(readPendingRoom(storage, start + 1000), "");

  assert.equal(savePendingRoom(storage, "nope", start), false);
  assert.equal(savePendingRoom({ setItem() { throw new Error("blocked"); } }, "ABCD", start), false);
  assert.equal(readPendingRoom({ getItem() { throw new Error("blocked"); } }, start), "");
  const future = memoryStorage();
  future.setItem(PENDING_ROOM_KEY, JSON.stringify({ v: 1, code: "ABCD", at: start + 120_000 }));
  assert.equal(readPendingRoom(future, start), "");
  clearPendingRoom(future);
  assert.equal(future.getItem(PENDING_ROOM_KEY), null);
});

test("join waits for sign-in, prompts when signed out, and skips an active race", () => {
  assert.deepEqual(joinDecision({ session: "unknown", code: "ABCD" }), { action: "wait", code: "ABCD" });
  assert.deepEqual(joinDecision({ session: "out", code: "abcd" }), { action: "prompt", code: "ABCD" });
  assert.deepEqual(joinDecision({ session: "in", code: "ABCD", inRace: false }), { action: "join", code: "ABCD" });
  assert.deepEqual(joinDecision({ session: "in", code: "ABCD", inRace: true }), { action: "busy", code: "ABCD" });
  assert.deepEqual(joinDecision({ session: "in", code: "ABCD", roomStatus: "full" }), { action: "full", code: "ABCD" });
  assert.deepEqual(joinDecision({ session: "in", code: "ABCD", roomStatus: "closed" }), { action: "closed", code: "ABCD" });
  assert.deepEqual(joinDecision({ session: "in", code: "ABCD", roomStatus: "limit" }), { action: "limit", code: "ABCD" });
  assert.deepEqual(joinDecision({ session: "in", code: "AB1D" }), { action: "invalid", code: "" });
  assert.deepEqual(joinDecision({ session: "out", code: "!!!!" }), { action: "invalid", code: "" });
  assert.equal(inviteStatusForReason("room_full"), "full");
  assert.equal(inviteStatusForReason("room_closed"), "closed");
  assert.equal(inviteStatusForReason("room_limit"), "limit");
  assert.equal(inviteStatusForReason("other"), "failed");
});

test("a join is refused when the code is bad, the room is empty, or the room is full", () => {
  assert.deepEqual(classifyRoomJoin("abcd", 1, 6), { ok: true, code: "ABCD" });
  assert.deepEqual(classifyRoomJoin("ab1d", 1, 6), { ok: false, reason: "room_invalid" });
  assert.deepEqual(classifyRoomJoin("ABCD", 0, 6), { ok: false, reason: "room_closed" });
  assert.deepEqual(classifyRoomJoin("ABCD", 6, 6), { ok: false, reason: "room_full" });
  assert.equal(roomOccupancy(2, 6), "2 of 6 players");
  assert.equal(roomOccupancy(2, 2), "2 of 2 players");
});

test("failed joins slow down after the limit, then the window opens again", () => {
  const book = new Map();
  const now = 5_000;
  for (let i = 0; i < JOIN_FAIL_LIMIT; i += 1) noteJoinFailure(book, ["user:ada", "ip:203.0.113.8"], now);
  assert.equal(joinBlocked(book, ["user:ada"], now + 1000), true);
  assert.equal(joinBlocked(book, ["ip:203.0.113.8"], now + 1000), true);
  assert.equal(joinBlocked(book, ["user:bea"], now + 1000), false);
  assert.equal(joinBlocked(book, ["user:ada"], now + 60_000), false);
});

test("the invite screen waits until the session is known and does not cover a race", () => {
  assert.equal(sessionShell({ session: "unknown", phase: "lobby", lobbyOpen: false, view: "invite" }), "loading");
  assert.equal(sessionShell({ session: "out", phase: "lobby", lobbyOpen: false, view: "invite" }), "invite");
  assert.equal(sessionShell({ session: "in", phase: "lobby", lobbyOpen: true, view: "invite" }), "invite");
  assert.equal(sessionShell({ session: "in", phase: "race", lobbyOpen: true, view: "invite" }), "race");
  assert.equal(sessionShell({ session: "in", phase: "lobby", lobbyOpen: true }), "lobby");
});
