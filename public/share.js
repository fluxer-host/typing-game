// Results-screen share controls. The server signs the link. This file only asks for it.

import { shareableName } from "../src/share-name.js";

export function shareLinks(url, title) {
  const shareUrl = encodeURIComponent(url);
  const shareTitle = encodeURIComponent(title || "Typing race");
  return [
    { label: "Share on X", href: `https://twitter.com/intent/tweet?text=${shareTitle}&url=${shareUrl}` },
    { label: "Share on Reddit", href: `https://www.reddit.com/submit?url=${shareUrl}&title=${shareTitle}` },
    { label: "Share on Facebook", href: `https://www.facebook.com/sharer/sharer.php?u=${shareUrl}` },
  ];
}

export function ensureShareMount(parent, h, view) {
  if (!parent || !view) return;
  if (parent.querySelector(".share-box") || parent.dataset.shareReady === "1") return;
  if (!view.ready) {
    parent.dataset.shareReady = "1";
    return;
  }
  if (!view.enabled) return;
  parent.dataset.shareReady = "1";
  mountShare(parent, h, view);
}

function mountShare(parent, h, view) {
  const box = h("div", { class: "share-box" });
  const canName = shareableName(view.name);
  if (canName) {
    const label = h("label", { class: "share-name" });
    label.append(
      h("input", { type: "checkbox", checked: true }),
      document.createTextNode("Show my name"),
    );
    box.append(label);
  }
  box.append(h("p", { id: "share-privacy", class: "hint", text: "Anyone with this link can see this result." }));
  const canSheet = typeof navigator !== "undefined" && typeof navigator.share === "function";
  const button = h("button", {
    class: "btn primary",
    type: "button",
    "data-action": "share-go",
    "aria-describedby": "share-privacy",
    text: canSheet ? "Share" : "Copy link",
  });
  const actions = h("div", { class: "actions share-actions" });
  actions.append(button);
  const status = h("p", { class: "hint share-status", "aria-live": "polite" });
  box.append(actions, status);
  parent.append(box);
  button.addEventListener("click", () => issueShare(box, h, view, button, status, canSheet));
}

async function issueShare(box, h, view, button, status, canSheet) {
  if (button.disabled) return;
  button.disabled = true;
  status.textContent = "";
  const showName = Boolean(box.querySelector(".share-name input")?.checked);
  const payload = view.kind === "race"
    ? { raceId: view.raceId, showName }
    : {
      kind: "practice",
      ladder: view.ladder,
      format: view.format,
      length: view.length || "",
      wpm: view.wpm,
      accuracy: view.accuracy,
      ms: view.ms,
      showName,
    };
  let data = null;
  try {
    const response = await fetch("/api/share", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    data = await response.json().catch(() => null);
    if (!response.ok || !data?.url) {
      status.textContent = shareError(response.status);
      button.disabled = false;
      return;
    }
  } catch {
    status.textContent = "The link was not created.";
    button.disabled = false;
    return;
  }
  revealLinks(box, h, data, canSheet, status);
  if (canSheet) {
    try {
      await navigator.share({ title: data.title, text: data.text, url: data.url });
    } catch (error) {
      if (!error || error.name !== "AbortError") status.textContent = "The share sheet did not open. Copy the link instead.";
    }
    return;
  }
  await copyShareLink(box, h, data.url, status);
}

function revealLinks(box, h, data, canSheet, status) {
  if (box.querySelector(".share-links")) return;
  const links = h("div", { class: "actions share-links" });
  if (canSheet) {
    const copy = h("button", { class: "btn", type: "button", "data-action": "share-copy", text: "Copy link" });
    copy.addEventListener("click", () => copyShareLink(box, h, data.url, status));
    links.append(copy);
  }
  if (!canSheet) {
    for (const link of shareLinks(data.url, data.title)) {
      links.append(h("a", {
        class: "btn",
        href: link.href,
        target: "_blank",
        rel: "noopener noreferrer",
        text: link.label,
      }));
    }
  }
  links.append(h("a", {
    class: "btn",
    href: data.image,
    download: "typing-race-result.png",
    text: "Download image",
  }));
  box.append(links);
}

async function copyShareLink(box, h, url, status) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url);
      status.textContent = "Link copied";
      return;
    }
  } catch {
    // The field below is the fallback when the clipboard is blocked.
  }
  let field = box.querySelector(".share-url");
  if (!field) {
    field = h("input", { class: "share-url", type: "text", readonly: true, "aria-label": "Share link" });
    box.append(field);
  }
  field.hidden = false;
  field.value = url;
  field.focus();
  field.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  status.textContent = copied ? "Link copied" : "Copy the link from the field.";
}

function shareError(status) {
  if (status === 503) return "Sharing is off until the server has a signing secret.";
  if (status === 404) return "That result is not available to share.";
  if (status === 429) return "Wait a moment, then try again.";
  if (status === 401) return "Sign in to share this race.";
  return "The link was not created.";
}
