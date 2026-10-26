import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { handleUpdate, tick } from "../src/bot";
import { COMMAND_MENUS } from "../src/commands";
import { imitationScores } from "../src/imitation";
import { renderHelp } from "../src/render";
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
  tap,
  voiceInGroup,
  type Call,
} from "./helpers";
import type { User } from "../src/telegram";

// Friday 23 Oct 2026 in Helsinki (UTC+3). Summer time ends on Sunday 25 Oct (then UTC+2).
const DAY = "2026-10-23";
const T0830 = "2026-10-23T05:30:00Z";
const T0900 = "2026-10-23T06:00:30Z";
const T1200 = "2026-10-23T09:00:00Z";
const T2100 = "2026-10-23T18:00:30Z";
const T2200 = "2026-10-23T19:00:00Z";
const SAT0000 = "2026-10-23T21:00:30Z";
const SAT0900 = "2026-10-24T06:00:30Z";
const SUN0900 = "2026-10-25T07:00:30Z";
const MON0900 = "2026-10-26T07:00:30Z";

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

/** Everyone sends an Eraly result, which puts them on the player list. */
async function register(now = T0830): Promise<void> {
  const scores = [640, 500, 450, 300];
  for (const [i, p] of PLAYERS.entries()) await handleUpdate(makeCtx(tg, now), dm(p, eralyShare(8, scores[i]!)));
}

async function suggest(...names: string[]): Promise<void> {
  for (const name of names) await handleUpdate(makeCtx(tg, T0830), inGroup(anna, `/ehdota ${name}`));
}

/** Registered players, a drawn character and everyone's recording: the vote is open. */
async function openVoteWithEveryone(): Promise<void> {
  await register();
  await suggest("Mikki Hiiri");
  await tick(makeCtx(tg, T0900));
  for (const p of PLAYERS) await handleUpdate(makeCtx(tg, T1200), voiceInGroup(p));
}

function groupTexts(): string[] {
  return tg.sentTo(GROUP).map((c) => c.params.text as string);
}

function ballot(user: User): Call {
  return tg.sentTo(user.id).filter((c) => c.params.reply_markup).at(-1)!;
}

function buttons(call: { params: Record<string, any> }): string[] {
  return call.params.reply_markup.inline_keyboard.flat().map((b: { text: string }) => b.text);
}

function answers(): string[] {
  return tg.of("answerCallbackQuery").map((c) => c.params.text as string);
}

async function vote(voter: User, first: User, second: User | null, now = T2200): Promise<void> {
  const messageId = ballot(voter).result.message_id as number;
  await handleUpdate(makeCtx(tg, now), tap(voter, `iv:${DAY}:${first.id}`, messageId));
  if (second) await handleUpdate(makeCtx(tg, now), tap(voter, `iv:${DAY}:${second.id}`, messageId));
}

describe("suggestions", () => {
  it("adds, refuses duplicates and lists what's left", async () => {
    await handleUpdate(makeCtx(tg, T0830), inGroup(anna, "/ehdota   Mikki   Hiiri "));
    expect(tg.of("setMessageReaction")[0]!.params.reaction).toEqual([{ type: "emoji", emoji: "👍" }]);

    await handleUpdate(makeCtx(tg, T0830), inGroup(ben, "/ehdota mikki hiiri"));
    expect(tg.lastTextTo(GROUP)).toBe("Mikki Hiiri on jo ehdotuslistalla.");

    await handleUpdate(makeCtx(tg, T0830), dm(ben, "/ehdota Aku Ankka"));
    expect(tg.lastTextTo(ben.id)).toBe("✅ Lisätty ehdotuksiin: <b>Aku Ankka</b>. Ehdotuksia jäljellä: 2.");

    await handleUpdate(makeCtx(tg, T0830), dm(stranger, "/ehdota Hessu Hopo"));
    expect(tg.lastTextTo(stranger.id)).toContain("Vain ryhmän jäsenet");

    await handleUpdate(makeCtx(tg, T0830), inGroup(ben, "/ehdota"));
    expect(tg.lastTextTo(GROUP)).toContain("<code>/ehdota Mikki Hiiri</code>");
    await handleUpdate(makeCtx(tg, T0830), inGroup(ben, `/ehdota ${"x".repeat(61)}`));
    expect(tg.lastTextTo(GROUP)).toContain("enintään 60 merkkiä");

    await handleUpdate(makeCtx(tg, T0830), inGroup(chris, "/ehdotukset"));
    expect(tg.lastTextTo(GROUP)).toBe(
      "📝 <b>Imitaatioehdotukset</b> · 2 jäljellä\n• Mikki Hiiri\n• Aku Ankka\n\nJo käytetty: 0. Lisää uusi: /ehdota Nimi",
    );
  });

  it("says when a suggestion has already been a challenge", async () => {
    await register();
    await suggest("Mikki Hiiri");
    await tick(makeCtx(tg, T0900));
    await handleUpdate(makeCtx(tg, T1200), inGroup(ben, "/ehdota Mikki Hiiri"));
    expect(tg.lastTextTo(GROUP)).toBe("Mikki Hiiri oli jo haasteena 23.10.");
  });
});

describe("the daily draw", () => {
  it("announces the character at 09:00, once", async () => {
    await register();
    await suggest("Mikki Hiiri");
    await tick(makeCtx(tg, T0830));
    expect(groupTexts().some((t) => t.includes("Päivän imitaatio"))).toBe(false);

    await handleUpdate(makeCtx(tg, T0830), inGroup(ben, "/haaste"));
    expect(tg.lastTextTo(GROUP)).toBe("🎭 Päivän imitaatiohaaste arvotaan klo 09:00.");

    await tick(makeCtx(tg, T0900));
    await tick(makeCtx(tg, T1200));
    const announcements = groupTexts().filter((t) => t.startsWith("🎭 <b>Päivän imitaatio: Mikki Hiiri</b>"));
    expect(announcements).toHaveLength(1);
    expect(announcements[0]).toContain("ääniviestinä tähän ryhmään klo 21:00 mennessä");
    expect(announcements[0]).toContain("@PodiumTestBot");
  });

  it("never draws the same character twice, and says once when they run out", async () => {
    await register();
    await suggest("Mikki Hiiri", "Aku Ankka");
    for (const t of [T0900, SAT0900, SUN0900, MON0900]) await tick(makeCtx(tg, t));
    const drawn = groupTexts()
      .filter((t) => t.startsWith("🎭 <b>Päivän imitaatio:"))
      .map((t) => /Päivän imitaatio: (.+?)<\/b>/.exec(t)![1]);
    expect(drawn.sort()).toEqual(["Aku Ankka", "Mikki Hiiri"]);
    expect(groupTexts().filter((t) => t.includes("ehdotukset ovat loppuneet"))).toHaveLength(1);
  });

  it("ignores voice messages when there is no contest", async () => {
    await register();
    tg.clear();
    await handleUpdate(makeCtx(tg, T1200), voiceInGroup(anna));
    expect(tg.calls).toEqual([]);
  });
});

describe("a full contest", () => {
  it("collects recordings, sends private ballots, counts 3 + 1 points and adds them to the podium", async () => {
    await register();
    await suggest("Mikki Hiiri");
    await tick(makeCtx(tg, T0900));

    for (const p of [anna, ben, chris]) await handleUpdate(makeCtx(tg, T1200), voiceInGroup(p));
    expect(tg.of("setMessageReaction").filter((c) => c.params.reaction[0].emoji === "👏")).toHaveLength(3);
    expect(tg.sentTo(anna.id).filter((c) => c.params.reply_markup)).toHaveLength(0); // no ballots yet
    const board = tg.of("editMessageText").at(-1)!.params.text as string;
    expect(board).toContain("Eraly #8 · Krillion #100 · Size It Up · 🎭 Mikki Hiiri");
    expect(board).toContain("✅⬜⬜✅ Anna");
    expect(board).toContain("✅⬜⬜⬜ Dan");

    await handleUpdate(makeCtx(tg, T1200), inGroup(dan, "/haaste"));
    expect(tg.lastTextTo(GROUP)).toContain("Äänitteet (3/4): ✅ Anna · ✅ Ben · ✅ Chris · ⏳ Dan");

    // The last recording opens the vote straight away.
    await handleUpdate(makeCtx(tg, T1200), voiceInGroup(dan));
    for (const p of PLAYERS) {
      const options = buttons(ballot(p));
      expect(options).toHaveLength(3);
      expect(options).not.toContain(p.first_name); // nobody can vote for themselves
    }
    expect(ballot(anna).params.text).toContain("Valitse <b>paras</b> suoritus (3 p).");
    const status = groupTexts().find((t) => t.startsWith("🗳️ <b>Äänestys alkoi: Mikki Hiiri</b>"))!;
    expect(status).toContain("Äänestäneet (0/4): –");

    // A forged tap on your own recording is refused.
    await handleUpdate(makeCtx(tg, T2200), tap(anna, `iv:${DAY}:${anna.id}`, ballot(anna).result.message_id));
    expect(answers().at(-1)).toBe("Omaa suoritusta ei voi äänestää.");

    await vote(anna, ben, chris);
    const edited = tg.of("editMessageText").filter((c) => c.params.chat_id === anna.id);
    expect(edited[0]!.params.text).toContain("1. Ben (3 p)\nValitse <b>toiseksi paras</b> (1 p).");
    expect(buttons(edited[0]!)).toEqual(["Chris", "Dan", "↩️ Aloita alusta"]);
    expect(edited[1]!.params.text).toContain("✅ Äänesi on tallessa:\n1. Ben (3 p)\n2. Chris (1 p)");
    expect(answers().slice(-2)).toEqual(["1. Ben (3 p)", "Kiitos, äänesi on tallessa!"]);
    const progress = tg.of("editMessageText").filter((c) => c.params.chat_id === GROUP).at(-1)!.params.text as string;
    expect(progress).toContain("Äänestäneet (1/4): Anna");

    await vote(ben, anna, chris);
    await vote(chris, ben, anna);
    expect(groupTexts().some((t) => t.includes("tulokset"))).toBe(false);
    await vote(dan, ben, anna);

    // Ben 3+3+3 = 9/9, Anna 3+1+1 = 5/9, Chris 1+1 = 2/9, Dan 0/9.
    expect(groupTexts().find((t) => t.includes("tulokset"))).toBe(
      "🎭 <b>Imitaatio: Mikki Hiiri – tulokset</b>\n🥇 Ben · 9/9 p\n🥈 Anna · 5/9 p\n🥉 Chris · 2/9 p\n4. Dan · 0/9 p\n\nPisteet lasketaan mukaan päivän kokonaispisteisiin.",
    );
    expect(groupTexts().some((t) => t.startsWith("🏁"))).toBe(false); // the games aren't done yet

    await tick(makeCtx(tg, SAT0000));
    const podium = groupTexts().find((t) => t.startsWith("🏁"))!;
    expect(podium).toContain("<b>🎭 Imitaatio: Mikki Hiiri</b>\n🥇 Ben · 9/9 p\n🥈 Anna · 5/9 p\n🥉 Chris · 2/9 p\n4. Dan · 0/9 p");
    // Eraly % + imitation %: Ben 71.4 + 100, Anna 91.4 + 55.6, Chris 64.3 + 22.2, Dan 42.9 + 0.
    expect(podium).toContain(
      "🏆 <b>Overall</b> (out of 400)\n🥇 Ben · 171.4 · 2/4 games\n🥈 Anna · 147.0 · 2/4 games\n🥉 Chris · 86.5 · 2/4 games\n4. Dan · 42.9 · 2/4 games",
    );

    await handleUpdate(makeCtx(tg, SAT0900), inGroup(anna, "/leaderboard"));
    expect(tg.lastTextTo(GROUP)).toContain("🎭 Imitaatio: Ben 1");
    await handleUpdate(makeCtx(tg, SAT0900), dm(ben, "/me"));
    expect(tg.lastTextTo(ben.id)).toContain("<b>🎭 Imitaatio</b>: 🥇1 🥈0 🥉0 · avg 100 % · best 100 % · 1 played");
  });

  it("posts the podium as soon as the last vote is in when everyone has played everything", async () => {
    await register();
    await suggest("Mikki Hiiri");
    // Games all done before the draw: the podium waits, because a contest is still to come.
    for (const p of PLAYERS) await handleUpdate(makeCtx(tg, T0830), dm(p, `${krillionShare(100, 300)}\n\n${sizeItUpShare(300)}`));
    expect(groupTexts().some((t) => t.startsWith("🏁"))).toBe(false);
    await tick(makeCtx(tg, T0900));
    expect(groupTexts().some((t) => t.startsWith("🏁"))).toBe(false);

    for (const p of PLAYERS) await handleUpdate(makeCtx(tg, T1200), voiceInGroup(p));
    await vote(anna, ben, chris);
    await vote(ben, anna, chris);
    await vote(chris, ben, anna);
    expect(groupTexts().some((t) => t.startsWith("🏁"))).toBe(false);
    await vote(dan, ben, anna);
    const podium = groupTexts().find((t) => t.startsWith("🏁"))!;
    expect(podium).toContain("(out of 400)");
    expect(podium).toContain("🥇 Ben · 9/9 p");
  });
});

describe("deadlines", () => {
  it("opens the vote at 21:00 with whoever has sent, and counts what was voted by the end of the day", async () => {
    await register();
    await suggest("Mikki Hiiri");
    await tick(makeCtx(tg, T0900));
    for (const p of [anna, ben, chris]) await handleUpdate(makeCtx(tg, T1200), voiceInGroup(p));

    await tick(makeCtx(tg, T2100));
    expect(buttons(ballot(dan)).sort()).toEqual(["Anna", "Ben", "Chris"]);
    expect(buttons(ballot(anna)).sort()).toEqual(["Ben", "Chris"]);

    // A late recording is turned away; someone who already sent one isn't nagged.
    await handleUpdate(makeCtx(tg, T2200), voiceInGroup(dan));
    expect(tg.lastTextTo(GROUP)).toBe("⏰ Äänestys on jo alkanut, joten tämä äänite ei osallistu tämän päivän imitaatioon.");
    const before = tg.sentTo(GROUP).length;
    await handleUpdate(makeCtx(tg, T2200), voiceInGroup(anna));
    expect(tg.sentTo(GROUP)).toHaveLength(before);

    await vote(anna, ben, chris);
    await vote(dan, ben, null); // only a first choice by midnight
    await tick(makeCtx(tg, SAT0000));
    expect(groupTexts().some((t) => t.includes("tulokset"))).toBe(false); // the podium carries them
    // Cast ballots: Anna's and Dan's. Ben 3+3 of 6, Chris 1 of 6, Anna 0 of 3 (only Dan's ballot could pick her).
    expect(groupTexts().find((t) => t.startsWith("🏁"))).toContain(
      "<b>🎭 Imitaatio: Mikki Hiiri</b>\n🥇 Ben · 6/6 p\n🥈 Chris · 1/6 p\n🥉 Anna · 0/3 p",
    );
  });

  it("calls the contest off with fewer than two recordings", async () => {
    await register();
    await suggest("Mikki Hiiri");
    await tick(makeCtx(tg, T0900));
    await handleUpdate(makeCtx(tg, T1200), voiceInGroup(anna));
    await tick(makeCtx(tg, T2100));
    expect(groupTexts().at(-1)).toBe(
      "🎭 Imitaatioon (Mikki Hiiri) tuli vain yksi suoritus, joten äänestystä ei järjestetä eikä imitaatio vaikuta tämän päivän pisteisiin.",
    );
    expect(tg.of("sendMessage").filter((c) => c.params.reply_markup)).toHaveLength(0);
    await tick(makeCtx(tg, SAT0000));
    const podium = groupTexts().find((t) => t.startsWith("🏁"))!;
    expect(podium).toContain("(out of 300)");
    expect(podium).not.toContain("Imitaatio");
  });
});

describe("ballots", () => {
  it("can be changed until the vote ends, and refuse taps that don't make sense", async () => {
    await openVoteWithEveryone();
    const id = ballot(anna).result.message_id as number;
    const press = (data: string, user = anna) => handleUpdate(makeCtx(tg, T2200), tap(user, data, id));

    await press(`iv:${DAY}:${ben.id}`);
    await press(`iv:${DAY}:${ben.id}`);
    expect(answers().at(-1)).toBe("Valitsit jo tämän parhaaksi. Valitse toiseksi paras.");
    await press(`iv:${DAY}:${chris.id}`);
    await press(`iv:${DAY}:${dan.id}`);
    expect(answers().at(-1)).toBe("Äänesi on jo tallessa. Paina ”Muuta ääntä”, jos haluat vaihtaa.");

    await press(`ir:${DAY}`);
    expect(answers().at(-1)).toBe("Valitse uudelleen.");
    await press(`iv:${DAY}:${dan.id}`);
    await press(`iv:${DAY}:${chris.id}`);
    const row = await env.DB.prepare("SELECT first_id, second_id FROM imitation_votes WHERE voter_id = ?").bind(anna.id).first();
    expect(row).toEqual({ first_id: dan.id, second_id: chris.id });

    await press(`iv:${DAY}:${ben.id}`, stranger);
    expect(answers().at(-1)).toBe("Sinulla ei ole äänestyslippua tähän äänestykseen.");

    await tick(makeCtx(tg, SAT0000));
    await press(`ir:${DAY}`);
    expect(answers().at(-1)).toBe("Tämä äänestys on jo päättynyt.");

    // Telegram needs exactly one answer per tap, or the button keeps spinning.
    const taps = tg.calls.filter((c) => c.method === "answerCallbackQuery").map((c) => c.params.callback_query_id);
    expect(taps).toHaveLength(9);
    expect(new Set(taps).size).toBe(9);
  });

  it("links each recording, and the latest recording is the one that counts", async () => {
    await register();
    await suggest("Mikki Hiiri");
    await tick(makeCtx(tg, T0900));
    await handleUpdate(makeCtx(tg, T1200), voiceInGroup(anna));
    const retake = voiceInGroup(anna);
    await handleUpdate(makeCtx(tg, T1200), retake);
    for (const p of [ben, chris, dan]) await handleUpdate(makeCtx(tg, T1200), voiceInGroup(p));
    expect(ballot(ben).params.text).toContain(`<a href="https://t.me/c/1234567890/${retake.message!.message_id}">Anna</a>`);
  });

  it("names players the bot couldn't reach, and /aanesta sends them a ballot", async () => {
    await register();
    await suggest("Mikki Hiiri");
    await tick(makeCtx(tg, T0900));
    tg.noPrivateChat.add(dan.id);
    for (const p of PLAYERS) await handleUpdate(makeCtx(tg, T1200), voiceInGroup(p));
    const status = groupTexts().find((t) => t.startsWith("🗳️"))!;
    expect(status).toContain("⚠️ En saanut lähetettyä äänestyslippua: Dan. Avaa @PodiumTestBot, paina Start ja lähetä /aanesta.");

    await handleUpdate(makeCtx(tg, T2200), inGroup(dan, "/aanesta"));
    expect(tg.lastTextTo(GROUP)).toContain("Äänestys käydään yksityisesti");

    tg.noPrivateChat.delete(dan.id); // Dan presses Start
    await handleUpdate(makeCtx(tg, T2200), dm(dan, "/aanesta"));
    expect(buttons(ballot(dan)).sort()).toEqual(["Anna", "Ben", "Chris"]);
    const progress = tg.of("editMessageText").filter((c) => c.params.chat_id === GROUP).at(-1)!.params.text as string;
    expect(progress).not.toContain("En saanut");
  });
});

describe("scoring and help", () => {
  it("gives 3 and 1 points and leaves uncast ballots out of everyone's maximum", () => {
    const scores = imitationScores(
      [1, 2, 3],
      [
        { voterId: 1, firstId: 2, secondId: 3 },
        { voterId: 2, firstId: 1, secondId: 3 },
        { voterId: 3, firstId: null, secondId: null },
        { voterId: 4, firstId: 2, secondId: null },
      ],
    );
    expect(Object.fromEntries(scores)).toEqual({
      1: { points: 3, max: 6 },
      2: { points: 6, max: 6 },
      3: { points: 2, max: 9 },
    });
  });

  it("keeps the help message within Telegram's limit and explains the contest", () => {
    const help = renderHelp({ closeTime: "00:00", timeZone: "Europe/Helsinki", linked: true });
    expect(help.length).toBeLessThan(4096);
    expect(help).toContain("<b>🎭 Imitaatiokisa</b>");
    expect(help).toContain("/ehdota Nimi");
  });
});
