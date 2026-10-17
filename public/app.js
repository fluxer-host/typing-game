import {
  applyTyping,
  consumeInput,
  correctLength,
  emptyInputSession,
  textUnits,
} from "./input.js";
import { characterClass, characterText, missLabel, pageTitle, typedMiss } from "./passage.js";
import { raceKeyPlan } from "./keys.js";
import {
  LOBBY_RETRY_BASE_MS,
  LOBBY_RETRY_CAP_MS,
  LOBBY_RETRY_LIMIT,
  RETRY_LIMIT,
  backoffDelay,
  classifyMe,
  lobbyDrop,
  nextRaceRetry,
  sessionShell,
  shouldAutoRetry,
} from "./net.js";

const MODES = {
  desktop: {
    title: "Desktop",
    blurb: "Physical keyboard. Its own rated ladder.",
  },
  mobile: {
    title: "Mobile",
    blurb: "Phone keyboard. Its own rated ladder.",
  },
  cursor: {
    title: "Cursor",
    blurb: "Mouse only. On-screen keys. Its own rated ladder.",
  },
};

const ROWS = [
  ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "-"],
  ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
  ["a", "s", "d", "f", "g", "h", "j", "k", "l", "'"],
  ["z", "x", "c", "v", "b", "n", "m", ",", ".", "?"],
];

function paintBrand() {
  const host = location.host;
  const node = document.querySelector(".brand-name");
  if (!node) return;
  const dot = host.indexOf(".");
  const head = dot > 0 ? host.slice(0, dot) : host;
  const tail = dot > 0 ? host.slice(dot) : "";
  const address = /^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?$/.test(host) || host.startsWith("[");
  node.replaceChildren();
  if (!address && tail && /^[A-Za-z0-9-]+$/.test(head)) {
    node.append(document.createTextNode(head));
    const rest = document.createElement("span");
    rest.textContent = tail;
    node.append(rest);
    return;
  }
  node.textContent = host;
}

paintBrand();

const AUTH_ERRORS = {
  denied: "Fluxer did not grant access.",
  bot: "Bot accounts cannot race.",
  state: "That sign-in expired. Try again.",
  token: "Fluxer rejected the login code.",
  not_configured: "This site does not have a Fluxer OAuth client yet.",
  profile: "Fluxer did not return a profile.",
};

const state = {
  config: null,
  me: null,
  recent: [],
  board: [],
  boardYou: null,
  mode: localStorage.getItem("tg_mode") || "desktop",
  length: localStorage.getItem("tg_length") || "sprint",
  phase: "lobby",
  sentence: "",
  typed: "",
  ok: 0,
  err: 0,
  startAt: 0,
  offset: 0,
  raceId: null,
  ranked: false,
  kind: null,
  players: [],
  live: [],
  results: null,
  room: null,
  queue: null,
  rematch: null,
  rooms: [],
  roomMax: 6,
  shift: false,
  shell: "",
  forfeitConfirm: false,
  forfeitedLocally: false,
  session: "unknown",
  configError: "",
  boardError: "",
  recentError: "",
  lobbyStatus: "closed",
  lobbyNotice: "",
  raceLink: "up",
  playLock: false,
};

let lobby = null;
let raceSocket = null;
let raceTries = 0;
let raceLostAt = 0;
let raceRetryTimer = null;
let lobbyTries = 0;
let lobbyRetryTimer = null;
let pendingPlay = "";
let meEpoch = 0;
let toastTimer = null;
let holdDelay = null;
let holdRepeat = null;
let leaveTimer = null;
let inputSession = emptyInputSession();
let refocusTries = 0;
let inputGuardEpoch = 0;
let composeEpoch = 0;
let lastLive = "";
let lastNote = "";
let heardLock = false;
const heardFinish = new Set();
const retries = {
  me: { attempt: 0, timer: null },
  config: { attempt: 0, timer: null },
  board: { attempt: 0, timer: null },
  recent: { attempt: 0, timer: null },
};

function h(tag, props, kids) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
    // style-src 'self' blocks a style attribute. Set node.style.* after create.
    else if (key.toLowerCase() === "style") continue;
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const kid of kids || []) node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return node;
}

function announce(text) {
  const message = String(text || "").trim();
  if (!message || message === lastLive) return;
  lastLive = message;
  const node = document.getElementById("live");
  if (node) node.textContent = message;
}

function toast(text) {
  const node = document.getElementById("toast");
  if (node) {
    node.textContent = text;
    node.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove("show"), 3200);
  }
  announce(text);
}

function setPageTitle() {
  const next = pageTitle(state.phase);
  if (document.title !== next) document.title = next;
}

async function api(path, options) {
  const response = await fetch(path, { credentials: "same-origin", ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || "request failed");
    error.status = response.status;
    throw error;
  }
  return data;
}

function serverNow() {
  return Date.now() + state.offset;
}

function wpm(chars, ms) {
  if (chars <= 0 || ms <= 0) return 0;
  return Math.round((chars / 5 / (ms / 60000)) * 10) / 10;
}

function currentWpm() {
  const elapsed = serverNow() - state.startAt;
  if (elapsed < 400) return 0;
  return wpm(correctLength(state.typed, state.sentence), elapsed);
}

function shellName() {
  return sessionShell({
    session: state.session,
    phase: state.phase,
    lobbyOpen: state.lobbyStatus === "open",
  });
}

function cssColor(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "#4641d9";
  const hex = (number >>> 0).toString(16).padStart(6, "0").slice(-6);
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  if (r + g + b < 150) return "#4641d9";
  return `#${hex}`;
}

function safeHex(value) {
  return typeof value === "string" && /^#[0-9a-f]{6}$/.test(value) ? value : null;
}

function lanePercent(progress, total) {
  const done = Number(progress);
  const length = Number(total);
  if (!Number.isFinite(done) || !Number.isFinite(length) || length <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((done / length) * 100)));
}

function applyLaneWidth(node, progress, total) {
  node.style.width = `${lanePercent(progress, total)}%`;
}

function applyAvatarColor(node, color) {
  const hex = safeHex(cssColor(color));
  if (!hex) return;
  node.style.backgroundColor = hex;
}

function avatarNode(player, className) {
  if (player.avatar) {
    const img = h("img", { class: className || "avatar", alt: "", src: player.avatar });
    img.addEventListener("error", () => img.replaceWith(initialNode(player, className)));
    return img;
  }
  return initialNode(player, className);
}

function initialNode(player, className) {
  const node = h("span", {
    class: className || "initial",
    text: (player.name || "?").slice(0, 1).toUpperCase(),
  });
  applyAvatarColor(node, player.color);
  return node;
}

function lengthInfo(id) {
  return (state.config?.lengths || []).find((row) => row.id === id) || null;
}

function modeElo() {
  if (!state.me) return null;
  return state.me.elo?.[state.mode];
}

function ensure() {
  setPageTitle();
  const next = shellName();
  const entered = next !== state.shell;
  if (entered) {
    state.shell = next;
    paintShell();
  }
  paintDynamic();
  renderAccount();
  renderSide();
  // Banners paint in the same turn. Announce the result last so it stays in the live region.
  if (entered && state.shell === "results") announceResults();
}

function paintShell() {
  const stage = document.getElementById("stage");
  stage.replaceChildren();
  if (state.shell === "loading") {
    stage.append(h("p", { class: "loading", text: "Loading the track…" }));
    return;
  }
  if (state.shell === "boot-error") {
    const view = bootErrorView();
    stage.append(view);
    view.querySelector("button")?.focus();
    return;
  }
  if (state.shell === "auth") stage.append(authView());
  else if (state.shell === "lobby") stage.append(lobbyView());
  else if (state.shell === "queue") stage.append(queueView());
  else if (state.shell === "room") stage.append(roomView());
  else if (state.shell === "browse") stage.append(browseView());
  else if (state.shell === "race") stage.append(raceView());
  else if (state.shell === "results") stage.append(resultsView());
}

function bootErrorView() {
  const box = h("div", { role: "alert" });
  box.append(h("h2", { class: "lead", text: "The track did not load" }));
  box.append(h("p", { class: "muted", text: "The session check failed. Retry, or wait for the next attempt." }));
  box.append(h("div", { class: "actions" }, [
    h("button", { class: "btn primary", type: "button", text: "Retry", onclick: retrySession }),
  ]));
  return box;
}

function authView() {
  const box = h("div", {});
  box.append(h("h2", { class: "lead", text: "Race the room" }));
  box.append(h("p", { class: "muted", text: "Everyone in a match gets the same Fluxer passage. First to finish wins." }));
  const actions = h("div", { class: "actions" });
  if (state.config?.oauth) {
    actions.append(h("a", { class: "btn primary", href: "/auth/login", text: "Sign in with Fluxer" }));
  }
  box.append(actions);
  if (state.config.devLogin) {
    const form = h("form", { class: "dev" });
    const input = h("input", { id: "dev-name", maxlength: "24", placeholder: "Local racer name", required: true });
    form.append(
      input,
      h("button", { class: "btn", type: "submit", text: "Enter local track" }),
    );
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        const data = await api("/auth/dev", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: input.value }),
        });
        state.me = data.user;
        state.session = data.user ? "in" : "out";
        clearRetry("me");
        await Promise.allSettled([pullBoard(), pullRecent()]);
        ensure();
        resumeRace();
      } catch (error) {
        toast(error.message === "name" ? "Use 2-24 letters for the local name." : "Could not open a local account.");
      }
    });
    box.append(h("p", { class: "hint", text: "Local accounts stay on this machine. Sign in with Fluxer on the public site." }));
    box.append(form);
  }
  if (state.config && !state.config.oauth && !state.config.devLogin) {
    box.append(h("p", { class: "hint", text: "Add the Fluxer client id and secret, then reload." }));
  }
  box.append(h("div", { id: "config-note", hidden: true }));
  return box;
}

function lobbyView() {
  const box = h("div", {});
  box.append(h("h2", { class: "lead", text: "Pick a ladder" }));
  box.append(h("p", { class: "muted", text: "Queue for a live room, practice alone, or join an open room." }));
  const modes = h("div", { class: "modes", role: "group", "aria-labelledby": "ladder-label" });
  modes.append(h("span", { id: "ladder-label", class: "visually-hidden", text: "Ladder" }));
  for (const [id, info] of Object.entries(MODES)) {
    const elo = state.me?.elo?.[id];
    const best = state.me?.best?.[id];
    const card = h("button", {
      class: `mode${state.mode === id ? " selected" : ""}`,
      type: "button",
      "data-mode": id,
      "aria-pressed": state.mode === id ? "true" : "false",
      onclick: () => chooseMode(id),
    });
    card.append(h("strong", { text: info.title }));
    card.append(h("span", { text: info.blurb }));
    card.append(h("em", { text: `${Math.round(elo ?? 1000)} elo${best ? ` · best ${best} wpm` : ""}` }));
    modes.append(card);
  }
  box.append(modes);
  const lengths = h("div", { class: "modes lengths", role: "group", "aria-labelledby": "length-label" });
  lengths.append(h("span", { id: "length-label", class: "visually-hidden", text: "Race length" }));
  for (const info of state.config?.lengths || []) {
    const card = h("button", {
      class: `length${state.length === info.id ? " selected" : ""}`,
      type: "button",
      "data-length": info.id,
      "aria-pressed": state.length === info.id ? "true" : "false",
      onclick: () => chooseLength(info.id),
    });
    card.append(h("strong", { text: info.title }));
    card.append(h("span", { text: info.blurb }));
    lengths.append(card);
  }
  box.append(lengths);
  box.append(h("div", { id: "config-note", hidden: true }));
  const actions = h("div", { class: "actions" });
  const play = () => ({ mode: state.mode, length: state.length });
  actions.append(
    h("button", { class: "btn primary", type: "button", "data-action": "queue", text: "Queue", onclick: () => beginPlay("queue", { t: "queue", ...play() }) }),
    h("button", { class: "btn", type: "button", "data-action": "practice", text: "Practice", onclick: () => beginPlay("practice", { t: "practice", ...play() }) }),
    h("button", { class: "btn", type: "button", "data-action": "create-room", text: "Create room", onclick: () => beginPlay("room", { t: "room_create", ...play() }) }),
    h("button", { class: "btn", type: "button", "data-action": "browse", text: "Open rooms", onclick: openBrowse }),
  );
  box.append(actions);
  const join = h("form", { class: "join" });
  const code = h("input", { id: "room-code", maxlength: "4", placeholder: "Room code", "aria-label": "Room code" });
  const params = new URLSearchParams(location.search);
  if (params.get("room")) code.value = params.get("room").toUpperCase();
  join.append(code, h("button", { class: "btn", type: "submit", text: "Join room" }));
  join.addEventListener("submit", (event) => {
    event.preventDefault();
    sendLobby({ t: "room_join", code: code.value });
  });
  box.append(join);
  return box;
}

function queueView() {
  return h("div", {}, [
    h("h2", { class: "lead", text: "Looking for racers" }),
    h("p", { id: "queue-copy", class: "muted", text: queueCopy() }),
    h("button", {
      class: "btn",
      type: "button",
      text: "Cancel",
      onclick: () => {
        sendLobby({ t: "leave" });
        state.phase = "lobby";
        state.queue = null;
        ensure();
      },
    }),
  ]);
}

function queueCopy() {
  const waiting = state.queue?.waiting || 1;
  const length = lengthInfo(state.length)?.title || "Sprint";
  const ladder = MODES[state.mode].title;
  if (waiting < 2) return `You are on the ${ladder} ladder, ${length}. Waiting for another racer.`;
  if (state.queue?.matching) return `${waiting} racers are here. The room opens in a moment.`;
  return `${waiting} racers are here. Waiting for a closer rating, or for the window to widen.`;
}

function roomView() {
  const room = state.room;
  const box = h("div", {});
  box.append(h("h2", { class: "lead", text: "Room" }));
  box.append(h("div", { class: "code", id: "room-code-label", text: room?.code || "" }));
  const roomLength = lengthInfo(state.length)?.title || "Sprint";
  box.append(h("p", { class: "muted", text: `${MODES[room?.mode || state.mode].title} · ${roomLength} · Unranked. No rating change. Listed in Open rooms until the host starts.` }));
  const list = h("ul", { class: "room-list", id: "room-players" });
  box.append(list);
  const actions = h("div", { class: "actions" });
  if (room?.youHost) {
    actions.append(h("button", {
      class: "btn primary",
      type: "button",
      text: "Start",
      onclick: () => sendLobby({ t: "room_start" }),
    }));
  } else {
    actions.append(h("p", { class: "hint", text: "Waiting for the host to start." }));
  }
  actions.append(h("button", {
    class: "btn ghost",
    type: "button",
    text: "Copy link",
    onclick: async () => {
      const link = `${location.origin}/?room=${room?.code || ""}`;
      try {
        await navigator.clipboard.writeText(link);
        toast("Link copied.");
      } catch {
        toast(link);
      }
    },
  }));
  actions.append(h("button", {
    class: "btn",
    type: "button",
    text: "Leave",
    onclick: () => {
      sendLobby({ t: "leave" });
      state.phase = "lobby";
      state.room = null;
      ensure();
    },
  }));
  box.append(actions);
  return box;
}

function openBrowse() {
  state.phase = "browse";
  state.rooms = [];
  ensure();
  sendLobby({ t: "browse" });
}

function browseView() {
  const box = h("div", {});
  box.append(h("h2", { class: "lead", text: "Open rooms" }));
  box.append(h("p", { class: "muted", text: "Rooms waiting for a host to start. Private rooms are Unranked and do not change rating. The list shows who is inside and how many seats are left." }));
  box.append(h("div", { id: "room-directory", class: "room-directory" }));
  box.append(h("div", { class: "actions" }, [
    h("button", {
      class: "btn",
      type: "button",
      "data-action": "browse-lobby",
      text: "Lobby",
      onclick: () => {
        sendLobby({ t: "browse_stop" });
        state.phase = "lobby";
        ensure();
      },
    }),
  ]));
  return box;
}

function paintRooms() {
  const root = document.getElementById("room-directory");
  if (!root) return;
  root.replaceChildren();
  const rooms = state.rooms || [];
  if (!rooms.length) {
    root.append(h("p", { class: "empty", text: "No open rooms right now." }));
    return;
  }
  const max = state.roomMax || 6;
  for (const room of rooms) {
    const count = room.players?.length || 0;
    const card = h("article", { class: "room-card" });
    const head = h("div", { class: "room-card-top" });
    head.append(h("strong", { class: "room-code", text: room.code || "" }));
    head.append(h("span", { class: "room-count", text: `${count} of ${max}` }));
    card.append(head);
    const modeTitle = MODES[room.mode]?.title || "Desktop";
    const lengthTitle = lengthInfo(room.length)?.title || "Sprint";
    card.append(h("p", { class: "muted", text: `${modeTitle} · ${lengthTitle} · Unranked` }));
    const list = h("ul", { class: "room-list" });
    for (const player of room.players || []) {
      const item = h("li", {});
      item.append(avatarNode(player), document.createTextNode(` ${player.name}${player.host ? " · host" : ""}`));
      list.append(item);
    }
    card.append(list);
    const full = count >= max;
    card.append(h("button", {
      class: "btn primary",
      type: "button",
      text: full ? "Full" : "Join",
      disabled: full,
      "data-code": room.code,
      onclick: () => sendLobby({ t: "room_join", code: room.code }),
    }));
    root.append(card);
  }
}

function raceView() {
  inputSession = emptyInputSession();
  refocusTries = 0;
  const box = h("div", { class: "race", "data-mode": state.mode });
  box.append(h("div", {
    id: "race-link",
    class: "net-banner",
    hidden: true,
  }));
  const top = h("div", { class: "race-top" });
  const raceLength = lengthInfo(state.length)?.title || "Sprint";
  top.append(h("span", { class: "pill", text: `${MODES[state.mode].title} · ${raceLength} · ${raceStandingWord()}` }));
  top.append(h("span", { class: "stats", id: "stats", text: "" }));
  top.append(h("button", {
    id: "leave-race",
    class: "btn ghost",
    type: "button",
    text: "Leave race",
    onclick: requestLeave,
  }));
  box.append(top);
  const wrap = h("div", { class: "passage-wrap" });
  wrap.append(h("div", { class: "count", id: "count", hidden: true }));
  wrap.append(h("p", { class: "passage", id: "passage" }));
  const capture = h("input", {
    id: "capture",
    class: "capture",
    type: "text",
    autocomplete: "off",
    autocapitalize: "off",
    autocorrect: "off",
    spellcheck: "false",
    inputmode: "text",
    enterkeyhint: "done",
    "aria-label": "Type the passage here",
    "aria-describedby": "race-hint",
  });
  if (state.mode === "cursor") {
    capture.tabIndex = -1;
    capture.setAttribute("aria-hidden", "true");
  }
  wrap.append(capture);
  box.append(wrap);
  const tap = h("button", {
    id: "tap-to-type",
    class: "btn tap-type",
    type: "button",
    text: "Tap to type",
    hidden: true,
  });
  tap.addEventListener("click", () => focusCapture());
  box.append(tap);
  const hint = state.mode === "cursor"
    ? "Click the keys. The keyboard does not type on this ladder."
    : state.mode === "mobile"
      ? "Tap the sentence, or Tap to type, if the phone keyboard is closed."
      : "Type the line. Backspace fixes a miss.";
  box.append(h("p", { id: "race-hint", class: "hint", text: hint }));
  if (state.mode === "cursor") box.append(keyboard());
  box.append(h("p", { class: "locked", id: "locked", hidden: true, text: "Locked in. Waiting for the rest of the room." }));
  box.append(h("p", { class: "hint", id: "race-note", hidden: true }));
  const confirm = h("div", {
    id: "forfeit",
    class: "forfeit",
    role: "dialog",
    "aria-modal": "true",
    "aria-labelledby": "forfeit-title",
    hidden: true,
  });
  confirm.append(h("p", { id: "forfeit-title", text: "Forfeit this ranked race? You'll lose rating." }));
  const confirmActions = h("div", { class: "actions" });
  confirmActions.append(
    h("button", { id: "forfeit-keep", class: "btn", type: "button", text: "Keep racing", onclick: closeForfeit }),
    h("button", { id: "forfeit-yes", class: "btn primary", type: "button", text: "Forfeit", onclick: confirmForfeit }),
  );
  confirm.append(confirmActions);
  box.append(confirm);
  capture.addEventListener("keydown", onCaptureKeyDown);
  capture.addEventListener("beforeinput", onCaptureBeforeInput);
  capture.addEventListener("input", onCaptureInput);
  capture.addEventListener("compositionstart", onCompositionStart);
  capture.addEventListener("compositionupdate", onCompositionUpdate);
  capture.addEventListener("compositionend", onCompositionEnd);
  capture.addEventListener("focus", () => {
    refocusTries = 0;
    paintCaptureFocus();
  });
  capture.addEventListener("blur", onCaptureBlur);
  box.addEventListener("pointerdown", keepTypingPointer);
  box.addEventListener("mousedown", keepTypingPointer);
  box.addEventListener("touchstart", keepTypingPointer, { passive: false });
  return box;
}

function keyboard() {
  const board = h("div", { class: "keyboard", id: "keyboard" });
  for (const row of ROWS) {
    const line = h("div", { class: "row" });
    for (const key of row) line.append(keyButton(key, key));
    board.append(line);
  }
  const bottom = h("div", { class: "row" });
  bottom.append(keyButton("shift", "shift", "wide"));
  bottom.append(keyButton(" ", "space", "space"));
  bottom.append(keyButton("back", "back", "wide"));
  board.append(bottom);
  return board;
}

function keyButton(key, label, extra) {
  const button = h("button", {
    class: `key${extra ? ` ${extra}` : ""}`,
    type: "button",
    "data-key": key,
    "data-letter": /^[a-z]$/.test(key) ? key : "",
    tabindex: "-1",
    "aria-pressed": key === "shift" ? "false" : null,
    text: label === " " ? "" : label,
  });
  button.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "touch") {
      toast("Cursor ladder is mouse only.");
      return;
    }
    event.preventDefault();
    pressKey(key);
    if (key === "back") {
      stopHold();
      holdDelay = setTimeout(() => {
        holdRepeat = setInterval(() => backspace(), 55);
      }, 320);
    }
  });
  button.addEventListener("contextmenu", (event) => event.preventDefault());
  return button;
}

function pressKey(key) {
  if (state.raceLink !== "up" || state.forfeitConfirm || racedOut()) return;
  if (key === "shift") {
    state.shift = !state.shift;
    paintShift();
    return;
  }
  if (key === "back") {
    backspace();
    return;
  }
  let ch = key;
  if (state.shift && /[a-z]/.test(ch)) {
    ch = ch.toUpperCase();
    state.shift = false;
    paintShift();
  }
  typeChar(ch);
}

function paintShift() {
  for (const button of document.querySelectorAll(".key[data-letter]")) {
    const base = button.dataset.letter;
    if (!base) continue;
    button.textContent = state.shift && /[a-z]/.test(base) ? base.toUpperCase() : base;
  }
  const shift = document.querySelector('[data-key="shift"]');
  if (!shift) return;
  shift.classList.toggle("on", state.shift);
  shift.setAttribute("aria-pressed", state.shift ? "true" : "false");
  shift.textContent = state.shift ? "SHIFT" : "shift";
}

function resultsCopy() {
  if (state.results?.cancelled) return { title: "Room closed", detail: "Everyone left before a finish." };
  const rows = state.results?.rows || [];
  const me = rows.find((row) => row.id === state.me?.id);
  const others = rows.filter((row) => row.id !== state.me?.id);
  if (!me) return { title: "Finish order", detail: "" };
  if (me.outcome === "forfeit") {
    if (raceStandingWord() === "rated") return { title: "You forfeited", detail: "This race counts as a loss." };
    return { title: "You left", detail: "This race does not change rating." };
  }
  if (me.outcome === "timeout" || me.outcome === "disconnect") return { title: "Timed out", detail: "The race moved on without you." };
  if (others.some((row) => row.outcome === "forfeit") && (me.outcome === "forfeit-win" || me.place === 1)) {
    return { title: "Opponent forfeited, you win", detail: "You take the win." };
  }
  if (me.place === 1 && others.some((row) => row.outcome === "timeout" || row.outcome === "disconnect")) {
    return { title: "You win", detail: "Your opponent timed out." };
  }
  return { title: "Finish order", detail: "" };
}

function resultsView() {
  const box = h("div", { class: "results" });
  const copy = resultsCopy();
  box.append(h("h2", { class: "lead", text: copy.title }));
  if (copy.detail) box.append(h("p", { class: "muted", text: copy.detail }));
  if (!state.results?.cancelled && raceStandingWord() === "Unranked") {
    box.append(h("p", { class: "pill", text: "Unranked" }));
  }
  if (!state.results?.cancelled) {
    box.append(h("p", { class: "quote", text: state.results?.sentence || state.sentence }));
    box.append(resultTable());
  }
  box.append(h("p", { id: "rematch-note", class: "hint rematch-note", hidden: true }));
  const actions = h("div", { class: "result-actions" });
  actions.append(
    h("button", { id: "rematch-btn", class: "btn primary", type: "button", "data-action": "rematch", text: "Rematch", onclick: askRematch }),
    h("button", { class: "btn", type: "button", "data-action": "queue-again", text: "Queue again", onclick: queueAgain }),
    h("button", { class: "btn", type: "button", "data-action": "practice-again", text: "Practice", onclick: practiceAgain }),
    h("button", { class: "btn ghost", type: "button", text: "Lobby", onclick: () => { sendLobby({ t: "leave" }); leaveRace(); } }),
  );
  box.append(actions);
  return box;
}

function announceResults() {
  if (state.results?.cancelled) {
    announce("Room closed. Everyone left before a finish.");
    return;
  }
  const copy = resultsCopy();
  const rows = state.results?.rows || [];
  const me = rows.find((row) => row.id === state.me?.id);
  if (!me) {
    announce(copy.detail ? `${copy.title}. ${copy.detail}` : copy.title);
    return;
  }
  const wpm = Number(me.wpm);
  const pace = Number.isFinite(wpm) ? `${wpm.toFixed(1)} words per minute` : "no pace";
  const accuracy = Number.isFinite(Number(me.accuracy)) ? `${me.accuracy}% accuracy` : "no accuracy";
  const place = placeLabel(me);
  announce(`${copy.title}. ${pace}, ${accuracy}, place ${place}.`);
}

function rematchNames(ids) {
  const rows = state.results?.rows || [];
  const players = state.players || [];
  return ids.map((id) => (
    rows.find((row) => row.id === id)?.name
    || players.find((row) => row.id === id)?.name
    || "A racer"
  ));
}

function paintRematch() {
  const note = document.getElementById("rematch-note");
  const button = document.getElementById("rematch-btn");
  if (!note || !button) return;
  const offer = state.rematch;
  const mine = Boolean(state.me && offer?.ready?.includes(state.me.id));
  button.textContent = mine ? "Cancel rematch" : "Rematch";
  if (!offer || offer.raceId !== state.raceId) {
    note.hidden = true;
    return;
  }
  const others = rematchNames((offer.ready || []).filter((id) => id !== state.me?.id));
  if (mine) {
    note.hidden = false;
    note.textContent = "Waiting for a rematch.";
    return;
  }
  if (others.length === 1) {
    note.hidden = false;
    note.textContent = `${others[0]} wants a rematch.`;
    return;
  }
  if (others.length > 1) {
    note.hidden = false;
    note.textContent = `${others.slice(0, -1).join(", ")} and ${others[others.length - 1]} want a rematch.`;
    return;
  }
  if (offer.started) {
    note.hidden = false;
    note.textContent = "A rematch already started.";
    return;
  }
  note.hidden = true;
}

function askRematch() {
  const offer = state.rematch;
  const mine = Boolean(state.me && offer?.ready?.includes(state.me.id));
  if (mine) {
    sendLobby({ t: "rematch_cancel" });
    return;
  }
  const solo = !state.ranked || (state.players || []).length < 2;
  if (solo) {
    beginPlay("practice", { t: "practice", mode: state.mode, length: state.length });
    return;
  }
  sendLobby({ t: "rematch", raceId: state.raceId });
}

function resultTable() {
  const table = h("table", {});
  table.append(h("caption", { class: "visually-hidden", text: "Race results" }));
  const head = h("tr", {});
  const columns = [
    ["Place", "Place"],
    ["Racer", "Racer"],
    ["WPM", "Words per minute"],
    ["Acc", "Accuracy"],
    ["Time", "Time"],
    ["Elo", "Rating"],
  ];
  for (const [short, full] of columns) {
    const cell = h("th", { scope: "col" });
    if (short === full) cell.textContent = short;
    else {
      cell.append(h("span", { "aria-hidden": "true", text: short }));
      cell.append(h("span", { class: "visually-hidden", text: full }));
    }
    head.append(cell);
  }
  table.append(h("thead", {}, [head]));
  const body = h("tbody", {});
  for (const row of state.results?.rows || []) {
    const tr = h("tr", { class: row.id === state.me?.id ? "me" : "" });
    tr.append(h("td", { text: placeLabel(row) }));
    tr.append(h("td", { text: row.name }));
    tr.append(h("td", { text: Number(row.wpm).toFixed(1) }));
    tr.append(h("td", { text: `${row.accuracy}%` }));
    tr.append(h("td", { text: row.ms == null ? "DNF" : `${(row.ms / 1000).toFixed(1)}s` }));
    const delta = eloText(row);
    const cell = h("td", { text: delta, class: delta.startsWith("+") ? "up" : delta.startsWith("-") ? "down" : "" });
    tr.append(cell);
    body.append(tr);
  }
  table.append(body);
  return table;
}

function placeLabel(row) {
  if (row.outcome === "forfeit-win" || row.finished) return String(row.place);
  if (row.outcome === "forfeit") return "Forfeit";
  if (row.outcome === "timeout" || row.outcome === "disconnect") return "Time";
  return "DNF";
}

function formatDelta(value) {
  if (value > 0) return `+${value}`;
  return String(value);
}

function raceKind() {
  if (state.results?.kind === "room" || state.results?.kind === "practice" || state.results?.kind === "queue") return state.results.kind;
  if (state.kind === "room" || state.kind === "practice" || state.kind === "queue") return state.kind;
  if (state.ranked) return "queue";
  return (state.players || []).length >= 2 ? "room" : "practice";
}

function raceStandingWord() {
  const ranked = state.results && typeof state.results.ranked === "boolean" ? state.results.ranked : state.ranked;
  if (ranked || raceKind() === "queue") return "rated";
  if (raceKind() === "room") return "Unranked";
  return "practice";
}

function eloText(row) {
  if (row.eloAfter != null && row.eloBefore != null) return formatDelta(row.eloAfter - row.eloBefore);
  if (raceKind() === "room") return "Unranked";
  return "unrated";
}

function paintModes() {
  for (const button of document.querySelectorAll(".mode[data-mode]")) {
    const on = button.dataset.mode === state.mode;
    button.classList.toggle("selected", on);
    button.setAttribute("aria-pressed", on ? "true" : "false");
  }
}

function paintLengths() {
  for (const button of document.querySelectorAll(".length[data-length]")) {
    const on = button.dataset.length === state.length;
    button.classList.toggle("selected", on);
    button.setAttribute("aria-pressed", on ? "true" : "false");
  }
}

function paintDynamic() {
  if (state.shell === "lobby" || state.shell === "auth") paintConfigNote();
  if (state.shell === "lobby") {
    paintModes();
    paintLengths();
  }
  if (state.shell === "queue") {
    const copy = document.getElementById("queue-copy");
    if (copy) copy.textContent = queueCopy();
  }
  if (state.shell === "room") paintRoom();
  if (state.shell === "browse") paintRooms();
  if (state.shell === "results") paintRematch();
  if (state.shell === "race") {
    paintPassage();
    paintStats();
    paintLocked();
    paintRaceNote();
    paintRaceBanner();
    paintCaptureFocus();
  }
  paintPlayButtons();
  paintNetBanner();
}

function inlineError(message, onRetry) {
  const box = h("div", { class: "inline-error" });
  box.append(h("p", { text: message }));
  box.append(h("button", { class: "btn", type: "button", text: "Retry", onclick: onRetry }));
  announce(message);
  return box;
}

function paintConfigNote() {
  const node = document.getElementById("config-note");
  if (!node) return;
  node.replaceChildren();
  if (state.configError) {
    node.hidden = false;
    node.append(inlineError(state.configError, () => retryNow("config", () => pullConfig())));
    return;
  }
  if (!state.config) {
    node.hidden = false;
    node.append(h("p", { class: "muted", text: "Loading match lengths…" }));
    return;
  }
  node.hidden = true;
}

function paintPlayButtons() {
  const locked = state.playLock;
  for (const button of document.querySelectorAll("[data-action='queue'], [data-action='practice'], [data-action='create-room'], [data-action='queue-again'], [data-action='practice-again']")) {
    button.disabled = locked;
  }
}

function ensureNetBanner() {
  let banner = document.getElementById("net-banner");
  if (banner) return banner;
  const layout = document.querySelector(".layout");
  if (!layout?.parentElement) return null;
  banner = h("div", {
    id: "net-banner",
    class: "net-banner",
    hidden: true,
    role: "region",
    "aria-label": "Connection",
  });
  layout.parentElement.insertBefore(banner, layout);
  return banner;
}

function lobbyBannerView() {
  if (state.shell === "race" || state.session !== "in") return null;
  const notice = state.lobbyNotice;
  if (!notice) return null;
  if (notice === "restored-requeue") return { role: "status", text: "Back online. Queue again to join a race." };
  if (notice === "restored-room") return { role: "status", text: "Back online. Rejoin the room if you still want to race." };
  if (notice === "restored") return { role: "status", text: "Back online." };
  const exhausted = lobbyTries >= LOBBY_RETRY_LIMIT && !lobbyRetryTimer && !(lobby && (lobby.readyState === WebSocket.OPEN || lobby.readyState === WebSocket.CONNECTING));
  if (exhausted) {
    let text = "Connection lost. Reconnect to keep racing.";
    if (notice === "requeue") text = "Connection lost. You left the queue. Reconnect, then queue again.";
    if (notice === "room") text = "Connection lost. The room may still be open. Reconnect, then join again.";
    return { role: "alert", text, action: "reconnect" };
  }
  return { role: "status", text: "Connection lost, reconnecting..." };
}

function paintNetBanner() {
  const banner = ensureNetBanner();
  if (!banner) return;
  const view = lobbyBannerView();
  const token = view ? `${view.role}:${view.text}` : "";
  if (banner.dataset.token === token) return;
  banner.dataset.token = token;
  banner.replaceChildren();
  if (!view) {
    banner.hidden = true;
    banner.removeAttribute("aria-live");
    return;
  }
  banner.hidden = false;
  banner.removeAttribute("aria-live");
  const paragraph = h("p", { text: view.text });
  // Keep the banner a named landmark. A blocking error announces from the paragraph.
  if (view.role === "alert") paragraph.setAttribute("role", "alert");
  else announce(view.text);
  banner.append(paragraph);
  if (view.action === "reconnect") {
    banner.append(h("div", { class: "actions" }, [
      h("button", { class: "btn", type: "button", text: "Reconnect", onclick: reconnectLobby }),
    ]));
  }
}

function paintRaceBanner() {
  const banner = document.getElementById("race-link");
  if (!banner) return;
  if (banner.dataset.link === state.raceLink) return;
  banner.dataset.link = state.raceLink;
  banner.replaceChildren();
  banner.removeAttribute("aria-live");
  if (state.raceLink === "up") {
    banner.hidden = true;
    banner.removeAttribute("role");
    return;
  }
  banner.hidden = false;
  if (state.raceLink === "lost") {
    banner.setAttribute("role", "alert");
    banner.append(h("p", { text: "The race connection was lost. Your progress stays on this screen. Try again to resume, or go back to the lobby. If the race cannot resume, the server records a timeout." }));
    banner.append(h("div", { class: "actions" }, [
      h("button", { class: "btn primary", type: "button", text: "Try again", onclick: retryRace }),
      h("button", { class: "btn", type: "button", text: "Back to lobby", onclick: abandonLostRace }),
    ]));
    return;
  }
  banner.removeAttribute("role");
  banner.append(h("p", { text: "Connection lost, reconnecting..." }));
  announce("Connection lost, reconnecting...");
}

function paintRoom() {
  const list = document.getElementById("room-players");
  if (!list || !state.room) return;
  list.replaceChildren();
  for (const player of state.room.players || []) {
    const item = h("li", {});
    item.append(avatarNode(player), document.createTextNode(` ${player.name}${player.host ? " · host" : ""}`));
    list.append(item);
  }
}

function paintPassage() {
  const box = document.getElementById("passage");
  if (!box) return;
  const sentence = state.sentence;
  const typed = state.typed;
  box.classList.toggle("long", sentence.length > 160);
  box.replaceChildren();
  for (let i = 0; i < sentence.length; i += 1) {
    const span = h("span", { class: characterClass(sentence, typed, i) });
    span.append(document.createTextNode(characterText(sentence, typed, i)));
    const miss = typedMiss(sentence, typed, i);
    if (miss) {
      const label = missLabel(miss);
      span.setAttribute("title", `Typed ${label}`);
      span.append(h("span", { class: "visually-hidden", text: `, typed ${label}` }));
    }
    box.append(span);
  }
}

function paintStats() {
  const node = document.getElementById("stats");
  if (!node) return;
  const elapsed = Math.max(0, serverNow() - state.startAt);
  const accTotal = state.ok + state.err;
  const acc = accTotal ? Math.round((state.ok / accTotal) * 1000) / 10 : 100;
  const clock = state.phase === "countdown" ? "ready" : `${(elapsed / 1000).toFixed(1)}s`;
  node.textContent = `${currentWpm().toFixed(1)} wpm · ${acc}% · ${clock}`;
}

function paintLocked() {
  const node = document.getElementById("locked");
  if (!node) return;
  const on = state.phase === "finishing";
  node.hidden = !on;
  if (on && !heardLock) {
    heardLock = true;
    announce("Locked in. Waiting for the rest of the room.");
  }
}

function paintRaceNote() {
  const note = document.getElementById("race-note");
  if (!note) return;
  const mine = myLive();
  const others = state.live.filter((row) => row.id !== state.me?.id);
  let text = "";
  if (mine?.status === "timeout" || mine?.status === "disconnect") text = "You timed out.";
  else if (others.some((row) => row.status === "forfeit" || row.status === "disconnect")) text = "Opponent left.";
  else if (others.some((row) => row.status === "timeout")) text = "Opponent timed out.";
  else if (others.some((row) => row.status === "away")) text = "Opponent reconnecting.";
  note.hidden = !text;
  note.textContent = text;
  if (text === lastNote) return;
  lastNote = text;
  if (text) announce(text);
}

function paceLabel(row) {
  if (row.status === "forfeit" || row.status === "disconnect") return "left";
  if (row.status === "timeout") return "idle";
  if (row.status === "away") return "away";
  if (row.finishedAt) return "fin";
  return `${Number(row.wpm || 0).toFixed(0)}`;
}

function myLive() {
  return state.live.find((row) => row.id === state.me?.id) || null;
}

function racedOut() {
  const status = myLive()?.status;
  return status === "timeout" || status === "disconnect" || status === "forfeit";
}

function eventElement(target) {
  if (!target) return null;
  if (target.nodeType === 1) return target;
  return target.parentElement || null;
}

function interactiveTarget(node) {
  const element = eventElement(node);
  if (!element) return false;
  if (element.id === "capture") return false;
  if (element.closest("[role='dialog']")) return true;
  const field = element.closest("button, a, textarea, select, input");
  return Boolean(field && field.id !== "capture");
}

function paintCaptureFocus() {
  const capture = document.getElementById("capture");
  const wrap = document.querySelector(".passage-wrap");
  const tap = document.getElementById("tap-to-type");
  if (wrap) {
    const on = state.mode !== "cursor" && capture && document.activeElement === capture;
    wrap.classList.toggle("is-typing", Boolean(on));
  }
  if (tap) {
    const show = state.mode === "mobile"
      && (state.phase === "countdown" || state.phase === "race")
      && document.activeElement !== capture;
    tap.hidden = !show;
  }
}

function focusCapture() {
  if (state.mode === "cursor" || state.forfeitConfirm) {
    paintCaptureFocus();
    return;
  }
  if (state.phase !== "countdown" && state.phase !== "race") {
    paintCaptureFocus();
    return;
  }
  const capture = document.getElementById("capture");
  if (capture && document.activeElement !== capture) capture.focus({ preventScroll: true });
  paintCaptureFocus();
}

function keepTypingPointer(event) {
  if (state.mode === "cursor") return;
  if (state.phase !== "countdown" && state.phase !== "race") return;
  const element = eventElement(event.target);
  if (interactiveTarget(element) || element?.id === "capture") return;
  refocusTries = 0;
  event.preventDefault();
  focusCapture();
}

function onCaptureBlur(event) {
  paintCaptureFocus();
  if (state.mode === "cursor" || state.forfeitConfirm) return;
  if (state.phase !== "countdown" && state.phase !== "race") return;
  if (interactiveTarget(event.relatedTarget)) return;
  // A phone keyboard closing blurs the field with no next target. Leave that
  // blur in place so Tap to type can open the keyboard again. A tap on the
  // passage still focuses the field.
  if (state.mode === "mobile" && !event.relatedTarget) return;
  if (refocusTries >= 1) return;
  refocusTries += 1;
  requestAnimationFrame(() => {
    if (state.forfeitConfirm || state.mode === "cursor") return;
    if (state.phase !== "countdown" && state.phase !== "race") return;
    if (interactiveTarget(document.activeElement)) {
      paintCaptureFocus();
      return;
    }
    const capture = document.getElementById("capture");
    if (!capture || document.activeElement === capture) {
      paintCaptureFocus();
      return;
    }
    capture.focus({ preventScroll: true });
    paintCaptureFocus();
  });
}

function clearCapture(node) {
  if (node && !inputSession.composing) node.value = "";
}

function releaseInputGuards() {
  // Backspace's extra delete event is dispatched before the next macrotask.
  const epoch = ++inputGuardEpoch;
  setTimeout(() => {
    if (epoch !== inputGuardEpoch) return;
    inputSession = { ...inputSession, ignoreDelete: false };
  }, 0);
}

function releaseComposeGuard() {
  // Some browsers emit the committed text again shortly after compositionend.
  // A trailing event clears the guard immediately. This timeout covers a
  // browser that never emits one, without dropping the duplicate.
  const epoch = ++composeEpoch;
  setTimeout(() => {
    if (epoch !== composeEpoch) return;
    inputSession = { ...inputSession, suppressInsert: false, skipInput: false };
  }, 100);
}

function onCaptureKeyDown(event) {
  if (state.mode === "cursor" || event.key !== "Backspace") return;
  const result = consumeInput(inputSession, { type: "keydown", key: event.key, isComposing: event.isComposing });
  inputSession = result.session;
  if (result.effect.effect !== "backspace") return;
  event.preventDefault();
  commitTyping(result.effect);
  clearCapture(event.target);
  releaseInputGuards();
}

function onCaptureBeforeInput(event) {
  if (state.mode === "cursor") return;
  const result = consumeInput(inputSession, { type: "beforeinput", inputType: event.inputType, data: event.data });
  inputSession = result.session;
  const kind = result.effect.effect;
  if (kind === "defer") return;
  event.preventDefault();
  if (kind === "insert" || kind === "backspace") commitTyping(result.effect);
  clearCapture(event.target);
}

function onCaptureInput(event) {
  if (state.mode === "cursor") return;
  const result = consumeInput(inputSession, {
    type: "input",
    inputType: event.inputType,
    data: event.data,
    value: event.target?.value || "",
  });
  inputSession = result.session;
  if (result.effect.effect === "insert" || result.effect.effect === "backspace") commitTyping(result.effect);
  clearCapture(event.target);
}

function onCompositionStart() {
  if (state.mode === "cursor") return;
  inputSession = consumeInput(inputSession, { type: "compositionstart" }).session;
}

function onCompositionUpdate() {
  if (state.mode === "cursor") return;
  inputSession = consumeInput(inputSession, { type: "compositionupdate" }).session;
}

function onCompositionEnd(event) {
  if (state.mode === "cursor") return;
  const data = event.data || event.target?.value || "";
  const result = consumeInput(inputSession, { type: "compositionend", data });
  inputSession = result.session;
  if (result.effect.effect === "insert") commitTyping(result.effect);
  clearCapture(event.target);
  releaseComposeGuard();
}

function typeChar(ch) {
  commitTyping({ effect: "insert", chars: textUnits(ch) });
}

function backspace() {
  commitTyping({ effect: "backspace" });
}

function commitTyping(effect) {
  if (!effect || effect.effect === "reject" || effect.effect === "ignore" || effect.effect === "defer") return;
  if (state.raceLink !== "up" || state.forfeitConfirm || racedOut()) return;
  if (effect.effect === "insert") {
    if (state.phase === "countdown") {
      toast("Wait for the start.");
      return;
    }
    if (state.phase !== "race") return;
    if (serverNow() < state.startAt) {
      toast("Wait for the start.");
      return;
    }
  } else if (effect.effect === "backspace") {
    if (state.phase !== "race") return;
  } else {
    return;
  }
  const result = applyTyping(
    { typed: state.typed, sentence: state.sentence, ok: state.ok, err: state.err },
    effect,
  );
  if (!result.changed) return;
  state.ok = result.ok;
  state.err = result.err;
  for (const step of result.steps) {
    state.typed = step.text;
    if (step.kind === "fin") state.phase = "finishing";
    publish(step.kind, step.text);
  }
  paintPassage();
  paintStats();
  paintLocked();
  localLane();
}

function publish(kind, text = state.typed) {
  if (raceSocket?.readyState === WebSocket.OPEN) {
    raceSocket.send(JSON.stringify({ t: kind, text }));
  }
}

function applyServerText(msg) {
  if (!msg || typeof msg.text !== "string") return;
  state.typed = msg.text;
  if (Number.isFinite(msg.ok)) state.ok = msg.ok;
  if (Number.isFinite(msg.err)) state.err = msg.err;
  if (state.phase === "finishing" && state.typed !== state.sentence) state.phase = "race";
  paintPassage();
  paintStats();
  paintLocked();
  localLane();
}

function localLane() {
  const mine = state.live.find((row) => row.id === state.me?.id);
  if (!mine) return;
  mine.i = correctLength(state.typed, state.sentence);
  mine.wpm = currentWpm();
  if (state.phase === "finishing") mine.finishedAt = mine.finishedAt || serverNow();
  paintLanes();
}

function renderAccount() {
  const slot = document.getElementById("account");
  slot.replaceChildren();
  if (!state.me) return;
  const who = h("div", { class: "who" });
  who.append(avatarNode(state.me));
  const names = h("div", {});
  names.append(h("strong", { text: state.me.name }));
  if (state.me.tag && state.me.tag !== state.me.name) names.append(h("div", { class: "tag", text: state.me.tag }));
  who.append(names);
  slot.append(who);
  slot.append(h("button", {
    class: "btn ghost",
    type: "button",
    text: "Sign out",
    onclick: async () => {
      try {
        await api("/auth/logout", { method: "POST" });
      } catch {
        toast("Could not sign out. Try again.");
        return;
      }
      dropLocalSession();
    },
  }));
  slot.className = "account";
}

function renderSide() {
  paintLanes();
  const you = document.getElementById("you");
  you.replaceChildren(h("h2", { text: MODES[state.mode].title }));
  if (state.session === "error") {
    you.append(h("p", { class: "empty", text: "Session check failed." }));
  } else if (!state.me) {
    you.append(h("p", { class: "empty", text: "Sign in to take a ladder spot." }));
  } else {
    const best = state.me.best?.[state.mode];
    const place = state.boardYou?.rank;
    const eloLine = `${Math.round(modeElo() ?? 1000)} elo`;
    you.append(h("p", { text: place ? `${eloLine} · rank ${place}` : eloLine }));
    you.append(h("p", { class: "muted", text: `${state.me.wins?.[state.mode] || 0} wins · ${state.me.races?.[state.mode] || 0} rated` }));
    you.append(h("p", { class: "muted", text: best ? `Best ${best} wpm` : "No finished race yet" }));
  }
  const board = document.getElementById("board");
  board.replaceChildren(h("h2", { text: "Ladder" }));
  if (state.boardError) board.append(inlineError(state.boardError, () => retryNow("board", () => pullBoard())));
  else if (!state.board.length) board.append(h("p", { class: "empty", text: "No rated races yet." }));
  for (const [index, row] of state.board.entries()) {
    const line = h("div", { class: "board-row" });
    const place = row.rank || index + 1;
    line.append(h("b", { text: `${place}. ${row.name}` }));
    line.append(h("span", { text: String(Math.round(row.rating ?? row.elo?.[state.mode] ?? 1000)) }));
    board.append(line);
  }
  const recent = document.getElementById("recent");
  recent.replaceChildren(h("h2", { text: "Recent" }));
  if (state.recentError) recent.append(inlineError(state.recentError, () => retryNow("recent", () => pullRecent())));
  else if (!state.recent.length) recent.append(h("p", { class: "empty", text: "Your races show up here." }));
  for (const race of state.recent) {
    const line = h("div", { class: "recent-row" });
    const place = race.ms == null ? "DNF" : `#${race.place}`;
    const label = race.label || (race.ranked ? "rated" : ((race.racers || 0) >= 2 ? "Unranked" : "practice"));
    line.append(h("b", { text: `${place} · ${race.mode} · ${label}` }));
    line.append(h("span", { text: `${Number(race.wpm).toFixed(0)} wpm` }));
    recent.append(line);
  }
}

function paintLanes() {
  const root = document.getElementById("lanes");
  const racing = state.shell === "race" || state.shell === "results";
  root.replaceChildren();
  if (!racing) return;
  root.append(h("h2", { text: "Room" }));
  const total = Math.max(1, state.sentence.length);
  const rows = state.players.map((player) => {
    const live = state.live.find((row) => row.id === player.id) || { i: 0, wpm: 0, finishedAt: null };
    return { ...player, ...live };
  });
  rows.sort((a, b) => {
    if (Boolean(a.finishedAt) !== Boolean(b.finishedAt)) return a.finishedAt ? -1 : 1;
    if (a.finishedAt && b.finishedAt) return a.finishedAt - b.finishedAt;
    return (b.i || 0) - (a.i || 0);
  });
  for (const row of rows) {
    const lane = h("div", { class: "lane" });
    lane.append(h("b", { text: row.name }));
    const track = h("div", { class: "track" });
    const fill = h("div", { class: "fill" });
    applyLaneWidth(fill, row.i || 0, total);
    track.append(fill);
    lane.append(track);
    lane.append(h("span", { class: "pace", text: paceLabel(row) }));
    root.append(lane);
  }
}

function chooseMode(mode) {
  if (state.shell === "race" || state.shell === "queue" || state.shell === "room") return;
  if (!MODES[mode]) return;
  state.mode = mode;
  localStorage.setItem("tg_mode", mode);
  paintModes();
  pullBoard();
}

function chooseLength(length) {
  if (state.shell === "race" || state.shell === "queue" || state.shell === "room") return;
  if (!lengthInfo(length)) return;
  state.length = length;
  localStorage.setItem("tg_length", length);
  paintLengths();
}

function socketUrl(raceId) {
  const url = new URL("/ws", location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  if (raceId) url.searchParams.set("race", raceId);
  return url.toString();
}

function lobbySocketLive(sock = lobby) {
  return Boolean(sock && (sock.readyState === WebSocket.OPEN || sock.readyState === WebSocket.CONNECTING));
}

function stopLobbyRetry() {
  clearTimeout(lobbyRetryTimer);
  lobbyRetryTimer = null;
}

function stopLobby() {
  stopLobbyRetry();
  lobbyTries = 0;
  state.lobbyStatus = "closed";
  state.lobbyNotice = "";
  const sock = lobby;
  lobby = null;
  if (sock) {
    sock.abandoned = true;
    try { sock.close(); } catch { /* closed */ }
  }
}

function connectLobby() {
  if (state.session !== "in") return;
  if (lobbySocketLive()) return;
  let sock;
  try {
    sock = new WebSocket(socketUrl());
  } catch {
    handleLobbyDown(null, false);
    return;
  }
  lobby = sock;
  state.lobbyStatus = "connecting";
  sock.addEventListener("open", () => {
    if (sock !== lobby) return;
    sock.wasOpen = true;
    state.lobbyStatus = "open";
    lobbyTries = 0;
    stopLobbyRetry();
    if (state.playLock) state.lobbyNotice = "";
    else if (state.lobbyNotice === "requeue") state.lobbyNotice = "restored-requeue";
    else if (state.lobbyNotice === "room") state.lobbyNotice = "restored-room";
    else if (state.lobbyNotice === "reconnect") state.lobbyNotice = "restored";
    if (state.phase === "browse") {
      try { sock.send(JSON.stringify({ t: "browse" })); } catch { /* closed */ }
    }
    ensure();
  });
  sock.addEventListener("message", (event) => onLobby(event));
  sock.addEventListener("error", () => {
    if (sock !== lobby) return;
    handleLobbyDown(sock, Boolean(sock.wasOpen));
  });
  sock.addEventListener("close", () => {
    if (sock.abandoned) return;
    if (sock !== lobby && lobby !== null) return;
    const wasOpen = Boolean(sock.wasOpen);
    if (lobby === sock) lobby = null;
    handleLobbyDown(sock, wasOpen);
  });
}

function handleLobbyDown(sock, wasOpen) {
  if (sock?.abandoned) return;
  if (state.session !== "in") return;
  if (sock?.downHandled) {
    scheduleLobbyRetry();
    return;
  }
  if (sock) sock.downHandled = true;
  if (wasOpen) {
    const drop = lobbyDrop(state.phase);
    state.phase = drop.phase;
    if (drop.clearQueue) state.queue = null;
    if (drop.clearRoom) state.room = null;
    state.lobbyNotice = drop.notice;
  } else if (!state.lobbyNotice || state.lobbyNotice.startsWith("restored")) {
    state.lobbyNotice = "reconnect";
  }
  state.lobbyStatus = "lost";
  releasePlay();
  ensure();
  scheduleLobbyRetry();
}

function watchSockets() {
  const sock = lobby;
  if (sock && !sock.abandoned && !sock.downHandled && sock.readyState !== WebSocket.OPEN && sock.readyState !== WebSocket.CONNECTING) {
    handleLobbyDown(sock, Boolean(sock.wasOpen));
  }
  const race = raceSocket;
  if (!race || !state.raceId || race.downHandled || state.forfeitedLocally || !raceStillHere()) return;
  if (race.readyState === WebSocket.OPEN || race.readyState === WebSocket.CONNECTING) return;
  race.downHandled = true;
  armRaceRetry(state.raceId);
}

function scheduleLobbyRetry() {
  if (state.session !== "in") return;
  if (lobbyRetryTimer || lobbySocketLive()) return;
  if (lobbyTries >= LOBBY_RETRY_LIMIT) {
    ensure();
    return;
  }
  const delay = backoffDelay(lobbyTries, LOBBY_RETRY_BASE_MS, LOBBY_RETRY_CAP_MS);
  lobbyTries += 1;
  lobbyRetryTimer = setTimeout(() => {
    lobbyRetryTimer = null;
    if (state.session !== "in") return;
    connectLobby();
  }, delay);
}

function reconnectLobby() {
  if (state.session !== "in") return;
  lobbyTries = 0;
  stopLobbyRetry();
  if (lobby) {
    const sock = lobby;
    lobby = null;
    sock.abandoned = true;
    try { sock.close(); } catch { /* closed */ }
  }
  releasePlay();
  if (!state.lobbyNotice || state.lobbyNotice.startsWith("restored")) state.lobbyNotice = "reconnect";
  state.lobbyStatus = "lost";
  ensure();
  connectLobby();
}

function sendLobby(payload) {
  if (state.session !== "in") return false;
  try {
    connectLobby();
  } catch {
    return false;
  }
  if (!lobby) return false;
  const sock = lobby;
  const body = JSON.stringify(payload);
  const deliver = () => {
    if (sock !== lobby || sock.readyState !== WebSocket.OPEN) return false;
    try {
      sock.send(body);
      return true;
    } catch {
      return false;
    }
  };
  if (sock.readyState === WebSocket.OPEN) return deliver();
  if (sock.readyState === WebSocket.CONNECTING) {
    sock.addEventListener("open", () => {
      if (sock !== lobby) return;
      if (!deliver()) releasePlay();
    }, { once: true });
    return true;
  }
  return false;
}

function beginPlay(kind, payload) {
  if (state.playLock || state.session !== "in") return;
  state.playLock = true;
  pendingPlay = kind;
  paintPlayButtons();
  if (!sendLobby(payload)) {
    const queuedView = kind === "queue" && state.phase === "queue";
    releasePlay();
    if (queuedView) {
      state.phase = "lobby";
      state.queue = null;
      ensure();
    }
    toast("The lobby is not connected.");
  }
}

function releasePlay() {
  state.playLock = false;
  pendingPlay = "";
  paintPlayButtons();
}

function onLobby(event) {
  if (event.target !== lobby) return;
  let msg;
  try {
    msg = JSON.parse(event.data);
  } catch {
    return;
  }
  if (msg.t === "error") {
    toast(msg.error || "Something went wrong.");
    if (pendingPlay === "queue" && state.phase === "queue") {
      state.phase = "lobby";
      state.queue = null;
    }
    releasePlay();
    ensure();
    return;
  }
  if (msg.t === "queued") {
    releasePlay();
    state.lobbyNotice = "";
    state.queue = msg;
    state.phase = "queue";
    state.mode = msg.mode;
    if (msg.length) state.length = msg.length;
    ensure();
    return;
  }
  if (msg.t === "room") {
    releasePlay();
    state.lobbyNotice = "";
    state.room = msg;
    state.mode = msg.mode || state.mode;
    if (msg.length) state.length = msg.length;
    state.phase = "room";
    const url = new URL(location.href);
    url.searchParams.set("room", msg.code);
    history.replaceState({}, "", url);
    ensure();
    return;
  }
  if (msg.t === "match") startMatch(msg);
  if (msg.t === "rooms") {
    state.rooms = msg.rooms || [];
    if (msg.max) state.roomMax = msg.max;
    if (state.shell === "browse") paintRooms();
    return;
  }
  if (msg.t === "rematch") {
    if (msg.raceId !== state.raceId || state.phase !== "results") return;
    state.rematch = msg;
    paintRematch();
  }
}

function startMatch(msg) {
  state.sentence = msg.sentence;
  state.typed = "";
  state.ok = 0;
  state.err = 0;
  state.shift = false;
  state.startAt = msg.startAt;
  state.offset = (msg.serverNow || Date.now()) - Date.now();
  state.raceId = msg.raceId;
  state.mode = msg.mode;
  if (msg.length) state.length = msg.length;
  state.ranked = msg.ranked;
  state.kind = msg.kind || (msg.ranked ? "queue" : ((msg.players || []).length >= 2 ? "room" : "practice"));
  state.players = msg.players || [];
  state.live = (msg.players || []).map((player) => ({ id: player.id, i: 0, wpm: 0, finishedAt: null }));
  state.results = null;
  state.rematch = null;
  state.forfeitConfirm = false;
  state.forfeitedLocally = false;
  state.lobbyNotice = "";
  state.raceLink = "up";
  raceTries = 0;
  raceLostAt = 0;
  stopRaceRetry();
  releasePlay();
  state.phase = serverNow() < state.startAt ? "countdown" : "race";
  lastLive = "";
  lastNote = "";
  heardLock = false;
  heardFinish.clear();
  state.shell = "";
  sessionStorage.setItem("tg_race", msg.raceId);
  localStorage.setItem("tg_mode", state.mode);
  if (state.length) localStorage.setItem("tg_length", state.length);
  ensure();
  if (state.phase === "race") announce("Go. Race started.");
  openRace(msg.raceId);
  focusCapture();
}

function stopRaceRetry() {
  clearTimeout(raceRetryTimer);
  raceRetryTimer = null;
}

function raceStillHere() {
  return state.phase === "race" || state.phase === "countdown" || state.phase === "finishing";
}

function openRace(raceId) {
  stopRaceRetry();
  const previous = raceSocket;
  let mine;
  try {
    mine = new WebSocket(socketUrl(raceId));
  } catch {
    armRaceRetry(raceId);
    return;
  }
  raceSocket = mine;
  if (previous && previous !== mine) {
    try { previous.close(); } catch { /* closed */ }
  }
  mine.addEventListener("message", (event) => {
    if (mine !== raceSocket) return;
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.t === "hello") {
      raceTries = 0;
      raceLostAt = 0;
      state.raceLink = "up";
      stopRaceRetry();
      absorbHello(msg);
    } else if (msg.t === "state") absorbState(msg);
    else if (msg.t === "results") absorbResults(msg);
    else if (msg.t === "left") finishLocalLeave(mine);
    else if (msg.t === "wait") {
      toast("Wait for the start.");
      applyServerText(msg);
    } else if (msg.t === "sync") applyServerText(msg);
  });
  const noteDown = () => {
    if (mine.downHandled || mine !== raceSocket || state.forfeitedLocally || !raceStillHere()) return;
    mine.downHandled = true;
    armRaceRetry(raceId);
  };
  mine.addEventListener("error", noteDown);
  mine.addEventListener("close", noteDown);
}

function armRaceRetry(raceId) {
  if (state.forfeitedLocally || !raceStillHere()) return;
  if (!raceLostAt) raceLostAt = Date.now();
  const delay = nextRaceRetry(raceTries, Date.now() - raceLostAt);
  if (delay == null) {
    state.raceLink = "lost";
    stopRaceRetry();
    ensure();
    return;
  }
  state.raceLink = "retry";
  raceTries += 1;
  ensure();
  stopRaceRetry();
  raceRetryTimer = setTimeout(() => {
    raceRetryTimer = null;
    if (state.forfeitedLocally || state.raceId !== raceId || !raceStillHere()) return;
    openRace(raceId);
  }, delay);
}

function retryRace() {
  const raceId = state.raceId || sessionStorage.getItem("tg_race");
  if (!raceId) {
    abandonLostRace();
    return;
  }
  raceTries = 0;
  raceLostAt = 0;
  state.raceId = raceId;
  state.raceLink = "retry";
  if (!raceStillHere()) state.phase = "countdown";
  ensure();
  openRace(raceId);
}

function abandonLostRace() {
  state.forfeitedLocally = true;
  stopRaceRetry();
  releaseRaceSocket();
  state.forfeitedLocally = false;
  state.raceLink = "up";
  raceLostAt = 0;
  exitToLobby();
}

function absorbHello(msg) {
  state.sentence = msg.sentence;
  state.startAt = msg.startAt;
  state.offset = msg.serverNow - Date.now();
  state.mode = msg.mode;
  if (msg.length) state.length = msg.length;
  state.ranked = msg.ranked;
  state.kind = msg.kind || state.kind || (msg.ranked ? "queue" : ((msg.players || state.players || []).length >= 2 ? "room" : "practice"));
  state.players = msg.players || state.players;
  if (msg.results) {
    absorbResults(msg.results.t ? msg.results : { t: "results", ...msg.results });
    return;
  }
  state.live = Array.isArray(msg.racers) ? msg.racers : (msg.players || []).map((player) => {
    const finish = msg.finishes?.[player.id];
    const progress = msg.progress?.[player.id] || {};
    return {
      id: player.id,
      i: finish ? msg.sentence.length : progress.i || 0,
      ok: progress.ok || 0,
      err: progress.err || 0,
      wpm: 0,
      finishedAt: finish?.at || null,
    };
  });
  const mine = myLive();
  if (mine && state.typed.length < mine.i) {
    state.typed = msg.sentence.slice(0, mine.i);
    state.ok = mine.ok;
    state.err = mine.err;
  }
  if (mine?.finishedAt) state.phase = "finishing";
  else state.phase = serverNow() < state.startAt ? "countdown" : "race";
  const painted = document.querySelector(".race");
  if (painted && painted.dataset.mode !== state.mode) state.shell = "";
  ensure();
  noteFinishes();
  if (state.mode === "cursor") document.getElementById("capture")?.blur();
  else focusCapture();
}

function absorbState(msg) {
  if (state.forfeitedLocally) return;
  if (msg.serverNow) state.offset = msg.serverNow - Date.now();
  state.live = msg.players || [];
  const mine = myLive();
  if (mine?.finishedAt) state.phase = state.phase === "results" ? "results" : "finishing";
  if (state.shell === "race") {
    paintLocked();
    paintLanes();
    paintRaceNote();
  }
  noteFinishes();
}

function absorbResults(msg) {
  if (state.forfeitedLocally) return;
  state.results = msg;
  if (msg.kind) state.kind = msg.kind;
  if (typeof msg.ranked === "boolean") state.ranked = msg.ranked;
  for (const row of msg.rows || []) {
    const live = state.live.find((entry) => entry.id === row.id);
    if (!live) continue;
    if (row.outcome === "forfeit") live.status = "forfeit";
    else if (row.outcome === "timeout") live.status = "timeout";
    else if (row.outcome === "disconnect") live.status = "disconnect";
    else if (row.outcome === "forfeit-win" || row.finished) live.status = "finished";
  }
  state.phase = "results";
  state.forfeitConfirm = false;
  state.raceLink = "up";
  stopRaceRetry();
  ensure();
  refreshAfterRace();
}

function clearResume() {
  sessionStorage.removeItem("tg_race");
  const url = new URL(location.href);
  url.searchParams.delete("room");
  history.replaceState({}, "", url.pathname);
}

function releaseRaceSocket() {
  stopRaceRetry();
  clearResume();
  const sock = raceSocket;
  raceSocket = null;
  if (sock) {
    try { sock.close(); } catch { /* closed */ }
  }
}

function exitToLobby() {
  stopRaceRetry();
  raceLostAt = 0;
  state.raceLink = "up";
  clearResume();
  state.raceId = null;
  state.kind = null;
  state.phase = "lobby";
  state.results = null;
  state.sentence = "";
  state.typed = "";
  state.players = [];
  state.live = [];
  state.room = null;
  state.queue = null;
  state.rematch = null;
  state.forfeitConfirm = false;
  ensure();
}

function requestLeave() {
  if (racedOut()) {
    state.forfeitedLocally = true;
    const sock = raceSocket;
    sendLobby({ t: "leave" });
    exitToLobby();
    if (sock) sock.close();
    if (raceSocket === sock) raceSocket = null;
    return;
  }
  if (state.ranked) {
    state.forfeitConfirm = true;
    const dialog = document.getElementById("forfeit");
    if (dialog) dialog.hidden = false;
    document.getElementById("forfeit-keep")?.focus();
    return;
  }
  commitLeave();
}

function closeForfeit() {
  state.forfeitConfirm = false;
  const dialog = document.getElementById("forfeit");
  if (dialog) dialog.hidden = true;
  document.getElementById("leave-race")?.focus();
}

function confirmForfeit() {
  commitLeave();
}

function sendLeave() {
  const payload = JSON.stringify({ t: "leave" });
  const sock = raceSocket;
  if (!sock) return false;
  if (sock.readyState === WebSocket.OPEN) {
    sock.send(payload);
    return true;
  }
  if (sock.readyState === WebSocket.CONNECTING) {
    sock.addEventListener("open", () => {
      if (state.forfeitedLocally && sock.readyState === WebSocket.OPEN) sock.send(payload);
    }, { once: true });
    return true;
  }
  return false;
}

function armLeaveClose() {
  clearTimeout(leaveTimer);
  const sock = raceSocket;
  leaveTimer = setTimeout(() => {
    if (sock && raceSocket === sock) {
      sock.close();
      raceSocket = null;
    }
  }, 3000);
}

function finishLocalLeave(sock) {
  clearTimeout(leaveTimer);
  state.forfeitedLocally = true;
  clearResume();
  if (sock === raceSocket) raceSocket = null;
  try {
    sock.close();
  } catch {
    // Already closed.
  }
  if (state.phase !== "lobby") exitToLobby();
}

function commitLeave() {
  const ranked = Boolean(state.ranked);
  state.forfeitConfirm = false;
  state.forfeitedLocally = true;
  sendLeave();
  sendLobby({ t: "leave" });
  exitToLobby();
  toast(ranked ? "You forfeited." : "You left the race.");
  armLeaveClose();
}

function practiceAgain() {
  if (state.playLock) return;
  const mode = state.mode;
  const length = state.length;
  releaseRaceSocket();
  beginPlay("practice", { t: "practice", mode, length });
}

function queueAgain() {
  if (state.playLock) return;
  const mode = state.mode;
  const length = state.length;
  releaseRaceSocket();
  if (lobby?.readyState === WebSocket.OPEN) {
    state.phase = "queue";
    state.queue = { waiting: 1, mode, length };
    state.results = null;
    state.sentence = "";
    state.typed = "";
    state.players = [];
    state.live = [];
    state.room = null;
    state.rematch = null;
    state.forfeitConfirm = false;
    state.forfeitedLocally = false;
    ensure();
  }
  beginPlay("queue", { t: "queue", mode, length });
}

function leaveRace() {
  state.forfeitedLocally = false;
  state.forfeitConfirm = false;
  releaseRaceSocket();
  exitToLobby();
}

function resumeRace() {
  const raceId = sessionStorage.getItem("tg_race");
  if (state.session !== "in" || !raceId) return;
  state.raceId = raceId;
  state.phase = "countdown";
  state.raceLink = "up";
  state.shell = "";
  ensure();
  openRace(raceId);
  focusCapture();
}

document.addEventListener("keydown", (event) => {
  if (state.forfeitConfirm || racedOut()) return;
  const active = state.phase === "race" || state.phase === "countdown";
  const target = event.target;
  const plan = raceKeyPlan(event, {
    mode: state.mode,
    active,
    fromCapture: target?.id === "capture",
    fromField: Boolean(target?.matches?.("input, textarea, button, a, select")),
  });
  if (!plan.prevent) return;
  event.preventDefault();
  // Cursor typing goes through the on-screen keys. Desktop still takes a
  // physical key when the hidden capture field is not the target yet.
  if (plan.effect === "backspace") backspace();
  else if (plan.effect === "type") typeChar(event.key);
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  focusCapture();
});

document.addEventListener("paste", (event) => {
  if (state.phase === "race" || state.phase === "countdown") event.preventDefault();
});

window.addEventListener("pointerup", stopHold);
window.addEventListener("pointercancel", stopHold);

function stopHold() {
  clearTimeout(holdDelay);
  clearInterval(holdRepeat);
  holdDelay = null;
  holdRepeat = null;
}

setInterval(watchSockets, 250);

setInterval(() => {
  if (state.shell !== "race") return;
  const count = document.getElementById("count");
  if (!count) return;
  const left = state.startAt - serverNow();
  if (left > 2000) showCount(count, "3");
  else if (left > 1000) showCount(count, "2");
  else if (left > 0) showCount(count, "1");
  else if (left > -650) {
    showCount(count, "go");
    beginRace();
  } else {
    count.hidden = true;
    beginRace();
  }
  paintStats();
}, 80);

function beginRace() {
  if (state.phase !== "countdown") return;
  state.phase = "race";
  announce("Go. Race started.");
  setPageTitle();
  focusCapture();
}

function showCount(node, text) {
  const changed = node.hidden || node.textContent !== text;
  node.hidden = false;
  node.textContent = text;
  if (changed && text !== "go") announce(text);
}

function noteFinishes() {
  if (state.phase === "results") return;
  for (const row of state.live || []) {
    if (!row?.finishedAt || row.id === state.me?.id || heardFinish.has(row.id)) continue;
    heardFinish.add(row.id);
    const name = (state.players || []).find((player) => player.id === row.id)?.name || "Opponent";
    announce(`${name} finished.`);
  }
}

function clearRetry(key) {
  const row = retries[key];
  if (!row) return;
  clearTimeout(row.timer);
  row.timer = null;
  row.attempt = 0;
}

function scheduleRetry(key, run) {
  const row = retries[key];
  if (!row || row.timer || row.attempt >= RETRY_LIMIT) return;
  const delay = backoffDelay(row.attempt);
  row.attempt += 1;
  row.timer = setTimeout(() => {
    row.timer = null;
    run();
  }, delay);
}

function retryNow(key, run) {
  clearRetry(key);
  run();
}

function retrySession() {
  meEpoch += 1;
  clearRetry("me");
  state.session = "unknown";
  ensure();
  pullMe();
}

async function pull(path, options) {
  try {
    const data = await api(path, options);
    return { ok: true, status: 200, data };
  } catch (error) {
    return { ok: false, status: Number(error?.status) || 0, message: error?.message || "request failed" };
  }
}

function applyMe(result) {
  const previous = state.session;
  const kind = result.ok
    ? classifyMe({ ok: true, user: result.data?.user ?? null })
    : classifyMe({ ok: false, status: result.status });
  if (kind === "in") {
    state.session = "in";
    state.me = result.data.user;
    clearRetry("me");
    if (previous !== "in") pullRecent();
    return;
  }
  if (kind === "out") {
    if (previous === "in") dropLocalSession();
    else {
      state.session = "out";
      state.me = null;
      state.recent = [];
      state.recentError = "";
      clearRetry("me");
    }
    return;
  }
  if (previous === "unknown" || previous === "error") {
    state.session = "error";
    if (shouldAutoRetry(result.status)) scheduleRetry("me", () => pullMe());
  }
}

async function pullMe() {
  const epoch = meEpoch;
  const result = await pull("/api/me");
  if (epoch !== meEpoch) return;
  applyMe(result);
  ensure();
}

async function pullConfig() {
  const result = await pull("/api/config");
  if (result.ok) {
    const first = !state.config;
    state.config = result.data;
    state.configError = "";
    clearRetry("config");
    if (state.config?.lengths?.length && !lengthInfo(state.length)) state.length = state.config.lengths[0].id;
    if (first && state.shell !== "race" && state.shell !== "results") state.shell = "";
  } else {
    state.configError = "Lengths and sign-in options did not load.";
    if (shouldAutoRetry(result.status)) scheduleRetry("config", () => pullConfig());
  }
  ensure();
}

async function pullBoard() {
  const mode = state.mode;
  const result = await pull(`/api/leaderboard?mode=${encodeURIComponent(mode)}`);
  if (mode !== state.mode) return;
  if (result.ok) {
    state.board = result.data?.rows || [];
    state.boardYou = result.data?.you || null;
    state.boardError = "";
    clearRetry("board");
  } else {
    state.boardYou = null;
    state.boardError = "The ladder did not load.";
    if (shouldAutoRetry(result.status)) scheduleRetry("board", () => pullBoard());
  }
  ensure();
}

async function pullRecent() {
  if (state.session !== "in") {
    state.recent = [];
    state.recentError = "";
    return;
  }
  const result = await pull("/api/me/races");
  if (state.session !== "in") return;
  if (result.ok) {
    state.recent = result.data?.races || [];
    state.recentError = "";
    clearRetry("recent");
  } else {
    state.recentError = "Recent races did not load.";
    if (shouldAutoRetry(result.status)) scheduleRetry("recent", () => pullRecent());
  }
  ensure();
}

async function refreshProfile() {
  const epoch = meEpoch;
  const result = await pull("/api/me");
  if (epoch !== meEpoch) return;
  const kind = result.ok
    ? classifyMe({ ok: true, user: result.data?.user ?? null })
    : classifyMe({ ok: false, status: result.status });
  if (kind === "in") {
    state.me = result.data.user;
    state.session = "in";
    renderAccount();
    renderSide();
    return;
  }
  if (kind === "out") dropLocalSession();
}

function dropLocalSession() {
  meEpoch += 1;
  clearRetry("me");
  clearResume();
  state.forfeitedLocally = true;
  stopRaceRetry();
  const race = raceSocket;
  raceSocket = null;
  if (race) {
    try { race.close(); } catch { /* closed */ }
  }
  state.forfeitedLocally = false;
  stopLobby();
  state.session = "out";
  state.me = null;
  state.recent = [];
  state.recentError = "";
  state.phase = "lobby";
  state.results = null;
  state.players = [];
  state.live = [];
  state.queue = null;
  state.room = null;
  state.playLock = false;
  pendingPlay = "";
  state.raceLink = "up";
  raceLostAt = 0;
  raceTries = 0;
  ensure();
}

function refreshAfterRace() {
  return Promise.allSettled([pullBoard(), pullRecent(), refreshProfile()]);
}

async function boot() {
  const params = new URLSearchParams(location.search);
  if (params.get("auth_error")) {
    toast(AUTH_ERRORS[params.get("auth_error")] || "Sign-in failed.");
    params.delete("auth_error");
    const next = params.toString();
    history.replaceState({}, "", next ? `/?${next}` : "/");
  }
  if (!MODES[state.mode]) state.mode = "desktop";
  ensureNetBanner();
  try {
    await Promise.allSettled([pullMe(), pullConfig(), pullBoard()]);
    ensure();
    if (state.session === "in" && params.get("room") && !sessionStorage.getItem("tg_race")) {
      sendLobby({ t: "room_join", code: params.get("room") });
    }
    if (state.session === "in") resumeRace();
  } catch (error) {
    console.error(error);
    if (state.session === "unknown") state.session = "error";
    ensure();
  }
}

boot();
