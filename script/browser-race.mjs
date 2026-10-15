// Drives the local site in headless Chromium: login, desktop practice, cursor clicks, mobile typing.
const base = process.env.BASE_URL || "http://127.0.0.1:8787";
const cdpHttp = process.env.CDP_HTTP || "http://127.0.0.1:9222";

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.next = 1;
    this.pending = new Map();
    this.logs = [];
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const waiter = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) waiter.reject(new Error(`${msg.error.message || "cdp"} ${JSON.stringify(msg.error)}`));
        else waiter.resolve(msg.result || {});
        return;
      }
      const method = msg.method || "";
      if (method === "Runtime.exceptionThrown") {
        this.logs.push(`exception ${msg.params?.exceptionDetails?.text || ""} ${msg.params?.exceptionDetails?.exception?.description || ""}`);
      } else if (method === "Runtime.consoleAPICalled" && msg.params?.type === "error") {
        const text = (msg.params.args || []).map((arg) => arg.value || arg.description || "").join(" ");
        this.logs.push(`console ${text}`);
      }
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
      }, 10000);
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
    throw new Error(result.exceptionDetails.text || result.exceptionDetails.exception?.description || "evaluate failed");
  }
  return result.result?.value;
}

async function waitFor(cdp, session, expression, label, ms = 12000) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < ms) {
    last = await evaluate(cdp, session, expression);
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`timeout ${label}: ${JSON.stringify(last)}`);
}

async function click(cdp, session, selector) {
  const box = await evaluate(cdp, session, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: "center", inline: "center" });
    const rect = el.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, w: rect.width, h: rect.height };
  })()`);
  assert(box && box.w > 0 && box.h > 0, `missing ${selector}`);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y }, session);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 }, session);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 }, session);
}

async function typeChar(cdp, session, ch) {
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch, unmodifiedText: ch }, session);
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch }, session);
}

async function setViewport(cdp, session, width, height, mobile) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile,
  }, session);
}

async function practiceAndWait(cdp, session) {
  await click(cdp, session, '[data-action="practice"]');
  await waitFor(cdp, session, `document.querySelector("#passage") ? "passage" : ""`, "passage");
  const started = await waitFor(
    cdp,
    session,
    `(() => {
      const stats = document.querySelector("#stats")?.textContent || "";
      return stats.includes("wpm") && !stats.includes("ready") ? stats : "";
    })()`,
    "race start",
    15000,
  );
  return started;
}

async function sentenceOf(cdp, session) {
  const text = await evaluate(cdp, session, `document.querySelector("#passage")?.textContent || ""`);
  assert(text.length > 0, "empty passage");
  return text;
}

async function finishOrder(cdp, session) {
  await waitFor(cdp, session, `document.querySelector(".results") ? "results" : ""`, "results", 15000);
  const table = await evaluate(cdp, session, `document.querySelector(".results")?.innerText || ""`);
  assert(!table.includes("\u2014") && !table.includes("\u2013"), "results contain a dash glyph");
  assert(table.includes("unrated"), `expected unrated practice, got ${table}`);
  assert(table.includes("Finish order"), table);
  return table;
}

async function overflow(cdp, session) {
  return evaluate(cdp, session, `({
    w: document.documentElement.clientWidth,
    sw: document.documentElement.scrollWidth,
    lead: document.querySelector(".lead")?.textContent || "",
  })`);
}

const version = await fetch(`${cdpHttp}/json/version`).then((response) => response.json());
const ws = await connect(version.webSocketDebuggerUrl);
const cdp = new Cdp(ws);
const created = await cdp.send("Target.createTarget", { url: "about:blank" });
const attached = await cdp.send("Target.attachToTarget", { targetId: created.targetId, flatten: true });
const session = attached.sessionId;
await cdp.send("Page.enable", {}, session);
await cdp.send("Runtime.enable", {}, session);
await cdp.send("Console.enable", {}, session);
await setViewport(cdp, session, 1280, 800, false);
await cdp.send("Page.navigate", { url: base }, session);
await waitFor(cdp, session, `document.querySelector("#dev-name") ? "login" : ""`, "login form");

await click(cdp, session, "#dev-name");
for (const ch of "Cam") await typeChar(cdp, session, ch);
await click(cdp, session, "form.dev button");
await waitFor(cdp, session, `document.querySelector('[data-action="practice"]') ? "lobby" : ""`, "lobby");
const desktopLobby = await overflow(cdp, session);
assert(desktopLobby.sw <= desktopLobby.w + 1, `desktop lobby overflow ${desktopLobby.sw} > ${desktopLobby.w}`);

await practiceAndWait(cdp, session);
const desktopSentence = await sentenceOf(cdp, session);
for (const ch of desktopSentence) await typeChar(cdp, session, ch);
const desktopResults = await finishOrder(cdp, session);
assert(desktopResults.includes("Cam"), "desktop results missing racer");

await click(cdp, session, ".result-actions .btn.ghost");
await waitFor(cdp, session, `document.querySelector('[data-mode="cursor"]') ? "modes" : ""`, "back to lobby");
await click(cdp, session, '[data-mode="cursor"]');
await practiceAndWait(cdp, session);
const cursorSentence = await sentenceOf(cdp, session);
const keyboard = await evaluate(cdp, session, `document.querySelectorAll("#keyboard .key").length`);
assert(keyboard > 20, "cursor keyboard missing");
await evaluate(cdp, session, `(() => {
  const key = document.querySelector('#keyboard .key');
  key.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "touch", pointerId: 1, isPrimary: true }));
})()`);
const toast = await waitFor(cdp, session, `document.querySelector("#toast")?.textContent?.includes("mouse only") ? "toast" : ""`, "touch toast");
assert(toast === "toast", "touch should be refused on the cursor ladder");
for (const ch of cursorSentence) {
  if (/[A-Z]/.test(ch)) await click(cdp, session, '#keyboard .key[data-key="shift"]');
  const key = ch === " " ? " " : ch.toLowerCase();
  await click(cdp, session, `#keyboard .key[data-key=${JSON.stringify(key)}]`);
}
await finishOrder(cdp, session);

await click(cdp, session, ".result-actions .btn.ghost");
await waitFor(cdp, session, `document.querySelector('[data-mode="mobile"]') ? "modes" : ""`, "lobby again");
await setViewport(cdp, session, 390, 844, true);
await click(cdp, session, '[data-mode="mobile"]');
const mobileLobby = await overflow(cdp, session);
assert(mobileLobby.sw <= mobileLobby.w + 1, `mobile lobby overflow ${mobileLobby.sw} > ${mobileLobby.w}`);
await practiceAndWait(cdp, session);
const mobileSentence = await sentenceOf(cdp, session);
const mobileRace = await overflow(cdp, session);
assert(mobileRace.sw <= mobileRace.w + 1, `mobile race overflow ${mobileRace.sw} > ${mobileRace.w}`);
await evaluate(cdp, session, `document.querySelector("#capture").focus()`);
for (const ch of mobileSentence) {
  const typed = await evaluate(cdp, session, `(() => {
    const capture = document.querySelector("#capture");
    capture.focus();
    const event = new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: ${JSON.stringify(ch)} });
    capture.dispatchEvent(event);
    return document.querySelector("#passage")?.textContent || "";
  })()`);
  assert(!typed.includes("undefined"), "mobile input produced undefined");
}
await finishOrder(cdp, session);

await click(cdp, session, ".account .btn");
await waitFor(cdp, session, `document.querySelector("#dev-name") ? "signed-out" : ""`, "signed out");
await click(cdp, session, "#dev-name");
for (const ch of "Dee") await typeChar(cdp, session, ch);
await click(cdp, session, "form.dev button");
await waitFor(cdp, session, `document.querySelector(".who strong")?.textContent === "Dee" ? "dee" : ""`, "second login");
await setViewport(cdp, session, 1280, 800, false);
await practiceAndWait(cdp, session);
const secondSentence = await sentenceOf(cdp, session);
for (const ch of secondSentence) await typeChar(cdp, session, ch);
const secondResults = await finishOrder(cdp, session);
assert(secondResults.includes("Dee"), "second login still raced as the previous account");
assert(!secondResults.includes("Cam"), "previous account name leaked into the new race");
assert(cdp.logs.length === 0, `browser errors: ${cdp.logs.join(" | ")}`);
ws.close();
console.log("browser race ok", { desktop: desktopSentence, cursor: cursorSentence, mobile: mobileSentence });
