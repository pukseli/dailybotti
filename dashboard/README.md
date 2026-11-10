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

## Publishing

Not live yet: waiting on the Cloudflare steps below. A nightly GitHub Action takes a fresh snapshot, exports the notebook to static files
(it runs in the browser with Pyodide) and deploys them to Cloudflare Pages behind Cloudflare Access, so only
the group can open it. The snapshot only holds the names players go by, never Telegram ids, usernames or raw
share text.

### 1. Cloudflare and GitHub (pukseli, who owns the bot's account and the repo)

- [ ] **Pages project**, created by hand and empty, so Access is in place before anything is uploaded:
      `npx wrangler pages project create dailybotti-dashboard --production-branch main`. The workflow never
      creates it, so a missing project makes the deploy fail rather than publish an open site.
- [ ] **Cloudflare Access** (Zero Trust, free up to 50 users) on **both** `dailybotti-dashboard.pages.dev` and
      `*.dailybotti-dashboard.pages.dev` (preview deployments get their own URLs). Policy: *Allow*, *Emails*: the
      group. Login method: one-time PIN (new Zero Trust accounts only have Cloudflare login, so add it).
      Session duration: one month.
- [ ] Check in a private window that both the main and a preview URL ask for a login.
- [ ] **API token for CI** with *Cloudflare Pages: Edit* and *D1: Read* on the bot's account, saved as the repo
      secret `DASHBOARD_API_TOKEN`. `CLOUDFLARE_ACCOUNT_ID` is already there.

### 2. Repo

- [x] `.github/workflows/dashboard.yml`: nightly at 22:15 UTC (00:15 Helsinki in winter, 01:15 in summer) plus
      a manual *Run workflow* button. Snapshot, `marimo export html-wasm`, `wrangler pages deploy`. It skips
      itself with a notice until `DASHBOARD_API_TOKEN` exists.
- [x] `deploy.yml` ignores `dashboard/**` and the dashboard workflow, so dashboard commits don't redeploy the bot.

### 3. Check before sharing the link

- [x] Open the WASM export in a real browser (checked 2026-11-10 in Chromium, desktop and phone width, with
      sample data). Fixed on the way: great-tables isn't bundled with Pyodide, so the notebook installs it with
      micropip in the browser; the browser build of polars has no `str.json_decode` and overflows
      `pl.date_range` (it's 32-bit), so those are done in Python; the box plots are three side-by-side charts
      because Vega-Lite ignored the facet's game order.
- [ ] Load time on a real phone: the first visit downloads about 30 MB (Python runtime + polars), cached after.
      Layout at phone width is fine; wide tables scroll sideways.
- [ ] Decide who goes on the Access allowlist, and whether daily is often enough (an hourly run costs nothing).
