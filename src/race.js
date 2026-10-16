import { saveRace } from "./db.js";
import { json } from "./http.js";
import { resolveUser } from "./identity.js";
import { isLength, LENGTHS } from "./lengths.js";
import { isMode } from "./modes.js";
import { MAX_RACE_MESSAGE_CHARS, RATE_WINDOW_MS, validateProgress } from "./progress.js";
import { buildResults } from "./results.js";
import { passageOk } from "./sentences.js";
import { wpm } from "./score.js";

const RACE_LIMIT_MS = 120000;

function viewProgress(progress) {
  const view = {};
  for (const [id, row] of Object.entries(progress || {})) {
    view[id] = { i: row?.i || 0, ok: row?.ok || 0, err: row?.err || 0 };
  }
  return view;
}

export class Race {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.state = null;
    this.finalizing = false;
    this.ctx.blockConcurrencyWhile(async () => {
      this.state = (await this.ctx.storage.get("state")) || null;
    });
  }

  async persist() {
    await this.ctx.storage.put("state", this.state);
  }

  connectedIds() {
    const ids = new Set();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const att = ws.deserializeAttachment();
      if (att?.id) ids.add(att.id);
    }
    return ids;
  }

  broadcast(payload) {
    const data = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
      } catch {
        // Closed socket.
      }
    }
  }

  snapshot() {
    const now = Date.now();
    return {
      t: "state",
      serverNow: now,
      startAt: this.state.startAt,
      players: this.state.players.map((player) => {
        const finish = this.state.finishes[player.id];
        const progress = this.state.progress[player.id] || { i: 0, ok: 0, err: 0 };
        const index = finish ? this.state.sentence.length : progress.i || 0;
        const end = finish?.at || now;
        const elapsed = Math.max(0, Math.min(end, now) - this.state.startAt);
        return {
          id: player.id,
          i: index,
          ok: (finish || progress).ok || 0,
          err: (finish || progress).err || 0,
          finishedAt: finish?.at || null,
          wpm: now < this.state.startAt ? 0 : wpm(index, Math.max(1, elapsed)),
        };
      }),
    };
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/init") return this.init(request);
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") return this.join(request);
    return new Response("not found", { status: 404 });
  }

  async init(request) {
    if (this.state) return json({ error: "exists" }, { status: 409 });
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "body" }, { status: 400 });
    }
    const length = isLength(body.length) ? body.length : "sprint";
    const limitMs = LENGTHS[length].limitMs;
    if (!isMode(body.mode) || !passageOk(body.mode, LENGTHS[length].sentences, body.sentence)) {
      return json({ error: "race" }, { status: 400 });
    }
    if (!Array.isArray(body.players) || body.players.length < 1 || body.players.length > 6) {
      return json({ error: "players" }, { status: 400 });
    }
    const players = body.players.map((player) => ({
      id: String(player.id),
      name: String(player.name || "racer").slice(0, 64),
      tag: String(player.tag || player.name || "racer").slice(0, 80),
      avatar: player.avatar || null,
      color: player.color ?? null,
      eloAtStart: Number(player.eloAtStart ?? player.elo?.[body.mode] ?? 1000),
    }));
    if (new Set(players.map((player) => player.id)).size !== players.length) {
      return json({ error: "players" }, { status: 400 });
    }
    const startAt = Number(body.startAt);
    if (!Number.isFinite(startAt)) return json({ error: "start" }, { status: 400 });
    this.state = {
      raceId: String(body.raceId),
      mode: body.mode,
      length,
      limitMs,
      ranked: Boolean(body.ranked),
      sentence: body.sentence,
      startAt,
      players,
      progress: {},
      finishes: {},
      results: null,
      saved: false,
    };
    await this.persist();
    await this.ctx.storage.setAlarm(startAt + limitMs);
    return json({ ok: true });
  }

  hello() {
    return {
      t: "hello",
      raceId: this.state.raceId,
      sentence: this.state.sentence,
      startAt: this.state.startAt,
      serverNow: Date.now(),
      mode: this.state.mode,
      length: this.state.length || "sprint",
      ranked: this.state.ranked,
      players: this.state.players,
      progress: viewProgress(this.state.progress),
      finishes: this.state.finishes,
      results: this.state.results,
    };
  }

  async join(request) {
    if (!this.state) return new Response("no race", { status: 404 });
    const resolved = await resolveUser(request, this.env);
    if (!resolved) return new Response("unauthorized", { status: 401 });
    const id = resolved.user.id;
    if (!this.state.players.some((player) => player.id === id)) return new Response("not in race", { status: 403 });
    for (const other of this.ctx.getWebSockets()) {
      const att = other.deserializeAttachment();
      if (att?.id === id) {
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
    server.serializeAttachment({ id });
    server.send(JSON.stringify(this.hello()));
    this.broadcast(this.snapshot());
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    if (!this.state || this.state.results) {
      if (this.state?.results) {
        try {
          ws.send(JSON.stringify({ t: "results", ...this.state.results }));
        } catch {
          // Closed.
        }
      }
      return;
    }
    const att = ws.deserializeAttachment();
    if (!att?.id) return;
    let text = raw;
    if (typeof text !== "string") text = new TextDecoder().decode(text);
    if (text.length > MAX_RACE_MESSAGE_CHARS) {
      this.noteReject(att.id, "malformed", false);
      return;
    }
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (!msg || (msg.t !== "prog" && msg.t !== "fin")) return;
    const player = this.state.players.find((entry) => entry.id === att.id);
    if (!player || this.state.finishes[player.id]) return;
    const now = Date.now();
    if (now > this.state.startAt + (this.state.limitMs || RACE_LIMIT_MS)) {
      await this.finalize();
      return;
    }
    const progress = this.state.progress[player.id] || { text: "", i: 0, ok: 0, err: 0, total: 0, recent: [] };
    if (progress.dq) return;
    const recent = (progress.recent || []).filter((stamp) => now - stamp < RATE_WINDOW_MS && now - stamp >= 0);
    const verdict = validateProgress({
      passage: this.state.sentence,
      previous: typeof progress.text === "string" ? progress.text : "",
      next: msg.text,
      elapsedMs: now - this.state.startAt,
      recentStrokes: recent.length,
      priorStrokes: progress.total || 0,
      kind: msg.t,
    });
    if (!verdict.ok) {
      this.noteReject(player.id, verdict.reason, verdict.disqualify);
      const sync = { text: progress.text || "", ok: progress.ok || 0, err: progress.err || 0 };
      if (verdict.reason === "early") {
        this.send(ws, { t: "wait", serverNow: now, startAt: this.state.startAt, ...sync });
        return;
      }
      if (verdict.disqualify) {
        progress.dq = true;
        this.state.progress[player.id] = progress;
        await this.persist();
        this.send(ws, { t: "sync", ...sync });
        this.broadcast(this.snapshot());
        await this.maybeFinish();
        return;
      }
      this.send(ws, { t: "sync", ...sync });
      return;
    }
    progress.text = verdict.text;
    progress.i = verdict.index;
    progress.ok = (progress.ok || 0) + verdict.okDelta;
    progress.err = (progress.err || 0) + verdict.errDelta;
    progress.total = (progress.total || 0) + 1;
    progress.recent = recent.concat(now);
    this.state.progress[player.id] = progress;
    if (verdict.finished) {
      this.state.finishes[player.id] = { at: now, ok: progress.ok, err: progress.err };
    }
    await this.persist();
    this.broadcast(this.snapshot());
    await this.maybeFinish();
  }

  noteReject(playerId, reason, disqualify) {
    console.log(JSON.stringify({
      event: "race_input_rejected",
      raceId: this.state?.raceId || null,
      playerId,
      reason,
      disqualify: Boolean(disqualify),
    }));
  }

  send(ws, payload) {
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      // Closed socket.
    }
  }

  async webSocketClose() {
    await this.maybeFinish();
  }

  async cancel() {
    if (!this.state || this.state.results) return;
    this.state.results = {
      cancelled: true,
      ranked: this.state.ranked,
      mode: this.state.mode,
      sentence: this.state.sentence,
      rows: [],
    };
    this.state.saved = true;
    await this.persist();
    try {
      await this.ctx.storage.deleteAlarm();
    } catch {
      // Alarm already gone.
    }
  }

  async maybeFinish() {
    if (!this.state || this.state.results) return;
    const connected = this.connectedIds();
    const pending = this.state.players.filter((player) => {
      if (this.state.finishes[player.id] || this.state.progress[player.id]?.dq) return false;
      return connected.has(player.id);
    });
    if (pending.length > 0) return;
    if (Object.keys(this.state.finishes).length === 0) {
      if (connected.size === 0) await this.cancel();
      return;
    }
    await this.finalize();
  }

  async webSocketError(_ws, error) {
    console.error("race socket error", error);
  }

  async alarm() {
    if (!this.state) return;
    if (!this.state.results) {
      const nobodyFinished = Object.keys(this.state.finishes).length === 0;
      if (nobodyFinished && this.connectedIds().size === 0) {
        await this.cancel();
        return;
      }
      await this.finalize();
      return;
    }
    if (!this.state.saved && !this.state.results.cancelled) await this.writeResults();
  }

  async finalize() {
    if (!this.state || this.state.results || this.finalizing) return;
    this.finalizing = true;
    const finishedAt = Date.now();
    this.state.results = buildResults(this.state, finishedAt);
    this.state.finishedAt = finishedAt;
    await this.persist();
    await this.writeResults();
    this.broadcast({ t: "results", ...this.state.results });
  }

  async writeResults() {
    if (!this.state?.results || this.state.results.cancelled || this.state.saved) return;
    try {
      await saveRace(this.env, {
        id: this.state.raceId,
        mode: this.state.mode,
        sentence: this.state.sentence,
        ranked: this.state.ranked,
        startedAt: this.state.startAt,
        finishedAt: this.state.finishedAt || Date.now(),
        rows: this.state.results.rows,
      });
      this.state.saved = true;
      await this.persist();
      await this.ctx.storage.deleteAlarm();
    } catch (error) {
      console.error("save race failed", error);
      try {
        await this.ctx.storage.setAlarm(Date.now() + 5000);
      } catch {
        // Retry on the next message instead.
      }
    }
  }
}
