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

# name: (how often they play, how good they are, the local hour they usually play each game)
PLAYERS = {
    "Aino": (0.95, 0.80, {"eraly": 7, "krillion": 7, "sizeitup": 8}),  # with the morning coffee
    "Eero": (0.90, 0.70, {"eraly": 22, "krillion": 23, "sizeitup": 22}),  # night owl
    "Mikko": (0.75, 0.75, {"eraly": 12, "krillion": 12, "sizeitup": 17}),  # lunch break, then the commute
    "Lotta": (0.85, 0.62, {"eraly": 9, "krillion": 14, "sizeitup": 20}),  # spread over the day
    "Sanna": (0.55, 0.85, {"eraly": 18, "krillion": 18, "sizeitup": 18}),  # all at once after work
    "Ville": (0.40, 0.55, {"eraly": 16, "krillion": 21, "sizeitup": 1}),  # whenever, sometimes past midnight
}

# Krillion's dive row, one symbol per round (plan.md), with the round quality each one needs.
KRILLION = [("⬛", 0, 0.0), ("🫧", 10, 0.15), ("🤡", 15, 0.30), ("🐟", 30, 0.36), ("🦑", 60, 0.55), ("🏮", 85, 0.75), ("🌟", 100, 0.93)]

# Every sample day is in Finnish summer time (it ends 25 Oct 2026), so a fixed offset is exact here.
HELSINKI = timezone(timedelta(hours=3))


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
        for player, (name, (activity, skill, hours)) in enumerate(PLAYERS.items(), start=1):
            for game, (max_score, start) in GAMES.items():
                if day < start or rng.random() > activity:
                    continue
                share = min(1.0, max(0.05, rng.gauss(skill, 0.15)))
                rounds_json = None
                if game == "sizeitup":
                    rounds = [min(100, max(0, round(rng.gauss(share * 100, 10)))) for _ in range(5)]
                    score, rounds_json = sum(rounds), json.dumps(rounds)
                elif game == "krillion":
                    # The score is the sum of the seven symbols, as in a real share.
                    qualities = [rng.gauss(share - 0.2, 0.2) for _ in range(7)]
                    row = [max((k for k in KRILLION if q >= k[2]), key=lambda k: k[2], default=KRILLION[0]) for q in qualities]
                    score, rounds_json = sum(k[1] for k in row), json.dumps([k[0] for k in row], ensure_ascii=False)
                else:
                    score = round(share * max_score)
                puzzle = (day - start).days + 1 if game != "sizeitup" else None
                # Around their usual hour, clamped to the day: a result counts for the day it arrives.
                minute = min(24 * 60 - 1, max(0, round(rng.gauss(hours[game] * 60 + 30, 75))))
                local = datetime.combine(day, time(minute // 60, minute % 60), HELSINKI)
                submitted = local.astimezone(timezone.utc)
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
