# Friend-Rank Bot — Concept: Consistent Share Parser

Four friends play three daily browser games: **Magnitudle: Size It Up**, **Krillion** (the daily dive), and **Eraly**. The
group wants a Telegram-bot share-format workflow: friends paste each game's share text into the Telegram group, the bot
parses it, and reports how the four friends rank against each other. This creates hype and gives an easy push trigger,
replacing timed leaderboard polling.

## 1. The three share formats

### Krillion — verified (Krill-Bot grammar + live game samples)

```text
Krillion #93 🦐
225

🫧🦑🏮🫧🐟⬛🐟
```

- Header: daily number + 🦐; bare score line; blank line; one whitespace-free emoji row of exactly 7 symbols.
- Symbol point values: ⬛=0, 🫧=10, 🐟=30, 🦑=60, 🏮=85.
- Score can be cross-checked against the symbol sum.
- Reference implementation: `Krill-Bot` (github.com/TheScottBot/Krill-Bot, MIT) — `result_grammar.py`.

### Magnitudle: Size It Up — verified (recovered from production bundle chunk `mag-9f53db01da249033.js`)

```text
Size It Up
Overall Score 461

🟥🟥🟥🟥🟥 100
🟥🟥🟥🟥⬜ 98
🟥🟥🟥🟥🟥 92
🟥🟥🟥🟥⬜ 87
🟥🟥🟥🟥🟥 84
https://magnitudle.com/size-it-up
```

- Shape: `{label}\nOverall Score {total}\n\n{five round rows}\n{link}`.
- Round row: `{🟥 × round(score/20 clamped 0–5)}{⬜ × rest} {round score}` — five rounds, 0–100 each, total ≤500.
- Variants: `Size It Up`, `Size It Up: Pop Culture`, `Size It Up: Geography`; `Unlimited`/`Archive` append suffixes; the
link line changes per variant.
- A starred round adds a trailing `*` plus an extra `* {note}` line.
- No puzzle number or date in the text — the day is bound by the paste date (midnight caveat).

### Eraly — user-verified (eraly.io documentation & rules; not independently re-verified from this network)

```text
Eraly #N
Score: 485/700

[7-symbol outcome row]
https://eraly.io
```

- 7 questions (guessing historical event years), maximum score 700.
- Round tiers: 100 = Timekeeper (exact year), 85 = Chronicler (very close), 60 = Historian (close), 30 = Explorer (rough
guess), 10 = Tourist (any other attempt), 0 = Lost in time (timeout / no answer).
- Share text activates after question 7: daily key, total score (≤700), and a 7-symbol breakdown that does not spoil event
answers.

## 2. One architecture for all three

1. **One pure grammar module per game** (Krill-Bot pattern): single anchored regex with named groups, frozen dataclass
output, stable rejection enum — `TOO_LONG` (>2000 chars), `NOT_A_RESULT`, `SEVERAL_RESULTS`. Each parser accepts exactly
one result block per message, tolerates surrounding text, rejects ambiguity instead of guessing.
2. **Uniform record.** Every grammar normalizes to `{game, puzzle_key, score, breakdown, raw_text}` — storage and ranking
layers are game-agnostic. Adding a game means adding one grammar file.
3. **Identity comes from the sender, never the text.** The record binds to the Telegram `from_user`; a config maps the
four Telegram users to their game identities. Kills all name-matching problems.
4. **Per-game cross-validation:**
   - Krillion: score = recognised-symbol sum when the row is fully recognised ({0, 10, 30, 60, 85}).
   - Magnitudle: square count = `round(score/20)`; the five round scores sum to the overall score (≤500).
   - Eraly: total = sum of the 7 tier values ({0, 10, 30, 60, 85, 100}), bounded 0–700.
   - Mismatches accepted but flagged — game updates never break logging.
5. **Idempotent storage.** Keyed by (Telegram user, game, puzzle_key). A re-paste updates the row instead of duplicating.
6. **Puzzle keys.** Krillion: `#N` → date via the krillion.me API (dive #100 = 2026-10-23, verified anchor). Magnitudle:
local paste date. Eraly: `#N` from the header; paste date as fallback.

## 3. Push-trigger flow

Bot is a group member (privacy mode off) or friends DM it. On a valid paste: instant short confirmation with the parsed
score. `/standings` (or auto-reply once all four have pasted a game) posts the four-way comparison for that game. No
scheduled jobs anywhere in the design.

## 4. Format comparison

| Feature | Krillion | Size It Up | Eraly |
|---|---|---|---|
| Score location | bare line after header | `Overall Score N` | `Score: X/700` |
| Puzzle key | `#N` in text | none — paste date | `#N` in text (fallback: date) |
| Rounds | 7 symbols | 5 rows (0–100) | 7 rounds (max 700) |
| Cross-check | symbol-point sum | square formula + row sum | sum of 7 tiers |
| Status | verified | verified | user-verified (not independent) |

## 5. Open items

- **Eraly emoji mapping:** confirm the exact emoji for each tier (Timekeeper, Chronicler, Historian, Explorer, Tourist,
Lost in time) from the first real paste; tune the breakdown-row regex accordingly. Validate one real share text against
the tier sum before go-live.
- **Multi-variant days:** if a friend plays Pop Culture AND Geography the same day, the record's label keeps them ranked
separately.
- **Side note:** Eraly's tier set {0, 10, 30, 60, 85, 100} is identical to Krillion's symbol values + 100. Plausible but
unusual — verify from one real paste before release.
