// Dev-only ladder seed for the local D1 database. Refuses --remote.
// Not used by the Worker, the build, or deploy.

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.argv.includes("--remote")) {
  console.error("seed-ladder refuses --remote");
  process.exit(1);
}

const today = new Date().toISOString().slice(0, 10);
const yesterdayMs = Date.parse(`${today}T00:00:00.000Z`) - 86_400_000;
const yesterday = new Date(yesterdayMs).toISOString().slice(0, 10);
const lines = [];

for (let i = 0; i < 60; i += 1) {
  const id = String(9_100_001 + i);
  const elo = 2060 - i;
  const avatar = i === 0 ? "'abc123'" : "NULL";
  const name = `Ladder ${String(i + 1).padStart(2, "0")}`;
  lines.push(
    `INSERT OR REPLACE INTO users (
      id, username, discriminator, global_name, avatar, avatar_color,
      elo_desktop, races_desktop, wins_desktop, best_wpm_desktop,
      elo_mobile, races_mobile, wins_mobile, best_wpm_mobile,
      elo_cursor, races_cursor, wins_cursor, best_wpm_cursor,
      created_at, updated_at
    ) VALUES (
      '${id}', 'ladder${i}', '0', '${name}', ${avatar}, NULL,
      ${elo}, 4, ${i % 3}, 40,
      1000, 0, 0, NULL,
      1000, 0, 0, NULL,
      1, 1
    );`,
  );
}

for (let i = 0; i < 30; i += 1) {
  const id = String(9_100_001 + i);
  lines.push(
    `INSERT OR REPLACE INTO daily_results (
      user_id, ladder, day, passage_id, wpm, accuracy, duration_ms, started_at, finished_at, created_at
    ) VALUES (
      '${id}', 'desktop', '${today}', 'seed', ${400 - i}, 99, ${10_000 + i}, 1, 2, ${i + 1}
    );`,
  );
}

for (let i = 0; i < 2; i += 1) {
  const id = String(9_100_001 + i);
  lines.push(
    `INSERT OR REPLACE INTO daily_results (
      user_id, ladder, day, passage_id, wpm, accuracy, duration_ms, started_at, finished_at, created_at
    ) VALUES (
      '${id}', 'desktop', '${yesterday}', 'seed', ${50 - i}, 95, 20000, 1, 2, ${100 + i}
    );`,
  );
}

const dir = mkdtempSync(join(tmpdir(), "ladder-seed-"));
const file = join(dir, "seed.sql");
writeFileSync(file, lines.join("\n"));

const result = spawnSync(
  process.execPath,
  ["node_modules/wrangler/bin/wrangler.js", "d1", "execute", "fluxer-typing-game", "--local", "--file", file],
  { stdio: "inherit" },
);
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(`seeded local ladder for ${today} (yesterday ${yesterday})`);
