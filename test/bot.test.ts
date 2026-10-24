import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { handleUpdate, tick } from "../src/bot";
import { getSettings } from "../src/db";
import { TelegramError } from "../src/telegram";
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
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('bot_username', ?), ('bot_id', '999')").bind(BOT_USERNAME).run();
});

describe("/setup", () => {
  it("only lets a group admin link the group", async () => {
    await handleUpdate(makeCtx(tg, FRI_NOON), inGroup(ben, "/setup"));
    expect(tg.lastTextTo(GROUP)).toContain("Only group admins");
    expect((await getSettings(env.DB)).groupChatId).toBeNull();

    await handleUpdate(makeCtx(tg, FRI_NOON), inGroup(anna, "/setup@PodiumTestBot"));
    expect(tg.lastTextTo(GROUP)).toContain("Linked to this group");
    expect(tg.lastTextTo(GROUP)).not.toContain("Delete messages");
    expect((await getSettings(env.DB)).groupChatId).toBe(GROUP);
  });

  it("asks for the delete right when the bot is not allowed to delete", async () => {
    tg.botCanDelete = false;
    await handleUpdate(makeCtx(tg, FRI_NOON), inGroup(anna, "/setup"));
    expect(tg.lastTextTo(GROUP)).toContain("Delete messages");
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

  it("answers /start with instructions", async () => {
    await linkGroup();
    await handleUpdate(makeCtx(tg, FRI_NOON), dm(anna, "/start"));
    expect(tg.lastTextTo(anna.id)).toContain("How it works");
    expect(tg.lastTextTo(anna.id)).not.toContain("not linked");
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
  it("confirms privately and removes the message", async () => {
    await linkGroup();
    const update = inGroup(chris, eralyShare(8, 500));
    await handleUpdate(makeCtx(tg, FRI_NOON), update);
    expect(tg.lastTextTo(chris.id)).toContain("✅ Eraly #8: 500/700 saved.");
    expect(tg.of("deleteMessage")[0]!.params).toEqual({ chat_id: GROUP, message_id: update.message!.message_id });
    expect(tg.lastTextTo(GROUP)).toContain("✅⬜⬜ Chris"); // the board
  });

  it("answers in the group when it can't message the player privately", async () => {
    await linkGroup();
    tg.noPrivateChat.add(dan.id);
    const update = inGroup(dan, krillionShare(100, 300));
    await handleUpdate(makeCtx(tg, FRI_NOON), update);
    expect(tg.of("deleteMessage")).toHaveLength(0);
    const answer = tg.sentTo(GROUP).find((c) => (c.params.text as string).includes("Krillion #100: 300/700 saved"));
    expect(answer?.params.reply_parameters).toEqual({ message_id: update.message!.message_id, allow_sending_without_reply: true });
    expect(answer?.params.text).toContain("Tip: send results to @PodiumTestBot");
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
