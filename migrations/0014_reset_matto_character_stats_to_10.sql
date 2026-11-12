-- Reset all character D&D stats (STR, DEX, CON, INT, WIS, CHA) to a flat starting value of 10.

DELETE FROM matto_stat_changes;
UPDATE matto_characters SET str = 10, dex = 10, con = 10, int = 10, wis = 10, cha = 10;
