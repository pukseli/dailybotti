import marimo

__generated_with = "0.25.2"
app = marimo.App(width="medium", app_title="Daily games stats")


@app.cell
def _():
    import html
    from datetime import timedelta

    import altair as alt
    import great_tables as gt
    import marimo as mo
    import polars as pl

    return alt, gt, html, mo, pl, timedelta


@app.cell
def _(mo):
    # Mirrors src/games.ts, in the order the bot lists games.
    GAMES = {"eraly": "Eraly", "krillion": "Krillion", "sizeitup": "Size It Up"}
    CATEGORIES = {"Overall": "overall", **{name: game for game, name in GAMES.items()}}
    # The group's timezone, as in wrangler.jsonc. Days and hours on the dashboard follow it.
    TIMEZONE = "Europe/Helsinki"
    # Krillion's dive row, one symbol per round, best first (plan.md).
    # 🌟 and 🤡 are unconfirmed: their values come from a fan site, not a real share yet.
    KRILLION_SYMBOLS = {
        "🌟": ("One in a Krillion", 100),
        "🏮": ("Deep Cut", 85),
        "🦑": ("Rare", 60),
        "🐟": ("Schooler", 30),
        "🤡": ("Too Clever", 15),
        "🫧": ("Plankton", 10),
        "⬛": ("Miss", 0),
    }

    # Categorical slots in fixed order, stepped separately for light and dark surfaces.
    # Players past the eighth share a neutral gray rather than getting a generated hue.
    DARK = mo.app_meta().theme == "dark"
    PALETTE = (
        ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"]
        if DARK
        else ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"]
    )
    OTHER = "#8a8985"
    # Table text and hairlines for the same two surfaces.
    INK, RULE = ("#f0efec", "#3a3a37") if DARK else ("#0b0b0b", "#e4e3df")

    def style(chart):
        """Recessive axes and grid, no frame: the data carries the chart."""
        return (
            chart.configure_axis(domain=False, gridOpacity=0.35, tickColor=OTHER, labelColor=OTHER, titleColor=OTHER)
            .configure_view(stroke=None)
            .configure_legend(labelColor=OTHER, titleColor=OTHER, orient="top")
        )

    return (
        CATEGORIES,
        DARK,
        GAMES,
        INK,
        KRILLION_SYMBOLS,
        OTHER,
        PALETTE,
        RULE,
        TIMEZONE,
        style,
    )


@app.cell
def _(GAMES, OTHER, PALETTE, TIMEZONE, alt, mo, pl):
    # Written by snapshot.py (real data) or sample_data.py (made up). Read over HTTP when exported to WASM.
    _data = mo.notebook_location() / "public"
    meta = pl.read_csv(str(_data / "meta.csv")).row(0, named=True)
    # submitted_at is UTC (the bot writes toISOString()); parsed explicitly so both "Z" and "+00:00" work.
    _results = pl.read_csv(str(_data / "results.csv"), try_parse_dates=True, schema_overrides={"submitted_at": pl.String})
    _placements = pl.read_csv(str(_data / "placements.csv"), try_parse_dates=True)

    # Players are labelled by their chosen name; two people with the same name get their number too.
    players = (
        _results.select("player", "name")
        .unique()
        .sort("player")
        .with_columns(
            who=pl.when(pl.col("name").is_duplicated())
            .then(pl.format("{} #{}", "name", "player"))
            .otherwise("name")
        )
    )
    _who = players.select("player", "who")
    _game_names = pl.col("game").replace_strict(GAMES, default=pl.col("game"))
    results = _results.join(_who, on="player").with_columns(
        game_name=_game_names,
        pct=pl.col("score") / pl.col("max_score") * 100,
        submitted=pl.col("submitted_at").str.to_datetime(time_zone="UTC").dt.convert_time_zone(TIMEZONE),
    ).with_columns(hour=pl.col("submitted").dt.hour())
    placements = _placements.join(_who, on="player")

    # Colour follows the player, never the filter: every chart uses this one scale over everyone.
    _names = players["who"].to_list()
    player_scale = alt.Scale(domain=_names, range=[PALETTE[i] if i < len(PALETTE) else OTHER for i in range(len(_names))])
    return meta, placements, player_scale, players, results


@app.cell
def _(meta, mo, results):
    _sample = (
        mo.callout(mo.md("**Sample data.** These players and scores are made up, run `snapshot.py` for the real thing."), kind="warn")
        if meta["source"] == "sample"
        else None
    )
    mo.vstack(
        [
            mo.md(
                f"""
                # Daily games stats
                Results up to **{results["day"].max().day} {results["day"].max():%b %Y}** · snapshot taken {meta["snapshot_at"][:16].replace("T", " ")} UTC
                """
            ),
            _sample,
        ]
    )
    return


@app.cell
def _(mo, players):
    period = mo.ui.dropdown({"Last 7 days": 7, "Last 30 days": 30, "All time": 0}, value="Last 30 days", label="Period")
    picked = mo.ui.multiselect(options=players["who"].to_list(), value=players["who"].to_list(), label="Players")
    mo.hstack([period, picked], justify="start", gap=2)
    return period, picked


@app.cell
def _(period, picked, pl, placements, results, timedelta):
    # Periods end at the last day with results, so an old snapshot still shows a full week.
    last_day = results["day"].max()
    first_day = last_day - timedelta(days=period.value - 1) if period.value else results["day"].min()
    _keep = pl.col("day").is_between(first_day, last_day) & pl.col("who").is_in(picked.value)
    period_results = results.filter(_keep)
    # Ranks stay as they were on the day, among everyone who played, whoever is picked here.
    period_placements = placements.filter(_keep)
    return first_day, last_day, period_placements, period_results


@app.cell
def _(mo, period_placements, period_results, pl):
    _wins = (
        period_placements.filter(pl.col("category") == "overall", pl.col("rank") == 1)
        .group_by("who")
        .len()
        .sort("len", descending=True)
    )
    _leader = f"{_wins['who'][0]} · {_wins['len'][0]} wins" if _wins.height else "–"
    mo.hstack(
        [
            mo.stat(value=str(period_results["day"].n_unique()), label="Days played"),
            mo.stat(value=str(period_results.height), label="Results posted"),
            mo.stat(value=str(period_results["who"].n_unique()), label="Players"),
            mo.stat(value=_leader, label="Most daily wins"),
        ],
        widths="equal",
        gap=1,
    )
    return


@app.cell(hide_code=True)
def _(mo):
    mo.md("""
    ## Player fact sheets
    How often everyone plays, their best rounds, and a few tags for what they're known for.
    """)
    return


@app.cell(hide_code=True)
def _(
    GAMES,
    KRILLION_SYMBOLS,
    last_day,
    period_placements,
    period_results,
    pl,
    player_scale,
    timedelta,
):
    # The numbers behind each fact sheet, over the period and the picked players.
    # Portions are out of the days that had any result, so a game nobody could play yet doesn't count against anyone.
    _game_days = dict(period_results.group_by("game").agg(pl.col("day").n_unique()).iter_rows())
    _all_days = period_results["day"].n_unique()

    # Rounds come as JSON: seven symbols for Krillion, five scores for Size It Up. Older rows may have none.
    _krillion = (
        period_results.filter(pl.col("game") == "krillion", pl.col("rounds_json").is_not_null())
        .select("who", symbol=pl.col("rounds_json").str.json_decode(pl.List(pl.String)))
        .explode("symbol")
        # Some phones send ⬛ with an emoji presentation selector (⬛ + U+FE0F); it's the same symbol.
        .with_columns(pl.col("symbol").str.replace_all("\ufe0f", "", literal=True))
    )
    _size_it_up = (
        period_results.filter(pl.col("game") == "sizeitup", pl.col("rounds_json").is_not_null())
        .select("who", points=pl.col("rounds_json").str.json_decode(pl.List(pl.Int64)))
        .explode("points")
    )
    _overall = period_placements.filter(pl.col("category") == "overall")
    _last_week = last_day - timedelta(days=6)

    facts = {}
    for _w in [w for w in player_scale.domain if w in period_results["who"].unique()]:
        _r = period_results.filter(pl.col("who") == _w)
        _o = _overall.filter(pl.col("who") == _w)
        _days = set(_r["day"].to_list())
        _streak = 0
        while last_day - timedelta(days=_streak) in _days:
            _streak += 1
        # Days with two or more games where everything was posted within half an hour.
        _sessions = _r.group_by("day").agg(n=pl.len(), span=pl.col("submitted").max() - pl.col("submitted").min()).filter(pl.col("n") >= 2)
        _symbols = dict(_krillion.filter(pl.col("who") == _w).group_by("symbol").len().iter_rows())
        _rounds = _size_it_up.filter(pl.col("who") == _w)["points"]
        facts[_w] = {
            "days": len(_days),
            "all_days": _all_days,
            "games": {g: (_r.filter(pl.col("game") == g).height, _game_days.get(g, 0)) for g in GAMES},
            "results": _r.height,
            "early": _r["hour"].is_between(5, 9).mean(),
            "last_minute": (_r["hour"] == 23).mean(),
            "night": ((_r["hour"] >= 21) | (_r["hour"] < 4)).mean(),
            "weekend": sum(d.weekday() >= 5 for d in _days) / len(_days),
            "speedrun": (_sessions["span"] <= timedelta(minutes=30)).mean() if _sessions.height else 0.0,
            "streak": _streak,
            "wins": (_o["rank"] == 1).sum(),
            "silvers": (_o["rank"] == 2).sum(),
            "avg_pct": _r["pct"].mean(),
            "pct_spread": _r["pct"].std() if _r.height >= 10 else None,
            "form": (_o.filter(pl.col("day") >= _last_week)["value"].mean() or 0) - (_o["value"].mean() or 0),
            "form_base": _o["value"].mean() or 0,
            "symbols": {s: _symbols.get(s, 0) for s in KRILLION_SYMBOLS},
            "krillion_rounds": sum(_symbols.values()),
            "hundreds": int((_rounds == 100).sum()),
            "size_rounds": _rounds.len(),
        }
    return (facts,)


@app.cell(hide_code=True)
def _(facts):
    # Tags for the fact sheets. Every rule that fits gives a (priority, tag, why) and each sheet shows its top 3.
    # Feats (85-100) outrank habits (50-80), so a rare achievement always shows. Hit-rate tags compare how often,
    # not how many, so someone who plays less can still earn them; ties share the tag.
    def _best(value, eligible=lambda f: True, lowest=False):
        scores = {w: value(f) for w, f in facts.items() if eligible(f)}
        if not scores:
            return set()
        target = (min if lowest else max)(scores.values())
        return {w for w, s in scores.items() if s == target and (lowest or s > 0)}

    _champs = _best(lambda f: f["wins"])
    _bridesmaids = _best(lambda f: f["silvers"])
    _stars = _best(lambda f: f["symbols"]["🌟"] / f["krillion_rounds"], lambda f: f["krillion_rounds"] >= 35)
    _bullseyes = _best(lambda f: f["hundreds"] / f["size_rounds"], lambda f: f["size_rounds"] >= 25)
    _clowns = _best(lambda f: f["symbols"]["🤡"] / f["krillion_rounds"], lambda f: f["krillion_rounds"] >= 35)
    _top_scorers = _best(lambda f: f["avg_pct"], lambda f: f["results"] >= 5)
    _steady = _best(lambda f: f["pct_spread"], lambda f: f["pct_spread"] is not None, lowest=True) if len(facts) >= 2 else set()

    player_tags = {}
    for _w, _f in facts.items():
        _share = _f["days"] / _f["all_days"] if _f["all_days"] else 0
        _enough = _f["results"] >= 5  # habits need a few results before they mean anything
        _never_misses = _share >= 0.95 and _f["days"] >= 5
        _star_rate = _f["symbols"]["🌟"] / _f["krillion_rounds"] if _f["krillion_rounds"] else 0
        _hit_rate = _f["hundreds"] / _f["size_rounds"] if _f["size_rounds"] else 0
        _rules = [
            # Feats
            (_w in _champs, 100, "👑 Daily Champ", f"Most overall daily wins: {_f['wins']}"),
            (_w in _stars, 92, "🌟 One in a Krillion", f"🌟 on {_star_rate:.0%} of Krillion rounds, the most often ({_f['symbols']['🌟']} in all)"),
            (_w in _bullseyes, 90, "💯 Bullseye", f"100 on {_hit_rate:.0%} of Size It Up rounds, the most often ({_f['hundreds']} in all)"),
            (_never_misses, 85, "📅 Never Misses", f"Played {_share:.0%} of game days"),
            # Standing
            (_w in _top_scorers, 78, "📊 Top Scorer", f"Best average: {_f['avg_pct']:.0f}% of max per game"),
            (_w in _steady, 72, "🎯 Steady Eddie", f"Most consistent scores (± {_f['pct_spread'] or 0:.0f}% of max)"),
            (_w in _bridesmaids and _w not in _champs, 66, "🥈 Always the Bridesmaid", f"Most 2nd places: {_f['silvers']}"),
            (not _never_misses and _f["streak"] >= 5, min(80, 60 + _f["streak"]), "🔥 On a Streak", f"Played every one of the last {_f['streak']} days"),
            (_f["days"] >= 10 and _f["form_base"] > 0 and _f["form"] >= 0.1 * _f["form_base"], 62, "📈 Heating Up", f"Last 7 days {_f['form']:+.0f} points above their average"),
            # Habits
            (_enough and _f["last_minute"] >= 0.25, 60 + 20 * _f["last_minute"], "⏰ Last Minute Larry", f"{_f['last_minute']:.0%} of plays in the last hour before midnight"),
            (_enough and _f["early"] >= 0.5, 55 + 25 * _f["early"], "🐦 Early Bird", f"{_f['early']:.0%} of plays between 05:00 and 10:00"),
            (_enough and _f["night"] >= 0.5 and _f["last_minute"] < 0.25, 50 + 25 * _f["night"], "🦉 Night Owl", f"{_f['night']:.0%} of plays between 21:00 and 04:00"),
            (_w in _clowns and _f["symbols"]["🤡"] >= 2, 58, "🤡 Too Clever", f"🤡 on {_f['symbols']['🤡']} Krillion rounds, the most often"),
            (_enough and _f["speedrun"] >= 0.6, 52, "⚡ Speedrunner", f"Posts everything within 30 minutes on {_f['speedrun']:.0%} of days"),
            (_f["days"] >= 6 and _f["weekend"] >= 0.45, 50, "🛋️ Weekend Warrior", f"{_f['weekend']:.0%} of their game days are weekends"),
            (_share < 0.5, 45, "👻 Part-timer", f"Played {_share:.0%} of game days"),
        ]
        _earned = sorted(((p, t, why) for fits, p, t, why in _rules if fits), key=lambda e: e[0], reverse=True)[:3]
        player_tags[_w] = _earned or [(0, "🎮 Regular", "Here, playing, no fuss")]
    return (player_tags,)


@app.cell(hide_code=True)
def _(
    GAMES,
    INK,
    KRILLION_SYMBOLS,
    OTHER,
    RULE,
    facts,
    html,
    mo,
    player_scale,
    player_tags,
):
    # One card per player. Bars and the top edge wear the player's chart colour; text stays in table ink.
    _colors = dict(zip(player_scale.domain, player_scale.range))


    def _portion(label, done, out_of, color):
        share = done / out_of if out_of else 0
        return f"""
        <div class="pf-row"><span>{label}</span><span><b>{done}</b> / {out_of} · {share:.0%}</span></div>
        <div class="pf-bar"><div style="width:{share * 100:.1f}%;background:{color}"></div></div>"""


    def _sheet(who, f):
        color = _colors[who]
        tags = "".join(f'<span class="pf-tag" title="{html.escape(why)}">{html.escape(tag)}</span>' for _, tag, why in player_tags[who])
        games = "".join(_portion(GAMES[g], n, out_of, color) for g, (n, out_of) in f["games"].items() if out_of)
        # A tiny column chart of the symbol spread, best symbol first. Bars scale to the player's most common
        # symbol, so each card shows its own shape; the raw count sits under each bar.
        _peak = max(f["symbols"].values()) or 1
        symbols = "".join(
            f'<div class="pf-sym" title="{name} · {points} points · {f["symbols"][s]}×">'
            f'<span>{s}</span><div class="pf-col"><div style="height:{f["symbols"][s] / _peak * 100:.0f}%;background:{color}"></div></div>'
            f'<b>{f["symbols"][s]}</b></div>'
            for s, (name, points) in KRILLION_SYMBOLS.items()
        )
        size_it_up = (
            f'<div class="pf-row"><span>💯 rounds</span><span><b>{f["hundreds"]}</b> of {f["size_rounds"]} · {f["hundreds"] / f["size_rounds"]:.0%}</span></div>'
            if f["size_rounds"]
            else '<div class="pf-row pf-none">No rounds posted</div>'
        )
        krillion = f'<div class="pf-syms">{symbols}</div>' if f["krillion_rounds"] else '<div class="pf-row pf-none">No rounds posted</div>'
        return f"""
        <div class="pf-card" style="border-top-color:{color}">
          <div class="pf-name">{html.escape(who)}</div>
          <div class="pf-tags">{tags}</div>
          {_portion("Game days", f["days"], f["all_days"], color)}
          <div class="pf-games">{games}</div>
          <div class="pf-head">Size It Up</div>{size_it_up}
          <div class="pf-head">Krillion</div>{krillion}
        </div>"""


    mo.Html(
        f"""
        <style>
          .pf-grid {{ display:grid; grid-template-columns:repeat(auto-fill,minmax(250px,1fr)); gap:12px; color:{INK}; font-family:system-ui,sans-serif; }}
          .pf-card {{ border:1px solid {RULE}; border-top:4px solid; border-radius:8px; padding:12px 14px; display:flex; flex-direction:column; gap:4px; }}
          .pf-name {{ font-size:17px; font-weight:650; }}
          .pf-tags {{ display:flex; flex-wrap:wrap; gap:4px; margin:2px 0 8px; }}
          .pf-tag {{ font-size:12px; padding:2px 8px; border-radius:999px; border:1px solid {RULE}; cursor:help; white-space:nowrap; }}
          .pf-row {{ display:flex; justify-content:space-between; font-size:13px; gap:8px; }}
          .pf-row span:last-child {{ color:{OTHER}; font-variant-numeric:tabular-nums; }}
          .pf-row b {{ color:{INK}; font-weight:600; }}
          .pf-bar {{ height:4px; border-radius:2px; background:{RULE}; overflow:hidden; margin-bottom:4px; }}
          .pf-bar div {{ height:100%; border-radius:2px; }}
          .pf-games {{ padding-left:10px; border-left:2px solid {RULE}; margin:2px 0 4px; }}
          .pf-games .pf-row {{ font-size:12px; }}
          .pf-head {{ font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:{OTHER}; margin-top:6px; }}
          .pf-syms {{ display:grid; grid-template-columns:repeat(7,1fr); gap:6px; margin-top:2px; }}
          .pf-sym {{ display:flex; flex-direction:column; align-items:center; gap:3px; cursor:help; font-size:13px; }}
          .pf-col {{ width:100%; max-width:22px; height:36px; display:flex; align-items:flex-end; border-bottom:1px solid {RULE}; }}
          .pf-col div {{ width:100%; min-height:1px; border-radius:3px 3px 0 0; }}
          .pf-sym b {{ font-size:11px; font-weight:600; font-variant-numeric:tabular-nums; }}
          .pf-none {{ color:{OTHER}; }}
        </style>
        <div class="pf-grid">{"".join(_sheet(w, f) for w, f in facts.items())}</div>
        <div style="font-size:12px;color:{OTHER};margin-top:6px;font-family:system-ui,sans-serif">Hover a tag to see why. Krillion symbols run best to worst; 🌟 and 🤡 point values aren't confirmed yet.</div>
        """
    )
    return


@app.cell
def _(mo):
    mo.md("""
    ## Leaderboard
    Daily podiums in the period. Overall points are each game as a percentage of its max, summed (out of 300);
    a skipped game counts as 0, just like on the bot's board.
    """)
    return


@app.cell
def _(
    DARK,
    GAMES,
    INK,
    PALETTE,
    RULE,
    gt,
    period_placements,
    pl,
    player_scale,
):
    _overall = pl.col("category") == "overall"
    _rank = pl.col("rank")
    leaderboard = (
        period_placements.sort("day")
        .group_by("who")
        .agg(
            gold=(_overall & (_rank == 1)).sum(),
            silver=(_overall & (_rank == 2)).sum(),
            bronze=(_overall & (_rank == 3)).sum(),
            days=_overall.sum(),
            avg_rank=_rank.filter(_overall).mean(),
            avg_points=pl.col("value").filter(_overall).mean(),
            # Space-separated values: the form great_tables draws as a nanoplot.
            form=pl.col("value").filter(_overall).tail(14).round(0).cast(pl.Int64).cast(pl.String).str.join(" "),
            **{f"{game}_wins": ((pl.col("category") == game) & (_rank == 1)).sum() for game in GAMES},
        )
        .sort(["gold", "silver", "bronze", "avg_points"], descending=True)
    )

    # Each player wears their chart colour, so the table and the charts read as one.
    _colors = dict(zip(player_scale.domain, player_scale.range))
    _blue = PALETTE[0]
    _medals = ["gold", "silver", "bronze"]
    _wins = [f"{game}_wins" for game in GAMES]

    (
        gt.GT(
            leaderboard.with_columns(
                who=pl.format(
                    '<span style="color:{}">●</span>&nbsp;{}', pl.col("who").replace_strict(_colors), pl.col("who")
                )
            )
        )
        .cols_label(
            who="Player",
            gold="🥇",
            silver="🥈",
            bronze="🥉",
            days="Days",
            avg_rank="Avg rank",
            avg_points="Avg points",
            form="Last 14 days",
            **{f"{game}_wins": name for game, name in GAMES.items()},
        )
        .tab_spanner("Overall podiums", columns=_medals)
        .tab_spanner("Daily wins by game", columns=_wins)
        .fmt_markdown(columns="who")
        .fmt_number(columns="avg_rank", decimals=2)
        .fmt_number(columns="avg_points", decimals=1)
        .data_color(columns="avg_points", palette=["#1d2a3a" if DARK else "#dce9f8", _blue])
        .fmt_nanoplot(
            columns="form",
            plot_type="line",
            options=gt.nanoplot_options(
                data_line_stroke_color=_blue,
                data_point_fill_color=_blue,
                data_point_stroke_color=_blue,
                data_area_fill_color=_blue,
            ),
        )
        .cols_align("center", columns=[*_medals, "days", *_wins])
        .tab_style(gt.style.text(weight="bold"), gt.loc.body(rows=[0]))
        .tab_source_note("Avg points: each game as a % of its max, summed (out of 300). Last 14 days: overall points per day played.")
        .opt_table_font(stack="system-ui")
        .tab_options(
            table_width="100%",
            table_background_color="transparent",
            table_font_color=INK,
            table_border_top_style="hidden",
            table_border_bottom_style="hidden",
            column_labels_border_top_style="hidden",
            column_labels_border_bottom_color=RULE,
            column_labels_font_weight="600",
            table_body_hlines_color=RULE,
            table_body_border_bottom_color=RULE,
            source_notes_font_size="12px",
        )
    )
    return


@app.cell
def _(CATEGORIES, mo):
    trend_category = mo.ui.dropdown(CATEGORIES, value="Overall", label="Score")
    mo.vstack([mo.md("## Form over time"), trend_category])
    return (trend_category,)


@app.cell
def _(alt, period_placements, pl, player_scale, style, trend_category):
    _overall = trend_category.value == "overall"
    _trend = (
        period_placements.filter(pl.col("category") == trend_category.value)
        .sort("day")
        .with_columns(avg=pl.col("value").rolling_mean_by("day", window_size="7d").over("who").round(1))
    )
    _y_title = "Points of 300, 7-day average" if _overall else "Score, 7-day average"
    _nearest = alt.selection_point(nearest=True, on="pointerover", fields=["day"], empty=False)
    _base = alt.Chart(_trend).encode(x=alt.X("day:T", title=None))
    _color = alt.Color("who:N", scale=player_scale, title=None)
    _lines = _base.mark_line(strokeWidth=2, interpolate="monotone").encode(y=alt.Y("avg:Q", title=_y_title), color=_color)
    _daily = _base.mark_circle(size=24, opacity=0.25).encode(y="value:Q", color=_color)
    _hover = _base.mark_point(size=80, filled=True, strokeWidth=2, stroke="white").encode(
        y="avg:Q",
        color=_color,
        opacity=alt.condition(_nearest, alt.value(1), alt.value(0)),
        tooltip=[
            alt.Tooltip("who:N", title="Player"),
            alt.Tooltip("day:T", title="Day", format="%-d %b"),
            alt.Tooltip("value:Q", title="That day"),
            alt.Tooltip("avg:Q", title="7-day avg"),
        ],
    )
    _rule = _base.mark_rule(color="gray", opacity=0.4).transform_filter(_nearest)
    _catch = _base.mark_rule(opacity=0).add_params(_nearest)
    style(alt.layer(_daily, _lines, _rule, _hover, _catch).properties(width="container", height=320))
    return


@app.cell
def _(mo):
    mo.md("""
    ## How consistent everyone is
    Every result as a percentage of the game's max. The box is the middle half of someone's days, the line their median.
    """)
    return


@app.cell
def _(GAMES, alt, period_results, player_scale, style):
    _box = (
        alt.Chart(period_results)
        .mark_boxplot(extent="min-max", size=16, median={"color": "white", "strokeWidth": 2}, box={"cornerRadius": 4})
        .encode(
            x=alt.X("who:N", title=None, sort=player_scale.domain, axis=alt.Axis(labelAngle=-40)),
            y=alt.Y("pct:Q", title="% of max", scale=alt.Scale(domain=[0, 100])),
            color=alt.Color("who:N", scale=player_scale, legend=None),
        )
        .properties(width=220, height=260)
        .facet(column=alt.Column("game_name:N", title=None, sort=list(GAMES.values())))
    )
    style(_box)
    return


@app.cell
def _(mo):
    mo.md("""
    ## Who shows up
    Every day in the period, one box per game for each player.
    """)
    return


@app.cell
def _(
    GAMES,
    INK,
    OTHER,
    first_day,
    gt,
    last_day,
    period_results,
    picked,
    pl,
    player_scale,
    results,
):
    # One box per player, game and day. A player can post each game once a day, so a box is either ticked or not.
    # Days before a game's first result in the group get a dash instead: there was nothing to miss.
    _who = [w for w in player_scale.domain if w in picked.value]
    _started = dict(results.group_by("game").agg(pl.col("day").min()).iter_rows())
    _posted = period_results.select("day", "who", "game").with_columns(posted=pl.lit(True))
    attendance = (
        pl.DataFrame({"day": pl.date_range(first_day, last_day, eager=True)})
        .join(pl.DataFrame({"who": _who}), how="cross")
        .join(pl.DataFrame({"game": list(GAMES)}), how="cross")
        .join(_posted, on=["day", "who", "game"], how="left")
        .with_columns(
            box=pl.when(pl.col("day") < pl.col("game").replace_strict(_started, default=None))
            .then(pl.lit("–"))
            .when(pl.col("posted"))
            .then(pl.lit("☑"))
            .otherwise(pl.lit("☐")),
            column=pl.format("{}|{}", "who", "game"),
        )
        .pivot("column", index="day", values="box")
        .sort("day", descending=True)
    )

    _colors = dict(zip(player_scale.domain, player_scale.range))
    _columns = {w: [f"{w}|{g}" for g in GAMES] for w in _who}
    _table = (
        gt.GT(attendance.with_columns(pl.col("day").dt.strftime("%a %d %b")))
        .cols_label(day="", **{c: GAMES[c.split("|")[1]][0] for cs in _columns.values() for c in cs})
        .cols_align("center", columns=[c for cs in _columns.values() for c in cs])
        .tab_style(gt.style.text(color=OTHER, size="13px"), gt.loc.body(columns="day"))
        .tab_source_note(f"{' · '.join(f'{name[0]} = {name}' for name in GAMES.values())}. ☑ posted · ☐ missed · – game not in the group yet")
        .opt_table_font(stack="system-ui")
        .tab_options(
            table_width="100%",
            table_background_color="transparent",
            table_font_color=INK,
            table_border_top_style="hidden",
            table_border_bottom_style="hidden",
            column_labels_border_top_style="hidden",
            table_body_hlines_style="hidden",
            data_row_padding="2px",
            container_height="460px",
            container_overflow_y="auto",
            source_notes_font_size="12px",
        )
    )
    for _w, _cs in _columns.items():
        _table = _table.tab_spanner(_w, columns=_cs).tab_style(
            gt.style.text(color=_colors[_w], size="17px"), gt.loc.body(columns=_cs)
        )
    _table
    return


@app.cell(hide_code=True)
def _(mo):
    mo.md("""
    ## Play patterns
    When everyone posts each game, by hour in Helsinki time. Darker means a bigger share of that player's plays of that game.
    """)
    return


@app.cell(hide_code=True)
def _(GAMES, alt, period_results, pl, player_scale, style):
    # Each row is one player's plays of one game, split by local hour; shares make occasional players comparable.
    _hours = (
        period_results.group_by("who", "game_name", "hour")
        .len(name="plays")
        .with_columns(share=(pl.col("plays") / pl.col("plays").sum().over("who", "game_name") * 100).round(0))
        .with_columns(slot=pl.format("{}:00–{}:00", pl.col("hour").cast(pl.String).str.zfill(2), ((pl.col("hour") + 1) % 24).cast(pl.String).str.zfill(2)))
    )
    _patterns = (
        alt.Chart(_hours)
        .mark_rect(cornerRadius=2)
        .encode(
            x=alt.X(
                "hour:O",
                title=None,
                scale=alt.Scale(domain=list(range(24)), paddingInner=0.12),
                axis=alt.Axis(labelAngle=0, labelExpr="datum.value % 6 == 0 ? datum.value + ':00' : ''", ticks=False),
            ),
            y=alt.Y("game_name:N", title=None, sort=list(GAMES.values()), scale=alt.Scale(paddingInner=0.12)),
            color=alt.Color("share:Q", title="% of their plays", scale=alt.Scale(scheme="blues", domain=[0, 50], clamp=True)),
            tooltip=[
                alt.Tooltip("who:N", title="Player"),
                alt.Tooltip("game_name:N", title="Game"),
                alt.Tooltip("slot:N", title="Time"),
                alt.Tooltip("plays:Q", title="Plays"),
                alt.Tooltip("share:Q", title="% of their plays", format=".0f"),
            ],
        )
        .properties(width=alt.Step(13), height=alt.Step(20))
        .facet(facet=alt.Facet("who:N", title=None, sort=player_scale.domain, header=alt.Header(labelFontWeight="bold", labelAnchor="start")), columns=2)
    )
    style(_patterns)
    return


@app.cell
def _(mo):
    mo.md("""
    ## All results
    """)
    return


@app.cell
def _(mo, period_results, pl):
    mo.ui.table(
        period_results.sort(["day", "game", "score"], descending=[True, False, True]).select(
            pl.col("day").alias("Day"),
            pl.col("who").alias("Player"),
            pl.col("game_name").alias("Game"),
            pl.col("puzzle").alias("Puzzle"),
            pl.col("score").alias("Score"),
            pl.col("max_score").alias("Max"),
        ),
        selection=None,
        page_size=15,
    )
    return


if __name__ == "__main__":
    app.run()
