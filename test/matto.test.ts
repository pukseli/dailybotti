import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { handleUpdate, tick } from "../src/bot";
import { COMMAND_MENUS } from "../src/commands";
import {
  buildDeal,
  buildMatchups,
  canSkip,
  isBallotComplete,
  matchupsForVoter,
  mattoPercent,
  mattoScores,
  mustKeep,
  shuffled,
} from "../src/matto";
import {
  BOT_USERNAME,
  FakeTelegram,
  GROUP,
  anna,
  ben,
  chris,
  dan,
  dm,
  eralyShare,
  inGroup,
  makeCtx,
  resetDb,
  tap,
} from "./helpers";
import type { User } from "../src/telegram";

const DAY = "2026-10-23";
const FRI_NOON = "2026-10-23T09:00:00Z";
const FRI_2100 = "2026-10-23T18:00:30Z";
const SAT_0001 = "2026-10-23T21:01:00Z";

const PLAYERS = [anna, ben, chris, dan];
let tg: FakeTelegram;

beforeEach(async () => {
  await resetDb();
  tg = new FakeTelegram();
  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES ('bot_username', ?), ('bot_id', '999'), ('command_menus', ?), ('group_chat_id', ?)",
  )
    .bind(BOT_USERNAME, COMMAND_MENUS, String(GROUP))
    .run();
});

async function register(now = FRI_NOON): Promise<void> {
  const scores = [640, 500, 450, 300];
  for (const [i, p] of PLAYERS.entries()) await handleUpdate(makeCtx(tg, now), dm(p, eralyShare(8, scores[i]!)));
}

function seq(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** Latest private keyboard message for a user (send or edit). */
function latestKeyboard(userId: number) {
  return [...tg.calls]
    .reverse()
    .find(
      (c) =>
        (c.method === "sendMessage" || c.method === "editMessageText") &&
        c.params.chat_id === userId &&
        c.params.reply_markup,
    )!;
}

function firstDraftMessageId(userId: number): number {
  return tg.sentTo(userId).find((c) => String(c.params.text).includes("Hahmo 1/10"))!.result.message_id as number;
}

function firstBallotMessageId(userId: number): number {
  return tg.sentTo(userId).find((c) => String(c.params.text).includes("äänestys"))!.result.message_id as number;
}

async function keepNext(user: User, messageId: number): Promise<void> {
  const card = latestKeyboard(user.id);
  const keep = (card.params.reply_markup.inline_keyboard as { callback_data: string }[][])
    .flat()
    .find((b) => b.callback_data.startsWith("mk:"))!;
  await handleUpdate(makeCtx(tg, FRI_NOON), tap(user, keep.callback_data, messageId));
}

async function draftFive(user: User): Promise<void> {
  const messageId = firstDraftMessageId(user.id);
  for (let i = 0; i < 5; i++) await keepNext(user, messageId);
}

describe("matto pure helpers", () => {
  it("shuffles without mutating the input", () => {
    const input = [1, 2, 3, 4, 5];
    const out = shuffled(input, seq(1));
    expect(input).toEqual([1, 2, 3, 4, 5]);
    expect(out).toHaveLength(5);
    expect(new Set(out)).toEqual(new Set(input));
  });

  it("forces keep when remaining offers equal open slots", () => {
    expect(mustKeep(4, 1)).toBe(true);
    expect(mustKeep(3, 2)).toBe(true);
    expect(mustKeep(3, 3)).toBe(false);
    expect(canSkip(3, 3)).toBe(true);
    expect(canSkip(4, 1)).toBe(false);
    expect(canSkip(4, 2)).toBe(true);
  });

  it("deals five strong and five weak then shuffles", () => {
    type Card = { id: number; strength: "strong" | "weak" };
    const strong: Card[] = Array.from({ length: 20 }, (_, i) => ({ id: i, strength: "strong" }));
    const weak: Card[] = Array.from({ length: 20 }, (_, i) => ({ id: 100 + i, strength: "weak" }));
    const deal = buildDeal(strong, weak, seq(42));
    expect(deal).toHaveLength(10);
    expect(deal.filter((c) => c.strength === "strong")).toHaveLength(5);
    expect(deal.filter((c) => c.strength === "weak")).toHaveLength(5);
  });

  it("builds a full round-robin of matchups", () => {
    const pairs = buildMatchups([1, 2, 3, 4], seq(7));
    expect(pairs).toHaveLength(6);
    const keys = new Set(pairs.map((p) => [p.teamA, p.teamB].sort().join("-")));
    expect(keys.size).toBe(6);
  });

  it("scores votes as points toward a percentage", () => {
    const matchups = [
      { id: 1, teamA: 1, teamB: 2 },
      { id: 2, teamA: 1, teamB: 3 },
      { id: 3, teamA: 2, teamB: 3 },
    ];
    // 3 teams → 1 eligible voter per matchup (everyone except the two playing)
    const votes = [
      { matchupId: 1, choice: 1 },
      { matchupId: 2, choice: 1 },
      { matchupId: 3, choice: 2 },
    ];
    const scores = mattoScores([1, 2, 3], matchups, votes);
    expect(scores.get(1)).toEqual({ points: 2, max: 2 });
    expect(mattoPercent(scores.get(1)!)).toBe(100);
    expect(matchupsForVoter(matchups, 1)).toEqual([{ id: 3, teamA: 2, teamB: 3 }]);
    expect(isBallotComplete(3, 3)).toBe(true);
    expect(isBallotComplete(2, 3)).toBe(false);
  });
});

describe("matto flow", () => {
  it("starts from /matto in the group and DMs a draft card", async () => {
    await register();
    await handleUpdate(makeCtx(tg, FRI_NOON), inGroup(anna, "/matto"));

    const announce = tg.sentTo(GROUP).map((c) => c.params.text as string).find((t) => t.includes("Daily Mättö alkaa"));
    expect(announce).toBeTruthy();

    const draft = tg.sentTo(anna.id).filter((c) => c.params.reply_markup).at(-1);
    expect(draft?.params.text).toContain("Daily Mättö");
    expect(draft?.params.text).toContain("Hahmo 1/10");

    const day = await env.DB.prepare("SELECT day, closed_at FROM matto_days WHERE day = ?").bind(DAY).first();
    expect(day).toEqual({ day: DAY, closed_at: null });

    const offers = await env.DB.prepare("SELECT COUNT(*) AS n FROM matto_offers WHERE day = ? AND player_id = ?")
      .bind(DAY, anna.id)
      .first<{ n: number }>();
    expect(offers?.n).toBe(10);
  });

  it("keeps and skips through a draft until five are chosen", async () => {
    await register();
    await handleUpdate(makeCtx(tg, FRI_NOON), inGroup(anna, "/matto"));
    await draftFive(anna);

    const team = await env.DB.prepare("SELECT completed_at FROM matto_teams WHERE day = ? AND player_id = ?")
      .bind(DAY, anna.id)
      .first<{ completed_at: string | null }>();
    expect(team?.completed_at).toBeTruthy();

    const kept = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM matto_offers WHERE day = ? AND player_id = ? AND decision IN ('keep', 'forced')",
    )
      .bind(DAY, anna.id)
      .first<{ n: number }>();
    expect(kept?.n).toBe(5);
  });

  it("accepts draft keep/skip as plain text without buttons", async () => {
    await register();
    await handleUpdate(makeCtx(tg, FRI_NOON), inGroup(anna, "/matto"));
    for (let i = 0; i < 5; i++) {
      await handleUpdate(makeCtx(tg, FRI_NOON), dm(anna, i % 2 === 0 ? "pidä" : "ohita"));
    }
    // May need more keeps if skips used — keep until done
    for (let guard = 0; guard < 10; guard++) {
      const team = await env.DB.prepare("SELECT completed_at FROM matto_teams WHERE day = ? AND player_id = ?")
        .bind(DAY, anna.id)
        .first<{ completed_at: string | null }>();
      if (team?.completed_at) break;
      await handleUpdate(makeCtx(tg, FRI_NOON), dm(anna, "pidä"));
    }
    const team = await env.DB.prepare("SELECT completed_at FROM matto_teams WHERE day = ? AND player_id = ?")
      .bind(DAY, anna.id)
      .first<{ completed_at: string | null }>();
    expect(team?.completed_at).toBeTruthy();
    const kept = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM matto_offers WHERE day = ? AND player_id = ? AND decision IN ('keep', 'forced')",
    )
      .bind(DAY, anna.id)
      .first<{ n: number }>();
    expect(kept?.n).toBe(5);
  });

  it("opens anonymous voting once everyone has drafted", async () => {
    await register();
    await handleUpdate(makeCtx(tg, FRI_NOON), inGroup(anna, "/matto"));
    for (const p of PLAYERS) await draftFive(p);

    const row = await env.DB.prepare("SELECT vote_opened_at FROM matto_days WHERE day = ?").bind(DAY).first<{ vote_opened_at: string | null }>();
    expect(row?.vote_opened_at).toBeTruthy();

    const matchups = await env.DB.prepare("SELECT COUNT(*) AS n FROM matto_matchups WHERE day = ?").bind(DAY).first<{ n: number }>();
    expect(matchups?.n).toBe(6);

    const ballot = tg.sentTo(ben.id).find((c) => String(c.params.text).includes("äänestys"));
    expect(ballot?.params.text).toContain("<b>Teema:</b>");
    expect(ballot?.params.text).not.toContain("Teema on salainen");
    expect(ballot?.params.text).not.toContain(anna.first_name);
    expect(ballot?.params.text).toMatch(/Vastaa <code>.+<\/code> tai <code>.+<\/code>/);
    // 4 players → each judges 3 matchups (not their own)
    expect(ballot?.params.text).toContain("Ottelu 1/3");
  });

  it("accepts votes as plain team-label text", async () => {
    await register();
    await handleUpdate(makeCtx(tg, FRI_NOON), inGroup(anna, "/matto"));
    for (const p of PLAYERS) await draftFive(p);

    for (const p of PLAYERS) {
      for (let i = 0; i < 3; i++) {
        const ballot = [...tg.calls]
          .reverse()
          .find(
            (c) =>
              (c.method === "sendMessage" || c.method === "editMessageText") &&
              c.params.chat_id === p.id &&
              String(c.params.text).includes("Ottelu"),
          );
        const text = String(ballot?.params.text ?? "");
        const m = /Ottelu \d+\/\d+: ([^<]+) vs ([^\n<]+)/.exec(text.replace(/<[^>]+>/g, ""));
        expect(m).toBeTruthy();
        await handleUpdate(makeCtx(tg, FRI_NOON), dm(p, m![1]!.trim()));
      }
    }

    const closed = await env.DB.prepare("SELECT closed_at FROM matto_days WHERE day = ?").bind(DAY).first<{ closed_at: string | null }>();
    expect(closed?.closed_at).toBeTruthy();
  });

  it("posts revealed results after everyone votes", async () => {
    await register();
    await handleUpdate(makeCtx(tg, FRI_NOON), inGroup(anna, "/matto"));
    for (const p of PLAYERS) await draftFive(p);

    for (const p of PLAYERS) {
      const messageId = firstBallotMessageId(p.id);
      for (let i = 0; i < 3; i++) {
        const ballot = latestKeyboard(p.id);
        const pick = (ballot.params.reply_markup.inline_keyboard as { callback_data: string }[][])
          .flat()
          .find((b) => b.callback_data.startsWith("mv:"));
        if (!pick) break;
        await handleUpdate(makeCtx(tg, FRI_NOON), tap(p, pick.callback_data, messageId));
      }
    }

    const closed = await env.DB.prepare("SELECT closed_at FROM matto_days WHERE day = ?").bind(DAY).first<{ closed_at: string | null }>();
    expect(closed?.closed_at).toBeTruthy();

    const results = tg.sentTo(GROUP).map((c) => c.params.text as string).find((t) => t.includes("tulokset"));
    expect(results).toContain("Teema:");
    expect(results).toContain(anna.first_name);

    const placements = await env.DB.prepare("SELECT COUNT(*) AS n FROM placements WHERE day = ? AND category = 'matto'")
      .bind(DAY)
      .first<{ n: number }>();
    expect(placements?.n).toBe(4);
  });

  it("resets an open vote with /mattonollaa and keeps drafts", async () => {
    await register();
    await handleUpdate(makeCtx(tg, FRI_NOON), inGroup(anna, "/matto"));
    for (const p of PLAYERS) await draftFive(p);

    const beforeTheme = await env.DB.prepare("SELECT theme_id FROM matto_days WHERE day = ?")
      .bind(DAY)
      .first<{ theme_id: number }>();
    expect(beforeTheme?.theme_id).toBeTruthy();

    // Cast one vote so ballots/votes exist
    const messageId = firstBallotMessageId(anna.id);
    const ballot = latestKeyboard(anna.id);
    const pick = (ballot.params.reply_markup.inline_keyboard as { callback_data: string }[][])
      .flat()
      .find((b) => b.callback_data.startsWith("mv:"))!;
    await handleUpdate(makeCtx(tg, FRI_NOON), tap(anna, pick.callback_data, messageId));

    tg.calls.length = 0;
    await handleUpdate(makeCtx(tg, FRI_NOON), inGroup(anna, "/mattonollaa"));

    const row = await env.DB.prepare("SELECT vote_opened_at, closed_at, theme_id FROM matto_days WHERE day = ?")
      .bind(DAY)
      .first<{ vote_opened_at: string | null; closed_at: string | null; theme_id: number }>();
    expect(row?.vote_opened_at).toBeTruthy();
    expect(row?.closed_at).toBeNull();
    expect(row?.theme_id).toBe(beforeTheme!.theme_id);

    const votes = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM matto_votes v JOIN matto_matchups m ON m.id = v.matchup_id WHERE m.day = ?",
    )
      .bind(DAY)
      .first<{ n: number }>();
    expect(votes?.n).toBe(0);

    const teams = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM matto_teams WHERE day = ? AND completed_at IS NOT NULL",
    )
      .bind(DAY)
      .first<{ n: number }>();
    expect(teams?.n).toBe(4);

    const fresh = tg.sentTo(ben.id).find((c) => String(c.params.text).includes("äänestys"));
    expect(fresh?.params.text).toContain("<b>Teema:</b>");
    expect(fresh?.params.text).toContain("Ottelu 1/3");

    const ack = tg.sentTo(GROUP).map((c) => c.params.text as string).find((t) => t.includes("nollattu"));
    expect(ack).toBeTruthy();
  });

  it("wipes the whole day with /mattonollaa kaikki", async () => {
    await register();
    await handleUpdate(makeCtx(tg, FRI_NOON), inGroup(anna, "/matto"));
    for (const p of PLAYERS) await draftFive(p);

    await handleUpdate(makeCtx(tg, FRI_NOON), inGroup(anna, "/mattonollaa kaikki"));

    const day = await env.DB.prepare("SELECT day FROM matto_days WHERE day = ?").bind(DAY).first();
    expect(day).toBeNull();
    const offers = await env.DB.prepare("SELECT COUNT(*) AS n FROM matto_offers WHERE day = ?").bind(DAY).first<{ n: number }>();
    expect(offers?.n).toBe(0);

    const ack = tg.sentTo(GROUP).map((c) => c.params.text as string).find((t) => t.includes("nollattu kokonaan"));
    expect(ack).toBeTruthy();
  });

  it("cancels at draft deadline if fewer than two teams finished", async () => {
    await register();
    await handleUpdate(makeCtx(tg, FRI_NOON), inGroup(anna, "/matto"));
    await draftFive(anna);

    await tick(makeCtx(tg, FRI_2100));
    const row = await env.DB.prepare("SELECT closed_at, vote_opened_at FROM matto_days WHERE day = ?")
      .bind(DAY)
      .first<{ closed_at: string | null; vote_opened_at: string | null }>();
    expect(row?.closed_at).toBeTruthy();
    expect(row?.vote_opened_at).toBeNull();
  });

  it("shows matto medals on /me without touching overall puzzle score", async () => {
    await register();
    await env.DB.prepare(
      "INSERT INTO placements (day, category, player_id, rank, value) VALUES (?, 'matto', ?, 1, 80)",
    )
      .bind(DAY, anna.id)
      .run();
    await env.DB.prepare(
      "INSERT INTO placements (day, category, player_id, rank, value) VALUES (?, 'overall', ?, 1, 200)",
    )
      .bind(DAY, anna.id)
      .run();

    await handleUpdate(makeCtx(tg, SAT_0001), inGroup(anna, "/me"));
    const me = tg.sentTo(GROUP).at(-1)?.params.text as string;
    expect(me).toContain("Daily Mättö");
    expect(me).toContain("Overall");
  });
});
