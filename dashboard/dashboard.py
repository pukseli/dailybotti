import marimo

__generated_with = "0.25.2"
app = marimo.App(width="medium", app_title="Daily games stats")


@app.cell
def _():
    from datetime import timedelta

    import altair as alt
    import great_tables as gt
    import marimo as mo
    import polars as pl

    return alt, gt, mo, pl, timedelta


@app.cell
def _(mo):
    # Mirrors src/games.ts, in the order the bot lists games.
    GAMES = {"eraly": "Eraly", "krillion": "Krillion", "sizeitup": "Size It Up"}
    CATEGORIES = {"Overall": "overall", **{name: game for game, name in GAMES.items()}}

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

    return CATEGORIES, DARK, GAMES, INK, OTHER, PALETTE, RULE, style


@app.cell
def _(GAMES, OTHER, PALETTE, alt, mo, pl):
    # Written by snapshot.py (real data) or sample_data.py (made up). Read over HTTP when exported to WASM.
    _data = mo.notebook_location() / "public"
    meta = pl.read_csv(str(_data / "meta.csv")).row(0, named=True)
    _results = pl.read_csv(str(_data / "results.csv"), try_parse_dates=True)
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
    results = _results.join(_who, on="player").with_columns(game_name=_game_names, pct=pl.col("score") / pl.col("max_score") * 100)
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
