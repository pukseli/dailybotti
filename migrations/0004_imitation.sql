-- Imitation contest: every morning the bot draws a character or person to imitate, players post a voice
-- message in the group, and each player ranks the others privately (1st = 3 points, 2nd = 1 point).

-- Suggestions added with /ehdota. name_key is the lowercased name, so the same one can't be added twice.
-- used_on is the day it was drawn; NULL while it's still in the hat.
CREATE TABLE imitation_suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL UNIQUE,
  added_by INTEGER NOT NULL,
  added_at TEXT NOT NULL,
  used_on TEXT
);
CREATE INDEX imitation_suggestions_used_on ON imitation_suggestions(used_on);

-- One row per day once the draw has happened. suggestion_id is NULL when there was nothing to draw.
-- closed_at is set when the vote ends, or straight away when there is no contest that day.
CREATE TABLE imitation_days (
  day TEXT PRIMARY KEY,
  suggestion_id INTEGER REFERENCES imitation_suggestions(id),
  announce_message_id INTEGER,
  vote_opened_at TEXT,
  vote_message_id INTEGER,
  closed_at TEXT
);
CREATE INDEX imitation_days_closed_at ON imitation_days(closed_at);

-- Each player's recording: the group message holding it. The latest one before voting counts.
CREATE TABLE imitation_entries (
  day TEXT NOT NULL,
  player_id INTEGER NOT NULL REFERENCES players(id),
  message_id INTEGER NOT NULL,
  submitted_at TEXT NOT NULL,
  PRIMARY KEY (day, player_id)
);

-- Each player's private ballot. first_id gets 3 points and second_id 1 point.
CREATE TABLE imitation_votes (
  day TEXT NOT NULL,
  voter_id INTEGER NOT NULL REFERENCES players(id),
  first_id INTEGER,
  second_id INTEGER,
  ballot_message_id INTEGER,
  updated_at TEXT,
  PRIMARY KEY (day, voter_id)
);
