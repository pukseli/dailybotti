import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { handleUpdate } from "../src/bot";
import { insertResult, savePlacements, worstOverallByPlayer, worstResultsByGame } from "../src/db";
import { renderPlayerWorstStats, renderWorstSummary, shamePlaceMark } from "../src/render";
import { shameRank } from "../src/scoring";
import {
  BOT_USERNAME,
  FakeTelegram,
  GROUP,
  anna,
  ben,
  chris,
  dm,
  inGroup,
  makeCtx,
  resetDb,
} from "./helpers";

const FRI_NOON = "2026-10-23T09:00:00Z";

describe("shame scoring and rendering", () => {
  it("shameRank orders lowest value first and handles ties with skips", () => {
    const entries = [
      { playerId: 1, value: 50 },
      { playerId: 2, value: 0 },
      { playerId: 3, value: 0 },
      { playerId: 4, value: 100 },
    ];
    const ranked = shameRank(entries);
    expect(ranked).toEqual([
      { playerId: 2, value: 0, rank: 1 },
      { playerId: 3, value: 0, rank: 1 },
      { playerId: 1, value: 50, rank: 3 },
      { playerId: 4, value: 100, rank: 4 },
    ]);
  });

  it("shamePlaceMark maps ranks to shame symbols", () => {
    expect(shamePlaceMark(1)).toBe("💩");
    expect(shamePlaceMark(2)).toBe("🪠");
    expect(shamePlaceMark(3)).toBe("🥔");
    expect(shamePlaceMark(4)).toBe("4.");
  });

  it("renderWorstSummary renders empty state nicely", () => {
    const text = renderWorstSummary({
      worstResults: [],
      worstOverall: [],
      names: new Map(),
    });
    expect(text).toContain("POHJANOTEERAUKSET · Hall of Shame");
    expect(text).toContain("Ei vielä tallennettuja tuloksia suljetuilta päiviltä.");
  });

  it("renderWorstSummary formats games and overall section", () => {
    const names = new Map([
      [anna.id, "Anna"],
      [ben.id, "Ben"],
    ]);
    const text = renderWorstSummary({
      worstResults: [
        { player_id: anna.id, game: "eraly", day: "2026-10-20", puzzle: 5, score: 0, max_score: 700 },
        { player_id: ben.id, game: "eraly", day: "2026-10-21", puzzle: 6, score: 100, max_score: 700 },
        { player_id: anna.id, game: "sizeitup", day: "2026-10-20", puzzle: null, score: 45, max_score: 500 },
      ],
      worstOverall: [
        { player_id: anna.id, day: "2026-10-20", score: 25.4 },
        { player_id: ben.id, day: "2026-10-21", score: 60.0 },
      ],
      names,
    });
    expect(text).toContain("POHJANOTEERAUKSET · Hall of Shame");
    expect(text).toContain("<b>Eraly</b>");
    expect(text).toContain("💩 Anna · 0/700");
    expect(text).toContain("🪠 Ben · 100/700");
    expect(text).toContain("<b>Size It Up</b>");
    expect(text).toContain("💩 Anna · 45/500");
    expect(text).toContain("🥄 <b>Overall (Mustin päivä)</b> (out of 300)");
    expect(text).toContain("💩 Anna · 25.4");
    expect(text).toContain("🪠 Ben · 60.0");
  });

  it("renderPlayerWorstStats renders a player disaster file", () => {
    const text = renderPlayerWorstStats({
      playerName: "Ben",
      results: [
        { player_id: ben.id, game: "eraly", day: "2026-10-21", puzzle: 6, score: 100, max_score: 700 },
      ],
      overall: { player_id: ben.id, day: "2026-10-21", score: 60.0 },
    });
    expect(text).toContain("POHJANOTEERAUKSET · Ben");
    expect(text).toContain("<b>Eraly</b>: 100/700");
    expect(text).toContain("<b>Krillion</b>: <i>ei tulosta</i>");
    expect(text).toContain("🥄 <b>Mustin päivä (Overall)</b>: 60.0 / 300");
  });
});

describe("/pohjat bot command", () => {
  let tg: FakeTelegram;

  beforeEach(async () => {
    await resetDb();
    tg = new FakeTelegram();
    await env.DB.prepare(
      "INSERT INTO settings (key, value) VALUES ('group_chat_id', ?), ('bot_username', ?), ('bot_id', '999')",
    )
      .bind(GROUP, BOT_USERNAME)
      .run();
  });

  it("handles /pohjat in group and private chat", async () => {
    // Add player results and finalized day placements
    await env.DB.prepare(
      "INSERT INTO players (id, first_name, username, created_at) VALUES (?, 'Anna', 'anna', '2026-10-01'), (?, 'Ben', 'ben', '2026-10-01')",
    )
      .bind(anna.id, ben.id)
      .run();

    await insertResult(env.DB, {
      player_id: anna.id,
      game: "eraly",
      day: "2026-10-20",
      puzzle: 5,
      score: 10,
      max_score: 700,
      submitted_at: "2026-10-20T10:00:00Z",
    });
    await insertResult(env.DB, {
      player_id: ben.id,
      game: "eraly",
      day: "2026-10-20",
      puzzle: 5,
      score: 250,
      max_score: 700,
      submitted_at: "2026-10-20T10:00:00Z",
    });

    await savePlacements(
      env.DB,
      "2026-10-20",
      [
        { category: "overall", playerId: anna.id, rank: 2, value: 45.0 },
        { category: "overall", playerId: ben.id, rank: 1, value: 80.0 },
      ],
      ["overall"],
    );

    // Call /pohjat in group
    await handleUpdate(makeCtx(tg, FRI_NOON), inGroup(anna, "/pohjat"));
    const groupReply = tg.lastTextTo(GROUP);
    expect(groupReply).toContain("POHJANOTEERAUKSET · Hall of Shame");
    expect(groupReply).toContain("💩 Anna · 10/700");
    expect(groupReply).toContain("🪠 Ben · 250/700");
    expect(groupReply).toContain("💩 Anna · 45.0");
    expect(groupReply).toContain("🪠 Ben · 80.0");

    // Call /pohjat in DM
    tg.clear();
    await handleUpdate(makeCtx(tg, FRI_NOON), dm(ben, "/pohjat"));
    expect(tg.lastTextTo(ben.id)).toContain("POHJANOTEERAUKSET · Hall of Shame");

    // Target a specific player
    tg.clear();
    await handleUpdate(makeCtx(tg, FRI_NOON), inGroup(ben, "/pohjat @anna"));
    const targetReply = tg.lastTextTo(GROUP);
    expect(targetReply).toContain("POHJANOTEERAUKSET · Anna");
    expect(targetReply).toContain("<b>Eraly</b>: 10/700");
    expect(targetReply).toContain("🥄 <b>Mustin päivä (Overall)</b>: 45.0 / 300");

    // Aliases work
    tg.clear();
    await handleUpdate(makeCtx(tg, FRI_NOON), inGroup(anna, "/jumbo"));
    expect(tg.lastTextTo(GROUP)).toContain("POHJANOTEERAUKSET · Hall of Shame");

    tg.clear();
    await handleUpdate(makeCtx(tg, FRI_NOON), inGroup(anna, "/pohjanoteeraus"));
    expect(tg.lastTextTo(GROUP)).toContain("POHJANOTEERAUKSET · Hall of Shame");

    tg.clear();
    await handleUpdate(makeCtx(tg, FRI_NOON), inGroup(anna, "/shame"));
    expect(tg.lastTextTo(GROUP)).toContain("POHJANOTEERAUKSET · Hall of Shame");
  });

  it("does not leak results from today if today is still unfinalized/open", async () => {
    await env.DB.prepare(
      "INSERT INTO players (id, first_name, username, created_at) VALUES (?, 'Anna', 'anna', '2026-10-01')",
    )
      .bind(anna.id)
      .run();

    // Anna played today (2026-10-23) and got 0
    await insertResult(env.DB, {
      player_id: anna.id,
      game: "eraly",
      day: "2026-10-23",
      puzzle: 8,
      score: 0,
      max_score: 700,
      submitted_at: "2026-10-23T08:00:00Z",
    });
    // Ensure day row is created and open (finalized_at is null)
    await env.DB.prepare("INSERT INTO days (day) VALUES ('2026-10-23')").run();

    await handleUpdate(makeCtx(tg, FRI_NOON), inGroup(ben, "/pohjat"));
    const text = tg.lastTextTo(GROUP);
    // Since today is not finalized and not closed yet, 2026-10-23 result should not be leaked
    expect(text).not.toContain("0/700");
    expect(text).toContain("Ei vielä tallennettuja tuloksia suljetuilta päiviltä.");
  });
});
