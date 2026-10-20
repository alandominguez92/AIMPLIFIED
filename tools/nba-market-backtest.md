# NBA PrizePicks markets: which under to aim for (backtest, 2026-10-19)

Every PrizePicks NBA market's under, replayed over the **2024-25 and 2025-26
regular seasons** (1,231 + 1,231 games, ESPN box scores, free, zero Odds API
credits). The script is `tools/nba-market-backtest.mjs`.

```
node tools/nba-market-backtest.mjs fetch <cacheDir>          # ~2,500 ESPN requests, 22 MB cached
node tools/nba-market-backtest.mjs report <cacheDir> [out.json]
```

**Method.** For every player-game, the line is the player's average over his
previous 10 games this season, rounded to the nearest .5. Only games he played
count toward the 10, a game he did not play is no sample (PrizePicks voids
it), and no line below 0.5 is used. The under wins if the actual is below the
line, and pushes on whole-number lines are left out of the rate. "Rotation"
means 20+ projected minutes, where projected minutes is the last-10 average.
The box scores are read with the cron's own parser (`nbaBoxRows`, taken from
worker.js), so every stat here means what it means in `nba_box`.

The line is a stand-in for PrizePicks' number, not the number itself. The last
column of the main table is a second, harder stand-in: the **median** of the
same 10 games. Counting stats are skewed. A few big nights pull the average
above a player's typical night, so an under against the average wins more than
half the time without the line knowing anything. Books set lines nearer the
typical night, and PrizePicks follows the books, so the median line is closer
to what PrizePicks will actually post.

## By market (rotation players)

Break-evens: 5/6-flex 54.2%, 2-pick power 57.7%, 3-flex 59.1%. A market
"clears" one only if the bottom of its 95% interval is at or above it.

| market | games | under | 95% CI | .5 lines only | 2024-25 | 2025-26 | clears | **at the median line** |
| --- | ---: | ---: | --- | ---: | ---: | ---: | --- | ---: |
| Blocks | 17,367 | 66.3% | 65.5–67.0 | 65.3% | 65.9% | 66.5% | all three | **62.8%** |
| Offensive rebounds | 22,621 | 60.3% | 59.6–60.9 | 58.8% | 60.6% | 60.0% | all three | **56.4%** |
| Free throws made | 24,394 | 59.9% | 59.2–60.5 | 59.3% | 59.9% | 59.8% | all three | 53.8% |
| Steals | 22,390 | 59.3% | 58.7–60.0 | 56.7% | 59.1% | 59.6% | flex, power | **57.9%** |
| Free throws attempted* | 24,853 | 58.3% | 57.7–58.9 | 58.3% | 58.5% | 58.1% | flex, power | 53.3% |
| Blks+Stls | 23,178 | 57.6% | 56.9–58.2 | 57.2% | 57.3% | 57.8% | 5/6-flex | 53.3% |
| 3-PT made | 21,509 | 57.3% | 56.6–57.9 | 57.2% | 56.7% | 57.8% | 5/6-flex | 52.6% |
| Turnovers | 22,943 | 56.2% | 55.5–56.8 | 55.5% | 56.4% | 56.0% | 5/6-flex | 52.5% |
| Assists | 24,409 | 55.2% | 54.5–55.8 | 55.0% | 54.7% | 55.6% | 5/6-flex | 50.9% |
| Defensive rebounds | 24,711 | 54.7% | 54.1–55.3 | 55.0% | 54.8% | 54.6% | – | 50.9% |
| Rebounds | 25,006 | 54.6% | 54.0–55.3 | 53.5% | 54.7% | 54.6% | – | 51.3% |
| 3-PT attempted | 23,150 | 54.2% | 53.6–54.9 | 54.2% | 53.6% | 54.8% | – | 51.2% |
| Rebs+Asts | 25,684 | 53.6% | 53.0–54.2 | 52.7% | 53.4% | 53.8% | – | 51.1% |
| FG made | 25,125 | 53.5% | 52.9–54.1 | 53.1% | 53.1% | 53.8% | – | 51.0% |
| Points | 26,355 | 53.3% | 52.7–53.9 | 53.4% | 53.1% | 53.4% | – | 51.1% |
| Pts+Rebs | 26,553 | 53.2% | 52.6–53.8 | 53.1% | 53.3% | 53.1% | – | 51.5% |
| Pts+Asts | 26,489 | 52.9% | 52.3–53.5 | 52.3% | 52.7% | 53.0% | – | 51.1% |
| Fantasy Score* | 27,142 | 52.9% | 52.3–53.5 | 53.2% | 52.8% | 53.1% | – | 51.7% |
| Pts+Rebs+Asts | 26,559 | 52.6% | 52.0–53.2 | 52.3% | 52.5% | 52.7% | – | 51.5% |
| FG attempted (shots) | 25,775 | 52.5% | 51.9–53.2 | 52.7% | 52.2% | 52.9% | – | 51.1% |

\* Not on the requested list. Added because the Odds API carries both
(`player_frees_attempts`, `player_fantasy_points`). Fantasy Score uses
PrizePicks' scoring: points 1, rebounds 1.2, assists 1.5, blocks 3, steals 3,
turnovers −1.

The two seasons agree within about a point on every market, so the ranking is
not one season's accident.

## By line level (rotation, under rate, games in brackets)

```
Blocks              0.5: 65.2% (12097) · 1: 69.5% (2958) · 1.5: 66.6% (1620) · 2+: 70.5% (692)
Offensive rebounds  0.5: 55.8% (8581) · 1-1.5: 63.3% (8858) · 2-2.5: 61.3% (3178) · 3+: 64.5% (2004)
Free throws made    0.5: 61.6% (3608) · 1-1.5: 57.7% (8086) · 2-2.5: 61.4% (5239) · 3-4.5: 59.4% (4957) · 5+: 61.7% (2504)
Steals              0.5: 50.9% (8975) · 1: 62.0% (7333) · 1.5: 66.7% (4773) · 2+: 75.5% (1309)
FT attempted        <2: 56.2% (8967) · 2-2.5: 59.1% (5506) · 3-3.5: 59.7% (3788) · 4-5.5: 58.6% (4041) · 6+: 61.6% (2551)
Blks+Stls           0.5: 44.1% (2979) · 1-1.5: 56.1% (12736) · 2-2.5: 64.1% (6307) · 3+: 72.1% (1156)
3-PT made           0.5: 54.2% (2432) · 1-1.5: 54.0% (8613) · 2-2.5: 59.0% (7154) · 3-3.5: 62.7% (2650) · 4+: 70.8% (660)
Turnovers           0.5: 45.8% (3240) · 1-1.5: 55.9% (10777) · 2-2.5: 58.9% (5985) · 3-3.5: 61.7% (2337) · 4+: 68.2% (604)
Assists             <2: 48.7% (5989) · 2-3.5: 57.0% (10009) · 4-5.5: 56.6% (5121) · 6-7.5: 58.9% (2335) · 8-9.5: 58.3% (700) · 10+: 63.5% (255)
Defensive rebounds  <3: 49.3% (7646) · 3-4.5: 56.1% (10777) · 5-6.5: 59.0% (4187) · 7-8.5: 58.1% (1560) · 9+: 61.2% (541)
Rebounds            <4: 49.7% (8652) · 4-5.5: 56.9% (8512) · 6-7.5: 57.5% (4175) · 8-9.5: 57.9% (2056) · 10-11.5: 55.0% (1057) · 12+: 62.8% (554)
3-PT attempted      <3: 51.8% (3621) · 3-4.5: 52.0% (8099) · 5-6.5: 55.0% (7169) · 7-8.5: 58.3% (3075) · 9+: 61.6% (1186)
Rebs+Asts           <5: 47.6% (2992) · 5-7.5: 52.2% (9457) · 8-10.5: 55.3% (7658) · 11-13.5: 55.6% (3661) · 14-16.5: 57.7% (1430) · 17+: 63.2% (486)
FG made             <3: 47.1% (2525) · 3-4.5: 51.9% (9737) · 5-6.5: 54.5% (7077) · 7-8.5: 55.8% (3936) · 9+: 61.3% (1850)
Points              <10: 49.4% (6630) · 10-14.5: 53.6% (9314) · 15-19.5: 54.2% (5384) · 20-24.5: 55.4% (3090) · 25-29.5: 57.3% (1474) · 30+: 64.4% (463)
Pts+Rebs            <12: 49.3% (3446) · 12-17.5: 51.8% (9239) · 18-23.5: 54.3% (7034) · 24-29.5: 55.1% (4214) · 30-35.5: 56.4% (1904) · 36+: 59.1% (716)
Pts+Asts            <12: 49.4% (6191) · 12-17.5: 53.3% (9541) · 18-23.5: 53.8% (5329) · 24-29.5: 54.1% (3232) · 30-35.5: 54.5% (1599) · 36+: 62.6% (597)
Fantasy Score       <15: 44.5% (948) · 15-19.5: 49.3% (4488) · 20-24.5: 52.1% (6070) · 25-29.5: 54.5% (5145) · 30-39.5: 53.8% (6851) · 40-49.5: 56.7% (2887) · 50+: 58.3% (753)
Pts+Rebs+Asts       <15: 48.9% (4530) · 15-21.5: 51.9% (9619) · 22-29.5: 53.9% (7056) · 30-37.5: 54.3% (3738) · 38-44.5: 56.6% (1272) · 45+: 60.5% (344)
FG attempted        <8: 49.2% (6464) · 8-10.5: 52.8% (7690) · 11-13.5: 52.8% (5056) · 14-16.5: 54.8% (3376) · 17-19.5: 54.4% (2227) · 20+: 59.5% (962)
```

The under gets better as the line goes up, in every market. Part of that is
real: high lines belong to high-usage players and starters. Part of it is a
last-10 average regressing toward a player's true level after a hot stretch,
and a book's line, built from more than 10 games, already prices that. So the
high-line rows say less about PrizePicks than they appear to. The low-line
rows are the useful warning. Under 0.5 steals, 0.5 blks+stls, 0.5 turnovers
and the lowest points/PRA lines are at or below 50%. The leg is "he does
nothing at all", and that is rarer than the average suggests.

## By projected minutes (everyone, under rate)

```
                    <20      20-25    25-30    30-35    35+
Blocks              69.4%    68.5%    66.3%    65.5%    63.2%
Offensive rebounds  62.0%    60.9%    59.8%    59.5%    62.2%
Free throws made    68.5%    62.8%    60.0%    57.6%    58.0%
Steals              64.9%    60.2%    59.4%    58.5%    59.1%
FT attempted        66.0%    60.1%    58.6%    56.7%    57.4%
Blks+Stls           59.6%    58.0%    57.2%    57.1%    58.4%
3-PT made           60.7%    57.4%    57.2%    56.9%    57.8%
Turnovers           61.8%    57.5%    56.3%    55.0%    55.5%
Assists             57.2%    56.2%    54.6%    54.7%    55.3%
Defensive rebounds  55.0%    54.5%    54.3%    55.5%    54.1%
Rebounds            53.9%    54.2%    54.4%    55.1%    55.1%
3-PT attempted      54.0%    52.5%    54.8%    54.6%    55.9%
Rebs+Asts           52.5%    53.0%    53.6%    53.7%    54.9%
FG made             53.6%    52.9%    52.6%    54.3%    55.3%
Points              53.0%    52.9%    52.6%    53.4%    55.8%
Pts+Rebs            51.8%    52.3%    52.3%    53.9%    56.1%
Pts+Asts            52.1%    52.7%    52.1%    53.2%    55.0%
Fantasy Score       51.0%    51.7%    52.4%    53.8%    55.7%
Pts+Rebs+Asts       51.3%    51.7%    51.6%    53.5%    55.5%
FG attempted        51.2%    51.0%    52.2%    53.3%    55.5%
```

Bench players (under 20 minutes) show the best unders on the low-count
markets. They are also the ones who do not play, and this table only counts
games they did play. The card's 20-minute floor stays.

## What it says

1. **Blocks, steals and offensive rebounds are the only markets that hold up
   against the median line** (62.8%, 57.9%, 56.4%). Everything else falls to
   51–54% there. If PrizePicks posts near the typical night, points, every
   points combo, FG made/attempted, 3-PT attempted, Fantasy Score and
   defensive rebounds have nothing.
2. **Assists and rebounds, two of the three already logged, drop to ~51% at
   the median line.** The Oct 6 choice rested on the average-line test, and
   the median test says most of that was skew. Threes keeps a little (52.6%).
   Their real-line record from opening night will settle it.
3. **Free throws made looks strong against the average (59.9%) but most of it
   is skew (53.8% at the median).**
4. **Points-based markets clear no break-even on either test.**
5. This is the same lesson as MLB's real-line record (legs below 65% hit about
   50% at PrizePicks' lines): a gap against a simple average is mostly the
   shape of the stat, not information. Only PrizePicks' real lines can show
   which markets keep an edge, which is what logging buys.

**Against the earlier figures.** The comments in worker.js quote 55.5 / 53.4 /
53.3 / 51.6 / 51.2% for threes / assists / rebounds / points / PRA. This run
gets 57.3 / 55.2 / 54.6 / 53.3 / 52.6%: higher, in the same order, by 1.3–1.8
points each. The earlier script was not saved. Eight other definitions were
tried (actual instead of projected minutes, pushes counted as losses, x.5-only
lines, a minimum of 5 earlier games, history carried across seasons, DNPs as
zeros, and so on), and none reproduces all five. The ordering and the
conclusions do not depend on which one is right.

## What can be logged, and what it costs

The Odds API bills an event-odds call as markets returned × regions. The NBA
capture asks for PrizePicks, DraftKings and FanDuel in one call, which counts
as one region. Each market therefore costs about 1 credit per game, once,
inside 4 hours of tip. A season is about 1,230 games.

| | per game | per season |
| --- | ---: | ---: |
| logged now: threes, assists, rebounds | 3 | ≈ 3,700 |
| + blocks, steals | +2 | ≈ +2,460 |
| + free throws made, blks+stls | +2 | ≈ +2,460 |
| every requested market the API carries (14 keys) | 14 | ≈ 17,200 |

95,944 credits were left on Oct 15.

**Not in the Odds API at any price:** offensive rebounds, defensive rebounds,
3-PT attempted, FG attempted (shots taken). The API's NBA keys are points,
rebounds, assists, threes, blocks, steals, blocks+steals, turnovers, PRA,
pts+rebs, pts+asts, rebs+asts, field goals, free throws made/attempted and
fantasy points. Offensive rebounds (60.3% / 56.4%) could only be logged by
typing PrizePicks' line in by hand, as the soccer card does.

## Recommendation (for the user to approve)

- **Pay to log blocks and steals:** +2 credits a game, ≈ 2,460 for the season,
  or ≈ 300 for a three-week trial (about 150 games at ~7 a night). These are
  the only markets that keep a margin at the stricter line. A few hundred to
  ~1,000 rotation legs each should be enough to tell a 62% market from a 54% one.
- **Optional, +2 more a game:** free throws made and blks+stls. Both are strong
  against the average and modest against the median. Worth it only if the
  extra data is wanted.
- **Do not pay for:** points, PRA, pts+rebs, pts+asts, rebs+asts, FG made,
  turnovers, Fantasy Score, FT attempted.
- **Review assists and rebounds after ~3 weeks of real lines.** If they grade
  near 50% at PrizePicks' numbers, dropping them saves 2 credits a game, the
  cost of blocks and steals.
- **Free option:** hand-enter PrizePicks' offensive-rebounds lines from the
  phone, the way soccer lines are entered.

**Approved 2026-10-20 and logged from opening night:** blocks and steals
(+2 credits a game). They stay off Picks of the day until they have a graded
record of their own.

## Dispersions for blocks and steals (2026-10-20)

```
node tools/nba-market-backtest.mjs disp <cacheDir>
```

The card's own projection, replayed over 2025-26 with 2024-25 as the prior:
each player's last ten games this season blended with his 2024-25 per-game
average as `NBA_PRIOR_K` = 5 games (the average only if he played 5+ games),
rotation players only (20+ minutes projected the same way), 15,857
player-games. The dispersion is the negative binomial's variance ÷ mean, and
the fit is the one that makes what the players then did likeliest.

| | best fit | in worker.js |
| --- | ---: | ---: |
| threes | 1.25 | 1.15 |
| assists | 1.3 | 1.25 |
| rebounds | 1.35 | 1.2 |
| **blocks** | **1.15** | **1.15** |
| **steals** | **1.1** | **1.1** |

The first three reproduce the 2026-10-09 fit (1.25, 1.3, 1.4), which kept
the starting values because a refit moved no leg by more than 1.2 points. So
this is the same method, and blocks and steals take their best fit.

Calibration at those values, claimed against landed, at every .5 line the
model put at 50%+:

```
blocks 1.15  50-55: 52.5 vs 54.5 · 55-60: 57.5 vs 56.9 · 60-65: 62.6 vs 65.5 · 65-70: 67.7 vs 69.4 · 70-75: 72.4 vs 74.3
             75-80: 77.4 vs 76.9 · 80-85: 82.6 vs 81.7 · 85-90: 87.6 vs 86.7 · 90+: 94.1 vs 93.7
steals 1.1   50-55: 52.5 vs 52.4 · 55-60: 57.5 vs 56.5 · 60-65: 62.5 vs 61.4 · 65-70: 67.5 vs 66.5 · 70-75: 72.6 vs 74.0
             75-80: 77.5 vs 77.4 · 80-85: 82.6 vs 81.6 · 85-90: 87.6 vs 87.2 · 90+: 94.1 vs 93.9
```

At the median-of-ten line the high bands run hot (steals at 70-75% landed
65%; blocks at 85-90% landed 81%). Threes, assists and rebounds do the same
there, at every dispersion tried. That is the line carrying information of its
own, not the dispersion being wrong, and the log's bands at PrizePicks' real
lines are what will show whether it holds.

The priors file now carries blocks and steals per game from ESPN's season
totals, to two decimals (`tools/build-nba-priors.py`). ESPN's own average is
rounded to one, which is a sixth of a 0.3-a-game player's rate. The rebuild on
2026-10-20 changed no other stat; it moved three players to new teams and left
42 cut players with no team.

Adding a market to the log is more than a config line. It needs
`NBA_PP_MARKETS` (`player_blocks` → `blk`, `player_steals` → `stl`), blocks and
steals in `nba-priors.json` (the builder reads only threes, assists and
rebounds today), a dispersion for each in `NBA_DISP` fitted from this data, and
the card's labels in app.js. Grading is already done: `nba_box` keeps every
stat from opening night, and `gradeNbaPp` and the entries grader read any of
these markets through `nbaStat`.
