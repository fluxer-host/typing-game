import assert from "node:assert/strict";
import test from "node:test";
import { isFunctionKey, raceKeyPlan } from "../public/keys.js";

function plan(event, context) {
  return raceKeyPlan(event, context);
}

const cursorRace = { mode: "cursor", active: true };
const desktopRace = { mode: "desktop", active: true };

test("modifier chords, function keys, and Tab reach the browser", () => {
  const chords = [
    { key: "f", ctrlKey: true },
    { key: "f", metaKey: true },
    { key: "f", altKey: true },
    { key: "f", ctrlKey: true, shiftKey: true },
    { key: "=", ctrlKey: true },
    { key: "-", ctrlKey: true },
    { key: "0", ctrlKey: true },
    { key: "+", ctrlKey: true, shiftKey: true },
    { key: "r", ctrlKey: true },
    { key: "l", metaKey: true },
    { key: "t", ctrlKey: true },
    { key: "w", ctrlKey: true },
    { key: "Tab", shiftKey: true },
    { key: "Tab" },
    { key: "F1" },
    { key: "F5" },
    { key: "F12" },
  ];
  for (const event of chords) {
    assert.deepEqual(plan(event, cursorRace), { prevent: false, effect: "pass" }, JSON.stringify(event));
    assert.deepEqual(plan(event, desktopRace), { prevent: false, effect: "pass" }, JSON.stringify(event));
  }
  assert.equal(isFunctionKey("F5"), true);
  assert.equal(isFunctionKey("f"), false);
  assert.equal(isFunctionKey("F"), false);
});

test("a cursor race keeps scroll and history keys, and lets letters through", () => {
  assert.deepEqual(plan({ key: " " }, cursorRace), { prevent: true, effect: "scroll" });
  assert.deepEqual(plan({ key: "ArrowDown" }, cursorRace), { prevent: true, effect: "scroll" });
  assert.deepEqual(plan({ key: "PageDown" }, cursorRace), { prevent: true, effect: "scroll" });
  assert.deepEqual(plan({ key: "Home" }, cursorRace), { prevent: true, effect: "scroll" });
  assert.deepEqual(plan({ key: "Backspace" }, cursorRace), { prevent: true, effect: "navigate" });
  assert.deepEqual(plan({ key: "a" }, cursorRace), { prevent: false, effect: "pass" });
  assert.deepEqual(plan({ key: "A", shiftKey: true }, cursorRace), { prevent: false, effect: "pass" });
  assert.deepEqual(plan({ key: " " }, { mode: "cursor", active: false }), { prevent: false, effect: "pass" });
  assert.deepEqual(plan({ key: "Backspace", ctrlKey: true }, cursorRace), { prevent: false, effect: "pass" });
});

test("a desktop race still types letters and backspace, and ignores fields", () => {
  assert.deepEqual(plan({ key: "a" }, desktopRace), { prevent: true, effect: "type" });
  assert.deepEqual(plan({ key: " " }, desktopRace), { prevent: true, effect: "type" });
  assert.deepEqual(plan({ key: "A", shiftKey: true }, desktopRace), { prevent: true, effect: "type" });
  assert.deepEqual(plan({ key: "Backspace" }, desktopRace), { prevent: true, effect: "backspace" });
  assert.deepEqual(plan({ key: "ArrowDown" }, desktopRace), { prevent: true, effect: "scroll" });
  assert.deepEqual(plan({ key: "a" }, { ...desktopRace, fromCapture: true }), { prevent: false, effect: "pass" });
  assert.deepEqual(plan({ key: "a" }, { ...desktopRace, fromField: true }), { prevent: false, effect: "pass" });
  assert.deepEqual(plan({ key: "a", isComposing: true }, desktopRace), { prevent: false, effect: "pass" });
  assert.deepEqual(plan({ key: " " }, { mode: "mobile", active: true }), { prevent: true, effect: "scroll" });
  assert.deepEqual(plan({ key: " " }, { mode: "mobile", active: true, fromCapture: true }), { prevent: false, effect: "pass" });
});
