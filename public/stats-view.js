import { chartPoints, trendSvg } from "./chart.js";
import {
  LADDER_NAMES,
  LENGTH_NAMES,
  displayStanding,
  excerpt,
  practiceTitle,
  formatRunDate,
  historyExport,
  ladderName,
  lengthName,
} from "./history.js";
import { passageById } from "../src/sentences.js";

function cell(h, label, text) {
  return h("td", { "data-label": label, text });
}

function tableHead(h, labels) {
  const row = h("tr", {});
  for (const label of labels) row.append(h("th", { scope: "col", text: label }));
  return h("thead", {}, [row]);
}

function bestRows(h, model) {
  const body = h("tbody", {});
  for (const mode of model.ladders) {
    for (const length of model.lengths) {
      const best = model.bests[`${mode}|${length}`];
      const row = h("tr", {});
      row.append(cell(h, "Ladder", ladderName(mode)));
      row.append(cell(h, "Length", lengthName(length)));
      row.append(cell(h, "Best WPM", best ? Number(best.wpm).toFixed(1) : "None"));
      row.append(cell(h, "Accuracy", best ? `${Number(best.accuracy)}%` : "None"));
      body.append(row);
    }
  }
  return body;
}

function recentRows(h, model) {
  const body = h("tbody", {});
  if (!model.recent.length) {
    const row = h("tr", {});
    const empty = h("td", { colspan: "6", "data-label": "Runs", text: "No runs yet." });
    row.append(empty);
    body.append(row);
    return body;
  }
  for (const run of model.recent) {
    const row = h("tr", {});
    row.append(cell(h, "Date", formatRunDate(run.at)));
    row.append(cell(h, "Ladder", ladderName(run.mode) || run.mode || ""));
    row.append(cell(h, "Length", lengthName(run.length)));
    const standing = displayStanding(run);
    row.append(cell(h, "Kind", standing === "Practice" ? practiceTitle(run) : standing));
    row.append(cell(h, "WPM", Number(run.wpm).toFixed(1)));
    row.append(cell(h, "Accuracy", `${Number(run.accuracy)}%`));
    body.append(row);
  }
  return body;
}

function trendTable(h, points) {
  const table = h("table", { id: "trend-table", class: "stats-table" });
  table.append(h("caption", { class: "visually-hidden", text: "Words per minute for the last 30 runs" }));
  table.append(tableHead(h, ["Run", "WPM"]));
  const body = h("tbody", {});
  if (!points.length) {
    body.append(h("tr", {}, [h("td", { colspan: "2", "data-label": "Runs", text: "No runs yet." })]));
  }
  points.forEach((point, index) => {
    const row = h("tr", {});
    row.append(cell(h, "Run", String(index + 1)));
    row.append(cell(h, "WPM", Number(point.wpm).toFixed(1)));
    body.append(row);
  });
  table.append(body);
  return table;
}

function passageRows(h, model, onRetry) {
  const body = h("tbody", {});
  if (!model.passages.length) {
    body.append(h("tr", {}, [h("td", { colspan: "5", "data-label": "Passages", text: "No passage bests yet." })]));
    return body;
  }
  for (const run of model.passages) {
    const record = passageById(run.passageId);
    const row = h("tr", {});
    row.append(cell(h, "Passage", excerpt(record?.text || run.sentence || run.passageId)));
    row.append(cell(h, "Ladder", ladderName(run.mode)));
    row.append(cell(h, "Length", lengthName(run.length)));
    row.append(cell(h, "Best WPM", Number(run.wpm).toFixed(1)));
    const action = h("td", { "data-label": "Retry" });
    if (record && LADDER_NAMES[run.mode] && LENGTH_NAMES[run.length]) {
      action.append(h("button", {
        class: "btn",
        type: "button",
        text: "Retry this passage",
        onclick: () => onRetry(run),
      }));
    }
    row.append(action);
    body.append(row);
  }
  return body;
}

export function renderStats(parent, h, model, actions) {
  parent.append(h("h2", { class: "lead", text: "Your stats" }));
  parent.append(h("p", { class: "muted", text: actions.signedIn
    ? "Practice stays on this browser. Ranked rows are the last 12 races stored for your account."
    : "Practice stays on this browser. Sign in when you want a ranked race." }));
  if (model.localCount === 0) {
    parent.append(h("p", { class: "empty", text: "No practice runs on this browser yet." }));
  }
  const summary = h("p", { class: "stats-summary" });
  if (model.total === 0) summary.textContent = "Total runs 0.";
  else {
    summary.textContent = `Total runs ${model.total}. Average ${model.averageWpm.toFixed(1)} wpm. Average accuracy ${model.averageAccuracy}%.`;
  }
  parent.append(summary);
  parent.append(h("h3", { text: "Personal bests" }));
  const bests = h("table", { class: "stats-table" });
  bests.append(h("caption", { class: "visually-hidden", text: "Personal bests by ladder and length" }));
  bests.append(tableHead(h, ["Ladder", "Length", "Best WPM", "Accuracy"]));
  bests.append(bestRows(h, model));
  parent.append(bests);

  parent.append(h("h3", { text: "Recent runs" }));
  if (model.total > model.recent.length) {
    parent.append(h("p", { class: "muted", text: `Showing ${model.recent.length} of ${model.total} runs.` }));
  }
  const recent = h("table", { class: "stats-table" });
  recent.append(h("caption", { class: "visually-hidden", text: "Recent runs" }));
  recent.append(tableHead(h, ["Date", "Ladder", "Length", "Kind", "WPM", "Accuracy"]));
  recent.append(recentRows(h, model));
  parent.append(recent);

  parent.append(h("h3", { id: "trend-title", text: "Pace over the last 30 runs" }));
  const geometry = chartPoints(model.trend);
  if (geometry.empty) parent.append(h("p", { class: "empty", text: "No runs yet." }));
  parent.append(trendSvg(geometry));
  parent.append(trendTable(h, geometry.points));

  parent.append(h("h3", { text: "Passage bests" }));
  const passages = h("table", { class: "stats-table" });
  passages.append(h("caption", { class: "visually-hidden", text: "Best run for each passage" }));
  passages.append(tableHead(h, ["Passage", "Ladder", "Length", "Best WPM", "Retry"]));
  passages.append(passageRows(h, model, actions.onRetry));
  parent.append(passages);

  const buttons = h("div", { class: "actions" });
  buttons.append(
    h("a", { class: "btn ghost", href: "#/", text: "Back" }),
    h("button", { class: "btn", type: "button", text: "Export JSON", onclick: () => actions.onExport(historyExport(actions.localRuns)) }),
    h("button", { class: "btn", type: "button", text: "Clear local history", onclick: actions.onAskClear }),
  );
  parent.append(buttons);
  if (actions.confirm) {
    const confirm = h("div", { class: "confirm", role: "group", "aria-labelledby": "clear-title" });
    confirm.append(h("p", { id: "clear-title", text: "Clear practice history on this browser? Ranked races on the server stay." }));
    const row = h("div", { class: "actions" });
    row.append(
      h("button", { id: "clear-yes", class: "btn primary", type: "button", text: "Clear history", onclick: actions.onConfirmClear }),
      h("button", { class: "btn", type: "button", text: "Cancel", onclick: actions.onCancelClear }),
    );
    confirm.append(row);
    parent.append(confirm);
  }
}
