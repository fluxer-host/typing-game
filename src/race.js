import { saveRace } from "./db.js";
import { json } from "./http.js";
import { resolveUser } from "./identity.js";
import { isLength, LENGTHS } from "./lengths.js";
import { normalizeKind } from "./match.js";
import { isMode } from "./modes.js";
import { websocketOriginAllowed } from "./origin.js";
import { MAX_RACE_MESSAGE_CHARS, RATE_WINDOW_MS, validateProgress } from "./progress.js";
import { applyRaceEvent, nextAlarmAt, raceStanding } from "./race-end.js";
import { buildResults } from "./results.js";
import { readFormat } from "./formats.js";
import { ensureTimedStream, prepareUnrankedInit, pullTimedReveal, timedLimitAction } from "./timed-race.js";
import { reviewTimedSubmission, timedAlarmPlan } from "./timed.js";
import {
  ALARM_COALESCE_MS,
  PROGRESS_CHECKPOINT_MS,
  RACE_RETAIN_MS,
  WAKE_SYNC_MS,
  raceReadyToPurge,
  recoverableGap,
  shouldWriteProgress,
} from "./retention.js";
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
    this.progressDirty = false;
    this.lastProgressWrite = 0;
    this.armedFor = null;
    this.bootedAt = Date.now();
    this.ctx.blockConcurrencyWhile(async () => {
      this.state = (await this.ctx.storage.get("state")) || null;
      if (this.state?.results && this.state.purgeAt) {
        try {
          await this.ctx.storage.setAlarm(Math.max(this.state.purgeAt, Date.now() + 250));
        } catch {
          // The stored alarm still fires when it was already set.
        }
      }
    });
  }

  async persist() {
    await this.ctx.storage.put("state", this.state);
    this.progressDirty = false;
    this.lastProgressWrite = Date.now();
  }

  async noteProgress(reason, now = Date.now()) {
    if (reason === "progress") this.progressDirty = true;
    const write = shouldWriteProgress({
      reason,
      now,
      lastWrite: this.lastProgressWrite,
      checkpointMs: PROGRESS_CHECKPOINT_MS,
      dirty: this.progressDirty,
    });
    if (!write) return false;
    await this.persist();
    return true;
  }

  async schedulePurge() {
    if (!this.state) return;
    this.state.purgeAt = Date.now() + RACE_RETAIN_MS;
    await this.persist();
    try {
      await this.ctx.storage.setAlarm(this.state.purgeAt);
      this.armedFor = this.state.purgeAt;
    } catch {
      // A later wake arms the purge from purgeAt.
    }
  }

  async purge() {
    if (!raceReadyToPurge(this.state, Date.now())) return;
    try {
      await this.ctx.storage.deleteAll();
    } catch (error) {
      console.error("race purge failed", error);
      return;
    }
    this.state = null;
    this.progressDirty = false;
    this.armedFor = null;
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

  decisionState(now = Date.now()) {
    const connected = this.connectedIds();
    const presence = this.state.presence || {};
    return {
      startAt: this.state.startAt,
      limitMs: this.state.limitMs || RACE_LIMIT_MS,
      players: this.state.players.map((player) => {
        const row = presence[player.id] || {};
        const progress = this.state.progress[player.id] || {};
        const dq = Boolean(progress.dq);
        const connectedNow = connected.has(player.id);
        // Keep a missing stamp missing. Filling it with the race start made a
        // reload after the grace window look expired, even when the socket
        // had only just closed. The tick records the start for someone who
        // never connected, and a disconnect event records the drop.
        const disconnectedAt = row.disconnectedAt ?? null;
        const dnfReason = row.dnfReason === "idle" || row.dnfReason === "disconnect" ? row.dnfReason : (dq ? "dq" : null);
        return {
          id: player.id,
          finished: Boolean(this.state.finishes[player.id]) && !dq,
          forfeit: Boolean(row.forfeit),
          dnf: Boolean(row.dnf) || dq,
          dnfReason,
          forfeitWin: Boolean(row.forfeitWin),
          lastActivity: row.lastActivity ?? null,
          connected: connectedNow,
          disconnectedAt,
        };
      }),
    };
  }

  storeDecision(players) {
    const presence = {};
    for (const player of players) {
      const idleOrDrop = player.dnfReason === "idle" || player.dnfReason === "disconnect";
      presence[player.id] = {
        lastActivity: player.lastActivity ?? null,
        disconnectedAt: player.connected ? null : (player.disconnectedAt ?? null),
        forfeit: Boolean(player.forfeit),
        forfeitWin: Boolean(player.forfeitWin) && !player.forfeit,
        dnf: idleOrDrop,
        dnfReason: idleOrDrop ? player.dnfReason : null,
      };
    }
    this.state.presence = presence;
  }

  currentEnd(now = Date.now()) {
    return raceStanding(this.decisionState(now).players);
  }

  playerViews() {
    const now = Date.now();
    const connected = this.connectedIds();
    return this.state.players.map((player) => {
      const finish = this.state.finishes[player.id];
      const progress = this.state.progress[player.id] || { i: 0, ok: 0, err: 0 };
      const presence = this.state.presence?.[player.id] || {};
      const dq = Boolean(progress.dq);
      const finished = Boolean(finish) && !dq;
      let status = "racing";
      if (finished) status = "finished";
      else if (presence.forfeit) status = "forfeit";
      else if (presence.dnfReason === "idle") status = "timeout";
      else if (presence.dnfReason === "disconnect" || dq) status = "disconnect";
      else if (!connected.has(player.id) && (presence.disconnectedAt != null || now >= this.state.startAt)) status = "away";
      const index = finished ? this.state.sentence.length : progress.i || 0;
      const end = finish?.at || now;
      const elapsed = Math.max(0, Math.min(end, now) - this.state.startAt);
      return {
        id: player.id,
        i: index,
        ok: (finished ? finish : progress).ok || 0,
        err: (finished ? finish : progress).err || 0,
        finishedAt: finished ? finish.at : null,
        wpm: now < this.state.startAt ? 0 : wpm(index, Math.max(1, elapsed)),
        status,
      };
    });
  }

  snapshot() {
    return {
      t: "state",
      serverNow: Date.now(),
      startAt: this.state.startAt,
      players: this.playerViews(),
    };
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/init") return this.init(request);
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      if (!websocketOriginAllowed(request.headers.get("origin"), request.url, this.env.ALLOWED_ORIGINS)) {
        return json({ error: "origin" }, { status: 403 });
      }
      return this.join(request);
    }
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
    const format = readFormat(body.format);
    let limitMs = LENGTHS[length].limitMs;
    let sentence = body.sentence;
    let extra = {};
    if (format === "passage") {
      if (!isMode(body.mode) || !passageOk(body.mode, LENGTHS[length].sentences, body.sentence)) {
        return json({ error: "race" }, { status: 400 });
      }
    } else {
      const prepared = prepareUnrankedInit(body);
      if (prepared.error) return json({ error: prepared.error }, { status: 400 });
      limitMs = prepared.limitMs;
      sentence = prepared.sentence;
      extra = prepared.extra;
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
    const kind = normalizeKind(body.kind, Boolean(body.ranked), players.length);
    const ranked = kind === "queue";
    this.state = {
      raceId: String(body.raceId),
      mode: body.mode,
      length,
      limitMs,
      ranked,
      kind,
      sentence,
      ...extra,
      startAt,
      players,
      progress: {},
      finishes: {},
      results: null,
      saved: false,
      presence: {},
    };
    await this.noteProgress("start");
    await this.arm();
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
      format: this.state.format || "passage",
      durationMs: this.state.durationMs || 0,
      ranked: this.state.ranked,
      kind: this.state.kind || normalizeKind(null, this.state.ranked, this.state.players.length),
      players: this.state.players,
      progress: viewProgress(this.state.progress),
      finishes: this.state.finishes,
      results: this.state.results,
      racers: this.playerViews(),
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
    const now = Date.now();
    const decision = this.decisionState(now);
    const outcome = applyRaceEvent(decision, { type: "reconnect", playerId: id }, now);
    if (outcome.ok) this.storeDecision(outcome.players);
    await this.noteProgress("reconnect", now);
    server.send(JSON.stringify(this.hello()));
    this.broadcast(this.snapshot());
    await this.settle(outcome.end);
    if (!this.state.results) await this.arm();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    if (!this.state) return;
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
    if (msg?.t === "leave") {
      await this.leave(att.id, ws);
      return;
    }
    if (this.state.results) {
      this.send(ws, { t: "results", ...this.state.results });
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
    const timed = this.state.format === "timed";
    if (timed) ensureTimedStream(this.state, typeof msg.text === "string" ? msg.text.length : 0);
    const verdict = timed
      ? reviewTimedSubmission({
        stream: this.state.stream,
        previous: typeof progress.text === "string" ? progress.text : "",
        next: msg.text,
        elapsedMs: now - this.state.startAt,
        recentStrokes: recent.length,
        priorStrokes: progress.total || 0,
        kind: msg.t,
        now,
        startAt: this.state.startAt,
        durationMs: this.state.durationMs || this.state.limitMs,
        ended: Boolean(this.state.results),
      })
      : validateProgress({
        passage: this.state.sentence,
        previous: typeof progress.text === "string" ? progress.text : "",
        next: msg.text,
        elapsedMs: now - this.state.startAt,
        recentStrokes: recent.length,
        priorStrokes: progress.total || 0,
        kind: msg.t,
      });
    if (!verdict.ok && timed && (verdict.reason === "closed" || verdict.reason === "ended")) {
      await this.finalize();
      return;
    }
    if (!verdict.ok) {
      const sync = { text: progress.text || "", ok: progress.ok || 0, err: progress.err || 0 };
      if (verdict.reason === "jump" && recoverableGap({
        previous: sync.text,
        next: msg.text,
        bootedAgeMs: now - this.bootedAt,
        checkpointMs: PROGRESS_CHECKPOINT_MS,
        wakeMs: WAKE_SYNC_MS,
      })) {
        this.send(ws, { t: "sync", ...sync });
        return;
      }
      this.noteReject(player.id, verdict.reason, verdict.disqualify);
      if (verdict.reason === "early") {
        this.send(ws, { t: "wait", serverNow: now, startAt: this.state.startAt, ...sync });
        return;
      }
      if (verdict.disqualify) {
        progress.dq = true;
        this.state.progress[player.id] = progress;
        await this.noteProgress("dnf", now);
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
    const activity = applyRaceEvent(this.decisionState(now), { type: "activity", playerId: player.id }, now);
    if (activity.ok) this.storeDecision(activity.players);
    if (verdict.finished && !timed) {
      this.state.finishes[player.id] = { at: now, ok: progress.ok, err: progress.err };
    }
    const chunk = timed ? pullTimedReveal(this.state, progress.i) : null;
    await this.noteProgress(chunk ? "chunk" : (verdict.finished ? "finish" : "progress"), now);
    this.broadcast(this.snapshot());
    if (chunk) this.broadcast({ t: "chunk", sentence: chunk, serverNow: now });
    await this.maybeFinish();
    await this.arm();
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

  async webSocketClose(ws) {
    if (!this.state || this.state.results) return;
    const att = ws?.deserializeAttachment?.();
    if (!att?.id) return;
    if (this.connectedIds().has(att.id)) return;
    const now = Date.now();
    const decision = this.decisionState(now);
    const outcome = applyRaceEvent(decision, { type: "disconnect", playerId: att.id }, now);
    if (!outcome.ok || outcome.players === decision.players) return;
    this.storeDecision(outcome.players);
    await this.noteProgress("disconnect", now);
    this.broadcast(this.snapshot());
    await this.arm();
  }

  async leave(playerId, ws) {
    if (!this.state || this.state.saved) return;
    if (!this.state.players.some((player) => player.id === playerId)) return;
    const now = Date.now();
    const decision = this.decisionState(now);
    const outcome = applyRaceEvent(decision, { type: "forfeit", playerId }, now);
    this.send(ws, { t: "left", ranked: Boolean(this.state.ranked) });
    if (!outcome.ok) return;
    this.storeDecision(outcome.players);
    const end = raceStanding(outcome.players);
    if (end === "cancel") this.state.results = null;
    await this.noteProgress("forfeit", now);
    this.broadcast(this.snapshot());
    if (this.state.saved) return;
    // Seal on the alarm so a second forfeit can land before saveRace runs.
    if (end) await this.ctx.storage.setAlarm(Date.now());
    else await this.arm();
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
    await this.schedulePurge();
    this.broadcast({ t: "results", ...this.state.results });
  }

  async maybeFinish() {
    if (!this.state || this.state.results) return;
    await this.settle(this.currentEnd());
  }

  async settle(end) {
    if (!this.state || this.state.results) return;
    if (end === "cancel") await this.cancel();
    else if (end === "results") await this.finalize();
  }

  async arm() {
    if (!this.state || this.state.results) return;
    const now = Date.now();
    let when = nextAlarmAt(this.decisionState(now), now);
    if (this.progressDirty) {
      const due = (this.lastProgressWrite || 0) + PROGRESS_CHECKPOINT_MS;
      when = Math.min(when, due);
    }
    const fireAt = when <= now ? now + 250 : when;
    if (this.armedFor != null && this.armedFor > now && Math.abs(this.armedFor - fireAt) < ALARM_COALESCE_MS) return;
    try {
      await this.ctx.storage.setAlarm(fireAt);
      this.armedFor = fireAt;
    } catch {
      // The next accepted event arms again.
    }
  }

  async webSocketError(_ws, error) {
    console.error("race socket error", error);
  }

  async alarm() {
    if (!this.state) return;
    const now = Date.now();
    if (raceReadyToPurge(this.state, now)) {
      await this.purge();
      return;
    }
    if (this.state.format === "timed") {
      const action = timedAlarmPlan(this.state, now);
      if (action === "ended") {
        if (!this.state.saved && !this.state.results.cancelled) await this.writeResults();
        return;
      }
    }
    if (this.state.results) {
      if (!this.state.saved && !this.state.results.cancelled) await this.writeResults();
      return;
    }
    const limitAt = this.state.startAt + (this.state.limitMs || RACE_LIMIT_MS);
    if (now >= limitAt && this.state.format === "timed") {
      this.state.timeUp = true;
      const standing = this.currentEnd(now);
      if (timedLimitAction(standing) === "cancel") {
        await this.cancel();
        return;
      }
      await this.finalize();
      return;
    }
    if (now >= limitAt) {
      const standing = this.currentEnd(now);
      if (standing === "cancel" || (Object.keys(this.state.finishes).length === 0 && this.connectedIds().size === 0 && standing !== "results")) {
        await this.cancel();
        return;
      }
      await this.finalize();
      return;
    }
    const decision = this.decisionState(now);
    const outcome = applyRaceEvent(decision, { type: "tick" }, now);
    if (outcome.ok) this.storeDecision(outcome.players);
    if (outcome.notices.length || outcome.end) await this.noteProgress("dnf", now);
    else if (this.progressDirty) await this.noteProgress("progress", now);
    if (outcome.notices.length) this.broadcast(this.snapshot());
    if (outcome.end === "cancel") {
      await this.cancel();
      return;
    }
    if (outcome.end === "results") {
      await this.finalize();
      return;
    }
    await this.arm();
  }

  async finalize() {
    if (!this.state || this.state.results || this.finalizing) return;
    this.finalizing = true;
    const finishedAt = Date.now();
    this.state.results = buildResults(this.state, finishedAt);
    this.state.finishedAt = finishedAt;
    await this.persist();
    await this.writeResults();
    if (!this.state?.saved) this.broadcast({ t: "results", ...this.state.results });
  }

  async writeResults() {
    if (!this.state?.results || this.state.results.cancelled || this.state.saved || this.writing) return;
    if (this.currentEnd() === "cancel") {
      this.state.results = null;
      await this.cancel();
      return;
    }
    this.writing = true;
    try {
      const saved = await saveRace(this.env, {
        id: this.state.raceId,
        mode: this.state.mode,
        sentence: this.state.sentence,
        ranked: this.state.ranked,
        format: this.state.format || "passage",
        startedAt: this.state.startAt,
        finishedAt: this.state.finishedAt || Date.now(),
        rows: this.state.results.rows,
      });
      if (saved?.rows && this.state.results?.rows) {
        const byId = new Map(saved.rows.map((row) => [row.id, row]));
        this.state.results.rows = this.state.results.rows.map((row) => {
          const next = byId.get(row.id);
          if (!next) return row;
          return { ...row, eloBefore: next.eloBefore ?? null, eloAfter: next.eloAfter ?? null };
        });
      }
      this.state.saved = true;
      await this.schedulePurge();
      this.broadcast({ t: "results", ...this.state.results });
    } catch (error) {
      console.error("save race failed", error);
      try {
        await this.ctx.storage.setAlarm(Date.now() + 5000);
      } catch {
        // Retry on the next message instead.
      }
    } finally {
      this.writing = false;
    }
  }
}
