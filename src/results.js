import { applyElo, eloDeltas } from "./elo.js";
import { accuracy, wpm } from "./score.js";

function presenceOf(state, id) {
  return state.presence?.[id] || {};
}

function outcomeFor(presence, finished) {
  if (finished) return "finished";
  if (presence.forfeitWin) return "forfeit-win";
  if (presence.forfeit) return "forfeit";
  if (presence.dnfReason === "idle") return "timeout";
  if (presence.dnfReason === "disconnect") return "disconnect";
  return "dnf";
}

export function countsAsWin(row) {
  return row.place === 1 && (row.ms != null || row.outcome === "forfeit-win");
}

function ordered(state) {
  const rows = state.players.map((player) => {
    const finish = state.finishes[player.id];
    const progress = state.progress[player.id] || { i: 0, ok: 0, err: 0 };
    const presence = presenceOf(state, player.id);
    const dq = Boolean(progress.dq);
    const finished = Boolean(finish) && !dq && !presence.forfeit && presence.dnfReason !== "idle" && presence.dnfReason !== "disconnect";
    const forfeitWin = Boolean(presence.forfeitWin) && !finished;
    return {
      player,
      dq,
      finished,
      forfeitWin,
      outcome: outcomeFor({ ...presence, forfeitWin }, finished),
      at: finished ? finish.at : null,
      i: finished ? state.sentence.length : progress.i || 0,
      ok: (finished ? finish : progress).ok || 0,
      err: (finished ? finish : progress).err || 0,
    };
  });
  rows.sort((a, b) => {
    const group = (row) => (row.finished ? 0 : row.forfeitWin ? 1 : 2);
    const ga = group(a);
    const gb = group(b);
    if (ga !== gb) return ga - gb;
    if (a.finished && b.finished) return a.at - b.at;
    if (a.i !== b.i) return b.i - a.i;
    return String(a.player.name).localeCompare(String(b.player.name));
  });
  return rows.map((row, index) => ({ ...row, place: index + 1 }));
}

export function buildResults(state, now) {
  const rows = ordered(state);
  const rated = Boolean(state.ranked) && rows.length >= 2;
  const deltas = rated
    ? eloDeltas(rows.map((row) => ({ id: row.player.id, elo: row.player.eloAtStart ?? 1000, place: row.place })))
    : {};
  return {
    cancelled: false,
    ranked: Boolean(state.ranked),
    mode: state.mode,
    sentence: state.sentence,
    rows: rows.map((row) => {
      const before = row.player.eloAtStart ?? 1000;
      // A disqualified player keeps the elo they started with. Everyone else
      // still uses the normal pairwise result, so an honest finish still gains.
      const after = !rated ? null : row.dq ? before : applyElo(before, deltas[row.player.id] || 0);
      const end = row.at || now;
      const elapsed = Math.max(1, end - state.startAt);
      const chars = row.finished ? state.sentence.length : row.i;
      const typed = (row.ok || 0) + (row.err || 0);
      return {
        id: row.player.id,
        name: row.player.name,
        tag: row.player.tag,
        avatar: row.player.avatar || null,
        color: row.player.color ?? null,
        place: row.place,
        finished: row.finished,
        outcome: row.outcome,
        wpm: wpm(chars, elapsed),
        accuracy: typed > 0 ? accuracy(row.ok, row.err) : row.finished ? 100 : 0,
        ms: row.finished ? end - state.startAt : null,
        progress: chars,
        eloBefore: state.ranked ? before : null,
        eloAfter: rated ? after : null,
      };
    }),
  };
}
