import {
  allPlayers,
  allResultsForPlayer,
  claimBoardPost,
  clearBoard,
  ensureDay,
  getDay,
  getResult,
  getSettings,
  insertResult,
  markFinalized,
  openDays,
  resultsForDay,
  savePlacements,
  saveBoard,
  setSetting,
  statsForEveryone,
  statsForPlayer,
  upsertPlayer,
  type PlacementRow,
  type ResultRow,
  type Settings,
} from "./db";
import { GAMES, dayForResult, gameById, parseResults, parseRoundData, type ParsedResult } from "./games";
import {
  calculateRegression,
  checkBlowout,
  generateExplanation,
  type Ai,
  type BlowoutReport,
  type RegressioReport,
} from "./regressio";
import {
  closeLabel,
  displayNames,
  renderBoard,
  renderHelp,
  renderLeaderboard,
  renderPlayerStats,
  renderRegressio,
  renderSummary,
} from "./render";
import { dayStandings, overallValue } from "./scoring";
import { isMessageGone, isNotModified, TelegramError, type ChatMember, type Message, type Telegram, type Update, type User } from "./telegram";
import { addDays, dayLabel, isClosed, localParts } from "./time";

export interface Ctx {
  db: D1Database;
  tg: Telegram;
  now: Date;
  timeZone: string;
  closeTime: string;
  ai?: Ai;
}

const BOARD_CLAIM_MS = 60_000;

function today(ctx: Ctx): string {
  return localParts(ctx.now, ctx.timeZone).date;
}

function dayIsClosed(ctx: Ctx, day: string): boolean {
  return isClosed(day, ctx.now, ctx.timeZone, ctx.closeTime);
}

// ---------- sending ----------

interface SendOptions {
  silent?: boolean;
  replyTo?: Message;
}

async function send(ctx: Ctx, chatId: number, text: string, opts: SendOptions & { threadId?: number | null } = {}): Promise<Message> {
  const params: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  };
  if (opts.silent) params.disable_notification = true;
  if (opts.threadId) params.message_thread_id = opts.threadId;
  if (opts.replyTo) params.reply_parameters = { message_id: opts.replyTo.message_id, allow_sending_without_reply: true };
  return ctx.tg.call<Message>("sendMessage", params);
}

/** Replies in the chat (and forum topic) the message came from. */
function reply(ctx: Ctx, msg: Message, text: string): Promise<Message> {
  const threadId = msg.is_topic_message ? msg.message_thread_id : undefined;
  return send(ctx, msg.chat.id, text, msg.chat.type === "private" ? {} : { replyTo: msg, threadId });
}

/** Sends to the linked group, following it if Telegram has upgraded it to a supergroup. */
async function sendToGroup(ctx: Ctx, settings: Settings, text: string, opts: SendOptions = {}): Promise<Message> {
  try {
    return await send(ctx, settings.groupChatId!, text, { ...opts, threadId: settings.groupThreadId });
  } catch (err) {
    if (!(err instanceof TelegramError) || !err.migrateToChatId) throw err;
    await setSetting(ctx.db, "group_chat_id", err.migrateToChatId);
    settings.groupChatId = err.migrateToChatId;
    return send(ctx, settings.groupChatId, text, { ...opts, threadId: settings.groupThreadId });
  }
}

async function tryCall(ctx: Ctx, method: string, params: Record<string, unknown>): Promise<boolean> {
  try {
    await ctx.tg.call(method, params);
    return true;
  } catch (err) {
    console.warn(`${method} failed`, err instanceof Error ? err.message : err);
    return false;
  }
}

// ---------- updates ----------

type ParsedCommand = { kind: "none" } | { kind: "other-bot" } | { kind: "command"; name: string };

export function parseCommand(text: string, botUsername: string | null): ParsedCommand {
  const m = /^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?(?:\s|$)/.exec(text);
  if (!m) return { kind: "none" };
  if (m[2] && botUsername && m[2].toLowerCase() !== botUsername.toLowerCase()) return { kind: "other-bot" };
  return { kind: "command", name: m[1]!.toLowerCase() };
}

export async function handleUpdate(ctx: Ctx, update: Update): Promise<void> {
  const msg = update.message;
  if (!msg) return;
  const settings = await getSettings(ctx.db);

  if (msg.migrate_to_chat_id && msg.chat.id === settings.groupChatId) {
    await setSetting(ctx.db, "group_chat_id", msg.migrate_to_chat_id);
    return;
  }

  const text = msg.text ?? msg.caption ?? "";
  const command = parseCommand(text, settings.botUsername);
  if (command.kind === "other-bot") return;

  if (msg.chat.type === "private") {
    if (!msg.from || msg.from.is_bot) return;
    if (command.kind === "command") return privateCommand(ctx, msg, msg.from, command.name, settings);
    return privateResults(ctx, msg, msg.from, text, settings);
  }

  if (msg.chat.type !== "group" && msg.chat.type !== "supergroup") return;
  if (command.kind === "command" && command.name === "setup") return setup(ctx, msg, settings);
  if (msg.chat.id !== settings.groupChatId) return;
  if (command.kind === "command") return groupCommand(ctx, msg, command.name, settings);
  if (!msg.from || msg.from.is_bot || msg.sender_chat) return;
  return groupResults(ctx, msg, msg.from, text, settings);
}

// ---------- commands ----------

async function findTargetPlayer(
  db: D1Database,
  names: Map<number, string>,
  arg: string,
  caller: User,
): Promise<{ id: number; name: string; isLeader?: boolean }> {
  const players = await allPlayers(db);
  const cleanArg = arg.replace(/^@/, "").trim().toLowerCase();

  const getLeader = async () => {
    const stats = await statsForEveryone(db);
    const overall = stats
      .filter((s) => s.category === "overall")
      .sort((a, b) => b.gold - a.gold || b.silver - a.silver || b.bronze - a.bronze || b.average - a.average);
    if (overall.length > 0 && overall[0]) {
      const topId = overall[0].player_id;
      return { id: topId, name: names.get(topId) ?? `Player ${topId}`, isLeader: true };
    }
    return null;
  };

  if (!cleanArg || cleanArg === "kärki" || cleanArg === "karki" || cleanArg === "top") {
    const leader = await getLeader();
    if (leader) return leader;
  }

  if (cleanArg) {
    const match = players.find(
      (p) =>
        (p.username && p.username.toLowerCase() === cleanArg) ||
        p.first_name.toLowerCase() === cleanArg ||
        (names.get(p.id) && names.get(p.id)!.toLowerCase() === cleanArg),
    );
    if (match) {
      return { id: match.id, name: names.get(match.id) ?? match.first_name };
    }
  }

  return { id: caller.id, name: names.get(caller.id) ?? caller.first_name };
}

async function regressioAction(ctx: Ctx, msg: Message, caller: User, text: string): Promise<void> {
  const players = await allPlayers(ctx.db);
  const names = displayNames(players);

  // If this command is a reply to another message, check if that message has game results
  const replyMsg = msg.reply_to_message;
  if (replyMsg) {
    const replyText = replyMsg.text ?? replyMsg.caption ?? "";
    const parsed = parseResults(replyText);

    if (parsed.results.length > 0) {
      const playerName = replyMsg.from ? (names.get(replyMsg.from.id) ?? replyMsg.from.first_name) : caller.first_name;
      const messageResults: ResultRow[] = parsed.results.map((r) => {
        const g = gameById(r.game);
        return {
          player_id: replyMsg.from?.id ?? caller.id,
          game: r.game,
          day: today(ctx),
          puzzle: r.puzzle,
          score: r.score,
          max_score: g?.max ?? (r.game === "eraly" ? 700 : r.game === "krillion" ? 100 : 500),
          submitted_at: ctx.now.toISOString(),
        };
      });

      const stats = calculateRegression(messageResults);
      const details = `Viestin pelitulos: ${messageResults.map((r) => `${r.game} ${r.score}/${r.max_score}`).join(", ")}
Alkuperäinen tulostaso: ${stats.rawAverage.toFixed(1)} / 5.0
Karsitut tilastoharhat: ${stats.outlierCount} kpl (${stats.outlierPuzzles.join(", ")})
Regressoitu todellinen taso: ${stats.regressedAverage.toFixed(1)} / 5.0 (pudotus -${stats.dropPercent.toFixed(1)} %)`;

      const aiRes = await generateExplanation(ctx.ai, playerName, "player", details);
      const report: RegressioReport = {
        playerName,
        stats,
        outlierLabel: aiRes.outlierLabel,
        conclusion: aiRes.conclusion,
        explanation: aiRes.explanation,
        subtitle: `[Hajontakomissio] Viestin pelituloksen (${messageResults.map((r) => r.game).join(", ")}) karsinta`,
      };
      await reply(ctx, msg, renderRegressio(report));
      return;
    }

    if (replyMsg.from) {
      const targetName = names.get(replyMsg.from.id) ?? replyMsg.from.first_name;
      const results = await allResultsForPlayer(ctx.db, replyMsg.from.id);
      const stats = calculateRegression(results);

      let explanation = "";
      let outlierLabel: string | undefined;
      let conclusion: string | undefined;
      if (stats.totalPlayed > 0) {
        const details = `Pelatut pelit: ${stats.totalPlayed} kpl
Alkuperäinen keskiarvo: ${stats.rawAverage.toFixed(1)} / 5.0
Karsitut tilastoharhat: ${stats.outlierCount} kpl (${stats.outlierPuzzles.slice(0, 3).join(", ")})
Regressoitu todellinen taso: ${stats.regressedAverage.toFixed(1)} / 5.0 (pudotus -${stats.dropPercent.toFixed(1)} %)`;
        const aiRes = await generateExplanation(ctx.ai, targetName, "player", details);
        explanation = aiRes.explanation;
        outlierLabel = aiRes.outlierLabel;
        conclusion = aiRes.conclusion;
      }

      const report: RegressioReport = {
        playerName: targetName,
        stats,
        outlierLabel,
        conclusion,
        explanation,
      };
      await reply(ctx, msg, renderRegressio(report));
      return;
    }
  }

  // Not a reply (or replied message had no results / user)
  const arg = text.replace(/^\/[a-zA-Z0-9_]+(@[a-zA-Z0-9_]+)?\s*/i, "").trim();
  const target = await findTargetPlayer(ctx.db, names, arg, caller);
  const results = await allResultsForPlayer(ctx.db, target.id);
  const stats = calculateRegression(results);

  let explanation = "";
  let outlierLabel: string | undefined;
  let conclusion: string | undefined;
  if (stats.totalPlayed > 0) {
    const details = `Pelatut pelit: ${stats.totalPlayed} kpl
Alkuperäinen keskiarvo: ${stats.rawAverage.toFixed(1)} / 5.0
Karsitut tilastoharhat: ${stats.outlierCount} kpl (${stats.outlierPuzzles.slice(0, 3).join(", ")})
Regressoitu todellinen taso: ${stats.regressedAverage.toFixed(1)} / 5.0 (pudotus -${stats.dropPercent.toFixed(1)} %)`;
    const aiRes = await generateExplanation(ctx.ai, target.name, "player", details);
    explanation = aiRes.explanation;
    outlierLabel = aiRes.outlierLabel;
    conclusion = aiRes.conclusion;
  }

  const report: RegressioReport = {
    playerName: target.name,
    stats,
    outlierLabel,
    conclusion,
    explanation,
    subtitle: target.isLeader ? "[Hajontakomissio] Tulostaulukon kärjen karsinta" : undefined,
  };
  await reply(ctx, msg, renderRegressio(report));
}

async function privateCommand(ctx: Ctx, msg: Message, user: User, name: string, settings: Settings): Promise<void> {
  switch (name) {
    case "today": {
      const day = today(ctx);
      if (dayIsClosed(ctx, day)) {
        await reply(ctx, msg, "Today's results are closed. The next board opens at midnight.");
        return;
      }
      await reply(ctx, msg, await boardText(ctx, settings, day, false));
      return;
    }
    case "me":
      await reply(ctx, msg, renderPlayerStats(user.first_name, await statsForPlayer(ctx.db, user.id)));
      return;
    case "leaderboard":
      await reply(ctx, msg, await leaderboardText(ctx));
      return;
    case "regressio":
      await regressioAction(ctx, msg, user, msg.text ?? msg.caption ?? "");
      return;
    case "setup":
      await reply(ctx, msg, "Send /setup in the group, not here.");
      return;
    default:
      await reply(ctx, msg, renderHelp({ closeTime: ctx.closeTime, timeZone: ctx.timeZone, linked: settings.groupChatId !== null }));
  }
}

async function groupCommand(ctx: Ctx, msg: Message, name: string, settings: Settings): Promise<void> {
  switch (name) {
    case "today": {
      const day = today(ctx);
      if (dayIsClosed(ctx, day)) {
        await reply(ctx, msg, "Today's results are closed. The next board opens at midnight.");
        return;
      }
      // Move the board to the bottom of the chat: delete the old one and post it again.
      await ensureDay(ctx.db, day);
      const row = await getDay(ctx.db, day);
      if (row?.board_message_id) await tryCall(ctx, "deleteMessage", { chat_id: settings.groupChatId, message_id: row.board_message_id });
      await clearBoard(ctx.db, day);
      await tryCall(ctx, "deleteMessage", { chat_id: msg.chat.id, message_id: msg.message_id });
      await refreshBoard(ctx, settings, day);
      return;
    }
    case "me":
      if (msg.from && !msg.sender_chat) {
        await reply(ctx, msg, renderPlayerStats(msg.from.first_name, await statsForPlayer(ctx.db, msg.from.id)));
      }
      return;
    case "leaderboard":
      await reply(ctx, msg, await leaderboardText(ctx));
      return;
    case "regressio":
      if (msg.from && !msg.sender_chat) {
        await regressioAction(ctx, msg, msg.from, msg.text ?? msg.caption ?? "");
      }
      return;
    case "help":
      await reply(ctx, msg, renderHelp({ closeTime: ctx.closeTime, timeZone: ctx.timeZone, linked: true }));
      return;
  }
}

async function setup(ctx: Ctx, msg: Message, settings: Settings): Promise<void> {
  if (settings.groupChatId !== null && settings.groupChatId !== msg.chat.id) {
    await reply(ctx, msg, "I'm already linked to another group. I can only keep score for one group.");
    return;
  }
  const anonymousAdmin = msg.sender_chat?.id === msg.chat.id;
  if (!anonymousAdmin) {
    if (!msg.from) return;
    const member = await ctx.tg.call<ChatMember>("getChatMember", { chat_id: msg.chat.id, user_id: msg.from.id });
    if (member.status !== "creator" && member.status !== "administrator") {
      await reply(ctx, msg, "Only group admins can run /setup.");
      return;
    }
  }

  await setSetting(ctx.db, "group_chat_id", msg.chat.id);
  await setSetting(ctx.db, "group_thread_id", msg.is_topic_message ? (msg.message_thread_id ?? null) : null);

  // The bot sees ordinary group messages only as an admin, or with privacy mode turned off in BotFather.
  const me = await ctx.tg.call<User>("getMe", {});
  await setSetting(ctx.db, "bot_id", me.id);
  if (me.username) await setSetting(ctx.db, "bot_username", me.username);
  const member = await ctx.tg.call<ChatMember>("getChatMember", { chat_id: msg.chat.id, user_id: me.id });
  const seesGroupMessages = member.status === "administrator" || me.can_read_all_group_messages === true;
  const bot = me.username ? `@${me.username}` : "me";
  const lines = [
    "✅ <b>Linked to this group.</b>",
    "",
    `Paste your Eraly, Krillion and Size It Up results here, or send them to ${bot} in a private chat (press <b>Start</b> there first) if you'd rather keep your score to yourself until the podium.`,
    `I'll keep a board of who has played, and post the podiums at ${closeLabel(ctx.closeTime)}.`,
  ];
  if (!seesGroupMessages) {
    lines.push(
      "",
      "⚠️ I can't see messages posted here yet, so results pasted in the group would be missed. Please make me an admin of this group (I don't need any special rights).",
    );
  }
  await reply(ctx, msg, lines.join("\n"));
}

async function leaderboardText(ctx: Ctx): Promise<string> {
  const [stats, players] = await Promise.all([statsForEveryone(ctx.db), allPlayers(ctx.db)]);
  return renderLeaderboard(stats, displayNames(players));
}

// ---------- results ----------

async function isGroupMember(ctx: Ctx, groupId: number, userId: number): Promise<boolean> {
  try {
    const m = await ctx.tg.call<ChatMember>("getChatMember", { chat_id: groupId, user_id: userId });
    return ["creator", "administrator", "member"].includes(m.status) || (m.status === "restricted" && m.is_member !== false);
  } catch (err) {
    // If Telegram can't tell us, let them in rather than block a friend.
    console.warn("getChatMember failed", err instanceof Error ? err.message : err);
    return true;
  }
}

async function privateResults(ctx: Ctx, msg: Message, user: User, text: string, settings: Settings): Promise<void> {
  if (settings.groupChatId === null) {
    await reply(ctx, msg, "I'm not linked to a group yet. A group admin needs to add me to the group and send /setup there.");
    return;
  }
  const parsed = parseResults(text);
  if (parsed.results.length === 0) {
    await reply(
      ctx,
      msg,
      parsed.rejected.length
        ? parsed.rejected.join("\n")
        : "I didn't find an Eraly, Krillion or Size It Up result in that message. Tap <b>Share</b> at the end of a game and send it here. /help explains more.",
    );
    return;
  }
  if (!(await isGroupMember(ctx, settings.groupChatId, user.id))) {
    await reply(ctx, msg, "Only members of the group can take part. Join the group first, then send your results again.");
    return;
  }
  const outcome = await recordResults(ctx, user, parsed.results, text);
  const status = outcome.status ? ["", outcome.status] : [];
  await reply(ctx, msg, [...outcome.saved, ...outcome.problems, ...parsed.rejected, ...status].join("\n"));
  await refreshBoardSafely(ctx, settings, outcome.boardDays);
}

async function groupResults(ctx: Ctx, msg: Message, user: User, text: string, settings: Settings): Promise<void> {
  const parsed = parseResults(text);
  if (parsed.results.length === 0) return; // ordinary chat
  const outcome = await recordResults(ctx, user, parsed.results, text);

  // The paste stays in the group for everyone to see. A 👍 reaction confirms it was saved, so the bot adds
  // no messages of its own; it only replies when something needs explaining, like a late or repeated result.
  const issues = [...outcome.problems, ...parsed.rejected];
  const reacted =
    issues.length === 0 &&
    (await tryCall(ctx, "setMessageReaction", {
      chat_id: msg.chat.id,
      message_id: msg.message_id,
      reaction: [{ type: "emoji", emoji: "👍" }],
    }));
  if (!reacted) await reply(ctx, msg, [...outcome.saved, ...issues].join("\n"));
  await refreshBoardSafely(ctx, settings, outcome.boardDays);
}

interface RecordOutcome {
  saved: string[];
  /** Results that were not counted, with the reason. */
  problems: string[];
  /** Which of today's games the player still has to play, while today is open. */
  status: string | null;
  /** Days whose board needs updating. */
  boardDays: string[];
}

async function recordResults(ctx: Ctx, user: User, results: ParsedResult[], rawInput = ""): Promise<RecordOutcome> {
  const nowIso = ctx.now.toISOString();
  const day0 = today(ctx);
  await upsertPlayer(ctx.db, user, nowIso);
  const saved: string[] = [];
  const problems: string[] = [];
  const boardDays = new Set<string>();

  for (const r of results) {
    const game = gameById(r.game)!;
    const day = dayForResult(r, day0);
    const title = r.puzzle !== null ? `${game.name} #${r.puzzle}` : game.name;

    if (day > addDays(day0, 1)) {
      problems.push(`⛔ ${title} isn't out yet, so I can't count it.`);
      continue;
    }
    if (dayIsClosed(ctx, day) || (await getDay(ctx.db, day))?.finalized_at) {
      problems.push(`⛔ ${title} is for ${dayLabel(day)}, which has already closed.`);
      continue;
    }
    await ensureDay(ctx.db, day);
    const roundData = rawInput ? parseRoundData(rawInput, r.game) : { rounds: null, rawText: null };
    const inserted = await insertResult(ctx.db, {
      player_id: user.id,
      game: r.game,
      day,
      puzzle: r.puzzle,
      score: r.score,
      max_score: game.max,
      submitted_at: nowIso,
      rounds_json: roundData.rounds ? JSON.stringify(roundData.rounds) : null,
      raw_text: roundData.rawText,
    });
    if (inserted) {
      saved.push(`✅ ${title}: ${r.score}/${game.max} saved${day === day0 ? "" : ` for ${dayLabel(day)}`}.`);
      if (day === day0) boardDays.add(day);
      continue;
    }
    const existing = await getResult(ctx.db, user.id, r.game, day);
    if (existing?.score === r.score) {
      saved.push(`☑️ ${title} was already saved (${r.score}/${game.max}).`);
    } else {
      problems.push(`ℹ️ You already sent ${title} (${existing?.score}/${game.max}). Only the first result counts.`);
    }
  }

  let status: string | null = null;
  if (!dayIsClosed(ctx, day0)) {
    const mine = (await resultsForDay(ctx.db, day0)).filter((r) => r.player_id === user.id);
    const missing = GAMES.filter((g) => !mine.some((r) => r.game === g.id)).map((g) => g.name);
    status =
      missing.length === 0
        ? `🎉 All three done for today. Podiums at ${closeLabel(ctx.closeTime)}.`
        : `Still to play today: ${missing.join(", ")}.`;
  }
  return { saved, problems, status, boardDays: [...boardDays] };
}

// ---------- board ----------

async function boardText(ctx: Ctx, settings: Settings, day: string, closed: boolean): Promise<string> {
  const [results, players] = await Promise.all([resultsForDay(ctx.db, day), allPlayers(ctx.db)]);
  return renderBoard({
    day,
    results,
    names: displayNames(players),
    closed,
    closeTime: ctx.closeTime,
    botUsername: settings.botUsername,
  });
}

async function refreshBoardSafely(ctx: Ctx, settings: Settings, days: string[]): Promise<void> {
  for (const day of days) {
    try {
      await refreshBoard(ctx, settings, day);
    } catch (err) {
      // The every-minute job will try again.
      console.error("board refresh failed", err);
    }
  }
}

/** Posts the day's board in the group, or edits it to match the current results. */
export async function refreshBoard(ctx: Ctx, settings: Settings, day: string): Promise<void> {
  if (settings.groupChatId === null) return;
  const row = await getDay(ctx.db, day);
  if (!row) return;
  const closed = row.finalized_at !== null;
  const text = await boardText(ctx, settings, day, closed);

  if (row.board_message_id !== null) {
    if (row.board_text === text) return;
    try {
      await ctx.tg.call("editMessageText", {
        chat_id: settings.groupChatId,
        message_id: row.board_message_id,
        text,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
      await saveBoard(ctx.db, day, row.board_message_id, text);
      return;
    } catch (err) {
      if (isNotModified(err)) {
        await saveBoard(ctx.db, day, row.board_message_id, text);
        return;
      }
      if (!isMessageGone(err)) throw err;
      await clearBoard(ctx.db, day); // someone deleted the board; post a new one below
    }
  }

  if (closed) return;
  const claimed = await claimBoardPost(ctx.db, day, ctx.now.toISOString(), new Date(ctx.now.getTime() + BOARD_CLAIM_MS).toISOString());
  if (!claimed) return;
  try {
    const sent = await sendToGroup(ctx, settings, text, { silent: true });
    await saveBoard(ctx.db, day, sent.message_id, text);
  } catch (err) {
    await clearBoard(ctx.db, day);
    throw err;
  }
}

// ---------- daily close ----------

export async function finalizeDay(ctx: Ctx, settings: Settings, day: string): Promise<void> {
  const results = await resultsForDay(ctx.db, day);
  if (results.length === 0) {
    await markFinalized(ctx.db, day, ctx.now.toISOString());
    return;
  }
  const standings = dayStandings(
    results.map((r) => ({ playerId: r.player_id, game: r.game, score: r.score, maxScore: r.max_score })),
  );
  const placements: PlacementRow[] = [];
  for (const [category, rows] of standings) {
    for (const s of rows) placements.push({ category, playerId: s.playerId, rank: s.rank, value: s.value });
  }
  await savePlacements(ctx.db, day, placements);

  const players = await allPlayers(ctx.db);
  const names = displayNames(players);

  let blowoutReport: BlowoutReport | null = null;
  const overallRows = standings.get("overall") ?? [];
  const blowout = checkBlowout(overallRows);

  if (blowout.isBlowout) {
    const winnerName = names.get(blowout.winnerId) ?? `Player ${blowout.winnerId}`;
    const winnerResults = results.filter((r) => r.player_id === blowout.winnerId);
    const sorted = [...winnerResults].sort((a, b) => b.score / b.max_score - a.score / a.max_score);
    const regressedWinnerResults = sorted.slice(1);
    const regressedScore = overallValue(
      regressedWinnerResults.map((r) => ({
        playerId: r.player_id,
        game: r.game,
        score: r.score,
        maxScore: r.max_score,
      })),
    );

    const details = `Päivän pisteet: ${blowout.winnerScore.toFixed(1)} / 300
Toiseksi tulleen pisteet: ${blowout.secondScore.toFixed(1)} / 300 (voittomarginaali: +${blowout.marginPercent.toFixed(1)} %)
Karsittu päivän huippusuonenveto: ${sorted[0] ? `${sorted[0].game} (${sorted[0].score}/${sorted[0].max_score})` : "huippupeli"}
Regressoidut pisteet: ${regressedScore.toFixed(1)} / 300`;

    const aiRes = await generateExplanation(ctx.ai, winnerName, "blowout", details);

    blowoutReport = {
      winnerName,
      winnerScore: blowout.winnerScore,
      secondScore: blowout.secondScore,
      marginPercent: blowout.marginPercent,
      regressedScore,
      explanation: aiRes.explanation,
    };
  }

  await sendToGroup(ctx, settings, renderSummary({ day, standings, results, names, blowoutReport }));
  await markFinalized(ctx.db, day, ctx.now.toISOString());
  await refreshBoardSafely(ctx, settings, [day]); // flip the board to "closed"
}

/** Runs every minute: posts podiums for days that have closed, then keeps today's board in sync. */
export async function tick(ctx: Ctx): Promise<void> {
  const settings = await getSettings(ctx.db);
  if (settings.groupChatId === null) return;

  try {
    for (const day of await openDays(ctx.db)) {
      if (dayIsClosed(ctx, day)) await finalizeDay(ctx, settings, day);
    }
  } catch (err) {
    // Leave the day open; the next run tries again, keeping days in order.
    console.error("finalize failed", err);
  }

  const day = today(ctx);
  if (!dayIsClosed(ctx, day)) await refreshBoardSafely(ctx, settings, [day]);
}
