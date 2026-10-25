"""Write a made-up snapshot to public/ so the dashboard can be built without database access.

    uv run sample_data.py

Same columns as snapshot.py produces. Placements are ranked the way the bot ranks them
(src/scoring.ts): ties share a rank, and overall is each game as a percentage of its max, summed.
"""

import csv
import json
import random
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path

PUBLIC = Path(__file__).resolve().parent / "public"

# Mirrors src/games.ts. A game has no results before its first day in the group.
GAMES = {"eraly": (700, date(2026, 10, 16)), "krillion": (700, date(2026, 7, 16)), "sizeitup": (500, date(2026, 7, 16))}

# name: (how often they play, how good they are)
PLAYERS = {
    "Aino": (0.95, 0.80),
    "Eero": (0.90, 0.70),
    "Mikko": (0.75, 0.75),
    "Lotta": (0.85, 0.62),
    "Sanna": (0.55, 0.85),
    "Ville": (0.40, 0.55),
}


def rank(entries: dict[int, float]) -> list[tuple[int, float, int]]:
    ordered = sorted(entries.items(), key=lambda e: (-e[1], e[0]))
    return [(p, v, 1 + sum(o > v for o in entries.values())) for p, v in ordered]


def main() -> None:
    rng = random.Random(42)
    PUBLIC.mkdir(exist_ok=True)
    results, placements = [], []
    first, last = date(2026, 7, 16), date(2026, 10, 24)

    day = first
    while day <= last:
        day_results: dict[int, list[tuple[str, int, int]]] = {}
        for player, (name, (activity, skill)) in enumerate(PLAYERS.items(), start=1):
            for game, (max_score, start) in GAMES.items():
                if day < start or rng.random() > activity:
                    continue
                share = min(1.0, max(0.05, rng.gauss(skill, 0.15)))
                rounds_json = None
                if game == "sizeitup":
                    rounds = [min(100, max(0, round(rng.gauss(share * 100, 10)))) for _ in range(5)]
                    score, rounds_json = sum(rounds), json.dumps(rounds)
                else:
                    score = round(share * max_score)
                puzzle = (day - start).days + 1 if game != "sizeitup" else None
                submitted = datetime.combine(day, time(rng.randint(6, 22), rng.randint(0, 59)), timezone.utc)
                results.append(
                    {
                        "player": player,
                        "name": name,
                        "game": game,
                        "day": day.isoformat(),
                        "puzzle": puzzle,
                        "score": score,
                        "max_score": max_score,
                        "submitted_at": submitted.isoformat(),
                        "rounds_json": rounds_json,
                    }
                )
                day_results.setdefault(player, []).append((game, score, max_score))

        names = list(PLAYERS)
        for game in GAMES:
            scores = {p: s for p, rs in day_results.items() for g, s, _ in rs if g == game}
            for p, v, r in rank(scores):
                placements.append({"day": day.isoformat(), "category": game, "player": p, "name": names[p - 1], "rank": r, "value": v})
        overall = {p: round(sum(s / m * 100 for _, s, m in rs), 1) for p, rs in day_results.items()}
        for p, v, r in rank(overall):
            placements.append({"day": day.isoformat(), "category": "overall", "player": p, "name": names[p - 1], "rank": r, "value": v})
        day += timedelta(days=1)

    for name, rows in {"results": results, "placements": placements}.items():
        with (PUBLIC / f"{name}.csv").open("w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=list(rows[0]))
            writer.writeheader()
            writer.writerows(rows)
        print(f"{name}: {len(rows)} rows")
    snapshot_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    (PUBLIC / "meta.csv").write_text(f"snapshot_at,source\n{snapshot_at},sample\n", encoding="utf-8")


if __name__ == "__main__":
    main()
