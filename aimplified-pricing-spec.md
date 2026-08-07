# Pricing refactor — build spec

**Status:** approved, not started. Build after the Aug 10 W32 read.
**Written:** 2026-08-05. All figures below measured on that date against live production.
**Scope:** batter props only (the posted product). K props and ML unchanged.

This spec is self-contained — it carries its own evidence so the decisions below
don't have to be re-derived or re-argued in a later session.

---

## 1. Why

Today's edge is **model vs. market**:

```
pOver     = fairOver + BATTER_SHRINK * (pRaw - fairOver)   // BATTER_SHRINK = 0.25
edgePts   = |pOver - fairOver| * 100
```

Three problems with it, all measured:

1. **No established edge.** On the cleaned record (post DNP-backfill), batter
   unders run +0.5% ROI at `roiP ≈ 0.83`; all graded unders +0.9% at `roiP ≈ 0.58`.
   Nothing is statistically distinguishable from break-even. No tier clears
   p<0.05 either (T1 0.73, T2 0.92, T3 0.89).

2. **The calibration result is weaker than it looks.** Measured slope is 0.923
   (SE 0.155) — apparently well calibrated. But with shrink at 0.25,
   `model_over = 0.75 * fair + 0.25 * raw_model`. Three-quarters of the number
   being validated *is the market*. The model contributes a quarter of the
   deviation, so the slope largely measures the market's calibration, not ours.

3. **Historical contamination.** In the `dk-fair` era, fair and price both came
   from DraftKings, making the "edge" mechanically the book's hold
   (`1/overround - 1`). That era shows the **highest ROI of the three (+4.9%** vs
   +1.2% and -7.7%) — the contaminated one looks best, which is precisely why a
   contaminated edge can't be trusted. Residue of this is still in the codebase:
   `sameTier()` discards CLV across mismatched sources, and `entryVsCloseTier`
   currently flags **334 rows** unverified.

The refactor replaces the selecting number with a **market vs. market** edge:
the gap between a sharp fair line and the soft price you can actually bet.

---

## 2. Architecture

Three pieces, no shared inputs between the first two.

### `best_price(side)`

Iterate the real offers for that exact side. Return the single best one, carrying
the book name with it. DK -110 / FD -115 on the over → return **-110, DraftKings**.

- No averaging, no synthesis.
- A side with no offer returns **nothing** — never an interpolated guess.

### `fair_prob(market)`

Shin de-vigged **median across the sharp books that quote that market**. Sharp
books are never bet and never shown in the Odds column; they exist only to produce
a fair line independent of the execution venue.

- H+R+RBI → novig + prophetx (two-book midpoint)
- Total Bases / Home Runs → pinnacle + novig + prophetx (three-book median)
- Never touches DK or FD.
- **Minimum two sharp books, each quoting two-sided.** A single book is never a
  fair line — it has no disagreement guard at all, so nothing distinguishes a
  real number from a stale or fat-fingered one.
- Fewer than two two-sided sharp quotes → **no fair → no pick.** No silent
  fallback, no single-book pricing.

### `edge`

```
price_edge = fair_prob - implied_prob(best_price)      // selects picks
model_edge = model_prob - fair_prob                    // recorded only
```

`implied_prob(best_price)` is **not** de-vigged — you pay the vig, so the edge
already nets it out.

---

## 3. Why the pool, not Pinnacle-only

Pinnacle-only was proposed and rejected on measurement. Live probe, 6 games,
2026-08-05 (`/api/fair-probe?games=6`, cost 3 credits):

| book | H+R+RBI | Total Bases | Home Runs | games quoted |
|---|---|---|---|---|
| **pinnacle** | **absent** | 83 | 32 | 5 of 6 |
| novig | 118 (105 two-sided) | 109 | 114 | 6 of 6 |
| prophetx | 120 (all two-sided) | 121 | 118 | 6 of 6 |

**Pinnacle posts zero H+R+RBI.** Matches the in-code probe note from 2026-07-25 —
unchanged 11 days later, so it is structural, not a transient gap. H+R+RBI is
**1,888 of 2,364 posted batter plays (~80%)**; Pinnacle-only would delete four
fifths of the board.

Pinnacle is also the *loosest* of the three where it does quote. `medianBooksum`
(overround):

| market | pinnacle | novig | prophetx |
|---|---|---|---|
| Home Runs | 1.0698 (6.98%) | **1.0252** | 1.0299 |
| Total Bases | 1.0699 | 1.0677 | **1.0534** |
| H+R+RBI | — | 1.0552 | **1.0506** |

A wider market de-vigs to a noisier fair. Pinnacle's sharp reputation comes from
main lines; on batter props it is neither the best-covered nor the tightest book.

**Known weakness of the pool:** the primary market (~80% of the board) is a
**two-book midpoint**, not a median. `SHARP_MAX_DISAGREE = 0.026` catches novig
and prophetx *diverging*, but nothing catches them being wrong *together* —
correlated error passes through as "fair." A three-book median degrades
gracefully when one book is stale; a two-book midpoint does not. There is no
fourth book available. Mitigation is measurement, not redundancy: see §7.

**Consequence of the two-book minimum on H+R+RBI.** Because Pinnacle doesn't
quote it, HRR has exactly two eligible sources and therefore **zero redundancy
under this rule**: if either novig or prophetx is missing for a player, that
player has no fair and is skipped. TB and HR degrade gracefully (lose one of
three, still priced); HRR fails closed. Since HRR is ~80% of the board, board
size is effectively a function of novig∩prophetx availability.

That is the correct trade — a lone-book fair is worse than no pick — but it
should be monitored rather than assumed benign. The 2026-08-05 probe reports
per-book totals, not their intersection (HRR: novig 105 two-sided of 118 quoted;
prophetx 120 of 120), so the true overlap and therefore the real board-size cost
is **not yet measured**. Instrument it at build time: log how many
player-markets are skipped for `reason = 'insufficient sharp quotes'`, split by
market. If HRR skips run high, that is the number to bring back to this decision
— not a reason to relax the rule silently.

---

## 4. Already built vs. new

Two thirds of this exists today.

| piece | state |
|---|---|
| `best_price` | **Built.** `bestBookMarket` returns the better of DK/FD for the chosen side with book attribution; markets with no offer render "no line posted" rather than interpolated. |
| `fair_prob` independent of execution book | **Built.** Sharp pool, never bet, never shown. 76.9% of current rows are `fair_src = sharp` (18.7% untagged legacy, 4.0% exec, 0.5% sharp-split). |
| `price_edge` | **New.** This is the whole build. |
| `model_edge` recorded alongside | **New** (it is today's `edge`, but must survive as its own field once `price_edge` takes over selection). |

---

## 5. Schema

Forward-only, per the existing convention. The `model_ver` / `fair_source`
comment states it directly: *"Deliberately NOT backfilled: rows written before
this column cannot be known to have been priced any particular way, and guessing
would be worse than the NULL."*

Add to `bpicks` via `addColumns`:

- `price_edge` REAL — the selecting number
- `model_edge` REAL — recorded, not selecting
- `fair_src` — already exists; extend values to distinguish a **2-book midpoint**
  from a **3-book median** so HRR fair precision can be compared to TB later

`price_edge` **cannot be reconstructed historically** — it needs the sharp fair
and best DK/FD price as they stood at log time, which isn't stored. The learning
clock starts at deploy.

**Expected time to answerability:** ~40 posted picks/night. A couple of weeks to
reach a comparable sample; closer to a month before "which edge earns" is
answerable with confidence. Set expectations accordingly — this is the same trap
as T1 sitting at n=19 for a season.

---

## 6. Tiering

**Tier on EV%, not probability points.**

```
EV% = edge_points / implied_prob
```

A 2-point edge is worth 2.8% at -250 and 7.0% at +250. The board spans -194 to
+124 (implied prob 0.66 → 0.45), so the same edge point is worth ~47% more at the
long end. The codebase already learned this for CLV — `avgClvEv` vs `avgCLV`,
*"avgClvEv is the one to trust when they disagree."* Extend it to edge.

**Discard `BATTER_TIERS = [5.5, 4, 3]`.** Those were derived from model-vs-fair
magnitudes (current era: p50 4.1, p75 4.9, p90 5.7, p95 6.3). Market-vs-market
edges run materially smaller. Re-derive from `edgeDistribution` on
`/api/batter-debug`, which is already deployed and reports per-era quantiles and
share-at-cutoff.

Target when re-deriving: T1 lands **10–20% of posted picks in the current era**,
no tier below ~8%, checked across *every* era rather than one night's board. A
single slate is not a valid basis — that error produced a 6.5 cutoff that
admitted 3.8%.

**Expect the optimizer's curse to survive the refactor.** `best_price` takes a
max across books, and maxima select for the book that is slowest or most wrong;
the biggest soft/sharp gaps will skew toward stale lines and news you don't have.
Do not assume the new edge is better behaved — measure it with `calibration`
and `tierVerdict`, which already exist.

---

## 7. Verification

Ship nothing without these.

1. **No shared inputs.** Assert in code and in test: `fair_prob` never reads a
   DK/FD price; `best_price` never reads a sharp book. This is the one invariant
   the whole refactor exists to guarantee.
2. **`sameTier` should become unnecessary.** If fair is always sharp-pool and
   price is always DK/FD, the cross-source CLV paths disappear. Watch
   `entryVsCloseTier` — the 334 unverified rows should stop growing.
3. **Both edges recorded on every posted row** — spot-check that `model_edge` is
   present and non-null on rows selected by `price_edge`.
4. **One-sided / no-quote → no pick**, verified with a synthetic market.
5. **Re-run `edgeDistribution`** post-deploy and set tiers from it; do not carry
   old cutoffs forward.
6. **HRR vs TB fair precision** — once graded, compare calibration/CLV on
   2-book-midpoint rows against 3-book-median rows. If HRR fair is measurably
   noisier, widen the HRR tier cutoff relative to TB.

---

## 8. Sequencing

1. **Aug 10** — W32 projection-bias read (scheduled routine
   `trig_01G36ncw3kb4taeqAgVG1HVf`). If HRR bias holds at -0.3 to -0.5 on the
   full week, `BATTER_PROJ_CAL` over-corrected and wants re-deriving **upward**.
2. **Lambda fix**, if called for. Contained change inside the current
   architecture. Let it grade a few days.
3. **This refactor.**

Do not ship 2 and 3 together — the ROI change would be unattributable.

---

## 9. Open

Decided:

- `best_price` as specified — best real DK/FD offer, book attached, nothing when
  there is no offer
- `fair_prob` = Shin de-vigged median across sharp books quoting that market,
  **minimum two books two-sided**, skip the pick otherwise
- Both edges recorded; `price_edge` selects, `model_edge` rides along
- `fair_src` tagged to distinguish 2-book midpoint from 3-book median

Still to confirm before build:

- Tier on EV% rather than probability points (§6) — recommended, not yet ratified

To measure at build time (§3): skip rate for `insufficient sharp quotes`, by
market. Unknown today; determines the real board-size cost of the two-book rule.
