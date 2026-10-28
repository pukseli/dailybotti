import type { GameId } from "./games";
import type { Category } from "./scoring";
import type { User } from "./telegram";

export interface Settings {
  groupChatId: number | null;
  groupThreadId: number | null;
  botUsername: string | null;
  botId: number | null;
  /** The command menus as last sent to Telegram (see commands.ts). */
  commandMenus: string | null;
}

export async function getSettings(db: D1Database): Promise<Settings> {
  const { results } = await db.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>();
  const map = new Map(results.map((r) => [r.key, r.value]));
  const num = (key: string) => (map.has(key) ? Number(map.get(key)) : null);
  return {
    groupChatId: num("group_chat_id"),
    groupThreadId: num("group_thread_id"),
    botUsername: map.get("bot_username") ?? null,
    botId: num("bot_id"),
    commandMenus: map.get("command_menus") ?? null,
  };
}

export async function setSetting(db: D1Database, key: string, value: string | number | null): Promise<void> {
  if (value === null) {
    await db.prepare("DELETE FROM settings WHERE key = ?").bind(key).run();
  } else {
    await db
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind(key, String(value))
      .run();
  }
}

export type VoteMode = "interim" | "finalize";

export interface VoteState {
  day: string;
  mode: VoteMode;
  messageId: number;
  yes: Record<string, string>;
  no: Record<string, string>;
  completed?: boolean;
  interimMessageIds?: number[];
}

export async function getVoteState(db: D1Database): Promise<VoteState | null> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'vote_state'").first<{ value: string }>();
  if (!row?.value) return null;
  try {
    return JSON.parse(row.value) as VoteState;
  } catch {
    return null;
  }
}

export async function setVoteState(db: D1Database, state: VoteState | null): Promise<void> {
  await setSetting(db, "vote_state", state ? JSON.stringify(state) : null);
}

export interface PlayerRow {
  id: number;
  first_name: string;
  last_name: string | null;
  username: string | null;
  /** Set with /name; null means use the Telegram name. */
  display_name: string | null;
}

export async function upsertPlayer(db: D1Database, user: User, nowIso: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO players (id, first_name, last_name, username, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET first_name = excluded.first_name, last_name = excluded.last_name, username = excluded.username`,
    )
    .bind(user.id, user.first_name, user.last_name ?? null, user.username ?? null, nowIso)
    .run();
}

export async function allPlayers(db: D1Database): Promise<PlayerRow[]> {
  const { results } = await db
    .prepare("SELECT id, first_name, last_name, username, display_name FROM players")
    .all<PlayerRow>();
  return results;
}

export async function setDisplayName(db: D1Database, playerId: number, name: string | null): Promise<void> {
  await db.prepare("UPDATE players SET display_name = ? WHERE id = ?").bind(name, playerId).run();
}

export interface ResultRow {
  player_id: number;
  game: GameId;
  day: string;
  puzzle: number | null;
  score: number;
  max_score: number;
  submitted_at: string;
  rounds_json?: string | null;
  raw_text?: string | null;
}

/** Saves a result unless the player already has one for that game and day. Returns whether it was saved. */
export async function insertResult(db: D1Database, r: ResultRow): Promise<boolean> {
  try {
    const res = await db
      .prepare(
        `INSERT INTO results (player_id, game, day, puzzle, score, max_score, submitted_at, rounds_json, raw_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(player_id, game, day) DO NOTHING`,
      )
      .bind(r.player_id, r.game, r.day, r.puzzle, r.score, r.max_score, r.submitted_at, r.rounds_json ?? null, r.raw_text ?? null)
      .run();
    return res.meta.changes > 0;
  } catch (err) {
    if (!(err instanceof Error) || !/no such column/i.test(err.message)) throw err;
    const res = await db
      .prepare(
        `INSERT INTO results (player_id, game, day, puzzle, score, max_score, submitted_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(player_id, game, day) DO NOTHING`,
      )
      .bind(r.player_id, r.game, r.day, r.puzzle, r.score, r.max_score, r.submitted_at)
      .run();
    return res.meta.changes > 0;
  }
}

export async function getResult(db: D1Database, playerId: number, game: GameId, day: string): Promise<ResultRow | null> {
  return db
    .prepare("SELECT * FROM results WHERE player_id = ? AND game = ? AND day = ?")
    .bind(playerId, game, day)
    .first<ResultRow>();
}

export async function resultsForDay(db: D1Database, day: string): Promise<ResultRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM results WHERE day = ? ORDER BY submitted_at")
    .bind(day)
    .all<ResultRow>();
  return results;
}

export async function allResultsForPlayer(db: D1Database, playerId: number): Promise<ResultRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM results WHERE player_id = ? ORDER BY day DESC, submitted_at DESC")
    .bind(playerId)
    .all<ResultRow>();
  return results;
}

export async function latestDayWithResults(db: D1Database, beforeDay?: string): Promise<string | null> {
  const row = beforeDay
    ? await db.prepare("SELECT MAX(day) AS day FROM results WHERE day < ?").bind(beforeDay).first<{ day: string | null }>()
    : await db.prepare("SELECT MAX(day) AS day FROM results").first<{ day: string | null }>();
  return row?.day ?? null;
}

export interface DayRow {
  day: string;
  board_message_id: number | null;
  board_text: string | null;
  board_claim_until: string | null;
  finalized_at: string | null;
}

export async function ensureDay(db: D1Database, day: string): Promise<void> {
  await db.prepare("INSERT INTO days (day) VALUES (?) ON CONFLICT(day) DO NOTHING").bind(day).run();
}

export async function getDay(db: D1Database, day: string): Promise<DayRow | null> {
  return db.prepare("SELECT * FROM days WHERE day = ?").bind(day).first<DayRow>();
}

export async function openDays(db: D1Database): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT day FROM days WHERE finalized_at IS NULL ORDER BY day")
    .all<{ day: string }>();
  return results.map((r) => r.day);
}

/** Lets only one request post a day's board; the claim expires in case that request dies. */
export async function claimBoardPost(db: D1Database, day: string, nowIso: string, untilIso: string): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE days SET board_claim_until = ?
       WHERE day = ? AND board_message_id IS NULL AND (board_claim_until IS NULL OR board_claim_until < ?)`,
    )
    .bind(untilIso, day, nowIso)
    .run();
  return res.meta.changes > 0;
}

export async function saveBoard(db: D1Database, day: string, messageId: number, text: string): Promise<void> {
  await db
    .prepare("UPDATE days SET board_message_id = ?, board_text = ?, board_claim_until = NULL WHERE day = ?")
    .bind(messageId, text, day)
    .run();
}

export async function clearBoard(db: D1Database, day: string): Promise<void> {
  await db
    .prepare("UPDATE days SET board_message_id = NULL, board_text = NULL, board_claim_until = NULL WHERE day = ?")
    .bind(day)
    .run();
}

export interface PlacementRow {
  category: Category;
  playerId: number;
  rank: number;
  value: number;
}

export async function savePlacements(db: D1Database, day: string, rows: PlacementRow[]): Promise<void> {
  const insert = db.prepare("INSERT INTO placements (day, category, player_id, rank, value) VALUES (?, ?, ?, ?, ?)");
  await db.batch([
    db.prepare("DELETE FROM placements WHERE day = ?").bind(day),
    ...rows.map((r) => insert.bind(day, r.category, r.playerId, r.rank, r.value)),
  ]);
}

export async function markFinalized(db: D1Database, day: string, nowIso: string): Promise<void> {
  await db.prepare("UPDATE days SET finalized_at = ? WHERE day = ?").bind(nowIso, day).run();
}

export interface StatsRow {
  player_id: number;
  category: Category;
  played: number;
  gold: number;
  silver: number;
  bronze: number;
  average: number;
  best: number;
}

const STATS_COLUMNS = `player_id, category, COUNT(*) AS played,
  SUM(rank = 1) AS gold, SUM(rank = 2) AS silver, SUM(rank = 3) AS bronze,
  AVG(value) AS average, MAX(value) AS best`;

export async function statsForPlayer(db: D1Database, playerId: number): Promise<StatsRow[]> {
  const { results } = await db
    .prepare(`SELECT ${STATS_COLUMNS} FROM placements WHERE player_id = ? GROUP BY category`)
    .bind(playerId)
    .all<StatsRow>();
  return results;
}

export async function statsForEveryone(db: D1Database): Promise<StatsRow[]> {
  const { results } = await db
    .prepare(`SELECT ${STATS_COLUMNS} FROM placements GROUP BY player_id, category`)
    .all<StatsRow>();
  return results;
}
