import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { config } from "../src/api.js";
import worker from "../src/index.js";
import { build } from "../script/build.mjs";

const root = new URL("..", import.meta.url);
const built = await build();

function readDist(name) {
  return readFileSync(new URL(name, new URL("dist/", root)), "utf8");
}

function walk(dir) {
  const found = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...walk(path));
    else found.push(path);
  }
  return found;
}

test("the built pages point at hashed files that exist", () => {
  const index = readDist("index.html");
  const missing = readDist("404.html");
  const jsPath = `/a/${built.jsName}`;
  const cssPath = `/a/${built.cssName}`;
  assert.match(built.jsName, /^app\.[0-9a-f]{8}\.js$/);
  assert.match(built.cssName, /^styles\.[0-9a-f]{8}\.css$/);
  assert.match(index, new RegExp(`src="${jsPath}"`));
  assert.match(index, new RegExp(`href="${cssPath}"`));
  assert.match(missing, new RegExp(`href="${cssPath}"`));
  assert.equal(index.includes('src="/app.js"'), false);
  assert.equal(index.includes('href="/styles.css"'), false);
  const files = walk(built.distDir);
  assert.ok(files.some((path) => path.endsWith(built.jsName)));
  assert.ok(files.some((path) => path.endsWith(built.cssName)));
  assert.equal(files.some((path) => path.endsWith(".map")), false);
  assert.equal(files.some((path) => path.endsWith("/app.js") || path.endsWith(`${join("dist", "app.js")}`)), false);
});

test("the built home page has the sharing tags", () => {
  const index = readDist("index.html");
  const required = [
    "<title>Typing race</title>",
    'name="description" content="Race other Fluxer users on the same sentence. Desktop, mobile, and mouse-only cursor ladders."',
    'rel="canonical" href="https://typing.fluxer.my/"',
    'name="theme-color" content="#0e0e12"',
    'property="og:title" content="Typing race"',
    'property="og:description"',
    'property="og:type" content="website"',
    'property="og:url" content="https://typing.fluxer.my/"',
    'property="og:image" content="https://typing.fluxer.my/og.png"',
    'property="og:image:width" content="1200"',
    'property="og:image:height" content="630"',
    'property="og:image:alt" content="Purple rounded square with a white wave and a white caret, the Typing race mark."',
    'name="twitter:card" content="summary_large_image"',
    'name="twitter:title" content="Typing race"',
    'name="twitter:description"',
    'name="twitter:image" content="https://typing.fluxer.my/og.png"',
    'name="twitter:image:alt"',
    'rel="apple-touch-icon" href="/apple-touch-icon.png"',
    'rel="manifest" href="/manifest.webmanifest"',
    'rel="icon" href="/favicon.svg"',
    'rel="icon" href="/icon-32.png"',
  ];
  for (const tag of required) assert.ok(index.includes(tag), tag);
  assert.equal(index.includes("style="), false);
  assert.equal(index.includes("<style"), false);
  assert.equal(/<script(?![^>]*\bsrc=)/.test(index), false);
});

test("the manifest, robots file, and sitemap describe the public site", () => {
  const manifest = JSON.parse(readDist("manifest.webmanifest"));
  assert.equal(manifest.name, "Typing race");
  assert.equal(manifest.short_name, "Typing race");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.theme_color, "#0e0e12");
  assert.equal(manifest.background_color, "#0e0e12");
  assert.deepEqual(manifest.icons.map((icon) => icon.src), ["/icon-192.png", "/icon-512.png"]);
  for (const icon of manifest.icons) assert.equal(icon.src.startsWith("/"), true);

  const robots = readDist("robots.txt");
  assert.match(robots, /^Allow: \/$/m);
  assert.match(robots, /^Disallow: \/api\/$/m);
  assert.match(robots, /^Disallow: \/auth\/$/m);
  assert.match(robots, /^Disallow: \/ws$/m);
  assert.match(robots, /^Sitemap: https:\/\/typing\.fluxer\.my\/sitemap\.xml$/m);

  const sitemap = readDist("sitemap.xml");
  assert.match(sitemap, /<loc>https:\/\/typing\.fluxer\.my\/<\/loc>/);
  assert.equal(sitemap.includes("/api/"), false);

  const security = readDist(".well-known/security.txt");
  assert.match(security, /^Contact: mailto:security@fluxer.host$/m);
  assert.match(security, /Replace Contact/);
  assert.match(security, /^Expires: 2027-10-17T00:00:00\.000Z$/m);
});

test("hashed assets are immutable and the policy stays strict", () => {
  const headers = readDist("_headers");
  assert.match(headers, /\/a\/\*\n {2}Cache-Control: public, max-age=31536000, immutable/);
  assert.match(headers, /^\/\n {2}Cache-Control: no-cache/m);
  assert.match(headers, /script-src 'self'/);
  assert.match(headers, /style-src 'self'/);
  assert.equal(headers.includes("cloudflareinsights"), false);
  assert.equal(headers.includes("unsafe-inline"), false);
});

test("the 404 page is branded and /index.html redirects home", async () => {
  const missing = readDist("404.html");
  assert.match(missing, /<title>Typing race, page not found<\/title>/);
  assert.match(missing, /name="robots" content="noindex"/);
  assert.match(missing, /href="\/"/);
  assert.match(missing, /Back to the start/);
  assert.equal(missing.includes("style="), false);
  assert.equal(missing.includes("<script"), false);

  const wrangler = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
  assert.equal(wrangler.assets.directory, "./dist");
  assert.equal(wrangler.assets.not_found_handling, "404-page");
  assert.ok(wrangler.assets.run_worker_first.includes("/index.html"));

  for (const method of ["GET", "HEAD"]) {
    const response = await worker.fetch(new Request("https://typing.fluxer.my/index.html", { method }), {});
    assert.equal(response.status, 301);
    assert.equal(response.headers.get("location"), "/");
    assert.equal(response.headers.get("cache-control"), "public, max-age=3600");
  }

  const home = await worker.fetch(new Request("https://typing.fluxer.my/"), {});
  assert.equal(home.status, 404);
  assert.equal(await home.text(), "not found");

  const assetMiss = await worker.fetch(new Request("https://typing.fluxer.my/missing-page"), {
    ASSETS: {
      fetch() {
        return new Response("branded", { status: 404, headers: { "content-type": "text/html; charset=utf-8" } });
      },
    },
  });
  assert.equal(assetMiss.status, 404);
  assert.equal(await assetMiss.text(), "branded");
});

test("config can be cached briefly and the boot fetches stay parallel", () => {
  const response = config({});
  assert.equal(response.headers.get("cache-control"), "private, max-age=60");
  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(app, /Promise\.allSettled\(\[pullMe\(\), pullConfig\(\), pullBoard\(\), pullDaily\(\)\]\)/);
  assert.equal(app.includes("document.title = host"), false);
});
