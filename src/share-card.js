// HTML and SVG for a share card. Every visitor-controlled string is escaped.
// The page has no inline script or style. It links the built stylesheet.

import { publicCardName } from "./share-name.js";

export const SITE_CSP = "default-src 'self'; img-src 'self' https://fluxerusercontent.com https://fluxerstatic.com; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'";

export const SHARE_CACHE = "public, max-age=31536000, immutable";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LADDERS = { desktop: "Desktop", mobile: "Mobile", cursor: "Cursor" };
const FORMATS = { passage: "Passage", timed: "Timed", punctuation: "Punctuation" };
const LENGTHS = { sprint: "Sprint", set: "Set", long: "Long" };

const ESCAPE = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ESCAPE[ch]);
}

export function svgText(value, max = 24) {
  const clean = String(value ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  const chars = Array.from(clean);
  const cut = chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : clean;
  return escapeHtml(cut);
}

export function formatShareDate(ms) {
  const date = new Date(Number(ms));
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

export function durationText(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return "";
  return `${(n / 1000).toFixed(1)} seconds`;
}

export function badgeLabel(card) {
  if (card?.kind === "practice") return "Practice";
  if (card?.ranked) return "Ranked";
  return "Race";
}

function timedLength(ms) {
  if (ms === 30000) return "30 seconds";
  if (ms === 60000) return "60 seconds";
  if (ms === 120000) return "120 seconds";
  return "";
}

export function detailLine(card) {
  const parts = [LADDERS[card?.ladder] || ""];
  if (FORMATS[card?.format]) parts.push(FORMATS[card.format]);
  if (card?.format === "timed") {
    const label = timedLength(card.ms);
    if (label) parts.push(label);
  } else if (LENGTHS[card?.length]) {
    parts.push(LENGTHS[card.length]);
  }
  if (card?.kind === "race" && card.place > 0) parts.push(`Place ${card.place}`);
  return parts.filter(Boolean).join(" · ");
}

export function shareTitle(card) {
  const pace = `${Number(card.wpm).toFixed(1)} WPM`;
  const badge = badgeLabel(card);
  if (badge === "Race") return `${pace} on Typing race`;
  return `${badge}, ${pace} on Typing race`;
}

export function shareDescription(card) {
  const parts = [
    detailLine(card),
    `${Number(card.accuracy).toFixed(1)}% accuracy`,
    durationText(card.ms),
    publicCardName(card.name),
    formatShareDate(card.at),
  ].filter(Boolean);
  if (card.kind === "practice") parts.push("This practice result was not checked against a saved race");
  return `${parts.join(". ")}.`;
}

export function securityHeaders(cache) {
  return new Headers({
    "cache-control": cache,
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "x-frame-options": "DENY",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    "content-security-policy": SITE_CSP,
  });
}

function safeOrigin(origin) {
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    return url.origin;
  } catch {
    return "";
  }
}

function stylesheetHref(value) {
  return typeof value === "string" && /^\/a\/styles\.[a-f0-9]{8}\.css$/.test(value) ? value : "";
}

export function sharePage({ card, origin, token, stylesheet }) {
  const root = safeOrigin(origin);
  const pageUrl = `${root}/s/${token}`;
  const imageUrl = `${pageUrl}/card.png`;
  const title = shareTitle(card);
  const description = shareDescription(card);
  const badge = badgeLabel(card);
  const name = publicCardName(card.name);
  const href = stylesheetHref(stylesheet);
  const style = href ? `<link rel="stylesheet" href="${escapeHtml(href)}">` : "";
  const practice = card.kind === "practice"
    ? `<p class="hint">This practice result was not checked against a saved race.</p>`
    : "";
  const pillClass = badge === "Practice" ? "pill practice" : badge === "Ranked" ? "pill ranked" : "pill";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <meta name="robots" content="noindex">
  <meta name="description" content="${escapeHtml(description)}">
  <meta name="theme-color" content="#0e0e12">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:type" content="website">
  <meta property="og:url" content="${escapeHtml(pageUrl)}">
  <meta property="og:image" content="${escapeHtml(imageUrl)}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="${escapeHtml(description)}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(title)}">
  <meta name="twitter:description" content="${escapeHtml(description)}">
  <meta name="twitter:image" content="${escapeHtml(imageUrl)}">
  <meta name="twitter:image:alt" content="${escapeHtml(description)}">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  ${style}
</head>
<body>
  <div class="app">
    <header class="top">
      <a class="brand" href="/">
        <svg class="mark" viewBox="0 0 32 32" aria-hidden="true">
          <rect width="32" height="32" rx="8" fill="#4641D9"/>
          <path d="M7 21c3-8 5-8 8 0s5 8 9 0" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"/>
          <rect x="23" y="8" width="2" height="12" rx="1" fill="#fff"/>
        </svg>
        <span class="brand-name">Typing race</span>
      </a>
    </header>
    <main class="layout">
      <section class="stage share-stage">
        <p class="${pillClass}">${escapeHtml(badge)}</p>
        <h1 class="share-wpm">${escapeHtml(Number(card.wpm).toFixed(1))} <span>WPM</span></h1>
        <p class="share-line">${escapeHtml(Number(card.accuracy).toFixed(1))}% accuracy</p>
        <p class="share-sub">${escapeHtml(detailLine(card))}</p>
        <p class="share-line">${escapeHtml(durationText(card.ms))}</p>
        <p class="share-line">${escapeHtml(name)}</p>
        <p class="share-sub">${escapeHtml(formatShareDate(card.at))}</p>
        <p class="hint">Anyone with this link can see this result.</p>
        ${practice}
        <div class="actions">
          <a class="btn primary" href="/">Play now</a>
        </div>
      </section>
    </main>
  </div>
</body>
</html>
`;
}

export function cardSvg(card) {
  const badge = badgeLabel(card);
  const badgeFill = badge === "Practice" ? "#e6b450" : badge === "Ranked" ? "#3dd68c" : "#a0a0b2";
  const name = svgText(publicCardName(card.name), 24);
  const detail = svgText(detailLine(card), 64);
  const when = svgText(formatShareDate(card.at), 24);
  const pace = svgText(Number(card.wpm).toFixed(1), 8);
  const accuracy = svgText(`${Number(card.accuracy).toFixed(1)}% accuracy`, 24);
  const duration = svgText(durationText(card.ms), 24);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#0e0e12"/>
  <rect x="40" y="36" width="1120" height="558" rx="28" fill="#16161d"/>
  <rect x="80" y="72" width="64" height="64" rx="16" fill="#4641d9"/>
  <path d="M96 120c6-16 10-16 16 0s10 16 18 0" fill="none" stroke="#ffffff" stroke-width="4" stroke-linecap="round"/>
  <rect x="132" y="92" width="5" height="28" rx="2" fill="#ffffff"/>
  <text x="164" y="116" fill="#f4f4f7" font-family="Liberation Sans" font-size="36" font-weight="700">Typing race</text>
  <text x="1120" y="114" fill="${badgeFill}" font-family="Liberation Sans" font-size="32" font-weight="700" text-anchor="end">${svgText(badge, 16)}</text>
  <text x="80" y="310" fill="#f4f4f7" font-family="Liberation Sans" font-size="148" font-weight="700">${pace}</text>
  <text x="80" y="372" fill="#a0a0b2" font-family="Liberation Sans" font-size="36">WPM</text>
  <text x="80" y="430" fill="#f4f4f7" font-family="Liberation Sans" font-size="36">${accuracy}</text>
  <text x="560" y="430" fill="#f4f4f7" font-family="Liberation Sans" font-size="36">${duration}</text>
  <text x="80" y="492" fill="#a0a0b2" font-family="Liberation Sans" font-size="30">${detail}</text>
  <text x="80" y="556" fill="#f4f4f7" font-family="Liberation Sans" font-size="32" font-weight="700">${name}</text>
  <text x="1120" y="556" fill="#a0a0b2" font-family="Liberation Sans" font-size="28" text-anchor="end">${when}</text>
</svg>
`;
}
