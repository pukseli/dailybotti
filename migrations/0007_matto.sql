-- Daily Mättö: draft 5 characters from 10 offers (half strong, half weak), then anonymous
-- round-robin votes under one hidden theme for the day. Standalone from the daily puzzle games;
-- placements land in category "matto" and do not affect overall scores.

CREATE TABLE matto_characters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL UNIQUE,
  strength TEXT NOT NULL CHECK (strength IN ('strong', 'weak')),
  added_by INTEGER NOT NULL,
  added_at TEXT NOT NULL
);
CREATE INDEX matto_characters_strength ON matto_characters(strength);

CREATE TABLE matto_themes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  text_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('serious', 'funny')),
  added_by INTEGER NOT NULL,
  added_at TEXT NOT NULL
);
CREATE INDEX matto_themes_kind ON matto_themes(kind);

-- One row per contest day. theme stays secret until closed_at is set.
CREATE TABLE matto_days (
  day TEXT PRIMARY KEY,
  theme_id INTEGER NOT NULL REFERENCES matto_themes(id),
  started_by INTEGER,
  announce_message_id INTEGER,
  vote_opened_at TEXT,
  vote_message_id INTEGER,
  closed_at TEXT
);
CREATE INDEX matto_days_closed_at ON matto_days(closed_at);

-- The 10 offered characters per player, in shuffled deal order (positions 0–9).
CREATE TABLE matto_offers (
  day TEXT NOT NULL,
  player_id INTEGER NOT NULL REFERENCES players(id),
  position INTEGER NOT NULL,
  character_id INTEGER NOT NULL REFERENCES matto_characters(id),
  decision TEXT CHECK (decision IS NULL OR decision IN ('keep', 'skip', 'forced')),
  decided_at TEXT,
  PRIMARY KEY (day, player_id, position)
);
CREATE INDEX matto_offers_player ON matto_offers(day, player_id);

-- Filled when the player has kept 5. label is the anonymous team name shown during voting.
CREATE TABLE matto_teams (
  day TEXT NOT NULL,
  player_id INTEGER NOT NULL REFERENCES players(id),
  label TEXT,
  draft_message_id INTEGER,
  completed_at TEXT,
  PRIMARY KEY (day, player_id)
);

CREATE TABLE matto_matchups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  team_a INTEGER NOT NULL REFERENCES players(id),
  team_b INTEGER NOT NULL REFERENCES players(id),
  UNIQUE (day, sort_order)
);
CREATE INDEX matto_matchups_day ON matto_matchups(day);

-- choice is the player_id of the team the voter picked (owners stay hidden in the UI).
CREATE TABLE matto_votes (
  matchup_id INTEGER NOT NULL REFERENCES matto_matchups(id),
  voter_id INTEGER NOT NULL REFERENCES players(id),
  choice INTEGER NOT NULL REFERENCES players(id),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (matchup_id, voter_id)
);

CREATE TABLE matto_ballots (
  day TEXT NOT NULL,
  voter_id INTEGER NOT NULL REFERENCES players(id),
  ballot_message_id INTEGER,
  cursor INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT,
  PRIMARY KEY (day, voter_id)
);
