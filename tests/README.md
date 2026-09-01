# Checks

Run with `node tests/<file>`. Each exits non-zero on failure and prints what it
checked, so they read as documentation of rules that are otherwise invisible in
the code.

Every one of these was verified to FAIL when its rule is broken, not merely to
pass on the current tree. A check that has never failed is decoration.

| file | guards |
| --- | --- |
| `tokenguard.mjs` | Two-theme token contract: no dark-only or light-only token, no light value identical to its dark one, typography declared once, no font stack re-inlined, no `var()` pointing at an undeclared token. A token added to dark and forgotten in light paints a dark colour onto a white page and nothing errors. |
| `intervalguard.mjs` | `.interval-cell` is hidden ONLY on the batter board. It is the model number on five other boards — Win Prob, the 80% interval, Cover %, the NFL projection median — and one unscoped `display:none` in the ≤900px block deleted all of them. Nothing errored; the number was just gone, and only on a phone. |
| `nflpriorsguard.mjs` | The priors page's colour posture — `--positive` nowhere, `--danger` only on the unrostered flag — and the ARI/AZ normalisation. nflverse writes Arizona as ARI in 2025 play-by-play, AZ in 2026 rosters, and ARI in the schedule; untreated, 8 players read as transfers who never moved and **10** fail a join on team code. The guard asserts the drop count EXCEEDS the rename count, because counting only renames understates it by two. |
| `crontest.mjs` | The close-capture cron fetches only the games inside the close window, not the whole slate. Measured 22 per-event fetches unscoped against 2 scoped. Also asserts `CLOSE_WINDOW_MIN` stays 15 — narrowing it costs sharp-sourced closes, which is what put 13.5% of rows on a different tier at close than at entry. |
| `pulledtest.mjs` | The pulled-row contract: a batter priced by books but left off the posted lineup card still reaches the board, carries nothing conditioned on tonight, keeps his season percentiles, and can reach neither the log nor a play tier. Needs a HEALTHY props feed — seeding from the card makes everyone on-card by construction and the test passes vacuously. |
| `trackrecord.mjs` | `/api/track-record` internal consistency: the headline, the interval, the tier table and the era table are slices of one population and must sum to it. Runs against live D1. |

## outageserver.mjs

Serves the board locally with the real `worker.js`, StatsAPI live, and the Odds
API stubbed. While the quota is out this is the only way to see the board at all,
and the only way to see its NORMAL state ever.

```
node outageserver.mjs                    # outage: odds 401, projections only
HEALTHY=1 node outageserver.mjs          # synthetic props — priced rows, edges, play/pass
PREGAME=1 node outageserver.mjs          # rewrite today's slate to Preview a few hours out
CARDS=1   node outageserver.mjs          # post a 9-man lineup card -> pulled rows
```

Combine them. `HEALTHY=1 PREGAME=1 CARDS=1` is the full board: priced rows,
grouped by game, with lineup alerts firing. Two bugs were only ever visible in
that combination — a pulled row losing its market subline, and pulled rows
counting toward the same-game correlation tag.

Verification loads against production cost real Odds API credits (~45 per
uncached page load, since batters is markets × games). Use this instead.
