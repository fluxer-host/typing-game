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
  mode: localStorage.getItem("tg_mode") || "desktop",
  phase: "lobby",
  sentence: "",
  typed: "",
  ok: 0,
  err: 0,
  startAt: 0,
  offset: 0,
  raceId: null,
  ranked: false,
  players: [],
  live: [],
  results: null,
  room: null,
  queue: null,
  shift: false,
  shell: "",
};

let lobby = null;
let raceSocket = null;
let raceTries = 0;
let toastTimer = null;
let holdDelay = null;
let holdRepeat = null;

function h(tag, props, kids) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const kid of kids || []) node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return node;
}

function toast(text) {
  const node = document.getElementById("toast");
  node.textContent = text;
  node.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove("show"), 3200);
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

function correctLength(typed, sentence) {
  const limit = Math.min(typed.length, sentence.length);
  let index = 0;
  while (index < limit && typed[index] === sentence[index]) index += 1;
  return index;
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
  if (!state.config) return "loading";
  if (!state.me) return "auth";
  if (state.phase === "results") return "results";
  if (state.phase === "countdown" || state.phase === "race" || state.phase === "finishing") return "race";
  if (state.phase === "queue") return "queue";
  if (state.phase === "room") return "room";
  return "lobby";
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

function avatarNode(player, className) {
  if (player.avatar) {
    const img = h("img", { class: className || "avatar", alt: "", src: player.avatar });
    img.addEventListener("error", () => img.replaceWith(initialNode(player, className)));
    return img;
  }
  return initialNode(player, className);
}

function initialNode(player, className) {
  return h("span", {
    class: className || "initial",
    text: (player.name || "?").slice(0, 1).toUpperCase(),
    style: `background:${cssColor(player.color)}`,
  });
}

function modeElo() {
  if (!state.me) return null;
  return state.me.elo?.[state.mode];
}

function ensure() {
  const next = shellName();
  if (next !== state.shell) {
    state.shell = next;
    paintShell();
  }
  paintDynamic();
  renderAccount();
  renderSide();
}

function paintShell() {
  const stage = document.getElementById("stage");
  stage.replaceChildren();
  if (state.shell === "loading") {
    stage.append(h("p", { class: "loading", text: "Loading the track…" }));
    return;
  }
  if (state.shell === "auth") stage.append(authView());
  else if (state.shell === "lobby") stage.append(lobbyView());
  else if (state.shell === "queue") stage.append(queueView());
  else if (state.shell === "room") stage.append(roomView());
  else if (state.shell === "race") stage.append(raceView());
  else if (state.shell === "results") stage.append(resultsView());
}

function authView() {
  const box = h("div", {});
  box.append(h("h1", { class: "lead", text: "Race the room" }));
  box.append(h("p", { class: "muted", text: "Everyone in a match gets the same Fluxer line. First finished sentence wins." }));
  const actions = h("div", { class: "actions" });
  if (state.config.oauth) {
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
        await loadMeta();
        ensure();
        resumeRace();
      } catch (error) {
        toast(error.message === "name" ? "Use 2-24 letters for the local name." : "Could not open a local account.");
      }
    });
    box.append(h("p", { class: "hint", text: "Local accounts stay on this machine. Sign in with Fluxer on the public site." }));
    box.append(form);
  }
  if (!state.config.oauth && !state.config.devLogin) {
    box.append(h("p", { class: "hint", text: "Add the Fluxer client id and secret, then reload." }));
  }
  return box;
}

function lobbyView() {
  const box = h("div", {});
  box.append(h("h1", { class: "lead", text: "Pick a ladder" }));
  box.append(h("p", { class: "muted", text: "Queue for a live room, practice alone, or share a 4-character code." }));
  const modes = h("div", { class: "modes" });
  for (const [id, info] of Object.entries(MODES)) {
    const elo = state.me?.elo?.[id];
    const best = state.me?.best?.[id];
    const card = h("button", {
      class: `mode${state.mode === id ? " selected" : ""}`,
      type: "button",
      "data-mode": id,
      onclick: () => chooseMode(id),
    });
    card.append(h("strong", { text: info.title }));
    card.append(h("span", { text: info.blurb }));
    card.append(h("em", { text: `${Math.round(elo ?? 1000)} elo${best ? ` · best ${best} wpm` : ""}` }));
    modes.append(card);
  }
  box.append(modes);
  const actions = h("div", { class: "actions" });
  actions.append(
    h("button", { class: "btn primary", type: "button", "data-action": "queue", text: "Queue", onclick: () => sendLobby({ t: "queue", mode: state.mode }) }),
    h("button", { class: "btn", type: "button", "data-action": "practice", text: "Practice", onclick: () => sendLobby({ t: "practice", mode: state.mode }) }),
    h("button", { class: "btn", type: "button", "data-action": "create-room", text: "Create room", onclick: () => sendLobby({ t: "room_create", mode: state.mode }) }),
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
    h("h1", { class: "lead", text: "Looking for racers" }),
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
  if (waiting < 2) return `You are on the ${MODES[state.mode].title} ladder. Waiting for another racer.`;
  return `${waiting} racers are here. The room opens in a moment.`;
}

function roomView() {
  const room = state.room;
  const box = h("div", {});
  box.append(h("h1", { class: "lead", text: "Private room" }));
  box.append(h("div", { class: "code", id: "room-code-label", text: room?.code || "" }));
  box.append(h("p", { class: "muted", text: `${MODES[room?.mode || state.mode].title} ladder. Share the code or the link.` }));
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

function raceView() {
  const box = h("div", { class: "race" });
  const top = h("div", { class: "race-top" });
  top.append(h("span", { class: "pill", text: `${MODES[state.mode].title} · ${state.ranked ? "rated" : "practice"}` }));
  top.append(h("span", { class: "stats", id: "stats", text: "" }));
  box.append(top);
  const wrap = h("div", { class: "passage-wrap" });
  wrap.append(h("div", { class: "count", id: "count", hidden: true }));
  wrap.append(h("p", { class: "passage", id: "passage" }));
  const capture = h("input", {
    id: "capture",
    class: "capture",
    autocomplete: "off",
    autocapitalize: "off",
    autocorrect: "off",
    spellcheck: "false",
    "aria-label": "Typing capture",
  });
  wrap.append(capture);
  box.append(wrap);
  const hint = state.mode === "cursor"
    ? "Click the keys. The keyboard does not type on this ladder."
    : state.mode === "mobile"
      ? "Tap the sentence if the phone keyboard is closed."
      : "Type the line. Backspace fixes a miss.";
  box.append(h("p", { class: "hint", text: hint }));
  if (state.mode === "cursor") box.append(keyboard());
  box.append(h("p", { class: "locked", id: "locked", hidden: true, text: "Locked in. Waiting for the rest of the room." }));
  capture.addEventListener("keydown", (event) => {
    if (state.mode !== "mobile") return;
    if (event.key === "Backspace") {
      event.preventDefault();
      backspace();
    }
  });
  capture.addEventListener("beforeinput", (event) => {
    if (state.mode !== "mobile") return;
    if (event.inputType === "insertText" && event.data) {
      event.preventDefault();
      for (const ch of event.data) typeChar(ch);
    } else if (event.inputType === "deleteContentBackward") {
      event.preventDefault();
      backspace();
    } else {
      event.preventDefault();
    }
    capture.value = "";
  });
  wrap.addEventListener("pointerdown", () => {
    if (state.mode === "mobile") capture.focus({ preventScroll: true });
  });
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
  document.querySelector('[data-key="shift"]')?.classList.toggle("on", state.shift);
}

function resultsView() {
  const box = h("div", { class: "results" });
  if (state.results?.cancelled) {
    box.append(h("h1", { class: "lead", text: "Room closed" }));
    box.append(h("p", { class: "muted", text: "Everyone left before a finish." }));
  } else {
    box.append(h("h1", { class: "lead", text: "Finish order" }));
    box.append(h("p", { class: "quote", text: state.results?.sentence || state.sentence }));
    box.append(resultTable());
  }
  const actions = h("div", { class: "result-actions" });
  actions.append(
    h("button", { class: "btn primary", type: "button", text: "Queue again", onclick: () => { leaveRace(); sendLobby({ t: "queue", mode: state.mode }); } }),
    h("button", { class: "btn", type: "button", text: "Practice", onclick: () => { leaveRace(); sendLobby({ t: "practice", mode: state.mode }); } }),
    h("button", { class: "btn ghost", type: "button", text: "Lobby", onclick: () => leaveRace() }),
  );
  box.append(actions);
  return box;
}

function resultTable() {
  const table = h("table", {});
  const head = h("tr", {});
  for (const label of ["Place", "Racer", "WPM", "Acc", "Time", "Elo"]) head.append(h("th", { text: label }));
  table.append(h("thead", {}, [head]));
  const body = h("tbody", {});
  for (const row of state.results?.rows || []) {
    const tr = h("tr", { class: row.id === state.me?.id ? "me" : "" });
    tr.append(h("td", { text: row.finished ? String(row.place) : "DNF" }));
    tr.append(h("td", { text: row.name }));
    tr.append(h("td", { text: Number(row.wpm).toFixed(1) }));
    tr.append(h("td", { text: `${row.accuracy}%` }));
    tr.append(h("td", { text: row.ms == null ? "DNF" : `${(row.ms / 1000).toFixed(1)}s` }));
    const delta = row.eloAfter == null || row.eloBefore == null ? "unrated" : formatDelta(row.eloAfter - row.eloBefore);
    const cell = h("td", { text: delta, class: delta.startsWith("+") ? "up" : delta.startsWith("-") ? "down" : "" });
    tr.append(cell);
    body.append(tr);
  }
  table.append(body);
  return table;
}

function formatDelta(value) {
  if (value > 0) return `+${value}`;
  return String(value);
}

function paintDynamic() {
  if (state.shell === "queue") {
    const copy = document.getElementById("queue-copy");
    if (copy) copy.textContent = queueCopy();
  }
  if (state.shell === "room") paintRoom();
  if (state.shell === "race") {
    paintPassage();
    paintStats();
    paintLocked();
  }
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
  const good = correctLength(state.typed, sentence);
  const wrong = state.typed.length > good;
  box.replaceChildren();
  for (let i = 0; i < sentence.length; i++) {
    const span = h("span", { class: "ch", text: wrong && i === good ? state.typed[good] : sentence[i] });
    if (i < good) span.classList.add("ok");
    if (wrong && i === good) span.classList.add("bad");
    if ((!wrong && i === state.typed.length) || (wrong && i === good)) span.classList.add("cur");
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
  node.hidden = state.phase !== "finishing";
}

function typeChar(ch) {
  if (state.phase === "countdown") {
    toast("Wait for the start.");
    return;
  }
  if (state.phase !== "race") return;
  if (serverNow() < state.startAt) {
    toast("Wait for the start.");
    return;
  }
  const good = correctLength(state.typed, state.sentence);
  if (state.typed.length > good || good >= state.sentence.length) return;
  state.typed += ch;
  if (ch === state.sentence[good]) state.ok += 1;
  else state.err += 1;
  const done = state.typed === state.sentence;
  publish(done ? "fin" : "prog");
  if (done) state.phase = "finishing";
  paintPassage();
  paintStats();
  paintLocked();
  localLane();
}

function backspace() {
  if (state.phase !== "race" || !state.typed) return;
  state.typed = state.typed.slice(0, -1);
  publish("prog");
  paintPassage();
  paintStats();
  localLane();
}

function publish(kind) {
  const index = correctLength(state.typed, state.sentence);
  if (raceSocket?.readyState === WebSocket.OPEN) {
    raceSocket.send(JSON.stringify({ t: kind, i: index, ok: state.ok, err: state.err }));
  }
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
      await api("/auth/logout", { method: "POST" });
      sessionStorage.removeItem("tg_race");
      if (raceSocket) raceSocket.close();
      raceSocket = null;
      if (lobby) lobby.close();
      lobby = null;
      state.me = null;
      state.recent = [];
      state.phase = "lobby";
      state.results = null;
      state.players = [];
      state.live = [];
      ensure();
    },
  }));
  slot.className = "account";
}

function renderSide() {
  paintLanes();
  const you = document.getElementById("you");
  you.replaceChildren(h("h2", { text: MODES[state.mode].title }));
  if (!state.me) {
    you.append(h("p", { class: "empty", text: "Sign in to take a ladder spot." }));
  } else {
    const best = state.me.best?.[state.mode];
    you.append(h("p", { text: `${Math.round(modeElo() ?? 1000)} elo` }));
    you.append(h("p", { class: "muted", text: `${state.me.wins?.[state.mode] || 0} wins · ${state.me.races?.[state.mode] || 0} rated` }));
    you.append(h("p", { class: "muted", text: best ? `Best ${best} wpm` : "No finished race yet" }));
  }
  const board = document.getElementById("board");
  board.replaceChildren(h("h2", { text: "Ladder" }));
  if (!state.board.length) board.append(h("p", { class: "empty", text: "No rated races yet." }));
  for (const [index, row] of state.board.entries()) {
    const line = h("div", { class: "board-row" });
    line.append(h("b", { text: `${index + 1}. ${row.name}` }));
    line.append(h("span", { text: String(Math.round(row.elo?.[state.mode] ?? 1000)) }));
    board.append(line);
  }
  const recent = document.getElementById("recent");
  recent.replaceChildren(h("h2", { text: "Recent" }));
  if (!state.recent.length) recent.append(h("p", { class: "empty", text: "Your races show up here." }));
  for (const race of state.recent) {
    const line = h("div", { class: "recent-row" });
    const place = race.ms == null ? "DNF" : `#${race.place}`;
    line.append(h("b", { text: `${place} · ${race.mode}` }));
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
    track.append(h("div", { class: "fill", style: `width:${Math.round(((row.i || 0) / total) * 100)}%` }));
    lane.append(track);
    lane.append(h("span", { class: "pace", text: row.finishedAt ? "fin" : `${Number(row.wpm || 0).toFixed(0)}` }));
    root.append(lane);
  }
}

function chooseMode(mode) {
  if (state.shell === "race" || state.shell === "queue" || state.shell === "room") return;
  state.mode = mode;
  localStorage.setItem("tg_mode", mode);
  loadBoard().then(() => ensure());
}

function socketUrl(raceId) {
  const url = new URL("/ws", location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  if (raceId) url.searchParams.set("race", raceId);
  return url.toString();
}

function openLobby() {
  if (lobby && (lobby.readyState === WebSocket.OPEN || lobby.readyState === WebSocket.CONNECTING)) return;
  lobby = new WebSocket(socketUrl());
  lobby.addEventListener("message", (event) => onLobby(event));
  lobby.addEventListener("close", () => {
    if (state.phase === "queue") toast("Lobby connection closed.");
  });
}

function sendLobby(payload) {
  openLobby();
  const send = () => lobby?.send(JSON.stringify(payload));
  if (lobby.readyState === WebSocket.OPEN) send();
  else lobby.addEventListener("open", send, { once: true });
}

function onLobby(event) {
  if (event.target !== lobby) return;
  const msg = JSON.parse(event.data);
  if (msg.t === "error") {
    toast(msg.error || "Something went wrong.");
    return;
  }
  if (msg.t === "queued") {
    state.queue = msg;
    state.phase = "queue";
    state.mode = msg.mode;
    ensure();
    return;
  }
  if (msg.t === "room") {
    state.room = msg;
    state.mode = msg.mode || state.mode;
    state.phase = "room";
    const url = new URL(location.href);
    url.searchParams.set("room", msg.code);
    history.replaceState({}, "", url);
    ensure();
    return;
  }
  if (msg.t === "match") startMatch(msg);
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
  state.ranked = msg.ranked;
  state.players = msg.players || [];
  state.live = (msg.players || []).map((player) => ({ id: player.id, i: 0, wpm: 0, finishedAt: null }));
  state.results = null;
  state.phase = serverNow() < state.startAt ? "countdown" : "race";
  state.shell = "";
  sessionStorage.setItem("tg_race", msg.raceId);
  localStorage.setItem("tg_mode", state.mode);
  ensure();
  openRace(msg.raceId);
}

function openRace(raceId) {
  const previous = raceSocket;
  const mine = new WebSocket(socketUrl(raceId));
  raceSocket = mine;
  if (previous) previous.close();
  mine.addEventListener("message", (event) => {
    if (mine !== raceSocket) return;
    const msg = JSON.parse(event.data);
    if (msg.t === "hello") {
      raceTries = 0;
      absorbHello(msg);
    } else if (msg.t === "state") absorbState(msg);
    else if (msg.t === "results") absorbResults(msg);
    else if (msg.t === "wait") toast("Wait for the start.");
  });
  mine.addEventListener("close", () => {
    if (mine !== raceSocket) return;
    if (state.phase !== "race" && state.phase !== "countdown" && state.phase !== "finishing") return;
    raceTries += 1;
    if (raceTries > 3) {
      sessionStorage.removeItem("tg_race");
      toast("Lost the race connection.");
      state.phase = "lobby";
      ensure();
      return;
    }
    setTimeout(() => {
      if (state.raceId === raceId && mine === raceSocket) openRace(raceId);
    }, 400);
  });
}

function absorbHello(msg) {
  state.sentence = msg.sentence;
  state.startAt = msg.startAt;
  state.offset = msg.serverNow - Date.now();
  state.mode = msg.mode;
  state.ranked = msg.ranked;
  state.players = msg.players || state.players;
  if (msg.results) {
    absorbResults(msg.results.t ? msg.results : { t: "results", ...msg.results });
    return;
  }
  state.live = (msg.players || []).map((player) => {
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
  const mine = state.live.find((row) => row.id === state.me?.id);
  if (mine && state.typed.length < mine.i) {
    state.typed = msg.sentence.slice(0, mine.i);
    state.ok = mine.ok;
    state.err = mine.err;
  }
  if (mine?.finishedAt) state.phase = "finishing";
  else state.phase = serverNow() < state.startAt ? "countdown" : "race";
  ensure();
}

function absorbState(msg) {
  if (msg.serverNow) state.offset = msg.serverNow - Date.now();
  state.live = msg.players || [];
  const mine = state.live.find((row) => row.id === state.me?.id);
  if (mine?.finishedAt) state.phase = state.phase === "results" ? "results" : "finishing";
  if (state.shell === "race") {
    paintLocked();
    paintLanes();
  }
}

function absorbResults(msg) {
  state.results = msg;
  state.phase = "results";
  ensure();
  loadMeta().then(() => renderSide());
}

function leaveRace() {
  sessionStorage.removeItem("tg_race");
  if (raceSocket) raceSocket.close();
  raceSocket = null;
  state.phase = "lobby";
  state.results = null;
  state.sentence = "";
  state.typed = "";
  state.players = [];
  state.live = [];
  state.room = null;
  state.queue = null;
  const url = new URL(location.href);
  url.searchParams.delete("room");
  history.replaceState({}, "", url.pathname);
  ensure();
}

function resumeRace() {
  const raceId = sessionStorage.getItem("tg_race");
  if (!state.me || !raceId) return;
  state.raceId = raceId;
  state.phase = "countdown";
  openRace(raceId);
}

async function loadBoard() {
  const data = await api(`/api/leaderboard?mode=${encodeURIComponent(state.mode)}`);
  state.board = data.rows || [];
}

async function loadMeta() {
  await loadBoard();
  if (!state.me) {
    state.recent = [];
    return;
  }
  try {
    const data = await api("/api/me/races");
    state.recent = data.races || [];
  } catch {
    state.recent = [];
  }
  const me = await api("/api/me");
  if (me.user) state.me = me.user;
}

document.addEventListener("keydown", (event) => {
  if (state.mode === "cursor") {
    if ((state.phase === "race" || state.phase === "countdown") && (event.key.length === 1 || event.key === "Backspace" || event.key === " ")) {
      event.preventDefault();
    }
    return;
  }
  if (state.mode !== "desktop") return;
  if (state.phase !== "race" && state.phase !== "countdown") return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.target && event.target.matches && event.target.matches("input, textarea") && event.target.id !== "capture") return;
  if (event.key === "Backspace") {
    event.preventDefault();
    backspace();
  } else if (event.key.length === 1) {
    event.preventDefault();
    typeChar(event.key);
  }
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

setInterval(() => {
  if (state.shell !== "race") return;
  const count = document.getElementById("count");
  if (!count) return;
  const left = state.startAt - serverNow();
  if (left > 2800) showCount(count, "3");
  else if (left > 1800) showCount(count, "2");
  else if (left > 800) showCount(count, "1");
  else if (left > 0) showCount(count, "go");
  else {
    count.hidden = true;
    if (state.phase === "countdown") {
      state.phase = "race";
      if (state.mode === "mobile") document.getElementById("capture")?.focus({ preventScroll: true });
    }
  }
  paintStats();
}, 80);

function showCount(node, text) {
  node.hidden = false;
  node.textContent = text;
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
  state.config = await api("/api/config");
  const me = await api("/api/me");
  state.me = me.user;
  await loadMeta();
  ensure();
  if (state.me && params.get("room") && !sessionStorage.getItem("tg_race")) {
    sendLobby({ t: "room_join", code: params.get("room") });
  }
  resumeRace();
}

boot().catch((error) => {
  console.error(error);
  toast("The track did not load.");
});
