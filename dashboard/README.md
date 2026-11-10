# Dashboard

A [marimo](https://marimo.io) notebook of the group's stats: player fact sheets, leaderboard, form over time,
consistency, who shows up and play patterns. It reads a snapshot of the bot's D1 database from `public/`, which
is never committed.

```sh
cd dashboard
uv run sample_data.py            # made-up data, no Cloudflare access needed
uv run snapshot.py               # or the real data (see below)
uv run marimo edit dashboard.py  # work on it
```

## Real data

`snapshot.py` uses wrangler, so log in once with `npx wrangler login`. The bot's database lives in a different
Cloudflare account than some of ours, and wrangler can't pick one by itself, so name it:

```sh
CLOUDFLARE_ACCOUNT_ID=<bot account id> uv run snapshot.py
```

The id is the one in the repo's `CLOUDFLARE_ACCOUNT_ID` GitHub secret, also shown by `npx wrangler whoami`.
It isn't a credential (nothing works with it alone), but this repo is public, so keep it out of committed files.

## What's on it

All sections follow the **Period** (last 7 days, last 30 days or all time, ending on the last day with results)
and **Players** pickers at the top. Times are Helsinki time.

- **Player fact sheets**: per player, how many game days they played, each game's share, their 💯 rounds in
  Size It Up, their Krillion symbol counts, and up to three tags (below).
- **Leaderboard**: overall podiums, days, average daily rank, average overall points (each game as a % of its
  max, summed, out of 300; a skipped game counts as 0), the last 14 days, and daily wins per game.
- **Form over time**: a 7-day average of the picked score per player, with each day as a dot.
- **How consistent everyone is**: box plots of every result as a % of the game's max.
- **Who shows up**: one box per day, player and game; a dash means the game wasn't in the group yet.
- **Play patterns**: a 24-hour clock per player; each hour's wedge is its share of their plays, games stacked.
- **All results**: the raw table, searchable.

### 💯 rounds (Size It Up)

`9 of 83` means 9 rounds scored exactly 100 out of the 83 Size It Up **rounds whose scores we know**, not out
of games. A game has 5 rounds, but the bot can only count the round lines that are in the pasted share, and
many shares have fewer or none: the old "Overall Score" format and the Magnitudle desktop format often come
without them. So the second number mostly says how complete someone's shares are, not how much they played.
On 2026-11-10 everyone had played 18 Size It Up games, yet had 83, 75, 48 and 31 known rounds.

### Krillion symbols

Each Krillion share has one symbol per round, which the fact sheets count. Best to worst, with points:
🌟 One in a Krillion 100, 🏮 Deep Cut 85, 🦑 Rare 60, 🐟 Schooler 30, 🤡 Too Clever 15, 🫧 Plankton 10,
⬛ Miss 0. The sources are in the repo's `plan.md`. 🌟 and 🤡 come only from a fan site and are still
unconfirmed: as of 2026-11-10 none of the group's 214 results has one, so the 🌟 One in a Krillion and
🤡 Too Clever tags can't be earned yet.

### Tags

Each player gets every tag whose rule fits, sorted by priority, and the sheet shows the **top 3**. Equal
priorities keep the order of the table below. Nobody with a tag gets **🎮 Regular** instead. Tags are worked
out among the picked players over the picked period, so they change with the pickers.

"Game days" means days in the period when anyone posted anything. "Results" counts games posted. "Most"
tags go to everyone tied for the top, and only with a value above 0.

| Priority | Tag | Rule | Minimum to qualify |
| --- | --- | --- | --- |
| 100 | 👑 Daily Champ | Most overall daily wins (1st place on the overall podium) | – |
| 92 | 🌟 One in a Krillion | Highest share of Krillion rounds that were 🌟 | 35 Krillion rounds |
| 90 | 💯 Bullseye | Highest share of known Size It Up rounds that scored 100 | 25 known rounds |
| 85 | 📅 Never Misses | Played at least 95% of game days | 5 days played |
| 80 at most | 🔥 On a Streak | Played every day up to the last day of the period, 5 days or more; priority 60 + streak length, capped at 80 | Not shown with 📅 Never Misses |
| 78 | 📊 Top Scorer | Highest average result as a % of the game's max | 5 results |
| 72 | 🎯 Steady Eddie | Smallest spread (standard deviation) of results as a % of max | 10 results, 2+ players |
| 66 | 🥈 Always the Bridesmaid | Most 2nd places on the overall podium | Not shown with 👑 Daily Champ |
| 62 | 📈 Heating Up | Overall points in the last 7 days at least 10% above their period average | 10 days played |
| 65–80 | ⏰ Last Minute Larry | At least 25% of plays between 23:00 and midnight; priority 60 + 20 × that share | 5 results |
| 67–80 | 🐦 Early Bird | At least 50% of plays between 05:00 and 10:00; priority 55 + 25 × that share | 5 results |
| 62–75 | 🦉 Night Owl | At least 50% of plays between 21:00 and 04:00; priority 50 + 25 × that share | 5 results, not a ⏰ Last Minute Larry |
| 58 | 🤡 Too Clever | Highest share of Krillion rounds that were 🤡 | 35 Krillion rounds and at least two 🤡 |
| 52 | ⚡ Speedrunner | On at least 60% of days with 2+ games, posted them all within 30 minutes | 5 results |
| 50 | 🛋️ Weekend Warrior | At least 45% of their game days are Saturdays or Sundays | 6 days played |
| 45 | 👻 Part-timer | Played under half of the game days | – |
| 0 | 🎮 Regular | Shown only when no other tag fits | – |

Hover a tag on the dashboard to see the numbers behind it. The rules live in the "Tags for the fact sheets"
cell of `dashboard.py`; keep this table in step when they change.

## Publishing

Live at https://dailybotti-dashboard.pages.dev since 2026-11-10, behind a Cloudflare Access login for the
group's emails (one-time PIN by email, one-month sessions). `.github/workflows/dashboard.yml` runs nightly at
22:15 UTC (00:15 Helsinki in winter, 01:15 in summer) and on demand from **Actions > Publish the stats
dashboard > Run workflow**: `snapshot.py`, `marimo export html-wasm --mode run`, then `wrangler pages deploy`
to the `dailybotti-dashboard` Pages project. The snapshot only holds the names players go by, never Telegram
ids, usernames or raw share text. `deploy.yml` ignores `dashboard/**` and this workflow, so dashboard changes
never redeploy the bot.

Setup, done by pukseli in the bot's Cloudflare account:

- The Pages project was created by hand and locked before the first upload. The workflow never creates it, so
  if it's ever deleted the deploy fails instead of publishing an open site.
- Cloudflare Access covers both `dailybotti-dashboard.pages.dev` and `*.dailybotti-dashboard.pages.dev`
  (preview deployments get their own URLs). To let someone new in, add their email to the policy on both.
- The workflow uses its own API token (*Cloudflare Pages: Edit*, *D1: Read*), saved as the repo secret
  `DASHBOARD_API_TOKEN`, plus the existing `CLOUDFLARE_ACCOUNT_ID`. Without the token it skips with a notice.

The browser version runs on Pyodide, which differs from local Python in a few ways (checked 2026-11-10):
great-tables isn't bundled, so the notebook installs it with micropip in the browser; the browser build of
polars has no `str.json_decode` and overflows `pl.date_range` (it's 32-bit), so those are done in plain Python;
and the box plots are three side-by-side charts because Vega-Lite ignored a facet's sort. Test changes with
`uv run marimo export html-wasm dashboard.py -o site --mode run` and `python -m http.server --directory site`
before pushing, since local `marimo edit` won't catch these. The first visit downloads about 30 MB (Python
plus polars), cached after that.
