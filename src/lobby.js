import { getUsers } from "./db.js";
import { json } from "./http.js";
import { resolveUser } from "./identity.js";
import { isLength, LENGTHS } from "./lengths.js";
import { nextMatchAt, nextQueuedAt, normalizeKind, pickGroup } from "./match.js";
import { isMode } from "./modes.js";
import { websocketOriginAllowed } from "./origin.js";
import { publicPlayer } from "./profile.js";
import { REMATCH_TTL_MS, rematchExpired } from "./retention.js";
import { pickPassageRecord, rememberIds, unionAvoid } from "./sentences.js";

const GATHER_MS = 1500;
const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const ROOM_LIMIT = 6;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Only the ranked queue writes Elo. Practice and private rooms do not.
export function rankedFor(kind) {
  return kind === "queue";
}

export function summarizeRooms(entries) {
  const groups = new Map();
  for (const entry of entries) {
    if (entry.status !== "room" || typeof entry.room !== "string" || !entry.room) continue;
    if (!groups.has(entry.room)) groups.set(entry.room, []);
    groups.get(entry.room).push(entry);
  }
  const rooms = [];
  for (const [code, members] of groups) {
    const host = members.find((entry) => entry.host) || members[0];
    const openedAt = members.reduce((min, entry) => {
      const value = Number(entry.openedAt) || 0;
      if (!value) return min;
      return min ? Math.min(min, value) : value;
    }, 0);
    rooms.push({
      code,
      mode: host.mode,
      length: readLength(host.length),
      openedAt,
      players: members.map((entry) => ({
        id: entry.user?.id,
        name: entry.user?.name || "Racer",
        tag: entry.user?.tag || "",
        avatar: entry.user?.avatar || null,
        color: entry.user?.color ?? null,
        host: Boolean(entry.host),
      })),
    });
  }
  rooms.sort((a, b) => b.players.length - a.players.length || b.openedAt - a.openedAt || a.code.localeCompare(b.code));
  return rooms;
}

function readLength(value) {
  return isLength(value) ? value : "sprint";
}

function roomCode() {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  let code = "";
  for (const byte of bytes) code += ROOM_ALPHABET[byte % ROOM_ALPHABET.length];
  return code;
}

export class Lobby {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.holding = Object.create(null);
    this.rematchHold = Object.create(null);
    this.rematchDue = null;
    this.pending = Object.create(null);
    this.recentPassageIds = new Map();
  }

  avoidFor(live) {
    const groups = [];
    for (const entry of live) {
      const userId = entry.att?.user?.id;
      if (userId) groups.push(this.recentPassageIds.get(userId) || []);
      const room = entry.att?.room;
      if (room) groups.push(this.recentPassageIds.get(`room:${room}`) || []);
    }
    return unionAvoid(groups);
  }

  rememberLaunch(live, id) {
    const keys = new Set();
    for (const entry of live) {
      const userId = entry.att?.user?.id;
      if (userId) keys.add(userId);
      if (entry.att?.room) keys.add(`room:${entry.att.room}`);
    }
    for (const key of keys) {
      this.recentPassageIds.set(key, rememberIds(this.recentPassageIds.get(key), id));
    }
  }

  sockets() {
    const open = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      open.push({ ws, att: ws.deserializeAttachment() || {} });
    }
    return open;
  }

  send(ws, payload) {
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      // The socket closed between the check and the write.
    }
  }

  queued(mode, length) {
    return this.sockets().filter((entry) => (
      entry.att.status === "queue"
      && entry.att.mode === mode
      && readLength(entry.att.length) === length
    ));
  }

  roomMembers(code) {
    return this.sockets().filter((entry) => entry.att.status === "room" && entry.att.room === code);
  }

  rematchGroup(raceId) {
    return this.sockets().filter((entry) => (
      entry.att.lastRace === raceId
      && (entry.att.status === "matched" || entry.att.status === "rematch")
    ));
  }

  async releaseGroup(ws, att) {
    const raceId = att.lastRace;
    const inGroup = raceId && (att.status === "matched" || att.status === "rematch");
    if (!inGroup) return;
    att.lastRace = null;
    ws.serializeAttachment(att);
    await this.syncRematch(raceId);
  }

  async syncRematch(raceId, notice) {
    if (!raceId || this.rematchHold[raceId]) return;
    const group = this.rematchGroup(raceId);
    const ready = group.filter((entry) => entry.att.status === "rematch");
    if (ready.length >= 2) {
      const mode = ready[0].att.mode;
      const length = readLength(ready[0].att.length);
      if (!isMode(mode)) return;
      this.rematchHold[raceId] = true;
      let launched = false;
      try {
        const kind = normalizeKind(ready[0].att.kind, ready[0].att.ranked, ready.length);
        launched = await this.launch(ready, mode, length, rankedFor(kind), kind);
      } finally {
        this.rematchHold[raceId] = false;
      }
      if (launched) await this.syncRematch(raceId, { started: true });
      return;
    }
    const payload = {
      t: "rematch",
      raceId,
      ready: ready.map((entry) => entry.att.user.id),
      started: Boolean(notice?.started) && ready.length === 0,
    };
    for (const entry of group) this.send(entry.ws, payload);
  }

  announce(mode, length) {
    const lane = readLength(length);
    const waiting = this.queued(mode, lane);
    const now = Date.now();
    const group = pickGroup(waiting.map((entry) => ({
      userId: entry.att.user?.id,
      elo: Number(entry.att.user?.elo?.[mode] ?? 1000),
      queuedAt: Number.isFinite(Number(entry.att.queuedAt)) ? Number(entry.att.queuedAt) : 0,
    })), now, 4);
    const matching = Boolean(group && group.length >= 2);
    for (const entry of waiting) {
      this.send(entry.ws, {
        t: "queued",
        mode,
        length: lane,
        waiting: waiting.length,
        serverNow: now,
        gatherMs: matching ? GATHER_MS : null,
        matching,
      });
    }
  }

  directory() {
    return summarizeRooms(this.sockets().map((entry) => ({
      status: entry.att.status,
      room: entry.att.room,
      host: entry.att.host,
      mode: entry.att.mode,
      length: entry.att.length,
      openedAt: entry.att.openedAt,
      user: entry.att.user,
    })));
  }

  emitDirectory() {
    const payload = { t: "rooms", max: ROOM_LIMIT, rooms: this.directory() };
    for (const entry of this.sockets()) {
      if (!entry.att.watching) continue;
      this.send(entry.ws, payload);
    }
  }

  emitRoom(code) {
    const members = this.roomMembers(code);
    if (members.length) {
      if (!members.some((entry) => entry.att.host)) {
        members[0].att.host = true;
        members[0].ws.serializeAttachment(members[0].att);
      }
      const players = members.map((entry) => ({ ...entry.att.user, host: Boolean(entry.att.host) }));
      for (const entry of members) {
        this.send(entry.ws, {
          t: "room",
          code,
          mode: entry.att.mode,
          length: readLength(entry.att.length),
          youHost: Boolean(entry.att.host),
          players,
        });
      }
    }
    this.emitDirectory();
  }

  async fetch(request) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: "expected_websocket" }, { status: 426 });
    }
    if (!websocketOriginAllowed(request.headers.get("origin"), request.url, this.env.ALLOWED_ORIGINS)) {
      return json({ error: "origin" }, { status: 403 });
    }
    const resolved = await resolveUser(request, this.env);
    if (!resolved) return new Response("unauthorized", { status: 401 });
    const player = publicPlayer(resolved.user, this.env);
    for (const other of this.ctx.getWebSockets()) {
      const att = other.deserializeAttachment();
      if (att?.user?.id === player.id) {
        try {
          other.close(4000, "replaced");
        } catch {
          // Already gone.
        }
      }
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ status: "idle", user: player, mode: null, length: "sprint", room: null, host: false });
    server.send(JSON.stringify({ t: "hello", you: player, serverNow: Date.now() }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    let text = raw;
    if (typeof text !== "string") text = new TextDecoder().decode(text);
    if (text.length > 2000) return;
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (!msg || typeof msg.t !== "string") return;
    const att = ws.deserializeAttachment() || {};
    if (!att.user) return;

    if (msg.t === "browse") {
      att.watching = true;
      ws.serializeAttachment(att);
      this.send(ws, { t: "rooms", max: ROOM_LIMIT, rooms: this.directory() });
      return;
    }

    if (msg.t === "browse_stop") {
      if (att.watching) {
        att.watching = false;
        ws.serializeAttachment(att);
      }
      return;
    }

    if (att.watching) {
      att.watching = false;
      ws.serializeAttachment(att);
    }

    if (msg.t === "queue") {
      if (!isMode(msg.mode)) return this.send(ws, { t: "error", error: "Pick a mode." });
      const previousRoom = att.status === "room" ? att.room : null;
      const previous = att.status === "queue" ? { mode: att.mode, length: readLength(att.length) } : null;
      const lane = readLength(msg.length);
      const queuedAt = nextQueuedAt(
        { ...att, length: readLength(att.length) },
        msg.mode,
        lane,
        Date.now(),
      );
      await this.releaseGroup(ws, att);
      att.status = "queue";
      att.mode = msg.mode;
      att.length = lane;
      att.queuedAt = queuedAt;
      att.room = null;
      att.host = false;
      ws.serializeAttachment(att);
      if (previousRoom) this.emitRoom(previousRoom);
      if (previous && (previous.mode !== att.mode || previous.length !== att.length)) {
        this.announce(previous.mode, previous.length);
        await this.pokeLane(previous.mode, previous.length);
      }
      this.announce(att.mode, att.length);
      await this.consider(att.mode, att.length);
      return;
    }

    if (msg.t === "practice") {
      if (!isMode(msg.mode)) return this.send(ws, { t: "error", error: "Pick a mode." });
      await this.releaseGroup(ws, att);
      att.mode = msg.mode;
      att.length = readLength(msg.length);
      ws.serializeAttachment(att);
      await this.launch([{ ws, att }], att.mode, att.length, rankedFor("practice"), "practice");
      return;
    }

    if (msg.t === "rematch") {
      const raceId = String(msg.raceId || "");
      if (!/^[0-9a-f-]{36}$/i.test(raceId)) return;
      const record = await this.loadRematch(raceId);
      const sameSocket = att.lastRace === raceId && (att.status === "matched" || att.status === "rematch");
      const listed = record && record.until >= Date.now() && Array.isArray(record.ids) && record.ids.includes(att.user.id);
      if (!sameSocket && !listed) return this.send(ws, { t: "error", error: "That rematch is closed." });
      if (!sameSocket) {
        if (!isMode(record.mode)) return this.send(ws, { t: "error", error: "That rematch is closed." });
        att.mode = record.mode;
        att.length = readLength(record.length);
        att.ranked = Boolean(record.ranked);
        att.kind = normalizeKind(record.kind, record.ranked, record.ids?.length || 0);
      }
      const previousRoom = att.status === "room" ? att.room : null;
      const previous = att.status === "queue" ? { mode: att.mode, length: readLength(att.length) } : null;
      att.status = "rematch";
      att.lastRace = raceId;
      att.room = null;
      att.host = false;
      ws.serializeAttachment(att);
      if (previousRoom) this.emitRoom(previousRoom);
      if (previous) {
        this.announce(previous.mode, previous.length);
        await this.pokeLane(previous.mode, previous.length);
      }
      await this.syncRematch(raceId);
      return;
    }

    if (msg.t === "rematch_cancel") {
      if (att.status !== "rematch" || !att.lastRace) return;
      att.status = "matched";
      ws.serializeAttachment(att);
      await this.syncRematch(att.lastRace);
      return;
    }

    if (msg.t === "room_create") {
      if (!isMode(msg.mode)) return this.send(ws, { t: "error", error: "Pick a mode." });
      await this.releaseGroup(ws, att);
      const previousRoom = att.status === "room" ? att.room : null;
      let code = roomCode();
      for (let i = 0; i < 5 && this.roomMembers(code).length; i++) code = roomCode();
      att.status = "room";
      att.mode = msg.mode;
      att.length = readLength(msg.length);
      att.room = code;
      att.host = true;
      att.openedAt = Date.now();
      ws.serializeAttachment(att);
      if (previousRoom && previousRoom !== code) this.emitRoom(previousRoom);
      this.emitRoom(code);
      return;
    }

    if (msg.t === "room_join") {
      const code = String(msg.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (code.length !== 4) return this.send(ws, { t: "error", error: "Room codes are 4 characters." });
      const members = this.roomMembers(code);
      if (!members.length) return this.send(ws, { t: "error", error: "That room is not open." });
      if (members.length >= ROOM_LIMIT) return this.send(ws, { t: "error", error: "That room is full." });
      await this.releaseGroup(ws, att);
      const host = members.find((entry) => entry.att.host) || members[0];
      const previousRoom = att.status === "room" ? att.room : null;
      att.status = "room";
      att.mode = host.att.mode;
      att.length = readLength(host.att.length);
      att.room = code;
      att.host = false;
      att.openedAt = host.att.openedAt || Date.now();
      ws.serializeAttachment(att);
      if (previousRoom && previousRoom !== code) this.emitRoom(previousRoom);
      this.emitRoom(code);
      return;
    }

    if (msg.t === "room_start") {
      if (att.status !== "room" || !att.host) return;
      const members = this.roomMembers(att.room);
      if (members.length < 2) {
        this.send(ws, { t: "error", error: "Need two racers in the room." });
        return;
      }
      await this.launch(members, att.mode, readLength(att.length), rankedFor("room"), "room");
      return;
    }

    if (msg.t === "leave") {
      const previousRoom = att.status === "room" ? att.room : null;
      const previous = att.status === "queue" ? { mode: att.mode, length: readLength(att.length) } : null;
      await this.releaseGroup(ws, att);
      att.status = "idle";
      att.room = null;
      att.host = false;
      ws.serializeAttachment(att);
      if (previousRoom) this.emitRoom(previousRoom);
      if (previous) {
        this.announce(previous.mode, previous.length);
        await this.pokeLane(previous.mode, previous.length);
      }
    }
  }

  async webSocketClose(ws) {
    const att = ws.deserializeAttachment();
    if (!att?.user) return;
    if (att.status === "room" && att.room) this.emitRoom(att.room);
    if (att.status === "queue" && att.mode) {
      const lane = readLength(att.length);
      this.announce(att.mode, lane);
      await this.pokeLane(att.mode, lane);
    }
    if (att.lastRace && (att.status === "matched" || att.status === "rematch")) await this.syncRematch(att.lastRace);
  }

  laneKey(mode, length) {
    return `${mode}:${readLength(length)}`;
  }

  splitLane(key) {
    const index = String(key).indexOf(":");
    if (index < 0) return ["", ""];
    return [key.slice(0, index), key.slice(index + 1)];
  }

  queuedLanes() {
    const keys = new Set();
    for (const entry of this.sockets()) {
      if (entry.att.status === "queue" && isMode(entry.att.mode)) keys.add(this.laneKey(entry.att.mode, entry.att.length));
    }
    return [...keys];
  }

  async queueRecords(mode, lane) {
    const waiting = this.queued(mode, lane);
    if (!waiting.length) return [];
    let byId = new Map();
    try {
      const ids = [...new Set(waiting.map((entry) => entry.att.user.id))];
      const rows = await getUsers(this.env, ids);
      byId = new Map(rows.map((row) => [row.id, row]));
    } catch (error) {
      console.error("queue ratings failed", error);
    }
    return waiting.map((entry) => {
      const row = byId.get(entry.att.user.id);
      if (row) {
        entry.att.user = publicPlayer(row, this.env);
        entry.ws.serializeAttachment(entry.att);
      }
      return {
        userId: entry.att.user.id,
        elo: Number(entry.att.user?.elo?.[mode] ?? 1000),
        queuedAt: Number.isFinite(Number(entry.att.queuedAt)) ? Number(entry.att.queuedAt) : 0,
        entry,
      };
    });
  }

  async pokeLane(mode, length) {
    if (!isMode(mode)) return;
    const key = this.laneKey(mode, length);
    if (this.holding[key]) return;
    const at = Date.now() + 40;
    if (this.pending[key] == null || this.pending[key] > at) this.pending[key] = at;
    await this.armMatchAlarm();
  }

  planWindow(mode, lane, records) {
    const key = this.laneKey(mode, lane);
    const now = Date.now();
    const at = nextMatchAt(records, now);
    if (at == null || at <= now) delete this.pending[key];
    else this.pending[key] = at;
    return this.armMatchAlarm();
  }

  async armMatchAlarm() {
    const now = Date.now();
    let when = null;
    for (const [key, at] of Object.entries(this.pending)) {
      const effective = this.holding[key] ? now + GATHER_MS : at;
      if (when == null || effective < when) when = effective;
    }
    if (this.rematchDue != null && (when == null || this.rematchDue < when)) when = this.rematchDue;
    try {
      if (when == null) await this.ctx.storage.deleteAlarm();
      else await this.ctx.storage.setAlarm(Math.max(when, now + 20));
    } catch {
      // The next queue or leave message arms the clock again.
    }
  }

  async loadRematch(raceId) {
    const record = await this.ctx.storage.get(`rematch:${raceId}`);
    if (!record) return null;
    if (!rematchExpired(record, Date.now())) return record;
    try {
      await this.ctx.storage.delete(`rematch:${raceId}`);
    } catch {
      // The sweep alarm deletes it again.
    }
    return null;
  }

  async saveRematch(raceId, record) {
    await this.ctx.storage.put(`rematch:${raceId}`, record);
    const until = Number(record?.until);
    if (Number.isFinite(until) && (this.rematchDue == null || until < this.rematchDue)) this.rematchDue = until;
    await this.armMatchAlarm();
  }

  async sweepRematches(now) {
    let next = null;
    const list = await this.ctx.storage.list({ prefix: "rematch:" });
    for (const [key, record] of list) {
      if (rematchExpired(record, now)) {
        await this.ctx.storage.delete(key);
        continue;
      }
      const until = Number(record.until);
      if (next == null || until < next) next = until;
    }
    this.rematchDue = next;
  }

  async alarm() {
    const now = Date.now();
    try {
      await this.sweepRematches(now);
    } catch (error) {
      console.error("rematch sweep failed", error);
    }
    const known = Object.keys(this.pending);
    const due = known.length
      ? known.filter((key) => this.pending[key] <= now + 25)
      : this.queuedLanes();
    for (const key of due) {
      if (this.holding[key]) continue;
      delete this.pending[key];
      const [mode, length] = this.splitLane(key);
      if (!isMode(mode) || !isLength(length)) continue;
      await this.consider(mode, length);
    }
    await this.armMatchAlarm();
  }

  async consider(mode, length) {
    if (!isMode(mode)) return;
    const lane = readLength(length);
    const key = this.laneKey(mode, lane);
    if (this.holding[key]) return;
    this.holding[key] = true;
    let launched = false;
    let attempted = false;
    let records = [];
    try {
      records = await this.queueRecords(mode, lane);
      this.announce(mode, lane);
      const group = pickGroup(records, Date.now(), 4);
      const members = (group || []).map((item) => item.entry).filter((entry) => entry?.ws?.readyState === WebSocket.OPEN);
      if (members.length >= 4) {
        delete this.pending[key];
        attempted = true;
        launched = await this.launch(members.slice(0, 4), mode, lane, rankedFor("queue"), "queue");
      } else if (members.length >= 2) {
        delete this.pending[key];
        attempted = true;
        await delay(GATHER_MS);
        const again = await this.queueRecords(mode, lane);
        const gathered = pickGroup(again, Date.now(), 4);
        const ready = (gathered || []).map((item) => item.entry).filter((entry) => entry?.ws?.readyState === WebSocket.OPEN);
        if (ready.length >= 2) launched = await this.launch(ready, mode, lane, rankedFor("queue"), "queue");
        records = again;
      }
    } finally {
      this.holding[key] = false;
    }
    const left = launched || attempted ? await this.queueRecords(mode, lane) : records;
    if (launched && left.length >= 2) {
      await this.consider(mode, lane);
      return;
    }
    if (!launched && attempted && pickGroup(left, Date.now(), 4)) {
      this.pending[key] = Date.now() + 2000;
      await this.armMatchAlarm();
      return;
    }
    await this.planWindow(mode, lane, left);
  }

  async launch(members, mode, length, ranked, kind) {
    const open = members.filter((entry) => entry.ws.readyState === WebSocket.OPEN);
    const seen = new Set();
    const live = [];
    for (const entry of open) {
      const id = entry.att?.user?.id;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      live.push(entry);
    }
    if (!live.length) return false;
    const raceKind = normalizeKind(kind, ranked, live.length);
    const rated = rankedFor(raceKind);
    if (rated && live.length < 2) return false;
    const previous = live.map((entry) => entry.att.status);
    for (const entry of live) {
      entry.att.status = "matched";
      entry.ws.serializeAttachment(entry.att);
    }
    try {
      const ids = live.map((entry) => entry.att.user.id);
      const rows = await getUsers(this.env, ids);
      const byId = new Map(rows.map((row) => [row.id, row]));
      const players = live.map((entry) => {
        const row = byId.get(entry.att.user.id);
        const player = row ? publicPlayer(row, this.env) : entry.att.user;
        entry.att.user = player;
        entry.ws.serializeAttachment(entry.att);
        return { ...player, eloAtStart: player.elo?.[mode] ?? 1000 };
      });
      const lane = readLength(length);
      const raceId = crypto.randomUUID();
      const record = pickPassageRecord(mode, LENGTHS[lane].sentences, { avoid: this.avoidFor(live) });
      const sentence = record?.text || "";
      const startAt = Date.now() + 3000;
      const stub = this.env.RACE.get(this.env.RACE.idFromName(raceId));
      const response = await stub.fetch("https://race.internal/init", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ raceId, sentence, startAt, mode, length: lane, ranked: rated, kind: raceKind, players }),
      });
      if (!response.ok) throw new Error(`race init ${response.status}`);
      if (record?.id) this.rememberLaunch(live, record.id);
      await this.saveRematch(raceId, {
        mode,
        length: lane,
        ranked: rated,
        kind: raceKind,
        ids: players.map((player) => player.id),
        until: Date.now() + REMATCH_TTL_MS,
      });
      const match = {
        t: "match",
        raceId,
        sentence,
        startAt,
        serverNow: Date.now(),
        mode,
        length: lane,
        ranked: rated,
        kind: raceKind,
        players,
      };
      for (const entry of live) {
        entry.att.lastRace = raceId;
        entry.att.mode = mode;
        entry.att.length = lane;
        entry.att.ranked = rated;
        entry.att.kind = raceKind;
        entry.att.status = "matched";
        entry.ws.serializeAttachment(entry.att);
        this.send(entry.ws, match);
      }
      this.announce(mode, lane);
      this.emitDirectory();
      return true;
    } catch (error) {
      console.error("launch failed", error);
      live.forEach((entry, index) => {
        entry.att.status = previous[index] || "idle";
        entry.ws.serializeAttachment(entry.att);
        this.send(entry.ws, { t: "error", error: "Could not start the race. Try again." });
      });
      const rooms = new Set(live.map((entry) => entry.att.room).filter(Boolean));
      for (const code of rooms) this.emitRoom(code);
      this.announce(mode, length);
      return false;
    }
  }

  async webSocketError(_ws, error) {
    console.error("lobby socket error", error);
  }
}
