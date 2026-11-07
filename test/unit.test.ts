import { describe, expect, it } from "vitest";
import { GAMES, dayForResult, gameTitle, parseResults, parseRoundData, puzzleNumberFor } from "../src/games";
import { displayNames, escapeHtml, renderLeaderboard } from "../src/render";
import type { StatsRow } from "../src/db";
import { dayStandings, overallValue, rank } from "../src/scoring";
import { addDays, dayLabel, isClosed, localParts } from "../src/time";
import { parseCommand } from "../src/bot";
import { eralyShare, krillionShare, sizeItUpShare } from "./helpers";

const [ERALY, KRILLION, SIZE_IT_UP] = GAMES;

describe("parseResults", () => {
  it("reads an Eraly share", () => {
    expect(parseResults(eralyShare(8, 420))).toEqual({ results: [{ game: "eraly", puzzle: 8, score: 420 }], rejected: [] });
  });

  it("reads Eraly at both ends of the scale", () => {
    expect(parseResults(eralyShare(8, 0)).results).toEqual([{ game: "eraly", puzzle: 8, score: 0 }]);
    expect(parseResults(eralyShare(12, 700)).results).toEqual([{ game: "eraly", puzzle: 12, score: 700 }]);
  });

  it("doesn't mistake the year for the score", () => {
    const text = "Eraly #9 · I travelled to 700 AD\n▰▱▱▱▱▱▱▱▱▱ 70/700\nhttps://eraly.io";
    expect(parseResults(text).results).toEqual([{ game: "eraly", puzzle: 9, score: 70 }]);
  });

  it("reads a Krillion share with and without the link", () => {
    expect(parseResults(krillionShare(100, 540)).results).toEqual([{ game: "krillion", puzzle: 100, score: 540 }]);
    expect(parseResults(krillionShare(100, 75, false)).results).toEqual([{ game: "krillion", puzzle: 100, score: 75 }]);
  });

  it("rejects Krillion unlimited, archive and themed games", () => {
    for (const mark of ["∞", "⟲", "🎃"]) {
      const out = parseResults(`Krillion ${mark} #12 🦐\n300\n\n🫧🐟🦑🏮🌟⬛🤡`);
      expect(out.results).toEqual([]);
      expect(out.rejected[0]).toContain("only the daily dive");
    }
  });

  it("reads a Size It Up share", () => {
    expect(parseResults(sizeItUpShare(437)).results).toEqual([{ game: "sizeitup", puzzle: null, score: 437 }]);
  });

  it("reads the new Magnitudle desktop Size It Up share format", () => {
    const text = [
      "Magnitudle — Size It Up",
      "2026-11-04",
      "",
      "Score: 461/500",
      "",
      "🟥🟥🟥🟥🟥 100",
      "🟥🟥🟥🟥⬜ 98",
      "🟥🟥🟥🟥🟥 92",
      "🟥🟥🟥🟥⬜ 87",
      "🟥🟥🟥🟥🟥 84",
      "",
      "https://magnitudle.com/size-it-up",
    ].join("\n");
    expect(parseResults(text).results).toEqual([{ game: "sizeitup", puzzle: null, score: 461 }]);
    expect(parseRoundData(text, "sizeitup")).toEqual({
      rounds: [100, 98, 92, 87, 84],
      rawText: text,
    });
  });

  it("reads Size It Up with a corrected-round note", () => {
    const text = "Size It Up\nOverall Score 455\n\n🟥🟥🟥🟥🟥 95*\n🟥🟥🟥🟥⬜ 90\n🟥🟥🟥🟥⬜ 90\n🟥🟥🟥🟥⬜ 90\n🟥🟥🟥🟥⬜ 90\n* Round 1 adjusted after an answer correction\nhttps://magnitudle.com/size-it-up";
    expect(parseResults(text).results).toEqual([{ game: "sizeitup", puzzle: null, score: 455 }]);

    const textNew = [
      "Magnitudle — Size It Up",
      "2026-11-04",
      "",
      "Score: 455/500",
      "",
      "🟥🟥🟥🟥🟥 95*",
      "🟥🟥🟥🟥⬜ 90",
      "🟥🟥🟥🟥⬜ 90",
      "🟥🟥🟥🟥⬜ 90",
      "🟥🟥🟥🟥⬜ 90",
      "",
      "* Round 1 adjusted after an answer correction",
      "",
      "https://magnitudle.com/size-it-up",
    ].join("\n");
    expect(parseResults(textNew).results).toEqual([{ game: "sizeitup", puzzle: null, score: 455 }]);
    expect(parseRoundData(textNew, "sizeitup")).toEqual({
      rounds: [95, 90, 90, 90, 90],
      rawText: textNew,
    });
  });

  it("reads Size It Up when the share sheet repeats the title", () => {
    expect(parseResults(`Size It Up\n\n${sizeItUpShare(300)}`).results).toEqual([{ game: "sizeitup", puzzle: null, score: 300 }]);
  });

  it("rounds a decimal Size It Up total", () => {
    expect(parseResults("Size It Up\nOverall Score 437.6\n").results[0]?.score).toBe(438);
    expect(parseResults("Magnitudle — Size It Up\n2026-11-04\n\nScore: 437.6/500\n").results[0]?.score).toBe(438);
  });

  it("rejects the other Size It Up modes", () => {
    const rejectedCases = [
      sizeItUpShare(400, "Size It Up: Pop Culture"),
      sizeItUpShare(400, "Size It Up: Geography"),
      sizeItUpShare(400, "Size It Up Unlimited"),
      sizeItUpShare(400, "Size It Up Archive · 2026-10-20"),
      "Magnitudle — Size It Up: Pop Culture\n2026-11-04\n\nScore: 400/500\n\nhttps://magnitudle.com/size-it-up/pop-culture",
      "Magnitudle — Size It Up: Geography\n2026-11-04\n\nScore: 400/500\n\nhttps://magnitudle.com/size-it-up/geography",
      "Magnitudle — Size It Up\n2026-11-04 · Unlimited\n\nScore: 400/500\n\nhttps://magnitudle.com/size-it-up/unlimited",
      "Magnitudle — Size It Up\n2026-11-04 · Practice\n\nScore: 400/500\n\nhttps://magnitudle.com/size-it-up?date=2026-11-01",
      "Magnitudle — Size It Up Archive\n2026-11-04 · Practice\n\nScore: 400/500\n\nhttps://magnitudle.com/size-it-up?date=2026-11-01",
    ];
    for (const text of rejectedCases) {
      const out = parseResults(text);
      expect(out.results).toEqual([]);
      expect(out.rejected[0]).toContain("Only the regular daily Size It Up counts");
    }
  });

  it("reads all three games from one message, including Windows line endings", () => {
    const text = [eralyShare(8, 640), krillionShare(100, 540), sizeItUpShare(402)].join("\n\n").replace(/\n/g, "\r\n");
    expect(parseResults(text).results).toEqual([
      { game: "eraly", puzzle: 8, score: 640 },
      { game: "krillion", puzzle: 100, score: 540 },
      { game: "sizeitup", puzzle: null, score: 402 },
    ]);
  });

  it("rejects impossible scores", () => {
    expect(parseResults("Eraly #8 · I travelled to 2026 AD\n▰▰▰▰▰▰▰▰▰▰ 800/700").results).toEqual([]);
    expect(parseResults("Krillion #100 🦐\n900\n").rejected).toHaveLength(1);
    expect(parseResults("Size It Up\nOverall Score 501").rejected).toHaveLength(1);
  });

  it("ignores ordinary chat", () => {
    expect(parseResults("Who's up for Krillion tonight? I got 540 yesterday")).toEqual({ results: [], rejected: [] });
    expect(parseResults("")).toEqual({ results: [], rejected: [] });
  });

  it("extracts per-round scores and raw share blocks with parseRoundData", () => {
    const sizeText = [
      "Size It Up",
      "Overall Score 461",
      "",
      "🟥🟥🟥🟥🟥 100",
      "🟥🟥🟥🟥⬜ 98*",
      "🟥🟥🟥🟥🟥 92",
      "🟥🟥🟥🟥⬜ 87",
      "🟥🟥🟥🟥🟥 84",
      "* Round 2 adjusted after an answer correction",
      "https://magnitudle.com/size-it-up",
    ].join("\n");
    expect(parseRoundData(sizeText, "sizeitup")).toEqual({
      rounds: [100, 98, 92, 87, 84],
      rawText: sizeText,
    });

    const krillText = krillionShare(100, 540);
    expect(parseRoundData(krillText, "krillion")).toEqual({
      rounds: ["🫧", "🐟", "🦑", "🏮", "🌟", "⬛", "🤡"],
      rawText: krillText,
    });

    const eralyTextOld = eralyShare(8, 420);
    expect(parseRoundData(eralyTextOld, "eraly")).toEqual({
      rounds: null,
      rawText: eralyTextOld,
    });

    const eralyTextNew = eralyShare(14, 510, "🟨🟩🟦🟧🟥🟨💤");
    expect(parseRoundData(eralyTextNew, "eraly")).toEqual({
      rounds: ["🟨", "🟩", "🟦", "🟧", "🟥", "🟨", "💤"],
      rawText: eralyTextNew,
    });

    const eralyHalloween = "Eraly #16 🎃 · I travelled to 1580 AD\n▰▰▰▰▰▰▰▱▱▱ 510/700\n🟨🟩🟦🟧🟥🟨💤\nhttps://eraly.io";
    expect(parseRoundData(eralyHalloween, "eraly")).toEqual({
      rounds: ["🟨", "🟩", "🟦", "🟧", "🟥", "🟨", "💤"],
      rawText: eralyHalloween,
    });
  });

  it("isolates each game's block and rounds from a combined multi-game message", () => {
    const combined = [eralyShare(8, 640, "🟨🟨🟨🟨🟨🟨💤"), krillionShare(100, 540), sizeItUpShare(402)].join("\n\n").replace(/\n/g, "\r\n");
    expect(parseRoundData(combined, "eraly")).toEqual({
      rounds: ["🟨", "🟨", "🟨", "🟨", "🟨", "🟨", "💤"],
      rawText: eralyShare(8, 640, "🟨🟨🟨🟨🟨🟨💤"),
    });
    expect(parseRoundData(combined, "krillion")).toEqual({
      rounds: ["🫧", "🐟", "🦑", "🏮", "🌟", "⬛", "🤡"],
      rawText: krillionShare(100, 540),
    });
    expect(parseRoundData(combined, "sizeitup")).toEqual({
      rounds: [80, 80, 80, 80, 80],
      rawText: sizeItUpShare(402),
    });
  });

  it("gracefully returns null rounds when a share text has only the overall score", () => {
    expect(parseRoundData("Size It Up\nOverall Score 437.6\n", "sizeitup")).toEqual({
      rounds: null,
      rawText: "Size It Up\nOverall Score 437.6",
    });
    expect(parseRoundData("Krillion #100 🦐\n540\n", "krillion")).toEqual({
      rounds: null,
      rawText: "Krillion #100 🦐\n540",
    });
  });
});

describe("time", () => {
  it("formats days", () => {
    expect(dayLabel("2026-10-23")).toBe("2026-10-23");
    expect(dayLabel("2027-01-01")).toBe("2027-01-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("converts to local time across the end of summer time", () => {
    // Finland leaves summer time (UTC+3 → UTC+2) on Sunday 25 Oct 2026 at 04:00.
    expect(localParts(new Date("2026-10-24T21:30:00Z"), "Europe/Helsinki")).toEqual({ date: "2026-10-25", time: "00:30" });
    expect(localParts(new Date("2026-10-25T21:30:00Z"), "Europe/Helsinki")).toEqual({ date: "2026-10-25", time: "23:30" });
    expect(localParts(new Date("2026-10-25T22:00:00Z"), "Europe/Helsinki")).toEqual({ date: "2026-10-26", time: "00:00" });
  });

  it("closes a day at midnight", () => {
    expect(isClosed("2026-10-23", new Date("2026-10-23T20:59:59Z"), "Europe/Helsinki", "00:00")).toBe(false);
    expect(isClosed("2026-10-23", new Date("2026-10-23T21:00:00Z"), "Europe/Helsinki", "00:00")).toBe(true);
    expect(isClosed("2026-10-24", new Date("2026-10-23T21:00:00Z"), "Europe/Helsinki", "00:00")).toBe(false);
  });

  it("closes a day at an evening time", () => {
    expect(isClosed("2026-10-23", new Date("2026-10-23T18:59:00Z"), "Europe/Helsinki", "22:00")).toBe(false);
    expect(isClosed("2026-10-23", new Date("2026-10-23T19:00:00Z"), "Europe/Helsinki", "22:00")).toBe(true);
  });
});

describe("puzzle numbers", () => {
  it("matches each game's own numbering", () => {
    expect(puzzleNumberFor(ERALY!, "2026-10-16")).toBe(1);
    expect(puzzleNumberFor(ERALY!, "2026-10-23")).toBe(8);
    expect(puzzleNumberFor(KRILLION!, "2026-07-16")).toBe(1);
    expect(puzzleNumberFor(KRILLION!, "2026-10-23")).toBe(100);
    expect(puzzleNumberFor(SIZE_IT_UP!, "2026-10-23")).toBeNull();
    expect(gameTitle(KRILLION!, "2026-10-23")).toBe("Krillion #100");
    expect(gameTitle(SIZE_IT_UP!, "2026-10-23")).toBe("Size It Up");
  });

  it("maps results to days", () => {
    expect(dayForResult({ game: "eraly", puzzle: 8, score: 1 }, "2026-10-23")).toBe("2026-10-23");
    expect(dayForResult({ game: "krillion", puzzle: 99, score: 1 }, "2026-10-23")).toBe("2026-10-22");
    expect(dayForResult({ game: "sizeitup", puzzle: null, score: 1 }, "2026-10-23")).toBe("2026-10-23");
  });
});

describe("scoring", () => {
  it("shares ranks on ties and skips the next", () => {
    expect(rank([{ playerId: 1, value: 600 }, { playerId: 2, value: 640 }, { playerId: 3, value: 640 }, { playerId: 4, value: 10 }]).map((s) => [s.playerId, s.rank])).toEqual([
      [2, 1],
      [3, 1],
      [1, 3],
      [4, 4],
    ]);
  });

  it("sums percentages for the overall score, counting a skipped game as 0", () => {
    expect(
      overallValue([
        { playerId: 1, game: "eraly", score: 640, maxScore: 700 },
        { playerId: 1, game: "krillion", score: 540, maxScore: 700 },
        { playerId: 1, game: "sizeitup", score: 402, maxScore: 500 },
      ]),
    ).toBe(249);
    expect(overallValue([{ playerId: 1, game: "sizeitup", score: 500, maxScore: 500 }])).toBe(100);
  });

  it("builds standings for every game and overall", () => {
    const s = dayStandings([
      { playerId: 1, game: "eraly", score: 700, maxScore: 700 },
      { playerId: 2, game: "eraly", score: 350, maxScore: 700 },
      { playerId: 2, game: "sizeitup", score: 500, maxScore: 500 },
    ]);
    expect(s.get("eraly")!.map((x) => x.playerId)).toEqual([1, 2]);
    expect(s.get("krillion")).toEqual([]);
    expect(s.get("overall")).toEqual([
      { playerId: 2, value: 150, rank: 1 },
      { playerId: 1, value: 100, rank: 2 },
    ]);
  });
});

describe("leaderboard medals", () => {
  const row = (player_id: number, category: StatsRow["category"], gold: number, silver: number, bronze: number): StatsRow => ({
    player_id,
    category,
    played: gold + silver + bronze + 1,
    gold,
    silver,
    bronze,
    average: 150,
    best: 200,
  });
  const names = new Map([
    [1, "Allu"],
    [2, "Könö"],
  ]);

  it("adds every event's medals together, leaving the daily podium out, and lists Mättö as its own event", () => {
    const text = renderLeaderboard(
      [
        row(1, "overall", 3, 0, 0),
        row(2, "overall", 0, 3, 0),
        row(1, "eraly", 2, 1, 0),
        row(2, "eraly", 1, 2, 0),
        row(1, "matto", 0, 1, 0),
        row(2, "matto", 1, 0, 0),
      ],
      names,
    );
    expect(text).toContain("1. Allu  🥇3 🥈0 🥉0 · 150.0 · 4"); // daily podium, unchanged
    expect(text).toContain("<b>Mitalit yhteensä</b> <i>(kaikki lajit)</i>\n1. Allu  🥇2 🥈2 🥉0 · 4 kpl\n2. Könö  🥇2 🥈2 🥉0 · 4 kpl");
    expect(text).toContain("<b>⚔️ Daily Mättö</b>\nKönö  🥇1 🥈0 🥉0\nAllu  🥇0 🥈1 🥉0");
    expect(text).not.toContain("Krillion"); // no Krillion placements yet
  });

  it("says when no day has finished yet", () => {
    expect(renderLeaderboard([], names)).toContain("Ei vielä päättyneitä päiviä.");
  });
});

describe("names and commands", () => {
  it("adds a last-name initial only when first names clash", () => {
    const names = displayNames([
      { id: 1, first_name: "Anna", last_name: "Korhonen", username: null, display_name: null },
      { id: 2, first_name: "Anna", last_name: "Virtanen", username: null, display_name: null },
      { id: 3, first_name: "Ben", last_name: null, username: null, display_name: null },
      { id: 4, first_name: "Sam", last_name: "K", username: "samk", display_name: null },
      { id: 5, first_name: "Sam", last_name: "K", username: null, display_name: null },
    ]);
    expect([...names.values()]).toEqual(["Anna K.", "Anna V.", "Ben", "Sam (@samk)", "Sam (#5)"]);
  });

  it("prefers a name chosen with /name", () => {
    const names = displayNames([
      { id: 1, first_name: "Anna", last_name: "Korhonen", username: null, display_name: "Karppi" },
      { id: 2, first_name: "Anna", last_name: "Virtanen", username: null, display_name: null },
      { id: 3, first_name: "Ben", last_name: null, username: null, display_name: "  " },
    ]);
    // The other Anna no longer needs an initial, and a blank chosen name falls back to the Telegram name.
    expect([...names.values()]).toEqual(["Karppi", "Anna", "Ben"]);
  });

  it("escapes HTML", () => {
    expect(escapeHtml("<b>Tom & Jerry</b>")).toBe("&lt;b&gt;Tom &amp; Jerry&lt;/b&gt;");
  });

  it("parses commands addressed to this bot only", () => {
    expect(parseCommand("/today", "PodiumBot")).toEqual({ kind: "command", name: "today" });
    expect(parseCommand("!today", "PodiumBot")).toEqual({ kind: "command", name: "today" });
    expect(parseCommand("/Today@podiumbot extra", "PodiumBot")).toEqual({ kind: "command", name: "today" });
    expect(parseCommand("/today@OtherBot", "PodiumBot")).toEqual({ kind: "other-bot" });
    expect(parseCommand("!today@OtherBot", "PodiumBot")).toEqual({ kind: "other-bot" });
    expect(parseCommand("Eraly #8", "PodiumBot")).toEqual({ kind: "none" });
    expect(parseCommand("/vote-leaderboard", "PodiumBot")).toEqual({ kind: "command", name: "vote_leaderboard" });
    expect(parseCommand("!vote-leaderboard", "PodiumBot")).toEqual({ kind: "command", name: "vote_leaderboard" });
    expect(parseCommand("/vote_leaderboard", "PodiumBot")).toEqual({ kind: "command", name: "vote_leaderboard" });
    expect(parseCommand("!vote_leaderboard", "PodiumBot")).toEqual({ kind: "command", name: "vote_leaderboard" });
    expect(parseCommand("/finalize", "PodiumBot")).toEqual({ kind: "command", name: "finalize" });
    expect(parseCommand("!finalize", "PodiumBot")).toEqual({ kind: "command", name: "finalize" });
    expect(parseCommand("/help", "PodiumBot")).toEqual({ kind: "command", name: "help" });
    expect(parseCommand("!help", "PodiumBot")).toEqual({ kind: "command", name: "komennot" });
    expect(parseCommand("/komennot", "PodiumBot")).toEqual({ kind: "command", name: "komennot" });
    expect(parseCommand("!komennot", "PodiumBot")).toEqual({ kind: "command", name: "komennot" });
  });
});
