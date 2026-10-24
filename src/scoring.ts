import { GAMES, type GameId } from "./games";

export interface DayResult {
  playerId: number;
  game: GameId;
  score: number;
  maxScore: number;
}

export interface Standing {
  playerId: number;
  value: number;
  rank: number;
}

export type Category = GameId | "overall";

/** Highest value first. Equal values share a rank and the next rank is skipped (1, 1, 3). */
export function rank(entries: { playerId: number; value: number }[]): Standing[] {
  const sorted = [...entries].sort((a, b) => b.value - a.value || a.playerId - b.playerId);
  return sorted.map((e) => ({ ...e, rank: 1 + sorted.filter((o) => o.value > e.value).length }));
}

/** Overall score: each game as a percentage of its maximum, summed (out of 300). A skipped game counts as 0. */
export function overallValue(results: DayResult[]): number {
  const sum = results.reduce((acc, r) => acc + (r.score / r.maxScore) * 100, 0);
  return Math.round(sum * 10) / 10;
}

/** Standings for each game and overall. Everyone who played at least one game appears in overall. */
export function dayStandings(results: DayResult[]): Map<Category, Standing[]> {
  const standings = new Map<Category, Standing[]>();
  for (const game of GAMES) {
    standings.set(
      game.id,
      rank(results.filter((r) => r.game === game.id).map((r) => ({ playerId: r.playerId, value: r.score }))),
    );
  }
  const byPlayer = new Map<number, DayResult[]>();
  for (const r of results) byPlayer.set(r.playerId, [...(byPlayer.get(r.playerId) ?? []), r]);
  standings.set(
    "overall",
    rank([...byPlayer].map(([playerId, rs]) => ({ playerId, value: overallValue(rs) }))),
  );
  return standings;
}

export const MEDALS = ["🥇", "🥈", "🥉"] as const;

export function placeMark(rank: number): string {
  return MEDALS[rank - 1] ?? `${rank}.`;
}
