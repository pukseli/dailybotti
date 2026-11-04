import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { handleUpdate } from "../src/bot";
import { ensureDay, getSettings, insertResult, previousMinScoresBeforeDay, savePlacements, worstOverallByPlayer, worstResultsByGame } from "../src/db";
import { formatWorstAlert, renderPlayerWorstStats, renderWorstSummary, shamePlaceMark } from "../src/render";
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

describe("new worst personal score alerts", () => {
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

  it("formatWorstAlert formats all styles correctly and handles Krillion specifically", () => {
    const singleEraly = {
      playerId: anna.id,
      playerName: "Anna",
      records: [{ game: "eraly" as const, gameName: "Eraly", score: 110, maxScore: 700, prevMinScore: 190 }],
    };

    // Style A: Sarkastisen juhlallinen
    const outA = formatWorstAlert(singleEraly, 0);
    expect(outA[0]).toBe("🪠 <b>UUSI POHJANOTEERAUS!</b>");
    expect(outA[1]).toBe("Onnittelut Anna uudesta pohjanoteerauksesta! Tuloksesi pelissä Eraly (110/700) oli elämäsi huonoin.");

    // Style B: Urheiluselostus & aiempi pohja
    const outB = formatWorstAlert(singleEraly, 1);
    expect(outB[0]).toBe("📉 <b>POHJANOTEERAUS-HÄLYTYS:</b>");
    expect(outB[1]).toBe("Uusi ennätys pohjamudissa! Anna alitti aiemman rimansa pelissä Eraly (110/700) (aiempi pohja: 190/700).");

    // Style C: Häpeäpaalu & Paskapysti
    const outC = formatWorstAlert(singleEraly, 2);
    expect(outC[0]).toBe("💩 <b>HENKILÖKOHTAINEN POHJAKOSKETUS:</b>");
    expect(outC[1]).toBe("Lämpimät onnittelut Anna! Päivän suoritus pelissä Eraly (110/700) kirjataan virallisesti pelaajahistoriasi synkimmäksi hetkeksi.");

    // Style D without Krillion: RIMANALITUS
    const outD = formatWorstAlert(singleEraly, 3);
    expect(outD[0]).toBe("🤿 <b>RIMANALITUS:</b>");
    expect(outD[1]).toContain("Anna teki sen taas – mutta väärään suuntaan!");

    // Style D with Krillion: Sukellus tyssäsi koska Krillionissa yritetään sukeltaa syvälle!
    const krillionAlert = {
      playerId: ben.id,
      playerName: "Ben",
      records: [{ game: "krillion" as const, gameName: "Krillion", score: 0, maxScore: 700, prevMinScore: 30 }],
    };
    const outDKrillion = formatWorstAlert(krillionAlert, 3);
    expect(outDKrillion[0]).toBe("🤿 <b>SUKELLUS TYSSÄSI PINNAN ALLE:</b>");
    expect(outDKrillion[1]).toContain("Krillionissa piti sukeltaa syvälle valtamereen, mutta Ben jäi räpylät pystyssä pintavesiin kellumaan!");

    // Multiple games in Style A
    const multiAlert = {
      playerId: anna.id,
      playerName: "Anna",
      records: [
        { game: "eraly" as const, gameName: "Eraly", score: 10, maxScore: 700, prevMinScore: 190 },
        { game: "krillion" as const, gameName: "Krillion", score: 0, maxScore: 700, prevMinScore: 50 },
      ],
    };
    const outMulti = formatWorstAlert(multiAlert, 0);
    expect(outMulti[1]).toBe("Onnittelut Anna uudesta pohjanoteerauksesta! Tuloksesi peleissä Eraly (10/700) ja Krillion (0/700) olivat elämäsi huonoimmat.");
  });

  it("previousMinScoresBeforeDay returns correct minimum scores before day", async () => {
    await env.DB.prepare(
      "INSERT INTO players (id, first_name, username, created_at) VALUES (?, 'Anna', 'anna', '2026-10-01')",
    )
      .bind(anna.id)
      .run();

    await insertResult(env.DB, {
      player_id: anna.id,
      game: "eraly",
      day: "2026-10-20",
      puzzle: 5,
      score: 300,
      max_score: 700,
      submitted_at: "2026-10-20T10:00:00Z",
    });
    await insertResult(env.DB, {
      player_id: anna.id,
      game: "eraly",
      day: "2026-10-21",
      puzzle: 6,
      score: 150,
      max_score: 700,
      submitted_at: "2026-10-21T10:00:00Z",
    });

    const mins = await previousMinScoresBeforeDay(env.DB, "2026-10-22", [anna.id]);
    expect(mins).toEqual([{ player_id: anna.id, game: "eraly", min_score: 150 }]);
  });

  it("finalizeDay alerts when a player records a new personal worst score", async () => {
    // Setup players
    await env.DB.prepare(
      "INSERT INTO players (id, first_name, username, created_at) VALUES (?, 'Anna', 'anna', '2026-10-01'), (?, 'Ben', 'ben', '2026-10-01')",
    )
      .bind(anna.id, ben.id)
      .run();

    // Past results on 2026-10-20
    await insertResult(env.DB, {
      player_id: anna.id,
      game: "eraly",
      day: "2026-10-20",
      puzzle: 5,
      score: 200,
      max_score: 700,
      submitted_at: "2026-10-20T10:00:00Z",
    });

    // Today results on 2026-10-23: Anna scores 50 (new personal worst! 50 < 200)
    await insertResult(env.DB, {
      player_id: anna.id,
      game: "eraly",
      day: "2026-10-23",
      puzzle: 8,
      score: 50,
      max_score: 700,
      submitted_at: "2026-10-23T10:00:00Z",
    });
    // Ben plays for the first time: scores 100 (first time, so NOT a new personal worst alert)
    await insertResult(env.DB, {
      player_id: ben.id,
      game: "eraly",
      day: "2026-10-23",
      puzzle: 8,
      score: 100,
      max_score: 700,
      submitted_at: "2026-10-23T10:00:00Z",
    });

    await ensureDay(env.DB, "2026-10-23");

    const settings = await getSettings(env.DB);
    const { finalizeDay } = await import("../src/bot");
    await finalizeDay(makeCtx(tg, "2026-10-23T21:05:00Z"), settings, "2026-10-23");

    const text = tg.lastTextTo(GROUP);
    expect(text).toContain("🏁 <b>Results · Fri 23 Oct</b>");
    // Anna gets a new worst score alert
    expect(text).toMatch(/(POHJANOTEERAUS|POHJAKOSKETUS|RIMANALITUS)/);
    expect(text).toContain("Anna");
    expect(text).toContain("50/700");
    // Ben did not have past results so no alert for Ben
    expect(text).not.toContain("Onnittelut Ben");
  });
});
