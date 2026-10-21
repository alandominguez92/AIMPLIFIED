# NHL PrizePicks markets: which under to aim for (backtest, 2026-10-20)

Every NHL market the box score carries, replayed over the **2024-25 and
2025-26 regular seasons** (1,312 + 1,312 games from `api-web.nhle.com`, free,
no key, zero Odds API credits), before any hockey prop is logged. The script
is `tools/nhl-market-backtest.mjs`.

```
node tools/nhl-market-backtest.mjs fetch <cacheDir>          # ~3,000 requests, ~5 min, 22 MB cached
node tools/nhl-market-backtest.mjs report <cacheDir> [out.json]
```

`fetch` lists each day's games from `/v1/score/YYYY-MM-DD`, the endpoint the
NHL moneyline grader already reads, and keeps the finished regular-season games
(`gameType` 2, `OFF`/`FINAL`). It then reads `/v1/gamecenter/{id}/boxscore`
for each one. Every game was read: none came back empty, every skater's points
equal his goals plus assists, and every team-game has exactly one starting
goalie.

## Method

A sample is one player-game, scored against lines built from the player's
previous 10 games that season. Skaters count only games they skated in.
Goalies count only their starts, and a goalie who is pulled still counts.
Players whose last-10 average is under 0.25 are left out, as the NBA run left
out lines below 0.5.

The lines are .5 lines, which is where hockey props are posted (shots 2.5,
points 0.5, saves 26.5). The NBA tool rounded to the nearest .5 and dropped
pushes. On counts this small that creates a different bet: "shots 2" becomes
"0–1 against 3+". Its numbers are in the last column for comparison only.

- **Average line:** the .5 line nearest the last-10 average. A whole-number
  average sits between two lines, so each gets half the weight.
- **Median line:** the .5 line that splits the last ten closest to five and
  five. This is the typical night, which is where books set a number. Equal
  splits share the weight.
- **Season-median line:** the same, but over every earlier game that season.
  It is a slower line, so a hot last ten cannot hand the under a free win.
- Time on ice is posted in quarter-minutes (25.25 = 25:15). It uses the
  average and the median of ten, rounded to the nearest .25.
- **"Last 10 said":** the share of the last ten that fell under the median
  line, the rate the line itself implies. If the under lands more often than
  that, the recent games were running hot.

**Regular skater = 15+ minutes of average TOI over the last 10 games.** That
keeps 9.7 skaters per team-game: 54% of forward games and 87% of defence games,
roughly the top six or seven forwards and every regular defenceman. The Oct 14
probe found DraftKings quoting about 6.5 players per team-game and FanDuel 4.5,
so 15 minutes is a little wider than a book's board. 18 minutes (5.8 per
team-game: 25% of forwards, 67% of defencemen) matches DraftKings. The sweep
below shows that the conclusions are the same at either floor. Goalies are
starters only.

Break-evens: 5/6-flex 54.2%, 2-pick power 57.7%, 3-flex 59.1%. A market
"clears" one only if the bottom of its 95% interval is at or above it. The
intervals treat player-games as independent. They are not (the same players
recur), so the real intervals are wider.

## By market (regular skaters, starting goalies)

| market | samples | avg line | **median line** | 95% CI | last 10 said | clears (median) | season-median line | NBA rounding avg / median |
| --- | ---: | ---: | ---: | --- | ---: | --- | ---: | ---: |
| Goals | 17,277 | 73.0% | **73.1%** | 72.5–73.8 | 63.9% | all three | 72.9% | 73.8% / 75.0% |
| Assists | 31,376 | 67.6% | **67.4%** | 66.8–67.9 | 60.7% | all three | 66.6% | 69.4% / 69.2% |
| Points | 40,344 | 60.9% | **59.5%** | 59.0–59.9 | 55.7% | flex, power | 57.8% | 63.9% / 63.0% |
| Hits | 44,341 | 59.8% | **56.7%** | 56.2–57.2 | 54.1% | 5/6-flex | 55.8% | 61.8% / 57.1% |
| Blocked shots | 46,242 | 58.7% | **56.0%** | 55.5–56.4 | 53.6% | 5/6-flex | 55.5% | 60.8% / 57.1% |
| Time on ice | 50,735 | 51.4% | **51.7%** | 51.3–52.1 | 49.9% | – | 48.8% | – |
| Shots on goal | 50,803 | 55.8% | **51.6%** | 51.2–52.1 | 50.8% | – | 50.9% | 56.5% / 52.0% |
| Goalie saves | 3,680 | 51.2% | **51.1%** | 49.5–52.7 | 49.9% | – | 53.0% | 51.4% / 51.4% |
| Goals against | 3,680 | 51.8% | **50.3%** | 48.7–51.9 | 50.0% | – | 48.8% | 52.0% / 50.0% |

The two seasons agree within 1.5 points on every market and both lines, so the
ranking is not one season's accident.

**Goals, assists and points are not line-choice markets.** For almost every
player the median line is 0.5, so the under means "held off the sheet". What
decides it is the player's scoring rate, not where a line was set. The table
below shows under 0.5 by the player's per-game rate over his earlier games that
season. The figure in brackets is how often those earlier games had been
scoreless.

```
Goals    <0.15: 91.6% (93.7) · 0.15-0.25: 80.9% (81.9) · 0.25-0.35: 75.4% (74.0) · 0.35-0.5: 69.8% (65.8) · 0.5+: 64.0% (54.5)
Assists  <0.25: 80.6% (84.8) · 0.25-0.4:  72.8% (72.5) · 0.4-0.55:  65.1% (62.2) · 0.55-0.7: 57.6% (53.4) · 0.7+: 48.9% (42.1)
Points   <0.4:  75.1% (77.6) · 0.4-0.6:   60.9% (60.8) · 0.6-0.8:   50.6% (49.0) · 0.8-1.0: 43.4% (39.8) · 1.0+: 34.3% (28.9)
```

Points under 0.5 runs 66.8% for defencemen and 51.5% for forwards whose median
line is 0.5. No line exists below 0.5, so a book prices these through the odds
(anytime goal at +150 to +250). PrizePicks pays a fixed multiplier. So the
question is whether PrizePicks offers the Less side at 0.5 for players whose
rate makes it a 60%+ leg. A box score cannot answer that; one look at
PrizePicks' board can.

## By TOI floor (median line)

```
                0+       12+      15+      18+      21+
Shots on goal   51.4%    51.5%    51.6%    51.6%    51.6%
Hits            55.5%    56.0%    56.7%    57.2%    58.4%
Blocked shots   57.4%    56.6%    56.0%    54.8%    53.2%
Points          62.5%    61.5%    59.5%    58.5%    59.6%
Assists         69.6%    69.1%    67.4%    64.8%    63.8%
Goals           74.8%    74.5%    73.1%    71.1%    72.5%
Time on ice     49.9%    50.7%    51.7%    52.9%    54.7%
```

Raising the floor from 0 to 21 minutes leaves shots on goal flat. Hits gain
about 3 points. Blocks lose 4, because big-minute defencemen block on most
nights. Points and assists lose 3–6, because low-minute players are rarely on
the sheet. No market changes verdict between 15 and 18 minutes.

## By line level and position (median line, regular)

```
Shots on goal   0.5: 36.4% · 1.5: 52.0% · 2.5: 59.4% · 3.5: 68.2% · 4.5+: 76.2%
Blocked shots   F 0.5: 58.6% (21,890) · F 1.5: 81.4% (1,569)
                D 0.5: 32.9% (6,921)  · D 1.5: 56.3% (12,409) · D 2.5: 71.1% (3,114) · D 3.5+: 81.6% (284)
Hits            0.5: 53.3% · 1.5: 60.9% · 2.5: 64.6% · 3.5: 68.3% · 4.5+: 68.8%
Goalie saves    <21: 32.2% · 21-23.5: 42.4% · 24-26.5: 55.0% · 27-29.5: 69.0% · 30+: 73.9%
Time on ice     F 20-23: 58.7% (4,874) · D 23+: 55.8% (5,079)
```

Every market does the NBA thing: unders win at high lines and lose at low ones.
Most of that is a recent run regressing. At the season-median line the
high-line rows shrink (shots 3.5: 68.2% → 61.4%; hits 3.5: 68.3% → 60.9%), and
a book that projects from more than ten games already prices what is left.
Saves are the exception: at the season-median line, 27–29.5 still lands 66.5%
while the season itself said 50%. That is the start of a saves model (shot
volume regressing to the league), not a recent-form edge.

Blocked shots split by position. Forwards (60.2% at the median line) carry the
market. Defencemen, the players a blocked-shots board mostly lists, land 51.5%
overall and 56.3% at 1.5.

## What it says

1. **Shots on goal, saves, goals against and time on ice have nothing at a
   typical-night line** (50–52%), at every TOI floor and in both seasons.
   Shots look like 55.8% against the average, but that gap is skew, the same
   pattern the NBA run found in points.
2. **Hits (56.7%) and blocked shots (56.0%) keep a small margin.** It clears
   only the 5/6-flex break-even, about where NBA offensive rebounds landed
   (56.4%) and below NBA steals (57.9%) and blocks (62.8%). Hits cannot be
   logged through the Odds API.
3. **Goals, assists and points unders are mostly the scoring rate.** They land
   73% / 67% / 60% for regulars, and 67% for defencemen on points. They are
   worth something only where PrizePicks offers Less at 0.5 on a standard
   payout. That is a fact about PrizePicks' board, not about hockey.
4. Nothing here is PrizePicks' number. MLB's lesson stands: legs below 65%
   at PrizePicks' real lines hit about 50%.

## What the Odds API carries for `icehockey_nhl`

These are the documented NHL player-prop keys (the-odds-api.com betting-markets
page, read 2026-10-20, no credits spent):

| key | in this backtest | note |
| --- | --- | --- |
| `player_shots_on_goal` | shots on goal | |
| `player_points` | points | |
| `player_goals` | goals | |
| `player_assists` | assists | |
| `player_blocked_shots` | blocked shots | |
| `player_total_saves` | goalie saves | |
| `player_power_play_points` | – | the box score has power-play goals only; it needs play-by-play |
| `player_faceoffs_won` | – | DFS books only; the box score has a percentage, not a count |
| `player_time_on_ice` | time on ice | DFS books only (PrizePicks posts about one forward and one defenceman per team) |
| `player_goal_scorer_first` / `_last` / `_anytime` | – | yes/no markets, no under |

Each also has an `_alternate` key, except the goal-scorer markets.
**No key at any price:** hits and goals against. Those could only be logged
by typing PrizePicks' line in by hand, the way the soccer card works. Hockey
Fantasy Score is not modelled: PrizePicks' current scoring table couldn't be
confirmed, and it needs shorthanded points that the box score lacks.

**Cost.** An event-odds call bills about 1 credit per market returned for each
region. PrizePicks, DraftKings and FanDuel in one `bookmakers=` list count as
one region, the same shape as the NBA capture. So each market costs about 1
credit per game, captured once near puck drop. Oct 14 showed that PrizePicks
posts little until game day, so the capture needs to be late (inside about 2
hours). 140 games had been played by Oct 19, which leaves about **1,170 this
season**, around 7 a night on average (about 150 in three weeks).

## Recommendation (for the user to approve)

Don't log shots on goal, saves, goals against or time on ice: at a book-like
line they land 50–52%, the same verdict NBA points got. The only markets worth
paying to watch are **points, assists and blocked shots**, and points/assists
only for one reason: their 0.5 unders land 60–67% for regulars (defencemen 67%
on points), which pays at PrizePicks only if it offers the Less side at 0.5.
So the first step is a **one-slate probe, about 8 credits**. It should run
within 2 hours of puck drop, on two games, with `player_points`,
`player_assists`, `player_goals` and `player_blocked_shots` at PrizePicks,
DraftKings and FanDuel (4 credits a game). It shows which of those PrizePicks
posts with an Under, and for whom. If points/assists unders are on offer for
defencemen and depth forwards, **log points + assists + blocked shots at 3
credits a game: about 450 for a three-week trial, about 3,500 for the rest of
the season.** Keep them logged-only, as NBA blocks and steals are, until each
has a graded record at PrizePicks' own numbers. If PrizePicks offers Less on
goals at 0.5, add it for +1 a game (73% here). If the probe shows no 0.5 unders,
log blocked shots alone at 1 credit a game (about 150 for three weeks, 1,170
for the season), or nothing. About 92,900 credits were left on Oct 20.
