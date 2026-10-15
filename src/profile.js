export function displayName(user) {
  const named = user.global_name || user.globalName;
  if (named) return String(named);
  return String(user.username || "racer");
}

export function tagOf(user) {
  const username = String(user.username || "racer");
  const raw = String(user.discriminator ?? "");
  if (raw === "" || Number(raw) === 0) return username;
  return `${username}#${raw.padStart(4, "0")}`;
}

export function avatarUrl(user, env) {
  const media = String(env?.MEDIA_BASE || "https://fluxerusercontent.com").replace(/\/$/, "");
  const cdn = String(env?.STATIC_CDN || "https://fluxerstatic.com").replace(/\/$/, "");
  if (user.avatar) {
    const hash = String(user.avatar);
    if (!/^[A-Za-z0-9_]+$/.test(hash)) return null;
    const ext = hash.startsWith("a_") ? "gif" : "png";
    return `${media}/avatars/${encodeURIComponent(String(user.id))}/${hash}.${ext}`;
  }
  if (/^\d+$/.test(String(user.id))) {
    const index = Number(BigInt(user.id) % 6n);
    return `${cdn}/avatars/${index}.png`;
  }
  return null;
}

function num(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function publicPlayer(user, env) {
  const color = user.avatar_color == null ? null : Number(user.avatar_color);
  return {
    id: String(user.id),
    name: displayName(user),
    tag: tagOf(user),
    avatar: avatarUrl(user, env),
    color: Number.isFinite(color) ? color : null,
    elo: {
      desktop: num(user.elo_desktop ?? user.elo?.desktop, 1000),
      mobile: num(user.elo_mobile ?? user.elo?.mobile, 1000),
      cursor: num(user.elo_cursor ?? user.elo?.cursor, 1000),
    },
    races: {
      desktop: num(user.races_desktop ?? user.races?.desktop, 0),
      mobile: num(user.races_mobile ?? user.races?.mobile, 0),
      cursor: num(user.races_cursor ?? user.races?.cursor, 0),
    },
    wins: {
      desktop: num(user.wins_desktop ?? user.wins?.desktop, 0),
      mobile: num(user.wins_mobile ?? user.wins?.mobile, 0),
      cursor: num(user.wins_cursor ?? user.wins?.cursor, 0),
    },
    best: {
      desktop: user.best_wpm_desktop ?? user.best?.desktop ?? null,
      mobile: user.best_wpm_mobile ?? user.best?.mobile ?? null,
      cursor: user.best_wpm_cursor ?? user.best?.cursor ?? null,
    },
  };
}
