// Ladder and length cards shared by the signed-out home screen and the lobby.

export function appendLadders(parent, h, options) {
  const modes = h("div", { class: "modes", role: "group", "aria-labelledby": "ladder-label" });
  modes.append(h("span", { id: "ladder-label", class: "visually-hidden", text: "Ladder" }));
  for (const [id, info] of Object.entries(options.modes || {})) {
    const selected = options.mode === id;
    const card = h("button", {
      class: `mode${selected ? " selected" : ""}`,
      type: "button",
      "data-mode": id,
      "aria-pressed": selected ? "true" : "false",
      onclick: () => options.onMode(id),
    });
    card.append(h("strong", { text: info.title }));
    card.append(h("span", { text: info.blurb }));
    const extra = options.detail ? options.detail(id) : "";
    if (extra) card.append(h("em", { text: extra }));
    modes.append(card);
  }
  parent.append(modes);
  const lengths = h("div", { class: "modes lengths", role: "group", "aria-labelledby": "length-label" });
  lengths.append(h("span", { id: "length-label", class: "visually-hidden", text: "Race length" }));
  for (const info of options.lengths || []) {
    const selected = options.length === info.id;
    const card = h("button", {
      class: `length${selected ? " selected" : ""}`,
      type: "button",
      "data-length": info.id,
      "aria-pressed": selected ? "true" : "false",
      onclick: () => options.onLength(info.id),
    });
    card.append(h("strong", { text: info.title }));
    card.append(h("span", { text: info.blurb }));
    lengths.append(card);
  }
  parent.append(lengths);
}
