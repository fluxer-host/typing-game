import { applyElo, eloDeltas } from "./elo.js";
import { accuracy, wpm } from "./score.js";

function ordered(state) {
  const rows = state.players.map((player) => {
    const finish = state.finishes[player.id];
    const progress = state.progress[player.id] || { i: 0, ok: 0, err: 0 };
    return {
      player,
      finished: Boolean(finish),
      at: finish ? finish.at : null,
      i: finish ? state.sentence.length : progress.i || 0,
      ok: (finish || progress).ok || 0,
      err: (finish || progress).err || 0,
    };
  });
  rows.sort((a, b) => {
    if (a.finished !== b.finished) return a.finished ? -1 : 1;
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
      const after = rated ? applyElo(before, deltas[row.player.id] || 0) : null;
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
