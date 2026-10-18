import { accuracy, wpm } from "../src/score.js";
import { countForLength, passageById, pickPassageRecord } from "../src/sentences.js";

export function soloPlayer(me) {
  return {
    id: me?.id || "local",
    name: me?.name || "You",
  };
}

export function passageFits(record, mode, length) {
  if (!record || record.length !== length) return false;
  if (mode === "cursor") return record.ladders.includes("cursor");
  if (mode === "desktop" || mode === "mobile") return record.ladders.includes("desktop");
  return false;
}

export function soloStart({ mode, length, me, now, avoid = [], passageId = "", same = false, random } = {}) {
  const count = countForLength(length);
  let record = null;
  if (passageId) {
    const found = passageById(passageId);
    if (passageFits(found, mode, length)) record = found;
  }
  if (!record) {
    record = pickPassageRecord(mode, count, {
      avoid: same ? [] : avoid,
      random,
    });
  }
  const player = soloPlayer(me);
  const startAt = Number.isFinite(Number(now)) ? Number(now) : 0;
  return {
    localPractice: true,
    soloSaved: false,
    soloRun: null,
    mode,
    length,
    sentence: record?.text || "",
    passageId: record?.id || "",
    typed: "",
    ok: 0,
    err: 0,
    phase: "race",
    startAt,
    ranked: false,
    kind: "practice",
    raceLink: "up",
    raceId: null,
    players: [{ id: player.id, name: player.name }],
    live: [{ id: player.id, i: 0, wpm: 0, finishedAt: null }],
    results: null,
    versus: null,
    forfeitConfirm: false,
    forfeitedLocally: false,
    rematch: null,
    room: null,
    queue: null,
    shift: false,
  };
}

export function soloFinish({ sentence, startAt, now, ok, err, mode, length, passageId } = {}) {
  const end = Number.isFinite(Number(now)) ? Number(now) : 0;
  const start = Number.isFinite(Number(startAt)) ? Number(startAt) : end;
  const ms = Math.max(1, end - start);
  const chars = typeof sentence === "string" ? sentence.length : 0;
  const good = Number.isFinite(Number(ok)) ? Number(ok) : 0;
  const bad = Number.isFinite(Number(err)) ? Number(err) : 0;
  return {
    at: end,
    mode,
    length,
    passageId: passageId || "",
    wpm: wpm(chars, ms),
    accuracy: accuracy(good, bad),
    ms,
    errors: bad > 0 ? bad : 0,
    ranked: false,
  };
}
