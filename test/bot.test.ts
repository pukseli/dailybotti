import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { handleUpdate, tick } from "../src/bot";
import { COMMAND_MENUS, GROUP_COMMANDS, PRIVATE_COMMANDS } from "../src/commands";
import { getSettings } from "../src/db";
import { TelegramError } from "../src/telegram";
import {
  BOT_USERNAME,
  FakeTelegram,
  GROUP,
  anna,
  ben,
  chris,
  clickButton,
  dan,
  dm,
  eralyShare,
  inGroup,
  krillionShare,
  makeCtx,
  resetDb,
  sizeItUpShare,
  stranger,
} from "./helpers";

// Friday 23 Oct 2026 in Helsinki (UTC+3): Eraly #8, Krillion #100.
const FRI_NOON = "2026-10-23T09:00:00Z";
const FRI_EVENING = "2026-10-23T18:00:00Z";
const FRI_2359 = "2026-10-23T20:59:30Z";
const SAT_0000 = "2026-10-23T21:00:30Z";
const SAT_0001 = "2026-10-23T21:01:30Z";

let tg: FakeTelegram;

async function linkGroup(): Promise<void> {
  await handleUpdate(makeCtx(tg, FRI_NOON), inGroup(anna, "/setup"));
  tg.clear();
}

function groupTexts(): string[] {
  return tg.sentTo(GROUP).map((c) => c.params.text as string);
}

beforeEach(async () => {
  await resetDb();
  tg = new FakeTelegram();
  // Command menus start up to date, as after any deploy that didn't change them.
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('bot_username', ?), ('bot_id', '999'), ('command_menus', ?)")
    .bind(BOT_USERNAME, COMMAND_MENUS)
    .run();
});

describe("/setup", () => {
  it("only lets a group admin link the group", async () => {
    await handleUpdate(makeCtx(tg, FRI_NOON), inGroup(ben, "/setup"));
    expect(tg.lastTextTo(GROUP)).toContain("Only group admins");
    expect((await getSettings(env.DB)).groupChatId).toBeNull();

    await handleUpdate(makeCtx(tg, FRI_NOON), inGroup(anna, "/setup@PodiumTestBot"));
    expect(tg.lastTextTo(GROUP)).toContain("Linked to this group");
    expect(tg.lastTextTo(GROUP)).toContain("Paste your Eraly, Krillion and Size It Up results here, or send them to @PodiumTestBot");
    expect(tg.lastTextTo(GROUP)).not.toContain("make me an admin");
    expect((await getSettings(env.DB)).groupChatId).toBe(GROUP);
  });

  it("asks to be made admin when it can't see group messages", async () => {
    tg.botIsAdmin = false;
    await handleUpdate(makeCtx(tg, FRI_NOON), inGroup(anna, "/setup"));
    expect(tg.lastTextTo(GROUP)).toContain("make me an admin");
  });

  it("doesn't need to be admin when privacy mode is off", async () => {
    tg.botIsAdmin = false;
    tg.botReadsAll = true;
    await handleUpdate(makeCtx(tg, FRI_NOON), inGroup(anna, "/setup"));
    expect(tg.lastTextTo(GROUP)).toContain("Linked to this group");
    expect(tg.lastTextTo(GROUP)).not.toContain("make me an admin");
  });

  it("refuses a second group", async () => {
    await linkGroup();
    await handleUpdate(makeCtx(tg, FRI_NOON), inGroup(anna, "/setup", -100999));
    expect(tg.lastTextTo(-100999)).toContain("already linked to another group");
    expect((await getSettings(env.DB)).groupChatId).toBe(GROUP);
  });

  it("works for an anonymous admin", async () => {
    const update = inGroup(anna, "/setup");
    update.message!.from = { id: 1087968824, is_bot: true, first_name: "Group" };
    update.message!.sender_chat = { id: GROUP, type: "supergroup" };
    await handleUpdate(makeCtx(tg, FRI_NOON), update);
    expect((await getSettings(env.DB)).groupChatId).toBe(GROUP);
  });

  it("posts into the forum topic it was run in", async () => {
    const update = inGroup(anna, "/setup");
    update.message!.is_topic_message = true;
    update.message!.message_thread_id = 42;
    await handleUpdate(makeCtx(tg, FRI_NOON), update);
    tg.clear();
    await handleUpdate(makeCtx(tg, FRI_NOON), dm(ben, eralyShare(8, 500)));
    expect(tg.sentTo(GROUP)[0]?.params.message_thread_id).toBe(42);
  });
});

describe("private results", () => {
  it("tells people when no group is linked", async () => {
    await handleUpdate(makeCtx(tg, FRI_NOON), dm(anna, eralyShare(8, 500)));
    expect(tg.lastTextTo(anna.id)).toContain("not linked to a group");
  });

  it("only accepts members of the group", async () => {
    await linkGroup();
    await handleUpdate(makeCtx(tg, FRI_NOON), dm(stranger, eralyShare(8, 500)));
    expect(tg.lastTextTo(stranger.id)).toContain("Only members of the group");
    expect(tg.sentTo(GROUP)).toHaveLength(0);
  });

  it("explains when a message has no result", async () => {
    await linkGroup();
    await handleUpdate(makeCtx(tg, FRI_NOON), dm(anna, "hello"));
    expect(tg.lastTextTo(anna.id)).toContain("didn't find");
    await handleUpdate(makeCtx(tg, FRI_NOON), dm(anna, sizeItUpShare(300, "Size It Up: Geography")));
    expect(tg.lastTextTo(anna.id)).toContain("Only the regular daily Size It Up counts");
  });

  it("answers /start and /help with usage and setup instructions", async () => {
    await linkGroup();
    for (const command of ["/start", "/help"]) {
      await handleUpdate(makeCtx(tg, FRI_NOON), dm(anna, command));
      const help = tg.lastTextTo(anna.id);
      expect(help).toContain("<b>Näin pelaat mukana</b>");
      expect(help).toContain("Palkintopallit julkaistaan keskiyöllä (Europe/Helsinki).");
      expect(help).toContain("/regressio – hajonta-analyysi");
      expect(help).toContain("<b>Käyttöönotto ryhmässä</b>");
      expect(help).not.toContain("En ole vielä yhdistetty");
    }
  });

  it("shows the closing time in /help when it isn't midnight", async () => {
    await linkGroup();
    await handleUpdate(makeCtx(tg, FRI_NOON, { closeTime: "22:00" }), dm(anna, "/help"));
    expect(tg.lastTextTo(anna.id)).toContain("Palkintopallit julkaistaan klo 22:00");
  });

  it("answers /help in a group before /setup, with the setup steps", async () => {
    await handleUpdate(makeCtx(tg, FRI_NOON), inGroup(ben, "/help"));
    const help = tg.lastTextTo(GROUP);
    expect(help).toContain("3. Ryhmän ylläpitäjä lähettää ryhmään /setup.");
    expect(help).toContain("En ole vielä yhdistetty ryhmään");
    expect(tg.sentTo(GROUP)[0]!.params.reply_parameters).toBeDefined();

    await linkGroup();
    await handleUpdate(makeCtx(tg, FRI_NOON), inGroup(ben, "/help@PodiumTestBot"));
    expect(tg.lastTextTo(GROUP)).toContain("<b>Käyttöönotto ryhmässä</b>");
    expect(tg.lastTextTo(GROUP)).not.toContain("En ole vielä yhdistetty");
  });

  it("counts only the first result per game and day", async () => {
    await linkGroup();
    await handleUpdate(makeCtx(tg, FRI_NOON), dm(ben, eralyShare(8, 500)));
    await handleUpdate(makeCtx(tg, FRI_NOON), dm(ben, eralyShare(8, 690)));
    expect(tg.lastTextTo(ben.id)).toContain("You already sent Eraly #8 (500/700). Only the first result counts.");
    await handleUpdate(makeCtx(tg, FRI_NOON), dm(ben, eralyShare(8, 500)));
    expect(tg.lastTextTo(ben.id)).toContain("Eraly #8 was already saved");
  });

  it("refuses puzzles from a closed day and puzzles that aren't out yet", async () => {
    await linkGroup();
    await handleUpdate(makeCtx(tg, FRI_NOON), dm(ben, eralyShare(7, 500)));
    expect(tg.lastTextTo(ben.id)).toContain("Eraly #7 is for Thu 22 Oct, which has already closed.");
    await handleUpdate(makeCtx(tg, FRI_NOON), dm(ben, krillionShare(105, 500)));
    expect(tg.lastTextTo(ben.id)).toContain("isn't out yet");
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM results").first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("files tomorrow's Krillion under tomorrow when it is already out (west of New York)", async () => {
    await linkGroup();
    // 22:00 Friday in Los Angeles is already Saturday in New York, so Krillion #101 is out.
    const ctx = makeCtx(tg, "2026-10-24T05:00:00Z", { timeZone: "America/Los_Angeles" });
    await handleUpdate(ctx, dm(ben, krillionShare(101, 400)));
    expect(tg.lastTextTo(ben.id)).toContain("Krillion #101: 400/700 saved for Sat 24 Oct.");
    expect(tg.sentTo(GROUP)).toHaveLength(0); // Friday's board isn't touched
    const row = await env.DB.prepare("SELECT day FROM results").first<{ day: string }>();
    expect(row?.day).toBe("2026-10-24");
  });

  it("closes early when CLOSE_TIME is set", async () => {
    await linkGroup();
    const ctx = makeCtx(tg, "2026-10-23T19:30:00Z", { closeTime: "22:00" }); // 22:30 Helsinki
    await handleUpdate(ctx, dm(ben, sizeItUpShare(400)));
    expect(tg.lastTextTo(ben.id)).toContain("which has already closed");
  });
});

describe("a full day", () => {
  it("keeps a board during the day and posts podiums at midnight", async () => {
    await linkGroup();

    // Anna sends all three in one message.
    await handleUpdate(
      makeCtx(tg, FRI_NOON),
      dm(anna, [eralyShare(8, 640), krillionShare(100, 540), sizeItUpShare(402)].join("\n\n")),
    );
    const annaReply = tg.lastTextTo(anna.id);
    expect(annaReply).toContain("✅ Eraly #8: 640/700 saved.");
    expect(annaReply).toContain("✅ Krillion #100: 540/700 saved.");
    expect(annaReply).toContain("✅ Size It Up: 402/500 saved.");
    expect(annaReply).toContain("All three done for today");

    // The board appears in the group, silently, without scores.
    const board = tg.sentTo(GROUP);
    expect(board).toHaveLength(1);
    expect(board[0]!.params.disable_notification).toBe(true);
    expect(board[0]!.params.text).toContain("Fri 23 Oct");
    expect(board[0]!.params.text).toContain("Eraly #8 · Krillion #100 · Size It Up");
    expect(board[0]!.params.text).toContain("✅✅✅ Anna");
    expect(board[0]!.params.text).toContain("@PodiumTestBot");
    expect(board[0]!.params.text).not.toContain("640");
    const boardId = (await env.DB.prepare("SELECT board_message_id AS id FROM days").first<{ id: number }>())!.id;

    // Ben plays one game; the board is edited, not reposted.
    tg.clear();
    await handleUpdate(makeCtx(tg, FRI_EVENING), dm(ben, eralyShare(8, 610)));
    expect(tg.lastTextTo(ben.id)).toContain("Still to play today: Krillion, Size It Up.");
    expect(tg.sentTo(GROUP)).toHaveLength(0);
    const edit = tg.of("editMessageText");
    expect(edit).toHaveLength(1);
    expect(edit[0]!.params.message_id).toBe(boardId);
    expect(edit[0]!.params.text).toContain("✅⬜⬜ Ben");

    // Chris ties Anna in Krillion and plays Size It Up.
    await handleUpdate(makeCtx(tg, FRI_EVENING), dm(chris, `${krillionShare(100, 540)}\n\n${sizeItUpShare(455)}`));

    // The every-minute job does nothing before midnight, and doesn't touch an up-to-date board.
    tg.clear();
    await tick(makeCtx(tg, FRI_2359));
    expect(tg.calls).toEqual([]);

    // After midnight: podiums, then the board flips to closed.
    await tick(makeCtx(tg, SAT_0000));
    const summary = tg.sentTo(GROUP);
    expect(summary).toHaveLength(1);
    expect(summary[0]!.params.disable_notification).toBeUndefined();
    const text = summary[0]!.params.text as string;
    expect(text).toContain("🏁 <b>Results · Fri 23 Oct</b>");
    expect(text).toContain("<b>Eraly #8</b>\n🥇 Anna · 640\n🥈 Ben · 610");
    expect(text).toContain("<b>Krillion #100</b>\n🥇 Anna · 540\n🥇 Chris · 540");
    expect(text).toContain("<b>Size It Up</b>\n🥇 Chris · 455\n🥈 Anna · 402");
    // Anna 91.4 + 77.1 + 80.4 = 249.0; Chris 77.1 + 91.0 = 168.1; Ben 87.1
    expect(text).toContain("🏆 <b>Overall</b> (out of 300)\n🥇 Anna · 249.0\n🥈 Chris · 168.1 · 2/3 games\n🥉 Ben · 87.1 · 1/3 games");
    expect(tg.of("editMessageText").at(-1)!.params.text).toContain("🔒 <b>Fri 23 Oct</b> · closed");

    // It happens once.
    tg.clear();
    await tick(makeCtx(tg, SAT_0001));
    expect(tg.sentTo(GROUP)).toHaveLength(0);

    // Late results for Friday are refused.
    await handleUpdate(makeCtx(tg, SAT_0001), dm(ben, krillionShare(100, 600)));
    expect(tg.lastTextTo(ben.id)).toContain("which has already closed");

    // All-time standings.
    await handleUpdate(makeCtx(tg, SAT_0001), inGroup(ben, "/leaderboard"));
    const leaderboard = tg.lastTextTo(GROUP);
    expect(leaderboard).toContain("1. Anna  🥇1 🥈0 🥉0 · 249.0 · 1");
    expect(leaderboard).toContain("2. Chris  🥇0 🥈1 🥉0 · 168.1 · 1");
    expect(leaderboard).toContain("Krillion: Anna 1 · Chris 1");

    await handleUpdate(makeCtx(tg, SAT_0001), dm(chris, "/me"));
    const me = tg.lastTextTo(chris.id);
    expect(me).toContain("📊 <b>Chris</b> · 1 day played");
    expect(me).toContain("<b>Size It Up</b>: 🥇1 🥈0 🥉0 · avg 455 · best 455 · 1 played");
    expect(me).toContain("<b>Eraly</b>: not played yet");
  });

  it("closes a day nobody played without posting anything", async () => {
    await linkGroup();
    await handleUpdate(makeCtx(tg, FRI_NOON), inGroup(anna, "/today"));
    tg.clear();
    await tick(makeCtx(tg, SAT_0000));
    expect(tg.sentTo(GROUP)).toHaveLength(0);
  });

  it("catches up on podiums missed while the bot was down, oldest first", async () => {
    await linkGroup();
    await handleUpdate(makeCtx(tg, "2026-10-22T09:00:00Z"), dm(anna, eralyShare(7, 300)));
    await handleUpdate(makeCtx(tg, FRI_NOON), dm(anna, eralyShare(8, 400)));
    tg.clear();
    await tick(makeCtx(tg, "2026-10-24T09:00:00Z"));
    const posted = groupTexts().filter((t) => t.startsWith("🏁"));
    expect(posted.map((t) => t.split("\n")[0])).toEqual(["🏁 <b>Results · Thu 22 Oct</b>", "🏁 <b>Results · Fri 23 Oct</b>"]);
  });

  it("retries the podium next minute if Telegram fails", async () => {
    await linkGroup();
    await handleUpdate(makeCtx(tg, FRI_NOON), dm(anna, eralyShare(8, 400)));
    tg.clear();
    tg.fail("sendMessage", new TelegramError("sendMessage", 502, "Bad Gateway"));
    const finalized = () => env.DB.prepare("SELECT finalized_at AS f FROM days").first<{ f: string | null }>();
    await tick(makeCtx(tg, SAT_0000));
    expect((await finalized())?.f).toBeNull();
    await tick(makeCtx(tg, SAT_0001));
    expect((await finalized())?.f).not.toBeNull();
    // One failed attempt, then one that went through.
    expect(groupTexts().filter((t) => t.startsWith("🏁"))).toHaveLength(2);
  });
});

describe("results posted in the group", () => {
  it("keeps the paste and confirms with a 👍 reaction, without messaging anyone", async () => {
    await linkGroup();
    const update = inGroup(chris, [eralyShare(8, 500), sizeItUpShare(400)].join("\n\n"));
    await handleUpdate(makeCtx(tg, FRI_NOON), update);
    expect(tg.of("setMessageReaction")[0]!.params).toEqual({
      chat_id: GROUP,
      message_id: update.message!.message_id,
      reaction: [{ type: "emoji", emoji: "👍" }],
    });
    expect(tg.of("deleteMessage")).toHaveLength(0);
    expect(tg.sentTo(chris.id)).toHaveLength(0);
    const groupMessages = tg.sentTo(GROUP);
    expect(groupMessages).toHaveLength(1); // only the board
    expect(groupMessages[0]!.params.text).toContain("✅⬜✅ Chris");
    const saved = await env.DB.prepare("SELECT COUNT(*) AS n FROM results WHERE player_id = ?").bind(chris.id).first<{ n: number }>();
    expect(saved?.n).toBe(2);
  });

  it("reacts again to a repeated paste of the same result", async () => {
    await linkGroup();
    await handleUpdate(makeCtx(tg, FRI_NOON), inGroup(chris, eralyShare(8, 500)));
    tg.clear();
    await handleUpdate(makeCtx(tg, FRI_NOON), inGroup(chris, eralyShare(8, 500)));
    expect(tg.of("setMessageReaction")).toHaveLength(1);
    expect(tg.of("sendMessage")).toHaveLength(0);
  });

  it("replies in the group when a result can't be counted", async () => {
    await linkGroup();
    await handleUpdate(makeCtx(tg, FRI_NOON), dm(dan, krillionShare(100, 300)));
    tg.clear();
    const update = inGroup(dan, `${krillionShare(100, 650)}\n\n${eralyShare(7, 400)}\n\n${sizeItUpShare(350)}`);
    await handleUpdate(makeCtx(tg, FRI_NOON), update);
    expect(tg.of("setMessageReaction")).toHaveLength(0);
    const answer = tg.sentTo(GROUP).find((c) => c.params.reply_parameters);
    expect(answer?.params.reply_parameters).toEqual({ message_id: update.message!.message_id, allow_sending_without_reply: true });
    expect(answer?.params.text).toBe(
      [
        "✅ Size It Up: 350/500 saved.",
        "⛔ Eraly #7 is for Thu 22 Oct, which has already closed.",
        "ℹ️ You already sent Krillion #100 (300/700). Only the first result counts.",
      ].join("\n"),
    );
  });

  it("replies instead when reactions are turned off in the group", async () => {
    await linkGroup();
    tg.fail("setMessageReaction", new TelegramError("setMessageReaction", 400, "Bad Request: REACTION_INVALID"));
    await handleUpdate(makeCtx(tg, FRI_NOON), inGroup(dan, krillionShare(100, 300)));
    expect(tg.sentTo(GROUP).some((c) => c.params.text === "✅ Krillion #100: 300/700 saved.")).toBe(true);
  });

  it("ignores ordinary chat and other groups", async () => {
    await linkGroup();
    await handleUpdate(makeCtx(tg, FRI_NOON), inGroup(ben, "Krillion was hard today"));
    await handleUpdate(makeCtx(tg, FRI_NOON), inGroup(ben, sizeItUpShare(300, "Size It Up: Pop Culture")));
    await handleUpdate(makeCtx(tg, FRI_NOON), inGroup(ben, eralyShare(8, 500), -100555));
    await handleUpdate(makeCtx(tg, FRI_NOON), inGroup(ben, "/today@SomeOtherBot"));
    expect(tg.calls).toEqual([]);
  });
});

describe("board upkeep", () => {
  it("posts a new board if the old one was deleted", async () => {
    await linkGroup();
    await handleUpdate(makeCtx(tg, FRI_NOON), dm(anna, eralyShare(8, 500)));
    tg.fail("editMessageText", new TelegramError("editMessageText", 400, "Bad Request: message to edit not found"));
    await handleUpdate(makeCtx(tg, FRI_NOON), dm(ben, eralyShare(8, 400)));
    const boards = tg.sentTo(GROUP);
    expect(boards).toHaveLength(2);
    expect(boards[1]!.params.text).toContain("✅⬜⬜ Ben");
  });

  it("treats 'message is not modified' as success", async () => {
    await linkGroup();
    await handleUpdate(makeCtx(tg, FRI_NOON), dm(anna, eralyShare(8, 500)));
    tg.fail(
      "editMessageText",
      new TelegramError("editMessageText", 400, "Bad Request: message is not modified: specified new message content and reply markup are exactly the same"),
    );
    await handleUpdate(makeCtx(tg, FRI_NOON), dm(ben, eralyShare(8, 400)));
    expect(tg.sentTo(GROUP)).toHaveLength(1);
    tg.clear();
    await tick(makeCtx(tg, FRI_EVENING));
    expect(tg.calls).toEqual([]); // stored as up to date
  });

  it("repairs a missed board update on the next minute", async () => {
    await linkGroup();
    await handleUpdate(makeCtx(tg, FRI_NOON), dm(anna, eralyShare(8, 500)));
    tg.fail("editMessageText", new TelegramError("editMessageText", 429, "Too Many Requests: retry after 5"));
    await handleUpdate(makeCtx(tg, FRI_NOON), dm(ben, eralyShare(8, 400)));
    expect(tg.lastTextTo(ben.id)).toContain("saved"); // the player still got their confirmation
    tg.clear();
    await tick(makeCtx(tg, FRI_EVENING));
    expect(tg.of("editMessageText")[0]!.params.text).toContain("✅⬜⬜ Ben");
  });

  it("/today moves the board to the bottom of the chat", async () => {
    await linkGroup();
    await handleUpdate(makeCtx(tg, FRI_NOON), dm(anna, eralyShare(8, 500)));
    const first = tg.sentTo(GROUP)[0]!;
    tg.clear();
    const command = inGroup(ben, "/today");
    await handleUpdate(makeCtx(tg, FRI_NOON), command);
    const deleted = tg.of("deleteMessage").map((c) => c.params.message_id);
    expect(deleted).toContain(command.message!.message_id);
    expect(deleted).toHaveLength(2);
    expect(tg.sentTo(GROUP)).toHaveLength(1);
    expect(tg.lastTextTo(GROUP)).toBe(first.params.text);
  });

  it("follows the group when Telegram upgrades it to a supergroup", async () => {
    await linkGroup();
    const NEW_ID = -1009876543210;
    tg.fail(
      "sendMessage",
      new TelegramError("sendMessage", 400, "Bad Request: group chat was upgraded to a supergroup chat", NEW_ID),
      (p) => p.chat_id === GROUP,
    );
    await handleUpdate(makeCtx(tg, FRI_NOON), dm(anna, eralyShare(8, 500)));
    const boardCalls = tg.of("sendMessage").filter((c) => (c.params.text as string).includes("today's board"));
    expect(boardCalls.at(-1)!.params.chat_id).toBe(NEW_ID);
    expect((await getSettings(env.DB)).groupChatId).toBe(NEW_ID);
  });

  it("follows the migration service message", async () => {
    await linkGroup();
    const update = inGroup(anna, "");
    delete update.message!.text;
    update.message!.chat = { id: GROUP, type: "group" };
    update.message!.migrate_to_chat_id = -100777;
    await handleUpdate(makeCtx(tg, FRI_NOON), update);
    expect((await getSettings(env.DB)).groupChatId).toBe(-100777);
  });
});

describe("round breakdown storage and backwards compatibility", () => {
  it("stores rounds_json and raw_text in D1 without changing any bot output, and supports json_each queries", async () => {
    await linkGroup();
    const customSizeItUp = [
      "Size It Up",
      "Overall Score 461",
      "",
      "🟥🟥🟥🟥🟥 100",
      "🟥🟥🟥🟥⬜ 98",
      "🟥🟥🟥🟥🟥 92",
      "🟥🟥🟥🟥⬜ 87",
      "🟥🟥🟥🟥🟥 84",
      "https://magnitudle.com/size-it-up",
    ].join("\n");

    await handleUpdate(
      makeCtx(tg, FRI_NOON),
      dm(anna, [eralyShare(8, 640), krillionShare(100, 540), customSizeItUp].join("\n\n")),
    );

    const rows = await env.DB.prepare("SELECT game, score, rounds_json, raw_text FROM results WHERE player_id = ? ORDER BY game")
      .bind(anna.id)
      .all<{ game: string; score: number; rounds_json: string | null; raw_text: string | null }>();

    expect(rows.results).toEqual([
      {
        game: "eraly",
        score: 640,
        rounds_json: null,
        raw_text: eralyShare(8, 640),
      },
      {
        game: "krillion",
        score: 540,
        rounds_json: JSON.stringify(["🫧", "🐟", "🦑", "🏮", "🌟", "⬛", "🤡"]),
        raw_text: krillionShare(100, 540),
      },
      {
        game: "sizeitup",
        score: 461,
        rounds_json: JSON.stringify([100, 98, 92, 87, 84]),
        raw_text: customSizeItUp,
      },
    ]);

    // Verify D1 SQLite json_each() can query individual rounds directly.
    const roundQuery = await env.DB.prepare(
      `SELECT CAST(j.key AS INTEGER) + 1 AS round_num, CAST(j.value AS INTEGER) AS round_score
       FROM results, json_each(results.rounds_json) AS j
       WHERE player_id = ? AND game = 'sizeitup'
       ORDER BY round_num`,
    )
      .bind(anna.id)
      .all<{ round_num: number; round_score: number }>();

    expect(roundQuery.results).toEqual([
      { round_num: 1, round_score: 100 },
      { round_num: 2, round_score: 98 },
      { round_num: 3, round_score: 92 },
      { round_num: 4, round_score: 87 },
      { round_num: 5, round_score: 84 },
    ]);
  });

  it("works seamlessly when legacy rows in results have NULL rounds_json and raw_text", async () => {
    await linkGroup();
    // Simulate a legacy row inserted before migration 0002 (only the original 7 columns).
    await env.DB.prepare("INSERT INTO days (day) VALUES ('2026-10-23')").run();
    await env.DB.prepare("INSERT INTO players (id, first_name, created_at) VALUES (?, 'Anna', '2026-10-23T08:00:00Z')")
      .bind(anna.id)
      .run();
    await env.DB.prepare(
      "INSERT INTO results (player_id, game, day, puzzle, score, max_score, submitted_at) VALUES (?, 'sizeitup', '2026-10-23', NULL, 410, 500, '2026-10-23T08:00:00Z')",
    )
      .bind(anna.id)
      .run();

    // New submission from Ben on the same day includes round data.
    await handleUpdate(makeCtx(tg, FRI_NOON), dm(ben, sizeItUpShare(450)));

    // Close the day and verify podiums & stats work with mixed legacy + new rows.
    await tick(makeCtx(tg, SAT_0000));
    const summary = tg.lastTextTo(GROUP);
    expect(summary).toContain("🥇 Ben · 450");
    expect(summary).toContain("🥈 Anna · 410");
  });
});

describe("/regressio and blowout analysis", () => {
  it("replies with regression analysis in private chat", async () => {
    await linkGroup();
    await handleUpdate(makeCtx(tg, FRI_NOON), dm(anna, eralyShare(8, 700)));
    tg.clear();
    await handleUpdate(makeCtx(tg, FRI_NOON), dm(anna, "/regressio"));
    expect(tg.lastTextTo(anna.id)).toContain("REGRESSIOANALYYSI: Anna");
    expect(tg.lastTextTo(anna.id)).toContain("Regressoitu taso:");
  });

  it("replies with regression analysis in group chat for specified user", async () => {
    await linkGroup();
    await handleUpdate(makeCtx(tg, FRI_NOON), dm(anna, eralyShare(8, 700)));
    tg.clear();
    await handleUpdate(makeCtx(tg, FRI_NOON), inGroup(ben, "/regressio Anna"));
    expect(tg.lastTextTo(GROUP)).toContain("REGRESSIOANALYYSI: Anna");
  });

  it("analyzes the leaderboard leader directly when /regressio is run without arguments", async () => {
    await linkGroup();
    // Anna submits 3 games, closing the day makes her the leaderboard leader
    await handleUpdate(makeCtx(tg, FRI_NOON), dm(anna, eralyShare(8, 700)));
    await handleUpdate(makeCtx(tg, FRI_NOON), dm(anna, krillionShare(100, 500)));
    await handleUpdate(makeCtx(tg, FRI_NOON), dm(anna, sizeItUpShare(500)));
    await tick(makeCtx(tg, SAT_0000));
    tg.clear();

    // Now Ben calls /regressio without parameters
    await handleUpdate(makeCtx(tg, SAT_0001), inGroup(ben, "/regressio"));
    expect(tg.lastTextTo(GROUP)).toContain("REGRESSIOANALYYSI: Anna");
    expect(tg.lastTextTo(GROUP)).toContain("Tulostaulukon kärjen karsinta");
  });

  it("analyzes the specific game result when /regressio is a reply to a message", async () => {
    await linkGroup();
    // Anna posts a result in the group
    const pasteUpdate = inGroup(anna, eralyShare(8, 700));
    pasteUpdate.message!.message_id = 1234;
    await handleUpdate(makeCtx(tg, FRI_NOON), pasteUpdate);
    tg.clear();

    // Ben replies to Anna's paste with /regressio
    const replyCommand = inGroup(ben, "/regressio");
    replyCommand.message!.reply_to_message = pasteUpdate.message;
    await handleUpdate(makeCtx(tg, FRI_NOON), replyCommand);

    const reply = tg.lastTextTo(GROUP);
    expect(reply).toContain("REGRESSIOANALYYSI: Anna");
    expect(reply).toContain("Viestin pelituloksen (eraly) karsinta");
    expect(reply).toContain("eraly (700/700)");
  });

  it("includes blowout analysis in daily podium when winner leads by > 20%", async () => {
    await linkGroup();
    await handleUpdate(makeCtx(tg, FRI_NOON), dm(anna, eralyShare(8, 700)));
    await handleUpdate(makeCtx(tg, FRI_NOON), dm(anna, krillionShare(100, 500)));
    await handleUpdate(makeCtx(tg, FRI_NOON), dm(anna, sizeItUpShare(500)));
    await handleUpdate(makeCtx(tg, FRI_NOON), dm(ben, eralyShare(8, 350)));
    tg.clear();

    await tick(makeCtx(tg, SAT_0000));
    const summary = tg.lastTextTo(GROUP);
    expect(summary).toContain("Results · Fri 23 Oct");
    expect(summary).toContain("TILASTOVALVONTA: Epäilyttävä ylivoima havaittu!");
    expect(summary).toContain("Anna oli");
  });

  describe("early daily close when all 4 players finish", () => {
    it("automatically finalizes the day immediately when the 4th player submits their last game", async () => {
      await linkGroup();

      // Anna, Ben and Chris submit all 3 games on Friday afternoon
      for (const u of [anna, ben, chris]) {
        await handleUpdate(makeCtx(tg, FRI_NOON), dm(u, `${eralyShare(8, 500)}\n\n${krillionShare(100, 500)}\n\n${sizeItUpShare(450)}`));
      }

      // 3 players finished, but Dan hasn't finished yet. The day is NOT finalized yet.
      const finalizedBefore = () => env.DB.prepare("SELECT finalized_at AS f FROM days WHERE day = '2026-10-23'").first<{ f: string | null }>();
      expect((await finalizedBefore())?.f).toBeNull();
      expect(groupTexts().filter((t) => t.startsWith("🏁"))).toHaveLength(0);

      // Dan submits game 1 and game 2
      await handleUpdate(makeCtx(tg, FRI_EVENING), dm(dan, eralyShare(8, 400)));
      await handleUpdate(makeCtx(tg, FRI_EVENING), dm(dan, krillionShare(100, 400)));
      expect((await finalizedBefore())?.f).toBeNull();
      expect(groupTexts().filter((t) => t.startsWith("🏁"))).toHaveLength(0);

      // Dan submits game 3 (Size It Up) -> All 4 players have now completed all 3 games!
      tg.clear();
      await handleUpdate(makeCtx(tg, FRI_EVENING), dm(dan, sizeItUpShare(400)));

      // Dan receives confirmation noting that everyone finished and results are being posted
      expect(tg.lastTextTo(dan.id)).toContain("Everyone has finished — posting today's results now!");

      // The podium summary was immediately posted in the group without waiting for midnight!
      const posted = groupTexts().filter((t) => t.startsWith("🏁"));
      expect(posted).toHaveLength(1);
      expect(posted[0]).toContain("🏁 <b>Results · Fri 23 Oct</b>");
      expect(posted[0]).toContain("🏆 <b>Overall</b> (out of 300)");

      // The day is marked finalized in DB
      expect((await finalizedBefore())?.f).not.toBeNull();

      // /today responds that the day is closed
      tg.clear();
      await handleUpdate(makeCtx(tg, FRI_EVENING), inGroup(anna, "/today"));
      expect(tg.lastTextTo(GROUP)).toContain("Today's results are closed. The next board opens at midnight.");

      // Later at midnight, tick() does not re-post or crash
      tg.clear();
      await tick(makeCtx(tg, SAT_0000));
      expect(groupTexts().filter((t) => t.startsWith("🏁"))).toHaveLength(0);
    });
  });
});

describe("/name", () => {
  it("is only for players who have sent a result", async () => {
    await linkGroup();
    await handleUpdate(makeCtx(tg, FRI_NOON), dm(ben, "/name Karppi"));
    expect(tg.lastTextTo(ben.id)).toContain("after your first result");
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM players").first<{ n: number }>();
    expect(count?.n).toBe(0); // no row that would hold up auto-finalize
  });

  it("shows the current name and how to change it", async () => {
    await linkGroup();
    await handleUpdate(makeCtx(tg, FRI_NOON), dm(ben, eralyShare(8, 500)));
    await handleUpdate(makeCtx(tg, FRI_NOON), dm(ben, "/name"));
    expect(tg.lastTextTo(ben.id)).toContain("Your name on the board, podiums and leaderboard is <b>Ben</b>.");
    expect(tg.lastTextTo(ben.id)).toContain("<code>/name Karppi</code>");
  });

  it("renames the player everywhere: board, podium, leaderboard and /me", async () => {
    await linkGroup();
    await handleUpdate(makeCtx(tg, FRI_NOON), dm(anna, eralyShare(8, 640)));
    await handleUpdate(makeCtx(tg, FRI_NOON), dm(ben, eralyShare(8, 500)));
    tg.clear();

    await handleUpdate(makeCtx(tg, FRI_NOON), dm(ben, "/name   Karppi   the Great "));
    expect(tg.lastTextTo(ben.id)).toBe("✅ You're now <b>Karppi the Great</b> on the board, podiums, leaderboard and stats.");
    // Today's board is edited straight away.
    expect(tg.of("editMessageText").at(-1)!.params.text).toContain("✅⬜⬜ Karppi the Great");

    await tick(makeCtx(tg, SAT_0000));
    const podium = groupTexts().find((t) => t.startsWith("🏁"))!;
    expect(podium).toContain("🥈 Karppi the Great · 500");
    expect(podium).not.toContain("Ben");

    await handleUpdate(makeCtx(tg, SAT_0001), inGroup(anna, "/leaderboard"));
    expect(tg.lastTextTo(GROUP)).toContain("2. Karppi the Great  🥇0 🥈1 🥉0");

    await handleUpdate(makeCtx(tg, SAT_0001), inGroup(ben, "/me"));
    expect(tg.lastTextTo(GROUP)).toContain("📊 <b>Karppi the Great</b> · 1 day played");
  });

  it("works in the group, with /nimi too, and /name reset goes back to the Telegram name", async () => {
    await linkGroup();
    await handleUpdate(makeCtx(tg, FRI_NOON), inGroup(chris, eralyShare(8, 500)));
    await handleUpdate(makeCtx(tg, FRI_NOON), inGroup(chris, "/nimi@PodiumTestBot Kalle"));
    expect(tg.lastTextTo(GROUP)).toContain("You're now <b>Kalle</b>");
    await handleUpdate(makeCtx(tg, FRI_NOON), inGroup(chris, "/name reset"));
    expect(tg.lastTextTo(GROUP)).toContain("You're now <b>Chris</b>");
  });

  it("refuses a name someone else has, a too-long name and a name starting with /", async () => {
    await linkGroup();
    await handleUpdate(makeCtx(tg, FRI_NOON), dm(anna, eralyShare(8, 640)));
    await handleUpdate(makeCtx(tg, FRI_NOON), dm(ben, eralyShare(8, 500)));
    await handleUpdate(makeCtx(tg, FRI_NOON), dm(anna, "/name Karppi"));

    await handleUpdate(makeCtx(tg, FRI_NOON), dm(ben, "/name karppi"));
    expect(tg.lastTextTo(ben.id)).toContain("Someone is already called karppi");
    await handleUpdate(makeCtx(tg, FRI_NOON), dm(ben, "/name ANNA"));
    expect(tg.lastTextTo(ben.id)).toContain("Someone is already called ANNA");
    await handleUpdate(makeCtx(tg, FRI_NOON), dm(ben, `/name ${"x".repeat(25)}`));
    expect(tg.lastTextTo(ben.id)).toContain("too long");
    await handleUpdate(makeCtx(tg, FRI_NOON), dm(ben, "/name /today"));
    expect(tg.lastTextTo(ben.id)).toContain("can't start with /");

    // 24 emoji are 24 characters, even though each is several bytes.
    await handleUpdate(makeCtx(tg, FRI_NOON), dm(ben, `/name ${"🦐".repeat(24)}`));
    expect(tg.lastTextTo(ben.id)).toContain("You're now");
    // Keeping your own name, in another case, is fine.
    await handleUpdate(makeCtx(tg, FRI_NOON), dm(anna, "/name KARPPI"));
    expect(tg.lastTextTo(anna.id)).toContain("You're now <b>KARPPI</b>");
  });

  it("escapes HTML in names", async () => {
    await linkGroup();
    await handleUpdate(makeCtx(tg, FRI_NOON), dm(ben, eralyShare(8, 500)));
    await handleUpdate(makeCtx(tg, FRI_NOON), dm(ben, "/name <b>Boss</b>"));
    expect(tg.lastTextTo(ben.id)).toContain("<b>&lt;b&gt;Boss&lt;/b&gt;</b>");
  });
});

describe("command menus", () => {
  const menus = () => env.DB.prepare("SELECT value FROM settings WHERE key = 'command_menus'").first<{ value: string }>();

  it("updates Telegram's menus once after a deploy that changed them, even before /setup", async () => {
    await env.DB.prepare("UPDATE settings SET value = '[]' WHERE key = 'command_menus'").run(); // the old commands
    await tick(makeCtx(tg, FRI_NOON));
    expect(tg.of("setMyCommands").map((c) => c.params)).toEqual([
      { commands: PRIVATE_COMMANDS, scope: { type: "all_private_chats" } },
      { commands: GROUP_COMMANDS, scope: { type: "all_group_chats" } },
    ]);
    expect((await menus())?.value).toBe(COMMAND_MENUS);

    tg.clear();
    await tick(makeCtx(tg, FRI_NOON));
    expect(tg.calls).toEqual([]);
  });

  it("tries again next minute if Telegram fails, without holding up the podium", async () => {
    await linkGroup();
    await handleUpdate(makeCtx(tg, FRI_NOON), dm(anna, eralyShare(8, 640)));
    await env.DB.prepare("DELETE FROM settings WHERE key = 'command_menus'").run();
    tg.fail("setMyCommands", new TelegramError("setMyCommands", 502, "Bad Gateway"));
    await tick(makeCtx(tg, SAT_0000));
    expect(groupTexts().some((t) => t.startsWith("🏁"))).toBe(true);
    expect(await menus()).toBeNull();

    tg.clear();
    await tick(makeCtx(tg, SAT_0001));
    expect(tg.of("setMyCommands")).toHaveLength(2);
    expect((await menus())?.value).toBe(COMMAND_MENUS);
  });
});

describe("!vote-leaderboard", () => {
  it("tells the group if nobody has played yet", async () => {
    await linkGroup();
    await handleUpdate(makeCtx(tg, FRI_NOON), inGroup(anna, "!vote-leaderboard"));
    expect(tg.lastTextTo(GROUP)).toContain("Kukaan ei ole vielä pelannut tänään.");
  });

  it("runs an interim vote with Joo/Ei buttons, lets voters switch votes, and posts interim standings at 4 Joo votes without closing the day", async () => {
    await linkGroup();
    await handleUpdate(makeCtx(tg, FRI_NOON), dm(anna, eralyShare(8, 640)));
    await handleUpdate(makeCtx(tg, FRI_NOON), dm(ben, eralyShare(8, 550)));
    tg.clear();

    // Anna starts the vote
    await handleUpdate(makeCtx(tg, FRI_NOON), inGroup(anna, "!vote-leaderboard"));
    const sentVote = tg.sentTo(GROUP)[0]!;
    expect(sentVote.params.text).toContain("Äänestys: Julkaistaanko päivän väliaikatilanne?");
    expect(sentVote.params.reply_markup).toEqual({
      inline_keyboard: [
        [
          { text: "👍 Joo (0/4)", callback_data: "vote:interim:yes" },
          { text: "👎 Ei (0)", callback_data: "vote:interim:no" },
        ],
      ],
    });
    const voteMsgId = tg.nextMessageId - 1;

    // Anna, Ben, Chris vote Joo; Dan votes Ei first
    await handleUpdate(makeCtx(tg, FRI_NOON), clickButton(anna, "vote:interim:yes", voteMsgId));
    await handleUpdate(makeCtx(tg, FRI_NOON), clickButton(ben, "vote:interim:yes", voteMsgId));
    await handleUpdate(makeCtx(tg, FRI_NOON), clickButton(chris, "vote:interim:yes", voteMsgId));
    await handleUpdate(makeCtx(tg, FRI_NOON), clickButton(dan, "vote:interim:no", voteMsgId));

    const lastEdit = tg.of("editMessageText").at(-1)!;
    expect(lastEdit.params.text).toContain("👍 <b>Joo (3/4):</b> Anna, Ben, Chris");
    expect(lastEdit.params.text).toContain("👎 <b>Ei (1):</b> Dan");

    // Dan changes mind from Ei to Joo -> 4/4 Joo reached!
    tg.clear();
    await handleUpdate(makeCtx(tg, FRI_NOON), clickButton(dan, "vote:interim:yes", voteMsgId));

    // Vote message is updated to completed without buttons
    const finalVoteEdit = tg.of("editMessageText").at(-1)!;
    expect(finalVoteEdit.params.text).toContain("✅ <b>Äänestys hyväksytty (4/4) – julkaistaan väliaikatilanne!</b>");
    expect(finalVoteEdit.params.reply_markup).toBeUndefined();

    // Interim summary is posted in the group
    const interimPost = tg.sentTo(GROUP)[0]!;
    expect(interimPost.params.text).toContain("⏱️ <b>Väliaikatilanne · Fri 23 Oct</b>");
    expect(interimPost.params.text).toContain("🥇 Anna · 640");
    expect(interimPost.params.text).toContain("🥈 Ben · 550");
    expect(interimPost.params.text).toContain('Vastaa tähän viestiin "finalize"');
    const interimMsgId = tg.nextMessageId - 1;

    // Day is STILL open: Chris can submit a game after the interim leaderboard!
    const dayRow = await env.DB.prepare("SELECT finalized_at AS f FROM days WHERE day = '2026-10-23'").first<{ f: string | null }>();
    expect(dayRow?.f).toBeNull();
    await handleUpdate(makeCtx(tg, FRI_EVENING), dm(chris, eralyShare(8, 690)));
    expect(tg.lastTextTo(chris.id)).toContain("✅ Eraly #8: 690/700 saved.");

    // Now Ben replies "finalize" to the interim summary message -> launches finalize vote!
    tg.clear();
    const replyUpdate = inGroup(ben, "finalize");
    replyUpdate.message!.reply_to_message = {
      message_id: interimMsgId,
      from: { id: 999, is_bot: true, first_name: "Podium" },
      chat: { id: GROUP, type: "supergroup" },
      text: interimPost.params.text as string,
    };
    await handleUpdate(makeCtx(tg, FRI_EVENING), replyUpdate);

    const finalizeVote = tg.sentTo(GROUP)[0]!;
    expect(finalizeVote.params.text).toContain("Äänestys: Suljetaanko päivän kisa ja julkaistaan lopulliset tulokset?");
    const finalizeVoteMsgId = tg.nextMessageId - 1;

    // All 4 vote Joo on the finalize vote
    for (const u of [anna, ben, chris, dan]) {
      await handleUpdate(makeCtx(tg, FRI_EVENING), clickButton(u, "vote:finalize:yes", finalizeVoteMsgId));
    }

    // Final results are posted with Chris's new score included, and the day is finalized!
    const finalSummary = groupTexts().find((t) => t.startsWith("🏁"))!;
    expect(finalSummary).toContain("🏁 <b>Results · Fri 23 Oct</b>");
    expect(finalSummary).toContain("🥇 Chris · 690");
    expect(finalSummary).toContain("🥈 Anna · 640");

    const dayRowAfter = await env.DB.prepare("SELECT finalized_at AS f FROM days WHERE day = '2026-10-23'").first<{ f: string | null }>();
    expect(dayRowAfter?.f).not.toBeNull();
  });

  it("supports direct '!vote-leaderboard finalize' command to close the day with 4 Joo votes", async () => {
    await linkGroup();
    await handleUpdate(makeCtx(tg, FRI_NOON), dm(anna, eralyShare(8, 640)));
    tg.clear();

    await handleUpdate(makeCtx(tg, FRI_EVENING), inGroup(anna, "!vote-leaderboard finalize"));
    const sentVote = tg.sentTo(GROUP)[0]!;
    expect(sentVote.params.text).toContain("Suljetaanko päivän kisa ja julkaistaan lopulliset tulokset?");
    const voteMsgId = tg.nextMessageId - 1;

    for (const u of [anna, ben, chris, dan]) {
      await handleUpdate(makeCtx(tg, FRI_EVENING), clickButton(u, "vote:finalize:yes", voteMsgId));
    }

    expect(groupTexts().some((t) => t.startsWith("🏁 <b>Results · Fri 23 Oct</b>"))).toBe(true);
    const dayRow = await env.DB.prepare("SELECT finalized_at AS f FROM days WHERE day = '2026-10-23'").first<{ f: string | null }>();
    expect(dayRow?.f).not.toBeNull();
  });
});
