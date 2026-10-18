-- Daily challenge scores. Existing tables are unchanged.
-- One scored row per account, ladder, and UTC day.

CREATE TABLE daily_attempts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  ladder TEXT NOT NULL,
  day TEXT NOT NULL,
  passage_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_daily_attempts_user ON daily_attempts (user_id, ladder, day, created_at);
CREATE INDEX idx_daily_attempts_started ON daily_attempts (started_at);

CREATE TABLE daily_results (
  user_id TEXT NOT NULL,
  ladder TEXT NOT NULL,
  day TEXT NOT NULL,
  passage_id TEXT NOT NULL,
  wpm REAL NOT NULL,
  accuracy REAL NOT NULL,
  duration_ms INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, ladder, day)
);

CREATE INDEX idx_daily_results_board ON daily_results (ladder, day, wpm DESC, accuracy DESC, duration_ms ASC);
CREATE INDEX idx_daily_results_created ON daily_results (created_at);
