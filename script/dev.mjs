import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "./build.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

await build();

let timer = null;
let running = false;
let again = false;

async function rebuild() {
  if (running) {
    again = true;
    return;
  }
  running = true;
  try {
    do {
      again = false;
      await build();
    } while (again);
  } catch (error) {
    console.error(error);
  } finally {
    running = false;
  }
}

const watcher = watch(join(root, "public"), { recursive: true }, () => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    rebuild();
  }, 80);
});

const child = spawn(process.execPath, [
  join(root, "node_modules", "wrangler", "bin", "wrangler.js"),
  "dev",
  "--ip",
  "127.0.0.1",
  "--port",
  "8787",
], { cwd: root, stdio: "inherit" });

let stopping = false;

function stop() {
  if (stopping) return;
  stopping = true;
  clearTimeout(timer);
  watcher.close();
  child.kill("SIGTERM");
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
child.on("exit", (code) => {
  watcher.close();
  process.exit(code ?? 0);
});
