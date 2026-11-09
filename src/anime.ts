import type { D1Database } from "@cloudflare/workers-types";
import { addAnimePoints, allPlayers, getAnimeLeaderboard, type PlayerRow } from "./db";
import { displayNames, escapeHtml, fit } from "./render";
import type { User } from "./telegram";

export interface ParsedAnimeAward {
  targetQuery?: string;
  amount: number;
}

/**
 * Parses anime point awards from text messages.
 * Matches:
 *  - "animepiste käyttäjä 1"
 *  - "animepiste käyttäjä" (defaults to 1)
 *  - "animepisteet käyttäjä 2"
 *  - "+1 animepiste!" (when isReply)
 *  - "animepiste!", "Animepiste!", "animepiste 1", "animepiste :D" (when isReply)
 *  - "/animepiste" or "/animepiste 2" (when isReply)
 *  - "/animepiste käyttäjä 1"
 */
export function parseAnimeTrigger(text: string, isReply: boolean): ParsedAnimeAward | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // 1. Slash commands: /animepiste, !animepiste, /anime, etc.
  const cmdMatch = /^[/!](?:animepiste|animepisteet|anime)(?:@\w+)?(?:\s+(.*)|[!?.])?$/i.exec(trimmed);
  if (cmdMatch) {
    const rawArg = (cmdMatch[1] ?? "").replace(/[!.,?]+$/, "").trim();
    if (!rawArg) {
      // In reply, /animepiste awards 1 point. Otherwise, standalone /animepiste displays the leaderboard.
      return isReply ? { amount: 1 } : null;
    }

    if (isReply) {
      const numMatch = /\b(\d+)\b/.exec(rawArg);
      const amount = numMatch && numMatch[1] ? Math.min(50, Math.max(1, parseInt(numMatch[1], 10))) : 1;
      return { amount };
    }

    const match = /^(.*?)(?:\s+(\d+))?[!.,?]*$/.exec(rawArg);
    if (!match || !match[1]) return null;
    const targetQuery = match[1].trim();
    if (!targetQuery) return null;
    const amount = match[2] ? Math.min(50, Math.max(1, parseInt(match[2], 10))) : 1;
    return { targetQuery, amount };
  }

  // 2. "+1 animepiste", "+animepiste", "+5 animepisteet!"
  const plusMatch = /^\+([0-9]*)\s*anime[-_]?piste(?:et)?.*$/i.exec(trimmed);
  if (plusMatch) {
    const amount = plusMatch[1] ? Math.min(50, Math.max(1, parseInt(plusMatch[1], 10))) : 1;
    return isReply ? { amount } : null;
  }

  // 3. Plain text starting with "animepiste" or "anime-piste" or "animepisteet"
  // e.g. "animepiste!", "Animepiste!", "animepiste 1", "animepiste Matti 2", "animepiste :D"
  const plainMatch = /^(?:anime[-_]?piste(?:et)?)(?:[!.,?]*\s*(.*))?$/i.exec(trimmed);
  if (!plainMatch) return null;

  const rest = (plainMatch[1] ?? "").trim();

  if (isReply) {
    // When replying, any text starting with animepiste gives points to the replied user.
    // Check if an explicit number is given, e.g. "animepiste 2" or "animepiste! 3"
    const numMatch = /\b(\d+)\b/.exec(rest);
    const amount = numMatch && numMatch[1] ? Math.min(50, Math.max(1, parseInt(numMatch[1], 10))) : 1;
    return { amount };
  }

  // Not a reply: requires target player
  if (!rest) return null;
  const userMatch = /^(.*?)(?:\s+(\d+))?[!.,?]*$/.exec(rest);
  if (!userMatch || !userMatch[1]) return null;
  const targetQuery = userMatch[1].trim();
  if (!targetQuery) return null;
  const amount = userMatch[2] ? Math.min(50, Math.max(1, parseInt(userMatch[2], 10))) : 1;
  return { targetQuery, amount };
}

export function renderAnimeSelfForbidden(): string {
  return "B-Baka! ( ≧Д≦) Et voi antaa animepisteitä itsellesi! Se on ankarasti kiellettyä weeb-laissa! &gt;w&lt; 💢";
}

export function renderAnimePlayerNotFound(query: string): string {
  return `Gomen nasai! (｡•́︿•̀｡) Pelaajaa '<b>${escapeHtml(query)}</b>' ei löytynyt! Tarkista nimi tai vastaa suoraan heidän viestiinsä!`;
}

export function renderAnimePointAwarded(opts: {
  receiverName: string;
  amount: number;
  total: number;
}): string {
  const { receiverName, amount, total } = opts;
  const ptsText = amount === 1 ? "animepiste" : "animepistettä";
  return [
    `Nyaa~ (⁄ ⁄&gt;⁄ ▽ ⁄&lt;⁄) ✨`,
    `Annettiin <b>+${amount}</b> ${ptsText} käyttäjälle <b>${escapeHtml(receiverName)}</b>!`,
    `Hänellä on nyt yhteensä <b>${total}</b> animepistettä! Sugoi desu ne! 🌸🍡`,
  ].join("\n");
}

export interface AnimeStanding {
  id: number;
  name: string;
  total: number;
}

export function renderAnimeLeaderboard(standings: AnimeStanding[]): string {
  const lines: string[] = [
    "🏆 <b>K-Konnichiwa minna-san!</b> (✿◠‿◠)✨",
    "Tässä tulee virallinen <i>Animepiste</i> -tilannekatsaus! UwU 🌸",
    "",
  ];

  if (standings.length === 0) {
    lines.push(
      "🥺👉👈 <i>H-honto ni?!</i> Yhtään animepistettä ei ole vielä jaettu!",
      "Oletteko te muka kaikki jotain tavallisia normoja ilman animetietoutta?! B-baka! (｡•́︿•̀｡)",
      "",
      "<i>Pisteitä jaetaan kirjoittamalla esim. <code>animepiste @käyttäjä 1</code> tai vastaamalla viestiin <code>animepiste</code>! nyaa~ 🍡</i>",
    );
    return fit(lines);
  }

  const leader = standings[0]!;
  lines.push(
    "👑 <b>SUGOI! Ryhmän suurin Anime-Sensei &amp; Kuningas:</b>",
    `<i>Onneksi olkoon ${escapeHtml(leader.name)}~senpai! (⁄ ⁄&gt;⁄ ▽ ⁄&lt;⁄)✨</i>`,
    `<i>Animetietoisuutesi taso on suorastaan... pelottavaa! On todellinen elämäntyö muistaa jokainen shounen-powerup, tietää kaikkien sivuhahmojen japaninkieliset ääninäyttelijät ja muistaa fillerijaksot ulkoa. Ulkoilma ja ruohon koskettelu ovat selvästi yliarvostettuja tällaisen korkeakulttuurin rinnalla! Olet todellinen Giga-Weeb, Gambatte ne! 🌸🍙👏</i>`,
    "",
    "<b>📜 Animetietoisuuden kunniataulu:</b>",
  );

  standings.forEach((p, idx) => {
    let prefix = "🎀";
    let title = "Normo vaaravyöhykkeellä";
    if (idx === 0) {
      prefix = "🥇";
      title = "Hokage / Giga-Weeb";
    } else if (idx === 1) {
      prefix = "🥈";
      title = "Chūnin / Tsundere-fani";
    } else if (idx === 2) {
      prefix = "🥉";
      title = "Genin / Viattomuus menetetty";
    }
    lines.push(`${prefix} <b>${escapeHtml(p.name)}</b>: ${p.total} p <i>(${title})</i>`);
  });

  lines.push(
    "",
    "<i>Pisteitä jaetaan kirjoittamalla esim. <code>animepiste [käyttäjä] [määrä]</code> tai vastaamalla viestiin <code>animepiste</code>! nyaa~ (¬‿¬)</i>",
  );

  return fit(lines);
}

/**
 * Handles awarding anime points and generating response.
 */
export async function awardAnimePoints(
  db: D1Database,
  giver: User,
  targetPlayer: { id: number; name: string },
  amount: number,
  nowIso: string,
): Promise<string> {
  if (giver.id === targetPlayer.id) {
    return renderAnimeSelfForbidden();
  }
  const newTotal = await addAnimePoints(db, giver.id, targetPlayer.id, amount, nowIso);
  return renderAnimePointAwarded({
    receiverName: targetPlayer.name,
    amount,
    total: newTotal,
  });
}

/**
 * Loads current anime leaderboard and returns rendered message.
 */
export async function getRenderedAnimeLeaderboard(db: D1Database): Promise<string> {
  const [board, players] = await Promise.all([getAnimeLeaderboard(db), allPlayers(db)]);
  const names = displayNames(players);

  const standings: AnimeStanding[] = board.map((row) => ({
    id: row.playerId,
    name: names.get(row.playerId) ?? `Pelaaja ${row.playerId}`,
    total: row.total,
  }));

  return renderAnimeLeaderboard(standings);
}
