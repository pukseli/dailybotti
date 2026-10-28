// Context and message-sending helpers shared by the bot's features.

import { setSetting, type Settings } from "./db";
import type { Ai } from "./regressio";
import { TelegramError, type ChatMember, type InlineKeyboardMarkup, type Message, type Telegram } from "./telegram";
import { isClosed, localParts } from "./time";

export interface Ctx {
  db: D1Database;
  tg: Telegram;
  now: Date;
  timeZone: string;
  closeTime: string;
  ai?: Ai;
}

/** How many players the group has. The early podium and the early imitation vote wait for this many. */
export const EXPECTED_PLAYERS = 4;

export function today(ctx: Ctx): string {
  return localParts(ctx.now, ctx.timeZone).date;
}

export function dayIsClosed(ctx: Ctx, day: string): boolean {
  return isClosed(day, ctx.now, ctx.timeZone, ctx.closeTime);
}

// ---------- sending ----------

export interface SendOptions {
  silent?: boolean;
  replyTo?: Message;
  replyMarkup?: InlineKeyboardMarkup;
}

export async function send(ctx: Ctx, chatId: number, text: string, opts: SendOptions & { threadId?: number | null } = {}): Promise<Message> {
  const params: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  };
  if (opts.silent) params.disable_notification = true;
  if (opts.threadId) params.message_thread_id = opts.threadId;
  if (opts.replyTo) params.reply_parameters = { message_id: opts.replyTo.message_id, allow_sending_without_reply: true };
  if (opts.replyMarkup) params.reply_markup = opts.replyMarkup;
  return ctx.tg.call<Message>("sendMessage", params);
}

/** Replies in the chat (and forum topic) the message came from. */
export function reply(ctx: Ctx, msg: Message, text: string): Promise<Message> {
  const threadId = msg.is_topic_message ? msg.message_thread_id : undefined;
  return send(ctx, msg.chat.id, text, msg.chat.type === "private" ? {} : { replyTo: msg, threadId });
}

/** Sends to the linked group, following it if Telegram has upgraded it to a supergroup. */
export async function sendToGroup(ctx: Ctx, settings: Settings, text: string, opts: SendOptions = {}): Promise<Message> {
  try {
    return await send(ctx, settings.groupChatId!, text, { ...opts, threadId: settings.groupThreadId });
  } catch (err) {
    if (!(err instanceof TelegramError) || !err.migrateToChatId) throw err;
    await setSetting(ctx.db, "group_chat_id", err.migrateToChatId);
    settings.groupChatId = err.migrateToChatId;
    return send(ctx, settings.groupChatId, text, { ...opts, threadId: settings.groupThreadId });
  }
}

export async function tryCall(ctx: Ctx, method: string, params: Record<string, unknown>): Promise<boolean> {
  try {
    await ctx.tg.call(method, params);
    return true;
  } catch (err) {
    console.warn(`${method} failed`, err instanceof Error ? err.message : err);
    return false;
  }
}

export async function isGroupMember(ctx: Ctx, groupId: number, userId: number): Promise<boolean> {
  try {
    const m = await ctx.tg.call<ChatMember>("getChatMember", { chat_id: groupId, user_id: userId });
    return ["creator", "administrator", "member"].includes(m.status) || (m.status === "restricted" && m.is_member !== false);
  } catch (err) {
    // If Telegram can't tell us, let them in rather than block a friend.
    console.warn("getChatMember failed", err instanceof Error ? err.message : err);
    return true;
  }
}
