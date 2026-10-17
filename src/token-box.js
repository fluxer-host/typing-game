import { b64urlDecode, b64urlEncode } from "./session.js";

const encoder = new TextEncoder();

export function tokenKeyOk(secret) {
  return typeof secret === "string" && secret.length >= 16;
}

function decodeKeyMaterial(secret) {
  if (!/^[A-Za-z0-9+/_=-]+$/.test(secret)) return null;
  try {
    const bytes = b64urlDecode(secret);
    if (bytes.length === 16 || bytes.length === 32) return bytes;
  } catch {
    return null;
  }
  return null;
}

async function aesKey(secret) {
  if (!tokenKeyOk(secret)) return null;
  const decoded = decodeKeyMaterial(secret);
  const raw = decoded || new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(secret)));
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

// Stored form is v1:<iv>:<ciphertext>, both base64url. Older rows are the
// raw refresh token and stay readable until the next authenticated request
// re-encrypts them.
export async function sealToken(plaintext, secret) {
  if (!plaintext) return null;
  const key = await aesKey(secret);
  if (!key) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(String(plaintext)));
  return `v1:${b64urlEncode(iv)}:${b64urlEncode(new Uint8Array(cipher))}`;
}

export async function openToken(stored, secret) {
  if (stored == null || stored === "") return { token: null, legacy: false };
  const value = String(stored);
  if (!value.startsWith("v1:")) return { token: value, legacy: true };
  const parts = value.split(":");
  if (parts.length !== 3) return { token: null, legacy: false };
  const key = await aesKey(secret);
  if (!key) return { token: null, legacy: false };
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64urlDecode(parts[1]) },
      key,
      b64urlDecode(parts[2]),
    );
    return { token: new TextDecoder().decode(plain), legacy: false };
  } catch {
    return { token: null, legacy: false };
  }
}
