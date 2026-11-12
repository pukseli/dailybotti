-- Add wise character strength category, trim Marvel & Star Wars to top 30,
-- add Disney/DreamWorks/Pixar classics (max 4 per movie) and Finnish politicians.

-- 1. Trim Marvel (60 -> 30) and Star Wars (75 -> 30), plus minor Madagascar zoo background characters
UPDATE matto_offers SET character_id = (SELECT id FROM matto_characters WHERE name_key = 'iron man') WHERE character_id IN (SELECT id FROM matto_characters WHERE name_key IN ('vision', 'captain marvel', 'wasp', 'nightcrawler', 'gambit', 'rogue', 'colossus', 'kitty pryde', 'emma frost', 'apocalypse', 'sabretooth', 'mystique', 'hela', 'winter soldier', 'falcon', 'war machine', 'shang-chi', 'wong', 'moon knight', 'ms. marvel', 'she-hulk', 'elektra', 'silver surfer', 'galactus', 'ultron', 'red skull', 'killmonger', 'taskmaster', 'carnage', 'mysterio'));
DELETE FROM matto_characters WHERE name_key IN ('vision', 'captain marvel', 'wasp', 'nightcrawler', 'gambit', 'rogue', 'colossus', 'kitty pryde', 'emma frost', 'apocalypse', 'sabretooth', 'mystique', 'hela', 'winter soldier', 'falcon', 'war machine', 'shang-chi', 'wong', 'moon knight', 'ms. marvel', 'she-hulk', 'elektra', 'silver surfer', 'galactus', 'ultron', 'red skull', 'killmonger', 'taskmaster', 'carnage', 'mysterio');

UPDATE matto_offers SET character_id = (SELECT id FROM matto_characters WHERE name_key = 'darth vader') WHERE character_id IN (SELECT id FROM matto_characters WHERE name_key IN ('finn', 'poe dameron', 'bo-katan kryze', 'sabine wren', 'ezra bridger', 'darth revan', 'kit fisto', 'plo koon', 'aayla secura', 'asajj ventress', 'savage opress', 'cad bane', 'ig-11', 'k-2so', 'wicket', 'salacious crumb', 'nien nunb', 'ev-9d9', 'bib fortuna', 'max rebo', 'sy snootles', 'wuher', 'figrin d''an', 'ponda baba', 'dr. evazan', 'sebulba', 'watto', 'dexter jettster', 'boss nass', 'captain tarpals', 'battle droid', 'gonk droid', 'mouse droid', 'pit droid', 'ig-88', '4-lom', 'zuckuss', 'dengar', 'bossk', 'embo', 'chopper', 'l3-37', '0-0-0', 'bt-1', 'aphra'));
DELETE FROM matto_characters WHERE name_key IN ('finn', 'poe dameron', 'bo-katan kryze', 'sabine wren', 'ezra bridger', 'darth revan', 'kit fisto', 'plo koon', 'aayla secura', 'asajj ventress', 'savage opress', 'cad bane', 'ig-11', 'k-2so', 'wicket', 'salacious crumb', 'nien nunb', 'ev-9d9', 'bib fortuna', 'max rebo', 'sy snootles', 'wuher', 'figrin d''an', 'ponda baba', 'dr. evazan', 'sebulba', 'watto', 'dexter jettster', 'boss nass', 'captain tarpals', 'battle droid', 'gonk droid', 'mouse droid', 'pit droid', 'ig-88', '4-lom', 'zuckuss', 'dengar', 'bossk', 'embo', 'chopper', 'l3-37', '0-0-0', 'bt-1', 'aphra');

UPDATE matto_offers SET character_id = (SELECT id FROM matto_characters WHERE name_key = 'kuningas julien') WHERE character_id IN (SELECT id FROM matto_characters WHERE name_key IN ('mason', 'phil', 'marlene', 'joey', 'burt'));
DELETE FROM matto_characters WHERE name_key IN ('mason', 'phil', 'marlene', 'joey', 'burt');

-- Finnish names for Madagascar penguins
UPDATE matto_characters SET name = 'Kippari (Madagascar)', name_key = 'kippari' WHERE name_key = 'skipper';
UPDATE matto_characters SET name = 'Alokas (Madagascar)', name_key = 'alokas' WHERE name_key = 'private';

-- 2. Rebuild matto_characters to allow strength IN ('strong', 'weak', 'wise')
CREATE TABLE matto_offers_backup AS SELECT * FROM matto_offers;
DROP TABLE matto_offers;

CREATE TABLE matto_characters_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL UNIQUE,
  strength TEXT NOT NULL CHECK (strength IN ('strong', 'weak', 'wise')),
  added_by INTEGER NOT NULL,
  added_at TEXT NOT NULL
);

INSERT INTO matto_characters_new (id, name, name_key, strength, added_by, added_at)
SELECT id, name, name_key, strength, added_by, added_at FROM matto_characters;

DROP TABLE matto_characters;
ALTER TABLE matto_characters_new RENAME TO matto_characters;
CREATE INDEX matto_characters_strength ON matto_characters(strength);

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

INSERT INTO matto_offers (day, player_id, position, character_id, decision, decided_at)
SELECT day, player_id, position, character_id, decision, decided_at FROM matto_offers_backup;
DROP TABLE matto_offers_backup;

-- 3. Move existing wise characters to wise category
UPDATE matto_characters SET strength = 'wise' WHERE name_key IN ('gandalf', 'saruman', 'galadriel', 'elrond', 'puuparta', 'radagast', 'tom bombadil', 'albus dumbledore', 'hermione granger', 'minerva mcgonagall', 'severus snape', 'remus lupin', 'luna lovegood', 'firenze', 'aslan', 'väinämöinen', 'ilmarinen', 'odysseus', 'tyrion lannister', 'varys', 'petyr baelish', 'melisandre', 'samwell tarly', 'sansa stark', 'vesemir');
UPDATE matto_characters SET strength = 'wise' WHERE name_key IN ('yennefer', 'regis', 'triss merigold', 'yoda', 'obi-wan kenobi', 'qui-gon jinn', 'palpatine', 'grand admiral thrawn', 'c-3po', 'admiral ackbar', 'r2-d2', 'count dooku', 'padmé amidala', 'professor x', 'doctor strange', 'odin', 'nick fury', 'magneto', 'doctor doom', 'doctor octopus', 'loki', 'batman', 'lex luthor', 'brainiac', 'martian manhunter');
UPDATE matto_characters SET strength = 'wise' WHERE name_key IN ('ra''s al ghul', 'morpheus', 'optimus prime', 'bishop', 'mimir', 'athena', 'freya', 'tyr', 'cortana', 'zelda', 'mewtwo', 'rosalina', 'otacon', 'liara t''soni', 'tali''zorah', 'sylens', 'alphys', 'toriel', 'sans', 'l lawliet', 'light yagami', 'near', 'armin arlert', 'erwin smith', 'kakashi hatake');
UPDATE matto_characters SET strength = 'wise' WHERE name_key IN ('itachi uchiha', 'minato namikaze', 'trafalgar law', 'shanks', 'aizen sosuke', 'yamamoto genryusai', 'kurapika', 'chrollo lucilfer', 'meruem', 'netero', 'whis', 'piccolo', 'sherlock holmes', 'john watson', 'moriarty', 'mycroft holmes', 'irene adler', 'indiana jones', 'henry jones sr.', 'urho kekkonen', 'mannerheim', 'pelle peloton', 'roope ankka', 'nuuskamuikkunen', 'hemuli');
UPDATE matto_characters SET strength = 'wise' WHERE name_key IN ('muumipappa', 'muumimamma', 'kilpinen', 'isoäiti (bamse)', 'tikku', 'donatello', 'sanna orava', 'kaaren plankton', 'plankton', 'professor farnsworth', 'turanga leela', 'hermes conrad', 'stewie griffin', 'brian griffin', 'velma dinkley', 'dexter', 'mandark', 'the brain', 'dr. nefario', 'grand pabbie', 'kowalski');

-- 4. Insert new Disney, DreamWorks, Pixar, and Finnish politician characters
INSERT INTO matto_characters (name, name_key, strength, added_by, added_at) VALUES
  ('Mufasa (Leijonakuningas)', 'mufasa', 'strong', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Simba (Leijonakuningas)', 'simba', 'strong', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Scar (Leijonakuningas)', 'scar (leijonakuningas)', 'wise', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Rafiki (Leijonakuningas)', 'rafiki', 'wise', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Fa Mulan (Mulan)', 'fa mulan', 'strong', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Shan Yu (Mulan)', 'shan yu', 'strong', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Kapteeni Li Shang (Mulan)', 'kapteeni li shang', 'strong', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Mushu (Mulan)', 'mushu', 'weak', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Alex-leijona (Madagascar)', 'alex-leijona', 'strong', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Nana-mummo (Madagascar)', 'nana-mummo', 'strong', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Moto Moto (Madagascar)', 'moto moto', 'strong', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Maurice (Madagascar)', 'maurice', 'wise', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Po, Lohikäärmesoturi (Kung Fu Panda)', 'po, lohikäärmesoturi', 'strong', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Tai Lung (Kung Fu Panda)', 'tai lung', 'strong', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Suurmestari Oogway (Kung Fu Panda)', 'suurmestari oogway', 'wise', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Mestari Shifu (Kung Fu Panda)', 'mestari shifu', 'wise', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Kronk (Keisarin uudet kuviot)', 'kronk', 'strong', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Yzma (Keisarin uudet kuviot)', 'yzma', 'wise', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Keisari Kuzco (Keisarin uudet kuviot)', 'keisari kuzco', 'weak', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Pacha (Keisarin uudet kuviot)', 'pacha', 'weak', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

INSERT INTO matto_characters (name, name_key, strength, added_by, added_at) VALUES
  ('Hampaaton (Näin koulutat lohikäärmeesi)', 'hampaaton', 'strong', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Astrid (Näin koulutat lohikäärmeesi)', 'astrid (näin koulutat lohikäärmeesi)', 'strong', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Raivo Suuri (Näin koulutat lohikäärmeesi)', 'raivo suuri', 'strong', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Hikotus (Näin koulutat lohikäärmeesi)', 'hikotus', 'wise', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Tarzan (Tarzan)', 'tarzan', 'strong', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Clayton (Tarzan)', 'clayton (tarzan)', 'strong', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Jane Porter (Tarzan)', 'jane porter', 'wise', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Terk (Tarzan)', 'terk', 'weak', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Stitch (Lilo & Stitch)', 'stitch', 'strong', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Kapteeni Gantu (Lilo & Stitch)', 'kapteeni gantu', 'strong', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Jumba Jookiba (Lilo & Stitch)', 'jumba jookiba', 'wise', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Lilo Pelekai (Lilo & Stitch)', 'lilo pelekai', 'weak', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Tare / Sulley (Monsterit Oy)', 'tare / sulley', 'strong', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Räähkä / Randall Boggs (Monsterit Oy)', 'räähkä / randall boggs', 'strong', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Roz (Monsterit Oy)', 'roz', 'wise', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Masasi / Mike Wazowski (Monsterit Oy)', 'masasi / mike wazowski', 'weak', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Bruce-hai (Nemoa etsimässä)', 'bruce-hai', 'strong', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Gill (Nemoa etsimässä)', 'gill', 'wise', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Crush-kilpikonna (Nemoa etsimässä)', 'crush-kilpikonna', 'wise', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Dori (Nemoa etsimässä)', 'dori', 'weak', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

INSERT INTO matto_characters (name, name_key, strength, added_by, added_at) VALUES
  ('Herra Ihme (Ihmeperhe)', 'herra ihme', 'strong', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Rajaton / Elastigirl (Ihmeperhe)', 'rajaton / elastigirl', 'strong', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Syndrooma (Ihmeperhe)', 'syndrooma', 'wise', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Edna Mode (Ihmeperhe)', 'edna mode', 'wise', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Salama McQueen (Autot)', 'salama mcqueen', 'strong', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Doc Hudson (Autot)', 'doc hudson', 'wise', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Martti / Mater (Autot)', 'martti / mater', 'weak', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Luigi (Autot)', 'luigi (autot)', 'weak', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Anton Ego (Rottatouille)', 'anton ego', 'wise', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Rémy (Rottatouille)', 'rémy', 'wise', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Auguste Gusteau (Rottatouille)', 'auguste gusteau', 'wise', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Alfredo Linguini (Rottatouille)', 'alfredo linguini', 'weak', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('EVE (WALL-E)', 'eve (wall-e)', 'strong', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('AUTO-ruori (WALL-E)', 'auto-ruori', 'wise', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('WALL-E (WALL-E)', 'wall-e', 'weak', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('M-O, siivousrobotti (WALL-E)', 'm-o, siivousrobotti', 'weak', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Charles Muntz (Up – kohti korkeuksia)', 'charles muntz', 'strong', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Carl Fredricksen (Up – kohti korkeuksia)', 'carl fredricksen', 'wise', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Rasseli / Russell (Up – kohti korkeuksia)', 'rasseli / russell', 'weak', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Dug-koira (Up – kohti korkeuksia)', 'dug-koira', 'weak', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

INSERT INTO matto_characters (name, name_key, strength, added_by, added_at) VALUES
  ('Päivi Räsänen (Suomen politiikka)', 'päivi räsänen', 'wise', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Ano Turtiainen (Suomen politiikka)', 'ano turtiainen', 'strong', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Touko Aalto (Suomen politiikka)', 'touko aalto', 'weak', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Sheikki Laakso (Suomen politiikka)', 'sheikki laakso', 'weak', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Teuvo Hakkarainen (Suomen politiikka)', 'teuvo hakkarainen', 'weak', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Paavo Väyrynen (Suomen politiikka)', 'paavo väyrynen', 'wise', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Sauli Niinistö (Suomen politiikka)', 'sauli niinistö', 'wise', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Sanna Marin (Suomen politiikka)', 'sanna marin', 'wise', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Alexander Stubb (Suomen politiikka)', 'alexander stubb', 'wise', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Timo Soini (Suomen politiikka)', 'timo soini', 'wise', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Jussi Halla-aho (Suomen politiikka)', 'jussi halla-aho', 'wise', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Pekka Haavisto (Suomen politiikka)', 'pekka haavisto', 'wise', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Tarja Halonen (Suomen politiikka)', 'tarja halonen', 'wise', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Martti Ahtisaari (Suomen politiikka)', 'martti ahtisaari', 'wise', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Mauno Koivisto (Suomen politiikka)', 'mauno koivisto', 'wise', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Ben Zyskowicz (Suomen politiikka)', 'ben zyskowicz', 'wise', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Li Andersson (Suomen politiikka)', 'li andersson', 'wise', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Hjallis Harkimo (Suomen politiikka)', 'hjallis harkimo', 'weak', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Matti Vanhanen (Suomen politiikka)', 'matti vanhanen', 'weak', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Antti Rinne (Suomen politiikka)', 'antti rinne', 'weak', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

INSERT INTO matto_characters (name, name_key, strength, added_by, added_at) VALUES
  ('Petteri Orpo (Suomen politiikka)', 'petteri orpo', 'weak', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Riikka Purra (Suomen politiikka)', 'riikka purra', 'weak', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Ilkka Kanerva (Suomen politiikka)', 'ilkka kanerva', 'weak', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Ahti Karjalainen (Suomen politiikka)', 'ahti karjalainen', 'weak', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Veltto Virtanen (Suomen politiikka)', 'veltto virtanen', 'weak', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Tony Halme (Suomen politiikka)', 'tony halme', 'strong', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

