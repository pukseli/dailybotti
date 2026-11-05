// Daily Mättö: each player drafts 5 characters from a personal deal of 10 (5 strong + 5 weak,
// shuffled). Then anonymous round-robin voting under one hidden theme for the day. Contests start
// on a random weekday or when someone sends /matto in the group. Placements use category "matto"
// and never feed the daily overall score.

import { dayIsClosed, isGroupMember, reply, sendToGroup, today, tryCall, type Ctx } from "./chat";
import { allPlayers, savePlacements, upsertPlayer, type Settings } from "./db";
import { displayNames, escapeHtml, fit } from "./render";
import { placeMark, rank } from "./scoring";
import { isNotModified, type CallbackQuery, type InlineKeyboardButton, type Message, type User } from "./telegram";
import { addDays, daysBetween, localParts, weekMonday } from "./time";

export const DRAFT_TIME = "09:00";
export const DRAFT_DEADLINE = "21:00";
export const OFFER_COUNT = 10;
export const KEEP_COUNT = 5;
export const STRONG_PER_DEAL = 5;
export const WEAK_PER_DEAL = 5;

const TEAM_LABELS = ["Alfa", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel"];

// ---------- pure helpers (tested) ----------

/** Fisher–Yates shuffle; does not mutate the input. */
export function shuffled<T>(items: readonly T[], rand: () => number = Math.random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Remaining slots to fill vs how many offers are left including the current one. */
export function mustKeep(kept: number, remainingIncludingCurrent: number, target = KEEP_COUNT): boolean {
  return remainingIncludingCurrent <= target - kept;
}

export function canSkip(kept: number, remainingIncludingCurrent: number, target = KEEP_COUNT): boolean {
  return remainingIncludingCurrent - 1 >= target - kept;
}

/** Build a 10-card deal: 5 strong + 5 weak, then shuffle. */
export function buildDeal<S, W>(strong: readonly S[], weak: readonly W[], rand: () => number = Math.random): (S | W)[] {
  if (strong.length < STRONG_PER_DEAL || weak.length < WEAK_PER_DEAL) {
    throw new Error("Not enough characters to deal");
  }
  const pickStrong = shuffled(strong, rand).slice(0, STRONG_PER_DEAL);
  const pickWeak = shuffled(weak, rand).slice(0, WEAK_PER_DEAL);
  return shuffled([...pickStrong, ...pickWeak], rand);
}

/** Every unordered pair as matchups, in shuffled order. */
export function buildMatchups(playerIds: readonly number[], rand: () => number = Math.random): { teamA: number; teamB: number }[] {
  const pairs: { teamA: number; teamB: number }[] = [];
  for (let i = 0; i < playerIds.length; i++) {
    for (let j = i + 1; j < playerIds.length; j++) {
      const pair = shuffled([playerIds[i]!, playerIds[j]!], rand);
      pairs.push({ teamA: pair[0]!, teamB: pair[1]! });
    }
  }
  return shuffled(pairs, rand);
}

export interface MattoScore {
  points: number;
  max: number;
}

/** One point per vote received. Max = matchups involving the team × number of voters. */
export function mattoScores(
  teams: readonly number[],
  matchups: readonly { id: number; teamA: number; teamB: number }[],
  votes: readonly { matchupId: number; choice: number }[],
  voterCount: number,
): Map<number, MattoScore> {
  const points = new Map<number, number>();
  for (const id of teams) points.set(id, 0);
  for (const v of votes) points.set(v.choice, (points.get(v.choice) ?? 0) + 1);
  const games = new Map<number, number>();
  for (const id of teams) games.set(id, 0);
  for (const m of matchups) {
    games.set(m.teamA, (games.get(m.teamA) ?? 0) + 1);
    games.set(m.teamB, (games.get(m.teamB) ?? 0) + 1);
  }
  const out = new Map<number, MattoScore>();
  for (const id of teams) {
    const max = (games.get(id) ?? 0) * voterCount;
    out.set(id, { points: points.get(id) ?? 0, max });
  }
  return out;
}

export function mattoPercent(s: MattoScore): number {
  if (s.max <= 0) return 0;
  return Math.round((s.points / s.max) * 1000) / 10;
}

export function isBallotComplete(cursor: number, matchupCount: number): boolean {
  return matchupCount > 0 && cursor >= matchupCount;
}

// ---------- data ----------

export interface MattoDay {
  day: string;
  theme_id: number;
  theme_text: string;
  started_by: number | null;
  announce_message_id: number | null;
  vote_opened_at: string | null;
  vote_message_id: number | null;
  closed_at: string | null;
}

interface CharacterRow {
  id: number;
  name: string;
  strength: "strong" | "weak";
}

interface OfferRow {
  day: string;
  player_id: number;
  position: number;
  character_id: number;
  name: string;
  strength: "strong" | "weak";
  decision: "keep" | "skip" | "forced" | null;
  decided_at: string | null;
}

interface TeamRow {
  day: string;
  player_id: number;
  label: string | null;
  draft_message_id: number | null;
  completed_at: string | null;
}

interface MatchupRow {
  id: number;
  day: string;
  sort_order: number;
  team_a: number;
  team_b: number;
}

interface BallotRow {
  day: string;
  voter_id: number;
  ballot_message_id: number | null;
  cursor: number;
  updated_at: string | null;
}

const DAY_COLUMNS = `d.day, d.theme_id, t.text AS theme_text, d.started_by, d.announce_message_id,
  d.vote_opened_at, d.vote_message_id, d.closed_at
  FROM matto_days d JOIN matto_themes t ON t.id = d.theme_id`;

export async function getMattoDay(db: D1Database, day: string): Promise<MattoDay | null> {
  return db.prepare(`SELECT ${DAY_COLUMNS} WHERE d.day = ?`).bind(day).first<MattoDay>();
}

async function openMattoDays(db: D1Database): Promise<MattoDay[]> {
  const { results } = await db
    .prepare(`SELECT ${DAY_COLUMNS} WHERE d.closed_at IS NULL ORDER BY d.day`)
    .all<MattoDay>();
  return results;
}

async function charactersByStrength(db: D1Database, strength: "strong" | "weak"): Promise<CharacterRow[]> {
  const { results } = await db
    .prepare("SELECT id, name, strength FROM matto_characters WHERE strength = ?")
    .bind(strength)
    .all<CharacterRow>();
  return results;
}

async function offersFor(db: D1Database, day: string, playerId: number): Promise<OfferRow[]> {
  const { results } = await db
    .prepare(
      `SELECT o.day, o.player_id, o.position, o.character_id, c.name, c.strength, o.decision, o.decided_at
       FROM matto_offers o JOIN matto_characters c ON c.id = o.character_id
       WHERE o.day = ? AND o.player_id = ?
       ORDER BY o.position`,
    )
    .bind(day, playerId)
    .all<OfferRow>();
  return results;
}

async function teamsFor(db: D1Database, day: string): Promise<TeamRow[]> {
  const { results } = await db
    .prepare("SELECT day, player_id, label, draft_message_id, completed_at FROM matto_teams WHERE day = ?")
    .bind(day)
    .all<TeamRow>();
  return results;
}

async function getTeam(db: D1Database, day: string, playerId: number): Promise<TeamRow | null> {
  return db
    .prepare("SELECT day, player_id, label, draft_message_id, completed_at FROM matto_teams WHERE day = ? AND player_id = ?")
    .bind(day, playerId)
    .first<TeamRow>();
}

async function matchupsFor(db: D1Database, day: string): Promise<MatchupRow[]> {
  const { results } = await db
    .prepare("SELECT id, day, sort_order, team_a, team_b FROM matto_matchups WHERE day = ? ORDER BY sort_order")
    .bind(day)
    .all<MatchupRow>();
  return results;
}

async function votesForDay(db: D1Database, day: string): Promise<{ matchup_id: number; voter_id: number; choice: number }[]> {
  const { results } = await db
    .prepare(
      `SELECT v.matchup_id, v.voter_id, v.choice FROM matto_votes v
       JOIN matto_matchups m ON m.id = v.matchup_id WHERE m.day = ?`,
    )
    .bind(day)
    .all<{ matchup_id: number; voter_id: number; choice: number }>();
  return results;
}

async function ballotsFor(db: D1Database, day: string): Promise<BallotRow[]> {
  const { results } = await db
    .prepare("SELECT day, voter_id, ballot_message_id, cursor, updated_at FROM matto_ballots WHERE day = ?")
    .bind(day)
    .all<BallotRow>();
  return results;
}

async function getBallot(db: D1Database, day: string, voterId: number): Promise<BallotRow | null> {
  return db
    .prepare("SELECT day, voter_id, ballot_message_id, cursor, updated_at FROM matto_ballots WHERE day = ? AND voter_id = ?")
    .bind(day, voterId)
    .first<BallotRow>();
}

async function keptNames(db: D1Database, day: string, playerId: number): Promise<string[]> {
  const offers = await offersFor(db, day, playerId);
  return offers.filter((o) => o.decision === "keep" || o.decision === "forced").map((o) => o.name);
}

async function claimWeek(db: D1Database, day: string): Promise<void> {
  const monday = weekMonday(day);
  await db
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(`matto_week:${monday}`, day)
    .run();
}

/**
 * Picks or returns this week's random contest day. Manual /matto also writes the same key so the
 * auto-draw does not start a second contest the same week.
 */
export async function weeklyMattoDay(db: D1Database, day: string): Promise<string> {
  const monday = weekMonday(day);
  const sunday = addDays(monday, 6);
  const key = `matto_week:${monday}`;
  const saved = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  if (saved?.value) return saved.value;

  const existing = await db
    .prepare("SELECT day FROM matto_days WHERE day >= ? AND day <= ? ORDER BY day DESC LIMIT 1")
    .bind(monday, sunday)
    .first<{ day: string }>();
  if (existing) {
    await db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").bind(key, existing.day).run();
    return existing.day;
  }

  // Never auto-pick "today" when first scheduling: the next tick would otherwise start a
  // contest in the middle of other evening deadlines (imitaatio etc.). /matto can still start today.
  const startDay = addDays(day, 1);
  if (startDay > sunday) {
    // No later day left this week — mark handled without an auto-start day.
    await db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").bind(key, "none").run();
    return "none";
  }
  const remaining = daysBetween(startDay, sunday) + 1;
  const chosen = addDays(startDay, Math.floor(Math.random() * remaining));
  await db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").bind(key, chosen).run();
  const final = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  return final?.value ?? chosen;
}

// ---------- texts ----------

function nameOf(names: Map<number, string>, id: number): string {
  return escapeHtml(names.get(id) ?? `Pelaaja ${id}`);
}

function closesLabel(closeTime: string): string {
  return closeTime === "00:00" ? "keskiyöllä" : `klo ${closeTime}`;
}

function draftProgress(offers: OfferRow[]): { kept: number; index: number; remaining: number } {
  const decided = offers.filter((o) => o.decision !== null);
  const kept = offers.filter((o) => o.decision === "keep" || o.decision === "forced").length;
  const index = decided.length;
  return { kept, index, remaining: offers.length - decided.length };
}

function renderDraftCard(opts: {
  day: string;
  characterName: string;
  position: number;
  kept: number;
  remaining: number;
  forced: boolean;
  keptNames: string[];
}): { text: string; keyboard: InlineKeyboardButton[][] } {
  const lines = [
    `⚔️ <b>Daily Mättö</b> · draft ${opts.day}`,
    "",
    `Hahmo ${opts.position + 1}/${OFFER_COUNT}: <b>${escapeHtml(opts.characterName)}</b>`,
    `Valittu ${opts.kept}/${KEEP_COUNT} · tarjouksia jäljellä ${opts.remaining}`,
  ];
  if (opts.keptNames.length) lines.push("", `Joukkueesi: ${opts.keptNames.map(escapeHtml).join(" · ")}`);
  if (opts.forced) {
    lines.push("", "Pakko ottaa — valittavia paikkoja on jäljellä yhtä monta kuin hahmoja.");
    return {
      text: lines.join("\n"),
      keyboard: [[{ text: "✅ Pidä", callback_data: `mk:${opts.day}:${opts.position}` }]],
    };
  }
  lines.push("", "Pidä vai ohita?");
  return {
    text: lines.join("\n"),
    keyboard: [
      [
        { text: "✅ Pidä", callback_data: `mk:${opts.day}:${opts.position}` },
        { text: "⏭️ Ohita", callback_data: `ms:${opts.day}:${opts.position}` },
      ],
    ],
  };
}

function renderDraftDone(day: string, names: string[]): string {
  return [
    `⚔️ <b>Daily Mättö</b> · draft valmis · ${day}`,
    "",
    `Joukkueesi (${KEEP_COUNT}):`,
    ...names.map((n) => `• ${escapeHtml(n)}`),
    "",
    "Äänestys alkaa, kun kaikki ovat valinneet (tai draftin deadline menee umpeen). Joukkueet pysyvät anonyymeinä äänestyksen ajan.",
  ].join("\n");
}

function renderAnnouncement(botUsername: string | null, startedByName: string | null): string {
  const bot = botUsername ? `@${escapeHtml(botUsername)}` : "minut";
  const who = startedByName ? `${escapeHtml(startedByName)} käynnisti` : "Viikon";
  return [
    `⚔️ <b>Daily Mättö alkaa!</b>`,
    "",
    `${who} mättö-pelin. Jokainen saa yksityisviestinä 10 hahmoa yksi kerrallaan — pidä tai ohita, kunnes joukkueessa on ${KEEP_COUNT}.`,
    `Puolet tarjouksista on vahvoja, puolet heikkoja (järjestys sekoitettu). Teema paljastuu vasta tuloksissa.`,
    "",
    `Draft päättyy klo ${DRAFT_DEADLINE} (tai heti kun kaikki ovat valmiita). Äänestys käydään anonyymisti yksityisviesteissä.`,
    `Jos et ole avannut ${bot} yksityisesti, avaa ja paina Start.`,
  ].join("\n");
}

function renderBallot(opts: {
  day: string;
  cursor: number;
  matchups: MatchupRow[];
  labels: Map<number, string>;
  roster: Map<number, string[]>;
}): { text: string; keyboard: InlineKeyboardButton[][] } {
  const lines = [
    `⚔️ <b>Daily Mättö</b> · äänestys · ${opts.day}`,
    "<i>Teema on salainen. Joukkueiden omistajat paljastetaan tuloksissa.</i>",
    "",
    "<b>Joukkueet</b>",
  ];
  for (const [playerId, label] of [...opts.labels.entries()].sort((a, b) => a[1].localeCompare(b[1], "fi"))) {
    const chars = opts.roster.get(playerId) ?? [];
    lines.push(`• <b>${escapeHtml(label)}</b>: ${chars.map(escapeHtml).join(", ")}`);
  }

  if (isBallotComplete(opts.cursor, opts.matchups.length)) {
    lines.push("", "✅ Kaikki ottelut äänestetty. Voit muuttaa ääniäsi, kunnes äänestys päättyy.");
    return { text: lines.join("\n"), keyboard: [[{ text: "↩️ Aloita äänestys alusta", callback_data: `mr:${opts.day}` }]] };
  }

  const m = opts.matchups[opts.cursor]!;
  const labelA = opts.labels.get(m.team_a) ?? "?";
  const labelB = opts.labels.get(m.team_b) ?? "?";
  lines.push("", `<b>Ottelu ${opts.cursor + 1}/${opts.matchups.length}</b>: ${escapeHtml(labelA)} vs ${escapeHtml(labelB)}`);
  lines.push("Kumpi voittaa päivän salaisessa haasteessa?");
  return {
    text: lines.join("\n"),
    keyboard: [
      [
        { text: labelA, callback_data: `mv:${opts.day}:${m.id}:${m.team_a}` },
        { text: labelB, callback_data: `mv:${opts.day}:${m.id}:${m.team_b}` },
      ],
      [{ text: "↩️ Aloita alusta", callback_data: `mr:${opts.day}` }],
    ],
  };
}

function renderVoteStatus(opts: {
  day: string;
  voters: { id: number; done: boolean }[];
  unreachable: number[];
  names: Map<number, string>;
  closeTime: string;
  botUsername: string | null;
  closed: boolean;
  phase: "draft" | "vote";
  drafted: { id: number; done: boolean }[];
}): string {
  if (opts.phase === "draft") {
    const done = opts.drafted.filter((d) => d.done);
    const lines = [
      `⚔️ <b>Daily Mättö</b> · draft käynnissä · ${opts.day}`,
      `Valitse ${KEEP_COUNT} hahmoa yksityisviestissä. Draft päättyy klo ${DRAFT_DEADLINE} tai kun kaikki ovat valmiita.`,
      "",
      `Valmiit (${done.length}/${opts.drafted.length}): ${done.length ? done.map((d) => nameOf(opts.names, d.id)).join(", ") : "–"}`,
    ];
    if (opts.unreachable.length > 0) {
      const bot = opts.botUsername ? `@${escapeHtml(opts.botUsername)}` : "minut";
      lines.push(
        "",
        `⚠️ En saanut lähetettyä draftia: ${opts.unreachable.map((id) => nameOf(opts.names, id)).join(", ")}. Avaa ${bot}, paina Start ja lähetä /matto.`,
      );
    }
    return lines.join("\n");
  }

  const done = opts.voters.filter((v) => v.done);
  const lines = opts.closed
    ? [`⚔️ <b>Daily Mättö</b> · äänestys päättyi · ${opts.day}`]
    : [
        `⚔️ <b>Daily Mättö</b> · äänestys käynnissä · ${opts.day}`,
        `Teema on salainen. Joukkueet anonyymejä. Äänestys päättyy, kun kaikki ovat äänestäneet, viimeistään ${closesLabel(opts.closeTime)}.`,
      ];
  lines.push("", `Äänestäneet (${done.length}/${opts.voters.length}): ${done.length ? done.map((v) => nameOf(opts.names, v.id)).join(", ") : "–"}`);
  if (!opts.closed && opts.unreachable.length > 0) {
    const bot = opts.botUsername ? `@${escapeHtml(opts.botUsername)}` : "minut";
    lines.push(
      "",
      `⚠️ En saanut lähetettyä äänestyslippua: ${opts.unreachable.map((id) => nameOf(opts.names, id)).join(", ")}. Avaa ${bot}, paina Start ja lähetä /mattoaanesta.`,
    );
  }
  return lines.join("\n");
}

function renderResults(opts: {
  day: string;
  theme: string;
  standings: { playerId: number; rank: number; value: number }[];
  scores: Map<number, MattoScore>;
  names: Map<number, string>;
  labels: Map<number, string>;
  roster: Map<number, string[]>;
}): string {
  const lines = [
    `⚔️ <b>Daily Mättö – tulokset</b> · ${opts.day}`,
    "",
    `<b>Teema:</b> ${escapeHtml(opts.theme)}`,
    "",
    "<b>Sijoitukset</b>",
  ];
  for (const s of opts.standings) {
    const score = opts.scores.get(s.playerId)!;
    const label = opts.labels.get(s.playerId);
    const labelBit = label ? ` (${escapeHtml(label)})` : "";
    lines.push(
      `${placeMark(s.rank)} ${nameOf(opts.names, s.playerId)}${labelBit} · ${score.points}/${score.max} ääntä (${s.value.toFixed(1)} %)`,
    );
  }
  lines.push("", "<b>Joukkueet</b>");
  for (const s of opts.standings) {
    const chars = opts.roster.get(s.playerId) ?? [];
    lines.push(`• ${nameOf(opts.names, s.playerId)}: ${chars.map(escapeHtml).join(", ")}`);
  }
  return fit(lines);
}

// ---------- contest lifecycle ----------

async function pickThemeId(db: D1Database): Promise<number | null> {
  const row = await db.prepare("SELECT id FROM matto_themes ORDER BY RANDOM() LIMIT 1").first<{ id: number }>();
  return row?.id ?? null;
}

async function ensurePlayerRows(ctx: Ctx, players: { id: number; first_name: string; last_name: string | null; username: string | null }[]): Promise<void> {
  const nowIso = ctx.now.toISOString();
  for (const p of players) {
    await upsertPlayer(ctx.db, { id: p.id, is_bot: false, first_name: p.first_name, last_name: p.last_name ?? undefined, username: p.username ?? undefined }, nowIso);
  }
}

async function dealForPlayer(db: D1Database, day: string, playerId: number, strong: CharacterRow[], weak: CharacterRow[]): Promise<void> {
  const deal = buildDeal(strong, weak);
  const stmts = deal.map((c, position) =>
    db
      .prepare(
        `INSERT INTO matto_offers (day, player_id, position, character_id, decision, decided_at)
         VALUES (?, ?, ?, ?, NULL, NULL)`,
      )
      .bind(day, playerId, position, c.id),
  );
  stmts.unshift(
    db
      .prepare("INSERT INTO matto_teams (day, player_id, label, draft_message_id, completed_at) VALUES (?, ?, NULL, NULL, NULL)")
      .bind(day, playerId),
  );
  await db.batch(stmts);
}

/** Starts a contest for `day`. Returns an error message, or null on success. */
export async function startMatto(ctx: Ctx, settings: Settings, day: string, startedBy: number | null): Promise<string | null> {
  const existing = await getMattoDay(ctx.db, day);
  if (existing && !existing.closed_at) return "Daily Mättö on jo käynnissä tänään.";
  if (existing?.closed_at) return "Tämän päivän mättö on jo pelattu.";

  const players = await allPlayers(ctx.db);
  if (players.length < 2) return "Tarvitaan vähintään kaksi rekisteröitynyttä pelaajaa.";

  const themeId = await pickThemeId(ctx.db);
  if (themeId === null) return "Teemalista on tyhjä — lisää teemoja kantaan.";

  const [strong, weak] = await Promise.all([charactersByStrength(ctx.db, "strong"), charactersByStrength(ctx.db, "weak")]);
  if (strong.length < STRONG_PER_DEAL || weak.length < WEAK_PER_DEAL) {
    return "Hahmolista on liian lyhyt draftia varten.";
  }

  await ensurePlayerRows(ctx, players);
  await ctx.db
    .prepare(
      `INSERT INTO matto_days (day, theme_id, started_by, announce_message_id, vote_opened_at, vote_message_id, closed_at)
       VALUES (?, ?, ?, NULL, NULL, NULL, NULL)`,
    )
    .bind(day, themeId, startedBy)
    .run();
  await claimWeek(ctx.db, day);

  for (const p of players) {
    await dealForPlayer(ctx.db, day, p.id, strong, weak);
  }

  const names = displayNames(players);
  const starterName = startedBy !== null ? (names.get(startedBy) ?? null) : null;
  const sent = await sendToGroup(ctx, settings, renderAnnouncement(settings.botUsername, starterName));
  await ctx.db.prepare("UPDATE matto_days SET announce_message_id = ? WHERE day = ?").bind(sent.message_id, day).run();

  const unreachable: number[] = [];
  for (const p of players) {
    const ok = await sendDraftCard(ctx, day, p.id);
    if (!ok) unreachable.push(p.id);
  }

  const status = await sendToGroup(
    ctx,
    settings,
    renderVoteStatus({
      day,
      voters: [],
      unreachable,
      names,
      closeTime: ctx.closeTime,
      botUsername: settings.botUsername,
      closed: false,
      phase: "draft",
      drafted: players.map((p) => ({ id: p.id, done: false })),
    }),
  );
  await ctx.db.prepare("UPDATE matto_days SET vote_message_id = ? WHERE day = ?").bind(status.message_id, day).run();
  return null;
}

async function sendDraftCard(ctx: Ctx, day: string, playerId: number): Promise<boolean> {
  const offers = await offersFor(ctx.db, day, playerId);
  const team = await getTeam(ctx.db, day, playerId);
  if (team?.completed_at) {
    try {
      await ctx.tg.call("sendMessage", {
        chat_id: playerId,
        text: renderDraftDone(day, await keptNames(ctx.db, day, playerId)),
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
      return true;
    } catch (err) {
      console.warn("matto draft-done not delivered", err instanceof Error ? err.message : err);
      return false;
    }
  }

  const { kept, index, remaining } = draftProgress(offers);
  if (index >= offers.length) return true;
  const current = offers[index]!;
  const forced = mustKeep(kept, remaining);
  const keptList = offers.filter((o) => o.decision === "keep" || o.decision === "forced").map((o) => o.name);
  const { text, keyboard } = renderDraftCard({
    day,
    characterName: current.name,
    position: current.position,
    kept,
    remaining,
    forced,
    keptNames: keptList,
  });

  try {
    if (team?.draft_message_id) {
      await ctx.tg.call("editMessageText", {
        chat_id: playerId,
        message_id: team.draft_message_id,
        text,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: { inline_keyboard: keyboard },
      });
      return true;
    }
    const sent = await ctx.tg.call<Message>("sendMessage", {
      chat_id: playerId,
      text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: keyboard },
    });
    await ctx.db
      .prepare("UPDATE matto_teams SET draft_message_id = ? WHERE day = ? AND player_id = ?")
      .bind(sent.message_id, day, playerId)
      .run();
    return true;
  } catch (err) {
    console.warn("matto draft not delivered", err instanceof Error ? err.message : err);
    return false;
  }
}

async function refreshGroupStatus(ctx: Ctx, settings: Settings, day: string): Promise<void> {
  const row = await getMattoDay(ctx.db, day);
  if (!row || !row.vote_message_id || settings.groupChatId === null) return;
  const [players, teams, ballots, matchups] = await Promise.all([
    allPlayers(ctx.db),
    teamsFor(ctx.db, day),
    ballotsFor(ctx.db, day),
    matchupsFor(ctx.db, day),
  ]);
  const names = displayNames(players);
  const phase = row.vote_opened_at ? "vote" : "draft";
  const text = renderVoteStatus({
    day,
    voters: ballots.map((b) => ({ id: b.voter_id, done: isBallotComplete(b.cursor, matchups.length) })),
    unreachable:
      phase === "vote"
        ? ballots.filter((b) => b.ballot_message_id === null).map((b) => b.voter_id)
        : teams.filter((t) => t.draft_message_id === null && !t.completed_at).map((t) => t.player_id),
    names,
    closeTime: ctx.closeTime,
    botUsername: settings.botUsername,
    closed: row.closed_at !== null,
    phase,
    drafted: players.map((p) => ({ id: p.id, done: Boolean(teams.find((t) => t.player_id === p.id)?.completed_at) })),
  });
  try {
    await ctx.tg.call("editMessageText", {
      chat_id: settings.groupChatId,
      message_id: row.vote_message_id,
      text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  } catch (err) {
    if (!isNotModified(err)) console.warn("matto status not updated", err instanceof Error ? err.message : err);
  }
}

async function completeDraft(ctx: Ctx, settings: Settings, day: string, playerId: number): Promise<void> {
  const nowIso = ctx.now.toISOString();
  await ctx.db
    .prepare("UPDATE matto_teams SET completed_at = ? WHERE day = ? AND player_id = ? AND completed_at IS NULL")
    .bind(nowIso, day, playerId)
    .run();
  const names = await keptNames(ctx.db, day, playerId);
  const team = await getTeam(ctx.db, day, playerId);
  const text = renderDraftDone(day, names);
  try {
    if (team?.draft_message_id) {
      await ctx.tg.call("editMessageText", {
        chat_id: playerId,
        message_id: team.draft_message_id,
        text,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
    } else {
      await ctx.tg.call("sendMessage", { chat_id: playerId, text, parse_mode: "HTML", link_preview_options: { is_disabled: true } });
    }
  } catch (err) {
    console.warn("matto draft complete not delivered", err instanceof Error ? err.message : err);
  }

  await refreshGroupStatus(ctx, settings, day);
  const [players, teams] = await Promise.all([allPlayers(ctx.db), teamsFor(ctx.db, day)]);
  if (players.length >= 2 && players.every((p) => teams.some((t) => t.player_id === p.id && t.completed_at))) {
    await openMattoVote(ctx, settings, day);
  }
}

async function assignLabels(db: D1Database, day: string, playerIds: number[]): Promise<Map<number, string>> {
  const labels = shuffled(TEAM_LABELS).slice(0, playerIds.length);
  const order = shuffled(playerIds);
  const map = new Map<number, string>();
  const stmts = order.map((id, i) => {
    const label = labels[i]!;
    map.set(id, label);
    return db.prepare("UPDATE matto_teams SET label = ? WHERE day = ? AND player_id = ?").bind(label, day, id);
  });
  await db.batch(stmts);
  return map;
}

export async function openMattoVote(ctx: Ctx, settings: Settings, day: string): Promise<void> {
  const row = await getMattoDay(ctx.db, day);
  if (!row || row.vote_opened_at || row.closed_at) return;

  const claimed = await ctx.db
    .prepare(
      `UPDATE matto_days SET vote_opened_at = ?
       WHERE day = ? AND vote_opened_at IS NULL AND closed_at IS NULL`,
    )
    .bind(ctx.now.toISOString(), day)
    .run();
  if (claimed.meta.changes === 0) return;

  const teams = (await teamsFor(ctx.db, day)).filter((t) => t.completed_at);
  if (teams.length < 2) {
    await closeMatto(ctx, settings, day, true);
    await sendToGroup(ctx, settings, `⚔️ Daily Mättö (${day}): alle kaksi joukkuetta valmistui, joten äänestystä ei järjestetä.`);
    return;
  }

  const playerIds = teams.map((t) => t.player_id);
  await assignLabels(ctx.db, day, playerIds);
  const pairs = buildMatchups(playerIds);
  await ctx.db.batch(
    pairs.map((p, i) =>
      ctx.db
        .prepare("INSERT INTO matto_matchups (day, sort_order, team_a, team_b) VALUES (?, ?, ?, ?)")
        .bind(day, i, p.teamA, p.teamB),
    ),
  );

  const players = await allPlayers(ctx.db);
  for (const p of players) {
    await ctx.db
      .prepare("INSERT INTO matto_ballots (day, voter_id, ballot_message_id, cursor, updated_at) VALUES (?, ?, NULL, 0, NULL) ON CONFLICT DO NOTHING")
      .bind(day, p.id)
      .run();
    await sendMattoBallot(ctx, settings, day, p.id);
  }

  await refreshGroupStatus(ctx, settings, day);
}

async function rosterMap(db: D1Database, day: string, playerIds: number[]): Promise<Map<number, string[]>> {
  const map = new Map<number, string[]>();
  for (const id of playerIds) map.set(id, await keptNames(db, day, id));
  return map;
}

async function labelMap(teams: TeamRow[]): Promise<Map<number, string>> {
  return new Map(teams.filter((t) => t.label).map((t) => [t.player_id, t.label!]));
}

async function sendMattoBallot(ctx: Ctx, settings: Settings, day: string, voterId: number): Promise<boolean> {
  const [ballot, matchups, teams] = await Promise.all([getBallot(ctx.db, day, voterId), matchupsFor(ctx.db, day), teamsFor(ctx.db, day)]);
  if (!ballot) return false;
  const finished = teams.filter((t) => t.completed_at);
  const labels = await labelMap(finished);
  const roster = await rosterMap(ctx.db, day, finished.map((t) => t.player_id));
  const { text, keyboard } = renderBallot({
    day,
    cursor: ballot.cursor,
    matchups,
    labels,
    roster,
  });
  try {
    if (ballot.ballot_message_id) {
      await ctx.tg.call("editMessageText", {
        chat_id: voterId,
        message_id: ballot.ballot_message_id,
        text,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: { inline_keyboard: keyboard },
      });
      return true;
    }
    const sent = await ctx.tg.call<Message>("sendMessage", {
      chat_id: voterId,
      text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: keyboard },
    });
    await ctx.db
      .prepare("UPDATE matto_ballots SET ballot_message_id = ?, updated_at = ? WHERE day = ? AND voter_id = ?")
      .bind(sent.message_id, ctx.now.toISOString(), day, voterId)
      .run();
    return true;
  } catch (err) {
    console.warn("matto ballot not delivered", err instanceof Error ? err.message : err);
    return false;
  }
}

async function closeMatto(ctx: Ctx, settings: Settings, day: string, cancelled: boolean): Promise<void> {
  const closed = await ctx.db
    .prepare(
      `UPDATE matto_days SET closed_at = ?, vote_opened_at = CASE WHEN ? THEN NULL ELSE vote_opened_at END
       WHERE day = ? AND closed_at IS NULL`,
    )
    .bind(ctx.now.toISOString(), cancelled ? 1 : 0, day)
    .run();
  if (closed.meta.changes === 0) return;

  if (cancelled) {
    await refreshGroupStatus(ctx, settings, day);
    return;
  }

  await refreshGroupStatus(ctx, settings, day);
  const [row, teams, matchups, votes, players] = await Promise.all([
    getMattoDay(ctx.db, day),
    teamsFor(ctx.db, day),
    matchupsFor(ctx.db, day),
    votesForDay(ctx.db, day),
    allPlayers(ctx.db),
  ]);
  if (!row) return;

  const finished = teams.filter((t) => t.completed_at && t.label);
  const teamIds = finished.map((t) => t.player_id);
  const ballots = await ballotsFor(ctx.db, day);
  const voterCount = ballots.length;
  const scores = mattoScores(
    teamIds,
    matchups.map((m) => ({ id: m.id, teamA: m.team_a, teamB: m.team_b })),
    votes.map((v) => ({ matchupId: v.matchup_id, choice: v.choice })),
    voterCount,
  );
  const counted = new Map([...scores].filter(([, s]) => s.max > 0));
  if (counted.size === 0) {
    await sendToGroup(ctx, settings, `⚔️ Daily Mättö (${day}): äänestys päättyi, mutta ääniä ei tullut.`);
    return;
  }

  const standings = rank([...counted].map(([playerId, s]) => ({ playerId, value: mattoPercent(s) })));
  await savePlacements(
    ctx.db,
    day,
    standings.map((s) => ({ category: "matto" as const, playerId: s.playerId, rank: s.rank, value: s.value })),
    ["matto"],
  );

  const names = displayNames(players);
  const labels = await labelMap(finished);
  const roster = await rosterMap(ctx.db, day, teamIds);
  await sendToGroup(
    ctx,
    settings,
    renderResults({
      day,
      theme: row.theme_text,
      standings,
      scores: counted,
      names,
      labels,
      roster,
    }),
  );
}

// ---------- tick ----------

export async function mattoTick(ctx: Ctx, settings: Settings): Promise<void> {
  for (const row of await openMattoDays(ctx.db)) {
    if (!dayIsClosed(ctx, row.day)) continue;
    if (row.vote_opened_at) await closeMatto(ctx, settings, row.day, false);
    else await closeMatto(ctx, settings, row.day, true);
  }

  const { date: day, time } = localParts(ctx.now, ctx.timeZone);
  if (dayIsClosed(ctx, day)) return;

  const open = await getMattoDay(ctx.db, day);
  if (open && !open.closed_at && !open.vote_opened_at && time >= DRAFT_DEADLINE) {
    await openMattoVote(ctx, settings, day);
  }

  if (time < DRAFT_TIME) return;
  // Schedule the week's day on a tick of its own. Starting in the same tick would surprise
  // other contests/tests the first time the key is written; the next minute starts if needed.
  const monday = weekMonday(day);
  const weekKey = `matto_week:${monday}`;
  const scheduled = await ctx.db.prepare("SELECT value FROM settings WHERE key = ?").bind(weekKey).first<{ value: string }>();
  if (!scheduled) {
    await weeklyMattoDay(ctx.db, day);
    return;
  }
  if (scheduled.value !== day) return;
  if (await getMattoDay(ctx.db, day)) return;
  await startMatto(ctx, settings, day, null);
}

// ---------- callbacks ----------

export async function handleMattoTap(ctx: Ctx, settings: Settings, cq: CallbackQuery): Promise<void> {
  const answer = (text: string) => tryCall(ctx, "answerCallbackQuery", { callback_query_id: cq.id, text });
  const data = cq.data ?? "";

  const draft = /^m([ks]):(\d{4}-\d{2}-\d{2}):(\d+)$/.exec(data);
  if (draft) {
    await handleDraftTap(ctx, settings, cq, draft[1] as "k" | "s", draft[2]!, Number(draft[3]), answer);
    return;
  }

  const reset = /^mr:(\d{4}-\d{2}-\d{2})$/.exec(data);
  if (reset) {
    await handleVoteReset(ctx, settings, cq, reset[1]!, answer);
    return;
  }

  const vote = /^mv:(\d{4}-\d{2}-\d{2}):(\d+):(\d+)$/.exec(data);
  if (vote) {
    await handleVotePick(ctx, settings, cq, vote[1]!, Number(vote[2]), Number(vote[3]), answer);
    return;
  }

  await answer("");
}

async function handleDraftTap(
  ctx: Ctx,
  settings: Settings,
  cq: CallbackQuery,
  kind: "k" | "s",
  day: string,
  position: number,
  answer: (text: string) => Promise<boolean>,
): Promise<void> {
  const row = await getMattoDay(ctx.db, day);
  if (!row || row.closed_at || row.vote_opened_at) {
    await answer("Draft on jo päättynyt.");
    return;
  }
  const offers = await offersFor(ctx.db, day, cq.from.id);
  if (offers.length === 0) {
    await answer("Sinulla ei ole draftia tähän peliin.");
    return;
  }
  const team = await getTeam(ctx.db, day, cq.from.id);
  if (team?.completed_at) {
    await answer("Joukkueesi on jo valmis.");
    return;
  }

  const { kept, index, remaining } = draftProgress(offers);
  const current = offers[index];
  if (!current || current.position !== position) {
    await answer("Tämä tarjous ei ole enää voimassa.");
    return;
  }

  let decision: "keep" | "skip" | "forced";
  if (kind === "s") {
    if (!canSkip(kept, remaining) || mustKeep(kept, remaining)) {
      await answer("Et voi ohittaa — tämä hahmo on pakko ottaa.");
      return;
    }
    decision = "skip";
  } else {
    decision = mustKeep(kept, remaining) ? "forced" : "keep";
  }

  await ctx.db
    .prepare("UPDATE matto_offers SET decision = ?, decided_at = ? WHERE day = ? AND player_id = ? AND position = ? AND decision IS NULL")
    .bind(decision, ctx.now.toISOString(), day, cq.from.id, position)
    .run();

  const nextOffers = await offersFor(ctx.db, day, cq.from.id);
  const nextKept = nextOffers.filter((o) => o.decision === "keep" || o.decision === "forced").length;
  await answer(decision === "skip" ? "Ohitettu." : "Pidetty!");

  if (nextKept >= KEEP_COUNT) {
    // Auto-skip any leftover offers so the deal is closed cleanly.
    const leftovers = nextOffers.filter((o) => o.decision === null);
    if (leftovers.length) {
      await ctx.db.batch(
        leftovers.map((o) =>
          ctx.db
            .prepare("UPDATE matto_offers SET decision = 'skip', decided_at = ? WHERE day = ? AND player_id = ? AND position = ?")
            .bind(ctx.now.toISOString(), day, cq.from.id, o.position),
        ),
      );
    }
    await completeDraft(ctx, settings, day, cq.from.id);
    return;
  }

  // Force-keep remaining cards if the player has no skip room left.
  let working = await offersFor(ctx.db, day, cq.from.id);
  let prog = draftProgress(working);
  while (prog.remaining > 0 && mustKeep(prog.kept, prog.remaining) && prog.kept < KEEP_COUNT) {
    const card = working[prog.index]!;
    await ctx.db
      .prepare("UPDATE matto_offers SET decision = 'forced', decided_at = ? WHERE day = ? AND player_id = ? AND position = ?")
      .bind(ctx.now.toISOString(), day, cq.from.id, card.position)
      .run();
    working = await offersFor(ctx.db, day, cq.from.id);
    prog = draftProgress(working);
    if (prog.kept >= KEEP_COUNT) {
      await completeDraft(ctx, settings, day, cq.from.id);
      return;
    }
  }

  await sendDraftCard(ctx, day, cq.from.id);
}

async function handleVoteReset(
  ctx: Ctx,
  settings: Settings,
  cq: CallbackQuery,
  day: string,
  answer: (text: string) => Promise<boolean>,
): Promise<void> {
  const row = await getMattoDay(ctx.db, day);
  if (!row?.vote_opened_at || row.closed_at) {
    await answer("Äänestys ei ole käynnissä.");
    return;
  }
  const matchups = await matchupsFor(ctx.db, day);
  if (matchups.length) {
    await ctx.db
      .prepare(`DELETE FROM matto_votes WHERE voter_id = ? AND matchup_id IN (SELECT id FROM matto_matchups WHERE day = ?)`)
      .bind(cq.from.id, day)
      .run();
  }
  await ctx.db
    .prepare("UPDATE matto_ballots SET cursor = 0, updated_at = ? WHERE day = ? AND voter_id = ?")
    .bind(ctx.now.toISOString(), day, cq.from.id)
    .run();
  if (cq.message) {
    await ctx.db
      .prepare("UPDATE matto_ballots SET ballot_message_id = ? WHERE day = ? AND voter_id = ?")
      .bind(cq.message.message_id, day, cq.from.id)
      .run();
  }
  await sendMattoBallot(ctx, settings, day, cq.from.id);
  await answer("Äänestys aloitettu alusta.");
  await refreshGroupStatus(ctx, settings, day);
}

async function handleVotePick(
  ctx: Ctx,
  settings: Settings,
  cq: CallbackQuery,
  day: string,
  matchupId: number,
  choice: number,
  answer: (text: string) => Promise<boolean>,
): Promise<void> {
  const row = await getMattoDay(ctx.db, day);
  if (!row?.vote_opened_at || row.closed_at) {
    await answer("Äänestys ei ole käynnissä.");
    return;
  }
  const ballot = await getBallot(ctx.db, day, cq.from.id);
  if (!ballot) {
    await answer("Sinulla ei ole äänestyslippua.");
    return;
  }
  const matchups = await matchupsFor(ctx.db, day);
  if (isBallotComplete(ballot.cursor, matchups.length)) {
    await answer("Äänesi on jo tallessa. Paina ”Aloita alusta”, jos haluat vaihtaa.");
    return;
  }
  const current = matchups[ballot.cursor];
  if (!current || current.id !== matchupId) {
    await answer("Tämä ottelu ei ole vuorossa.");
    return;
  }
  if (choice !== current.team_a && choice !== current.team_b) {
    await answer("Virheellinen valinta.");
    return;
  }

  await ctx.db
    .prepare(
      `INSERT INTO matto_votes (matchup_id, voter_id, choice, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(matchup_id, voter_id) DO UPDATE SET choice = excluded.choice, updated_at = excluded.updated_at`,
    )
    .bind(matchupId, cq.from.id, choice, ctx.now.toISOString())
    .run();
  const nextCursor = ballot.cursor + 1;
  await ctx.db
    .prepare("UPDATE matto_ballots SET cursor = ?, ballot_message_id = ?, updated_at = ? WHERE day = ? AND voter_id = ?")
    .bind(nextCursor, cq.message?.message_id ?? ballot.ballot_message_id, ctx.now.toISOString(), day, cq.from.id)
    .run();

  await answer("Ääni tallessa.");
  await sendMattoBallot(ctx, settings, day, cq.from.id);

  const wasComplete = isBallotComplete(ballot.cursor, matchups.length);
  const nowComplete = isBallotComplete(nextCursor, matchups.length);
  if (wasComplete === nowComplete) return;
  await refreshGroupStatus(ctx, settings, day);
  if (!nowComplete) return;

  const ballots = await ballotsFor(ctx.db, day);
  if (ballots.every((b) => isBallotComplete(b.cursor, matchups.length))) {
    await closeMatto(ctx, settings, day, false);
  }
}

// ---------- commands ----------

/** /matto in the group starts (or reports) today's contest. Privately resends draft/ballot. */
export async function mattoCommand(ctx: Ctx, msg: Message, user: User, settings: Settings): Promise<void> {
  const day = today(ctx);

  if (msg.chat.type === "private") {
    if (settings.groupChatId === null || !(await isGroupMember(ctx, settings.groupChatId, user.id))) {
      await reply(ctx, msg, "Vain ryhmän jäsenet voivat pelata Daily Mättöä.");
      return;
    }
    const row = await getMattoDay(ctx.db, day);
    if (!row || row.closed_at) {
      await reply(ctx, msg, "Daily Mättö ei ole käynnissä. Käynnistä se ryhmässä komennolla /matto.");
      return;
    }
    if (!row.vote_opened_at) {
      const ok = await sendDraftCard(ctx, day, user.id);
      await reply(ctx, msg, ok ? "Lähetin draft-viestin." : "En saanut lähetettyä draftia. Paina Start ja yritä uudelleen.");
      return;
    }
    await ctx.db
      .prepare("INSERT INTO matto_ballots (day, voter_id, ballot_message_id, cursor, updated_at) VALUES (?, ?, NULL, 0, NULL) ON CONFLICT DO NOTHING")
      .bind(day, user.id)
      .run();
    // Fresh ballot message
    await ctx.db
      .prepare("UPDATE matto_ballots SET ballot_message_id = NULL WHERE day = ? AND voter_id = ?")
      .bind(day, user.id)
      .run();
    const ok = await sendMattoBallot(ctx, settings, day, user.id);
    if (ok) await refreshGroupStatus(ctx, settings, day);
    await reply(ctx, msg, ok ? "Lähetin äänestyslipun." : "En saanut lähetettyä äänestyslippua. Paina Start ja yritä uudelleen.");
    return;
  }

  if (msg.chat.id !== settings.groupChatId) return;
  const row = await getMattoDay(ctx.db, day);
  if (row && !row.closed_at) {
    await challengeMattoCommand(ctx, msg);
    return;
  }
  if (row?.closed_at) {
    await reply(ctx, msg, "Tämän päivän Daily Mättö on jo pelattu. Seuraava arvotaan ensi viikolla, tai odota uutta päivää.");
    return;
  }

  const err = await startMatto(ctx, settings, day, user.id);
  if (err) await reply(ctx, msg, err);
}

/** /mattoaanesta privately requests a fresh ballot. */
export async function mattoBallotCommand(ctx: Ctx, msg: Message, user: User, settings: Settings): Promise<void> {
  if (msg.chat.type !== "private") {
    const bot = settings.botUsername ? `@${escapeHtml(settings.botUsername)}` : "minut";
    await reply(ctx, msg, `Äänestys käydään yksityisesti: avaa ${bot} ja lähetä /mattoaanesta.`);
    return;
  }
  const day = today(ctx);
  const row = await getMattoDay(ctx.db, day);
  if (!row?.vote_opened_at || row.closed_at) {
    await reply(ctx, msg, "Mättö-äänestys ei ole nyt käynnissä.");
    return;
  }
  await ctx.db
    .prepare("INSERT INTO matto_ballots (day, voter_id, ballot_message_id, cursor, updated_at) VALUES (?, ?, NULL, 0, NULL) ON CONFLICT DO NOTHING")
    .bind(day, user.id)
    .run();
  await ctx.db.prepare("UPDATE matto_ballots SET ballot_message_id = NULL WHERE day = ? AND voter_id = ?").bind(day, user.id).run();
  const ok = await sendMattoBallot(ctx, settings, day, user.id);
  if (ok) await refreshGroupStatus(ctx, settings, day);
  await reply(ctx, msg, ok ? "Lähetin äänestyslipun." : "En saanut lähetettyä äänestyslippua.");
}

/** /mattotilanne shows draft/vote progress or final results. */
export async function challengeMattoCommand(ctx: Ctx, msg: Message): Promise<void> {
  const day = today(ctx);
  const row = await getMattoDay(ctx.db, day);
  if (!row) {
    const monday = weekMonday(day);
    const saved = await ctx.db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .bind(`matto_week:${monday}`)
      .first<{ value: string }>();
    if (saved?.value && saved.value < day) {
      await reply(ctx, msg, `⚔️ Tämän viikon Daily Mättö pelattiin ${saved.value}. Seuraava arvotaan ensi viikolla, tai käynnistä /matto uutena päivänä.`);
      return;
    }
    await reply(
      ctx,
      msg,
      `⚔️ Daily Mättö ei ole käynnissä. Käynnistä ryhmässä /matto, tai odota viikon satunnaista päivää (klo ${DRAFT_TIME}).`,
    );
    return;
  }

  if (row.closed_at) {
    const [teams, matchups, votes, players] = await Promise.all([
      teamsFor(ctx.db, day),
      matchupsFor(ctx.db, day),
      votesForDay(ctx.db, day),
      allPlayers(ctx.db),
    ]);
    const finished = teams.filter((t) => t.completed_at && t.label);
    const teamIds = finished.map((t) => t.player_id);
    const scores = mattoScores(
      teamIds,
      matchups.map((m) => ({ id: m.id, teamA: m.team_a, teamB: m.team_b })),
      votes.map((v) => ({ matchupId: v.matchup_id, choice: v.choice })),
      (await ballotsFor(ctx.db, day)).length,
    );
    const counted = new Map([...scores].filter(([, s]) => s.max > 0));
    if (counted.size === 0) {
      await reply(ctx, msg, "⚔️ Päivän mättö päättyi ilman ääniä.");
      return;
    }
    const standings = rank([...counted].map(([playerId, s]) => ({ playerId, value: mattoPercent(s) })));
    await reply(
      ctx,
      msg,
      renderResults({
        day,
        theme: row.theme_text,
        standings,
        scores: counted,
        names: displayNames(players),
        labels: await labelMap(finished),
        roster: await rosterMap(ctx.db, day, teamIds),
      }),
    );
    return;
  }

  const [players, teams, ballots, matchups] = await Promise.all([
    allPlayers(ctx.db),
    teamsFor(ctx.db, day),
    ballotsFor(ctx.db, day),
    matchupsFor(ctx.db, day),
  ]);
  await reply(
    ctx,
    msg,
    renderVoteStatus({
      day,
      voters: ballots.map((b) => ({ id: b.voter_id, done: isBallotComplete(b.cursor, matchups.length) })),
      unreachable: [],
      names: displayNames(players),
      closeTime: ctx.closeTime,
      botUsername: null,
      closed: false,
      phase: row.vote_opened_at ? "vote" : "draft",
      drafted: players.map((p) => ({ id: p.id, done: Boolean(teams.find((t) => t.player_id === p.id)?.completed_at) })),
    }),
  );
}
