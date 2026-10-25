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

## Publishing (TODO)

Not live yet. The plan: a daily GitHub Action takes a fresh snapshot, exports the notebook to static files
(it runs in the browser with Pyodide) and deploys them to Cloudflare Pages behind Cloudflare Access, so only
the group can open it. The snapshot only holds the names players go by, never Telegram ids, usernames or raw
share text.

### 1. Cloudflare (someone with access to the bot's account)

- [ ] **API token for CI.** Needs *Cloudflare Pages: Edit* and *D1: Read*. Either add those to the existing
      `CLOUDFLARE_API_TOKEN` secret's token or make a separate one (e.g. a `DASHBOARD_API_TOKEN` secret), which
      keeps the bot's token narrow.
- [ ] **Pages project.** `npx wrangler pages project create dailybotti-dashboard --production-branch main`
      (or let the first deploy create it).
- [ ] **Cloudflare Access** (Zero Trust, free up to 50 users). Add a self-hosted application covering **both**
      `dailybotti-dashboard.pages.dev` and `*.dailybotti-dashboard.pages.dev`; preview deployments get their
      own URLs and would otherwise be open. Policy: *Allow*, the group's emails. Login method: one-time PIN
      (optionally Google/GitHub). Session duration: e.g. one month.
- [ ] Check in a private window that both the main and a preview URL ask for a login.

### 2. Repo

- [ ] `.github/workflows/dashboard.yml`, roughly:
  - `on: schedule` with cron `15 22 * * *` (just after the day closes at midnight Helsinki in winter; that's
    21:00 UTC in summer, so it lands at 01:15 then) plus `workflow_dispatch` for manual runs.
  - Checkout, `astral-sh/setup-uv`, Node + `npm ci` (for wrangler).
  - `uv run snapshot.py` in `dashboard/`, with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from secrets
    in the environment.
  - `uv run marimo export html-wasm dashboard.py -o site --mode run`, then delete `site/CLAUDE.md` (a generic
    file marimo adds to every export).
  - `npx wrangler pages deploy dashboard/site --project-name dailybotti-dashboard --branch main`.
- [ ] `deploy.yml` already ignores `dashboard/**`, so dashboard commits don't redeploy the bot. Nothing to do.

### 3. Check before sharing the link

- [ ] Open the WASM export in a real browser (`python -m http.server --directory site`). Not yet verified:
      `great-tables` and polars time zones under Pyodide, the "Form over time" line chart, and the box plots'
      game order (Eraly, Krillion, Size It Up), which looked wrong in a static export.
- [ ] Load time and layout on a phone: the first visit downloads the Python runtime.
- [ ] Decide who goes on the Access allowlist, and whether daily is often enough (an hourly run costs nothing).
