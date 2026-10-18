// Ladder page: hash routes, page maths, and the view model.
// The race ladder in the sidebar stays on its own request.

import {
  BOARD_MAX_OFFSET,
  LADDER_PAGE_SIZE,
  pageLabel,
  pageWindow,
  winRate,
} from "../src/board.js";
import {
  DAILY_RESULT_RETENTION_DAYS,
  formatUtcDay,
  parseUtcDay,
  utcDayString,
} from "../src/daily.js";
import { isMode } from "../src/modes.js";

export { LADDER_PAGE_SIZE, pageLabel, pageWindow, winRate };

export const LADDER_TABS = [
  { id: "desktop", label: "Desktop" },
  { id: "mobile", label: "Mobile" },
  { id: "cursor", label: "Cursor" },
  { id: "daily", label: "Daily" },
];

const TAB_IDS = new Set(LADDER_TABS.map((tab) => tab.id));
const DAY_MS = 86_400_000;
const TEXT = { r: 244, g: 244, b: 247 };

export function maxLadderPage(pageSize = LADDER_PAGE_SIZE) {
  const size = Number.isInteger(pageSize) && pageSize > 0 ? pageSize : LADDER_PAGE_SIZE;
  return Math.floor(BOARD_MAX_OFFSET / size) + 1;
}

export function pageOffset(page, pageSize = LADDER_PAGE_SIZE) {
  const size = Number.isInteger(pageSize) && pageSize > 0 ? pageSize : LADDER_PAGE_SIZE;
  const current = Number.isInteger(page) && page > 0 ? page : 1;
  const offset = (current - 1) * size;
  if (offset > BOARD_MAX_OFFSET) return null;
  return offset;
}

export function tabMove(ids, current, key) {
  const list = Array.isArray(ids) ? ids : [];
  const index = list.indexOf(current);
  if (index < 0 || !list.length) return null;
  if (key === "Home") return list[0];
  if (key === "End") return list[list.length - 1];
  if (key === "ArrowRight" || key === "ArrowDown") return list[(index + 1) % list.length];
  if (key === "ArrowLeft" || key === "ArrowUp") return list[(index - 1 + list.length) % list.length];
  return null;
}

// "now" focuses a tab while the table is still loading and keeps the target so the
// finished paint can focus it again. "later" waits for captions and rows. "now-clear" focuses and drops the target.
export function focusAfterPaint(status, role) {
  if (status === "loading") return role === "tab" ? "now" : "later";
  return "now-clear";
}

function parsePage(raw) {
  if (raw == null || raw === "") return { page: 1, invalid: false };
  if (!/^\d+$/.test(raw)) return { page: 1, invalid: true };
  const page = Number(raw);
  if (!Number.isSafeInteger(page) || page < 1 || page > maxLadderPage()) return { page: 1, invalid: true };
  return { page, invalid: false };
}

export function parseLadderHash(hash) {
  const raw = String(hash || "");
  const body = raw.startsWith("#") ? raw.slice(1) : raw;
  const [path, query = ""] = body.split("?");
  const parts = path.split("/").filter(Boolean);
  if (parts[0] !== "ladder") return null;
  let invalid = parts.length > 2;
  let tab = "desktop";
  if (parts[1]) {
    if (TAB_IDS.has(parts[1])) tab = parts[1];
    else {
      tab = "desktop";
      invalid = true;
    }
  }
  const params = new URLSearchParams(query);
  const parsedPage = parsePage(params.get("page"));
  let page = parsedPage.page;
  if (parsedPage.invalid) invalid = true;
  let ladder = "desktop";
  let day = "";
  if (tab === "daily") {
    const asked = params.get("ladder");
    if (asked) {
      if (isMode(asked)) ladder = asked;
      else invalid = true;
    }
    const dayRaw = params.get("day");
    if (dayRaw) {
      if (parseUtcDay(dayRaw)) day = dayRaw;
      else invalid = true;
    }
  }
  return { tab, page, ladder, day, invalid };
}

export function ladderHash({ tab, page, ladder, day } = {}) {
  const id = TAB_IDS.has(tab) ? tab : "desktop";
  const params = new URLSearchParams();
  if (id === "daily") {
    if (isMode(ladder) && ladder !== "desktop") params.set("ladder", ladder);
    if (parseUtcDay(day || "")) params.set("day", day);
  }
  const safePage = Number.isInteger(page) && page > 1 && page <= maxLadderPage() ? page : 0;
  if (safePage > 1) params.set("page", String(safePage));
  const query = params.toString();
  const path = id === "desktop" ? "/ladder" : `/ladder/${id}`;
  return `#${path}${query ? `?${query}` : ""}`;
}

export function routeFromHash(hash) {
  const value = String(hash || "");
  if (value === "#/stats") return { route: "stats", ladder: null };
  const ladder = parseLadderHash(value);
  if (!ladder) return { route: "", ladder: null };
  return { route: "ladder", ladder };
}

export function freshLadder(parsed) {
  return {
    tab: parsed?.tab || "desktop",
    page: parsed?.page || 1,
    ladder: parsed?.ladder || "desktop",
    day: parsed?.day || "",
    status: "idle",
    error: "",
    data: null,
  };
}

export function ladderKey(row) {
  return `${row?.tab || ""}|${row?.page || 1}|${row?.ladder || ""}|${row?.day || ""}`;
}

export function shiftUtcDay(day, delta) {
  const parsed = parseUtcDay(day);
  const step = Number(delta);
  if (!parsed || !Number.isInteger(step)) return "";
  return utcDayString(parsed.startMs + step * DAY_MS);
}

export function oldestDailyDay(today, retention = DAILY_RESULT_RETENTION_DAYS) {
  const parsed = parseUtcDay(today);
  if (!parsed) return "";
  const keep = Number.isFinite(Number(retention)) && Number(retention) > 0
    ? Math.floor(Number(retention))
    : DAILY_RESULT_RETENTION_DAYS;
  return utcDayString(parsed.startMs - (keep - 1) * DAY_MS);
}

export function ratingPagePath({ mode, page }) {
  const offset = pageOffset(page);
  const params = new URLSearchParams();
  params.set("mode", mode);
  params.set("limit", String(LADDER_PAGE_SIZE));
  params.set("offset", String(offset == null ? 0 : offset));
  return `/api/leaderboard?${params.toString()}`;
}

export function dailyPagePath({ ladder, day, page }) {
  const offset = pageOffset(page);
  const params = new URLSearchParams();
  params.set("ladder", isMode(ladder) ? ladder : "desktop");
  params.set("limit", String(LADDER_PAGE_SIZE));
  params.set("offset", String(offset == null ? 0 : offset));
  if (parseUtcDay(day || "")) params.set("day", day);
  return `/api/daily?${params.toString()}`;
}

function channel(value) {
  const s = value / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(rgb) {
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

function contrast(left, right) {
  const a = luminance(left);
  const b = luminance(right);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

// Light text needs a dark disc. A light custom color keeps the brand purple.
export function avatarDisc(color) {
  if (color == null || color === "") return null;
  const number = Number(color);
  if (!Number.isFinite(number)) return null;
  const hex = (number >>> 0).toString(16).padStart(6, "0").slice(-6);
  const rgb = {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
  };
  if (contrast(rgb, TEXT) < 4.5) return null;
  return `#${hex}`;
}

export function formatRating(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  return String(Math.round(n));
}

export function formatWpm(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  return n.toFixed(1);
}

export function formatAccuracy(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  return `${n.toFixed(1)}%`;
}

export function formatWinRate(wins, races) {
  const rate = winRate(wins, races);
  if (rate == null) return "";
  return `${(rate * 100).toFixed(1)}%`;
}

function tabLabel(id) {
  return LADDER_TABS.find((tab) => tab.id === id)?.label || "Ladder";
}

export function ladderAnnounce(ladder) {
  const name = tabLabel(ladder?.tab);
  if (ladder?.status === "loading") return "Loading the ladder.";
  if (ladder?.status === "error") return ladder.error || "The ladder did not load.";
  const total = Number(ladder?.data?.total) || 0;
  if (ladder?.status === "empty" || total === 0) {
    return ladder?.tab === "daily"
      ? "Daily ladder. No scores for this day yet."
      : `${name} ladder. No rated races on this ladder yet.`;
  }
  const when = ladder?.tab === "daily" && ladder.data?.day ? ` ${formatUtcDay(ladder.data.day)}.` : "";
  return `${name} ladder.${when} ${pageLabel(pageWindow(total, ladder.page))}`.replace(/\s+/g, " ").trim();
}

function displayRow(row, kind, youRank) {
  const self = Boolean(row?.self) || Boolean(youRank && row?.rank === youRank);
  return {
    rank: row?.rank,
    name: row?.name || "Racer",
    avatar: row?.avatar || null,
    color: row?.color ?? null,
    self,
    primary: kind === "daily" ? formatWpm(row?.wpm) : formatRating(row?.rating),
    secondary: kind === "daily" ? formatAccuracy(row?.accuracy) : String(Number(row?.races) || 0),
    extra: kind === "daily" ? "" : formatWinRate(row?.wins, row?.races),
  };
}

export function ladderViewModel(ladder) {
  const tab = TAB_IDS.has(ladder?.tab) ? ladder.tab : "desktop";
  const kind = tab === "daily" ? "daily" : "rating";
  const data = ladder?.data || null;
  const total = Number(data?.total) || 0;
  const rawStatus = ladder?.status || "idle";
  const status = rawStatus === "idle" ? "loading" : rawStatus;
  const window = pageWindow(total, ladder?.page || 1);
  const youRank = data?.you?.rank || 0;
  const columns = kind === "daily"
    ? [
      { key: "rank", label: "Rank", className: "col-rank" },
      { key: "name", label: "Racer", className: "col-name" },
      { key: "primary", label: "WPM", className: "col-score" },
      { key: "secondary", label: "Accuracy", className: "col-secondary" },
    ]
    : [
      { key: "rank", label: "Rank", className: "col-rank" },
      { key: "name", label: "Racer", className: "col-name" },
      { key: "primary", label: "Rating", className: "col-score" },
      { key: "secondary", label: "Races", className: "col-secondary" },
      { key: "extra", label: "Win rate", className: "col-extra" },
    ];
  const serverToday = data?.serverNow ? utcDayString(data.serverNow) : "";
  const shownDay = data?.day || ladder?.day || serverToday;
  const oldest = serverToday ? oldestDailyDay(serverToday) : "";
  const prevDay = shownDay ? shiftUtcDay(shownDay, -1) : "";
  const dayLabel = shownDay ? formatUtcDay(shownDay) : "";
  const ladderId = isMode(ladder?.ladder) ? ladder.ladder : "desktop";
  const label = tabLabel(tab);
  const caption = status === "loading"
    ? "Loading the ladder."
    : kind === "daily"
      ? `Daily ladder, ${tabLabel(ladderId)}${dayLabel ? `, ${dayLabel}` : ""}`
      : `${label} ladder`;
  return {
    heading: "Ladder",
    tabs: LADDER_TABS.map((item) => ({
      id: item.id,
      label: item.label,
      selected: item.id === tab,
      controls: "ladder-panel",
      tabId: `ladder-tab-${item.id}`,
    })),
    panelId: "ladder-panel",
    labelledBy: `ladder-tab-${tab}`,
    kind,
    status,
    error: ladder?.error || "The ladder did not load.",
    caption,
    columns,
    rows: (data?.rows || []).map((row) => displayRow(row, kind, youRank)),
    around: (data?.around || []).map((row) => displayRow(row, kind, youRank)),
    pageLabel: status === "loading" ? "Loading the ladder." : pageLabel(window),
    hasPrev: status !== "loading" && status !== "error" && window.hasPrev,
    hasNext: status !== "loading" && status !== "error" && window.hasNext,
    youText: status === "ready" && youRank ? `Your rank is ${youRank}.` : "",
    jump: status === "ready" && Boolean(youRank),
    emptyText: kind === "daily" ? "No scores for this day yet." : "No rated races on this ladder yet.",
    showLength: false,
    showPeriod: false,
    showDay: kind === "daily",
    dayLabel,
    dayPrevDisabled: !serverToday || !prevDay || prevDay < oldest,
    dayNextDisabled: !serverToday || !shownDay || shownDay >= serverToday,
    dailyLadders: LADDER_TABS.filter((item) => item.id !== "daily").map((item) => ({
      id: item.id,
      label: item.label,
      pressed: item.id === ladderId,
    })),
    showToday: status === "error" && kind === "daily",
    busy: status === "loading",
    showPager: status === "ready" || status === "empty" || status === "loading",
    showAround: status === "ready" && Array.isArray(data?.around) && data.around.length > 0,
  };
}
