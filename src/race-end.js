// No accepted keystroke for this long, measured on the server clock, is a DNF.
// The clock starts at the race start, then resets on each accepted keystroke.
export const IDLE_MS = 20_000;

// A dropped socket can resume the same race until this passes.
export const RECONNECT_GRACE_MS = 15_000;

function clonePlayers(players) {
  return players.map((player) => ({ ...player }));
}

function findPlayer(players, id) {
  return players.find((player) => player.id === id) || null;
}

function isOut(player) {
  return Boolean(player.finished || player.forfeit || player.dnf);
}

function idleDue(player, startAt) {
  const activity = player.lastActivity == null ? startAt : Math.max(player.lastActivity, startAt);
  return activity + IDLE_MS;
}

function conclude(players, cause) {
  const racing = players.filter((player) => !isOut(player));
  const finished = players.some((player) => player.finished);
  if (racing.length === 1 && cause === "forfeit" && !finished && players.some((player) => player.forfeit)) {
    racing[0].forfeitWin = true;
  }
  return raceStanding(players);
}

// "results" seals a finish, a forfeit win, or an all-idle field.
// "cancel" drops the race with no winner and no rating change.
// null means at least one player is still racing.
export function raceStanding(players) {
  const list = players || [];
  const racing = list.filter((player) => !(player.finished || player.forfeit || player.dnf));
  const finished = list.some((player) => player.finished);
  if (list.some((player) => player.forfeitWin)) return "results";
  if (racing.length > 0) return null;
  if (finished) return "results";
  if (list.length > 0 && list.every((player) => player.forfeit)) return "cancel";
  if (list.length > 0 && list.every((player) => player.dnfReason === "disconnect" || player.forfeit)) return "cancel";
  if (list.length === 0) return null;
  return "results";
}

function unchanged(state, reason) {
  return { ok: false, reason, players: state.players, end: null, notices: [], resumed: false };
}

function accepted(players, end, notices, resumed) {
  return { ok: true, reason: null, players, end, notices, resumed };
}

// state.players entries carry finished, forfeit, dnf, dnfReason, forfeitWin,
// lastActivity, connected, and disconnectedAt. event.type is forfeit,
// disconnect, reconnect, activity, or tick. now is the server clock.
export function applyRaceEvent(state, event, now) {
  if (!state || !Array.isArray(state.players) || !event || typeof event.type !== "string" || !Number.isFinite(now)) {
    return unchanged(state || { players: [] }, "malformed");
  }
  const players = clonePlayers(state.players);
  const player = event.playerId == null ? null : findPlayer(players, event.playerId);

  if (event.type === "forfeit") {
    if (!player) return unchanged(state, "not-participant");
    if (player.forfeit || player.finished || player.dnf) return unchanged(state, "repeated");
    player.forfeit = true;
    player.forfeitWin = false;
    player.dnfReason = null;
    return accepted(players, conclude(players, "forfeit"), [{ playerId: player.id, kind: "forfeit" }], false);
  }

  if (event.type === "disconnect") {
    if (!player) return unchanged(state, "not-participant");
    if (isOut(player)) return accepted(state.players, null, [], false);
    player.connected = false;
    if (player.disconnectedAt == null) player.disconnectedAt = now;
    return accepted(players, null, [], false);
  }

  if (event.type === "reconnect") {
    if (!player) return unchanged(state, "not-participant");
    const expired = player.disconnectedAt != null && now >= player.disconnectedAt + RECONNECT_GRACE_MS;
    player.connected = true;
    player.disconnectedAt = null;
    if (isOut(player)) return accepted(players, null, [], false);
    if (!expired) return accepted(players, null, [], true);
    player.dnf = true;
    player.dnfReason = "disconnect";
    return accepted(players, conclude(players, "tick"), [{ playerId: player.id, kind: "disconnect" }], false);
  }

  if (event.type === "activity") {
    if (!player) return unchanged(state, "not-participant");
    if (isOut(player) || now < state.startAt) return accepted(state.players, null, [], false);
    player.lastActivity = now;
    player.connected = true;
    return accepted(players, null, [], false);
  }

  if (event.type === "tick") {
    const notices = [];
    for (const entry of players) {
      if (isOut(entry)) continue;
      if (!entry.connected && entry.disconnectedAt != null && now >= entry.disconnectedAt + RECONNECT_GRACE_MS) {
        entry.dnf = true;
        entry.dnfReason = "disconnect";
        notices.push({ playerId: entry.id, kind: "disconnect" });
        continue;
      }
      if (entry.connected && now >= state.startAt && now >= idleDue(entry, state.startAt)) {
        entry.dnf = true;
        entry.dnfReason = "idle";
        notices.push({ playerId: entry.id, kind: "timeout" });
      }
    }
    return accepted(players, conclude(players, "tick"), notices, false);
  }

  return unchanged(state, "malformed");
}

export function nextAlarmAt(state, now) {
  let next = state.startAt + state.limitMs;
  if (state.players.some((player) => player.forfeitWin)) return now;
  // Wake at the start so a player who never connected picks up a grace deadline.
  if (Number.isFinite(now) && now < state.startAt) next = Math.min(next, state.startAt);
  for (const player of state.players) {
    if (player.finished || player.forfeit || player.dnf) continue;
    if (!player.connected && player.disconnectedAt != null) {
      next = Math.min(next, player.disconnectedAt + RECONNECT_GRACE_MS);
    } else {
      const base = player.lastActivity == null ? state.startAt : Math.max(player.lastActivity, state.startAt);
      next = Math.min(next, base + IDLE_MS);
    }
  }
  return next;
}

export function resultsHeadline(rows, meId, cancelled) {
  if (cancelled) return { title: "Room closed", detail: "Everyone left before a finish." };
  const me = (rows || []).find((row) => row.id === meId);
  const others = (rows || []).filter((row) => row.id !== meId);
  if (!me) return { title: "Finish order", detail: "" };
  if (me.outcome === "forfeit") return { title: "You forfeited", detail: "This race counts as a loss." };
  if (me.outcome === "timeout" || me.outcome === "disconnect") return { title: "Timed out", detail: "The race moved on without you." };
  if (others.some((row) => row.outcome === "forfeit") && (me.outcome === "forfeit-win" || me.place === 1)) {
    return { title: "Opponent forfeited, you win", detail: "You take the win." };
  }
  if (me.place === 1 && others.some((row) => row.outcome === "timeout" || row.outcome === "disconnect")) {
    return { title: "You win", detail: "Your opponent timed out." };
  }
  return { title: "Finish order", detail: "" };
}
