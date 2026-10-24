import { addDays, daysBetween } from "./time";

export type GameId = "eraly" | "krillion" | "sizeitup";

export interface Game {
  id: GameId;
  name: string;
  max: number;
  /** Date of puzzle #1, for games that number their puzzles. */
  firstDay?: string;
}

// Formats and numbering come from each game's own share code:
// - Eraly #1 is 16 Oct 2026, counted from the player's local midnight.
// - Krillion #1 is 16 Jul 2026, counted from midnight New York time.
// - Size It Up shares no number, so a result belongs to the day it arrives.
export const GAMES: readonly Game[] = [
  { id: "eraly", name: "Eraly", max: 700, firstDay: "2026-10-16" },
  { id: "krillion", name: "Krillion", max: 700, firstDay: "2026-07-16" },
  { id: "sizeitup", name: "Size It Up", max: 500 },
];

export function gameById(id: string): Game | undefined {
  return GAMES.find((g) => g.id === id);
}

export interface ParsedResult {
  game: GameId;
  puzzle: number | null;
  score: number;
}

export interface ParseOutcome {
  results: ParsedResult[];
  /** Explanations for results that were recognised but don't count, e.g. an Unlimited game. */
  rejected: string[];
}

// "Eraly #8 · I travelled to 1450 AD\n▰▰▰▰▰▰▱▱▱▱ 420/700\nhttps://eraly.io"
const ERALY = /Eraly\s*#\s*(\d+)[\s\S]{0,200}?(?<!\d)(\d+)\s*\/\s*700(?!\d)/;

// "Krillion #100 🦐\n540\n\n🫧🐟🦑🏮🌟⬛🤡\n\nhttps://krillion.io"
// Unlimited and archive games read "Krillion ∞ #12" / "Krillion ⟲ #12", which this deliberately doesn't match.
const KRILLION = /Krillion[ \t]+#\s*(\d+)[^\n]*\n\s*(\d+)(?![\d.,])/;
const KRILLION_OTHER = /Krillion[ \t]+[^\s#][^\n#]*#\s*\d+/;

// "Size It Up\nOverall Score 437\n\n🟥🟥🟥🟥⬜ 85\n...\nhttps://magnitudle.com/size-it-up"
// Pop Culture, Geography, Unlimited and Archive have a longer first line and don't match.
const SIZE_IT_UP = /(?:^|\n)[ \t]*Size It Up[ \t]*\n\s*Overall Score[ \t]*(\d+(?:[.,]\d+)?)/;
const SIZE_IT_UP_OTHER = /Size It Up[^\n]*\S[^\n]*\n\s*Overall Score/;

export function parseResults(input: string): ParseOutcome {
  const text = input.replace(/\r\n?/g, "\n");
  const results: ParsedResult[] = [];
  const rejected: string[] = [];

  const eraly = ERALY.exec(text);
  if (eraly) {
    const puzzle = Number(eraly[1]);
    const score = Number(eraly[2]);
    if (puzzle >= 1 && score <= 700) results.push({ game: "eraly", puzzle, score });
    else rejected.push("That Eraly result doesn't look right, so I skipped it.");
  }

  const krillion = KRILLION.exec(text);
  if (krillion) {
    const puzzle = Number(krillion[1]);
    const score = Number(krillion[2]);
    if (puzzle >= 1 && score <= 700) results.push({ game: "krillion", puzzle, score });
    else rejected.push("That Krillion result doesn't look right, so I skipped it.");
  } else if (KRILLION_OTHER.test(text)) {
    rejected.push("Krillion Unlimited, archive and themed games don't count, only the daily dive.");
  }

  const sizeItUp = SIZE_IT_UP.exec(text);
  if (sizeItUp) {
    const score = Math.round(Number(sizeItUp[1]!.replace(",", ".")));
    if (score <= 500) results.push({ game: "sizeitup", puzzle: null, score });
    else rejected.push("That Size It Up result doesn't look right, so I skipped it.");
  } else if (SIZE_IT_UP_OTHER.test(text)) {
    rejected.push("Only the regular daily Size It Up counts (not Pop Culture, Geography, Unlimited or Archive).");
  }

  return { results, rejected };
}

/** The day a result belongs to. Size It Up has no puzzle number, so it uses the day it arrived. */
export function dayForResult(result: ParsedResult, today: string): string {
  const game = gameById(result.game)!;
  if (game.firstDay && result.puzzle !== null) return addDays(game.firstDay, result.puzzle - 1);
  return today;
}

/** Puzzle number of a game on a day, or null for games without numbers. */
export function puzzleNumberFor(game: Game, day: string): number | null {
  if (!game.firstDay) return null;
  const n = daysBetween(game.firstDay, day) + 1;
  return n >= 1 ? n : null;
}

/** "Eraly #8", "Size It Up" */
export function gameTitle(game: Game, day: string): string {
  const n = puzzleNumberFor(game, day);
  return n === null ? game.name : `${game.name} #${n}`;
}
