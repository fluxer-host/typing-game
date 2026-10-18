import assert from "node:assert/strict";
import test from "node:test";
import { soloStart } from "../public/solo.js";
import { botOpponent, compareRace, ghostOpponent } from "../public/versus.js";

test("a fresh solo start has no opponent", () => {
  const patch = soloStart({ mode: "desktop", length: "sprint", now: 10 });
  assert.equal(patch.versus, null);
  assert.equal(patch.kind, "practice");
  assert.equal(patch.ranked, false);
  assert.equal(patch.players.length, 1);
});

test("the result names the winner and the margin", () => {
  const byTime = compareRace({
    youFinished: true,
    youMs: 10_000,
    oppFinished: true,
    oppMs: 11_400,
    length: 80,
    opponent: "Bot",
  });
  assert.equal(byTime.winner, "you");
  assert.equal(byTime.marginMs, 1400);
  assert.equal(byTime.summary, "You won by 1.4 seconds.");
  const lost = compareRace({
    youFinished: true,
    youMs: 10_800,
    oppFinished: true,
    oppMs: 10_000,
    length: 80,
    opponent: "Bot",
  });
  assert.equal(lost.winner, "opponent");
  assert.equal(lost.marginMs, 800);
  assert.equal(lost.summary, "Bot won by 0.8 seconds.");
  const tie = compareRace({
    youFinished: true,
    youMs: 5000,
    oppFinished: true,
    oppMs: 5000,
    length: 40,
    opponent: "Your ghost",
  });
  assert.equal(tie.winner, "tie");
  assert.equal(tie.marginMs, 0);
  assert.equal(tie.summary, "You tied on time.");
  const ahead = compareRace({
    youFinished: true,
    youMs: 9000,
    youIndex: 100,
    oppFinished: false,
    oppIndex: 40,
    length: 100,
    opponent: "Bot",
  });
  assert.equal(ahead.winner, "you");
  assert.equal(ahead.marginChars, 60);
  assert.equal(ahead.summary, "You won by 60 characters.");
  const behind = compareRace({
    youFinished: false,
    youIndex: 10,
    oppFinished: true,
    oppMs: 8000,
    oppIndex: 100,
    length: 100,
    opponent: "Your ghost",
  });
  assert.equal(behind.winner, "opponent");
  assert.equal(behind.marginChars, 90);
  assert.equal(behind.summary, "Your ghost won by 90 characters.");
  const open = compareRace({
    youFinished: false,
    youIndex: 12,
    oppFinished: false,
    oppIndex: 11,
    length: 40,
    opponent: "Bot",
  });
  assert.equal(open.winner, "you");
  assert.equal(open.marginChars, 1);
  assert.equal(open.summary, "You won by 1 character.");
});

test("bot and ghost opponents finish the passage they were given", () => {
  const sentence = "Race the same line from the first letter to the last.";
  const bot = botOpponent({ sentence, targetWpm: 60, seed: 4 });
  assert.equal(bot.kind, "bot");
  assert.equal(bot.name, "Bot, 60 WPM");
  assert.equal(bot.samples.at(-1).i, sentence.length);
  assert.equal(bot.finishMs, bot.samples.at(-1).t);
  const again = botOpponent({ sentence, targetWpm: 60, seed: 4 });
  assert.deepEqual(again.samples, bot.samples);
  const best = {
    wpm: 72,
    chars: 20,
    samples: [{ t: 0, i: 0 }, { t: 4000, i: 20 }],
  };
  const ghost = ghostOpponent({ sentence, best });
  assert.equal(ghost.kind, "ghost");
  assert.equal(ghost.name, "Your best, 72 WPM");
  assert.equal(ghost.samples.at(-1).i, sentence.length);
  assert.equal(ghostOpponent({ sentence: "", best }), null);
  assert.equal(ghostOpponent({ sentence, best: null }), null);
});
