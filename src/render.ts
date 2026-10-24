// Message texts. Everything is sent with parse_mode HTML, so user-provided text goes through escapeHtml.

import type { PlayerRow, ResultRow, StatsRow } from "./db";
import { GAMES, gameTitle } from "./games";
import type { BlowoutReport, RegressioReport } from "./regressio";
import { MEDALS, placeMark, type Category, type Standing } from "./scoring";
import { dayLabel } from "./time";

const MAX_LENGTH = 4000; // Telegram allows 4096 characters per message

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Keeps a message under Telegram's limit by dropping whole lines, so no HTML tag is cut in half. */
function fit(lines: string[]): string {
  const out: string[] = [];
  let length = 0;
  for (const line of lines) {
    if (length + line.length + 1 > MAX_LENGTH - 2) {
      out.push("…");
      break;
    }
    out.push(line);
    length += line.length + 1;
  }
  return out.join("\n");
}

/** First names, with a last-name initial or username added only where two players share a first name. */
export function displayNames(players: PlayerRow[]): Map<number, string> {
  const base = (p: PlayerRow) => p.first_name.trim() || p.username || `Player ${p.id}`;
  const names = new Map<number, string>();
  const groups = new Map<string, PlayerRow[]>();
  for (const p of players) {
    const key = base(p).toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  for (const group of groups.values()) {
    if (group.length === 1) {
      names.set(group[0]!.id, base(group[0]!));
      continue;
    }
    const initials = group.map((p) => (p.last_name?.trim() ? `${base(p)} ${p.last_name.trim()[0]}.` : base(p)));
    group.forEach((p, i) => {
      const unique = initials.filter((n) => n === initials[i]).length === 1;
      names.set(p.id, unique ? initials[i]! : `${base(p)} (${p.username ? `@${p.username}` : `#${p.id % 1000}`})`);
    });
  }
  return names;
}

function nameOf(names: Map<number, string>, id: number): string {
  return escapeHtml(names.get(id) ?? `Player ${id}`);
}

export function closeLabel(closeTime: string): string {
  return closeTime === "00:00" ? "midnight" : closeTime;
}

export function renderBoard(opts: {
  day: string;
  results: ResultRow[];
  names: Map<number, string>;
  closed: boolean;
  closeTime: string;
  botUsername: string | null;
}): string {
  const { day, results, names } = opts;
  const lines = [
    opts.closed ? `🔒 <b>${dayLabel(day)}</b> · closed` : `📋 <b>${dayLabel(day)}</b> · today's board`,
    GAMES.map((g) => gameTitle(g, day)).join(" · "),
    "",
  ];
  const players = [...new Set(results.map((r) => r.player_id))]
    .map((id) => ({ id, done: GAMES.map((g) => results.some((r) => r.player_id === id && r.game === g.id)) }))
    .sort((a, b) => b.done.filter(Boolean).length - a.done.filter(Boolean).length || nameOf(names, a.id).localeCompare(nameOf(names, b.id)));
  if (players.length === 0) lines.push("<i>Nobody has played yet.</i>");
  for (const p of players) lines.push(`${p.done.map((d) => (d ? "✅" : "⬜")).join("")} ${nameOf(names, p.id)}`);
  lines.push("");
  if (opts.closed) {
    lines.push("Final results are posted below.");
  } else {
    const bot = opts.botUsername ? `@${escapeHtml(opts.botUsername)}` : "me";
    lines.push(`Paste your results here or send them privately to ${bot}. Podiums at ${closeLabel(opts.closeTime)}.`);
  }
  return fit(lines);
}

export function renderSummary(opts: {
  day: string;
  standings: Map<Category, Standing[]>;
  results: ResultRow[];
  names: Map<number, string>;
  blowoutReport?: BlowoutReport | null;
}): string {
  const { day, standings, results, names, blowoutReport } = opts;
  const lines = [`🏁 <b>Results · ${dayLabel(day)}</b>`];
  for (const game of GAMES) {
    lines.push("", `<b>${escapeHtml(gameTitle(game, day))}</b>`);
    const rows = standings.get(game.id) ?? [];
    if (rows.length === 0) lines.push("<i>Nobody played.</i>");
    for (const s of rows) lines.push(`${placeMark(s.rank)} ${nameOf(names, s.playerId)} · ${s.value}`);
  }
  lines.push("", "🏆 <b>Overall</b> (out of 300)");
  for (const s of standings.get("overall") ?? []) {
    const played = new Set(results.filter((r) => r.player_id === s.playerId).map((r) => r.game)).size;
    const note = played < GAMES.length ? ` · ${played}/${GAMES.length} games` : "";
    lines.push(`${placeMark(s.rank)} ${nameOf(names, s.playerId)} · ${s.value.toFixed(1)}${note}`);
  }
  if (blowoutReport) {
    lines.push(
      "",
      "🚨 <b>TILASTOVALVONTA: Epäilyttävä ylivoima havaittu!</b>",
      `Voittaja ${escapeHtml(blowoutReport.winnerName)} oli ${blowoutReport.marginPercent.toFixed(1)}% parempi kuin toiseksi tullut.`,
      `Karsimalla päivän kovin suonenveto regressoitu tulos on ${blowoutReport.regressedScore.toFixed(1)} pistettä.`,
      `<i>"${escapeHtml(blowoutReport.explanation)}"</i>`,
    );
  }
  lines.push("", "/leaderboard for all-time standings");
  return fit(lines);
}

export function renderRegressio(report: RegressioReport): string {
  const { playerName, stats, explanation, subtitle } = report;
  if (stats.totalPlayed === 0) {
    return `📊 <b>REGRESSIOANALYYSI: ${escapeHtml(playerName)}</b>\n\nEi tallennettuja pelejä. Pelaa ensin päivän pelejä, jotta tilastoja voidaan karsia.`;
  }

  const sub = subtitle ?? "[Hajontakomissio] Kun tilastoista karsitaan epärealistiset poikkeamat";
  const lines = [
    `📊 <b>REGRESSIOANALYYSI: ${escapeHtml(playerName)}</b>`,
    `<i>${escapeHtml(sub)}</i>`,
    "",
    "📉 <b>Tilastokorjaus:</b>",
    `• Alkuperäinen keskiarvo: ${stats.rawAverage.toFixed(1)} / 5.0 (${stats.totalPlayed} ${stats.totalPlayed === 1 ? "tulos" : "peliä"})`,
    `• Karsitut suonenvedot: ${stats.outlierCount} kpl (${stats.outlierPuzzles.slice(0, 3).join(", ")}${stats.outlierPuzzles.length > 3 ? "..." : ""})`,
    `• <b>Regressoitu taso:</b> ${stats.regressedAverage.toFixed(1)} / 5.0 (📉 -${stats.dropPercent.toFixed(1)}%)`,
    `• <b>Johtopäätös:</b> Taantuu sarjan harmaaseen perusmassaan.`,
    "",
    "🧠 <b>Asiantuntijalausunto:</b>",
    `<i>"${escapeHtml(explanation)}"</i>`,
  ];
  return fit(lines);
}

function medalCounts(s: Pick<StatsRow, "gold" | "silver" | "bronze">): string {
  return `${MEDALS[0]}${s.gold} ${MEDALS[1]}${s.silver} ${MEDALS[2]}${s.bronze}`;
}

export function renderLeaderboard(stats: StatsRow[], names: Map<number, string>): string {
  const overall = stats
    .filter((s) => s.category === "overall")
    .sort((a, b) => b.gold - a.gold || b.silver - a.silver || b.bronze - a.bronze || b.average - a.average);
  if (overall.length === 0) return "🏆 <b>All-time leaderboard</b>\n\nNo finished days yet. The first podium is posted when today closes.";

  const lines = ["🏆 <b>All-time leaderboard</b>", "<i>Daily overall podiums · average score · days played</i>"];
  overall.forEach((s, i) => {
    lines.push(`${i + 1}. ${nameOf(names, s.player_id)}  ${medalCounts(s)} · ${s.average.toFixed(1)} · ${s.played}`);
  });
  lines.push("", "<b>Game wins</b> 🥇");
  for (const game of GAMES) {
    const winners = stats
      .filter((s) => s.category === game.id && s.gold > 0)
      .sort((a, b) => b.gold - a.gold || b.silver - a.silver)
      .map((s) => `${nameOf(names, s.player_id)} ${s.gold}`);
    lines.push(`${escapeHtml(game.name)}: ${winners.length ? winners.join(" · ") : "–"}`);
  }
  return fit(lines);
}

export function renderPlayerStats(name: string, stats: StatsRow[]): string {
  const overall = stats.find((s) => s.category === "overall");
  if (!overall) return `📊 <b>${escapeHtml(name)}</b>\n\nNo finished days yet. Your stats appear once a day you played has closed.`;
  const lines = [
    `📊 <b>${escapeHtml(name)}</b> · ${overall.played} ${overall.played === 1 ? "day" : "days"} played`,
    "",
    `<b>Overall</b>: ${medalCounts(overall)} · avg ${overall.average.toFixed(1)} · best ${overall.best.toFixed(1)}`,
  ];
  for (const game of GAMES) {
    const s = stats.find((x) => x.category === game.id);
    lines.push(
      s
        ? `<b>${escapeHtml(game.name)}</b>: ${medalCounts(s)} · avg ${Math.round(s.average)} · best ${s.best} · ${s.played} played`
        : `<b>${escapeHtml(game.name)}</b>: not played yet`,
    );
  }
  return lines.join("\n");
}

export function renderHelp(opts: { closeTime: string; timeZone: string; linked: boolean }): string {
  const lines = [
    "👋 I collect the daily results for <b>Eraly</b>, <b>Krillion</b> and <b>Size It Up</b> and post podiums every day.",
    "",
    "<b>How it works</b>",
    "1. Play the daily games: eraly.io, krillion.io and magnitudle.com/size-it-up",
    "2. Tap <b>Share</b> at the end of a game and paste the result in the group, or send it to me in a private chat if you'd rather keep your score to yourself until the podium. You can send all three in one message.",
    `3. The group's board shows who has played, and the podiums are posted at ${closeLabel(opts.closeTime)} (${escapeHtml(opts.timeZone)} time).`,
    "",
    "Only your first result for each game counts. Unlimited, archive and themed modes don't count.",
    "",
    "<b>Commands</b>",
    "/today – today's board",
    "/me – your stats",
    "/leaderboard – all-time standings",
  ];
  if (!opts.linked) lines.push("", "⚠️ I'm not linked to a group yet. A group admin needs to add me to the group and send /setup there.");
  return lines.join("\n");
}
