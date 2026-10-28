import { setSetting } from "./db";
import type { Telegram } from "./telegram";

// The command menus Telegram shows when someone types "/". Change them here; the bot updates Telegram by itself.

export const PRIVATE_COMMANDS = [
  { command: "today", description: "Today's board" },
  { command: "tulos", description: "Pelaajan pelitulos kierroksittain" },
  { command: "me", description: "Your stats" },
  { command: "leaderboard", description: "All-time standings" },
  { command: "regressio", description: "Hajonta- ja outlier-analyysi" },
  { command: "name", description: "Change your name on the leaderboards" },
  { command: "haaste", description: "Päivän imitaatiohaaste ja tilanne" },
  { command: "aanesta", description: "Imitaatioäänestyksen äänestyslippu" },
  { command: "ehdota", description: "Ehdota hahmoa imitoitavaksi" },
  { command: "ehdotukset", description: "Imitaatioehdotukset" },
  { command: "help", description: "Käyttö- ja käyttöönotto-ohjeet" },
];

export const GROUP_COMMANDS = [
  { command: "today", description: "Show today's board at the bottom of the chat" },
  { command: "tulos", description: "Pelaajan pelitulos kierroksittain" },
  { command: "leaderboard", description: "All-time standings" },
  { command: "me", description: "Your stats" },
  { command: "regressio", description: "Hajonta- ja outlier-analyysi" },
  { command: "name", description: "Change your name on the leaderboards" },
  { command: "haaste", description: "Päivän imitaatiohaaste ja tilanne" },
  { command: "ehdota", description: "Ehdota hahmoa imitoitavaksi" },
  { command: "ehdotukset", description: "Imitaatioehdotukset" },
  { command: "vote_leaderboard", description: "Äänestys väliaikatilanteen julkaisusta" },
  { command: "finalize", description: "Äänestys päivän kisan sulkemisesta" },
  { command: "setup", description: "Link the bot to this group (admins)" },
  { command: "help", description: "Käyttö- ja käyttöönotto-ohjeet" },
];

/** Both menus as last sent to Telegram, stored in settings to spot when a deploy has changed them. */
export const COMMAND_MENUS = JSON.stringify([PRIVATE_COMMANDS, GROUP_COMMANDS]);

/**
 * Sends the command menus to Telegram unless they're unchanged since the last time (or `force`).
 * Runs every minute, so a deploy that changes the commands reaches Telegram within a minute.
 */
export async function syncCommandMenus(db: D1Database, tg: Telegram, lastSent: string | null, force = false): Promise<boolean> {
  if (!force && lastSent === COMMAND_MENUS) return false;
  await tg.call("setMyCommands", { commands: PRIVATE_COMMANDS, scope: { type: "all_private_chats" } });
  await tg.call("setMyCommands", { commands: GROUP_COMMANDS, scope: { type: "all_group_chats" } });
  await setSetting(db, "command_menus", COMMAND_MENUS);
  return true;
}
