export function json(data, { status = 200, cookies = [], cache = "no-store" } = {}) {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": cache,
    "x-content-type-options": "nosniff",
  });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(JSON.stringify(data), { status, headers });
}

export function redirect(location, cookies = []) {
  const headers = new Headers({
    location,
    "cache-control": "no-store",
  });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
}

export function sameOrigin(request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}
