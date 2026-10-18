// Signed, stateless result tokens. No expiry: the card is public and immutable.
// Verify with crypto.subtle.verify so the MAC compare stays constant-time.

import { b64urlDecode, b64urlEncode } from "./session.js";
import { isAccountId, publicCardName } from "./share-name.js";

export const SHARE_VERSION = 1;
export const MAX_TOKEN_LENGTH = 512;
export const MIN_SECRET_LENGTH = 16;

const encoder = new TextEncoder();
const LADDERS = new Set(["desktop", "mobile", "cursor"]);
const FORMATS = new Set(["", "passage", "timed", "punctuation"]);
const LENGTHS = new Set(["", "sprint", "set", "long"]);

export function shareSecrets(env) {
  return {
    current: secretValue(env?.SHARE_SIGNING_SECRET),
    previous: secretValue(env?.SHARE_SIGNING_SECRET_PREVIOUS),
  };
}

export function shareEnabled(env) {
  return shareSecrets(env).current.length >= MIN_SECRET_LENGTH;
}

function secretValue(value) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  return text.length >= MIN_SECRET_LENGTH ? text : "";
}

async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export function canonicalCard(card) {
  if (!card || card.v !== SHARE_VERSION) return null;
  if (card.kind !== "race" && card.kind !== "practice") return null;
  if (!LADDERS.has(card.ladder)) return null;
  if (!FORMATS.has(card.format || "")) return null;
  if (!LENGTHS.has(card.length || "")) return null;
  const wpm = oneDecimal(card.wpm, 1000);
  const accuracy = oneDecimal(card.accuracy, 100);
  const ms = whole(card.ms, 0, 30 * 60 * 1000);
  const at = whole(card.at, 1_500_000_000_000, 4_000_000_000_000);
  const place = whole(card.place || 0, 0, 99);
  if (wpm == null || accuracy == null || ms == null || at == null || place == null) return null;
  const name = typeof card.name === "string" ? card.name : "";
  if (!name || Array.from(name).length > 24) return null;
  if (name !== "Anonymous" && (name.includes("@") || name.includes("://") || isAccountId(name))) return null;
  if (name !== publicCardName(name) && name !== "Anonymous") return null;
  const ranked = card.ranked === true;
  if (card.kind === "practice" && ranked) return null;
  return {
    v: SHARE_VERSION,
    kind: card.kind,
    ladder: card.ladder,
    format: card.format || "",
    length: card.length || "",
    wpm,
    accuracy,
    ms,
    at,
    name,
    ranked,
    place,
  };
}

function oneDecimal(value, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > max) return null;
  const rounded = Math.round(n * 10) / 10;
  if (Math.abs(rounded - n) > 1e-6) return null;
  return rounded;
}

function whole(value, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

export async function sealSharePayload(payload, secret) {
  if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH) return null;
  let body;
  try {
    body = b64urlEncode(encoder.encode(JSON.stringify(payload)));
  } catch {
    return null;
  }
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(body));
  const token = `${body}.${b64urlEncode(new Uint8Array(signature))}`;
  if (token.length > MAX_TOKEN_LENGTH) return null;
  return token;
}

export async function encodeShareToken(card, secret) {
  const payload = canonicalCard(card);
  if (!payload) return null;
  return sealSharePayload(payload, secret);
}

export async function readShareToken(token, secrets) {
  if (typeof token !== "string" || token.length < 20 || token.length > MAX_TOKEN_LENGTH) return null;
  const cut = token.indexOf(".");
  if (cut <= 0 || cut !== token.lastIndexOf(".")) return null;
  const body = token.slice(0, cut);
  const signature = token.slice(cut + 1);
  if (!/^[\w-]+$/.test(body) || !/^[\w-]+$/.test(signature)) return null;
  let signatureBytes;
  try {
    signatureBytes = b64urlDecode(signature);
  } catch {
    return null;
  }
  if (!(signatureBytes instanceof Uint8Array) || signatureBytes.byteLength !== 32) return null;
  const keys = [secrets?.current, secrets?.previous].filter((item) => typeof item === "string" && item.length >= MIN_SECRET_LENGTH);
  if (!keys.length) return null;
  const data = encoder.encode(body);
  let ok = false;
  for (const secret of keys) {
    const match = await crypto.subtle.verify("HMAC", await hmacKey(secret), signatureBytes, data);
    if (match) ok = true;
  }
  if (!ok) return null;
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  return canonicalCard(payload);
}
