import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { handleUpdate, tick } from "../src/bot";
import { COMMAND_MENUS } from "../src/commands";
import {
  buildDeal,
  buildMatchups,
  canRemove,
  canSkip,
  computeMattoStatChanges,
  isBallotComplete,
  matchupsForVoter,
  mattoPercent,
  mattoScores,
  mustKeep,
  parseDraftTextChoice,
  removalOutcome,
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
  return tg.sentTo(userId).find((c) => String(c.params.text).includes("Hahmo 1/8"))!.result.message_id as number;
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

async function removeNext(user: User, messageId: number): Promise<void> {
  const card = latestKeyboard(user.id);
  const remove = (card.params.reply_markup.inline_keyboard as { callback_data: string }[][])
    .flat()
    .find((b) => b.callback_data.startsWith("mx:"))!;
  await handleUpdate(makeCtx(tg, FRI_NOON), tap(user, remove.callback_data, messageId));
}

async function skipNext(user: User, messageId: number): Promise<void> {
  const card = latestKeyboard(user.id);
  const skip = (card.params.reply_markup.inline_keyboard as { callback_data: string }[][])
    .flat()
    .find((b) => b.callback_data.startsWith("ms:"))!;
  await handleUpdate(makeCtx(tg, FRI_NOON), tap(user, skip.callback_data, messageId));
}

async function draftFive(user: User): Promise<void> {
  const messageId = firstDraftMessageId(user.id);
  for (let i = 0; i < 3; i++) await keepNext(user, messageId);
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
    expect(mustKeep(2, 1)).toBe(true);
    expect(mustKeep(1, 2)).toBe(true);
    expect(mustKeep(1, 3)).toBe(false);
    expect(canSkip(1, 3)).toBe(true);
    expect(canSkip(2, 1)).toBe(false);
    expect(canSkip(2, 2)).toBe(true);
  });

  it("determines whether a card can be removed", () => {
    // When replacement is available, remove is always allowed even if mustKeep is true
    expect(canRemove(2, 1, true)).toBe(true);
    expect(canRemove(1, 2, true)).toBe(true);
    expect(canRemove(0, 8, true)).toBe(true);

    // When replacement is already used (false), remove follows canSkip
    expect(canRemove(2, 1, false)).toBe(false);
    expect(canRemove(1, 2, false)).toBe(false);
    expect(canRemove(1, 3, false)).toBe(true);
    expect(canRemove(2, 2, false)).toBe(true);
  });

  it("calculates removal poll outcome based on majority of players", () => {
    // 4 players -> majority needed is Math.floor(4/2)+1 = 3
    expect(removalOutcome(3, 0, 4)).toBe("retired");
    expect(removalOutcome(3, 1, 4)).toBe("retired");
    expect(removalOutcome(2, 1, 4)).toBe("open");
    expect(removalOutcome(1, 1, 4)).toBe("open");
    // If 2 have voted keep, max possible remove is 4 - 2 = 2 < 3 -> kept!
    expect(removalOutcome(0, 2, 4)).toBe("kept");
    expect(removalOutcome(1, 2, 4)).toBe("kept");
    expect(removalOutcome(2, 2, 4)).toBe("kept");

    // 5 players -> majority needed is Math.floor(5/2)+1 = 3
    expect(removalOutcome(3, 0, 5)).toBe("retired");
    expect(removalOutcome(2, 2, 5)).toBe("open");
    expect(removalOutcome(1, 3, 5)).toBe("kept");
  });

  it("parses text choice including removal", () => {
    expect(parseDraftTextChoice("pidä")).toBe("k");
    expect(parseDraftTextChoice("p")).toBe("k");
    expect(parseDraftTextChoice("ohita")).toBe("s");
    expect(parseDraftTextChoice("o")).toBe("s");
    expect(parseDraftTextChoice("poista")).toBe("x");
    expect(parseDraftTextChoice("remove")).toBe("x");
    expect(parseDraftTextChoice("x")).toBe("x");
    expect(parseDraftTextChoice("del")).toBe("x");
    expect(parseDraftTextChoice("tuntematon")).toBe(null);
  });

  it("deals 2 strong, 2 weak, 2 wise, and 2 random cards then shuffles", () => {
    type Card = { id: number; strength: "strong" | "weak" | "wise" };
    const strong: Card[] = Array.from({ length: 20 }, (_, i) => ({ id: i, strength: "strong" }));
    const weak: Card[] = Array.from({ length: 20 }, (_, i) => ({ id: 100 + i, strength: "weak" }));
    const wise: Card[] = Array.from({ length: 20 }, (_, i) => ({ id: 200 + i, strength: "wise" }));
    const deal = buildDeal(strong, weak, wise, seq(42));
    expect(deal).toHaveLength(8);
    expect(new Set(deal.map((c) => c.id)).size).toBe(8);
    expect(deal.filter((c) => c.strength === "strong").length).toBeGreaterThanOrEqual(2);
    expect(deal.filter((c) => c.strength === "weak").length).toBeGreaterThanOrEqual(2);
    expect(deal.filter((c) => c.strength === "wise").length).toBeGreaterThanOrEqual(2);
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

  it("awards +1 to winners, -1 to last place, and 0 to ranks 2-3", () => {
    const standings = [
      { playerId: 101, rank: 1, value: 100 },
      { playerId: 102, rank: 2, value: 66.7 },
      { playerId: 103, rank: 3, value: 33.3 },
      { playerId: 104, rank: 4, value: 0 },
    ];
    const teamChars = new Map<number, number[]>([
      [101, [1, 2, 3]],
      [102, [4, 5, 6]],
      [103, [7, 8, 9]],
      [104, [10, 11, 12]],
    ]);
    const changes = computeMattoStatChanges(standings, teamChars, "int", "wis");
    expect(changes).toEqual([
      { characterId: 1, stat: "int", delta: 1 },
      { characterId: 2, stat: "int", delta: 1 },
      { characterId: 3, stat: "int", delta: 1 },
      { characterId: 10, stat: "wis", delta: -1 },
      { characterId: 11, stat: "wis", delta: -1 },
      { characterId: 12, stat: "wis", delta: -1 },
    ]);
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
    expect(draft?.params.text).toContain("Hahmo 1/8");
    expect(draft?.params.text).not.toContain("STR ");

    const day = await env.DB.prepare("SELECT day, closed_at FROM matto_days WHERE day = ?").bind(DAY).first();
    expect(day).toEqual({ day: DAY, closed_at: null });

    const offers = await env.DB.prepare("SELECT COUNT(*) AS n FROM matto_offers WHERE day = ? AND player_id = ?")
      .bind(DAY, anna.id)
      .first<{ n: number }>();
    expect(offers?.n).toBe(8);
  });

  it("keeps and skips through a draft until three are chosen", async () => {
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
    expect(kept?.n).toBe(3);
  });

  it("accepts draft keep/skip as plain text without buttons", async () => {
    await register();
    await handleUpdate(makeCtx(tg, FRI_NOON), inGroup(anna, "/matto"));
    for (let i = 0; i < 4; i++) {
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
    expect(kept?.n).toBe(3);
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
    expect(ballot?.params.text).not.toContain("STR ");
    expect(ballot?.params.text).not.toContain("Panos:");
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
    expect(results).toContain("Statsimuutokset:");
    expect(results).toContain(anna.first_name);

    const statChanges = await env.DB.prepare("SELECT COUNT(*) AS n FROM matto_stat_changes WHERE day = ?")
      .bind(DAY)
      .first<{ n: number }>();
    expect(statChanges?.n).toBeGreaterThan(0);

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

  it("plays a full /testimatto game without saving anything to the database", async () => {
    await register();
    await handleUpdate(makeCtx(tg, FRI_NOON), inGroup(anna, "/testimatto"));

    const announce = tg.sentTo(GROUP).map((c) => c.params.text as string).find((t) => t.includes("(testipeli)"));
    expect(announce).toBeTruthy();

    for (const p of PLAYERS) await draftFive(p);

    for (const p of PLAYERS) {
      const messageId = firstBallotMessageId(p.id);
      for (let i = 0; i < 3; i++) {
        const ballot = latestKeyboard(p.id);
        expect(String(ballot.params.text)).toContain(DAY);
        expect(String(ballot.params.text)).not.toContain(`test:${DAY}`);
        const pick = (ballot.params.reply_markup.inline_keyboard as { callback_data: string }[][])
          .flat()
          .find((b) => b.callback_data.startsWith("mv:"));
        if (!pick) break;
        await handleUpdate(makeCtx(tg, FRI_NOON), tap(p, pick.callback_data, messageId));
      }
    }

    const results = tg.sentTo(GROUP).map((c) => c.params.text as string).find((t) => t.includes("tulokset"));
    expect(results).toContain("(testipeli – ei tallenneta)");
    expect(results).toContain(DAY);
    expect(results).not.toContain(`test:${DAY}`);

    const placements = await env.DB.prepare("SELECT COUNT(*) AS n FROM placements WHERE category = 'matto'").first<{ n: number }>();
    expect(placements?.n).toBe(0);

    const statChanges = await env.DB.prepare("SELECT COUNT(*) AS n FROM matto_stat_changes").first<{ n: number }>();
    expect(statChanges?.n).toBe(0);

    const daysLeft = await env.DB.prepare("SELECT COUNT(*) AS n FROM matto_days").first<{ n: number }>();
    expect(daysLeft?.n).toBe(0);

    const offersLeft = await env.DB.prepare("SELECT COUNT(*) AS n FROM matto_offers").first<{ n: number }>();
    expect(offersLeft?.n).toBe(0);

    const teamsLeft = await env.DB.prepare("SELECT COUNT(*) AS n FROM matto_teams").first<{ n: number }>();
    expect(teamsLeft?.n).toBe(0);

    const matchupsLeft = await env.DB.prepare("SELECT COUNT(*) AS n FROM matto_matchups").first<{ n: number }>();
    expect(matchupsLeft?.n).toBe(0);

    const votesLeft = await env.DB.prepare("SELECT COUNT(*) AS n FROM matto_votes").first<{ n: number }>();
    expect(votesLeft?.n).toBe(0);

    const ballotsLeft = await env.DB.prepare("SELECT COUNT(*) AS n FROM matto_ballots").first<{ n: number }>();
    expect(ballotsLeft?.n).toBe(0);
  });

  it("shows character D&D stats with /statsit", async () => {
    await register();
    const char = await env.DB.prepare("SELECT name FROM matto_characters LIMIT 1").first<{ name: string }>();
    expect(char?.name).toBeTruthy();

    await handleUpdate(makeCtx(tg, FRI_NOON), inGroup(anna, `/statsit [[${char!.name}]]`));
    const msg = tg.sentTo(GROUP).at(-1)?.params.text as string;
    expect(msg).toContain(char!.name);
    expect(msg).toMatch(/STR \d+ · DEX \d+ · CON \d+ · INT \d+ · WIS \d+ · CHA \d+/);
  });

  it("removes a character in draft, draws 1 replacement, and subsequent removals skip without extra cards", async () => {
    await register();
    await handleUpdate(makeCtx(tg, FRI_NOON), inGroup(anna, "/matto"));
    const messageId = firstDraftMessageId(anna.id);

    // 1st removal: replacement card is drawn (8 -> 9 offers)
    await removeNext(anna, messageId);
    const card2 = latestKeyboard(anna.id);
    expect(String(card2.params.text)).toContain("Hahmo 2/9");

    const removed1 = await env.DB.prepare(
      "SELECT character_id FROM matto_removed_characters WHERE player_id = ?",
    )
      .bind(anna.id)
      .all<{ character_id: number }>();
    expect(removed1.results).toHaveLength(1);

    const polls1 = await env.DB.prepare(
      "SELECT id, character_id, status FROM matto_removal_polls WHERE status = 'open'",
    ).all<{ id: number; character_id: number; status: string }>();
    expect(polls1.results).toHaveLength(1);

    const votes1 = await env.DB.prepare(
      "SELECT voter_id, choice FROM matto_removal_votes WHERE poll_id = ?",
    )
      .bind(polls1.results[0]!.id)
      .all<{ voter_id: number; choice: string }>();
    expect(votes1.results).toEqual([{ voter_id: anna.id, choice: "remove" }]);

    const totalOffers1 = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM matto_offers WHERE day = ? AND player_id = ?",
    )
      .bind(DAY, anna.id)
      .first<{ n: number }>();
    expect(totalOffers1?.n).toBe(9);

    // 2nd removal: no extra card drawn (remains 9 offers)
    await removeNext(anna, messageId);
    const card3 = latestKeyboard(anna.id);
    expect(String(card3.params.text)).toContain("Hahmo 3/9");

    const removed2 = await env.DB.prepare(
      "SELECT character_id FROM matto_removed_characters WHERE player_id = ?",
    )
      .bind(anna.id)
      .all<{ character_id: number }>();
    expect(removed2.results).toHaveLength(2);

    const polls2 = await env.DB.prepare(
      "SELECT id, character_id, status FROM matto_removal_polls WHERE status = 'open'",
    ).all<{ id: number; character_id: number; status: string }>();
    expect(polls2.results).toHaveLength(2);

    const totalOffers2 = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM matto_offers WHERE day = ? AND player_id = ?",
    )
      .bind(DAY, anna.id)
      .first<{ n: number }>();
    expect(totalOffers2?.n).toBe(9);

    // Anna keeps 3 cards to complete draft
    for (let i = 0; i < 3; i++) await keepNext(anna, messageId);
    const team = await env.DB.prepare(
      "SELECT completed_at FROM matto_teams WHERE day = ? AND player_id = ?",
    )
      .bind(DAY, anna.id)
      .first<{ completed_at: string | null }>();
    expect(team?.completed_at).toBeTruthy();
  });

  it("allows removing a card when remaining offers equal needed slots if replacement is available", async () => {
    await register();
    await handleUpdate(makeCtx(tg, FRI_NOON), inGroup(anna, "/matto"));
    const messageId = firstDraftMessageId(anna.id);

    // Keep 2 cards
    await keepNext(anna, messageId);
    await keepNext(anna, messageId);

    // Skip 5 cards (cards 2..6)
    for (let i = 0; i < 5; i++) {
      await skipNext(anna, messageId);
    }

    // Now at card 8 (position 7): kept 2, remaining 1.
    // Because replacement is available, removal is allowed!
    const card7 = latestKeyboard(anna.id);
    expect(String(card7.params.text)).toContain("Pakko ottaa tai poistaa");
    const buttons7 = (card7.params.reply_markup.inline_keyboard as { text: string }[][]).flat();
    expect(buttons7.map((b) => b.text)).toEqual(["✅ Pidä", "🗑️ Poista"]);

    // Remove this card: replacement card (position 8) is drawn.
    // Since replacement is now used and remaining slots equal open slots, position 8 is auto-forced!
    await removeNext(anna, messageId);

    const card8Offer = await env.DB.prepare(
      "SELECT decision FROM matto_offers WHERE day = ? AND player_id = ? AND position = 8",
    )
      .bind(DAY, anna.id)
      .first<{ decision: string }>();
    expect(card8Offer?.decision).toBe("forced");

    const team = await env.DB.prepare(
      "SELECT completed_at FROM matto_teams WHERE day = ? AND player_id = ?",
    )
      .bind(DAY, anna.id)
      .first<{ completed_at: string | null }>();
    expect(team?.completed_at).toBeTruthy();
  });

  it("runs group removal vote upon mättö close and retires or keeps nominated characters", async () => {
    await register();
    await handleUpdate(makeCtx(tg, FRI_NOON), inGroup(anna, "/matto"));

    // Anna removes 2 characters then keeps 3
    const annaDraftId = firstDraftMessageId(anna.id);
    await removeNext(annaDraftId ? anna : anna, annaDraftId);
    await removeNext(annaDraftId ? anna : anna, annaDraftId);
    for (let i = 0; i < 3; i++) await keepNext(anna, annaDraftId);

    // Ben, Chris, Dan draft normally
    for (const p of [ben, chris, dan]) await draftFive(p);

    // Everyone votes in matchups
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

    // Results are posted, followed by the removal vote message in the group
    const removalMsg = tg.sentTo(GROUP).find((c) => String(c.params.text).includes("poistoäänestys"));
    expect(removalMsg).toBeTruthy();
    expect(String(removalMsg?.params.text)).toContain("2026-10-23");
    expect(String(removalMsg?.params.text)).toContain("Poistuu kaikilta, jos vähintään 3/4 äänestää 🗑️");

    const openPolls = await env.DB.prepare(
      "SELECT id, character_id FROM matto_removal_polls WHERE day = ? ORDER BY id",
    )
      .bind(DAY)
      .all<{ id: number; character_id: number }>();
    expect(openPolls.results).toHaveLength(2);
    const [poll1, poll2] = openPolls.results;

    // For poll1: Ben and Chris vote remove (3/4 remove votes -> retired!)
    const msgId = removalMsg!.result.message_id as number;
    await handleUpdate(makeCtx(tg, FRI_NOON), tap(ben, `mp:${poll1!.id}:r`, msgId));
    await handleUpdate(makeCtx(tg, FRI_NOON), tap(chris, `mp:${poll1!.id}:r`, msgId));

    const poll1Db = await env.DB.prepare("SELECT status FROM matto_removal_polls WHERE id = ?")
      .bind(poll1!.id)
      .first<{ status: string }>();
    expect(poll1Db?.status).toBe("retired");

    const char1 = await env.DB.prepare("SELECT retired_at FROM matto_characters WHERE id = ?")
      .bind(poll1!.character_id)
      .first<{ retired_at: string | null }>();
    expect(char1?.retired_at).toBeTruthy();

    // For poll2: Ben and Chris vote keep (2/4 keep votes -> kept!)
    await handleUpdate(makeCtx(tg, FRI_NOON), tap(ben, `mp:${poll2!.id}:k`, msgId));
    await handleUpdate(makeCtx(tg, FRI_NOON), tap(chris, `mp:${poll2!.id}:k`, msgId));

    const poll2Db = await env.DB.prepare("SELECT status FROM matto_removal_polls WHERE id = ?")
      .bind(poll2!.id)
      .first<{ status: string }>();
    expect(poll2Db?.status).toBe("kept");

    const char2 = await env.DB.prepare("SELECT retired_at FROM matto_characters WHERE id = ?")
      .bind(poll2!.character_id)
      .first<{ retired_at: string | null }>();
    expect(char2?.retired_at).toBeNull();

    // Check statsit shows retired status
    const char1Row = await env.DB.prepare("SELECT name FROM matto_characters WHERE id = ?")
      .bind(poll1!.character_id)
      .first<{ name: string }>();
    await handleUpdate(makeCtx(tg, FRI_NOON), inGroup(anna, `/statsit [[${char1Row!.name}]]`));
    const statsitMsg = tg.sentTo(GROUP).at(-1)?.params.text as string;
    expect(statsitMsg).toContain("poistettu pelistä");
  });

  it("handles testipeli (/testimatto) removals and posts removal poll with (testipelistä)", async () => {
    await register();
    await handleUpdate(makeCtx(tg, FRI_NOON), inGroup(anna, "/testimatto"));

    const messageId = firstDraftMessageId(anna.id);
    await removeNext(anna, messageId);
    for (let i = 0; i < 3; i++) await keepNext(anna, messageId);
    for (const p of [ben, chris, dan]) await draftFive(p);

    // Vote in test matchups
    for (const p of PLAYERS) {
      const bId = firstBallotMessageId(p.id);
      for (let i = 0; i < 3; i++) {
        const ballot = latestKeyboard(p.id);
        const pick = (ballot.params.reply_markup.inline_keyboard as { callback_data: string }[][])
          .flat()
          .find((b) => b.callback_data.startsWith("mv:"));
        if (!pick) break;
        await handleUpdate(makeCtx(tg, FRI_NOON), tap(p, pick.callback_data, bId));
      }
    }

    // Removal poll posted to group with (testipelistä)
    const removalMsg = tg.sentTo(GROUP).find((c) => String(c.params.text).includes("poistoäänestys"));
    expect(removalMsg).toBeTruthy();
    expect(String(removalMsg?.params.text)).toContain("(testipelistä)");

    // Even though test game was wiped, personal removal and removal poll are kept!
    const removedCount = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM matto_removed_characters WHERE player_id = ?",
    )
      .bind(anna.id)
      .first<{ n: number }>();
    expect(removedCount?.n).toBe(1);

    const pollCount = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM matto_removal_polls",
    ).first<{ n: number }>();
    expect(pollCount?.n).toBe(1);
  });

  it("rejects removal votes from unregistered users", async () => {
    await register();
    await handleUpdate(makeCtx(tg, FRI_NOON), inGroup(anna, "/matto"));
    const messageId = firstDraftMessageId(anna.id);
    await removeNext(anna, messageId);
    for (let i = 0; i < 3; i++) await keepNext(anna, messageId);
    for (const p of [ben, chris, dan]) await draftFive(p);

    // Close mättö by voting
    for (const p of PLAYERS) {
      const bId = firstBallotMessageId(p.id);
      for (let i = 0; i < 3; i++) {
        const ballot = latestKeyboard(p.id);
        const pick = (ballot.params.reply_markup.inline_keyboard as { callback_data: string }[][])
          .flat()
          .find((b) => b.callback_data.startsWith("mv:"));
        if (!pick) break;
        await handleUpdate(makeCtx(tg, FRI_NOON), tap(p, pick.callback_data, bId));
      }
    }

    const poll = await env.DB.prepare("SELECT id FROM matto_removal_polls LIMIT 1").first<{ id: number }>();
    expect(poll).toBeTruthy();

    const stranger: User = { id: 777777, is_bot: false, first_name: "Tuntematon" };
    await handleUpdate(makeCtx(tg, FRI_NOON), tap(stranger, `mp:${poll!.id}:r`, 9999));
    const answer = tg.calls.find(
      (c) => c.method === "answerCallbackQuery" && String(c.params.text).includes("Vain rekisteröityneet"),
    );
    expect(answer).toBeTruthy();
  });
});
