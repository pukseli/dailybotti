import { describe, expect, it } from "vitest";
import {
  calculateRegression,
  checkBlowout,
  FALLBACK_EXPLANATIONS,
  generateExplanation,
  type Ai,
} from "../src/regressio";
import { renderRegressio, renderSummary } from "../src/render";
import type { ResultRow } from "../src/db";
import type { Standing } from "../src/scoring";

describe("calculateRegression", () => {
  it("handles empty results", () => {
    const stats = calculateRegression([]);
    expect(stats.totalPlayed).toBe(0);
    expect(stats.rawAverage).toBe(0);
    expect(stats.outlierCount).toBe(0);
    expect(stats.regressedAverage).toBe(0);
  });

  it("handles a single result", () => {
    const r: ResultRow = {
      player_id: 1,
      game: "eraly",
      day: "2026-10-24",
      puzzle: 1,
      score: 700,
      max_score: 700,
      submitted_at: "2026-10-24T12:00:00Z",
    };
    const stats = calculateRegression([r]);
    expect(stats.totalPlayed).toBe(1);
    expect(stats.rawAverage).toBe(5.0);
    expect(stats.outlierCount).toBe(1);
    expect(stats.regressedAverage).toBeLessThan(stats.rawAverage);
    expect(stats.dropPercent).toBeGreaterThan(0);
  });

  it("removes top 20% outliers and calculates regression correctly", () => {
    // 5 games: 1 perfect score (5.0 / 5.0) and 4 moderate scores (2.0 / 5.0)
    const results: ResultRow[] = [
      { player_id: 1, game: "eraly", day: "2026-10-20", puzzle: 1, score: 700, max_score: 700, submitted_at: "" },
      { player_id: 1, game: "eraly", day: "2026-10-21", puzzle: 2, score: 280, max_score: 700, submitted_at: "" },
      { player_id: 1, game: "eraly", day: "2026-10-22", puzzle: 3, score: 280, max_score: 700, submitted_at: "" },
      { player_id: 1, game: "eraly", day: "2026-10-23", puzzle: 4, score: 280, max_score: 700, submitted_at: "" },
      { player_id: 1, game: "eraly", day: "2026-10-24", puzzle: 5, score: 280, max_score: 700, submitted_at: "" },
    ];

    const stats = calculateRegression(results);
    expect(stats.totalPlayed).toBe(5);
    // Math.ceil(5 * 0.2) = 1 outlier
    expect(stats.outlierCount).toBe(1);
    expect(stats.outlierPuzzles[0]).toContain("eraly (700/700)");

    // Raw mean: (1.0 + 4 * 0.4) / 5 = 2.6 / 5 = 0.52 -> on 5-scale: 2.6
    expect(stats.rawAverage).toBe(2.6);
    // After removing 700/700: remaining 4 games are 0.4 -> 2.0
    expect(stats.regressedAverage).toBe(2.0);
    expect(stats.dropPercent).toBeCloseTo(23.1, 1);
  });

  it("scales outlier count for larger sets (10 games removes 2)", () => {
    const results: ResultRow[] = Array.from({ length: 10 }, (_, i) => ({
      player_id: 1,
      game: "sizeitup",
      day: `2026-10-0${i + 1}`,
      puzzle: null,
      score: i >= 8 ? 500 : 200,
      max_score: 500,
      submitted_at: "",
    }));

    const stats = calculateRegression(results);
    expect(stats.totalPlayed).toBe(10);
    expect(stats.outlierCount).toBe(2);
    expect(stats.regressedAverage).toBeLessThan(stats.rawAverage);
  });
});

describe("checkBlowout", () => {
  it("returns false for fewer than 2 players", () => {
    expect(checkBlowout([])).toEqual(expect.objectContaining({ isBlowout: false }));
    expect(checkBlowout([{ playerId: 1, value: 200, rank: 1 }])).toEqual(
      expect.objectContaining({ isBlowout: false }),
    );
  });

  it("returns false when margin is <= 20%", () => {
    const standings: Standing[] = [
      { playerId: 1, value: 120, rank: 1 },
      { playerId: 2, value: 100, rank: 2 },
    ];
    const res = checkBlowout(standings);
    expect(res.isBlowout).toBe(false);
    expect(res.marginPercent).toBe(20);
  });

  it("returns true when margin is strictly > 20%", () => {
    const standings: Standing[] = [
      { playerId: 1, value: 121, rank: 1 },
      { playerId: 2, value: 100, rank: 2 },
    ];
    const res = checkBlowout(standings);
    expect(res.isBlowout).toBe(true);
    expect(res.marginPercent).toBe(21);
  });

  it("handles second player with score 0 as blowout", () => {
    const standings: Standing[] = [
      { playerId: 1, value: 150, rank: 1 },
      { playerId: 2, value: 0, rank: 2 },
    ];
    const res = checkBlowout(standings);
    expect(res.isBlowout).toBe(true);
  });
});

describe("generateExplanation and fallbacks", () => {
  it("uses fallback when AI is undefined", async () => {
    const res = await generateExplanation(undefined, "Teemu", "player", "test details");
    expect(FALLBACK_EXPLANATIONS).toContain(res.explanation);
    expect(res.outlierLabel.length).toBeGreaterThan(0);
    expect(res.conclusion.length).toBeGreaterThan(0);
  });

  it("calls AI and parses structured response when provided", async () => {
    const mockAi: Ai = {
      run: async (_model, _input) => ({
        response:
          "KARSINTA: Hemohes-vilppiä\nJOHTOPÄÄTÖS: Sulaa harmaaksi massaksi\nLAUSUNTO: Matin tulokset sulavat kuin 5-1 johto Ruotsia vastaan.",
      }),
    };
    const res = await generateExplanation(mockAi, "Matti", "player", "details");
    expect(res.outlierLabel).toBe("Hemohes-vilppiä");
    expect(res.conclusion).toBe("Sulaa harmaaksi massaksi");
    expect(res.explanation).toBe("Matin tulokset sulavat kuin 5-1 johto Ruotsia vastaan.");
  });

  it("falls back gracefully if AI throws", async () => {
    const failingAi: Ai = {
      run: async () => {
        throw new Error("Rate limit exceeded");
      },
    };
    const res = await generateExplanation(failingAi, "Matti", "blowout", "details");
    expect(FALLBACK_EXPLANATIONS).toContain(res.explanation);
  });

  it("fallbacks do not contain NFL or Mahomes keywords", () => {
    for (const exp of FALLBACK_EXPLANATIONS) {
      expect(exp.toLowerCase()).not.toContain("mahomes");
      expect(exp.toLowerCase()).not.toContain("dak");
      expect(exp.toLowerCase()).not.toContain("nfl");
    }
  });
});

describe("renderRegressio", () => {
  it("renders report nicely in HTML with AI quips", () => {
    const html = renderRegressio({
      playerName: "Matti",
      stats: {
        totalPlayed: 5,
        rawAverage: 4.8,
        outlierCount: 1,
        regressedAverage: 2.1,
        dropPercent: 56.3,
        outlierPuzzles: ["eraly (700/700)"],
      },
      outlierLabel: "Hemohes-tason lääkärinlaukun antimia",
      conclusion: "Taantuu Juha Miedon tavoin ikuiseksi sadasosahäviäjäksi.",
      explanation: "Tulos sulaa kuin pito suojakelillä.",
    });

    expect(html).toContain("<b>REGRESSIOANALYYSI: Matti</b>");
    expect(html).toContain("4.8 / 5.0");
    expect(html).toContain("Hemohes-tason lääkärinlaukun antimia");
    expect(html).toContain("2.1 / 5.0");
    expect(html).toContain("-56.3%");
    expect(html).toContain("Taantuu Juha Miedon tavoin ikuiseksi sadasosahäviäjäksi.");
    expect(html).toContain("Tulos sulaa kuin pito suojakelillä.");
  });
});

describe("renderSummary with blowoutReport", () => {
  it("appends blowout warning when present", () => {
    const html = renderSummary({
      day: "2026-10-24",
      standings: new Map([
        [
          "overall",
          [
            { playerId: 1, value: 250, rank: 1 },
            { playerId: 2, value: 150, rank: 2 },
          ],
        ],
      ]),
      results: [],
      names: new Map([
        [1, "Voittaja"],
        [2, "Kakkonen"],
      ]),
      blowoutReport: {
        winnerName: "Voittaja",
        winnerScore: 250,
        secondScore: 150,
        marginPercent: 66.7,
        regressedScore: 140,
        explanation: "Puhdas suonenveto lääkärinlaukusta.",
      },
    });

    expect(html).toContain("🚨 <b>TILASTOVALVONTA: Epäilyttävä ylivoima havaittu!</b>");
    expect(html).toContain("Voittaja Voittaja oli 66.7% parempi");
    expect(html).toContain("140.0 pistettä");
    expect(html).toContain("Puhdas suonenveto lääkärinlaukusta.");
  });
});
