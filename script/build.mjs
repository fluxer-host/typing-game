import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { brotliCompressSync, gzipSync } from "node:zlib";
import * as esbuild from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = join(root, "public");
const distDir = join(root, "dist");

const COPIED = [
  "_headers",
  "favicon.svg",
  "icon-32.png",
  "apple-touch-icon.png",
  "icon-192.png",
  "icon-512.png",
  "og.png",
  "robots.txt",
  "sitemap.xml",
  "manifest.webmanifest",
];

function hashedName(bytes, stem, ext) {
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 8);
  return `${stem}.${hash}.${ext}`;
}

function rewriteHtml(html, cssName, jsName) {
  const next = html
    .replaceAll('href="/styles.css"', `href="/a/${cssName}"`)
    .replaceAll('src="/app.js"', `src="/a/${jsName}"`);
  if (next.includes('href="/styles.css"') || next.includes('src="/app.js"')) {
    throw new Error("HTML still points at an unhashed stylesheet or script");
  }
  return next;
}

async function bundle(entry, options) {
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    minify: true,
    legalComments: "none",
    charset: "utf8",
    ...options,
  });
  if (result.outputFiles.length !== 1) {
    throw new Error(`expected one output for ${entry}, got ${result.outputFiles.length}`);
  }
  return result.outputFiles[0].contents;
}

export async function build() {
  const jsBytes = await bundle(join(sourceDir, "app.js"), {
    format: "esm",
    platform: "browser",
  });
  const cssBytes = await bundle(join(sourceDir, "styles.css"), {
    platform: "browser",
  });
  const jsName = hashedName(jsBytes, "app", "js");
  const cssName = hashedName(cssBytes, "styles", "css");
  const staging = join(root, "dist.tmp");

  await rm(staging, { recursive: true, force: true });
  await mkdir(join(staging, "a"), { recursive: true });
  await mkdir(join(staging, ".well-known"), { recursive: true });
  await mkdir(join(staging, "fonts"), { recursive: true });
  await writeFile(join(staging, "a", jsName), jsBytes);
  await writeFile(join(staging, "a", cssName), cssBytes);

  const index = await readFile(join(sourceDir, "index.html"), "utf8");
  const missing = await readFile(join(sourceDir, "404.html"), "utf8");
  const indexOut = rewriteHtml(index, cssName, jsName);
  const missingOut = rewriteHtml(missing, cssName, jsName);
  if (!indexOut.includes(`/a/${jsName}`) || !indexOut.includes(`/a/${cssName}`)) {
    throw new Error("built home page is missing a hashed asset");
  }
  if (!missingOut.includes(`/a/${cssName}`)) {
    throw new Error("built 404 page is missing the hashed stylesheet");
  }
  await writeFile(join(staging, "index.html"), indexOut);
  await writeFile(join(staging, "404.html"), missingOut);

  for (const name of COPIED) {
    await writeFile(join(staging, name), await readFile(join(sourceDir, name)));
  }
  for (const name of ["LiberationSans-Regular.ttf", "LiberationSans-Bold.ttf", "OFL.txt"]) {
    await writeFile(join(staging, "fonts", name), await readFile(join(sourceDir, "fonts", name)));
  }
  await writeFile(
    join(staging, ".well-known", "security.txt"),
    await readFile(join(sourceDir, ".well-known", "security.txt")),
  );

  await rm(distDir, { recursive: true, force: true });
  await rename(staging, distDir);

  const sourceJs = await readFile(join(sourceDir, "app.js"));
  const sourceCss = await readFile(join(sourceDir, "styles.css"));
  const graphNames = ["app.js", "input.js", "passage.js", "keys.js", "net.js"];
  const graph = Buffer.concat(await Promise.all(graphNames.map((name) => readFile(join(sourceDir, name)))));
  report("app.js", sourceJs, jsBytes, `a/${jsName}`);
  report("js graph", graph, jsBytes, `a/${jsName}`);
  report("styles.css", sourceCss, cssBytes, `a/${cssName}`);

  return { distDir, jsName, cssName, jsBytes, cssBytes };
}

function report(label, source, built, name) {
  const line = [
    label,
    `raw ${source.length} -> ${built.length}`,
    `gzip ${gzipSync(source).length} -> ${gzipSync(built).length}`,
    `brotli ${brotliCompressSync(source).length} -> ${brotliCompressSync(built).length}`,
    name,
  ].join(" | ");
  console.log(line);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await build();
}
