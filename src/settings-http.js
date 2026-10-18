// GET and PUT /api/settings. The body is a preference object, never an account id.

import { readSettingsColumn, writeSettingsColumn } from "./db.js";
import { json, sameOrigin } from "./http.js";
import { resolveUser } from "./identity.js";
import { allowSettingsWrite } from "./settings-limit.js";
import {
  SETTINGS_MAX_BYTES,
  normalizeSettings,
  parseStoredSettings,
  settingsByteLength,
  settingsJson,
} from "./settings.js";

function unauthorized() {
  return json({ error: "unauthorized" }, { status: 401 });
}

export async function settingsGet(request, env) {
  const resolved = await resolveUser(request, env);
  if (!resolved) return unauthorized();
  const column = await readSettingsColumn(env, resolved.user.id);
  return json(parseStoredSettings(column).settings);
}

export async function settingsPut(request, env) {
  const origin = request.headers.get("origin");
  if (!origin || !sameOrigin(request)) return json({ error: "origin" }, { status: 403 });
  const resolved = await resolveUser(request, env);
  if (!resolved) return unauthorized();
  if (!allowSettingsWrite(resolved.user.id)) return json({ error: "limit" }, { status: 429 });
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > SETTINGS_MAX_BYTES) {
    return json({ error: "too_large" }, { status: 413 });
  }
  const type = request.headers.get("content-type") || "";
  if (!type.toLowerCase().includes("application/json")) return json({ error: "json" }, { status: 400 });
  let text = "";
  try {
    text = await request.text();
  } catch {
    return json({ error: "json" }, { status: 400 });
  }
  if (settingsByteLength(text) > SETTINGS_MAX_BYTES) return json({ error: "too_large" }, { status: 413 });
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "json" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "settings" }, { status: 400 });
  }
  const settings = normalizeSettings(body);
  const stored = settingsJson(settings);
  if (settingsByteLength(stored) > SETTINGS_MAX_BYTES) return json({ error: "too_large" }, { status: 413 });
  await writeSettingsColumn(env, resolved.user.id, stored);
  return json(settings);
}
