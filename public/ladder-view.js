// Ladder page markup. The page module owns the requests and the hash.

import { avatarDisc, tabMove } from "./ladder.js";

function ladderInitial(h, row) {
  const node = h("span", {
    class: "initial",
    text: String(row.name || "?").slice(0, 1).toUpperCase(),
  });
  const fill = avatarDisc(row.color);
  if (fill) node.style.backgroundColor = fill;
  return node;
}

function ladderAvatar(h, row) {
  if (!row.avatar) return ladderInitial(h, row);
  const img = h("img", {
    class: "avatar",
    alt: "",
    src: row.avatar,
    width: "32",
    height: "32",
    loading: "lazy",
  });
  img.addEventListener("error", () => {
    img.replaceWith(ladderInitial(h, row));
  });
  return img;
}

function nameCell(h, row) {
  const who = h("span", { class: "ladder-who" });
  who.append(ladderAvatar(h, row));
  who.append(h("span", { class: "ladder-name", text: row.name }));
  if (row.self) who.append(h("span", { class: "you-tag", text: "You" }));
  return who;
}

function bodyRows(h, columns, rows, prefix) {
  return rows.map((row) => {
    const props = {};
    if (row.self) {
      props.class = "me";
      props["aria-current"] = "true";
      props.tabindex = "-1";
      props.id = `${prefix}-${row.rank}`;
    }
    const tr = h("tr", props);
    for (const column of columns) {
      const td = h("td", { class: column.className });
      if (column.key === "name") td.append(nameCell(h, row));
      else td.textContent = String(row[column.key] ?? "");
      tr.append(td);
    }
    return tr;
  });
}

function buildTable(h, { caption, captionId, columns, rows, prefix, busy, emptyText }) {
  const table = h("table", { class: "ladder-table" });
  const captionProps = { class: "ladder-caption", text: caption };
  if (captionId) {
    captionProps.id = captionId;
    captionProps.tabindex = "-1";
  }
  table.append(h("caption", captionProps));
  const head = h("tr");
  for (const column of columns) {
    head.append(h("th", { scope: "col", class: column.className, text: column.label }));
  }
  table.append(h("thead", {}, [head]));
  const body = h("tbody");
  if (busy) {
    body.setAttribute("aria-hidden", "true");
    for (let i = 0; i < 8; i += 1) {
      const tr = h("tr", { class: "ladder-skel-row" });
      for (const column of columns) {
        tr.append(h("td", { class: column.className }, [h("span", { class: "ladder-skel" })]));
      }
      body.append(tr);
    }
  } else if (!rows.length) {
    body.append(h("tr", {}, [
      h("td", { colspan: String(columns.length), text: emptyText }),
    ]));
  } else {
    for (const tr of bodyRows(h, columns, rows, prefix)) body.append(tr);
  }
  table.append(body);
  return table;
}

export function renderLadder(parent, h, model, actions) {
  parent.append(h("h2", { class: "lead", text: model.heading }));
  const tabs = h("div", {
    class: "ladder-tabs",
    role: "tablist",
    "aria-label": "Ladders",
    onkeydown: (event) => {
      const selected = model.tabs.find((tab) => tab.selected);
      const next = tabMove(model.tabs.map((tab) => tab.id), selected?.id, event.key);
      if (!next) return;
      event.preventDefault();
      actions.onTab(next);
    },
  });
  for (const tab of model.tabs) {
    tabs.append(h("button", {
      class: "btn ladder-tab",
      type: "button",
      role: "tab",
      id: tab.tabId,
      "aria-controls": tab.controls,
      "aria-selected": tab.selected ? "true" : "false",
      tabindex: tab.selected ? "0" : "-1",
      text: tab.label,
      onclick: () => actions.onTab(tab.id),
    }));
  }
  parent.append(tabs);

  const panel = h("div", {
    class: "ladder-panel",
    role: "tabpanel",
    id: model.panelId,
    "aria-labelledby": model.labelledBy,
    "aria-busy": model.busy ? "true" : "false",
  });

  if (model.showDay) {
    panel.append(h("div", { class: "ladder-days" }, [
      h("button", {
        class: "btn",
        type: "button",
        id: "ladder-day-prev",
        text: "Previous day",
        disabled: model.dayPrevDisabled,
        onclick: () => actions.onDay(-1),
      }),
      h("p", { class: "ladder-day", text: model.dayLabel }),
      h("button", {
        class: "btn",
        type: "button",
        id: "ladder-day-next",
        text: "Next day",
        disabled: model.dayNextDisabled,
        onclick: () => actions.onDay(1),
      }),
    ]));
    panel.append(h("div", { class: "ladder-filters", role: "group", "aria-label": "Daily ladder" },
      model.dailyLadders.map((item) => h("button", {
        class: "btn",
        type: "button",
        "aria-pressed": item.pressed ? "true" : "false",
        text: item.label,
        onclick: () => actions.onDailyLadder(item.id),
      }))));
  }

  if (model.youText) panel.append(h("p", { class: "ladder-you", text: model.youText }));
  if (model.jump) {
    panel.append(h("button", {
      class: "btn",
      type: "button",
      text: "Jump to my rank",
      onclick: () => actions.onJump(),
    }));
  }

  if (model.status === "error") {
    panel.append(h("h2", {
      id: "ladder-caption",
      class: "ladder-sub",
      tabindex: "-1",
      text: "The ladder did not load",
    }));
    panel.append(h("p", { text: model.error }));
    const actionsRow = h("div", { class: "actions" });
    actionsRow.append(h("button", {
      class: "btn primary",
      type: "button",
      text: "Retry",
      onclick: () => actions.onRetry(),
    }));
    if (model.showToday) {
      actionsRow.append(h("button", {
        class: "btn",
        type: "button",
        text: "Show today",
        onclick: () => actions.onToday(),
      }));
    }
    panel.append(actionsRow);
    parent.append(panel);
    return;
  }

  panel.append(buildTable(h, {
    caption: model.caption,
    captionId: "ladder-caption",
    columns: model.columns,
    rows: model.rows,
    prefix: "ladder-row",
    busy: model.busy,
    emptyText: model.emptyText,
  }));

  if (model.status === "empty") {
    panel.append(h("div", { class: "actions" }, [
      h("button", {
        class: "btn primary",
        type: "button",
        text: "Play a race",
        onclick: () => actions.onPlay(),
      }),
    ]));
  }

  if (model.showPager) {
    panel.append(h("div", { class: "ladder-pager" }, [
      h("button", {
        class: "btn",
        type: "button",
        text: "Previous",
        disabled: !model.hasPrev,
        onclick: () => actions.onPage(-1),
      }),
      h("p", { class: "ladder-page-label", text: model.pageLabel }),
      h("button", {
        class: "btn",
        type: "button",
        text: "Next",
        disabled: !model.hasNext,
        onclick: () => actions.onPage(1),
      }),
    ]));
  }

  if (model.showAround) {
    panel.append(h("h2", { class: "ladder-sub", text: "Around your rank" }));
    panel.append(buildTable(h, {
      caption: "Players near your rank",
      columns: model.columns,
      rows: model.around,
      prefix: "ladder-around",
      busy: false,
      emptyText: "",
    }));
  }

  parent.append(panel);
}
