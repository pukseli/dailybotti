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
 *  - "+1 animepiste" (when isReply)
 *  - "animepiste 1" or "animepiste" (when isReply)
 *  - "/animepiste käyttäjä 1"
 */
export function parseAnimeTrigger(text: string, isReply: boolean): ParsedAnimeAward | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // Slash commands
  if (/^\/[a-zA-Z0-9_]+/i.test(trimmed)) {
    const m = /^\/(?:animepiste|animepisteet|anime)(?:@\w+)?(?:\s+(.*))?$/i.exec(trimmed);
    if (!m) return null;
    const arg = (m[1] ?? "").trim();
    if (!arg) return null; // /animepiste alone displays leaderboard

    if (isReply && /^\d+$/.test(arg)) {
      const amount = Math.min(50, Math.max(1, parseInt(arg, 10)));
      return { amount };
    }

    const match = /^(.*?)(?:\s+(\d+))?$/.exec(arg);
    if (!match || !match[1]) return null;
    const targetQuery = match[1].trim();
    if (!targetQuery) return null;
    const amount = match[2] ? Math.min(50, Math.max(1, parseInt(match[2], 10))) : 1;
    return { targetQuery, amount };
  }

  // "+1 animepiste" reply
  if (/^\+([0-9]+)\s*anime[-_]?piste(?:et)?$/i.test(trimmed)) {
    const m = /^\+([0-9]+)\s*anime[-_]?piste(?:et)?$/i.exec(trimmed);
    const amount = m && m[1] ? Math.min(50, Math.max(1, parseInt(m[1], 10))) : 1;
    return isReply ? { amount } : null;
  }

  // Plain text "animepiste ..."
  const plainMatch = /^(?:anime[-_]?piste(?:et)?)(?:\s+(.*))?$/i.exec(trimmed);
  if (!plainMatch) return null;

  const rest = (plainMatch[1] ?? "").trim();
  if (!rest) {
    if (isReply) return { amount: 1 };
    return null;
  }

  if (isReply && /^\d+$/.test(rest)) {
    const amount = Math.min(50, Math.max(1, parseInt(rest, 10)));
    return { amount };
  }

  const userMatch = /^(.*?)(?:\s+(\d+))?$/.exec(rest);
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
