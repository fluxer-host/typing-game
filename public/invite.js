// Room invite controls. The lobby signs the player in and sends the join.

import { inviteLink, normalizeRoomCode } from "../src/room-code.js";

export function canNativeShare() {
  return typeof navigator !== "undefined" && typeof navigator.share === "function";
}

export async function copyWithFallback(box, h, text, status, success, fieldLabel) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      status.textContent = success;
      return success;
    }
  } catch {
    // The field below is the fallback when the clipboard is blocked.
  }
  let field = box.querySelector(".invite-url");
  if (!field) {
    field = h("input", {
      class: "invite-url",
      type: "text",
      readonly: true,
      "aria-label": fieldLabel,
    });
    box.append(field);
  }
  field.hidden = false;
  field.value = text;
  field.focus();
  field.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  status.textContent = copied ? success : "Copy it from the field.";
  return status.textContent;
}

export function mountRoomShare(parent, h, room, hooks) {
  const code = normalizeRoomCode(room?.code);
  if (!parent || !code) return;
  const box = h("div", { class: "invite-box" });
  const status = h("p", {
    id: "invite-status",
    class: "hint",
  });
  const actions = h("div", { class: "actions invite-actions" });
  const link = inviteLink(hooks?.origin || location.origin, code);
  const report = (phrase) => {
    if (phrase === "Code copied" || phrase === "Link copied") hooks?.announce?.(phrase);
  };
  const copyCode = h("button", {
    class: "btn",
    type: "button",
    "data-action": "copy-code",
    "aria-describedby": "invite-status",
    text: "Copy code",
  });
  copyCode.addEventListener("click", () => {
    copyWithFallback(box, h, code, status, "Code copied", "Room code").then(report);
  });
  const copyLink = h("button", {
    class: "btn",
    type: "button",
    "data-action": "copy-invite",
    "aria-describedby": "invite-status",
    text: "Copy invite link",
  });
  copyLink.addEventListener("click", () => {
    copyWithFallback(box, h, link, status, "Link copied", "Invite link").then(report);
  });
  actions.append(copyCode, copyLink);
  if (canNativeShare()) {
    const share = h("button", {
      class: "btn",
      type: "button",
      "data-action": "share-room",
      "aria-label": "Share invite link",
      text: "Share",
    });
    share.addEventListener("click", async () => {
      try {
        await navigator.share({ title: "Typing race", text: `Join room ${code}`, url: link });
      } catch (error) {
        if (!error || error.name !== "AbortError") {
          status.textContent = "The share sheet did not open. Copy the link instead.";
        }
      }
    });
    actions.append(share);
  }
  box.append(actions, status);
  parent.append(box);
}

const CLOSED_COPY = {
  invalid: "That code does not look like a room code.",
  full: "That room is full.",
  closed: "That room is not open. It may have started, or the host may have left.",
  limit: "Too many tries. Wait a moment, then try the code again.",
  failed: "The room could not be joined.",
};

export function inviteMessage(status) {
  return CLOSED_COPY[status] || CLOSED_COPY.failed;
}

export function renderInvite(h, model) {
  const box = h("div", { class: "invite-screen" });
  const code = normalizeRoomCode(model?.code) || "";
  if (model?.status === "hold") {
    box.append(h("h2", { class: "lead", text: "Checking the room..." }));
    return box;
  }
  if (model?.status === "joining" || model?.status === "canceling") {
    const canceling = model.status === "canceling";
    box.append(h("h2", { class: "lead", text: `Joining room ${code}...` }));
    box.append(h("p", { class: "muted", text: canceling ? "Leaving the room." : "You will land in the room lobby in a moment." }));
    box.append(h("div", { class: "actions" }, [
      h("button", {
        class: "btn",
        type: "button",
        "data-action": "invite-cancel",
        text: "Cancel",
        disabled: canceling,
        onclick: model.onCancel,
      }),
    ]));
    return box;
  }
  if (model?.status === "prompt") {
    box.append(h("h2", { class: "lead", text: "You are invited to a room" }));
    box.append(h("p", { class: "muted", text: "Sign in to take a seat. Anyone with the room code can ask to join while it is open." }));
    if (code) box.append(h("div", { class: "code", id: "invite-code", text: code }));
    const actions = h("div", { class: "actions" });
    if (model.oauth) {
      actions.append(h("a", {
        class: "btn primary",
        href: "/auth/login",
        text: "Sign in with Fluxer to join",
        onclick: (event) => {
          if (model.onSignIn?.() === false) event.preventDefault();
        },
      }));
    }
    box.append(actions);
    if (typeof model.renderDev === "function") model.renderDev(box);
    box.append(h("div", { class: "actions" }, [
      h("button", {
        class: "btn ghost",
        type: "button",
        "data-action": "invite-lobby",
        text: "Back to lobby",
        onclick: model.onLobby,
      }),
    ]));
    return box;
  }
  if (model?.status === "busy") {
    box.append(h("h2", { class: "lead", text: "You are already in a race" }));
    box.append(h("p", { class: "muted", text: `Room ${code} can wait. Leave the race and join, or stay where you are.` }));
    box.append(h("div", { class: "actions" }, [
      h("button", {
        class: "btn primary",
        type: "button",
        "data-action": "invite-leave",
        text: "Leave race and join",
        onclick: model.onLeaveRace,
      }),
      h("button", {
        class: "btn",
        type: "button",
        "data-action": "invite-stay",
        text: "Stay in the race",
        onclick: model.onStay,
      }),
    ]));
    return box;
  }
  const status = CLOSED_COPY[model?.status] ? model.status : "failed";
  box.append(h("h2", { class: "lead", text: "Room unavailable" }));
  box.append(h("p", { class: "muted", text: inviteMessage(status) }));
  if (code && status !== "invalid") box.append(h("div", { class: "code", text: code }));
  box.append(h("div", { class: "actions" }, [
    h("button", {
      class: "btn primary",
      type: "button",
      "data-action": "invite-lobby",
      text: "Back to lobby",
      onclick: model.onLobby,
    }),
  ]));
  return box;
}
