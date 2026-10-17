import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { saveStatements } from "../src/db.js";
import { planRating } from "../src/rating.js";

const MIGRATION = readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8");

function duel(id) {
  return {
    id,
    mode: "desktop",
    sentence: "I love Fluxer",
    ranked: true,
    startedAt: 1_000,
    finishedAt: 2_000,
    rows: [
      { id: "a", place: 1, wpm: 80, accuracy: 100, ms: 5000, progress: 13, finished: true, outcome: "finished", dq: false },
      { id: "b", place: 2, wpm: 60, accuracy: 100, ms: 8000, progress: 13, finished: true, outcome: "finished", dq: false },
    ],
  };
}

function runSql(statements, query) {
  const python = spawnSync("python3", ["-c", `
import json, sqlite3, sys
payload = json.load(sys.stdin)
db = sqlite3.connect(":memory:")
db.executescript(payload["migration"])
db.executescript(payload["setup"])
for statement in payload["statements"]:
    db.execute(statement["sql"], statement["binds"])
db.commit()
cur = db.execute(payload["query"])
cols = [col[0] for col in cur.description]
json.dump([dict(zip(cols, row)) for row in cur.fetchall()], sys.stdout)
`], {
    input: JSON.stringify({
      migration: MIGRATION,
      setup: `INSERT INTO users (id, username, discriminator, created_at, updated_at)
        VALUES ('a', 'Ada', '0', 1, 1), ('b', 'Bea', '0', 1, 1);`,
      statements,
      query,
    }),
    encoding: "utf8",
  });
  assert.equal(python.status, 0, python.stderr);
  return JSON.parse(python.stdout);
}

test("sqlite applies overlapping elo adds once and skips an unranked room", () => {
  const rows = duel("race-1").rows;
  const plan = planRating(rows, { ranked: true, elos: { a: 1000, b: 1000 }, pairCounts: {} });
  const room = {
    ...duel("room-1"),
    ranked: false,
    rows,
  };
  const roomPlan = planRating(rows, { ranked: false, elos: { a: 1000, b: 1000 }, pairCounts: {} });
  const lowRows = rows.map((row) => ({ ...row }));
  const lowPlan = planRating(lowRows, { ranked: true, elos: { a: 100, b: 100 }, pairCounts: {} });
  const low = { ...duel("race-low"), rows: lowRows };
  const statements = [
    ...saveStatements(duel("race-1"), plan),
    ...saveStatements(duel("race-2"), plan),
    ...saveStatements(duel("race-1"), plan),
    ...saveStatements(room, roomPlan),
  ];
  const users = runSql(statements, "SELECT id, elo_desktop, elo_mobile, races_desktop, wins_desktop FROM users ORDER BY id");
  assert.deepEqual(users, [
    { id: "a", elo_desktop: 1032, elo_mobile: 1000, races_desktop: 2, wins_desktop: 2 },
    { id: "b", elo_desktop: 968, elo_mobile: 1000, races_desktop: 2, wins_desktop: 0 },
  ]);
  const results = runSql(statements, "SELECT race_id, user_id, elo_before, elo_after FROM race_results ORDER BY race_id, user_id");
  const race1 = results.filter((row) => row.race_id === "race-1");
  assert.equal(race1.length, 2);
  assert.deepEqual(race1.map((row) => [row.user_id, row.elo_before, row.elo_after]), [
    ["a", 1000, 1016],
    ["b", 1000, 984],
  ]);
  assert.equal(results.filter((row) => row.race_id === "room-1" && row.elo_after == null).length, 2);
  const floored = runSql([
    "UPDATE users SET elo_desktop = 100",
    ...saveStatements(low, lowPlan),
    ...saveStatements(low, lowPlan),
  ].flatMap((statement) => (typeof statement === "string" ? [{ sql: statement, binds: [] }] : [statement])),
  "SELECT id, elo_desktop, races_desktop FROM users ORDER BY id");
  assert.equal(floored.find((row) => row.id === "b").elo_desktop, 100);
  assert.equal(floored.find((row) => row.id === "b").races_desktop, 1);
  assert.equal(floored.find((row) => row.id === "a").races_desktop, 1);
});
