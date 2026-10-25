"""Pull a snapshot of the bot's D1 database into public/ for the dashboard.

    uv run snapshot.py            # production database (needs Cloudflare credentials)
    uv run snapshot.py --local    # the local `wrangler dev` database

Only what the dashboard shows leaves the database: the name each player goes by, never their
Telegram id, username or last name, and never the raw share text.
"""

import argparse
import csv
import json
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path

DATABASE = "daily-games-bot"
REPO = Path(__file__).resolve().parent.parent
PUBLIC = Path(__file__).resolve().parent / "public"

# The same name the bot shows on boards: the /name choice, else the Telegram first name.
# Players get a small stable number so two people with the same first name stay apart.
PLAYER = """
  WITH p AS (SELECT id, COALESCE(display_name, first_name) AS name,
                    ROW_NUMBER() OVER (ORDER BY created_at, id) AS player FROM players)
"""

QUERIES = {
    "results": PLAYER
    + """
  SELECT p.player, p.name, r.game, r.day, r.puzzle, r.score, r.max_score, r.submitted_at, r.rounds_json
  FROM results r JOIN p ON p.id = r.player_id
  ORDER BY r.day, r.game, p.player
""",
    "placements": PLAYER
    + """
  SELECT pl.day, pl.category, p.player, p.name, pl.rank, pl.value
  FROM placements pl JOIN p ON p.id = pl.player_id
  ORDER BY pl.day, pl.category, pl.rank
""",
}


def query(sql: str, local: bool) -> list[dict]:
    npx = shutil.which("npx")
    if npx is None:
        raise SystemExit("npx not found: install Node.js")
    where = "--local" if local else "--remote"
    out = subprocess.run(
        [npx, "wrangler", "d1", "execute", DATABASE, where, "--json", "--command", " ".join(sql.split())],
        cwd=REPO,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    if out.returncode != 0:
        raise SystemExit(out.stderr or out.stdout)
    return json.loads(out.stdout)[0]["results"]


def write_csv(path: Path, rows: list[dict]) -> None:
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0]) if rows else [])
        writer.writeheader()
        writer.writerows(rows)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--local", action="store_true", help="read the local wrangler dev database")
    args = parser.parse_args()

    PUBLIC.mkdir(exist_ok=True)
    for name, sql in QUERIES.items():
        rows = query(sql, args.local)
        write_csv(PUBLIC / f"{name}.csv", rows)
        print(f"{name}: {len(rows)} rows")
    snapshot_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    (PUBLIC / "meta.csv").write_text(f"snapshot_at,source\n{snapshot_at},d1\n", encoding="utf-8")


if __name__ == "__main__":
    main()
