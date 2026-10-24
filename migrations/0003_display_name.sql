-- A name the player chose with /name. Shown on the board, podiums, leaderboard and stats instead of
-- their Telegram first name. NULL means use the Telegram name.
ALTER TABLE players ADD COLUMN display_name TEXT;
