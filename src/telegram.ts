// Minimal Telegram Bot API client and the parts of the update types the bot uses.

export interface User {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  /** Only in getMe: true when privacy mode is off, so the bot sees every group message. */
  can_read_all_group_messages?: boolean;
}

export interface Chat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
}

export interface Message {
  message_id: number;
  message_thread_id?: number;
  is_topic_message?: boolean;
  from?: User;
  sender_chat?: Chat;
  chat: Chat;
  text?: string;
  caption?: string;
  reply_to_message?: Message;
  migrate_to_chat_id?: number;
}

export interface Update {
  update_id: number;
  message?: Message;
}

export interface ChatMember {
  status: "creator" | "administrator" | "member" | "restricted" | "left" | "kicked";
  is_member?: boolean;
}

export class TelegramError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    readonly description: string,
    readonly migrateToChatId?: number,
  ) {
    super(`Telegram ${method} failed (${code}): ${description}`);
  }
}

export interface Telegram {
  call<T = unknown>(method: string, params: Record<string, unknown>): Promise<T>;
}

export function createTelegram(token: string, apiBase = "https://api.telegram.org"): Telegram {
  return {
    async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
      let body: { ok: boolean; result?: T; error_code?: number; description?: string; parameters?: { migrate_to_chat_id?: number } };
      try {
        const res = await fetch(`${apiBase}/bot${token}/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(params),
        });
        body = await res.json();
      } catch (err) {
        throw new TelegramError(method, 0, err instanceof Error ? err.message : String(err));
      }
      if (!body.ok) {
        throw new TelegramError(method, body.error_code ?? 0, body.description ?? "unknown error", body.parameters?.migrate_to_chat_id);
      }
      return body.result as T;
    },
  };
}

export function isNotModified(err: unknown): boolean {
  return err instanceof TelegramError && err.description.includes("message is not modified");
}

export function isMessageGone(err: unknown): boolean {
  return (
    err instanceof TelegramError &&
    /message to edit not found|message to delete not found|MESSAGE_ID_INVALID|message can't be edited/i.test(err.description)
  );
}
