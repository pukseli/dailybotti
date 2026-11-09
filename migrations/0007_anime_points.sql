-- Anime points awarded for anime awareness
CREATE TABLE anime_points (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  giver_id INTEGER REFERENCES players(id),
  receiver_id INTEGER NOT NULL REFERENCES players(id),
  amount INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_anime_points_receiver ON anime_points(receiver_id);
