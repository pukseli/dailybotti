import { handleUpdate, tick, type Ctx } from "./bot";
import { setSetting } from "./db";
import type { Ai } from "./regressio";
import { createTelegram, type Update, type User } from "./telegram";
import { isValidCloseTime, isValidTimeZone } from "./time";

export interface Env {
  DB: D1Database;
  AI?: Ai;
  TELEGRAM_BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  TIMEZONE: string;
  CLOSE_TIME: string;
  /** Only for local testing against a fake Telegram API. */
  TELEGRAM_API_BASE?: string;
}

function context(env: Env): Ctx {
  return {
    db: env.DB,
    ai: env.AI,
    tg: createTelegram(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_API_BASE || undefined),
    now: new Date(),
    timeZone: env.TIMEZONE,
    closeTime: env.CLOSE_TIME === "24:00" ? "00:00" : env.CLOSE_TIME,
  };
}

const PRIVATE_COMMANDS = [
  { command: "today", description: "Today's board" },
  { command: "me", description: "Your stats" },
  { command: "leaderboard", description: "All-time standings" },
  { command: "regressio", description: "Hajonta- ja outlier-analyysi" },
  { command: "help", description: "How it works" },
];

const GROUP_COMMANDS = [
  { command: "today", description: "Show today's board at the bottom of the chat" },
  { command: "leaderboard", description: "All-time standings" },
  { command: "me", description: "Your stats" },
  { command: "regressio", description: "Hajonta- ja outlier-analyysi" },
  { command: "setup", description: "Link the bot to this group (admins)" },
];

/** One-time setup, opened in a browser after deploying: checks the config and registers the webhook. */
async function init(request: Request, env: Env): Promise<Response> {
  const report: string[] = [];
  const fail = (line: string) => new Response([...report, `❌ ${line}`].join("\n"), { status: 500 });

  if (!env.TELEGRAM_BOT_TOKEN) return fail("TELEGRAM_BOT_TOKEN secret is missing. Run: npx wrangler secret put TELEGRAM_BOT_TOKEN");
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(env.WEBHOOK_SECRET ?? "")) {
    return fail("WEBHOOK_SECRET must be 16–256 characters of A–Z, a–z, 0–9, _ or -.");
  }
  if (!isValidTimeZone(env.TIMEZONE)) return fail(`TIMEZONE "${env.TIMEZONE}" isn't a valid timezone, e.g. "Europe/Helsinki".`);
  const closeTime = env.CLOSE_TIME === "24:00" ? "00:00" : env.CLOSE_TIME;
  if (!isValidCloseTime(closeTime)) return fail(`CLOSE_TIME "${env.CLOSE_TIME}" must look like "00:00" or "22:30".`);
  report.push(`✅ Config: timezone ${env.TIMEZONE}, results close at ${closeTime === "00:00" ? "midnight" : closeTime}`);

  try {
    await env.DB.prepare("SELECT COUNT(*) FROM settings").first();
    report.push("✅ Database tables exist");
  } catch {
    return fail("Database tables are missing. Run: npx wrangler d1 migrations apply daily-games-bot --remote");
  }

  const tg = createTelegram(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_API_BASE || undefined);
  try {
    const me = await tg.call<User>("getMe", {});
    await setSetting(env.DB, "bot_id", me.id);
    if (me.username) await setSetting(env.DB, "bot_username", me.username);
    report.push(`✅ Bot token works: @${me.username}`);

    const webhookUrl = `${new URL(request.url).origin}/telegram`;
    await tg.call("setWebhook", {
      url: webhookUrl,
      secret_token: env.WEBHOOK_SECRET,
      allowed_updates: ["message"],
      max_connections: 1,
    });
    report.push(`✅ Webhook set to ${webhookUrl}`);

    await tg.call("setMyCommands", { commands: PRIVATE_COMMANDS, scope: { type: "all_private_chats" } });
    await tg.call("setMyCommands", { commands: GROUP_COMMANDS, scope: { type: "all_group_chats" } });
    report.push("✅ Command menu set");
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }

  report.push("", "All done. Next: add the bot to your group, make it an admin, and send /setup in the group.");
  return new Response(report.join("\n"));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/telegram" && request.method === "POST") {
      if (!env.WEBHOOK_SECRET || request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      let update: Update;
      try {
        update = await request.json();
      } catch {
        return new Response("bad request", { status: 400 });
      }
      const ctx = context(env);
      try {
        await handleUpdate(ctx, update);
      } catch (err) {
        console.error("update failed", err);
        const msg = update.message;
        if (msg && (msg.chat.type === "private" || msg.text?.startsWith("/"))) {
          await ctx.tg
            .call("sendMessage", { chat_id: msg.chat.id, text: "Sorry, something went wrong. Please try again in a minute." })
            .catch(() => {});
        }
      }
      // Always acknowledge, so Telegram doesn't keep resending an update that fails.
      return new Response("ok");
    }

    if (url.pathname === "/init") {
      if (!env.WEBHOOK_SECRET || url.searchParams.get("secret") !== env.WEBHOOK_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      return init(request, env);
    }

    if (url.pathname === "/test-ai") {
      if (!env.AI) return new Response("env.AI missing", { status: 500 });
      const model = (url.searchParams.get("model") || "@cf/meta/llama-3.1-8b-instruct-fp8") as any;
      const start = Date.now();
      try {
        const res = await env.AI.run(model, {
          messages: [
            { role: "system", content: "Olet avustaja. Vastaa yhdellä sanalla." },
            { role: "user", content: "Toimiiko?" },
          ],
          max_tokens: 20,
        });
        return Response.json({
          status: "ok",
          model,
          durationMs: Date.now() - start,
          raw: res,
        });
      } catch (err) {
        return Response.json(
          {
            status: "error",
            model,
            durationMs: Date.now() - start,
            error: err instanceof Error ? err.message : String(err),
          },
          { status: 500 },
        );
      }
    }

    if (url.pathname === "/") return new Response("Daily games bot is running.");
    return new Response("not found", { status: 404 });
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await tick(context(env));
  },
} satisfies ExportedHandler<Env>;
