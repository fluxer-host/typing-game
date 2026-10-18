-- Per-account lobby preferences. NULL means this account has not saved settings.
-- Safe to apply before the Worker that reads the column. Existing rows stay valid.

ALTER TABLE users ADD COLUMN settings TEXT;
