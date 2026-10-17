// The request host is always allowed. ALLOWED_ORIGINS is a comma-separated
// list of extra Origin values (scheme, host, and port) for preview hosts.
export function allowedOriginList(requestUrl, extra) {
  let own = "";
  try {
    own = new URL(requestUrl).origin;
  } catch {
    own = "";
  }
  const more = String(extra || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set([own, ...more].filter(Boolean))];
}

// Browsers send Origin on a WebSocket upgrade. A missing or foreign Origin
// is refused. Non-browser clients must send the site origin themselves.
export function websocketOriginAllowed(originHeader, requestUrl, extra) {
  if (!originHeader || typeof originHeader !== "string") return false;
  return allowedOriginList(requestUrl, extra).includes(originHeader);
}
