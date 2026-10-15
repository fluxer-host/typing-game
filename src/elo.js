// Pairwise Elo, averaged across opponents so a 4-player room does not swing
// three times harder than a duel. K = 32, start at 1000, floor at 100.
export function eloDeltas(players, k = 32) {
  const deltas = Object.fromEntries(players.map((player) => [player.id, 0]));
  const count = players.length;
  if (count < 2) return deltas;
  for (let i = 0; i < count; i++) {
    for (let j = i + 1; j < count; j++) {
      const a = players[i];
      const b = players[j];
      const expectedA = 1 / (1 + 10 ** ((b.elo - a.elo) / 400));
      const expectedB = 1 - expectedA;
      let scoreA;
      let scoreB;
      if (a.place < b.place) {
        scoreA = 1;
        scoreB = 0;
      } else if (a.place > b.place) {
        scoreA = 0;
        scoreB = 1;
      } else {
        scoreA = 0.5;
        scoreB = 0.5;
      }
      deltas[a.id] += k * (scoreA - expectedA);
      deltas[b.id] += k * (scoreB - expectedB);
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
