// WCAG 2 contrast. Shared by the unit tests. The page does not import this.

export function hexChannels(input) {
  if (typeof input !== "string") return null;
  let hex = input.trim().replace(/^#/, "");
  if (hex.length === 3) hex = hex.split("").map((ch) => ch + ch).join("");
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null;
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ];
}

function linearize(channel) {
  const value = channel / 255;
  if (value <= 0.04045) return value / 12.92;
  return ((value + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex) {
  const channels = hexChannels(hex);
  if (!channels) return null;
  const [red, green, blue] = channels;
  return 0.2126 * linearize(red) + 0.7152 * linearize(green) + 0.0722 * linearize(blue);
}

export function contrastRatio(foreground, background) {
  const left = relativeLuminance(foreground);
  const right = relativeLuminance(background);
  if (left == null || right == null) return null;
  const lighter = Math.max(left, right);
  const darker = Math.min(left, right);
  return (lighter + 0.05) / (darker + 0.05);
}

export function compositeHex(foreground, background, alpha) {
  const fg = hexChannels(foreground);
  const bg = hexChannels(background);
  const amount = Number(alpha);
  if (!fg || !bg || !Number.isFinite(amount) || amount < 0 || amount > 1) return null;
  const mixed = fg.map((channel, index) => Math.round(channel * amount + bg[index] * (1 - amount)));
  return `#${mixed.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}
