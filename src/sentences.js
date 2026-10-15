// Original prompts built from public Fluxer lore: the name, the flux capacitor,
// Plutonium, Visionary badges, and self-hosting. Cursor races use the short set
// so an on-screen mouse keyboard stays finishable.
// Keep CURSOR_KEYS in sync with the rows in public/app.js.

export const CURSOR_KEYS = "1234567890-qwertyuiopasdfghjkl'zxcvbnm,.? ";

export const CHARSET = /^[A-Za-z0-9 .,?'-]+$/;

export const SENTENCES = [
  { text: "I love Fluxer", cursor: true },
  { text: "The flux capacitor is fluxing.", cursor: true },
  { text: "Flux means change.", cursor: true },
  { text: "Custom CSS is a love language.", cursor: true },
  { text: "Your instance, your rules, your memes.", cursor: true },
  { text: "A snowflake is a very precise hello.", cursor: true },
  { text: "Hit 88 miles per hour.", cursor: true },
  { text: "Self-host it, read it, share it.", cursor: true },
  { text: "Friends, groups, and communities.", cursor: true },
  { text: "Say it with the room. I love Fluxer.", cursor: true },
  { text: "Chat is motion.", cursor: true },
  { text: "First to the period wins.", cursor: true },
  { text: "Visionaries still wear a badge.", cursor: true },
  { text: "One line for the whole room.", cursor: true },
  { text: "Roads? We bring our own server.", cursor: true },
  { text: "No ads, just a blinking caret.", cursor: true },
  { text: "Plutonium is movie fuel.", cursor: true },
  { text: "Great Scott, we are racing.", cursor: true },
  { text: "1.21 gigawatts of chat.", cursor: true },
  { text: "Where we are going, we type.", cursor: true },
  { text: "Great Scott, the gateway just reconnected.", cursor: false },
  { text: "Hit 88 miles per hour and send the message.", cursor: false },
  { text: "1.21 gigawatts, and the chat still feels instant.", cursor: false },
  { text: "Plutonium is a subscription named after movie fuel.", cursor: false },
  { text: "Fluxer started as a high school project.", cursor: false },
  { text: "We answer to users, not investors.", cursor: false },
  { text: "Back to the timeline where chat stayed for friends.", cursor: false },
  { text: "Self-host it, read it, change it, share it.", cursor: false },
  { text: "Visionaries still wear their numbered badge.", cursor: false },
  { text: "Flux means change, and the room never sits still.", cursor: false },
  { text: "The logo is a wave because chat will not hold still.", cursor: false },
  { text: "No ads in the gutter and no training on your DMs.", cursor: false },
  { text: "Type it like you mean it. I love Fluxer.", cursor: false },
  { text: "One sentence for the whole room. First to finish wins.", cursor: false },
  { text: "Hampus built the app he wished already existed.", cursor: false },
  { text: "The DeLorean of chat apps skips the investor meeting.", cursor: false },
  { text: "Open source under the AGPL, with a caret at column one.", cursor: false },
  { text: "Guilds, DMs, voice, and a race to the last period.", cursor: false },
  { text: "If the capacitor is fluxing, everyone gets the same line.", cursor: false },
  { text: "A discriminator is four digits beside your name.", cursor: false },
  { text: "Fluxer blue looks like 4641D9 from across the room.", cursor: false },
  { text: "Where we are going, we do not need a paywall.", cursor: false },
  { text: "Half a million people, one open living room.", cursor: false },
  { text: "Roads? Where we are going, we bring our own server.", cursor: false },
  { text: "Chat is motion. The sentence is the finish line.", cursor: false },
];

export function poolFor(mode) {
  if (mode === "cursor") return SENTENCES.filter((row) => row.cursor);
  return SENTENCES;
}

export function pickSentence(mode) {
  const pool = poolFor(mode);
  const index = Math.floor(Math.random() * pool.length);
  return pool[index].text;
}

export function pickPassage(mode, count) {
  const pool = poolFor(mode).map((row) => row.text);
  const bag = [...pool];
  const chosen = [];
  const total = Math.max(1, count);
  for (let i = 0; i < total; i++) {
    if (!bag.length) bag.push(...pool);
    const index = Math.floor(Math.random() * bag.length);
    chosen.push(bag.splice(index, 1)[0]);
  }
  return chosen.join(" ");
}

export function passageOk(mode, count, sentence) {
  if (!Number.isInteger(count) || count < 1 || typeof sentence !== "string" || !sentence) return false;
  const pool = poolFor(mode).map((row) => row.text);
  let rest = sentence;
  let seen = 0;
  while (rest.length) {
    const match = pool
      .filter((text) => rest === text || rest.startsWith(`${text} `))
      .sort((a, b) => b.length - a.length)[0];
    if (!match) return false;
    rest = rest.slice(match.length);
    if (rest.startsWith(" ")) rest = rest.slice(1);
    seen += 1;
    if (seen > count) return false;
  }
  return seen === count;
}

export function isKnownSentence(text) {
  return SENTENCES.some((row) => row.text === text);
}

export function cursorCanType(text) {
  for (const ch of text) {
    if (ch >= "A" && ch <= "Z") {
      if (!CURSOR_KEYS.includes(ch.toLowerCase())) return false;
    } else if (!CURSOR_KEYS.includes(ch)) {
      return false;
    }
  }
  return true;
}
