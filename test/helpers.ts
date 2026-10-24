import { env } from "cloudflare:workers";
import type { Ctx } from "../src/bot";
import { TelegramError, type ChatMember, type Telegram, type Update, type User } from "../src/telegram";

// Share texts built exactly the way each game's own code builds them.

export function eralyShare(puzzle: number, total: number): string {
  const filled = Math.round((total / 700) * 10);
  return `Eraly #${puzzle} · I travelled to 1450 AD\n${"▰".repeat(filled)}${"▱".repeat(10 - filled)} ${total}/700\nhttps://eraly.io`;
}

export function krillionShare(puzzle: number, score: number, withLink = true): string {
  const text = `Krillion #${puzzle} 🦐\n${score}\n\n🫧🐟🦑🏮🌟⬛🤡`;
  return withLink ? `${text}\n\nhttps://krillion.io` : text;
}

export function sizeItUpShare(total: number, label = "Size It Up"): string {
  const rounds = [total / 5, total / 5, total / 5, total / 5, total / 5].map((e) => {
    const t = Math.max(0, Math.min(5, Math.round(e / 20)));
    return `${"🟥".repeat(t)}${"⬜".repeat(5 - t)} ${Math.round(e)}`;
  });
  return [label, `Overall Score ${total}`, "", ...rounds, "https://magnitudle.com/size-it-up"].join("\n");
}

// Telegram fake: records every call and answers like the real API.

export const GROUP = -1001234567890;
export const BOT_ID = 999;
export const BOT_USERNAME = "PodiumTestBot";

export const anna: User = { id: 101, is_bot: false, first_name: "Anna", last_name: "Korhonen", username: "anna" };
export const ben: User = { id: 102, is_bot: false, first_name: "Ben" };
export const chris: User = { id: 103, is_bot: false, first_name: "Chris" };
export const dan: User = { id: 104, is_bot: false, first_name: "Dan" };
export const stranger: User = { id: 200, is_bot: false, first_name: "Stranger" };

export interface Call {
  method: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params: Record<string, any>;
}

export class FakeTelegram implements Telegram {
  calls: Call[] = [];
  nextMessageId = 5000;
  /** Membership status in GROUP; anyone missing has left. */
  members = new Map<number, ChatMember["status"]>([
    [anna.id, "creator"],
    [ben.id, "member"],
    [chris.id, "member"],
    [dan.id, "member"],
  ]);
  botCanDelete = true;
  /** Users who never pressed Start, so the bot can't message them. */
  noPrivateChat = new Set<number>();
  /** One-off errors: the next matching call throws. */
  failures: { method: string; error: TelegramError; when?: (params: Record<string, unknown>) => boolean }[] = [];

  fail(method: string, error: TelegramError, when?: (params: Record<string, unknown>) => boolean): void {
    this.failures.push({ method, error, when });
  }

  async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    this.calls.push({ method, params });
    const i = this.failures.findIndex((f) => f.method === method && (!f.when || f.when(params)));
    if (i >= 0) throw this.failures.splice(i, 1)[0]!.error;
    return this.answer(method, params) as T;
  }

  private answer(method: string, params: Record<string, unknown>): unknown {
    switch (method) {
      case "getMe":
        return { id: BOT_ID, is_bot: true, first_name: "Podium", username: BOT_USERNAME };
      case "sendMessage": {
        const chatId = params.chat_id as number;
        if (chatId > 0 && this.noPrivateChat.has(chatId)) {
          throw new TelegramError(method, 403, "Forbidden: bot can't initiate conversation with a user");
        }
        return { message_id: this.nextMessageId++, chat: { id: chatId, type: chatId > 0 ? "private" : "supergroup" }, text: params.text };
      }
      case "getChatMember": {
        if (params.user_id === BOT_ID) return { status: "administrator", can_delete_messages: this.botCanDelete };
        return { status: this.members.get(params.user_id as number) ?? "left" };
      }
      default:
        return true;
    }
  }

  of(method: string): Call[] {
    return this.calls.filter((c) => c.method === method);
  }

  sentTo(chatId: number): Call[] {
    return this.of("sendMessage").filter((c) => c.params.chat_id === chatId);
  }

  lastTextTo(chatId: number): string {
    const sent = this.sentTo(chatId);
    return sent[sent.length - 1]?.params.text ?? "";
  }

  clear(): void {
    this.calls = [];
  }
}

let nextId = 1;

export function dm(user: User, text: string): Update {
  const id = nextId++;
  return { update_id: id, message: { message_id: id, from: user, chat: { id: user.id, type: "private" }, text } };
}

export function inGroup(user: User, text: string, chatId = GROUP): Update {
  const id = nextId++;
  return { update_id: id, message: { message_id: id, from: user, chat: { id: chatId, type: "supergroup", title: "Games" }, text } };
}

export function makeCtx(tg: FakeTelegram, now: string, overrides: Partial<Ctx> = {}): Ctx {
  return { db: env.DB, tg, now: new Date(now), timeZone: "Europe/Helsinki", closeTime: "00:00", ...overrides };
}

export async function resetDb(): Promise<void> {
  await env.DB.batch(
    ["placements", "results", "days", "players", "settings"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
  );
}
