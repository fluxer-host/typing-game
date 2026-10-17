// Fails when the signed-in lobby or a cursor race scrolls sideways.
// Usage: BASE_URL=http://127.0.0.1:8787 node script/overflow.mjs
const base = process.env.BASE_URL || "http://127.0.0.1:8787";
const port = process.env.CDP_PORT || "9223";
const widths = [320, 375, 414];

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.next = 1;
    this.pending = new Map();
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (!msg.id || !this.pending.has(msg.id)) return;
      const waiter = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(msg.error.message || "cdp"));
      else waiter.resolve(msg.result || {});
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.next++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`cdp timeout ${method}`));
      }, 15000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error("cdp open timeout")), 8000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("cdp socket error"));
    });
  });
}

async function evaluate(cdp, session, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  }, session);
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "evaluate failed");
  }
  return result.result?.value;
}

async function waitFor(cdp, session, expression, label) {
  const start = Date.now();
  while (Date.now() - start < 12000) {
    if (await evaluate(cdp, session, expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`timeout ${label}`);
}

async function click(cdp, session, selector) {
  const box = await evaluate(cdp, session, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: "center", inline: "nearest" });
    const rect = el.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, w: rect.width, h: rect.height };
  })()`);
  if (!box || box.w < 1) throw new Error(`missing ${selector}`);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y }, session);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 }, session);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 }, session);
}

async function typeChar(cdp, session, ch) {
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch, unmodifiedText: ch }, session);
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch }, session);
}

async function setViewport(cdp, session, width) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width,
    height: 812,
    deviceScaleFactor: 1,
    mobile: width < 800,
  }, session);
}

const probe = `(() => {
  const doc = document.documentElement;
  const buttons = [...document.querySelectorAll("[data-action], .mode, .length, .account .btn, #leave-race, .join .btn")].map((el) => {
    const rect = el.getBoundingClientRect();
    return { label: (el.textContent || "").trim().slice(0, 24), h: rect.height };
  });
  const keys = [...document.querySelectorAll("#keyboard .key")].map((el) => el.getBoundingClientRect().width);
  return {
    clientWidth: doc.clientWidth,
    scrollWidth: doc.scrollWidth,
    buttons,
    keyMin: keys.length ? Math.min(...keys) : null,
  };
})()`;

const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((response) => response.json());
const ws = await connect(version.webSocketDebuggerUrl);
const cdp = new Cdp(ws);
const created = await cdp.send("Target.createTarget", { url: "about:blank" });
const attached = await cdp.send("Target.attachToTarget", { targetId: created.targetId, flatten: true });
const session = attached.sessionId;
await cdp.send("Page.enable", {}, session);
await cdp.send("Runtime.enable", {}, session);
await cdp.send("Network.setCacheDisabled", { cacheDisabled: true }, session).catch(() => {});
await setViewport(cdp, session, 375);
await cdp.send("Page.navigate", { url: base }, session);
await waitFor(cdp, session, `document.querySelector("#dev-name, .account .btn") ? "ready" : ""`, "shell");
if (await evaluate(cdp, session, `document.querySelector(".account .btn") ? "in" : ""`)) {
  await click(cdp, session, ".account .btn");
  await waitFor(cdp, session, `document.querySelector("#dev-name") ? "login" : ""`, "signed out");
}
await click(cdp, session, "#dev-name");
for (const ch of "Alexandria Wolfe") await typeChar(cdp, session, ch);
await click(cdp, session, "form.dev button");
await waitFor(cdp, session, `document.querySelector('[data-action="queue"]') ? "lobby" : ""`, "lobby");
await new Promise((resolve) => setTimeout(resolve, 250));

for (const width of widths) {
  await setViewport(cdp, session, width);
  await new Promise((resolve) => setTimeout(resolve, 120));
  const row = await evaluate(cdp, session, probe);
  const overflow = row.scrollWidth - row.clientWidth;
  console.log(`lobby ${width} scroll ${row.scrollWidth} client ${row.clientWidth}`);
  if (overflow > 0) fail(`lobby overflows at ${width}px by ${overflow}px`);
  for (const button of row.buttons) {
    if (button.h + 0.5 < 44) fail(`${button.label} is ${button.h}px tall at ${width}px`);
  }
}

await setViewport(cdp, session, 1280);
await new Promise((resolve) => setTimeout(resolve, 120));
const desktop = await evaluate(cdp, session, probe);
if (desktop.scrollWidth > desktop.clientWidth) fail(`desktop lobby overflows by ${desktop.scrollWidth - desktop.clientWidth}px`);
for (const button of desktop.buttons) {
  if (button.h + 0.5 < 44) fail(`desktop ${button.label} is ${button.h}px tall`);
}

await setViewport(cdp, session, 375);
await click(cdp, session, '[data-mode="cursor"]');
await click(cdp, session, '[data-action="practice"]');
await waitFor(cdp, session, `document.querySelector("#keyboard .key") ? "keys" : ""`, "keyboard");
await new Promise((resolve) => setTimeout(resolve, 200));
for (const width of widths) {
  await setViewport(cdp, session, width);
  await new Promise((resolve) => setTimeout(resolve, 120));
  await evaluate(cdp, session, `window.scrollTo(0, 0)`);
  const row = await evaluate(cdp, session, probe);
  console.log(`race ${width} scroll ${row.scrollWidth} client ${row.clientWidth} keyMin ${row.keyMin}`);
  if (row.scrollWidth > row.clientWidth) fail(`cursor race overflows at ${width}px by ${row.scrollWidth - row.clientWidth}px`);
  if (row.keyMin == null || row.keyMin + 0.5 < 32) fail(`cursor key is ${row.keyMin}px wide at ${width}px`);
  const leave = row.buttons.find((button) => button.label.startsWith("Leave"));
  if (!leave || leave.h + 0.5 < 44) fail(`Leave is ${leave?.h}px at ${width}px`);
}

ws.close();
if (process.exitCode) process.exit(process.exitCode);
console.log("overflow ok");
