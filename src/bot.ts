import {
  allPlayers,
  allResultsForPlayer,
  claimBoardPost,
  claimFinalize,
  clearBoard,
  ensureDay,
  getDay,
  getResult,
  getSettings,
  getVoteState,
  insertResult,
  latestDayWithResults,
  markFinalized,
  openDays,
  releaseFinalize,
  resultsForDay,
  savePlacements,
  saveBoard,
  setDisplayName,
  setSetting,
  setVoteState,
  statsForEveryone,
  statsForPlayer,
  upsertPlayer,
  type PlacementRow,
  type ResultRow,
  type Settings,
  type VoteMode,
  type VoteState,
} from "./db";
import { dayIsClosed, EXPECTED_PLAYERS, isGroupMember, reply, send, sendToGroup, today, tryCall, type Ctx } from "./chat";

export { EXPECTED_PLAYERS };
import { syncCommandMenus } from "./commands";
import {
  ballotCommand,
  challengeCommand,
  handleRecording,
  handleVoteTap,
  imitationTick,
  isRecording,
  suggestCommand,
  suggestionsCommand,
} from "./imitation";
import { GAMES, dayForResult, gameById, matchGameArg, parseResults, parseRoundData, type GameId, type ParsedResult } from "./games";
import {
  calculateRegression,
  checkBlowout,
  generateExplanation,
  type BlowoutReport,
  type RegressioReport,
} from "./regressio";
import {
  closeLabel,
  displayNames,
  escapeHtml,
  renderBoard,
  renderCommands,
  renderHelp,
  renderLeaderboard,
  renderPlayerDayResults,
  renderPlayerStats,
  renderRegressio,
  renderSummary,
  renderVoteKeyboard,
  renderVoteMessage,
} from "./render";
import { dayStandings, overallValue, type DayResult } from "./scoring";
import {
  isMessageGone,
  isNotModified,
  type CallbackQuery,
  type ChatMember,
  type Message,
  type Update,
  type User,
} from "./telegram";
import { addDays, dayLabel } from "./time";

export type { Ctx } from "./chat";

const BOARD_CLAIM_MS = 60_000;
const FINALIZE_CLAIM_MS = 60_000;

export const VOTE_THRESHOLD = 4;

/**
 * Checks whether all expected players have completed all games for the given day.
 * Returns true if at least minPlayers (default 4) exist and every registered player has completed all games.
 */
export async function isDayComplete(ctx: Ctx, day: string, minPlayers = EXPECTED_PLAYERS): Promise<boolean> {
  const [players, results] = await Promise.all([
    allPlayers(ctx.db),
    resultsForDay(ctx.db, day),
  ]);
  if (players.length < minPlayers) return false;

  for (const player of players) {
    const playerResults = results.filter((r) => r.player_id === player.id);
    const hasAll = GAMES.every((g) => playerResults.some((r) => r.game === g.id));
    if (!hasAll) return false;
  }
  return true;
}

// ---------- updates ----------

type ParsedCommand = { kind: "none" } | { kind: "other-bot" } | { kind: "command"; name: string };

export function parseCommand(text: string, botUsername: string | null): ParsedCommand {
  const m = /^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?(?:\s|$)/.exec(text);
  if (!m) return { kind: "none" };
  if (m[2] && botUsername && m[2].toLowerCase() !== botUsername.toLowerCase()) return { kind: "other-bot" };
  return { kind: "command", name: m[1]!.toLowerCase() };
}

function parseBangHelp(text: string, botUsername: string | null): "none" | "other-bot" | "match" {
  const m = /^!(?:help|komennot)(?:@([A-Za-z0-9_]+))?(?:\s|$)/i.exec(text.trim());
  if (!m) return "none";
  if (m[1] && botUsername && m[1].toLowerCase() !== botUsername.toLowerCase()) return "other-bot";
  return "match";
}

export async function handleUpdate(ctx: Ctx, update: Update): Promise<void> {
  if (update.callback_query) {
    const settings = await getSettings(ctx.db);
    if (update.callback_query.data?.startsWith("vote:")) {
      await handleCallbackQuery(ctx, update.callback_query, settings);
      return;
    }
    await handleVoteTap(ctx, settings, update.callback_query);
    return;
  }
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
  const bangHelp = parseBangHelp(text, settings.botUsername);
  if (bangHelp === "other-bot") return;

  if (msg.chat.type === "private") {
    if (!msg.from || msg.from.is_bot) return;
    if (bangHelp === "match") {
      await reply(ctx, msg, renderCommands());
      return;
    }
    if (command.kind === "command") return privateCommand(ctx, msg, msg.from, command.name, settings);
    return privateResults(ctx, msg, msg.from, text, settings);
  }

  if (msg.chat.type !== "group" && msg.chat.type !== "supergroup") return;
  if (command.kind === "command" && command.name === "setup") return setup(ctx, msg, settings);
  if (command.kind === "command" && command.name === "help") {
    // Answered before /setup too, since that's when the setup steps are needed.
    const linked = msg.chat.id === settings.groupChatId;
    await reply(ctx, msg, renderHelp({ closeTime: ctx.closeTime, timeZone: ctx.timeZone, linked }));
    return;
  }
  if (bangHelp === "match" || (command.kind === "command" && command.name === "komennot")) {
    await reply(ctx, msg, renderCommands());
    return;
  }
  if (msg.chat.id !== settings.groupChatId) return;
  if (command.kind === "command") return groupCommand(ctx, msg, command.name, settings);
  if (!msg.from || msg.from.is_bot || msg.sender_chat) return;
  if (isRecording(msg)) {
    await handleRecording(ctx, settings, msg, msg.from);
    return;
  }
  const voteMode = await detectVoteCommand(ctx, msg, text, settings);
  if (voteMode) {
    await startVote(ctx, msg, voteMode, settings);
    return;
  }
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

/** A player's results as the caller may see them: other players' scores stay hidden until the day's podium. */
async function revealedResultsForPlayer(ctx: Ctx, playerId: number, caller: User): Promise<ResultRow[]> {
  const results = await allResultsForPlayer(ctx.db, playerId);
  if (playerId === caller.id) return results;
  const hidden = new Set((await openDays(ctx.db)).filter((day) => !dayIsClosed(ctx, day)));
  return results.filter((r) => !hidden.has(r.day));
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
      const results = await revealedResultsForPlayer(ctx, replyMsg.from.id, caller);
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
  const results = await revealedResultsForPlayer(ctx, target.id, caller);
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

async function tulosCommand(ctx: Ctx, msg: Message, caller: User, text: string): Promise<void> {
  const players = await allPlayers(ctx.db);
  const names = displayNames(players);

  const rawArg = text
    .replace(/^\/[a-zA-Z0-9_]+(@[a-zA-Z0-9_]+)?\s*/i, "")
    .replace(/\bsize\s+it\s+up\b/gi, "sizeitup")
    .trim();

  const tokens = rawArg ? rawArg.split(/\s+/) : [];
  let gameFilter: GameId | null = null;
  let explicitDay: string | null = null;
  let explicitPuzzle: number | null = null;
  const playerTokens: string[] = [];

  for (const token of tokens) {
    const matchedGame = matchGameArg(token);
    if (matchedGame && !gameFilter) {
      gameFilter = matchedGame;
      continue;
    }
    const lower = token.toLowerCase();
    if (lower === "eilen" || lower === "yesterday") {
      explicitDay = addDays(today(ctx), -1);
      continue;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(token)) {
      explicitDay = token;
      continue;
    }
    const puzzleMatch = /^#(\d+)$/.exec(token);
    if (puzzleMatch) {
      explicitPuzzle = Number(puzzleMatch[1]);
      continue;
    }
    playerTokens.push(token);
  }

  let target = { id: caller.id, name: names.get(caller.id) ?? caller.first_name };
  if (playerTokens.length > 0) {
    const playerArg = playerTokens.join(" ");
    const cleanPlayer = playerArg.replace(/^@/, "").trim().toLowerCase();
    const match = players.find(
      (p) =>
        (p.username && p.username.toLowerCase() === cleanPlayer) ||
        (p.display_name && p.display_name.trim().toLowerCase() === cleanPlayer) ||
        p.first_name.toLowerCase() === cleanPlayer ||
        (names.get(p.id) && names.get(p.id)!.toLowerCase() === cleanPlayer),
    );
    if (match) {
      target = { id: match.id, name: names.get(match.id) ?? match.first_name };
    } else if (
      caller.first_name.toLowerCase() === cleanPlayer ||
      (caller.username && caller.username.toLowerCase() === cleanPlayer)
    ) {
      target = { id: caller.id, name: names.get(caller.id) ?? caller.first_name };
    } else {
      await reply(
        ctx,
        msg,
        `Pelaajaa tai peliä "${escapeHtml(playerArg)}" ei löytynyt. Käyttö: <code>/tulos [pelaaja] [peli]</code>`,
      );
      return;
    }
  }

  let day: string;
  if (explicitDay) {
    day = explicitDay;
  } else if (explicitPuzzle !== null) {
    if (gameFilter && gameById(gameFilter)?.firstDay) {
      day = dayForResult({ game: gameFilter, puzzle: explicitPuzzle, score: 0 }, today(ctx));
    } else {
      const allTarget = await allResultsForPlayer(ctx.db, target.id);
      const found = allTarget.find((r) => r.puzzle === explicitPuzzle && (!gameFilter || r.game === gameFilter));
      day = found?.day ?? today(ctx);
    }
  } else {
    const todayDay = today(ctx);
    const [todayResults, todayRow] = await Promise.all([resultsForDay(ctx.db, todayDay), getDay(ctx.db, todayDay)]);
    if (todayResults.length > 0 || todayRow?.finalized_at) {
      day = todayDay;
    } else {
      const prevDay = await latestDayWithResults(ctx.db, todayDay);
      day = prevDay ?? todayDay;
    }
  }

  const dayRow = await getDay(ctx.db, day);
  const isClosedDay = dayIsClosed(ctx, day) || Boolean(dayRow?.finalized_at);

  if (!isClosedDay && target.id !== caller.id) {
    await reply(
      ctx,
      msg,
      "🔒 Päivän pelit ovat vielä auki. Voit tarkastella muiden pelaajien tuloksia vasta, kun päivän pelit on suljettu.",
    );
    return;
  }

  const dayResults = (await resultsForDay(ctx.db, day)).filter((r) => r.player_id === target.id);
  await reply(ctx, msg, renderPlayerDayResults({ playerName: target.name, day, results: dayResults, gameFilter }));
}

async function privateCommand(ctx: Ctx, msg: Message, user: User, name: string, settings: Settings): Promise<void> {
  switch (name) {
    case "today": {
      const day = today(ctx);
      const row = await getDay(ctx.db, day);
      if (dayIsClosed(ctx, day) || row?.finalized_at) {
        await reply(ctx, msg, "Today's results are closed. The next board opens at midnight.");
        return;
      }
      await reply(ctx, msg, await boardText(ctx, settings, day, false));
      return;
    }
    case "tulos":
    case "tulokset":
      await tulosCommand(ctx, msg, user, msg.text ?? msg.caption ?? "");
      return;
    case "me":
      await reply(ctx, msg, renderPlayerStats(await playerName(ctx, user), await statsForPlayer(ctx.db, user.id)));
      return;
    case "name":
    case "nimi":
      await nameCommand(ctx, msg, user, msg.text ?? "", settings);
      return;
    case "leaderboard":
      await reply(ctx, msg, await leaderboardText(ctx));
      return;
    case "regressio":
      await regressioAction(ctx, msg, user, msg.text ?? msg.caption ?? "");
      return;
    case "ehdota":
      await suggestCommand(ctx, msg, user, settings);
      return;
    case "ehdotukset":
      await suggestionsCommand(ctx, msg);
      return;
    case "haaste":
      await challengeCommand(ctx, msg);
      return;
    case "aanesta":
      await ballotCommand(ctx, msg, user, settings);
      return;
    case "komennot":
      await reply(ctx, msg, renderCommands());
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
      let row = await getDay(ctx.db, day);
      if (dayIsClosed(ctx, day) || row?.finalized_at) {
        await reply(ctx, msg, "Today's results are closed. The next board opens at midnight.");
        return;
      }
      // Move the board to the bottom of the chat: delete the old one and post it again.
      await ensureDay(ctx.db, day);
      row = await getDay(ctx.db, day);
      if (row?.board_message_id) await tryCall(ctx, "deleteMessage", { chat_id: settings.groupChatId, message_id: row.board_message_id });
      await clearBoard(ctx.db, day);
      await tryCall(ctx, "deleteMessage", { chat_id: msg.chat.id, message_id: msg.message_id });
      await refreshBoard(ctx, settings, day);
      return;
    }
    case "tulos":
    case "tulokset":
      if (msg.from && !msg.sender_chat) {
        await tulosCommand(ctx, msg, msg.from, msg.text ?? msg.caption ?? "");
      }
      return;
    case "me":
      if (msg.from && !msg.sender_chat) {
        await reply(ctx, msg, renderPlayerStats(await playerName(ctx, msg.from), await statsForPlayer(ctx.db, msg.from.id)));
      }
      return;
    case "name":
    case "nimi":
      if (msg.from && !msg.sender_chat) await nameCommand(ctx, msg, msg.from, msg.text ?? "", settings);
      return;
    case "leaderboard":
      await reply(ctx, msg, await leaderboardText(ctx));
      return;
    case "regressio":
      if (msg.from && !msg.sender_chat) {
        await regressioAction(ctx, msg, msg.from, msg.text ?? msg.caption ?? "");
      }
      return;
    case "ehdota":
      if (msg.from && !msg.sender_chat) await suggestCommand(ctx, msg, msg.from, settings);
      return;
    case "ehdotukset":
      await suggestionsCommand(ctx, msg);
      return;
    case "haaste":
      await challengeCommand(ctx, msg);
      return;
    case "aanesta":
      if (msg.from && !msg.sender_chat) await ballotCommand(ctx, msg, msg.from, settings);
      return;
    case "vote_leaderboard":
      if (msg.from && !msg.sender_chat) {
        const mode: VoteMode = /\bfinalize\b/i.test(msg.text ?? msg.caption ?? "") ? "finalize" : "interim";
        await startVote(ctx, msg, mode, settings);
      }
      return;
    case "finalize":
      if (msg.from && !msg.sender_chat) {
        await startVote(ctx, msg, "finalize", settings);
      }
      return;
  }
}

async function detectVoteCommand(ctx: Ctx, msg: Message, text: string, settings: Settings): Promise<VoteMode | null> {
  const m = /^(?:!vote[-_]leaderboard|\/vote-leaderboard)(?:@([A-Za-z0-9_]+))?(?:\s+(.*))?$/i.exec(text.trim());
  if (m) {
    if (m[1] && settings.botUsername && m[1].toLowerCase() !== settings.botUsername.toLowerCase()) return null;
    const arg = m[2] ?? "";
    return /\bfinalize\b/i.test(arg) ? "finalize" : "interim";
  }

  const replyMsg = msg.reply_to_message;
  if (replyMsg && /^!?(?:finalize|sulje|lopullinen)(?:\s|$)/i.test(text.trim())) {
    const voteState = await getVoteState(ctx.db);
    const isTrackedMessage =
      voteState?.interimMessageIds?.includes(replyMsg.message_id) ||
      voteState?.messageId === replyMsg.message_id;
    const isBotInterimMessage =
      (settings.botId !== null && replyMsg.from?.id === settings.botId) ||
      (replyMsg.text ?? "").includes("Väliaikatilanne");
    if (isTrackedMessage || isBotInterimMessage) {
      return "finalize";
    }
  }
  return null;
}

async function startVote(ctx: Ctx, msg: Message, mode: VoteMode, settings: Settings): Promise<void> {
  const day = today(ctx);
  const row = await getDay(ctx.db, day);
  if (dayIsClosed(ctx, day) || row?.finalized_at) {
    await reply(ctx, msg, "Today's results are closed. The next board opens at midnight.");
    return;
  }

  const results = await resultsForDay(ctx.db, day);
  if (results.length === 0) {
    await reply(ctx, msg, "Kukaan ei ole vielä pelannut tänään.");
    return;
  }

  const prev = await getVoteState(ctx.db);
  const interimMessageIds = prev?.day === day ? (prev.interimMessageIds ?? []) : [];

  const state: VoteState = {
    day,
    mode,
    messageId: 0,
    yes: {},
    no: {},
    completed: false,
    interimMessageIds,
  };

  const threadId = msg.is_topic_message ? msg.message_thread_id : settings.groupThreadId;
  const sent = await send(ctx, msg.chat.id, renderVoteMessage(state, VOTE_THRESHOLD), {
    replyTo: msg,
    threadId,
    replyMarkup: renderVoteKeyboard(state, VOTE_THRESHOLD),
  });
  state.messageId = sent.message_id;
  await setVoteState(ctx.db, state);
}

async function postInterimSummary(ctx: Ctx, settings: Settings, day: string): Promise<Message | null> {
  const results = await resultsForDay(ctx.db, day);
  if (results.length === 0) return null;
  const dayResults: DayResult[] = results.map((r) => ({
    playerId: r.player_id,
    game: r.game,
    score: r.score,
    maxScore: r.max_score,
  }));
  const standings = dayStandings(dayResults);
  const players = await allPlayers(ctx.db);
  const names = displayNames(players);
  return sendToGroup(ctx, settings, renderSummary({ day, standings, results, names, interim: true }));
}

async function handleCallbackQuery(ctx: Ctx, query: CallbackQuery, settings: Settings): Promise<void> {
  const m = /^vote:(?:(interim|finalize):)?(yes|no)$/.exec(query.data ?? "");
  if (!m) {
    await tryCall(ctx, "answerCallbackQuery", { callback_query_id: query.id });
    return;
  }
  const choice = m[2] as "yes" | "no";

  if (settings.groupChatId === null || (query.message && query.message.chat.id !== settings.groupChatId)) {
    await tryCall(ctx, "answerCallbackQuery", { callback_query_id: query.id });
    return;
  }

  const day = today(ctx);
  const [state, dayRow] = await Promise.all([getVoteState(ctx.db), getDay(ctx.db, day)]);

  if (!state || state.day !== day || dayIsClosed(ctx, day) || dayRow?.finalized_at) {
    await tryCall(ctx, "answerCallbackQuery", { callback_query_id: query.id, text: "Tämä äänestys ei ole enää voimassa." });
    return;
  }
  if (state.completed) {
    await tryCall(ctx, "answerCallbackQuery", { callback_query_id: query.id, text: "Äänestys on jo päättynyt." });
    return;
  }
  if (query.message && query.message.message_id !== state.messageId) {
    await tryCall(ctx, "answerCallbackQuery", { callback_query_id: query.id, text: "Uudempi äänestys on käynnissä." });
    return;
  }

  const voterName = await playerName(ctx, query.from);
  const userKey = String(query.from.id);

  if (choice === "yes") {
    if (state.yes[userKey]) {
      await tryCall(ctx, "answerCallbackQuery", { callback_query_id: query.id, text: "Olet jo äänestänyt Joo." });
      return;
    }
    delete state.no[userKey];
    state.yes[userKey] = voterName;
  } else {
    if (state.no[userKey]) {
      await tryCall(ctx, "answerCallbackQuery", { callback_query_id: query.id, text: "Olet jo äänestänyt Ei." });
      return;
    }
    delete state.yes[userKey];
    state.no[userKey] = voterName;
  }

  if (Object.keys(state.yes).length >= VOTE_THRESHOLD) {
    state.completed = true;
    await tryCall(ctx, "answerCallbackQuery", {
      callback_query_id: query.id,
      text: "4 Joo-ääntä täynnä! Julkaistaan tulokset.",
    });
    await tryCall(ctx, "editMessageText", {
      chat_id: settings.groupChatId,
      message_id: state.messageId,
      text: renderVoteMessage(state, VOTE_THRESHOLD),
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });

    if (state.mode === "finalize") {
      await setVoteState(ctx.db, state);
      await finalizeDay(ctx, settings, day);
    } else {
      const sentSummary = await postInterimSummary(ctx, settings, day);
      if (sentSummary) {
        state.interimMessageIds = [...(state.interimMessageIds ?? []), sentSummary.message_id];
      }
      await setVoteState(ctx.db, state);
    }
    return;
  }

  await setVoteState(ctx.db, state);
  await tryCall(ctx, "answerCallbackQuery", {
    callback_query_id: query.id,
    text: choice === "yes" ? "Äänestit: Joo 👍" : "Äänestit: Ei 👎",
  });
  await tryCall(ctx, "editMessageText", {
    chat_id: settings.groupChatId,
    message_id: state.messageId,
    text: renderVoteMessage(state, VOTE_THRESHOLD),
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: renderVoteKeyboard(state, VOTE_THRESHOLD),
  });
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

const MAX_NAME_LENGTH = 24;
const graphemes = new Intl.Segmenter();

/** The name a player is shown with: the one chosen with /name, otherwise their Telegram first name. */
async function playerName(ctx: Ctx, user: User): Promise<string> {
  return displayNames(await allPlayers(ctx.db)).get(user.id) ?? user.first_name;
}

/** /name New name sets the caller's own display name, /name reset goes back to the Telegram name. */
async function nameCommand(ctx: Ctx, msg: Message, user: User, text: string, settings: Settings): Promise<void> {
  const players = await allPlayers(ctx.db);
  const me = players.find((p) => p.id === user.id);
  // Only players who have sent a result: the board and auto-finalize count everyone in the players table.
  if (!me) {
    await reply(ctx, msg, "You'll appear on the leaderboards after your first result. Send one, then choose your name with /name.");
    return;
  }
  const names = displayNames(players);
  const current = names.get(user.id) ?? user.first_name;
  const arg = text.replace(/^\/[A-Za-z0-9_]+(?:@[A-Za-z0-9_]+)?/, "").replace(/\s+/g, " ").trim();

  if (!arg) {
    await reply(
      ctx,
      msg,
      `Your name on the board, podiums and leaderboard is <b>${escapeHtml(current)}</b>.\nChange it with /name followed by the new name, e.g. <code>/name Karppi</code>. /name reset goes back to your Telegram name.`,
    );
    return;
  }

  let chosen: string | null = null;
  if (arg.toLowerCase() !== "reset") {
    if ([...graphemes.segment(arg)].length > MAX_NAME_LENGTH) {
      await reply(ctx, msg, `That name is too long. Keep it to ${MAX_NAME_LENGTH} characters.`);
      return;
    }
    if (arg.startsWith("/")) {
      await reply(ctx, msg, "A name can't start with /.");
      return;
    }
    const taken = players.some(
      (p) =>
        p.id !== user.id &&
        [names.get(p.id), p.display_name, p.first_name].some((n) => n?.trim().toLowerCase() === arg.toLowerCase()),
    );
    if (taken) {
      await reply(ctx, msg, `Someone is already called ${escapeHtml(arg)}. Pick another name.`);
      return;
    }
    chosen = arg;
  }

  await setDisplayName(ctx.db, user.id, chosen);
  const updated = displayNames(await allPlayers(ctx.db)).get(user.id) ?? user.first_name;
  await reply(ctx, msg, `✅ You're now <b>${escapeHtml(updated)}</b> on the board, podiums, leaderboard and stats.`);

  // Today's board lists names, so show the new one straight away.
  const day = today(ctx);
  if (!dayIsClosed(ctx, day)) await refreshBoardSafely(ctx, settings, [day]);
}

async function leaderboardText(ctx: Ctx): Promise<string> {
  const [stats, players] = await Promise.all([statsForEveryone(ctx.db), allPlayers(ctx.db)]);
  return renderLeaderboard(stats, displayNames(players));
}

// ---------- results ----------

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
  for (const day of outcome.boardDays) {
    if (await isDayComplete(ctx, day)) {
      await finalizeDay(ctx, settings, day);
    } else {
      await refreshBoardSafely(ctx, settings, [day]);
    }
  }
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
  for (const day of outcome.boardDays) {
    if (await isDayComplete(ctx, day)) {
      await finalizeDay(ctx, settings, day);
    } else {
      await refreshBoardSafely(ctx, settings, [day]);
    }
  }
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
  const dayRow = await getDay(ctx.db, day0);
  if (!dayIsClosed(ctx, day0) && !dayRow?.finalized_at) {
    const mine = (await resultsForDay(ctx.db, day0)).filter((r) => r.player_id === user.id);
    const missing = GAMES.filter((g) => !mine.some((r) => r.game === g.id)).map((g) => g.name);
    if (missing.length === 0) {
      const complete = await isDayComplete(ctx, day0);
      status = complete
        ? "🎉 All three done for today! Everyone has finished — posting today's results now!"
        : `🎉 All three done for today. Podiums at ${closeLabel(ctx.closeTime)}.`;
    } else {
      status = `Still to play today: ${missing.join(", ")}.`;
    }
  }
  return { saved, problems, status, boardDays: [...boardDays] };
}

// ---------- board ----------

async function boardText(ctx: Ctx, settings: Settings, day: string, closed: boolean): Promise<string> {
  const [results, players] = await Promise.all([
    resultsForDay(ctx.db, day),
    allPlayers(ctx.db),
  ]);
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
  const until = new Date(ctx.now.getTime() + FINALIZE_CLAIM_MS).toISOString();
  if (!(await claimFinalize(ctx.db, day, ctx.now.toISOString(), until))) return;
  try {
    await postPodium(ctx, settings, day);
  } catch (err) {
    await releaseFinalize(ctx.db, day);
    throw err;
  }
}

async function postPodium(ctx: Ctx, settings: Settings, day: string): Promise<void> {
  const results = await resultsForDay(ctx.db, day);
  if (results.length === 0) {
    await markFinalized(ctx.db, day, ctx.now.toISOString());
    return;
  }
  const dayResults: DayResult[] = results.map((r) => ({
    playerId: r.player_id,
    game: r.game,
    score: r.score,
    maxScore: r.max_score,
  }));
  const maxTotal = GAMES.length * 100;
  const standings = dayStandings(dayResults);
  const placements: PlacementRow[] = [];
  for (const [category, rows] of standings) {
    for (const s of rows) placements.push({ category, playerId: s.playerId, rank: s.rank, value: s.value });
  }
  await savePlacements(ctx.db, day, placements, [...GAMES.map((g) => g.id), "overall"]);

  const players = await allPlayers(ctx.db);
  const names = displayNames(players);

  let blowoutReport: BlowoutReport | null = null;
  const overallRows = standings.get("overall") ?? [];
  const blowout = checkBlowout(overallRows);

  if (blowout.isBlowout) {
    const winnerName = names.get(blowout.winnerId) ?? `Player ${blowout.winnerId}`;
    const winnerResults = dayResults.filter((r) => r.playerId === blowout.winnerId);
    const sorted = [...winnerResults].sort((a, b) => b.score / b.maxScore - a.score / a.maxScore);
    const regressedWinnerResults = sorted.slice(1);
    const regressedScore = overallValue(regressedWinnerResults);

    const details = `Päivän pisteet: ${blowout.winnerScore.toFixed(1)} / ${maxTotal}
Toiseksi tulleen pisteet: ${blowout.secondScore.toFixed(1)} / ${maxTotal} (voittomarginaali: +${blowout.marginPercent.toFixed(1)} %)
Karsittu päivän huippusuonenveto: ${sorted[0] ? `${sorted[0].game} (${sorted[0].score}/${sorted[0].maxScore})` : "huippupeli"}
Regressoidut pisteet: ${regressedScore.toFixed(1)} / ${maxTotal}`;

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

  // After a deploy that changed the commands, update Telegram's menus. No-op otherwise.
  try {
    await syncCommandMenus(ctx.db, ctx.tg, settings.commandMenus);
  } catch (err) {
    console.error("command menu update failed", err); // tried again next minute
  }

  if (settings.groupChatId === null) return;

  try {
    await imitationTick(ctx, settings);
  } catch (err) {
    console.error("imitation contest step failed", err); // tried again next minute
  }

  try {
    for (const day of await openDays(ctx.db)) {
      if (dayIsClosed(ctx, day) || (await isDayComplete(ctx, day))) {
        await finalizeDay(ctx, settings, day);
      }
    }
  } catch (err) {
    // Leave the day open; the next run tries again, keeping days in order.
    console.error("finalize failed", err);
  }

  const day = today(ctx);
  const dayRow = await getDay(ctx.db, day);
  if (!dayIsClosed(ctx, day) && !dayRow?.finalized_at) {
    await refreshBoardSafely(ctx, settings, [day]);
  }
}
