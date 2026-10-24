-- Per-round breakdown as JSON (e.g. "[100,98,92,87,84]" for Size It Up,
-- or '["🫧","🐟","🦑","🏮","🌟","⬛","🤡"]' for Krillion). NULL for older rows or games without round breakdown.
ALTER TABLE results ADD COLUMN rounds_json TEXT;

-- The matched share block for this game, preserved for future re-parsing or deeper analysis.
ALTER TABLE results ADD COLUMN raw_text TEXT;
