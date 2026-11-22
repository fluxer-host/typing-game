// Builds public/chat-passages.js. Ids stay stable for an unchanged run of this file.
// Each thread is original IM: lowercase, no punctuation, one message per line.
//   node script/chat-passages-build.mjs

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BOUNDS = {
  sprint: { easy: [20, 34], medium: [35, 52], hard: [53, 140] },
  set: { easy: [40, 58], medium: [59, 78], hard: [79, 220] },
  long: { easy: [80, 110], medium: [111, 130], hard: [131, 360] },
};

const LENGTH_FOR_LINES = { 3: "sprint", 4: "set", 6: "long" };
const CODE = { sprint: "sp", set: "se", long: "lg" };
const DIFF_CODE = { easy: "e", medium: "m", hard: "h" };

const SPRINT = [
  ["hey you up", "yeah just got home", "want to hop in voice"],
  ["omw", "traffic is bad", "save me a seat"],
  ["you free tonight", "after 8", "ill bring snacks"],
  ["lunch", "the usual place", "see you there"],
  ["did you feed the cat", "yes she is fine", "thanks"],
  ["running late", "no rush", "ill wait downstairs"],
  ["movie or games", "games", "im already in the channel"],
  ["rain check", "tomorrow works", "same time"],
  ["you see my message", "just now", "lol ok"],
  ["need a ride", "where are you", "by the library"],
  ["coffee", "oat milk if they have it", "on my way"],
  ["practice got moved", "to 6", "ill tell the others"],
  ["you eating", "leftovers", "want some"],
  ["bus is here", "run", "i see you"],
  ["homework", "which one", "the history page"],
  ["voice", "one sec", "ok im in"],
  ["keys", "on the hook", "got them"],
  ["you close", "two blocks", "ill wave"],
  ["soup is ready", "be right down", "save me a bowl"],
  ["new song", "send it", "its in the chat"],
  ["walk later", "after dinner", "ill text you"],
  ["charger", "check the desk", "found it"],
  ["you still out", "heading back", "see you in 10"],
  ["group project", "i did the slides", "you do the notes"],
  ["park", "by the pond", "im on the bench"],
  ["dont wait up", "text when you leave", "will do"],
  ["breakfast", "eggs or toast", "both"],
  ["you muted", "fixed", "we can hear you now"],
  ["ticket", "under your name", "got it thanks"],
  ["gym", "leg day", "ill be done at 7"],
  ["package came", "its by the door", "ill grab it"],
  ["you good", "yeah long day", "call me later"],
  ["map", "left at the light", "then the blue house"],
  ["study", "library at 4", "ill bring the cards"],
  ["dinner vote", "noodles", "im in"],
  ["alarm", "i slept through it", "leave in 5"],
];

const SET = [
  ["hey are you around", "yeah just sat down", "want to try the new update", "give me ten minutes"],
  ["cant find my jacket", "check the chair", "not there", "hall closet"],
  ["we still on for saturday", "yes", "noon at the station", "ill bring the tickets"],
  ["the wifi dropped", "mine too", "router light is red", "unplug it for a minute"],
  ["you coming to practice", "running behind", "we start without you", "save me a spot"],
  ["what do you want for dinner", "anything warm", "soup or rice", "soup"],
  ["i missed the bus", "next one is in 12", "ill wait with you", "im by the stop"],
  ["did the plants get water", "the big one did", "the small one looks sad", "ill do it tonight"],
  ["voice chat", "im in the kitchen", "headphones on", "ok talk then"],
  ["can you read my paragraph", "send it", "its short", "looks good ship it"],
  ["market run", "need eggs and bread", "oat milk too", "back in 20"],
  ["you still at work", "leaving now", "want a ride", "yes please"],
  ["game night", "my place", "bring the blue controller", "and chips"],
  ["the group chat is loud", "mute it", "i need the project bit", "ill paste it here"],
  ["walk the dog with me", "give me 5", "leash is by the door", "see you outside"],
  ["test tomorrow", "what time", "first period", "we can quiz at 8"],
  ["you hear that", "thunder", "windows are shut", "good"],
  ["im at the counter", "order for me", "the usual", "got it"],
  ["photos from the park", "send the pond one", "and the ducks", "done"],
  ["room is open", "code is in the note", "password too", "joining now"],
  ["you want the window seat", "you take it", "i like the aisle", "deal"],
  ["laundry", "your socks are dry", "thanks", "basket is on the bed"],
  ["we need one more for the team", "ask noor", "she said yes", "then we are full"],
  ["late snack", "apple or toast", "toast", "ill make two"],
  ["the trail is muddy", "boots then", "and a dry shirt", "meet at the gate"],
  ["you left your book", "which one", "the green notebook", "ill pick it up tomorrow"],
  ["stream tonight", "after 9", "ill be quiet", "same channel as last time"],
  ["groceries are in the hall", "the cold stuff first", "on it", "thanks for going"],
  ["can we move the call", "to 7", "that works", "ill update the note"],
  ["you ok getting home", "bus then a short walk", "text me when you are in", "i will"],
  ["new recipe", "its simple", "send the list", "already in the chat"],
  ["i can host", "how many people", "four", "ill clear the table"],
  ["the match is at 3", "im bringing water", "ill bring the ball", "see you on the field"],
  ["you still need the notes", "yes please", "page 4 to 6", "sending now"],
  ["power flickered", "same here", "the lamp is back", "save your work anyway"],
  ["morning", "you sleep at all", "a little", "coffee is on"],
];

const LONG = [
  ["hey", "you still up for the trip", "yes i packed last night", "train is at 9", "ill meet you on the platform", "save me the window if you get there first"],
  ["we should start the project", "i can take the intro", "ill do the pictures", "who writes the ending", "mina said she would", "then we check it sunday"],
  ["kitchen is a mess", "i can wash", "ill dry", "the big pot first", "then the plates", "soup bowls are still on the table"],
  ["you coming over", "after class", "ill be there around 5", "the door code is the same", "shoes by the mat", "ill put the kettle on"],
  ["game update dropped", "did you install it", "doing that now", "the new map looks fun", "want to try it tonight", "yes after dinner"],
  ["i lost my water bottle", "the blue one", "check the gym desk", "not there", "back seat of the car", "found it thanks"],
  ["market list", "apples", "bread", "the cheap oats", "and flowers if they look good", "ill send a photo before i buy them"],
  ["study group", "library second floor", "table by the window", "i have the cards", "bring your own pen", "we stop at 6"],
  ["rain all day", "practice might move inside", "coach has not said", "ill check the chat", "if it moves i can drive", "text me by 4"],
  ["you want help moving the shelf", "yes it is heavier than it looks", "i can come at noon", "the screws are in a jar", "the wall is marked", "we should be done in an hour"],
  ["birthday plan", "cake from the corner shop", "no candles they were out", "we can use the small ones from last year", "they are in the drawer", "ill pick the cake up at 2"],
  ["the show starts at 8", "doors at 7", "i have the tickets on my phone", "meet by the side door", "ill wear the red jacket", "text if the line is long"],
  ["camping list", "tent", "two lamps", "the dry snacks", "extra socks", "we leave before the sun is up"],
  ["you free to talk", "in a bit", "nothing bad", "just the weekend plan", "voice is easier", "call me when you sit down"],
  ["class notes", "i missed the first ten minutes", "the date is on the board", "page 12 was the main bit", "i can photo it", "send it when you can"],
  ["we should cook together", "saturday", "you chop", "i stir", "the recipe is short", "ill buy the greens on friday"],
  ["ride home", "i can leave at 6", "that works", "im by the north door", "look for the grey hood", "ill watch for you"],
  ["the group needs a name", "something simple", "not too cute", "we can vote in the chat", "three options", "ill write them down"],
];

function classify(lines) {
  const length = LENGTH_FOR_LINES[lines.length];
  if (!length) return { error: `line count ${lines.length}` };
  for (const line of lines) {
    if (typeof line !== "string" || !line) return { error: "empty line" };
    if (line !== line.trim()) return { error: `trim ${line}` };
    if (/\s{2,}/.test(line)) return { error: `double space ${line}` };
    if (!/^[a-z0-9 ]+$/.test(line)) return { error: `charset ${line}` };
  }
  const text = lines.join("\n");
  const chars = text.length;
  const bands = BOUNDS[length];
  let difficulty = "";
  for (const name of ["easy", "medium", "hard"]) {
    const [min, max] = bands[name];
    if (chars >= min && chars <= max) {
      difficulty = name;
      break;
    }
  }
  if (!difficulty) return { error: `bounds ${length} ${chars} ${text.replaceAll("\n", " / ")}` };
  return { length, difficulty, text, chars };
}

const errors = [];
const buckets = { sprint: [], set: [], long: [] };
for (const [name, group] of [["sprint", SPRINT], ["set", SET], ["long", LONG]]) {
  const seen = new Set();
  for (const lines of group) {
    const row = classify(lines);
    if (row.error) {
      errors.push(row.error);
      continue;
    }
    if (row.length !== name) errors.push(`tier ${name} ${row.length}`);
    if (seen.has(row.text)) errors.push(`duplicate ${row.text}`);
    seen.add(row.text);
    buckets[name].push(row);
  }
}

const rows = [];
for (const length of ["sprint", "set", "long"]) {
  const counts = { easy: 0, medium: 0, hard: 0 };
  for (const row of buckets[length]) {
    counts[row.difficulty] += 1;
    const id = `c-${CODE[length]}-${DIFF_CODE[row.difficulty]}-${String(counts[row.difficulty]).padStart(3, "0")}`;
    rows.push({
      id,
      text: row.text,
      ladders: ["desktop", "mobile", "cursor"],
      length,
      difficulty: row.difficulty,
      chars: row.chars,
    });
  }
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}

const body = `// Original chat passages. Lowercase messages, no punctuation.
// Generated by script/chat-passages-build.mjs. Edit that file, then rebuild.

export const CHAT_PASSAGES = ${JSON.stringify(rows, null, 2)};
`;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
writeFileSync(join(root, "public", "chat-passages.js"), body);
const tally = {};
for (const row of rows) {
  const key = `${row.length} ${row.difficulty}`;
  tally[key] = (tally[key] || 0) + 1;
}
console.log(`wrote ${rows.length}`);
console.log(tally);
