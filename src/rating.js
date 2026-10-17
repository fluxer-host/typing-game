import { applyElo, eloDeltas, pairFactor, pairKey } from "./elo.js";
import { countsAsWin } from "./results.js";

export function pairCountsFromRows(rows, ids) {
  const byRace = new Map();
  for (const row of rows || []) {
    const raceId = row.raceId ?? row.race_id;
    const userId = row.userId ?? row.user_id;
    if (!raceId || !userId) continue;
    if (!byRace.has(raceId)) byRace.set(raceId, new Set());
    byRace.get(raceId).add(String(userId));
  }
  const unique = [...new Set((ids || []).map((id) => String(id)))];
  const counts = {};
  for (let i = 0; i < unique.length; i++) {
    for (let j = i + 1; j < unique.length; j++) {
      let n = 0;
      for (const set of byRace.values()) {
        if (set.has(unique[i]) && set.has(unique[j])) n += 1;
      }
      counts[pairKey(unique[i], unique[j])] = n;
    }
  }
  return counts;
}

function ratingOf(elos, id) {
  const parsed = Number(elos?.[id]);
  return Number.isFinite(parsed) ? parsed : 1000;
}

// Deltas are computed from the ratings passed in (the latest rows at apply
// time). A disqualified player adds 0. Unranked plans change nothing.
export function planRating(rows, { ranked, elos, pairCounts } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const rated = Boolean(ranked) && list.length >= 2;
  const factors = pairCounts || {};
  const deltas = rated
    ? eloDeltas(
      list.map((row) => ({ id: row.id, elo: ratingOf(elos, row.id), place: row.place })),
      32,
      (a, b) => pairFactor(factors[pairKey(a, b)] || 0),
    )
    : {};
  return list.map((row) => {
    if (!rated) {
      return { id: row.id, delta: 0, eloBefore: null, eloAfter: null, countRace: false, won: false };
    }
    const before = ratingOf(elos, row.id);
    const delta = row.dq ? 0 : (deltas[row.id] || 0);
    return {
      id: row.id,
      delta,
      eloBefore: before,
      eloAfter: applyElo(before, delta),
      countRace: true,
      won: Boolean(countsAsWin(row)),
    };
  });
}

// Mirrors `SET elo = MAX(100, elo + delta)` gated by a race id so the same
// race cannot apply twice. Each ladder is its own cell.
export function commitRating(book, plan, raceId, mode) {
  const users = JSON.parse(JSON.stringify(book?.users || {}));
  const applied = new Set(book?.applied || []);
  for (const row of plan || []) {
    const key = `${raceId}:${mode}:${row.id}`;
    if (applied.has(key)) continue;
    applied.add(key);
    if (!row.countRace) continue;
    if (!users[row.id]) users[row.id] = {};
    if (!users[row.id][mode]) users[row.id][mode] = { elo: 1000, races: 0, wins: 0 };
    const cell = users[row.id][mode];
    cell.elo = Math.max(100, cell.elo + row.delta);
    cell.races += 1;
    if (row.won) cell.wins += 1;
  }
  return { users, applied };
}

export function standingLabel(race) {
  if (race?.ranked) return "rated";
  const racers = Number(race?.racers ?? 0);
  if (race?.kind === "room" || racers >= 2) return "Unranked";
  return "practice";
}
