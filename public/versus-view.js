function stat(h, label, value) {
  const cell = h("div", {});
  cell.append(h("span", { class: "solo-label", text: label }));
  cell.append(h("strong", { text: value }));
  return cell;
}

export function appendVersus(parent, h, view) {
  const box = h("fieldset", { class: "versus", id: "versus-practice" });
  box.append(h("legend", { text: "Unranked practice" }));
  box.append(h("p", { class: "hint", text: "Race a bot or your best run on this browser. Rating does not change." }));
  const presets = h("div", { class: "presets", role: "group", "aria-label": "Bot skill" });
  for (const preset of view.presets || []) {
    const on = preset.wpm === view.wpm;
    presets.append(h("button", {
      class: "btn preset",
      type: "button",
      "data-preset": String(preset.wpm),
      "aria-pressed": on ? "true" : "false",
      "aria-label": `${preset.label}, ${preset.wpm} WPM`,
      text: preset.label,
      onclick: () => view.onPreset(preset.wpm),
    }));
  }
  box.append(presets);
  const field = h("div", { class: "wpm-field" });
  field.append(h("label", { for: "bot-wpm", text: "Target WPM" }));
  const slider = h("input", {
    id: "bot-wpm",
    class: "wpm-slider",
    type: "range",
    min: String(view.min),
    max: String(view.max),
    step: "1",
    value: String(view.wpm),
    "aria-valuemin": String(view.min),
    "aria-valuemax": String(view.max),
    "aria-valuenow": String(view.wpm),
    "aria-valuetext": `${view.wpm} WPM`,
  });
  slider.addEventListener("input", () => view.onWpm(Number(slider.value)));
  field.append(slider);
  field.append(h("span", { id: "bot-wpm-value", class: "wpm-readout", text: `${view.wpm} WPM` }));
  box.append(field);
  const actions = h("div", { class: "actions" });
  actions.append(h("button", {
    class: "btn",
    type: "button",
    "data-action": "race-bot",
    text: "Race a bot",
    onclick: () => view.onBot(),
  }));
  actions.append(h("button", {
    id: "race-ghost",
    class: "btn",
    type: "button",
    "data-action": "race-ghost",
    text: "Race your ghost",
    disabled: !view.ghostReady,
    "aria-describedby": "ghost-hint",
    onclick: () => view.onGhost(),
  }));
  box.append(actions);
  box.append(h("p", { id: "ghost-hint", class: "hint", text: view.ghostHint || "" }));
  parent.append(box);
}

export function renderVersusResults(parent, h, view) {
  parent.append(h("h2", { class: "lead", text: "Practice results" }));
  parent.append(h("p", { class: "pill", text: view.title || "Practice" }));
  parent.append(h("p", { class: "versus-outcome", text: view.summary || "" }));
  parent.append(h("p", { class: "muted", text: "This run stays on this browser. It does not change rating." }));
  parent.append(h("p", { class: "quote", text: view.sentence || "" }));
  const stats = h("div", { class: "solo-stats" });
  stats.append(
    stat(h, "WPM", Number(view.wpm).toFixed(1)),
    stat(h, "Accuracy", `${Number(view.accuracy)}%`),
    stat(h, "Time", `${(Number(view.ms) / 1000).toFixed(1)}s`),
    stat(h, "Errors", String(view.errors || 0)),
    stat(h, view.oppLabel || "Opponent", Number(view.oppWpm).toFixed(1)),
    stat(h, "Opponent time", `${(Number(view.oppMs) / 1000).toFixed(1)}s`),
  );
  parent.append(stats);
  const actions = h("div", { class: "actions" });
  actions.append(
    h("button", { class: "btn primary", type: "button", "data-action": "race-again", text: "Race again", onclick: view.onAgain }),
    h("button", { class: "btn", type: "button", "data-action": "change-bot", text: "Change bot", onclick: view.onChange }),
    h("button", { class: "btn", type: "button", "data-action": "back-lobby", text: "Back to lobby", onclick: view.onLobby }),
  );
  parent.append(actions);
}
