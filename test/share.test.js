import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { config } from "../src/api.js";
import { PUNCTUATION_PASSAGES } from "../public/punctuation-passages.js";
import { cardSvg, escapeHtml, securityHeaders, sharePage, SITE_CSP, svgText } from "../src/share-card.js";
import { clearShareLimits, SHARE_LIMIT, SHARE_WINDOW_MS } from "../src/share-limit.js";
import { renderCardPng } from "../src/share-png.js";
import { cardFromPractice, cardFromSavedRace, describeSavedSentence } from "../src/share-record.js";
import { shareGet, shareIssue } from "../src/share.js";
import { publicCardName, shareableName } from "../src/share-name.js";
import {
  encodeShareToken,
  MAX_TOKEN_LENGTH,
  readShareToken,
  sealSharePayload,
  shareEnabled,
  shareSecrets,
} from "../src/share-token.js";
import { b64urlDecode } from "../src/session.js";
import { openStream } from "../src/timed.js";
import { poolFor } from "../src/sentences.js";
import { shareLinks } from "../public/share.js";

const SECRET = "share-secret-value-32chars-minimum";
const PREVIOUS = "previous-share-secret-value-32c";
const NOW = 1760000000000;

function sample(overrides = {}) {
  return {
    v: 1,
    kind: "practice",
    ladder: "desktop",
    format: "passage",
    length: "sprint",
    wpm: 84.2,
    accuracy: 98.5,
    ms: 12340,
    at: NOW,
    name: "Ada One",
    ranked: false,
    place: 0,
    ...overrides,
  };
}

function secrets(current = SECRET, previous = "") {
  return { current, previous };
}

function tokenBody(token) {
  return JSON.parse(new TextDecoder().decode(b64urlDecode(token.split(".")[0])));
}

test("a signed token round-trips and keeps only public fields", async () => {
  const card = sample({ name: `A<b>"&'` });
  const token = await encodeShareToken(card, SECRET);
  assert.ok(token);
  assert.ok(token.length <= MAX_TOKEN_LENGTH);
  const read = await readShareToken(token, secrets());
  assert.equal(read.name, card.name);
  assert.equal(read.wpm, 84.2);
  assert.equal(read.v, 1);
  assert.equal(read.ranked, false);
  const json = JSON.stringify(tokenBody(token));
  assert.equal(json.includes("user"), false);
  assert.equal(json.includes("@"), false);
  assert.equal(json.includes("avatar"), false);
});

test("a tampered token, a bad signature, and a malformed token are rejected", async () => {
  const token = await encodeShareToken(sample(), SECRET);
  const [body, signature] = token.split(".");
  const flipped = `${body[0] === "A" ? "B" : "A"}${body.slice(1)}.${signature}`;
  const resign = `${body}.${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
  assert.equal(await readShareToken(flipped, secrets()), null);
  assert.equal(await readShareToken(resign, secrets()), null);
  assert.equal(await readShareToken(token, secrets("other-secret-value-32-characters")), null);
  for (const bad of ["", "nope", "abc.", ".sig", "a.b.c", "%%%", "abc.def"]) {
    assert.equal(await readShareToken(bad, secrets()), null, bad);
  }
});

test("the wrong version and an oversized token are rejected", async () => {
  const token = await sealSharePayload({ ...sample(), v: 2 }, SECRET);
  assert.ok(token);
  assert.equal(await readShareToken(token, secrets()), null);
  assert.equal(await readShareToken("a".repeat(MAX_TOKEN_LENGTH + 1), secrets()), null);
  const huge = await sealSharePayload({ ...sample(), name: "n".repeat(400) }, SECRET);
  assert.equal(huge, null);
  assert.equal(await encodeShareToken(sample({ name: "n".repeat(80) }), SECRET), null);
});

test("the previous signing key still verifies and a missing secret fails closed", async () => {
  const oldToken = await encodeShareToken(sample(), PREVIOUS);
  const currentToken = await encodeShareToken(sample({ name: "Bea Two" }), SECRET);
  assert.equal((await readShareToken(oldToken, secrets(SECRET, PREVIOUS))).name, "Ada One");
  assert.equal((await readShareToken(currentToken, secrets(SECRET, PREVIOUS))).name, "Bea Two");
  assert.equal(await readShareToken(oldToken, secrets(SECRET, "")), null);
  assert.equal(await encodeShareToken(sample(), ""), null);
  assert.equal(await encodeShareToken(sample(), "short"), null);
  assert.equal(shareEnabled({}), false);
  assert.equal(shareEnabled({ SHARE_SIGNING_SECRET: "short" }), false);
  assert.equal(shareEnabled({ SHARE_SIGNING_SECRET: SECRET }), true);
  assert.equal(shareSecrets({ SHARE_SIGNING_SECRET: SECRET, SHARE_SIGNING_SECRET_PREVIOUS: "short" }).previous, "");
});

test("names with markup are escaped and long names are truncated", () => {
  const raw = `A<b>"&'`;
  assert.equal(escapeHtml(raw), "A&lt;b&gt;&quot;&amp;&#39;");
  assert.equal(svgText(raw), "A&lt;b&gt;&quot;&amp;&#39;");
  const long = "N".repeat(40);
  const cut = svgText(long, 24);
  assert.equal(Array.from(cut).length, 24);
  assert.equal(cut.endsWith("…"), true);
  assert.equal(cut.includes("<"), false);
  const hostile = sample({ name: raw });
  const html = sharePage({
    card: hostile,
    origin: "https://typing.fluxer.my",
    token: "body.sig",
    stylesheet: "/a/styles.abcdef12.css",
  });
  assert.equal(html.includes(raw), false);
  assert.equal(html.includes("<script"), false);
  assert.equal(html.includes("style="), false);
  assert.ok(html.includes("A&lt;b&gt;&quot;&amp;&#39;"));
  const svg = cardSvg(hostile);
  assert.equal(svg.includes(raw), false);
  assert.ok(svg.includes("A&lt;b&gt;&quot;&amp;&#39;"));
  assert.equal(svg.includes("<script"), false);
  const injected = sharePage({
    card: sample(),
    origin: "https://typing.fluxer.my",
    token: "body.sig",
    stylesheet: "https://evil.example/x.css",
  });
  assert.equal(injected.includes("evil.example"), false);
  assert.equal(injected.includes('rel="stylesheet"'), false);
});

test("the share page carries the preview tags", () => {
  const html = sharePage({
    card: sample({ name: "Ada One" }),
    origin: "https://typing.fluxer.my",
    token: "body.sig",
    stylesheet: "/a/styles.abcdef12.css",
  });
  const required = [
    'property="og:title"',
    'property="og:description"',
    'property="og:type" content="website"',
    'property="og:url" content="https://typing.fluxer.my/s/body.sig"',
    'property="og:image" content="https://typing.fluxer.my/s/body.sig/card.png"',
    'property="og:image:width" content="1200"',
    'property="og:image:height" content="630"',
    'property="og:image:alt"',
    'name="twitter:card" content="summary_large_image"',
    'name="robots" content="noindex"',
    "Play now",
    "84.2",
    "98.5% accuracy",
    "Ada One",
    "Practice",
    'href="/a/styles.abcdef12.css"',
  ];
  for (const tag of required) assert.ok(html.includes(tag), tag);
  assert.equal(html.includes("<script"), false);
  assert.equal(html.includes("<style"), false);
  assert.equal(html.includes("style="), false);
});

test("saved race cards use the stored result and practice cards stay unverified", () => {
  const passage = poolFor("desktop", "sprint")[0];
  const ranked = cardFromSavedRace({
    mode: "desktop",
    sentence: passage.text,
    ranked: 1,
    finished_at: NOW,
    place: 1,
    wpm: 80.5,
    accuracy: 99.1,
    ms: 12000,
    racers: 2,
  }, { id: "user-99", global_name: "Ada One", username: "ada" }, true);
  assert.equal(ranked.wpm, 80.5);
  assert.equal(ranked.ranked, true);
  assert.equal(ranked.kind, "race");
  assert.equal(ranked.format, "passage");
  assert.equal(ranked.length, "sprint");
  assert.equal(ranked.name, "Ada One");
  assert.equal(JSON.stringify(ranked).includes("user-99"), false);

  const hidden = cardFromSavedRace({
    mode: "desktop",
    sentence: passage.text,
    ranked: 1,
    finished_at: NOW,
    place: 2,
    wpm: 80.5,
    accuracy: 99,
    ms: 12000,
  }, { id: "99999999", global_name: "99999999" }, true);
  assert.equal(hidden.name, "Anonymous");
  assert.equal(shareableName("99999999"), false);
  assert.equal(shareableName("Ada One"), true);
  assert.equal(publicCardName("https://fluxerusercontent.com/avatars/1/a.png"), "Anonymous");

  const practice = cardFromPractice({
    kind: "practice",
    ladder: "desktop",
    format: "passage",
    length: "sprint",
    wpm: 70.2,
    accuracy: 100,
    ms: 15000,
    showName: true,
    name: "Hacker",
    ranked: true,
  }, { id: "user-99", global_name: "Ada One" }, NOW);
  assert.equal(practice.name, "Ada One");
  assert.equal(practice.ranked, false);
  assert.equal(practice.kind, "practice");
  assert.equal(JSON.stringify(practice).includes("Hacker"), false);
  assert.equal(JSON.stringify(practice).includes("user-99"), false);

  const guest = cardFromPractice({
    kind: "practice",
    ladder: "desktop",
    format: "passage",
    length: "sprint",
    wpm: 70,
    accuracy: 100,
    ms: 15000,
    showName: true,
    name: "Hacker",
  }, null, NOW);
  assert.equal(guest.name, "Anonymous");
  assert.equal(cardFromPractice({ ladder: "cursor", format: "punctuation", length: "sprint", wpm: 10, accuracy: 100, ms: 1000 }, null, NOW), null);
});

test("a saved sentence can be labelled without a format column", () => {
  const passage = poolFor("desktop", "sprint")[0];
  assert.deepEqual(describeSavedSentence("desktop", passage.text), { format: "passage", length: "sprint" });
  const punct = PUNCTUATION_PASSAGES[0];
  assert.equal(describeSavedSentence("desktop", punct.text).format, "punctuation");
  assert.equal(describeSavedSentence("cursor", punct.text).format, "");
  const opened = openStream(poolFor("desktop").map((row) => ({ id: row.id, text: row.text })), 7, { chunk: 100 });
  assert.equal(describeSavedSentence("desktop", opened.sentence).format, "timed");
  assert.equal(describeSavedSentence("desktop", "z".repeat(120)).format, "");
  const ranked = cardFromSavedRace({
    mode: "desktop",
    sentence: opened.sentence,
    ranked: 1,
    finished_at: NOW,
    place: 1,
    wpm: 12,
    accuracy: 100,
    ms: 30000,
  }, { global_name: "Ada One" }, false);
  assert.equal(ranked.format, "passage");
  assert.equal(ranked.ranked, true);
  assert.equal(ranked.name, "Anonymous");
});

test("share issuing signs stored race numbers and refuses a missing secret", async () => {
  const closed = await shareIssue(new Request("https://typing.fluxer.my/api/share", {
    method: "POST",
    headers: { origin: "https://typing.fluxer.my", "content-type": "application/json" },
    body: JSON.stringify({ kind: "practice", ladder: "desktop", format: "passage", length: "sprint", wpm: 10, accuracy: 100, ms: 1000 }),
  }), {});
  assert.equal(closed.status, 503);
  assert.equal((await closed.json()).error, "share_unavailable");

  const passage = poolFor("desktop", "sprint")[0];
  const env = { SHARE_SIGNING_SECRET: SECRET };
  const response = await shareIssue(new Request("https://typing.fluxer.my/api/share", {
    method: "POST",
    headers: { origin: "https://typing.fluxer.my", "content-type": "application/json" },
    body: JSON.stringify({
      raceId: "11111111-1111-4111-8111-111111111111",
      showName: true,
      wpm: 999,
      accuracy: 1,
      name: "Hacker",
      ranked: false,
    }),
  }), env, {
    resolveUser: async () => ({ user: { id: "user-99", global_name: "Ada One", username: "ada" } }),
    loadRace: async (_env, raceId, userId) => {
      assert.equal(raceId, "11111111-1111-4111-8111-111111111111");
      assert.equal(userId, "user-99");
      return {
        mode: "desktop",
        sentence: passage.text,
        ranked: 1,
        finished_at: NOW,
        place: 1,
        wpm: 80.5,
        accuracy: 99.1,
        ms: 12000,
        racers: 2,
      };
    },
  });
  assert.equal(response.status, 200);
  const issued = await response.json();
  const token = new URL(issued.url).pathname.slice(3);
  const card = await readShareToken(token, shareSecrets(env));
  assert.equal(card.wpm, 80.5);
  assert.equal(card.accuracy, 99.1);
  assert.equal(card.ranked, true);
  assert.equal(card.name, "Ada One");
  assert.equal(JSON.stringify(tokenBody(token)).includes("user-99"), false);
  assert.equal(JSON.stringify(tokenBody(token)).includes("999"), false);
  assert.equal(issued.title.includes("Ranked"), true);

  const anonymous = await shareIssue(new Request("https://typing.fluxer.my/api/share", {
    method: "POST",
    headers: { origin: "https://typing.fluxer.my", "content-type": "application/json" },
    body: JSON.stringify({ raceId: "11111111-1111-4111-8111-111111111111", showName: true, wpm: 999 }),
  }), env);
  assert.equal(anonymous.status, 401);

  const practice = await shareIssue(new Request("https://typing.fluxer.my/api/share", {
    method: "POST",
    headers: { origin: "https://typing.fluxer.my", "content-type": "application/json" },
    body: JSON.stringify({
      kind: "practice",
      ladder: "mobile",
      format: "passage",
      length: "set",
      wpm: 55.5,
      accuracy: 97,
      ms: 20000,
      showName: true,
      name: "Hacker",
      ranked: true,
    }),
  }), env);
  assert.equal(practice.status, 200);
  const practiceCard = await readShareToken(new URL((await practice.json()).url).pathname.slice(3), shareSecrets(env));
  assert.equal(practiceCard.kind, "practice");
  assert.equal(practiceCard.ranked, false);
  assert.equal(practiceCard.name, "Anonymous");
  assert.equal(practiceCard.wpm, 55.5);
});

test("the share page and a bad token keep the site headers", async () => {
  const env = {
    SHARE_SIGNING_SECRET: SECRET,
    ASSETS: {
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/index.html") {
          return new Response('<link rel="stylesheet" href="/a/styles.abcdef12.css">', { status: 200 });
        }
        if (path === "/404.html") return new Response("branded missing", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
        return new Response("no", { status: 404 });
      },
    },
  };
  const issued = await shareIssue(new Request("https://typing.fluxer.my/api/share", {
    method: "POST",
    headers: { origin: "https://typing.fluxer.my", "content-type": "application/json" },
    body: JSON.stringify({ kind: "practice", ladder: "desktop", format: "timed", wpm: 40, accuracy: 100, ms: 30000, showName: false }),
  }), env);
  const token = new URL((await issued.json()).url).pathname.slice(3);
  const page = await shareGet(new Request(`https://typing.fluxer.my/s/${token}`), env);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(page.headers.get("content-security-policy"), SITE_CSP);
  assert.equal(page.headers.get("x-robots-tag"), "noindex");
  assert.equal(page.headers.get("content-security-policy").includes("unsafe-inline"), false);
  const html = await page.text();
  assert.ok(html.includes('name="twitter:card" content="summary_large_image"'));
  assert.ok(html.includes('property="og:image:width" content="1200"'));
  assert.ok(html.includes('property="og:image:height" content="630"'));
  assert.ok(html.includes("Practice"));
  assert.ok(html.includes("Timed"));
  assert.equal(html.includes("<script"), false);
  const tampered = `${token.slice(0, 8) === "AAAAAAAA" ? "BBBBBBBB" : "AAAAAAAA"}${token.slice(8)}`;
  const missing = await shareGet(new Request(`https://typing.fluxer.my/s/${tampered}`), env);
  assert.equal(missing.status, 404);
  assert.equal(await missing.text(), "branded missing");
  assert.equal(missing.headers.get("content-security-policy"), securityHeaders("no-store").get("content-security-policy"));
  const off = config({});
  assert.equal((await off.json()).share, false);
  assert.equal((await config({ SHARE_SIGNING_SECRET: SECRET }).json()).share, true);
});

test("share requests are capped per caller", async () => {
  clearShareLimits();
  const env = { SHARE_SIGNING_SECRET: SECRET };
  let status = 200;
  for (let i = 0; i < SHARE_LIMIT + 1; i += 1) {
    const response = await shareIssue(new Request("https://typing.fluxer.my/api/share", {
      method: "POST",
      headers: {
        origin: "https://typing.fluxer.my",
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.10",
      },
      body: JSON.stringify({ kind: "practice", ladder: "desktop", format: "passage", length: "sprint", wpm: 10, accuracy: 100, ms: 1000 }),
    }), env);
    status = response.status;
  }
  assert.equal(status, 429);
  const later = await shareIssue(new Request("https://typing.fluxer.my/api/share", {
    method: "POST",
    headers: {
      origin: "https://typing.fluxer.my",
      "content-type": "application/json",
      "cf-connecting-ip": "203.0.113.10",
    },
    body: JSON.stringify({ kind: "practice", ladder: "desktop", format: "passage", length: "sprint", wpm: 10, accuracy: 100, ms: 1000 }),
  }), env);
  assert.equal(later.status, 429);
  clearShareLimits();
  const fresh = await shareIssue(new Request("https://typing.fluxer.my/api/share", {
    method: "POST",
    headers: {
      origin: "https://typing.fluxer.my",
      "content-type": "application/json",
      "cf-connecting-ip": "203.0.113.10",
    },
    body: JSON.stringify({ kind: "practice", ladder: "desktop", format: "passage", length: "sprint", wpm: 10, accuracy: 100, ms: 1000 + SHARE_WINDOW_MS }),
  }), env);
  assert.equal(fresh.status, 200);
});

test("the card renderer writes a 1200 by 630 PNG", async () => {
  const svg = cardSvg(sample({ name: `A<b>"&'` }));
  const root = new URL("..", import.meta.url);
  const rendered = await renderCardPng(svg, {
    wasm: new Uint8Array(readFileSync(new URL("node_modules/@resvg/resvg-wasm/index_bg.wasm", root))),
    regular: new Uint8Array(readFileSync(new URL("public/fonts/LiberationSans-Regular.ttf", root))),
    bold: new Uint8Array(readFileSync(new URL("public/fonts/LiberationSans-Bold.ttf", root))),
  });
  assert.equal(rendered.width, 1200);
  assert.equal(rendered.height, 630);
  assert.equal(rendered.png[0], 0x89);
  assert.equal(rendered.png[1], 0x50);
  assert.equal(rendered.png[2], 0x4e);
  assert.equal(rendered.png[3], 0x47);
  assert.ok(rendered.png.length > 1000);
});

test("social links are built from the share URL", () => {
  const links = shareLinks("https://typing.fluxer.my/s/body.sig", "84.2 WPM");
  assert.equal(links.length, 3);
  assert.ok(links[0].href.startsWith("https://twitter.com/intent/tweet?"));
  assert.ok(links[1].href.startsWith("https://www.reddit.com/submit?"));
  assert.ok(links[2].href.startsWith("https://www.facebook.com/sharer/sharer.php?"));
  for (const link of links) assert.ok(link.href.includes(encodeURIComponent("https://typing.fluxer.my/s/body.sig")));
});
