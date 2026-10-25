# Dashboard

A [marimo](https://marimo.io) notebook of the group's stats: leaderboard, form over time, consistency and
participation. It reads a snapshot of the bot's D1 database from `public/`, which is never committed.

```sh
cd dashboard
uv run sample_data.py            # made-up data, no Cloudflare access needed
uv run snapshot.py               # or the real data (Cloudflare credentials, same as wrangler)
uv run marimo edit dashboard.py  # work on it
```

## Publishing

The dashboard runs entirely in the browser (Pyodide), so the site is just static files:

```sh
uv run marimo export html-wasm dashboard.py -o site --mode run
python -m http.server --directory site   # try it locally
```

The plan is a daily GitHub Action that runs `snapshot.py`, exports, and deploys `site/` to Cloudflare Pages
behind Cloudflare Access, so only the group can open it. The snapshot only holds the names players go by,
never Telegram ids, usernames or raw share text.
