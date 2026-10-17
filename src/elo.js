// Pairwise Elo, averaged across opponents so a 4-player field does not swing
// three times harder than a duel. K = 32, start at 1000, floor at 100.
//
// Repeated ranked matches between the same two accounts are reduced per pair.
// The first PAIR_RATED_LIMIT ranked finishes on one ladder inside
// PAIR_WINDOW_MS use the normal formula. Later finishes in that window
// contribute 0 for that pair only. Other opponents in the same race still
// move, and the three ladders do not share this count.
export const PAIR_WINDOW_MS = 60 * 60 * 1000;
export const PAIR_RATED_LIMIT = 2;

export function pairKey(a, b) {
  const left = String(a);
  const right = String(b);
  return left < right ? `${left}\0${right}` : `${right}\0${left}`;
}

export function pairFactor(priorCount) {
  const count = Number(priorCount) || 0;
  return count < PAIR_RATED_LIMIT ? 1 : 0;
}

export function expectedScore(eloA, eloB) {
  return 1 / (1 + 10 ** ((eloB - eloA) / 400));
}

// Raw points one player takes from one opponent, before the field is averaged.
export function eloDelta(player, opponent, k = 32) {
  const expected = expectedScore(player.elo, opponent.elo);
  const score = player.place < opponent.place ? 1 : player.place > opponent.place ? 0 : 0.5;
  return k * (score - expected);
}

export function eloDeltas(players, k = 32, pairFactorFor = null) {
  const deltas = Object.fromEntries(players.map((player) => [player.id, 0]));
  const count = players.length;
  if (count < 2) return deltas;
  for (let i = 0; i < count; i++) {
    for (let j = i + 1; j < count; j++) {
      const a = players[i];
      const b = players[j];
      const factor = typeof pairFactorFor === "function" ? pairFactorFor(a.id, b.id) : 1;
      const swing = factor * eloDelta(a, b, k);
      deltas[a.id] += swing;
      deltas[b.id] -= swing;
    }
  }
  const opponents = count - 1;
  for (const id of Object.keys(deltas)) {
    deltas[id] = Math.round(deltas[id] / opponents);
  }
  return deltas;
}

export function applyElo(current, delta) {
  return Math.max(100, Math.round(current + delta));
}
