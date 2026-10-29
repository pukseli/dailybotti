// Message texts. Everything is sent with parse_mode HTML, so user-provided text goes through escapeHtml.

import type { PlayerRow, ResultRow, StatsRow, VoteState } from "./db";
import { ERALY_SYMBOL_POINTS, GAMES, KRILLION_SYMBOL_POINTS, gameById, gameTitle, parseRoundData, type GameId } from "./games";
import type { DayImitation } from "./imitation";
import type { BlowoutReport, RegressioReport } from "./regressio";
import { MEDALS, placeMark, type Category, type Standing } from "./scoring";
import type { InlineKeyboardMarkup } from "./telegram";
import { dayLabel } from "./time";

const MAX_LENGTH = 4000; // Telegram allows 4096 characters per message

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Keeps a message under Telegram's limit by dropping whole lines, so no HTML tag is cut in half. */
export function fit(lines: string[]): string {
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

/**
 * The name chosen with /name, otherwise the Telegram first name. A last-name initial or username is added only
 * where two players would show the same name.
 */
export function displayNames(players: PlayerRow[]): Map<number, string> {
  const base = (p: PlayerRow) => p.display_name?.trim() || p.first_name.trim() || p.username || `Player ${p.id}`;
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
  /** The day's imitation contest, shown as a fourth column. */
  imitation?: { name: string; entrants: Set<number> } | null;
}): string {
  const { day, results, names, imitation } = opts;
  const titles = GAMES.map((g) => gameTitle(g, day));
  if (imitation) titles.push(`🎭 ${escapeHtml(imitation.name)}`);
  const lines = [
    opts.closed ? `🔒 <b>${dayLabel(day)}</b> · closed` : `📋 <b>${dayLabel(day)}</b> · today's board`,
    titles.join(" · "),
    "",
  ];
  const players = [...new Set([...results.map((r) => r.player_id), ...(imitation?.entrants ?? [])])]
    .map((id) => ({
      id,
      done: [
        ...GAMES.map((g) => results.some((r) => r.player_id === id && r.game === g.id)),
        ...(imitation ? [imitation.entrants.has(id)] : []),
      ],
    }))
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
  /** The day's imitation result, when it counts towards the overall score. */
  imitation?: DayImitation | null;
  interim?: boolean;
}): string {
  const { day, standings, results, names, blowoutReport, imitation, interim } = opts;
  const lines = [interim ? `⏱️ <b>Väliaikatilanne · ${dayLabel(day)}</b>` : `🏁 <b>Results · ${dayLabel(day)}</b>`];
  for (const game of GAMES) {
    lines.push("", `<b>${escapeHtml(gameTitle(game, day))}</b>`);
    const rows = standings.get(game.id) ?? [];
    if (rows.length === 0) lines.push("<i>Nobody played.</i>");
    for (const s of rows) lines.push(`${placeMark(s.rank)} ${nameOf(names, s.playerId)} · ${s.value}`);
  }
  if (imitation) {
    lines.push("", `<b>🎭 Imitaatio: ${escapeHtml(imitation.name)}</b>`);
    for (const s of standings.get("imitation") ?? []) {
      const score = imitation.scores.get(s.playerId)!;
      lines.push(`${placeMark(s.rank)} ${nameOf(names, s.playerId)} · ${score.points}/${score.max} p`);
    }
  }
  const events = GAMES.length + (imitation ? 1 : 0);
  lines.push("", `🏆 <b>Overall</b> (out of ${events * 100})`);
  for (const s of standings.get("overall") ?? []) {
    const played =
      new Set(results.filter((r) => r.player_id === s.playerId).map((r) => r.game)).size + (imitation?.scores.has(s.playerId) ? 1 : 0);
    const note = played < events ? ` · ${played}/${events} games` : "";
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
  if (interim) {
    lines.push(
      "",
      '<i>Päivän kisa on vielä auki. Vastaa tähän viestiin "finalize" käynnistääksesi äänestyksen päivän lopullisesta sulkemisesta.</i>',
    );
  } else {
    lines.push("", "/leaderboard for all-time standings");
  }
  return fit(lines);
}

export function renderVoteMessage(state: VoteState, threshold = 4): string {
  const yesNames = Object.values(state.yes);
  const noNames = Object.values(state.no);
  const header = state.completed
    ? state.mode === "finalize"
      ? `✅ <b>Äänestys hyväksytty (${yesNames.length}/${threshold}) – suljetaan päivän kisa ja julkaistaan lopulliset tulokset!</b>`
      : `✅ <b>Äänestys hyväksytty (${yesNames.length}/${threshold}) – julkaistaan väliaikatilanne!</b>`
    : state.mode === "finalize"
      ? `🗳️ <b>Äänestys: Suljetaanko päivän kisa ja julkaistaan lopulliset tulokset? (${dayLabel(state.day)})</b>\nVaaditaan ${threshold} Joo-ääntä.`
      : `🗳️ <b>Äänestys: Julkaistaanko päivän väliaikatilanne? (${dayLabel(state.day)})</b>\nVaaditaan ${threshold} Joo-ääntä.`;

  return [
    header,
    "",
    `👍 <b>Joo (${yesNames.length}/${threshold}):</b> ${yesNames.length ? yesNames.map(escapeHtml).join(", ") : "–"}`,
    `👎 <b>Ei (${noNames.length}):</b> ${noNames.length ? noNames.map(escapeHtml).join(", ") : "–"}`,
  ].join("\n");
}

export function renderVoteKeyboard(state: VoteState, threshold = 4): InlineKeyboardMarkup {
  const yesCount = Object.keys(state.yes).length;
  const noCount = Object.keys(state.no).length;
  return {
    inline_keyboard: [
      [
        { text: `👍 Joo (${yesCount}/${threshold})`, callback_data: `vote:${state.mode}:yes` },
        { text: `👎 Ei (${noCount})`, callback_data: `vote:${state.mode}:no` },
      ],
    ],
  };
}

export function renderRegressio(report: RegressioReport): string {
  const { playerName, stats, explanation, subtitle, outlierLabel, conclusion } = report;
  if (stats.totalPlayed === 0) {
    return `📊 <b>REGRESSIOANALYYSI: ${escapeHtml(playerName)}</b>\n\nEi tallennettuja pelejä. Pelaa ensin päivän pelejä, jotta tilastoja voidaan karsia.`;
  }

  const sub = subtitle ?? "[Hajontakomissio] Kun tilastoista karsitaan epärealistiset poikkeamat";
  const puzzleList = stats.outlierPuzzles.length > 0 ? ` (${stats.outlierPuzzles.slice(0, 3).join(", ")}${stats.outlierPuzzles.length > 3 ? "..." : ""})` : "";
  const outlierQuip = outlierLabel
    ? `${stats.outlierCount} kpl${puzzleList} – ${escapeHtml(outlierLabel)}`
    : `${stats.outlierCount} kpl${puzzleList}`;
  const conclusionQuip = conclusion ? escapeHtml(conclusion) : "Taantuu sarjan harmaaseen perusmassaan.";

  const lines = [
    `📊 <b>REGRESSIOANALYYSI: ${escapeHtml(playerName)}</b>`,
    `<i>${escapeHtml(sub)}</i>`,
    "",
    "📉 <b>Tilastokorjaus:</b>",
    `• Alkuperäinen keskiarvo: ${stats.rawAverage.toFixed(1)} / 5.0 (${stats.totalPlayed} ${stats.totalPlayed === 1 ? "tulos" : "peliä"})`,
    `• Karsitut suonenvedot: ${outlierQuip}`,
    `• <b>Regressoitu taso:</b> ${stats.regressedAverage.toFixed(1)} / 5.0 (📉 -${stats.dropPercent.toFixed(1)}%)`,
    `• <b>Johtopäätös:</b> ${conclusionQuip}`,
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
  const imitators = stats
    .filter((s) => s.category === "imitation" && s.gold > 0)
    .sort((a, b) => b.gold - a.gold || b.silver - a.silver)
    .map((s) => `${nameOf(names, s.player_id)} ${s.gold}`);
  if (stats.some((s) => s.category === "imitation")) lines.push(`🎭 Imitaatio: ${imitators.length ? imitators.join(" · ") : "–"}`);
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
  const imitation = stats.find((x) => x.category === "imitation");
  if (imitation) {
    lines.push(
      `<b>🎭 Imitaatio</b>: ${medalCounts(imitation)} · avg ${Math.round(imitation.average)} % · best ${Math.round(imitation.best)} % · ${imitation.played} played`,
    );
  }
  return lines.join("\n");
}

function parseStoredRounds(res: ResultRow): (number | string)[] | null {
  if (res.rounds_json) {
    try {
      const parsed = JSON.parse(res.rounds_json);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch {
      // Fall through to raw_text
    }
  }
  if (res.raw_text) {
    return parseRoundData(res.raw_text, res.game).rounds;
  }
  return null;
}

export function renderPlayerDayResults(opts: {
  playerName: string;
  day: string;
  results: ResultRow[];
  gameFilter?: GameId | null;
}): string {
  const { playerName, day, results, gameFilter } = opts;
  const header = `🎯 <b>${escapeHtml(playerName)} · ${dayLabel(day)}</b>`;

  if (gameFilter) {
    const game = gameById(gameFilter)!;
    const res = results.find((r) => r.game === gameFilter);
    if (!res) {
      return `${header}\n\n<i>Ei tallennettua tulosta pelistä ${escapeHtml(gameTitle(game, day))}.</i>`;
    }
  } else if (results.length === 0) {
    return `${header}\n\n<i>Ei tallennettuja tuloksia tälle päivälle.</i>`;
  }

  const lines = [header];
  const gamesToShow = gameFilter ? GAMES.filter((g) => g.id === gameFilter) : GAMES;

  for (const game of gamesToShow) {
    const res = results.find((r) => r.game === game.id);
    if (!res) continue;

    const title = res.puzzle !== null ? `${game.name} #${res.puzzle}` : gameTitle(game, day);
    lines.push("", `<b>${escapeHtml(title)}</b> · ${res.score}/${res.max_score}`);

    if (game.id === "krillion") {
      const rounds = parseStoredRounds(res);
      if (rounds && rounds.length > 0) {
        const symbols = rounds.map(String);
        lines.push(escapeHtml(symbols.join("")));
        const breakdown = symbols.map((sym, idx) => {
          const pts = KRILLION_SYMBOL_POINTS[sym];
          return pts !== undefined ? `${idx + 1}. ${escapeHtml(sym)} ${pts}p` : `${idx + 1}. ${escapeHtml(sym)}`;
        });
        lines.push(breakdown.join(" · "));
      } else if (res.raw_text) {
        const rawLines = res.raw_text
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l && !/^Krillion/i.test(l) && !/^\d+$/.test(l) && !/^https?:\/\//i.test(l));
        for (const l of rawLines) lines.push(escapeHtml(l));
      }
    } else if (game.id === "sizeitup") {
      const rawRoundLines = res.raw_text
        ? res.raw_text
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => /^[🟥⬜]{5}\s+\d+(?:[.,]\d+)?\*?$/.test(l))
        : [];
      if (rawRoundLines.length > 0) {
        rawRoundLines.forEach((l, idx) => {
          lines.push(`${idx + 1}. ${escapeHtml(l)}`);
        });
        const noteLine = res.raw_text
          ?.split("\n")
          .map((l) => l.trim())
          .find((l) => l.startsWith("*"));
        if (noteLine) lines.push(`<i>${escapeHtml(noteLine)}</i>`);
      } else {
        const rounds = parseStoredRounds(res);
        if (rounds && rounds.length > 0) {
          rounds.forEach((val, idx) => {
            const num = Number(val);
            const reds = Math.max(0, Math.min(5, Math.round(num / 20)));
            const bar = "🟥".repeat(reds) + "⬜".repeat(5 - reds);
            lines.push(`${idx + 1}. ${bar} ${num}`);
          });
        }
      }
    } else if (game.id === "eraly") {
      const rounds = parseStoredRounds(res);
      if (rounds && rounds.length > 0) {
        const symbols = rounds.map(String);
        lines.push(escapeHtml(symbols.join("")));
        const breakdown = symbols.map((sym, idx) => {
          const pts = ERALY_SYMBOL_POINTS[sym];
          return pts !== undefined ? `${idx + 1}. ${escapeHtml(sym)} ${pts}p` : `${idx + 1}. ${escapeHtml(sym)}`;
        });
        lines.push(breakdown.join(" · "));
      } else if (res.raw_text) {
        const rawLines = res.raw_text
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l && !/^https?:\/\//i.test(l));
        for (const rawLine of rawLines) {
          const stripped = rawLine.replace(/^Eraly\s*#\s*\d+\s*(?:·|-)?\s*/i, "").trim();
          if (stripped && !/^(?:Score:\s*)?\d+\s*\/\s*700$/i.test(stripped)) {
            lines.push(escapeHtml(stripped));
          }
        }
      }
    }
  }

  return fit(lines);
}

/** !help (and /komennot): lists all available commands and their usage. */
export function renderCommands(): string {
  const lines = [
    "📖 <b>Käytössä olevat komennot</b>",
    "",
    "<b>Pelit ja tilastot</b>",
    "• <code>/today</code> – Päivän pelitaulu (ryhmässä siirtää taulun keskustelun alareunaan)",
    "• <code>/tulos [pelaaja] [peli] [eilen | YYYY-MM-DD | #nro]</code> (tai <code>/tulokset</code>) – Pelaajan pelitulos kierroksittain (omat tulokset päivän ollessa auki, kaikkien tulokset päivän sulkeuduttua)",
    "• <code>/me</code> – Omat tilastot, mitalit, keskiarvot ja ennätykset",
    "• <code>/leaderboard</code> – Kaikkien aikojen tilanne ja lajivoitot",
    "• <code>/regressio [pelaaja | kärki]</code> – Hajonta- ja outlier-analyysi (ilman nimeä tilastokärjestä, nimen kanssa valitusta pelaajasta, tai vastauksena viestiin sen tuloksesta)",
    "",
    "<b>Päivän äänestykset (ryhmässä)</b>",
    "• <code>!vote-leaderboard</code> (tai <code>/vote_leaderboard</code>) – Käynnistä äänestys päivän väliaikatilanteen julkaisusta (vaatii 4 Joo-ääntä)",
    "• <code>!vote-leaderboard finalize</code> (tai <code>/finalize</code>) – Käynnistä äänestys päivän kisan lopullisesta sulkemisesta ja tulosten julkaisusta (toimii myös vastaamalla väliaikatilanteeseen <code>finalize</code>, <code>sulje</code> tai <code>lopullinen</code>)",
    "",
    "<b>🎭 Imitaatiokisa</b>",
    "• <code>/haaste</code> – Päivän imitaatiohaaste, saapuneet äänitteet ja äänestyksen tilanne",
    "• <code>/ehdota Nimi</code> – Lisää uusi hahmo tai henkilö imitaatioiden arvontalistalle",
    "• <code>/ehdotukset</code> – Listaa arvonnassa jäljellä olevat imitaatioehdotukset",
    "• <code>/aanesta</code> – Pyydä uusi äänestyslippu yksityisviestinä äänestyksen ollessa käynnissä",
    "",
    "<b>Asetukset ja ohjeet</b>",
    "• <code>/name Uusi nimi</code> (tai <code>/nimi</code>) – Vaihda nimesi tauluun, palkintopalleille ja tilastoihin (<code>/name reset</code> palauttaa Telegram-nimen)",
    "• <code>!help</code> (tai <code>/komennot</code>) – Tämä komentolistaus",
    "• <code>/help</code> (tai <code>/start</code>) – Kattavat peliohjeet, säännöt ja käyttöönotto-ohjeet",
    "• <code>/setup</code> – Yhdistä botti ryhmään (vain ryhmän ylläpitäjille)",
  ];
  return fit(lines);
}

/** /help and /start: how to take part, the rules, the commands and how to set the bot up in a group. */
export function renderHelp(opts: { closeTime: string; timeZone: string; linked: boolean }): string {
  const closes = opts.closeTime === "00:00" ? "keskiyöllä" : `klo ${opts.closeTime}`;
  const lines = [
    "👋 Kerään <b>Eralyn</b>, <b>Krillionin</b> ja <b>Size It Upin</b> päivän tulokset ja julkaisen palkintopallit joka päivä.",
    "",
    "<b>Näin pelaat mukana</b>",
    "1. Pelaa päivän pelit: eraly.io, krillion.io ja magnitudle.com/size-it-up",
    "2. Paina pelin lopussa <b>Share</b> ja liitä tulos ryhmään. Saat 👍-reaktion, kun tulos on tallessa.",
    "3. Jos et halua näyttää pisteitäsi ennen palkintojenjakoa, lähetä tulos minulle yksityisviestillä. Avaa minut ja paina ensin <b>Start</b>.",
    "4. Kaikki kolme tulosta voi lähettää samassa viestissä.",
    `5. Ryhmän taulusta näkee, kuka on jo pelannut. Palkintopallit julkaistaan ${closes} (${escapeHtml(opts.timeZone)}).`,
    "",
    "<b>Säännöt</b>",
    "• Vain päivän pelit lasketaan, eivät Unlimited-, arkisto- tai teemapelit eivätkä Size It Upin Pop Culture tai Geography.",
    "• Vain ensimmäinen tulos kustakin pelistä lasketaan.",
    "• Size It Upin tuloksessa ei ole pelinumeroa, joten se lasketaan sille päivälle, jona lähetät sen.",
    "• Kokonaispisteet: jokainen peli prosentteina maksimistaan, yhteensä enintään 300, tai 400 kun päivällä on imitaatiohaaste. Pelaamatta jäänyt peli on 0.",
    "",
    "<b>Komennot</b>",
    "!help (tai /komennot) – luettelee kaikki käytössä olevat komennot",
    "/today – päivän taulu",
    "/tulos [pelaaja] [peli] [eilen | YYYY-MM-DD | #nro] (tai /tulokset) – pelaajan pelitulos kierroksittain (omat tulokset päivän ollessa auki, kaikkien tulokset päivän sulkeuduttua)",
    "/me – omat tilastosi",
    "/leaderboard – kaikkien aikojen tilanne",
    "/regressio – hajonta-analyysi: ilman nimeä kärjestä, nimen kanssa siitä pelaajasta, tai vastauksena viestiin sen tuloksesta",
    "/name Uusi nimi (tai /nimi) – vaihda nimesi tauluun, palkintopalleille ja tilastoihin. /name reset palauttaa Telegram-nimen",
    "!vote-leaderboard (tai /vote_leaderboard) – käynnistä äänestys päivän väliaikatilanteen julkaisusta (tai !vote-leaderboard finalize / /finalize päivän sulkemisesta)",
    "/setup – yhdistä botti ryhmään (vain ylläpitäjille)",
    "/help – tämä ohje",
    "",
    "<b>🎭 Imitaatiokisa</b>",
    "• Arvon joka aamu klo 9 päivän hahmon tai ihmisen ehdotuslistalta. Sama ei tule kahdesti.",
    "• Lähetä imitaatiosi ääniviestinä ryhmään klo 21 mennessä. Viimeisin äänitteesi lasketaan.",
    "• Kun kaikki ovat lähettäneet, viimeistään klo 21, lähetän jokaiselle äänestyslipun yksityisviestinä. Valitse paras (3 p) ja toiseksi paras (1 p). Omaa suoritusta ei voi äänestää.",
    "• Tulokset tulevat, kun kaikki ovat äänestäneet, viimeistään palkintojenjaossa. Imitaatio lasketaan päivän kokonaispisteisiin neljäntenä lajina: saadut pisteet prosentteina maksimista.",
    "/haaste – päivän hahmo ja tilanne",
    "/ehdota Nimi – lisää hahmo tai ihminen ehdotuslistalle",
    "/ehdotukset – arvottavana olevat ehdotukset",
    "/aanesta – uusi äänestyslippu yksityisviestinä",
    "",
    "<b>Käyttöönotto ryhmässä</b>",
    "1. Lisää minut ryhmään.",
    "2. Tee minusta ryhmän ylläpitäjä, jotta näen ryhmään liitetyt tulokset. Erikoisoikeuksia ei tarvita.",
    "3. Ryhmän ylläpitäjä lähettää ryhmään /setup.",
    "4. Jokainen, joka haluaa lähettää tuloksia yksityisesti, avaa minut ja painaa <b>Start</b>.",
    "",
    "Oman botin pystytys (BotFather ja Cloudflare): ohjeet ovat README:ssä osoitteessa github.com/pukseli/dailybotti",
  ];
  if (!opts.linked) lines.push("", "⚠️ En ole vielä yhdistetty ryhmään. Ryhmän ylläpitäjän pitää lisätä minut ryhmään ja lähettää siellä /setup.");
  return lines.join("\n");
}
