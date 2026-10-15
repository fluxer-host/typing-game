import { getUsers } from "./db.js";
import { json } from "./http.js";
import { resolveUser } from "./identity.js";
import { isLength, LENGTHS } from "./lengths.js";
import { isMode } from "./modes.js";
import { publicPlayer } from "./profile.js";
import { pickPassage } from "./sentences.js";

const GATHER_MS = 1500;
const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
        launched = await this.launch(ready, mode, length, Boolean(ready[0].att.ranked));
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
    for (const entry of waiting) {
      this.send(entry.ws, {
        t: "queued",
        mode,
        length: lane,
        waiting: waiting.length,
        serverNow: Date.now(),
        gatherMs: waiting.length >= 2 ? GATHER_MS : null,
      });
    }
  }

  emitRoom(code) {
    const members = this.roomMembers(code);
    if (!members.length) return;
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

  async fetch(request) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: "expected_websocket" }, { status: 426 });
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

    if (msg.t === "queue") {
      if (!isMode(msg.mode)) return this.send(ws, { t: "error", error: "Pick a mode." });
      const previousRoom = att.status === "room" ? att.room : null;
      const previous = att.status === "queue" ? { mode: att.mode, length: readLength(att.length) } : null;
      await this.releaseGroup(ws, att);
      att.status = "queue";
      att.mode = msg.mode;
      att.length = readLength(msg.length);
      att.room = null;
      att.host = false;
      ws.serializeAttachment(att);
      if (previousRoom) this.emitRoom(previousRoom);
      if (previous && (previous.mode !== att.mode || previous.length !== att.length)) this.announce(previous.mode, previous.length);
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
      await this.launch([{ ws, att }], att.mode, att.length, false);
      return;
    }

    if (msg.t === "rematch") {
      const raceId = String(msg.raceId || "");
      if (!/^[0-9a-f-]{36}$/i.test(raceId)) return;
      const record = await this.ctx.storage.get(`rematch:${raceId}`);
      const sameSocket = att.lastRace === raceId && (att.status === "matched" || att.status === "rematch");
      const listed = record && record.until >= Date.now() && Array.isArray(record.ids) && record.ids.includes(att.user.id);
      if (!sameSocket && !listed) return this.send(ws, { t: "error", error: "That rematch is closed." });
      if (!sameSocket) {
        if (!isMode(record.mode)) return this.send(ws, { t: "error", error: "That rematch is closed." });
        att.mode = record.mode;
        att.length = readLength(record.length);
        att.ranked = Boolean(record.ranked);
      }
      const previousRoom = att.status === "room" ? att.room : null;
      const previous = att.status === "queue" ? { mode: att.mode, length: readLength(att.length) } : null;
      att.status = "rematch";
      att.lastRace = raceId;
      att.room = null;
      att.host = false;
      ws.serializeAttachment(att);
      if (previousRoom) this.emitRoom(previousRoom);
      if (previous) this.announce(previous.mode, previous.length);
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
      if (members.length >= 6) return this.send(ws, { t: "error", error: "That room is full." });
      await this.releaseGroup(ws, att);
      const host = members.find((entry) => entry.att.host) || members[0];
      const previousRoom = att.status === "room" ? att.room : null;
      att.status = "room";
      att.mode = host.att.mode;
      att.length = readLength(host.att.length);
      att.room = code;
      att.host = false;
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
      await this.launch(members, att.mode, readLength(att.length), true);
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
      if (previous) this.announce(previous.mode, previous.length);
    }
  }

  async webSocketClose(ws) {
    const att = ws.deserializeAttachment();
    if (!att?.user) return;
    if (att.status === "room" && att.room) this.emitRoom(att.room);
    if (att.status === "queue" && att.mode) this.announce(att.mode, readLength(att.length));
    if (att.lastRace && (att.status === "matched" || att.status === "rematch")) await this.syncRematch(att.lastRace);
  }

  laneKey(mode, length) {
    return `${mode}:${readLength(length)}`;
  }

  async consider(mode, length) {
    const lane = readLength(length);
    const key = this.laneKey(mode, lane);
    if (this.holding[key]) return;
    const ready = this.queued(mode, lane);
    if (ready.length >= 4) {
      const launched = await this.launch(ready.slice(0, 4), mode, lane, true);
      if (launched && this.queued(mode, lane).length >= 2) await this.consider(mode, lane);
      return;
    }
    if (ready.length < 2) return;
    this.holding[key] = true;
    let launched = false;
    try {
      await delay(GATHER_MS);
      const gathered = this.queued(mode, lane);
      if (gathered.length >= 2) launched = await this.launch(gathered.slice(0, 4), mode, lane, true);
    } finally {
      this.holding[key] = false;
    }
    if (launched && this.queued(mode, lane).length >= 2) await this.consider(mode, lane);
  }

  async launch(members, mode, length, ranked) {
    const live = members.filter((entry) => entry.ws.readyState === WebSocket.OPEN);
    if (!live.length) return false;
    if (ranked && live.length < 2) return false;
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
      const sentence = pickPassage(mode, LENGTHS[lane].sentences);
      const startAt = Date.now() + 3800;
      const stub = this.env.RACE.get(this.env.RACE.idFromName(raceId));
      const response = await stub.fetch("https://race.internal/init", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ raceId, sentence, startAt, mode, length: lane, ranked, players }),
      });
      if (!response.ok) throw new Error(`race init ${response.status}`);
      await this.ctx.storage.put(`rematch:${raceId}`, {
        mode,
        length: lane,
        ranked: Boolean(ranked),
        ids: players.map((player) => player.id),
        until: Date.now() + 180000,
      });
      const match = {
        t: "match",
        raceId,
        sentence,
        startAt,
        serverNow: Date.now(),
        mode,
        length: lane,
        ranked,
        players,
      };
      for (const entry of live) {
        entry.att.lastRace = raceId;
        entry.att.mode = mode;
        entry.att.length = lane;
        entry.att.ranked = Boolean(ranked);
        entry.att.status = "matched";
        entry.ws.serializeAttachment(entry.att);
        this.send(entry.ws, match);
      }
      this.announce(mode, lane);
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
