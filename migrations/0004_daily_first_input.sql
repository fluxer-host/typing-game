-- Daily score clock. The attempt window still uses started_at.
-- first_input_at is the server time of the first accepted key, or null when the page never reported one.

ALTER TABLE daily_attempts ADD COLUMN first_input_at INTEGER;
