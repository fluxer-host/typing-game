// Browser side of lobby preferences.
// Signed-in saves go to PUT /api/settings. Signed-out saves stay on the guest key.
// fetch keepalive is used on page hide because sendBeacon cannot send a PUT.

import {
  ACCOUNT_SETTINGS_KEY,
  GUEST_SETTINGS_KEY,
  SETTINGS_CHANNEL,
  SETTINGS_FAIL_MESSAGE,
  accountNotice,
  crossTabAction,
  freshSave,
  guestForUpload,
  mergeOnSignIn,
  normalizeSettings,
  openingSettings,
  parseNotice,
  readGuestSettings,
  readLegacySettings,
  reduceSave,
  remoteIsNewer,
  settingsJson,
} from "../src/settings.js";

export function browserStorage() {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

function readJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function createSettingsSync(options) {
  const storage = options.storage;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const now = options.now || (() => Date.now());
  let save = freshSave();
  let timer = null;
  let generation = 0;
  let changedAt = 0;
  let deferred = null;
  let reloading = false;
  let lastRemoteKey = "";
  let channel = null;

  try {
    if (typeof BroadcastChannel === "function") channel = new BroadcastChannel(SETTINGS_CHANNEL);
  } catch {
    channel = null;
  }

  const legacy = readLegacySettings(storage);
  if (!readGuestSettings(storage) && legacy && storage && typeof storage.setItem === "function") {
    try {
      storage.setItem(GUEST_SETTINGS_KEY, settingsJson(legacy));
    } catch {
      // The legacy keys are still readable for this visit.
    }
  }

  function signedIn() {
    return Boolean(options.signedIn());
  }

  function accountId() {
    return String(options.accountId() || "");
  }

  function locked() {
    return Boolean(options.locked());
  }

  function clearTimer() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function schedule() {
    clearTimer();
    if (!signedIn() || save.sendingRev) return;
    const at = save.dueAt || save.retryAt;
    if (!at) return;
    const delay = Math.max(0, at - now());
    timer = setTimeout(tick, delay);
  }

  function tick() {
    timer = null;
    const result = reduceSave(save, { type: "tick", now: now() });
    save = result.state;
    if (result.clearNotice) options.clearNotice();
    if (result.announce) options.announce(result.announce);
    if (result.send) void deliver(result.send, false);
    else schedule();
  }

  async function deliver(payload, keepalive) {
    const gen = generation;
    let response;
    try {
      response = await fetchImpl("/api/settings", {
        method: "PUT",
        credentials: "same-origin",
        keepalive,
        headers: { "content-type": "application/json" },
        body: settingsJson(payload.settings),
      });
    } catch {
      response = null;
    }
    if (gen !== generation) return;
    if (response && response.ok) {
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      if (gen !== generation) return;
      const result = reduceSave(save, { type: "ack", rev: payload.rev, now: now() });
      save = result.state;
      if (result.clearNotice) options.clearNotice();
      if (body && save.ackedRev === payload.rev && save.rev === payload.rev) {
        options.apply(normalizeSettings(body));
      }
      if (result.send) void deliver(result.send, false);
      else schedule();
      return;
    }
    const status = response ? response.status : 0;
    if (status === 400 || status === 401 || status === 403 || status === 413) {
      save = freshSave();
      clearTimer();
      if (status === 400 || status === 413) options.announce(SETTINGS_FAIL_MESSAGE);
      return;
    }
    const result = reduceSave(save, { type: "fail", rev: payload.rev, now: now() });
    save = result.state;
    if (result.announce) options.announce(result.announce);
    schedule();
  }

  function publish(settings, at) {
    const id = accountId();
    if (!id) return;
    const notice = accountNotice(id, settings, at);
    try {
      if (storage && typeof storage.setItem === "function") {
        storage.setItem(ACCOUNT_SETTINGS_KEY, JSON.stringify(notice));
      }
    } catch {
      // Another tab still hears the channel when it is available.
    }
    try {
      channel?.postMessage(notice);
    } catch {
      // The storage write is the fallback.
    }
  }

  function queue(settings) {
    const clean = normalizeSettings(settings);
    if (!signedIn()) {
      changedAt = now();
      try {
        if (storage && typeof storage.setItem === "function") {
          storage.setItem(GUEST_SETTINGS_KEY, settingsJson(clean));
        }
      } catch {
        // The choice still applies for this visit.
      }
      try {
        channel?.postMessage({ type: "guest", settings: clean, at: changedAt });
      } catch {
        // The guest key write notifies other tabs through the storage event.
      }
      return;
    }
    changedAt = now();
    const result = reduceSave(save, { type: "change", settings: clean, now: changedAt });
    save = result.state;
    if (result.clearNotice) options.clearNotice();
    publish(clean, changedAt);
    schedule();
  }

  function requestReload() {
    if (reloading) return;
    reloading = true;
    options.reload();
  }

  function onRemote(event) {
    const key = JSON.stringify(event);
    if (key === lastRemoteKey) return;
    if (event.at && !remoteIsNewer(changedAt, event.at)) return;
    const action = crossTabAction({
      racing: locked(),
      signedIn: signedIn(),
      accountId: accountId(),
      event,
    });
    if (action === "ignore") return;
    lastRemoteKey = key;
    if (action === "reload") {
      requestReload();
      return;
    }
    if (action === "reload-later") {
      deferred = "reload";
      return;
    }
    if (action === "defer") {
      if (deferred !== "reload") deferred = event.settings;
      return;
    }
    deferred = null;
    save = freshSave();
    clearTimer();
    changedAt = Number(event.at) || now();
    options.apply(event.settings);
    options.repaint();
  }

  function onStorage(event) {
    if (!event) return;
    if (event.key === GUEST_SETTINGS_KEY && event.newValue) {
      const parsed = readJson(event.newValue);
      if (!parsed) return;
      onRemote({ type: "guest", settings: normalizeSettings(parsed), at: now() });
      return;
    }
    if (event.key !== ACCOUNT_SETTINGS_KEY) return;
    if (!event.newValue) {
      const previous = readJson(event.oldValue || "");
      onRemote({ type: "signed-out", accountId: String(previous?.accountId || "") });
      return;
    }
    const notice = parseNotice(readJson(event.newValue));
    if (notice) onRemote(notice);
  }

  function onChannel(event) {
    const notice = parseNotice(event?.data);
    if (notice) onRemote(notice);
  }

  if (channel) channel.onmessage = onChannel;
  const target = options.target || (typeof window === "undefined" ? null : window);
  if (target && typeof target.addEventListener === "function") {
    target.addEventListener("pagehide", () => {
      void flush();
    });
    target.addEventListener("storage", onStorage);
  }

  async function flush() {
    if (!signedIn()) return;
    clearTimer();
    const result = reduceSave(save, { type: "flush", now: now() });
    save = result.state;
    if (!result.send) return;
    await deliver(result.send, true);
  }

  function settle() {
    if (locked()) return "wait";
    if (deferred === "reload") {
      deferred = null;
      requestReload();
      return "reload";
    }
    if (deferred) {
      const settings = deferred;
      deferred = null;
      save = freshSave();
      clearTimer();
      options.apply(settings);
      return "applied";
    }
    return "idle";
  }

  function onSignedIn(me) {
    generation += 1;
    clearTimer();
    save = freshSave();
    deferred = null;
    const decision = mergeOnSignIn({
      serverSaved: me.saved === true,
      serverSettings: me.settings,
      guest: guestForUpload(storage),
    });
    if (decision.upload) queue(decision.settings);
    else publish(decision.settings, now());
    return decision.settings;
  }

  function onSignedOut(previousAccountId) {
    generation += 1;
    clearTimer();
    save = freshSave();
    deferred = null;
    changedAt = 0;
    const notice = { type: "signed-out", accountId: String(previousAccountId || ""), at: now() };
    try {
      if (storage && typeof storage.removeItem === "function") storage.removeItem(ACCOUNT_SETTINGS_KEY);
    } catch {
      // The channel message still tells other tabs.
    }
    try {
      channel?.postMessage(notice);
    } catch {
      // The key removal is the fallback.
    }
  }

  return { queue, flush, settle, onSignedIn, onSignedOut };
}
