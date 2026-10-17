export const LENGTHS = {
  sprint: { sentences: 1, title: "Sprint", blurb: "A short passage.", limitMs: 120000 },
  set: { sentences: 3, title: "Set", blurb: "A medium passage.", limitMs: 240000 },
  long: { sentences: 5, title: "Long", blurb: "A long passage.", limitMs: 360000 },
};

export function isLength(value) {
  return Object.prototype.hasOwnProperty.call(LENGTHS, value);
}

export function lengthList() {
  return Object.entries(LENGTHS).map(([id, row]) => ({
    id,
    title: row.title,
    blurb: row.blurb,
    sentences: row.sentences,
  }));
}
