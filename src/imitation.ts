// Imitation contest. Once a week on a random day (Mon–Sun) the bot draws a character or person from the group's
// suggestions. Players post their imitation as a voice message in the group. Once everyone has (or at the deadline),
// each player gets a private ballot and ranks the others: 1st = 3 points, 2nd = 1 point. Nobody can vote for
// themselves. The contest is standalone from the daily games; its medals appear in /leaderboard and /me.

import { dayIsClosed, EXPECTED_PLAYERS, isGroupMember, reply, sendToGroup, today, tryCall, type Ctx } from "./chat";
import { allPlayers, savePlacements, upsertPlayer, type Settings } from "./db";
import { displayNames, escapeHtml, fit } from "./render";
import { placeMark, rank } from "./scoring";
import { isNotModified, type CallbackQuery, type InlineKeyboardButton, type Message, type User } from "./telegram";
import { addDays, daysBetween, localParts, weekMonday } from "./time";

/** The day's character is drawn and announced at this time. */
export const CHALLENGE_TIME = "09:00";
/** Recordings are accepted until this time, when the vote opens at the latest. */
export const VOTE_DEADLINE = "21:00";
export const FIRST_POINTS = 3;
export const SECOND_POINTS = 1;
const MAX_SUGGESTION_LENGTH = 60;
const graphemes = new Intl.Segmenter();

// ---------- data ----------

export interface ImitationDay {
  day: string;
  suggestion_id: number | null;
  /** The character or person, from the suggestion. Null when there was nothing to draw. */
  name: string | null;
  announce_message_id: number | null;
  vote_opened_at: string | null;
  vote_message_id: number | null;
  closed_at: string | null;
}

interface EntryRow {
  player_id: number;
  message_id: number;
  submitted_at: string;
}

interface BallotRow {
  day: string;
  voter_id: number;
  first_id: number | null;
  second_id: number | null;
  ballot_message_id: number | null;
}

const DAY_COLUMNS = `d.day, d.suggestion_id, s.name, d.announce_message_id, d.vote_opened_at, d.vote_message_id, d.closed_at
  FROM imitation_days d LEFT JOIN imitation_suggestions s ON s.id = d.suggestion_id`;

export async function getImitationDay(db: D1Database, day: string): Promise<ImitationDay | null> {
  return db.prepare(`SELECT ${DAY_COLUMNS} WHERE d.day = ?`).bind(day).first<ImitationDay>();
}

async function openChallenges(db: D1Database): Promise<ImitationDay[]> {
  const { results } = await db.prepare(`SELECT ${DAY_COLUMNS} WHERE d.closed_at IS NULL ORDER BY d.day`).all<ImitationDay>();
  return results;
}

async function entriesFor(db: D1Database, day: string): Promise<EntryRow[]> {
  const { results } = await db
    .prepare("SELECT player_id, message_id, submitted_at FROM imitation_entries WHERE day = ? ORDER BY submitted_at")
    .bind(day)
    .all<EntryRow>();
  return results;
}

async function ballotsFor(db: D1Database, day: string): Promise<BallotRow[]> {
  const { results } = await db
    .prepare("SELECT day, voter_id, first_id, second_id, ballot_message_id FROM imitation_votes WHERE day = ?")
    .bind(day)
    .all<BallotRow>();
  return results;
}

async function unusedSuggestionCount(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM imitation_suggestions WHERE used_on IS NULL").first<{ n: number }>();
  return row?.n ?? 0;
}

/** Picks an unused suggestion at random for the day and marks it used, in one transaction. Does nothing twice. */
async function drawChallenge(db: D1Database, day: string, nowIso: string): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO imitation_days (day, suggestion_id)
         VALUES (?, (SELECT id FROM imitation_suggestions WHERE used_on IS NULL ORDER BY RANDOM() LIMIT 1))
         ON CONFLICT(day) DO NOTHING`,
      )
      .bind(day),
    db
      .prepare(
        `UPDATE imitation_suggestions SET used_on = ?
         WHERE id = (SELECT suggestion_id FROM imitation_days WHERE day = ?) AND used_on IS NULL`,
      )
      .bind(day, day),
    // Nothing to draw: the day has no contest, so it is closed from the start.
    db.prepare("UPDATE imitation_days SET closed_at = ? WHERE day = ? AND suggestion_id IS NULL AND closed_at IS NULL").bind(nowIso, day),
  ]);
}

/** Lets one request post the day's announcement. -1 marks it as being posted. */
async function claimAnnouncement(db: D1Database, day: string): Promise<boolean> {
  const res = await db
    .prepare("UPDATE imitation_days SET announce_message_id = -1 WHERE day = ? AND announce_message_id IS NULL")
    .bind(day)
    .run();
  return res.meta.changes > 0;
}

async function setAnnouncement(db: D1Database, day: string, messageId: number | null): Promise<void> {
  await db.prepare("UPDATE imitation_days SET announce_message_id = ? WHERE day = ?").bind(messageId, day).run();
}

async function claimVoteOpening(db: D1Database, day: string, nowIso: string): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE imitation_days SET vote_opened_at = ?
       WHERE day = ? AND suggestion_id IS NOT NULL AND vote_opened_at IS NULL AND closed_at IS NULL`,
    )
    .bind(nowIso, day)
    .run();
  return res.meta.changes > 0;
}

/** Ends the day's contest. `cancelled` means no vote was held. Returns false if it had already ended. */
async function closeChallenge(db: D1Database, day: string, nowIso: string, cancelled: boolean): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE imitation_days SET closed_at = ?, vote_opened_at = CASE WHEN ? THEN NULL ELSE vote_opened_at END
       WHERE day = ? AND closed_at IS NULL`,
    )
    .bind(nowIso, cancelled ? 1 : 0, day)
    .run();
  return res.meta.changes > 0;
}

async function setVoteMessage(db: D1Database, day: string, messageId: number): Promise<void> {
  await db.prepare("UPDATE imitation_days SET vote_message_id = ? WHERE day = ?").bind(messageId, day).run();
}

async function saveEntry(db: D1Database, day: string, playerId: number, messageId: number, nowIso: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO imitation_entries (day, player_id, message_id, submitted_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(day, player_id) DO UPDATE SET message_id = excluded.message_id, submitted_at = excluded.submitted_at`,
    )
    .bind(day, playerId, messageId, nowIso)
    .run();
}

async function ensureBallot(db: D1Database, day: string, voterId: number): Promise<void> {
  await db.prepare("INSERT INTO imitation_votes (day, voter_id) VALUES (?, ?) ON CONFLICT DO NOTHING").bind(day, voterId).run();
}

async function getBallot(db: D1Database, day: string, voterId: number): Promise<BallotRow | null> {
  return db
    .prepare("SELECT day, voter_id, first_id, second_id, ballot_message_id FROM imitation_votes WHERE day = ? AND voter_id = ?")
    .bind(day, voterId)
    .first<BallotRow>();
}

async function saveBallot(db: D1Database, b: BallotRow, nowIso: string): Promise<void> {
  await db
    .prepare("UPDATE imitation_votes SET first_id = ?, second_id = ?, ballot_message_id = ?, updated_at = ? WHERE day = ? AND voter_id = ?")
    .bind(b.first_id, b.second_id, b.ballot_message_id, nowIso, b.day, b.voter_id)
    .run();
}

// ---------- scoring ----------

export interface Ballot {
  voterId: number;
  firstId: number | null;
  secondId: number | null;
}

export interface ImitationScore {
  points: number;
  /** The most this player could have got: 3 points from every ballot cast by someone else. */
  max: number;
}

/** Who a voter can choose from: everyone who sent a recording, except the voter. */
export function ballotOptions(entrants: number[], voterId: number): number[] {
  return entrants.filter((id) => id !== voterId);
}

/** A voter picks a winner and a runner-up, or just a winner when there is only one other recording. */
export function picksNeeded(optionCount: number): number {
  return Math.min(2, optionCount);
}

export function isBallotComplete(b: Pick<Ballot, "firstId" | "secondId">, optionCount: number): boolean {
  const picks = (b.firstId !== null ? 1 : 0) + (b.secondId !== null ? 1 : 0);
  return picks >= picksNeeded(optionCount);
}

/** Points for each recording. Ballots nobody filled in don't count towards anyone's maximum. */
export function imitationScores(entrants: number[], ballots: Ballot[]): Map<number, ImitationScore> {
  const cast = ballots.filter((b) => b.firstId !== null);
  const scores = new Map<number, ImitationScore>();
  for (const id of entrants) {
    const points = cast.reduce(
      (sum, b) => sum + (b.firstId === id ? FIRST_POINTS : 0) + (b.secondId === id ? SECOND_POINTS : 0),
      0,
    );
    scores.set(id, { points, max: FIRST_POINTS * cast.filter((b) => b.voterId !== id).length });
  }
  return scores;
}

export function imitationPercent(s: ImitationScore): number {
  return Math.round((s.points / s.max) * 1000) / 10;
}

export interface DayImitation {
  name: string;
  /** Only players someone else voted on; the percentage needs a maximum above zero. */
  scores: Map<number, ImitationScore>;
}

/** The day's imitation result for the podium, or null if there was no vote or nobody voted. */
export async function imitationForDay(db: D1Database, day: string): Promise<DayImitation | null> {
  const row = await getImitationDay(db, day);
  if (!row?.name || !row.vote_opened_at || !row.closed_at) return null;
  const [entries, ballots] = await Promise.all([entriesFor(db, day), ballotsFor(db, day)]);
  const scores = imitationScores(
    entries.map((e) => e.player_id),
    ballots.map((b) => ({ voterId: b.voter_id, firstId: b.first_id, secondId: b.second_id })),
  );
  const counted = new Map([...scores].filter(([, s]) => s.max > 0));
  return counted.size > 0 ? { name: row.name, scores: counted } : null;
}

/**
 * Picks or returns the week's random contest day (Mon–Sun). Stored in settings under `imitation_week:<monday>`.
 * If a week already had a drawn challenge before this setting existed, that day is adopted.
 */
export async function weeklyChallengeDay(db: D1Database, day: string): Promise<string> {
  const monday = weekMonday(day);
  const sunday = addDays(monday, 6);
  const key = `imitation_week:${monday}`;
  const saved = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  if (saved?.value) return saved.value;

  const existing = await db
    .prepare("SELECT day FROM imitation_days WHERE day >= ? AND day <= ? AND suggestion_id IS NOT NULL ORDER BY day DESC LIMIT 1")
    .bind(monday, sunday)
    .first<{ day: string }>();
  if (existing) {
    await db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").bind(key, existing.day).run();
    return existing.day;
  }

  const startDay = day > monday ? day : monday;
  const remaining = daysBetween(startDay, sunday) + 1;
  const chosen = addDays(startDay, Math.floor(Math.random() * remaining));
  await db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").bind(key, chosen).run();
  const final = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  return final?.value ?? chosen;
}

// ---------- texts ----------

/** "2026-10-23" → "23.10." */
function finnishDate(day: string): string {
  const [, m, d] = day.split("-").map(Number);
  return `${d}.${m}.`;
}

function closesLabel(closeTime: string): string {
  return closeTime === "00:00" ? "keskiyöllä" : `klo ${closeTime}`;
}

function nameOf(names: Map<number, string>, id: number): string {
  return escapeHtml(names.get(id) ?? `Pelaaja ${id}`);
}

/** A link to a message in a supergroup, so voters can find each recording. Basic groups have no links. */
function messageLink(groupChatId: number | null, messageId: number): string | null {
  const id = String(groupChatId ?? "");
  return id.startsWith("-100") ? `https://t.me/c/${id.slice(4)}/${messageId}` : null;
}

function renderAnnouncement(name: string, botUsername: string | null): string {
  const bot = botUsername ? `@${escapeHtml(botUsername)}` : "minut";
  return [
    `🎭 <b>Viikon imitaatio: ${escapeHtml(name)}</b>`,
    "",
    `Lähetä imitaatiosi ääniviestinä tähän ryhmään klo ${VOTE_DEADLINE} mennessä. Viimeisin äänitteesi lasketaan.`,
    `Kun kaikki ovat lähettäneet, viimeistään klo ${VOTE_DEADLINE}, saatte äänestyslipun yksityisviestinä. Paras saa ${FIRST_POINTS} pistettä ja toiseksi paras ${SECOND_POINTS}. Omaa suoritusta ei voi äänestää.`,
    "",
    `Jos et ole vielä avannut ${bot} yksityisesti, avaa se ja paina Start, niin äänestyslippu tulee perille.`,
  ].join("\n");
}

interface BallotView {
  day: string;
  name: string;
  options: number[];
  first: number | null;
  second: number | null;
  names: Map<number, string>;
  links: Map<number, string | null>;
}

function renderBallot(v: BallotView): { text: string; keyboard: InlineKeyboardButton[][] } {
  const performances = v.options
    .map((id) => {
      const link = v.links.get(id);
      return link ? `<a href="${link}">${nameOf(v.names, id)}</a>` : nameOf(v.names, id);
    })
    .join(" · ");
  const lines = [`🗳️ <b>Imitaatio: ${escapeHtml(v.name)}</b> · ${finnishDate(v.day)}`, `Suoritukset: ${performances}`, ""];
  const pick = (id: number) => ({ text: v.names.get(id) ?? `Pelaaja ${id}`, callback_data: `iv:${v.day}:${id}` });
  const reset = { text: "↩️ Aloita alusta", callback_data: `ir:${v.day}` };

  if (isBallotComplete({ firstId: v.first, secondId: v.second }, v.options.length)) {
    lines.push("✅ Äänesi on tallessa:", `1. ${nameOf(v.names, v.first!)} (${FIRST_POINTS} p)`);
    if (v.second !== null) lines.push(`2. ${nameOf(v.names, v.second)} (${SECOND_POINTS} p)`);
    lines.push("", "Voit muuttaa ääntäsi, kunnes äänestys päättyy.");
    return { text: lines.join("\n"), keyboard: [[{ text: "↩️ Muuta ääntä", callback_data: `ir:${v.day}` }]] };
  }
  if (v.first !== null) {
    lines.push(`1. ${nameOf(v.names, v.first)} (${FIRST_POINTS} p)`, `Valitse <b>toiseksi paras</b> (${SECOND_POINTS} p).`);
    return { text: lines.join("\n"), keyboard: [...v.options.filter((id) => id !== v.first).map((id) => [pick(id)]), [reset]] };
  }
  lines.push(`Valitse <b>paras</b> suoritus (${FIRST_POINTS} p).`);
  return { text: lines.join("\n"), keyboard: v.options.map((id) => [pick(id)]) };
}

function renderVoteStatus(opts: {
  name: string;
  voters: { id: number; done: boolean }[];
  unreachable: number[];
  names: Map<number, string>;
  closeTime: string;
  botUsername: string | null;
  closed: boolean;
}): string {
  const done = opts.voters.filter((v) => v.done);
  const lines = opts.closed
    ? [`🗳️ <b>Äänestys päättyi: ${escapeHtml(opts.name)}</b>`]
    : [
        `🗳️ <b>Äänestys alkoi: ${escapeHtml(opts.name)}</b>`,
        `Lähetin jokaiselle äänestyslipun yksityisviestinä. Paras saa ${FIRST_POINTS} pistettä ja toiseksi paras ${SECOND_POINTS}. Omaa suoritusta ei voi äänestää.`,
        `Äänestys päättyy, kun kaikki ovat äänestäneet, viimeistään ${closesLabel(opts.closeTime)}.`,
      ];
  lines.push("", `Äänestäneet (${done.length}/${opts.voters.length}): ${done.length ? done.map((v) => nameOf(opts.names, v.id)).join(", ") : "–"}`);
  if (!opts.closed && opts.unreachable.length > 0) {
    const bot = opts.botUsername ? `@${escapeHtml(opts.botUsername)}` : "minut";
    lines.push(
      "",
      `⚠️ En saanut lähetettyä äänestyslippua: ${opts.unreachable.map((id) => nameOf(opts.names, id)).join(", ")}. Avaa ${bot}, paina Start ja lähetä /aanesta.`,
    );
  }
  return lines.join("\n");
}

function renderResults(imitation: DayImitation, names: Map<number, string>): string {
  const lines = [`🎭 <b>Imitaatio: ${escapeHtml(imitation.name)} – tulokset</b>`];
  const standings = rank([...imitation.scores].map(([playerId, s]) => ({ playerId, value: imitationPercent(s) })));
  for (const s of standings) {
    const score = imitation.scores.get(s.playerId)!;
    lines.push(`${placeMark(s.rank)} ${nameOf(names, s.playerId)} · ${score.points}/${score.max} p`);
  }
  return lines.join("\n");
}

// ---------- the day's flow (run every minute) ----------

/** Draws and announces the week's character on its chosen day, opens the vote at the deadline, and ends votes when their day closes. */
export async function imitationTick(ctx: Ctx, settings: Settings): Promise<void> {
  // Days that have ended: count the votes, or call the contest off if the vote never started.
  for (const row of await openChallenges(ctx.db)) {
    if (!dayIsClosed(ctx, row.day)) continue;
    if (row.vote_opened_at) await closeVote(ctx, settings, row.day);
    else await closeChallenge(ctx.db, row.day, ctx.now.toISOString(), true);
  }

  const { date: day, time } = localParts(ctx.now, ctx.timeZone);
  if (dayIsClosed(ctx, day) || time < CHALLENGE_TIME) return;
  const challengeDay = await weeklyChallengeDay(ctx.db, day);
  if (day !== challengeDay) return;
  if (time < VOTE_DEADLINE) {
    await drawAndAnnounce(ctx, settings, day);
    return;
  }
  const row = await getImitationDay(ctx.db, day);
  if (row?.name && !row.vote_opened_at && !row.closed_at) await openVote(ctx, settings, day);
}

async function drawAndAnnounce(ctx: Ctx, settings: Settings, day: string): Promise<void> {
  let row = await getImitationDay(ctx.db, day);
  if (!row) {
    await drawChallenge(ctx.db, day, ctx.now.toISOString());
    row = await getImitationDay(ctx.db, day);
  }
  if (!row || row.announce_message_id !== null) return;

  let text: string;
  if (row.name) {
    text = renderAnnouncement(row.name, settings.botUsername);
  } else {
    // Mention it once, on the first draw where the suggestions have run out, not every time after.
    const prev = await ctx.db
      .prepare("SELECT suggestion_id FROM imitation_days WHERE day < ? ORDER BY day DESC LIMIT 1")
      .bind(day)
      .first<{ suggestion_id: number | null }>();
    if (!prev || prev.suggestion_id === null) return;
    text = "🎭 Imitaatioehdotukset ovat loppuneet, joten tällä viikolla ei ole imitaatiohaastetta. Lisää uusia: /ehdota Nimi";
  }
  if (!(await claimAnnouncement(ctx.db, day))) return;
  try {
    const sent = await sendToGroup(ctx, settings, text);
    await setAnnouncement(ctx.db, day, sent.message_id);
  } catch (err) {
    await setAnnouncement(ctx.db, day, null); // try again next minute
    throw err;
  }
}

/** Starts the vote: a private ballot to every player and a progress message in the group. */
async function openVote(ctx: Ctx, settings: Settings, day: string): Promise<void> {
  if (!(await claimVoteOpening(ctx.db, day, ctx.now.toISOString()))) return;
  const row = (await getImitationDay(ctx.db, day))!;
  const entries = await entriesFor(ctx.db, day);
  if (entries.length < 2) {
    await closeChallenge(ctx.db, day, ctx.now.toISOString(), true);
    const count = entries.length === 0 ? "ei tullut yhtään suoritusta" : "tuli vain yksi suoritus";
    await sendToGroup(ctx, settings, `🎭 Imitaatioon (${escapeHtml(row.name!)}) ${count}, joten äänestystä ei järjestetä.`);
    return;
  }

  const players = await allPlayers(ctx.db);
  const names = displayNames(players);
  for (const p of players) {
    await ensureBallot(ctx.db, day, p.id);
    await sendBallot(ctx, settings, row, (await getBallot(ctx.db, day, p.id))!, entries, names);
  }
  const sent = await sendToGroup(ctx, settings, await voteStatusText(ctx, settings, day));
  await setVoteMessage(ctx.db, day, sent.message_id);
}

function ballotView(row: ImitationDay, ballot: BallotRow, entries: EntryRow[], names: Map<number, string>, groupChatId: number | null): BallotView {
  const options = ballotOptions(
    entries.map((e) => e.player_id),
    ballot.voter_id,
  );
  return {
    day: row.day,
    name: row.name!,
    options,
    first: ballot.first_id,
    second: ballot.second_id,
    names,
    links: new Map(entries.map((e) => [e.player_id, messageLink(groupChatId, e.message_id)])),
  };
}

/** Sends a fresh ballot to the voter. Returns false if Telegram won't let the bot message them. */
async function sendBallot(
  ctx: Ctx,
  settings: Settings,
  row: ImitationDay,
  ballot: BallotRow,
  entries: EntryRow[],
  names: Map<number, string>,
): Promise<boolean> {
  const { text, keyboard } = renderBallot(ballotView(row, ballot, entries, names, settings.groupChatId));
  try {
    const sent = await ctx.tg.call<Message>("sendMessage", {
      chat_id: ballot.voter_id,
      text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: keyboard },
    });
    await saveBallot(ctx.db, { ...ballot, ballot_message_id: sent.message_id }, ctx.now.toISOString());
    return true;
  } catch (err) {
    console.warn("ballot not delivered", err instanceof Error ? err.message : err);
    return false;
  }
}

/** The group's vote progress message. A ballot with no message is one the bot couldn't deliver. */
async function voteStatusText(ctx: Ctx, settings: Settings, day: string): Promise<string> {
  const [row, entries, ballots, players] = await Promise.all([
    getImitationDay(ctx.db, day),
    entriesFor(ctx.db, day),
    ballotsFor(ctx.db, day),
    allPlayers(ctx.db),
  ]);
  const entrants = entries.map((e) => e.player_id);
  return renderVoteStatus({
    name: row!.name!,
    voters: ballots.map((b) => ({
      id: b.voter_id,
      done: isBallotComplete({ firstId: b.first_id, secondId: b.second_id }, ballotOptions(entrants, b.voter_id).length),
    })),
    unreachable: ballots.filter((b) => b.ballot_message_id === null).map((b) => b.voter_id),
    names: displayNames(players),
    closeTime: ctx.closeTime,
    botUsername: settings.botUsername,
    closed: row!.closed_at !== null,
  });
}

async function refreshVoteStatus(ctx: Ctx, settings: Settings, day: string): Promise<void> {
  const row = await getImitationDay(ctx.db, day);
  if (!row?.name || !row.vote_message_id || settings.groupChatId === null) return;
  const text = await voteStatusText(ctx, settings, day);
  try {
    await ctx.tg.call("editMessageText", {
      chat_id: settings.groupChatId,
      message_id: row.vote_message_id,
      text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  } catch (err) {
    if (!isNotModified(err)) console.warn("vote status not updated", err instanceof Error ? err.message : err);
  }
}

/** Ends the vote, saves the imitation placements and posts the results in the group. */
async function closeVote(ctx: Ctx, settings: Settings, day: string): Promise<void> {
  if (!(await closeChallenge(ctx.db, day, ctx.now.toISOString(), false))) return;
  await refreshVoteStatus(ctx, settings, day);
  const imitation = await imitationForDay(ctx.db, day);
  if (imitation) {
    const standings = rank([...imitation.scores].map(([playerId, s]) => ({ playerId, value: imitationPercent(s) })));
    await savePlacements(
      ctx.db,
      day,
      standings.map((s) => ({ category: "imitation" as const, playerId: s.playerId, rank: s.rank, value: s.value })),
      ["imitation"],
    );
  }
  const names = displayNames(await allPlayers(ctx.db));
  await sendToGroup(
    ctx,
    settings,
    imitation ? renderResults(imitation, names) : "🎭 Äänestys päättyi, mutta kukaan ei äänestänyt.",
  );
}

// ---------- updates ----------

export function isRecording(msg: Message): boolean {
  return Boolean(msg.voice || msg.audio || msg.video_note);
}

/**
 * A voice message (or audio file or round video) in the group. Saves it as the sender's entry while the day's
 * contest is taking recordings, and starts the vote once every player has sent one.
 */
export async function handleRecording(ctx: Ctx, settings: Settings, msg: Message, user: User): Promise<void> {
  if (!isRecording(msg)) return;
  const day = today(ctx);
  const row = await getImitationDay(ctx.db, day);
  if (!row?.name) return; // no contest today: just a voice message

  if (row.vote_opened_at || row.closed_at) {
    // Only speak up if this looks like a late entry, not someone chatting after sending theirs.
    const entries = await entriesFor(ctx.db, day);
    if (!entries.some((e) => e.player_id === user.id)) {
      await reply(ctx, msg, "⏰ Äänestys on jo alkanut, joten tämä äänite ei osallistu tämän päivän imitaatioon.");
    }
    return;
  }

  const nowIso = ctx.now.toISOString();
  await upsertPlayer(ctx.db, user, nowIso);
  await saveEntry(ctx.db, day, user.id, msg.message_id, nowIso);
  const reacted = await tryCall(ctx, "setMessageReaction", {
    chat_id: msg.chat.id,
    message_id: msg.message_id,
    reaction: [{ type: "emoji", emoji: "👏" }],
  });
  if (!reacted) await reply(ctx, msg, "✅ Imitaatio tallessa.");

  const [players, entries] = await Promise.all([allPlayers(ctx.db), entriesFor(ctx.db, day)]);
  if (players.length >= EXPECTED_PLAYERS && players.every((p) => entries.some((e) => e.player_id === p.id))) {
    await openVote(ctx, settings, day);
  }
}

/**
 * A tap on a ballot button. Records the pick, edits the ballot, and ends the vote once everyone has voted.
 */
export async function handleVoteTap(ctx: Ctx, settings: Settings, cq: CallbackQuery): Promise<void> {
  const answer = (text: string) => tryCall(ctx, "answerCallbackQuery", { callback_query_id: cq.id, text });
  const m = /^i([vr]):(\d{4}-\d{2}-\d{2})(?::(\d+))?$/.exec(cq.data ?? "");
  if (!m) {
    await answer("");
    return;
  }
  const kind = m[1];
  const day = m[2]!;
  const target = m[3];
  const row = await getImitationDay(ctx.db, day);
  if (!row?.name || !row.vote_opened_at || row.closed_at) {
    await answer("Tämä äänestys on jo päättynyt.");
    return;
  }
  const ballot = await getBallot(ctx.db, day, cq.from.id);
  if (!ballot) {
    await answer("Sinulla ei ole äänestyslippua tähän äänestykseen.");
    return;
  }
  const entries = await entriesFor(ctx.db, day);
  const options = ballotOptions(
    entries.map((e) => e.player_id),
    cq.from.id,
  );
  const wasComplete = isBallotComplete({ firstId: ballot.first_id, secondId: ballot.second_id }, options.length);
  const names = displayNames(await allPlayers(ctx.db));

  let note: string;
  if (kind === "r") {
    ballot.first_id = null;
    ballot.second_id = null;
    note = "Valitse uudelleen.";
  } else {
    const picked = Number(target);
    if (picked === cq.from.id) {
      await answer("Omaa suoritusta ei voi äänestää.");
      return;
    }
    if (!options.includes(picked)) {
      await answer("Tätä suoritusta ei löydy.");
      return;
    }
    if (wasComplete) {
      await answer("Äänesi on jo tallessa. Paina ”Muuta ääntä”, jos haluat vaihtaa.");
      return;
    }
    if (ballot.first_id === null) {
      ballot.first_id = picked;
      note = `1. ${names.get(picked) ?? picked} (${FIRST_POINTS} p)`;
    } else if (picked !== ballot.first_id) {
      ballot.second_id = picked;
      note = `2. ${names.get(picked) ?? picked} (${SECOND_POINTS} p)`;
    } else {
      await answer("Valitsit jo tämän parhaaksi. Valitse toiseksi paras.");
      return;
    }
  }
  const complete = isBallotComplete({ firstId: ballot.first_id, secondId: ballot.second_id }, options.length);
  if (complete) note = "Kiitos, äänesi on tallessa!";
  if (cq.message) ballot.ballot_message_id = cq.message.message_id;
  await saveBallot(ctx.db, ballot, ctx.now.toISOString());

  if (cq.message) {
    const { text, keyboard } = renderBallot(ballotView(row, ballot, entries, names, settings.groupChatId));
    try {
      await ctx.tg.call("editMessageText", {
        chat_id: cq.message.chat.id,
        message_id: cq.message.message_id,
        text,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: { inline_keyboard: keyboard },
      });
    } catch (err) {
      if (!isNotModified(err)) console.warn("ballot not updated", err instanceof Error ? err.message : err);
    }
  }
  await answer(note);

  if (complete === wasComplete) return;
  await refreshVoteStatus(ctx, settings, day);
  if (!complete) return;
  const ballots = await ballotsFor(ctx.db, day);
  const entrants = entries.map((e) => e.player_id);
  const everyoneVoted = ballots.every((b) =>
    isBallotComplete({ firstId: b.first_id, secondId: b.second_id }, ballotOptions(entrants, b.voter_id).length),
  );
  if (!everyoneVoted) return;
  await closeVote(ctx, settings, day);
}

// ---------- commands ----------

/** /ehdota Mikki Hiiri adds a character or person to the draw. */
export async function suggestCommand(ctx: Ctx, msg: Message, user: User, settings: Settings): Promise<void> {
  const name = (msg.text ?? "").replace(/^\/\S+/, "").replace(/\s+/g, " ").trim();
  if (!name) {
    await reply(ctx, msg, "Kirjoita hahmo tai ihminen komennon perään, esim. <code>/ehdota Mikki Hiiri</code>.");
    return;
  }
  if ([...graphemes.segment(name)].length > MAX_SUGGESTION_LENGTH || name.startsWith("/")) {
    await reply(ctx, msg, `Ehdotus voi olla enintään ${MAX_SUGGESTION_LENGTH} merkkiä, eikä se voi alkaa /-merkillä.`);
    return;
  }
  if (msg.chat.type === "private") {
    if (settings.groupChatId === null || !(await isGroupMember(ctx, settings.groupChatId, user.id))) {
      await reply(ctx, msg, "Vain ryhmän jäsenet voivat lisätä ehdotuksia.");
      return;
    }
  }

  const key = name.toLowerCase();
  const added = await ctx.db
    .prepare(
      `INSERT INTO imitation_suggestions (name, name_key, added_by, added_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(name_key) DO NOTHING`,
    )
    .bind(name, key, user.id, ctx.now.toISOString())
    .run();
  if (added.meta.changes === 0) {
    const existing = await ctx.db
      .prepare("SELECT name, used_on FROM imitation_suggestions WHERE name_key = ?")
      .bind(key)
      .first<{ name: string; used_on: string | null }>();
    await reply(
      ctx,
      msg,
      existing?.used_on
        ? `${escapeHtml(existing.name)} oli jo haasteena ${finnishDate(existing.used_on)}`
        : `${escapeHtml(existing?.name ?? name)} on jo ehdotuslistalla.`,
    );
    return;
  }

  const left = await unusedSuggestionCount(ctx.db);
  if (msg.chat.type !== "private") {
    const reacted = await tryCall(ctx, "setMessageReaction", {
      chat_id: msg.chat.id,
      message_id: msg.message_id,
      reaction: [{ type: "emoji", emoji: "👍" }],
    });
    if (reacted) return;
  }
  await reply(ctx, msg, `✅ Lisätty ehdotuksiin: <b>${escapeHtml(name)}</b>. Ehdotuksia jäljellä: ${left}.`);
}

/** /ehdotukset lists what's still in the draw. */
export async function suggestionsCommand(ctx: Ctx, msg: Message): Promise<void> {
  const { results } = await ctx.db
    .prepare("SELECT name FROM imitation_suggestions WHERE used_on IS NULL ORDER BY added_at")
    .all<{ name: string }>();
  const used = await ctx.db.prepare("SELECT COUNT(*) AS n FROM imitation_suggestions WHERE used_on IS NOT NULL").first<{ n: number }>();
  if (results.length === 0) {
    await reply(ctx, msg, "📝 Ehdotuslista on tyhjä. Lisää ehdotus: <code>/ehdota Mikki Hiiri</code>");
    return;
  }
  await reply(
    ctx,
    msg,
    fit([
      `📝 <b>Imitaatioehdotukset</b> · ${results.length} jäljellä`,
      ...results.map((r) => `• ${escapeHtml(r.name)}`),
      "",
      `Jo käytetty: ${used?.n ?? 0}. Lisää uusi: /ehdota Nimi`,
    ]),
  );
}

/** /haaste shows the week's character and how far the contest has got. */
export async function challengeCommand(ctx: Ctx, msg: Message): Promise<void> {
  const day = today(ctx);
  const row = await getImitationDay(ctx.db, day);
  if (!row?.name) {
    const left = await unusedSuggestionCount(ctx.db);
    if (left === 0) {
      await reply(ctx, msg, "🎭 Tänään ei ole imitaatiohaastetta, koska ehdotukset ovat loppu. Lisää uusia: /ehdota Nimi");
      return;
    }
    const monday = weekMonday(day);
    const done = await ctx.db
      .prepare(
        `SELECT d.day, s.name FROM imitation_days d JOIN imitation_suggestions s ON s.id = d.suggestion_id
         WHERE d.day >= ? AND d.day < ? ORDER BY d.day DESC LIMIT 1`,
      )
      .bind(monday, day)
      .first<{ day: string; name: string }>();
    const text = done
      ? `🎭 Tämän viikon imitaatiohaaste (${escapeHtml(done.name)}) on jo pidetty (${finnishDate(done.day)}). Seuraava haaste arvotaan ensi viikolla.`
      : `🎭 Tänään ei ole imitaatiohaastetta. Viikon haaste julkistetaan satunnaisena päivänä klo ${CHALLENGE_TIME}.`;
    await reply(ctx, msg, text);
    return;
  }

  const [entries, ballots, players] = await Promise.all([entriesFor(ctx.db, day), ballotsFor(ctx.db, day), allPlayers(ctx.db)]);
  const names = displayNames(players);
  const lines = [`🎭 <b>Viikon imitaatio: ${escapeHtml(row.name)}</b>`, ""];
  if (!row.vote_opened_at && !row.closed_at) {
    lines.push(
      `Äänitteet (${entries.length}/${players.length}): ${players.map((p) => `${entries.some((e) => e.player_id === p.id) ? "✅" : "⏳"} ${nameOf(names, p.id)}`).join(" · ")}`,
      `Lähetä ääniviesti ryhmään klo ${VOTE_DEADLINE} mennessä.`,
    );
  } else if (!row.closed_at) {
    const entrants = entries.map((e) => e.player_id);
    const done = ballots.filter((b) =>
      isBallotComplete({ firstId: b.first_id, secondId: b.second_id }, ballotOptions(entrants, b.voter_id).length),
    );
    lines.push(`Äänestys käynnissä: ${done.length}/${ballots.length} äänestänyt. Oman äänestyslipun saat lähettämällä minulle yksityisesti /aanesta.`);
  } else {
    const imitation = await imitationForDay(ctx.db, day);
    if (imitation) {
      await reply(ctx, msg, renderResults(imitation, names));
      return;
    }
    lines.push("Äänestystä ei järjestetty.");
  }
  await reply(ctx, msg, lines.join("\n"));
}

/** /aanesta (privately) sends the voter a new ballot, e.g. if the first one couldn't be delivered. */
export async function ballotCommand(ctx: Ctx, msg: Message, user: User, settings: Settings): Promise<void> {
  if (msg.chat.type !== "private") {
    const bot = settings.botUsername ? `@${escapeHtml(settings.botUsername)}` : "minut";
    await reply(ctx, msg, `Äänestys käydään yksityisesti: avaa ${bot} ja lähetä siellä /aanesta.`);
    return;
  }
  const day = today(ctx);
  const row = await getImitationDay(ctx.db, day);
  if (!row?.name || !row.vote_opened_at || row.closed_at) {
    await reply(ctx, msg, "Imitaatioäänestys ei ole nyt käynnissä.");
    return;
  }
  const players = await allPlayers(ctx.db);
  if (!players.some((p) => p.id === user.id)) {
    await reply(ctx, msg, "Äänestää voivat ryhmän pelaajat.");
    return;
  }
  await ensureBallot(ctx.db, day, user.id);
  const ballot = (await getBallot(ctx.db, day, user.id))!;
  const sent = await sendBallot(ctx, settings, row, ballot, await entriesFor(ctx.db, day), displayNames(players));
  if (sent) await refreshVoteStatus(ctx, settings, day);
}
