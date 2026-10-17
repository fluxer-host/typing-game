// Decides which keydown events a race should take, and which the browser keeps.
// Modifier chords, function keys, and Tab always pass through.

const SCROLL_KEYS = new Set([
  " ",
  "Spacebar",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "PageUp",
  "PageDown",
  "Home",
  "End",
]);

export function isFunctionKey(key) {
  return /^F\d{1,2}$/.test(key || "");
}

function pass() {
  return { prevent: false, effect: "pass" };
}

export function raceKeyPlan(event, context = {}) {
  const key = event?.key || "";
  if (!context.active) return pass();
  if (event?.ctrlKey || event?.metaKey || event?.altKey) return pass();
  if (event?.isComposing) return pass();
  if (key === "Tab" || isFunctionKey(key)) return pass();

  if (context.mode === "cursor") {
    // The on-screen keys type. The physical keyboard only has to stay put.
    if (SCROLL_KEYS.has(key)) return { prevent: true, effect: "scroll" };
    if (key === "Backspace") return { prevent: true, effect: "navigate" };
    return pass();
  }

  if (context.mode === "desktop") {
    if (context.fromCapture || context.fromField) return pass();
    if (key === "Backspace") return { prevent: true, effect: "backspace" };
    if (key.length === 1) return { prevent: true, effect: "type" };
    if (SCROLL_KEYS.has(key)) return { prevent: true, effect: "scroll" };
    return pass();
  }

  if (SCROLL_KEYS.has(key) && !context.fromCapture && !context.fromField) {
    return { prevent: true, effect: "scroll" };
  }
  if (key === "Backspace" && !context.fromCapture && !context.fromField) {
    return { prevent: true, effect: "navigate" };
  }
  return pass();
}
