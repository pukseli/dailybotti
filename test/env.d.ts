import type { D1Migration } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      TEST_MIGRATIONS: D1Migration[];
      TELEGRAM_BOT_TOKEN: string;
      WEBHOOK_SECRET: string;
      TIMEZONE: string;
      CLOSE_TIME: string;
    }
  }
}
