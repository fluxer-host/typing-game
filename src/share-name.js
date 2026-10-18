// Public name on a share card. Internal ids, emails, and avatar URLs stay out.

const MAX_NAME = 24;

export function isAccountId(name) {
  const text = String(name || "").trim();
  if (/^\d{5,}$/.test(text)) return true;
  if (/^dev_[A-Za-z0-9_-]{6,}$/.test(text)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)) return true;
  return false;
}

function hiddenName(text) {
  if (!text || text.includes("@") || text.includes("://") || isAccountId(text)) return true;
  return false;
}

export function shareableName(name) {
  return !hiddenName(String(name || "").trim());
}

export function publicCardName(name) {
  const text = String(name || "")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim()
    .replace(/\s+/g, " ");
  if (hiddenName(text)) return "Anonymous";
  const chars = Array.from(text);
  if (chars.length <= MAX_NAME) return text;
  return `${chars.slice(0, MAX_NAME - 1).join("")}…`;
}
