import { getSession, getUser } from "./db.js";
import { readCookie, readPayload, secretOk } from "./session.js";

export async function resolveUser(request, env) {
  if (!secretOk(env)) return null;
  const url = new URL(request.url);
  let token = readCookie(request, "tg_session");
  if (!token && env.ALLOW_DEV_LOGIN === "true") token = url.searchParams.get("t");
  if (!token) return null;
  const payload = await readPayload(token, env.SESSION_SECRET);
  if (!payload?.sid) return null;
  const session = await getSession(env, payload.sid);
  if (!session || session.expires_at < Date.now()) return null;
  const user = await getUser(env, session.user_id);
  if (!user) return null;
  return { user, session };
}
