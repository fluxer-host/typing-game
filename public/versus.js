import { botLaneName, botTimeline, clampBotWpm, normalizeSeed } from "./bot.js";
import { ghostLaneName, scaleGhost } from "./ghost.js";

export const BOT_LANE_ID = "practice-bot";
export const GHOST_LANE_ID = "practice-ghost";

export function botOpponent({ sentence, targetWpm, seed }) {
  const target = clampBotWpm(targetWpm);
  const resolved = normalizeSeed(seed);
  const timeline = botTimeline(sentence, target, resolved);
  return {
    kind: "bot",
    id: BOT_LANE_ID,
    name: botLaneName(target),
    wpm: target,
    seed: resolved,
    samples: timeline.samples,
    finishMs: timeline.finishMs,
  };
}

export function ghostOpponent({ sentence, best }) {
  const text = typeof sentence === "string" ? sentence : "";
  if (!best || !Array.isArray(best.samples) || !best.samples.length || !text.length) return null;
  const from = Math.max(1, Math.round(Number(best.chars) || best.samples[best.samples.length - 1].i || text.length));
  const samples = scaleGhost(best.samples, from, text.length);
  const last = samples[samples.length - 1];
  if (!last || last.i !== text.length) return null;
  return {
    kind: "ghost",
    id: GHOST_LANE_ID,
    name: ghostLaneName(best.wpm),
    wpm: Number(best.wpm) || 0,
    seed: null,
    samples,
    finishMs: last.t,
  };
}

function marginSeconds(ms) {
  const seconds = Math.abs(Number(ms) || 0) / 1000;
  if (seconds < 0.05) return "under 0.1 seconds";
  const shown = (Math.round(seconds * 10) / 10).toFixed(1);
  return shown === "1.0" ? "1.0 second" : `${shown} seconds`;
}

function marginCharacters(count) {
  const n = Math.abs(Math.round(Number(count) || 0));
  return n === 1 ? "1 character" : `${n} characters`;
}

function bounded(index, length) {
  const value = Math.round(Number(index) || 0);
  const cap = Math.max(0, Math.round(Number(length) || 0));
  if (value < 0) return 0;
  if (cap && value > cap) return cap;
  return value;
}

export function compareRace({
  youFinished = false,
  youMs = 0,
  youIndex = 0,
  oppFinished = false,
  oppMs = 0,
  oppIndex = 0,
  length = 0,
  opponent = "Bot",
} = {}) {
  const total = Math.max(0, Math.round(Number(length) || 0));
  const youAt = bounded(youFinished && total ? total : youIndex, total);
  const oppAt = bounded(oppFinished && total ? total : oppIndex, total);
  const youTime = youFinished && Number.isFinite(Number(youMs)) && Number(youMs) >= 0 ? Number(youMs) : null;
  const oppTime = oppFinished && Number.isFinite(Number(oppMs)) && Number(oppMs) >= 0 ? Number(oppMs) : null;
  const name = String(opponent || "Bot");
  if (youTime != null && oppTime != null) {
    const marginMs = Math.abs(youTime - oppTime);
    if (youTime === oppTime) {
      return { winner: "tie", marginMs: 0, marginChars: null, summary: "You tied on time." };
    }
    if (youTime < oppTime) {
      return { winner: "you", marginMs, marginChars: null, summary: `You won by ${marginSeconds(marginMs)}.` };
    }
    return { winner: "opponent", marginMs, marginChars: null, summary: `${name} won by ${marginSeconds(marginMs)}.` };
  }
  let winner = "tie";
  let marginChars = 0;
  if (youTime != null && oppTime == null) {
    winner = "you";
    marginChars = Math.max(0, total - oppAt);
  } else if (oppTime != null && youTime == null) {
    winner = "opponent";
    marginChars = Math.max(0, total - youAt);
  } else if (youAt !== oppAt) {
    winner = youAt > oppAt ? "you" : "opponent";
    marginChars = Math.abs(youAt - oppAt);
  }
  if (winner === "tie") {
    return { winner, marginMs: null, marginChars: 0, summary: "You are even." };
  }
  const summary = winner === "you"
    ? `You won by ${marginCharacters(marginChars)}.`
    : `${name} won by ${marginCharacters(marginChars)}.`;
  return { winner, marginMs: null, marginChars, summary };
}
