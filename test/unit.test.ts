import { describe, expect, it } from "vitest";
import { GAMES, dayForResult, gameTitle, parseResults, puzzleNumberFor } from "../src/games";
import { displayNames, escapeHtml } from "../src/render";
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

  it("reads Size It Up with a corrected-round note", () => {
    const text = "Size It Up\nOverall Score 455\n\n🟥🟥🟥🟥🟥 95*\n🟥🟥🟥🟥⬜ 90\n🟥🟥🟥🟥⬜ 90\n🟥🟥🟥🟥⬜ 90\n🟥🟥🟥🟥⬜ 90\n* Round 1 adjusted after an answer correction\nhttps://magnitudle.com/size-it-up";
    expect(parseResults(text).results).toEqual([{ game: "sizeitup", puzzle: null, score: 455 }]);
  });

  it("reads Size It Up when the share sheet repeats the title", () => {
    expect(parseResults(`Size It Up\n\n${sizeItUpShare(300)}`).results).toEqual([{ game: "sizeitup", puzzle: null, score: 300 }]);
  });

  it("rounds a decimal Size It Up total", () => {
    expect(parseResults("Size It Up\nOverall Score 437.6\n").results[0]?.score).toBe(438);
  });

  it("rejects the other Size It Up modes", () => {
    for (const label of ["Size It Up: Pop Culture", "Size It Up: Geography", "Size It Up Unlimited", "Size It Up Archive · 2026-10-20"]) {
      const out = parseResults(sizeItUpShare(400, label));
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
});

describe("time", () => {
  it("formats days", () => {
    expect(dayLabel("2026-10-23")).toBe("Fri 23 Oct");
    expect(dayLabel("2027-01-01")).toBe("Fri 1 Jan");
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

describe("names and commands", () => {
  it("adds a last-name initial only when first names clash", () => {
    const names = displayNames([
      { id: 1, first_name: "Anna", last_name: "Korhonen", username: null },
      { id: 2, first_name: "Anna", last_name: "Virtanen", username: null },
      { id: 3, first_name: "Ben", last_name: null, username: null },
      { id: 4, first_name: "Sam", last_name: "K", username: "samk" },
      { id: 5, first_name: "Sam", last_name: "K", username: null },
    ]);
    expect([...names.values()]).toEqual(["Anna K.", "Anna V.", "Ben", "Sam (@samk)", "Sam (#5)"]);
  });

  it("escapes HTML", () => {
    expect(escapeHtml("<b>Tom & Jerry</b>")).toBe("&lt;b&gt;Tom &amp; Jerry&lt;/b&gt;");
  });

  it("parses commands addressed to this bot only", () => {
    expect(parseCommand("/today", "PodiumBot")).toEqual({ kind: "command", name: "today" });
    expect(parseCommand("/Today@podiumbot extra", "PodiumBot")).toEqual({ kind: "command", name: "today" });
    expect(parseCommand("/today@OtherBot", "PodiumBot")).toEqual({ kind: "other-bot" });
    expect(parseCommand("Eraly #8", "PodiumBot")).toEqual({ kind: "none" });
  });
});
