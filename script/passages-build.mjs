// Builds public/passages.js. Ids stay stable for an unchanged run of this file.
// Passages are original prose. Edit the banks here, then run:
//   node script/passages-build.mjs

import { writeFileSync } from "node:fs";

const DESKTOP_RE = /^[A-Za-z0-9 .,?'"!():;-]+$/;
const CURSOR_CHARS = "1234567890-qwertyuiopasdfghjkl'zxcvbnm,.? ";

const BOUNDS = {
  sprint: { easy: [48, 68], medium: [69, 84], hard: [85, 96] },
  set: { easy: [140, 170], medium: [171, 205], hard: [206, 240] },
  long: { easy: [260, 320], medium: [321, 390], hard: [391, 460] },
};

const NEED = { desktop: 36, cursor: 18 };
const LENGTH_CODE = { sprint: "sp", set: "se", long: "lg" };
const DIFF_CODE = { easy: "e", medium: "m", hard: "h" };

const SCENES = [
  {
    who: ["Mina", "Owen", "Priya", "Leah", "Sam", "The baker", "The night cook", "Ned", "Rosa", "Hana", "Jules", "The pastry cook", "Evan", "Noor"],
    act: ["set the kettle on the stove", "wiped the flour from the counter", "sliced the brown bread", "stirred the soup", "checked the oven", "buttered the warm rolls", "washed the cups", "moved the jam to the shelf", "opened the window a little", "wrote the date in the log", "stacked the clean plates", "tasted the soup", "filled the jar with oats", "lit the lamp by the door"],
    where: ["in the warm kitchen", "by the back window", "at the wooden table", "near the pantry", "beside the stove"],
    when: ["before the street woke", "while the bread cooled", "after the rain stopped", "as the clock struck six", "before the first customer"],
  },
  {
    who: ["Ada", "Cal", "Wren", "The gardener", "Imani", "Theo", "Priya", "Ned", "Rosa", "Sam", "Leah", "The park keeper", "Owen", "Hana"],
    act: ["watered the herb bed", "pulled the weeds", "tied the tomato stems", "raked the gravel path", "filled the watering can", "checked the pea rows", "trimmed the hedge", "turned the compost", "picked the ripe beans", "swept the potting bench", "moved the pots into the sun", "read the rain gauge", "shut the tool shed", "shook the dirt from the boots"],
    where: ["in the back garden", "by the garden wall", "along the pea row", "near the shed", "under the apple tree"],
    when: ["after the rain", "before the frost", "while the sun was low", "at the end of the day", "before supper"],
  },
  {
    who: ["Jules", "The station clerk", "Noor", "Evan", "Mina", "Theo", "Ada", "The bus driver", "Sam", "Leah", "Owen", "Hana", "Cal", "Rosa"],
    act: ["checked the departure board", "held the paper ticket", "waited on the platform", "counted the empty seats", "wiped the bench", "read the platform sign", "zipped the coat", "watched the signal light", "asked for the next train", "kept the bag on the seat", "stepped back from the edge", "noted the delay", "found the right car", "saved a seat by the window"],
    where: ["on the north platform", "in the station hall", "by the ticket desk", "under the clock", "near the bus bay"],
    when: ["before the train arrived", "after the announcement", "while the crowd thinned", "as the doors opened", "before the evening rush"],
  },
  {
    who: ["The librarian", "Imani", "Ada", "Noor", "Jules", "Priya", "Evan", "Hana", "Wren", "Theo", "Leah", "Sam", "Mina", "Cal"],
    act: ["shelved the returned books", "stamped the due date", "wiped the reading table", "turned the page", "pushed the cart down the aisle", "sorted the new magazines", "dimmed the desk lamp", "wrote the call number", "found the missing novel", "straightened the chairs", "opened the window a crack", "checked the hold list", "closed the card catalog", "saved a quiet seat"],
    where: ["in the small library", "by the tall window", "at the front desk", "in the history aisle", "near the reading room"],
    when: ["before the doors opened", "during the quiet hour", "after the class visit", "while the rain tapped", "as the lamps came on"],
  },
  {
    who: ["The market clerk", "Rosa", "Ned", "Sam", "Leah", "Owen", "Priya", "Hana", "Theo", "Mina", "Jules", "Ada", "Noor", "Evan"],
    act: ["weighed the apples", "stacked the crates", "counted the coins", "bagged the oranges", "wiped the scale", "wrote the price on the card", "moved the flowers into the shade", "checked the egg cartons", "folded the paper bags", "swept the aisle", "set out the bread", "tasted a sample grape", "tied the bunches of herbs", "closed the cash box"],
    where: ["under the market awning", "at the corner stall", "by the fruit stand", "near the bakery table", "along the main aisle"],
    when: ["before the crowd arrived", "after the morning rush", "while the band played", "as the shade moved", "before closing time"],
  },
  {
    who: ["Cal", "The map maker", "Evan", "Ned", "Owen", "Theo", "Sam", "Wren", "Jules", "Ada", "Noor", "The radio host", "Mina", "Leah"],
    act: ["sharpened the pencil", "swept the wood shavings", "checked the measuring tape", "oiled the hinge", "sanded the rough edge", "sorted the screws", "wiped the workbench", "held the board steady", "marked the cut line", "coiled the spare cord", "tested the lamp", "put the tools back", "read the small diagram", "closed the toolbox"],
    where: ["in the workshop", "at the workbench", "by the side door", "under the shop lamp", "near the tool wall"],
    when: ["before the job started", "after the glue dried", "while the radio played", "as the light faded", "before supper"],
  },
  {
    who: ["The ferry pilot", "The dock hand", "Rosa", "Theo", "Hana", "Jules", "Owen", "Mina", "Ned", "Sam", "Leah", "Cal", "Noor", "Evan"],
    act: ["tied the boat to the ring", "checked the tide chart", "coiled the wet rope", "wiped the rail", "counted the life vests", "watched the channel marker", "secured the hatch", "read the wind", "moved the crate down the ramp", "rang the small bell", "logged the departure", "cleared the gangway", "pointed out the buoy", "shut the cabin door"],
    where: ["on the ferry deck", "at the dock", "by the harbor wall", "near the ramp", "in the small cabin"],
    when: ["before the tide turned", "after the fog lifted", "while the gulls called", "as the whistle blew", "before the next crossing"],
  },
  {
    who: ["The school cook", "The choir teacher", "Priya", "Imani", "Ada", "Evan", "Hana", "Theo", "Leah", "Sam", "Jules", "Noor", "Mina", "Wren"],
    act: ["wiped the chalkboard", "set out the music sheets", "lined up the chairs", "filled the water jug", "checked the name list", "opened the classroom window", "stacked the lunch trays", "tuned the first note", "wrote the date on the board", "collected the pencils", "swept the hall", "set the clock", "put the books in a row", "waited by the door"],
    where: ["in the classroom", "in the lunch room", "by the school gate", "near the piano", "at the front of the hall"],
    when: ["before the bell", "after the rehearsal", "while the class was out", "as the choir warmed up", "before the parents arrived"],
  },
  {
    who: ["The park keeper", "Wren", "Ada", "Sam", "Leah", "Theo", "Rosa", "Cal", "Hana", "Owen", "Mina", "Jules", "Ned", "Noor"],
    act: ["swept the path", "fed the ducks", "checked the playground gate", "picked up the fallen branch", "sat on the bench", "watched the pond", "tied a loose shoelace", "read the trail sign", "zipped the jacket", "shared the last apple", "waited for the friend", "followed the gravel loop", "noted the dark cloud", "turned back toward home"],
    where: ["in the city park", "by the pond", "along the gravel path", "under the oak", "near the playground"],
    when: ["before the rain", "after the school day", "while the wind dropped", "as the lamps came on", "before sunset"],
  },
  {
    who: ["Mina", "Owen", "Priya", "Ned", "Rosa", "Hana", "Jules", "Theo", "Leah", "Sam", "Ada", "Cal", "Noor", "Evan"],
    act: ["folded the clean towels", "sorted the mail", "shook the rain from the coat", "read the note on the fridge", "filled the kettle", "turned the lamp on", "locked the front door", "set the table", "watered the houseplant", "put the keys in the bowl", "opened the evening paper", "checked the window latch", "laid the blanket on the chair", "wrote a short list"],
    where: ["in the front room", "by the kitchen sink", "at the hall table", "near the window", "on the back step"],
    when: ["after work", "before bed", "while the soup warmed", "as the street grew quiet", "after the news"],
  },
];

const FACTS = [
  "The corner bakery opens while the street is still dark and quiet.",
  "A paper ticket shows the platform, the time, and the town name.",
  "Rain on a tin roof sounds louder than rain on the grass.",
  "The last bus of the night keeps its lights on at the stop.",
  "A wooden spoon leaves a ring of flour on the kitchen table.",
  "The harbor bell rings once when the ferry is about to leave.",
  "Fresh bread cools on a rack by the open kitchen window.",
  "A green pencil mark shows where the board should be cut.",
  "The school bell ends rehearsal and sends the choir into the hall.",
  "Ducks gather by the pond when someone arrives with bread.",
  "A library card is a small paper pass for borrowing books.",
  "The morning train waits under the clock before the doors shut.",
  "Wet rope is heavier, so the dock hand coils it in a loose loop.",
  "Soup tastes better after it rests for a few quiet minutes.",
  "A trail sign points left toward the pond and right toward home.",
  "The cash box stays shut until the next customer counts out coins.",
  "Chalk dust falls when someone wipes the board before class.",
  "A houseplant leans toward the window when the lamp is off.",
  "The gravel path crunches under boots after a night of rain.",
  "An empty platform still echoes when one person walks across it.",
];

const DESKTOP_TAILS = [
  ' They said, "Wait!"',
  ' They said, "Not yet!"',
  ' They said, "Ready!"',
  ' They whispered, "Go now."',
  ' They called, "Here!"',
  ' A note read: leave it.',
  ' A note read: come back.',
  ' They paused; nobody answered.',
  ' They laughed; the work was done.',
  ' The spare key (the small one) was missing.',
];

const CURSOR_TAILS = [
  " The clock read 7.",
  " Was the work done?",
  " It was a two-hour job.",
  " They didn't look back.",
  " The well-worn list held.",
  " Stop 3 was the plan.",
  " Bay 2 could wait.",
  " Was the list done?",
  " Room 4 stayed quiet.",
  " Did they ask once more?",
];

function clean(text) {
  return String(text).replace(/\s+/g, " ").trim();
}

function extraPunct(text) {
  const marks = String(text).match(/[.,'"!?;:()\-]/g);
  let count = marks ? marks.length : 0;
  if (String(text).endsWith(".")) count -= 1;
  return count;
}

function cursorSafe(text) {
  for (const ch of text) {
    if (ch >= "A" && ch <= "Z") {
      if (!CURSOR_CHARS.includes(ch.toLowerCase())) return false;
    } else if (!CURSOR_CHARS.includes(ch)) return false;
  }
  return true;
}

function desktopSafe(text) {
  return DESKTOP_RE.test(text);
}

function capitalWhen(when) {
  return when.charAt(0).toUpperCase() + when.slice(1);
}

function actsFrom(scene, start, count) {
  const out = [];
  for (let i = 0; i < count; i += 1) out.push(scene.act[(start + i) % scene.act.length]);
  return out;
}

function story(who, acts, where, when, comma) {
  if (acts.length === 1) {
    if (comma) return `${capitalWhen(when)}, ${who} ${acts[0]} ${where}.`;
    return `${who} ${acts[0]} ${where} ${when}.`;
  }
  const lines = acts.map((act, index) => {
    if (index === 0) return `${who} ${act} ${where}.`;
    const name = "they";
    if (index === acts.length - 1) {
      return comma ? `After that, ${name} ${act} ${when}.` : `Then ${name} ${act} ${when}.`;
    }
    return `Next ${name} ${act}.`;
  });
  return clean(lines.join(" "));
}

function oneBeat(who, act, where, when, shape) {
  if (shape === "when") return `${who} ${act} ${when}.`;
  if (shape === "where") return `${who} ${act} ${where}.`;
  if (shape === "comma") return `${capitalWhen(when)}, ${who} ${act} ${where}.`;
  return `${who} ${act} ${where} ${when}.`;
}

function acceptable(text) {
  if (!text || text !== text.trim()) return false;
  if (/\s{2,}/.test(text)) return false;
  if (!/^[A-Z]/.test(text)) return false;
  if (/ [.,!?;:]/.test(text)) return false;
  const parts = text.split(/(?<=[.!?])\s+/);
  if (new Set(parts).size !== parts.length) return false;
  return true;
}

function plainBand(text) {
  if (!cursorSafe(text) || !acceptable(text)) return null;
  for (const length of ["sprint", "set", "long"]) {
    for (const difficulty of ["easy", "medium"]) {
      const [min, max] = BOUNDS[length][difficulty];
      if (text.length < min || text.length > max) continue;
      if (length === "sprint" && difficulty === "easy" && extraPunct(text) > 0) return null;
      return { length, difficulty };
    }
  }
  return null;
}

function pushUnique(list, text, seen) {
  if (seen.has(text)) return;
  seen.add(text);
  list.push(text);
}

const seenPlain = new Set();
const plain = {
  sprint: { easy: [], medium: [] },
  set: { easy: [], medium: [] },
  long: { easy: [], medium: [] },
};
const bodies = [];

function consider(text) {
  const cleaned = clean(text);
  if (!acceptable(cleaned) || !cursorSafe(cleaned)) return;
  pushUnique(bodies, cleaned, seenPlain);
  const band = plainBand(cleaned);
  if (!band) return;
  const bucket = plain[band.length][band.difficulty];
  if (!bucket.includes(cleaned)) bucket.push(cleaned);
}

for (const scene of SCENES) {
  for (let whoIndex = 0; whoIndex < scene.who.length; whoIndex += 1) {
    const who = scene.who[whoIndex];
    for (let start = 0; start < scene.act.length; start += 1) {
      for (let whereIndex = 0; whereIndex < scene.where.length; whereIndex += 1) {
        const whenIndex = (whoIndex + start + whereIndex) % scene.when.length;
        const where = scene.where[whereIndex];
        const when = scene.when[whenIndex];
        const act = scene.act[start];
        consider(oneBeat(who, act, where, when, "when"));
        consider(oneBeat(who, act, where, when, "where"));
        consider(oneBeat(who, act, where, when, "both"));
        consider(oneBeat(who, act, where, when, "comma"));
        for (const beats of [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
          const chosen = actsFrom(scene, start, beats);
          consider(story(who, chosen, where, when, false));
          consider(story(who, chosen, where, when, true));
        }
      }
    }
  }
}

for (const fact of FACTS) consider(fact);

function splitPool(list) {
  const sorted = [...list].sort();
  const cursor = [];
  const desktop = [];
  sorted.forEach((text, index) => {
    if (index % 3 === 0) cursor.push(text);
    else desktop.push(text);
  });
  return { cursor, desktop };
}

function withTails(source, tails, min, max, ok) {
  const out = [];
  const seen = new Set();
  for (const body of source) {
    for (const tail of tails) {
      const text = `${body}${tail}`;
      if (text.length < min || text.length > max) continue;
      if (seen.has(text) || !acceptable(text) || !ok(text)) continue;
      seen.add(text);
      out.push(text);
      break;
    }
  }
  out.sort();
  return out;
}

for (const tail of DESKTOP_TAILS) {
  if (!desktopSafe(tail) || !/["!;:()]/.test(tail)) throw new Error(`bad desktop tail: ${tail}`);
}
for (const tail of CURSOR_TAILS) {
  if (!cursorSafe(tail) || !/[0-9'?\-]/.test(tail)) throw new Error(`bad cursor tail: ${tail}`);
}

const hard = {
  cursor: {
    sprint: withTails(bodies, CURSOR_TAILS, ...BOUNDS.sprint.hard, (text) => cursorSafe(text) && /[0-9'?\-]/.test(text)),
    set: withTails(bodies, CURSOR_TAILS, ...BOUNDS.set.hard, (text) => cursorSafe(text) && /[0-9'?\-]/.test(text)),
    long: withTails(bodies, CURSOR_TAILS, ...BOUNDS.long.hard, (text) => cursorSafe(text) && /[0-9'?\-]/.test(text)),
  },
  desktop: {
    sprint: withTails(bodies, DESKTOP_TAILS, ...BOUNDS.sprint.hard, (text) => desktopSafe(text) && /["!;:()]/.test(text)),
    set: withTails(bodies, DESKTOP_TAILS, ...BOUNDS.set.hard, (text) => desktopSafe(text) && /["!;:()]/.test(text)),
    long: withTails(bodies, DESKTOP_TAILS, ...BOUNDS.long.hard, (text) => desktopSafe(text) && /["!;:()]/.test(text)),
  },
};

const used = new Set();
const passages = [];

function takeFrom(list, need) {
  const available = list.filter((text) => !used.has(text));
  const out = [];
  if (available.length) {
    const step = available.length / need;
    for (let index = 0; index < need; index += 1) {
      const pick = available[Math.min(available.length - 1, Math.floor(index * step))];
      if (!pick || used.has(pick)) continue;
      used.add(pick);
      out.push(pick);
    }
  }
  if (out.length < need) {
    for (const text of available) {
      if (out.length >= need) break;
      if (used.has(text)) continue;
      used.add(text);
      out.push(text);
    }
  }
  return out;
}

function addBucket(prefix, length, difficulty, texts) {
  const need = prefix === "c" ? NEED.cursor : NEED.desktop;
  const chosen = takeFrom(texts, need);
  if (chosen.length < need) {
    throw new Error(`${prefix} ${length} ${difficulty} produced ${chosen.length}, need ${need}, candidates ${texts.length}`);
  }
  chosen.sort();
  chosen.forEach((text, index) => {
    passages.push({
      id: `${prefix}-${LENGTH_CODE[length]}-${DIFF_CODE[difficulty]}-${String(index + 1).padStart(3, "0")}`,
      text,
      ladders: prefix === "c" ? ["cursor"] : ["desktop", "mobile"],
      length,
      difficulty,
      chars: text.length,
    });
  });
  console.log(`${prefix} ${length} ${difficulty}: ${chosen[0]}`);
}

for (const length of ["sprint", "set", "long"]) {
  for (const difficulty of ["easy", "medium"]) {
    const parts = splitPool(plain[length][difficulty]);
    const comma = parts.cursor.filter((text) => text.includes(","));
    const plainCursor = parts.cursor.filter((text) => !text.includes(","));
    const commaDesktop = parts.desktop.filter((text) => text.includes(","));
    const plainDesktop = parts.desktop.filter((text) => !text.includes(","));
    const cursorList = difficulty === "medium" ? [...comma, ...plainCursor] : [...plainCursor, ...comma];
    const desktopList = difficulty === "medium" ? [...commaDesktop, ...plainDesktop] : [...plainDesktop, ...commaDesktop];
    addBucket("c", length, difficulty, cursorList);
    addBucket("d", length, difficulty, desktopList);
  }
  addBucket("c", length, "hard", hard.cursor[length]);
  addBucket("d", length, "hard", hard.desktop[length]);
}

passages.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

const ids = new Set();
const texts = new Set();
for (const row of passages) {
  if (ids.has(row.id) || texts.has(row.text)) throw new Error(`duplicate ${row.id}`);
  ids.add(row.id);
  texts.add(row.text);
  if (row.chars !== row.text.length) throw new Error(`chars ${row.id}`);
  const [min, max] = BOUNDS[row.length][row.difficulty];
  if (row.text.length < min || row.text.length > max) throw new Error(`bounds ${row.id} ${row.text.length}`);
  if (row.ladders.includes("cursor")) {
    if (!cursorSafe(row.text)) throw new Error(`cursor ${row.id}`);
  } else if (!desktopSafe(row.text)) throw new Error(`desktop ${row.id}`);
  if (row.length === "sprint" && row.difficulty === "easy" && extraPunct(row.text) > 1) throw new Error(`punct ${row.id}`);
  if (row.difficulty === "hard" && row.ladders.includes("cursor") && !/[0-9'?\-]/.test(row.text)) throw new Error(`variety ${row.id}`);
  if (row.difficulty === "hard" && row.ladders.includes("desktop") && !/["!;:()]/.test(row.text)) throw new Error(`variety ${row.id}`);
}

const body = `// Generated by script/passages-build.mjs.
// Ids are stable. Edit the generator, then run: node script/passages-build.mjs
// Original prose for the typing pool. Do not paste copyrighted text here.

export const PASSAGES = ${JSON.stringify(passages, null, 2)};
`;

if (/\bstyle\s*[:=]/.test(body) || /setAttribute\(\s*['"]style['"]/.test(body)) {
  throw new Error("generated file would trip the inline-style scan");
}

writeFileSync(new URL("../public/passages.js", import.meta.url), body);
const desktop = passages.filter((row) => row.ladders.includes("desktop")).length;
const cursor = passages.filter((row) => row.ladders.includes("cursor")).length;
console.log(`wrote ${passages.length} passages (${desktop} desktop, ${cursor} cursor)`);
