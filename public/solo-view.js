// Results for a practice run that never left this browser.

function stat(h, label, value) {
  const cell = h("div", {});
  cell.append(h("span", { class: "solo-label", text: label }));
  cell.append(h("strong", { text: value }));
  return cell;
}

export function renderSoloResults(parent, h, view) {
  parent.append(h("h2", { class: "lead", text: "Practice results" }));
  parent.append(h("p", { class: "pill", text: "Practice" }));
  parent.append(h("p", { class: "muted", text: "This run stays on this browser. It is not ranked." }));
  parent.append(h("p", { class: "quote", text: view.sentence || "" }));
  const stats = h("div", { class: "solo-stats" });
  stats.append(
    stat(h, "WPM", Number(view.wpm).toFixed(1)),
    stat(h, "Accuracy", `${Number(view.accuracy)}%`),
    stat(h, "Time", `${(Number(view.ms) / 1000).toFixed(1)}s`),
    stat(h, "Errors", String(view.errors || 0)),
  );
  parent.append(stats);
  const actions = h("div", { class: "actions" });
  actions.append(
    h("button", { class: "btn primary", type: "button", "data-action": "try-again", text: "Try again", onclick: view.onAgain }),
    h("button", { class: "btn", type: "button", "data-action": "new-passage", text: "New passage", onclick: view.onNew }),
  );
  if (view.signedIn) {
    actions.append(h("button", { class: "btn", type: "button", "data-action": "race-others", text: "Race others", onclick: view.onRace }));
  } else if (view.loginHref) {
    actions.append(h("a", { class: "btn", href: view.loginHref, text: "Sign in to race others" }));
  } else {
    actions.append(h("button", { class: "btn", type: "button", "data-action": "race-others", text: "Sign in to race others", onclick: view.onRace }));
  }
  parent.append(actions);
}
