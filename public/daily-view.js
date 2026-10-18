// Home card and results for the daily challenge. No inline styles.

const RULE = "The first finish today is the scored attempt. Later runs are practice and stay off the leaderboard. Rating does not change.";

function cell(h, text, header) {
  return h(header ? "th" : "td", header ? { scope: "col", text } : { text });
}

export function appendDaily(parent, h, view) {
  const card = h("section", {
    class: "daily",
    id: "daily-challenge",
    "aria-labelledby": "daily-title",
  });
  card.append(h("h2", { id: "daily-title", text: "Daily challenge" }));
  card.append(h("p", { id: "daily-meta", class: "daily-meta", text: "Loading today's challenge." }));
  card.append(h("p", { id: "daily-countdown", class: "daily-count", text: "Next challenge in 00:00:00" }));
  card.append(h("p", { id: "daily-you", class: "daily-you", text: "" }));
  card.append(h("p", { id: "daily-rule", class: "hint", text: RULE }));
  card.append(h("div", { class: "actions" }, [
    h("button", {
      class: "btn primary",
      type: "button",
      id: "daily-play",
      "data-action": "daily-play",
      "aria-describedby": "daily-rule",
      text: "Play",
      onclick: view.onPlay,
    }),
  ]));
  const table = h("table", { class: "daily-table" });
  table.append(h("caption", { id: "daily-caption", text: "Today's top scores" }));
  const head = h("tr");
  head.append(cell(h, "Rank", true), cell(h, "Racer", true), cell(h, "WPM", true), cell(h, "Accuracy", true));
  table.append(h("thead", {}, [head]));
  table.append(h("tbody", { id: "daily-rows" }));
  card.append(table);
  parent.append(card);
}

export function fillDaily(view) {
  const meta = document.getElementById("daily-meta");
  if (!meta) return;
  meta.textContent = view.meta || "Loading today's challenge.";
  const countdown = document.getElementById("daily-countdown");
  if (countdown) countdown.textContent = view.countdown || "Next challenge in 00:00:00";
  const you = document.getElementById("daily-you");
  if (you) you.textContent = view.you || "";
  const play = document.getElementById("daily-play");
  if (play) {
    play.textContent = view.playLabel || "Play";
    play.disabled = !view.ready;
  }
  const caption = document.getElementById("daily-caption");
  if (caption) caption.textContent = view.caption || "Today's top scores";
  const body = document.getElementById("daily-rows");
  if (!body) return;
  body.replaceChildren();
  const rows = view.rows || [];
  if (!rows.length) {
    const empty = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 4;
    td.textContent = "No scores yet today.";
    empty.append(td);
    body.append(empty);
    return;
  }
  for (const row of rows) {
    const tr = document.createElement("tr");
    if (row.self) tr.className = "me";
    const rank = document.createElement("td");
    rank.textContent = String(row.rank || "");
    const name = document.createElement("td");
    name.textContent = row.name || "Racer";
    if (row.self) {
      const mark = document.createElement("span");
      mark.className = "visually-hidden";
      mark.textContent = " (you)";
      name.append(mark);
    }
    const wpm = document.createElement("td");
    wpm.textContent = Number(row.wpm || 0).toFixed(1);
    const accuracy = document.createElement("td");
    accuracy.textContent = `${Number(row.accuracy || 0)}%`;
    tr.append(rank, name, wpm, accuracy);
    body.append(tr);
  }
}

function stat(h, label, value) {
  const cellNode = h("div", {});
  cellNode.append(h("span", { class: "solo-label", text: label }));
  cellNode.append(h("strong", { text: value }));
  return cellNode;
}

export function renderDailyResults(parent, h, view) {
  parent.append(h("h2", { class: "lead", text: "Daily challenge" }));
  parent.append(h("p", { class: "pill", text: view.badge || "Practice" }));
  if (view.notice) parent.append(h("p", { class: "muted", text: view.notice }));
  if (view.sentence) parent.append(h("p", { class: "quote", text: view.sentence }));
  if (view.officialNote) parent.append(h("p", { class: "hint official-note", text: view.officialNote }));
  const stats = h("div", { class: "solo-stats" });
  stats.append(
    stat(h, "WPM", Number(view.wpm || 0).toFixed(1)),
    stat(h, "Accuracy", `${Number(view.accuracy || 0)}%`),
    stat(h, "Time", `${(Number(view.ms || 0) / 1000).toFixed(1)}s`),
    stat(h, "Rank", view.rankText || "Practice"),
  );
  parent.append(stats);
  const actions = h("div", { class: "actions" });
  actions.append(
    h("button", {
      class: "btn primary",
      type: "button",
      "data-action": "race-again",
      text: "Try again (practice)",
      onclick: view.onAgain,
    }),
    h("button", {
      class: "btn",
      type: "button",
      "data-action": "back-lobby",
      text: "Back to lobby",
      onclick: view.onLobby,
    }),
  );
  parent.append(actions);
}
