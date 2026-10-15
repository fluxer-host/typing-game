// Monkeytype-style net speed: five characters count as one word.
export function wpm(chars, ms) {
  if (!Number.isFinite(chars) || !Number.isFinite(ms) || chars <= 0 || ms <= 0) return 0;
  const value = chars / 5 / (ms / 60000);
  return Math.round(value * 10) / 10;
}

export function accuracy(ok, err) {
  const good = Number.isFinite(ok) && ok > 0 ? ok : 0;
  const bad = Number.isFinite(err) && err > 0 ? err : 0;
  const total = good + bad;
  if (total <= 0) return 100;
  return Math.round((good / total) * 1000) / 10;
}
