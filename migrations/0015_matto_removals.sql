-- Global soft delete: retired characters are never dealt. Row, stats and history are kept.
ALTER TABLE matto_characters ADD COLUMN retired_at TEXT;

-- Personal removal: never deal this character to this player again (survives a "keep" vote).
CREATE TABLE matto_removed_characters (
  player_id INTEGER NOT NULL REFERENCES players(id),
  character_id INTEGER NOT NULL REFERENCES matto_characters(id),
  day TEXT NOT NULL,
  removed_at TEXT NOT NULL,
  PRIMARY KEY (player_id, character_id)
);

-- Group removal vote: one row per nominated character per round.
CREATE TABLE matto_removal_polls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id INTEGER NOT NULL REFERENCES matto_characters(id),
  day TEXT NOT NULL,
  message_id INTEGER,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'retired', 'kept')),
  resolved_at TEXT
);
CREATE INDEX matto_removal_polls_day ON matto_removal_polls(day);
CREATE UNIQUE INDEX matto_removal_polls_open ON matto_removal_polls(character_id) WHERE status = 'open';

CREATE TABLE matto_removal_votes (
  poll_id INTEGER NOT NULL REFERENCES matto_removal_polls(id),
  voter_id INTEGER NOT NULL REFERENCES players(id),
  choice TEXT NOT NULL CHECK (choice IN ('remove', 'keep')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (poll_id, voter_id)
);
