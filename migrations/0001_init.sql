-- Key/value settings: the linked group and the bot's own username.
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Everyone who has sent a result. id is the Telegram user id.
CREATE TABLE players (
  id INTEGER PRIMARY KEY,
  first_name TEXT NOT NULL,
  last_name TEXT,
  username TEXT,
  created_at TEXT NOT NULL
);

-- One row per player, game and day. Only the first submission counts.
CREATE TABLE results (
  player_id INTEGER NOT NULL REFERENCES players(id),
  game TEXT NOT NULL,
  day TEXT NOT NULL,
  puzzle INTEGER,
  score INTEGER NOT NULL,
  max_score INTEGER NOT NULL,
  submitted_at TEXT NOT NULL,
  PRIMARY KEY (player_id, game, day)
);
CREATE INDEX results_day ON results(day);

-- One row per day that has results: the live board message and whether the podium has been posted.
CREATE TABLE days (
  day TEXT PRIMARY KEY,
  board_message_id INTEGER,
  board_text TEXT,
  board_claim_until TEXT,
  finalized_at TEXT
);
CREATE INDEX days_finalized ON days(finalized_at);

-- Final standings of a closed day, per game and overall. Feeds the all-time leaderboard.
CREATE TABLE placements (
  day TEXT NOT NULL,
  category TEXT NOT NULL,
  player_id INTEGER NOT NULL REFERENCES players(id),
  rank INTEGER NOT NULL,
  value REAL NOT NULL,
  PRIMARY KEY (day, category, player_id)
);
CREATE INDEX placements_player ON placements(player_id);
