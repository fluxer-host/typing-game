CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  discriminator TEXT NOT NULL DEFAULT '0',
  global_name TEXT,
  avatar TEXT,
  avatar_color INTEGER,
  elo_desktop INTEGER NOT NULL DEFAULT 1000,
  elo_mobile INTEGER NOT NULL DEFAULT 1000,
  elo_cursor INTEGER NOT NULL DEFAULT 1000,
  races_desktop INTEGER NOT NULL DEFAULT 0,
  races_mobile INTEGER NOT NULL DEFAULT 0,
  races_cursor INTEGER NOT NULL DEFAULT 0,
  wins_desktop INTEGER NOT NULL DEFAULT 0,
  wins_mobile INTEGER NOT NULL DEFAULT 0,
  wins_cursor INTEGER NOT NULL DEFAULT 0,
  best_wpm_desktop REAL,
  best_wpm_mobile REAL,
  best_wpm_cursor REAL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  refresh_token TEXT,
  expires_at INTEGER NOT NULL
);

CREATE TABLE races (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  sentence TEXT NOT NULL,
  ranked INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER NOT NULL
);

CREATE TABLE race_results (
  race_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  place INTEGER NOT NULL,
  wpm REAL NOT NULL,
  accuracy REAL NOT NULL,
  ms INTEGER,
  progress INTEGER NOT NULL,
  elo_before INTEGER,
  elo_after INTEGER,
  PRIMARY KEY (race_id, user_id)
);

CREATE INDEX idx_results_user ON race_results (user_id, race_id);
