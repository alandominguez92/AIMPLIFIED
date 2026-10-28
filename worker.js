// Cloudflare Worker entrypoint.
// Serves the static site via the ASSETS binding and proxies real data on /api/*:
//   /api/scores  -> The Odds API — live MLB scores        (needs ODDS_API_KEY)
//   /api/odds    -> The Odds API — MLB moneyline + totals  (needs ODDS_API_KEY)
//   /api/hitters -> MLB StatsAPI — season hitting leaders  (no key required)
// Secrets stay server-side; the browser only ever sees shaped JSON.

const ODDS = 'https://api.the-odds-api.com/v4/sports/baseball_mlb';
const STATS = 'https://statsapi.mlb.com/api/v1';

// Model calibration. Strikeouts per start are overdispersed vs a Poisson
// (innings vary, matchup variance), so pricing off Poisson makes P(over) too
// confident and edges too large. Use an overdispersed spread, and regress the
// projection modestly toward the (sharp) market line to temper model error.
const DISPERSION = 1.55;   // Var(K) / mean at the game level

// ---- Hits allowed by the starter (projection only — nothing is priced or bet) --
// Same shape as the strikeout model, swapping the pitcher's K/9 for his H/9 and
// the opponent's K/PA for its H/PA. All three constants were measured on 220
// completed starts rather than assumed; refit them the way the K side does.
const HITS_DISPERSION = 1.21;  // Var(H) / mean at the game level — hits are tighter than Ks (1.55)
// Innings of league-average prior mixed into a pitcher's own H/9. MAE is nearly
// flat from 15 to 180 IP (1.925 -> 1.997), so this was NOT chosen on accuracy —
// it was chosen on the tail. Unregressed, one arm with a handful of innings
// projected 13.1 hits off an H/9 of 15.3, which against any real line would read
// as an enormous edge and be pure sample noise. At 60 the worst projection on
// the same starts is 7.6.
const H_PRIOR_IP = 60;
// League H/9, the mean a short sample regresses toward. Hardcoded like the other
// baselines: deriving it live would need a second teams/stats call, and the
// hitting call already made supplies the opponent side for free.
const LG_H9_BASE = 8.32;
// The raw model projected +0.41 hits per start too many, which on its own made it
// lean over on 78% of starts against a real over rate of 56%. This zeroes that.
// Fitted on season rates that include the graded starts, so it is optimistic and
// should be refit from proj_log once real out-of-sample rows accumulate.
const H_PROJ_CAL = 0.923;
// Calibration audit (214 graded K picks): aggregate is well-calibrated
// (predicted 63.1% over, actual 61.4%) but Tier 1 overstates — predicted 69.4%,
// hit 62.1% (~7pt gap). Classic optimizer's curse: the biggest model-vs-market
// edges are the most inflated. So instead of the planned drop to 0.24, raise
// shrink 0.30 -> 0.37 — it pulls the projection toward the sharp line by a fixed
// fraction, so the P(over) reduction scales with the projection-line gap and
// lands hardest on T1 while barely touching the calibrated lower tiers. Interim
// half-step; refit precisely from the per-decile curve as more picks grade.
const LINE_SHRINK = 0.37;
// Strikeout projection calibration (2026-09-17).
//
// Across 881 graded starts under k-sharp-shin (07-28..09-16) the model projected
// 5.21 strikeouts and pitchers recorded 4.76: actual/projected 0.913, and 0.912 /
// 0.914 in the two halves, so a stable bias rather than a streak. Running high
// made the model lean OVER on 74% of starts, and overs were the losing side
// (247-307, -11%, p=0.01; unders 84-90, -2.6%).
//
// 0.93 is 85% of the first-half fit (0.912 -> 0.925), the caution every
// calibration here has used. Scored on the second half: average miss 1.895 ->
// 1.857 strikeouts, over-leans 74% -> 52%, Brier on P(over) 0.2528 -> 0.2522.
//
// What it does NOT do: beat the market (its Brier was 0.2505) or make K props
// bettable — the second half's non-pass picks went from break-even to -5.4%
// after re-pricing. It ships because the projections on the K Props tab are read
// daily and were systematically high, not because it finds an edge.
//
// Not applied: pulling extreme projections toward the average (actual = 1.53 +
// 0.62 x projection on the first half). It lowered the miss further (1.842) but
// made the over/under probabilities worse (0.2537).
const K_PROJ_CAL = 0.93;  // fraction of the projection pulled toward the line

// The books we price against (the user's accounts). Odds API bookmaker keys ->
// short display labels. Prices are pinned to these two only, and the better of
// the two is highlighted so the board doubles as a line-shop.
const BOOKS = { draftkings: 'DK', fanduel: 'FD' };
// Extra soft books pulled ONLY to sharpen the strikeout fair line — never shown
// in the Odds column and never bet (you only have DK/FD accounts). They already
// ride along in the us-region prop response we pay for, so pooling them is free
// quota. More de-vigged books -> a median fair that rejects one soft/stale line.
const FAIR_EXTRA = { betmgm: 'MGM' };
// PrizePicks — SHOWN, never priced against. It is where most of the betting
// actually happens here, so its number belongs on the board; but pick'em is not
// a sportsbook. The payout comes from the entry type (2-pick power, 6-pick flex,
// ...), not from the line, so its "odds" cannot drive a best price, an EV gate or
// a fair line — the model's probability against the entry's break-even is the
// comparison that means anything, and that lives with the reader, not the row.
//
// What IS decision-grade is the NUMBER: PrizePicks routinely hangs a different
// line than DK/FD, and under 2.5 is a different bet from under 1.5. So the line
// is displayed, flagged when it differs from the one we priced, and kept out of
// every calculation. Free: billing is ceil(books/10) region-equivalents and this
// is the 8th book in the same request.
const DISPLAY_BOOKS = { prizepicks: 'PP' };
const FAIR_BOOKS = { ...BOOKS, ...FAIR_EXTRA };
// Sharp reference book: Pinnacle's de-vigged line is the closest thing to a true
// probability. We price value against it (fair line) but still bet DK/FD (the
// books you can actually use). Pinnacle lives in the Odds API's `eu` region.
const REF_BOOK = 'pinnacle';

// Sharp fair sources for BATTER props. These are never bet (no accounts) and
// never shown in the Odds column — they exist only to produce a fair line that
// is independent of the book we execute at. Pricing a DK bet against a DK-derived
// fair is circular: the "edge" is just model-minus-DK, so it can't predict where
// DK is going to move. Splitting the two is what makes CLV meaningful.
// Coverage is market-dependent (probe 07-25: Pinnacle 17 TB / 0 H+R+RBI, novig
// strong on both), so the pool is pooled-by-median rather than a single book.
const SHARP_BOOKS = { pinnacle: 'PIN', novig: 'NOVIG', prophetx: 'PX', lowvig: 'LV' };
// Every book we parse out of the batter-prop response: execution venues (bet),
// MGM (soft reference), and the sharp pool (fair only). Requesting these by key
// costs ceil(n/10) region-equivalents = 1, identical to the `regions=us` call it
// replaces, so the sharp fair line is quota-neutral.
const PROP_BOOKS = { ...BOOKS, ...FAIR_EXTRA, ...SHARP_BOOKS, ...DISPLAY_BOOKS };
const SHARP_LABELS = Object.values(SHARP_BOOKS);
// Max de-vigged disagreement tolerated between exactly two sharp books before
// their midpoint stops being a fair line and becomes a guess. Live pairs agree
// to well under 0.026; the one pathological row seen so far was 0.112 apart.
const SHARP_MAX_SPREAD = 0.05;
// Bumped whenever the pricing regime changes, and stamped on every logged row so
// eras stay separable in analysis. 'dk-fair' = edge measured against DraftKings
// (circular); 'sharp-shin' = edge vs the Shin-de-vigged sharp pool.
// Bumped when the negative binomial replaced Poisson. The pricing side did not
// change, but the projection distribution did, so rows either side of that
// switch are not the same experiment — leaving both as 'sharp-shin' would have
// blended a 3-slate Poisson sample into the negative-binomial one and made the
// sharp-fair verdict unattributable to either change.
// Bumped again 2026-09-17 for the H+R+RBI calibration (BATTER_PROJ_CAL.hrr
// 1.00 -> 1.11). It changes which H+R+RBI unders are posted, so rows either side
// of it are different experiments and the era-edge card must start counting fresh
// rather than blend a month at 1.00 into whatever 1.11 does.
// And again the same day for the implied-team-runs input on H+R+RBI (see
// ITT_BETA). It moves H+R+RBI projections game by game, so it is its own era.
const BATTER_MODEL_VER = 'sharp-shin-nb-evgate-hrrcal111-itt';
// Same idea for the strikeout board, which moved from a DK/FD/MGM consensus fair
// (circular — two of the three are the books we bet) to the sharp pool with that
// consensus demoted to a middle fallback rung.
// 'k-sharp-shin-cal93' (2026-09-17): projections scaled by K_PROJ_CAL.
const K_MODEL_VER = 'k-sharp-shin-cal93';
// Moneyline pricing era. 'ml-shin' covers Shin de-vig on the sharp pair,
// grading at entry price rather than close, and de-vigging each book's own
// two sides instead of the best-of pair. fair_source is logged alongside so
// a Pinnacle-priced pick is distinguishable from a soft-book fallback.
// 'ml-shin-check25' (2026-09-17): Pinnacle edges of ML_EDGE_CHECK+ are flagged
// 'check' instead of ranked, so rows either side of it are different regimes.
const ML_MODEL_VER = 'ml-shin-check25';
// Stamped on every run-line row so eras stay separable, exactly as the other
// tables do. 'rl-shin' is the regime this starts in: cover% from the model,
// fair from Pinnacle's de-vigged spread, edge measured against it.
const RL_MODEL_VER = 'rl-shin';

const API_ROUTES = new Set([
  '/api/odds', '/api/scores', '/api/hitters', '/api/pitchers',
  '/api/board', '/api/batters', '/api/track-record', '/api/injuries', '/api/live-now',
  '/api/ml-debug', '/api/track-debug', '/api/edge-debug', '/api/batter-debug', '/api/bpicks-export', '/api/mlpicks-export', '/api/pppicks-export', '/api/gmpicks-export', '/api/top-legs', '/api/picks', '/api/entries', '/api/soc-lines',
  '/api/fair-probe', '/api/sports-list', '/api/soccer-board', '/api/soccer-props', '/api/nba-board', '/api/nba-pp', '/api/nhl-board', '/api/nhl-pp', '/api/soccer-ingest', '/api/nfl-ingest', '/api/nfl-capture', '/api/nfl-board', '/api/nfl-compare', '/api/nfl-grade', '/api/be-gate', '/api/nfl-props', '/api/usage',
  '/api/mlb-void-moved', '/api/hist-backtest',
]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;

    if (!API_ROUTES.has(p)) return env.ASSETS.fetch(request); // static site

    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
    // Your entries: private, written to, and never cached — so it is answered
    // before the shared edge cache, which would otherwise hand one viewer's
    // response to the next.
    if (p === '/api/entries') return entriesApi(request, env, url);
    // The PrizePicks soccer lines typed on the card: private the same way.
    if (p === '/api/soc-lines') return socLinesApi(request, env);

    // Shared edge cache: every viewer reuses one upstream burst per TTL (the TTL
    // is each handler's Cache-Control max-age). This is what protects the paid
    // Odds API quota — usage drops from per-viewer to ~once per window per colo.
    // Side effects (D1 logging, self-grading) run only on a miss, i.e. once per
    // window, which is the cadence we want anyway.
    const cache = caches.default;
    // Query string is dropped so every viewer shares one cached response per
    // path — except fair-probe, whose ?market= and ?games= change what is
    // actually being asked. Stripping them there would serve a batter-market
    // result to a strikeout probe and silently answer the wrong question.
    // ?nofetch=1 — verification mode. Serves whatever is already cached and
    // NEVER invokes a handler that could call the Odds API.
    //
    // Added after a session of repeated visual checks helped exhaust the API
    // quota: every uncached page load fans out to /api/board, /api/batters,
    // /api/odds and /api/scores, and the batters call alone is markets x regions
    // x games — roughly 45 credits on a fifteen-game slate. The board then
    // blamed the sportsbooks for the outage.
    //
    // Deliberately decided HERE rather than inside a fetch wrapper. A
    // module-level "dry run" flag is shared by every request in the isolate, so
    // a checking request could suppress fetches for a real viewer arriving at
    // the same moment. Routing is request-scoped and cannot leak.
    if (url.searchParams.get('nofetch') === '1') {
      const dryKey = new Request(url.origin + p);
      const hit = await caches.default.match(dryKey);
      if (hit) {
        const h = new Headers(hit.headers);
        h.set('x-dry-run', 'cache-hit');
        return new Response(hit.body, { status: hit.status, headers: h });
      }
      // Nothing cached: answer in the shape each route promises, flagged, rather
      // than 204 — the client should render its normal empty state, not break.
      const body = p === '/api/batters'
        ? { rows: [], feedError: { status: 0, code: 'DRY_RUN', message: 'nofetch=1: no upstream call made', kind: 'dry-run' } }
        : { dryRun: true, note: 'nofetch=1: no upstream call made, and nothing cached for this route' };
      return cors(json(body, 5));
    }

    // Both write; caching either would serve a stale body and skip the write.
    if (p === '/api/nfl-ingest' || p === '/api/nfl-capture' || p === '/api/nfl-grade' || p === '/api/soccer-ingest' || p === '/api/mlb-void-moved' || p === '/api/hist-backtest') return handleApi(p, env, ctx, url);
    // The query string is dropped from the key on purpose — every viewer should
    // share one response — EXCEPT where it changes what the route returns.
    // /api/nfl-compare was keyed by path alone, so ?all=1 (played games included,
    // what the Monday grading run reads) could be answered from a cached
    // upcoming-only response left by anyone who opened the NFL board in the last
    // minute: zero graded rows, and a run concluding grading had failed. Its
    // ?summary=1 form would have been worse the other way round — a rowless body
    // cached under the path the board itself reads.
    // Routes whose answer depends on the query string. The edge cache key drops
    // the query everywhere else, so without this a ?summary=1 request and a full
    // board request would share one entry and serve each other's body.
    const KEYED_BY_QUERY = p === '/api/fair-probe' || p === '/api/nfl-compare' || p === '/api/board' || p === '/api/batters' || p === '/api/track-record' || p === '/api/bpicks-export' || p === '/api/mlpicks-export' || p === '/api/pppicks-export' || p === '/api/gmpicks-export' || p === '/api/top-legs' || p === '/api/soccer-board' || p === '/api/soccer-props' || p === '/api/nba-pp' || p === '/api/nhl-pp';
    const cacheKey = new Request(url.origin + p + (KEYED_BY_QUERY ? url.search : ''));
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    const resp = await handleApi(p, env, ctx, url);
    // Only cache real successes — never an error (so a transient failure can't
    // stick). Empty [] uses a short TTL in its handler, so it self-heals fast.
    if (resp && resp.status === 200 && ctx && ctx.waitUntil) {
      ctx.waitUntil(cache.put(cacheKey, resp.clone()));
    }
    return resp;
  },

  // Cron trigger (see wrangler.toml [triggers]). Freezes closing lines so CLV is
  // measured against the real close, not whatever line was up the last time a
  // viewer happened to load the site. See captureCloses.
  async scheduled(event, env, ctx) {
    // The soccer box-score cron has its own trigger: a match is ~30 requests,
    // and an invocation's request budget is shared by everything it runs.
    if (event && event.cron === SOC_BOX_CRON) {
      ctx.waitUntil(socBoxTick(env, { perTick: 30, via: 'soccer-trigger' }).catch(() => null));
      return;
    }
    ctx.waitUntil(captureCloses(env, ctx));
    // Soccer game lines, gated to twice a matchday per league — see
    // soccerMaybeIngest. Most ticks do nothing but read a counter.
    ctx.waitUntil(soccerMaybeIngest(env, ctx).catch(() => null));
    // Same shape for the NFL game lines: most ticks read a counter and stop.
    ctx.waitUntil(nflMaybeIngest(env, ctx).catch(() => null));
    // And the NBA moneyline, recorded only -- see nbaMaybeIngest.
    ctx.waitUntil(nbaMaybeIngest(env).catch(() => null));
    // The NHL moneyline the same way, on its own counter (2026-10-20).
    ctx.waitUntil(nhlMaybeIngest(env).catch(() => null));
    // NBA PrizePicks unders: the night's box scores in, each game's PrizePicks
    // lines read when posted and again before tip (ppReadDue), the log graded.
    ctx.waitUntil(nbaBoxIngest(env).catch(() => null));
    ctx.waitUntil(nbaPpMaybeCapture(env).catch(() => null));
    // NHL PrizePicks points and assists unders: read the same way, graded
    // hourly from the NHL's box scores.
    ctx.waitUntil(nhlPpMaybeCapture(env).catch(() => null));
    ctx.waitUntil(gradeNhlPp(env).catch(() => null));
    // Grading is free (ESPN only) and idempotent, so it can ride the cron rather
    // than waiting for someone to open the track record.
    ctx.waitUntil(gradeGamePicks(env).catch(() => null));
    ctx.waitUntil(gradePassTds(env).catch(() => null));
    ctx.waitUntil(gradePassYds(env).catch(() => null));
    ctx.waitUntil(nflGradeCron(env).catch(() => null));
    ctx.waitUntil(gradeEntryLegs(env).catch(() => null));
    // Picks of the day: every fifteen minutes, so the log knows which legs were
    // on the list when each game started even with nobody on the site.
    const min = new Date((event && event.scheduledTime) || Date.now()).getUTCMinutes();
    if (min % 15 < 5) ctx.waitUntil(dayPicksTick(env).catch(() => null));
    // Soccer box scores, a dozen players a tick (see socBoxTick).
    ctx.waitUntil(socBoxTick(env, { perTick: 12, via: 'main' }).catch(() => null));
  },
};

// The close is the last line before first pitch — the number CLV is measured
// against. Logging refreshes close_over/close_price every time board()/batters()
// run, but that only happens on organic traffic, so a game that goes off while
// no one is on the site keeps a stale close and its CLV is meaningless. This
// cron fills that gap: a few minutes before each game we refresh both boards,
// which re-logs the picks and stamps their close to that near-final line.
//
// To stay cheap, the paid Odds refresh fires only when a game is actually in the
// pre-pitch window — on a normal slate that's a handful of starts, not all day.
// A 5-minute cron with a 7-minute window guarantees every game gets at least one
// in-window refresh (there's always a tick in the 5 minutes before first pitch).
//
// Widened to 15 so each game gets ~3 in-window refreshes instead of ~1. On its
// own that changes nothing — this window only decides WHEN a refresh fires, and
// the close write always overwrote, so the last tick before first pitch won
// regardless. The extra passes only help because the close write now refuses to
// downgrade (see logBatterPicks): a sharp-sourced close captured at 15 minutes
// survives a 5-minute refresh that can only see the execution book. Sharp books
// pull early, which is what put 13.5% of rows on a different tier at close than
// at entry.
//
// Costs ~2-3x the close-capture refreshes. Each fires board() + batters(), and
// batters() is the expensive call, so watch quota before widening further.
const CLOSE_WINDOW_MIN = 15;

// Props post the morning of game day, so a game more than ~12h out often has no
// lines yet. That is no longer a reason not to ask (see early lines below): the
// Odds API bills only the markets it returns, so an empty answer costs nothing —
// the cost of asking early is how OFTEN, which the early tier rations.
//
// board() has gated its strikeout fetch on this since the board started rolling
// a day ahead into projections. batters() never did: it asked /events with no
// upper bound and priced everything with a future start, which in season is
// today's slate PLUS tomorrow's once books post it. That is the expensive call
// (three markets per event against strikeouts' one), so the ungated path was
// the costly one, and it was silently paying double through the evening.
//
// Hoisted to module scope so the two cannot drift apart again. The /events
// request is bounded upstream by commenceTimeTo; since early lines (below) that
// bound is PROP_EARLY_HORIZON_MS, and the tiers decide what is actually priced.
const PROP_LEAD_MS = 12 * 3600 * 1000;

// Early lines. PROP_LEAD_MS on its own meant no line was bought for a game until
// 12 hours before first pitch, so an afternoon slate sat unpriced through the
// small hours while DraftKings and FanDuel were already showing the numbers —
// on 2026-09-14 every row read "awaiting line" at 2 AM PT for a 3:40 PM first
// pitch. The model's projections were on the board the whole time; it was the
// market side of the comparison that was missing.
//
// Games on the slate the board is SHOWING are now priced as soon as books post
// them, on two cadences so the fix does not reopen the quota problem the lead
// window was added to close:
//   near   inside PROP_LEAD_MS — unchanged: the board's own TTL.
//   early  on the displayed slate but further out — bought at most once per
//          PROP_EARLY_TTL_MS, globally, through feed_cache, however many
//          viewers or Cloudflare locations ask in between.
// Lines move little that far from first pitch. Games on a slate the board is
// not showing (tomorrow's, before the roll) are still not bought.
const PROP_EARLY_HORIZON_MS = 24 * 3600 * 1000;
const PROP_EARLY_TTL_MS = 60 * 60 * 1000;
// Both boards roll to tomorrow's slate once tonight's games are done, which puts
// a full schedule into the early tier for the whole night. At the hourly cadence
// that is ~8 refreshes of every game before anyone is awake, for lines that
// barely move that far out. Beyond PROP_EARLY_FAR_MS the cadence drops to three
// hours; inside it — which is where a slate spends the morning it is played —
// nothing changes.
// Stored lines carry team ABBREVIATIONS (awayAb/homeAb), and the board rebuilds
// each row's matchup string from them. So a change to the abbreviation table does
// not reach records already in the store: on 2026-09-16, minutes after Arizona
// was corrected from ARI to AZ, the board listed the same game twice — "MIA @
// ARI" with 8 rows from the store and "MIA @ AZ" with 1 from the fresh fetch. It
// would have healed itself within three hours, which is three hours of a board
// showing sixteen games on a fifteen-game slate.
//
// Bump this whenever the shape or the spelling of what is stored changes. Old
// keys are simply never read again, and expire on their own.
// v3 (2026-09-17): same-named hitters in different games are stored as separate
// records; a v2 record could hold two players' lines merged under one name.
// v4 (2026-09-18): stored props carry PrizePicks alongside DK/FD/sharps.
const LINES_STORE_VER = 'v4';
const PROP_EARLY_FAR_MS = 18 * 3600 * 1000;
const PROP_EARLY_FAR_TTL_MS = 3 * 60 * 60 * 1000;
// Splits early events by how far out they are: [{ suffix, ttlMs, events }].
// The suffix keeps the two cadences in separate store keys, so the slower one
// cannot be refreshed early by the faster one writing over it.
function earlyBuckets(events, nowMs) {
  const soon = [], far = [];
  for (const ev of events) {
    const t = ev && ev.commence_time ? Date.parse(ev.commence_time) : 0;
    (t - nowMs > PROP_EARLY_FAR_MS ? far : soon).push(ev);
  }
  return [
    { suffix: '', ttlMs: PROP_EARLY_TTL_MS, events: soon },
    { suffix: ':far', ttlMs: PROP_EARLY_FAR_TTL_MS, events: far },
  ].filter((b) => b.events.length);
}
const ptDateOf = (ms) => {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
  } catch (e) { return new Date(ms).toISOString().slice(0, 10); }
};
// 'near' | 'early' | null for a start time, against the slate being displayed.
function propTierAt(tMs, nowMs, slateYmd) {
  if (!(tMs > nowMs)) return null;                        // started: its pre-game line is gone
  if (tMs - nowMs <= PROP_LEAD_MS) return 'near';
  if (tMs - nowMs <= PROP_EARLY_HORIZON_MS && ptDateOf(tMs) === slateYmd) return 'early';
  return null;
}
const propTier = (ev, nowMs, slateYmd) =>
  (!ev || !ev.commence_time ? 'near' : propTierAt(Date.parse(ev.commence_time), nowMs, slateYmd));

// Buys lines for a set of events at most once per ttlMs across every location,
// using the same single-flight lease as the batter line store. fetchInto(ev,
// target) fills `target` and returns an error string, or null.
//
// Unlike the near store, an EMPTY result is stored too: early in the day most
// books have not posted, and without a stored "nothing yet" every request would
// see a cold store and re-ask — the hourly cadence would only hold for slates
// that already had lines. An error is never stored.
async function linesOnCadence(env, ctx, key, ttlMs, events, fetchInto) {
  const useStore = !!(env && env.DB);
  if (useStore) {
    const hit = await loadFeedCache(env.DB, key);
    if (hit.present && hit.ageMs < ttlMs) return { data: hit.data || {}, error: null, fromStore: true };
    if (!(await claimFeedRefresh(env.DB, key, ttlMs)) && hit.present) {
      return { data: hit.data || {}, error: null, fromStore: true };
    }
  }
  const data = {};
  const errs = await Promise.all(events.map((ev) => fetchInto(ev, data)));
  const error = errs.find(Boolean) || null;
  if (useStore && !error) {
    const w = saveFeedCache(env.DB, key, data);
    if (ctx && ctx.waitUntil) ctx.waitUntil(w); else await w;
  }
  return { data, error, fromStore: false };
}

// Odds API wants ISO8601 with no sub-second part; toISOString always emits ms.
const oddsTime = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
// Looks as far as the early tier can reach. /events itself costs nothing; the
// per-event price calls are what the tiers above ration.
const eventsUrl = (key) => `${ODDS}/events?apiKey=${key}&dateFormat=iso`
  + `&commenceTimeTo=${oddsTime(Date.now() + PROP_EARLY_HORIZON_MS)}`;

// The cron fires when ANY game is inside the close window, but it was then
// refreshing the WHOLE slate — every game's props re-fetched so that one game's
// closing line could be frozen. On a staggered slate that is most of the cost:
// measured on 2026-08-27 (7 games over 520 minutes, 14 firings) it was 98
// per-event fetches where 21 would do, so 79% of the cron's spend bought nothing.
//
// Scoping the refresh to the games actually closing keeps the window at 15
// minutes — which is not redundancy, it is what lets a sharp-sourced close
// survive a later refresh that can only see the execution book — while dropping
// the fetches that were re-pricing games hours from first pitch.
const closingSoon = (events, windowMs) => {
  const now = Date.now();
  return (Array.isArray(events) ? events : []).filter((ev) => {
    if (!ev.commence_time) return false;   // no start time -> cannot be closing
    const t = Date.parse(ev.commence_time);
    return t > now && (t - now) <= windowMs;
  });
};
async function captureCloses(env, ctx) {
  if (!env || !env.DB) return; // no track-record DB -> nothing to freeze
  let sched;
  try {
    const r = await fetch(`${STATS}/schedule?sportId=1&date=${slateDate()}`, { headers: { accept: 'application/json' } });
    if (!r.ok) return;
    sched = await r.json();
  } catch (e) { return; }
  const games = (sched.dates && sched.dates[0] && sched.dates[0].games) || [];
  const now = Date.now();
  const windowMs = CLOSE_WINDOW_MIN * 60 * 1000;
  const nearPitch = games.some((g) => {
    const t = Date.parse(g.gameDate);
    return t && t > now && (t - now) <= windowMs; // starts within the window
  });
  if (!nearPitch) return; // no close to capture this tick — skip the paid refresh
  // Refresh both boards so strikeout, moneyline (board) and batter (batters)
  // closes all re-log. Their own ctx.waitUntil writes ride on this same ctx.
  //
  // closeOnly restricts each to the games inside the window. The close write only
  // touches rows for games that are about to start, so re-pricing the rest of the
  // slate produced writes identical to what was already stored — 79% of this
  // job's per-event fetches, measured across a full slate.
  try {
    await Promise.all([
      board(env, ctx, { closeOnly: windowMs }),
      batters(env, ctx, { closeOnly: windowMs }),
    ]);
  } catch (e) { /* transient */ }
}

// `url` is threaded through because /api/fair-probe reads ?market= and ?games=
// from the query string. The edge cache above keys on path alone for every
// other route; fair-probe is the one exception and includes its query.
async function handleApi(p, env, ctx, url) {
  if (p === '/api/hitters') return hitters();
  if (p === '/api/pitchers') return pitchers();
  if (p === '/api/board') {
    const full = await board(env, ctx);
    return url && url.searchParams.get('summary') ? boardSummary(full) : full;
  }
  if (p === '/api/batters') {
    const full = await batters(env, ctx);
    return url.searchParams.get('summary') ? battersSummary(full) : full;
  }
  if (p === '/api/track-record') {
    const full = await trackRecordCached(env);
    return url && url.searchParams.get('summary') ? trackRecordSummary(full) : full;
  }
  if (p === '/api/injuries') return injuries();
  if (p === '/api/live-now') return liveNow(env);
  if (p === '/api/ml-debug') return mlDebug(env);
  if (p === '/api/track-debug') return trackDebug(env);
  if (p === '/api/edge-debug') return edgeDebug(env);
  if (p === '/api/batter-debug') return batterDebug(env);
  if (p === '/api/bpicks-export') return bpicksExport(env, url);
  if (p === '/api/pppicks-export') return ppExport(env, url);
  if (p === '/api/gmpicks-export') return gmExport(env, url);
  if (p === '/api/top-legs') return topLegs(env, url);
  // A failed read is kept at the edge for seconds, not two minutes: every
  // viewer was served "Picks unavailable" until it expired.
  if (p === '/api/picks') { const d = await picksBoard(env); return cors(json(d, d.error || d.recordError ? 5 : 120)); }
  if (p === '/api/mlpicks-export') return mlpicksExport(env, url);
  if (p === '/api/mlb-void-moved') return voidMovedGameRows(env, url);
  if (p === '/api/fair-probe') return fairProbe(env, url);
  if (p === '/api/hist-backtest') {
    return cors(new Response(JSON.stringify(await histBacktest(env, url)), { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }));
  }
  if (p === '/api/sports-list') return sportsList(env, url);
  if (p === '/api/soccer-board') return cors(json(await soccerBoardData(env, url), 120));
  if (p === '/api/soccer-props') return cors(json(await socPropsBoard(env, url), 120));
  if (p === '/api/nba-board') return cors(json(await nbaBoardData(env), 120));
  if (p === '/api/nhl-pp') return cors(json(await nhlPpBoard(env, url), 120));
  if (p === '/api/nba-pp') {
    const raw = url && url.searchParams.get('raw');
    const day = url && url.searchParams.get('day');
    if (/^\d{4}-\d{2}-\d{2}$/.test(day || '')) return cors(json(await nbaPpDay(env, day), 120));
    return cors(json(raw === '1' ? await nbaPpRaw(env) : raw === 'events' ? await ppEventsRaw(env, 'nba', 'reg') : await nbaPpBoard(env), 120));
  }
  if (p === '/api/nhl-board') return cors(json(await nhlBoardData(env), 120));
  if (p === '/api/soccer-ingest') return cors(json(await soccerIngest(env, url), 30));
  if (p === '/api/nfl-ingest') return nflIngest(env, url);
  if (p === '/api/nfl-compare') return nflCompare(env, url);
  if (p === '/api/nfl-grade') return nflGrade(env, url);
  if (p === '/api/nfl-capture') {
    const o = await ingestNflProps(env, {
      sport: url.searchParams.get('sport') || 'nfl',
      dry: url.searchParams.get('dry') === '1',
    }, url);
    return cors(json(o, 10));
  }
  if (p === '/api/nfl-board') return nflBoard(env, url);
  if (p === '/api/be-gate') return beGate(env, url);
  if (p === '/api/nfl-props') return nflProps(env, url);
  if (p === '/api/usage') return oddsUsage(env);

  // Scores come from StatsAPI, which is free and authoritative for MLB. They
  // used to be bought from the Odds API for 2 credits a call, 1,102 times on
  // 2026-09-04 — 29% of that day's entire quota spend, for a scoreboard.
  if (p === '/api/scores') return mlbScores();

  const key = env.ODDS_API_KEY;
  if (!key) return err('ODDS_API_KEY is not configured', 500);
  // 300s, not 30. The ticker polls this every 60 seconds, so a 30-second TTL
  // had already expired by the time the next poll arrived and the shared cache
  // never once absorbed a request — every poll bought a fresh call. The number
  // this feeds is a moneyline label on a ticker; it does not move in 5 minutes.
  // h2h only. `totals` was requested for years and read by nothing: the sole
  // consumer of this endpoint is homeMoneyline(), which looks up the h2h market
  // and nothing else. Billing is per market, so that second market doubled the
  // call's cost to buy a number no code path has ever opened.
  return proxy(`${ODDS}/odds?apiKey=${key}&regions=us&markets=h2h&oddsFormat=american&dateFormat=iso`,
    env, ctx, 'api:odds', 300);
}

// -------------------------------------------------------------------------
// /api/scores — tonight's scoreboard, from StatsAPI rather than the paid feed.
// Shaped exactly like the Odds API /scores response it replaces (id,
// commence_time, completed, home_team, away_team, scores[]) so the client did
// not have to change to read it.
//
// The one field that cannot be preserved is `id`: an Odds API event id has no
// StatsAPI equivalent. The client matched odds to scores on it, so that lookup
// moved to home_team, which both feeds spell the same way.
// -------------------------------------------------------------------------
async function mlbScores() {
  try {
    const r = await fetch(`${STATS}/schedule?sportId=1&date=${slateDate()}&hydrate=team,linescore`,
      { headers: { accept: 'application/json' } });
    if (!r.ok) return cors(json([], 30));
    const d = await r.json();
    const games = (((d.dates || [])[0] || {}).games) || [];
    const rows = games.map((g) => {
      const away = g.teams.away, home = g.teams.home;
      const ls = g.linescore || {};
      const state = (g.status && g.status.abstractGameState) || 'Preview';
      const aR = numOr(away.score, ls.teams && ls.teams.away && ls.teams.away.runs);
      const hR = numOr(home.score, ls.teams && ls.teams.home && ls.teams.home.runs);
      // A 0-0 game in progress is a real score; only a game that has not started
      // gets an empty array, which is how the client tells "no score yet" from
      // "nobody has scored". Matching the Odds API's own behaviour here.
      const hasScore = (state === 'Live' || state === 'Final') && aR != null && hR != null;
      return {
        id: 'g' + g.gamePk,
        commence_time: g.gameDate,
        completed: state === 'Final',
        home_team: home.team.name,
        away_team: away.team.name,
        scores: hasScore
          ? [{ name: away.team.name, score: String(aR) }, { name: home.team.name, score: String(hR) }]
          : [],
      };
    });
    return cors(json(rows, 30));   // free upstream, so freshness costs nothing
  } catch (e) { return cors(json([], 30)); }
}

// -------------------------------------------------------------------------
// /api/hitters — real season hitting leaders (by OPS) from MLB StatsAPI.
// Shaped to match what the Hottest Hitters cards expect. Returns [] on any
// upstream trouble so the page falls back to its built-in sample data.
// -------------------------------------------------------------------------
async function hitters() {
  const season = new Date().getUTCFullYear();
  const api = `${STATS}/stats?stats=season&group=hitting&gameType=R`
    + `&season=${season}&sportId=1&playerPool=Qualified&limit=300`;

  let r;
  try {
    r = await fetch(api, { headers: { accept: 'application/json' } });
  } catch (e) {
    return cors(json([], 30)); // network trouble -> let the page use mock data
  }
  if (!r.ok) return cors(json([], 30));

  let data;
  try { data = await r.json(); } catch (e) { return cors(json([], 30)); }

  const splits = (data.stats && data.stats[0] && data.stats[0].splits) || [];
  const rows = splits
    .map((s) => {
      const st = s.stat || {};
      return {
        id: (s.player || {}).id,
        name: shortName((s.player || {}).fullName),
        team: teamAbbr(s.team),
        ops: toNum(st.ops),
        pa: toNum(st.plateAppearances),
        statVal: avg3(st.ops),
        statLabel: 'OPS · season',
        streak: avg3(st.avg) + ' AVG',
        hrs: typeof st.homeRuns === 'number' ? st.homeRuns : toNum(st.homeRuns),
      };
    })
    .filter((x) => x.name && x.ops > 0 && x.pa >= 150)
    .sort((a, b) => b.ops - a.ops)
    .slice(0, 10);

  await attachSplits(rows, 'hitting'); // OPS vs LHP / vs RHP
  return cors(json(rows, 300)); // cache 5 min — season stats move slowly
}

// -------------------------------------------------------------------------
// /api/pitchers — real season pitching leaders (by K/9) from MLB StatsAPI.
// Shaped to match the Hottest Pitchers cards. [] on trouble -> page uses mock.
// -------------------------------------------------------------------------
async function pitchers() {
  const season = new Date().getUTCFullYear();
  const api = `${STATS}/stats?stats=season&group=pitching&gameType=R`
    + `&season=${season}&sportId=1&playerPool=Qualified&limit=300`;

  let r;
  try {
    r = await fetch(api, { headers: { accept: 'application/json' } });
  } catch (e) {
    return cors(json([], 30));
  }
  if (!r.ok) return cors(json([], 30));

  let data;
  try { data = await r.json(); } catch (e) { return cors(json([], 30)); }

  const splits = (data.stats && data.stats[0] && data.stats[0].splits) || [];
  const rows = splits
    .map((s) => {
      const st = s.stat || {};
      const k9 = toNum(st.strikeoutsPer9Inn);
      const era = (st.era === undefined || st.era === null) ? '—' : String(st.era);
      const k = typeof st.strikeOuts === 'number' ? st.strikeOuts : toNum(st.strikeOuts || st.strikeouts);
      return {
        id: (s.player || {}).id,
        name: shortName((s.player || {}).fullName),
        team: teamAbbr(s.team),
        k9,
        ip: toNum(st.inningsPitched),
        statVal: k9 ? k9.toFixed(1) : '—',
        statLabel: 'K/9 · season',
        chip1: era + ' ERA',
        chip2: k + ' K',
        cmp: [
          { k: 'K/9', v: k9 ? k9.toFixed(1) : '—' },
          { k: 'ERA', v: era },
          { k: 'K', v: String(k) },
        ],
      };
    })
    .filter((x) => x.name && x.k9 > 0 && x.ip >= 40)
    .sort((a, b) => b.k9 - a.k9)
    .slice(0, 10);

  await attachSplits(rows, 'pitching'); // opponent OPS vs LHB / vs RHB
  return cors(json(rows, 300));
}

// Attach real handedness splits (OPS vs L / vs R) to leader rows, in one bulk
// call. For hitters this is their OPS by pitcher hand; for pitchers it's the
// opponent OPS-against by batter hand. Silently no-ops if unavailable.
async function attachSplits(rows, group) {
  const ids = rows.map((r) => r.id).filter(Boolean);
  if (!ids.length) return;
  const season = new Date().getUTCFullYear();
  try {
    const r = await fetch(`${STATS}/people?personIds=${ids.join(',')}&hydrate=stats(group=[${group}],type=[statSplits],sitCodes=[vl,vr],season=${season})`, { headers: { accept: 'application/json' } });
    if (!r.ok) return;
    const d = await r.json();
    const byId = {};
    (d.people || []).forEach((pl) => {
      const m = {};
      (((pl.stats || [])[0] || {}).splits || []).forEach((sp) => {
        const code = sp.split && sp.split.code;
        if (code === 'vl' || code === 'vr') m[code] = toNum((sp.stat || {}).ops);
      });
      byId[pl.id] = m;
    });
    rows.forEach((row) => {
      const m = byId[row.id];
      if (!m) return;
      if (m.vl != null) { row.splitL = ops3(m.vl); row.splitLnum = Math.round(m.vl * 1000); }
      if (m.vr != null) { row.splitR = ops3(m.vr); row.splitRnum = Math.round(m.vr * 1000); }
    });
  } catch (e) { /* leave rows without splits -> table falls back */ }
}

// -------------------------------------------------------------------------
// ESPN probable-pitcher fallback.
//
// StatsAPI stays the source of record. Everything downstream is keyed to its
// person ids -- season stats, the K and hits projections, grading from box
// scores, proj_log, picks.pitcher_id -- so a probable that cannot be resolved
// back to one of those ids is useless to us no matter who published it.
//
// It also posts LATE. Measured 2026-09-12: StatsAPI was missing 2 of 30 sides
// that day and 4 of 30 the next, where ESPN had 29 and 30. The gap widens the
// further ahead you look, and one day ahead is exactly where this board is
// trying to be -- opening lines are soft before the market sharpens them. A
// missing probable is silent: projFor() returns null, the arm drops off the K
// board and the batter board loses its opposing-arm context, and nothing errors.
//
// FALLBACK ONLY. A side StatsAPI has already named is never touched. The feeds
// do genuinely disagree -- CWS read Sean Newcomb on StatsAPI and Luis Castillo
// on ESPN the day this was written -- and preferring one would mean
// adjudicating staleness on every render. Silently swapping out a pitcher the
// model has already projected is a worse failure than showing none.
// -------------------------------------------------------------------------

// cdn.espn.com, NOT site.api.espn.com: the latter 403s from Workers (the same
// wall the NFL grader hit). The date parameter here is `date` SINGULAR --
// site.api's `dates` is accepted and then silently ignored, serving a cached
// current-day scoreboard, which looks like real data for the wrong day.
const ESPN_MLB_SB = 'https://cdn.espn.com/core/mlb/scoreboard?xhr=1&date=';
// ESPN spells some clubs differently. OAK/WAS are defensive: not seen on the
// current card, but historical ESPN data used both.
const ESPN_TEAM_FIX = { CHW: 'CWS', ARI: 'AZ', OAK: 'ATH', WAS: 'WSH' };

// Implied team runs, as an H+R+RBI projection input.
//
// H+R+RBI is two-thirds runs and RBI, which depend far more on how much a
// team scores than on the hitter alone, and the projection barely saw it.
// Backtested on 5,763 graded H+R+RBI rows (2026-07-28..09-16), joined to
// DraftKings totals and moneylines for all 689 games via ESPN:
//
//   implied team runs   projected   actual   actual/projected   under plays
//   2.7-3.6               1.46       1.58        1.09           136, +11.6%
//   3.6-4.0               1.49       1.65        1.11           236,  +1.8%
//   4.0-4.3               1.52       1.75        1.15           347,  +1.2%
//   4.3-4.6               1.54       1.77        1.15           425,  -2.5%
//   4.6-6.5               1.60       2.10        1.31           553,  -7.6%
//
// Actuals rise 33% from the weakest offenses to the strongest; the projection
// rose 10%. The model posted its MOST unders on the highest-scoring teams, where
// they lost. Fit on the first half and scored on the second: the negative-
// binomial log-likelihood improves by 5.5 on one parameter (p~0.001), beta 0.5 on
// closing lines and 0.6 on opening lines, and the calibration constant fitted
// alongside it did not move (1.173 either way), so this sits on top of
// BATTER_PROJ_CAL rather than replacing any of it.
//
// What the backtest did NOT show: better betting results. On the held-out half
// the adjusted under plays went -1.1% (n=166) against -0.1% (n=192); the picks it
// dropped and added were too few to read. This ships because the projection is
// measurably more accurate, not because a profit has been demonstrated.
//
// Total Bases is deliberately untouched: the same test found zero out-of-sample
// gain. TB is the hitter's own contact and power, which the model already has.
//
// No line posted yet (overnight, or ESPN has nothing) -> multiplier 1.0, the same
// neutral default every other matchup input uses.
const ITT_BETA = 0.5;
const ITT_MEAN = 4.17;          // mean implied team runs across the backtest rows (DK closing lines)
const ITT_MULT_LO = 0.75;
const ITT_MULT_HI = 1.30;

const parseAmerican = (v) => {
  const t = String(v == null ? '' : v).trim().toUpperCase();
  if (t === 'EVEN' || t === 'EV') return 100;
  const n = Number(t.replace('+', ''));
  return isFinite(n) && Math.abs(n) >= 100 ? n : null;
};
const americanProb = (a) => (a > 0 ? 100 / (a + 100) : -a / (-a + 100));

// Game total split between the two clubs by their de-vigged win probability,
// converted to a run ratio with the Pythagorean exponent (1.83). Returns
// { away, home } in runs, or null if the line is incomplete.
function impliedTeamRuns(total, awayML, homeML) {
  const t = Number(total), a = parseAmerican(awayML), h = parseAmerican(homeML);
  if (!(t > 0) || a == null || h == null) return null;
  const pa = americanProb(a), ph = americanProb(h);
  const pHome = ph / (pa + ph);
  if (!(pHome > 0 && pHome < 1)) return null;
  const ratio = Math.pow(pHome / (1 - pHome), 1 / 1.83);
  const home = t * ratio / (1 + ratio);
  return { away: t - home, home };
}

// ESPN's scoreboard carries DraftKings' pre-game total and both moneylines, at no
// credit cost. Returns 'AWAY@HOME' -> [{ startMs, away, home }] (implied runs),
// several entries for a doubleheader. Empty on any failure.
async function espnGameLines(date) {
  const out = {};
  try {
    const r = await fetch(ESPN_MLB_SB + String(date).replace(/-/g, ''), { headers: { accept: 'application/json' } });
    if (!r.ok) return out;
    const d = await r.json();
    for (const ev of ((((d.content || {}).sbData || {}).events) || [])) {
      const comp = (ev.competitions || [])[0] || {};
      const side = {};
      for (const c of (comp.competitors || [])) {
        const raw = String(((c.team || {}).abbreviation) || '').toUpperCase();
        side[c.homeAway] = ESPN_TEAM_FIX[raw] || raw;
      }
      const o = (comp.odds || [])[0];
      if (!o || !side.away || !side.home) continue;
      const ml = o.moneyline || {};
      const pickML = (k) => {
        const x = ml[k] || {};
        return (x.close && x.close.odds) || (x.current && x.current.odds) || (x.open && x.open.odds) || null;
      };
      const runs = impliedTeamRuns(o.overUnder, pickML('away'), pickML('home'));
      if (!runs) continue;
      const key = `${side.away}@${side.home}`;
      (out[key] || (out[key] = [])).push({ startMs: Date.parse(ev.date) || 0, away: runs.away, home: runs.home });
    }
  } catch (e) { /* neutral this render */ }
  return out;
}

// Strip accents and case so ESPN's unaccented spelling compares equal to the
// accented one StatsAPI returns (Urena/Urena, Rodon/Rodon, Perez/Perez).
const plainName = (v) => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

// `date` is 'YYYY-MM-DD'; ESPN wants 'YYYYMMDD'. Returns team abbreviation ->
// pitcher name, abbreviations normalised to StatsAPI's spelling.
async function espnProbables(date) {
  const byTeam = {};
  try {
    const r = await fetch(ESPN_MLB_SB + String(date).replace(/-/g, ''), { headers: { accept: 'application/json' } });
    if (!r.ok) return byTeam;
    const d = await r.json();
    const evs = (((d.content || {}).sbData || {}).events) || [];
    for (const ev of evs) {
      const comp = (ev.competitions || [])[0];
      for (const c of ((comp && comp.competitors) || [])) {
        const raw = String(((c.team || {}).abbreviation) || '').toUpperCase();
        if (!raw) continue;
        const abbr = ESPN_TEAM_FIX[raw] || raw;
        // A doubleheader puts a club on the card twice and nothing here says
        // which game a name belongs to. Poison the entry rather than guess.
        if (Object.prototype.hasOwnProperty.call(byTeam, abbr)) { byTeam[abbr] = null; continue; }
        const pr = (c.probables || [])[0];
        byTeam[abbr] = (pr && pr.athlete && pr.athlete.displayName) || null;
      }
    }
  } catch (e) { /* no fallback this render */ }
  return byTeam;
}

// One search call covers every name. Returns name -> { id, fullName }.
async function resolvePitcherIds(names) {
  const out = {};
  if (!names.length) return out;
  try {
    const r = await fetch(`${STATS}/people/search?names=${encodeURIComponent(names.join(','))}&sportId=1`,
      { headers: { accept: 'application/json' } });
    if (!r.ok) return out;
    const people = ((await r.json()).people) || [];
    for (const nm of names) {
      // Pitchers only, and only when the name lands on exactly one of them.
      // 'Eury Perez' returns a pitcher and a left fielder; 'Jose Ramirez' a
      // pitcher and a third baseman. Ambiguity is skipped, never guessed -- a
      // wrong id would hang another player's season line on the projection.
      const hits = people.filter((pl) => plainName(pl.fullName) === plainName(nm)
        && ((pl.primaryPosition || {}).abbreviation === 'P'));
      if (hits.length === 1) out[nm] = { id: hits[0].id, fullName: hits[0].fullName };
    }
  } catch (e) { /* leave the holes */ }
  return out;
}

// Mutates the schedule games in place, filling ONLY the sides StatsAPI left
// empty. Returns how many were filled. Costs no request at all on a day where
// there are none, which is the common case for tonight.
async function fillMissingProbables(games, date) {
  const holes = [];
  for (const g of (games || [])) {
    for (const side of ['away', 'home']) {
      const t = g.teams && g.teams[side];
      if (!t || (t.probablePitcher && t.probablePitcher.id)) continue;
      const abbr = teamAbbr(t.team);
      if (abbr) holes.push({ t, abbr });
    }
  }
  if (!holes.length) return 0;
  const byTeam = await espnProbables(date);
  const wanted = [];
  for (const h of holes) {
    const nm = byTeam[h.abbr];
    if (!nm) continue;
    h.name = nm;
    if (!wanted.includes(nm)) wanted.push(nm);
  }
  if (!wanted.length) return 0;
  const ids = await resolvePitcherIds(wanted);
  let filled = 0;
  for (const h of holes) {
    const hit = h.name && ids[h.name];
    if (!hit) continue;
    // Shaped exactly like StatsAPI's own probablePitcher so every consumer
    // downstream reads it without knowing where it came from. probableSource is
    // the only addition, so a row sourced this way stays identifiable.
    h.t.probablePitcher = { id: hit.id, fullName: hit.fullName };
    h.t.probableSource = 'espn';
    filled += 1;
  }
  return filled;
}

// -------------------------------------------------------------------------
// /api/board — tonight's real slate with a transparent projected-K model.
//   projK = pitcherK/9 × (expectedIP / 9) × (opponentK% / leagueK%)
//   80% interval from a Poisson spread around projK.
// Real matchups + probable pitchers from the schedule; stats join the
// projection. Degrades gracefully (defaults) if a stats feed hiccups; []
// if the schedule itself fails, so the page uses its Odds-API slate.
// -------------------------------------------------------------------------
async function board(env, ctx, opts) {
  const season = new Date().getUTCFullYear();
  let date = slateDate(); // the site's slate day, in Pacific time

  const fetchSlate = async (d) => {
    try {
      const r = await fetch(`${STATS}/schedule?sportId=1&date=${d}&hydrate=probablePitcher,linescore,team`, { headers: { accept: 'application/json' } });
      if (!r.ok) return null;
      return await r.json();
    } catch (e) { return null; }
  };

  let sched = await fetchSlate(date);
  if (!sched) return cors(json([], 60));
  let games = (sched.dates && sched.dates[0] && sched.dates[0].games) || [];

  // Roll a day ahead into projections once tonight's slate is done — every game
  // Final (or none today). Projections appear immediately from the probable
  // pitchers; odds/edges fill in as books post — moneyline/run line the night
  // before, props in the morning. Staying a day ahead is how you get on soft
  // opening lines before the market sharpens them. (Paid prop calls are gated to
  // games near first pitch below, so this doesn't burn quota overnight.)
  const allFinal = games.length > 0 && games.every((g) => (g.status && g.status.abstractGameState) === 'Final');
  if (!games.length || allFinal) {
    const nextDate = slateDateOffset(1);
    const next = await fetchSlate(nextDate);
    const nextGames = next ? ((next.dates && next.dates[0] && next.dates[0].games) || []) : [];
    if (nextGames.length) { date = nextDate; sched = next; games = nextGames; }
  }
  if (!games.length) return cors(json([], 60));

  // Fill probables StatsAPI has not posted yet. Fallback only, and a no-op on
  // days where it has posted them all -- most days for tonight, fewer for
  // tomorrow, which is where the board spends its time.
  await fillMissingProbables(games, date);

  // Real strikeout prop lines (paid Odds API player props), keyed by pitcher
  // name. Per-event requests — cached 5 min below to protect the quota.
  const propByName = {};
  const key = env && env.ODDS_API_KEY;
  if (key) {
    try {
      const evR = await fetch(eventsUrl(key), { headers: { accept: 'application/json' } });
      if (ctx && ctx.waitUntil) ctx.waitUntil(recordOddsUsage(env, evR, 'board:events'));
      if (evR.ok) {
        const events = await evR.json();
        // Only price games that haven't started — a live game's pre-game prop is
        // gone, so the per-event call just burns Odds API quota for nothing. This
        // trims calls exactly through the afternoon/evening as games go live.
        const now = Date.now();
        // Kept alongside the upstream commenceTimeTo bound: that one cannot
        // express "already started", which is the other half of this filter.
        // Same scoping as batters(): a close-capture pass only needs the games
        // whose lines are about to vanish, not every game with a posted prop.
        const list = Array.isArray(events) ? events : [];
        // `date` is the slate this board is showing, which may already have
        // rolled to tomorrow — so early lines follow what is on screen.
        const upcoming = (opts && opts.closeOnly)
          ? closingSoon(events, opts.closeOnly)
          : list.filter((ev) => propTier(ev, now, date) === 'near');
        // Never on a close-capture pass: freezing a closing line must see the
        // live book, not a copy bought up to an hour ago.
        const earlyK = (opts && opts.closeOnly) ? [] : list.filter((ev) => propTier(ev, now, date) === 'early');
        const fetchK = async (ev, target) => {
          try {
            const pr = await fetch(`${ODDS}/events/${ev.id}/odds?apiKey=${key}&bookmakers=${Object.keys(PROP_BOOKS).join(',')}&markets=pitcher_strikeouts&oddsFormat=american&dateFormat=iso`, { headers: { accept: 'application/json' } });
            if (ctx && ctx.waitUntil) ctx.waitUntil(recordOddsUsage(env, pr, 'board:kprops'));
            if (!pr.ok) return `HTTP ${pr.status}`;
            const pd = await pr.json();
            for (const bm of (pd.bookmakers || [])) {
              const label = PROP_BOOKS[bm.key]; // DK/FD (bet) + MGM and the sharp pool (fair only)
              if (!label) continue;
              const mk = (bm.markets || []).find((m) => m.key === 'pitcher_strikeouts');
              if (!mk) continue;
              for (const oc of (mk.outcomes || [])) {
                const nm = normName(oc.description);
                if (!nm) continue;
                const rec = target[nm] || (target[nm] = {});
                const b = rec[label] || (rec[label] = {});
                if (oc.point != null) b.point = oc.point;
                if (oc.name === 'Over') b.over = oc.price;
                else if (oc.name === 'Under') b.under = oc.price;
              }
            }
            return null;
          } catch (e) { return null; /* skip this event */ }
        };
        await Promise.all(upcoming.map((ev) => fetchK(ev, propByName)));
        for (const b of earlyBuckets(earlyK, now)) {
          const got = await linesOnCadence(env, ctx, `kprop_lines_early:${LINES_STORE_VER}:${date}${b.suffix}`, b.ttlMs, b.events, fetchK);
          for (const [nm, rec] of Object.entries(got.data || {})) if (!propByName[nm]) propByName[nm] = rec;
        }
      }
    } catch (e) { /* no props -> projection-only board */ }
  }

  // Probable-pitcher season stats (one call for all of them).
  const pids = [];
  games.forEach((g) => ['away', 'home'].forEach((s) => {
    const pp = g.teams && g.teams[s] && g.teams[s].probablePitcher;
    if (pp && pp.id) pids.push(pp.id);
  }));
  const pmap = {};
  if (pids.length) {
    try {
      const r = await fetch(`${STATS}/people?personIds=${pids.join(',')}&hydrate=stats(group=[pitching],type=[season],season=${season})`, { headers: { accept: 'application/json' } });
      if (r.ok) {
        const d = await r.json();
        (d.people || []).forEach((pl) => {
          const sp = (((pl.stats || [])[0] || {}).splits || [])[0];
          const st = sp ? sp.stat : {};
          pmap[pl.id] = {
            k9: toNum(st.strikeoutsPer9Inn),
            // Read straight off the API the same way k9 is, rather than derived
            // from hits/IP, so the two rates cannot disagree about innings.
            h9: toNum(st.hitsPer9Inn),
            ip: toNum(st.inningsPitched),
            gs: toNum(st.gamesStarted),
            era: (st.era == null || st.era === '') ? null : String(st.era),
            hand: (pl.pitchHand && pl.pitchHand.code) || null,
          };
        });
      }
    } catch (e) { /* projections fall back to defaults */ }
  }

  // Live weather per game — temperature drives a small strikeout adjustment.
  // `fields`-filtered so each call returns only the weather subtree (light,
  // cached with the board). Degrades to neutral if unavailable.
  const wxByGame = {};
  await Promise.all(games.map(async (g) => {
    try {
      const r = await fetch(`https://statsapi.mlb.com/api/v1.1/game/${g.gamePk}/feed/live?fields=gameData,weather,condition,temp,wind`, { headers: { accept: 'application/json' } });
      if (!r.ok) return;
      const d = await r.json();
      const w = d && d.gameData && d.gameData.weather;
      if (w && (w.temp != null || w.condition)) wxByGame[g.gamePk] = { temp: toNum(w.temp), cond: w.condition || '', wind: w.wind || '' };
    } catch (e) { /* neutral weather for this game */ }
  }));

  // Team strikeout rate + league baseline (one call). The same response carries
  // hits, so the opponent context for the hits model rides along at no cost —
  // a second call would have bought a number already in this one.
  const teamK = {}; const teamH = {}; let lgSO = 0, lgPA = 0, lgHit = 0;
  try {
    const r = await fetch(`${STATS}/teams/stats?season=${season}&sportId=1&group=hitting&stats=season`, { headers: { accept: 'application/json' } });
    if (r.ok) {
      const d = await r.json();
      const splits = ((d.stats || [])[0] || {}).splits || [];
      splits.forEach((sp) => {
        const st = sp.stat || {};
        const id = sp.team && sp.team.id;
        const so = toNum(st.strikeOuts), pa = toNum(st.plateAppearances), hit = toNum(st.hits);
        if (id && pa > 0) { teamK[id] = so / pa; teamH[id] = hit / pa; lgSO += so; lgPA += pa; lgHit += hit; }
      });
    }
  } catch (e) { /* opponent adjustment falls back to neutral */ }
  const lgK = lgPA > 0 ? lgSO / lgPA : 0.222;
  const lgHrate = lgPA > 0 ? lgHit / lgPA : 0.2166;

  // Team win% (for the moneyline model) — one standings call.
  const teamWL = {};
  try {
    const r = await fetch(`${STATS}/standings?leagueId=103,104&season=${season}&standingsTypes=regularSeason`, { headers: { accept: 'application/json' } });
    if (r.ok) {
      const d = await r.json();
      (d.records || []).forEach((rec) => {
        (rec.teamRecords || []).forEach((tr) => {
          const id = tr.team && tr.team.id;
          if (id) teamWL[id] = { w: toNum(tr.wins), l: toNum(tr.losses) };
        });
      });
    }
  } catch (e) { /* moneyline model falls back to even teams */ }
  const teamWinP = (id) => {
    const r = teamWL[id];
    if (!r || (r.w + r.l) === 0) return 0.5;
    return (r.w + 10) / (r.w + r.l + 20); // shrink toward .500
  };

  // Real moneylines + run lines, in one call.
  //
  // Requested BY BOOK KEY rather than by region. The Odds API bills
  // markets x region-equivalents, and an explicit bookmaker list costs
  // ceil(books/10) = 1, where `regions=us,eu` costs 2 — so this halves the call
  // (4 credits -> 2) while returning identical prices. The batter prop path has
  // always done it this way; this one had not, and the per-route ledger put the
  // difference at ~300 credits a day.
  //
  // The old comment here claimed adding `spreads` cost no extra quota. It does:
  // billing is per market, and the ledger measured this call at exactly 4
  // credits = 2 markets x 2 regions. The run line was never free, it was just
  // never itemised.
  //
  // Only the three books actually consumed below are requested. Every reader is
  // filtered by key (dkfd = BOOKS, pin = REF_BOOK), so naming more would change
  // nothing except the size of the response. Widening this to the SHARP_BOOKS
  // pool for a median fair line costs the same 1 region-equivalent, but that
  // changes what the model calls fair, so it stays a separate decision.
  const ML_BOOKS = [...Object.keys(BOOKS), REF_BOOK].join(',');
  const mlByHome = {};   // DK/FD best price per side — what you'd actually bet
  const mlBookPairs = {}; // per-book {book,home,away} — real quotes, for de-vigging
  const pinByHome = {};  // Pinnacle price per side — the sharp fair line
  const totByHome = {};  // { soft: [{book,point,over,under}], pin: [...] } — logged only
  const rlByHome = {};   // DK/FD best run-line price+point per side
  const pinRlByHome = {}; // Pinnacle run-line price+point per side (sharp fair)
  if (key) {
    try {
      // h2h only since 2026-09-17. `spreads` was bought for the run line, which
      // is no longer logged or shown; at 2 markets per call it was half of this
      // route's credits (~40 a day). The route name changes with it, so the
      // usage ledger shows the drop rather than blending the two regimes.
      // + totals (2026-09-17), logged only — see TOT_EDGE_CHECK. Roughly the
      // credits the run line's spreads used to cost.
      const r = await fetch(`${ODDS}/odds?apiKey=${key}&bookmakers=${ML_BOOKS}&markets=h2h,totals&oddsFormat=american&dateFormat=iso`, { headers: { accept: 'application/json' } });
      if (ctx && ctx.waitUntil) ctx.waitUntil(recordOddsUsage(env, r, 'board:h2h+totals'));
      if (r.ok) {
        const events = await r.json();
        // Best moneyline price for a team name across a set of bookmakers.
        // One book's own two sides — the only pair that was ever really offered,
        // and so the only one with a meaningful overround to strip.
        const pairFrom = (b, homeName, awayName) => {
          const mk = (b.markets || []).find((m) => m.key === 'h2h');
          if (!mk) return null;
          const h = (mk.outcomes || []).find((x) => x.name === homeName);
          const a = (mk.outcomes || []).find((x) => x.name === awayName);
          return (h && a && h.price != null && a.price != null) ? { home: h.price, away: a.price } : null;
        };
        const priceFrom = (books, name) => {
          let best = null;
          for (const b of books) {
            const mk = (b.markets || []).find((m) => m.key === 'h2h');
            const o = mk && (mk.outcomes || []).find((x) => x.name === name);
            if (o && o.price != null && (best == null || payoutMult(o.price) > payoutMult(best))) best = o.price;
          }
          return best;
        };
        // Best run-line price for a team at the main ±1.5 line, with its point.
        const spreadFrom = (books, name) => {
          let best = null, point = null;
          for (const b of books) {
            const mk = (b.markets || []).find((m) => m.key === 'spreads');
            const o = mk && (mk.outcomes || []).find((x) => x.name === name && Math.abs(x.point) === 1.5);
            if (o && o.price != null) { point = o.point; if (best == null || payoutMult(o.price) > payoutMult(best)) best = o.price; }
          }
          return best == null ? null : { price: best, point };
        };
        const totalsFrom = (books) => books.map((b) => {
          const mk = (b.markets || []).find((m) => m.key === 'totals');
          if (!mk) return null;
          const o = (mk.outcomes || []).find((x) => x.name === 'Over');
          const u = (mk.outcomes || []).find((x) => x.name === 'Under');
          if (!o || !u || o.point == null || o.point !== u.point) return null;
          return { book: BOOKS[b.key] || 'PIN', point: o.point, over: o.price, under: u.price };
        }).filter(Boolean);
        (Array.isArray(events) ? events : []).forEach((ev) => {
          const bms = ev.bookmakers || [];
          const dkfd = bms.filter((b) => BOOKS[b.key]);
          const pin = bms.filter((b) => b.key === REF_BOOK);
          // Key by canonical abbreviation (same as the props matching) so an
          // Odds-vs-StatsAPI name difference (e.g. Athletics, AZ/ARI) can't miss.
          const k2 = keyAbbr(ev.home_team);
          if (dkfd.length) {
            mlByHome[k2] = { home: priceFrom(dkfd, ev.home_team), away: priceFrom(dkfd, ev.away_team) };
            // Per-book two-sided pairs, kept alongside the best-of. The best-of
            // pair is the right EXECUTION price (take the best number on the
            // side you bet) but it is not a market: pairing the most generous
            // home price from one book with the most generous away price from
            // another describes a quote nobody posted, and its overround is
            // compressed by the shopping itself. De-vigging that yields a fair
            // line built from two tails rather than either book's centre.
            mlBookPairs[k2] = dkfd
              .map((b) => ({ book: BOOKS[b.key], ...(pairFrom(b, ev.home_team, ev.away_team) || {}) }))
              .filter((p) => p.home != null && p.away != null);
            rlByHome[k2] = { home: spreadFrom(dkfd, ev.home_team), away: spreadFrom(dkfd, ev.away_team) };
          }
          totByHome[k2] = { soft: totalsFrom(dkfd), pin: totalsFrom(pin) };
          if (pin.length) {
            pinByHome[k2] = { home: priceFrom(pin, ev.home_team), away: priceFrom(pin, ev.away_team) };
            pinRlByHome[k2] = { home: spreadFrom(pin, ev.home_team), away: spreadFrom(pin, ev.away_team) };
          }
        });
      }
    } catch (e) { /* no moneylines -> ml/rl pick is model-only */ }
  }

  // Last-known moneylines from D1 — fallback when the live h2h feed stops
  // returning a price for a game (book pulled it pre-game, or it aged out).
  const savedLines = (env && env.DB) ? await loadMlLines(env.DB, date) : {};
  // Last-known strikeout props from D1 — keeps the closing line on the board
  // after the book pulls the market (see savePropLines).
  const savedProps = (env && env.DB) ? await loadPropLines(env.DB, date) : {};
  // Run lines are no longer bought, so there is nothing to fall back to — and
  // reading rl_lines on every board build would spend D1 reads for nothing.
  const savedRl = {};

  const rows = games.map((g) => {
    const away = g.teams.away, home = g.teams.home;
    // Venue + weather adjustments (shared by both starters in this game).
    const homeAbbr = teamAbbr(home.team);
    const parkK = PARK_K_FACTOR[homeAbbr] || 1;
    const wx = wxByGame[g.gamePk] || null;
    const wxK = weatherK(wx);
    const projFor = (side) => {
      const pp = g.teams[side].probablePitcher;
      if (!pp || !pp.id) return null;
      const st = pmap[pp.id] || {};
      const oppTeam = g.teams[side === 'away' ? 'home' : 'away'].team;
      const oppK = teamK[oppTeam.id] || lgK;
      const k9 = st.k9 > 0 ? st.k9 : 8.5;
      const expIP = clamp(st.gs > 0 ? st.ip / st.gs : 5.5, 4, 6.8);
      // Base rate model, then scale by park (strikeout factor) and weather (temp).
      const projK = (k9 * expIP / 9) * (lgK > 0 ? oppK / lgK : 1) * parkK * wxK * K_PROJ_CAL;
      const sd = Math.sqrt(Math.max(projK, 1) * DISPERSION);

      // Hits allowed, same shape. Projection only — no line is bought for this
      // market and nothing here is priced, tiered or posted.
      //
      // The pitcher's own H/9 is regressed toward league on the innings behind
      // it, so a short sample cannot carry a full-strength rate (see H_PRIOR_IP).
      // No park or weather term: PARK_K_FACTOR is a strikeout table and
      // PARK_FACTORS carries hr/tb, and neither is a hits factor — applying the
      // wrong one would move every projection in a direction nobody measured, so
      // this stays deliberately under-adjusted instead.
      const oppH = teamH[oppTeam.id] || lgHrate;
      const h9raw = st.h9 > 0 ? st.h9 : LG_H9_BASE;
      const ipSeen = st.ip > 0 ? st.ip : 0;
      const h9 = (h9raw * ipSeen + LG_H9_BASE * H_PRIOR_IP) / (ipSeen + H_PRIOR_IP);
      const projH = (h9 * expIP / 9) * (lgHrate > 0 ? oppH / lgHrate : 1) * H_PROJ_CAL;
      const sdH = Math.sqrt(Math.max(projH, 1) * HITS_DISPERSION);

      // Market: price the projection against the DK/FD strikeout lines, taking
      // the better of the two prices for the chosen side. When the live prop is
      // gone (book pulled it), fall back to the persisted closing line and mark
      // the market closed — shown, but no longer bettable.
      const nm = normName(pp.fullName);
      const liveProp = propByName[nm];
      const liveHasProp = liveProp && Object.keys(liveProp).length;
      const propRec = liveHasProp ? liveProp : savedProps[nm];
      const market = priceStrikeouts(propRec, projK);
      if (market && !liveHasProp) market.closed = true;

      return {
        id: pp.id,
        name: shortName(pp.fullName),
        fullName: pp.fullName,
        team: teamAbbr(g.teams[side].team),
        // 'espn' when StatsAPI had not posted this arm and the fallback filled
        // it in. Carried so a row sourced that way can be told apart instead of
        // blending in with the ones the league itself published.
        probableSource: g.teams[side].probableSource || 'statsapi',
        hand: st.hand || null,
        era: st.era || null,
        k9: round1(k9),
        proj: round1(projK),
        lo: round1(Math.max(0, projK - 1.28 * sd)),
        hi: round1(projK + 1.28 * sd),
        // Hits allowed. `h9` is the REGRESSED rate actually used, not the raw
        // season number — showing the raw one next to a projection built from
        // the shrunk one would make the arithmetic look wrong.
        h9: round1(h9),
        h9raw: round1(h9raw),
        projH: round1(projH),
        loH: round1(Math.max(0, projH - 1.28 * sdH)),
        hiH: round1(projH + 1.28 * sdH),
        oppHpct: Math.round(oppH * 1000) / 10,
        oppKpct: Math.round(oppK * 1000) / 10,
        parkK: Math.round(parkK * 1000) / 1000,
        park: homeAbbr,
        temp: wx && wx.temp > 0 ? wx.temp : null,
        wxCond: wx ? wx.cond : null,
        wxK: Math.round(wxK * 1000) / 1000,
        modeled: k9 !== 8.5,
        market,
        // PrizePicks' strikeout number for this starter, with the model's
        // probability of landing under IT — not under the DK/FD line, which is
        // often a different number.
        pp: ppQuote(propRec, (L) => {
          const lam = (1 - LINE_SHRINK) * projK + LINE_SHRINK * L;
          const sd2 = Math.sqrt(Math.max(lam, 1) * DISPERSION);
          return normCdf((L - lam) / sd2);
        }),
      };
    };

    const pitchers = [projFor('away'), projFor('home')].filter(Boolean);
    const status = (g.status && g.status.abstractGameState) || 'Preview';
    const ls = g.linescore || {};
    const aR = numOr(away.score, ls.teams && ls.teams.away && ls.teams.away.runs);
    const hR = numOr(home.score, ls.teams && ls.teams.home && ls.teams.home.runs);
    const hasScore = (status === 'Live' || status === 'Final') && aR != null && hR != null;

    // Row-level play: the pitcher with the biggest market edge (if any priced).
    const priced = pitchers.filter((p) => p.market && p.market.price != null);
    const lead = priced.length
      ? priced.reduce((m, p) => (!m || p.market.edge > m.market.edge ? p : m), null)
      : null;
    const projLean = pitchers.reduce((m, p) => (!m || p.proj > m.proj ? p : m), null);

    // Moneyline: price the DK/FD line you'd bet against Pinnacle's sharp fair
    // line. Prefer the live DK/FD price; fall back to the last-known line so
    // Edge/Tier survive once the book pulls it. Pinnacle is the fair reference.
    const gid = 'g' + g.gamePk;
    const hKey = keyAbbr(home.team && home.team.name);
    const livePair = mlByHome[hKey];
    const liveHasPrice = livePair && (livePair.home != null || livePair.away != null);
    const effPair = liveHasPrice ? livePair : (savedLines[gid] || null);
    const ml = moneyline(g, home, away, teamWinP, pmap, effPair, pinByHome[hKey] || null, mlBookPairs[hKey] || null);
    const tq = totByHome[hKey];
    const tot = tq ? totalsRead(tq.soft, tq.pin) : null;
    if (ml && !liveHasPrice && effPair) ml.lineStale = true; // shown from last-known line

    // Run line: Pinnacle fair + the log5 model (via ml) as the lean filter.
    // Falls back to the persisted closing spread when the live market is gone.
    const rlModelWin = ml ? ml.homeModelProb / 100 : 0.5;
    let rl = runLine(home, away, rlByHome[hKey] || null, pinRlByHome[hKey] || null, rlModelWin);
    if (!rl) {
      const s = savedRl[gid];
      if (s) { rl = runLine(home, away, s.rl || null, s.pin || null, rlModelWin); if (rl) rl.closed = true; }
    }

    return {
      id: 'g' + g.gamePk,
      matchup: `${teamAbbr(away.team)} @ ${teamAbbr(home.team)}`,
      pitcherNames: pitchers.map((p) => p.name),
      timeMs: Date.parse(g.gameDate) || 0,
      timeLabel: timeLabelPT(g.gameDate),
      status,
      score: hasScore ? `${aR}-${hR}` : null,
      pick: lead
        ? `${lead.name} ${lead.market.side === 'Over' ? 'O' : 'U'} ${lead.market.line} Ks`
        : (projLean ? `${projLean.name} proj ${projLean.proj} Ks` : '—'),
      odds: lead ? lead.market.price : null,
      oddsBooks: lead && !lead.market.closed ? lead.market.books : null,
      edge: lead ? lead.market.edge : null,
      tier: lead ? lead.market.tier : 'model',
      closed: lead ? !!lead.market.closed : false, // priced from a persisted closing line — not bettable
      interval: lead ? `${lead.lo} – ${lead.hi}` : (projLean ? `${projLean.lo} – ${projLean.hi}` : '—'),
      pitchers,
      ml,
      rl,
      tot,                 // game total vs Pinnacle — logged only, not rendered
    };
  }).sort((a, b) => a.timeMs - b.timeMs);

  // Log tonight's priced picks to the track record (idempotent) — non-blocking.
  if (env && env.DB) {
    const write = logPicks(env.DB, rows, date).catch(() => {});
    if (ctx && ctx.waitUntil) ctx.waitUntil(write);
    const writeMl = logMlPicks(env.DB, rows, date).catch(() => {});
    if (ctx && ctx.waitUntil) ctx.waitUntil(writeMl);
    const writeTot = logTotPicks(env.DB, rows, date).catch(() => {});
    if (ctx && ctx.waitUntil) ctx.waitUntil(writeTot);
    const ppK = [];
    for (const r of rows) {
      if (r.status !== 'Preview') continue;
      for (const p of (r.pitchers || [])) {
        if (p && p.pp && p.id != null) ppK.push({ gameId: r.id, playerId: p.id, player: p.fullName || p.name, team: p.team, market: 'K', pp: p.pp });
      }
    }
    const writePpK = logPpPicks(env.DB, ppK, date).catch(() => {});
    if (ctx && ctx.waitUntil) ctx.waitUntil(writePpK);
    // The run line is no longer logged (2026-09-17). It was logged to find out
    // whether the model read the 1.5 at all, and the record answered: 31-54,
    // -18.2u, -21.4% ROI on 85 graded games, 9-21 over its last two days, with
    // nothing posted on it. Rows already logged keep grading (gradeRlPicks is
    // untouched), so the pending ones still settle and the history stays on the
    // Track Record; nothing new is added to it.

    // Hits-allowed projections. Nothing here is a pick — this is the accuracy
    // record that has to exist before deciding whether the market is worth
    // buying lines for.
    const writeProj = saveProjLog(env.DB, date, rows).catch(() => {});
    if (ctx && ctx.waitUntil) ctx.waitUntil(writeProj);

    // Snapshot tonight's live strikeout props so the closing line survives the
    // book pulling the market (only entries we fetched live this window).
    if (Object.keys(propByName).length) {
      const wp = savePropLines(env.DB, date, propByName).catch(() => {});
      if (ctx && ctx.waitUntil) ctx.waitUntil(wp);
    }

    // Persist tonight's live moneylines so they survive the book pulling the
    // market — captured every window while a price is still offered.
    const livePairs = games.map((g) => {
      const home = g.teams.home, lp = mlByHome[keyAbbr(home.team && home.team.name)];
      return (lp && (lp.home != null || lp.away != null))
        ? { gameId: 'g' + g.gamePk, home: lp.home, away: lp.away } : null;
    }).filter(Boolean);
    if (livePairs.length) {
      const wl = saveMlLines(env.DB, date, livePairs).catch(() => {});
      if (ctx && ctx.waitUntil) ctx.waitUntil(wl);
    }

    // Persist tonight's live run lines (spread pairs) the same way — only games
    // that actually have a spread point posted this window.
    const hasPoint = (p) => p && ((p.home && p.home.point != null) || (p.away && p.away.point != null));
    const rlPairs = games.map((g) => {
      const hk = keyAbbr(g.teams.home.team && g.teams.home.team.name);
      const rlp = rlByHome[hk] || null, pinp = pinRlByHome[hk] || null;
      return (hasPoint(rlp) || hasPoint(pinp))
        ? { gameId: 'g' + g.gamePk, data: JSON.stringify({ rl: rlp, pin: pinp }) } : null;
    }).filter(Boolean);
    if (rlPairs.length) {
      const wr = saveRlLines(env.DB, date, rlPairs).catch(() => {});
      if (ctx && ctx.waitUntil) ctx.waitUntil(wr);
    }
  }

  // A finished game is nothing to act on, so it leaves the board as soon as it
  // goes Final. The result is not lost: it is in the track record, and while the
  // game was running it was in Live Now.
  //
  // Filtered HERE, after every logPicks/logMlPicks/logRlPicks/saveProjLog call
  // above, and deliberately not earlier. Those writes are what put a pick on the
  // record at all, and they run off this same array. Filtering before them would
  // mean a game that ended before anyone opened the page never got logged, never
  // got graded, and silently left the record — a far worse failure than a stale
  // row, and one nothing on the page would show.
  const openRows = rows.filter((r) => r.status !== 'Final');

  // 5 min near first pitch, 15 while the slate is still hours out — see
  // BOARD_TTL_NEAR. Props are the expensive part, and they do not move overnight.
  // Measured on what REMAINS: once the last game is final this is empty, which
  // ttlForSoonest reads as the near window, so the board clears promptly rather
  // than holding finished games for another 15 minutes.
  return cors(json(openRows, ttlForSoonest(soonestStart(openRows, 'timeMs'))));
}

// Moneyline for one game. Fair line = Pinnacle's de-vigged probability (the
// sharpest read available); edge = how much the DK/FD price you'd actually bet
// beats that fair number. If Pinnacle is missing we fall back to DK/FD-de-vig vs
// our log5 model, and if there's no market at all, to the model favorite.
// Moneyline edges against Pinnacle at or above this many points are flagged
// "check the news" rather than ranked as the strongest plays.
//
// Graded mlpicks through 2026-09-16, priced against Pinnacle, at the last
// recorded price:
//   edge 0-2.5    41-25   about +17%
//   edge 2.5-4     6-10   -23.7%
//   edge 4+       16-28   -24.6%     (these were Tier 1)
//   underdogs at 2.5+: 8-26, -42.4% (p=0.02); favourites at 2.5+: 14-12, -0.7%
// A DK/FD price several points better than the sharp book is rarely a gift. It
// usually means one of them has not caught up with news — a scratched starter,
// a bullpen game, a lineup or weather change — and the side that looks cheap is
// the stale one. The price move after entry agrees: our side lengthened 76% of
// the time. Small samples, and several slices were checked, so this is a flag
// and not a filter: the row still shows, with its number, labelled.
const ML_EDGE_CHECK = 2.5;

// Game totals — LOGGED ONLY, never shown or posted (2026-09-17).
//
// The same read as the moneyline: the best DK/FD over/under price against
// Pinnacle's de-vigged total at the SAME number, with the same "check" flag on
// big gaps. It exists to find out whether that read has anything in it for
// totals. Nothing here has been validated: our own runs model lost to the DK
// total in backtesting (MAE 3.55 vs 3.47, no information beyond the line), and
// the 2.5-point cutoff is copied from moneylines, where it was measured, as a
// starting point to test rather than a finding. Graded quietly into totpicks
// and summarised under `totals` on /api/track-record for reading; no tab.
const TOT_MODEL_VER = 'tot-pin-check25';
const TOT_EDGE_CHECK = 2.5;

// soft = [{ book, point, over, under }] for DK/FD; pin = same for Pinnacle.
// Returns the side whose DK/FD price beats Pinnacle's fair by more, or a row with
// side null when there is nothing to compare (no Pinnacle total, or the books
// hang a different number — a half-run apart is a different bet, not a price).
function totalsRead(soft, pin) {
  if (!soft || !soft.length) return null;
  const p = (pin || [])[0] || null;
  const none = (point, why) => ({ point, side: null, price: null, pinFair: null, edge: null, edgeKind: null, edgeCheck: false, why });
  if (!p) return none(soft[0].point, 'no Pinnacle total');
  const fairOver = shinDevig(p.over, p.under);
  if (fairOver == null) return none(p.point, 'Pinnacle total not two-sided');
  const same = soft.filter((q) => q.point === p.point);
  if (!same.length) return none(p.point, 'DK/FD on a different total than Pinnacle');
  const best = (k) => same.reduce((acc, q) => (q[k] != null && (acc == null || payoutMult(q[k]) > payoutMult(acc)) ? q[k] : acc), null);
  const bo = best('over'), bu = best('under');
  const eo = bo == null ? null : round1((fairOver - amProb(bo)) * 100);
  const eu = bu == null ? null : round1(((1 - fairOver) - amProb(bu)) * 100);
  if (eo == null && eu == null) return none(p.point, 'no DK/FD price');
  const over = eu == null || (eo != null && eo >= eu);
  const edge = over ? eo : eu;
  return {
    point: p.point, side: over ? 'Over' : 'Under', price: over ? bo : bu,
    pinFair: Math.round((over ? fairOver : 1 - fairOver) * 1e4) / 1e4,
    edge, edgeKind: 'sharp', edgeCheck: edge >= TOT_EDGE_CHECK,
  };
}

function moneyline(g, home, away, teamWinP, pmap, oddsPair, pinPair, bookPairs) {
  // log5 team model (kept as a fallback fair line and a reference number).
  const pH = teamWinP(home.team && home.team.id);
  const pA = teamWinP(away.team && away.team.id);
  let homeWin = (pH - pH * pA) / (pH + pA - 2 * pH * pA);
  if (!isFinite(homeWin)) homeWin = 0.5;
  homeWin += 0.035; // home-field advantage
  const eraOf = (pp) => { const s = pp && pp.id ? pmap[pp.id] : null; return s && s.era != null ? parseFloat(s.era) : null; };
  const hERA = eraOf(home.probablePitcher), aERA = eraOf(away.probablePitcher);
  if (hERA != null && aERA != null) homeWin += clamp((aERA - hERA) * 0.025, -0.08, 0.08);
  homeWin = clamp(homeWin, 0.05, 0.95);
  const model = { home: homeWin, away: 1 - homeWin };

  // De-vig a two-way price pair into a fair P(home), using Shin rather than
  // proportional normalisation. Moneylines carry far heavier favourites than
  // props, and that is exactly where splitting the margin proportionally goes
  // wrong: it under-states the favourite by ~0.7pt at -320 and ~0.9pt at -450,
  // against a T3 threshold of 1.0. Every favourite was being priced too cheap.
  const devigHome = (pair) => {
    if (!pair) return null;
    return shinDevig(pair.home, pair.away);
  };
  // The old proportional number, kept alongside so the choice of method can be
  // settled by which one lands closer to the close rather than by theory.
  const devigHomeMult = (pair) => {
    if (!pair) return null;
    const iH = amProb(pair.home), iA = amProb(pair.away);
    if (iH == null || iA == null) return null;
    const v = iH + iA;
    return v > 0 ? iH / v : iH;
  };
  const pinFairH = devigHome(pinPair);   // sharp fair (preferred) — one book's pair
  const pinMultH = devigHomeMult(pinPair); // same pair, old method — comparison only
  // Fallback fair when Pinnacle is missing: de-vig EACH soft book's own two
  // sides, then take the median. Never the best-of pair, which mixes one book's
  // most generous home price with another's most generous away price and so has
  // an overround produced by shopping rather than by any book's opinion.
  const softFair = (() => {
    const dvs = (bookPairs || [])
      .map((p) => shinDevig(p.home, p.away))
      .filter((v) => v != null && isFinite(v));
    return dvs.length ? median(dvs) : null;
  })();
  // Last resort only: no per-book pair survived, so fall back to the best-of.
  const dkFairH = softFair != null ? softFair : devigHome(oddsPair);
  let fairH, fairSource;
  if (pinFairH != null) { fairH = pinFairH; fairSource = 'pinnacle'; }
  else if (dkFairH != null) { fairH = dkFairH; fairSource = 'dkfd'; }
  else { fairH = model.home; fairSource = 'model'; }

  const price = oddsPair || {}; // the DK/FD price you'd actually bet
  const sideFor = (side) => {
    const teamObj = side === 'home' ? home.team : away.team;
    const fair = side === 'home' ? fairH : 1 - fairH; // sharp true prob for this side
    const pr = side === 'home' ? price.home : price.away;
    let edge = null;
    if (fairSource === 'pinnacle') {
      // Value of the DK/FD price vs Pinnacle's fair number (the real +EV read).
      const imp = amProb(pr);
      edge = imp == null ? null : round1((fair - imp) * 100);
    } else if (fairSource === 'dkfd') {
      // No sharp line — fall back to our model vs the soft de-vig.
      edge = round1((model[side] - fair) * 100);
    }
    return {
      side, teamAbbr: teamAbbr(teamObj),
      winProb: Math.round(fair * 100), price: pr != null ? pr : null, edge,
      fairProb: Math.round(fair * 10000) / 10000,
      modelProb: Math.round(model[side] * 100),
    };
  };
  const h = sideFor('home'), a = sideFor('away');

  // Bet the side with the larger edge; with no edge, name the fair favorite.
  let chosen;
  if (h.edge == null || a.edge == null) chosen = fairH >= 0.5 ? h : a;
  else chosen = h.edge >= a.edge ? h : a;

  const e = chosen.edge;
  // Which kind of edge this is. Against Pinnacle it is price shopping — the
  // DK/FD number vs the sharp book's fair. Without Pinnacle it is our log5 model
  // vs the soft market, a different claim that used to share the same column
  // with nothing to tell them apart.
  const edgeKind = fairSource === 'pinnacle' ? 'sharp' : fairSource === 'dkfd' ? 'model' : null;
  // A big gap to Pinnacle is a warning, not a stronger play. See ML_EDGE_CHECK.
  const edgeCheck = fairSource === 'pinnacle' && e != null && e >= ML_EDGE_CHECK;
  const tier = e == null ? 'model'
    : edgeCheck ? 'check'
    : e >= 4 ? 1 : e >= 2.5 ? 2 : e >= 1 ? 3 : 'pass';
  return {
    pick: `${chosen.teamAbbr} ML`,
    teamAbbr: chosen.teamAbbr,
    winProb: chosen.winProb,   // fair (sharp) win prob of the pick
    // The same fair, unrounded. winProb is whole points, which at even money
    // moves EV against the close by up to ~1% -- too coarse to measure with.
    fairProb: chosen.fairProb,
    price: chosen.price,       // DK/FD price you'd bet
    edge: e,
    tier,
    edgeKind,                  // 'sharp' (vs Pinnacle) | 'model' (log5 vs DK/FD) | null
    edgeCheck,                 // true -> gap to Pinnacle too large to trust; check the news
    fairSource,                // 'pinnacle' | 'dkfd' | 'model'
    // Shin vs proportional on the same sharp pair, in points. Lets the de-vig
    // method be judged empirically instead of assumed.
    devigDeltaPts: (pinFairH != null && pinMultH != null) ? round1((pinFairH - pinMultH) * 100) : null,
    homeAbbr: h.teamAbbr, awayAbbr: a.teamAbbr,
    homeWinProb: h.winProb, awayWinProb: a.winProb,        // fair probs
    homeModelProb: h.modelProb, awayModelProb: a.modelProb, // log5 model, for reference
  };
}

// Run line (±1.5) for one game — same philosophy as the moneyline. Pinnacle's
// de-vigged run line is the fair number; edge = how much the DK/FD price you'd
// bet beats it. Layered on top: the log5 win model is a LEAN FILTER — a value
// side is only surfaced as a pick when the model agrees the game breaks that
// way (a confident favorite backs -1.5; a competitive dog backs +1.5).
const RL_FAV_LEAN = 0.55; // model win% needed to back a -1.5 favorite
const RL_DOG_LEAN = 0.42; // model win% needed to back a +1.5 dog (live dog)
function runLine(home, away, rlPair, pinPair, modelHomeWin) {
  const rl = rlPair || {}, pin = pinPair || {};
  const hasPin = pin.home && pin.away && pin.home.price != null && pin.away.price != null;
  // Need at least a run-line point to know who's favored.
  const pointSrc = hasPin ? pin : rl;
  if (!pointSrc.home || pointSrc.home.point == null) return null; // no run line posted

  // Pinnacle de-vigged fair cover probability for the home side.
  let fairHomeCover = null, fairSource = 'none';
  if (hasPin) {
    const iH = amProb(pin.home.price), iA = amProb(pin.away.price);
    const v = iH + iA;
    fairHomeCover = v > 0 ? iH / v : iH;
    fairSource = 'pinnacle';
  }

  const sideFor = (side) => {
    const teamObj = side === 'home' ? home.team : away.team;
    const leg = side === 'home' ? rl.home : rl.away;
    const point = leg && leg.point != null ? leg.point : null;
    const pr = leg && leg.price != null ? leg.price : null;
    const fair = fairHomeCover == null ? null : (side === 'home' ? fairHomeCover : 1 - fairHomeCover);
    let edge = null;
    if (fairSource === 'pinnacle' && pr != null) {
      const imp = amProb(pr);
      edge = imp == null ? null : round1((fair - imp) * 100); // DK/FD value vs sharp fair
    }
    return { side, teamAbbr: teamAbbr(teamObj), point, price: pr,
             coverPct: fair == null ? null : Math.round(fair * 100), edge };
  };
  const h = sideFor('home'), a = sideFor('away');

  // Value side = the larger DK/FD-vs-Pinnacle edge (needs both to be priced).
  const chosen = (h.edge == null || a.edge == null) ? null : (h.edge >= a.edge ? h : a);

  // Lean filter: only call it a pick when the model agrees with the value side.
  const modelWin = { home: modelHomeWin, away: 1 - modelHomeWin };
  let modelAgrees = false, tier = 'pass';
  if (chosen && chosen.edge != null && chosen.point != null) {
    const mw = chosen.side === 'home' ? modelWin.home : modelWin.away;
    modelAgrees = chosen.point < 0 ? (mw >= RL_FAV_LEAN) : (mw >= RL_DOG_LEAN);
    if (modelAgrees) { const e = chosen.edge; tier = e >= 4 ? 1 : e >= 2.5 ? 2 : e >= 1 ? 3 : 'pass'; }
  }

  const modelFavHome = modelWin.home >= modelWin.away;
  return {
    pick: chosen ? `${chosen.teamAbbr} ${chosen.point > 0 ? '+' : ''}${chosen.point}` : null,
    teamAbbr: chosen ? chosen.teamAbbr : null,
    side: chosen ? (chosen.point < 0 ? 'fav' : 'dog') : null,
    point: chosen ? chosen.point : null,
    price: chosen ? chosen.price : null,
    edge: chosen ? chosen.edge : null,
    tier,
    modelAgrees,
    fairSource,                                  // 'pinnacle' | 'none'
    homeAbbr: h.teamAbbr, awayAbbr: a.teamAbbr,
    homePoint: h.point, awayPoint: a.point,
    homePrice: h.price, awayPrice: a.price,
    homeCoverPct: h.coverPct, awayCoverPct: a.coverPct,
    homeEdge: h.edge, awayEdge: a.edge,
    modelFavAbbr: modelFavHome ? h.teamAbbr : a.teamAbbr,
    modelFavPct: Math.round(Math.max(modelWin.home, modelWin.away) * 100),
  };
}

// -------------------------------------------------------------------------
// /api/batters — tonight's real batter props (HR, total bases, H+R+RBI) from
// the paid Odds API, priced against a per-game rate model. Percentile bars
// (power / slugging / contact / discipline) are computed from real season
// stats across the priced pool. Empty [] on any trouble so the tab degrades.
// -------------------------------------------------------------------------
const BATTER_MARKETS = [
  // fetch:false = still modelled and still shown, just not bought. Home runs
  // have never once cleared pricing: across 8,552 graded rows the market never
  // appears in byMarket, byMarketUnder or projBiasByMarket, because a 0.5 line
  // at a long price cannot pass the EV gate. Every per-event call was buying a
  // third market whose only use was to be discarded -- a third of the board's
  // single largest quota line item.
  //
  // Kept in this list rather than deleted, because the list is also what the
  // expand panel renders from (batterMarkets, below): dropping the entry would
  // have removed the visible "no line posted -- HR proj 0.3" row, which is fed
  // by lambda.hr off season stats and costs no quota at all. With no book data
  // the market prices to null exactly as it already does today, so the row is
  // unchanged.
  { key: 'batter_home_runs', label: 'HR', metric: 'hr', fetch: false },
  { key: 'batter_total_bases', label: 'TB', metric: 'tb' },
  { key: 'batter_hits_runs_rbis', label: 'H+R+RBI', metric: 'hrr' },
];
// The markets actually requested from the paid per-event endpoint. Billing is
// markets x region-equivalents per event, so this length is a direct multiplier
// on the biggest line item in the account.
const FETCHED_BATTER_MARKETS = BATTER_MARKETS.filter((m) => m.fetch !== false);
// The batter markets that can be posted as plays; the rest price and log only.
// Total bases left 2026-10-11 (see where tiers are set in batters()).
const BATTER_POSTED_METRICS = new Set(['hrr', 'hr']);

// ---- Opponent-context tunables for the batter projection ----
// Everything here defaults to NEUTRAL (×1.0) when data is missing, so a failed
// feed leaves the projection exactly at its season-rate baseline — this can only
// add signal, never break the working under edge. Kept moderate + regressed on
// purpose: an aggressive matchup swing could move projections off the edge.
const PLATOON_WEIGHT = 0.5;    // regress the vs-hand adjustment halfway to neutral
const PARK_WEIGHT = 0.7;       // apply published park factors at 70% strength
const MIN_SPLIT_PA = 40;       // below this the vs-hand sample is too thin to trust
// Opposing starter quality. A starter's season line is a far larger sample than
// a platoon split, so it earns more trust — but the batter only faces him for
// roughly two thirds of tonight's PA and the bullpen covers the rest, which
// dilutes the effect back down. 0.7 confidence x ~0.65 of PA lands near 0.45.
const PITCHER_WEIGHT = 0.45;
const MIN_PITCHER_BF = 100;    // below this the season line is noise -> neutral
// Widened from 0.75/1.30: with a third genuine factor in the product the old
// band would bind on ordinary matchups and quietly discard real signal.
const ADJ_LO = 0.70, ADJ_HI = 1.35; // no combined matchup multiplier past this band

// Published, stable single-park HR / total-base tendencies, keyed by StatsAPI
// venue name. Unlisted (or renamed/relocated) parks fall through to neutral 1.0,
// which is the safe default — a name miss just means no park adjustment.
const PARK_FACTORS = {
  'Coors Field': { hr: 1.28, tb: 1.18 },
  'Great American Ball Park': { hr: 1.22, tb: 1.08 },
  'Yankee Stadium': { hr: 1.18, tb: 1.06 },
  'Citizens Bank Park': { hr: 1.14, tb: 1.05 },
  'Fenway Park': { hr: 1.02, tb: 1.10 },
  'Wrigley Field': { hr: 1.05, tb: 1.03 },
  'Dodger Stadium': { hr: 1.06, tb: 1.01 },
  'Globe Life Field': { hr: 1.05, tb: 1.03 },
  'Chase Field': { hr: 1.03, tb: 1.04 },
  'Truist Park': { hr: 1.03, tb: 1.02 },
  'Nationals Park': { hr: 1.02, tb: 1.02 },
  'Rogers Centre': { hr: 1.04, tb: 1.03 },
  'Angel Stadium': { hr: 1.02, tb: 1.00 },
  'Busch Stadium': { hr: 0.96, tb: 0.99 },
  'Progressive Field': { hr: 0.97, tb: 0.99 },
  'Target Field': { hr: 0.98, tb: 1.00 },
  'Guaranteed Rate Field': { hr: 1.06, tb: 1.02 },
  'Rate Field': { hr: 1.06, tb: 1.02 },
  'Minute Maid Park': { hr: 1.02, tb: 1.02 },
  'Daikin Park': { hr: 1.02, tb: 1.02 },
  'PNC Park': { hr: 0.92, tb: 0.98 },
  'Kauffman Stadium': { hr: 0.90, tb: 1.02 },
  'Comerica Park': { hr: 0.91, tb: 0.99 },
  'loanDepot park': { hr: 0.90, tb: 0.95 },
  'T-Mobile Park': { hr: 0.91, tb: 0.94 },
  'Oracle Park': { hr: 0.84, tb: 1.00 },
  'Petco Park': { hr: 0.93, tb: 0.96 },
  'Oriole Park at Camden Yards': { hr: 0.95, tb: 0.99 },
  'Citi Field': { hr: 0.97, tb: 0.99 },
  'American Family Field': { hr: 1.03, tb: 1.01 },
  'Sutter Health Park': { hr: 1.05, tb: 1.05 },
  'George M. Steinbrenner Field': { hr: 1.10, tb: 1.05 },
};
// Park multiplier for a metric, compressed by PARK_WEIGHT. hrr rides a dampened
// total-base factor (hits/runs/rbi are less park-driven than raw HR/TB).
function parkFactor(venue, metric) {
  const f = venue && PARK_FACTORS[venue];
  if (!f) return 1;
  const raw = metric === 'hr' ? f.hr : metric === 'tb' ? f.tb : (1 + 0.6 * (f.tb - 1));
  return 1 + PARK_WEIGHT * (raw - 1);
}

// Upstream failure, described rather than swallowed.
//
// Every path in batters() used to return a bare [] — a quota exhaustion, a
// network error and a genuinely empty slate were indistinguishable to the
// client, so the board blamed the sportsbooks for an outage on our side. It told
// readers to "check back closer to first pitch" while the feed was returning 401
// OUT_OF_USAGE_CREDITS.
//
// The shape stays backwards-compatible in spirit: rows is still the payload, and
// feedError is null on the happy path.
async function feedErrorFrom(res) {
  let code = null, message = null;
  try {
    const body = await res.text();
    try {
      const j = JSON.parse(body);
      code = j.error_code || null;
      message = j.message || null;
    } catch (e) { message = body.slice(0, 200); }
  } catch (e) { /* body already consumed or unreadable */ }
  return {
    status: res.status,
    code,
    message,
    // The one distinction the UI acts on: out of credits is ours to fix, an
    // upstream 5xx is theirs, and both are different from "no lines yet".
    kind: code === 'OUT_OF_USAGE_CREDITS' || res.status === 401 || res.status === 429
      ? 'quota'
      : (res.status >= 500 ? 'upstream' : 'error'),
  };
}
// Cache-Control seconds for a board payload, and the freshness window for the
// shared line store below — deliberately the same number, so the two layers
// cannot expire out of step and re-fetch twice per window.
//
// A flat 300 was set when the board was only ever looked at near first pitch.
// It is the wrong number for the hours before that: a prop line hours from a
// start barely moves, but every 300s window still bought the whole slate again.
// The close is NOT captured through this cache — the cron calls board() and
// batters() directly with closeOnly — so lengthening the far window cannot cost
// a closing line, and the near window is left exactly where it was rather than
// tightened, so nothing about the last three hours changes.
// How many projection-only batter rows the board will carry. 40 was the whole
// board's size when no line existed anywhere, so this keeps that case unchanged.
const MODEL_ROW_CAP = 40;
const BOARD_TTL_NEAR = 300;
const BOARD_TTL_FAR = 900;
const TTL_FAR_MS = 3 * 3600 * 1000;
// `soonest` is the nearest FUTURE start, so a slate already underway returns
// null and holds the near TTL: those rows carry live status and scores, which
// is the one time a stale board is actually wrong rather than merely old.
function ttlForSoonest(soonestMs) {
  if (soonestMs == null) return BOARD_TTL_NEAR;
  return (soonestMs - Date.now()) > TTL_FAR_MS ? BOARD_TTL_FAR : BOARD_TTL_NEAR;
}
function soonestStart(rows, field) {
  const now = Date.now();
  let soonest = null;
  for (const r of (Array.isArray(rows) ? rows : [])) {
    const t = r && typeof r[field] === 'number' ? r[field]
      : (r && r[field] ? Date.parse(r[field]) : NaN);
    if (Number.isFinite(t) && t > now && (soonest == null || t < soonest)) soonest = t;
  }
  return soonest;
}
// ttlSec is passed in by batters() so the response and the shared line store
// expire on the same number. Derived from the slate's soonest start rather than
// the finished rows, because a board that priced nothing still knows perfectly
// well when the next first pitch is — and falling back to the near TTL there
// would re-buy an empty slate every five minutes.
// `slate` is counted BEFORE finished rows are dropped, and exists only because
// they are. The client's empty-state copy has to tell "books have not posted the
// two-way lines yet" from "the games are over and the books pulled them", and it
// read that off the Final rows themselves. Those no longer arrive, so the fact
// travels separately. Without it a board emptied by a finished slate tells the
// reader to check back closer to first pitch at midnight — which is precisely
// the bug that copy was written to fix.
// ?summary=1 — the same board, counted instead of listed. A full board is ~80
// rows of projection, market, percentile and matchup detail, which is a lot to
// move (and to read) when the question is only "is the board up, and how much of
// it has a line yet". That question gets asked by the scheduled checks, which
// have to read whatever they fetch — a large answer there is wasted for the same
// reason it is useful on the page.
//
// Derived from the real response rather than computed alongside it, so it cannot
// drift from what the board actually shows.
// The MLB game board, one line per game, for the scheduled checks: the full
// board carries every pitcher's projection detail, and a check only needs the
// moneyline and the strikeout read. Same fields the page shows, nothing derived.
async function boardSummary(res) {
  let games = null;
  try { games = await res.clone().json(); } catch (e) { return res; }
  if (!Array.isArray(games)) return res;
  const ttl = Number((/max-age=(\d+)/.exec(res.headers.get('cache-control') || '') || [])[1]) || null;
  const out = games.map((g) => {
    const ml = g.ml || null;
    const pickModel = ml && ml.teamAbbr
      ? (ml.teamAbbr === ml.homeAbbr ? ml.homeModelProb : ml.awayModelProb) : null;
    return {
      matchup: g.matchup, time: g.timeLabel, status: g.status, score: g.score || null,
      ml: ml ? {
        pick: ml.pick, price: ml.price, fairWinProb: ml.winProb, modelWinProb: pickModel,
        edge: ml.edge, tier: ml.tier, fairSource: ml.fairSource,
        edgeCheck: !!ml.edgeCheck, lineStale: !!ml.lineStale,
      } : null,
      k: (g.pitchers || []).map((p) => ({
        name: p.name, team: p.team, proj: p.proj,
        line: p.market ? p.market.line : null, price: p.market ? p.market.price : null,
        edge: p.market ? p.market.edge : null,
        pp: p.pp ? { point: p.pp.point, modelUnder: p.pp.modelUnder } : null,
      })),
    };
  });
  return cors(json({ games: out.length, priced: out.filter((g) => g.ml && g.ml.price != null).length, byGame: out }, ttl || 300));
}

async function battersSummary(res) {
  let body = null;
  try { body = await res.clone().json(); } catch (e) { return res; }
  const rows = (body && body.rows) || [];
  // A play is what the board marks Play: a priced under the model backs.
  const isPlay = (r) => !r.pulled && r.odds != null && (r.tier === 'play' || ['1', '2', '3'].includes(String(r.tier)));
  const byGame = new Map();
  for (const r of rows) {
    const g = byGame.get(r.matchup) || { matchup: r.matchup, timeLabel: r.timeLabel, rows: 0, priced: 0, plays: 0, pulled: 0, inLineup: 0, status: r.status };
    g.rows++;
    if (r.odds != null) g.priced++;
    if (isPlay(r)) g.plays++;
    // Pulled and in-lineup are how a check can tell a posted card from a game
    // still waiting on one: before the card, both are zero.
    if (r.pulled) g.pulled++;
    if (r.lineupSlot) g.inLineup++;
    byGame.set(r.matchup, g);
  }
  // Named, not just counted, so a check after lineups post can say which plays
  // survived and which were scratched. Capped: the summary stays a summary.
  const plays = rows.filter(isPlay)
    .sort((a, b) => (b.edge ?? -99) - (a.edge ?? -99))
    .slice(0, 20)
    .map((r) => ({ name: r.name, team: r.team, game: r.matchup, time: r.timeLabel, pick: r.pick, odds: r.odds, edge: r.edge }));
  const pulledPlays = rows.filter((r) => r.pulled && r.wasEdge != null)
    .sort((a, b) => b.wasEdge - a.wasEdge)
    .slice(0, 15)
    .map((r) => ({ name: r.name, team: r.team, game: r.matchup, wasPick: r.wasPick, wasEdge: r.wasEdge }));
  const games = [...byGame.values()].sort((a, b) => (a.timeLabel || '').localeCompare(b.timeLabel || ''));
  const ttl = Number((/max-age=(\d+)/.exec(res.headers.get('cache-control') || '') || [])[1]) || null;
  return cors(json({
    rows: rows.length,
    priced: rows.filter((r) => r.odds != null).length,
    pulled: rows.filter((r) => r.pulled).length,
    playCount: rows.filter(isPlay).length,
    plays,
    pulledPlays,
    // Every scratched batter, as "Name TEAM". /api/top-legs ranks legs from the
    // morning's log and cannot see a scratch, so this is what a check reads to
    // flag a Today's-card leg whose player is not in tonight's lineup.
    pulledNames: rows.filter((r) => r.pulled).map((r) => `${r.name} ${r.team || ''}`.trim()),
    games: games.length,
    gamesWithALine: games.filter((g) => g.priced > 0).length,
    slate: (body && body.slate) || null,
    feedError: (body && body.feedError) || null,
    ttlSec: ttl,
    byGame: games,
  }, ttl || 300));
}

const battersPayload = (rows, feedError, ttlSec, slate) => cors(json(
  { rows, feedError: feedError || null, slate: slate || null },
  // An EMPTY board never takes the long TTL. Every way of ending up with no rows
  // is temporary and about to change by itself — the slate just went final and is
  // about to roll, or the books have not posted and the next refresh will find
  // them — so caching that answer for 15 minutes holds an empty page in front of
  // readers long after there is something to show. The far TTL exists for a
  // board full of rows whose lines are not moving, which is the opposite case.
  feedError ? 30
    : (!rows || !rows.length) ? BOARD_TTL_NEAR
      : (ttlSec || ttlForSoonest(soonestStart(rows, 'timeMs'))),
));

async function batters(env, ctx, opts) {
  const season = new Date().getUTCFullYear();
  const key = env && env.ODDS_API_KEY;

  // 1) Which events are on, and their batter prop lines (DK/FD), per player.
  //
  // The odds feed supplies PRICES, not the slate. It used to be fetched first
  // and returned on failure, which meant one 401 blanked a board whose model
  // half -- lineups, opposing arm, park, projections -- comes from StatsAPI and
  // was still perfectly healthy. Every other board (K props, ML, run line)
  // degrades to model-only in that situation; this one went dark. So the fetch
  // is now non-fatal: record the error, carry on, and price whatever we can.
  let events = [];
  let feedError = null;
  if (!key) {
    feedError = { status: 0, code: 'NO_KEY', message: 'ODDS_API_KEY is not configured', kind: 'config' };
  } else {
    try {
      const evR = await fetch(eventsUrl(key), { headers: { accept: 'application/json' } });
      if (ctx && ctx.waitUntil) ctx.waitUntil(recordOddsUsage(env, evR, 'batters:events'));
      if (!evR.ok) feedError = await feedErrorFrom(evR);
      else {
        const ev = await evR.json();
        if (Array.isArray(ev)) events = ev;
      }
    } catch (e) {
      feedError = { status: 0, code: 'FETCH_FAILED', message: String((e && e.message) || e), kind: 'upstream' };
    }
  }

  // Map each "AWAY@HOME" to its real MLB gamePk + status, so batter picks can
  // be logged and later graded from the boxscore (needs the gamePk). The same
  // request hydrates posted starting lineups: once a manager's card is up we
  // know who actually plays tonight and where they bat.
  const schedByMatchup = {};
  const gameByTeamId = {};          // teamId -> tonight's game identity (matchup/time/status)
  const sideByTeamId = {};          // teamId -> 'away' | 'home' (for implied team runs)
  const lineupSlotById = {};        // playerId -> batting slot 1-9
  const lineupById = {};            // playerId -> { name, teamId } for posted starters
  const lineupPostedTeamIds = new Set(); // teams whose lineup is posted
  const oppPPIdByTeamId = {};       // teamId -> the OPPONENT's probable pitcher id
  const oppPPNameByTeamId = {};     // teamId -> that pitcher's name (display/debug)
  const parkByTeamId = {};          // teamId -> tonight's venue name (for park factor)
  const ppIds = new Set();          // probable-pitcher ids to resolve throwing hand
  // The slate this board is showing. Starts as today in Pacific time and rolls a
  // day ahead once tonight is over — the same rule /api/board has always used.
  // Without it the batter board simply emptied when the last game went Final and
  // stayed empty until the next morning, while the strikeout board next to it was
  // already showing tomorrow. Everything downstream keys off this: the schedule
  // read, the line store, and the date picks are logged and graded under.
  let slateYmd = slateDate();
  const fetchBatterSlate = async (d) => {
    try {
      // Adds probablePitcher (opposing arm) + venue (park factor) to the same
      // schedule call — no extra request, and both feed the batter projection.
      const r = await fetch(`${STATS}/schedule?sportId=1&date=${d}&hydrate=team,lineups,probablePitcher,venue`, { headers: { accept: 'application/json' } });
      if (!r.ok) return null;
      const sd = await r.json();
      return (((sd.dates || [])[0] || {}).games) || [];
    } catch (e) { return null; }
  };
  try {
    let sdGames = await fetchBatterSlate(slateYmd);
    const doneForToday = Array.isArray(sdGames)
      && (!sdGames.length || sdGames.every((g) => (g.status && g.status.abstractGameState) === 'Final'));
    if (doneForToday) {
      const nextYmd = slateDateOffset(1);
      const nextGames = await fetchBatterSlate(nextYmd);
      // Only roll if tomorrow actually has games — in the offseason, or the day
      // after the last one, staying put is what shows the correct empty board.
      if (nextGames && nextGames.length) { slateYmd = nextYmd; sdGames = nextGames; }
    }
    if (sdGames) {
      // Same fallback as /api/board. Here a missing probable is even quieter:
      // the opposing arm just goes neutral, so every batter facing an
      // unannounced starter is silently modelled against a league-average one.
      await fillMissingProbables(sdGames, slateYmd);
      sdGames.forEach((g) => {
        // Key by team NAME through the same table the Odds events use, so
        // StatsAPI abbreviations that differ (e.g. AZ vs ARI) still match.
        const away = keyAbbr((g.teams.away.team || {}).name), home = keyAbbr((g.teams.home.team || {}).name);
        // Score comes free with this response — no extra hydration and no extra
        // request. It was being dropped, which is why the batter board (the only
        // one that posts plays) was the only board that could not show a score
        // once a game started, while /api/board carried one all along.
        schedByMatchup[`${away}@${home}`] = {
          gamePk: g.gamePk,
          status: (g.status && g.status.abstractGameState) || 'Preview',
          awayScore: numOr(g.teams.away.score, null),
          homeScore: numOr(g.teams.home.score, null),
        };
        // Same identity the props loop stamps onto a priced player, but keyed by
        // team so a lineup-seeded batter can find his game without the odds feed.
        const ident = {
          matchup: `${away} @ ${home}`,
          timeMs: Date.parse(g.gameDate) || 0,
          timeLabel: timeLabelPT(g.gameDate),
          gamePk: g.gamePk,
          gameStatus: (g.status && g.status.abstractGameState) || 'Preview',
          awayScore: numOr(g.teams.away.score, null),
          homeScore: numOr(g.teams.home.score, null),
        };
        if (g.teams.away.team && g.teams.away.team.id) { gameByTeamId[g.teams.away.team.id] = ident; sideByTeamId[g.teams.away.team.id] = 'away'; }
        if (g.teams.home.team && g.teams.home.team.id) { gameByTeamId[g.teams.home.team.id] = ident; sideByTeamId[g.teams.home.team.id] = 'home'; }

        const lp = g.lineups || {};
        [['awayPlayers', g.teams.away.team], ['homePlayers', g.teams.home.team]].forEach(([k, team]) => {
          const arr = lp[k] || [];
          if (!arr.length || !team || !team.id) return;
          lineupPostedTeamIds.add(team.id);
          arr.forEach((p, i) => {
            if (!p || !p.id) return;
            lineupSlotById[p.id] = i + 1;
            // Name + team are what the model-only path needs to seed a row when
            // no book has priced this player.
            if (p.fullName) lineupById[p.id] = { name: p.fullName, teamId: team.id };
          });
        });
        // Each team's batters face the OTHER team's probable pitcher; both share
        // the venue. Missing pitcher/venue just leaves that team at neutral.
        const venueName = (g.venue && g.venue.name) || null;
        const awayTeam = g.teams.away.team, homeTeam = g.teams.home.team;
        const awayPP = g.teams.away.probablePitcher, homePP = g.teams.home.probablePitcher;
        if (awayTeam && awayTeam.id) { parkByTeamId[awayTeam.id] = venueName; if (homePP && homePP.id) { oppPPIdByTeamId[awayTeam.id] = homePP.id; oppPPNameByTeamId[awayTeam.id] = homePP.fullName || null; } }
        if (homeTeam && homeTeam.id) { parkByTeamId[homeTeam.id] = venueName; if (awayPP && awayPP.id) { oppPPIdByTeamId[homeTeam.id] = awayPP.id; oppPPNameByTeamId[homeTeam.id] = awayPP.fullName || null; } }
        if (awayPP && awayPP.id) ppIds.add(awayPP.id);
        if (homePP && homePP.id) ppIds.add(homePP.id);
      });
    }
  } catch (e) { /* no gamePk mapping -> batter picks just won't be logged */ }

  // Resolve each probable pitcher's throwing hand (one light StatsAPI call; the
  // basic person record carries pitchHand). teamId -> 'L' | 'R' of the arm its
  // batters face tonight. Any failure leaves oppHandByTeamId empty -> neutral.
  // The same call also hydrates his season pitching line, so we keep WHO he is
  // rather than only which arm he throws with. Facing an ace instead of a
  // replacement arm moves a batter's expectation more than platoon and park
  // combined, and the request was already being paid for.
  const oppHandByTeamId = {};
  const oppPitcherByTeamId = {};    // teamId -> { bf, hr, tb, hrr } allowed, season totals
  if (ppIds.size) {
    try {
      const r = await fetch(`${STATS}/people?personIds=${[...ppIds].join(',')}&hydrate=stats(group=[pitching],type=[season],season=${season})`, { headers: { accept: 'application/json' } });
      if (r.ok) {
        const d = await r.json();
        const handById = {}, lineById = {};
        (d.people || []).forEach((pl) => {
          handById[pl.id] = (pl.pitchHand && pl.pitchHand.code) || null;
          // Sum every season split, not just the first: a pitcher traded
          // mid-year comes back as one split per team, and taking [0] would
          // model him off a fraction of his work.
          const sp = (((pl.stats || [])[0] || {}).splits) || [];
          if (!sp.length) return;
          let bf = 0, h = 0, hr = 0, d2 = 0, t3 = 0, runs = 0, tbOk = true;
          for (const s of sp) {
            const st = s.stat || {};
            bf += toNum(st.battersFaced); h += toNum(st.hits); hr += toNum(st.homeRuns);
            runs += toNum(st.runs); d2 += toNum(st.doubles); t3 += toNum(st.triples);
            if (st.doubles == null || st.triples == null) tbOk = false;
          }
          if (!(bf > 0)) return;
          lineById[pl.id] = {
            bf,
            hr,
            // Total bases allowed, built the same way the batter side counts
            // them. If doubles/triples are absent from the split the sum would
            // silently degrade to singles+HR and understate TB, so tbOk gates it
            // to null (neutral) rather than a wrong number.
            tb: tbOk ? h + d2 + 2 * t3 + 3 * hr : null,
            // H+R+RBI has no clean pitching analogue (RBI is not charged to a
            // pitcher), but runs allowed tracks RBI allowed closely league-wide,
            // so H+R is used on BOTH sides of the ratio and the omitted RBI term
            // largely cancels.
            hrr: h + runs,
          };
        });
        for (const teamId of Object.keys(oppPPIdByTeamId)) {
          const pid = oppPPIdByTeamId[teamId];
          const hd = handById[pid];
          if (hd === 'L' || hd === 'R') oppHandByTeamId[teamId] = hd;
          if (lineById[pid]) oppPitcherByTeamId[teamId] = lineById[pid];
        }
      }
    } catch (e) { /* no hands/quality -> both stay neutral */ }
  }

  const marketKeys = FETCHED_BATTER_MARKETS.map((m) => m.key).join(',');
  const byName = {}; // normName -> { name, matchup, timeMs, timeLabel, props:{metric:{DK,FD}} }
  // Skip started games — no pre-game props to fetch, so don't spend the quota
  // (batter markets cost more: 3 markets per event vs. 1 for strikeouts).
  const nowB = Date.now();
  // closeOnly: only the games about to start need their closing line frozen, so
  // the other dozen are not re-priced to do it.
  // The same PROP_LEAD_MS gate board() applies to strikeouts. This path was the
  // one without it, and it is the costly one: three markets per event, so every
  // game beyond the lead window was three credits spent to receive a book list
  // no one has posted yet. Overnight the board rolls a day ahead and shows
  // projections; that is the designed behaviour, and prices now fill in on the
  // same schedule the strikeout board has always used.
  // Implied team runs per club for tonight, from ESPN's copy of the DraftKings
  // line. Matched by matchup and, for a doubleheader, by the nearer start time.
  const ittByTeamId = {};
  {
    const lines = await espnGameLines(slateYmd);
    for (const teamId of Object.keys(gameByTeamId)) {
      const g = gameByTeamId[teamId], side = sideByTeamId[teamId];
      if (!g || !side) continue;
      const cands = lines[String(g.matchup || '').replace(' @ ', '@')] || [];
      let best = null;
      for (const c of cands) {
        const gap = Math.abs((c.startMs || 0) - (g.timeMs || 0));
        if (gap <= 4 * 3600e3 && (!best || gap < best.gap)) best = { gap, c };
      }
      if (best) ittByTeamId[teamId] = best.c[side];
    }
  }
  const slateYmdB = slateYmd;
  const upcomingB = opts && opts.closeOnly
    ? closingSoon(events, opts.closeOnly)
    : events.filter((ev) => propTier(ev, nowB, slateYmdB) === 'near');
  // Today's games still further out than PROP_LEAD_MS — see propTier.
  const earlyB = opts && opts.closeOnly ? [] : events.filter((ev) => propTier(ev, nowB, slateYmdB) === 'early');
  // A per-event props failure used to return silently, so a whole slate of 401s
  // looked identical to a slate with no props posted. Keep the first one.
  let propsFeedError = null;

  // Has another colo already bought this window's lines? (see feed_cache.) The
  // store is keyed by the markets actually requested, so changing that list can
  // never serve lines for a market mix the board is no longer asking for.
  //
  // closeOnly is deliberately excluded: freezing a closing line is the one job
  // that must see the live book, never a copy bought minutes ago.
  const boardTtlSec = ttlForSoonest(soonestStart(upcomingB, 'commence_time'));
  const linesTtlMs = boardTtlSec * 1000;
  const feedKey = `batter_lines:${LINES_STORE_VER}:${slateYmd}:${marketKeys}`;
  const useStore = !!(env && env.DB) && !(opts && opts.closeOnly);
  let doFetch = true;
  let seeded = null;
  if (useStore) {
    const hit = await loadFeedCache(env.DB, feedKey);
    if (hit.present && hit.ageMs < linesTtlMs) {
      doFetch = false; seeded = hit.data;          // fresh — nobody pays
    } else if (await claimFeedRefresh(env.DB, feedKey, linesTtlMs)) {
      doFetch = true;                              // we own this window's refresh
    } else if (hit.present) {
      doFetch = false; seeded = hit.data;          // someone else is refreshing; serve what we have
    }
    // Cold store AND we lost the claim: fall through and fetch. Paying twice
    // once beats opening the board empty.
  }
  // Every line — fetched now, read from a store, near or early — goes through
  // this one rehydrate, in the stored shape. Status and score are re-derived from
  // tonight's schedule rather than stored: the lines are what was bought, but a
  // score read from cache would be wrong the moment the game moves.
  const seedInto = (stored) => {
    for (const [nm, s] of Object.entries(stored || {})) {
      if (!s || !s.props || byName[nm]) continue;       // near lines take precedence
      // The same windows the fetch paths apply. Without this a stored line would
      // outlive its game and quote a price on something already underway.
      const t = s.timeMs || 0;
      if (!propTierAt(t, nowB, slateYmdB)) continue;
      const sc = schedByMatchup[`${s.awayAb}@${s.homeAb}`] || null;
      byName[nm] = {
        name: s.name, matchup: `${s.awayAb} @ ${s.homeAb}`,
        timeMs: t, timeLabel: s.timeLabel,
        gamePk: sc ? sc.gamePk : null, gameStatus: sc ? sc.status : 'Preview',
        awayScore: sc ? sc.awayScore : null, homeScore: sc ? sc.homeScore : null,
        props: s.props,
      };
    }
  };
  const fetchBatter = async (ev, target) => {
    try {
      // Explicit bookmaker list rather than `regions=us`: it pulls the sharp fair
      // sources (which sit outside the us region) at the same 1 region-equivalent
      // price, since Odds API bills ceil(books/10) and we ask for 7.
      const r = await fetch(`${ODDS}/events/${ev.id}/odds?apiKey=${key}&bookmakers=${Object.keys(PROP_BOOKS).join(',')}&markets=${marketKeys}&oddsFormat=american&dateFormat=iso`, { headers: { accept: 'application/json' } });
      if (ctx && ctx.waitUntil) ctx.waitUntil(recordOddsUsage(env, r, 'batters:props'));
      if (!r.ok) { const fe = await feedErrorFrom(r); if (!propsFeedError) propsFeedError = fe; return fe; }
      const d = await r.json();
      const awayAb = keyAbbr(ev.away_team);
      const homeAb = keyAbbr(ev.home_team);
      for (const bm of (d.bookmakers || [])) {
        const label = PROP_BOOKS[bm.key]; // DK/FD = bet, MGM + sharps = fair only
        if (!label) continue;
        for (const spec of BATTER_MARKETS) {
          const mk = (bm.markets || []).find((m) => m.key === spec.key);
          if (!mk) continue;
          for (const oc of (mk.outcomes || [])) {
            const nm = normName(oc.description);
            if (!nm) continue;
            // Two same-named hitters quoted in different games must stay two
            // records; merging them priced one man's line off the other's.
            // The row loop strips the qualifier and resolves the player by game.
            let slot = nm;
            if (target[slot] && (target[slot].awayAb !== awayAb || target[slot].homeAb !== homeAb)) slot = `${nm}|${awayAb}@${homeAb}`;
            const rec = target[slot] || (target[slot] = { name: oc.description, awayAb, homeAb, timeMs: Date.parse(ev.commence_time) || 0, timeLabel: timeLabelPT(ev.commence_time), props: {} });
            const mp = rec.props[spec.metric] || (rec.props[spec.metric] = {});
            const b = mp[label] || (mp[label] = {});
            if (oc.point != null) b.point = oc.point;
            if (oc.name === 'Over') b.over = oc.price;
            else if (oc.name === 'Under') b.under = oc.price;
          }
        }
      }
      return null;
    } catch (e) { return null; /* skip this event */ }
  };

  if (seeded) seedInto(seeded);
  if (doFetch && upcomingB.length) {
    const fresh = {};
    await Promise.all(upcomingB.map((ev) => fetchBatter(ev, fresh)));
    seedInto(fresh);
    // Publish what we just bought so the next colo does not buy it again. Only
    // on a clean fetch that actually produced lines: caching a slate emptied by
    // a 401 would spread the outage to every colo for the rest of the window,
    // and the whole point of the store is that one colo's bad luck is not
    // everyone's.
    if (useStore && !propsFeedError && Object.keys(fresh).length) {
      const w = saveFeedCache(env.DB, feedKey, fresh);
      if (ctx && ctx.waitUntil) ctx.waitUntil(w); else await w;
    }
  }
  for (const b of earlyBuckets(earlyB, nowB)) {
    const got = await linesOnCadence(env, ctx, `batter_lines_early:${LINES_STORE_VER}:${slateYmdB}:${marketKeys}${b.suffix}`, b.ttlMs, b.events, fetchBatter);
    seedInto(got.data);
  }
  if (propsFeedError && !feedError) feedError = propsFeedError;

  // No priced players -- but that does not mean nothing is knowable. Everything
  // the projection needs (batting slot when posted, opposing arm, park, season
  // rates) comes from StatsAPI, which is independent of the odds feed. The
  // seeding happens below, once season stats are in hand, because the player
  // universe has to come from the stats pool when no lineup card is up yet.
  // Which GAMES the books have quoted, not whether any game was quoted. The
  // seeding below used to be all-or-nothing across the slate: one priced game
  // switched it off for every other, so a game the books had not posted yet
  // vanished from the board entirely — no row, no projection, no note. On
  // 2026-09-15 that hid every hitter facing Yamamoto and Misiorowski, which
  // reads as "the model passed on them" and is indistinguishable from "that
  // game does not exist tonight". Per game, an unquoted game is seeded from the
  // schedule while its quoted neighbours keep the book's own player list.
  const gameKeyOfRec = (rec) => (rec && rec.gamePk != null ? `g${rec.gamePk}` : (rec && rec.matchup) || null);
  const gameKeyOfTeam = (teamId) => gameKeyOfRec(gameByTeamId[teamId]);
  const pricedGames = new Set(Object.values(byName).map(gameKeyOfRec).filter(Boolean));
  // Nothing priced AND no game on the schedule: genuinely nothing to show.
  if (!Object.keys(byName).length && !Object.keys(gameByTeamId).length) return battersPayload([], feedError, boardTtlSec);

  // 2) Season hitting stats for every batter, keyed by name for matching.
  //
  // A name is NOT a player. Books quote hitters by name, so matching has to go
  // through the name — but it used to store one player per name, and the last one
  // read won. On 2026-09-17 there were two Max Muncys (Dodgers 3B, Athletics SS):
  // the Athletics' overwrote the Dodger, so the Dodger's line in LAD @ CIN was
  // priced off the other man's season, at Tropicana Field, against Tampa's
  // starter and the Athletics' implied runs — and posted as a play at +104.
  //
  // So every candidate is kept, and statFor() picks the one actually in the game
  // the line (or the seed) came from. Ambiguous and nobody in that game -> no row,
  // rather than a confident projection of the wrong person.
  const statsByName = {};
  try {
    const r = await fetch(`${STATS}/stats?stats=season&group=hitting&gameType=R&season=${season}&sportId=1&playerPool=All&limit=2000`, { headers: { accept: 'application/json' } });
    if (r.ok) {
      const d = await r.json();
      ((d.stats || [])[0] || {}).splits?.forEach((s) => {
        const nm = normName((s.player || {}).fullName);
        // fullName is kept for display: the key is normalized, so it can't be
        // shown, and the model-only path has no book description to fall back on.
        if (nm) (statsByName[nm] || (statsByName[nm] = [])).push({ st: s.stat || {}, id: (s.player || {}).id, name: (s.player || {}).fullName || null, team: teamAbbr(s.team), teamId: (s.team || {}).id });
      });
    }
  } catch (e) { /* projections fall back to rate-only where possible */ }
  const allStats = Object.values(statsByName).flat();
  // The season-stat entry for the player named `nm` who is in `rec`'s game.
  // Identity is by team id against tonight's schedule, not by abbreviation, so a
  // spelling difference between feeds cannot mis-assign anyone.
  const statFor = (nm, rec) => {
    const cands = statsByName[nm] || [];
    if (cands.length <= 1) return cands[0] || null;       // unique name: as before
    const inGame = cands.filter((c) => {
      const g = c.teamId != null ? gameByTeamId[c.teamId] : null;
      return g && rec && g.matchup === rec.matchup;
    });
    if (!inGame.length) return null;                     // shared name, neither is in this game
    // One player listed twice (traded mid-season, one split per club) is still
    // one player: take the split with the most plate appearances.
    if (new Set(inGame.map((c) => c.id)).size > 1) return null;   // two same-named players in ONE game
    return inGame.sort((a, b) => toNum((b.st || {}).plateAppearances) - toNum((a.st || {}).plateAppearances))[0];
  };

  // 2a) Model-only seeding, per game. A game the books have not quoted still has
  // everything the projection needs — batting slot once the card is up, opposing
  // arm, park, season rates — all from StatsAPI, which is independent of the odds
  // feed. So it gets rows carrying a projection and no price, rather than being
  // dropped. A game the books HAVE quoted is left alone: there the book's list is
  // the universe, and seeding it would add players nobody can price.
  //
  // Preference order matters, and it is per club. A posted lineup card is fact,
  // so it wins outright for that club. Before the card goes up -- most of the
  // day, since they post ~3h out -- fall back to its qualified hitters from the
  // season pool. That is a projection of who plays, not a claim about it, and it
  // self-corrects: the moment a card posts, the slot filter in step 3 drops
  // everyone not on it.
  {
    const seed = (name, teamId) => {
      const g = gameByTeamId[teamId];
      if (!g) return;
      const nm = normName(name);
      if (!nm) return;
      // The key is the name, so a namesake already seeded for ANOTHER game gets a
      // team-qualified key instead of silently taking this player's place. The
      // row loop strips the qualifier and resolves by game (statFor).
      let slot = nm;
      if (byName[slot]) {
        if (byName[slot].matchup === g.matchup) return;    // same player, same game: already there
        slot = `${nm}|${teamId}`;
        if (byName[slot]) return;
      }
      byName[slot] = {
        name, matchup: g.matchup, timeMs: g.timeMs, timeLabel: g.timeLabel,
        gamePk: g.gamePk, gameStatus: g.gameStatus,
        awayScore: g.awayScore, homeScore: g.homeScore,
        props: {},               // no book quotes -> no line, no price, no edge
      };
    };
    // Each club's hitters by season plate appearances — playing time is the best
    // available predictor of who is in tonight's card.
    const paByTeam = {};
    for (const st of allStats) {
      if (!st.teamId || !gameByTeamId[st.teamId]) continue;
      (paByTeam[st.teamId] || (paByTeam[st.teamId] = [])).push({ name: st.name, pa: toNum((st.st || {}).plateAppearances) });
    }
    const cardByTeam = {};
    for (const pid of Object.keys(lineupById)) {
      const l = lineupById[pid];
      (cardByTeam[l.teamId] || (cardByTeam[l.teamId] = [])).push(l);
    }
    for (const teamId of Object.keys(gameByTeamId)) {
      const key = gameKeyOfTeam(teamId);
      if (key && pricedGames.has(key)) continue;   // the books have this game
      if (cardByTeam[teamId]) {
        cardByTeam[teamId].forEach((l) => seed(l.name, l.teamId));
      } else {
        (paByTeam[teamId] || []).sort((a, b) => b.pa - a.pa).slice(0, 9)
          .forEach((x) => x.name && seed(x.name, teamId));
      }
    }
  }

  // 2b) Platoon splits: each batter's TB / HR / (H+R+RBI) per PA vs LHP and vs
  // RHP, so tonight's projection can lean on how he hits the hand he's facing.
  // One bulk statSplits call (chunked for URL length); any miss -> no platoon
  // adjustment for that batter, i.e. neutral. splitByPlayerId[id] = { L, R }
  // where each side is { pa, hr, tb, hrr } season totals for that split.
  const splitByPlayerId = {};
  const batterIds = [...new Set(allStats.map((x) => x.id).filter(Boolean))];
  const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
  await Promise.all(chunk(batterIds, 100).map(async (ids) => {
    try {
      const r = await fetch(`${STATS}/people?personIds=${ids.join(',')}&hydrate=stats(group=[hitting],type=[statSplits],sitCodes=[vl,vr],season=${season})`, { headers: { accept: 'application/json' } });
      if (!r.ok) return;
      const d = await r.json();
      (d.people || []).forEach((pl) => {
        const m = {};
        (((pl.stats || [])[0] || {}).splits || []).forEach((sp) => {
          const code = sp.split && sp.split.code;
          const st = sp.stat || {};
          if (code !== 'vl' && code !== 'vr') return;
          const pa = toNum(st.plateAppearances);
          m[code === 'vl' ? 'L' : 'R'] = { pa, hr: toNum(st.homeRuns), tb: toNum(st.totalBases), hrr: toNum(st.hits) + toNum(st.runs) + toNum(st.rbi) };
        });
        if (m.L || m.R) splitByPlayerId[pl.id] = m;
      });
    } catch (e) { /* this chunk stays neutral */ }
  }));

  // 2c) League baseline, aggregated from the same hitting pool we already
  // fetched. What every batter collectively does per PA IS what every pitcher
  // collectively allows per batter faced, so this is the correct denominator for
  // a pitcher's rates — and it self-calibrates each season instead of drifting
  // against a hardcoded constant. H+R is used (not H+R+RBI) to match the pitcher
  // side, where RBI isn't charged.
  const lg = { pa: 0, hr: 0, tb: 0, hrr: 0 };
  for (const cand of allStats) {
    const s = cand.st || {};
    lg.pa += toNum(s.plateAppearances);
    lg.hr += toNum(s.homeRuns);
    lg.tb += toNum(s.totalBases);
    lg.hrr += toNum(s.hits) + toNum(s.runs);
  }
  const lgRate = lg.pa > 0
    ? { hr: lg.hr / lg.pa, tb: lg.tb / lg.pa, hrr: lg.hrr / lg.pa }
    : null;

  // 3) Build priced rows; collect pool arrays for percentile bars.
  const pool = { iso: [], slg: [], contact: [], disc: [] };
  const draft = [];
  for (const nm of Object.keys(byName)) {
    const rec = byName[nm];
    const match = statFor(nm.split('|')[0], rec);
    if (!match) continue;              // no stats, or a shared name we cannot place -> skip
    const st = match.st;
    const gp = toNum(st.gamesPlayed), pa = toNum(st.plateAppearances);
    if (gp < 10 || pa < 30) continue;  // too small a sample to model
    // Confirmed lineups: if this batter's team has posted tonight's card and
    // he's not on it, he isn't starting — drop him rather than price a dead
    // pick. If he IS on it, project tonight's PA from his batting slot
    // instead of his historical average (leadoff sees ~a full PA more than
    // the 9-hole). No card posted yet -> behave exactly as before.
    // He is not starting. Until now that was a `continue`, so the row simply
    // vanished — including a row someone had already starred, with nothing on
    // screen to say why it went. It is projected anyway and marked pulled: the
    // work is local arithmetic and costs no upstream call, and knowing what the
    // row WOULD have been is the whole content of the alert ("was a play at
    // +3.4%"). The display fields are stripped at emit, so a pulled row cannot
    // show a number that assumed plate appearances he will not take.
    const slot = lineupSlotById[match.id] || 0;
    const pulled = !slot && !!match.teamId && lineupPostedTeamIds.has(match.teamId);
    const expPA = slot ? SLOT_PA[slot - 1] : pa / gp;
    const hr = toNum(st.homeRuns), tb = toNum(st.totalBases);
    const hits = toNum(st.hits), runs = toNum(st.runs), rbi = toNum(st.rbi);
    const iso = Math.max(0, toNum(st.slg) - toNum(st.avg));
    const kpct = pa > 0 ? toNum(st.strikeOuts) / pa : 0;
    const bbpct = pa > 0 ? toNum(st.baseOnBalls) / pa : 0;
    pool.iso.push(iso); pool.slg.push(toNum(st.slg)); pool.contact.push(1 - kpct); pool.disc.push(bbpct);

    const baseRate = { hr: hr / pa, tb: tb / pa, hrr: (hits + runs + rbi) / pa };

    // Opponent context. facingHand = the arm this batter's lineup faces tonight;
    // split = his per-PA production vs that hand; venue drives the park factor.
    // Each multiplier is regressed and the product clamped, so a thin split or an
    // extreme park can't yank the projection — and any missing piece = ×1.0.
    const facingHand = oppHandByTeamId[match.teamId] || null;
    const split = splitByPlayerId[match.id] || null;
    const venue = parkByTeamId[match.teamId] || null;
    const platoonMult = (metric) => {
      if (!facingHand || !split) return 1;
      const s = facingHand === 'L' ? split.L : split.R;
      if (!s || !(s.pa >= MIN_SPLIT_PA) || !(baseRate[metric] > 0)) return 1;
      const ratio = (s[metric] / s.pa) / baseRate[metric];
      return 1 + PLATOON_WEIGHT * (ratio - 1);
    };
    // Opposing starter quality: his rate allowed per batter faced against the
    // league rate per PA. Same regressed-multiplier shape as platoon and park,
    // so a missing or thin pitching line is simply x1.0.
    const oppP = oppPitcherByTeamId[match.teamId] || null;
    const pitcherMult = (metric) => {
      if (!oppP || !lgRate || !(oppP.bf >= MIN_PITCHER_BF)) return 1;
      const allowed = oppP[metric];
      if (allowed == null || !(lgRate[metric] > 0)) return 1;
      const ratio = (allowed / oppP.bf) / lgRate[metric];
      if (!(ratio > 0) || !isFinite(ratio)) return 1;
      return 1 + PITCHER_WEIGHT * (ratio - 1);
    };
    const adj = {};
    for (const m of ['hr', 'tb', 'hrr']) {
      adj[m] = clamp(platoonMult(m) * parkFactor(venue, m) * pitcherMult(m), ADJ_LO, ADJ_HI);
    }
    // Implied team runs — H+R+RBI only, applied outside the matchup clamp because
    // that is how it was fitted: on top of projections that already carried it.
    const impliedRuns = ittByTeamId[match.teamId] != null ? ittByTeamId[match.teamId] : null;
    const ittMult = impliedRuns != null
      ? clamp(Math.pow(impliedRuns / ITT_MEAN, ITT_BETA), ITT_MULT_LO, ITT_MULT_HI)
      : 1;

    const lambda = {
      hr: baseRate.hr * expPA * BATTER_PROJ_CAL.hr * adj.hr,
      tb: baseRate.tb * expPA * BATTER_PROJ_CAL.tb * adj.tb,
      hrr: (slot ? baseRate.hrr * expPA : (hits + runs + rbi) / gp) * BATTER_PROJ_CAL.hrr * adj.hrr * ittMult,
    };
    const markets = {};
    for (const spec of BATTER_MARKETS) {
      markets[spec.metric] = priceBatterProp(rec.props[spec.metric], lambda[spec.metric], spec.metric);
    }
    // Total bases is priced and logged but not posted (2026-10-11, the owner's
    // call): 685 posted unders went 330-355, -80.8u (-11.8%), while H+R+RBI
    // held near 54% over 3,300. The tier it would have had rides along as
    // tierWas, so the logged-only record can still be read by it.
    for (const metric of Object.keys(markets)) {
      const m = markets[metric];
      if (m && !BATTER_POSTED_METRICS.has(metric) && m.tier && m.tier !== 'pass') { m.tierWas = m.tier; m.tier = 'pass'; }
    }
    // oppPFac = the pitcher-only multiplier per metric, kept separate from the
    // combined `adj` so a projection can be traced back to which factor moved it.
    const oppPFac = oppP ? { hr: round2(pitcherMult('hr')), tb: round2(pitcherMult('tb')), hrr: round2(pitcherMult('hrr')) } : null;
    draft.push({ nm, rec, match, st, lambda, iso, slg: toNum(st.slg), kpct, bbpct, markets, slot, pulled, facingHand, venue, adj, seasonPA: pa, oppPName: oppPPNameByTeamId[match.teamId] || null, oppPFac, impliedRuns, ittMult });
  }
  if (!draft.length) return battersPayload([], feedError, boardTtlSec);

  const pr = (arr, v) => arr.length ? Math.round(arr.filter((x) => x <= v).length / arr.length * 100) : 0;
  const tone = (v) => v >= 66 ? 'cool' : v >= 33 ? 'warm' : 'hot';

  const all = draft.map((b) => {
    const priced = BATTER_MARKETS
      .map((spec) => ({ spec, m: b.markets[spec.metric] }))
      .filter((x) => x.m && x.m.price != null);
    // The PLAYS are batter unders — the one side the graded record shows a real
    // edge (public over-bias inflates batter lines). Headline = the best priced
    // UNDER; a batter with no under lean is analysis, not a play, and doesn't
    // make the board. All priced markets (both sides) still log for research.
    const unders = priced.filter((x) => x.m.side === 'Under');
    // A posted market leads the row over one that is logged only, whatever
    // its edge: a total-bases under no longer heads a row an H+R+RBI play could.
    const postedUnders = unders.filter((x) => x.m.tier !== 'pass');
    const lead = (postedUnders.length ? postedUnders : unders).reduce((best, x) => (!best || x.m.edge > best.m.edge ? x : best), null);
    const expFor = (metric) => round2(b.lambda[metric]);
    // With no price there is no line to take a side against, so there is no
    // pick and no edge -- but the projection itself stands on its own, the way
    // the K board reads "proj 6.3 Ks". Total bases is the continuous metric that
    // carries the most information, so it headlines.
    const modelOnly = !priced.length;
    const power = pr(pool.iso, b.iso), slug = pr(pool.slg, b.slg);
    const contact = pr(pool.contact, 1 - b.kpct), disc = pr(pool.disc, b.bbpct);

    // A pulled batter takes no plate appearances, so EVERY number conditioned on
    // tonight is wrong for him — not just the edge. Blanking one and leaving the
    // rest asserts a 60% under for someone who will not bat. Stripped here rather
    // than in the client so the value never crosses the wire: a field the page
    // must not show is a field the page should not receive.
    //
    // Season percentiles survive: they describe the player, not tonight.
    const pulledOut = (row) => {
      if (!b.pulled) return row;
      return Object.assign({}, row, {
        pick: '—', odds: null, oddsBooks: null, edge: null, interval: '—',
        side: null, line: null, projVal: null, marketLabel: null, metric: null,
        modelOver: null, fairOver: null, fairSrc: null, hasPriced: false,
        moveSincePost: null, tier: 'out',
        pulled: true,
        // Kept for the alert bar only — what the board loses by his absence.
        // Never rendered in the row itself.
        wasPick: lead ? `${lead.m.side === 'Over' ? 'O' : 'U'} ${lead.m.line} ${lead.spec.label}` : null,
        wasEdge: lead ? lead.m.edge : null,
        wasTier: lead ? lead.m.tier : (priced.length ? 'pass' : 'model'),
        // Which market he was being faded in. Not conditioned on tonight — he is
        // a total-bases bat whether or not he plays — so the row can still say
        // what it was about instead of leaving the subline blank.
        wasMetric: lead ? lead.spec.metric : (row.metric || null),
      });
    };
    return pulledOut({
      id: 'b' + (b.match.id || b.nm.replace(/\s/g, '')),
      name: shortName(b.rec.name),
      team: b.match.team,
      playerId: b.match.id || null,
      gamePk: b.rec.gamePk || null,
      status: b.rec.gameStatus || 'Preview',
      matchup: b.rec.matchup,
      timeMs: b.rec.timeMs,
      timeLabel: b.rec.timeLabel,
      // Away-home, matching the order the matchup string reads. Null on a
      // Preview game so the client can tell "not started" from "0-0".
      awayScore: b.rec.awayScore ?? null,
      homeScore: b.rec.homeScore ?? null,
      lineupSlot: b.slot || null,
      // Matchup context that shaped the projection — surfaced so the reasoning
      // stays visible. facingHand = opposing arm, park = venue, adj = the applied
      // platoon×park multiplier per metric (1.0 = no adjustment / data missing).
      facingHand: b.facingHand || null,
      park: b.venue || null,
      adj: b.adj || null,
      // Season PA behind the rate that produced this projection. Logged so
      // the pa>=30 admission threshold can be tested against outcomes rather
      // than argued about: a 30-PA rate is mostly noise, but whether that
      // noise costs anything is measurable once the column exists.
      seasonPA: b.seasonPA || null,
      // The club's implied runs tonight and what it did to the H+R+RBI projection
      // (1.0 when no line is posted yet).
      impliedRuns: b.impliedRuns != null ? round2(b.impliedRuns) : null,
      impliedRunsAdj: b.ittMult != null ? round2(b.ittMult) : null,
      oppPitcher: b.oppPName || null,   // tonight's opposing starter
      oppPitcherAdj: b.oppPFac || null, // his contribution alone, per metric
      pick: lead ? `${lead.m.side === 'Over' ? 'O' : 'U'} ${lead.m.line} ${lead.spec.label}`
        : modelOnly ? `proj ${expFor('tb')} TB` : '—',
      odds: lead ? lead.m.price : null,
      oddsBooks: lead ? lead.m.books : null,
      // edge = model_prob - fair_prob, and fair comes from de-vigged book prices.
      // No price, no edge. Null is the honest value; 0 would read as "no lean".
      edge: lead ? lead.m.edge : null,
      tier: lead ? lead.m.tier : modelOnly ? 'model' : 'pass',
      interval: lead ? `proj ${expFor(lead.spec.metric)} ${lead.spec.label}`
        : modelOnly ? `proj ${expFor('hrr')} H+R+RBI · ${expFor('hr')} HR` : '—',
      // Fields for the fade display: the model-vs-line scale and hit probability.
      side: lead ? lead.m.side : null,
      line: lead ? lead.m.line : null,
      projVal: lead ? expFor(lead.spec.metric) : modelOnly ? expFor('tb') : null,
      marketLabel: lead ? lead.spec.label : modelOnly ? 'TB' : null,
      metric: lead ? lead.spec.metric : modelOnly ? 'tb' : null,  // hr|tb|hrr — joins to bpicks
      modelOver: lead ? lead.m.modelOver : null,
      fairOver: lead ? lead.m.fairOver : null,       // current vig-free P(over) — for since-posted movement
      fairSrc: lead ? lead.m.fairSrc : null,
      hasPriced: priced.length > 0,
      // Per-market detail for the expanded row (also carries what logging needs).
      batterMarkets: BATTER_MARKETS.map((spec) => {
        const m = b.markets[spec.metric];
        // PrizePicks rides along on every market, priced or not: a row with no
        // DK/FD line can still have a PP number to play, and that is precisely
        // the row that used to show nothing.
        // The model's own P(under) at PrizePicks' number — unregressed, because
        // regression pulls toward a market fair line and there isn't one at a
        // number only PrizePicks hangs. The client labels it as the model's read,
        // not an edge; the graded record says these probabilities run optimistic.
        const pp = ppQuote((b.rec.props || {})[spec.metric],
          (L) => negBinomCdf(Math.floor(L), b.lambda[spec.metric], BATTER_DISPERSION[spec.metric]));
        return m
          ? { label: spec.label, metric: spec.metric, line: m.line, side: m.side, price: m.price, edge: m.edge, modelOver: m.modelOver, fairOver: m.fairOver, fairSrc: m.fairSrc, fairBooks: m.fairBooks, tier: m.tier, ...(m.tierWas ? { tierWas: m.tierWas } : {}), proj: expFor(spec.metric), books: m.books, pp }
          : { label: spec.label, metric: spec.metric, none: true, proj: expFor(spec.metric), pp };
      }),
      // Real percentile bars from the priced pool. These describe the player's
      // season, not tonight, so they survive a pull.
      stats: [
        { label: 'Power (ISO)', value: power, tone: tone(power) },
        { label: 'Slugging', value: slug, tone: tone(slug) },
        { label: 'Contact', value: contact, tone: tone(contact) },
        { label: 'Discipline', value: disc, tone: tone(disc) },
      ],
    });
  });

  // Board rows = under leans only. Logging stays whole-model (every priced
  // market, both sides) so the research record keeps measuring what we DON'T post.
  //
  // MODEL_ROW_CAP bounds the unpriced half of the board. A fully unquoted 15-game
  // slate seeds ~9 hitters a side; without a cap the payload would grow with the
  // schedule rather than with anything useful.
  const pricedRows = all.filter((r) => r.odds != null)
    .sort((a, b) => (b.edge || 0) - (a.edge || 0))
    .slice(0, 40);
  // Projection-only rows ride below the priced ones. Ranked by projected total
  // bases, since with no line there is no edge to rank by; batting order breaks
  // ties, being the one ordering here that is real information rather than an
  // artifact of the projection. Priced rows are kept first so that if either cap
  // bites, what it drops is a row with no number to act on. (The client sorts the
  // board by first pitch, so this decides what survives, not what shows on top.)
  const modelRows = all.filter((r) => r.tier === 'model')
    .sort((a, b) => (b.projVal || 0) - (a.projVal || 0) || (a.lineupSlot || 99) - (b.lineupSlot || 99))
    .slice(0, MODEL_ROW_CAP);
  const live = pricedRows.concat(modelRows);
  // Pulled rows ride along rather than being filtered out. They carry no price
  // so the priced filter drops them, but a row that silently disappears is the
  // problem the alert bar exists to fix — especially one already on someone's
  // slip. The client sorts by first pitch, so they land back in their own game.
  // They cannot reach logRows, which gates on hasPriced (false for all of them).
  const rows = live.concat(all.filter((r) => r.pulled));
  const logRows = all.filter((r) => r.hasPriced).slice(0, 60);

  if (env && env.DB) {
    // Line movement since posted: compare each row's CURRENT vig-free fair to the
    // entry fair we froze the first time this pick logged (entry_over is written
    // INSERT-OR-IGNORE, so it never drifts). Read before the write below, so it
    // reflects prior sightings, not this one — a pick's first appearance has no
    // baseline yet and correctly shows nothing.
    //
    // Two guards keep it honest, matching the CLV discipline used at grading:
    //  - entry line must equal the current line (a moved line compares different
    //    markets), and
    //  - entry fair tier must equal the current tier (sharp→mkt is a book gap,
    //    not real movement).
    try {
      const prior = (await env.DB.prepare(
        'SELECT game_id, player_id, market, entry_over, line, fair_src FROM bpicks WHERE date=?'
      ).bind(slateYmd).all()).results || [];
      const em = {};
      prior.forEach((p) => { em[`${p.game_id}|${p.player_id}|${p.market}`] = p; });
      rows.forEach((r) => {
        if (r.playerId == null || r.gamePk == null || !r.metric || r.fairOver == null || !r.side) return;
        const e = em[`g${r.gamePk}|${r.playerId}|${r.metric}`];
        if (!e || e.entry_over == null) return;
        if (e.line !== r.line) return;                             // line moved -> not comparable
        if ((e.fair_src || null) !== (r.fairSrc || null)) return;  // tier changed -> not comparable
        // Positive = moved toward our side (fair P(over) fell for an Under).
        const mv = (r.side === 'Under' ? (e.entry_over - r.fairOver) : (r.fairOver - e.entry_over)) * 100;
        r.moveSincePost = Math.round(mv * 10) / 10;
      });
    } catch (e) { /* movement is optional — never block the board on it */ }

    // Logged under the slate being shown, not the wall-clock day: a pick made
    // on a rolled board belongs to the day its game is played, which is the date
    // grading looks it up by.
    const write = logBatterPicks(env.DB, logRows, slateYmd).catch(() => {});
    if (ctx && ctx.waitUntil) ctx.waitUntil(write); else await write;
    // Every PrizePicks number on the board, priced or not — a row the books never
    // quoted still has a PrizePicks line to play, and those are most of them.
    const ppEntries = [];
    for (const r of all) {
      if (r.status !== 'Preview' || r.playerId == null || r.gamePk == null) continue;
      for (const m of (r.batterMarkets || [])) {
        if (m && m.pp) ppEntries.push({ gameId: 'g' + r.gamePk, playerId: r.playerId, player: r.name, team: r.team, market: m.metric, pp: m.pp });
      }
    }
    const wpp = logPpPicks(env.DB, ppEntries, slateYmd).catch(() => {});
    if (ctx && ctx.waitUntil) ctx.waitUntil(wpp); else await wpp;
  }

  // Same rule as the strikeout board: a game that has gone Final drops off.
  // Safe to do on `rows` because logging runs off `logRows`, which is built from
  // `all` and never touched here — the record does not depend on what is
  // displayed. Pulled rows go with their game, since "he was scratched" stops
  // being news the moment the game is over.
  const slate = {
    rows: rows.length,
    // Live from WARMUP, 20-30 minutes early in StatsAPI's terms; the slate has
    // only started once every game's scheduled first pitch has also passed --
    // the same rule as the client's gameStarted.
    started: rows.length > 0 && rows.every((r) => r.status === 'Final'
      || (r.status === 'Live' && (!r.timeMs || Date.now() >= r.timeMs))),
    allFinal: rows.length > 0 && rows.every((r) => r.status === 'Final'),
  };
  const openRows = rows.filter((r) => r.status !== 'Final');

  // 5 min — batter props are the expensive call. propsFeedError rides along even
  // on a good slate: some events can 401 while others succeed, and a partial
  // slate presented as complete is its own quiet lie.
  return battersPayload(openRows, feedError, boardTtlSec, slate);
}

function abbrFromName(name) {
  return String(name || '').split(' ').pop().slice(0, 3).toUpperCase();
}
// Team full name -> our canonical abbreviation. Used on BOTH the Odds event and
// the MLB schedule so the two always key the same (avoids AZ/ARI-style misses).
function keyAbbr(name) {
  return TEAM_ABBR_BY_NAME[name] || abbrFromName(name);
}
function round2(n) { return Math.round(n * 100) / 100; }

// -------------------------------------------------------------------------
// /api/live-now — tonight's logged picks whose games are in progress, scored
// against the live boxscore: each player's current stat vs the prop line, the
// game state, and a cashing / live / cooling read. Real pitch-by-pitch data
// flows straight in (the boxscore updates continuously). [] when nothing's live.
// -------------------------------------------------------------------------
const MARKET_SHORT = { hr: 'HR', tb: 'TB', hrr: 'H+R+RBI' };
const EXP_IP = 6;   // expected innings for a start (pace denominator)
const EXP_AB = 4;   // expected at-bats for a hitter

async function mlbLiveCards(env) {
  const date = slateDate();
  if (!env || !env.DB) return [];

  // 1) Which of tonight's games are in progress (+ score / inning).
  let games = [];
  try {
    const r = await fetch(`${STATS}/schedule?sportId=1&date=${date}&hydrate=linescore,team`, { headers: { accept: 'application/json' } });
    if (!r.ok) return [];
    games = (((await r.json()).dates || [])[0] || {}).games || [];
  } catch (e) { return []; }

  const meta = {};
  for (const g of games) {
    if (((g.status || {}).abstractGameState) !== 'Live') continue;
    const ls = g.linescore || {};
    const runs = (side) => numOr((ls.teams && ls.teams[side] && ls.teams[side].runs), g.teams[side].score) ?? 0;
    meta['g' + g.gamePk] = {
      away: teamAbbr(g.teams.away.team), home: teamAbbr(g.teams.home.team),
      awayR: runs('away'), homeR: runs('home'),
      inning: ls.currentInningOrdinal ? `${(ls.inningHalf || '').replace('Bottom', 'Bot')} ${ls.currentInningOrdinal}`.trim() : 'Live',
    };
  }
  if (!Object.keys(meta).length) return [];

  // 2) Tonight's logged picks (lines/sides) from D1.
  let picks = [], bpicks = [];
  try {
    await ensureSchema(env.DB); await ensureBatterSchema(env.DB);
    picks = (await env.DB.prepare('SELECT * FROM picks WHERE date=?').bind(date).all()).results || [];
    bpicks = (await env.DB.prepare('SELECT * FROM bpicks WHERE date=?').bind(date).all()).results || [];
  } catch (e) { return []; }

  // 3) One boxscore per live game that carries a pick.
  const need = [...new Set([...picks, ...bpicks].map((p) => p.game_id).filter((id) => meta[id]))];
  if (!need.length) return [];
  const box = {};
  await Promise.all(need.map(async (gid) => {
    try {
      const r = await fetch(`${STATS}/game/${String(gid).replace(/^g/, '')}/boxscore`, { headers: { accept: 'application/json' } });
      if (r.ok) box[gid] = await r.json();
    } catch (e) { /* skip */ }
  }));

  const cards = [];
  for (const p of picks) {
    const m = meta[p.game_id], b = box[p.game_id];
    if (!m || !b) continue;
    const st = pitchingLive(b, p.pitcher_id);
    if (!st) continue;
    cards.push(liveCard({
      id: 'lp' + p.game_id + p.pitcher_id, pid: 'p' + p.pitcher_id, name: p.pitcher, team: p.team, pos: 'P',
      stat: st.k, label: 'K', line: p.line, side: p.side, m,
      note: `${st.pitches} pitches · ${st.ip} IP${st.done ? ' · pulled' : ''}`,
      progress: st.outs / (EXP_IP * 3), pitches: st.pitches, done: st.done, edge: p.edge,
      started: st.outs > 0 || st.pitches > 0,
    }));
  }
  for (const p of bpicks) {
    const m = meta[p.game_id], b = box[p.game_id];
    if (!m || !b) continue;
    const st = battingLive(b, p.player_id, p.market);
    if (!st) continue;
    cards.push(liveCard({
      id: 'lb' + p.game_id + p.player_id + p.market, pid: 'b' + p.player_id, name: p.player, team: p.team, pos: 'B',
      stat: st.val, label: MARKET_SHORT[p.market] || p.market, line: p.line, side: p.side, m,
      note: st.note, progress: st.ab / EXP_AB, edge: p.edge,
      // A walk leaves at-bats at 0 but can still put a run on the H+R+RBI line,
      // so the stat counts as having batted too.
      started: st.ab > 0 || st.val > 0,
    }));
  }

  return rankLive(cards, LIVE_PER_SPORT).map((c) => ({ sport: 'mlb', ...c }));
}

// /api/live-now across every sport followed (2026-10-23). MLB's cards as
// before, and beside them the NBA and NHL PrizePicks unders and Picks of the
// day's NBA and NHL moneylines whose games are under way, each scored against
// the league's own live feed: ESPN's box scores for the NBA, the NHL's own for
// the NHL. No odds are read, so no credit is spent, and a feed is asked only
// when one of its legs has started. Each card names its sport; the page shows
// a tab's own, and all of them on Picks.
const LIVE_LOOKBACK_MS = 4 * 3600e3;       // a started leg is looked for this long
const LIVE_PER_SPORT = 9;
async function liveNow(env) {
  if (!env || !env.DB) return cors(json([], 30));
  const now = Date.now();
  const feeds = liveFeeds(now);
  const parts = await Promise.all([mlbLiveCards(env), nbaLiveCards(env, now, feeds), nhlLiveCards(env, now, feeds), mlLiveCards(env, now, feeds)]
    .map((p) => p.catch(() => [])));
  return cors(json(parts.flat(), 30)); // 30s — live data
}

// Each feed read at most once a request, shared by the prop and moneyline cards.
function liveFeeds(now) {
  const memo = new Map();
  const once = (k, f) => { if (!memo.has(k)) memo.set(k, f().catch(() => null)); return memo.get(k); };
  const get = async (url) => { const r = await fetch(url, { headers: { accept: 'application/json' } }); return r.ok ? r.json() : null; };
  const day = ptDateOf(now);
  return {
    nba: () => once('nba', async () => espnLiveGames(freshestEvents(
      await espnScoreboard(`nba/scoreboard?xhr=1&date=${day.replace(/-/g, '')}`),
      await espnScoreboard('nba/scoreboard?xhr=1').catch(() => [])))),
    nhl: () => once('nhl', async () => nhlLiveGames(await get(`https://api-web.nhle.com/v1/score/${day}`))),
    // The NFL scoreboard is the current week's whatever date is asked (see
    // gradeGamePicks), so it is asked without one.
    nfl: () => once('nfl', async () => espnLiveGames(await espnScoreboard('nfl/scoreboard?xhr=1'), 'nfl')),
    // ESPN's cdn serves box scores from a lagging copy at times too: at 4:30
    // PM Pacific on Oct 25 boxscore still had Magic @ Knicks before tip, no
    // players, in the 1st quarter, and at 6:11 it was at 10:28 of the 4th
    // with the scoreboard at 6:12 -- while playbyplay, the same box inside it,
    // was at 5:45. When the box is not under way, or behind the scoreboard by
    // more than a minute and a half of play, playbyplay's is read as well and
    // the one with more minutes played is kept.
    nbaBox: (id, gone) => once('nbabox:' + id, async () => {
      const read = async (kind) => {
        const j = await get(`${ESPN_CDN_NBA}/${kind}?xhr=1&gameId=${id}`);
        const st = ((((j && j.gamepackageJSON && j.gamepackageJSON.header) || {}).competitions || [])[0] || {}).status || {};
        return { rows: j ? nbaBoxRows(j, id, day, 2) : [], state: (st.type || {}).state, gone: espnGone(st, 12).gone };
      };
      const box = await read('boxscore');
      if (box.rows.length && box.state === 'in' && box.gone >= (gone || 0) - 1.5 / 48) return box.rows;
      const pbp = await read('playbyplay').catch(() => ({ rows: [] }));
      const mins = (x) => x.rows.reduce((a, r) => a + (Number(r.min) || 0), 0);
      return mins(pbp) > mins(box) ? pbp.rows : box.rows;
    }),
    nhlBox: (id) => once('nhlbox:' + id, async () => { const j = await get(`https://api-web.nhle.com/v1/gamecenter/${id}/boxscore`); return j ? nhlBoxLines(j) : new Map(); }),
  };
}

// ESPN's cdn answers the dated scoreboard from a lagging copy at times. On
// Oct 25 it had Lakers @ Jazz not yet started 55 minutes after tip, then held
// it at 9:54 of the 2nd while the undated scoreboard -- today's -- was at
// 8:11. Live reads both and takes each game from whichever is further on:
// finished over under way over not started, then the later period, then the
// higher combined score.
function freshestEvents(...lists) {
  const key = (e) => {
    const st = (e && e.status) || {};
    const cs = (((e && e.competitions) || [])[0] || {}).competitors || [];
    return [{ pre: 0, in: 1, post: 2 }[(st.type || {}).state] || 0, Number(st.period) || 0, cs.reduce((a, c) => a + (Number(c.score) || 0), 0)];
  };
  const later = (a, b) => { const x = key(a), y = key(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] > y[i] ? a : b; return a; };
  const by = new Map();
  for (const list of lists) {
    for (const e of (list || [])) {
      if (!e || e.id == null) continue;
      const id = String(e.id);
      by.set(id, by.has(id) ? later(by.get(id), e) : e);
    }
  }
  return [...by.values()];
}
// "7:12" -> 7.2 minutes; under a minute ESPN shows seconds alone ("34.5").
function clockMin(s) {
  const t = String(s == null ? '' : s).trim();
  if (!t) return null;
  if (t.includes(':')) { const [m, sec] = t.split(':').map(Number); return isFinite(m) && isFinite(sec) ? m + sec / 60 : null; }
  const sec = Number(t);
  return isFinite(sec) ? sec / 60 : null;
}
// Pure: an ESPN scoreboard's games under way -- the score, the clock, and how
// much of regulation is gone (0 to 1). Four quarters: twelve minutes in the
// NBA, fifteen in the NFL (since 2026-10-25).
// How much of regulation an ESPN status says is gone (0 to 1), and its clock.
function espnGone(st, q) {
  const ty = (st && st.type) || {};
  const per = Number(st && st.period) || 1, rem = clockMin(st && st.displayClock);
  if (/HALFTIME/.test(ty.name || '')) return { gone: 0.5, per, label: 'Half' };
  if (/END_PERIOD/.test(ty.name || '')) return { gone: Math.min(1, per / 4), per, label: `End ${per > 4 ? 'OT' : 'Q' + per}` };
  const gone = per > 4 ? 1 : ((per - 1) * q + (q - (rem == null ? q : rem))) / (4 * q);
  return { gone: Math.max(0, Math.min(1, gone)), per, label: `${per > 4 ? 'OT' : 'Q' + per} ${(st && st.displayClock) || ''}`.trim() };
}
function espnLiveGames(events, sport) {
  const q = sport === 'nfl' ? 15 : 12;
  const out = [];
  for (const ev of (events || [])) {
    const st = (ev && ev.status) || {}, ty = st.type || {};
    if (ty.state !== 'in') continue;
    const c = (ev.competitions || [])[0] || {};
    const h = (c.competitors || []).find((t) => t.homeAway === 'home'), a = (c.competitors || []).find((t) => t.homeAway === 'away');
    if (!h || !a) continue;
    const { gone, per, label } = espnGone(st, q);
    const nm = (t) => (t.team && (t.team.displayName || t.team.name)) || '';
    out.push({ id: String(ev.id), home: nm(h), away: nm(a), homeAb: (h.team && h.team.abbreviation) || '', awayAb: (a.team && a.team.abbreviation) || '',
      hs: Number(h.score) || 0, as: Number(a.score) || 0, gone, label, period: per });
  }
  return out;
}
// Pure: the NHL's score feed, its games under way, the same shape.
function nhlLiveGames(j) {
  const out = [];
  for (const g of ((j && j.games) || [])) {
    if (g.gameState !== 'LIVE' && g.gameState !== 'CRIT') continue;
    const h = g.homeTeam || {}, a = g.awayTeam || {}, ck = g.clock || {};
    const per = Number((g.periodDescriptor && g.periodDescriptor.number) || g.period) || 1;
    const rem = clockMin(ck.timeRemaining), inter = !!ck.inIntermission;
    const gone = per > 3 ? 1 : inter ? per / 3 : ((per - 1) * 20 + (20 - (rem == null ? 20 : rem))) / 60;
    const label = inter ? `${['1st', '2nd', '3rd'][per - 1] || 'OT'} int` : `${per > 3 ? 'OT' : 'P' + per} ${ck.timeRemaining || ''}`.trim();
    out.push({ id: String(g.id), home: (h.name && h.name.default) || '', away: (a.name && a.name.default) || '', homeAb: h.abbrev || '', awayAb: a.abbrev || '',
      hs: Number(h.score) || 0, as: Number(a.score) || 0, gone: Math.max(0, Math.min(1, gone)), label });
  }
  return out;
}
// Our game in a live list: the odds feed's names against the league's.
function liveGameOf(games, home, away, same) {
  return (games || []).find((g) => (same(g.home, home) && same(g.away, away)) || (same(g.home, away) && same(g.away, home))) || null;
}
// An under as it stands, by the chance it stays under: the player's own
// projection for the stat (proj, a game's worth) over the part of the game
// left, Poisson. Over the line already, or level with a whole-number line
// (a push at best): lost. 80%+ to stay under in the last quarter of the game:
// nearly there (cashing); under 40%: going the wrong way (cooling). On Oct 25 the clock alone called Towns
// "cashing" at 3 assists against under 3.5 with 8:40 left -- half an assist
// from the line, about a 37% chance of another -- and he had his 4th by 5:56.
// Without a projection, the clock: held under with a quarter left, and the
// pace read as if at least 40% of the game were gone, so one early assist
// does not call an under lost.
function liveUnderState(stat, line, gone, proj) {
  if (stat > line) return 'cooling';
  if (!(proj > 0)) {
    if (gone >= 0.75 && stat < line) return 'cashing';
    return stat / Math.max(gone, 0.4) > line ? 'cooling' : 'live';
  }
  const room = Math.ceil(line - stat) - 1;              // how many more he can add and stay under
  if (room < 0) return 'cooling';
  const m = proj * Math.max(0, 1 - gone);
  let t = Math.exp(-m), p = t;
  for (let k = 1; k <= room; k++) { t *= m / k; p += t; }
  return p >= 0.8 && gone >= 0.75 ? 'cashing' : p >= 0.4 ? 'live' : 'cooling';
}
// The legs on today's Picks of the day, by leg id.
async function livePickIds(db, days, kinds) {
  await ensureDayPickSchema(db);
  const rows = (await db.prepare(`SELECT leg_id FROM daypicks WHERE date IN (${days.map(() => '?').join(',')}) AND on_list = 1 AND kind IN (${kinds.map(() => '?').join(',')})`)
    .bind(...days, ...kinds).all()).results || [];
  return new Set(rows.map((r) => r.leg_id));
}
// Logged PrizePicks legs whose games have started, at their current lines:
// the list's own, and each game's best three by the model's chance -- of the
// under, or with chance given, of the side followed (the NHL's More).
function liveFollowed(rows, now, picked, idOf, ok, chance = (r) => r.model_under) {
  const started = ppStanding(rows).map(ppCurrent).filter((r) => { const t = Date.parse(r.commence); return t <= now && t > now - LIVE_LOOKBACK_MS; });
  // One leg a player: the list's, else his best.
  const out = new Map();
  for (const r of started) if (picked.has(idOf(r))) out.set(r.player, { ...r, onPicks: true });
  const byGame = new Map();
  for (const r of started.filter(ok).sort((a, b) => chance(b) - chance(a))) {
    const n = byGame.get(r.game_id) || 0;
    if (n >= 3 || out.has(r.player)) continue;
    byGame.set(r.game_id, n + 1);
    out.set(r.player, r);
  }
  return [...out.values()];
}
function livePropCard(sport, r, g, stat, label, played, note, m, side = 'Under') {
  const over = side === 'Over';
  const c = liveCard({ id: `${sport}:${r.game_id}:${r.player}:${r.market}`, pid: `${sport}${r.player}${r.market}`, name: r.player, team: r.team || '', pos: '',
    stat, label, line: r.point, side, m, note, progress: g.gone, edge: over ? 100 - r.model_under : r.model_under, started: played });
  return { sport, ...c, state: over ? liveOverState(stat, r.point, g.gone, r.proj) : liveUnderState(stat, r.point, g.gone, r.proj), ...(r.onPicks ? { onPicks: true } : {}) };
}
// An over in progress (2026-10-27, the NHL's More): past the line, it has
// landed (cashing); else the chance the time left adds what it needs, Poisson
// at what remains of his projection -- 40%+ live, under that cooling. A point
// at 0.5 needs one more; at 1.5 with none yet, two. Without a projection,
// live while a third of the game is left.
function liveOverState(stat, line, gone, proj) {
  if (stat > line) return 'cashing';
  if (!(proj > 0)) return gone < 0.67 ? 'live' : 'cooling';
  const need = Math.floor(line - stat) + 1;
  const m = proj * Math.max(0, 1 - gone);
  let t = Math.exp(-m), short = t;                 // the chance he adds fewer than need
  for (let k = 1; k < need; k++) { t *= m / k; short += t; }
  return 1 - short >= 0.4 ? 'live' : 'cooling';
}
const liveMeta = (g) => ({ away: g.awayAb, awayR: g.as, home: g.homeAb, homeR: g.hs, inning: g.label });

async function nbaLiveCards(env, now, feeds) {
  // A card needs its game under way on the scoreboard, so with none under way
  // there is nothing to read: the night's open legs are some 250 rows, and the
  // page asks every 45 seconds all day (2026-10-27).
  const games = await feeds.nba();
  if (!games || !games.length) return [];
  const days = [ptDateOf(now), ptDateOf(now - 864e5)];
  await ensureNbaSchema(env.DB);
  const rows = (await env.DB.prepare('SELECT * FROM nbapp WHERE date IN (?, ?) AND result IS NULL').bind(...days).all()).results || [];
  const picked = await livePickIds(env.DB, days, ['nba_pp']);
  const legs = liveFollowed(rows, now, picked, (r) => `nbapp:${r.game_id}:${r.player}:${r.market}`, (r) => r.min_proj >= NBA_ROTATION_MIN);
  if (!legs.length) return [];
  const cards = [];
  for (const r of legs) {
    const g = liveGameOf(games, r.home, r.away, nbaMatch);
    if (!g) continue;
    const box = (await feeds.nbaBox(g.id, g.gone)) || [];
    const b = box.find((x) => r.player_id && x.player_id === String(r.player_id)) || box.find((x) => nbaName(x.player) === nbaName(r.player));
    if (!b) continue;
    const stat = b.dnp ? 0 : (nbaStat(b, r.market) || 0);
    const min = b.dnp ? 0 : (b.min || 0);
    cards.push(livePropCard('nba', r, g, stat, PICKS_NBA_MK[r.market] || r.market, min > 0,
      b.dnp ? 'has not played' : `${min} of ${Math.round(r.min_proj)} min`, liveMeta(g)));
  }
  return rankLive(cards, LIVE_PER_SPORT);
}

async function nhlLiveCards(env, now, feeds) {
  // As the NBA's: no game under way, no card, so nothing to read.
  const games = await feeds.nhl();
  if (!games || !games.length) return [];
  const days = [ptDateOf(now), ptDateOf(now - 864e5)];
  await ensureNhlPpSchema(env.DB);
  const rows = (await env.DB.prepare('SELECT * FROM nhlpp WHERE date IN (?, ?) AND result IS NULL').bind(...days).all()).results || [];
  // The NHL card lists Mores since 2026-10-27, so Live follows them: each
  // game's best three at a More chance of PP_MORE_MIN or better.
  const more = (r) => (r.model_under == null ? -1 : 100 - r.model_under);
  const legs = liveFollowed(rows, now, new Set(), (r) => `nhlpp:${r.game_id}:${r.player}:${r.market}`, (r) => more(r) >= PP_MORE_MIN, more);
  if (!legs.length) return [];
  const cards = [];
  for (const r of legs) {
    const g = liveGameOf(games, r.home, r.away, nhlMatch);
    if (!g || !r.player_id) continue;
    const box = await feeds.nhlBox(g.id);
    const b = box && box.get(String(r.player_id));
    if (!b) continue;
    const stat = Number(r.market === 'ast' ? b.a : b.p) || 0;
    cards.push(livePropCard('nhl', r, g, stat, r.market === 'ast' ? 'AST' : 'PTS', !!b.toi && b.toi !== '00:00',
      b.toi ? `${b.toi} on ice` : '', liveMeta(g), 'Over'));
  }
  return rankLive(cards, LIVE_PER_SPORT);
}

// Picks of the day's NBA, NHL and NFL moneylines in progress: the score, and
// whether the side is ahead. The NFL log names clubs by the site's codes, which
// are ESPN's but for two (NFL_LOGO: WAS is WSH, LA is LAR).
const nflLiveSame = (espnAb, ours) => String(espnAb || '').toLowerCase() === (NFL_LOGO[ours] || String(ours || '').toLowerCase());
async function mlLiveCards(env, now, feeds) {
  const days = [ptDateOf(now), ptDateOf(now - 864e5)];
  await ensureDayPickSchema(env.DB);
  const legs = ((await env.DB.prepare("SELECT * FROM daypicks WHERE date IN (?, ?) AND on_list = 1 AND kind IN ('nba_ml', 'nhl_ml', 'nfl_ml')").bind(...days).all()).results || [])
    .filter((r) => { const t = Date.parse(r.commence); return t <= now && t > now - LIVE_LOOKBACK_MS; });
  const cards = [];
  for (const r of legs) {
    const sport = { nba_ml: 'nba', nhl_ml: 'nhl', nfl_ml: 'nfl' }[r.kind];
    const gm = await env.DB.prepare('SELECT home, away, pick, side FROM gmpicks WHERE sport = ? AND date = ? AND game_id = ? AND market = ?')
      .bind(sport, r.src_date, r.game_id, r.market || 'h2h').first();
    if (!gm) continue;
    const same = sport === 'nba' ? nbaMatch : sport === 'nhl' ? nhlMatch : nflLiveSame;
    // NFL rows carry codes, so its games are matched on ESPN's codes.
    const games = sport === 'nfl' ? ((await feeds.nfl()) || []).map((x) => ({ ...x, home: x.homeAb, away: x.awayAb }))
      : await (sport === 'nba' ? feeds.nba() : feeds.nhl());
    const g = liveGameOf(games, gm.home, gm.away, same);
    if (!g) continue;
    // The feeds may list the two sides the other way round from ours.
    const ourHomeIsTheirs = same(g.home, gm.home);
    const mine = (gm.side === 'home') === ourHomeIsTheirs ? g.hs : g.as, theirs = (gm.side === 'home') === ourHomeIsTheirs ? g.as : g.hs;
    const lead = mine - theirs;
    cards.push({
      sport, kind: 'ml', id: `ml:${r.leg_id}`, name: r.label || `${gm.pick} ML`, team: '', pos: '', onPicks: true,
      stat: `${mine}–${theirs}`, statLabel: '', line: null, side: 'ML',
      vs: lead > 0 ? `up ${lead}` : lead < 0 ? `down ${-lead}` : 'level',
      matchup: `${g.awayAb} ${g.as} – ${g.homeAb} ${g.hs}`, inning: g.label,
      note: r.p != null ? `${Math.round(r.p)}% before the start` : '',
      state: lead > 0 ? (g.gone >= 0.75 ? 'cashing' : 'live') : lead < 0 ? 'cooling' : 'live',
      fill: Math.round(g.gone * 100), tick: null, started: true,
    });
  }
  return cards;
}

// The top n cards. One card per player -- an MLB batter carries multiple
// markets, so keep the one where he's doing best (highest fill), breaking ties
// by model edge.
function rankLive(cards, n) {
  const byPid = new Map();
  for (const c of cards) {
    const ex = byPid.get(c._pid);
    if (!ex || c.fill > ex.fill || (c.fill === ex.fill && c._edge > ex._edge)) byPid.set(c._pid, c);
  }
  // Rank: cashing (the fun ones) first, then live, then cooling. Within a state,
  // order by how the PICK is doing rather than by how big the number is.
  // Ranking on fill sorted the raw stat, which is upside down for an Under: a
  // batter held to 0 against Under 1.5 is winning and sorted last, while one who
  // has run to 7 is a settled loss and sorted first. `cushion` is signed the
  // same way for both sides -- positive means on the right side of the number --
  // and divided by the line so a 6.5-strikeout prop and a 0.5 to-hit prop are
  // compared on the same scale instead of in raw units.
  const order = { cashing: 0, live: 1, cooling: 2 };
  const cushion = (c) => (c.side === 'Under' ? c.line - c.stat : c.stat - c.line) / Math.max(c.line, 0.5);
  return [...byPid.values()].sort((a, b) =>
    (order[a.state] - order[b.state])
    // Someone who has not come to the plate or thrown a pitch has nothing to
    // show yet. He keeps his card, but he should not hold a slot above a player
    // who does -- with nine slots and a full slate those are the ones that get cut.
    || (b._started - a._started)
    // A leg on Picks of the day before one that is only on its sport's card.
    || ((b.onPicks ? 1 : 0) - (a.onPicks ? 1 : 0))
    || (cushion(b) - cushion(a))
    || (b._edge - a._edge))
    // `started` goes to the page, which merges every sport's cards on the
    // Picks tab and puts those under way before those yet to bat or skate.
    .slice(0, n).map(({ _pid, _edge, _started, ...c }) => ({ ...c, started: !!_started }));
}

function liveCard(o) {
  const state = liveState(o.stat, o.line, o.side, o.progress, o.pos, o.pitches, o.done);
  const scale = Math.max(o.line * 1.7, o.stat + 0.5, o.line + 1);
  return {
    id: o.id, name: o.name, team: o.team, pos: o.pos,
    stat: o.stat, statLabel: o.label, line: o.line, side: o.side,
    matchup: `${o.m.away} ${o.m.awayR} – ${o.m.home} ${o.m.homeR}`,
    inning: o.m.inning, note: o.note, state,
    fill: Math.round(Math.min(100, Math.max(0, o.stat / scale * 100))),
    tick: Math.round(Math.min(100, o.line / scale * 100)),
    _pid: o.pid, _edge: o.edge || 0, _started: o.started ? 1 : 0,
  };
}

// cashing = already cleared the number; live = still on track / chances remain;
// cooling = trending to miss. Pitchers read off K pace (Ks accrue steadily);
// batters read off at-bats remaining (hits are lumpy, so pace is noisy early).
function liveState(stat, line, side, progress, type, pitches, done) {
  const oppFrac = 1 - progress;              // fraction of the start / plate appearances left
  const pace = stat / Math.max(progress, 0.2);
  if (side === 'Over') {
    if (stat > line) return 'cashing';
    if (type === 'P') {
      if (done) return 'cooling';                    // out of the game and short — it cannot move
      if ((pitches || 0) >= 105) return 'cooling';   // near the pitch limit and still short
      return pace >= line ? 'live' : 'cooling';
    }
    if (line <= 0.5) return oppFrac > 0.1 ? 'live' : 'cooling'; // to-hit props: live while an AB remains
    return oppFrac >= 0.3 ? 'live' : 'cooling';                 // enough at-bats left to get there
  }
  // Under
  if (stat > line) return 'cooling';         // already over the number
  // Out of the game and still under it: the Under is settled, not merely on pace.
  if (type === 'P') return done ? 'cashing' : (pace <= line ? 'live' : 'cooling');
  return oppFrac < 0.3 ? 'cashing' : 'live'; // held under with few at-bats left = nearly there
}

function pitchingLive(box, pid) {
  let s = null, order = null;
  ['away', 'home'].forEach((side) => {
    const team = (box.teams || {})[side] || {};
    const players = team.players || {};
    Object.keys(players).forEach((k) => {
      const pl = players[k];
      if (pl.person && pl.person.id === pid && pl.stats && pl.stats.pitching && Object.keys(pl.stats.pitching).length) {
        s = pl.stats.pitching;
        order = Array.isArray(team.pitchers) ? team.pitchers : null;
      }
    });
  });
  if (!s) return null;
  const ip = String(s.inningsPitched || '0.0');
  const [whole, frac] = ip.split('.');
  const outs = (parseInt(whole, 10) || 0) * 3 + (parseInt(frac, 10) || 0);
  // teams[side].pitchers lists the arms used in order, so a pitcher is still in
  // the game only if he is the last one. Without this a starter lifted in the
  // 3rd keeps pacing toward his number all night: the pitch-count check only
  // catches arms that reach 105, never one pulled early. Unknown order leaves
  // him in, so a missing field degrades to the old behaviour rather than
  // declaring every pitcher done.
  const done = !!(order && order.length && Number(order[order.length - 1]) !== Number(pid));
  return { k: toNum(s.strikeOuts), outs, pitches: toNum(s.numberOfPitches != null ? s.numberOfPitches : s.pitchesThrown), ip, done };
}

function battingLive(box, pid, market) {
  let s = null;
  ['away', 'home'].forEach((side) => {
    const players = ((box.teams || {})[side] || {}).players || {};
    Object.keys(players).forEach((k) => {
      const pl = players[k];
      if (pl.person && pl.person.id === pid && pl.stats && pl.stats.batting) s = pl.stats.batting;
    });
  });
  if (!s) return null;
  const h = toNum(s.hits), d = toNum(s.doubles), t = toNum(s.triples), hr = toNum(s.homeRuns);
  const r = toNum(s.runs), rbi = toNum(s.rbi), ab = toNum(s.atBats);
  let val;
  if (market === 'hr') val = hr;
  else if (market === 'tb') val = h + d + 2 * t + 3 * hr;
  else if (market === 'hrr') val = h + r + rbi;
  else return null;
  return { val, ab, note: `${h}-for-${ab}` };
}

// -------------------------------------------------------------------------
// Track record (Cloudflare D1). Picks are logged as the board is viewed and
// graded on read once their games are final — no cron needed. All D1 access
// is guarded, so the site works normally before the DB is set up.
// -------------------------------------------------------------------------
// The Track Record is the most expensive read on the site: it runs every grading
// pass and then reads every pick ever logged across four tables. It was cached
// only at the edge, for 120 seconds, and the edge cache is per Cloudflare
// location — so each location with a viewer rebuilt it from scratch every two
// minutes, while open pages re-requested it every ten. On 2026-09-12 and 09-13
// that, with the NFL board, exhausted D1's daily row-read allowance by midday.
//
// Now the built result is stored once in feed_cache and shared by every
// location for TRACK_RECORD_TTL_MS. When it goes stale, one request wins the
// refresh (the same single-flight lease the board uses) and the others keep
// serving the last result instead of all rebuilding at once. New grades
// therefore reach the page within about ten minutes, rather than two.
const TRACK_RECORD_TTL_MS = 10 * 60 * 1000;
const TRACK_RECORD_KEY = 'track-record:v1';

// ?summary=1: the headline numbers only, for scheduled checks. The full record
// carries every graded row (~96KB), more than a check can read in one go.
async function trackRecordSummary(res) {
  let d = null;
  try { d = await res.clone().json(); } catch (e) { return res; }
  if (!d || d.error) return res;
  const pick = (o, keys) => (o ? Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]])) : null);
  const gm = ['logged', 'pending', 'n', 'record', 'winRate', 'units', 'roi'];
  const out = {
    summary: true, cachedAgeSec: d.cachedAgeSec ?? null,
    recent: d.recent ? { date: d.recent.date, record: d.recent.record, units: d.recent.units, total: d.recent.total } : null,
    batterUnders: pick(d.batterUnders, ['n', 'record', 'winRate', 'breakEven', 'units', 'roi']),
    ml: d.ml ? { ...pick(d.ml, ['tracked', 'record', 'winRate', 'units', 'roi', 'pending', 'forwardSince', 'byPriceBand', 'vsSharpClose']),
      legacy: pick(d.ml.legacy, ['tracked', 'record', 'winRate', 'units', 'roi']) } : null,
    prizepicks: pick(d.prizepicks, ['graded', 'underRate', 'byMarket']),
    soccerFav: pick(d.soccerFav, [...gm, 'byBand']),
    soccerMl: pick(d.soccerMl, gm),
    nflMl: pick(d.nflMl, gm),
    nflPassTds: pick(d.nflPassTds, [...gm, 'verdict']),
    nflPassYds: pick(d.nflPassYds, ['logged', 'pending', 'n', 'hit', 'hitRate', 'byLineGap', 'ppHigherBy5', 'controlAtBookLine', 'meanGap', 'ci', 'verdict']),
    nbaMl: pick(d.nbaMl, [...gm, 'byLeague']),
    nhlMl: pick(d.nhlMl, [...gm, 'byBand']),
  };
  return cors(json(out, 300));
}

async function trackRecordCached(env) {
  if (!env || !env.DB) return trackRecord(env);
  const cached = await loadFeedCache(env.DB, TRACK_RECORD_KEY);
  const serve = (data, ageMs, ttl) => cors(json({ ...data, cachedAgeSec: Math.round(ageMs / 1000) }, ttl));
  if (cached.present && cached.ageMs < TRACK_RECORD_TTL_MS) return serve(cached.data, cached.ageMs, 300);
  // Stale or missing. With something to show, only the request that wins the
  // lease rebuilds; everyone else serves what exists. With nothing stored yet
  // there is nothing to serve, so the request builds regardless.
  if (cached.present && !(await claimFeedRefresh(env.DB, TRACK_RECORD_KEY, 120000))) {
    return serve(cached.data, cached.ageMs, 60);
  }
  const fresh = await trackRecord(env);
  let data = null;
  try { data = await fresh.clone().json(); } catch (e) { return fresh; }
  // Never store an error: a failed build must not be served for ten minutes.
  if (!data || data.error) return fresh;
  await saveFeedCache(env.DB, TRACK_RECORD_KEY, data);
  return serve(data, 0, 300);
}

async function trackRecord(env) {
  if (!env || !env.DB) return cors(json({ empty: true, logged: 0 }, 60));
  try {
    await ensureSchema(env.DB);
    await ensureBatterSchema(env.DB);
    await gradeUngraded(env);
    await gradeBatterPicks(env);
    await backfillBatterGrades(env);
    await gradeMlPicks(env);
    await gradeRlPicks(env);
    try { await gradeTotPicks(env); } catch (e) { /* additive — never break the record */ }
    try { await gradePpPicks(env); } catch (e) { /* additive */ }
    try { await gradeGamePicks(env); } catch (e) { /* additive */ }
    try { await gradePassTds(env); } catch (e) { /* additive */ }
    try { await gradePassYds(env); } catch (e) { /* additive */ }
    // MLB's half, kept until a row of its six tables is written (recordCached;
    // the graders above made the tables): after the World Series nothing
    // writes them until spring.
    const mlb = await recordCached(env, 'track-mlb', () => trackRecordMlb(env));
    const out = mlb.out;
    try {
      // NFL and soccer game lines. MLB's moneyline stays in out.ml, on its own
      // table, so its 763 rows keep running without a schema change under them.
      const gm = ((await env.DB.prepare('SELECT * FROM gmpicks').all()).results) || [];
      out.nflMl = buildGmRecord(gm, 'nfl');
      out.soccerMl = buildGmRecord(gm.filter((r) => r.market !== 'fav'), 'soccer');
      out.soccerFav = buildSoccerFavRecord(gm);
      out.nflPassTds = buildPassTdRecord(gm);
      out.nbaMl = buildGmRecord(gm, 'nba');
      out.nhlMl = buildGmRecord(gm, 'nhl');
    } catch (e) { /* additive */ }
    try {
      await ensurePassYdsSchema(env.DB);
      out.nflPassYds = buildPassYdsRecord(((await env.DB.prepare('SELECT * FROM nflpyd').all()).results) || []);
    } catch (e) { /* additive */ }
    out.recent = mlb.recent;
    return cors(json(out, 120));
  } catch (e) {
    return cors(json({ empty: true, logged: 0, error: String(e) }, 60));
  }
}

// The track record's MLB half: strikeout and batter props, moneyline, run
// line, totals, PrizePicks -- every row of each, which is most of what the
// record reads. Incomplete when one of the additive parts could not be read.
async function trackRecordMlb(env) {
  let complete = true;
  const kres = await env.DB.prepare('SELECT * FROM picks').all();
  const bres = await env.DB.prepare('SELECT * FROM bpicks').all();
  // Normalize both feeds to one row shape: pitcher picks are market 'K' with
  // actual_k; batter picks map their per-market actual into the same field.
  const unified = [
    ...(kres.results || []).map((r) => ({ ...r, market: 'K' })),
    ...(bres.results || []).map((r) => ({ ...r, actual_k: r.actual, market: String(r.market || '').toUpperCase() })),
  ];
  const out = buildTrackRecord(unified);
  let mlRows = [];
  try {
    const mlres = await env.DB.prepare('SELECT * FROM mlpicks').all();
    mlRows = mlres.results || [];
    out.ml = buildMlRecord(mlRows);
    out.ml.byPriceBand = buildMlPriceBands(mlRows);
    out.ml.vsSharpClose = mlVsSharpClose(mlRows);
  } catch (e) { complete = false; /* ML record is additive — never break the props track record */ }
  try {
    // Reuses buildMlRecord: an rlpicks row is shaped the same as an mlpicks
    // row for every field the record needs (result, entry/close price, tier,
    // edge), so a second aggregator would be a copy that could drift.
    const rlres = await env.DB.prepare('SELECT * FROM rlpicks').all();
    const rlRows = rlres.results || [];
    // Pass-tier included, deliberately — see buildMlRecord. Every run-line
    // pick is currently pass, so the alternative is an empty record forever.
    out.rl = buildMlRecord(rlRows, true);
    out.rl.logged = rlRows.length;
    out.rl.passShare = rlRows.length
      ? Math.round(rlRows.filter((r) => String(r.tier) === 'pass').length / rlRows.length * 100) : null;
    out.rl.note = 'run line, graded against the posted +/-1.5 from the final score. '
      + 'ALL tiers counted including pass, because none of these were posted and the question is whether the model reads the 1.5 at all. '
      + 'Logged and graded, still not posted.';
  } catch (e) { complete = false; /* additive */ }
  try {
    await ensureTotSchema(env.DB);
    out.totals = buildTotRecord(((await env.DB.prepare('SELECT * FROM totpicks').all()).results) || []);
  } catch (e) { complete = false; /* additive */ }
  try {
    await ensurePpSchema(env.DB);
    out.prizepicks = buildPpRecord(((await env.DB.prepare('SELECT * FROM pppicks').all()).results) || []);
  } catch (e) { complete = false; /* additive */ }
  return { data: { out, recent: buildRecent(unified, mlRows) }, complete };
}

async function ensureSchema(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS picks (
    date TEXT, game_id TEXT, pitcher_id INTEGER, pitcher TEXT, team TEXT,
    line REAL, side TEXT, price INTEGER, proj REAL, model_over REAL,
    edge REAL, tier TEXT, actual_k INTEGER, result TEXT,
    entry_over REAL, close_line REAL, close_price INTEGER, close_over REAL,
    PRIMARY KEY (date, game_id, pitcher_id)
  )`).run();
  await addColumns(db, 'picks', CLV_COLUMNS);
  // Which tier produced the fair line, and the pricing era. Without these the
  // strikeout board cannot be asked how often each fallback rung fires, which is
  // the whole basis for deciding whether the consensus rung can later be
  // dropped. Rows written before the sharp pool shipped keep NULL and stay
  // separable from it, exactly as on bpicks.
  await addColumns(db, 'picks', [['fair_src', 'TEXT'], ['model_ver', 'TEXT'], ['close_src', 'TEXT']]);
  // Partial index over UNGRADED rows only. D1 bills rows scanned, and the
  // grading passes ask "which games still need a boxscore?" with
  // `result IS NULL AND date < today` — a range that covers every day of
  // history, so through the primary key it read the whole table on every Track
  // Record request just to find the handful still open. This index holds only
  // the open rows, so the answer costs about as many reads as there are rows
  // left to grade, and stays that size however long the record grows.
  await db.prepare('CREATE INDEX IF NOT EXISTS picks_ungraded ON picks (date, game_id) WHERE result IS NULL').run();
}

// Batter picks live in their own table (a player carries up to 3 markets per
// game, so the key includes the market).
async function ensureBatterSchema(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS bpicks (
    date TEXT, game_id TEXT, player_id INTEGER, player TEXT, team TEXT,
    market TEXT, line REAL, side TEXT, price INTEGER, proj REAL, model_over REAL,
    edge REAL, tier TEXT, actual REAL, result TEXT,
    entry_over REAL, close_line REAL, close_price INTEGER, close_over REAL,
    PRIMARY KEY (date, game_id, player_id, market)
  )`).run();
  await addColumns(db, 'bpicks', CLV_COLUMNS);
  // Era tags. Rows written before the sharp-fair cutover keep NULL here, so the
  // old (DraftKings-derived, circular) edge sample stays intact and separable
  // instead of being silently blended with the new one.
  await addColumns(db, 'bpicks', [['fair_src', 'TEXT'], ['model_ver', 'TEXT']]);
  // Per-book de-vigged P(over) behind the pooled fair, as JSON at entry time.
  // The pooled median is what we price against, but it hides which book said
  // what — and "is ProphetX actually a sharp source?" is only answerable by
  // scoring each book's entry number against where the market closed
  // (close_over). Write-once: a column we skip today is a question we cannot
  // ask of tonight's rows later.
  await addColumns(db, 'bpicks', [['fair_books', 'TEXT']]);
  // Which tier produced the CLOSING fair, recorded separately from the entry
  // tier. Sharp books post late and pull early, so a row can enter priced
  // against a sharp consensus and close priced against DraftKings. Subtracting
  // one from the other is not line movement — it is the standing gap between
  // two books, and DK shades toward the public over, so the error has a
  // direction. CLV is only computed when both ends came from the same tier.
  await addColumns(db, 'bpicks', [['close_src', 'TEXT'], ['season_pa', 'INTEGER']]);
  // Which grader wrote this row's result. Rows graded before the did-not-play
  // fix carry NULL and are the ones the backfill has to re-derive from the
  // boxscore; reconciled rows are stamped so the sweep terminates instead of
  // re-fetching the same games forever.
  await addColumns(db, 'bpicks', [['grade_ver', 'TEXT']]);
  // Implied team runs at entry. Written for both markets so the betting effect of
  // the H+R+RBI input can be measured directly, and TB re-tested, rather than
  // reconstructed from ESPN after the fact.
  await addColumns(db, 'bpicks', [['impl_runs', 'REAL']]);
  // Partial index over UNGRADED rows only. D1 bills rows scanned, and the
  // grading passes ask "which games still need a boxscore?" with
  // `result IS NULL AND date < today` — a range that covers every day of
  // history, so through the primary key it read the whole table on every Track
  // Record request just to find the handful still open. This index holds only
  // the open rows, so the answer costs about as many reads as there are rows
  // left to grade, and stays that size however long the record grows.
  await db.prepare('CREATE INDEX IF NOT EXISTS bpicks_ungraded ON bpicks (date, game_id) WHERE result IS NULL').run();
  // The backfill sweep's own lookup, as a partial index over exactly the rows it
  // has left to reconcile. Its WHERE clause is built by the same function the
  // query uses, because SQLite only picks a partial index when the query's
  // conditions match the index's; a bound ? cannot be matched, so the version is
  // written in as a literal and the index is named for it. When the sweep is
  // done this index is empty, and so is the cost of asking.
  await db.prepare(`CREATE INDEX IF NOT EXISTS ${backfillIndexName()} ON bpicks (date, game_id) WHERE ${backfillWhere()}`).run();
}

// Stamped on every row this grader touches. Bump only if the grading RULE
// changes — it is what tells the backfill which rows still need re-deriving.
const GRADE_VER = 'dnp-void-1';
// Shared by backfillBatterGrades and the partial index built for it, so the two
// can never drift apart — if they did, SQLite would quietly stop using the index
// and the sweep would go back to reading the whole table. GRADE_VER is a code
// constant, never user input, so writing it into the SQL is safe.
const backfillWhere = () => `actual = 0 AND result IN ('win','loss') AND (grade_ver IS NULL OR grade_ver <> '${GRADE_VER}')`;
const backfillIndexName = () => 'bpicks_backfill_' + GRADE_VER.replace(/[^a-z0-9]/gi, '_');

// Moneyline last-known lines. Unlike strikeout picks, the moneyline is never
// logged, so it lives only in the live h2h feed. The book only offers it
// pre-game — once the game starts (or the feed drops it) the price vanishes and
// the board loses Edge/Tier with nothing to fall back on. We persist each
// game's most recent line so the board keeps showing the last real market
// number (the close) instead of blanking mid-day.
async function ensureMlSchema(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS ml_lines (
    date TEXT, game_id TEXT, home_price INTEGER, away_price INTEGER, updated_at INTEGER,
    PRIMARY KEY (date, game_id)
  )`).run();
}

// Moneyline PICKS — the logged bet (one per game), so the ML model builds a
// real graded track record instead of being eyeballed. entry_price freezes on
// first log; edge/tier/win_prob/close_price refresh to the pre-game close.
async function ensureMlPickSchema(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS mlpicks (
    date TEXT, game_id TEXT, team TEXT, opp TEXT, is_home INTEGER,
    tier TEXT, win_prob INTEGER, edge REAL,
    entry_price INTEGER, close_price INTEGER,
    result TEXT, team_score INTEGER, opp_score INTEGER,
    PRIMARY KEY (date, game_id)
  )`).run();
  // Pricing era, forward-only. The moneyline picked up Shin de-vig, entry-price
  // grading and the per-book fair in one day with no way to tell which moved a
  // number afterwards — every other table had this and mlpicks did not.
  // Deliberately NOT backfilled: rows written before this column cannot be known
  // to have been priced any particular way, and guessing would be worse than the
  // NULL that honestly says "before attribution existed".
  await addColumns(db, 'mlpicks', [['model_ver', 'TEXT'], ['fair_source', 'TEXT']]);
  // The pick as it stood, not only as it ended (2026-10-11). Every read
  // overwrites win_prob, edge and tier with the latest, while entry_price stays
  // the first -- so the log compared close-time chances with morning prices,
  // and neither "the edge when it was posted" nor its closing-line value could
  // be read back. entry_* is the first read; posted_* is the first read at a
  // posted tier (1-3), which is what a play actually looked like when it was
  // shown; close_at stamps the latest read. Forward-only, like model_ver.
  await addColumns(db, 'mlpicks', [['entry_win_prob', 'INTEGER'], ['entry_edge', 'REAL'], ['entry_tier', 'TEXT'],
    ['entry_fair_source', 'TEXT'], ['entry_at', 'TEXT'], ['posted_at', 'TEXT'], ['posted_price', 'INTEGER'],
    ['posted_win_prob', 'INTEGER'], ['posted_edge', 'REAL'], ['posted_tier', 'TEXT'], ['close_at', 'TEXT']]);
  // The close's fair, unrounded, and the book it came from (2026-10-12).
  // fair_source is written once, at entry; the close's edge can come from a
  // different source if Pinnacle dropped out between reads, so measuring a
  // price against Pinnacle's close needs the close's own source beside it.
  await addColumns(db, 'mlpicks', [['close_fair', 'REAL'], ['close_fair_source', 'TEXT']]);
  // Partial index over ungraded rows — see picks_ungraded in ensureSchema.
  await db.prepare('CREATE INDEX IF NOT EXISTS mlpicks_ungraded ON mlpicks (date, game_id) WHERE result IS NULL').run();
}
// Game totals, logged only (see TOT_EDGE_CHECK). One row per game: the side and
// number first seen, the entry edge frozen, the latest price and edge refreshed
// while the side and number hold — the same entry/close shape as mlpicks.
async function ensureTotSchema(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS totpicks (
    date TEXT, game_id TEXT, side TEXT, point REAL,
    entry_price INTEGER, close_price INTEGER, pin_fair REAL,
    entry_edge REAL, edge REAL, edge_check INTEGER,
    result TEXT, total_runs INTEGER, model_ver TEXT,
    PRIMARY KEY (date, game_id)
  )`).run();
  await db.prepare('CREATE INDEX IF NOT EXISTS totpicks_ungraded ON totpicks (date, game_id) WHERE result IS NULL').run();
}
async function logTotPicks(db, rows, date) {
  const stmts = [];
  for (const r of rows) {
    const t = r.tot;
    if (r.status !== 'Preview' || !t || !t.side || t.price == null) continue;
    stmts.push(db.prepare(
      `INSERT OR IGNORE INTO totpicks (date,game_id,side,point,entry_price,close_price,pin_fair,entry_edge,edge,edge_check,model_ver)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(date, r.id, t.side, t.point, t.price, t.price, t.pinFair, t.edge, t.edge, t.edgeCheck ? 1 : 0, TOT_MODEL_VER));
    stmts.push(db.prepare(
      'UPDATE totpicks SET close_price=?, pin_fair=?, edge=?, edge_check=? WHERE date=? AND game_id=? AND side=? AND point=?'
    ).bind(t.price, t.pinFair, t.edge, t.edgeCheck ? 1 : 0, date, r.id, t.side, t.point));
  }
  if (!stmts.length) return;
  await ensureTotSchema(db);
  await db.batch(stmts);
}

// PrizePicks lines, logged and graded at THEIR number.
//
// Everything else here is graded against DK/FD: the record says batter unders
// hit 54.8% at the book's line. That number does not transfer to pick'em,
// because PrizePicks hangs a different number — on 2026-09-18 it was mostly 0.5
// total bases and 1.5 H+R+RBI where the books posted 1.5 and 2.5 — and an under
// at 1.5 is a different bet from an under at 2.5.
//
// So the number that decides a pick'em entry has never been measured. This logs
// it: every PrizePicks line the board sees, the model's probability of landing
// under THAT number, and afterwards what actually happened. Nothing is posted
// and nothing is ranked; it exists so a daily card can be built on a graded hit
// rate against the entry break-evens (57.7% for a 2-pick power, ~54.2% for a
// 6-pick flex) instead of on the book-line record, which does not apply.
//
// Costs no credits: the PrizePicks quote already rides the prop call.
const PP_MODEL_VER = 'pp-v1';
async function ensurePpSchema(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS pppicks (
    date TEXT, game_id TEXT, player_id INTEGER, player TEXT, team TEXT,
    market TEXT, point REAL, model_under REAL,
    close_point REAL, close_model_under REAL,
    actual REAL, result TEXT, model_ver TEXT,
    PRIMARY KEY (date, game_id, player_id, market)
  )`).run();
  await db.prepare('CREATE INDEX IF NOT EXISTS pppicks_ungraded ON pppicks (date, game_id) WHERE result IS NULL').run();
}

// rows: board rows carrying a pp quote. `pick(r)` yields [{playerId, player,
// team, market, pp}] so the batter board (a row per hitter, several markets) and
// the strikeout board (a row per game, two starters) can share one writer.
async function logPpPicks(db, entries, date) {
  const stmts = [];
  for (const e of entries) {
    if (!e || !e.pp || e.pp.point == null || e.playerId == null || e.gameId == null) continue;
    stmts.push(db.prepare(
      `INSERT OR IGNORE INTO pppicks (date,game_id,player_id,player,team,market,point,model_under,close_point,close_model_under,model_ver)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(date, e.gameId, e.playerId, e.player || null, e.team || null, e.market, e.pp.point, e.pp.modelUnder ?? null, e.pp.point, e.pp.modelUnder ?? null, PP_MODEL_VER));
    // The closing number, refreshed while the line still stands. PrizePicks moves
    // its numbers too, and a card built at noon is not the card at first pitch.
    stmts.push(db.prepare(
      'UPDATE pppicks SET close_point=?, close_model_under=? WHERE date=? AND game_id=? AND player_id=? AND market=?'
    ).bind(e.pp.point, e.pp.modelUnder ?? null, date, e.gameId, e.playerId, e.market));
  }
  if (!stmts.length) return;
  await ensurePpSchema(db);
  await db.batch(stmts);
}

// Graded at the PrizePicks number: under it wins, over it loses, exactly on it
// is a push (PrizePicks lines are usually .5, so pushes are rare but real on
// whole numbers). A player who did not appear is void, never a 0 — the same hole
// the batter grader had.
async function gradePpPicks(env) {
  const db = env.DB;
  await ensurePpSchema(db);
  const today = slateDate();
  const games = (await db.prepare('SELECT DISTINCT game_id, date FROM pppicks WHERE result IS NULL AND date < ?').bind(today).all()).results || [];
  if (!games.length) return;
  const statusByGame = {};
  for (const d of [...new Set(games.map((g) => g.date))]) {
    try {
      const r = await fetch(`${STATS}/schedule?sportId=1&date=${d}`, { headers: { accept: 'application/json' } });
      if (!r.ok) continue;
      (((await r.json()).dates || [])[0] || {}).games?.forEach((g) => {
        statusByGame['g' + g.gamePk] = (g.status && g.status.abstractGameState) || '';
      });
    } catch (e) { /* skip this date */ }
  }
  const unresolved = games.filter((g) => statusByGame[g.game_id] !== 'Final').map((g) => g.game_id);
  const byPk = unresolved.length ? await gamesByPk(unresolved) : {};
  for (const [gid, g] of Object.entries(byPk)) if (g.state === 'Final') statusByGame[gid] = 'Final';
  const abandoned = Object.keys(byPk).filter((gid) => isAbandoned(byPk[gid]));
  if (abandoned.length) {
    try {
      await db.batch(abandoned.map((gid) => db.prepare(
        "UPDATE pppicks SET result='void' WHERE game_id=? AND result IS NULL").bind(gid)));
    } catch (e) { /* retry next pass */ }
  }
  for (const g of games.slice(0, 30)) {
    if (statusByGame[g.game_id] !== 'Final') continue;
    let box;
    try {
      const r = await fetch(`${STATS}/game/${String(g.game_id).replace(/^g/, '')}/boxscore`, { headers: { accept: 'application/json' } });
      if (!r.ok) continue;
      box = await r.json();
    } catch (e) { continue; }
    const ks = pitcherKsFromBox(box);
    const picks = (await db.prepare('SELECT * FROM pppicks WHERE game_id=? AND result IS NULL').bind(g.game_id).all()).results || [];
    const stmts = [];
    for (const p of picks) {
      const actual = p.market === 'K' ? (ks[p.player_id] ?? null) : batterActual(box, p.player_id, p.market);
      const point = p.close_point != null ? p.close_point : p.point;
      const result = actual == null ? 'void' : (actual < point ? 'under' : actual > point ? 'over' : 'push');
      stmts.push(db.prepare('UPDATE pppicks SET actual=?, result=? WHERE date=? AND game_id=? AND player_id=? AND market=?')
        .bind(actual, result, p.date, p.game_id, p.player_id, p.market));
    }
    if (stmts.length) { try { await db.batch(stmts); } catch (e) { /* next pass */ } }
  }
}

// How often the model's under call at PrizePicks' own number was right, banded
// by the probability it claimed — the bands are the entry break-evens, so the
// table reads directly against the card a reader would build.
function buildPpRecord(rows) {
  const graded = rows.filter((r) => r.result === 'under' || r.result === 'over');
  const band = (lo, hi) => {
    const rs = graded.filter((r) => r.close_model_under != null && r.close_model_under >= lo && r.close_model_under < hi);
    const hit = rs.filter((r) => r.result === 'under').length;
    return { n: rs.length, under: hit, over: rs.length - hit, hitRate: rs.length ? round1(hit / rs.length * 100) : null };
  };
  const all = graded.length;
  const hits = graded.filter((r) => r.result === 'under').length;
  const byMarket = {};
  for (const mk of [...new Set(graded.map((r) => r.market))]) {
    const rs = graded.filter((r) => r.market === mk);
    const h = rs.filter((x) => x.result === 'under').length;
    byMarket[mk] = { n: rs.length, hitRate: rs.length ? round1(h / rs.length * 100) : null };
  }
  return {
    note: 'PrizePicks lines, graded at THEIR number. Under = the result landed below the line. '
      + 'Nothing here is posted or ranked; break-evens for reference: 2-pick power 57.7%, 4-pick flex 56.9%, 5-pick flex 54.3%, 6-pick flex 54.2%.',
    logged: rows.length,
    pending: rows.filter((r) => r.result == null).length,
    voided: rows.filter((r) => r.result === 'void').length,
    graded: all,
    underRate: all ? round1(hits / all * 100) : null,
    byModelUnder: {
      'under 50': band(0, 50),
      '50-55': band(50, 55),
      '55-60': band(55, 60),
      '60-70': band(60, 70),
      '70plus': band(70, 101),
    },
    byMarket,
  };
}

// ---------------------------------------------------------------------------
// Game moneylines across sports: NFL and soccer, kept the way the MLB moneyline
// already is.
//
// MLB stays in its own table (mlpicks, 763 rows) so its history runs unbroken.
// These two start empty and share one table, because they share one shape: a
// side, the sharp pool's fair number for it, the best price standing against
// that number, and what happened. Soccer adds the only real difference — the
// draw is a side you can be on, so a three-way result grades like any other.
//
// Nothing here is posted or ranked. It is a record being accumulated so that in
// a month there is something to read.
// gm-v2 (2026-10-27): the fair line is Pinnacle's when it quotes (sharpFair),
// and each row carries every book's no-vig chance of its pick (book_fairs).
const GM_MODEL_VER = 'gm-v2';

async function ensureGamePickSchema(db) {
  // The first shape of this table keyed on (sport, date, game_id), which allowed
  // one row per game and so one market. Goals totals are bought on the same call
  // as the 1X2 and were being thrown away. The table shipped hours before that
  // was noticed and never took a row, so it is recreated rather than migrated —
  // guarded on being empty, so a populated table is never dropped.
  try {
    const cols = (await db.prepare('PRAGMA table_info(gmpicks)').all()).results || [];
    const have = new Set(cols.map((c) => c.name));
    const want = ['market', 'point', 'week'];
    if (cols.length && want.some((c) => !have.has(c))) {
      const n = await db.prepare('SELECT COUNT(*) AS n FROM gmpicks').first();
      if (n && Number(n.n) === 0) await db.prepare('DROP TABLE gmpicks').run();
    }
  } catch (e) { /* first run: nothing to inspect */ }
  await db.prepare(`CREATE TABLE IF NOT EXISTS gmpicks (
    sport TEXT NOT NULL,
    date TEXT NOT NULL,
    game_id TEXT NOT NULL,
    market TEXT NOT NULL DEFAULT 'h2h',
    league TEXT,
    week INTEGER,
    commence TEXT,
    side TEXT,
    point REAL,
    pick TEXT,
    home TEXT,
    away TEXT,
    win_prob REAL,
    implied REAL,
    edge REAL,
    entry_price INTEGER,
    close_price INTEGER,
    book TEXT,
    fair_src TEXT,
    sharp_n INTEGER,
    result TEXT,
    home_score INTEGER,
    away_score INTEGER,
    model_ver TEXT,
    PRIMARY KEY (sport, date, game_id, market)
  )`).run();
  // The grader reads only ungraded rows from days already played; a partial
  // index keeps that read off the rest of the table.
  await db.prepare('CREATE INDEX IF NOT EXISTS gmpicks_ungraded ON gmpicks (sport, date) WHERE result IS NULL').run();
  // The entry-leg grader looks rows up by game_id alone, every five minutes
  // while a moneyline leg is open; date sits between sport and game_id in the
  // key, so it read every row of three sports.
  await db.prepare('CREATE INDEX IF NOT EXISTS gmpicks_game ON gmpicks (game_id)').run();
  // The first read kept beside the latest (2026-10-11), as mlpicks now does:
  // win_prob and edge are overwritten by every read, entry_price is not.
  await addColumns(db, 'gmpicks', [['entry_win_prob', 'REAL'], ['entry_edge', 'REAL'], ['entry_at', 'TEXT'], ['close_at', 'TEXT']]);
  // Every book's no-vig chance of the pick, as last read (2026-10-27): which
  // book is sharpest per sport, scored on this site's own games.
  await addColumns(db, 'gmpicks', [['book_fairs', 'TEXT']]);
}

// entries: { game_id, league, commence, side, pick, home, away, win_prob,
//            implied, edge, price, book, fair_src, sharp_n }
async function logGamePicks(db, sport, date, entries) {
  if (!db || !date || !entries || !entries.length) return 0;
  await ensureGamePickSchema(db);
  const stmts = [];
  for (const e of entries) {
    if (!e || !e.game_id || e.price == null || e.win_prob == null) continue;
    // The same rule the moneyline learned: a price disagreeing with the fair
    // number by more than ML_PRICE_GAP is a bad read off the feed, not an edge.
    if (!mlPriceSane(e.price, e.win_prob)) continue;
    const market = e.market || 'h2h';
    const at = new Date().toISOString();
    stmts.push(db.prepare(
      `INSERT OR IGNORE INTO gmpicks (sport,date,game_id,market,league,week,commence,side,point,pick,home,away,win_prob,implied,edge,entry_price,close_price,book,fair_src,sharp_n,model_ver,
         entry_win_prob,entry_edge,entry_at,close_at,book_fairs)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(sport, date, String(e.game_id), market, e.league || null, e.week == null ? null : e.week,
      e.commence || null, e.side || null,
      e.point == null ? null : e.point, e.pick || null,
      e.home || null, e.away || null, e.win_prob, e.implied == null ? null : e.implied, e.edge == null ? null : e.edge,
      e.price, e.price, e.book || null, e.fair_src || null, e.sharp_n == null ? null : e.sharp_n, GM_MODEL_VER,
      e.win_prob, e.edge == null ? null : e.edge, at, at, e.book_fairs || null));
    // Close refreshes only while the same side is still the board's lead, so a
    // flip later in the week cannot overwrite the entry side's closing number.
    stmts.push(db.prepare(
      'UPDATE gmpicks SET close_price=?, edge=?, win_prob=?, implied=?, close_at=?, book_fairs=COALESCE(?, book_fairs) WHERE sport=? AND date=? AND game_id=? AND market=? AND side=?'
    ).bind(e.price, e.edge == null ? null : e.edge, e.win_prob, e.implied == null ? null : e.implied, at, e.book_fairs || null,
      sport, date, String(e.game_id), market, e.side || null));
  }
  if (!stmts.length) return 0;
  await db.batch(stmts);
  return stmts.length / 2;
}

// ESPN's cdn host is the one a Worker can reach — site.api answers 403 from
// Cloudflare (see the nfl-grade probe). Free either way, like every other score
// read in this file.
const ESPN_SOCCER_SLUG = { epl: 'eng.1', laliga: 'esp.1', ucl: 'uefa.champions', uel: 'uefa.europa', seriea: 'ita.1', ligamx: 'mex.1', mls: 'usa.1', uefanl: 'uefa.nations' };
async function espnScoreboard(path) {
  const r = await fetch(`https://cdn.espn.com/core/${path}`, { headers: { accept: 'application/json' } });
  if (!r.ok) return [];
  const j = await r.json();
  return (j && j.content && j.content.sbData && j.content.sbData.events) || [];
}
// Club names differ between the odds feed and ESPN ("Bournemouth" against "AFC
// Bournemouth", "Malaga" against "Málaga"). Strip the accents and the club-form
// words and match on what is left.
const CLUB_NOISE = /\b(afc|fc|cf|sc|ud|cd|rcd|ac|as|ss|sv|bv|club|de|the)\b/g;
// Teams the two feeds spell differently. Keys and values are clubKey form.
// Substring matching already covers "North Macedonia"/"Macedonia" and
// "Republic of Ireland"/"Ireland"; these are the ones it cannot. The MLS pair
// is ESPN's "Red Bull New York" and "LAFC" against the feed's "New York Red
// Bulls" and "Los Angeles FC" -- neither ever graded, and the other 28 MLS
// clubs match as they are.
// The last three (2026-10-21) are the feed's Inter Milan, Sporting Lisbon and
// Slavia Praha against ESPN's Internazionale, Sporting CP and Slavia Prague:
// none of their games had ever graded, and their Picks legs had no crest.
const TEAM_ALIAS = {
  czechrepublic: 'czechia', turkey: 'turkiye',
  bosniaandherzegovina: 'bosniaherzegovina',
  redbullnewyork: 'newyorkredbulls', lafc: 'losangeles',
  intermilan: 'internazionale', sportinglisbon: 'sportingcp', slaviapraha: 'slaviaprague',
  // The Europa League's first capture (2026-10-22): four of its eighteen
  // fixtures did not match ESPN's names, two of them favourites over 65%.
  unionsaintgilloise: 'unionstgilloise', rennes: 'staderennais', omonoia: 'omonianicosia', olympiakospiraeus: 'olympiacos',
};
// Letters NFD leaves whole are spelled out, and "&" is read as "and", so the
// feed's "Bod\u00f8/Glimt" is ESPN's "Bodo/Glimt" and its "Brighton and Hove
// Albion" is ESPN's "Brighton & Hove Albion" (2026-10-21: neither had graded;
// the \u00f8 was simply dropped, leaving "bodglimt").
const CLUB_LETTERS = { '\u00f8': 'o', '\u00e6': 'ae', '\u0153': 'oe', '\u00df': 'ss', '\u0111': 'd', '\u0142': 'l', '\u0131': 'i', '\u00fe': 'th', '\u00f0': 'd' };
function clubKey(s) {
  const k = String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[\u00f8\u00e6\u0153\u00df\u0111\u0142\u0131\u00fe\u00f0]/g, (c) => CLUB_LETTERS[c])
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(CLUB_NOISE, ' ').replace(/[^a-z0-9]+/g, '');
  return TEAM_ALIAS[k] || k;
}
function clubMatch(a, b) {
  const x = clubKey(a), y = clubKey(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}
const nbaNick = (s) => clubKey(String(s || '').trim().split(/\s+/).pop());
function nbaMatch(a, b) {
  const x = nbaNick(a), y = nbaNick(b);
  return !!x && x === y;
}

// How far ahead a re-listed fixture is looked for. See `stuck` below.
const MOVED_FIXTURE_MS = 21 * 864e5;

// Grade every ungraded row from a day that has finished. ESPN only, no credits.
async function gradeGamePicks(env) {
  const out = { graded: 0, pending: 0, unmatched: [], voidedMoved: [] };
  const stuck = [];
  if (!env || !env.DB) return out;
  await ensureGamePickSchema(env.DB);
  const today = slateDate();
  const rows = (await env.DB.prepare(
    'SELECT * FROM gmpicks WHERE result IS NULL AND date < ?'
  ).bind(today).all()).results || [];
  out.pending = rows.length;
  if (!rows.length) return out;

  // One scoreboard fetch per (sport, league/week, date), never per row.
  const need = new Map();
  for (const r of rows) {
    const k = `${r.sport}|${r.league || ''}|${r.week == null ? '' : r.week}|${r.date}`;
    if (!need.has(k)) need.set(k, { sport: r.sport, league: r.league, week: r.week, date: r.date, rows: [] });
    need.get(k).rows.push(r);
  }
  const stmts = [];
  for (const job of need.values()) {
    let events = [], finals = null;
    if (job.sport === 'nfl') {
      // The NFL scoreboard is week-oriented and ignores any date parameter
      // entirely — ?dates= and ?date= both return whatever week is current, so
      // asking it for a past Sunday hands back this Sunday's games. Ask by week,
      // which is why the week is stored on the row.
      const yr = Number(String(job.date).slice(0, 4));
      const season = Number(String(job.date).slice(5, 7)) <= 2 ? yr - 1 : yr;   // Jan/Feb belong to the previous season
      const stype = String(job.league || 'REG').toUpperCase() === 'PRE' ? 1 : 2;
      if (job.week == null) { for (const r of job.rows) out.unmatched.push(`${r.sport} ${r.date} no week stored`); continue; }
      try { events = await espnScoreboard(`nfl/scoreboard?xhr=1&year=${season}&seasontype=${stype}&week=${job.week}`); } catch (e) { continue; }
    } else if (job.sport === 'soccer' || job.sport === 'nba') {
      // Soccer takes ?date= (singular). ?dates= is accepted and silently
      // ignored, which returns the current matchday — so every row would have
      // been graded against whatever was played most recently. The NBA board
      // is the same: on 2026-10-03 ?dates=20251004 answered with that night's
      // Heat-Raptors game, and ?date=20251004 with the five games played then.
      const slug = ESPN_SOCCER_SLUG[job.league] || 'eng.1';
      const day = job.sport === 'nba'
        ? (ymd) => espnScoreboard(`nba/scoreboard?xhr=1&date=${ymd}`)
        : (ymd) => espnScoreboard(`soccer/scoreboard?xhr=1&league=${slug}&date=${ymd}`);
      try { events = await day(String(job.date).replace(/-/g, '')); } catch (e) { continue; }
      // Our dates are Pacific and ESPN's are UTC, so a late kickoff lands on the
      // next one. Ask for that day too rather than leaving a row ungraded.
      try {
        const nxt = new Date(Date.parse(job.date + 'T12:00:00Z') + 86400e3).toISOString().slice(0, 10).replace(/-/g, '');
        events = events.concat(await day(nxt));
      } catch (e) { /* the first day covers most of them */ }
    } else if (job.sport === 'nhl') {
      // The NHL's own feed, asked for the row's day only -- see nhlFinals.
      try { finals = await nhlScoreDay(job.date); } catch (e) { continue; }
    } else {
      // Passing touchdowns live in this table too and are graded from box
      // scores by gradePassTds. They used to fall through to the soccer branch
      // here and ask ESPN's English Premier League for a quarterback.
      continue;
    }

    if (!finals) finals = [];
    // Matches called off for good: abandoned or cancelled. Rayo Vallecano and
    // Athletic Club on 2026-10-10 was abandoned at 0-0, and its rows waited
    // for a final that was never coming. A bet on one is void.
    const offs = [];
    for (const ev of events) {
      const st = (ev && ev.status && ev.status.type && ev.status.type.name) || '';
      if (/ABANDONED|CANCELED|CANCELLED/.test(String(st))) {
        const c0 = (ev.competitions || [])[0];
        const h0 = c0 && (c0.competitors || []).find((t) => t.homeAway === 'home');
        const a0 = c0 && (c0.competitors || []).find((t) => t.homeAway === 'away');
        if (h0 && a0) offs.push({ home: (h0.team && (h0.team.displayName || h0.team.name)) || '', away: (a0.team && (a0.team.displayName || a0.team.name)) || '' });
        continue;
      }
      if (!/FINAL|FULL_TIME/.test(String(st))) continue;
      const c = (ev.competitions || [])[0];
      if (!c) continue;
      const h = (c.competitors || []).find((t) => t.homeAway === 'home');
      const a = (c.competitors || []).find((t) => t.homeAway === 'away');
      if (!h || !a) continue;
      finals.push({
        home: (h.team && (h.team.displayName || h.team.name)) || '',
        away: (a.team && (a.team.displayName || a.team.name)) || '',
        homeAb: (h.team && h.team.abbreviation) || '',
        awayAb: (a.team && a.team.abbreviation) || '',
        hs: Number(h.score), as: Number(a.score),
      });
    }
    // NBA names differ the way club names do -- the feed's "Los Angeles
    // Clippers" is ESPN's "LA Clippers" -- but every NBA nickname is unique, so
    // matching on the last word settles all thirty without an alias table.
    const same = job.sport === 'nba' ? nbaMatch : job.sport === 'nhl' ? nhlMatch : clubMatch;
    for (const r of job.rows) {
      let f = finals.find((x) => (r.sport === 'nfl'
        ? (clubMatch(x.homeAb, r.home) || clubMatch(x.home, r.home)) && (clubMatch(x.awayAb, r.away) || clubMatch(x.away, r.away))
        : same(x.home, r.home) && same(x.away, r.away)));
      // National teams play at neutral grounds, and the two feeds do not always
      // agree which side is "home". Found reversed, the scores are flipped back
      // into our orientation so r.side still means what it meant when logged.
      // NBA preseason plays neutral sites too (Knicks-76ers in Abu Dhabi), and
      // the NHL plays a few regular-season games in Europe.
      if (!f && (r.sport === 'soccer' || r.sport === 'nba' || r.sport === 'nhl')) {
        const x = finals.find((y) => same(y.home, r.away) && same(y.away, r.home));
        if (x) f = { ...x, hs: x.as, as: x.hs };
      }
      if (!f && r.sport !== 'nfl' && offs.some((x) => (same(x.home, r.home) && same(x.away, r.away)) || (same(x.home, r.away) && same(x.away, r.home)))) {
        stmts.push(env.DB.prepare(
          'UPDATE gmpicks SET result=?, home_score=NULL, away_score=NULL WHERE sport=? AND date=? AND game_id=? AND market=?'
        ).bind('void', r.sport, r.date, r.game_id, r.market || 'h2h'));
        out.voidedOff = (out.voidedOff || 0) + 1;
        continue;
      }
      if (!f || !isFinite(f.hs) || !isFinite(f.as)) {
        out.unmatched.push(`${r.sport} ${r.date} ${r.away}@${r.home}`);
        if (r.sport === 'soccer' && !f) stuck.push(r);
        continue;
      }
      let result;
      if (r.market === 'totals') {
        // Settled on the score line, not on who won. A whole-number line that
        // lands exactly is a push; 2.5 cannot, but 3.0 is quoted often enough.
        const scored = f.hs + f.as;
        result = r.point == null ? null
          : (scored === r.point ? 'push' : ((scored > r.point) === (r.side === 'over') ? 'win' : 'loss'));
        if (result == null) { out.unmatched.push(`${r.sport} ${r.date} totals with no line`); continue; }
      } else {
        const winner = f.hs > f.as ? 'home' : (f.as > f.hs ? 'away' : 'draw');
        // An NFL tie is a push — no draw price is offered, so there was no such
        // side to be on. Soccer prices the draw, so there it grades like any other.
        // (An NBA final cannot be level; if one ever read that way it pushes.
        // Nor can an NHL final: overtime and the shootout are in the price.)
        result = r.sport === 'nfl' || r.sport === 'nba' || r.sport === 'nhl'
          ? (winner === 'draw' ? 'push' : (winner === r.side ? 'win' : 'loss'))
          : (winner === r.side ? 'win' : 'loss');
      }
      stmts.push(env.DB.prepare(
        'UPDATE gmpicks SET result=?, home_score=?, away_score=? WHERE sport=? AND date=? AND game_id=? AND market=?'
      ).bind(result, f.hs, f.as, r.sport, r.date, r.game_id, r.market || 'h2h'));
      out.graded++;
    }
  }
  if (stmts.length) await env.DB.batch(stmts);

  // A fixture the odds feed listed and then moved. St. Louis at the Red Bulls
  // was listed for Sep 26 under one event id and played Sep 30 under another;
  // ESPN has no Sep 26 game, so the first rows matched nothing and would have
  // sat pending for good. They are voided once the same pairing has graded on a
  // later date -- not before, so a name that fails to match on BOTH dates still
  // shows up as unmatched rather than being voided out of sight.
  if (stuck.length) {
    const since = stuck.reduce((m, r) => (r.date < m ? r.date : m), stuck[0].date);
    const later = ((await env.DB.prepare(
      "SELECT game_id, league, home, away, commence, result FROM gmpicks WHERE sport='soccer' AND result IS NOT NULL AND date >= ?"
    ).bind(since).all()).results || []).filter((g) => g.result != null && g.result !== 'void');
    const voids = [];
    for (const r of stuck) {
      const t = Date.parse(r.commence);
      const moved = later.find((g) => {
        const tg = Date.parse(g.commence);
        return g.game_id !== r.game_id && g.league === r.league && g.home === r.home && g.away === r.away
          && tg > t && tg - t <= MOVED_FIXTURE_MS;
      });
      if (!moved) continue;
      voids.push(env.DB.prepare(
        'UPDATE gmpicks SET result=?, home_score=?, away_score=? WHERE sport=? AND date=? AND game_id=? AND market=?'
      ).bind('void', null, null, r.sport, r.date, r.game_id, r.market || 'h2h'));
      out.voidedMoved.push(`${r.date} ${r.away}@${r.home} (${r.market || 'h2h'}), played under ${moved.game_id}`);
    }
    if (voids.length) await env.DB.batch(voids);
  }
  return out;
}

// Passing touchdowns, logged only.
//
// Reuses gmpicks — a side, a fair number, a price and a result is the same
// shape whether the side is a team or a player's under. sport 'nflptd' keeps it
// out of the NFL moneyline record, which is about games.
//
// The side is always the under, because that is the question: is the sharp
// pool's under-1.5 price cheaper than the 55.4% the market has actually run at.
// Logging the model-preferred side instead would answer a question no one asked
// and leave the baseline uncomparable.
const PTD_SHARP = ['betonlineag', 'novig', 'prophetx', 'pinnacle', 'lowvig'];
const PTD_EXEC = ['draftkings', 'fanduel', 'betmgm', 'betrivers', 'williamhill_us'];

function passTdEntries(rows, week, seasonType) {
  // rows: nfl_lines rows for market player_pass_tds, latest per (event, player, book)
  const byPlayer = new Map();
  for (const r of rows) {
    if (r.market !== 'player_pass_tds') continue;
    if (Number(r.point) !== NFL_PASS_TD_LINE) continue;      // only the standard line
    const k = `${r.event_id}|${r.player}`;
    if (!byPlayer.has(k)) byPlayer.set(k, { event_id: r.event_id, player: r.player, commence: r.commence, home: r.home, away: r.away, books: {} });
    byPlayer.get(k).books[r.book] = { over: r.over, under: r.under };
  }
  const out = [];
  for (const g of byPlayer.values()) {
    // Every book's no-vig chance of the under, two-way Shin on over/under.
    const byBook = {};
    for (const [bk, q] of Object.entries(g.books)) {
      if (!q || typeof q.over !== 'number' || typeof q.under !== 'number') continue;
      const pOver = shinDevig(q.over, q.under);
      if (pOver != null && isFinite(pOver)) byBook[bk] = 1 - pOver;              // p(under)
    }
    // The fair (2026-10-27): Pinnacle's, then FanDuel's -- Pikkit's 2024 NFL
    // props ranking has Pinnacle first and FanDuel second -- and without
    // either, two or more of the rest of the pool (sharpFair).
    const pool = sharpFair(Object.fromEntries(PTD_SHARP.filter((bk) => byBook[bk] != null).map((bk) => [bk, byBook[bk]])));
    const sf = byBook.pinnacle != null ? pool : byBook.fanduel != null ? { fair: byBook.fanduel, src: 'fanduel', n: pool.n } : pool;
    if (sf.fair == null) continue;
    const fairUnder = sf.fair;
    // Best executable under price.
    let price = null, book = null;
    for (const bk of PTD_EXEC) {
      const q = g.books[bk];
      if (!q || typeof q.under !== 'number') continue;
      if (price == null || amProb(q.under) < amProb(price)) { price = q.under; book = bk; }
    }
    if (price == null) continue;
    out.push({
      game_id: `${g.event_id}|${g.player}`,
      market: 'pass_tds', league: seasonType || 'REG', week,
      commence: g.commence, side: 'under', point: NFL_PASS_TD_LINE,
      pick: `${g.player} under ${NFL_PASS_TD_LINE}`,
      home: g.home, away: g.away,
      win_prob: Math.round(fairUnder * 1000) / 10,
      implied: Math.round(amProb(price) * 1000) / 10,
      // Edge against the realised baseline, not against the model — there is no
      // model. Positive means the price is cheaper than the rate history ran at.
      edge: Math.round((NFL_PASS_TD_BASE - amProb(price) * 100) * 10) / 10,
      price, book, fair_src: sf.src, sharp_n: sf.n, book_fairs: bookFairsJson(byBook),
    });
  }
  return out;
}

// The season a date's game belongs to. ESPN's NFL scoreboard is asked by
// season year, and Weeks 17-18 and the playoffs are played the January after.
function nflSeasonOf(date) {
  const y = Number(String(date).slice(0, 4)), m = Number(String(date).slice(5, 7));
  return m && m <= 6 ? y - 1 : y;
}

// Every passer's line for one NFL week, read from the box score of each final
// game a pending row is in -- one fetch a game.
//
// The first passing-TD grader read the scoreboard's leaders instead. Checked
// against the real Week 3 payload it was wrong twice over: ESPN hangs leaders
// on the competition, not on each team, and it lists only the single game
// leader -- Jordan Love, 312 yards -- so Michael Penix never appeared at all.
// The box score carries both passers:
//   ATL  Michael Penix Jr.  18/25  256  ...  TD 1
//   GB   Jordan Love        28/53  312  ...  TD 2
//
// stats: base name -> { td, yds }. passersBy: `away|home` -> the base names of
// everyone who threw a pass, for each game whose box score was read. Null when
// the scoreboard could not be read.
async function nflPassingWeek(yr, lg, wk, rs) {
  let events = [];
  try {
    events = await espnScoreboard(`nfl/scoreboard?xhr=1&year=${yr}&seasontype=${String(lg).toUpperCase() === 'PRE' ? 1 : 2}&week=${wk}`);
  } catch (e) { return null; }
  const stats = new Map();
  const passersBy = new Map();
  const want = new Set(rs.map((r) => `${r.away}|${r.home}`));
  for (const ev of events) {
    const st = (ev && ev.status && ev.status.type && ev.status.type.name) || '';
    if (!/FINAL/.test(String(st))) continue;
    const c = (ev.competitions || [])[0];
    const names = ((c && c.competitors) || []).map((t) => (t.team || {}).displayName || '');
    const keys = [...want].filter((k) => { const [a, h] = k.split('|'); return names.includes(a) && names.includes(h); });
    if (!keys.length || !ev.id) continue;
    let sum;
    try {
      const r = await fetch(`${ESPN_CDN}/boxscore?xhr=1&gameId=${ev.id}`,
        { headers: { accept: 'application/json', 'user-agent': ESPN_UA } });
      if (!r.ok) continue;
      sum = await r.json();
    } catch (e) { continue; }
    const box = (sum.gamepackageJSON && sum.gamepackageJSON.boxscore) || sum.boxscore || {};
    const passers = [];
    for (const team of (box.players || [])) {
      const cat = (team.statistics || []).find((x) => x.name === 'passing');
      if (!cat) continue;
      const labels = (cat.labels || []).map((l) => String(l).toUpperCase());
      const ti = labels.indexOf('TD'), yi = labels.indexOf('YDS');
      if (ti < 0 && yi < 0) continue;
      for (const a of (cat.athletes || [])) {
        const nm = (a.athlete || {}).displayName;
        const td = ti < 0 ? NaN : Number((a.stats || [])[ti]);
        const yds = yi < 0 ? NaN : Number((a.stats || [])[yi]);
        if (!nm || (!Number.isFinite(td) && !Number.isFinite(yds))) continue;
        stats.set(nflBaseName(nm), { td: Number.isFinite(td) ? td : null, yds: Number.isFinite(yds) ? yds : null });
        passers.push(nflBaseName(nm));
      }
    }
    if (passers.length) for (const k2 of keys) passersBy.set(k2, passers);
  }
  return { stats, passersBy };
}

// A quarterback with no stat line did not play once his game's box score has
// been read and no passer in it shares even his surname; the row is void. A
// surname match (a "Cam" against a "Cameron") stays pending instead, where a
// name mismatch can be seen. `passers` is undefined until the box score is in.
function nflPasserAbsent(passers, name) {
  const last = nflBaseName(name).split(' ').pop();
  return !!(passers && last && !passers.some((p) => p.split(' ').pop() === last));
}

// Grades from the box score the NFL projections already read, not from a
// scoreboard: the result needed is one player's passing touchdowns.
async function gradePassTds(env) {
  const out = { graded: 0, pending: 0, voided: 0 };
  if (!env || !env.DB) return out;
  await ensureGamePickSchema(env.DB);
  const today = slateDate();
  const rows = (await env.DB.prepare(
    "SELECT * FROM gmpicks WHERE sport='nflptd' AND result IS NULL AND date < ?"
  ).bind(today).all()).results || [];
  out.pending = rows.length;
  if (!rows.length) return out;
  const byWeek = new Map();
  for (const r of rows) {
    const k = `${nflSeasonOf(r.date)}|${r.league}|${r.week}`;
    if (!byWeek.has(k)) byWeek.set(k, []);
    byWeek.get(k).push(r);
  }
  const stmts = [];
  for (const [k, rs] of byWeek) {
    const [yr, lg, wk] = k.split('|');
    if (!wk || wk === 'null') continue;
    const week = await nflPassingWeek(yr, lg, wk, rs);
    if (!week) continue;
    for (const r of rs) {
      const nm = String(r.pick || '').replace(/ under .*$/, '');
      const s = week.stats.get(nflBaseName(nm));
      const got = s ? s.td : null;
      if (got == null) {
        // Not final yet, or the quarterback did not play. Week 3's Tyson Bagent
        // row sat pending for good because Case Keenum started. See
        // nflPasserAbsent for when that is called.
        if (nflPasserAbsent(week.passersBy.get(`${r.away}|${r.home}`), nm)) {
          stmts.push(env.DB.prepare(
            "UPDATE gmpicks SET result=?, home_score=? WHERE sport='nflptd' AND date=? AND game_id=? AND market=?"
          ).bind('void', null, r.date, r.game_id, r.market));
          out.voided++;
        }
        continue;
      }
      const result = got === r.point ? 'push' : (got < r.point ? 'win' : 'loss');
      stmts.push(env.DB.prepare(
        "UPDATE gmpicks SET result=?, home_score=? WHERE sport='nflptd' AND date=? AND game_id=? AND market=?"
      ).bind(result, got, r.date, r.game_id, r.market));
      out.graded++;
    }
  }
  if (stmts.length) await env.DB.batch(stmts);
  return out;
}

// Until 2026-09-24 a capture dated every passing-TD row from the first entry in
// it, so four Sunday quarterbacks were also filed under Thursday. Those rows are
// left in the table rather than deleted; this keeps one per (game, player) —
// the copy whose date matches its own kickoff — so nothing is counted twice.
function dedupePassTds(rows) {
  const best = new Map();
  for (const r of rows) {
    const own = r.commence ? ptDateOf(Date.parse(r.commence)) : null;
    const prev = best.get(r.game_id);
    if (!prev) { best.set(r.game_id, r); continue; }
    const prevOwn = prev.commence ? ptDateOf(Date.parse(prev.commence)) : null;
    if (own === r.date && prevOwn !== prev.date) best.set(r.game_id, r);
  }
  return [...best.values()];
}

function buildPassTdRecord(rows) {
  const mine = dedupePassTds(rows.filter((r) => r.sport === 'nflptd'));
  const graded = mine.filter((r) => r.result === 'win' || r.result === 'loss');
  const w = graded.filter((r) => r.result === 'win').length;
  let u = 0;
  for (const r of graded) u += profitUnits(r.result, mlGradePrice(r));
  // The whole point: what the sharp pool said, against what history ran at.
  const fair = graded.filter((r) => r.win_prob != null).map((r) => r.win_prob);
  const impl = graded.filter((r) => r.implied != null).map((r) => r.implied);
  const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length * 10) / 10 : null);
  return {
    note: `passing touchdowns, under ${NFL_PASS_TD_LINE}, LOGGED ONLY — nothing projected and nothing posted. `
      + `Read against ${NFL_PASS_TD_BASE}%, the realised under-${NFL_PASS_TD_LINE} rate over 1,082 QB starts in 2024-25 `
      + `(55.6% and 55.1% by season). If the sharp fair sits at or above that, the market has it priced and there is nothing here.`,
    baseline: NFL_PASS_TD_BASE,
    logged: mine.length, pending: mine.filter((r) => r.result == null).length,
    pushed: mine.filter((r) => r.result === 'push').length,
    n: graded.length, record: `${w}–${graded.length - w}`,
    underRate: graded.length ? round1(w / graded.length * 100) : null,
    units: Math.round(u * 10) / 10,
    roi: graded.length ? round1(u / graded.length * 100) : null,
    sharpFairMean: avg(fair),
    bestPriceImpliedMean: avg(impl),
    verdict: avg(fair) == null ? null
      : (avg(fair) >= NFL_PASS_TD_BASE
        ? 'sharp pool is at or above the realised rate — priced, no edge visible'
        : 'sharp pool is below the realised rate — worth continuing to watch'),
  };
}

// Passing yards, logged only (2026-10-15).
//
// Nothing is projected -- the projection failed its backtest -- and there is no
// price: PrizePicks pays by entry, not by line, and no two sharp books hang the
// same number, so no two-book fair exists. What is logged is every book's
// number for each quarterback PrizePicks quotes, and what is asked of it after
// the game is whether PrizePicks' under landed below PrizePicks' number, split
// by where that number sat against the books'.
//
// Its own table, not gmpicks: a gmpicks row needs a price and a fair to pass
// mlPriceSane, and its close refresh rewrites the fair -- neither fits a row
// whose only numbers are lines. pp_open/book_open are the first capture's,
// pp_line/book_line the last before kickoff, which is what is graded.
async function ensurePassYdsSchema(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS nflpyd (
    event_id TEXT NOT NULL, player TEXT NOT NULL,
    season INTEGER, week INTEGER, season_type TEXT, date TEXT, commence TEXT, home TEXT, away TEXT,
    pp_open REAL, book_open REAL,
    pp_line REAL, book_line REAL, book_n INTEGER, sharp_line REAL, sharp_n INTEGER, dk_line REAL,
    quotes TEXT, first_at TEXT, last_at TEXT,
    actual REAL, result TEXT, graded_at TEXT,
    PRIMARY KEY (event_id, player)
  )`).run();
  // The grader asks every cron tick; this keeps that to the ungraded rows.
  await db.prepare('CREATE INDEX IF NOT EXISTS nflpyd_open ON nflpyd (date) WHERE result IS NULL').run();
}

// A book's main number for one player: of the points it quotes, the two-sided
// one priced nearest even money. A one-sided point (PrizePicks' demons and
// goblins come over-only) is used only when there is nothing else.
function pydMainPoint(list) {
  const score = (x) => (typeof x[1] === 'number' && typeof x[2] === 'number'
    ? Math.abs(amProb(x[1]) - amProb(x[2])) : 2);
  const best = [...list].sort((a, b) => score(a) - score(b) || a[0] - b[0])[0];
  return best ? best[0] : null;
}

// Pure: one event's odds payload in, one row per quarterback PrizePicks
// quotes out. quotes = { book: [[point, over, under], ...] }.
function passYdsEntries(ev, d, week, seasonType) {
  const out = [];
  if (!ev || !d) return out;
  const byName = new Map();
  for (const bm of (d.bookmakers || [])) {
    for (const mk of (bm.markets || [])) {
      if (mk.key !== NFL_PASS_YDS_MARKET) continue;
      const cells = new Map();
      for (const o of (mk.outcomes || [])) {
        if (!o.description || o.point == null || !Number.isFinite(Number(o.point))) continue;
        const k = `${o.description}|${o.point}`;
        const c = cells.get(k) || { player: o.description, point: Number(o.point), over: null, under: null };
        if (o.name === 'Over') c.over = o.price; else if (o.name === 'Under') c.under = o.price;
        cells.set(k, c);
      }
      for (const c of cells.values()) {
        const nk = nflBaseName(c.player);
        const q = byName.get(nk) || { player: c.player, quotes: {} };
        // PrizePicks' spelling names the row, so it keys the same way every
        // capture whatever order the books come back in.
        if (bm.key === 'prizepicks') q.player = c.player;
        (q.quotes[bm.key] = q.quotes[bm.key] || []).push([c.point, c.over, c.under]);
        byName.set(nk, q);
      }
    }
  }
  const lineOf = (q, books) => {
    const pts = books.filter((b) => q.quotes[b]).map((b) => pydMainPoint(q.quotes[b])).filter((x) => x != null);
    return { line: pts.length ? median(pts) : null, n: pts.length };
  };
  for (const q of byName.values()) {
    if (!q.quotes.prizepicks) continue;
    const others = Object.keys(q.quotes).filter((b) => b !== 'prizepicks');
    const bk = lineOf(q, others);
    const sh = lineOf(q, PTD_SHARP);
    out.push({
      event_id: ev.id, player: q.player,
      season: nflSeasonOf(ptDateOf(Date.parse(ev.commence_time))), week: week == null ? null : week,
      season_type: seasonType || 'REG', date: ptDateOf(Date.parse(ev.commence_time)),
      commence: ev.commence_time || null, home: ev.home_team || null, away: ev.away_team || null,
      pp_line: pydMainPoint(q.quotes.prizepicks),
      book_line: bk.line, book_n: bk.n,
      sharp_line: sh.line, sharp_n: sh.n,
      dk_line: q.quotes.draftkings ? pydMainPoint(q.quotes.draftkings) : null,
      quotes: JSON.stringify(q.quotes),
    });
  }
  return out;
}

// First capture sets the open; every later one before kickoff moves the line
// that is graded. A graded row is never rewritten.
async function logPassYds(db, rows, stamp) {
  if (!db || !rows || !rows.length) return 0;
  await ensurePassYdsSchema(db);
  const stmts = rows.map((r) => db.prepare(
    `INSERT INTO nflpyd (event_id, player, season, week, season_type, date, commence, home, away,
       pp_open, book_open, pp_line, book_line, book_n, sharp_line, sharp_n, dk_line, quotes, first_at, last_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT (event_id, player) DO UPDATE SET
       pp_line = excluded.pp_line, book_line = excluded.book_line, book_n = excluded.book_n,
       sharp_line = excluded.sharp_line, sharp_n = excluded.sharp_n, dk_line = excluded.dk_line,
       quotes = excluded.quotes, last_at = excluded.last_at
     WHERE nflpyd.result IS NULL`
  ).bind(r.event_id, r.player, r.season, r.week, r.season_type, r.date, r.commence, r.home, r.away,
    r.pp_line, r.book_line, r.pp_line, r.book_line, r.book_n, r.sharp_line, r.sharp_n, r.dk_line,
    r.quotes, stamp, stamp));
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
  return stmts.length;
}

async function gradePassYds(env) {
  const out = { graded: 0, pending: 0, voided: 0 };
  if (!env || !env.DB) return out;
  await ensurePassYdsSchema(env.DB);
  // Two weeks back at most. A row the box score cannot settle (a name that
  // matches only by surname) would otherwise send the cron to ESPN every tick
  // for the rest of the season; past two weeks it is left pending, visibly.
  const rows = (await env.DB.prepare('SELECT * FROM nflpyd WHERE result IS NULL AND date < ? AND date >= ?')
    .bind(slateDate(), slateDateOffset(-14)).all()).results || [];
  out.pending = rows.length;
  if (!rows.length) return out;
  const byWeek = new Map();
  for (const r of rows) {
    const k = `${r.season}|${r.season_type}|${r.week}`;
    if (!byWeek.has(k)) byWeek.set(k, []);
    byWeek.get(k).push(r);
  }
  const at = new Date().toISOString();
  const stmts = [];
  for (const [k, rs] of byWeek) {
    const [yr, lg, wk] = k.split('|');
    if (!wk || wk === 'null' || !yr || yr === 'null') continue;
    const week = await nflPassingWeek(yr, lg, wk, rs);
    if (!week) continue;
    for (const r of rs) {
      const s = week.stats.get(nflBaseName(r.player));
      const yds = s ? s.yds : null;
      let result = null;
      if (yds == null) {
        if (nflPasserAbsent(week.passersBy.get(`${r.away}|${r.home}`), r.player)) result = 'void';
      } else if (r.pp_line != null) {
        result = yds === r.pp_line ? 'push' : (yds < r.pp_line ? 'under' : 'over');
      }
      if (!result) continue;
      stmts.push(env.DB.prepare('UPDATE nflpyd SET result=?, actual=?, graded_at=? WHERE event_id=? AND player=?')
        .bind(result, yds, at, r.event_id, r.player));
      if (result === 'void') out.voided++; else out.graded++;
    }
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return out;
}

// The question, and what would make it worth posting: PrizePicks' under, at
// PrizePicks' number, where that number sits above the books'. Posting needs
// the 95% interval clear of the entry break-even, not a point estimate above it.
const PYD_MIN_N = 30;
function buildPassYdsRecord(rows) {
  const graded = rows.filter((r) => r.result === 'under' || r.result === 'over');
  const split = ppSplitRecord(graded.map((r) => ({
    p: null, won: r.result === 'under' ? 1 : 0,
    gap: r.book_line != null && r.pp_line != null ? round1(r.pp_line - r.book_line) : null,
  })));
  const vsSharp = ppSplitRecord(graded.map((r) => ({
    p: null, won: r.result === 'under' ? 1 : 0,
    gap: r.sharp_line != null && r.pp_line != null ? round1(r.pp_line - r.sharp_line) : null,
  }))).byLineGap;
  const cell = (l) => {
    const hit = l.filter((r) => r.result === 'under').length;
    return { n: l.length, hit, hitRate: l.length ? round1(hit / l.length * 100) : null };
  };
  // A control: the books' own under at the books' own number. If that runs
  // well above half too, a PrizePicks result is the season, not the gap.
  const atBook = graded.filter((r) => r.book_line != null && typeof r.actual === 'number');
  const controlAtBookLine = cell(atBook.filter((r) => r.actual !== r.book_line)
    .map((r) => ({ result: r.actual < r.book_line ? 'under' : 'over' })));
  const gaps = rows.filter((r) => r.pp_line != null && r.book_line != null).map((r) => r.pp_line - r.book_line);
  const hi = split.byLineGap.ppHigher;
  const BE = { '6-pick flex': 54.2, '2-pick power': 57.7 };
  let ci = null, verdict;
  if (hi.n < PYD_MIN_N) {
    verdict = `too few to say: ${hi.n} graded where PrizePicks sat above the books, ${PYD_MIN_N} needed before reading anything`;
  } else {
    const p = hi.hit / hi.n, se = Math.sqrt(p * (1 - p) / hi.n) * 100;
    ci = { lo: round1(p * 100 - 1.96 * se), hi: round1(p * 100 + 1.96 * se) };
    verdict = ci.lo > BE['6-pick flex']
      ? `worth posting: PrizePicks-higher unders ${hi.hitRate}%, interval ${ci.lo}-${ci.hi} clears the ${BE['6-pick flex']}% flex break-even`
      : (ci.hi < BE['6-pick flex']
        ? `not worth posting: PrizePicks-higher unders ${hi.hitRate}%, interval ${ci.lo}-${ci.hi} sits below the ${BE['6-pick flex']}% flex break-even`
        : `inconclusive: PrizePicks-higher unders ${hi.hitRate}%, interval ${ci.lo}-${ci.hi} straddles the ${BE['6-pick flex']}% flex break-even`);
  }
  return {
    note: "passing yards, LOGGED ONLY — nothing projected and nothing posted. hit = PrizePicks' under landed below PrizePicks' number; "
      + "byLineGap.ppHigher = that number sat above the books' median line, so its under was easier than the market's.",
    logged: rows.length,
    pending: rows.filter((r) => r.result == null).length,
    voided: rows.filter((r) => r.result === 'void').length,
    pushed: rows.filter((r) => r.result === 'push').length,
    n: split.n, hit: split.hit, hitRate: split.hitRate,
    byLineGap: split.byLineGap,
    ppHigherBy5: cell(graded.filter((r) => r.book_line != null && r.pp_line != null && r.pp_line - r.book_line >= 5)),
    vsSharpLine: vsSharp,
    controlAtBookLine,
    meanGap: gaps.length ? round1(gaps.reduce((s, x) => s + x, 0) / gaps.length) : null,
    breakEvens: BE,
    ci, verdict,
  };
}

// One band of graded game-line rows by the sharp win probability: how they did,
// and what they were expected to do (the band's average win probability).
function gmBand(graded, lo, hi) {
  const b = graded.filter((r) => r.win_prob >= lo && r.win_prob < hi);
  let w = 0, u = 0;
  for (const r of b) { if (r.result === 'win') w++; u += profitUnits(r.result, mlGradePrice(r)); }
  const exp = b.length ? round1(b.reduce((s, r) => s + r.win_prob, 0) / b.length) : null;
  return { n: b.length, record: `${w}–${b.length - w}`, winRate: b.length ? round1(w / b.length * 100) : null,
    expected: exp, units: Math.round(u * 10) / 10, roi: b.length ? round1(u / b.length * 100) : null };
}

// "Do the teams rated likeliest to win, win often enough to pay?" Banded by the
// sharp win probability, because a 70% favourite at -300 and a 45% one at +150
// are different bets and a single record would average them into nothing.
function buildSoccerFavRecord(rows) {
  const fav = rows.filter((r) => r.sport === 'soccer' && r.market === 'fav');
  const base = buildGmRecord(fav, 'soccer');
  const graded = fav.filter((r) => r.result === 'win' || r.result === 'loss');
  const band = (lo, hi) => gmBand(graded, lo, hi);
  return {
    ...base,
    note: 'Soccer: the side the sharp books rate likeliest to win in each fixture, at the best DK/FD price. LOGGED ONLY. expected = the average sharp win probability in the band; a winRate above it means the favourites beat their own odds.',
    byBand: { '65+': band(65, 101), '55-65': band(55, 65), '45-55': band(45, 55), 'under 45': band(0, 45) },
  };
}

function buildGmRecord(rows, sport) {
  const mine = rows.filter((r) => r.sport === sport);
  const graded = mine.filter((r) => r.result === 'win' || r.result === 'loss');
  const sum = (arr) => {
    let w = 0, u = 0;
    for (const r of arr) { if (r.result === 'win') w++; u += profitUnits(r.result, mlGradePrice(r)); }
    return { n: arr.length, record: `${w}–${arr.length - w}`, winRate: arr.length ? round1(w / arr.length * 100) : null,
      units: Math.round(u * 10) / 10, roi: arr.length ? round1(u / arr.length * 100) : null };
  };
  const bySide = {};
  for (const sd of [...new Set(graded.map((r) => r.side))]) bySide[sd] = sum(graded.filter((r) => r.side === sd));
  const byMarket = {};
  for (const mk of [...new Set(graded.map((r) => r.market || 'h2h'))]) byMarket[mk] = sum(graded.filter((r) => (r.market || 'h2h') === mk));
  const byLeague = {};
  // NBA splits too: preseason ('pre') and regular season ('reg') are different
  // games -- starters sit -- and must never be read as one record.
  if (sport === 'soccer' || sport === 'nba') for (const lg of [...new Set(graded.map((r) => r.league))]) byLeague[lg] = sum(graded.filter((r) => r.league === lg));
  let beat = 0, clvN = 0;
  for (const r of graded) {
    const ie = amProb(r.entry_price), ic = amProb(r.close_price);
    if (ie == null || ic == null || r.entry_price === r.close_price) continue;
    clvN++; if (ic > ie) beat++;
  }
  return {
    note: `${sport} game lines, LOGGED ONLY — not posted and not ranked. The sharp pool's fair number against the best executable price, graded from free ${sport === 'nhl' ? 'NHL (api-web.nhle.com)' : 'ESPN'} finals.`,
    logged: mine.length,
    pending: mine.filter((r) => r.result == null).length,
    pushed: mine.filter((r) => r.result === 'push').length,
    ...sum(graded),
    bySide, byMarket,
    ...(sport === 'soccer' || sport === 'nba' ? { byLeague } : {}),
    // The NHL log is judged band by band, 65%+ first: that is the bar Picks of
    // the day lists every other sport's favourites at (PICK_KINDS), and NHL is
    // not on that list until its own 65%+ favourites have held up (2026-10-20).
    // The NFL board shows the same line since 2026-10-25, and from 2026-10-26
    // its own bar, 75%+, with the 65-75% favourites it left beside it. `bar`
    // is the sport's Picks floor, so the page leads with the band Picks uses.
    ...(sport === 'nhl' || sport === 'nfl' ? { byBand: { '65+': gmBand(graded, 65, 101), '60-65': gmBand(graded, 60, 65),
      '55-60': gmBand(graded, 55, 60), 'under 55': gmBand(graded, 0, 55),
      ...(sport === 'nfl' ? { '75+': gmBand(graded, 75, 101), '65-75': gmBand(graded, 65, 75) } : {}) },
      bar: PICK_KINDS[sport + '_ml'].min } : {}),
    // NHL home favourites at 60%+ (2026-10-26), logged beside the 65%+ bar:
    // by Oct 25 the NHL's 65%+ favourites were 2 of 5 and its 55-65% ones 13
    // of 18, home sides 17 of 26 and away ones 5 of 13. Two weeks of this say
    // whether it, and not 65%+, is the NHL's bar. Not on Picks of the day.
    ...(sport === 'nhl' ? { homeFav60: gmBand(graded.filter((r) => r.side === 'home'), 60, 101) } : {}),
    clvBeatRate: clvN ? round1(beat / clvN * 100) : null, clvN,
  };
}


// ---------------------------------------------------------------------------
// Your entries — what you actually bet, graded.
//
// Every record on this site so far grades the board's own picks. None of it
// grades what you actually play: PrizePicks power and flex entries and
// DraftKings straights and parlays, built before the games. "Which options win"
// can only be answered from those, so this is where they are kept.
//
// Private by key. The phone generates one; the first key to save claims the log
// and every later save or read must present it (header x-entry-key, never a URL
// parameter). If ENTRY_KEY is set as a Worker secret, that is the key instead.
// Responses are never cached and carry no CORS header, so another site cannot
// read them from your browser.
//
// Grading reuses the PrizePicks log's machinery — the same box scores, the same
// batterActual and pitcherKsFromBox — for MLB props, strikeouts and moneylines.
// Anything else (NFL, soccer, NBA, other DraftKings markets) takes a one-tap
// result until its sport grows a grader.
//
// Payouts: standard PrizePicks multipliers — the ones this site's break-evens
// were computed from — and DraftKings from the odds. Goblins, demons, boosts and
// promos pay differently, so any entry's payout can be overridden with what the
// app actually paid.
const PP_POWER = { 2: 3, 3: 5, 4: 10, 5: 20, 6: 37.5 };
const PP_FLEX = { 3: { 3: 2.25, 2: 1.25 }, 4: { 4: 5, 3: 1.5 }, 5: { 5: 10, 4: 2, 3: 0.4 }, 6: { 6: 25, 5: 2, 4: 0.4 } };
const ENTRY_MARKETS_AUTO = new Set(['tb', 'hrr', 'hr', 'K', 'ml']);

async function ensureEntrySchema(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS entries (
    id TEXT PRIMARY KEY, created_at TEXT, date TEXT,
    book TEXT, kind TEXT, legs_n INTEGER, stake REAL,
    payout REAL, payout_src TEXT, status TEXT, note TEXT
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS entry_legs (
    entry_id TEXT, idx INTEGER,
    sport TEXT, date TEXT, game_id TEXT, player_id INTEGER, player TEXT, team TEXT,
    market TEXT, line REAL, side TEXT, price INTEGER, model_prob REAL,
    result TEXT, actual REAL, graded_by TEXT,
    PRIMARY KEY (entry_id, idx)
  )`).run();
  await db.prepare('CREATE INDEX IF NOT EXISTS entry_legs_open ON entry_legs (game_id) WHERE result IS NULL').run();
  // settleEntries asks for the open entries every five minutes.
  await db.prepare("CREATE INDEX IF NOT EXISTS entries_open ON entries (status) WHERE status = 'open'").run();
}

async function sha256hex(str) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

async function entryAuth(env, request) {
  const key = (request.headers.get('x-entry-key') || '').trim();
  if (key.length < 16) return { ok: false, status: 401, error: 'This device has no entries key yet.' };
  if (env.ENTRY_KEY) {
    return key === env.ENTRY_KEY ? { ok: true } : { ok: false, status: 403, error: 'That key does not open this log.' };
  }
  const h = await sha256hex(key);
  const cur = await loadFeedCache(env.DB, 'entries_owner');
  if (cur.present && cur.data && cur.data.h) {
    return cur.data.h === h ? { ok: true } : { ok: false, status: 403, error: 'That key does not open this log.' };
  }
  await saveFeedCache(env.DB, 'entries_owner', { h, claimedAt: new Date().toISOString() });
  return { ok: true, claimed: true };
}

function entryResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
  });
}

const amDec = (p) => (p == null || !isFinite(p) ? null : (p > 0 ? 1 + p / 100 : 1 + 100 / Math.abs(p)));

// What an entry returned, from its legs. A push is removed like a void — the
// way PrizePicks treats a tie with the line — and an entry left under its
// minimum size is refunded.
function entryPayout(e, legs) {
  const stake = Number(e.stake) || 0;
  const live = legs.filter((l) => l.result === 'win' || l.result === 'loss');
  const wins = live.filter((l) => l.result === 'win').length;
  const lost = live.length - wins;
  if (e.book === 'pp') {
    const n = live.length;
    if (n < 2) return { payout: stake, src: 'table' };
    if (e.kind === 'flex' && n >= 3) {
      const mult = (PP_FLEX[Math.min(n, 6)] || {})[wins] || 0;
      return { payout: Math.round(stake * mult * 100) / 100, src: 'table' };
    }
    // Power, or a flex reduced below three legs.
    return { payout: lost ? 0 : Math.round(stake * (PP_POWER[Math.min(n, 6)] || 0) * 100) / 100, src: 'table' };
  }
  // DraftKings.
  if (!live.length) return { payout: stake, src: 'odds' };
  if (lost) return { payout: 0, src: 'odds' };
  const dec = live.reduce((d, l) => d * (amDec(l.price) || 1), 1);
  return { payout: Math.round(stake * dec * 100) / 100, src: 'odds' };
}

// Grade open MLB legs whose games are final (free: StatsAPI only), and the NFL
// and soccer legs the site's own graded rows can settle (see
// gradeEntryLegsOther: no fetch at all).
async function gradeEntryLegs(env) {
  const db = env.DB;
  await ensureEntrySchema(db);
  const open = ((await db.prepare(
    "SELECT * FROM entry_legs WHERE result IS NULL AND sport = 'mlb' AND game_id IS NOT NULL"
  ).all()).results || []).filter((l) => ENTRY_MARKETS_AUTO.has(l.market));
  const byPk = open.length ? await gamesByPk(open.map((l) => l.game_id)) : {};
  const boxes = {};
  const stmts = [];
  // The other sports first: they need no fetch at all, and an MLB pass with
  // nothing open used to return before reaching them.
  try { stmts.push(...(await gradeEntryLegsOther(db))); } catch (e) { /* next pass */ }
  for (const l of open) {
    const g = byPk[l.game_id];
    if (!g) continue;
    if (isAbandoned(g)) {
      stmts.push(db.prepare("UPDATE entry_legs SET result='void', graded_by='auto' WHERE entry_id=? AND idx=?").bind(l.entry_id, l.idx));
      continue;
    }
    if (g.state !== 'Final') continue;
    let result = null, actual = null;
    if (l.market === 'ml') {
      if (g.homeR == null || g.awayR == null) continue;
      const homeWon = g.homeR > g.awayR;
      result = (l.side === 'home') === homeWon ? 'win' : 'loss';
    } else {
      if (!boxes[l.game_id]) {
        try {
          const r = await fetch(`${STATS}/game/${String(l.game_id).replace(/^g/, '')}/boxscore`, { headers: { accept: 'application/json' } });
          if (!r.ok) continue;
          boxes[l.game_id] = await r.json();
        } catch (e) { continue; }
      }
      const box = boxes[l.game_id];
      actual = l.market === 'K' ? (pitcherKsFromBox(box)[l.player_id] ?? null) : batterActual(box, l.player_id, l.market);
      if (actual == null) result = 'void';                         // did not play
      else if (actual === l.line) result = 'push';
      else result = ((actual < l.line) === (l.side === 'Under')) ? 'win' : 'loss';
    }
    stmts.push(db.prepare("UPDATE entry_legs SET result=?, actual=?, graded_by='auto' WHERE entry_id=? AND idx=?")
      .bind(result, actual, l.entry_id, l.idx));
  }
  if (stmts.length) await db.batch(stmts);
  await settleEntries(env);
  return stmts.length;
}

// NFL and soccer legs (2026-10-04, when the slip began taking them), graded
// from what this site has ALREADY graded, never from a fresh read: the game-
// line log's final scores (gmpicks) for a moneyline, and the frozen
// projections' box-score actuals (nfl_proj) for yardage. No new ESPN calls and
// no second set of matching rules to drift from the ones the records use. A
// leg whose game those rows do not cover stays open for its one-tap result.
const ENTRY_NFL_YDS = { rec_yds: 'receiving', rush_yds: 'rushing' };
// An NFL leg's game is keyed "AWAY @ HOME|YYYY-MM-DD" (Pacific day): the
// moneyline and yardage rows share no event id, but both write the matchup.
function entryNflKey(gameId) {
  const m = /^g?(.+? @ .+?)\|(\d{4}-\d{2}-\d{2})$/.exec(String(gameId || ''));
  if (!m) return null;
  const [away, home] = m[1].split(' @ ');
  return { game: m[1], away, home, date: m[2] };
}
async function gradeEntryLegsOther(db) {
  const open = ((await db.prepare(
    "SELECT * FROM entry_legs WHERE result IS NULL AND sport IN ('nfl','soccer','nba','nhl') AND game_id IS NOT NULL"
  ).all()).results || []).filter((l) => l.market === 'ml' || (l.sport === 'nfl' && ENTRY_NFL_YDS[l.market])
    || (l.sport === 'nba' && nbaPropMarket(l.market))
    || (l.sport === 'soccer' && SOC_PROP_STATS.includes(l.market)));
  if (!open.length) return [];
  // Soccer props grade from the soccer box scores, by ESPN's event and player
  // ids (the slip carries both). A match fully read with the player absent is
  // a player who did not appear: void.
  const socLegs = open.filter((l) => l.sport === 'soccer' && l.market !== 'ml');
  const socBox = new Map(), socDone = new Set();
  if (socLegs.length) {
    try {
      await ensureSocPropSchema(db);
      const gids = [...new Set(socLegs.map((l) => String(l.game_id).replace(/^g/, '')))];
      const ph = gids.map(() => '?').join(',');
      for (const g of ((await db.prepare(`SELECT game_id FROM soc_box_games WHERE done = 1 AND game_id IN (${ph})`).bind(...gids).all()).results || [])) socDone.add(g.game_id);
      for (const b of ((await db.prepare(`SELECT * FROM soc_box WHERE game_id IN (${ph})`).bind(...gids).all()).results || [])) socBox.set(`${b.game_id}|${b.player_id}`, b);
    } catch (e) { /* no soccer box tables yet */ }
  }
  const winnerOf = (hs, as) => (hs > as ? 'home' : as > hs ? 'away' : 'draw');
  // Soccer, the NBA and the NHL keep the odds feed's event id on both sides:
  // the log's game_id and the leg's.
  const byIdLegs = open.filter((l) => (l.sport === 'soccer' || l.sport === 'nba' || l.sport === 'nhl') && l.market === 'ml');
  const socIds = [...new Set(byIdLegs.map((l) => String(l.game_id).replace(/^g/, '')))];
  let soc = [];
  if (socIds.length) {
    await ensureGamePickSchema(db);
    // Through gmpicks_game: the + keeps SQLite off the key's sport column,
    // which it would otherwise take and read three sports whole. The ORDER BY
    // is the key's order, the one these rows came in before: a moved fixture
    // has a row on each date, and the first match below is the one used.
    soc = ((await db.prepare(
      `SELECT sport, game_id, result, home_score, away_score FROM gmpicks WHERE +sport IN ('soccer','nba','nhl') AND result IS NOT NULL AND game_id IN (${socIds.map(() => '?').join(',')})
        ORDER BY sport, date, game_id, market`
    ).bind(...socIds).all()).results || []);
  }
  const keys = open.filter((l) => l.sport === 'nfl').map((l) => entryNflKey(l.game_id)).filter(Boolean);
  let nflGames = [], nflYds = [];
  if (keys.length) {
    // Commence is UTC and the key's day is Pacific, so read a day either side
    // and match on the Pacific day of each row.
    const days = keys.map((k) => Date.parse(k.date + 'T12:00:00Z'));
    const lo = new Date(Math.min(...days) - 2 * 864e5).toISOString();
    const hi = new Date(Math.max(...days) + 2 * 864e5).toISOString();
    await ensureGamePickSchema(db);
    nflGames = ((await db.prepare(
      "SELECT away, home, commence, home_score, away_score FROM gmpicks WHERE sport='nfl' AND result IS NOT NULL AND commence >= ? AND commence < ?"
    ).bind(lo, hi).all()).results || []);
    if (open.some((l) => ENTRY_NFL_YDS[l.market])) {
      try {
        // Through nfl_proj_graded; in rowid order, as the scan it replaced
        // gave them, since the first match below is the one used.
        nflYds = ((await db.prepare(
          'SELECT player, market, game, commence, actual, graded_at FROM nfl_proj WHERE graded_at IS NOT NULL AND commence >= ? AND commence < ? ORDER BY rowid'
        ).bind(lo, hi).all()).results || []);
      } catch (e) { /* no NFL projections table yet */ }
    }
  }
  const sameDay = (iso, day) => ptDateOf(Date.parse(iso)) === day;
  // NBA props grade from the box scores the NBA log reads (nba_box), by the
  // player's name on the leg's day. A day whose games are all read settles a
  // player missing from it as did-not-play.
  const nbaDays = new Map();
  for (const day of [...new Set(open.filter((l) => l.sport === 'nba' && l.market !== 'ml').map((l) => l.date))]) {
    try {
      const rows = ((await db.prepare('SELECT * FROM nba_box WHERE date = ?').bind(day).all()).results || []);
      const pend = await db.prepare('SELECT COUNT(*) AS n FROM nba_box_games WHERE date = ? AND done = 0').bind(day).first();
      const read = await db.prepare('SELECT COUNT(*) AS n FROM nba_box_games WHERE date = ? AND done = 1').bind(day).first();
      nbaDays.set(day, { byName: new Map(rows.map((b) => [nbaName(b.player), b])),
        settled: Number(read && read.n) > 0 && Number(pend && pend.n) === 0 });
    } catch (e) { /* no NBA box table yet */ }
  }
  const stmts = [];
  for (const l of open) {
    let result = null, actual = null;
    if (l.sport === 'soccer' && l.market !== 'ml') {
      const gid = String(l.game_id).replace(/^g/, '');
      if (!socDone.has(gid)) continue;
      const b = socBox.get(`${gid}|${l.player_id}`);
      if (!b || b[l.market] == null) result = 'void';
      else if (l.line == null) continue;
      else {
        actual = b[l.market];
        result = actual === l.line ? 'push' : ((actual < l.line) === (l.side === 'Under') ? 'win' : 'loss');
      }
    } else if (l.sport === 'nba' && l.market !== 'ml') {
      const d = nbaDays.get(l.date);
      if (!d) continue;
      const b = d.byName.get(nbaName(l.player));
      if (b) {
        if (b.dnp || nbaStat(b, l.market) == null) result = 'void';
        else if (l.line == null) continue;
        else {
          actual = nbaStat(b, l.market);
          result = actual === l.line ? 'push' : ((actual < l.line) === (l.side === 'Under') ? 'win' : 'loss');
        }
      } else if (d.settled) result = 'void';
      else continue;
    } else if (l.sport === 'soccer' || l.sport === 'nba' || l.sport === 'nhl') {
      const g = soc.find((x) => x.sport === l.sport && x.game_id === String(l.game_id).replace(/^g/, ''));
      if (!g) continue;
      // A fixture the log voided (listed, then moved) voids the leg with it.
      if (g.result === 'void') result = 'void';
      else if (g.home_score == null || g.away_score == null) continue;
      else {
        const w = winnerOf(g.home_score, g.away_score);
        // The draw is a side in soccer; an NBA or NHL final cannot be level, and
        // if one ever read that way it pushes.
        result = (l.sport === 'nba' || l.sport === 'nhl') && w === 'draw' ? 'push' : (w === l.side ? 'win' : 'loss');
      }
    } else {
      const k = entryNflKey(l.game_id);
      if (!k) continue;
      if (l.market === 'ml') {
        const g = nflGames.find((x) => x.away === k.away && x.home === k.home && sameDay(x.commence, k.date));
        if (!g || g.home_score == null || g.away_score == null) continue;
        const w = winnerOf(g.home_score, g.away_score);
        result = w === 'draw' ? 'push' : (w === l.side ? 'win' : 'loss');    // an NFL tie pushes
      } else {
        const p = nflYds.find((x) => x.market === ENTRY_NFL_YDS[l.market] && x.game === k.game
          && sameDay(x.commence, k.date) && nflBaseName(x.player) === nflBaseName(l.player));
        if (!p) continue;
        actual = p.actual;
        // Graded with no stat line is a player who did not play: void, never a
        // free under.
        if (actual == null) result = 'void';
        else if (l.line == null) continue;
        else if (actual === l.line) result = 'push';
        else result = ((actual < l.line) === (l.side === 'Under')) ? 'win' : 'loss';
      }
    }
    stmts.push(db.prepare("UPDATE entry_legs SET result=?, actual=?, graded_by='auto' WHERE entry_id=? AND idx=?")
      .bind(result, actual, l.entry_id, l.idx));
  }
  return stmts;
}

// Close any open entry whose legs are all decided. A manual payout is kept.
async function settleEntries(env) {
  const db = env.DB;
  const open = (await db.prepare("SELECT * FROM entries WHERE status = 'open'").all()).results || [];
  if (!open.length) return;
  const stmts = [];
  for (const e of open) {
    const legs = (await db.prepare('SELECT * FROM entry_legs WHERE entry_id = ?').bind(e.id).all()).results || [];
    if (!legs.length || legs.some((l) => l.result == null)) continue;
    if (e.payout_src === 'manual') {
      stmts.push(db.prepare("UPDATE entries SET status='settled' WHERE id=?").bind(e.id));
      continue;
    }
    const p = entryPayout(e, legs);
    stmts.push(db.prepare("UPDATE entries SET status='settled', payout=?, payout_src=? WHERE id=?").bind(p.payout, p.src, e.id));
  }
  if (stmts.length) await db.batch(stmts);
}

function entryTypeLabel(e) {
  if (e.book === 'pp') return `PrizePicks ${e.legs_n}-pick ${e.kind === 'flex' ? 'flex' : 'power'}`;
  return e.kind === 'parlay' ? `DraftKings ${e.legs_n}-leg parlay` : 'DraftKings straight';
}
const ENTRY_MARKET_LABEL = { tb: 'Total bases', hrr: 'H+R+RBI', hr: 'Home runs', K: 'Strikeouts', ml: 'Moneyline',
  rec_yds: 'Receiving yards', rush_yds: 'Rushing yards', threes: 'Threes', ast: 'Assists', reb: 'Rebounds', pts: 'Points',
  shots: 'Shots', sot: 'Shots on target', passes: 'Passes attempted', tackles: 'Tackles', clear: 'Clearances', fouls: 'Fouls', saves: 'Goalie saves',
  crosses: 'Crosses', shot_ast: 'Shots assisted', conceded: 'Goals allowed', fouls_drawn: 'Fouls drawn', goal_ast: 'Goal + assist' };

function buildEntrySummary(entries, legs) {
  const settled = entries.filter((e) => e.status === 'settled');
  const money = (list) => {
    const staked = list.reduce((a, e) => a + (Number(e.stake) || 0), 0);
    const back = list.reduce((a, e) => a + (Number(e.payout) || 0), 0);
    const won = list.filter((e) => (Number(e.payout) || 0) > (Number(e.stake) || 0)).length;
    return { entries: list.length, won, staked: Math.round(staked * 100) / 100, returned: Math.round(back * 100) / 100,
      profit: Math.round((back - staked) * 100) / 100, roi: staked ? round1((back - staked) / staked * 100) : null };
  };
  const group = (keyFn) => {
    const m = new Map();
    for (const e of settled) { const k = keyFn(e); if (!m.has(k)) m.set(k, []); m.get(k).push(e); }
    return [...m.entries()].map(([k, list]) => ({ key: k, ...money(list) })).sort((a, b) => b.entries - a.entries);
  };
  const decided = legs.filter((l) => l.result === 'win' || l.result === 'loss');
  const legGroup = (keyFn) => {
    const m = new Map();
    for (const l of decided) { const k = keyFn(l); if (k == null) continue; if (!m.has(k)) m.set(k, { key: k, n: 0, hit: 0 }); const g = m.get(k); g.n++; if (l.result === 'win') g.hit++; }
    return [...m.values()].map((g) => ({ ...g, hitRate: round1(g.hit / g.n * 100) })).sort((a, b) => b.n - a.n);
  };
  const band = (p) => (p == null ? null : p < 50 ? 'under 50%' : p < 55 ? '50–55%' : p < 60 ? '55–60%' : p < 70 ? '60–70%' : '70%+');
  return {
    overall: money(settled),
    open: entries.filter((e) => e.status === 'open').length,
    byType: group(entryTypeLabel),
    byBook: group((e) => (e.book === 'pp' ? 'PrizePicks' : 'DraftKings')),
    legs: { n: decided.length, hit: decided.filter((l) => l.result === 'win').length,
      hitRate: decided.length ? round1(decided.filter((l) => l.result === 'win').length / decided.length * 100) : null },
    legsByMarket: legGroup((l) => ENTRY_MARKET_LABEL[l.market] || l.market || 'Other'),
    legsByModelProb: legGroup((l) => band(l.model_prob)),
    payoutNote: 'PrizePicks entries use standard power and flex payouts; DraftKings uses the logged odds. Override any entry with what the app actually paid.',
  };
}

async function entriesApi(request, env, url) {
  if (!env || !env.DB) return entryResponse({ error: 'no DB binding' }, 500);
  const auth = await entryAuth(env, request);
  if (!auth.ok) return entryResponse({ error: auth.error }, auth.status);
  const db = env.DB;
  await ensureEntrySchema(db);

  if (request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch (e) { return entryResponse({ error: 'Body must be JSON.' }, 400); }
    const act = body && body.action;

    if (act === 'create') {
      const e = body.entry || {};
      const book = e.book === 'dk' ? 'dk' : e.book === 'pp' ? 'pp' : null;
      const kind = String(e.kind || '');
      const legs = Array.isArray(e.legs) ? e.legs.slice(0, 8) : [];
      const stake = Number(e.stake);
      if (!book) return entryResponse({ error: 'Pick PrizePicks or DraftKings.' }, 400);
      if (!(stake > 0 && stake < 100000)) return entryResponse({ error: 'Enter a stake.' }, 400);
      if (book === 'pp' && !['power', 'flex'].includes(kind)) return entryResponse({ error: 'PrizePicks entries are power or flex.' }, 400);
      if (book === 'dk' && !['straight', 'parlay'].includes(kind)) return entryResponse({ error: 'DraftKings bets are straight or parlay.' }, 400);
      if (book === 'pp' && kind === 'power' && (legs.length < 2 || legs.length > 6)) return entryResponse({ error: 'Power entries take 2 to 6 picks.' }, 400);
      if (book === 'pp' && kind === 'flex' && (legs.length < 3 || legs.length > 6)) return entryResponse({ error: 'Flex entries take 3 to 6 picks.' }, 400);
      if (book === 'dk' && kind === 'straight' && legs.length !== 1) return entryResponse({ error: 'A straight bet is one leg.' }, 400);
      if (book === 'dk' && kind === 'parlay' && legs.length < 2) return entryResponse({ error: 'A parlay needs two or more legs.' }, 400);
      if (book === 'dk' && legs.some((l) => l.price == null || !isFinite(Number(l.price)))) {
        return entryResponse({ error: 'Every DraftKings leg needs its odds.' }, 400);
      }
      const id = crypto.randomUUID();
      const dates = legs.map((l) => l.date).filter(Boolean).sort();
      const date = dates[0] || slateDate();
      const stmts = [db.prepare(
        `INSERT INTO entries (id, created_at, date, book, kind, legs_n, stake, payout, payout_src, status, note)
         VALUES (?,?,?,?,?,?,?,NULL,NULL,'open',?)`
      ).bind(id, new Date().toISOString(), date, book, kind, legs.length, stake, e.note ? String(e.note).slice(0, 200) : null)];
      legs.forEach((l, i) => {
        stmts.push(db.prepare(
          `INSERT INTO entry_legs (entry_id, idx, sport, date, game_id, player_id, player, team, market, line, side, price, model_prob, result, actual, graded_by)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL)`
        ).bind(id, i, String(l.sport || 'other').slice(0, 12), l.date || date,
          l.gamePk != null ? 'g' + String(l.gamePk).replace(/^g/, '') : null,
          l.playerId != null && isFinite(Number(l.playerId)) ? Number(l.playerId) : null,
          String(l.player || '').slice(0, 80), l.team ? String(l.team).slice(0, 8) : null,
          String(l.market || 'other').slice(0, 24),
          l.line != null && isFinite(Number(l.line)) ? Number(l.line) : null,
          String(l.side || '').slice(0, 12),
          l.price != null && isFinite(Number(l.price)) ? Math.round(Number(l.price)) : null,
          l.modelProb != null && isFinite(Number(l.modelProb)) ? Math.round(Number(l.modelProb) * 10) / 10 : null));
      });
      await db.batch(stmts);
      return entryResponse({ ok: true, id, claimed: !!auth.claimed });
    }

    if (act === 'delete') {
      await db.batch([
        db.prepare('DELETE FROM entry_legs WHERE entry_id = ?').bind(String(body.id)),
        db.prepare('DELETE FROM entries WHERE id = ?').bind(String(body.id)),
      ]);
      return entryResponse({ ok: true });
    }

    if (act === 'leg') {
      const r = body.result;
      if (![null, 'win', 'loss', 'push', 'void'].includes(r)) return entryResponse({ error: 'Result must be win, loss, push or void.' }, 400);
      await db.prepare("UPDATE entry_legs SET result=?, graded_by=? WHERE entry_id=? AND idx=?")
        .bind(r, r == null ? null : 'manual', String(body.id), Number(body.idx)).run();
      // Reopen so a changed leg re-settles.
      await db.prepare("UPDATE entries SET status='open' WHERE id=? AND payout_src IS NOT 'manual'").bind(String(body.id)).run();
      await settleEntries(env);
      return entryResponse({ ok: true });
    }

    if (act === 'payout') {
      const v = body.payout;
      if (v == null) {
        await db.prepare("UPDATE entries SET payout_src=NULL, payout=NULL, status='open' WHERE id=?").bind(String(body.id)).run();
      } else {
        const n = Number(v);
        if (!(n >= 0 && n < 1e7)) return entryResponse({ error: 'Enter what the app paid.' }, 400);
        await db.prepare("UPDATE entries SET payout=?, payout_src='manual' WHERE id=?").bind(n, String(body.id)).run();
      }
      await settleEntries(env);
      return entryResponse({ ok: true });
    }
    return entryResponse({ error: 'Unknown action.' }, 400);
  }

  // GET: grade what can be graded, then report.
  try { await gradeEntryLegs(env); } catch (e) { /* report what is there */ }
  const entries = (await db.prepare('SELECT * FROM entries ORDER BY date DESC, created_at DESC LIMIT 300').all()).results || [];
  const legs = (await db.prepare('SELECT * FROM entry_legs').all()).results || [];
  const byEntry = new Map();
  for (const l of legs) { if (!byEntry.has(l.entry_id)) byEntry.set(l.entry_id, []); byEntry.get(l.entry_id).push(l); }
  const list = entries.map((e) => ({ ...e, type: entryTypeLabel(e),
    legs: (byEntry.get(e.id) || []).sort((a, b) => a.idx - b.idx) }));
  return entryResponse({ entries: list, summary: buildEntrySummary(entries, legs.filter((l) => entries.some((e) => e.id === l.entry_id))) });
}

async function loadMlLines(db, date) {
  try {
    await ensureMlSchema(db);
    const rows = (await db.prepare('SELECT game_id, home_price, away_price FROM ml_lines WHERE date=?').bind(date).all()).results || [];
    const map = {};
    for (const r of rows) map[r.game_id] = { home: r.home_price, away: r.away_price };
    return map;
  } catch (e) { return {}; } // best-effort — never block the board
}
async function saveMlLines(db, date, pairs) {
  try {
    await ensureMlSchema(db);
    const now = Date.now();
    const stmts = pairs.map((p) => db.prepare(
      'INSERT OR REPLACE INTO ml_lines (date, game_id, home_price, away_price, updated_at) VALUES (?,?,?,?,?)'
    ).bind(date, p.gameId, p.home ?? null, p.away ?? null, now));
    if (stmts.length) await db.batch(stmts);
  } catch (e) { /* persistence is best-effort; never break the board */ }
}

// Strikeout-prop lines persist just like moneylines: each window while a book
// still offers the pre-game prop we snapshot it (keyed by pitcher). Once the
// game starts and the book pulls the market, the snapshot lets the board keep
// showing the CLOSING line + edge (marked closed, not bettable) instead of
// going blank. Stored as the raw book-price object so it reprices identically.
// -------------------------------------------------------------------------
// proj_log — projection accuracy for markets that are NOT bet.
//
// The picks table can only measure a projection that was priced against a line,
// so a market with no line bought is invisible to it. Hits allowed is exactly
// that: projected every slate, never posted. This records the number that was
// projected before first pitch and the number the pitcher actually gave up, so
// the model can be judged on a real out-of-sample record before anyone pays for
// a line to price it against.
// -------------------------------------------------------------------------
async function ensureProjLogSchema(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS proj_log (
    date TEXT, game_id TEXT, pitcher_id INTEGER, market TEXT,
    proj REAL, actual INTEGER, updated_at INTEGER,
    PRIMARY KEY (date, game_id, pitcher_id, market)
  )`).run();
  // Partial index over projections still waiting on a boxscore — the other half
  // of gradeUngraded's UNION. See picks_ungraded in ensureSchema.
  await db.prepare('CREATE INDEX IF NOT EXISTS proj_log_ungraded ON proj_log (date, game_id) WHERE actual IS NULL').run();
}
// Written once per slate render. INSERT OR IGNORE, never REPLACE: the value being
// judged is what the model said BEFORE the game, and a later pass re-projecting
// the same start with newer season rates would quietly overwrite the prediction
// with a better-informed one and flatter the record.
async function saveProjLog(db, date, rows) {
  try {
    await ensureProjLogSchema(db);
    const now = Date.now();
    const stmts = [];
    for (const g of rows) {
      for (const p of (g.pitchers || [])) {
        if (!p || p.id == null || typeof p.projH !== 'number') continue;
        stmts.push(db.prepare(
          'INSERT OR IGNORE INTO proj_log (date, game_id, pitcher_id, market, proj, actual, updated_at) VALUES (?,?,?,?,?,NULL,?)'
        ).bind(date, String(g.id), p.id, 'H', p.projH, now));
      }
    }
    for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
  } catch (e) { /* best-effort; a missed slate is a gap in the record, not a bug */ }
}

async function ensurePropSchema(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS prop_lines (
    date TEXT, name TEXT, data TEXT, updated_at INTEGER,
    PRIMARY KEY (date, name)
  )`).run();
}
async function loadPropLines(db, date) {
  try {
    await ensurePropSchema(db);
    const rows = (await db.prepare('SELECT name, data FROM prop_lines WHERE date=?').bind(date).all()).results || [];
    const map = {};
    for (const r of rows) { try { map[r.name] = JSON.parse(r.data); } catch (e) { /* skip bad row */ } }
    return map;
  } catch (e) { return {}; } // best-effort — never block the board
}
async function savePropLines(db, date, propByName) {
  try {
    await ensurePropSchema(db);
    const now = Date.now();
    const stmts = Object.entries(propByName)
      .filter(([, rec]) => rec && Object.keys(rec).length)
      .map(([name, rec]) => db.prepare(
        'INSERT OR REPLACE INTO prop_lines (date, name, data, updated_at) VALUES (?,?,?,?)'
      ).bind(date, name, JSON.stringify(rec), now));
    if (stmts.length) await db.batch(stmts);
  } catch (e) { /* persistence is best-effort; never break the board */ }
}

// -------------------------------------------------------------------------
// Shared feed cache (D1) — one paid refresh per window for the WHOLE site.
//
// caches.default is per-colo. Every Cloudflare colo that serves a viewer keeps
// its own copy, so the site was buying the same slate once per colo per TTL:
// the quota cost scaled with how geographically spread the traffic was, which
// is not a number anyone was choosing. D1 is global, so a line bought by the
// first colo to ask is visible to all the others.
//
// This caches the PAID part only — the book lines — not the computed board.
// Re-running the model is free CPU and the payload is ~154KB, most of it
// projections, percentile bars and season stats that D1 has no reason to hold.
// The per-colo cache still fronts this and still absorbs the repeat viewers;
// this layer only decides whether a colo miss has to spend credits.
//
// Reuses the prop_lines pattern, but keyed as one blob rather than a row per
// player: ~150 batters would be a 150-statement batch on every refresh, where
// the lines together are ~60KB as a single row.
async function ensureFeedCacheSchema(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS feed_cache (
    key TEXT PRIMARY KEY, data TEXT, updated_at INTEGER, claimed_until INTEGER
  )`).run();
}
// Returns { data, ageMs, present } — data is whatever was stored, parsed.
async function loadFeedCache(db, key) {
  try {
    await ensureFeedCacheSchema(db);
    const row = await db.prepare('SELECT data, updated_at FROM feed_cache WHERE key=?').bind(key).first();
    if (!row || !row.data) return { data: null, ageMs: Infinity, present: false };
    return { data: JSON.parse(row.data), ageMs: Date.now() - (row.updated_at || 0), present: true };
  } catch (e) { return { data: null, ageMs: Infinity, present: false }; }
}
// Single-flight. Two colos can miss the same window at the same instant; without
// this they would both pay. The UPDATE is conditional on the claim having
// lapsed, so exactly one of them sees changes>0 and does the fetch — the other
// serves the stale lines it already loaded rather than queueing behind it.
//
// The claim is a lease, not a lock: it expires on its own, so a refresh that
// dies mid-flight costs one stale window and not a wedged feed.
async function claimFeedRefresh(db, key, leaseMs) {
  try {
    await ensureFeedCacheSchema(db);
    const now = Date.now();
    await db.prepare(
      'INSERT OR IGNORE INTO feed_cache (key, data, updated_at, claimed_until) VALUES (?,NULL,0,0)'
    ).bind(key).run();
    const res = await db.prepare(
      'UPDATE feed_cache SET claimed_until=? WHERE key=? AND claimed_until<=?'
    ).bind(now + leaseMs, key, now).run();
    // Only a positively-reported zero means someone else owns the window. If the
    // driver does not report changes at all we must claim it, not concede it:
    // conceding on an unknown would make a present-but-stale store serve the
    // same lines forever, since nobody would ever win the right to refresh.
    // Guessing wrong this way costs one duplicate fetch; the other way is a
    // board frozen on yesterday's prices.
    const changes = (res && res.meta && typeof res.meta.changes === 'number') ? res.meta.changes : null;
    return changes == null ? true : changes > 0;
  } catch (e) { return true; } // D1 unavailable -> behave exactly as before it existed
}
async function saveFeedCache(db, key, data) {
  try {
    await ensureFeedCacheSchema(db);
    await db.prepare(
      'INSERT OR REPLACE INTO feed_cache (key, data, updated_at, claimed_until) VALUES (?,?,?,0)'
    ).bind(key, JSON.stringify(data), Date.now()).run();
  } catch (e) { /* best-effort; a failed write just means the next colo pays */ }
}

// ---- Records kept until their rows change (2026-10-27) ---------------------------
// D1 bills every row a query reads, and the records the page polls read every
// row ever logged: the track record every ten minutes while a page is open
// (20,700 rows on 2026-10-27, 15,000 of them bpicks), Picks of the day's kind
// records on every read of the list (6,500), the soccer and NBA cards' records
// on every read of theirs. With one page open all day that came to about five
// million rows, D1's whole free-tier day, and every one of those tables grows.
// Nearly none of those rows had changed since the read before: a record over
// graded rows moves only when a row is graded, and MLB's tables not at all
// once its season is over.
//
// So each such record is kept in feed_cache and rebuilt only once a row it is
// built from has been written. rec_dirty holds one flag a record. SQLite
// triggers on each table it reads raise the flag on every write that can move
// it -- any row, for a record over every row; a row graded before or after the
// write, for one over graded rows -- whatever code wrote it. A rebuild lowers
// the flag before it reads, so a write landing mid-build raises it again, and
// counts a generation as it does: a kept record is served only while its
// generation is the latest, so of two builds racing only the later stands.
//
// Kept per deploy (CF_VERSION_METADATA, wrangler.toml): code that changes how
// a record is built never serves one the code before it built. A build that
// could not read everything is not kept, and nothing is served past
// REC_MAX_AGE_MS, so a lost trigger or a failed write costs a rebuild, not a
// wrong record. Without rec_dirty (D1 refusing it) every read builds, as before.
const REC_MAX_AGE_MS = 6 * 3600e3;
// A row-filter over R (each trigger's NEW or OLD row); none for every row.
const REC_GRADED = 'R.result IS NOT NULL';
const REC_SOURCES = {
  // trackRecordMlb: the track record's MLB half, every row of six tables.
  'track-mlb': [['picks'], ['bpicks'], ['mlpicks'], ['rlpicks'], ['totpicks'], ['pppicks']],
  // pickKindRecords: graded rows only (each read is `result IN (...)`).
  'pick-kinds': [['mlpicks', REC_GRADED], ['pppicks', REC_GRADED], ['gmpicks', REC_GRADED], ['nbapp', REC_GRADED], ['nhlpp', REC_GRADED]],
  // edgeBetRecord: the edge bets once graded.
  'edge-bets': [['edgebets', REC_GRADED]],
  // socPropsBoard's record at the default lines.
  'soc-record': [['socprops', REC_GRADED]],
  // nbaPpBoard's record, and the NBA moneylines its byGame split reads.
  'nba-record': [['nbapp', REC_GRADED], ['gmpicks', "R.sport = 'nba' AND R.market = 'h2h'"]],
  // topLegs for MLB, every PrizePicks row, on a day none of today's needs the lineups.
  'top-legs-mlb': [['pppicks']],
};
const REC_READY = new Set();
async function ensureRecordFlags(db, key) {
  if (REC_READY.has(key)) return;
  const sts = [
    db.prepare('CREATE TABLE IF NOT EXISTS rec_dirty (k TEXT PRIMARY KEY, dirty INTEGER NOT NULL, gen INTEGER NOT NULL)'),
    db.prepare('INSERT OR IGNORE INTO rec_dirty (k, dirty, gen) VALUES (?, 1, 0)').bind(key),
  ];
  for (const [table, rows] of REC_SOURCES[key]) {
    for (const ev of ['INSERT', 'UPDATE', 'DELETE']) {
      const on = (r) => rows.replace(/\bR\./g, r + '.');
      const when = !rows ? '' : ` WHEN ${ev === 'INSERT' ? on('NEW') : ev === 'DELETE' ? on('OLD') : `(${on('OLD')}) OR (${on('NEW')})`}`;
      sts.push(db.prepare(`CREATE TRIGGER IF NOT EXISTS rec_${key.replace(/-/g, '_')}_${table}_${ev[0].toLowerCase()} AFTER ${ev} ON ${table}${when}
        BEGIN UPDATE rec_dirty SET dirty = 1 WHERE k = '${key}' AND dirty = 0; END`));
    }
  }
  await db.batch(sts);
  REC_READY.add(key);
}
const raiseRecord = (db, key) => db.prepare('UPDATE rec_dirty SET dirty = 1 WHERE k = ?').bind(key).run().catch(() => null);
// The record build() makes, kept until a write raises its flag. build returns
// { data, complete }; an incomplete build is served once and not kept. A
// variant (a day, say) keeps one copy at a time: another variant rebuilds.
async function recordCached(env, key, build, variant = '') {
  const db = env.DB;
  const base = `rec:${key}:`;
  const ck = base + ((env.CF_VERSION_METADATA && env.CF_VERSION_METADATA.id) || '') + (variant ? ':' + variant : '');
  let gen = null;
  try {
    await ensureRecordFlags(db, key);
    const f = await db.prepare('SELECT dirty, gen FROM rec_dirty WHERE k = ?').bind(key).first();
    if (f && Number(f.dirty) === 0) {
      const hit = await loadFeedCache(db, ck);
      if (hit.present && hit.ageMs < REC_MAX_AGE_MS && hit.data && hit.data.gen === Number(f.gen)) return hit.data.data;
    }
    const [, g] = await db.batch([
      db.prepare('UPDATE rec_dirty SET dirty = 0, gen = gen + 1 WHERE k = ?').bind(key),
      db.prepare('SELECT gen FROM rec_dirty WHERE k = ?').bind(key),
    ]);
    const row = g && g.results && g.results[0];
    if (row) gen = Number(row.gen);
  } catch (e) { /* unflagged: built every time */ }
  let built;
  try { built = await build(); } catch (e) { if (gen != null) await raiseRecord(db, key); throw e; }
  if (gen == null) return built.data;
  if (!built.complete) { await raiseRecord(db, key); return built.data; }
  try {
    await db.prepare('INSERT OR REPLACE INTO feed_cache (key, data, updated_at, claimed_until) VALUES (?,?,?,0)')
      .bind(ck, JSON.stringify({ gen, data: built.data }), Date.now()).run();
    // The deploys before this one's copies.
    await db.prepare('DELETE FROM feed_cache WHERE key >= ? AND key < ? AND key <> ?').bind(base, base.slice(0, -1) + ';', ck).run();
  } catch (e) { await raiseRecord(db, key); }
  return built.data;
}

// Run lines (spreads) persist the same way — snapshot the DK/FD + Pinnacle
// spread pairs per game while offered, so the closing run line survives the
// book pulling the spread market once the game starts (shown closed, not bettable).
// -------------------------------------------------------------------------
// Run-line picks: log, then grade. Deliberately a sibling of the moneyline
// path rather than a new shape -- same table columns, same INSERT OR IGNORE
// entry with a refreshed close, same score source.
//
// The board has been saying "not graded and not posted -- no track record
// stands behind it" since it shipped. That was true and it was permanent: the
// LINES were persisted but the model's READ never was, so there was nothing a
// grader could have scored. Nothing here posts anything; it makes the run line
// measurable so the banner can eventually stop being true by evidence rather
// than by assertion.
// -------------------------------------------------------------------------
async function ensureRlPickSchema(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS rlpicks (
    date TEXT, game_id TEXT, team TEXT, opp TEXT, is_home INTEGER,
    point REAL, side TEXT, tier TEXT, cover_pct INTEGER, edge REAL,
    entry_price INTEGER, close_price INTEGER,
    result TEXT, team_score INTEGER, opp_score INTEGER,
    model_ver TEXT, fair_source TEXT,
    PRIMARY KEY (date, game_id)
  )`).run();
  // Partial index over ungraded rows — see picks_ungraded in ensureSchema.
  await db.prepare('CREATE INDEX IF NOT EXISTS rlpicks_ungraded ON rlpicks (date, game_id) WHERE result IS NULL').run();
}
async function logRlPicks(db, rows, date) {
  await ensureRlPickSchema(db);
  const stmts = [];
  for (const r of rows) {
    if (r.status !== 'Preview') continue;
    const rl = r.rl;
    if (!rl || rl.price == null || rl.point == null || !rl.teamAbbr) continue;
    const isHome = rl.teamAbbr === rl.homeAbbr ? 1 : 0;
    const opp = isHome ? rl.awayAbbr : rl.homeAbbr;
    const cover = isHome ? rl.homeCoverPct : rl.awayCoverPct;
    stmts.push(db.prepare(
      `INSERT OR IGNORE INTO rlpicks (date,game_id,team,opp,is_home,point,side,tier,cover_pct,edge,entry_price,close_price,model_ver,fair_source)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(date, r.id, rl.teamAbbr, opp || '', isHome, rl.point, rl.side || null,
      String(rl.tier), cover ?? null, rl.edge ?? null, rl.price, rl.price, RL_MODEL_VER, rl.fairSource ?? null));
    // Close refreshed only while the logged side is still the pick, so a
    // mid-day flip to the other team cannot overwrite our entry side's close.
    stmts.push(db.prepare(
      'UPDATE rlpicks SET close_price=?, edge=?, tier=?, cover_pct=? WHERE date=? AND game_id=? AND team=? AND point=?'
    ).bind(rl.price, rl.edge ?? null, String(rl.tier), cover ?? null, date, r.id, rl.teamAbbr, rl.point));
  }
  if (stmts.length) await db.batch(stmts);
}

// Graded off the final score against the posted number: the bet wins when the
// margin plus the point is positive. At +/-1.5 a push is arithmetically
// impossible, but it is handled rather than assumed away -- the same
// defensiveness the moneyline grader applies to equal scores in a sport with no
// ties.
async function gradeRlPicks(env) {
  const db = env.DB;
  await ensureRlPickSchema(db);
  const today = slateDate();
  const rows = (await db.prepare('SELECT * FROM rlpicks WHERE result IS NULL AND date < ?').bind(today).all()).results || [];
  if (!rows.length) return;
  const byDate = {};
  for (const r of rows) (byDate[r.date] = byDate[r.date] || []).push(r);
  for (const d of Object.keys(byDate)) {
    let games = [];
    try {
      const r = await fetch(`${STATS}/schedule?sportId=1&date=${d}&hydrate=linescore,team`, { headers: { accept: 'application/json' } });
      if (!r.ok) continue;
      games = (((await r.json()).dates || [])[0] || {}).games || [];
    } catch (e) { continue; }
    const scoreByGame = {};
    for (const g of games) {
      if (((g.status || {}).abstractGameState) !== 'Final') continue;
      if (movedOffDate(g, d)) continue;   // postponed: see movedOffDate
      const ls = g.linescore || {};
      const homeR = numOr((ls.teams && ls.teams.home && ls.teams.home.runs), g.teams.home.score);
      const awayR = numOr((ls.teams && ls.teams.away && ls.teams.away.runs), g.teams.away.score);
      if (homeR == null || awayR == null) continue;
      scoreByGame['g' + g.gamePk] = { homeR, awayR };
    }
    // A game replayed on another date never lands in this date's map, so the
    // row would be skipped on every pass forever. Same rescue and same void the
    // other three graders use.
    const missing = byDate[d].filter((p) => !scoreByGame[p.game_id]).map((p) => p.game_id);
    if (missing.length) {
      const byPk = await gamesByPk(missing);
      const voids = [], moved = [];
      for (const [gid, g] of Object.entries(byPk)) {
        if (movedOffDate(g, d)) moved.push(gid);
        else if (g.state === 'Final' && g.homeR != null && g.awayR != null) scoreByGame[gid] = { homeR: g.homeR, awayR: g.awayR };
        else if (isAbandoned(g)) voids.push(gid);
      }
      const stmts = [
        ...voids.map((gid) => db.prepare("UPDATE rlpicks SET result='void' WHERE game_id=? AND result IS NULL").bind(gid)),
        ...moved.map((gid) => db.prepare(
          "UPDATE rlpicks SET result='void', team_score=NULL, opp_score=NULL WHERE date=? AND game_id=? AND result IS NULL").bind(d, gid)),
      ];
      if (stmts.length) {
        try { await db.batch(stmts); } catch (e) { /* retry next pass */ }
      }
    }
    const stmts = [];
    for (const p of byDate[d]) {
      const sc = scoreByGame[p.game_id];
      if (!sc) continue;
      const teamR = p.is_home ? sc.homeR : sc.awayR;
      const oppR = p.is_home ? sc.awayR : sc.homeR;
      const adj = (teamR - oppR) + Number(p.point);
      const result = adj === 0 ? 'push' : (adj > 0 ? 'win' : 'loss');
      stmts.push(db.prepare('UPDATE rlpicks SET result=?, team_score=?, opp_score=? WHERE date=? AND game_id=?')
        .bind(result, teamR, oppR, p.date, p.game_id));
    }
    if (stmts.length) { try { await db.batch(stmts); } catch (e) { /* skip */ } }
  }
}

async function ensureRlSchema(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS rl_lines (
    date TEXT, game_id TEXT, data TEXT, updated_at INTEGER,
    PRIMARY KEY (date, game_id)
  )`).run();
}
async function loadRlLines(db, date) {
  try {
    await ensureRlSchema(db);
    const rows = (await db.prepare('SELECT game_id, data FROM rl_lines WHERE date=?').bind(date).all()).results || [];
    const map = {};
    for (const r of rows) { try { map[r.game_id] = JSON.parse(r.data); } catch (e) { /* skip bad row */ } }
    return map;
  } catch (e) { return {}; } // best-effort — never block the board
}
async function saveRlLines(db, date, pairs) {
  try {
    await ensureRlSchema(db);
    const now = Date.now();
    const stmts = pairs.map((p) => db.prepare(
      'INSERT OR REPLACE INTO rl_lines (date, game_id, data, updated_at) VALUES (?,?,?,?)'
    ).bind(date, p.gameId, p.data, now));
    if (stmts.length) await db.batch(stmts);
  } catch (e) { /* persistence is best-effort; never break the board */ }
}

// CLV columns, added to pre-existing tables via guarded ALTER (D1 throws if the
// column already exists — that's fine, we ignore it).
const CLV_COLUMNS = [
  ['entry_over', 'REAL'], ['close_line', 'REAL'], ['close_price', 'INTEGER'], ['close_over', 'REAL'],
];
// A column is confirmed once per isolate -- added, or reported as already
// there -- and not asked about again: the schema checks run on every board
// read, and each ALTER is a query. Any other failure is retried next time.
const COLUMNS_CONFIRMED = new Set();
async function addColumns(db, table, cols) {
  for (const [name, type] of cols) {
    const key = `${table}.${name}`;
    if (COLUMNS_CONFIRMED.has(key)) continue;
    try { await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`).run(); COLUMNS_CONFIRMED.add(key); }
    catch (e) { if (/duplicate column/i.test(String((e && e.message) || e))) COLUMNS_CONFIRMED.add(key); }
  }
}

// ---------------------------------------------------------------------------
// NFL
// ---------------------------------------------------------------------------
// Two tables, plus a `sport` column on the MLB ones. The column is what makes a
// cross-sport CLV harness possible: NFL yields roughly 600-1,000 graded picks a
// SEASON against MLB's ~40 a night, so a per-sport harness would never reach
// significance on the NFL side. Sport has to be a dimension of one sample, not
// its own table.
//
// nfl_lines is raw quotes, one row per book per poll -- deliberately not
// de-duplicated to "current". The close is the number CLV is measured against,
// and it can only be reconstructed later if the intermediate polls were kept.
async function ensureNflSchema(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS nfl_lines (
    season INTEGER, week INTEGER, event_id TEXT, commence TEXT,
    home TEXT, away TEXT,
    season_type TEXT NOT NULL DEFAULT 'REG',
    market TEXT, player_id TEXT, player TEXT, point REAL,
    book TEXT, over INTEGER, under INTEGER,
    captured_at TEXT,
    PRIMARY KEY (event_id, market, player, point, book, captured_at)
  )`).run();
  await addColumns(db, 'nfl_lines', [['season_type', "TEXT NOT NULL DEFAULT 'REG'"]]);
  await db.prepare('CREATE INDEX IF NOT EXISTS nfl_lines_evt ON nfl_lines (event_id, market)').run();
  await db.prepare('CREATE INDEX IF NOT EXISTS nfl_lines_wk ON nfl_lines (season, week)').run();
  // The NFL board asks twice per load for lines by season type and kickoff
  // (`season_type = ? AND commence > ?`), and neither column was indexed, so both
  // read every price snapshot ever captured. This table only grows — one
  // capture on 2026-09-13 added 4,827 rows — so without it every NFL page cost
  // more than the last. With it, played games drop out of the read entirely.
  await db.prepare('CREATE INDEX IF NOT EXISTS nfl_lines_type_commence ON nfl_lines (season_type, commence)').run();
  // The passing-TD log reads one market's upcoming quotes after every props
  // capture (`market = 'player_pass_tds' AND commence > ?`). No index led with
  // either column, so it read every price snapshot ever captured to find a few
  // hundred (2026-10-23). A partial index over that market holds only its rows,
  // and the query's own market term is what lets SQLite choose it.
  await db.prepare("CREATE INDEX IF NOT EXISTS nfl_lines_ptd ON nfl_lines (commence) WHERE market = 'player_pass_tds'").run();

  // npicks carries the lifecycle. The state column is the reason this is not
  // modelled as a boolean `posted`: an NFL play exists for four days and can be
  // re-priced or pulled at lock, and those outcomes are themselves the data the
  // "where the ladder moved us" panel reports. firm_point/firm_price preserve
  // what firming showed -- without them a re-price destroys the evidence that
  // it happened.
  await db.prepare(`CREATE TABLE IF NOT EXISTS npicks (
    id TEXT PRIMARY KEY, sport TEXT NOT NULL DEFAULT 'nfl',
    season INTEGER, week INTEGER, event_id TEXT,
    player_id TEXT, player TEXT, team TEXT, pos TEXT,
    market TEXT, point REAL, side TEXT DEFAULT 'under',

    fair_src TEXT CHECK (fair_src IN ('gameline-pool','props-pool','MKT')),
    fair_prob REAL, sharp_n INTEGER NOT NULL DEFAULT 0,
    best_price INTEGER, best_book TEXT, price_edge REAL,
    model_prob REAL, model_proj REAL, model_edge REAL, tier TEXT,
    prior_only INTEGER NOT NULL DEFAULT 0,

    state TEXT NOT NULL DEFAULT 'provisional'
      CHECK (state IN ('provisional','firming','locked','graded','pulled')),
    posted_at TEXT, firmed_at TEXT, locked_at TEXT, graded_at TEXT,
    lock_outcome TEXT CHECK (lock_outcome IN ('confirmed','repriced','pulled')),
    firm_point REAL, firm_price INTEGER,

    actual_live REAL, actual_official REAL,
    result TEXT, exit_reason TEXT, exited_q INTEGER,
    grade_ver TEXT, model_ver TEXT,
    script_key TEXT, stake REAL
  )`).run();
  await db.prepare('CREATE INDEX IF NOT EXISTS npicks_state ON npicks (state, season, week)').run();
  await db.prepare('CREATE INDEX IF NOT EXISTS npicks_evt ON npicks (event_id)').run();

  // Stat corrections run through Tuesday. Rather than overwrite a graded row --
  // which would make the record silently disagree with what was published -- a
  // change from the live gamebook value writes a row here and the pick keeps
  // both numbers.
  // The projection as it stood BEFORE kickoff, frozen.
  //
  // /api/nfl-props recomputes from the current board every call, so a projection
  // only exists for as long as the request that made it. On 2026-09-09 the model
  // called Jaxon Smith-Njigba 126.2 (he had 122) and TreVeyon Henderson 55.3 (he
  // did not play) — and neither number survived the night. Nothing could be
  // graded, because nothing had been written down.
  //
  // INSERT OR IGNORE, never REPLACE: the row being judged is what the model said
  // before the game. A later capture re-projecting the same game off a moved
  // spread would quietly overwrite the forecast with a better-informed one.
  await db.prepare(`CREATE TABLE IF NOT EXISTS nfl_proj (
    season INTEGER, week INTEGER, event_id TEXT, player TEXT, market TEXT,
    team TEXT, pos TEXT, game TEXT, commence TEXT,
    proj REAL, p25 REAL, p50 REAL, p75 REAL, conf INTEGER,
    actual REAL, captured_at TEXT, graded_at TEXT,
    PRIMARY KEY (season, event_id, player, market)
  )`).run();
  // Season leads the key, and none of these name it: the grader's pending read
  // and its per-row UPDATE (graded_at IS NULL), and the entry-leg grader's
  // kickoff window over graded rows (every five minutes while an NFL leg is
  // open). Each was a scan of every projection ever frozen -- the UPDATE once
  // per row graded. Two partial indexes split the table between them.
  await db.prepare('CREATE INDEX IF NOT EXISTS nfl_proj_open ON nfl_proj (commence) WHERE graded_at IS NULL').run();
  await db.prepare('CREATE INDEX IF NOT EXISTS nfl_proj_graded ON nfl_proj (commence) WHERE graded_at IS NOT NULL').run();

  await db.prepare(`CREATE TABLE IF NOT EXISTS npick_corrections (
    pick_id TEXT, was REAL, now_val REAL, was_result TEXT, now_result TEXT,
    noticed_at TEXT,
    PRIMARY KEY (pick_id, noticed_at)
  )`).run();

  // Existing MLB tables join the same harness. Default 'mlb' backfills every
  // row already written, so nothing has to be migrated by hand.
  for (const t of ['picks', 'bpicks', 'mlpicks']) {
    await addColumns(db, t, [['sport', "TEXT NOT NULL DEFAULT 'mlb'"]]);
  }
}

// Game lines for the NFL slate. Player props are not on the wire yet (every
// prop market returned zero bookmakers on 2026-08-14, while h2h returned all
// seven books), so this ingests what exists and is written to pick up props
// unchanged when they appear -- the row shape is already per-player.
// Preseason is a separate sport key upstream. It is ingested so the pipeline has
// live games to run against before Week 1, and every row it writes is tagged
// PRE -- starters play a quarter, so these lines describe a different game than
// the model is built for and must stay separable forever.
const NFL_SPORTS = {
  nfl:    { key: 'americanfootball_nfl',           seasonType: 'REG' },
  nflpre: { key: 'americanfootball_nfl_preseason', seasonType: 'PRE' },
};
const NFL_GAME_MARKETS = 'h2h,spreads,totals';
// The player markets worth capturing, and only those.
//
// `player_anytime_td` is deliberately absent: the 2026-09-09 coverage probe
// found 57 players quoted and `twoSided: 0`, so there is no under side to
// de-vig and no fair line can be built from it. Paying for a market that cannot
// be priced is the mistake this whole capture exists to avoid.
//
// Passing is absent for a different reason: the model is not allowed to post it.
// Backtested under-mean was 42.0% (2024) and 49.5% (2025) — never above 50 —
// because passing yards sum ~20 completions and the CLT flattens the right skew
// the thesis trades on. Capturing lines for a market we will not price would be
// spending to build a dataset with no question attached to it.
//
// `player_receptions` went out on 2026-09-14 for the same reason. It was captured
// from the start, but nothing projects a reception COUNT — NFL_PROJ_TO_ODDS maps
// only receiving and rushing yards — so no row was ever joined to it, graded
// against it, or shown. It was still 1,869 of the 4,827 prop rows the Week 1
// Sunday capture wrote, and a third of that capture's 42 credits (billing is per
// market per event). tests/nflmarkets.mjs keeps this list equal to the markets
// the model projects, so a market the model cannot use cannot creep back in.
// player_pass_tds joins them for a different reason, and on a different footing:
// nothing projects it and nothing is posted from it. It is bought to be MEASURED.
//
// Probed 2026-09-22: BetOnline, Novig and ProphetX quote it two-sided, so a
// non-circular fair line exists, and DK, FanDuel, BetMGM and BetRivers quote it
// for execution. (player_pass_longest_completion was probed at the same time and
// failed — DraftKings and BetMGM only, no sharp book, so there is nothing to
// de-vig against. It is not bought.)
//
// The question it answers: passing TDs are a coarse count, 0 through 5, so a
// line sits at 1.5 and the book prices P(0 or 1) directly rather than setting a
// number near a skewed mean. Over 2024-25, 1,082 QB starts of 15+ attempts
// landed under 1.5 in 55.4% of them — 55.6% and 55.1% by season, which is
// remarkably steady. A fair price of -124. If the sharp pool prices the under
// at -124 or worse there is nothing here; if it prices it cheaper, the edge
// needs no model, just that number. NFL_PASS_TD_BASE is what the log is read
// against.
const NFL_PROP_MARKETS = 'player_reception_yds,player_rush_yds,player_pass_tds';
const NFL_PASS_TD_LINE = 1.5;
const NFL_PASS_TD_BASE = 55.4;   // realised under-1.5 rate, 2024-25 regular season
// Passing yards, measured too (2026-10-15), and bought only near kickoff.
//
// The projection stays rejected: it landed under its own mean 42.0% and 49.5%
// of the time in the two backtested seasons. This asks something else, with no
// model in it -- does PrizePicks' under land when its number sits above the
// books'? Its receiving and rushing unders did 30 of 51 there.
//
// Probed on SEA @ DEN the same day: all ten books, PrizePicks included, quote
// both quarterbacks, but no two sharp books hang the same number, so there is
// no two-book fair at any line. What gets logged is each book's number.
//
// The capture prices every game in a ten-day horizon twice a slate day, so
// adding the market to every call would have bought each game ten-odd times,
// ~150 credits a week. Inside NFL_PASS_YDS_WINDOW_MS only the two day-of
// captures buy it: about 2 credits a game, ~30 a week.
const NFL_PASS_YDS_MARKET = 'player_pass_yds';
const NFL_PASS_YDS_WINDOW_MS = 20 * 3600 * 1000;
// Books are named explicitly rather than pulled by region. Three reasons, all
// found by dry-running the live payload: regions=us,eu returned 23 books, 13 of
// them European retail we will never price against; it billed 6 credits where a
// named list of <=10 bills 3; and it did NOT include novig or prophetx, which
// are the exchanges the props pool depends on -- they only appear when asked for
// by key. Keep this at 10 or fewer or the request bills as a second region.
// The player-prop capture swaps BetRivers for PrizePicks (2026-10-06): the
// user plays PrizePicks first, and its yardage number is often not the books'
// -- a probe of two Week 5 games found it on 18 receivers and 9 rushers, more
// than DraftKings. Still ten books, so still one region's credits. The game-line
// ingest keeps BetRivers, which is often the best moneyline price.
const NFL_PROP_BOOKS = [
  'pinnacle', 'lowvig', 'betonlineag', 'novig', 'prophetx',
  'draftkings', 'fanduel', 'williamhill_us', 'betmgm', 'prizepicks',
];
const NFL_BOOKS = [
  'pinnacle', 'lowvig', 'betonlineag', 'novig', 'prophetx',   // fair candidates
  'draftkings', 'fanduel', 'williamhill_us', 'betmgm', 'betrivers', // execution
];
// How far ahead to ingest. The Odds API returns the entire remaining season --
// 272 events, 4,743 rows on one call -- and re-writing all of it on every poll
// would bury the slate we actually price in months of untouched future games.
// Ten days covers a full Tue-to-Mon game week with room either side.
const NFL_HORIZON_DAYS = 10;

// -------------------------------------------------------------------------
// /api/nfl-capture — snapshot player prop lines, and freeze the projection.
//
// This CAPTURES, it does not PRICE. No fair line is computed, no edge, no tier,
// nothing is posted. The Worker's only job here is to write down what the market
// said and what the model said, at a moment before kickoff.
//
// It exists because NFL prop lines are perishable in a way MLB's were not. The
// hits-allowed question was settled for free off StatsAPI game logs, months
// after the fact — NFL prop lines cannot be reconstructed later at any price on
// this plan, so the capture is the one part that is genuinely urgent and the
// pricing is the part that is not.
//
// Cost: markets x ceil(books/10) per event = 3 x 1 = 3 credits a game, ~48 for a
// full Sunday. That is a research log, not a board: it wants one or two sweeps a
// day near kickoff, not the 5-minute cadence a live board would need.
// -------------------------------------------------------------------------
async function ingestNflProps(env, opts, reqUrl) {
  const sp = NFL_SPORTS[(opts && opts.sport) || 'nfl'];
  const out = { sport: (opts && opts.sport) || 'nfl', seasonType: sp && sp.seasonType,
    events: 0, eventsPriced: 0, wrote: 0, unchanged: 0, projFrozen: 0, markets: {}, credits: 0, errors: [] };
  if (!sp) { out.errors.push('unknown sport'); return out; }
  const key = env && env.ODDS_API_KEY;
  if (!key) { out.errors.push('ODDS_API_KEY not configured'); return out; }
  if (!env.DB) { out.errors.push('no DB binding'); return out; }
  await ensureNflSchema(env.DB);
  await nflSchedule(env);
  const dry = !!(opts && opts.dry);

  // The event list is free (0 credits), so it is safe to ask for it every sweep.
  let events = [];
  try {
    const evR = await fetch(`https://api.the-odds-api.com/v4/sports/${sp.key}/events?apiKey=${key}&dateFormat=iso`,
      { headers: { accept: 'application/json' } });
    await recordOddsUsage(env, evR, 'nfl:events');
    if (!evR.ok) { out.errors.push('events: ' + (await evR.text()).slice(0, 160)); return out; }
    events = await evR.json();
  } catch (e) { out.errors.push('events: ' + String((e && e.message) || e)); return out; }
  if (!Array.isArray(events)) { out.errors.push('unexpected events payload'); return out; }

  const now = Date.now();
  const horizon = now + NFL_HORIZON_DAYS * 864e5;
  // Started games only ever cost money: the pre-game line is already gone, and a
  // live number is not what the model is being judged against.
  const upcoming = events.filter((e) => {
    const t = Date.parse(e.commence_time);
    return isFinite(t) && t > now && t <= horizon;
  });
  out.events = upcoming.length;
  if (!upcoming.length) { out.note = 'no upcoming events inside the horizon'; return out; }

  // Same change-detection the game-line ingest uses: captured_at is in the
  // primary key, so writing unconditionally would store a near-identical
  // snapshot every sweep. Append only on a real move.
  const cur = new Map();
  const lineKey = (ev, mkt, who, pt, bk) =>
    ev + '|' + mkt + '|' + (who == null ? '' : who) + '|' + (pt == null ? '' : pt) + '|' + bk;
  // Only the markets this capture can buy: `same` is only ever asked about
  // them, and the game lines stored beside them were read for nothing.
  const propMkts = [...NFL_PROP_MARKETS.split(','), NFL_PASS_YDS_MARKET];
  try {
    const ids = upcoming.map((e) => e.id);
    for (let i = 0; i < ids.length; i += 40) {
      const chunk = ids.slice(i, i + 40);
      const q = await env.DB.prepare(
        'SELECT event_id, market, player, point, book, over, under, captured_at FROM nfl_lines'
        + ' WHERE event_id IN (' + chunk.map(() => '?').join(',') + ')'
        + ' AND market IN (' + propMkts.map(() => '?').join(',') + ')'
      ).bind(...chunk, ...propMkts).all();
      for (const r of (q.results || [])) {
        const k = lineKey(r.event_id, r.market, r.player, r.point, r.book);
        const prev = cur.get(k);
        if (!prev || String(prev.captured_at) < String(r.captured_at)) cur.set(k, r);
      }
    }
  } catch (e) { out.errors.push('readCurrent: ' + String((e && e.message) || e)); }
  const same = (k, ov, un) => {
    const p = cur.get(k);
    if (!p) return false;
    const eq = (a, c) => (a == null && c == null) || Number(a) === Number(c);
    return eq(p.over, ov) && eq(p.under, un);
  };

  const stamp = new Date().toISOString();
  const stmts = [];
  const pydRows = [];
  out.passYdsEvents = 0;
  for (const ev of upcoming) {
    let d;
    // Passing yards only inside the day-of window -- see NFL_PASS_YDS_WINDOW_MS.
    const nearKick = Date.parse(ev.commence_time) - now <= NFL_PASS_YDS_WINDOW_MS;
    const markets = NFL_PROP_MARKETS + (nearKick ? ',' + NFL_PASS_YDS_MARKET : '');
    try {
      const r = await fetch(
        `https://api.the-odds-api.com/v4/sports/${sp.key}/events/${ev.id}/odds`
        + `?apiKey=${key}&bookmakers=${NFL_PROP_BOOKS.join(',')}&markets=${markets}`
        + '&oddsFormat=american&dateFormat=iso',
        { headers: { accept: 'application/json' } });
      await recordOddsUsage(env, r, 'nfl:props');
      const used = parseInt(r.headers.get('x-requests-last') || '', 10);
      if (Number.isFinite(used)) out.credits += used;
      if (!r.ok) { out.errors.push(`${ev.id}: ${r.status}`); continue; }
      d = await r.json();
    } catch (e) { out.errors.push(`${ev.id}: ${String((e && e.message) || e)}`); continue; }

    const wk = sp.seasonType === 'REG' ? nflWeekOf(ev.commence_time) : null;
    let priced = false;
    for (const bm of (d.bookmakers || [])) {
      for (const mk of (bm.markets || [])) {
        // A prop outcome names the SIDE in `name` and the PLAYER in
        // `description` — the opposite of the team markets, where the selection
        // is the name. Pairing the two sides per (player, point) is what makes a
        // row de-viggable later.
        const byPlayer = new Map();
        for (const o of (mk.outcomes || [])) {
          const who = o.description;
          if (!who) continue;
          const k = who + '|' + (o.point == null ? '' : o.point);
          const cell = byPlayer.get(k) || { player: who, point: o.point == null ? null : o.point, over: null, under: null };
          if (o.name === 'Over') cell.over = o.price;
          else if (o.name === 'Under') cell.under = o.price;
          byPlayer.set(k, cell);
        }
        for (const c of byPlayer.values()) {
          priced = true;
          out.markets[mk.key] = (out.markets[mk.key] || 0) + 1;
          const k = lineKey(ev.id, mk.key, c.player, c.point, bm.key);
          if (same(k, c.over, c.under)) { out.unchanged++; continue; }
          stmts.push(env.DB.prepare(
            `INSERT OR REPLACE INTO nfl_lines
             (season, week, season_type, event_id, commence, home, away, market, player_id, player, point, book, over, under, captured_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
          ).bind(2026, wk, sp.seasonType, ev.id, ev.commence_time || null, ev.home_team || null, ev.away_team || null,
            mk.key, null, c.player, c.point, bm.key, c.over, c.under, stamp));
        }
      }
    }
    if (priced) out.eventsPriced++;
    // Passing yards are logged from the payload just bought rather than read
    // back from nfl_lines: the read-back runs before this capture's rows are
    // written, so a game captured once would never be logged at all.
    if (nearKick) {
      out.passYdsEvents++;
      for (const e of passYdsEntries(ev, d, wk, sp.seasonType)) pydRows.push(e);
    }
  }
  out.wrote = stmts.length;

  // Freeze the projections for the same slate. Calling the handler and reading
  // its body keeps one definition of the model rather than a second copy that
  // could drift away from what the board serves.
  let projRows = [];
  try {
    const pr = await nflProps(env, reqUrl);
    const pd = await pr.json();
    projRows = pd.rows || [];
  } catch (e) { out.errors.push('projections: ' + String((e && e.message) || e)); }
  const evByMatch = new Map();
  for (const e of upcoming) evByMatch.set(`${nflAbbr(e.away_team)} @ ${nflAbbr(e.home_team)}`, e);
  const projStmts = [];
  for (const r of projRows) {
    const e = evByMatch.get(r.game);
    if (!e || typeof r.proj !== 'number') continue;
    projStmts.push(env.DB.prepare(
      `INSERT OR IGNORE INTO nfl_proj
       (season, week, event_id, player, market, team, pos, game, commence, proj, p25, p50, p75, conf, actual, captured_at, graded_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,NULL)`
    ).bind(2026, sp.seasonType === 'REG' ? nflWeekOf(e.commence_time) : null, e.id, r.player, r.market,
      r.team || null, r.pos || null, r.game || null, r.commence || null,
      r.proj, r.p25 ?? null, r.p50 ?? null, r.p75 ?? null, r.conf ?? null, stamp));
  }
  out.projFrozen = projStmts.length;
  // Passing touchdowns, logged off the rows this capture just wrote.
  //
  // This lives here and not in nflIngest: player_pass_tds is bought by THIS
  // function (per event, NFL_PROP_MARKETS), while nflIngest buys the game
  // markets. Hooked onto the wrong one it read a table that never had a
  // passing row in it and logged nothing, silently.
  //
  // Read back rather than logged inline: the capture writes append-on-change,
  // so the current price for a player is whatever survived, not necessarily a
  // row written on this pass. Nothing is posted from these — see passTdEntries.
  try {
    // Through nfl_lines_ptd. Rows of one capture share captured_at, and the
    // last one per player and book wins below (a second point at one book can
    // hide the 1.5), so ties keep the order they had when this read was a
    // scan: rowid.
    const ptdRows = (await env.DB.prepare(
      `SELECT event_id, commence, home, away, market, player, point, book, over, under, week, season_type
         FROM nfl_lines WHERE market = 'player_pass_tds' AND commence > ?
        ORDER BY captured_at ASC, rowid ASC`
    ).bind(new Date().toISOString()).all()).results || [];
    const latest = new Map();
    for (const r of ptdRows) latest.set(`${r.event_id}|${r.player}|${r.book}`, r);
    const byWeek = new Map();
    for (const r of latest.values()) {
      const k = `${r.week}|${r.season_type}`;
      if (!byWeek.has(k)) byWeek.set(k, []);
      byWeek.get(k).push(r);
    }
    let wrote = 0;
    for (const [k, rs] of byWeek) {
      const [wk, st] = k.split('|');
      const entries = passTdEntries(rs, wk === 'null' ? null : Number(wk), st);
      if (!entries.length) continue;
      // Each entry takes ITS OWN kickoff date. A capture covers the whole week
      // and an NFL week is three slates, so dating them all from the first
      // filed Sunday's quarterbacks under Thursday — harmless to grading, which
      // is by week, but it makes the per-day ranking read a week as one day.
      const byDay = new Map();
      for (const e of entries) {
        const day = ptDateOf(Date.parse(e.commence || Date.now()));
        if (!byDay.has(day)) byDay.set(day, []);
        byDay.get(day).push(e);
      }
      for (const [day, list] of byDay) wrote += await logGamePicks(env.DB, 'nflptd', day, list);
    }
    out.passTdsLogged = wrote;
  } catch (e) { out.errors.push('pass-tds: ' + String((e && e.message) || e)); }
  try {
    out.passYdsLogged = dry ? 0 : await logPassYds(env.DB, pydRows, stamp);
    if (dry) out.passYdsWouldLog = pydRows.length;
  } catch (e) { out.errors.push('pass-yds: ' + String((e && e.message) || e)); }


  if (dry) { out.dryRun = true; return out; }
  for (const batch of [stmts, projStmts]) {
    for (let i = 0; i < batch.length; i += 50) {
      try { await env.DB.batch(batch.slice(i, i + 50)); }
      catch (e) { out.errors.push('write: ' + String((e && e.message) || e)); }
    }
  }
  return out;
}

async function ingestNflLines(env, opts) {
  const sp = NFL_SPORTS[(opts && opts.sport) || 'nfl'];
  if (!sp) return { wrote: 0, errors: [`unknown sport; expected one of ${Object.keys(NFL_SPORTS).join(', ')}`] };
  const key = env && env.ODDS_API_KEY;
  const out = { sport: (opts && opts.sport) || 'nfl', seasonType: sp.seasonType, wrote: 0, events: 0, books: 0, markets: {}, errors: [] };
  if (!key) { out.errors.push('ODDS_API_KEY not configured'); return out; }
  if (!env.DB) { out.errors.push('no DB binding'); return out; }
  await ensureNflSchema(env.DB);
  await nflSchedule(env);   // nflWeekOf reads NFL_SCHED; without this every row lands week NULL
  const dry = !!(opts && opts.dry);
  try {
    const r = await fetch(
      `https://api.the-odds-api.com/v4/sports/${sp.key}/odds?apiKey=${key}&bookmakers=${NFL_BOOKS.join(',')}&markets=${NFL_GAME_MARKETS}`
      + '&oddsFormat=american&dateFormat=iso',
      { headers: { accept: 'application/json' } });
    // Awaited, not deferred: ingestNflLines has no ctx to hand a background
    // promise to, and `ctx` here would be an unbound reference inside a try.
    await recordOddsUsage(env, r, 'nfl:game-markets');
    out.httpStatus = r.status;
    out.creditsUsed = r.headers.get('x-requests-last');
    out.creditsRemaining = r.headers.get('x-requests-remaining');
    if (!r.ok) { out.errors.push((await r.text()).slice(0, 200)); return out; }
    const events = await r.json();
    if (!Array.isArray(events)) { out.errors.push('unexpected payload'); return out; }
    const now = new Date().toISOString();
    const seen = new Set();
    const stmts = [];
    // Current value per line, so a poll that finds nothing moved writes nothing.
    // captured_at is in the primary key, which means every poll would otherwise
    // store a full snapshot -- at the Sunday 5-minute cadence that is roughly
    // 69k rows a week of mostly identical prices. Appending only on a real
    // change keeps the full price history CLV needs without the duplication.
    const cur = new Map();
    const lineKey = (ev, mkt, who, pt, bk) =>
      ev + '|' + mkt + '|' + (who == null ? '' : who) + '|' + (pt == null ? '' : pt) + '|' + bk;
    // Game markets only. These events' player props sit in the same table, every
    // snapshot of them, and `same` is never asked about one: the read was mostly
    // props, on every capture (2026-10-23).
    const gameMkts = NFL_GAME_MARKETS.split(',');
    try {
      const ids = events.map((e) => e.id);
      for (let i = 0; i < ids.length; i += 40) {
        const chunk = ids.slice(i, i + 40);
        const marks = chunk.map(() => '?').join(',');
        const q = await env.DB.prepare(
          'SELECT event_id, market, player, point, book, over, under, captured_at'
          + ' FROM nfl_lines WHERE event_id IN (' + marks + ')'
          + ' AND market IN (' + gameMkts.map(() => '?').join(',') + ')'
        ).bind(...chunk, ...gameMkts).all();
        for (const r of (q.results || [])) {
          const k = lineKey(r.event_id, r.market, r.player, r.point, r.book);
          const prev = cur.get(k);
          if (!prev || String(prev.captured_at) < String(r.captured_at)) cur.set(k, r);
        }
      }
    } catch (e) { out.errors.push('readCurrent: ' + String((e && e.message) || e)); }
    const same = (k, ov, un) => {
      const p = cur.get(k);
      if (!p) return false;
      const eq = (a, c) => (a == null && c == null) || Number(a) === Number(c);
      return eq(p.over, ov) && eq(p.under, un);
    };
    out.unchanged = 0;
    const horizon = Date.now() + NFL_HORIZON_DAYS * 864e5;
    out.eventsReturned = events.length;
    for (const e of events) {
      const ct = Date.parse(e.commence_time);
      if (isFinite(ct) && ct > horizon) { out.skippedBeyondHorizon = (out.skippedBeyondHorizon || 0) + 1; continue; }
      out.events++;
      const wk = sp.seasonType === 'REG' ? nflWeekOf(e.commence_time) : null;
      for (const bm of (e.bookmakers || [])) {
        seen.add(bm.key);
        for (const mk of (bm.markets || [])) {
          out.markets[mk.key] = (out.markets[mk.key] || 0) + 1;
          // h2h/spreads/totals are two-outcome markets keyed by team or
          // Over/Under. Both collapse to the same (point, over, under) shape the
          // prop rows use, so one table serves both and the props ingest will
          // not need a second schema.
          const oc = mk.outcomes || [];
          const isOU = oc.some((o) => o.name === 'Over' || o.name === 'Under');
          if (isOU) {
            const over = oc.find((o) => o.name === 'Over');
            const under = oc.find((o) => o.name === 'Under');
            const kOU = lineKey(e.id, mk.key, null, over && over.point != null ? over.point : null, bm.key);
            if (same(kOU, over ? over.price : null, under ? under.price : null)) { out.unchanged++; continue; }
            stmts.push(env.DB.prepare(
              `INSERT OR REPLACE INTO nfl_lines
               (season, week, season_type, event_id, commence, home, away, market, player_id, player, point, book, over, under, captured_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
            ).bind(2026, wk, sp.seasonType, e.id, e.commence_time || null, e.home_team || null, e.away_team || null,
              mk.key, null, null, over && over.point != null ? over.point : null,
              bm.key, over ? over.price : null, under ? under.price : null, now));
          } else {
            // Team-keyed (h2h, spreads): one row per side, the team in `player`
            // so the column means "which selection" for every market.
            for (const o of oc) {
              const kT = lineKey(e.id, mk.key, o.name || null, o.point != null ? o.point : null, bm.key);
              if (same(kT, o.price != null ? o.price : null, null)) { out.unchanged++; continue; }
              stmts.push(env.DB.prepare(
                `INSERT OR REPLACE INTO nfl_lines
                 (season, week, season_type, event_id, commence, home, away, market, player_id, player, point, book, over, under, captured_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
              ).bind(2026, wk, sp.seasonType, e.id, e.commence_time || null, e.home_team || null, e.away_team || null,
                mk.key, null, o.name || null, o.point != null ? o.point : null,
                bm.key, o.price != null ? o.price : null, null, now));
            }
          }
        }
      }
    }
    out.books = seen.size;
    out.bookList = [...seen].sort();
    out.wrote = stmts.length;
    if (dry) { out.dryRun = true; return out; }
    // D1 caps a batch; chunk so a full slate cannot exceed it.
    for (let i = 0; i < stmts.length; i += 80) {
      await env.DB.batch(stmts.slice(i, i + 80));
    }
  } catch (e) { out.errors.push(String((e && e.message) || e)); }
  return out;
}

// Week number from a kickoff timestamp, off the shipped schedule asset rather
// than arithmetic on a season-opener date -- byes, international kickoffs and
// the Wednesday opener all break the arithmetic version.
let NFL_SCHED = null;
async function nflSchedule(env) {
  if (NFL_SCHED) return NFL_SCHED;
  try {
    const r = await env.ASSETS.fetch(new Request('https://x/nfl-schedule-2026.json'));
    if (r.ok) NFL_SCHED = await r.json();
  } catch (e) { /* asset missing -> week stays null */ }
  return NFL_SCHED;
}
function nflWeekOf(commence) {
  if (!commence || !NFL_SCHED || !NFL_SCHED.games) return null;
  const t = Date.parse(commence);
  if (!isFinite(t)) return null;
  let best = null, bestGap = Infinity;
  for (const g of NFL_SCHED.games) {
    const gt = Date.parse(`${g.d}T${g.t}:00Z`);
    if (!isFinite(gt)) continue;
    const gap = Math.abs(gt - t);
    if (gap < bestGap) { bestGap = gap; best = g; }
  }
  // Kickoff times drift by a few hours between sources; anything further out is
  // a different game and should stay null rather than be forced into a week.
  return bestGap <= 36 * 3600e3 ? best.wk : null;
}

async function logBatterPicks(db, rows, date) {
  await ensureBatterSchema(db);
  const stmts = [];
  for (const r of rows) {
    // Only genuine pre-game picks with a resolvable MLB game.
    if (r.status !== 'Preview' || !r.gamePk || r.playerId == null) continue;
    for (const m of (r.batterMarkets || [])) {
      if (m.none || m.price == null) continue;
      const gid = 'g' + r.gamePk;
      stmts.push(db.prepare(
        `INSERT OR IGNORE INTO bpicks (date,game_id,player_id,player,team,market,line,side,price,proj,model_over,edge,tier,entry_over,fair_src,model_ver,fair_books,season_pa,impl_runs)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(date, gid, r.playerId, r.name, r.team, m.metric, m.line, m.side, m.price, m.proj, m.modelOver, m.edge, String(m.tier), m.fairOver ?? null, m.fairSrc ?? null, BATTER_MODEL_VER, m.fairBooks ? JSON.stringify(m.fairBooks) : null, r.seasonPA ?? null, r.impliedRuns ?? null));
      // Continuous close capture: latest line/price always; the vig-free over%
      // only when the line still matches entry (so a late line move never
      // clobbers the last comparable close).
      stmts.push(db.prepare('UPDATE bpicks SET close_line=?, close_price=? WHERE date=? AND game_id=? AND player_id=? AND market=?')
        .bind(m.line, m.price, date, gid, r.playerId, m.metric));
      if (m.fairOver != null) {
        // Stamp the tier alongside the number so a sharp-entry/DK-close pair can
        // be detected later instead of silently reading as line movement.
        //
        // Never downgrade: once a close is stored whose tier MATCHES entry, only
        // another matching capture may replace it. A later refresh that can only
        // see the execution book would otherwise wipe a good sharp close and put
        // the row out of CLV reach — the earlier number is slightly less final
        // but comparable, which beats a fresher number that has to be discarded.
        // A stored close that already mismatches is replaceable by anything.
        stmts.push(db.prepare(
          `UPDATE bpicks SET close_over=?, close_src=?
           WHERE date=? AND game_id=? AND player_id=? AND market=? AND line=?
             AND (close_src IS NULL OR close_src <> COALESCE(fair_src,'') OR ? = COALESCE(fair_src,''))`
        ).bind(m.fairOver, m.fairSrc ?? null, date, gid, r.playerId, m.metric, m.line, m.fairSrc ?? ''));
      }
    }
  }
  if (stmts.length) await db.batch(stmts);
}

// Grade finished batter picks from the boxscore (same Final-only guard as the
// pitcher grader). HR / total bases / H+R+RBI are read/derived per market.
async function gradeBatterPicks(env) {
  const db = env.DB;
  const today = slateDate();
  const rows = (await db.prepare('SELECT DISTINCT game_id, date FROM bpicks WHERE result IS NULL AND date < ?').bind(today).all()).results || [];
  if (!rows.length) return;

  const statusByGame = {};
  for (const d of [...new Set(rows.map((r) => r.date))]) {
    try {
      const r = await fetch(`${STATS}/schedule?sportId=1&date=${d}`, { headers: { accept: 'application/json' } });
      if (!r.ok) continue;
      const sd = await r.json();
      (((sd.dates || [])[0] || {}).games || []).forEach((g) => {
        statusByGame['g' + g.gamePk] = (g.status && g.status.abstractGameState) || '';
      });
    } catch (e) { /* skip this date */ }
  }

  // Same reschedule hole as the other graders. bpicks has no stuck rows today,
  // but the defect is identical and would bite on the next postponement.
  const unresolvedB = rows.filter((g) => statusByGame[g.game_id] !== 'Final').map((g) => g.game_id);
  const bByPk = unresolvedB.length ? await gamesByPk(unresolvedB) : {};
  for (const [gid, g] of Object.entries(bByPk)) {
    if (g.state === 'Final') statusByGame[gid] = 'Final';
  }
  const abandonedB = Object.keys(bByPk).filter((gid) => isAbandoned(bByPk[gid]));
  if (abandonedB.length) {
    try {
      await db.batch(abandonedB.map((gid) => db.prepare(
        "UPDATE bpicks SET result='void' WHERE game_id=? AND result IS NULL").bind(gid)));
    } catch (e) { /* retry next pass */ }
  }

  for (const g of rows.slice(0, 30)) {
    if (statusByGame[g.game_id] !== 'Final') continue;
    const pk = String(g.game_id).replace(/^g/, '');
    let box;
    try {
      const r = await fetch(`${STATS}/game/${pk}/boxscore`, { headers: { accept: 'application/json' } });
      if (!r.ok) continue;
      box = await r.json();
    } catch (e) { continue; }
    const picks = (await db.prepare('SELECT * FROM bpicks WHERE game_id=? AND result IS NULL').bind(g.game_id).all()).results || [];
    const stmts = [];
    for (const p of picks) {
      const actual = batterActual(box, p.player_id, p.market);
      // Didn't play -> void, written explicitly rather than left NULL. Leaving it
      // NULL would keep the row in this function's own work queue
      // (WHERE result IS NULL) forever: every bench player, every night, re-fetching
      // a boxscore that can never resolve, eventually crowding real games out of
      // the 30-game slice. 'void' is already excluded from every stats reader,
      // which all filter to win/loss.
      const result = actual == null ? 'void' : gradePick(p.side, p.line, actual);
      stmts.push(db.prepare('UPDATE bpicks SET actual=?, result=?, grade_ver=? WHERE date=? AND game_id=? AND player_id=? AND market=?').bind(actual, result, GRADE_VER, p.date, p.game_id, p.player_id, p.market));
    }
    if (stmts.length) { try { await db.batch(stmts); } catch (e) { /* skip */ } }
  }
}

// A batter's actual value for a market from the boxscore batting line.
// One-shot reconciliation of rows graded before the did-not-play fix. Those rows
// scored a bench player as actual=0, which is an Under win and is not separable
// from a real 0-for-4 by looking at the table — only the boxscore knows. So the
// sweep re-derives from the boxscore.
//
// Only actual=0 rows can be wrong: any nonzero actual is proof he batted. That
// keeps the work small, and stamping grade_ver makes it terminate — each game is
// re-fetched once, ever, and confirmed 0-for-4 rows are marked so they are never
// looked at again.
//
// Four games per pass, newest first. Small because this shares a subrequest
// budget with gradeUngraded and gradeBatterPicks, which already burn up to 30
// boxscore fetches each — a bigger batch here would starve live grading rather
// than merely slow the sweep. Newest first so the current pricing era, which is
// what projBiasByWeek reads, is clean first.
async function backfillBatterGrades(env) {
  const db = env.DB;
  const games = (await db.prepare(
    `SELECT DISTINCT game_id, date FROM bpicks WHERE ${backfillWhere()} ORDER BY date DESC LIMIT 4`
  ).all()).results || [];
  if (!games.length) return;

  for (const g of games) {
    const pk = String(g.game_id).replace(/^g/, '');
    let box;
    try {
      const r = await fetch(`${STATS}/game/${pk}/boxscore`, { headers: { accept: 'application/json' } });
      if (!r.ok) continue;
      box = await r.json();
    } catch (e) { continue; }
    // Re-derive only the suspect rows. Rows with a nonzero actual are left alone
    // entirely — they were never in question and re-grading them would risk
    // rewriting a settled result off a boxscore correction.
    const picks = (await db.prepare(
      // date as well as game_id: date leads the primary key, so this is a direct
      // lookup. game_id alone read every row in the table, once per game.
      `SELECT * FROM bpicks WHERE date=? AND game_id=? AND actual = 0 AND result IN ('win','loss')`
    ).bind(g.date, g.game_id).all()).results || [];
    const stmts = [];
    for (const p of picks) {
      const actual = batterActual(box, p.player_id, p.market);
      const result = actual == null ? 'void' : gradePick(p.side, p.line, actual);
      stmts.push(db.prepare(
        'UPDATE bpicks SET actual=?, result=?, grade_ver=? WHERE date=? AND game_id=? AND player_id=? AND market=?'
      ).bind(actual, result, GRADE_VER, p.date, p.game_id, p.player_id, p.market));
    }
    if (stmts.length) { try { await db.batch(stmts); } catch (e) { /* retry next pass */ } }
  }
}

function batterActual(box, playerId, market) {
  let bat = null;
  ['away', 'home'].forEach((side) => {
    const players = ((box.teams || {})[side] || {}).players || {};
    Object.keys(players).forEach((k) => {
      const pl = players[k];
      if (pl.person && pl.person.id === playerId && pl.stats && pl.stats.batting) bat = pl.stats.batting;
    });
  });
  if (!bat) return null;
  // A rostered batter who never came off the bench still carries a stats.batting
  // object in the boxscore — it is simply empty. {} is truthy, so the guard above
  // passed him through, and toNum(undefined) then scored every category 0, which
  // grades an Under as a win. Indistinguishable, after the fact, from a real
  // 0-for-4. The pitcher grader never had this hole because it null-checks a
  // FIELD (stats.pitching.strikeOuts) rather than the container.
  //
  // Require positive evidence he actually appeared. gamesPlayed leads because a
  // pinch runner who scores has no PA and no AB but a legitimate H+R+RBI of 1;
  // keying on plate appearances alone would void him.
  const appeared = toNum(bat.gamesPlayed) >= 1
    || toNum(bat.plateAppearances) > 0
    || toNum(bat.atBats) > 0;
  if (!appeared) return null; // didn't play -> leave ungraded (void), never a 0
  const h = toNum(bat.hits), d = toNum(bat.doubles), t = toNum(bat.triples), hr = toNum(bat.homeRuns);
  const runs = toNum(bat.runs), rbi = toNum(bat.rbi);
  if (market === 'hr') return hr;
  if (market === 'tb') return h + d + 2 * t + 3 * hr; // 1B + 2·2B + 3·3B + 4·HR
  if (market === 'hrr') return h + runs + rbi;
  return null;
}

async function logPicks(db, rows, date) {
  await ensureSchema(db);
  const stmts = [];
  for (const r of rows) {
    // Only log genuine pre-game picks — never a game already under way/final.
    if (r.status !== 'Preview') continue;
    for (const p of (r.pitchers || [])) {
      if (!p.market || p.market.price == null || p.id == null) continue;
      const m = p.market;
      stmts.push(db.prepare(
        `INSERT OR IGNORE INTO picks (date,game_id,pitcher_id,pitcher,team,line,side,price,proj,model_over,edge,tier,entry_over,fair_src,model_ver)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(date, r.id, p.id, p.name, p.team, m.line, m.side, m.price, p.proj, m.modelOver, m.edge, String(m.tier), m.fairOver ?? null, m.fairSrc ?? null, K_MODEL_VER));
      // Continuous close capture (see logBatterPicks for the rationale).
      stmts.push(db.prepare('UPDATE picks SET close_line=?, close_price=? WHERE date=? AND game_id=? AND pitcher_id=?')
        .bind(m.line, m.price, date, r.id, p.id));
      if (m.fairOver != null) {
        // close_src stamped with the number, so a fair that entered on the sharp
        // pool and closed on consensus is detectable rather than reading as line
        // movement — the same trap already closed on bpicks, and the same
        // no-downgrade rule so a late execution-only refresh cannot wipe a
        // sharp close captured earlier in the window.
        stmts.push(db.prepare(
          `UPDATE picks SET close_over=?, close_src=?
           WHERE date=? AND game_id=? AND pitcher_id=? AND line=?
             AND (close_src IS NULL OR close_src <> COALESCE(fair_src,'') OR ? = COALESCE(fair_src,''))`
        ).bind(m.fairOver, m.fairSrc ?? null, date, r.id, p.id, m.line, m.fairSrc ?? ''));
      }
    }
  }
  if (stmts.length) await db.batch(stmts);
}

// Resolve games by gamePk instead of by the date they were logged on.
//
// Both graders below key scores off `schedule?date=<the pick's date>`. That is
// correct until a game is postponed: it is replayed under the SAME gamePk on a
// different officialDate, so it never appears on the original date's schedule,
// the row is skipped, and it is skipped again on every subsequent pass. Nothing
// errors and nothing retries differently — the pick just sits ungraded forever.
//
// gamePk follows the game across the reschedule, so one lookup keyed on it
// settles the question. Also returns the terminal-but-unplayed states, because
// a cancelled game has to be voided or it becomes the same permanent limbo.
async function gamesByPk(gameIds) {
  const pks = [...new Set(gameIds.map((id) => String(id).replace(/^g/, '')))].filter(Boolean);
  if (!pks.length) return {};
  const out = {};
  // Batched, and capped: this is a repair path, not the hot path. Anything it
  // does not reach this pass is picked up on the next one.
  for (let i = 0; i < pks.length && i < 60; i += 20) {
    const slice = pks.slice(i, i + 20);
    try {
      const r = await fetch(`${STATS}/schedule?sportId=1&gamePks=${slice.join(',')}&hydrate=linescore,team`,
        { headers: { accept: 'application/json' } });
      if (!r.ok) continue;
      const j = await r.json();
      for (const g of (j.dates || []).flatMap((d) => d.games || [])) {
        const st = g.status || {};
        const ls = g.linescore || {};
        out['g' + g.gamePk] = {
          state: st.abstractGameState || '',
          coded: st.codedGameState || '',
          detailed: st.detailedState || '',
          officialDate: g.officialDate || null,
          homeR: numOr((ls.teams && ls.teams.home && ls.teams.home.runs), g.teams && g.teams.home && g.teams.home.score),
          awayR: numOr((ls.teams && ls.teams.away && ls.teams.away.runs), g.teams && g.teams.away && g.teams.away.score),
        };
      }
    } catch (e) { /* next slice */ }
  }
  return out;
}

// A game that will never produce a box score. 'C' cancelled, 'D' postponed with
// no replay date, 'T' suspended-and-abandoned. Postponed-and-rescheduled is NOT
// here: that game still resolves by pk once it is replayed, so voiding it would
// throw away a real result.
function isAbandoned(g) {
  if (!g) return false;
  return ['C', 'D', 'T'].includes(g.coded) || /cancel/i.test(g.detailed || '');
}

// A game line logged for a day the game was not played on. Postponed-and-
// rescheduled keeps its gamePk, so the pk lookup above hands back the MAKEUP's
// score: ALCS Game 4, TB @ CLE (849817), was rained out 2026-10-16 and played
// 2026-10-18 as Game 5, and the 10-16 moneyline row graded 1-3 off Game 5 --
// the same game counted on two dates. Books void a postponed MLB moneyline not
// played that day, so the row is void. officialDate is the day the game counts
// on, and the original date's listing carries the NEW one, so either listing
// answers. A suspended game is not this: resumed later, it keeps its original
// officialDate (824912, 2026-06-16, finished 06-17) and grades as before.
// Game lines only (moneyline, run line, totals). The prop graders still read
// box scores by pk and are not covered by this.
function movedOffDate(g, date) {
  return !!(g && g.officialDate && date && g.officialDate !== date);
}

async function gradeUngraded(env) {
  const db = env.DB;
  const today = slateDate();
  // Games needing a boxscore: those with an ungraded PICK, and those with an
  // ungraded PROJECTION. The second half is not optional. proj_log writes a row
  // for every probable starter, but picks only exist where a market was priced,
  // so driving this off picks alone would silently never grade the projections
  // for any game that had no priced K prop — and would drop the rest the moment
  // their picks graded or voided, since the game then leaves the pending pool
  // for good. The surviving sample would be "games the book priced", which is
  // exactly the wrong population to judge a projection on.
  await ensureProjLogSchema(db);
  const rows = (await db.prepare(
    `SELECT DISTINCT game_id, date FROM picks WHERE result IS NULL AND date < ?
     UNION
     SELECT DISTINCT game_id, date FROM proj_log WHERE actual IS NULL AND date < ?`
  ).bind(today, today).all()).results || [];
  if (!rows.length) return;

  // Only grade games that are actually Final (never a live/postponed one).
  // One schedule call per date gives every game's status.
  const statusByGame = {};
  for (const d of [...new Set(rows.map((r) => r.date))]) {
    try {
      const r = await fetch(`${STATS}/schedule?sportId=1&date=${d}`, { headers: { accept: 'application/json' } });
      if (!r.ok) continue;
      const sd = await r.json();
      (((sd.dates || [])[0] || {}).games || []).forEach((g) => {
        statusByGame['g' + g.gamePk] = (g.status && g.status.abstractGameState) || '';
      });
    } catch (e) { /* skip this date */ }
  }

  // Anything the date-keyed pass could not place is looked up by gamePk, which
  // is what rescues a game postponed and replayed on a different date.
  const unresolvedK = rows.filter((g) => statusByGame[g.game_id] !== 'Final').map((g) => g.game_id);
  const kByPk = unresolvedK.length ? await gamesByPk(unresolvedK) : {};
  for (const [gid, g] of Object.entries(kByPk)) {
    if (g.state === 'Final') statusByGame[gid] = 'Final';
  }
  // A game that will never be played cannot be graded and must not be retried
  // forever. Voided rather than left NULL so it leaves the pending pool.
  const abandonedK = Object.keys(kByPk).filter((gid) => isAbandoned(kByPk[gid]));
  if (abandonedK.length) {
    try {
      await db.batch(abandonedK.map((gid) => db.prepare(
        "UPDATE picks SET result='void' WHERE game_id=? AND result IS NULL").bind(gid)));
    } catch (e) { /* retry next pass */ }
  }

  for (const g of rows.slice(0, 30)) {
    if (statusByGame[g.game_id] !== 'Final') continue;
    const pk = String(g.game_id).replace(/^g/, '');
    let box;
    try {
      const r = await fetch(`${STATS}/game/${pk}/boxscore`, { headers: { accept: 'application/json' } });
      if (!r.ok) continue;
      box = await r.json();
    } catch (e) { continue; }
    const kById = pitcherKsFromBox(box);

    // Grade the hits projections off the SAME boxscore. Separate from the picks
    // loop below because these are not picks: there is no side, no line and no
    // result — only a number that was predicted and a number that happened.
    try {
      const hById = pitcherHitsFromBox(box);
      const hStmts = Object.keys(hById).map((pid) => db.prepare(
        'UPDATE proj_log SET actual=?, updated_at=? WHERE game_id=? AND pitcher_id=? AND market=? AND actual IS NULL'
      ).bind(hById[pid], Date.now(), String(g.game_id), Number(pid), 'H'));
      if (hStmts.length) await db.batch(hStmts);
    } catch (e) { /* the projection record is not worth failing a grading pass */ }

    const picks = (await db.prepare('SELECT * FROM picks WHERE game_id=? AND result IS NULL').bind(g.game_id).all()).results || [];
    const stmts = [];
    for (const p of picks) {
      const k = kById[p.pitcher_id];
      // Scratched starter: the game is Final but this pitcher has no pitching
      // line, so there is no strikeout total to grade against. `continue` left
      // the row NULL and it was re-examined on every pass forever. This is the
      // pitcher-side twin of the batter did-not-play bug — void it, exactly as
      // batterActual does, and never score it as a 0 (which would settle an
      // Under as a win for a pitcher who never threw).
      //
      // A pitcher who DID throw and struck out nobody is unaffected: he carries
      // strikeOuts: 0, which pitcherKsFromBox keeps, so k is 0 and not null.
      if (k == null) {
        stmts.push(db.prepare(
          "UPDATE picks SET result='void' WHERE date=? AND game_id=? AND pitcher_id=?")
          .bind(p.date, p.game_id, p.pitcher_id));
        continue;
      }
      const result = gradePick(p.side, p.line, k);
      stmts.push(db.prepare('UPDATE picks SET actual_k=?, result=? WHERE date=? AND game_id=? AND pitcher_id=?').bind(k, result, p.date, p.game_id, p.pitcher_id));
    }
    if (stmts.length) { try { await db.batch(stmts); } catch (e) { /* skip */ } }
  }
}

// Log tonight's moneyline picks (one row per game) the same way logPicks does
// for strikeouts: only genuine pre-game picks, entry price frozen, close price
// captured continuously. The graded side is whatever the model backed at entry.
// The moneyline tiers that post a play (pass and check do not).
const ML_POSTED_TIERS = new Set(['1', '2', '3']);
async function logMlPicks(db, rows, date) {
  await ensureMlPickSchema(db);
  const stmts = [];
  for (const r of rows) {
    if (r.status !== 'Preview') continue;
    const ml = r.ml;
    if (!ml || ml.price == null || !ml.teamAbbr) continue;
    // A price this far from the model's own number is a bad read off the feed,
    // not an edge. Logging it poisons the record; posting it sends a bet at a
    // number no book is holding.
    if (!mlPriceSane(ml.price, ml.winProb)) continue;
    const isHome = ml.teamAbbr === ml.homeAbbr ? 1 : 0;
    const opp = isHome ? ml.awayAbbr : ml.homeAbbr;
    const at = new Date().toISOString();
    const tier = String(ml.tier);
    stmts.push(db.prepare(
      `INSERT OR IGNORE INTO mlpicks (date,game_id,team,opp,is_home,tier,win_prob,edge,entry_price,close_price,model_ver,fair_source,
         entry_win_prob,entry_edge,entry_tier,entry_fair_source,entry_at,close_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(date, r.id, ml.teamAbbr, opp || '', isHome, tier, ml.winProb ?? null, ml.edge ?? null, ml.price, ml.price, ML_MODEL_VER, ml.fairSource ?? null,
      ml.winProb ?? null, ml.edge ?? null, tier, ml.fairSource ?? null, at, at));
    // Refresh close only while the logged side is still the model's pick, so a
    // mid-day side flip can't overwrite our entry side's closing price.
    stmts.push(db.prepare(
      'UPDATE mlpicks SET close_price=?, edge=?, tier=?, win_prob=?, close_at=?, close_fair=?, close_fair_source=? WHERE date=? AND game_id=? AND team=?'
    ).bind(ml.price, ml.edge ?? null, tier, ml.winProb ?? null, at, ml.fairProb ?? null, ml.fairSource ?? null, date, r.id, ml.teamAbbr));
    // The first read at a posted tier is the play as it was shown; written once.
    if (ML_POSTED_TIERS.has(tier)) {
      stmts.push(db.prepare(
        'UPDATE mlpicks SET posted_at=?, posted_price=?, posted_win_prob=?, posted_edge=?, posted_tier=? WHERE date=? AND game_id=? AND team=? AND posted_at IS NULL'
      ).bind(at, ml.price, ml.winProb ?? null, ml.edge ?? null, tier, date, r.id, ml.teamAbbr));
    }
  }
  if (stmts.length) await db.batch(stmts);
}

// Grade past-day moneyline picks from final scores (schedule linescore). The
// picked team wins the bet if it outscored its opponent. MLB has no ties, but
// equal scores grade as push defensively.
// Over wins above the number, under below, a landing on it pushes.
async function gradeTotPicks(env) {
  const db = env.DB;
  await ensureTotSchema(db);
  const rows = (await db.prepare('SELECT * FROM totpicks WHERE result IS NULL AND date < ?').bind(slateDate()).all()).results || [];
  if (!rows.length) return;
  const byDate = {};
  for (const r of rows) (byDate[r.date] = byDate[r.date] || []).push(r);
  for (const d of Object.keys(byDate)) {
    let games = [];
    try {
      const res = await fetch(`${STATS}/schedule?sportId=1&date=${d}&hydrate=linescore,team`, { headers: { accept: 'application/json' } });
      if (!res.ok) continue;
      games = (((await res.json()).dates || [])[0] || {}).games || [];
    } catch (e) { continue; }
    const runsByGame = {};
    for (const g of games) {
      if (((g.status || {}).abstractGameState) !== 'Final') continue;
      if (movedOffDate(g, d)) continue;   // postponed: see movedOffDate
      const ls = g.linescore || {};
      const h = numOr((ls.teams && ls.teams.home && ls.teams.home.runs), g.teams.home.score);
      const a = numOr((ls.teams && ls.teams.away && ls.teams.away.runs), g.teams.away.score);
      if (h != null && a != null) runsByGame['g' + g.gamePk] = h + a;
    }
    const missing = byDate[d].filter((p) => runsByGame[p.game_id] == null).map((p) => p.game_id);
    if (missing.length) {
      const byPk = await gamesByPk(missing);
      const voids = [], moved = [];
      for (const [gid, g] of Object.entries(byPk)) {
        if (movedOffDate(g, d)) moved.push(gid);
        else if (g.state === 'Final' && g.homeR != null && g.awayR != null) runsByGame[gid] = g.homeR + g.awayR;
        else if (isAbandoned(g)) voids.push(gid);
      }
      const stmts = [
        ...voids.map((gid) => db.prepare("UPDATE totpicks SET result='void' WHERE game_id=? AND result IS NULL").bind(gid)),
        ...moved.map((gid) => db.prepare(
          "UPDATE totpicks SET result='void', total_runs=NULL WHERE date=? AND game_id=? AND result IS NULL").bind(d, gid)),
      ];
      if (stmts.length) {
        try { await db.batch(stmts); } catch (e) { /* next pass */ }
      }
    }
    const stmts = [];
    for (const p of byDate[d]) {
      const runs = runsByGame[p.game_id];
      if (runs == null) continue;
      const result = runs === p.point ? 'push' : ((runs > p.point) === (p.side === 'Over') ? 'win' : 'loss');
      stmts.push(db.prepare('UPDATE totpicks SET result=?, total_runs=? WHERE date=? AND game_id=?').bind(result, runs, p.date, p.game_id));
    }
    if (stmts.length) { try { await db.batch(stmts); } catch (e) { /* next pass */ } }
  }
}

// Totals summary for reading, not for the page: everything logged, split by the
// entry edge the way the moneyline flag was measured, plus how often the price
// moved our way.
function buildTotRecord(rows) {
  const graded = rows.filter((r) => r.result === 'win' || r.result === 'loss');
  const sum = (arr) => {
    let w = 0, l = 0, units = 0;
    for (const r of arr) { if (r.result === 'win') w++; else l++; units += profitUnits(r.result, r.entry_price ?? r.close_price); }
    const n = w + l;
    return { n, record: `${w}–${l}`, units: Math.round(units * 10) / 10, roi: n ? round1(units / n * 100) : null };
  };
  const e = (r) => (r.entry_edge != null ? r.entry_edge : r.edge);
  let beat = 0, clvN = 0;
  for (const r of graded) {
    const ie = amProb(r.entry_price), ic = amProb(r.close_price);
    if (ie == null || ic == null || r.entry_price === r.close_price) continue;
    clvN++; if (ic > ie) beat++;
  }
  return {
    note: `game totals, LOGGED ONLY — not shown or posted. DK/FD best price vs Pinnacle's de-vigged total at the same number; flag at ${TOT_EDGE_CHECK}+ points copied from moneylines, under test.`,
    logged: rows.length,
    pending: rows.filter((r) => r.result == null).length,
    all: sum(graded),
    byEntryEdge: {
      below0: sum(graded.filter((r) => e(r) != null && e(r) < 0)),
      from0to2_5: sum(graded.filter((r) => e(r) != null && e(r) >= 0 && e(r) < TOT_EDGE_CHECK)),
      check2_5plus: sum(graded.filter((r) => e(r) != null && e(r) >= TOT_EDGE_CHECK)),
    },
    bySide: { Over: sum(graded.filter((r) => r.side === 'Over')), Under: sum(graded.filter((r) => r.side === 'Under')) },
    clvBeatRate: clvN ? Math.round(beat / clvN * 1000) / 10 : null,
    clvN,
  };
}

async function gradeMlPicks(env) {
  const db = env.DB;
  await ensureMlPickSchema(db);
  const today = slateDate();
  const rows = (await db.prepare('SELECT * FROM mlpicks WHERE result IS NULL AND date < ?').bind(today).all()).results || [];
  if (!rows.length) return;
  const byDate = {};
  for (const r of rows) (byDate[r.date] = byDate[r.date] || []).push(r);
  for (const d of Object.keys(byDate)) {
    let games = [];
    try {
      const r = await fetch(`${STATS}/schedule?sportId=1&date=${d}&hydrate=linescore,team`, { headers: { accept: 'application/json' } });
      if (!r.ok) continue;
      games = (((await r.json()).dates || [])[0] || {}).games || [];
    } catch (e) { continue; }
    const scoreByGame = {};
    for (const g of games) {
      if (((g.status || {}).abstractGameState) !== 'Final') continue;
      // A postponed game's listing reads 'Final' on its original date.
      if (movedOffDate(g, d)) continue;
      const ls = g.linescore || {};
      const homeR = numOr((ls.teams && ls.teams.home && ls.teams.home.runs), g.teams.home.score);
      const awayR = numOr((ls.teams && ls.teams.away && ls.teams.away.runs), g.teams.away.score);
      if (homeR == null || awayR == null) continue;
      scoreByGame['g' + g.gamePk] = { homeR, awayR };
    }
    // Same reschedule hole as the other two graders: a game replayed on another
    // date never lands in this date's scoreByGame, so the row was skipped every
    // pass. Resolve the stragglers by gamePk, and void the ones that will never
    // be played so they stop accumulating in `pending`.
    const missing = byDate[d].filter((p) => !scoreByGame[p.game_id]).map((p) => p.game_id);
    if (missing.length) {
      const byPk = await gamesByPk(missing);
      const voids = [], moved = [];
      for (const [gid, g] of Object.entries(byPk)) {
        if (movedOffDate(g, d)) {
          moved.push(gid);
        } else if (g.state === 'Final' && g.homeR != null && g.awayR != null) {
          scoreByGame[gid] = { homeR: g.homeR, awayR: g.awayR };
        } else if (isAbandoned(g)) {
          voids.push(gid);
        }
      }
      // Scoped to this date: the makeup's own row, logged on the day it was
      // played, grades normally.
      const stmts = [
        ...voids.map((gid) => db.prepare("UPDATE mlpicks SET result='void' WHERE game_id=? AND result IS NULL").bind(gid)),
        ...moved.map((gid) => db.prepare(
          "UPDATE mlpicks SET result='void', team_score=NULL, opp_score=NULL WHERE date=? AND game_id=? AND result IS NULL").bind(d, gid)),
      ];
      if (stmts.length) {
        try { await db.batch(stmts); } catch (e) { /* retry next pass */ }
      }
    }
    const stmts = [];
    for (const p of byDate[d]) {
      const sc = scoreByGame[p.game_id];
      if (!sc) continue;
      const teamR = p.is_home ? sc.homeR : sc.awayR;
      const oppR = p.is_home ? sc.awayR : sc.homeR;
      const result = teamR === oppR ? 'push' : (teamR > oppR ? 'win' : 'loss');
      stmts.push(db.prepare('UPDATE mlpicks SET result=?, team_score=?, opp_score=? WHERE date=? AND game_id=?')
        .bind(result, teamR, oppR, p.date, p.game_id));
    }
    if (stmts.length) { try { await db.batch(stmts); } catch (e) { /* skip */ } }
  }
}

// /api/mlb-void-moved?since=YYYY-MM-DD -- one-off repair for game-line rows
// graded before movedOffDate existed (2026-10-19). The graders only read
// result IS NULL, so a row already graded off a makeup's score stays wrong
// without this. Idempotent: a voided row is never a candidate again.
//
// Candidates are rows whose gamePk was logged on two or more dates inside the
// window -- a gamePk has one official day, so that is the reschedule leaving a
// trace -- which keeps it to one StatsAPI call. Only a row whose date differs
// from that game's officialDate is touched. The row on the day it was played,
// a row whose lookup failed, and anything outside the window are left alone.
// Default window two weeks; ?since= reaches further back.
const MOVED_VOID_SET = {
  mlpicks: "result='void', team_score=NULL, opp_score=NULL",
  rlpicks: "result='void', team_score=NULL, opp_score=NULL",
  totpicks: "result='void', total_runs=NULL",
};
async function voidMovedGameRows(env, url) {
  if (!env || !env.DB) return cors(json({ error: 'env.DB not configured' }, 30));
  const db = env.DB;
  try {
    await ensureMlPickSchema(db); await ensureRlPickSchema(db); await ensureTotSchema(db);
    const q = url && url.searchParams ? String(url.searchParams.get('since') || '').trim() : '';
    const since = /^\d{4}-\d{2}-\d{2}$/.test(q) ? q : slateDateOffset(-14);
    const until = slateDate();
    const found = [];
    for (const table of Object.keys(MOVED_VOID_SET)) {
      const rows = (await db.prepare(`SELECT date, game_id, result FROM ${table} WHERE date >= ? AND date < ?`)
        .bind(since, until).all()).results || [];
      const dates = {};
      for (const r of rows) (dates[r.game_id] = dates[r.game_id] || new Set()).add(r.date);
      for (const r of rows) {
        if (r.result != null && r.result !== 'void' && dates[r.game_id].size > 1) found.push({ table, ...r });
      }
    }
    const byPk = found.length ? await gamesByPk(found.map((r) => r.game_id)) : {};
    const voided = [], stmts = [];
    for (const r of found) {
      const g = byPk[r.game_id];
      if (!movedOffDate(g, r.date)) continue;
      stmts.push(db.prepare(`UPDATE ${r.table} SET ${MOVED_VOID_SET[r.table]} WHERE date=? AND game_id=? AND result IS NOT NULL AND result <> 'void'`)
        .bind(r.date, r.game_id));
      voided.push({ table: r.table, date: r.date, game_id: r.game_id, was: r.result, playedOn: g.officialDate });
    }
    if (stmts.length) await db.batch(stmts);
    for (const v of voided) console.log(`mlb-void-moved: ${v.table} ${v.date} ${v.game_id} ${v.was} -> void (played ${v.playedOn})`);
    return cors(json({ since, until, checked: found.length, voided }, 5));
  } catch (e) {
    return cors(json({ error: String((e && e.message) || e) }, 5));
  }
}

// Aggregate the graded moneyline picks into a record/units/ROI/CLV summary,
// mirroring the props track record. Pass-tier picks are excluded from the
// headline, same as the strikeout side.
// Small stats helpers for the ML record. Kept module-level (not inside
// buildMlRecord) so the batter-debug versions stay independent of this one.
function mlMean(xs) { return xs.reduce((s, x) => s + x, 0) / xs.length; }
function mlT(xs) {
  if (!xs || xs.length < 2) return null;
  const m = mlMean(xs);
  const sd = Math.sqrt(xs.reduce((s, x) => s + (x - m) * (x - m), 0) / (xs.length - 1));
  // Guard on an epsilon, not on >0: a slice where every value is identical
  // leaves float dust instead of a clean zero, which would divide out to a
  // t-statistic in the billions and read as overwhelming significance.
  return sd > 1e-9 ? m / (sd / Math.sqrt(xs.length)) : null;
}
function mlP(t) { return (t == null || !isFinite(t)) ? null : Math.round(2 * (1 - normCdf(Math.abs(t))) * 1e4) / 1e4; }
function mlR2(v) { return (v == null || !isFinite(v)) ? null : Math.round(v * 100) / 100; }

// includePass exists for markets that are MEASURED rather than POSTED. The
// moneyline headline excludes pass-tier on purpose -- those are picks nobody was
// told to make, and counting them would flatter or damn a record of bets that
// never happened. The run line is different: under current pricing every one of
// its picks is pass, so excluding them leaves a record of 0-0 no matter how many
// games grade, and the reason for grading it at all disappears.
// The moneyline log split by the price each pick was graded at, for the owner's
// question "which price ranges win more often than their odds say". Every
// graded pick, pass and check included: over 827 picks to 2026-09-25 the tiers
// did not separate winners from losers (tier 1 was the worst), so this is about
// price, not tier. Graded at the same price as the headline (mlGradePrice).
// `implied` is the average win rate those prices needed; a winRate above it is
// a range beating its odds. The +140 to +199 dogs were the only such range on
// Sep 25, on 87 picks, which is too few to call.
const ML_PRICE_BANDS = [
  ['fav -200 and shorter', -Infinity, -200], ['fav -140 to -199', -199, -140], ['fav -100 to -139', -139, -100],
  ['dog +100 to +139', 100, 139], ['dog +140 to +199', 140, 199], ['dog +200 and longer', 200, Infinity],
];
function buildMlPriceBands(rows) {
  const priced = [];
  for (const r of rows) {
    if (r.result !== 'win' && r.result !== 'loss') continue;
    const p = mlGradePrice(r);
    if (p == null || !isFinite(p) || Math.abs(p) < 100 || Math.abs(p) > ML_PRICE_MAX) continue;
    priced.push({ r, p });
  }
  const out = {};
  for (const [label, lo, hi] of ML_PRICE_BANDS) {
    const b = priced.filter((x) => x.p >= lo && x.p <= hi);
    let w = 0, u = 0, imp = 0;
    for (const x of b) { if (x.r.result === 'win') w++; u += profitUnits(x.r.result, x.p); imp += amProb(x.p) * 100; }
    out[label] = {
      n: b.length, record: `${w}–${b.length - w}`,
      winRate: b.length ? round1(w / b.length * 100) : null,
      implied: b.length ? round1(imp / b.length) : null,
      units: Math.round(u * 10) / 10, roi: b.length ? round1(u / b.length * 100) : null,
    };
  }
  return out;
}

// Which graded moneyline rows the record counts as posted, at what tier and at
// what price (2026-10-12). tier is the latest read's, which every refresh
// overwrites, so counting by it scored a play by its close-time tier: a T2 that
// drifted to pass by first pitch was never in the record, and a pass that
// ticked up to T3 at the close was, graded at a morning price it was never
// posted at. Rows logged since 9c7701e (entry_at set) carry the play as shown:
// posted means posted_at is set, at posted_tier and posted_price. Older rows
// have only the latest tier and keep the old rule, as their own legacy line --
// never relabelled, never added into the forward headline.
const mlIsForward = (r) => r.entry_at != null && r.entry_at !== '';
function mlPostedAs(r) {
  if (mlIsForward(r)) {
    if (!r.posted_at) return null;
    return { tier: String(r.posted_tier), price: r.posted_price != null ? r.posted_price : mlGradePrice(r), from: r.posted_price };
  }
  if (r.tier === 'pass' || r.tier === 'check') return null;
  return { tier: String(r.tier), price: mlGradePrice(r), from: r.entry_price };
}

// One population of moneyline plays, each with the tier it counts at, the price
// it grades at, and the price its closing-line value is measured from.
function mlSummary(items) {
  const byTier = { '1': { w: 0, l: 0, units: 0 }, '2': { w: 0, l: 0, units: 0 }, '3': { w: 0, l: 0, units: 0 } };
  let w = 0, l = 0, units = 0, t1w = 0, t1l = 0, clvBeat = 0, clvN = 0;
  const profits = [], clvPts = [];
  for (const { r, tier, price, from } of items) {
    const win = r.result === 'win';
    if (win) w++; else l++;
    // Graded at the price the play was available at -- never the close, which
    // scores a bet nobody could have placed, and shifts ROI by exactly the line
    // movement CLV is separately measuring.
    const u = profitUnits(r.result, price);
    units += u;
    profits.push(u);
    const bt = byTier[tier];
    if (bt) { if (win) bt.w++; else bt.l++; bt.units += u; }
    if (tier === '1') { if (win) t1w++; else t1l++; }
    if (from != null && r.close_price != null) {
      const ie = amProb(from), ic = amProb(r.close_price);
      // A line that never moved is neither a beat nor a miss. Counting it in the
      // denominator only quietly scores every unrefreshed row as a CLV loss: 15%
      // of posted rows, dragging the reported beat rate from 27.4% to 23.2%.
      // buildTotRecord already skips them; these two numbers sit side by side
      // on the same page and have to mean the same thing.
      if (ie != null && ic != null && from !== r.close_price) {
        clvN++;
        if (ic > ie) clvBeat++;   // our side shortened = market agreed
        // Magnitude, not just a beat rate: a 60% beat rate on half-point moves
        // is worth less than 52% on large ones. Both prices carry the book's
        // vig, so the difference is a fair proxy for the move itself.
        clvPts.push((ic - ie) * 100);
      }
    }
  }
  const n = w + l;
  const tierBreakdown = ['1', '2', '3'].map((k) => {
    const b = byTier[k]; const nn = b.w + b.l;
    return nn ? { tier: k, record: `${b.w}–${b.l}`, n: nn, units: Math.round(b.units * 10) / 10, roi: round1(b.units / nn * 100) } : null;
  }).filter(Boolean);
  return {
    tracked: n, record: `${w}–${l}`, winRate: n ? round1(w / n * 100) : null,
    tier1: `${t1w}–${t1l}`, units: Math.round(units * 10) / 10, roi: n ? round1(units / n * 100) : null,
    tierBreakdown, clvBeatRate: clvN ? round1(clvBeat / clvN * 100) : null, clvN,
    // Era split. Rows before attribution existed carry NULL and group as
    // '(untagged)' rather than being folded into the current era. Graded at
    // the same price as the headline, so the eras sum to it.
    byModelVer: (() => {
      const m = {};
      for (const x of items) { const k = x.r.model_ver || '(untagged)'; (m[k] = m[k] || []).push(x); }
      return Object.keys(m).map((k) => {
        const arr = m[k];
        let w = 0, u = 0;
        for (const x of arr) { if (x.r.result === 'win') w++; u += profitUnits(x.r.result, x.price); }
        return { modelVer: k, n: arr.length, record: `${w}-${arr.length - w}`, roi: round1(u / arr.length * 100), units: Math.round(u * 10) / 10 };
      }).sort((a, b) => b.n - a.n);
    })(),
    // Magnitude + error bars. On a market this efficient a beat rate near 50%
    // and avgCLV near 0 is the expected null result, and p >= 0.05 means exactly
    // that — no established effect, regardless of how the ROI reads.
    avgCLVpts: clvPts.length ? round1(mlMean(clvPts)) : null,
    sig: { roiT: mlR2(mlT(profits)), roiP: mlP(mlT(profits)), clvT: mlR2(mlT(clvPts)), clvP: mlP(mlT(clvPts)) },
  };
}

function buildMlRecord(rows, includePass) {
  const graded = rows.filter((r) => r.result === 'win' || r.result === 'loss');
  const fairSourceMix = (() => {
    const m = {};
    for (const r of rows) { const k = r.fair_source || '(untagged)'; m[k] = (m[k] || 0) + 1; }
    return Object.keys(m).map((k) => ({ fairSource: k, n: m[k] })).sort((a, b) => b.n - a.n);
  })();
  const pending = rows.filter((r) => r.result == null).length;
  // The run line counts every graded row on one rule (see the caller).
  if (includePass) {
    return { ...mlSummary(graded.map((r) => ({ r, tier: String(r.tier), price: mlGradePrice(r), from: r.entry_price }))), fairSourceMix, pending };
  }
  // 'check' rows are graded but kept out alongside pass: the board told nobody
  // to bet them, it told them to check the news first. A forward row at check
  // never gets posted_at, so the same holds there.
  const forward = [], legacy = [];
  for (const r of graded) {
    const p = mlPostedAs(r);
    if (p) (mlIsForward(r) ? forward : legacy).push({ r, ...p });
  }
  const fwdDates = rows.filter(mlIsForward).map((r) => r.date).filter(Boolean).sort();
  return {
    ...mlSummary(forward),
    forwardSince: fwdDates.length ? fwdDates[0] : null,
    legacy: mlSummary(legacy),
    fairSourceMix, pending,
  };
}

// Every graded moneyline price against Pinnacle's closing line (2026-10-12):
// EV% = close fair x decimal(price) - 1, at the price the record grades the row
// at. A play that keeps beating the sharp close has value whatever a few weeks
// of results say; one that keeps missing it does not. Three groups: the
// forward posted plays (the headline), the older rows posted on the old rule,
// and every graded row. Most rows are passes, and a pass bought at a soft book
// sits about the book's margin below fair by construction -- so the all-rows
// number is mostly that margin, not a read on the plays.
function mlCloseFair(r) {
  if (r.close_fair != null) return r.close_fair_source === 'pinnacle' ? { fair: r.close_fair, rebuilt: false } : null;
  // Logged before close_fair existed: the close read wrote edge, close_price
  // and win_prob together, so edge/100 + implied(close_price) is that read's
  // fair. fair_source is the ENTRY read's, though: if Pinnacle had dropped out
  // by the close, the close's edge was the log5 model against the soft books
  // and the sum is no fair at all. win_prob is the same read's fair, rounded,
  // so a true rebuild lands within half a point of it (edge adds 0.05).
  if (r.fair_source !== 'pinnacle' || r.edge == null || r.close_price == null || r.win_prob == null) return null;
  const imp = amProb(r.close_price);
  if (imp == null) return null;
  const fair = r.edge / 100 + imp;
  if (Math.abs(fair * 100 - r.win_prob) > 0.6) return { rejected: true };
  return { fair, rebuilt: true };
}
const mlDecimal = (p) => (p > 0 ? 1 + p / 100 : 1 + 100 / -p);
function mlVsSharpClose(rows) {
  const groups = { posted: [], legacyPosted: [], all: [] };
  let rejected = 0;
  for (const r of rows) {
    if (r.result !== 'win' && r.result !== 'loss') continue;
    const cf = mlCloseFair(r);
    if (!cf) continue;
    if (cf.rejected) { rejected++; continue; }
    const posted = mlPostedAs(r);
    const price = posted ? posted.price : mlGradePrice(r);
    if (price == null || !isFinite(price) || Math.abs(price) < 100) continue;
    const x = { ev: (cf.fair * mlDecimal(price) - 1) * 100, won: r.result === 'win', fair: cf.fair, rebuilt: cf.rebuilt };
    groups.all.push(x);
    if (posted) groups[mlIsForward(r) ? 'posted' : 'legacyPosted'].push(x);
  }
  const r2 = (v) => Math.round(v * 100) / 100;
  const sum = (xs) => (xs.length ? {
    n: xs.length,
    median: r2(median(xs.map((x) => x.ev))),
    mean: r2(mlMean(xs.map((x) => x.ev))),
    above: round1(xs.filter((x) => x.ev > 0).length / xs.length * 100),
    won: round1(xs.filter((x) => x.won).length / xs.length * 100),
    expected: round1(mlMean(xs.map((x) => x.fair)) * 100),
    rebuilt: xs.filter((x) => x.rebuilt).length,
  } : { n: 0 });
  return { posted: sum(groups.posted), legacyPosted: sum(groups.legacyPosted), all: sum(groups.all), rejected };
}

// Hits allowed, from the boxscore already fetched to grade strikeouts — so
// grading the hits projection costs no extra request. Same shape and the same
// zero-is-not-null care: a starter who allowed no hits carries hits: 0, which
// must survive as 0 rather than being read as "did not pitch".
function pitcherHitsFromBox(box) {
  const out = {};
  ['away', 'home'].forEach((side) => {
    const players = ((box.teams || {})[side] || {}).players || {};
    Object.keys(players).forEach((key) => {
      const pl = players[key];
      const id = pl.person && pl.person.id;
      const p = pl.stats && pl.stats.pitching;
      // Only starters: proj_log holds projections for probable starters, and a
      // reliever's hits would grade a projection that was never made.
      if (id != null && p && p.gamesStarted && p.hits != null && p.hits !== '') out[id] = toNum(p.hits);
    });
  });
  return out;
}
function pitcherKsFromBox(box) {
  const out = {};
  ['away', 'home'].forEach((side) => {
    const players = ((box.teams || {})[side] || {}).players || {};
    Object.keys(players).forEach((key) => {
      const pl = players[key];
      const id = pl.person && pl.person.id;
      const k = pl.stats && pl.stats.pitching && pl.stats.pitching.strikeOuts;
      if (id != null && k != null && k !== '') out[id] = toNum(k);
    });
  });
  return out;
}

function gradePick(side, line, k) {
  if (k === line) return 'push';
  const over = k > line;
  return (side === 'Over' ? over : !over) ? 'win' : 'loss';
}

// A moneyline price the book could actually have been offering.
//
// One row in the log is AZ at +1500 on 2026-07-21, closing at -118, on a game
// the model made a 55% favourite and scored as a 1-point edge. A price does not
// travel from +1500 to -118, and a 55% side is not +1500; the edge and win
// probability were computed against the real number, so only the stored price
// was wrong. It won, and at +1500 it paid 15 units into a record whose entire
// profit was 8.3 — every other pick together lost. One garbled field turned a
// losing model into a winning one on the page.
//
// Two ways it fails the check. MLB moneylines do not reach +/-600 (the longest
// real dog in 763 logged rows is +304), and a price cannot disagree with the
// model's own probability by 25 points; the widest genuine gap here is ~20, and
// ML_EDGE_CHECK already treats 2.5 as worth a second look.
const ML_PRICE_MAX = 600;
const ML_PRICE_GAP = 25;
function mlPriceSane(price, winProb) {
  if (price == null || !isFinite(price)) return false;
  if (Math.abs(price) < 100 || Math.abs(price) > ML_PRICE_MAX) return false;
  if (winProb == null) return true;
  const imp = amProb(price);
  return imp == null ? false : Math.abs(winProb - imp * 100) <= ML_PRICE_GAP;
}
// The price to grade at: entry when it is usable, else the close. The bad row
// keeps its history and stops paying out.
function mlGradePrice(r) {
  return mlPriceSane(r.entry_price, r.win_prob) ? r.entry_price : r.close_price;
}

function profitUnits(result, price) {
  if (result === 'push') return 0;
  if (result === 'loss') return -1;
  return price > 0 ? price / 100 : 100 / (-price); // win, at 1u stake
}

function buildTrackRecord(rows) {
  const graded = rows.filter((r) => r.result === 'win' || r.result === 'loss');
  let w = 0, l = 0, units = 0, t1w = 0, t1l = 0;
  for (const r of graded) {
    if (r.tier === 'pass') continue;
    if (r.result === 'win') w++; else l++;
    units += profitUnits(r.result, r.price);
    if (String(r.tier) === '1') { if (r.result === 'win') t1w++; else t1l++; }
  }
  const plays = w + l;

  // ROI, per-tier and per-side breakdowns, projection accuracy (MAE), and a
  // cumulative-units series for the units-over-time chart.
  const roi = plays ? round1(units / plays * 100) : null; // 1u staked per play
  const byTier = { '1': { w: 0, l: 0, units: 0 }, '2': { w: 0, l: 0, units: 0 }, '3': { w: 0, l: 0, units: 0 } };
  const bySide = { Over: { w: 0, l: 0, units: 0 }, Under: { w: 0, l: 0, units: 0 } };
  const byMarket = {};
  const byDate = {};
  for (const r of graded) {
    if (r.tier === 'pass') continue;
    const u = profitUnits(r.result, r.price);
    const bt = byTier[String(r.tier)];
    if (bt) { if (r.result === 'win') bt.w++; else bt.l++; bt.units += u; }
    const bs = bySide[r.side];
    if (bs) { if (r.result === 'win') bs.w++; else bs.l++; bs.units += u; }
    const mk = r.market || 'K';
    const bmk = byMarket[mk] || (byMarket[mk] = { w: 0, l: 0, units: 0 });
    if (r.result === 'win') bmk.w++; else bmk.l++; bmk.units += u;
    byDate[r.date] = (byDate[r.date] || 0) + u;
  }
  const breakdown = (map, keyName, keys) => keys.map((k) => {
    const b = map[k]; const n = b.w + b.l;
    return { [keyName]: k, record: `${b.w}–${b.l}`, n, units: Math.round(b.units * 10) / 10, roi: n ? round1(b.units / n * 100) : null };
  }).filter((x) => x.n > 0);
  const tierBreakdown = breakdown(byTier, 'tier', ['1', '2', '3']);
  const sideBreakdown = breakdown(bySide, 'side', ['Over', 'Under']);
  const MARKET_LABEL = { K: 'Strikeouts', HR: 'Home Runs', TB: 'Total Bases', HRR: 'H+R+RBI' };
  const marketBreakdown = Object.keys(byMarket).map((k) => {
    const b = byMarket[k]; const n = b.w + b.l;
    return { market: MARKET_LABEL[k] || k, n, record: `${b.w}–${b.l}`, units: Math.round(b.units * 10) / 10, roi: n ? round1(b.units / n * 100) : null };
  }).filter((x) => x.n > 0).sort((a, b) => b.n - a.n);
  let cum = 0;
  const cumulative = Object.keys(byDate).sort().map((d) => { cum += byDate[d]; return { date: d, units: Math.round(cum * 10) / 10 }; });

  // Closing-line value: how far the vig-free market moved toward the bet side
  // between entry and close. Only picks whose line didn't move are directly
  // comparable; line-move picks are counted separately.
  let clvSum = 0, clvN = 0, beat = 0, lineMoved = 0;
  for (const r of graded) {
    if (r.tier === 'pass') continue;
    if (r.close_line != null && r.line != null && r.close_line !== r.line) { lineMoved++; continue; }
    if (r.close_over == null || r.entry_over == null) continue;
    const clv = r.side === 'Over' ? (r.close_over - r.entry_over) : (r.entry_over - r.close_over);
    clvSum += clv; clvN++; if (clv > 0) beat++;
  }
  const clv = clvN ? round1(clvSum / clvN * 100) : null;   // avg probability points
  const clvBeatRate = clvN ? round1(beat / clvN * 100) : null;

  // Projection accuracy: mean absolute error of projected vs actual Ks. Kept
  // strikeout-only — mixing K (0–15) with HR/TB (0–4) scales would be meaningless.
  let maeSum = 0, maeN = 0;
  for (const r of rows) {
    if ((r.market || 'K') !== 'K') continue;
    if (r.actual_k != null && r.proj != null && (r.result === 'win' || r.result === 'loss' || r.result === 'push')) {
      maeSum += Math.abs(r.proj - r.actual_k); maeN++;
    }
  }
  const mae = maeN ? round1(maeSum / maeN) : null;

  // Model calibration — strikeout model ONLY (the batter model is deliberately
  // regressed to the market and not yet calibrated, so mixing it in would muddy
  // this). Bucket graded K picks by the model's P(over); compare to the actual
  // over-rate. Only buckets with enough samples plot, so a lucky n=2 can't
  // masquerade as a data point.
  const CAL_MIN_N = 5;
  const calByBin = {};
  let calPredSum = 0, calOvers = 0, calN = 0;
  for (const r of graded) {
    if ((r.market || 'K') !== 'K') continue;
    if (r.model_over == null || r.actual_k == null || r.line == null) continue;
    if (r.result === 'push') continue;
    const bin = Math.min(9, Math.max(0, Math.floor(r.model_over / 10)));
    (calByBin[bin] = calByBin[bin] || []).push(r);
    calPredSum += r.model_over; if (r.actual_k > r.line) calOvers++; calN++;
  }
  const calibration = Object.values(calByBin).map((arr) => {
    const predicted = round1(arr.reduce((s, r) => s + r.model_over, 0) / arr.length);
    const overs = arr.filter((r) => r.actual_k > r.line).length;
    return { predicted, actual: round1(overs / arr.length * 100), n: arr.length };
  }).filter((x) => x.n >= CAL_MIN_N).sort((a, b) => a.predicted - b.predicted);
  // Headline read: overall predicted vs actual over-rate across all graded K
  // picks — needs a real sample before it means anything.
  const calibrationSummary = calN >= 20
    ? { n: calN, predicted: round1(calPredSum / calN), actual: round1(calOvers / calN * 100) }
    : null;

  // Batter UNDERS — the posted product since the pivot. Hit rate is the number
  // that transfers to any platform; units/ROI are flat-stake sportsbook basis.
  // Same tier='pass' exclusion as every other breakdown above: a pass means the
  // model found no edge, so it was never a play and can't count toward the record.
  // One pass, one population. Everything the record page shows about posted
  // unders is derived from THIS array, so the headline, the interval, the tier
  // table and the era table can never be computed off slightly different filters.
  const buRows = graded.filter((r) => r.tier !== 'pass'
    && (r.market || 'K') !== 'K' && r.side === 'Under');
  let buW = 0, buL = 0, buU = 0;
  const buPrices = [], buBreakEvens = [];
  for (const r of buRows) {
    if (r.result === 'win') buW++; else buL++;
    buU += profitUnits(r.result, r.price);
    if (typeof r.price !== 'number') continue;
    buPrices.push(r.price);
    // Break-even for ONE bet at ONE price: the win rate that price alone demands.
    const payout = r.price > 0 ? r.price / 100 : 100 / Math.abs(r.price);
    buBreakEvens.push(100 / (1 + payout));
  }
  const buN = buW + buL;
  // DO NOT average American odds. They are not linear and these straddle zero
  // (−205 to +138), so the mean is a number with no meaning: taking it and
  // deriving one break-even gave 46.8% where the correctly weighted figure is
  // 54.6% — a 13-point error, all of it flattering. The honest statistic is the
  // mean of the PER-BET break-evens, which is what the portfolio actually has to
  // clear. The median price is reported alongside as a plain description of a
  // typical price, and is not used in any calculation.
  const breakEven = buBreakEvens.length
    ? round1(buBreakEvens.reduce((s, x) => s + x, 0) / buBreakEvens.length) : null;
  const medianPrice = buPrices.length
    ? [...buPrices].sort((a, b) => a - b)[Math.floor((buPrices.length - 1) / 2)] : null;
  // 95% interval on the hit rate. Without it a point estimate above break-even
  // reads as a proven edge, which at this sample size it is not.
  let ci = null;
  if (buN >= 30) {
    const pHat = buW / buN;
    const se = Math.sqrt(pHat * (1 - pHat) / buN) * 100;
    ci = { lo: round1(buW / buN * 100 - 1.96 * se), hi: round1(buW / buN * 100 + 1.96 * se), se: round1(se) };
  }
  const batterUnders = buN > 0 ? {
    n: buN, record: `${buW}–${buL}`,
    winRate: round1(buW / buN * 100),
    roi: round1(buU / buN * 100),
    units: Math.round(buU * 10) / 10,
    medianPrice, breakEven, ci,
    // Stated rather than left to the reader to infer from two numbers barely a
    // point apart. Null means the interval contains break-even — "we cannot yet
    // tell", which is a different claim from "no edge" and must read differently.
    beatsBreakEven: ci && breakEven != null ? (ci.lo > breakEven ? true : ci.hi < breakEven ? false : null) : null,
    // The bottom line, and the only figure here that already accounts for every
    // price correctly. Hit rate against a break-even is a useful sanity check;
    // ROI is what the record actually returned, so it carries its own test.
    roiP: roiSignificance(buRows.map((r) => profitUnits(r.result, r.price))).p,
  } : null;

  // Slice the same rows two ways for the record page's tables. Both carry a
  // p-value, because a tier or era ordering that no test supports is a ranking
  // the record does not justify — and the page says so out loud.
  const sliceStats = (rows, key, label) => {
    const rets = rows.map((r) => profitUnits(r.result, r.price));
    const wins = rows.filter((r) => r.result === 'win').length;
    const { mean, units, p } = roiSignificance(rets);
    return { [key]: label, n: rows.length, record: `${wins}–${rows.length - wins}`,
      // Hit rate as well as the W–L string: a rate is comparable across slices of
      // very different size, which is the whole point of putting them in a table.
      hit: rows.length ? round1(wins / rows.length * 100) : null,
      units: Math.round(units * 10) / 10, roi: round1(mean * 100), p };
  };
  // What each tier label actually meant when it was applied. T1–T3 were bands of
  // model-vs-market disagreement; `play` is the EV gate that replaced them. Saying
  // so stops a reader inferring that T1 was ever a confidence ranking.
  const TIER_SUB = {
    '1': 'largest model disagreement',
    '2': 'middle band',
    '3': 'smallest qualifying edge',
    play: 'current era — gated on EV, not ranked',
  };
  const groupBy = (rows, fn) => {
    const m = new Map();
    for (const r of rows) { const k = fn(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
    return m;
  };
  const buTierBreakdown = ['1', '2', '3', 'play']
    .map((t) => {
      const rs = buRows.filter((r) => String(r.tier) === t);
      return rs.length ? Object.assign(sliceStats(rs, 'tier', t), { sub: TIER_SUB[t] || null }) : null;
    })
    .filter(Boolean);
  // Pricing eras, oldest first. dk-fair priced against the same book we bet, so
  // its "edge" was mechanically DraftKings' hold — it stays on the page because
  // deleting a bad era flatters the record.
  // Chronological, not by size or by result — the table is a history, and
  // sorting eras by ROI would put the contaminated one wherever it happened to
  // land rather than where it belongs in the story.
  // Below this an era's ROI is not a result. Matches the threshold the hit-rate
  // interval uses, so the page applies one standard for "enough to say anything".
  const ERA_MIN_N = 30;
  const ERA_ORDER = ['(untagged)', 'exec', 'sharp-split', 'sharp'];
  // Keyed on the fair_src values the database actually holds. Two of these carry
  // a warning, and the reason is the same in both cases: the era with the best
  // return is not the era with the best evidence.
  const ERA_META = {
    '(untagged)': { tag: 'unknown', warn: true,
      note: 'Posted before the fair source was recorded, so how these were priced cannot be reconstructed. The strongest return on this page sits here, on the rows we can say the least about.' },
    'exec': { tag: 'contaminated', warn: true,
      note: 'Fair line and price both came from the execution book, so the “edge” was mechanically that book’s hold rather than a read on the market. Kept because deleting a bad era flatters the record.' },
    'sharp-split': { tag: 'legacy',
      note: 'A short transitional sample while the sharp pool was being split from the execution book. Too small to carry weight either way.' },
    'sharp': { tag: 'current',
      note: 'Fair from the Shin de-vigged sharp pool, independent of the book we bet at. This is what ships tonight.' },
  };
  const eraBreakdown = [...groupBy(buRows, (r) => r.fair_src || '(untagged)').entries()]
    .map(([k, rs]) => {
      const s = sliceStats(rs, 'era', k);
      const meta = ERA_META[k] || { tag: null, note: null };
      // `warn` drives the caveat on the page. Carried per era rather than
      // inferred from the tag, so a new era added later has to make the call
      // deliberately instead of defaulting to un-caveated.
      //
      // `thin` is the other way an era row misleads: sharp-split returns +14.7%,
      // the best number in the table, on seven picks. That is noise wearing a
      // percentage sign, and it tops the ordering exactly because small samples
      // produce extreme values. Anything under the threshold is flagged so the
      // page can refuse to treat it as a result.
      return { ...s, tag: meta.tag, note: meta.note, warn: !!meta.warn, thin: s.n < ERA_MIN_N };
    })
    .sort((a, b) => (ERA_ORDER.indexOf(a.era) - ERA_ORDER.indexOf(b.era)) || b.n - a.n);

  // The log. Capped rather than paged: the page is an audit surface, not a
  // database browser, and the summary tables above already describe the whole
  // sample. Newest first so the most recent grading is the first thing checkable.
  const clvOf = (r) => (r.close_over == null || r.entry_over == null || (r.close_line != null && r.line != null && r.close_line !== r.line))
    ? null
    : Math.round((r.side === 'Over' ? (r.close_over - r.entry_over) : (r.entry_over - r.close_over)) * 1000) / 10;
  const LOG_MAX = 250;
  const toLogRow = (r) => ({
    date: r.date, player: r.player, team: r.team || null,
    market: MARKET_LABEL[r.market] || r.market || 'Strikeouts',
    line: r.line, side: r.side, price: r.price, tier: r.tier,
    result: r.result, clv: clvOf(r),
    // Whether this row is part of the record the page's headline describes.
    posted: r.tier !== 'pass' && (r.market || 'K') !== 'K' && r.side === 'Under',
  });
  const newestFirst = (a, b) => String(b.date).localeCompare(String(a.date));
  const logRowsOut = [...buRows].sort(newestFirst).slice(0, LOG_MAX).map(toLogRow);
  // The full model log: every graded row, including the K props, the overs and
  // the passes that are never posted and never counted in any number above. It
  // exists so the record cannot be accused of showing only its own selection —
  // but the rows appear beneath headline stats they are not part of, so each one
  // carries `posted` and the page has to say which population it is showing.
  const logAllOut = [...graded].sort(newestFirst).slice(0, LOG_MAX).map(toLogRow);
  const logScope = {
    postedN: buRows.length,
    allN: graded.length,
    // Named exactly. Moneylines live in their own table and are NOT in here;
    // claiming them would be describing a log we are not rendering.
    allNote: 'every graded model row — K props, overs and passes included. None of '
      + 'these are posted, and none are counted in the numbers above.',
  };

  // Current-era edge, for the gated note under the tabs. The record shown on the
  // site spans every pricing era we have ever run, which flatters or punishes the
  // model we are actually shipping tonight. This slice is only the current era,
  // and it carries its own significance so the UI can say "not yet established"
  // instead of implying a proven edge from a number that has not cleared a test.
  //
  // Same population as batterUnders (posted plays only, tier='pass' excluded) so
  // the two numbers are directly comparable — this is a subset of that record,
  // never a different accounting of it.
  const eraRet = [];
  let eraW = 0, eraL = 0;
  for (const r of graded) {
    if (r.tier === 'pass') continue;
    if ((r.market || 'K') === 'K' || r.side !== 'Under') continue;
    if ((r.model_ver || null) !== BATTER_MODEL_VER) continue;
    if (r.result === 'win') eraW++; else eraL++;
    eraRet.push(profitUnits(r.result, r.price));
  }
  const eraN = eraW + eraL;
  let eraEdge = null;
  if (eraN > 0) {
    const { mean, p } = roiSignificance(eraRet);
    // Established only when the test clears AND the edge is positive. A
    // significant NEGATIVE ROI is not an edge, and must never open the gate.
    const established = p != null && p < 0.05 && mean > 0;
    eraEdge = {
      era: BATTER_MODEL_VER,
      n: eraN,
      record: `${eraW}–${eraL}`,
      roi: round1(mean * 100),
      units: Math.round(eraRet.reduce((s, x) => s + x, 0) * 10) / 10,
      roiP: p,
      established,
      note: established
        ? `${eraN} graded this era · edge significant (p ${p})`
        : `${eraN} graded this era · edge not yet significant`,
    };
  }

  // Per-tier calibration: the model's average predicted WIN probability for each
  // tier vs the actual win rate — "our Tier-1 leans win at the rate we claim".
  // Predicted win prob orients model P(over) to the side we actually bet.
  const tierCal = { '1': { pred: 0, win: 0, n: 0 }, '2': { pred: 0, win: 0, n: 0 }, '3': { pred: 0, win: 0, n: 0 } };
  for (const r of graded) {
    if ((r.market || 'K') !== 'K' || r.model_over == null) continue;
    const t = tierCal[String(r.tier)];
    if (!t) continue;
    t.pred += (r.side === 'Over' ? r.model_over : 100 - r.model_over);
    t.win += (r.result === 'win' ? 1 : 0);
    t.n++;
  }
  const calibrationByTier = Object.entries(tierCal)
    .map(([tier, t]) => t.n >= 10
      ? { tier, predicted: round1(t.pred / t.n), actual: round1(t.win / t.n * 100), n: t.n }
      : null)
    .filter(Boolean);

  // The batter model's own calibration, this pricing era (2026-10-11). The
  // curve above is the strikeout model's, and its heading did not say so: the
  // improvement analysis read "says 64%, lands 48.7%" as the batter unders.
  // Every graded batter row this era, both sides, by the model's chance that
  // the under lands at the book's line.
  const batCal = {};
  let batN = 0, batSaid = 0, batUnder = 0;
  for (const r of graded) {
    if ((r.market || 'K') === 'K' || r.model_over == null || (r.model_ver || null) !== BATTER_MODEL_VER) continue;
    const pu = 100 - r.model_over;
    const landedUnder = (r.side === 'Under') === (r.result === 'win') ? 1 : 0;
    const lo = Math.max(35, Math.min(75, Math.floor(pu / 5) * 5));
    const c = batCal[lo] = batCal[lo] || { said: 0, under: 0, n: 0 };
    c.said += pu; c.under += landedUnder; c.n++;
    batN++; batSaid += pu; batUnder += landedUnder;
  }
  const calibrationBatter = batN ? {
    era: BATTER_MODEL_VER, n: batN, predicted: round1(batSaid / batN), actual: round1(batUnder / batN * 100),
    bins: Object.entries(batCal).filter(([, c]) => c.n >= 20).sort((a, b) => a[0] - b[0])
      .map(([lo, c]) => ({ band: `${lo}-${Number(lo) + 5}`, predicted: round1(c.said / c.n), actual: round1(c.under / c.n * 100), n: c.n })),
  } : null;

  return {
    empty: plays === 0,
    logged: rows.length,
    tracked: plays,
    winRate: plays ? round1(w / plays * 100) : null,
    record: `${w}–${l}`,
    tier1: `${t1w}–${t1l}`,
    units: Math.round(units * 10) / 10,
    roi,
    mae,
    cumulative,
    tierBreakdown,
    sideBreakdown,
    marketBreakdown,
    clv,
    clvBeatRate,
    clvN,
    clvLineMoved: lineMoved,
    calibration,
    calibrationSummary,
    calibrationByTier,
    calibrationBatter,
    batterUnders,
    buTierBreakdown,
    eraBreakdown,
    log: logRowsOut,
    logAll: logAllOut,
    logScope,
    eraEdge,
  };
}

// Most recent graded slate, as individual picks — feeds the "Yesterday's Card"
// strip. buildTrackRecord returns aggregates; this returns the per-pick detail
// for the single most recent date that has any graded pick (props + ML).
function buildRecent(propRows, mlRows) {
  const all = [];
  const add = (o) => { if (o.result === 'win' || o.result === 'loss' || o.result === 'push') all.push(o); };
  for (const r of propRows) {
    if (r.tier === 'pass') continue;
    // Yesterday's card mirrors what we POST as plays: batter unders only.
    // K picks and batter overs keep logging/grading for research, but they're
    // analysis now — not posted bets — so they don't appear on the card.
    if ((r.market || 'K') === 'K' || r.side !== 'Under') continue;
    const actual = r.actual_k != null ? r.actual_k : (r.actual != null ? r.actual : null);
    add({
      date: r.date, name: r.pitcher || r.player || '', team: r.team || '',
      market: String(r.market || 'K'), side: r.side || null, line: r.line ?? null,
      price: r.price ?? null, tier: String(r.tier || ''), result: r.result, actual,
    });
  }
  // Moneyline is context post-pivot — it keeps grading for research but never
  // appears on the card. (mlRows intentionally unused here.)
  void mlRows;
  if (!all.length) return null;
  const maxDate = all.reduce((m, x) => (x.date > m ? x.date : m), all[0].date);
  const day = all.filter((x) => x.date === maxDate);
  // Day record/units cover every graded play (Tier 1–3), matching the season
  // methodology. The inline card, though, shows only recommended plays
  // (Tier 1 + Tier 2, Tier 1 first); Tier 3 lives on the full track record.
  let w = 0, l = 0, units = 0;
  for (const p of day) {
    if (p.result === 'win') w++; else if (p.result === 'loss') l++;
    if (p.result !== 'push' && p.price != null) units += profitUnits(p.result, p.price);
  }
  const rank = (t) => (t === '1' ? 0 : t === '2' ? 1 : 2);
  const picks = day.filter((p) => p.tier === '1' || p.tier === '2').sort((a, b) => rank(a.tier) - rank(b.tier));
  return { date: maxDate, record: `${w}–${l}`, units: Math.round(units * 10) / 10, total: day.length, picks };
}

// Price a strikeout projection against the DK/FD lines. Picks the side with a
// model edge, quotes the better price of the two books for that side, and
// returns a per-book breakdown for the line-shop display. `prop` is
// { DK:{point,over,under}, FD:{point,over,under} } (either book may be absent).
// Given DK/FD prices for a prop and a model P(over) at the reference line, pick
// the +edge side, quote the better of the two prices, and return a per-book
// breakdown for the line-shop display. `prop` is
// { DK:{point,over,under}, FD:{point,over,under} }; `probOver(line)` returns the
// model's P(over) at that line. Shared by strikeouts and batter props.
// opts.shrink (default 1) regresses the model probability toward the market's
// fair probability — used to temper an uncalibrated model (batters) so edges
// don't wildly overstate. opts.tiers sets the [T1,T2,T3] edge cutoffs.
function bestBookMarket(prop, probOver, opts) {
  if (!prop) return null;
  const shrink = (opts && opts.shrink != null) ? opts.shrink : 1;
  const tiers = (opts && opts.tiers) || [5, 3, 1.5];
  const dk = prop.DK, fd = prop.FD;
  const refLine = (dk && dk.point != null) ? dk.point
    : (fd && fd.point != null ? fd.point : null);
  if (refLine == null) return null;

  const pRaw = probOver(refLine);

  // Vig-free fair over% at the reference line. De-vig a two-sided book by
  // normalizing its over/under to sum to 1.
  const devigTwo = (b) => {
    if (!b || b.point !== refLine || b.over == null || b.under == null) return null;
    const io = amProb(b.over), iu = amProb(b.under), v = io + iu;
    return v > 0 ? io / v : io;
  };

  let fairOver, fairBooks = null, fairSrc = null;
  if (opts && opts.fairPool) {
    // Independent fair line: de-vig the SHARP books only, then take the median
    // across whichever of them quoted this exact line two-sided. Because none of
    // these books is where the bet lands, the resulting edge is a real
    // disagreement between our model and sharp money — not an artifact of
    // measuring DraftKings against itself.
    const pool = opts.fairPool
      .map((book) => ({ book, dv: (() => {
        const b = prop[book];
        if (!b || b.point !== refLine || b.over == null || b.under == null) return null;
        return shinDevig(b.over, b.under);
      })() }))
      .filter((x) => x.dv != null);
    if (pool.length) {
      const dvs = pool.map((x) => x.dv);
      // The median rejects one stale book only when there are three to choose
      // between. At exactly two the median IS their midpoint, so a broken quote
      // drags the fair half its error and nothing catches it — a live TB row had
      // NOVIG at .3849 against PX at .4967 and priced the midpoint. Normal
      // two-book agreement runs under ~0.026, so a spread past SHARP_MAX_SPREAD
      // means one of them is wrong and we cannot tell which. Those fall through
      // to the execution fair, tagged 'sharp-split' rather than 'sharp' so the
      // weaker pricing stays visible in fairSourceMix instead of hiding.
      const spread = Math.max(...dvs) - Math.min(...dvs);
      const split = pool.length === 2 && spread > SHARP_MAX_SPREAD;
      fairBooks = pool.map((x) => ({ book: x.book, over: Math.round(x.dv * 1e4) / 1e4 }));
      if (split) {
        fairSrc = 'sharp-split';   // fair resolved below; books kept for diagnosis
      } else {
        fairOver = median(dvs);
        fairSrc = 'sharp';
      }
    }
  }
  if (fairOver == null && opts && opts.fairConsensus) {
    // Consensus fair: median de-vigged P(over) across the pooled books (the DK/FD
    // you bet + MGM as a reference). The median rejects a single soft/stale line,
    // so the edge measures the model against the market's agreement, not one book.
    const pool = [['DK', dk], ['FD', fd], ['MGM', prop.MGM]]
      .map(([book, b]) => ({ book, dv: devigTwo(b) }))
      .filter((x) => x.dv != null);
    if (pool.length) {
      fairOver = median(pool.map((x) => x.dv));
      fairBooks = pool.map((x) => ({ book: x.book, over: Math.round(x.dv * 1e4) / 1e4 }));
      fairSrc = 'consensus';
    }
  }
  if (fairOver == null) {
    // Single-book fair (prefer DK, then FD) — batters, and any line with no
    // two-sided quote to de-vig. Preserves the original behavior exactly.
    const atRef = [dk, fd].filter((b) => b && b.point === refLine);
    const twoSided = atRef.find((b) => b.over != null && b.under != null);
    // A 'sharp-split' tag set above survives: the reason this row landed on the
    // execution fair is that the sharp books contradicted each other, which is a
    // different (and more interesting) case than no sharp book quoting at all.
    const keep = fairSrc === 'sharp-split';
    if (twoSided) { const io = amProb(twoSided.over), iu = amProb(twoSided.under); const v = io + iu; fairOver = v > 0 ? io / v : io; if (!keep) fairSrc = 'exec'; }
    else { const one = atRef.find((b) => b.over != null || b.under != null); if (!one) return null; fairOver = one.over != null ? amProb(one.over) : 1 - amProb(one.under); if (!keep) fairSrc = 'exec-1s'; }
  }

  // Regress the model toward the market (shrink<1 for an uncalibrated model).
  const pOver = fairOver + shrink * (pRaw - fairOver);
  const over = (pOver - fairOver) >= 0;
  const side = over ? 'Over' : 'Under';
  const edgePts = round1(Math.abs(pOver - fairOver) * 100);

  // Per-book prices for the chosen side; mark the best payout.
  const books = [];
  for (const [label, b] of [['DK', dk], ['FD', fd]]) {
    if (!b) continue;
    const px = over ? b.over : b.under;
    if (px == null) continue;
    books.push({ book: label, price: px, line: b.point, off: b.point !== refLine });
  }
  if (!books.length) return null;
  const comparable = books.filter((x) => !x.off);
  const pool = comparable.length ? comparable : books;
  let best = pool[0].price;
  pool.forEach((x) => { if (payoutMult(x.price) > payoutMult(best)) best = x.price; });
  const bestSet = comparable.length ? comparable : books;
  books.forEach((x) => { x.best = bestSet.includes(x) && x.price === best; });

    // Expected value of the chosen side at the price actually available, from
    // the model's own probability. This is the number the graded record says
    // matters: over 4,832 rows, edge (model minus fair) separated winners from
    // losers about three times worse than EV did.
    //
    // EV = p*payout - (1-p). Positive means the price pays more than the model
    // thinks the outcome is worth.
    const pPick = over ? pOver : 1 - pOver;
    const ev = pPick * payoutMult(best) - (1 - pPick);

    // Tiering. When opts.evGate is set the board stops RANKING and only GATES.
    //
    // Ranking was dropped because nothing in the record orders the plays. ROI by
    // EV band is non-monotone (three rises, three falls across bands with 50+
    // rows), the 5-10% EV band returns -5.0% against +1.7% for 0-2%, and all four
    // candidate cutoff sets put T1 at or near the worst tier. Edge ordered no
    // better. A tier that claims T1 > T2 > T3 when the record shows no such
    // ordering is a confidence display with nothing behind it.
    //
    // What the record does support is the gate itself: rows below it returned
    // -3.1% (p=0.035-0.042, the only cell clearing 0.05), against roughly break
    // even for rows above. So the board says play or pass, and says nothing it
    // cannot support about which play is strongest.
    const gated = opts && opts.evGate != null;

  return {
    line: refLine,
    side,
    price: best,        // the better of DK/FD for the chosen side — what you'd bet
    edge: edgePts,
    modelOver: round1(pOver * 100),
    fairOver: Math.round(fairOver * 1e4) / 1e4, // vig-free market P(over) — for CLV
    fairSrc,            // 'sharp' | 'consensus' | 'exec' | 'exec-1s' — which tier produced the fair
    fairBooks,          // [{ book, over }] de-vigged pool behind the fair (consensus) — null otherwise
    ev: Math.round(ev * 1e4) / 1e4,
    evPct: round1(ev * 100),
    tier: gated
      ? (ev >= opts.evGate ? 'play' : 'pass')
      : (edgePts >= tiers[0] ? 1 : edgePts >= tiers[1] ? 2 : edgePts >= tiers[2] ? 3 : 'pass'),
    books,              // [{ book, price, line, off, best }]
  };
}

// The PrizePicks quote for one market, in the shape the client renders: the
// number, and the model's own read of it. Never an edge — see DISPLAY_BOOKS.
// `modelUnder` is the model's probability that the result lands UNDER the PP
// number, which is the only figure a pick'em entry is decided on.
function ppQuote(bookRec, modelUnderAt) {
  const b = bookRec && bookRec.PP;
  if (!b || b.point == null) return null;
  const out = { point: b.point, over: b.over ?? null, under: b.under ?? null };
  if (typeof modelUnderAt === 'function') {
    const u = modelUnderAt(b.point);
    if (u != null && isFinite(u)) out.modelUnder = Math.round(u * 1000) / 10;
  }
  return out;
}

// Strikeout prop: overdispersed normal around the projection, regressed to line.
function priceStrikeouts(prop, projK) {
  return bestBookMarket(prop, (L) => {
    const lam = (1 - LINE_SHRINK) * projK + LINE_SHRINK * L;
    const sigma = Math.sqrt(Math.max(lam, 1) * DISPERSION);
    return 1 - normCdf((L - lam) / sigma);
  }, { fairPool: SHARP_LABELS, fairConsensus: true });
}

// The batter model is a Poisson approximation and not yet calibrated (early
// grading shows it wildly overstates edges), so until it has a track record we
// regress it hard toward the market and price it on stricter tiers. This keeps
// batter picks honest — most land Tier 2/3/pass, not a board full of Tier 1.
const BATTER_SHRINK = 0.25;      // keep ~25% of the raw model-vs-market gap
// T1/T2/T3 edge cutoffs (vs 5/3/1.5 for Ks). T1 was 8, which admitted 4 of the
// 899 posted picks in the current era — 0.4%. At that rate T1 could never
// accumulate enough graded history to say anything (roiP 0.729 on n=19 across
// all eras), so the label claimed a confidence the record could not test.
//
// Set from the graded edge distribution per era (edgeDistribution on
// /api/batter-debug), NOT from a single slate. A one-night sample ran 75% of
// posted picks at edge>=5; the graded current era runs 22.6%. Fitting to the
// slate produced 6.5, which turned out to admit just 3.8% — barely better than
// the 8 it replaced. The nightly board is far too volatile to site a threshold
// on; only the graded population is.
//
// Share of posted picks at [5.5, 4, 3], by era:
//   sharp-shin-nb (current, n=899)  T1 13.3%  T2 40.6%  T3 46.1%
//   dk-fair              (n=234)    T1 17.5%  T2 44.5%  T3 38.0%
//   sharp-shin           (n=119)    T1 10.9%  T2 33.6%  T3 55.5%
// T1 stays a selective minority in every era while being large enough to build
// a testable sample, and T2 keeps a real population — holding T2 at 5 would
// have squeezed it to a 9% sliver between T1 and T3.
//
// T3 stays at 3, so the pass boundary is unchanged: this relabels picks, it does
// not change which ones get posted. Tier is stamped at log time, so graded
// history is not relabelled — T1's usable sample builds forward from here.
// EV gate. A batter under is posted when the price pays more than the model
// thinks the outcome is worth, and passed otherwise. Zero rather than a positive
// cushion: the 0-2% EV band was the best-performing band in the record (+1.7%),
// so requiring a margin above it would discard the rows that did best.
//
// BATTER_TIERS is retained only for the K-props path, which still ranks. It no
// longer touches the batter board.
const BATTER_EV_GATE = 0;
const BATTER_TIERS = [5.5, 4, 3];
// Projection calibration. HISTORY: the projection once ran ~16-17% HIGH (HRR
// projected 1.9 vs 1.6 actual, TB 1.8 vs 1.5, n=1382), which manufactured losing
// OVER picks. 0.86 pulled lambda down to fix that.
//
// 2026-08-08: that correction has OVER-shot and now runs the other way. The
// projection under-projects, which over-rates Unders — the only side posted —
// and those Unders lose when actuals land higher. Measured on projBiasByWeek:
//
//   HRR W31  n=1342  proj 1.4  actual 1.7   k = 1.214
//   HRR W32  n= 910  proj 1.4  actual 1.8   k = 1.286
//   TB  W31  n= 668  proj 1.5  actual 1.6   k = 1.067
//   TB  W32  n= 465  proj 1.4  actual 1.6   k = 1.143
//
// One constant serves hr/tb/hrr, so the correction is the n-weighted blend:
// k = 1.195 over 3385 graded rows. Full correction would be 0.86*1.195 = 1.027;
// applied at 85% of measured bias (the same caution the original used, and the
// direction has only just reversed, so the estimate is not yet stable) that is
// 1.002 -> 1.00.
//
// Corroboration, not just the bias number: batter unders fell from +6.7u to
// -31.7u in two days, the 387 newly graded picks returning -9.9%. The graded
// EDGE distribution was unchanged over the same window (p50 4.1, >=5.5 at 13.5%),
// so this is a projection problem, not a tier problem.
//
// Caveat on precision: projBias is reported to 1dp, so k could sit anywhere in
// 1.120-1.275, putting the 85% correction between 0.948 and 1.061. 1.00 is the
// centre of that band. The reporting is widened to 2dp below so the 2026-08-10
// read can re-derive this sharply and confirm or adjust.
// Per market, not one number for all three.
//
// 2026-08-11: W33 is the first week priced entirely at the post-fix value, and
// it shows the two markets needing corrections in OPPOSITE directions:
//
//   HRR  n=159  proj 1.64  actual 1.87  k = 1.140  (wants MORE lambda)
//   TB   n= 74  proj 1.71  actual 1.50  k = 0.877  (wants LESS)
//
// A single constant is now guaranteed to be wrong for at least one of them: the
// n-weighted blend is 1.057, which would push TB further past an actual it is
// already overshooting. HRR is ~80% of the posted board, so a shared constant
// gets dragged toward HRR and leaves TB worse.
//
// The values below are DELIBERATELY all 1.00 — identical to the single constant
// they replace, so this change is a no-op on pricing. It exists so the two
// markets can be tuned independently once W33 has more than one graded day
// behind it. `projCalSuggest` on /api/batter-debug reports the measured k and a
// suggested value per market; re-derive from there rather than by hand.
//
// HR keeps 1.00 and no suggestion of its own: home runs are not posted as a
// market and carry no graded projection bias to fit against.
// 2026-09-17: H+R+RBI 1.00 -> 1.11. TB stays 1.00.
//
// Measured over the whole sharp-shin-nb-evgate era (2,377 graded H+R+RBI rows,
// 08-16..09-16): actual / projected = 1.150 — 1.132 in the first half, 1.163 in
// the second, so the under-projection is persistent and growing. 1.11 is 85% of
// the first-half fit, the same caution every previous correction used. TB
// measured 1.00 (1.68 projected, 1.68 actual) and needs nothing.
//
// Replayed offline through the exact production pricing (tests nothing here, but
// the replay reproduced 2,377/2,377 model probabilities and 1,953/1,958 play/pass
// calls at 1.00 before any what-if was trusted):
//
//                 posted   record    ROI     units
//   at 1.00        526    273-253   -3.9%   -20.4
//   at 1.11        275    143-132   -3.4%    -9.2
//   dropped        251    130-121   -4.5%   -11.2
//
// READ THIS BEFORE CITING IT AS A WIN. Kept minus dropped is +1.1 ROI points,
// p=0.89 — no evidence the calibration selects better picks. The halves disagree:
// the picks it drops returned +5.9% in the first half and -14.4% in the second.
// What it reliably does is halve H+R+RBI exposure on a stream that is negative
// either way, and stop the model stating 1.6 where the truth is 1.8. It is a
// correctness and exposure fix, not a profitability fix.
const BATTER_PROJ_CAL = { hr: 1.00, tb: 1.00, hrr: 1.11 };
// Variance-to-mean ratio per market, measured from this system's own graded
// outcomes (see negBinomCdf). Home runs stay on Poisson: no graded HR sample
// exists to fit, and at a per-game lambda near 0.15 the Poisson, binomial and
// negative-binomial answers agree to well inside a tenth of a point, so there is
// nothing to gain and a free parameter to get wrong.
//
// Re-fit these as the sample grows — they are measurements, not constants.
const BATTER_DISPERSION = { tb: 2.41, hrr: 2.37, hr: 1 };

// Expected plate appearances by batting-order slot (league-typical: leadoff
// ~4.65, dropping ~0.11 per slot to ~3.77 in the 9-hole). Used once tonight's
// lineup is posted; before that, a batter's own season PA/G stands in.
const SLOT_PA = [4.65, 4.54, 4.43, 4.32, 4.21, 4.10, 3.99, 3.88, 3.77];

// Batter counting-stat prop (HR / total bases / H+R+RBI): Poisson around the
// per-game expectation, then regressed toward the market (see BATTER_SHRINK).
function priceBatterProp(prop, lambda, metric) {
  const phi = BATTER_DISPERSION[metric];
  return bestBookMarket(prop, (L) => 1 - negBinomCdf(Math.floor(L), lambda, phi), {
    shrink: BATTER_SHRINK, tiers: BATTER_TIERS, fairPool: SHARP_LABELS,
    evGate: BATTER_EV_GATE,
  });
}

// Negative-binomial CDF P(X <= k) for mean `mean` and variance-to-mean ratio
// `phi`, parameterised so r = mean / (phi - 1).
//
// Poisson forces variance == mean. Batter counting stats are not remotely that
// tight: 1,949 graded H+R+RBI outcomes measure variance/mean at 2.37 and 923
// total-bases outcomes at 2.41, because one hit delivers 1-4 bases at once
// rather than arriving as independent unit events. The cost of assuming
// otherwise is concentrated exactly where the lines sit — Poisson put P(0) 17-18
// points too low and P(over 1.5) 7-8 points too HIGH, which is what manufactured
// 1,583 over-leans against 516 unders and left projBiasByMarket at +0.2.
//
// Pooling batters of differing lambda inflates variance by itself, so this was
// checked: lambda across batters has sd ~0.3, accounting for ~0.06 of the 1.4
// excess. The dispersion is within-batter, not a mixture artefact.
//
// Computed by the standard recurrence, so r need not be an integer:
//   P(0)   = (r/(r+m))^r
//   P(k)   = P(k-1) * (r+k-1)/k * m/(r+m)
function negBinomCdf(k, mean, phi) {
  if (!(mean > 0)) return 1;
  if (!(phi > 1)) return poissonCdf(k, mean);   // no overdispersion -> Poisson
  const r = mean / (phi - 1);
  const q = mean / (r + mean);
  let term = Math.pow(r / (r + mean), r), sum = term;
  for (let i = 1; i <= k; i++) {
    term *= (r + i - 1) / i * q;
    sum += term;
  }
  return Math.min(1, sum);
}

// Poisson CDF P(X <= k) for mean lambda.
function poissonCdf(k, lambda) {
  if (!(lambda > 0)) return 1;
  let term = Math.exp(-lambda), sum = term;
  for (let i = 1; i <= k; i++) { term *= lambda / i; sum += term; }
  return Math.min(1, sum);
}

// American-odds payout multiple (decimal profit per 1u). Higher = better price.
function payoutMult(a) { return a > 0 ? a / 100 : 100 / (-a); }

// Shin de-vig for a two-way market. Multiplicative de-vig (over/(over+under))
// assumes the book's margin is spread proportionally, which systematically
// over-states the favourite. Shin instead models the margin as the book
// protecting itself against a proportion z of informed money, which pulls the
// longshot down and the favourite up — the correction is largest exactly where
// batter props live (heavy-favourite unders at -300 and worse).
//
// p_i = [sqrt(z^2 + 4(1-z)*pi_i^2/B) - z] / (2(1-z)),  chosen so sum(p_i) = 1.
// Solved by bisection on z (monotone in z over [0, 0.5)); ~40 iterations is
// exact to well past the precision anything downstream cares about.
// Returns P(over), or null if the quote isn't two-sided.
function shinDevig(overOdds, underOdds) {
  const io = amProb(overOdds), iu = amProb(underOdds);
  if (io == null || iu == null || !(io > 0) || !(iu > 0)) return null;
  const B = io + iu;
  // No overround (or a crossed/arbed quote) — nothing to strip, just normalize.
  if (!(B > 1)) return io / B;
  const p = (z) => {
    const f = (pi) => (Math.sqrt(z * z + 4 * (1 - z) * pi * pi / B) - z) / (2 * (1 - z));
    return [f(io), f(iu)];
  };
  let lo = 0, hi = 0.5;
  for (let i = 0; i < 40; i++) {
    const z = (lo + hi) / 2;
    const [a, b] = p(z);
    if (a + b > 1) lo = z; else hi = z;
  }
  const [a, b] = p((lo + hi) / 2);
  const s = a + b;
  return s > 0 ? a / s : io / B;
}

// Median of a numeric array (even length -> mean of the middle two). Used to
// pool several books' de-vigged probabilities into one robust fair number.
function median(xs) {
  const a = [...xs].sort((p, q) => p - q); const n = a.length;
  if (!n) return null;
  return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
}

// The sharp fair line for a game (2026-10-27, the owner's call: "keep it as
// sharp betting ... Pinnacle where possible"). Pikkit's sharpness rankings
// (the books the market moves toward) put Pinnacle first or second on main
// markets in every sport they rank, behind only Circa; Circa, BookMaker and
// South Point are not in The Odds API. So: Pinnacle's no-vig number when it
// quotes. Without it, the median of the rest of the pool, BetOnline and
// LowVig counted once -- one shop's two screens, which the old median let
// vote twice -- and at least minPool of them. fairs: book -> fair (a chance,
// or a three-way array). n: the sharp books that quoted.
function sharpFair(fairs, minPool = 2) {
  const n = Object.keys(fairs).length;
  if (fairs.pinnacle != null) return { fair: fairs.pinnacle, src: 'pinnacle', n };
  const pool = Object.entries(fairs).filter(([bk]) => !(bk === 'lowvig' && fairs.betonlineag != null)).map(([, f]) => f);
  if (pool.length < minPool) return { fair: null, src: 'MKT', n };
  return { fair: Array.isArray(pool[0]) ? pool[0].map((_, i) => median(pool.map((f) => f[i]))) : median(pool), src: 'sharp-pool', n };
}
// Every book's no-vig chance of a row's pick, in percent, as its book_fairs
// (JSON): the record that will say, from this site's own games, which book
// was sharpest in each sport.
// The pick'em apps quote both sides at a flat price that is no chance of
// anything: left out.
const DFS_BOOKS = new Set(['prizepicks', 'underdog', 'pick6', 'dabble_us_dfs']);
function bookFairsJson(map) {
  const out = {};
  for (const [bk, p] of Object.entries(map || {})) if (!DFS_BOOKS.has(bk) && p != null && isFinite(p)) out[bk] = Math.round(p * 1000) / 10;
  return Object.keys(out).length ? JSON.stringify(out) : null;
}

// Strikeout park factors (normalized ~1.00; >1 = more Ks). Approximate, stable
// season-level values — thin-air Coors suppresses whiffs; pitcher parks lift
// them. Keyed by home-team abbreviation.
const PARK_K_FACTOR = {
  SEA: 1.03, SD: 1.02, MIA: 1.02, ATH: 1.02, OAK: 1.02, TB: 1.01, DET: 1.01,
  NYM: 1.01, LAD: 1.01, SF: 1.01, HOU: 1.00, CLE: 1.00, PIT: 1.00, WSH: 1.00,
  MIN: 1.00, LAA: 1.00, CHC: 1.00, ATL: 1.00, MIL: 1.00, PHI: 0.99, NYY: 0.99,
  STL: 0.99, TOR: 0.99, BAL: 0.99, ARI: 0.99, AZ: 0.99, CWS: 0.99, TEX: 0.99,
  KC: 0.98, BOS: 0.98, CIN: 0.98, COL: 0.95,
};

// Weather -> strikeout multiplier. Cold, dense air breaks pitches a touch more
// (~+0.5% Ks / 10°F below 70); domes/closed roofs are climate-controlled and
// stay neutral. Capped at ±3% so it never dominates the projection.
function weatherK(wx) {
  if (!wx) return 1;
  const c = String(wx.cond || '').toLowerCase();
  if (c.includes('dome') || c.includes('roof closed')) return 1;
  const t = wx.temp;
  if (!(t > 0)) return 1;
  return clamp(1 + (70 - t) * 0.0006, 0.97, 1.03);
}

// Standard normal CDF (Abramowitz & Stegun 7.1.26 erf approximation).
// Two-sided t-test on a series of per-bet profits, asking whether the mean
// return differs from zero. Every "is this slice actually profitable" question
// on the record page runs through here — overall, per tier, per pricing era — so
// they cannot answer it three slightly different ways.
//
// Returns p:null rather than a number when the sample cannot support the test,
// which the caller must render as "not enough data" instead of "not significant".
// Those are different claims: one is silence, the other is evidence of absence.
function roiSignificance(returns) {
  const n = returns.length;
  const sum = returns.reduce((s, x) => s + x, 0);
  const mean = n ? sum / n : 0;
  if (n < 2) return { n, mean, units: sum, p: null };
  const sd = Math.sqrt(returns.reduce((s, x) => s + (x - mean) * (x - mean), 0) / (n - 1));
  // Epsilon rather than >0: an all-identical slice leaves float dust that would
  // divide out to a spuriously enormous t.
  if (!(sd > 1e-9)) return { n, mean, units: sum, p: null };
  const t = mean / (sd / Math.sqrt(n));
  return { n, mean, units: sum, t, p: Math.round(2 * (1 - normCdf(Math.abs(t))) * 1e4) / 1e4 };
}

function normCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-z * z / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
}
// American odds -> implied probability.
function amProb(odds) {
  if (typeof odds !== 'number') return null;
  return odds > 0 ? 100 / (odds + 100) : -odds / (-odds + 100);
}
// "Tarik Skubal" / "Skubal, Tarik" -> "tarik skubal" for matching.
function normName(s) {
  if (!s) return '';
  let n = String(s).toLowerCase().replace(/[.'-]/g, '').trim();
  if (n.includes(',')) { const [a, b] = n.split(','); n = (b.trim() + ' ' + a.trim()).trim(); }
  return n.replace(/\s+/g, ' ');
}

// /api/edge-debug — the decisive read on whether the model has REAL edge or just
// noise. CLV (how far the vig-free market moved toward our side) bucketed by the
// model's claimed edge is the cleanest test: real edge -> bigger claimed edges
// earn bigger CLV; noise -> CLV flat near zero regardless of claimed edge. Also
// reports signed projection bias (root of any systematic over/under lean).
async function edgeDebug(env) {
  if (!env || !env.DB) return cors(json({ error: 'env.DB not configured' }, 30));
  try {
    await ensureSchema(env.DB);
    await ensureBatterSchema(env.DB);
    const kres = await env.DB.prepare('SELECT * FROM picks').all();
    const bres = await env.DB.prepare('SELECT * FROM bpicks').all();
    const rows = [
      ...((kres.results || []).map((r) => ({ ...r, market: 'K' }))),
      ...((bres.results || []).map((r) => ({ ...r, actual_k: r.actual, market: String(r.market || '').toUpperCase() }))),
    ].filter((r) => r.result === 'win' || r.result === 'loss');

    // CLV in probability points, only when the line didn't move (comparable).
    const clvOf = (r) => {
      if (r.close_over == null || r.entry_over == null) return null;
      if (r.close_line != null && r.line != null && r.close_line !== r.line) return null;
      return (r.side === 'Over' ? (r.close_over - r.entry_over) : (r.entry_over - r.close_over)) * 100;
    };
    const summarize = (arr) => {
      const n = arr.length; if (!n) return { n: 0 };
      let w = 0, u = 0, clvSum = 0, clvN = 0;
      for (const r of arr) {
        if (r.result === 'win') w++;
        u += profitUnits(r.result, r.price);
        const c = clvOf(r); if (c != null) { clvSum += c; clvN++; }
      }
      return { n, record: `${w}-${n - w}`, winRate: round1(w / n * 100), roi: round1(u / n * 100), avgCLV: clvN ? round1(clvSum / clvN) : null, clvN };
    };

    // Signed projection bias (K): +value => model projects too HIGH (over-lean root).
    let biasSum = 0, biasN = 0;
    for (const r of rows) if (r.market === 'K' && r.proj != null && r.actual_k != null) { biasSum += (r.proj - r.actual_k); biasN++; }

    const BINS = [[0, 2], [2, 4], [4, 6], [6, 8], [8, 999]];
    const byEdge = (subset) => BINS.map(([lo, hi]) => ({ edge: `${lo}-${hi === 999 ? '+' : hi}`, ...summarize(subset.filter((r) => r.edge != null && r.edge >= lo && r.edge < hi)) }));
    const markets = [...new Set(rows.map((r) => r.market))];
    const overUnder = {};
    for (const m of markets) overUnder[m] = { Over: summarize(rows.filter((r) => r.market === m && r.side === 'Over')), Under: summarize(rows.filter((r) => r.market === m && r.side === 'Under')) };

    // Hits-allowed projection accuracy. Not a betting record — there is no line
    // and no side — so it reports error, not ROI. This is the number that decides
    // whether the market is worth buying lines for at all.
    let hitsProj = { n: 0, note: 'no graded hits projections yet' };
    try {
      await ensureProjLogSchema(env.DB);
      const hr = (await env.DB.prepare(
        "SELECT proj, actual FROM proj_log WHERE market='H' AND actual IS NOT NULL"
      ).all()).results || [];
      // Rows written but not yet graded. Reported separately because n=0 has two
      // very different causes — nothing projected yet (broken write path) versus
      // nothing final yet (working, just early) — and without this the endpoint
      // cannot tell them apart. Grading only runs on slate dates before today,
      // so a full slate sits pending until the Pacific date rolls over.
      const pend = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM proj_log WHERE market='H' AND actual IS NULL"
      ).first();
      const pending = (pend && pend.n) || 0;
      if (!hr.length) {
        hitsProj = pending
          ? { n: 0, pending, note: `${pending} projections logged, none graded yet — grading runs once the slate date rolls over` }
          : { n: 0, pending: 0, note: 'no hits projections logged yet' };
      }
      if (hr.length) {
        const n = hr.length;
        const mp = hr.reduce((s, r) => s + r.proj, 0) / n;
        const ma = hr.reduce((s, r) => s + r.actual, 0) / n;
        const mae = hr.reduce((s, r) => s + Math.abs(r.proj - r.actual), 0) / n;
        const varA = hr.reduce((s, r) => s + (r.actual - ma) ** 2, 0) / n;
        hitsProj = {
          n, pending, meanProj: round2(mp), meanActual: round2(ma),
          bias: round2(mp - ma), mae: round2(mae),
          dispersion: ma > 0 ? round2(varA / ma) : null,
          // Out-of-sample, unlike the constants: these rows were projected before
          // the game and graded after, so a bias here is real and H_PROJ_CAL
          // should be refit against it rather than against the fitted sample.
          read: 'bias>0 = projections run high. Compare dispersion with HITS_DISPERSION (1.21) and refit if it has drifted.',
        };
      }
    } catch (e) { hitsProj = { n: 0, error: String(e && e.message || e) }; }

    return cors(json({
      n: rows.length,
      projBiasK: biasN ? round1(biasSum / biasN) : null,
      hitsProj,
      overallCLV: summarize(rows).avgCLV,
      edgeBuckets_all: byEdge(rows),
      edgeBuckets_K: byEdge(rows.filter((r) => r.market === 'K')),
      overUnderByMarket: overUnder,
      read: 'avgCLV should RISE with the edge bucket if the edge is real; flat/near-0 means the claimed edges are noise. projBiasK>0 = projections run high.',
    }, 30));
  } catch (e) { return cors(json({ error: String(e && e.message || e) }, 30)); }
}

// /api/batter-debug — pressure-tests the one signal edge-debug surfaced: batter
// counting-stat UNDERS are profitable. Real edge survives slicing; a fluke
// doesn't. By month = is it stable or one hot stretch? By price = do we win at
// prices that actually pay, or only expensive -150 unders? By market = which
// props carry it. Cumulative = the trajectory.
// /api/bpicks-export?market=hrr&ver=sharp-shin-nb-evgate — graded batter rows,
// compact, for replaying the model offline. batter-debug answers questions it
// was written to answer; a calibration backtest needs the rows themselves: the
// projection, line, fair, price and result that decided each pick, so a changed
// constant can be re-applied through the same probability and EV gate and the
// picks it would have kept or dropped scored against what actually happened.
//
// Read-only, graded rows only, and filtered in SQL so an export of one market
// and one model version does not ship the whole table. Columns are positional
// to keep the payload small; `cols` names them.
// GET /api/pppicks-export — the PrizePicks log, row by row. buildPpRecord only
// reports bands; a question like "why are the strikeout unders losing" needs the
// rows themselves (the number, the model's claim, what the pitcher actually did)
// and this is cheaper than a deploy each time one comes up.
async function ppExport(env, url) {
  if (!env || !env.DB) return cors(json({ error: 'env.DB not configured' }, 30));
  try {
    await ensurePpSchema(env.DB);
    // Batter markets are stored lowercase and strikeouts as 'K', so match
    // without case: ?market=K and ?market=k both have to find the 41 K rows
    // rather than silently returning none, which reads as "nothing logged".
    const market = (url.searchParams.get('market') || '').trim();
    const cols = ['date', 'player', 'team', 'market', 'point', 'model_under', 'close_point', 'close_model_under', 'actual', 'result', 'game_id', 'player_id', 'model_ver'];
    const rows = (await env.DB.prepare(
      `SELECT ${cols.join(', ')} FROM pppicks${market ? ' WHERE market = ? COLLATE NOCASE' : ''} ORDER BY date, player`
    ).bind(...(market ? [market] : [])).all()).results || [];
    return cors(json({ market: market || 'all', n: rows.length, cols, rows: rows.map((r) => cols.map((c) => r[c])) }, 600));
  } catch (e) {
    return cors(json({ error: String((e && e.message) || e) }, 30));
  }
}

// GET /api/gmpicks-export — the NFL and soccer game-line log, row by row.
// ?sport=nfl|soccer, ?league=epl|laliga|ucl|REG|PRE. The record reports totals;
// the questions worth asking of it ("are the draws the losing side", "is one
// league carrying the whole thing") need the rows.
async function gmExport(env, url) {
  if (!env || !env.DB) return cors(json({ error: 'env.DB not configured' }, 30));
  try {
    await ensureGamePickSchema(env.DB);
    const sport = (url.searchParams.get('sport') || '').trim();
    const league = (url.searchParams.get('league') || '').trim();
    const market = (url.searchParams.get('market') || '').trim();
    const where = [], args = [];
    if (sport) { where.push('sport = ? COLLATE NOCASE'); args.push(sport); }
    if (league) { where.push('league = ? COLLATE NOCASE'); args.push(league); }
    if (market) { where.push('market = ? COLLATE NOCASE'); args.push(market); }
    const cols = ['sport', 'date', 'market', 'league', 'week', 'commence', 'away', 'home', 'side', 'point', 'pick', 'win_prob', 'implied', 'edge',
      'entry_price', 'close_price', 'book', 'fair_src', 'sharp_n', 'result', 'away_score', 'home_score', 'game_id', 'model_ver',
      'entry_win_prob', 'entry_edge', 'entry_at', 'close_at'];
    const rows = (await env.DB.prepare(
      `SELECT ${cols.join(', ')} FROM gmpicks${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY date, commence`
    ).bind(...args).all()).results || [];
    return cors(json({ sport: sport || 'all', league: league || 'all', n: rows.length, cols,
      rows: rows.map((r) => cols.map((c) => r[c])) }, 600));
  } catch (e) {
    return cors(json({ error: String((e && e.message) || e) }, 30));
  }
}

// GET /api/top-legs — does ranking by confidence beat taking one of everything?
//
// The finding this exists to test, on three days of PrizePicks legs: split by
// market, nothing clears a break-even (H+R+RBI 53.7%, total bases 52.4%,
// strikeouts 39.6%, everything 51.5%). Ranked by the model's own probability and
// pooled across markets, the top three legs of a day ran 77.8% and the top
// twelve 61.1%. If that holds it says the market label is not what separates a
// winning leg from a losing one, and an entry should be built from the best legs
// of the day whatever market they come from.
//
// Nine legs is not a finding, it is a hypothesis. This is the instrument, not
// the answer: read-only, computed from rows already logged, so it applies to
// every row already in the table and to every row added from here.
//
// The three sports are NOT the same experiment, and the payload says so:
//   mlb     ranks by the model's probability that the under lands. A model claim.
//   soccer  ranks by the gap to the sharp pool's fair line. No model exists for
//   nfl     soccer or NFL game lines, so this tests whether disagreeing with the
//           sharp number predicts anything — a different question with a
//           different failure mode.
//   nflptd  ranks by the gap to the realised 55.4% under rate.
// The model-chance levels the Today's card reports a record for.
const TOP_LEG_LEVELS = [[0, 50], [50, 55], [55, 60], [60, 65], [65, 70], [70, 75], [75, 101]];
const TOP_LEG_BANDS = [3, 5, 8, 12];

function topLegScore(sport, r) {
  if (sport === 'mlb') {
    // The probability claimed at the close where there is one, since that is the
    // number the leg was actually offered at.
    const p = r.close_model_under != null ? r.close_model_under : r.model_under;
    return p == null ? null : p;
  }
  // Everything else ranks on the gap between the fair line and the price taken.
  return r.edge == null ? null : r.edge;
}
function topLegWon(sport, r) {
  if (sport === 'mlb') return r.result === 'under' ? 1 : (r.result === 'over' ? 0 : null);
  return r.result === 'win' ? 1 : (r.result === 'loss' ? 0 : null);
}

// Posted batting orders for a day, by game: { g<pk>: { <abbr>: Set(ids) } }, a
// club present only once its card is up. One StatsAPI read, no odds credit.
// null when the read fails, so a caller can say it could not check.
async function postedLineups(ymd) {
  const s = await mlbDaySlate(ymd);
  return s ? s.cards : null;
}
// One StatsAPI read for a day: each game's first pitch, state and clubs, and
// the posted cards in postedLineups' shape. null when the read fails.
async function mlbDaySlate(ymd) {
  try {
    const r = await fetch(`${STATS}/schedule?sportId=1&date=${ymd}&hydrate=team,lineups`, { headers: { accept: 'application/json' } });
    if (!r.ok) return null;
    const games = {}, cards = {};
    for (const g of ((((await r.json()).dates || [])[0] || {}).games || [])) {
      const lp = g.lineups || {}, sides = {};
      for (const [k, side] of [['awayPlayers', 'away'], ['homePlayers', 'home']]) {
        const arr = lp[k] || [];
        if (arr.length) sides[teamAbbr(g.teams[side].team)] = new Set(arr.map((p) => p && p.id));
      }
      cards['g' + g.gamePk] = sides;
      games['g' + g.gamePk] = {
        commence: g.gameDate || null, status: (g.status && g.status.abstractGameState) || 'Preview',
        away: teamAbbr(g.teams.away.team), home: teamAbbr(g.teams.home.team),
      };
    }
    return { games, cards };
  } catch (e) { return null; }
}
// 'in', 'out' (his club's card is up and he is not on it), or null (no card yet,
// or a pitcher's leg, which a batting order says nothing about).
function lineupStatus(cards, r) {
  if (!cards || r.market === 'K') return null;
  const sides = cards[r.game_id];
  if (!sides) return null;
  const mine = sides[r.team];
  if (mine) return mine.has(r.player_id) ? 'in' : 'out';
  // His club's abbreviation did not match either card. With both cards up he
  // is still placeable: on neither means he is not starting.
  const all = Object.values(sides);
  if (all.some((s) => s.has(r.player_id))) return 'in';
  return all.length === 2 ? 'out' : null;
}

async function topLegs(env, url) {
  const blank = () => ({
    note: 'LOGGED ONLY, nothing posted and nothing shown on the site. Ranks every leg already logged '
      + 'by confidence, pools them across markets, and reports how the best N of each day actually did.',
    rankedBy: null, sport: null, bands: {}, byDay: [], today: [],
    breakEvens: { '6-pick flex': 54.2, '5-pick flex': 54.3, '4-pick flex': 56.9, '3-pick flex': 59.1, '2-pick power': 57.7 },
  });
  let out = blank();
  if (!env || !env.DB) { out.error = 'no DB binding'; return cors(json(out, 300)); }
  const sport = (url.searchParams.get('sport') || 'mlb').toLowerCase();
  out.sport = sport;
  try {
    // The page reads MLB's every ten minutes. Kept until pppicks is written or
    // the day turns (recordCached), on a day none of today's legs needed the
    // lineups -- from the end of the World Series until spring.
    if (sport === 'mlb') {
      out = await recordCached(env, 'top-legs-mlb', async () => {
        const o = blank();
        o.sport = sport;
        return { data: o, complete: !(await topLegsFill(env, sport, o)) };
      }, slateDate());
    } else await topLegsFill(env, sport, out);
  } catch (e) { out.error = String((e && e.message) || e); }
  return cors(json(out, 300));
}
// Fills out; true when it read the posted lineups for today's legs.
async function topLegsFill(env, sport, out) {
  let lineups = false;
  let rows = [];
  if (sport === 'mlb') {
    await ensurePpSchema(env.DB);
    rows = ((await env.DB.prepare('SELECT * FROM pppicks').all()).results) || [];
    out.rankedBy = "the model's probability that the under lands (a model claim)";
    out.source = 'pppicks — PrizePicks lines at their own number';
  } else {
    await ensureGamePickSchema(env.DB);
    const want = sport === 'nflptd' ? 'nflptd' : sport;
    rows = (((await env.DB.prepare('SELECT * FROM gmpicks WHERE sport = ?').bind(want).all()).results) || [])
      .filter((r) => r.market !== 'fav');
    if (want === 'nflptd') rows = dedupePassTds(rows);   // the ranking is per day
    out.rankedBy = sport === 'nflptd'
      ? 'the gap between the best price and the realised 55.4% under rate'
      : "the gap between the sharp pool's fair line and the best price (no model exists here)";
    out.source = `gmpicks, sport='${want}'`;
  }
  out.logged = rows.length;

  const scored = rows.map((r) => ({ r, s: topLegScore(sport, r), w: topLegWon(sport, r) }))
    .filter((x) => x.s != null);
  const graded = scored.filter((x) => x.w != null);
  out.graded = graded.length;
  // How legs at each level of the model's chance have actually landed at
  // PrizePicks' numbers -- the card prints the one each leg falls in
  // (2026-10-11). This is the calibration, kept live rather than fitted:
  // batter legs the model put anywhere under 65% landed about 50%, so a
  // fitted map would mostly invent precision the top buckets do not have.
  // Batter legs (TB, H+R+RBI) and strikeouts are kept apart; they did not
  // behave alike.
  if (sport === 'mlb') {
    out.legBands = {};
    for (const [g, f] of [['batter', (x) => x.r.market !== 'K'], ['K', (x) => x.r.market === 'K']]) {
      out.legBands[g] = TOP_LEG_LEVELS.map(([lo, hi]) => {
        const b = graded.filter((x) => f(x) && x.s >= lo && x.s < hi);
        const hit = b.filter((x) => x.w === 1).length;
        return { lo, hi: hi > 100 ? null : hi, n: b.length, hit, hitRate: b.length ? round1(hit / b.length * 100) : null };
      });
    }
  }

  // Per day, best first.
  const days = new Map();
  for (const x of graded) {
    if (!days.has(x.r.date)) days.set(x.r.date, []);
    days.get(x.r.date).push(x);
  }
  for (const [, list] of days) list.sort((a, b) => b.s - a.s);

  const band = (n) => {
    let w = 0, tot = 0;
    for (const [, list] of days) {
      for (const x of list.slice(0, n)) { w += x.w; tot++; }
    }
    return { n: tot, hit: w, hitRate: tot ? round1(w / tot * 100) : null };
  };
  for (const n of TOP_LEG_BANDS) out.bands['top ' + n] = band(n);
  out.bands.everything = band(1e9);
  // The bands above rank only legs that played: a leg voided because the
  // player sat is dropped and the next one moves up, which nobody building
  // before lineups could have done. `voided` counts how many of each day's
  // top N, ranked over every settled leg, never played -- out of `slots`.
  const settledDays = new Map();
  for (const x of scored) {
    if (x.r.result == null) continue;
    if (!settledDays.has(x.r.date)) settledDays.set(x.r.date, []);
    settledDays.get(x.r.date).push(x);
  }
  for (const [, list] of settledDays) list.sort((a, b) => b.s - a.s);
  const voidsIn = (n) => {
    let v = 0, t = 0;
    for (const [, list] of settledDays) for (const x of list.slice(0, n)) { t++; if (x.r.result === 'void') v++; }
    return { voided: v, slots: t, voidRate: t ? round1(v / t * 100) : null };
  };
  for (const n of TOP_LEG_BANDS) Object.assign(out.bands['top ' + n], voidsIn(n));
  Object.assign(out.bands.everything, voidsIn(1e9));
  // The point of the exercise: how many of the entry break-evens each band clears.
  for (const k of Object.keys(out.bands)) {
    const hr = out.bands[k].hitRate;
    out.bands[k].clears = hr == null ? null
      : Object.entries(out.breakEvens).filter(([, be]) => hr >= be).map(([name]) => name);
  }

  const label = (r) => (sport === 'mlb'
    ? `${r.player} ${r.market} u${r.point}`
    : `${r.pick}${r.point != null ? ' ' + r.point : ''} (${r.away} @ ${r.home})`);
  for (const [date, list] of [...days.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    out.byDay.push({
      date, legs: list.length,
      top: list.slice(0, 5).map((x) => ({ leg: label(x.r), score: x.s, result: x.r.result })),
      topHit: list.slice(0, 3).filter((x) => x.w === 1).length,
    });
  }

  // What it would take today, ungraded — so the idea can be watched forward
  // rather than only backwards.
  const todayYmd = slateDate();
  let todayAll = scored.filter((x) => x.r.date === todayYmd && x.w == null)
    .sort((a, b) => b.s - a.s);
  // A leg is logged while its player is listed, often before the card posts,
  // and stays here after he is benched: the books pull his props, he drops off
  // the batter board, and the board's scratch flag never sees him. Pham,
  // 2026-10-07, sat at 80% atop this list a few minutes before first pitch,
  // benched, and was voided. The posted cards are checked here instead, and a
  // benched leg leaves the list so the next one moves up.
  let cards = null;
  if (sport === 'mlb' && todayAll.length) {
    lineups = true;
    cards = await postedLineups(todayYmd);
    out.lineupCheck = cards ? 'checked against posted lineups' : 'lineups unavailable, not checked';
    for (const x of todayAll) x.lineup = lineupStatus(cards, x.r);
    const benched = todayAll.filter((x) => x.lineup === 'out');
    if (benched.length) out.todayBenched = benched.map((x) => ({ leg: label(x.r), score: x.s, team: x.r.team || null }));
    todayAll = todayAll.filter((x) => x.lineup !== 'out');
  }
  const todayList = todayAll.slice(0, 8);
  // Legs from one game tend to land or miss together, which a PrizePicks entry
  // pays for all at once. sameGame counts the legs in THIS list that share the
  // leg's game, so a check can warn without knowing anything about the slate.
  // Passing-TD rows key on "event|player" so both quarterbacks of a game can
  // be logged; the game is the part before the bar.
  const gameOf = (r) => (r.game_id ? String(r.game_id).split('|')[0] : null);
  const perGame = {};
  for (const x of todayList) { const k = gameOf(x.r); if (k) perGame[k] = (perGame[k] || 0) + 1; }
  out.today = todayList.map((x) => ({
    leg: label(x.r), score: x.s,
    team: x.r.team || null, game: gameOf(x.r),
    sameGame: gameOf(x.r) ? perGame[gameOf(x.r)] : 1,
    ...(sport === 'mlb' ? { lineup: x.lineup || (x.r.market === 'K' ? 'pitcher' : (cards ? 'not posted' : 'unchecked')) } : {}),
  }));
  if (!out.today.length) out.todayNote = `nothing ungraded logged for ${todayYmd} yet`;
  return lineups;
}

// ---------------------------------------------------------------------------
// /api/picks — Picks of the day (2026-10-09)
// ---------------------------------------------------------------------------
// The legs most likely to land, across sports, one per game. PrizePicks pays
// the same multiplier on every leg of an entry, moneylines included (the user,
// 2026-10-09), so for a PrizePicks entry the chance a leg lands is the whole
// question. At DraftKings it is not -- a -400 favourite lands 80% of the time
// and still loses money -- which is why this is a PrizePicks list.
//
// Only kinds of leg whose stated chance held up in the logs get in, at the bar
// where it held up (claimed vs realised, through 2026-10-08):
//   MLB moneyline favourites at 65%+: 52 of 76 (68%) against 69% claimed. Over
//     all 878 games the site's win chance was 57.2% realised vs 57.0% claimed.
//   MLB PrizePicks unders at 70%+: 19 of 25 (76%). Below 70 the model ran 5-10
//     points hot (60-65%: 55 of 109), and strikeout unders hit 49%: both out.
//   NBA and soccer favourites at 65%+, NFL's at 75%+ (from 2026-10-26), and
//   NBA PrizePicks unders at 70%+:
//     in, each with its own record beside it. The sharp line is the best
//     number there is and the NBA model held up on last season's games, but
//     none has PICKS_PROVEN_N graded legs at its bar yet. NBA preseason is out:
//     its favourites sat their starters (11 of 23 against 63% claimed).
//   NBA blocks and steals unders (logged from 2026-10-20): out until they have
//     a graded record of their own (NBA_PICK_MARKETS). NBA rebounds unders, and
//     any NBA leg under a PrizePicks line below the books': out from 2026-10-23
//     on their first three nights at PrizePicks' lines (50% and 45%).
// Every leg comes from a log the site already keeps and grades, so the list
// reads no odds and spends no credit. It keeps a record of its own: a leg on
// the list when its game starts is logged in daypicks and graded from the log
// it came from.
const PICKS_N = 6;                       // the largest PrizePicks entry
const PICKS_WINDOW_MS = 24 * 3600e3;     // games starting in the next day
const PICKS_PROVEN_N = 30;
const PICK_KINDS = {
  mlb_ml: { sport: 'mlb', label: 'MLB moneyline favourite', min: 65 },
  mlb_pp: { sport: 'mlb', label: 'MLB PrizePicks under (TB, H+R+RBI)', min: 70 },
  nba_ml: { sport: 'nba', label: 'NBA moneyline favourite', min: 65 },
  nba_pp: { sport: 'nba', label: 'NBA PrizePicks under (3PM, AST; PP line not below the book)', min: 70 },
  // PrizePicks Mores from 2026-10-28, the owner's call: the two markets whose
  // More side had landed where the model leaned More -- NBA blocks 17 of 24
  // and NHL points and assists 20 of 29 at 55%+ through Oct 27 (the cards'
  // blkMore and more records). PrizePicks legs, so they widen its entries.
  nba_blk_more: { sport: 'nba', label: 'NBA blocks More (PrizePicks)', min: 55 },
  // NFL at 75%+ from 2026-10-26, on the owner's call ("too many losses"):
  // through Week 7 the log's favourites at 75%+ won 11 of 14 (78.5% stated)
  // and those at 65-75% 6 of 12 (about 70% stated) -- the Texans at 80.9% and
  // the Jets at 65.6% both lost on Oct 25.
  nfl_ml: { sport: 'nfl', label: 'NFL moneyline favourite', min: 75 },
  // NFL passing-TD unders at 60%+ from 2026-10-27, the owner's call: the
  // sharp books' chance of under 1.5 (passTdEntries), whose 60%+ legs landed
  // 26 of 37 through Week 7 (62-67% stated; 60-65% went 20 of 24, 65%+ 6 of
  // 13). The chance is at the books' 1.5, so a leg is listed only while
  // PrizePicks has the same 1.5 up, or has not posted the player yet.
  nfl_ptd: { sport: 'nfl', label: 'NFL passing TDs under 1.5 (sharp books)', min: 60 },
  // NHL since 2026-10-22, on the owner's call after last season's backtest:
  // 2025-26 favourites the sharp books made 65%+ won 114 of 171 (66.7%,
  // stated 69.1%), from /api/hist-backtest?job=nhl. Overtime and the shootout
  // count, as in the price.
  nhl_ml: { sport: 'nhl', label: 'NHL moneyline favourite', min: 65 },
  nhl_more: { sport: 'nhl', label: 'NHL points/assists More (PrizePicks)', min: 55 },
  soccer_fav: { sport: 'soccer', label: 'Soccer favourite to win', min: 65 },
};
// ---- Edge and stake (2026-10-27, the owner's call: quarter Kelly) -----------
// Edge is where the chance and the price meet: EV = p x decimal - 1, so +110
// against a fair +100 is 0.5 x 2.10 - 1 = +5%. The stake is Kelly's, the edge
// over the net odds (+110 at 50%: 0.05 / 1.10 = 4.5% of the bankroll), taken at
// a quarter: the chance is an estimate, and full Kelly on an over-stated one
// is how a bankroll goes. The chance Kelly is fed is the leg's stated one,
// never above it, pulled toward its kind's own record with KELLY_PRIOR_N legs
// of weight on the stated chance -- NBA PrizePicks unders stated 70%+ had
// landed 60% by Oct 27, the NHL's 65%+ favourites 43%. betAt is the price
// that chance breaks even at: anything better is a bet, at any book, Circa
// and South Point included.
const KELLY_FRACTION = 0.25;
const KELLY_PRIOR_N = 20;
// Props smaller still (2026-10-27): Kelly overstates a prop's edge -- thin
// markets, and books limit the bettors who beat them (Unabated, "Profitable
// Prop Betting in 3 Easy Steps") -- so a prop stakes at most PROP_STAKE_CAP%
// of the bankroll and a pick'em entry ENTRY_STAKE_CAP%, whatever Kelly says.
// The first PrizePicks entry priced this way asked 5.4% on two model unders.
const PROP_STAKE_CAP = 1;
const ENTRY_STAKE_CAP = 2;
const PROP_KINDS = new Set(['mlb_pp', 'nba_pp', 'nba_blk_more', 'nhl_more', 'nfl_ptd']);
const capStake = (s, cap) => (cap != null && s > cap ? { stake: cap, capped: true } : { stake: s });
const decOf = (am) => (am > 0 ? 1 + am / 100 : 1 + 100 / -am);
const amOfChance = (p) => (p >= 0.5 ? -Math.round(p / (1 - p) * 100) : Math.round((1 - p) / p * 100));
function kellyChance(p, rec) {             // p and the result in %; rec { n, hit }
  if (p == null) return null;
  if (!rec || !rec.n) return p;
  return Math.min(p, (rec.hit * 100 + KELLY_PRIOR_N * p) / (rec.n + KELLY_PRIOR_N));
}
function legStake(p, price, rec, cap = null) {
  const pk = kellyChance(p, rec);
  if (pk == null || !(pk > 0 && pk < 100)) return {};
  const out = { kellyP: round1(pk), betAt: amOfChance(pk / 100) };
  if (typeof price !== 'number') return out;
  const d = decOf(price), ev = pk / 100 * d - 1;
  out.ev = round1(ev * 100);
  Object.assign(out, capStake(ev > 0 ? round1(ev / (d - 1) * KELLY_FRACTION * 100) : 0, cap));
  return out;
}
// A PrizePicks entry the same way: each leg's Kelly chance, the chance of
// each count landing (Poisson-binomial), PrizePicks' payout for each, and the
// stake that maximises the expected log of the bankroll -- Kelly for an entry
// with several outcomes -- at a quarter.
function entryStake(ps, type) {              // ps: chances 0-1
  const n = ps.length;
  let dist = [1];
  for (const p of ps) { const nx = new Array(dist.length + 1).fill(0); dist.forEach((v, k) => { nx[k] += v * (1 - p); nx[k + 1] += v * p; }); dist = nx; }
  const pay = (k) => (type === 'power' ? (k === n ? PP_POWER[n] || 0 : 0) : ((PP_FLEX[n] || {})[k] || 0));
  const ev = dist.reduce((s, v, k) => s + v * pay(k), 0) - 1;
  if (!(ev > 0)) return { ev: round1(ev * 100), stake: 0 };
  const growth = (f) => dist.reduce((s, v, k) => s + (v > 0 ? v * Math.log(Math.max(1e-12, 1 + f * (pay(k) - 1))) : 0), 0);
  let lo = 0, hi = 0.999;
  for (let i = 0; i < 100; i++) { const a = lo + (hi - lo) / 3, b = hi - (hi - lo) / 3; if (growth(a) < growth(b)) lo = a; else hi = b; }
  return { ev: round1(ev * 100), ...capStake(round1((lo + hi) / 2 * KELLY_FRACTION * 100), ENTRY_STAKE_CAP) };
}
// The kinds PrizePicks takes in an entry (2026-10-27): its player picks. Of
// the list's moneylines it takes only the NFL's, as a team pick ("game
// winner"), one an entry. The NBA, NHL, soccer and MLB moneylines are
// sportsbook bets; priced at PrizePicks' payouts they made a 2-pick Power read
// +62% and stake 7.8% of a bankroll, on an entry that could not be placed.
const PP_ENTRY_KINDS = new Set(['mlb_pp', 'nba_pp', 'nba_blk_more', 'nhl_more', 'nfl_ptd']);

// ---- Bets with an edge (2026-10-27) -------------------------------------------
// The list ranks by how likely a leg is to land; sharp betting asks where a
// price beats the sharp line. Every side the logs hold a fair and a best price
// for, starting in the next day: both sides of each NBA and NHL game (the
// boards' snapshots); the NFL and soccer sides the boards logged (the
// favourite, the best-value 1X2 side, the goals total); every passing-TD
// under; and NBA threes and assists unders where PrizePicks' line is the
// book's, so the sharp chance is at the line the price is for. The edge is EV
// at the best price on the sharp chance itself -- there is no record to pull
// it toward -- and the stake a quarter of Kelly's. Game lines need +1.5% and
// props +3%: the fair line is an estimate too, and props' holds are wider.
// Nothing is bought: snapshots and logs only. asOf says how old each price is.
const EV_MIN_LINE = 1.5;
const EV_MIN_PROP = 3;
const EV_MAX = 12;
// Further out than the list's day: an early price is often the better one,
// and the moneyline captures read 36 hours ahead.
const EV_WINDOW_MS = 36 * 3600e3;
// How far behind its league's latest read a row's may be and still be that
// read's: one capture writes its rows within a second or two.
const GM_READ_SLACK_MS = 30 * 60e3;
// evScan keeps every side it priced (all), as well as those past the bar
// (bets): the edge-bet log reads each logged bet's closing price and fair
// from all (2026-10-28). Each side carries how it grades (grade).
const evShown = (b) => { const { key, grade, league, ...rest } = b; return rest; };
async function evBets(env, now) { return (await evScan(env, now)).bets.map(evShown); }
async function evScan(env, now) {
  const out = [], all = [];
  const seen = new Set();
  const add = (o) => {
    const t = Date.parse(o.commence);
    if (!(t > now && t - now <= EV_WINDOW_MS) || o.fair == null || typeof o.price !== 'number' || seen.has(o.key)) return;
    const p = o.fair / 100;
    if (!(p > 0 && p < 1) || !mlPriceSane(o.price, o.fair)) return;
    seen.add(o.key);
    all.push(o);
    const d = decOf(o.price), ev = p * d - 1;
    if (ev * 100 < (o.prop ? EV_MIN_PROP : EV_MIN_LINE)) return;
    out.push({ ...o, fair: round1(o.fair), ev: round1(ev * 100), ...capStake(round1(ev / (d - 1) * KELLY_FRACTION * 100), o.prop ? PROP_STAKE_CAP : null), betAt: amOfChance(p) });
  };
  // NBA and NHL: both sides of every game, as the last capture priced them.
  for (const sport of ['nba', 'nhl']) {
    const hit = await loadFeedCache(env.DB, `${sport}_board:reg`).catch(() => null);
    const snap = hit && hit.present ? hit.data : null;
    const nick = sport === 'nhl' ? nhlNick : lastWord;
    for (const g of (snap && snap.games) || []) {
      if (!g.fairSrc || g.fairSrc === 'MKT') continue;
      const sub = `${nick(g.away)} @ ${nick(g.home)}`;
      for (const [side, team, fair, price, book] of [['home', g.home, g.homeFair, g.homePrice, g.homeBook], ['away', g.away, g.awayFair, g.awayPrice, g.awayBook]]) {
        add({ key: `${sport}:${g.id}:${side}`, sport, market: 'ml', label: `${nick(team)} ML`, sub, commence: g.commence,
          fair, price, book, fairSrc: g.fairSrc, asOf: snap.asOf, league: 'reg', grade: { t: 'side', sport, game_id: g.id, side } });
      }
    }
  }
  // The NFL, passing TDs and soccer: the sides the boards logged, at their latest read.
  const days = [ptDateOf(now), ptDateOf(now + 86400e3), ptDateOf(now + 2 * 86400e3)];
  const gm = (await env.DB.prepare("SELECT * FROM gmpicks WHERE sport IN ('nfl','nflptd','soccer') AND date IN (?, ?, ?) AND result IS NULL").bind(...days).all()).results || [];
  // A row's price refreshes only while its side is still the board's lead
  // (logGamePicks), so a side that lost the lead keeps the price of the read
  // that last had it: on Oct 28 FC Cincinnati's +410 was from Oct 27 at 5 AM
  // while the rest of the MLS had been read at 12:20 PM. A side its league's
  // latest read did not refresh is not priced now, and is left off.
  const readAt = (r) => r.close_at || r.entry_at || '';
  const latest = new Map();
  for (const r of gm) { const k = `${r.sport}:${r.league}`; if (readAt(r) > (latest.get(k) || '')) latest.set(k, readAt(r)); }
  const current = (r) => Date.parse(readAt(r)) >= Date.parse(latest.get(`${r.sport}:${r.league}`)) - GM_READ_SLACK_MS;
  for (const r of gm) {
    if (!current(r)) continue;
    const base = { commence: r.commence, fair: r.win_prob, price: r.close_price != null ? r.close_price : r.entry_price, book: r.book, fairSrc: r.fair_src, asOf: r.close_at || r.entry_at };
    if (r.sport === 'nfl' && r.market === 'h2h') {
      add({ ...base, key: `nfl:${r.game_id}:${r.pick}`, sport: 'nfl', market: 'ml', label: `${r.pick} ML`, sub: `${r.away} @ ${r.home}`, grade: gmGrade(r) });
    } else if (r.sport === 'nflptd') {
      const [, player] = String(r.game_id).split('|');
      add({ ...base, key: `ptd:${r.game_id}`, sport: 'nfl', market: 'pass_tds', prop: true, label: `${player} Under ${r.point} Pass TDs`,
        sub: `${NFL_ABBR[r.away] || r.away} @ ${NFL_ABBR[r.home] || r.home}`, grade: gmGrade(r) });
    } else if (r.sport === 'soccer') {
      const league = (SOCCER_LEAGUES[r.league] && SOCCER_LEAGUES[r.league].label) || r.league || '';
      const label = r.market === 'totals' ? `${r.pick} goals` : r.side === 'draw' ? 'Draw' : `${r.pick} ML`;
      add({ ...base, key: `soc:${r.game_id}:${r.market === 'totals' ? 'tot' : 'res'}:${r.pick}`, sport: 'soccer', market: r.market === 'totals' ? 'totals' : 'ml',
        label, sub: `${r.away} @ ${r.home}${league ? ' · ' + league : ''}`, league: r.league, grade: gmGrade(r) });
    }
  }
  // NBA unders at the book's own line, where the sharp books priced him.
  const np = (await env.DB.prepare(`SELECT * FROM nbapp WHERE date IN (?, ?, ?) AND result IS NULL AND sharp_under IS NOT NULL AND market IN (${NBA_PICK_MARKETS.map(() => '?').join(',')})`)
    .bind(...days, ...NBA_PICK_MARKETS).all()).results || [];
  for (const row of ppStanding(np)) {
    const r = ppCurrent(row);
    if (r.book_line == null || r.book_line !== r.point || typeof r.book_under !== 'number' || r.sharp_under == null) continue;
    add({ key: `nbapp:${r.game_id}:${r.player}:${r.market}`, sport: 'nba', market: r.market, prop: true,
      label: `${r.player} Under ${r.point} ${PICKS_NBA_MK[r.market] || r.market}`, sub: `${lastWord(r.away)} @ ${lastWord(r.home)}`,
      commence: r.commence, fair: r.sharp_under, price: r.book_under, book: 'DK/FD', fairSrc: 'sharp books', asOf: r.close_at || r.captured_at,
      grade: { t: 'under', date: r.date, game_id: r.game_id, player: r.player, market: r.market, line: r.point } });
  }
  return { bets: out.sort((a, b) => b.ev - a.ev).slice(0, EV_MAX), all };
}
// How a side from the game-line log grades: a moneyline or 1X2 side by the
// game's final (the row's own pick can flip before the start), a goals total
// by the score, a passing-TD under as its row does.
const gmGrade = (r) => (r.market === 'h2h' || r.market === 'fav' ? { t: 'side', sport: r.sport, game_id: r.game_id, side: r.side }
  : r.market === 'totals' ? { t: 'total', sport: r.sport, game_id: r.game_id, over: /^over/i.test(String(r.side || r.pick || '')), point: r.point }
    : { t: 'row', sport: r.sport, game_id: r.game_id, market: r.market, pick: r.pick });

// ---- The edge bets' own record (2026-10-28, the owner's call) ---------------
// "Bets with an edge" named bets and kept nothing, so nobody could say
// whether its edges were real. Each bet is logged the first time the card
// shows it, at that price and fair; its closing price and fair are the last
// read of the same side before its start, whether or not it still clears the
// bar; and it is graded from the log its side came from. Closing-line value
// is the bet's EV at its first price on the closing fair -- the sharp
// market's last word -- the quickest sign an edge was real, long before the
// results are enough to say.
async function ensureEdgeBetSchema(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS edgebets (
    date TEXT NOT NULL, key TEXT NOT NULL, sport TEXT, market TEXT, label TEXT, sub TEXT, commence TEXT,
    book TEXT, fair_src TEXT, prop INTEGER, grade TEXT,
    first_at TEXT, first_price INTEGER, first_fair REAL, first_ev REAL, first_stake REAL,
    last_at TEXT, last_price INTEGER, last_fair REAL, last_ev REAL,
    close_at TEXT, close_price INTEGER, close_fair REAL,
    result TEXT, graded_at TEXT,
    PRIMARY KEY (date, key)
  )`).run();
  await db.prepare('CREATE INDEX IF NOT EXISTS edgebets_open ON edgebets (date) WHERE result IS NULL').run();
}
// scan: evScan's. Writes only what changed, so an unchanged read costs nothing.
async function logEdgeBets(db, scan, now) {
  await ensureEdgeBetSchema(db);
  const nowIso = new Date(now).toISOString();
  const stmts = scan.bets.map((b) => db.prepare(
    `INSERT INTO edgebets (date, key, sport, market, label, sub, commence, book, fair_src, prop, grade,
       first_at, first_price, first_fair, first_ev, first_stake, last_at, last_price, last_fair, last_ev, close_at, close_price, close_fair)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(date, key) DO UPDATE SET last_at = excluded.last_at, last_price = excluded.last_price, last_fair = excluded.last_fair, last_ev = excluded.last_ev
     WHERE julianday(edgebets.commence) > julianday(?) AND (edgebets.last_price IS NOT excluded.last_price OR edgebets.last_fair IS NOT excluded.last_fair)`
  ).bind(ptDateOf(Date.parse(b.commence)), b.key, b.sport, b.market, b.label, b.sub, b.commence, b.book || null, b.fairSrc || null, b.prop ? 1 : 0,
    JSON.stringify(b.grade || null), nowIso, b.price, b.fair, b.ev, b.stake, nowIso, b.price, b.fair, b.ev, nowIso, b.price, b.fair, nowIso));
  // The close: every logged bet still to start, at this read of its side.
  const open = (await db.prepare('SELECT date, key, commence FROM edgebets WHERE result IS NULL').all()).results || [];
  const byKey = new Map(scan.all.map((o) => [o.key, o]));
  for (const r of open) {
    const o = byKey.get(r.key);
    if (!o || !(Date.parse(r.commence) > now)) continue;
    stmts.push(db.prepare(`UPDATE edgebets SET close_at = ?, close_price = ?, close_fair = ? WHERE date = ? AND key = ?
      AND julianday(commence) > julianday(?) AND (close_price IS NOT ? OR close_fair IS NOT ?)`)
      .bind(nowIso, o.price, round1(o.fair), r.date, r.key, nowIso, o.price, round1(o.fair)));
  }
  if (stmts.length) await db.batch(stmts);
}
const EDGE_WL = { win: 'hit', loss: 'miss', push: 'push', void: 'void' };
async function edgeBetResult(db, g) {
  const one = (sql, ...a) => db.prepare(sql).bind(...a).first();
  if (!g) return null;
  if (g.t === 'under') {
    const m = await one('SELECT actual, result FROM nbapp WHERE date = ? AND game_id = ? AND player = ? AND market = ?', g.date, g.game_id, g.player, g.market);
    if (!m || m.result == null) return null;
    if (m.result === 'void') return 'void';
    return m.actual == null ? null : m.actual < g.line ? 'hit' : m.actual > g.line ? 'miss' : 'push';
  }
  if (g.t === 'row') {
    const m = await one('SELECT result FROM gmpicks WHERE sport = ? AND game_id = ? AND market = ? AND pick = ?', g.sport, g.game_id, g.market, g.pick);
    return (m && EDGE_WL[m.result]) || null;
  }
  // The game's own row (soccer's favourite row carries the score as well).
  const m = await one("SELECT side, result, home_score, away_score FROM gmpicks WHERE sport = ? AND game_id = ? AND market IN ('h2h', 'fav') AND result IS NOT NULL ORDER BY market = 'h2h' DESC", g.sport, g.game_id);
  if (!m || !EDGE_WL[m.result]) return null;
  if (m.result === 'void') return 'void';
  const hs = m.home_score, as = m.away_score, scored = typeof hs === 'number' && typeof as === 'number';
  if (g.t === 'total') return !scored ? null : hs + as > g.point ? (g.over ? 'hit' : 'miss') : hs + as < g.point ? (g.over ? 'miss' : 'hit') : 'push';
  if (m.side === g.side) return EDGE_WL[m.result];
  // Soccer's three ways by the score; a two-way game is the logged side's
  // other half, as its grader judged it (overtime and shootouts included).
  if (g.sport === 'soccer') return !scored ? null : (hs > as ? 'home' : as > hs ? 'away' : 'draw') === g.side ? 'hit' : 'miss';
  return m.result === 'win' ? 'miss' : m.result === 'loss' ? 'hit' : 'push';
}
async function gradeEdgeBets(db, now) {
  await ensureEdgeBetSchema(db);
  const open = (await db.prepare('SELECT date, key, commence, grade FROM edgebets WHERE result IS NULL').all()).results || [];
  const ups = [];
  for (const r of open.filter((x) => Date.parse(x.commence) < now - 3 * 3600e3).slice(0, 40)) {
    let g = null;
    try { g = JSON.parse(r.grade); } catch (e) { /* ungradable */ }
    let res = await edgeBetResult(db, g);
    // A side its log never grades (a game dropped from the feed) stops being
    // asked after three days.
    if (!res && Date.parse(r.commence) < now - 3 * 86400e3) res = 'void';
    if (res) ups.push(db.prepare('UPDATE edgebets SET result = ?, graded_at = ? WHERE date = ? AND key = ?').bind(res, new Date(now).toISOString(), r.date, r.key));
  }
  if (ups.length) await db.batch(ups);
}
// The record: won and lost, units flat and at the quarter-Kelly stake each was
// shown with (as a share of the bankroll), and how many beat the close.
async function edgeBetRecord(env) {
  await ensureEdgeBetSchema(env.DB);
  return recordCached(env, 'edge-bets', async () => {
    const rows = (await env.DB.prepare("SELECT date, first_price, first_fair, first_stake, close_fair, result FROM edgebets WHERE result IS NOT NULL").all()).results || [];
    const dec = rows.filter((r) => r.result === 'hit' || r.result === 'miss');
    let flat = 0, kelly = 0;
    for (const r of dec) { const d = decOf(r.first_price); flat += r.result === 'hit' ? d - 1 : -1; kelly += (r.first_stake || 0) * (r.result === 'hit' ? d - 1 : -1); }
    const clv = rows.filter((r) => r.close_fair != null && r.result !== 'void').map((r) => (r.close_fair / 100 * decOf(r.first_price) - 1) * 100);
    return { data: {
      since: rows.length ? rows.map((r) => r.date).sort()[0] : null,
      n: dec.length, hit: dec.filter((r) => r.result === 'hit').length, push: rows.filter((r) => r.result === 'push').length, void: rows.filter((r) => r.result === 'void').length,
      units: round2(flat), kellyUnits: round2(kelly), roi: dec.length ? round1(flat / dec.length * 100) : null,
      clv: { n: clv.length, beat: clv.filter((v) => v > 0).length, avg: clv.length ? round1(clv.reduce((a, v) => a + v, 0) / clv.length) : null },
    }, complete: true };
  });
}

// ---- Pick6 lines the market has moved past (2026-10-27) -----------------------
// DraftKings Pick6 seldom moves a line once it is posted (Unabated, on
// market-based prop projections), so when the books move during the day its
// number is left behind. Each NBA leg the reads saw on Pick6 carries the
// sharp books' chance at Pick6's own line (p6_sharp_under, re-priced from
// theirs as nbaSharpUnder does); either side at PICKEM_MIN or better is
// listed. A pick'em leg has no price, so its edge is its chance over a
// 2-pick's break-even (3x: 57.7% a leg), and it is staked as an entry is.
const PICKEM_MIN = 58;
const PICKEM_BE = 57.7;
async function pickemEdges(env, now) {
  const days = [ptDateOf(now), ptDateOf(now + 86400e3), ptDateOf(now + 2 * 86400e3)];
  const rows = (await env.DB.prepare('SELECT * FROM nbapp WHERE date IN (?, ?, ?) AND result IS NULL AND p6_line IS NOT NULL AND p6_sharp_under IS NOT NULL').bind(...days).all()).results || [];
  const out = [];
  for (const r of rows) {
    const t = Date.parse(r.commence);
    if (!(t > now && t - now <= EV_WINDOW_MS)) continue;
    const less = r.p6_sharp_under >= 50;
    const chance = less ? r.p6_sharp_under : 100 - r.p6_sharp_under;
    if (chance < PICKEM_MIN) continue;
    out.push({ venue: 'Pick6', sport: 'nba', market: r.market, side: less ? 'Less' : 'More', line: r.p6_line,
      label: `${r.player} ${less ? 'Less' : 'More'} ${r.p6_line} ${PICKS_NBA_MK[r.market] || r.market}`, sub: `${lastWord(r.away)} @ ${lastWord(r.home)}`,
      commence: r.commence, chance: round1(chance), edge: round1(chance - PICKEM_BE), ppLine: r.close_point != null ? r.close_point : r.point,
      asOf: r.close_at || r.captured_at });
  }
  return out.sort((a, b) => b.chance - a.chance).slice(0, EV_MAX);
}
// Per leg, the PrizePicks break-even for an entry of that many legs (2-pick
// power; 3 to 6, flex). The same table the slip's parlay read uses.
const PICKS_BREAK_EVEN = { 2: ['2-pick power', 57.7], 3: ['3-pick flex', 59.1], 4: ['4-pick flex', 56.9], 5: ['5-pick flex', 54.3], 6: ['6-pick flex', 54.2] };
const PICKS_MLB_MK = { tb: 'TB', hrr: 'H+R+RBI' };
const PICKS_NHL_MK = { pts: 'PTS', ast: 'AST' };
// A More's chance as the list states it (2026-10-28): the model's, blended
// with the sharp books' where they priced the line, as an NBA under's is
// (NBA_PICK_MODEL_W). The NHL log has no sharp read, so its is the model's.
const ppMoreChance = (r) => (r.sharp_under != null
  ? round1(NBA_PICK_MODEL_W * (100 - r.model_under) + (1 - NBA_PICK_MODEL_W) * (100 - r.sharp_under)) : round1(100 - r.model_under));
// The chance an NBA under is ranked and staked on (2026-10-27): where the
// sharp books priced him, a quarter the model's and three quarters theirs.
// Unabated blends a market-based projection into its own at 10-20%; this
// leans the other way because the market has been the honest one -- through
// Oct 27 the model's 70%+ unders landed 10 of 16, while legs the sharp books
// put under 50% landed 32 of 64 and above 54% 3 of 4. Qualifying is still
// the model's 70%+, as the kind's record counts it.
const NBA_PICK_MODEL_W = 0.25;
const PICKS_NBA_MK = { threes: '3PM', ast: 'AST', reb: 'REB', blk: 'BLK', stl: 'STL' };
const lastWord = (s) => String(s || '').trim().split(/\s+/).pop();
// The game-line log's row as a Picks kind: the regular season's moneylines (an
// NBA preseason favourite is not an NBA favourite), soccer's favourite.
const gmPickKind = (r) => (r.sport === 'nba' && r.market === 'h2h' && r.league === 'reg' ? 'nba_ml'
  : r.sport === 'nhl' && r.market === 'h2h' && r.league === 'reg' ? 'nhl_ml'
    : r.sport === 'nfl' && r.market === 'h2h' ? 'nfl_ml'
      : r.sport === 'nflptd' && r.market === 'pass_tds' ? 'nfl_ptd'
        : r.sport === 'soccer' && r.market === 'fav' ? 'soccer_fav' : null);
// PrizePicks' passing-TD line for each quarterback with a game in the next
// day, as the NFL props read last left it: `${event}|${player}` -> point.
// Read only when a passing-TD leg could make the list.
async function ptdPpLines(db, now) {
  const out = new Map();
  try {
    const rows = (await db.prepare(`SELECT event_id, player, point FROM nfl_lines WHERE market = 'player_pass_tds' AND book = 'prizepicks'
        AND commence > ? AND commence < ? ORDER BY captured_at ASC, rowid ASC`)
      .bind(new Date(now).toISOString(), new Date(now + PICKS_WINDOW_MS).toISOString()).all()).results || [];
    for (const r of rows) out.set(`${r.event_id}|${r.player}`, Number(r.point));
  } catch (e) { /* no NFL props table yet: every line unread */ }
  return out;
}
// An NHL club by nickname, two words for the Blue Jackets, Golden Knights,
// Maple Leafs and Red Wings: the NHL board's nhlNick, so a Picks leg and the
// board's own leg read the same.
const nhlNick = (name) => {
  const w = String(name || '').trim().split(/\s+/);
  return w.length >= 3 && /^(blue|golden|maple|red)$/i.test(w[w.length - 2]) ? w.slice(-2).join(' ') : w[w.length - 1];
};
const gamePkNum = (id) => { const m = /(\d{5,})/.exec(String(id || '')); return m ? Number(m[1]) : null; };

// ---- Club logos on the Picks list (2026-10-14) ---------------------------------
// A moneyline leg shows its club's mark. ESPN serves every one under
// a.espncdn.com/i/teamlogos/; a leg carries the path below that as spec.logo,
// and the page builds the URL. The file names are ESPN's own codes, not the
// site's: Golden State is gs, Utah utah, both Washingtons wsh, the Rams lar.
// Guessing costs a face either way: uta.png and nop.png 404, while sas.png and
// la.png answer 200 with another picture (the Spurs' wordmark, the Rams'
// alternate). tests/faces.mjs holds both tables to ESPN's recorded team lists.
const NBA_LOGO = {      // by nickname: the leg's team, the feed's last word
  hawks: 'atl', celtics: 'bos', nets: 'bkn', hornets: 'cha', bulls: 'chi', cavaliers: 'cle', mavericks: 'dal',
  nuggets: 'den', pistons: 'det', warriors: 'gs', rockets: 'hou', pacers: 'ind', clippers: 'lac', lakers: 'lal',
  grizzlies: 'mem', heat: 'mia', bucks: 'mil', timberwolves: 'min', pelicans: 'no', knicks: 'ny', thunder: 'okc',
  magic: 'orl', '76ers': 'phi', suns: 'phx', blazers: 'por', kings: 'sac', spurs: 'sa', raptors: 'tor',
  jazz: 'utah', wizards: 'wsh',
};
// By the site's code (NFL_ABBR). ESPN's is the same, lower-cased, but for two.
const NFL_LOGO = { WAS: 'wsh', LA: 'lar' };
// By nickname, as ESPN's NHL team list files them (2026-10-20). The odds feed
// writes "Montréal Canadiens" and "St Louis Blues", so the club is found by the
// nickname its full name ends with -- two words first, for the Blue Jackets,
// Red Wings, Maple Leafs and Golden Knights.
const NHL_LOGO = {
  ducks: 'ana', bruins: 'bos', sabres: 'buf', flames: 'cgy', hurricanes: 'car', blackhawks: 'chi', avalanche: 'col',
  'blue jackets': 'cbj', stars: 'dal', 'red wings': 'det', oilers: 'edm', panthers: 'fla', kings: 'la', wild: 'min',
  canadiens: 'mtl', predators: 'nsh', devils: 'nj', islanders: 'nyi', rangers: 'nyr', senators: 'ott', flyers: 'phi',
  penguins: 'pit', sharks: 'sj', kraken: 'sea', blues: 'stl', lightning: 'tb', 'maple leafs': 'tor', mammoth: 'utah',
  canucks: 'van', 'golden knights': 'vgk', capitals: 'wsh', jets: 'wpg',
};
function moneylineLogo(sport, team) {
  if (sport === 'nhl') {
    const w = String(team || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim().split(/\s+/);
    const c = NHL_LOGO[w.slice(-2).join(' ')] || NHL_LOGO[w[w.length - 1]];
    return c ? `nhl/500/${c}.png` : null;
  }
  if (sport === 'nba') {
    const c = NBA_LOGO[lastWord(team).toLowerCase()];
    return c ? `nba/500/${c}.png` : null;
  }
  if (sport === 'nfl') {
    const t = String(team || '');
    return Object.values(NFL_ABBR).includes(t) ? `nfl/500/${NFL_LOGO[t] || t.toLowerCase()}.png` : null;
  }
  return null;
}
// Soccer has too many clubs to list, so its marks come from the ESPN scoreboard
// the grader reads (cdn.espn.com, free): the fixture found by both clubs,
// matched as the grader matches them, and the picked side's logo. Clubs sit
// under soccer/500/, national teams under countries/500/. ESPN files a match
// under its US day -- every Liga MX kickoff at 03:00Z from Aug 1 to Oct 11,
// 2026 sat under the day before -- so the leg's Pacific day is the one to ask
// for. Page reads only, not the cron; one read per league and day, kept ten
// minutes; and never more than SOC_LOGO_WAIT_MS of the list's time, because a
// slow ESPN must not hold the Picks tab: the leg shows its initials instead.
const SOC_LOGO_TTL_MS = 10 * 60e3;
const SOC_LOGO_WAIT_MS = 2500;
// The read itself is kept, not its result, so three legs on one day share one.
const socLogoDays = new Map();     // `${slug}|${yyyymmdd}` -> { at, games: Promise }
const SOC_LOGO_PATH = /^https:\/\/a\.espncdn\.com\/i\/teamlogos\/((?:soccer|countries)\/500\/[a-z0-9]+\.png)$/i;
function soccerLogoDay(slug, ymd) {
  const k = `${slug}|${ymd}`;
  const hit = socLogoDays.get(k);
  if (hit && Date.now() - hit.at < SOC_LOGO_TTL_MS) return hit.games;
  const side = (c) => ({ name: (c.team && (c.team.displayName || c.team.name)) || '', logo: (c.team && c.team.logo) || '' });
  const games = espnScoreboard(`soccer/scoreboard?xhr=1&league=${slug}&date=${ymd}`).then((evs) => evs.map((ev) => {
    const cs = ((ev.competitions || [])[0] || {}).competitors || [];
    const h = cs.find((c) => c.homeAway === 'home'), a = cs.find((c) => c.homeAway === 'away');
    return h && a ? { home: side(h), away: side(a) } : null;
  }).filter(Boolean));
  socLogoDays.set(k, { at: Date.now(), games });
  games.catch(() => socLogoDays.delete(k));    // a failed read is retried on the next page read
  return games;
}
async function soccerPickLogos(legs) {
  await Promise.all(legs.filter((l) => l.kind === 'soccer_fav' && l.clubs && ESPN_SOCCER_SLUG[l.clubs.league]).map(async (l) => {
    let games = [];
    try { games = await soccerLogoDay(ESPN_SOCCER_SLUG[l.clubs.league], String(l.spec.date).replace(/-/g, '')); } catch (e) { return; }
    const { home, away } = l.clubs;
    // Neutral grounds: the feeds can disagree which side is home.
    const g = games.find((x) => (clubMatch(x.home.name, home) && clubMatch(x.away.name, away))
      || (clubMatch(x.home.name, away) && clubMatch(x.away.name, home)));
    const mine = g && [g.home, g.away].find((x) => clubMatch(x.name, l.spec.team));
    const m = mine && SOC_LOGO_PATH.exec(mine.logo);
    if (m) l.spec.logo = m[1].toLowerCase();
  }));
}

async function ensureDayPickSchema(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS daypicks (
    date TEXT NOT NULL, leg_id TEXT NOT NULL, kind TEXT NOT NULL,
    src_date TEXT, game_id TEXT, player_key TEXT, market TEXT, team TEXT,
    label TEXT, p REAL, commence TEXT, rank INTEGER, on_list INTEGER,
    seen_at TEXT, result TEXT,
    PRIMARY KEY (date, leg_id)
  )`).run();
  // The chance a leg first showed, beside p, the one it showed last before its
  // start (2026-10-22). With the pre-start reads p is the close, so the two say
  // which way the market moved while the leg sat on the list.
  await addColumns(db, 'daypicks', [['first_p', 'REAL'], ['first_at', 'TEXT']]);
  // The grader asks every fifteen minutes, and on every Picks read, for listed
  // legs still ungraded -- a scan of the whole log until now. Keyed on on_list,
  // one value throughout, so the legs come out in rowid order as the scan gave
  // them (the grader takes the first forty).
  await db.prepare('CREATE INDEX IF NOT EXISTS daypicks_open ON daypicks (on_list) WHERE on_list = 1 AND result IS NULL').run();
  // The PrizePicks entry's pool (2026-10-28, ppPoolOf), kept as the list is:
  // in_pool at each start, and the chance and rank it showed there. A leg in
  // the pool and never on the list has on_list 0 and no seen_at, so it is not
  // one the list dropped.
  await addColumns(db, 'daypicks', [['in_pool', 'INTEGER'], ['pool_p', 'REAL'], ['pool_rank', 'INTEGER']]);
  await db.prepare('CREATE INDEX IF NOT EXISTS daypicks_pool_open ON daypicks (in_pool) WHERE in_pool = 1 AND result IS NULL').run();
}

// Every leg that clears its kind's bar, for games starting in the next day.
// Each carries what the slip needs to take it under the id its own board uses,
// so a star here and a star there are one leg. `unavailable` names the kinds
// whose source could not be read, so the log does not mistake an outage for a
// leg falling off the list.
async function picksCandidates(env, now) {
  const db = env.DB;
  const days = [ptDateOf(now), ptDateOf(now + 86400e3)];
  const until = now + PICKS_WINDOW_MS;
  const soon = (iso) => { const t = Date.parse(iso || ''); return isFinite(t) && t > now && t <= until; };
  const legs = [], unavailable = new Set();

  // MLB: the moneyline log and the PrizePicks log, timed and lineup-checked
  // from one StatsAPI read per day.
  await ensureMlPickSchema(db); await ensurePpSchema(db);
  const ml = (await db.prepare('SELECT * FROM mlpicks WHERE date IN (?, ?) AND result IS NULL').bind(...days).all()).results || [];
  const pp = (await db.prepare("SELECT * FROM pppicks WHERE date IN (?, ?) AND result IS NULL AND market IN ('tb','hrr')").bind(...days).all()).results || [];
  const slates = {};
  for (const d of new Set([...ml, ...pp].map((r) => r.date))) {
    slates[d] = await mlbDaySlate(d);
    if (!slates[d]) { unavailable.add('mlb_ml'); unavailable.add('mlb_pp'); }
  }
  const mlbGame = (r) => { const s = slates[r.date]; const g = s && s.games[r.game_id]; return g && g.status !== 'Final' && soon(g.commence) ? g : null; };
  for (const r of ml) {
    const g = mlbGame(r);
    if (!g || r.win_prob == null) continue;
    // One row per game, for the side the board leads with -- often the dog.
    // The favourite is whichever side the win chance points to.
    const pickFav = r.win_prob >= 50;
    const p = pickFav ? r.win_prob : 100 - r.win_prob;
    if (p < PICK_KINDS.mlb_ml.min) continue;
    const team = pickFav ? r.team : r.opp;
    const isHome = pickFav ? !!r.is_home : !r.is_home;
    const price = pickFav ? (r.close_price != null ? r.close_price : r.entry_price) : null;
    legs.push({ kind: 'mlb_ml', gameKey: 'mlb:' + r.game_id, p, commence: g.commence,
      // The board's star takes the side it leads with as `ml:<game>`.
      legId: pickFav ? `ml:${r.game_id}` : `ml:${r.game_id}:${team}`,
      title: `${team} ML`, sub: r.is_home ? `${r.opp} @ ${r.team}` : `${r.team} @ ${r.opp}`, odds: price,
      src: { date: r.date, game_id: r.game_id, team, market: 'ml' },
      spec: { sport: 'mlb', date: r.date, gamePk: gamePkNum(r.game_id), player: team, team, market: 'ml',
        side: isHome ? 'home' : 'away', book: { line: null, price, win: round1(p) }, pp: null } });
  }
  for (const r of pp) {
    const g = mlbGame(r);
    if (!g) continue;
    const p = r.close_model_under != null ? r.close_model_under : r.model_under;
    if (p == null || p < PICK_KINDS.mlb_pp.min) continue;
    const s = slates[r.date];
    const lineup = lineupStatus(s && s.cards, r);
    if (lineup === 'out') continue;          // benched: the leg would void
    const point = r.close_point != null ? r.close_point : r.point;
    legs.push({ kind: 'mlb_pp', gameKey: 'mlb:' + r.game_id, p, commence: g.commence, lineup: lineup || 'not posted',
      legId: `pp:b${r.player_id}:${r.market}`,   // the batter row is 'b' + player id
      title: `${r.player} Under ${point} ${PICKS_MLB_MK[r.market] || r.market}`, sub: `${g.away} @ ${g.home}`, odds: null,
      src: { date: r.date, game_id: r.game_id, player_key: String(r.player_id), market: r.market, team: r.team },
      spec: { sport: 'mlb', date: r.date, gamePk: gamePkNum(r.game_id), playerId: r.player_id, player: r.player, team: r.team || null,
        market: r.market, side: 'Under', book: { line: null, price: null, under: null }, pp: { line: point, under: round1(p) } } });
  }

  // NBA, NHL, NFL and soccer game lines: the side the sharp books favour, from
  // the game-line log (each board refreshes its row's win chance and price).
  await ensureGamePickSchema(db);
  const gm = (await db.prepare("SELECT * FROM gmpicks WHERE sport IN ('nba','nhl','nfl','nflptd','soccer') AND date IN (?, ?) AND result IS NULL").bind(...days).all()).results || [];
  const ptdPP = gm.some((r) => r.sport === 'nflptd' && soon(r.commence) && r.win_prob >= PICK_KINDS.nfl_ptd.min) ? await ptdPpLines(db, now) : new Map();
  for (const r of gm) {
    if (!soon(r.commence) || r.win_prob == null) continue;
    const kind = gmPickKind(r);
    if (!kind || r.win_prob < PICK_KINDS[kind].min) continue;
    const day = ptDateOf(Date.parse(r.commence));
    const price = r.close_price != null ? r.close_price : r.entry_price;
    const base = { kind, p: r.win_prob, commence: r.commence, odds: price,
      src: { date: r.date, game_id: r.game_id, team: r.pick, market: r.market } };
    const book = { line: null, price, win: round1(r.win_prob) };
    if (kind === 'nba_ml') {
      legs.push({ ...base, gameKey: 'nba:' + r.game_id, legId: `nba:ml:${r.game_id}:${r.side}`,
        title: `${lastWord(r.pick)} ML`, sub: `${lastWord(r.away)} @ ${lastWord(r.home)}`,
        spec: { sport: 'nba', date: day, gamePk: r.game_id, player: r.pick, team: lastWord(r.pick), market: 'ml', side: r.side,
          logo: moneylineLogo('nba', r.pick), book, pp: null } });
    } else if (kind === 'nhl_ml') {
      // The NHL board's own leg id and nicknames, so a star here is its star.
      legs.push({ ...base, gameKey: 'nhl:' + r.game_id, legId: `nhl:ml:${r.game_id}:${r.side}`,
        title: `${nhlNick(r.pick)} ML`, sub: `${nhlNick(r.away)} @ ${nhlNick(r.home)}`,
        spec: { sport: 'nhl', date: day, gamePk: r.game_id, player: r.pick, team: nhlNick(r.pick), market: 'ml', side: r.side,
          logo: moneylineLogo('nhl', r.pick), book, pp: null } });
    } else if (kind === 'nfl_ml') {
      legs.push({ ...base, gameKey: 'nfl:' + r.game_id, legId: `nfl:ml:${r.game_id}:${r.pick}`,
        title: `${r.pick} ML`, sub: `${r.away} @ ${r.home}`,
        // The NFL slip keys a game by matchup and day, as its board does.
        spec: { sport: 'nfl', date: day, gamePk: `${r.away} @ ${r.home}|${day}`, player: r.pick, team: r.pick, market: 'ml', side: r.side,
          logo: moneylineLogo('nfl', r.pick), book, pp: null } });
    } else if (kind === 'nfl_ptd') {
      // One leg a game with the NFL moneyline (the event id leads the row's
      // game_id). PrizePicks at another number is another under: left off.
      const [event, player] = String(r.game_id).split('|');
      const pp = ptdPP.get(r.game_id);
      if (pp != null && pp !== r.point) continue;
      const away = NFL_ABBR[r.away] || r.away, home = NFL_ABBR[r.home] || r.home;
      legs.push({ ...base, gameKey: 'nfl:' + event, legId: `nfl:ptd:${event}:${player}`,
        title: `${player} Under ${r.point} Pass TDs`, sub: `${away} @ ${home}${pp == null ? ` · check PrizePicks has ${r.point}` : ''}`,
        spec: { sport: 'nfl', date: day, gamePk: `${away} @ ${home}|${day}`, player, team: null, market: 'pass_tds', side: 'Under', logo: null,
          book: { line: r.point, price, under: null }, pp: { line: r.point, under: round1(r.win_prob) } } });
    } else {
      legs.push({ ...base, gameKey: 'soc:' + r.game_id, legId: `soc:${r.game_id}:${r.side}`,
        title: `${r.pick} ML`, sub: `${r.away} @ ${r.home}`,
        league: (SOCCER_LEAGUES[r.league] && SOCCER_LEAGUES[r.league].label) || r.league || null,
        // What the logo lookup matches on (soccerPickLogos); not sent to the page.
        clubs: { league: r.league, home: r.home, away: r.away },
        spec: { sport: 'soccer', date: day, gamePk: r.game_id, player: r.pick, team: r.pick, market: 'ml', side: r.side, logo: null, book, pp: null } });
    }
  }

  // NBA PrizePicks unders: rotation players, as on the NBA card, in the
  // markets the list was built on (blocks and steals are logged only).
  await ensureNbaSchema(db);
  const np = (await db.prepare(`SELECT * FROM nbapp WHERE date IN (?, ?) AND result IS NULL AND market IN (${NBA_PICK_MARKETS.map(() => '?').join(',')})`)
    .bind(...days, ...NBA_PICK_MARKETS).all()).results || [];
  for (const row of ppStanding(np)) {
    // At its latest line: the one that can be played now (ppCurrent).
    const r = ppCurrent(row);
    if (!soon(r.commence) || r.model_under == null || r.model_under < PICK_KINDS.nba_pp.min) continue;
    if (!(r.min_proj >= NBA_ROTATION_MIN) || ppBelowBook(r)) continue;
    const p = r.sharp_under != null ? round1(NBA_PICK_MODEL_W * r.model_under + (1 - NBA_PICK_MODEL_W) * r.sharp_under) : r.model_under;
    legs.push({ kind: 'nba_pp', gameKey: 'nba:' + r.game_id, p, modelP: r.model_under, proj: r.proj, commence: r.commence, odds: null,
      vsBook: r.book_line != null && r.point != null ? round1(r.point - r.book_line) : null,
      legId: `nbapp:${r.game_id}:${r.player}:${r.market}`,
      title: `${r.player} Under ${r.point} ${PICKS_NBA_MK[r.market] || r.market}`, sub: `${lastWord(r.away)} @ ${lastWord(r.home)}`,
      src: { date: r.date, game_id: r.game_id, player_key: r.player, market: r.market, team: r.team },
      // playerId is ESPN's athlete id (nba_box), which is what the page's
      // headshot reads (2026-10-14); it was null.
      spec: { sport: 'nba', date: ptDateOf(Date.parse(r.commence)), gamePk: r.game_id, playerId: r.player_id || null, player: r.player, team: r.team || null,
        market: r.market, side: 'Under', book: { line: r.book_line != null ? r.book_line : null, price: typeof r.book_under === 'number' ? r.book_under : null, under: null },
        pp: { line: r.point, under: p } },
      // Underdog's and Pick6's line on the same under, where read (2026-10-25).
      dfs: { ud: r.ud_line == null ? null : r.ud_line, p6: r.p6_line == null ? null : r.p6_line },
      // The sharp books' chance of the under at the line shown (2026-10-25).
      sharp: r.sharp_under == null ? null : r.sharp_under });
  }

  // The PrizePicks Mores (2026-10-28): NBA blocks, rotation players, and the
  // NHL's points and assists, at a More chance of 55%+ by the model, as their
  // cards list them. A blocks leg the sharp books priced blends as the unders
  // do (ppMoreChance), and the chance the list states has to clear the bar as
  // well: 55% is near PrizePicks' break-even, and on Oct 26 Zach Edey's 55.8
  // More read 45.8 with the sharp books' 42.5 in it.
  const moreLeg = (sport, r, p, mk) => ({ kind: sport === 'nba' ? 'nba_blk_more' : 'nhl_more', gameKey: `${sport}:${r.game_id}`, p,
    modelP: round1(100 - r.model_under), proj: r.proj, commence: r.commence, odds: null,
    legId: `${sport}pp:${r.game_id}:${r.player}:${r.market}:over`, title: `${r.player} Over ${r.point} ${mk}`,
    sub: sport === 'nhl' ? `${nhlNick(r.away)} @ ${nhlNick(r.home)}` : `${lastWord(r.away)} @ ${lastWord(r.home)}`,
    src: { date: r.date, game_id: r.game_id, player_key: r.player, market: r.market, team: r.team },
    spec: { sport, date: ptDateOf(Date.parse(r.commence)), gamePk: r.game_id, playerId: r.player_id || null, player: r.player, team: r.team || null,
      market: r.market, side: 'Over', book: { line: r.book_line != null ? r.book_line : null, price: null, under: null }, pp: { line: r.point, under: round1(100 - p) } } });
  const blk = (await db.prepare("SELECT * FROM nbapp WHERE date IN (?, ?) AND result IS NULL AND market = 'blk'").bind(...days).all()).results || [];
  for (const row of ppStanding(blk)) {
    const r = ppCurrent(row);
    if (!soon(r.commence) || r.model_under == null || !(r.min_proj >= NBA_ROTATION_MIN)) continue;
    const p = ppMoreChance(r);
    if (100 - r.model_under < PICK_KINDS.nba_blk_more.min || p < PICK_KINDS.nba_blk_more.min) continue;
    legs.push({ ...moreLeg('nba', r, p, 'BLK'), sharp: r.sharp_under == null ? null : round1(100 - r.sharp_under) });
  }
  await ensureNhlPpSchema(db);
  const nhl = (await db.prepare('SELECT * FROM nhlpp WHERE date IN (?, ?) AND result IS NULL').bind(...days).all()).results || [];
  for (const row of ppStanding(nhl)) {
    const r = ppCurrent(row);
    if (!soon(r.commence) || r.model_under == null) continue;
    if (100 - r.model_under < PICK_KINDS.nhl_more.min) continue;
    legs.push(moreLeg('nhl', r, ppMoreChance(r), PICKS_NHL_MK[r.market] || r.market));
  }
  return { legs, unavailable };
}

// The best leg of each game, best first, at most PICKS_N. Legs of one game tend
// to land or miss together, and a PrizePicks entry needs two teams anyway.
function pickList(legs) {
  const best = new Map();
  for (const l of [...legs].sort((a, b) => b.p - a.p || Date.parse(a.commence) - Date.parse(b.commence))) {
    if (!best.has(l.gameKey)) best.set(l.gameKey, l);
  }
  return [...best.values()].slice(0, PICKS_N);
}
// The PrizePicks entry's own pool (2026-10-28): the best leg of each game
// among the kinds PrizePicks takes (PP_ENTRY_KINDS), and the first NFL
// moneyline as the entry's one team pick, from everything that qualifies --
// not only the list's six, where the moneylines crowded its player picks out
// (Oct 28: four moneylines on the list, two PrizePicks legs).
function ppPoolOf(legs) {
  const pool = [], games = new Set();
  let teamPick = false;
  for (const l of [...legs].sort((a, b) => b.p - a.p || Date.parse(a.commence) - Date.parse(b.commence))) {
    if (pool.length >= PICKS_N || games.has(l.gameKey)) continue;
    const team = l.kind === 'nfl_ml';
    if (!PP_ENTRY_KINDS.has(l.kind) && !(team && !teamPick)) continue;
    if (team) teamPick = true;
    games.add(l.gameKey);
    pool.push(l);
  }
  return pool;
}

// What the list showed is what it is judged on. Each leg on it is written with
// its rank; a leg that drops off before its game starts is marked off; once a
// game starts its rows are left alone, so the row says whether that leg was on
// the list at first pitch or tip. Times are compared as times (2026-10-22):
// as text the feed's '...T23:00:00Z' sorts after '...T23:00:00.123Z', so a
// read in the first second of a start minute -- when the cron fires -- took a
// game that had just started for one still to come, and marked its leg off.
async function logDayPicks(db, list, unavailable, now, pool = []) {
  await ensureDayPickSchema(db);
  const nowIso = new Date(now).toISOString();
  const stmts = list.map((l, i) => db.prepare(
    `INSERT INTO daypicks (date, leg_id, kind, src_date, game_id, player_key, market, team, label, p, commence, rank, on_list, seen_at, first_p, first_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)
     ON CONFLICT(date, leg_id) DO UPDATE SET p = excluded.p, rank = excluded.rank, on_list = 1,
       seen_at = excluded.seen_at, label = excluded.label,
       first_p = COALESCE(daypicks.first_p, excluded.first_p), first_at = COALESCE(daypicks.first_at, excluded.first_at)
     WHERE julianday(daypicks.commence) > julianday(?)`
  ).bind(ptDateOf(Date.parse(l.commence)), l.legId, l.kind, l.src.date, String(l.src.game_id), l.src.player_key || null,
    l.src.market || null, l.src.team || null, l.title, l.p, l.commence, i + 1, nowIso, l.p, nowIso, nowIso));
  const ids = list.map((l) => l.legId);
  const keep = [...unavailable];
  stmts.push(db.prepare(
    `UPDATE daypicks SET on_list = 0, rank = NULL WHERE date IN (?, ?) AND julianday(commence) > julianday(?)`
      + (ids.length ? ` AND leg_id NOT IN (${ids.map(() => '?').join(',')})` : '')
      + (keep.length ? ` AND kind NOT IN (${keep.map(() => '?').join(',')})` : '')
  ).bind(ptDateOf(now), ptDateOf(now + 86400e3), nowIso, ...ids, ...keep));
  // The entry's pool, after the list (2026-10-28). A leg on both keeps the
  // list's label and chance; one only in the pool takes the pool's.
  for (const [i, l] of pool.entries()) {
    stmts.push(db.prepare(
      `INSERT INTO daypicks (date, leg_id, kind, src_date, game_id, player_key, market, team, label, p, commence, on_list, in_pool, pool_p, pool_rank)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,0,1,?,?)
       ON CONFLICT(date, leg_id) DO UPDATE SET in_pool = 1, pool_p = excluded.pool_p, pool_rank = excluded.pool_rank,
         label = CASE WHEN daypicks.seen_at IS NULL THEN excluded.label ELSE daypicks.label END,
         p = CASE WHEN daypicks.seen_at IS NULL THEN excluded.p ELSE daypicks.p END
       WHERE julianday(daypicks.commence) > julianday(?)`
    ).bind(ptDateOf(Date.parse(l.commence)), l.legId, l.kind, l.src.date, String(l.src.game_id), l.src.player_key || null,
      l.src.market || null, l.src.team || null, l.title, l.p, l.commence, l.p, i + 1, nowIso));
  }
  const pids = pool.map((l) => l.legId);
  stmts.push(db.prepare(
    `UPDATE daypicks SET in_pool = 0, pool_rank = NULL WHERE date IN (?, ?) AND julianday(commence) > julianday(?) AND in_pool = 1`
      + (pids.length ? ` AND leg_id NOT IN (${pids.map(() => '?').join(',')})` : '')
      + (keep.length ? ` AND kind NOT IN (${keep.map(() => '?').join(',')})` : '')
  ).bind(ptDateOf(now), ptDateOf(now + 86400e3), nowIso, ...pids, ...keep));
  await db.batch(stmts);
}

// A game-line kind's log (gmpicks) by sport.
const PICK_GM_SPORT = { nba_ml: 'nba', nhl_ml: 'nhl', nfl_ml: 'nfl', nfl_ptd: 'nflptd', soccer_fav: 'soccer' };
// The side a listed under landed on: a leg the list showed at the pre-tip
// line grades at that line, and the label carries the number it showed
// ("... Under 6.5 REB").
function ppShownResult(m, label) {
  const shown = Number((String(label || '').match(/ (?:Under|Over) (\d+(?:\.\d+)?) /) || [])[1]);
  return m && (m.close_point != null && m.close_point !== m.point && shown === m.close_point ? m.close_result : m.result);
}
const ppLegResult = (res) => (res === 'under' ? 'hit' : res === 'over' ? 'miss' : res === 'push' ? 'push' : res === 'void' ? 'void' : null);
const ppMoreResult = (res) => (res === 'over' ? 'hit' : res === 'under' ? 'miss' : res === 'push' ? 'push' : res === 'void' ? 'void' : null);
// A listed leg's result, read from the log it came from. hit / miss / push /
// void, or null while that log has not graded it.
async function dayPickResult(db, r) {
  const one = (sql, ...a) => db.prepare(sql).bind(...a).first();
  if (r.kind === 'mlb_ml') {
    const m = await one('SELECT team, result FROM mlpicks WHERE date = ? AND game_id = ?', r.src_date, r.game_id);
    if (!m || (m.result !== 'win' && m.result !== 'loss')) return m && m.result === 'void' ? 'void' : null;
    return (m.team === r.team) === (m.result === 'win') ? 'hit' : 'miss';
  }
  if (r.kind === 'mlb_pp' || r.kind === 'nba_pp') {
    const m = r.kind === 'mlb_pp'
      ? await one('SELECT result FROM pppicks WHERE date = ? AND game_id = ? AND player_id = ? AND market = ?', r.src_date, r.game_id, Number(r.player_key), r.market)
      : await one('SELECT result, point, close_point, close_result FROM nbapp WHERE date = ? AND game_id = ? AND player = ? AND market = ?', r.src_date, r.game_id, r.player_key, r.market);
    return ppLegResult(ppShownResult(m, r.label));
  }
  // A More (2026-10-28) lands on the over, at the line the list showed.
  if (r.kind === 'nba_blk_more' || r.kind === 'nhl_more') {
    const m = await one(`SELECT result, point, close_point, close_result FROM ${r.kind === 'nhl_more' ? 'nhlpp' : 'nbapp'} WHERE date = ? AND game_id = ? AND player = ? AND market = ?`,
      r.src_date, r.game_id, r.player_key, r.market);
    return ppMoreResult(ppShownResult(m, r.label));
  }
  const sport = PICK_GM_SPORT[r.kind];
  if (!sport) return null;
  const m = await one('SELECT result FROM gmpicks WHERE sport = ? AND date = ? AND game_id = ? AND market = ?', sport, r.src_date, r.game_id, r.market);
  const res = m && m.result;
  return res === 'win' ? 'hit' : res === 'loss' ? 'miss' : res === 'push' ? 'push' : res === 'void' ? 'void' : null;
}
async function gradeDayPicks(db, now) {
  await ensureDayPickSchema(db);
  const cut = new Date(now - 3 * 3600e3).toISOString();
  const open = (await db.prepare('SELECT * FROM daypicks WHERE on_list = 1 AND result IS NULL AND commence < ?').bind(cut).all()).results || [];
  // And the entry's pool legs the list did not carry (2026-10-28).
  const pooled = (await db.prepare('SELECT * FROM daypicks WHERE in_pool = 1 AND result IS NULL AND on_list = 0 AND commence < ?').bind(cut).all()).results || [];
  const ups = [];
  for (const r of [...open, ...pooled].slice(0, 40)) {
    const res = await dayPickResult(db, r);
    if (res) ups.push(db.prepare('UPDATE daypicks SET result = ? WHERE date = ? AND leg_id = ?').bind(res, r.date, r.leg_id));
  }
  if (ups.length) await db.batch(ups);
}

// ---- Legs that left the list before their start (2026-10-27) -----------------
// On Oct 26 Sion James's threes under led the list at 2 PM (78%) and was off
// it at tip, where it would have landed, and nothing said why. The record
// judges the list on what it showed at each start, so a leg off by then is
// not in it; this sits beside it: each leg the list showed in the last few
// days and dropped before its game, why, from the log it came from, and how
// it went. The rows are daypicks' own: a dropped leg keeps on_list = 0 and
// seen_at, the last time it was on the list.
const PICK_DROP_DAYS = 3;
const PICK_DROP_MAX = 30;
const dropOutranked = (o) => `${o.label} (${Math.round(o.p)}%) took its game's place`;
// An NBA under, as the pre-tip read left it (ppStanding, ppCurrent): taken
// down, moved, under the bar, below the books' line -- or still good, and
// beaten in its game by the leg that held the place at tip (other). A More
// (2026-10-28) reads its own side's chance against its own bar; a line below
// the books' is no reason to leave it.
function ppDropWhy(m, reread, other, kind = 'nba_pp') {
  if (!m) return null;
  if (reread && m.close_point == null) return `PrizePicks took the line down before ${kind === 'nhl_more' ? 'puck drop' : 'tip'}, most often a player ruled out`;
  if (!PICK_KINDS[kind]) kind = 'nba_pp';
  const cur = ppCurrent(m), min = PICK_KINDS[kind].min, more = kind !== 'nba_pp';
  const p = cur.model_under == null ? null : more ? 100 - cur.model_under : cur.model_under;
  const why = [];
  if (cur.point !== m.point) why.push(`PrizePicks moved the line from ${m.point} to ${cur.point}`);
  if (!(p >= min)) why.push(p == null ? `no chance was read at ${cur.point}` : `the chance at ${cur.point} was ${round1(p)}%, under the ${min}% bar`);
  else if (more && ppMoreChance(cur) < min) why.push(`the sharp books had it at ${round1(100 - cur.sharp_under)}%, ${ppMoreChance(cur)}% with the model's, under the ${min}% bar`);
  else if (!more && ppBelowBook(cur)) why.push(`PrizePicks' ${cur.point} sat below the books' ${cur.book_line}`);
  else if (other) why.push(dropOutranked(other));
  return why.length ? why.join('; ') : null;
}
// A moneyline or soccer favourite, by the game-line log's row at the start.
function gmDropWhy(g, r, other) {
  if (!g) return null;
  if (g.pick !== r.team) return `the books' favourite became ${g.pick}`;
  const min = PICK_KINDS[r.kind].min;
  if (g.win_prob != null && g.win_prob < min) return `its chance was ${round1(g.win_prob)}% by the start, under the ${min}% bar`;
  return other ? dropOutranked(other) : null;
}
// listed: the list's on_list rows (date, label, p, game_id), for the leg that
// held a dropped leg's game at its start.
async function dayPickDrops(db, now, listed) {
  const off = (await db.prepare(`SELECT date, leg_id, kind, src_date, game_id, player_key, market, team, label, p, seen_at, commence FROM daypicks
      WHERE on_list = 0 AND seen_at IS NOT NULL AND date >= ? AND julianday(commence) <= julianday(?) ORDER BY date DESC, p DESC LIMIT ?`)
    .bind(ptDateOf(now - PICK_DROP_DAYS * 86400e3), new Date(now).toISOString(), PICK_DROP_MAX).all()).results || [];
  const one = (sql, ...a) => db.prepare(sql).bind(...a).first();
  return Promise.all(off.map(async (r) => {
    const other = listed.find((x) => x.date === r.date && String(x.game_id) === String(r.game_id)) || null;
    let why = null, result = null, actual = null;
    if (r.kind === 'nba_pp' || r.kind === 'nba_blk_more' || r.kind === 'nhl_more') {
      const tbl = r.kind === 'nhl_more' ? 'nhlpp' : 'nbapp';
      const m = await one(`SELECT * FROM ${tbl} WHERE date = ? AND game_id = ? AND player = ? AND market = ?`, r.src_date, r.game_id, r.player_key, r.market);
      const reread = !!(m && (m.close_at || await one(`SELECT 1 AS x FROM ${tbl} WHERE date = ? AND game_id = ? AND close_at IS NOT NULL LIMIT 1`, r.src_date, r.game_id)));
      why = ppDropWhy(m, reread, other, r.kind);
      const res = ppShownResult(m, r.label);
      result = r.kind === 'nba_pp' ? ppLegResult(res) : ppMoreResult(res);
      if (m && m.actual != null) actual = m.actual;
    } else if (PICK_GM_SPORT[r.kind]) {
      const g = await one('SELECT pick, win_prob, result FROM gmpicks WHERE sport = ? AND date = ? AND game_id = ? AND market = ?', PICK_GM_SPORT[r.kind], r.src_date, r.game_id, r.market);
      why = gmDropWhy(g, r, other);
      // As listed: a favourite that flipped is a different leg.
      if (g && g.pick === r.team) result = { win: 'hit', loss: 'miss', push: 'push', void: 'void' }[g.result] || null;
    }
    if (!why) why = other ? dropOutranked(other) : 'off the list before its start';
    return { date: r.date, kind: r.kind, label: r.label, p: round1(r.p), lastOn: r.seen_at, why, result, ...(actual != null ? { actual } : {}) };
  }));
}

// How each kind has done at its bar, from its own log -- the number printed
// beside each leg, so a 72% leg says whether 72% legs have been landing.
// Graded rows only, so kept until one is graded (recordCached).
async function pickKindRecords(env) {
  const db = env.DB;
  await ensureMlPickSchema(db); await ensurePpSchema(db); await ensureGamePickSchema(db); await ensureNbaSchema(db); await ensureNhlPpSchema(db);
  return recordCached(env, 'pick-kinds', async () => ({ data: await pickKindBuild(db), complete: true }));
}
async function pickKindBuild(db) {
  const rec = Object.fromEntries(Object.keys(PICK_KINDS).map((k) => [k, { n: 0, hit: 0 }]));
  const add = (k, won) => { rec[k].n++; if (won) rec[k].hit++; };
  for (const r of ((await db.prepare("SELECT win_prob, result FROM mlpicks WHERE result IN ('win','loss')").all()).results || [])) {
    if (r.win_prob == null) continue;
    const fav = r.win_prob >= 50;
    if ((fav ? r.win_prob : 100 - r.win_prob) >= PICK_KINDS.mlb_ml.min) add('mlb_ml', fav === (r.result === 'win'));
  }
  for (const r of ((await db.prepare("SELECT model_under, close_model_under, result FROM pppicks WHERE result IN ('under','over') AND market IN ('tb','hrr')").all()).results || [])) {
    const p = r.close_model_under != null ? r.close_model_under : r.model_under;
    if (p != null && p >= PICK_KINDS.mlb_pp.min) add('mlb_pp', r.result === 'under');
  }
  for (const r of ((await db.prepare("SELECT sport, market, league, win_prob, result FROM gmpicks WHERE sport IN ('nba','nhl','nfl','soccer') AND result IN ('win','loss')").all()).results || [])) {
    const kind = gmPickKind(r);
    if (kind && r.win_prob != null && r.win_prob >= PICK_KINDS[kind].min) add(kind, r.result === 'win');
  }
  // Passing-TD unders, one row a quarterback a game (dedupePassTds): before
  // 2026-09-24 a capture filed four Sunday passers under Thursday too.
  const ptd = (await db.prepare("SELECT date, game_id, commence, market, win_prob, result FROM gmpicks WHERE sport = 'nflptd' AND result IN ('win','loss')").all()).results || [];
  for (const r of dedupePassTds(ptd)) if (r.win_prob != null && r.win_prob >= PICK_KINDS.nfl_ptd.min) add('nfl_ptd', r.result === 'win');
  // The kind's record is the legs the list carries, so a blocks or steals leg,
  // or one under a PrizePicks line below the books', cannot vouch for a threes
  // leg beside it.
  for (const r of ((await db.prepare(`SELECT model_under, min_proj, point, book_line, result FROM nbapp WHERE result IN ('under','over') AND market IN (${NBA_PICK_MARKETS.map(() => '?').join(',')})`)
    .bind(...NBA_PICK_MARKETS).all()).results || [])) {
    if (r.min_proj >= NBA_ROTATION_MIN && r.model_under >= PICK_KINDS.nba_pp.min && !ppBelowBook(r)) add('nba_pp', r.result === 'under');
  }
  // The Mores (2026-10-28): graded at the first line, the More side, as the
  // cards' blkMore and more records count them.
  for (const r of ((await db.prepare("SELECT model_under, min_proj, result FROM nbapp WHERE result IN ('under','over') AND market = 'blk'").all()).results || [])) {
    if (r.min_proj >= NBA_ROTATION_MIN && r.model_under != null && 100 - r.model_under >= PICK_KINDS.nba_blk_more.min) add('nba_blk_more', r.result === 'over');
  }
  for (const r of ((await db.prepare("SELECT model_under, result FROM nhlpp WHERE result IN ('under','over')").all()).results || [])) {
    if (r.model_under != null && 100 - r.model_under >= PICK_KINDS.nhl_more.min) add('nhl_more', r.result === 'over');
  }
  for (const v of Object.values(rec)) {
    v.hitRate = v.n ? round1(v.hit / v.n * 100) : null;
    v.proven = v.n >= PICKS_PROVEN_N;
  }
  return rec;
}

// What the list would have paid (2026-10-22): one unit an entry at PrizePicks'
// standard payouts (PP_POWER, PP_FLEX), each day's top two by chance as a
// 2-pick Power and its top three to six as a Flex. An entry waits until every
// leg in it has graded. A void or tie in it counts as a refund, neither won
// nor lost: PrizePicks drops that leg and pays the smaller entry, or refunds a
// two-pick, and the smaller entry is not one the list showed.
// The fifth field is a floor (2026-10-25): the 75%+ Power takes the day's top
// two legs at 75% or better, and skips a day without two. From Oct 10 to 24,
// legs at 75%+ landed 28 of 31 and legs at 65-75% 20 of 29.
const PICK_HIST_ENTRIES = [['p2', 'Top 2 Power', 2, 'power'], ['p2h', 'Top 2 Power, 75%+', 2, 'power', 75], ['f3', 'Top 3 Flex', 3, 'flex'],
  ['f4', 'Top 4 Flex', 4, 'flex'], ['f5', 'Top 5 Flex', 5, 'flex'], ['f6', 'Top 6 Flex', 6, 'flex']];
const PICK_HIST_DAYS = 14;
const histTotals = () => Object.fromEntries(PICK_HIST_ENTRIES.map(([key, label, n, type]) => [key, { key, label, n, type, days: 0, won: 0, refunds: 0, units: 0 }]));
const histTotalsOut = (tot) => Object.values(tot).map((t) => ({ ...t, units: Math.round(t.units * 100) / 100, roi: t.days ? round1(t.units / t.days * 100) : null }));
// One day's entries from its legs, best chance first, counted into each of tots.
function histDayEntries(l, tots) {
  const entries = {};
  for (const [key, , n, type, min] of PICK_HIST_ENTRIES) {
    const top = (min ? l.filter((x) => x.p >= min) : l).slice(0, n);
    if (top.length < n || top.some((x) => x.result == null)) continue;
    if (top.some((x) => x.result !== 'hit' && x.result !== 'miss')) { for (const t of tots) t[key].refunds++; entries[key] = { refund: true, net: 0 }; continue; }
    const wins = top.filter((x) => x.result === 'hit').length;
    const pay = type === 'power' ? (wins === n ? PP_POWER[n] : 0) : ((PP_FLEX[n] || {})[wins] || 0);
    for (const t of tots) { t[key].days++; t[key].units += pay - 1; if (pay > 1) t[key].won++; }
    entries[key] = { wins, pay, net: Math.round((pay - 1) * 100) / 100 };
  }
  return entries;
}
// The entries are the PrizePicks pool's from its first logged day (2026-10-28,
// the owner's call): the list's top two were often moneylines PrizePicks does
// not take, so its units graded entries that could not be placed. The days
// before keep the list's own (listEntries), and the list's top-two count
// stays the list's (listTotals).
function pickHistory(rows, poolRows = []) {
  const byDay = new Map(), poolDay = new Map();
  for (const r of rows) { if (!byDay.has(r.date)) byDay.set(r.date, []); byDay.get(r.date).push(r); }
  for (const r of poolRows) { if (!poolDay.has(r.date)) poolDay.set(r.date, []); poolDay.get(r.date).push({ ...r, p: r.pool_p != null ? r.pool_p : r.p }); }
  const poolSince = poolDay.size ? [...poolDay.keys()].sort()[0] : null;
  const listAll = histTotals(), listBefore = histTotals(), pooled = histTotals();
  const legOut = (x) => ({ label: x.label, kind: x.kind, p: round1(x.p), first: x.first_p == null ? null : round1(x.first_p), result: x.result || null });
  const days = [];
  for (const date of [...new Set([...byDay.keys(), ...poolDay.keys()])].sort()) {
    const l = (byDay.get(date) || []).sort((a, b) => b.p - a.p);
    const fromPool = poolSince != null && date >= poolSince;
    let entries = histDayEntries(l, fromPool ? [listAll] : [listAll, listBefore]);
    let pool = null;
    if (fromPool) {
      const q = (poolDay.get(date) || []).sort((a, b) => b.p - a.p);
      entries = histDayEntries(q, [pooled]);
      pool = q.map(legOut);
    }
    const dec = l.filter((x) => x.result === 'hit' || x.result === 'miss');
    days.push({ date, hit: dec.filter((x) => x.result === 'hit').length, decided: dec.length, pending: l.filter((x) => x.result == null).length,
      legs: l.map(legOut), entries, ...(pool ? { pool } : {}) });
  }
  // Which way the market moved while each leg sat on the list (2026-10-22):
  // its first chance against its last before the start -- the close, with the
  // pre-start reads -- and how the legs that firmed and drifted then landed.
  // A move under a point is noise. Only legs logged since first_p was kept.
  const mv = { n: 0, sum: 0, rose: { n: 0, hit: 0 }, fell: { n: 0, hit: 0 }, flat: { n: 0, hit: 0 } };
  for (const r of rows) {
    if (r.first_p == null || r.p == null || (r.result !== 'hit' && r.result !== 'miss')) continue;
    const d = r.p - r.first_p;
    const b = d >= 1 ? mv.rose : d <= -1 ? mv.fell : mv.flat;
    mv.n++; mv.sum += d; b.n++; if (r.result === 'hit') b.hit++;
  }
  return {
    since: days.length ? days[0].date : null,
    payouts: { power: PP_POWER, flex: PP_FLEX },
    moved: mv.n ? { n: mv.n, avg: round1(mv.sum / mv.n), rose: mv.rose, fell: mv.fell, flat: mv.flat } : null,
    entries: histTotalsOut(poolSince ? pooled : listAll),
    ...(poolSince ? { entriesFrom: 'pool', poolSince, listEntries: histTotalsOut(listBefore) } : {}),
    listTotals: histTotalsOut(listAll),
    days: days.reverse().slice(0, PICK_HIST_DAYS),
  };
}

// The list's own record: legs it showed at first pitch or tip, graded. The
// top two "both landed" count is the Top 2 Power entry's, so the two never
// disagree (a day counts once both its top legs have graded).
async function dayPickRecord(db) {
  await ensureDayPickSchema(db);
  // One read for the list's rows and the entry pool's (2026-10-28).
  const both = (await db.prepare('SELECT date, kind, label, p, first_p, result, game_id, on_list, in_pool, pool_p FROM daypicks WHERE on_list = 1 OR in_pool = 1').all()).results || [];
  const all = both.filter((r) => r.on_list === 1);
  const rows = all.filter((r) => r.result != null);
  const dec = rows.filter((r) => r.result === 'hit' || r.result === 'miss');
  const hit = dec.filter((r) => r.result === 'hit').length;
  const history = pickHistory(all, both.filter((r) => r.in_pool === 1));
  // Beside each recent day, the legs that left the list before their start.
  const drops = await dayPickDrops(db, Date.now(), all).catch(() => []);
  for (const d of history.days) { const l = drops.filter((x) => x.date === d.date); if (l.length) d.dropped = l; }
  const p2 = history.listTotals.find((e) => e.key === 'p2');
  return {
    since: rows.length ? rows.map((r) => r.date).sort()[0] : null,
    legs: { n: dec.length, hit, hitRate: dec.length ? round1(hit / dec.length * 100) : null },
    voided: rows.filter((r) => r.result === 'void').length,
    top2: { days: p2.days, bothHit: p2.won },
    history,
  };
}

// The cron's share: keep the log current so a leg's state at its game's start
// is recorded even when nobody has the page open. No records read here.
async function dayPicksTick(env) {
  if (!env || !env.DB) return null;
  const now = Date.now();
  const { legs, unavailable } = await picksCandidates(env, now);
  await logDayPicks(env.DB, pickList(legs), unavailable, now, ppPoolOf(legs));
  await gradeDayPicks(env.DB, now);
  // The edge bets (2026-10-28): their log and grades, and a fresh read of the
  // prices behind any shown on an old one.
  try {
    const scan = await evScan(env, now);
    await logEdgeBets(env.DB, scan, now);
    await gradeEdgeBets(env.DB, now);
    await refreshEdgePrices(env, scan, now);
  } catch (e) { /* next tick */ }
  return null;
}

// Fresh prices behind the edge bets (2026-10-28). The captures read each
// league twice a day and 75 and 25 minutes before each start; a bet shown the
// night before rode the last of those for hours (FC Cincinnati's +410 was 21
// hours old). A bet whose price is over EDGE_STALE_MS old buys one read of its
// league -- 1 credit for the NBA or NHL, 2 for a soccer league, 3 for the NFL
// -- at most once per league per EDGE_REFRESH_GAP_MS and EDGE_REFRESH_MAX a
// day. Props are left to their own reads.
const EDGE_STALE_MS = 4 * 3600e3;
const EDGE_REFRESH_GAP_MS = 3 * 3600e3;
const EDGE_REFRESH_MAX = 8;
async function refreshEdgePrices(env, scan, now) {
  if (!env.ODDS_API_KEY) return [];
  const due = new Map();
  for (const b of scan.bets) {
    if (b.prop || !b.asOf || now - Date.parse(b.asOf) < EDGE_STALE_MS) continue;
    const lg = b.sport === 'soccer' ? b.league : b.sport;
    if (lg) due.set(`${b.sport}:${lg}`, { sport: b.sport, lg });
  }
  if (!due.size) return [];
  const key = `edge_fresh:${ptDateOf(now)}`;
  const hit = await loadFeedCache(env.DB, key);
  const st = (hit.present && hit.data) || { n: 0, last: {} };
  const done = [];
  for (const [k, x] of due) {
    if (st.n >= EDGE_REFRESH_MAX || (st.last[k] && now - st.last[k] < EDGE_REFRESH_GAP_MS)) continue;
    if (x.sport === 'soccer' && !SOCCER_LEAGUES[x.lg]) continue;
    st.n++; st.last[k] = now;
    await saveFeedCache(env.DB, key, st);   // before the read: a failed one is not retried every tick
    try {
      if (x.sport === 'nba') await h2hCapture(env, NBA_ML, 'reg');
      else if (x.sport === 'nhl') await h2hCapture(env, NHL_ML, 'reg');
      else if (x.sport === 'soccer') await soccerIngest(env, new URL(`https://x/api/soccer-ingest?league=${x.lg}`));
      else if (x.sport === 'nfl') { await ingestNflLines(env, { sport: 'nfl' }); await nflBoardData(env, null); }
      done.push(k);
    } catch (e) { /* counted; the next window tries again */ }
  }
  return done;
}

async function picksBoard(env) {
  const out = {
    note: 'LOGGED as shown. The legs most likely to land, across sports, one per game: for PrizePicks, which pays the same on every leg. '
      + 'Only kinds of leg whose stated chance has held up in the logs, at the bar where it held up.',
    asOf: new Date().toISOString(),
    rules: Object.fromEntries(Object.entries(PICK_KINDS).map(([k, v]) => [k, `${v.label}, ${v.min}%+`])),
    legs: [], qualifyingGames: 0, entries: [], kinds: {}, record: null,
  };
  if (!env || !env.DB) { out.error = 'no DB binding'; return out; }
  try {
    const now = Date.now();
    const { legs, unavailable } = await picksCandidates(env, now);
    const list = pickList(legs), pool = ppPoolOf(legs);
    // Soccer marks are read while the log is written, and waited on only so long.
    const logos = soccerPickLogos(list).catch(() => {});
    try { await logDayPicks(env.DB, list, unavailable, now, pool); } catch (e) { out.logError = String((e && e.message) || e); }
    try { await gradeDayPicks(env.DB, now); } catch (e) { /* next read */ }
    // The records are read apart from the list (2026-10-22): a database refusal
    // there (D1 answered one read "out of memory: SQLITE_NOMEM" at 23:56 Pacific)
    // took the whole list down with it. Now the legs stand without them.
    let kinds = {};
    try { kinds = await pickKindRecords(env); } catch (e) { out.recordError = String((e && e.message) || e); }
    let timer;
    await Promise.race([logos, new Promise((r) => { timer = setTimeout(r, SOC_LOGO_WAIT_MS); })]);
    clearTimeout(timer);
    out.kinds = Object.fromEntries(Object.entries(PICK_KINDS).map(([k, v]) => [k, { ...v, record: kinds[k] }]));
    out.qualifyingGames = new Set(legs.map((l) => l.gameKey)).size;
    if (unavailable.size) out.unavailable = [...unavailable];
    // Each leg's first chance on the list, for how far it has moved since.
    const firsts = new Map();
    try {
      const ids = list.map((l) => l.legId);
      if (ids.length) {
        const fr = (await env.DB.prepare(`SELECT leg_id, first_p, first_at FROM daypicks WHERE date IN (?, ?) AND leg_id IN (${ids.map(() => '?').join(',')})`)
          .bind(ptDateOf(now), ptDateOf(now + 86400e3), ...ids).all()).results || [];
        for (const r of fr) if (r.first_p != null) firsts.set(r.leg_id, r);
      }
    } catch (e) { /* the list stands without it */ }
    const shown = (l, i) => ({
      rank: i + 1, kind: l.kind, sport: PICK_KINDS[l.kind].sport, kindLabel: PICK_KINDS[l.kind].label,
      p: round1(l.p), title: l.title, sub: l.sub, commence: l.commence, odds: l.odds == null ? null : l.odds,
      lineup: l.lineup || null, vsBook: l.vsBook == null ? null : l.vsBook, league: l.league || null,
      firstP: firsts.has(l.legId) ? round1(firsts.get(l.legId).first_p) : null, firstAt: firsts.has(l.legId) ? firsts.get(l.legId).first_at : null,
      record: kinds[l.kind], legId: l.legId, spec: l.spec,
      ...(l.dfs ? { dfs: l.dfs } : {}),
      ...(l.sharp != null ? { sharp: l.sharp } : {}),
      // Its edge at the best price, and the quarter-Kelly stake (legStake),
      // a prop's capped at PROP_STAKE_CAP.
      ...legStake(l.p, l.odds, kinds[l.kind], PROP_KINDS.has(l.kind) ? PROP_STAKE_CAP : null),
      ...(l.modelP != null ? { modelP: l.modelP } : {}),
      // His projection, for the bar under a player leg (2026-10-28).
      ...(l.proj != null ? { proj: l.proj } : {}),
    });
    out.legs = list.map(shown);
    out.ppPool = pool.map(shown);
    const inPool = new Set(pool.map((l) => l.legId));
    for (const l of out.legs) l.ppOk = inPool.has(l.legId);
    // The entry read: the top two as a 2-pick power (both have to land), and
    // the average leg of the top three to six against the flex break-even --
    // over that pool.
    const ppLegs = out.ppPool;
    for (let n = 2; n <= ppLegs.length; n++) {
      const top = ppLegs.slice(0, n);
      const [name, be] = PICKS_BREAK_EVEN[n];
      out.entries.push({ legs: n, entry: name, perLegBreakEven: be,
        avgLeg: round1(top.reduce((a, x) => a + x.p, 0) / n),
        allLand: round1(top.reduce((a, x) => a * x.p / 100, 1) * 100),
        // At PrizePicks' payouts, on each leg's Kelly chance (entryStake).
        ...entryStake(top.map((x) => (x.kellyP != null ? x.kellyP : x.p) / 100), n === 2 ? 'power' : 'flex') });
    }
    // Prices that beat the sharp line, wherever they are (evBets), and Pick6
    // lines the market has moved past (pickemEdges).
    // Logged as shown, graded, and their record beside them (2026-10-28).
    try {
      const scan = await evScan(env, now);
      out.evBets = scan.bets.map(evShown);
      try { await logEdgeBets(env.DB, scan, now); await gradeEdgeBets(env.DB, now); } catch (e) { out.logError = String((e && e.message) || e); }
    } catch (e) { out.evBets = []; out.evError = String((e && e.message) || e); }
    try { out.edgeRecord = await edgeBetRecord(env); } catch (e) { out.recordError = String((e && e.message) || e); }
    try { out.pickemEdges = await pickemEdges(env, now); } catch (e) { out.pickemEdges = []; out.evError = String((e && e.message) || e); }
    try { out.record = await dayPickRecord(env.DB); } catch (e) { out.recordError = String((e && e.message) || e); }
  } catch (e) { out.error = String((e && e.message) || e); }
  return out;
}

async function bpicksExport(env, url) {
  if (!env || !env.DB) return cors(json({ error: 'env.DB not configured' }, 30));
  const market = (url.searchParams.get('market') || '').toLowerCase();
  const ver = url.searchParams.get('ver') || BATTER_MODEL_VER;
  // k = pitcher strikeout props, from the `picks` table: same pricing fields,
  // with actual_k as the actual and pitcher_id as the player.
  if (market === 'k') {
    try {
      await ensureSchema(env.DB);
      const kv = url.searchParams.get('ver') || K_MODEL_VER;
      const cols = ['date', 'line', 'side', 'price', 'proj', 'model_over', 'entry_over', 'tier', 'result', 'fair_src', 'actual', 'game_id', 'team', 'player_id', 'edge'];
      const rows = (await env.DB.prepare(
        `SELECT date, line, side, price, proj, model_over, entry_over, tier, result, fair_src, actual_k AS actual, game_id, team, pitcher_id AS player_id, edge
           FROM picks WHERE model_ver = ? AND result IN ('win','loss') ORDER BY date`
      ).bind(kv).all()).results || [];
      return cors(json({
        market, ver: kv, n: rows.length, cols, rows: rows.map((r) => cols.map((c) => r[c])),
        lineShrink: LINE_SHRINK, dispersion: DISPERSION, tiers: [5, 3, 1.5],
      }, 600));
    } catch (e) {
      return cors(json({ error: String((e && e.message) || e) }, 30));
    }
  }
  if (!/^(hrr|tb|hr)$/.test(market)) return cors(json({ error: 'market must be hrr, tb, hr or k' }, 30));
  try {
    await ensureBatterSchema(env.DB);
    // game_id / team / player_id let a replay join outside data (game totals,
    // weather, bullpen) to the rows; the rest is what the pricing needs.
    const cols = ['date', 'line', 'side', 'price', 'proj', 'model_over', 'entry_over', 'tier', 'result', 'fair_src', 'actual', 'game_id', 'team', 'player_id', 'impl_runs'];
    const rows = (await env.DB.prepare(
      `SELECT ${cols.join(', ')} FROM bpicks
        WHERE market = ? AND model_ver = ? AND result IN ('win','loss')
        ORDER BY date`
    ).bind(market, ver).all()).results || [];
    return cors(json({
      market, ver, n: rows.length, cols,
      rows: rows.map((r) => cols.map((c) => r[c])),
      calibrationInForce: BATTER_PROJ_CAL[market],
      dispersion: BATTER_DISPERSION[market],
      shrink: BATTER_SHRINK,
      evGate: BATTER_EV_GATE,
    }, 600));
  } catch (e) {
    return cors(json({ error: String((e && e.message) || e) }, 30));
  }
}

// /api/mlpicks-export — every graded moneyline row, compact, for offline review.
// Same reasoning as bpicks-export: a question about what the moneyline record is
// made of (Pinnacle-priced vs not, favourite vs dog, entry vs close) needs the
// rows, not a summary written before the question existed. Read-only, graded
// rows only, positional columns.
async function mlpicksExport(env, url) {
  if (!env || !env.DB) return cors(json({ error: 'env.DB not configured' }, 30));
  try {
    await ensureMlPickSchema(env.DB);
    const cols = ['date', 'game_id', 'team', 'opp', 'is_home', 'tier', 'win_prob', 'edge', 'entry_price', 'close_price', 'result', 'team_score', 'opp_score', 'model_ver', 'fair_source',
      'entry_win_prob', 'entry_edge', 'entry_tier', 'entry_fair_source', 'entry_at', 'posted_at', 'posted_price', 'posted_win_prob', 'posted_edge', 'posted_tier', 'close_at',
      'close_fair', 'close_fair_source'];
    // ?date=YYYY-MM-DD: one day's graded picks. The whole log is ~100KB, more
    // than a scheduled check can read in one go.
    const date = url && url.searchParams ? String(url.searchParams.get('date') || '').trim() : '';
    const oneDay = /^\d{4}-\d{2}-\d{2}$/.test(date);
    const rows = (await env.DB.prepare(
      `SELECT ${cols.join(', ')} FROM mlpicks WHERE result IN ('win','loss')${oneDay ? ' AND date = ?' : ''} ORDER BY date`
    ).bind(...(oneDay ? [date] : [])).all()).results || [];
    return cors(json({ n: rows.length, cols, rows: rows.map((r) => cols.map((c) => r[c])) }, 600));
  } catch (e) {
    return cors(json({ error: String((e && e.message) || e) }, 30));
  }
}

async function batterDebug(env) {
  if (!env || !env.DB) return cors(json({ error: 'env.DB not configured' }, 30));
  try {
    await ensureBatterSchema(env.DB);
    const bres = await env.DB.prepare('SELECT * FROM bpicks').all();
    const graded = (bres.results || []).filter((r) => r.result === 'win' || r.result === 'loss');
    const unders = graded.filter((r) => r.side === 'Under');
    const overs = graded.filter((r) => r.side === 'Over');

    // True when entry and close were priced off the same book tier.
    // close_src only exists on rows logged after that column was added, so an
    // absent value means "cannot verify" rather than "mismatched" — those rows
    // are still counted, because dropping them would silently delete every
    // sharp-era pick logged before the guard shipped. entryVsCloseTier reports
    // the unverified share separately so it never passes as confirmed.
    const sameTier = (r) => !r.close_src || (r.fair_src || null) === r.close_src;
    const clvOf = (r) => {
      if (r.close_over == null || r.entry_over == null) return null;
      if (r.close_line != null && r.line != null && r.close_line !== r.line) return null;
      if (!sameTier(r)) return null; // sharp-in / DK-out is a book gap, not movement
      return (r.side === 'Over' ? (r.close_over - r.entry_over) : (r.entry_over - r.close_over)) * 100;
    };
    // EV of the price we actually took, evaluated at the closing fair
    // probability. clvOf says the line moved our way; this says whether the
    // NUMBER we got was +EV against where the market settled. The two disagree
    // on heavy favourites, where a 0.2pt probability move is worth almost
    // nothing at -250 — which is exactly the shape of a batter under.
    const clvEvOf = (r) => {
      if (r.close_over == null || r.price == null || !r.side) return null;
      if (r.close_line != null && r.line != null && r.close_line !== r.line) return null;
      if (!sameTier(r)) return null; // closing fair must come from the entry tier
      const pClose = r.side === 'Over' ? r.close_over : 1 - r.close_over;
      if (!(pClose > 0) || !(pClose < 1)) return null;
      return (pClose * (payoutMult(r.price) + 1) - 1) * 100;
    };
    // Significance. A mean with no error bar can't be read: +13.6% ROI over 516
    // picks and +13.6% over 20 are different claims, and avgCLV near zero could
    // be a true zero or an underpowered real effect. t = mean / (sd/sqrt(n)),
    // two-tailed p via the normal approximation (fine at these sample sizes).
    const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
    const sdev = (xs) => {
      if (xs.length < 2) return null;
      const m = mean(xs);
      return Math.sqrt(xs.reduce((s, x) => s + (x - m) * (x - m), 0) / (xs.length - 1));
    };
    const tStat = (xs) => {
      if (!xs || xs.length < 2) return null;
      const s = sdev(xs);
      // Epsilon, not >0: an all-identical slice leaves float dust rather than a
      // clean zero and would divide out to a spuriously enormous t.
      return (s != null && s > 1e-9) ? mean(xs) / (s / Math.sqrt(xs.length)) : null;
    };
    const pTwo = (t) => (t == null || !isFinite(t)) ? null : Math.round(2 * (1 - normCdf(Math.abs(t))) * 1e4) / 1e4;
    const r2 = (v) => v == null || !isFinite(v) ? null : Math.round(v * 100) / 100;

    const summarize = (arr) => {
      const n = arr.length; if (!n) return { n: 0 };
      let w = 0;
      const profits = [], clvs = [], evs = [];
      for (const r of arr) {
        if (r.result === 'win') w++;
        profits.push(profitUnits(r.result, r.price));
        const c = clvOf(r); if (c != null) clvs.push(c);
        const e = clvEvOf(r); if (e != null) evs.push(e);
      }
      const u = profits.reduce((s, x) => s + x, 0);
      const tRoi = tStat(profits), tClv = tStat(clvs);
      return {
        n, record: `${w}-${n - w}`, winRate: round1(w / n * 100), roi: round1(u / n * 100), units: round1(u),
        avgCLV: clvs.length ? round1(mean(clvs)) : null,
        // Mean EV% per unit staked, priced at the close. Negative = the number
        // we took was worse than the closing fair, however the line moved.
        avgClvEv: evs.length ? round1(mean(evs)) : null,
        sig: {
          roiT: r2(tRoi), roiP: pTwo(tRoi),
          clvN: clvs.length, clvT: r2(tClv), clvP: pTwo(tClv),
        },
      };
    };
    const groupBy = (arr, keyFn) => {
      const m = {};
      for (const r of arr) { const k = keyFn(r); if (k == null || k === '') continue; (m[k] = m[k] || []).push(r); }
      return m;
    };

    const monthMap = groupBy(unders, (r) => String(r.date || '').slice(0, 7));
    const byMonth = Object.keys(monthMap).sort().map((k) => ({ month: k, ...summarize(monthMap[k]) }));

    const priceLabel = (p) => {
      if (p == null) return null;
      if (p <= -140) return '<= -140';
      if (p <= -115) return '-139..-115';
      if (p <= 105) return '-114..+105';
      if (p <= 140) return '+106..+140';
      return '+141+';
    };
    const priceMap = groupBy(unders, (r) => priceLabel(r.price));
    const priceOrder = ['<= -140', '-139..-115', '-114..+105', '+106..+140', '+141+'];
    const byPrice = priceOrder.filter((k) => priceMap[k]).map((k) => ({ price: k, ...summarize(priceMap[k]) }));

    // ROI bucketed by the model's own win probability — the missing third of the
    // "which sort surfaces winners?" question. byTier answers it for Edge and
    // byPrice for Odds, but Model P / Win Prob had only a calibration curve,
    // which measures whether the probability is ACCURATE, not whether sorting by
    // it makes money. Those are different: a perfectly calibrated probability
    // sorted high just surfaces favourites, which win often and pay little.
    //
    // Read it against byPrice. With BATTER_SHRINK at 0.25 the model probability
    // is three-quarters market fair, so these buckets track the price closely and
    // the two tables should tell nearly the same story. Where they diverge is the
    // quarter of the number the model actually contributes.
    const probLabel = (r) => {
      if (r.model_over == null || !r.side) return null;
      const p = r.side === 'Over' ? r.model_over : 100 - r.model_over;
      if (!(p > 0) || !(p < 100)) return null;
      if (p < 45) return '<45%';
      if (p < 50) return '45-50%';
      if (p < 55) return '50-55%';
      if (p < 60) return '55-60%';
      if (p < 65) return '60-65%';
      return '65%+';
    };
    const probMap = groupBy(unders, probLabel);
    const probOrder = ['<45%', '45-50%', '50-55%', '55-60%', '60-65%', '65%+'];
    const byModelProb = probOrder.filter((k) => probMap[k]).map((k) => ({ modelProb: k, ...summarize(probMap[k]) }));

    // Both sides, matching the field name. This was built from `unders` alone,
    // which made byMarket.HRR byte-identical to the HRR Under row in
    // byMarketSide while reading like a both-sides blend — a -17.9% Over slice
    // sat inside a market the summary showed as positive. The unders-only view
    // is still available in byMarketSide, so nothing is lost by making the name
    // honest. Same filter as msMap: K lives in its own table and is never mixed.
    // Does tier actually rank? The pooled tierBreakdown on /api/track-record
    // mixes three markets whose ROIs run 0% / -16.9% / -19.4%, so its tier
    // ordering is dominated by which market happens to sit in which tier — a
    // mixing artifact, not a property of the tiers. This slice is the POSTED
    // product alone (batter unders, pass excluded), which is the only place the
    // question means anything.
    const posted = unders.filter((r) => r.tier !== 'pass');

    // byModelProb restricted to POSTED picks. The unrestricted table showed ROI
    // falling as model probability rises, with the <45% bucket a large positive
    // outlier — but it counts every graded under, including pass-tier rows the
    // board never recommended. If the effect lives only in the pass rows it is a
    // property of what the model already rejects, not something a sort on the
    // posted board could ever capture. This is the split that tells them apart.
    //
    // Read the two together: a bucket whose posted ROI collapses toward zero
    // while its all-unders ROI stayed high was carried by picks nobody could
    // have bet.
    const probMapPosted = groupBy(posted, probLabel);
    const byModelProbPosted = probOrder.filter((k) => probMapPosted[k])
      .map((k) => ({ modelProb: k, ...summarize(probMapPosted[k]) }));
    // Same question for price, for the same reason — byPrice is also all-unders.
    const pricePostedMap = groupBy(posted, (r) => priceLabel(r.price));
    const byPricePosted = priceOrder.filter((k) => pricePostedMap[k])
      .map((k) => ({ price: k, ...summarize(pricePostedMap[k]) }));

    // Price band x MARKET and price band x ERA, posted plays only.
    //
    // These exist to attack a specific result rather than to browse. The
    // -114..+105 band came back at -12.4% ROI on the posted board while every
    // other band was break-even or better, and that bucket was picked AFTER
    // seeing the numbers — which is exactly how a curve-fitted filter gets
    // born. One lucky slice shows up in one cell; a real effect shows up in
    // BOTH markets and BOTH pricing eras. If it only lives in one, it is noise
    // wearing a p-value.
    //
    // Cells under 20 picks are dropped: at that size ROI is dominated by a
    // handful of results and reading a sign off it is self-deception.
    const crossPrice = (keyFn, label) => {
      const m = groupBy(posted, (r) => `${priceLabel(r.price)}|${keyFn(r)}`);
      return Object.keys(m)
        .map((k) => {
          const i = k.indexOf('|');
          return { price: k.slice(0, i), [label]: k.slice(i + 1), ...summarize(m[k]) };
        })
        .filter((x) => x.n >= 20)
        .sort((a, b) => priceOrder.indexOf(a.price) - priceOrder.indexOf(b.price)
          || String(a[label]).localeCompare(String(b[label])));
    };
    const byPriceMarket = crossPrice((r) => String(r.market || '?').toUpperCase(), 'market');
    const byPriceEra = crossPrice((r) => r.model_ver || 'dk-fair', 'era');
    // The counterfactual the split is really asking about. REPORTED, NOT
    // APPLIED: no filter is in force, and it should not become one until the
    // two splits above say the effect is real in both markets and both eras.
    const byPriceExclNearEven = {
      ...summarize(posted.filter((r) => priceLabel(r.price) !== '-114..+105')),
      note: 'posted plays EXCLUDING the -114..+105 band — a counterfactual, not a live filter',
    };

    const tierMap = groupBy(posted, (r) => String(r.tier || '?'));
    const byTier = ['1', '2', '3'].filter((k) => tierMap[k])
      .map((k) => ({ tier: k, ...summarize(tierMap[k]) }));
    // Ranking verdict. Monotone ROI is necessary but not sufficient: with these
    // sample sizes an ordering can look clean and still be noise, so T1 vs T3 is
    // tested directly rather than eyeballed.
    const tierVerdict = (() => {
      if (byTier.length < 2) return 'too few tiers graded to say.';
      const rois = byTier.map((t) => t.roi);
      const mono = rois.every((v, i) => i === 0 || rois[i - 1] >= v);
      const t1 = byTier[0], t3 = byTier[byTier.length - 1];
      // Two-proportion z on win rate is the wrong test here (prices differ per
      // tier); compare ROI via the same t on per-pick returns summarize() uses.
      const sep = (t1.sig && t3.sig && t1.sig.roiP != null && t3.sig.roiP != null)
        ? `T${t1.tier} roiP ${t1.sig.roiP}, T${t3.tier} roiP ${t3.sig.roiP}`
        : 'no p-values available';
      if (!mono) return `NOT monotone — ROI does not fall with tier (${rois.join(', ')}). Tier is not ranking these picks. ${sep}.`;
      const anySig = byTier.some((t) => t.sig && t.sig.roiP != null && t.sig.roiP < 0.05);
      return anySig
        ? `Monotone (${rois.join(' > ')}) and at least one tier clears p<0.05. Tier is ranking. ${sep}.`
        : `Monotone (${rois.join(' > ')}) but NO tier is distinguishable from zero, so the ordering is not yet evidence that tier ranks. ${sep}.`;
    })();

    // Where the tier cutoffs actually fall. Choosing a T1 threshold needs the
    // edge distribution of the picks it will select, and that was never exposed
    // — the cutoff could only be set by interpolating between tier counts.
    // Split by era because the eras disagree materially about how much edge the
    // model finds, and only the current one governs picks logged from here on.
    const edgeDistribution = (() => {
      const withEdge = posted.filter((r) => r.edge != null && isFinite(r.edge));
      if (!withEdge.length) return { n: 0, note: 'no graded posted picks carry an edge value.' };
      const CUTS = [3, 4, 5, 5.5, 6, 6.5, 7, 8];
      const shareAt = (rows) => CUTS.map((c) => {
        const n = rows.filter((r) => r.edge >= c).length;
        return { cutoff: c, n, pct: round1(n / rows.length * 100) };
      });
      const quantiles = (rows) => {
        const s = rows.map((r) => r.edge).sort((a, b) => a - b);
        const at = (p) => s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))];
        return { p50: at(0.5), p75: at(0.75), p80: at(0.8), p90: at(0.9), p95: at(0.95), max: s[s.length - 1] };
      };
      const eraMapE = groupBy(withEdge, (r) => r.model_ver || 'dk-fair');

      // ---- EV% views -------------------------------------------------------
      // Tiers are moving to EV%, and an edge-point quantile does NOT convert to
      // an EV% quantile by any fixed factor: EV% = edge_points / implied_prob,
      // and implied_prob varies per row, so the two orderings genuinely differ
      // across the price range. A cutoff read off the edge-point quantiles above
      // would be in the wrong units.
      //
      // Derivation. Staking 1u at American price P with vig-inclusive implied
      // probability q = amProb(P), a true win probability p returns
      //   EV = p*(1/q) - 1 = (p - q)/q
      // so EV% = 100 * (p - q)/q. Both views below use that, differing only in
      // what stands in for p:
      //
      //   modelEv  — p = the shrunk model probability (today's selecting number,
      //              restated in EV terms so old and new tiers are comparable)
      //   priceEv  — p = the SHARP FAIR probability. This is exactly the
      //              price_edge the refactor will select on, computable today
      //              because entry_over already stores the fair at log time.
      //              Expect most rows to be NEGATIVE: paying a vigged price
      //              against a fair line is -EV unless the book is genuinely off,
      //              which is the point — it is a far stricter filter than the
      //              model edge, and this distribution is what the new cutoffs
      //              should be derived from.
      const sideProb = (r, pOver) => (r.side === 'Over' ? pOver : 1 - pOver);
      const evOf = (r, pOver) => {
        if (pOver == null || !isFinite(pOver) || r.price == null) return null;
        const q = amProb(r.price);
        if (!(q > 0) || !(q < 1)) return null;
        const p = sideProb(r, pOver);
        if (!(p > 0) || !(p < 1)) return null;
        return 100 * (p - q) / q;
      };
      const modelEv = (r) => evOf(r, r.model_over == null ? null : r.model_over / 100);
      const priceEv = (r) => evOf(r, r.entry_over == null ? null : r.entry_over);

      const EV_CUTS = [-2, -1, 0, 1, 2, 3, 5, 7.5];
      const evBlock = (rows, fn, label) => {
        const vals = rows.map(fn).filter((v) => v != null && isFinite(v)).sort((a, b) => a - b);
        if (!vals.length) return { n: 0, note: `no rows carry the inputs for ${label}.` };
        const at = (p) => Math.round(vals[Math.min(vals.length - 1, Math.floor((vals.length - 1) * p))] * 100) / 100;
        return {
          n: vals.length,
          quantiles: { p10: at(0.1), p50: at(0.5), p75: at(0.75), p90: at(0.9), p95: at(0.95), max: Math.round(vals[vals.length - 1] * 100) / 100 },
          shareAtCutoff: EV_CUTS.map((c) => {
            const n = vals.filter((v) => v >= c).length;
            return { cutoff: c, n, pct: round1(n / vals.length * 100) };
          }),
        };
      };
      const evByEra = (fn) => Object.keys(eraMapE).map((k) => ({ era: k, ...evBlock(eraMapE[k], fn, 'ev') }))
        .sort((a, b) => b.n - a.n);

      return {
        n: withEdge.length,
        activeTiers: BATTER_TIERS,
        units: 'edge points (probability points); see evPct / priceEdgeEvPct for the EV% views',
        overall: { n: withEdge.length, quantiles: quantiles(withEdge), shareAtCutoff: shareAt(withEdge) },
        byEra: Object.keys(eraMapE).map((k) => ({
          era: k, n: eraMapE[k].length,
          quantiles: quantiles(eraMapE[k]),
          shareAtCutoff: shareAt(eraMapE[k]),
        })).sort((a, b) => b.n - a.n),
        // Today's selecting edge, restated as EV% at the price actually taken.
        evPct: { basis: 'model probability vs price taken', overall: evBlock(withEdge, modelEv, 'modelEv'), byEra: evByEra(modelEv) },
        // The refactor's selecting number, measurable now.
        priceEdgeEvPct: { basis: 'sharp fair (entry_over) vs price taken — the post-refactor price_edge', overall: evBlock(withEdge, priceEv, 'priceEv'), byEra: evByEra(priceEv) },
        note: `T1 cutoff is ${BATTER_TIERS[0]} in EDGE POINTS. Read shareAtCutoff for the CURRENT era (${BATTER_MODEL_VER}) — that is the rate T1 fills at. Tier is stamped at log time, so changing a cutoff never relabels rows above. When moving tiers to EV%, derive from priceEdgeEvPct, not from the edge-point quantiles.`,
      };
    })();

    // Calibration for the posted product: the model's claimed win probability
    // against what actually happened. A slope of 1 through the diagonal means
    // calibrated; a slope near 0 means the probabilities carry no information
    // about outcomes, which makes every tier cutoff derived from them arbitrary.
    const calibration = calibrationCurve(posted);
    // Same question aimed at the market rather than the model: does the sharp
    // fair predict outcomes? Decides whether the pricing refactor is buildable.
    const fairCalibration = fairEvCalibration(posted);

    const marketMap = groupBy(graded, (r) => {
      const m = String(r.market || '').toUpperCase();
      return (!m || m === 'K') ? null : m;
    });
    const byMarket = Object.keys(marketMap).map((k) => ({ market: k, ...summarize(marketMap[k]) })).sort((a, b) => b.n - a.n);
    // Kept explicitly rather than left implicit: the posted product is unders,
    // so the unders-only market split is worth reading directly, and naming it
    // is what stops byMarket from quietly meaning this again.
    const undersMap = groupBy(unders, (r) => String(r.market || '').toUpperCase());
    const byMarketUnder = Object.keys(undersMap).map((k) => ({ market: k, ...summarize(undersMap[k]) })).sort((a, b) => b.n - a.n);

    // Strikeouts live in `picks`, a different table and a different experiment.
    // Reported here beside the batter numbers but never merged into them, so a
    // sharp-shin verdict is never one market carrying another.
    let kBlock = { note: 'pitcher strikeouts — separate experiment, never blended with batter rows' };
    try {
      await ensureSchema(env.DB);
      const kres = await env.DB.prepare('SELECT * FROM picks').all();
      const kGraded = (kres.results || []).filter((r) => r.result === 'win' || r.result === 'loss');
      const kMap = groupBy(kGraded, (r) => `${r.model_ver || 'consensus-era'}|${r.side || '?'}`);
      kBlock.byModelVerSide = Object.keys(kMap).map((k) => {
        const [modelVer, side] = k.split('|');
        return { modelVer, side, ...summarize(kMap[k]) };
      }).sort((a, b) => b.n - a.n);
      const kSrc = groupBy(kres.results || [], (r) => r.fair_src || 'untagged');
      kBlock.fairSourceMix = Object.keys(kSrc).map((k) => ({ fairSrc: k, n: kSrc[k].length })).sort((a, b) => b.n - a.n);
    } catch (e) { kBlock.error = String(e && e.message || e); }

    const sorted = [...unders].sort((a, b) => String(a.date).localeCompare(String(b.date)));
    let cum = 0; const cumByDate = {};
    for (const r of sorted) { cum += profitUnits(r.result, r.price); cumByDate[r.date] = round1(cum); }
    const cumulative = Object.keys(cumByDate).sort().map((d) => ({ date: d, units: cumByDate[d] }));

    // Signed projection bias per batter market (ALL graded picks, both sides):
    // +avgProjMinusActual = model projects too HIGH -> the correction magnitude
    // to subtract from the projection so overs stop being manufactured.
    const biasMap = groupBy(graded.filter((r) => r.proj != null && r.actual != null), (r) => String(r.market || '').toUpperCase());
    const projBiasByMarket = Object.keys(biasMap).map((m) => {
      const arr = biasMap[m];
      const avg = arr.reduce((s, r) => s + (r.proj - r.actual), 0) / arr.length;
      const avgProj = arr.reduce((s, r) => s + r.proj, 0) / arr.length;
      const avgActual = arr.reduce((s, r) => s + r.actual, 0) / arr.length;
      // 2dp, not 1dp: BATTER_PROJ_CAL is re-derived from actual/proj, and at 1dp
      // a ratio like 1.8/1.4 is only pinned to 1.12-1.28 — a 13-point spread in
      // the constant. The extra digit is what makes the re-derivation decidable.
      return { market: m, n: arr.length, avgProj: round2(avgProj), avgActual: round2(avgActual), avgProjMinusActual: round2(avg) };
    }).sort((a, b) => b.n - a.n);

    // Same bias, sliced by week, so a shift can be seen rather than inferred
    // from a single moving average. The negative-binomial switch should pull
    // avgProjMinusActual toward 0; if it does not, the residual is in lambda
    // itself and BATTER_PROJ_CAL is the next thing to re-derive.
    const isoWeek = (d) => {
      const t = new Date(String(d) + 'T00:00:00Z');
      if (isNaN(t)) return null;
      const day = (t.getUTCDay() + 6) % 7;            // Mon=0
      t.setUTCDate(t.getUTCDate() - day + 3);          // nearest Thursday
      const firstThu = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
      const fday = (firstThu.getUTCDay() + 6) % 7;
      firstThu.setUTCDate(firstThu.getUTCDate() - fday + 3);
      return `${t.getUTCFullYear()}-W${String(1 + Math.round((t - firstThu) / 604800000)).padStart(2, '0')}`;
    };
    const bwMap = groupBy(graded.filter((r) => r.proj != null && r.actual != null),
      (r) => { const w = isoWeek(r.date); return w ? `${String(r.market || '?').toUpperCase()}|${w}` : null; });
    const projBiasByWeek = Object.keys(bwMap).map((k) => {
      const [market, week] = k.split('|');
      const arr = bwMap[k];
      return {
        market, week, n: arr.length,
        avgProj: round2(arr.reduce((s, r) => s + r.proj, 0) / arr.length),
        avgActual: round2(arr.reduce((s, r) => s + r.actual, 0) / arr.length),
        avgProjMinusActual: round2(arr.reduce((s, r) => s + (r.proj - r.actual), 0) / arr.length),
      };
    }).sort((a, b) => a.market.localeCompare(b.market) || a.week.localeCompare(b.week));

    // Suggested BATTER_PROJ_CAL per market, so the split is tuned from measured
    // bias rather than by hand. k = actual/proj on the CURRENT pricing era only:
    // weeks priced under an older constant describe a model that no longer runs,
    // and blending them in drags the suggestion toward a correction already made.
    //
    // 85% of the measured gap, matching the caution used every time this constant
    // has moved — the estimate is unstable while a week is only part graded, and
    // under-correcting is recoverable in a way that oscillating is not.
    //
    // Declared here, after projBiasByWeek, and not beside the other posted-only
    // blocks: it reads that array, and a `const` referenced above its declaration
    // throws at runtime rather than being hoisted.
    // Measured on rows priced by the model version now running, NOT by week.
    // It used to select weeks from 2026-W33 on, which was right while every one
    // of those weeks ran at the constant in force. The 2026-09-17 H+R+RBI change
    // (1.00 -> 1.11) broke that: the suggestion multiplies the measured k by the
    // CURRENT constant, so a month of rows projected at 1.00 would have been read
    // as though projected at 1.11, and it would have recommended ~1.25 — an
    // over-correction of half again, on the next read, from nothing new.
    //
    // model_ver is stamped on every row at log time and bumped whenever pricing
    // changes, so it is exactly the "rows this constant produced" boundary a week
    // number only approximated. Until the new version has graded rows the report
    // says so instead of falling back to the old ones.
    const projCalSuggest = (() => {
      const out = { basis: `graded rows logged under ${BATTER_MODEL_VER} (the constants now in force)`, current: BATTER_PROJ_CAL, markets: [] };
      const cur = graded.filter((r) => (r.model_ver || null) === BATTER_MODEL_VER && r.proj > 0 && r.actual != null);
      for (const [mk, key] of [['HRR', 'hrr'], ['TB', 'tb']]) {
        const arr = cur.filter((r) => r.market === key);
        const n = arr.length;
        if (!n) { out.markets.push({ market: mk, n: 0, current: BATTER_PROJ_CAL[key], note: `no graded rows under ${BATTER_MODEL_VER} yet — nothing to re-derive from` }); continue; }
        const sumP = arr.reduce((s2, r) => s2 + r.proj, 0), sumA = arr.reduce((s2, r) => s2 + r.actual, 0);
        const k = sumA / sumP;
        const c = BATTER_PROJ_CAL[key];
        out.markets.push({
          market: mk, n,
          avgProj: round2(sumP / n),
          avgActual: round2(sumA / n),
          k: round2(k),
          current: c,
          suggestedFull: round2(c * k),
          suggestedAt85: round2(c * (1 + 0.85 * (k - 1))),
          direction: k > 1.005 ? 'raise (under-projecting)' : k < 0.995 ? 'lower (over-projecting)' : 'hold',
          // A week that is one graded day is a direction, not a value.
          confidence: n < 300 ? 'LOW — too few graded rows to set a value; read as direction only' : 'usable',
        });
      }
      const dirs = new Set(out.markets.filter((m) => m.n).map((m) => (m.k > 1 ? 'up' : 'down')));
      out.verdict = dirs.size > 1
        ? 'Markets need corrections in OPPOSITE directions — this is why the constant is split. Do not average them.'
        : 'Markets agree in direction; a shared constant would still work, but the split costs nothing.';
      return out;
    })();

    // Era split. Rows logged before the sharp-fair cutover carry model_ver NULL
    // and priced their edge against DraftKings — the same book the bet lands at,
    // so the "edge" was self-referential and CLV had nothing to converge on.
    // Comparing the two eras (especially avgCLV) is the whole point of tagging.
    const eraMap = groupBy(unders, (r) => r.model_ver || 'dk-fair');
    const byModelVer = Object.keys(eraMap).map((k) => ({ modelVer: k, ...summarize(eraMap[k]) })).sort((a, b) => b.n - a.n);
    // Era x MARKET. TB and H+R+RBI are separate experiments with separate
    // distributions and separate sharp coverage, so a single blended sharp-shin
    // verdict can hide one carrying the other.
    const emMap = groupBy(unders, (r) => `${r.model_ver || 'dk-fair'}|${String(r.market || '?').toUpperCase()}`);
    const byModelVerMarket = Object.keys(emMap).map((k) => {
      const [modelVer, market] = k.split('|');
      return { modelVer, market, ...summarize(emMap[k]) };
    }).sort((a, b) => a.modelVer.localeCompare(b.modelVer) || b.n - a.n);
    // Which fair tier actually produced each pick's line. If 'sharp' is a small
    // share, the sharp books simply aren't quoting our lines and the refactor is
    // only partly live — read this before reading any CLV number below.
    const srcMap = groupBy((bres.results || []).filter((r) => r.side === 'Under'), (r) => r.fair_src || 'untagged');
    const fairSourceMix = Object.keys(srcMap).map((k) => ({ fairSrc: k, n: srcMap[k].length })).sort((a, b) => b.n - a.n);

    // How often a row entered on one book tier and closed on another. Those are
    // dropped from CLV (the difference would be a book gap, not movement), so
    // this is the count of picks CLV can no longer see. A large share here means
    // the sharp books are pulling before first pitch and the CLV sample is being
    // silently thinned — read it before trusting any clvP below.
    const tierMix = {};
    for (const r of (bres.results || [])) {
      if (r.close_over == null || r.entry_over == null) continue;
      const k = `${r.fair_src || 'untagged'} -> ${r.close_src || 'untagged'}`;
      tierMix[k] = (tierMix[k] || 0) + 1;
    }
    const entryVsCloseTier = Object.keys(tierMix)
      .map((k) => {
        const [from, to] = k.split(' -> ');
        // Three states, not two: confirmed same tier, confirmed different (these
        // are dropped from CLV), and unverified — logged before close_src
        // existed, so counted but not proven comparable.
        const unverified = to === 'untagged' && from !== 'untagged';
        return { path: k, n: tierMix[k], matched: !unverified && from === to, unverified };
      })
      .sort((a, b) => b.n - a.n);

    // Per-book credibility. A book earns its place in the sharp pool by posting
    // a number that lands near where the market actually closed, so score each
    // book's entry fair against close_over on the same line. Lower avgMissPts =
    // that book was already saying at post time what the market agreed on later.
    // This is the evidence for keeping or dropping a source (e.g. ProphetX,
    // which the 07-25 probe showed carrying a retail-sized 8.5% overround).
    const bookErr = {};
    for (const r of (bres.results || [])) {
      if (!r.fair_books || r.close_over == null) continue;
      if (r.close_line != null && r.line != null && r.close_line !== r.line) continue;
      let pool; try { pool = JSON.parse(r.fair_books); } catch (e) { continue; }
      for (const { book, over } of (pool || [])) {
        if (over == null) continue;
        const e = bookErr[book] || (bookErr[book] = { n: 0, sum: 0 });
        e.n++; e.sum += Math.abs(over - r.close_over) * 100;
      }
    }
    const sharpBookAccuracy = Object.keys(bookErr)
      .map((b) => ({ book: b, n: bookErr[b].n, avgMissPts: round1(bookErr[b].sum / bookErr[b].n), thin: bookErr[b].n < 30 }))
      .sort((a, b) => a.avgMissPts - b.avgMissPts);

    // Market × side — the direct directional test: for each batter market, how
    // does the Over do vs the Under? This is what decides whether an over could
    // EVER be considered, or whether the edge is under-only per market.
    const msMap = groupBy(graded, (r) => {
      const m = String(r.market || '').toUpperCase();
      if (!m || m === 'K' || !r.side) return null;
      return `${m}|${r.side}`;
    });
    const byMarketSide = Object.keys(msMap).map((k) => {
      const [market, side] = k.split('|');
      return { market, side, ...summarize(msMap[k]) };
    }).sort((a, b) => a.market.localeCompare(b.market) || a.side.localeCompare(b.side));

    // Market × side × LINE. Splitting by the exact number is what revealed the
    // edge is not spread across a market but concentrated in one line: HRR
    // Under 1.5 carries it, while HRR Under 2.5 has significantly negative CLV.
    // That distinction is invisible at the market level, which is why this
    // stays. It also settled whether the edge survived at the higher lines
    // pick'em apps offer — it does not, so that question is closed.
    // n<5 buckets are kept but flagged thin: a 4-1 line is not a finding.
    const mslMap = groupBy(graded, (r) => {
      const m = String(r.market || '').toUpperCase();
      if (!m || m === 'K' || !r.side || r.line == null) return null;
      return `${m}|${r.side}|${r.line}`;
    });
    const byMarketSideLine = Object.keys(mslMap).map((k) => {
      const [market, side, line] = k.split('|');
      const s = summarize(mslMap[k]);
      return { market, side, line: Number(line), thin: s.n < 5, ...s };
    }).sort((a, b) => a.market.localeCompare(b.market) || a.side.localeCompare(b.side) || a.line - b.line);

    const underTotal = summarize(unders);
    const overTotal = summarize(overs);
    return cors(json({
      underTotal,
      overTotal,
      byMarketSide,
      byMarketSideLine,
      projBiasByMarket,
      projBiasByWeek,
      projCalSuggest,
      byModelVer,
      byModelVerMarket,
      strikeouts: kBlock,
      fairSourceMix,
      entryVsCloseTier,
      sharpBookAccuracy,
      byMonth,
      byPrice,
      byPricePosted,
      byPriceMarket,
      byPriceEra,
      byPriceExclNearEven,
      byModelProb,
      byModelProbPosted,
      byMarket,
      byMarketUnder,
      byTier,
      tierVerdict,
      edgeDistribution,
      calibration,
      fairCalibration,
      cumulative,
      readSig: 'Significance: sig.roiP is the two-tailed p for ROI != 0, sig.clvP the same for CLV. Treat p>=0.05 as "no established effect" no matter how large the ROI looks. These p-values assume independent picks; picks on the same slate are correlated (shared games, shared weather, shared lineups), so the true p is LARGER than reported — read a marginal 0.04 as not significant. avgClvEv is the mean EV% per unit at the closing fair price: unlike avgCLV it accounts for the price paid, so a positive avgCLV with a negative avgClvEv means the line moved our way but we still took a number worse than the close. avgClvEv is the one to trust when they disagree.',
      read: readNarrative({ underTotal, overTotal, byMarketSideLine, byModelVer }),
    }, 30));
  } catch (e) { return cors(json({ error: String(e && e.message || e) }, 30)); }
}

// The `read` field used to be a hand-written paragraph. It asserted that the
// edge sat in one cell — HRR Under 1.5, n=293, +15.8% ROI, roiP 0.0016 — and it
// kept asserting exactly that while the sample grew past 1500 and the ROI fell
// to under a point. A static claim about a live dataset is wrong the moment the
// data moves, and it moves nightly. Everything below is derived from the same
// numbers the endpoint returns, so the narrative cannot drift from the table.
//
// Rule it enforces: never call an edge established unless the current data says
// so. Positive claims must clear multiple-comparison correction, because the
// cells are searched, not pre-registered — the best of eight p-values is not a
// 0.05 test. Negative findings are reported at raw p, deliberately: a warning
// that a slice is losing money should not need a stricter bar than a claim that
// one is winning.
// Reliability curve + slope fit for a set of graded picks.
//
// Every tier cutoff in this codebase is a threshold on `edge`, and edge is the
// distance between the model's probability and the market's. That only ranks
// anything if the model's probability tracks reality. The slope below measures
// exactly that: regress realised win rate on claimed win rate, both centred on
// 50%. Slope 1 = calibrated. Slope 0 = the number carries no information, and
// every cutoff built on it is sorting noise.
//
// Fitted through the centred origin deliberately — an intercept would absorb a
// flat bias that belongs in the aggregate gap, not in the slope.
function calibrationCurve(rows) {
  const pts = [];
  for (const r of rows) {
    if (r.model_over == null || !r.side) continue;
    if (r.result !== 'win' && r.result !== 'loss') continue;
    const pred = (r.side === 'Over' ? r.model_over : 100 - r.model_over) / 100;
    if (!(pred > 0) || !(pred < 1)) continue;
    pts.push({ pred, win: r.result === 'win' ? 1 : 0 });
  }
  if (pts.length < 20) return { n: pts.length, buckets: [], slope: null, verdict: 'too few graded picks to fit a curve.' };

  const EDGES = [0, 0.40, 0.475, 0.525, 0.60, 1];
  const buckets = [];
  for (let i = 0; i < EDGES.length - 1; i++) {
    const inB = pts.filter((p) => p.pred >= EDGES[i] && p.pred < EDGES[i + 1]);
    if (!inB.length) continue;
    const predicted = inB.reduce((s, p) => s + p.pred, 0) / inB.length;
    const actual = inB.reduce((s, p) => s + p.win, 0) / inB.length;
    buckets.push({
      range: `${Math.round(EDGES[i] * 100)}-${Math.round(EDGES[i + 1] * 100)}%`,
      n: inB.length,
      predicted: round1(predicted * 100),
      actual: round1(actual * 100),
      gapPts: round1((actual - predicted) * 100),
    });
  }

  // Weighted LS on the raw picks, not the buckets — bucketing is for display.
  const num = pts.reduce((s, p) => s + (p.pred - 0.5) * (p.win - 0.5), 0);
  const den = pts.reduce((s, p) => s + (p.pred - 0.5) ** 2, 0);
  if (!(den > 1e-9)) return { n: pts.length, buckets, slope: null, verdict: 'model probabilities are constant; no slope to fit.' };
  const slope = num / den;
  const resid = pts.reduce((s, p) => s + ((p.win - 0.5) - slope * (p.pred - 0.5)) ** 2, 0);
  const se = Math.sqrt(resid / Math.max(pts.length - 1, 1) / den);
  const sTo = (target) => (se > 1e-12 ? (slope - target) / se : null);
  const vs1 = sTo(1), vs0 = sTo(0);
  const informative = vs0 != null && Math.abs(vs0) > 2;
  const calibrated = vs1 != null && Math.abs(vs1) <= 2;

  return {
    n: pts.length,
    buckets,
    slope: Math.round(slope * 1000) / 1000,
    slopeSE: Math.round(se * 1000) / 1000,
    sigmasFromCalibrated: vs1 == null ? null : Math.round(vs1 * 10) / 10,
    sigmasFromNoInfo: vs0 == null ? null : Math.round(vs0 * 10) / 10,
    informative,
    verdict: calibrated
      ? `Calibrated — slope ${round1(slope * 100) / 100} is within 2 SE of 1.`
      : informative
        ? `Miscalibrated but informative — slope ${Math.round(slope * 1000) / 1000} is ${Math.abs(Math.round(vs1 * 10) / 10)} SE below 1, yet ${Math.abs(Math.round(vs0 * 10) / 10)} SE above 0. The probabilities rank picks but overstate confidence; tier cutoffs still mean something, the stated win rates do not.`
        : `NOT informative — slope ${Math.round(slope * 1000) / 1000} is only ${vs0 == null ? '?' : Math.abs(Math.round(vs0 * 10) / 10)} SE above 0. The model's probability does not track outcomes, so every tier cutoff derived from it is sorting noise. Reordering the cutoffs cannot fix this; the probability has to become informative first.`,
  };
}

// Does the SHARP FAIR predict outcomes? This is calibrationCurve's test aimed at
// the market instead of the model, and it decides whether the planned pricing
// refactor is buildable at all.
//
// The refactor selects on price_edge = fair - implied(price). That only works if
// the fair is a true probability. Measured on the current record it is not
// obviously so: predicted EV at the sharp fair runs a median of -6.4% (i.e. the
// full book hold), yet the same picks realised roughly 0% over 3600+ bets — a
// gap far outside sampling error. Either the model finds edge the sharp books
// miss, or those books' PROP pricing is biased (novig/prophetx are low-vig
// venues, sharp on main lines but not necessarily on batter props).
//
// Regress realised return on predicted EV, WITH an intercept, because the two
// failure modes are different and only the intercept separates them:
//   slope ~1, intercept ~0  -> fair is calibrated; price_edge is a valid selector
//   slope >0, intercept >>0 -> fair RANKS but is level-biased; the ranking is
//                              usable, the ">0" threshold is not
//   slope ~0                -> fair carries no information about outcomes and
//                              cannot select picks however clean the plumbing is
function fairEvCalibration(rows) {
  const pts = [];
  for (const r of rows) {
    if (r.result !== 'win' && r.result !== 'loss') continue;
    if (r.entry_over == null || r.price == null || !r.side) continue;
    const q = amProb(r.price);
    if (!(q > 0) || !(q < 1)) continue;
    const p = r.side === 'Over' ? r.entry_over : 1 - r.entry_over;
    if (!(p > 0) || !(p < 1)) continue;
    pts.push({ pred: 100 * (p - q) / q, real: profitUnits(r.result, r.price) * 100 });
  }
  if (pts.length < 100) return { n: pts.length, verdict: 'too few graded rows to test the fair.' };

  const EDGES = [-Infinity, -8, -6, -4, -2, 0, Infinity];
  const buckets = [];
  for (let i = 0; i < EDGES.length - 1; i++) {
    const inB = pts.filter((x) => x.pred >= EDGES[i] && x.pred < EDGES[i + 1]);
    if (!inB.length) continue;
    const mp = inB.reduce((s, x) => s + x.pred, 0) / inB.length;
    const mr = inB.reduce((s, x) => s + x.real, 0) / inB.length;
    buckets.push({
      range: `${EDGES[i] === -Infinity ? 'min' : EDGES[i]}..${EDGES[i + 1] === Infinity ? 'max' : EDGES[i + 1]}`,
      n: inB.length,
      predictedEvPct: round1(mp),
      realisedRoiPct: round1(mr),
      gapPts: round1(mr - mp),
    });
  }

  const n = pts.length;
  const mP = pts.reduce((s, x) => s + x.pred, 0) / n;
  const mR = pts.reduce((s, x) => s + x.real, 0) / n;
  const sxx = pts.reduce((s, x) => s + (x.pred - mP) ** 2, 0);
  if (!(sxx > 1e-9)) return { n, buckets, verdict: 'predicted EV is constant; no slope to fit.' };
  const sxy = pts.reduce((s, x) => s + (x.pred - mP) * (x.real - mR), 0);
  const slope = sxy / sxx;
  const intercept = mR - slope * mP;
  const resid = pts.reduce((s, x) => s + (x.real - (intercept + slope * x.pred)) ** 2, 0);
  const se = Math.sqrt(resid / Math.max(n - 2, 1) / sxx);
  const sig = (t) => (se > 1e-12 ? (slope - t) / se : null);
  const vs0 = sig(0), vs1 = sig(1);
  const r2 = (v) => Math.round(v * 100) / 100;
  // Three-way, not two-way. "Not 2 SE above 0" is NOT the same claim as "does
  // not rank": when the standard error is large the slope can sit within 2 SE of
  // BOTH 0 and 1, and the only honest reading is that the test cannot tell them
  // apart. Reporting that as a finding would recommend killing a refactor on the
  // strength of a measurement that establishes nothing.
  //
  // Why the SE is large here is itself the point: predicted EV is dominated by
  // the book's hold, so it barely varies (most rows cluster near -6.4). A
  // predictor with almost no spread cannot have its slope estimated, no matter
  // how many rows there are. Power comes from rows where the fair genuinely
  // diverges from the price — exactly the rows that are rare.
  const excludesNoInfo = vs0 != null && Math.abs(vs0) > 2;
  const excludesCalibrated = vs1 != null && Math.abs(vs1) > 2;
  const inconclusive = !excludesNoInfo && !excludesCalibrated;
  const lo = r2(slope - 1.96 * se), hi = r2(slope + 1.96 * se);

  let verdict;
  if (inconclusive) {
    verdict = `INCONCLUSIVE — slope ${r2(slope)} with SE ${r2(se)}; the 95% interval [${lo}, ${hi}] contains BOTH 0 (no information) and 1 (calibrated). This test cannot yet tell them apart, so it is not evidence for or against building price_edge. Cause: predicted EV barely varies (mean ${r2(mP)}, dominated by the book hold), and only rows where the fair diverges from the price carry power — there are few. Separately, realised beat predicted by ${r2(mR - mP)} pts, which is the level question, not the ranking question.`;
  } else if (!excludesNoInfo) {
    verdict = `FAIR DOES NOT RANK — slope ${r2(slope)}, 95% interval [${lo}, ${hi}], excludes 1 but not 0. Predicted EV does not track realised return, so price_edge cannot select picks. Do NOT build it as the selector.`;
  } else if (!excludesCalibrated && Math.abs(mR - mP) < 2) {
    verdict = `FAIR IS CALIBRATED — slope ${r2(slope)} within 2 SE of 1, mean gap ${r2(mR - mP)} pts. price_edge is a valid selector as specified.`;
  } else {
    verdict = `FAIR RANKS BUT IS LEVEL-BIASED — slope ${r2(slope)} is ${Math.abs(r2(vs0))} SE above 0, but realised beats predicted by ${r2(mR - mP)} pts on average. The ordering is usable; the ">0" cutoff is not. Derive the threshold from the bucket table, not from EV=0.`;
  }

  return {
    n,
    buckets,
    meanPredictedEvPct: r2(mP),
    meanRealisedRoiPct: r2(mR),
    meanGapPts: r2(mR - mP),          // systematic level bias of the fair
    slope: r2(slope),
    slopeSE: r2(se),
    slopeCI95: [lo, hi],
    sigmasFromNoInfo: vs0 == null ? null : r2(vs0),
    sigmasFromCalibrated: vs1 == null ? null : r2(vs1),
    // Only true when the data actually EXCLUDES the no-information hypothesis.
    fairRanksOutcomes: excludesNoInfo && slope > 0,
    inconclusive,
    verdict,
  };
}

function readNarrative({ underTotal, overTotal, byMarketSideLine, byModelVer }) {
  const parts = [];
  const pct = (v) => (v == null ? '?' : `${v > 0 ? '+' : ''}${v}%`);
  const verdict = (s) => {
    const p = s && s.sig && s.sig.roiP;
    if (p == null) return 'no p-value (too few rows)';
    return p < 0.05 ? `significant (roiP ${p})` : `NOT significant (roiP ${p})`;
  };

  parts.push('Read p-values before ROI. This paragraph is generated from the numbers in this response — if it disagrees with a slice below, trust the slice.');

  // --- the product line: unders, then overs, always stated even when null ---
  if (underTotal && underTotal.n) {
    parts.push(`UNDERS (the posted side): n=${underTotal.n}, ${underTotal.record}, ROI ${pct(underTotal.roi)} — ${verdict(underTotal)}.`);
  }
  if (overTotal && overTotal.n) {
    const negSig = overTotal.sig && overTotal.sig.roiP != null && overTotal.sig.roiP < 0.05 && overTotal.roi < 0;
    parts.push(`OVERS: n=${overTotal.n}, ${overTotal.record}, ROI ${pct(overTotal.roi)} — ${verdict(overTotal)}${negSig ? '; the fade thesis survives on this side being reliably negative, which is not the same as the under being reliably positive' : ''}.`);
  }

  // --- searched cells, corrected. Thin rows never enter the count. ---
  const cells = (byMarketSideLine || []).filter((c) => !c.thin && c.sig && c.sig.roiP != null);
  if (cells.length) {
    const sorted = cells.slice().sort((a, b) => a.sig.roiP - b.sig.roiP);
    const bonf = 0.05 / sorted.length;
    // Benjamini-Hochberg: largest k with p(k) <= k/m * 0.05; everything up to k passes.
    let bh = 0;
    sorted.forEach((c, i) => { if (c.sig.roiP <= ((i + 1) / sorted.length) * 0.05) bh = i + 1; });
    const name = (c) => `${c.market} ${c.side} ${c.line}`;
    const desc = (c) => `${name(c)} (n=${c.n}, ROI ${pct(c.roi)}, roiP ${c.sig.roiP}${c.sig.clvP != null ? `, clvP ${c.sig.clvP}` : ''})`;

    const posCorrected = sorted.filter((c, i) => c.roi > 0 && (c.sig.roiP < bonf || i < bh));
    const posRaw = sorted.filter((c) => c.roi > 0 && c.sig.roiP < 0.05);
    const negRaw = sorted.filter((c) => c.roi < 0 && c.sig.roiP < 0.05);

    parts.push(`${sorted.length} non-thin cells were tested, so this is a search, not one hypothesis: the Bonferroni threshold is roiP < ${Math.round(bonf * 1e5) / 1e5}.`);

    if (posCorrected.length) {
      parts.push(`ESTABLISHED positive edge (survives correction): ${posCorrected.map(desc).join('; ')}. Size the product here and nowhere else.`);
    } else if (posRaw.length) {
      parts.push(`No positive cell survives correction. ${posRaw.map(desc).join('; ')} clear${posRaw.length === 1 ? 's' : ''} raw p<0.05 but not the corrected bar — that is what the best of ${sorted.length} searched cells looks like under the null. Do not build on it yet.`);
    } else {
      const best = sorted.filter((c) => c.roi > 0)[0];
      parts.push(`NO positive-ROI cell reaches even raw p<0.05${best ? ` (best is ${desc(best)})` : ''}. There is currently no established edge in any slice — the honest read is that the product is not yet distinguishable from break-even.`);
    }

    if (negRaw.length) {
      parts.push(`Significantly NEGATIVE cells — avoid, and do not read a large negative as a fade opportunity: ${negRaw.map(desc).join('; ')}.`);
    }
    parts.push('Ignore every thin:true row; they are excluded from the counts above.');
  }

  // --- eras, when the column is populated ---
  const eras = (byModelVer || []).filter((e) => e.n && e.sig && e.sig.roiP != null);
  if (eras.length) {
    const sigEras = eras.filter((e) => e.sig.roiP < 0.05 && e.roi > 0);
    parts.push(`By pricing era: ${eras.map((e) => `${e.modelVer || e.model_ver} n=${e.n} ROI ${pct(e.roi)} roiP ${e.sig.roiP}`).join('; ')}. ${sigEras.length ? '' : 'No era shows a significant positive ROI, so the current pricing cannot yet be claimed as an improvement on any earlier one.'}`.trim());
  }

  // --- durable, structural caveats: true regardless of what the data says ---
  parts.push('On avgClvEv: for model_ver dk-fair it measures THE BOOK\'S HOLD, not our edge — fair and price both came from DraftKings, so EV at that fair is mechanically 1/overround - 1. It only carries information on sharp-shin rows, where the price is DK/FD but the closing fair comes from books we never bet.');
  parts.push('All p-values assume independent picks. Same-slate picks share games, weather and lineups, so the true p is LARGER than reported and every "not significant" above is the conservative call.');

  return parts.join(' ');
}

// /api/fair-probe — READ-ONLY viability check for a real fair-value source.
//
// Today the batter edge is computed against DK/FD's own de-vigged line and then
// bet at DK/FD — the fair source and the execution venue are the same book, so
// the "edge" measures model-vs-DK disagreement, not value. That circularity is
// the most likely reason season CLV sits at ~0 despite large posted edges.
//
// This asks the only question that decides whether the fix is possible: do the
// SHARP books actually post our batter markets? It changes nothing — no model,
// no selection, no logging — and uses the `bookmakers` param (which overrides
// `regions`), so <=10 books bills as one region equivalent: markets x 1.
const PROBE_FAIR_BOOKS = ['pinnacle', 'novig', 'prophetx', 'lowvig'];
const PROBE_EXEC_BOOKS = ['draftkings', 'fanduel'];
// Sports this probe may be pointed at. A whitelist rather than passing the query
// through: the value lands in an upstream path, and an unbounded one turns a
// read-only diagnostic into an open proxy for any Odds API endpoint.
const PROBE_SPORTS = {
  mlb: 'baseball_mlb',
  nfl: 'americanfootball_nfl',
  nflpre: 'americanfootball_nfl_preseason',
  // Soccer, for coverage probes only — nothing is modelled or priced here yet.
  epl: 'soccer_epl',
  laliga: 'soccer_spain_la_liga',
  ucl: 'soccer_uefa_champs_league',
  uel: 'soccer_uefa_europa_league',
  // Candidates, probe-only: none of these are ingested. The three above all
  // pause for the FIFA windows together, so "which leagues are playing when
  // ours are not" is a question worth being able to ask without a deploy.
  seriea: 'soccer_italy_serie_a',
  ligamx: 'soccer_mexico_ligamx',
  mls: 'soccer_usa_mls',
  bundesliga: 'soccer_germany_bundesliga',
  // NBA, for the coverage question before anything is built: which books quote
  // player threes, assists and rebounds two-sided, and whether PrizePicks is on
  // them. Those three are where the under thesis held in 2024-25 and 2025-26
  // (55.5%, 53.4% and 53.3% under a player's last-10 average over ~23,000
  // rotation games each); points and PRA did not (51.6%, 51.2%).
  nba: 'basketball_nba',
  nbapre: 'basketball_nba_preseason',
  // NHL (2026-10-14): the question before any hockey props are built is
  // whether shots on goal has a sharp fair line (two sharp books on the same
  // number, two-sided) and whether PrizePicks and DraftKings quote the same
  // players. The moneyline is logged since 2026-10-20 (NHL_ML); props are not.
  nhl: 'icehockey_nhl',
};
// ---------------------------------------------------------------------------
// Soccer — game lines only, for three leagues, as CONTEXT.
//
// What the coverage probe found on 2026-09-20: Pinnacle, lowvig and betonlineag
// quote 1X2 and goals totals for all three, DK and FanDuel quote them too, and
// PrizePicks is absent from soccer entirely. Player props (shots, shots on
// target, assists) come back OVER-ONLY from a single book, so there is no under
// side to fade and no independent fair line — the thesis this site is built on
// does not exist in that market, and nothing here pretends otherwise.
//
// So this is the NFL board's shape: a sharp fair line, the best price you could
// take against it, and the gap. No model, no projections, no plays.
// Liga MX earns its place on fixtures, not on form: the three above all pause
// for the same FIFA windows, and this one plays straight through them — Sep 25,
// 26 and 27 while EPL, La Liga and the Champions League sit idle until Oct 9.
// Probed 2026-09-22: Pinnacle, lowvig and betonlineag all quote its 1X2, and so
// do DK and FanDuel, which is the same coverage the original three have.
//
// Serie A is on exactly the same break as the EPL and adds no fixtures before
// Oct 10; it is here because it is a league worth having, not to fill the gap.
const SOCCER_LEAGUES = {
  epl: { key: 'soccer_epl', label: 'Premier League', country: 'England' },
  laliga: { key: 'soccer_spain_la_liga', label: 'La Liga', country: 'Spain' },
  ucl: { key: 'soccer_uefa_champs_league', label: 'Champions League', country: 'UEFA' },
  // The Europa League (2026-10-22), on the owner's call: Thursday nights, 18
  // fixtures a matchday with more mismatches than the Champions League. The
  // same two-book rule. 2 credits a capture, at most two a day while a fixture
  // is inside 36 hours: about 8 credits a matchday week.
  uel: { key: 'soccer_uefa_europa_league', label: 'Europa League', country: 'UEFA' },
  seriea: { key: 'soccer_italy_serie_a', label: 'Serie A', country: 'Italy' },
  ligamx: { key: 'soccer_mexico_ligamx', label: 'Liga MX', country: 'Mexico' },
  // MLS, for the same reason as Liga MX and with the same caveat: both run on a
  // spring-to-autumn calendar and finish in November (MLS Nov 7, Liga MX Nov 22)
  // while the European four go to May. They are a seven-week source that covers
  // this FIFA window, not a permanent fifth and sixth league.
  mls: { key: 'soccer_usa_mls', label: 'MLS', country: 'USA' },
  // National teams. Added 2026-09-26 for the double FIFA window that stops the
  // European leagues until Oct 10: 18 fixtures that weekend and 8 more on Oct 3,
  // all priced by Pinnacle. Friendlies are not in the odds feed at all, so this
  // is the one international competition the sharp-pool method can price.
  // pinnacleFallback: on Sep 26 every Nations League fixture had one sharp book
  // or none, so none had a fair line. The owner chose to follow Pinnacle's line
  // alone for it when the pool is short (fairSrc 'pinnacle'); the other leagues
  // keep the two-book rule.
  uefanl: { key: 'soccer_uefa_nations_league', label: 'Nations League', country: 'UEFA', pinnacleFallback: true },
};
const SOCCER_SHARP = ['pinnacle', 'lowvig', 'betonlineag'];
const SOCCER_EXEC = ['draftkings', 'fanduel'];
const SOCCER_BOOKS = [...SOCCER_SHARP, ...SOCCER_EXEC];   // 5 books = 1 region-equivalent
const SOCCER_MARKETS = 'h2h,totals';
// Twice a matchday, per league: 2 markets x 1 region-equivalent = 2 credits a
// call, so 12 credits on a day all three play. The gap keeps a busy Saturday
// from turning into a dozen refreshes.
const SOCCER_MAX_PER_DAY = 2;
const SOCCER_MIN_GAP_MS = 5 * 3600 * 1000;
// Only bother when something is actually coming.
const SOCCER_HORIZON_MS = 36 * 3600 * 1000;

async function ensureSoccerSchema(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS soccer_lines (
    league TEXT, event_id TEXT, commence TEXT, home TEXT, away TEXT,
    market TEXT, selection TEXT, point REAL, book TEXT, price INTEGER,
    captured_at TEXT
  )`).run();
  // The board reads by league and kickoff; the change-detection read keys off
  // the same pair. Without this every render scans the whole history.
  await db.prepare('CREATE INDEX IF NOT EXISTS soccer_lines_lg ON soccer_lines (league, commence)').run();
}

// One league's lines, appended only where a number actually moved.
async function soccerIngest(env, url) {
  const out = { leagues: [], credits: 0, wrote: 0, unchanged: 0, errors: [] };
  const key = env && env.ODDS_API_KEY;
  if (!key) { out.errors.push('ODDS_API_KEY not configured'); return out; }
  if (!env.DB) { out.errors.push('no DB binding'); return out; }
  await ensureSoccerSchema(env.DB);
  const want = (url && url.searchParams && url.searchParams.get('league')) || null;
  const leagues = Object.keys(SOCCER_LEAGUES).filter((l) => !want || l === want);
  const now = Date.now();
  for (const lg of leagues) {
    const sp = SOCCER_LEAGUES[lg];
    const res = { league: lg, events: 0, wrote: 0, unchanged: 0 };
    try {
      const r = await fetch(`https://api.the-odds-api.com/v4/sports/${sp.key}/odds?apiKey=${key}&bookmakers=${SOCCER_BOOKS.join(',')}&markets=${SOCCER_MARKETS}&oddsFormat=american&dateFormat=iso`,
        { headers: { accept: 'application/json' } });
      await recordOddsUsage(env, r, `soccer:${lg}`);
      const used = Number(r.headers.get('x-requests-last') || 0);
      if (isFinite(used)) out.credits += used;
      if (!r.ok) { out.errors.push(`${lg}: HTTP ${r.status}`); out.leagues.push(res); continue; }
      const events = await r.json();
      const live = (Array.isArray(events) ? events : []).filter((e) => Date.parse(e.commence_time) > now - 3 * 3600e3);
      res.events = live.length;
      // Latest stored number per (event, market, selection, book), so an
      // unchanged price is not written again. Append-on-change keeps the history
      // honest — every row is a real move — and keeps the table small.
      const prior = (await env.DB.prepare(
        'SELECT event_id, market, selection, point, book, price, captured_at FROM soccer_lines WHERE league=? AND commence > ? ORDER BY captured_at ASC'
      ).bind(lg, new Date(now - 3 * 3600e3).toISOString()).all()).results || [];
      const last = new Map();
      for (const p of prior) last.set(`${p.event_id}|${p.market}|${p.selection}|${p.book}`, p);
      const stamp = new Date().toISOString();
      const stmts = [];
      for (const e of live) {
        for (const bm of (e.bookmakers || [])) {
          for (const mk of (bm.markets || [])) {
            if (mk.key !== 'h2h' && mk.key !== 'totals') continue;
            for (const oc of (mk.outcomes || [])) {
              const sel = mk.key === 'totals' ? oc.name : oc.name;   // Over/Under, or a club name (or 'Draw')
              const k = `${e.id}|${mk.key}|${sel}|${bm.key}`;
              const was = last.get(k);
              if (was && was.price === oc.price && (was.point ?? null) === (oc.point ?? null)) { res.unchanged++; continue; }
              stmts.push(env.DB.prepare(
                `INSERT INTO soccer_lines (league,event_id,commence,home,away,market,selection,point,book,price,captured_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?)`
              ).bind(lg, e.id, e.commence_time || null, e.home_team || null, e.away_team || null, mk.key, sel, oc.point ?? null, bm.key, oc.price ?? null, stamp));
              res.wrote++;
            }
          }
        }
      }
      for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
    } catch (e) {
      out.errors.push(`${lg}: ${String((e && e.message) || e)}`);
    }
    out.wrote += res.wrote; out.unchanged += res.unchanged;
    out.leagues.push(res);
  }
  return out;
}

// Cron gate: at most SOCCER_MAX_PER_DAY captures per league per day, spaced, and
// only when that league actually has a fixture inside the horizon. The counter
// lives in feed_cache rather than its own table — it is one small row a day.
// Cron gate for NFL game lines, the same shape as the soccer one below: at most
// NFL_MAX_PER_DAY captures a day, spaced, and only when a game is close enough
// to matter. Until now the NFL lines came in only when a one-off scheduled task
// fired, which meant a week nobody set one up left no record at all.
//
// 3 markets x 1 region-equivalent = 3 credits a call, so a slate day costs 6 and
// a full NFL week about 18 — against a quota in the tens of thousands.
// How long a "nothing inside the window" answer is trusted before the free
// events list is asked again. Every 5-minute tick asked it, which on 2026-09-25
// was ~1,400 calls across six soccer leagues and the NFL — free in credits, but
// each one a usage-ledger write and each one a subrequest drawn from the same
// scheduled invocation that captures closing lines. A fixture entering the 36h
// window is still seen within the hour.
const EVENTS_RECHECK_MS = 60 * 60 * 1000;
// Pre-start reads (2026-10-22): a leg is played at the price just before its
// game, so each start time gets a read about 75 minutes out and another about
// 25 minutes out -- the close, read before the last Picks refresh ahead of it
// (dayPicksTick runs every 15). The two daily captures read an evening game
// at lunchtime: a scratch at 3 PM moved the line, and the board did not know.
// Each is one ordinary capture (1 credit for a moneyline league, 2 for a
// soccer league, 3 for the NFL's game lines), and the start times come from
// what the last read already holds, so finding them costs nothing. Counted
// apart from the two daily captures, and capped per league per day.
const PRESTART_MS = [75 * 60e3, 25 * 60e3];
const PRESTART_MAX_PER_DAY = 16;
function prestartDue(starts, last, now) {
  return (starts || []).some((t) => PRESTART_MS.some((w) => now >= t - w && now < t && !(last >= t - w)));
}
const upcomingStarts = (list, now) => (list || []).map((t) => (typeof t === 'number' ? t : Date.parse(t)))
  .filter((t) => isFinite(t) && t > now && t - now <= 36 * 3600e3);
const NFL_MAX_PER_DAY = 2;
const NFL_MIN_GAP_MS = 5 * 3600 * 1000;
const NFL_HORIZON_MS = 36 * 3600 * 1000;
async function nflMaybeIngest(env, ctx) {
  if (!env || !env.DB || !env.ODDS_API_KEY) return null;
  try {
    const today = slateDate();
    const cacheKey = `nfl_cap:${today}`;
    const hit = await loadFeedCache(env.DB, cacheKey);
    const state = (hit.present && hit.data) || { n: 0, last: 0 };
    // Before each kickoff: the game lines only (3 credits), and the board's
    // log after them -- not the props, which are priced per game.
    const now = Date.now();
    // The capture itself, not the /api/nfl-ingest handler around it: the handler
    // follows a capture with a readback for whoever called it -- three reads
    // of the whole of nfl_lines (a count, a count by week, the rows with no
    // week) -- and the cron threw the answer away. With the pre-start reads
    // that was up to ten whole-table passes, three reads each, on a Sunday
    // (2026-10-23).
    if ((state.pre || 0) < PRESTART_MAX_PER_DAY && prestartDue(upcomingStarts(state.starts, now), state.last, now)) {
      const res = await ingestNflLines(env, { sport: 'nfl' });
      try { await nflBoardData(env, null); } catch (e) { /* logged next capture */ }
      await saveFeedCache(env.DB, cacheKey, { ...state, pre: (state.pre || 0) + 1, last: now });
      return { ran: true, prestart: true, wrote: res && res.wrote };
    }
    const regular = state.n < NFL_MAX_PER_DAY && !(state.last && now - state.last < NFL_MIN_GAP_MS);
    if (!regular && state.starts) return null;
    if (state.checked && now - state.checked < EVENTS_RECHECK_MS) return null;
    // Is anything coming? The events list is free, so this question costs nothing
    // on the many days the answer is no.
    const evR = await fetch(`https://api.the-odds-api.com/v4/sports/americanfootball_nfl/events?apiKey=${env.ODDS_API_KEY}&dateFormat=iso`,
      { headers: { accept: 'application/json' } });
    await recordOddsUsage(env, evR, 'nfl:cron-events');
    if (!evR.ok) return null;
    const evs = await evR.json();
    const starts = upcomingStarts((Array.isArray(evs) ? evs : []).map((e) => e.commence_time), now);
    const soon = starts.length > 0;
    if (!regular || !soon) { await saveFeedCache(env.DB, cacheKey, { ...state, checked: now, starts }); return null; }
    const res = await ingestNflLines(env, { sport: 'nfl' });
    // Player props on the same tick. They are a separate purchase — per event
    // rather than per slate — and the game-line ingest does not touch them, so
    // without this the passing-TD log never fills and the projections have no
    // line to grade against. Every capture before this one came from a one-off
    // scheduled task, every one of which is now spent.
    //
    // 3 markets x 1 region-equivalent per event: about 3 credits for a Thursday,
    // 48 for a sixteen-game Sunday, so roughly 110 a week at twice a slate day.
    // (Measured 2026-10-14/15: ~83 a day, since every game inside the ten-day
    // horizon is priced on each capture.) Passing yards add 1 a game on the two
    // day-of captures only -- see NFL_PASS_YDS_WINDOW_MS.
    let props = null;
    try { props = await ingestNflProps(env, { sport: 'nfl' }, new URL('https://x/api/nfl-capture')); }
    catch (e) { /* the game lines are already in; props retry next tick */ }
    // The board is what logs each game's favoured side (gmpicks), and until now
    // it ran only when someone opened it: a Sunday nobody looked at before
    // kickoff left no moneyline record, and Picks of the day nothing to list.
    // Reading it here costs D1 reads only.
    try { await nflBoardData(env, null); } catch (e) { /* logged next capture */ }
    await saveFeedCache(env.DB, cacheKey, { n: state.n + 1, last: Date.now(), pre: state.pre || 0, starts });
    return { ran: true, n: state.n + 1, wrote: res && res.wrote, props: props && props.wrote };
  } catch (e) { return null; }   // next tick
}

async function soccerMaybeIngest(env, ctx) {
  if (!env || !env.DB || !env.ODDS_API_KEY) return null;
  const today = slateDate();
  const out = [];
  for (const lg of Object.keys(SOCCER_LEAGUES)) {
    try {
      const cacheKey = `soccer_cap:${lg}:${today}`;
      const hit = await loadFeedCache(env.DB, cacheKey);
      const state = (hit.present && hit.data) || { n: 0, last: 0 };
      // Before each kickoff, from the kickoff times the last events read kept.
      const now = Date.now();
      if ((state.pre || 0) < PRESTART_MAX_PER_DAY && prestartDue(upcomingStarts(state.starts, now), state.last, now)) {
        const res = await soccerIngest(env, new URL(`https://x/api/soccer-ingest?league=${lg}`));
        await saveFeedCache(env.DB, cacheKey, { ...state, pre: (state.pre || 0) + 1, last: now });
        out.push({ league: lg, prestart: true, ...(res.leagues[0] || {}), credits: res.credits });
        continue;
      }
      // Past its two daily captures a league still needs its kickoff times
      // once (a day whose captures predate this): one free events read.
      const regular = state.n < SOCCER_MAX_PER_DAY && !(state.last && now - state.last < SOCCER_MIN_GAP_MS);
      if (!regular && state.starts) continue;
      if (state.checked && now - state.checked < EVENTS_RECHECK_MS) continue;
      // Is anything coming? The events list is free.
      const evR = await fetch(`https://api.the-odds-api.com/v4/sports/${SOCCER_LEAGUES[lg].key}/events?apiKey=${env.ODDS_API_KEY}&dateFormat=iso`, { headers: { accept: 'application/json' } });
      await recordOddsUsage(env, evR, `soccer:${lg}:events`);
      if (!evR.ok) continue;
      const evs = await evR.json();
      const starts = upcomingStarts((Array.isArray(evs) ? evs : []).map((e) => e.commence_time), now);
      const soon = starts.length > 0;
      if (!regular || !soon) { await saveFeedCache(env.DB, cacheKey, { ...state, checked: now, starts }); continue; }
      const res = await soccerIngest(env, new URL(`https://x/api/soccer-ingest?league=${lg}`));
      await saveFeedCache(env.DB, cacheKey, { n: state.n + 1, last: Date.now(), pre: state.pre || 0, starts });
      out.push({ league: lg, ...(res.leagues[0] || {}), credits: res.credits });
    } catch (e) { /* next tick */ }
  }
  // Soccer picks used to be written only when someone opened the soccer board,
  // so Sunday 2026-09-27's Nations League, which nobody opened before kickoff,
  // left no record at all. A capture is the only moment the stored prices
  // change, so logging right after one is the same as a reader opening the
  // board then. One read of the stored lines, no odds calls.
  if (out.length) {
    try { await soccerBoardData(env, new URL('https://x/api/soccer-board?all=1'), { log: true }); } catch (e) { /* next capture */ }
  }
  return out.length ? out : null;
}

// ---------------------------------------------------------------------------
// NBA — game lines, recorded only.
//
// Started 2026-10-03, the first preseason game (Heat at Raptors, in Quebec
// City). The coverage probe that day found the moneyline and nothing else:
// Pinnacle, DraftKings, FanDuel and BetRivers quote it, and no book quotes a
// single player prop for a preseason game. So this keeps what the NFL log
// keeps -- the side the sharp books rate likelier to win, at the best price
// that could be taken -- and nothing is posted. Player props wait for the
// regular season and the Oct 19 re-probe.
//
// One /odds call per league per capture: h2h from ten named books is one
// region-equivalent, so 1 credit however many games are on it. Two captures a
// day at most: the first once a game is inside 36h (the entry), the second
// inside 3h of a tip (the close, which is where preseason rest news lands).
// Preseason rows carry league 'pre' and regular-season rows 'reg', so the
// two never share a record.
const NBA_LEAGUES = { pre: 'basketball_nba_preseason', reg: 'basketball_nba' };
const NBA_SHARP = ['pinnacle', 'lowvig', 'betonlineag', 'novig', 'prophetx'];
const NBA_EXEC = ['draftkings', 'fanduel', 'betmgm', 'betrivers', 'williamhill_us'];
const NBA_MAX_PER_DAY = 2;
const NBA_MIN_GAP_MS = 3600 * 1000;
const NBA_HORIZON_MS = 36 * 3600 * 1000;
const NBA_CLOSE_MS = 3 * 3600 * 1000;
// The log's settings as one object, so the NHL moneyline (below) runs the same
// capture, board and cron gate on its own league under its own keys:
// `${sport}_board:${lg}` snapshots, `${sport}_cap:${lg}:${day}` counters and
// `${sport}:${lg}:odds` on the usage ledger. For the NBA those are the keys it
// has always used.
const NBA_ML = { sport: 'nba', leagues: NBA_LEAGUES, sharp: NBA_SHARP, exec: NBA_EXEC, maxPerDay: NBA_MAX_PER_DAY,
  minGap: NBA_MIN_GAP_MS, horizon: NBA_HORIZON_MS, close: NBA_CLOSE_MS };

// Pure: an /odds response in, one read per game inside the window -- both
// sides' fair and best executable price. Fair is the median Shin de-vig of two
// or more sharp books; with fewer, Pinnacle alone (fair_src 'pinnacle'), the
// same fallback the Nations League uses -- preseason has nothing else. With
// neither, the game is still listed (the board shows its prices) but carries
// no fair and logs nothing.
function h2hGames(cfg, evs, lg, now) {
  const out = [];
  for (const e of (Array.isArray(evs) ? evs : [])) {
    const t = Date.parse(e && e.commence_time);
    if (!isFinite(t) || t <= now || t - now > cfg.horizon) continue;
    const home = e.home_team, away = e.away_team;
    const px = {};
    for (const bm of (e.bookmakers || [])) {
      const mk = (bm.markets || []).find((m) => m.key === 'h2h');
      const h = mk && (mk.outcomes || []).find((o) => o.name === home);
      const a = mk && (mk.outcomes || []).find((o) => o.name === away);
      if (h && a && typeof h.price === 'number' && typeof a.price === 'number') px[bm.key] = { home: h.price, away: a.price };
    }
    // Every book's no-vig chance of the home side; the sharp ones make the fair.
    const byBook = {};
    for (const [bk, q] of Object.entries(px)) { const f = shinDevig(q.home, q.away); if (f != null && isFinite(f)) byBook[bk] = f; }
    const sf = sharpFair(Object.fromEntries(cfg.sharp.filter((bk) => byBook[bk] != null).map((bk) => [bk, byBook[bk]])));
    let fairHome = sf.fair, fairSrc = sf.src;
    if (fairHome != null && !isFinite(fairHome)) fairHome = null;
    if (fairHome == null) fairSrc = 'MKT';
    const best = (side) => {
      let price = null, book = null;
      for (const bk of cfg.exec) {
        const q = px[bk] && px[bk][side];
        if (typeof q !== 'number') continue;
        if (price == null || amProb(q) < amProb(price)) { price = q; book = bk; }
      }
      return { price, book };
    };
    const bh = best('home'), ba = best('away');
    if (bh.price == null && ba.price == null) continue;
    const value = (fair, price) => (fair != null && price != null ? round1((fair - amProb(price)) * 100) : null);
    const pickSide = fairHome == null ? null : (fairHome >= 0.5 ? 'home' : 'away');
    out.push({
      id: e.id, league: lg, commence: e.commence_time, home, away,
      fairSrc, sharpN: sf.n, byBook,
      homeFair: fairHome == null ? null : round1(fairHome * 100),
      awayFair: fairHome == null ? null : round1((1 - fairHome) * 100),
      homePrice: bh.price, homeBook: bh.book, awayPrice: ba.price, awayBook: ba.book,
      homeValue: value(fairHome, bh.price), awayValue: value(fairHome == null ? null : 1 - fairHome, ba.price),
      pickSide,
    });
  }
  return out;
}

// gmpicks entries from those reads: the side the sharp books favour, at its
// best price. A game with no fair, or no price on that side, logs nothing.
function h2hEntries(cfg, evs, lg, now) {
  const out = [];
  for (const g of h2hGames(cfg, evs, lg, now)) {
    if (!g.pickSide) continue;
    const side = g.pickSide;
    const price = side === 'home' ? g.homePrice : g.awayPrice;
    if (price == null) continue;
    const winProb = (side === 'home' ? g.homeFair : g.awayFair) / 100;
    const imp = amProb(price);
    out.push({
      game_id: g.id, league: lg, commence: g.commence, side,
      pick: side === 'home' ? g.home : g.away, home: g.home, away: g.away,
      win_prob: round1(winProb * 100), implied: round1(imp * 100), edge: round1((winProb - imp) * 100),
      price, book: side === 'home' ? g.homeBook : g.awayBook, fair_src: g.fairSrc, sharp_n: g.sharpN,
      book_fairs: bookFairsJson(Object.fromEntries(Object.entries(g.byBook || {}).map(([bk, p]) => [bk, side === 'home' ? p : 1 - p]))),
    });
  }
  return out;
}

async function h2hCapture(env, cfg, lg) {
  const r = await fetch(`https://api.the-odds-api.com/v4/sports/${cfg.leagues[lg]}/odds?apiKey=${env.ODDS_API_KEY}`
    + `&markets=h2h&oddsFormat=american&dateFormat=iso&bookmakers=${[...cfg.sharp, ...cfg.exec].join(',')}`,
  { headers: { accept: 'application/json' } });
  await recordOddsUsage(env, r, `${cfg.sport}:${lg}:odds`);
  if (!r.ok) return { league: lg, error: `HTTP ${r.status}` };
  const evs = await r.json();
  // Each row is dated by its own tip, Pacific, like every other date here.
  const byDay = new Map();
  for (const e of h2hEntries(cfg, evs, lg, Date.now())) {
    const d = ptDateOf(Date.parse(e.commence));
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(e);
  }
  let logged = 0;
  for (const [d, list] of byDay) logged += await logGamePicks(env.DB, cfg.sport, d, list);
  // The board reads this snapshot, so it costs nothing to open: its prices are
  // the ones the last capture bought, and it says how old they are.
  await saveFeedCache(env.DB, `${cfg.sport}_board:${lg}`, { asOf: new Date().toISOString(), games: h2hGames(cfg, evs, lg, Date.now()) });
  return { league: lg, events: Array.isArray(evs) ? evs.length : 0, logged, credits: r.headers.get('x-requests-last') };
}

// GET /api/nba-board (and /api/nhl-board). The upcoming games of every league
// from the captures' snapshots -- no Odds API call on a read. The one exception is a league that
// has never been captured since the board shipped: that read buys one capture
// (1 credit) under a lease, so the tab is not blank until the next cron window.
async function h2hBoardData(env, cfg) {
  const out = { games: [], asOf: null, note: 'Sharp-book fair line against the best DK/FD/BetMGM/BetRivers/Caesars price. Not modelled and not posted; the side the sharp books favour is logged and graded.' };
  if (!env || !env.DB) { out.error = 'no DB binding'; return out; }
  const now = Date.now();
  let latest = null;
  for (const lg of Object.keys(cfg.leagues)) {
    const key = `${cfg.sport}_board:${lg}`;
    let snap = await loadFeedCache(env.DB, key);
    if (!snap.present && env.ODDS_API_KEY && await claimFeedRefresh(env.DB, key, 120000)) {
      try { await h2hCapture(env, cfg, lg); snap = await loadFeedCache(env.DB, key); } catch (e) { /* next read */ }
    }
    const d = snap.present && snap.data ? snap.data : null;
    if (!d) continue;
    // How old the prices shown are: only a league with a game still to come
    // counts (2026-10-22). The finished preseason's last read, Oct 16, was
    // the NBA tab's "prices as of" all through opening week.
    const ups = (d.games || []).filter((g) => Date.parse(g.commence) > now);
    if (ups.length && d.asOf && (!out.asOf || d.asOf < out.asOf)) out.asOf = d.asOf;
    if (d.asOf && (!latest || d.asOf > latest)) latest = d.asOf;
    out.games.push(...ups);
  }
  // Nothing to come: the last read anywhere, for "lines last read".
  if (!out.asOf) out.asOf = latest;
  out.games.sort((a, b) => Date.parse(a.commence) - Date.parse(b.commence));
  out.empty = out.games.length === 0;
  return out;
}
// Each row shows both clubs' marks (2026-10-20): the path under ESPN's
// /i/teamlogos/, the same one a Picks-of-the-day leg carries as spec.logo.
function withLogos(out, sport) {
  for (const g of ((out && out.games) || [])) {
    g.homeLogo = moneylineLogo(sport, g.home);
    g.awayLogo = moneylineLogo(sport, g.away);
  }
  return out;
}
async function nbaBoardData(env) { return withLogos(await h2hBoardData(env, NBA_ML), 'nba'); }

// Cron gate, the soccer and NFL shape: a free events read first, a paid capture
// only when a game is close enough, counted per league per day.
async function h2hMaybeIngest(env, cfg) {
  if (!env || !env.DB || !env.ODDS_API_KEY) return null;
  const today = slateDate();
  const out = [];
  for (const lg of Object.keys(cfg.leagues)) {
    try {
      const cacheKey = `${cfg.sport}_cap:${lg}:${today}`;
      const hit = await loadFeedCache(env.DB, cacheKey);
      const state = (hit.present && hit.data) || { n: 0, last: 0 };
      // Before each start: its tip-off times are in the board's own snapshot.
      const now = Date.now();
      const snap = await loadFeedCache(env.DB, `${cfg.sport}_board:${lg}`);
      const starts = upcomingStarts(snap.present && snap.data ? (snap.data.games || []).map((g) => g.commence) : [], now);
      if ((state.pre || 0) < PRESTART_MAX_PER_DAY && prestartDue(starts, state.last, now)) {
        const res = await h2hCapture(env, cfg, lg);
        await saveFeedCache(env.DB, cacheKey, { ...state, pre: (state.pre || 0) + 1, last: now });
        out.push({ ...res, prestart: true });
        continue;
      }
      if (state.n >= cfg.maxPerDay) continue;
      if (state.last && Date.now() - state.last < cfg.minGap) continue;
      if (state.checked && Date.now() - state.checked < EVENTS_RECHECK_MS) continue;
      const evR = await fetch(`https://api.the-odds-api.com/v4/sports/${cfg.leagues[lg]}/events?apiKey=${env.ODDS_API_KEY}&dateFormat=iso`,
        { headers: { accept: 'application/json' } });
      await recordOddsUsage(env, evR, `${cfg.sport}:${lg}:events`);
      if (!evR.ok) continue;
      const evs = await evR.json();
      // The entry wants a game inside 36h; the close, one inside 3h of tip.
      const within = state.n === 0 ? cfg.horizon : cfg.close;
      const soon = (Array.isArray(evs) ? evs : []).some((e) => {
        const t = Date.parse(e.commence_time);
        return isFinite(t) && t > Date.now() && t - Date.now() <= within;
      });
      if (!soon) { await saveFeedCache(env.DB, cacheKey, { ...state, checked: Date.now() }); continue; }
      const res = await h2hCapture(env, cfg, lg);
      await saveFeedCache(env.DB, cacheKey, { n: state.n + 1, last: Date.now(), pre: state.pre || 0 });
      out.push(res);
    } catch (e) { /* next tick */ }
  }
  return out.length ? out : null;
}
function nbaMaybeIngest(env) { return h2hMaybeIngest(env, NBA_ML); }

// ---------------------------------------------------------------------------
// NHL — the moneyline, recorded only (2026-10-20).
//
// Player props wait: the Oct 14 probe found no Pinnacle on shots on goal,
// Novig and ProphetX on the same number for 6 lines in two games, and
// PrizePicks on five players. The moneyline is another market. The Oct 20
// probe (three games, 00:30 Pacific on game day) found lowvig, betonlineag,
// Novig and ProphetX on every game, and DraftKings, FanDuel, BetMGM, BetRivers
// and Caesars too; Pinnacle had not posted yet. So this is the NBA log on
// another league: the side the sharp pool rates likelier to win, at the best
// price that could be taken, logged and graded, not posted. Same books, same
// windows, same cap -- two captures a day, 1 credit each.
//
// h2h is the two-way line, overtime and shootout included (the regulation
// three-way is its own market key, h2h_3_way, never asked for here), so a row
// grades on the final winner. Graded from the NHL's own scores: see nhlFinals.
const NHL_LEAGUES = { reg: 'icehockey_nhl' };
const NHL_ML = { sport: 'nhl', leagues: NHL_LEAGUES, sharp: NBA_SHARP, exec: NBA_EXEC, maxPerDay: 2,
  minGap: NBA_MIN_GAP_MS, horizon: NBA_HORIZON_MS, close: NBA_CLOSE_MS };
function nhlMaybeIngest(env) { return h2hMaybeIngest(env, NHL_ML); }

// GET /api/nhl-board: the NBA board's read for hockey, plus the log's record --
// above all its 65%+ favourites, the bar Picks of the day lists favourites at.
// NHL joined that list on 2026-10-22 (PICK_KINDS.nhl_ml), after last season's
// backtest; this is the number that keeps it there.
async function nhlBoardData(env) {
  const out = withLogos(await h2hBoardData(env, NHL_ML), 'nhl');
  if (!env || !env.DB) return out;
  try {
    const rec = buildGmRecord(((await env.DB.prepare("SELECT * FROM gmpicks WHERE sport = 'nhl'").all()).results) || [], 'nhl');
    out.record = { logged: rec.logged, pending: rec.pending, n: rec.n, record: rec.record, winRate: rec.winRate, byBand: rec.byBand, bar: rec.bar, homeFav60: rec.homeFav60 };
  } catch (e) { /* no log yet */ }
  return out;
}

// The NHL's free score feed, one day at a time. ESPN serves no NHL scoreboard
// on its cdn host -- core/nhl/scoreboard answers 404, and site.api is the host
// that has refused Cloudflare -- so hockey grades off the league's own feed.
// From a Cloudflare Worker on 2026-10-20: api-web.nhle.com/v1/score/{date}
// answered 200, about 14 KB a day; ESPN's core/nhl/schedule also answers, but
// as a 1.5 MB week. The date is honoured -- each day asked returned that day's
// games. A shootout winner's score already carries the deciding goal (Red
// Wings 0, Canadiens 1, on Oct 10), so the higher score is the winner in
// every final.
//
// Rows are dated by the Pacific day of puck drop, and the league dates a game
// by its local day; those agree for every North American start and for the
// European ones, so the day is asked alone. The next day is not asked: two
// clubs can meet on consecutive nights, and a game still unplayed on its own
// day would have been graded by the next night's.
function nhlFinals(j) {
  const out = [];
  for (const g of ((j && j.games) || [])) {
    if (g.gameState !== 'OFF' && g.gameState !== 'FINAL') continue;
    const h = g.homeTeam || {}, a = g.awayTeam || {};
    out.push({
      home: (h.name && h.name.default) || '', away: (a.name && a.name.default) || '',
      homeAb: h.abbrev || '', awayAb: a.abbrev || '',
      hs: Number(h.score), as: Number(a.score),
    });
  }
  return out;
}
async function nhlScoreDay(date) {
  const r = await fetch(`https://api-web.nhle.com/v1/score/${date}`, { headers: { accept: 'application/json' } });
  if (!r.ok) return [];
  return nhlFinals(await r.json());
}
// The feed names a club by its nickname ("Blue Jackets", "Mammoth"); the odds
// feed by city and nickname ("Columbus Blue Jackets", "Montréal Canadiens").
// No two of the 32 nicknames end the same way, so the full name ending in the
// nickname settles every club without an alias table.
function nhlMatch(a, b) {
  const x = clubKey(a), y = clubKey(b);
  return !!x && !!y && (x === y || x.endsWith(y) || y.endsWith(x));
}

// ---------------------------------------------------------------------------
// NHL — PrizePicks points and assists unders, logged (2026-10-22).
//
// Two seasons of box scores (tools/nhl-market-backtest.md) found the under at
// a regular skater's typical line landing 59.5% for points and 67.4% for
// assists, and that on these 0.5 lines the under is "held off the sheet": a
// player's scoring rate decides it (a 0.5 points-a-game skater was scoreless
// 60.9% of the time; Poisson says 60.7%). The Oct 22 check found PrizePicks
// offering Less on both at its standard -137, on the same number as
// DraftKings; it posted no goals, and blocked shots for two players.
//
// So: each game's PrizePicks points and assists lines, read when PrizePicks
// posts them and again before puck drop (ppReadDue, since 2026-10-23), about 2 credits a read. The chance
// is Poisson at the player's rate this season blended with last season's
// (NHL_PRIOR_K games of it), both from the NHL's free stats API by name, which
// also gives the NHL player id the box scores grade by. Regulars only: 15+
// minutes a night. Logged, not posted: off Picks of the day until it has a
// graded record.
const NHL_PP_MARKETS = { player_points: 'pts', player_assists: 'ast' };
// Ten books or fewer bill as one region: PrizePicks, the other pick'em apps,
// the books whose number it is compared with, and the sharp books.
const NHL_PP_BOOKS = ['prizepicks', 'underdog', 'pick6', 'draftkings', 'fanduel', 'pinnacle', 'novig', 'prophetx'];
const NHL_PP_PER_TICK = 4;
const NHL_PP_RAW_KEY = 'nhl_pp_raw';
const NHL_PRIOR_K = 5;
const NHL_TOI_MIN = 15;
const NHL_SEASONS = { prior: '20252026', current: '20262027' };
const NHL_STATS = 'https://api.nhle.com/stats/rest/en/skater/summary';
const nhlName = (s) => nbaBaseName(s);
async function ensureNhlPpSchema(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS nhlpp (
    date TEXT NOT NULL, game_id TEXT NOT NULL, player TEXT NOT NULL, market TEXT NOT NULL,
    commence TEXT, home TEXT, away TEXT, team TEXT, player_id TEXT,
    point REAL, proj REAL, model_under REAL, gp_cur INTEGER, prior_gp INTEGER, toi_proj REAL,
    book_line REAL, book_under INTEGER, actual REAL, result TEXT, captured_at TEXT,
    PRIMARY KEY (date, game_id, player, market)
  )`).run();
  await addColumns(db, 'nhlpp', PP_CLOSE_COLS);   // the pre-tip read, as the NBA log keeps it
  await addColumns(db, 'nhlpp', [['book_unders', 'TEXT']]);   // every book's line and under (bookUndersJson)
  // The hourly grader's `result IS NULL AND date < today` went through the key,
  // which is every day before today: the whole log, to find last night's
  // legs. Only the open rows, as nbapp_ungraded does for the NBA.
  await db.prepare('CREATE INDEX IF NOT EXISTS nhlpp_ungraded ON nhlpp (date) WHERE result IS NULL').run();
}
// A season's skaters by name, from the NHL's stats API (one request, free):
// games, goals, assists, points and time on ice a game. Last season's is
// kept for good; this season's for three hours. A name two skaters share
// matches neither.
async function nhlSkaters(env, season, ttlMs) {
  const key = `nhl_sk:${season}`;
  const hit = await loadFeedCache(env.DB, key);
  if (hit.present && hit.data && (ttlMs == null || hit.ageMs < ttlMs)) return nhlSkaterMap(hit.data);
  try {
    const r = await fetch(`${NHL_STATS}?isAggregate=false&isGame=false&start=0&limit=-1&cayenneExp=gameTypeId=2%20and%20seasonId=${season}`,
      { headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const rows = ((j && j.data) || []).map((x) => ({ id: String(x.playerId), name: x.skaterFullName, team: String(x.teamAbbrevs || '').split(',').pop() || null,
      pos: x.positionCode, gp: x.gamesPlayed, g: x.goals, a: x.assists, p: x.points, toi: x.timeOnIcePerGame != null ? x.timeOnIcePerGame / 60 : null }));
    await saveFeedCache(env.DB, key, rows);
    return nhlSkaterMap(rows);
  } catch (e) {
    return hit.present && hit.data ? nhlSkaterMap(hit.data) : new Map();
  }
}
function nhlSkaterMap(rows) {
  const m = new Map();
  for (const x of rows || []) {
    const k = nhlName(x.name);
    if (!k) continue;
    m.set(k, m.has(k) ? null : x);
  }
  return m;
}
// Pure: one event's odds in, one leg per PrizePicks under on a regular skater.
function nhlPpLegs(ev, pri, cur) {
  const out = [];
  const pp = ev && (ev.bookmakers || []).find((b) => b.key === 'prizepicks');
  if (!pp) return out;
  const bookLine = (mk, name) => {
    for (const bk of ['draftkings', 'fanduel']) {
      const b = (ev.bookmakers || []).find((x) => x.key === bk);
      const m = b && (b.markets || []).find((x) => x.key === mk);
      const u = m && (m.outcomes || []).find((o) => o.name === 'Under' && nhlName(o.description) === name);
      if (u && u.point != null) return { line: u.point, price: typeof u.price === 'number' ? u.price : null };
    }
    return { line: null, price: null };
  };
  for (const m of (pp.markets || [])) {
    const market = NHL_PP_MARKETS[m.key];
    if (!market) continue;
    const stat = market === 'pts' ? 'p' : 'a';
    const seen = new Set();
    for (const o of (m.outcomes || [])) {
      if (o.name !== 'Under' || o.point == null) continue;
      const name = nhlName(o.description);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const p = pri.get(name) || null, c = cur.get(name) || null;
      const who = c || p;
      if (!who) continue;
      const blend = (k) => {
        const prior = p && p.gp >= 10 && p[k] != null ? (k === 'toi' ? p.toi : p[k] / p.gp) : null;
        const n = c && c.gp ? c.gp : 0;
        const sum = c && c[k] != null ? (k === 'toi' ? c.toi * n : c[k]) : 0;
        if (prior != null) return (sum + NHL_PRIOR_K * prior) / (n + NHL_PRIOR_K);
        return n >= 3 ? sum / n : null;
      };
      const proj = blend(stat), toi = blend('toi');
      if (proj == null || toi == null || toi < NHL_TOI_MIN) continue;
      const bl = bookLine(m.key, name);
      out.push({ game_id: ev.id, commence: ev.commence_time, home: ev.home_team, away: ev.away_team,
        player: o.description, player_id: who.id, team: (c && c.team) || (p && p.team) || null, market, point: o.point,
        proj: Math.round(proj * 100) / 100, model_under: round1(negBinomCdf(Math.ceil(o.point) - 1, proj, 1) * 100),
        gp_cur: c ? c.gp : 0, prior_gp: p ? p.gp : 0, toi_proj: round1(toi), book_line: bl.line, book_under: bl.price,
        // Every book's own line and no-vig under, as the NBA log keeps (2026-10-27).
        book_unders: bookUndersJson(ev, m.key, name, nhlName) });
    }
  }
  return out;
}
async function logNhlPp(db, legs, close) {
  if (!legs.length) return 0;
  const stamp = new Date().toISOString();
  const stmts = legs.map((l) => db.prepare(
    `INSERT OR IGNORE INTO nhlpp (date, game_id, player, market, commence, home, away, team, player_id, point, proj, model_under, gp_cur, prior_gp, toi_proj, book_line, book_under, captured_at, book_unders)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(ptDateOf(Date.parse(l.commence)), l.game_id, l.player, l.market, l.commence, l.home, l.away, l.team, l.player_id,
    l.point, l.proj, l.model_under, l.gp_cur, l.prior_gp, l.toi_proj, l.book_line, l.book_under, stamp, l.book_unders || null));
  // The pre-tip read fills each leg's close_ columns (logNbaPp's rule), and
  // book_unders as last read.
  if (close) for (const l of legs) stmts.push(db.prepare(
    'UPDATE nhlpp SET close_point=?, close_under=?, close_book_line=?, close_book_under=?, close_at=?, book_unders=COALESCE(?, book_unders) WHERE date=? AND game_id=? AND player=? AND market=?'
  ).bind(l.point, l.model_under, l.book_line, l.book_under, stamp, l.book_unders || null, ptDateOf(Date.parse(l.commence)), l.game_id, l.player, l.market));
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
  return legs.length;
}
// Cron: each game watched from 36 hours out, read when PrizePicks posts it and
// again before puck drop (ppReadDue, as the NBA log), the games taken from the
// free events list and the NHL board's snapshot (ppWatchGames).
// Paused 2026-10-25, the user's call: 39 of 84 unders (46%) landed at
// PrizePicks' lines against the backtest's 59-67%. Read again from 2026-10-27,
// the user's call, for the other side: where the model leaned More, 29 of 51
// landed through Oct 26 and 18 of 26 at a More chance of 55%+. The card lists
// Mores now; about 20-55 credits a day (Oct 23-25's reads).
const NHL_PP_PAUSED = false;
async function nhlPpMaybeCapture(env) {
  if (NHL_PP_PAUSED || !env || !env.DB || !env.ODDS_API_KEY) return null;
  const now = Date.now();
  const states = await ppReadStates(env.DB, 'nhl_pp_games', now);
  const due = (await ppWatchGames(env, 'nhl', 'reg', NHL_LEAGUES.reg, now))
    .map((g) => ({ g, what: ppReadDue(g.commence, states[g.id], now) })).filter((x) => x.what)
    .sort((a, b) => ((a.what === 'close' ? 0 : 1) - (b.what === 'close' ? 0 : 1)) || Date.parse(a.g.commence) - Date.parse(b.g.commence));
  if (!due.length) return null;
  await ensureNhlPpSchema(env.DB);
  let pri = null, cur = null;
  let calls = 0, logged = 0;
  const url = (id, markets, books) => `https://api.the-odds-api.com/v4/sports/icehockey_nhl/events/${id}/odds?apiKey=${env.ODDS_API_KEY}`
    + `&markets=${markets}&oddsFormat=american&dateFormat=iso&bookmakers=${books}`;
  for (const { g, what } of due) {
    if (calls >= NHL_PP_PER_TICK) break;
    const st = states[g.id] = { ...(states[g.id] || {}), commence: g.commence };
    try {
      if (what === 'check') {
        calls++;
        const c = await fetch(url(g.id, 'player_points', 'prizepicks'), { headers: { accept: 'application/json' } });
        await recordOddsUsage(env, c, 'nhl:reg:pp-check');
        st.checked = now;
        const cb = c.ok ? await c.json() : null;
        if (!(cb && (cb.bookmakers || []).some((b) => b.key === 'prizepicks'))) continue;
        st.posted = now;
        if (calls >= NHL_PP_PER_TICK) continue;
      }
      calls++;
      const r = await fetch(url(g.id, Object.keys(NHL_PP_MARKETS).join(','), NHL_PP_BOOKS.join(',')),
        { headers: { accept: 'application/json' } });
      await recordOddsUsage(env, r, 'nhl:reg:pp');
      if (!r.ok) continue;
      const body = await r.json();
      if (!pri) { pri = await nhlSkaters(env, NHL_SEASONS.prior, null); cur = await nhlSkaters(env, NHL_SEASONS.current, 3 * 3600e3); }
      const hasPP = !!(body && (body.bookmakers || []).some((b) => b.key === 'prizepicks'));
      logged += await logNhlPp(env.DB, nhlPpLegs(body, pri, cur), what === 'close');
      if (what === 'close') st.close = now;
      if (hasPP) st.first = st.first || now; else { st.posted = null; st.checked = now; }
      // The last payload with PrizePicks on it, as it came (/api/nhl-pp?raw=1).
      if (hasPP) await saveFeedCache(env.DB, NHL_PP_RAW_KEY, { at: new Date().toISOString(), game: g.id, credits: Number(r.headers.get('x-requests-last')) || null, body });
    } catch (e) { /* this game waits for the next tick */ }
  }
  await saveFeedCache(env.DB, 'nhl_pp_games', states);
  return { logged, calls, due: due.length };
}
// Pure: one NHL box score in, each skater's goals, assists and points by NHL id.
function nhlBoxLines(box) {
  const out = new Map();
  for (const side of ['awayTeam', 'homeTeam']) {
    const t = (box && box.playerByGameStats && box.playerByGameStats[side]) || {};
    for (const x of [...(t.forwards || []), ...(t.defense || [])]) {
      if (x && x.playerId != null) out.set(String(x.playerId), { g: x.goals, a: x.assists, p: x.points, toi: x.toi });
    }
  }
  return out;
}
// Grade from the NHL's own box scores (free), once an hour: a day's finished
// games, each player by NHL id. A logged player missing from a day whose
// games are all final did not play: void, never a free under.
async function gradeNhlPp(env) {
  if (!env || !env.DB) return 0;
  await ensureNhlPpSchema(env.DB);
  const gate = await loadFeedCache(env.DB, 'nhl_pp_grade');
  if (gate.present && gate.data && Date.now() - gate.data.at < 3600e3) return 0;
  await saveFeedCache(env.DB, 'nhl_pp_grade', { at: Date.now() });
  const open = ((await env.DB.prepare('SELECT * FROM nhlpp WHERE result IS NULL AND date < ?').bind(slateDate()).all()).results || []);
  const stmts = [];
  for (const day of [...new Set(open.map((r) => r.date))].slice(0, 3)) {
    let games = [];
    try { const r = await fetch(`https://api-web.nhle.com/v1/score/${day}`, { headers: { accept: 'application/json' } }); games = r.ok ? ((await r.json()).games || []) : []; } catch (e) { continue; }
    if (!games.length) continue;
    const settled = games.every((g) => g.gameState === 'OFF' || g.gameState === 'FINAL');
    const lines = new Map();
    for (const g of games.filter((x) => x.gameState === 'OFF' || x.gameState === 'FINAL')) {
      try {
        const r = await fetch(`https://api-web.nhle.com/v1/gamecenter/${g.id}/boxscore`, { headers: { accept: 'application/json' } });
        if (r.ok) for (const [id, v] of nhlBoxLines(await r.json())) lines.set(id, v);
      } catch (e) { /* that game grades next hour */ }
    }
    for (const r of open.filter((x) => x.date === day)) {
      const b = r.player_id && lines.get(String(r.player_id));
      let result = null, actual = null;
      if (b) {
        const v = r.market === 'pts' ? b.p : b.a;
        if (v == null) continue;
        actual = v; result = v < r.point ? 'under' : v > r.point ? 'over' : 'push';
      } else if (settled) result = 'void';
      if (!result) continue;
      const close = r.close_point == null ? null : result === 'void' ? 'void' : ppSide(actual, r.close_point);
      stmts.push(env.DB.prepare('UPDATE nhlpp SET result=?, actual=?, close_result=? WHERE date=? AND game_id=? AND player=? AND market=?')
        .bind(result, actual, close, r.date, r.game_id, r.player, r.market));
    }
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return stmts.length;
}
// GET /api/nhl-pp: tonight's logged legs, best under first, and the record --
// the unders by band, market and line gap, and the overs the same way, as the
// NBA log keeps them. ?raw=1: the last capture's payload. Free (D1 only).
async function nhlPpBoard(env, url) {
  if (!env || !env.DB) return { error: 'no DB binding' };
  if (url && url.searchParams && url.searchParams.get('raw') === '1') {
    const hit = await loadFeedCache(env.DB, NHL_PP_RAW_KEY);
    return hit.present ? hit.data : { none: 'no capture with PrizePicks on it yet' };
  }
  if (url && url.searchParams && url.searchParams.get('raw') === 'events') return ppEventsRaw(env, 'nhl', 'reg');
  const out = { note: 'LOGGED, not posted. The chance the under lands at PrizePicks’ line: Poisson at the skater’s scoring rate, this season blended with last. Points and assists, regulars (15+ minutes). The card lists the More side (100 minus it) since 2026-10-27.', legs: [], record: null,
    ...(NHL_PP_PAUSED ? { paused: '2026-10-25' } : {}) };
  try {
    await ensureNhlPpSchema(env.DB);
    const now = Date.now();
    const rows = (await env.DB.prepare('SELECT * FROM nhlpp WHERE date >= ? ORDER BY model_under DESC').bind(slateDateOffset(-1)).all()).results || [];
    out.legs = ppStanding(rows.filter((r) => Date.parse(r.commence) > now)).map((r) => ppCurrent(r)).map((r) => ({
      player: r.player, team: r.team, market: r.market, point: r.point, model_under: r.model_under, proj: r.proj, gp_cur: r.gp_cur,
      toi_proj: r.toi_proj, game: `${r.away} @ ${r.home}`, game_id: r.game_id, commence: r.commence, player_id: r.player_id,
      book_line: r.book_line, book_under: r.book_under, vsBook: r.book_line != null && r.point != null ? round1(r.point - r.book_line) : null,
      first_point: r.first_point, first_under: r.first_under, first_at: r.captured_at, close_at: r.close_at,
    })).sort((a, b) => b.model_under - a.model_under);
    const graded = (await env.DB.prepare("SELECT market, model_under, point, book_line, result, close_point, close_result FROM nhlpp WHERE result IN ('under','over','push')").all()).results || [];
    const gap = (g) => (g.book_line != null && g.point != null ? round1(g.point - g.book_line) : null);
    const un = ppSplitRecord(graded.map((g) => ({ p: g.model_under, won: g.result === 'under' ? 1 : (g.result === 'over' ? 0 : null), gap: gap(g) })));
    const lean = graded.filter((g) => g.model_under != null && g.model_under < 50);
    const ov = ppSplitRecord(lean.map((g) => ({ p: 100 - g.model_under, won: g.result === 'over' ? 1 : (g.result === 'under' ? 0 : null), gap: gap(g) })));
    const byMarket = (list, side) => Object.fromEntries(Object.values(NHL_PP_MARKETS).map((mk) => {
      const l = list.filter((g) => g.market === mk && g.result !== 'push');
      const hit = l.filter((g) => g.result === side).length;
      return [mk, { n: l.length, hit, hitRate: l.length ? round1(hit / l.length * 100) : null }];
    }));
    out.record = { scope: `regular skaters (${NHL_TOI_MIN}+ minutes), at PrizePicks’ line`, graded: un.n, hit: un.hit, hitRate: un.hitRate,
      byBand: un.byBand, byLineGap: un.byLineGap, byMarket: byMarket(graded, 'under'),
      overs: { graded: ov.n, hit: ov.hit, hitRate: ov.hitRate, byBand: ov.byBand, byLineGap: ov.byLineGap, byMarket: byMarket(lean, 'over') },
      more: ppMoreRecord(lean),
      ...ppCloseRecord(graded) };
  } catch (e) { out.error = String((e && e.message) || e); }
  return out;
}

// ---------------------------------------------------------------------------
// NBA — PrizePicks unders, logged (2026-10-06).
//
// The MLB Today's card never needed a sharp book: it ranks the under by the
// model's own chance at PrizePicks' line, and PrizePicks pays by entry type, not
// by price. The NBA version is the same claim. Threes, assists and rebounds,
// because those are where the under beat a player's recent average across two
// seasons of box scores (55.5%, 53.4% and 53.3%); points did not (51.6%).
// Every other PrizePicks market was run the same way on 2026-10-19, with a
// stricter median-line check: tools/nba-market-backtest.md. Blocks and steals
// were the two that held up at a line set at the median of a player's last ten
// (62.8% and 57.9%, rotation players, 2024-26), and are logged from opening
// night 2026-10-20 (the user's call: +2 credits a game). Logged only: Picks of
// the day leaves them out until they have a graded record of their own
// (NBA_PICK_MARKETS).
//
// Projection: the player's last ten regular-season games blended with last
// season's per-game average (nba-priors.json), the prior counting as
// NBA_PRIOR_K games -- the whole projection on opening night, a third of it by
// a player's tenth game. The chance of the under is a negative binomial at
// that mean. The dispersions were checked on 2025-26 (16,109 rotation games,
// 2024-25 as the prior, 2026-10-09): within 1-2 points of the realised under
// rate at every band from 50% to 90%, and a refit moved no leg by more than 1.2
// points, so they stand. That tests the model against any line, not against
// PrizePicks' -- which is what the record's bands are for. Blocks and steals
// were fitted the same way on 2026-10-20 (`node tools/nba-market-backtest.mjs
// disp`, 15,857 rotation games, which gives threes 1.25, ast 1.3, reb 1.35 --
// the Oct 9 fit): the likeliest dispersions are blocks 1.15 and steals 1.1,
// and at those the chance of the under at every .5 line is within 3 points of
// how often it landed, in every band from 50% to 100%.
// Recent games come from ESPN's box scores, read nightly into nba_box (free).
//
// Nothing here is posted. It is logged and graded, so the card has a record
// before anyone trusts it.
const NBA_PP_MARKETS = { player_threes: 'threes', player_assists: 'ast', player_rebounds: 'reb', player_blocks: 'blk', player_steals: 'stl' };
// Underdog and DraftKings Pick6 ride along (2026-10-22): the feed bills ten
// named books as one region, so the same read now says where each pick'em
// app sets its line. Only PrizePicks' lines are logged and graded.
// The sharp books joined on 2026-10-25 (NBA_SHARP: Pinnacle, LowVig,
// BetOnline, Novig, ProphetX), for the sharp-fair chance at PrizePicks' line:
// ten books in all, still one region, so the read costs what it did.
const NBA_PP_BOOKS = ['prizepicks', 'underdog', 'pick6', 'draftkings', 'fanduel', ...NBA_SHARP];
const NBA_PRIOR_K = 5;
const NBA_DISP = { threes: 1.15, ast: 1.25, reb: 1.2, blk: 1.15, stl: 1.1 };
// The markets Picks of the day may carry: the ones whose under it was built on.
// Blocks and steals join once their own graded record says their chance holds.
// Rebounds came off on 2026-10-23: 67 of 133 unders (50.4%) at PrizePicks'
// own lines in the first three nights, against 63% for assists and threes,
// and about 51% in the Oct 19 backtest. Still logged and graded on the card.
const NBA_PICK_MARKETS = ['threes', 'ast'];
// And no leg whose PrizePicks line sits below the books' (2026-10-23): that
// under is harder than the market's, and those legs landed 32 of 71 (45%)
// against 58-60% at or above the books' number.
const ppBelowBook = (r) => r.book_line != null && r.point != null && r.point < r.book_line;
const NBA_PP_VER = 'nbapp-v1';
const NBA_PP_PER_TICK = 5;                   // per-event calls a tick may make
// When PrizePicks' props are read (2026-10-23), for the NBA and NHL logs alike.
// They were read once, 4 hours before tip, but PrizePicks posts a game's lines
// as early as the night before, and that is when the user often builds an
// entry. So each game is watched from 36 hours out: every two hours a
// PrizePicks-only check of one market, which costs nothing while PrizePicks
// has posted nothing (an empty answer is not billed) and about 1 credit once
// it has. The first time it answers, the full read follows at once -- every
// market, with the books beside it -- and its lines are each leg's first
// line, the one the record grades. Then one more read inside 90 minutes of
// the start: the close, which updates each leg (the card shows what moved)
// and adds any leg posted since.
const PP_WATCH_MS = 36 * 3600e3;
const PP_WATCH_EVERY_MS = 2 * 3600e3;
const PP_CLOSE_MS = 90 * 60e3;
// Pure: what one game needs now -- 'check', 'first', 'close' or nothing.
// st is the game's read state: { checked, first, close } (times).
function ppReadDue(commence, st, now) {
  const t = Date.parse(commence);
  if (!isFinite(t) || t <= now || t - now > PP_WATCH_MS) return null;
  if (t - now <= PP_CLOSE_MS) return st && st.close ? null : 'close';
  if (st && st.first) return null;
  if (st && st.posted) return 'first';           // seen up, its full read not yet taken
  if (st && st.checked && now - st.checked < PP_WATCH_EVERY_MS) return null;
  return 'check';
}
// A logged leg as it stands now: the pre-tip read's line, chance and book
// line where one was read, the first read's otherwise, with the first kept.
const ppCurrent = (r) => (r.close_point == null
  ? { ...r, first_point: r.point, first_under: r.model_under }
  : { ...r, first_point: r.point, first_under: r.model_under, point: r.close_point, model_under: r.close_under,
    book_line: r.close_book_line, book_under: r.close_book_under,
    sharp_under: r.close_sharp_under != null ? r.close_sharp_under : (r.close_at && r.sharp_under != null ? null : r.sharp_under) });
// Which side a count landed on against a line.
const ppSide = (actual, line) => (actual < line ? 'under' : actual > line ? 'over' : 'push');
// The More side of legs the model leaned More on (2026-10-27): all of them,
// and those at a More chance of PP_MORE_MIN or better -- the bar the NBA
// card's blocks and the NHL card list them at. Graded at the first line, as
// every leg is.
const PP_MORE_MIN = 55;
function ppMoreRecord(lean) {
  const cell = (l) => {
    const d = l.filter((g) => g.result === 'over' || g.result === 'under');
    const hit = d.filter((g) => g.result === 'over').length;
    return { n: d.length, hit, hitRate: d.length ? round1(hit / d.length * 100) : null };
  };
  return { bar: PP_MORE_MIN, leaned: cell(lean), atBar: cell(lean.filter((g) => 100 - g.model_under >= PP_MORE_MIN)) };
}
// The legs PrizePicks still has up. One whose game had the pre-tip read and
// that was not on it was taken down after the first read -- most often a
// player ruled out -- so it leaves the card and the list. It still grades at
// its first line, as every leg does.
function ppStanding(rows) {
  const reread = new Set(rows.filter((r) => r.close_at).map((r) => r.game_id));
  return rows.filter((r) => r.close_point != null || !reread.has(r.game_id));
}
// The record a pre-tip read adds (2026-10-23): how the legs graded at the
// line read before tip, and where PrizePicks moved its number after the first
// read -- raised (the first line's under was the easier one), lowered, or
// kept -- with how the first line's under landed in each.
function ppCloseRecord(rows) {
  const cell = (l, key) => { const d = l.filter((g) => g[key] === 'under' || g[key] === 'over'); const hit = d.filter((g) => g[key] === 'under').length;
    return { n: d.length, hit, hitRate: d.length ? round1(hit / d.length * 100) : null }; };
  const read = rows.filter((g) => g.close_point != null);
  return {
    atClose: cell(read, 'close_result'),
    moved: {
      raised: cell(read.filter((g) => g.close_point > g.point), 'result'),
      lowered: cell(read.filter((g) => g.close_point < g.point), 'result'),
      kept: cell(read.filter((g) => g.close_point === g.point), 'result'),
    },
  };
}
// Each game's read state, kept a day past its start.
async function ppReadStates(db, key, now) {
  const hit = await loadFeedCache(db, key);
  const all = (hit.present && hit.data) || {};
  for (const [id, s] of Object.entries(all)) if (!s || !(Date.parse(s.commence) > now - 864e5)) delete all[id];
  return all;
}
// The games to watch (2026-10-23): the feed's events list, which costs
// nothing, read every two hours and kept as it came in feed_cache
// `${sport}_pp_events:${lg}` (?raw=events), with the moneyline board's
// snapshot beside it. The snapshot alone holds only games the books have
// priced: on Friday afternoon it had none of Saturday's, so nothing for
// Saturday was checked while PrizePicks may already have posted it.
const PP_EVENTS_EVERY_MS = 2 * 3600e3;
async function ppWatchGames(env, sport, lg, sportKey, now) {
  const key = `${sport}_pp_events:${lg}`;
  const hit = await loadFeedCache(env.DB, key);
  let ev = hit.present ? hit.data : null;
  if (!(ev && now - Date.parse(ev.at) < PP_EVENTS_EVERY_MS)) {
    let list = null;
    try {
      const r = await fetch(`https://api.the-odds-api.com/v4/sports/${sportKey}/events?apiKey=${env.ODDS_API_KEY}&dateFormat=iso`,
        { headers: { accept: 'application/json' } });
      await recordOddsUsage(env, r, `${sport}:${lg}:pp-events`);
      const body = r.ok ? await r.json() : null;
      if (Array.isArray(body)) list = body;
    } catch (e) { /* the last list, or the snapshot, stands in */ }
    // A failed read keeps the last list and waits the two hours, not a tick.
    ev = { at: new Date(now).toISOString(), events: list || (ev && ev.events) || [], ...(list ? {} : { failed: true }) };
    await saveFeedCache(env.DB, key, ev);
  }
  const snap = await loadFeedCache(env.DB, `${sport}_board:${lg}`);
  const games = new Map();
  for (const g of ((snap.present && snap.data && snap.data.games) || [])) games.set(g.id, { id: g.id, commence: g.commence, home: g.home, away: g.away });
  for (const e of (ev.events || [])) {
    if (e && e.id && e.commence_time) games.set(e.id, { id: e.id, commence: e.commence_time, home: e.home_team, away: e.away_team });
  }
  return [...games.values()];
}
const NBA_PP_RAW_KEY = 'nba_pp_raw';         // feed_cache: the last capture's payload
const NBA_PP_UNMATCHED_DAYS = 30;            // a name with no prior stays on the raw payload's log this long after last seen
const NBA_BOX_PER_TICK = 4;                  // box scores a tick may read
const NBA_SEASON_FROM = '2026-10-01';        // recent games: this season only
const ESPN_CDN_NBA = 'https://cdn.espn.com/core/nba';
const NBA_ROTATION_MIN = 20;                 // projected minutes; the card shows only these

// How a PrizePicks under has done, split two ways. `items`: { p (the model's
// chance, %), won (1, 0, or null for a push), gap (PrizePicks' number minus the
// books' line, or null with no book) }.
//   byBand: in MLB the model's number carried nothing below 65% at PrizePicks'
//     lines (about 50% wherever it pointed) and held up only above it, so the
//     record has to show the bands rather than one average.
//   byLineGap: PrizePicks follows the books but moves slower. Where its number
//     sits ABOVE the books' line its under is easier than the market's, which
//     is an edge that needs no model at all -- if it holds.
const PP_BANDS = [['<55', 0, 55], ['55-60', 55, 60], ['60-65', 60, 65], ['65-70', 65, 70], ['70+', 70, 101]];
function ppSplitRecord(items) {
  const cell = (l) => {
    const g = l.filter((x) => x.won != null);
    const hit = g.filter((x) => x.won === 1).length;
    return { n: g.length, hit, hitRate: g.length ? round1(hit / g.length * 100) : null };
  };
  const out = { ...cell(items) };
  if (items.some((x) => x.p != null)) {
    out.byBand = Object.fromEntries(PP_BANDS.map(([k, lo, hi]) => [k, cell(items.filter((x) => x.p != null && x.p >= lo && x.p < hi))]));
  }
  out.byLineGap = {
    ppHigher: cell(items.filter((x) => x.gap != null && x.gap > 0)),
    same: cell(items.filter((x) => x.gap === 0)),
    ppLower: cell(items.filter((x) => x.gap != null && x.gap < 0)),
    noBook: cell(items.filter((x) => x.gap == null)),
  };
  return out;
}

// Every count in ESPN's box score line, kept since 2026-10-15 so any PrizePicks
// market can be graded and backtested, not only the three logged. Each column
// is its market's key: threes is 3-pointers made, fg3a attempted, fga shots
// taken. A combo is the sum of its parts, and a part missing is no stat --
// games read before these columns existed grade void on them, never 0.
const NBA_BOX_STATS = ['pts', 'reb', 'ast', 'threes', 'fg3a', 'fgm', 'fga', 'ftm', 'fta', 'oreb', 'dreb', 'stl', 'blk', 'tov', 'pf'];
const NBA_COMBOS = { pra: ['pts', 'reb', 'ast'], pts_reb: ['pts', 'reb'], pts_ast: ['pts', 'ast'], reb_ast: ['reb', 'ast'], blk_stl: ['blk', 'stl'] };
function nbaStat(b, market) {
  const parts = NBA_COMBOS[market] || (NBA_BOX_STATS.includes(market) ? [market] : null);
  if (!b || !parts) return null;
  let s = 0;
  for (const k of parts) { if (b[k] == null) return null; s += b[k]; }
  return s;
}
const nbaPropMarket = (m) => NBA_BOX_STATS.includes(m) || !!NBA_COMBOS[m];

async function ensureNbaSchema(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS nba_box (
    game_id TEXT NOT NULL, date TEXT NOT NULL, season_type INTEGER,
    player_id TEXT NOT NULL, player TEXT, team TEXT,
    min REAL, threes INTEGER, ast INTEGER, reb INTEGER, starter INTEGER, dnp INTEGER,
    PRIMARY KEY (game_id, player_id)
  )`).run();
  // Forward only: rows already read keep what they were read with.
  await addColumns(db, 'nba_box', NBA_BOX_STATS.filter((k) => !['threes', 'ast', 'reb'].includes(k)).map((k) => [k, 'INTEGER']));
  await db.prepare('CREATE INDEX IF NOT EXISTS nba_box_date ON nba_box (date)').run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS nba_box_games (
    game_id TEXT PRIMARY KEY, date TEXT, season_type INTEGER, done INTEGER DEFAULT 0
  )`).run();
  // "Which games are left to read" every tick, and a day's read and unread
  // counts for each day with open legs: each scanned every game of the season.
  await db.prepare('CREATE INDEX IF NOT EXISTS nba_box_games_todo ON nba_box_games (done, date)').run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS nbapp (
    date TEXT NOT NULL, game_id TEXT NOT NULL, player TEXT NOT NULL, market TEXT NOT NULL,
    league TEXT, commence TEXT, home TEXT, away TEXT, team TEXT, player_id TEXT,
    point REAL, proj REAL, model_under REAL, n_recent INTEGER, prior_gp INTEGER, min_proj REAL,
    book_line REAL, book_under INTEGER, actual REAL, result TEXT, model_ver TEXT, captured_at TEXT,
    PRIMARY KEY (date, game_id, player, market)
  )`).run();
  await db.prepare('CREATE INDEX IF NOT EXISTS nbapp_ungraded ON nbapp (date) WHERE result IS NULL').run();
  // The pre-tip read beside the first (2026-10-23): point and model_under are
  // the first line's, graded as result; the close_ columns are the last read
  // before tip, graded as close_result.
  await addColumns(db, 'nbapp', PP_CLOSE_COLS);
  // Underdog's and Pick6's lines on the same under, as last read (2026-10-25).
  await addColumns(db, 'nbapp', [['ud_line', 'REAL'], ['p6_line', 'REAL']]);
  // The sharp books' chance of the under at PrizePicks' line, at the first
  // read and the pre-tip one, and his season's games against the line as last
  // read (2026-10-25).
  await addColumns(db, 'nbapp', [['sharp_under', 'REAL'], ['sharp_n', 'INTEGER'], ['sharp_src', 'TEXT'], ['close_sharp_under', 'REAL'],
    ['l10_n', 'INTEGER'], ['l10_under', 'INTEGER']]);
  // Every book's own line and no-vig under there (2026-10-27): bookUndersJson.
  // And the sharp books' chance of the under at Pick6's line (pickemEdges).
  await addColumns(db, 'nbapp', [['book_unders', 'TEXT'], ['p6_sharp_under', 'REAL']]);
}
const PP_CLOSE_COLS = [['close_point', 'REAL'], ['close_under', 'REAL'], ['close_book_line', 'REAL'], ['close_book_under', 'INTEGER'],
  ['close_at', 'TEXT'], ['close_result', 'TEXT']];

// Accents are stripped as well as case and suffixes: "Nikola Jokić" in one feed
// is "Nikola Jokic" in the other.
const nbaBaseName = (s) => nflBaseName(String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
// Where PrizePicks' name for a player is not ESPN's even then: its name -> the
// one in nba-priors.json. On opening night 2026-10-20 its "Ron Holland" found
// no prior and his rebounds leg was never logged. Every name goes through it,
// priors included, so a player whose own name is one of these collides with the
// aliased one and both are dropped (nbaPriors), never given each other's legs.
const NBA_NAME_ALIAS = { 'Ron Holland': 'Ronald Holland II' };
let NBA_ALIAS = null;   // built on first use: nflBaseName is defined further down
const nbaName = (s) => {
  if (!NBA_ALIAS) NBA_ALIAS = new Map(Object.entries(NBA_NAME_ALIAS).map(([a, b]) => [nbaBaseName(a), nbaBaseName(b)]));
  const k = nbaBaseName(s);
  return NBA_ALIAS.get(k) || k;
};

let NBA_PRIORS = null;
async function nbaPriors(env) {
  if (NBA_PRIORS) return NBA_PRIORS;
  try {
    const r = await env.ASSETS.fetch(new Request('https://x/nba-priors.json'));
    if (r.ok) {
      const d = await r.json();
      const byName = new Map();
      for (const [id, pl] of Object.entries(d.players || {})) {
        const k = nbaName(pl.n);
        // Two players with one name are both dropped: a leg handed to the wrong
        // one is worse than a leg with no projection.
        byName.set(k, byName.has(k) ? null : { id, ...pl });
      }
      NBA_PRIORS = { ...d, byName };
    }
  } catch (e) { /* asset missing -> nothing is projected rather than something wrong */ }
  return NBA_PRIORS;
}

// One player's per-game rows, newest first, from this season's regular season
// and playoffs. Preseason minutes are not a player's real role.
async function nbaRecentMap(db) {
  // Every logged market's column: a market missing here projects from last
  // season alone, however many games he has played.
  const rows = ((await db.prepare(
    `SELECT player_id, date, min, ${[...new Set(Object.values(NBA_PP_MARKETS))].join(', ')} FROM nba_box WHERE season_type IN (2,3) AND dnp = 0 AND date >= ? ORDER BY date DESC`
  ).bind(NBA_SEASON_FROM).all()).results || []);
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r.player_id)) m.set(r.player_id, []);
    const a = m.get(r.player_id);
    if (a.length < 10) a.push(r);
  }
  return m;
}

// The sharp books' chance of an under at PrizePicks' number (2026-10-25): the
// way every +EV pick'em guide prices a leg -- a sharp book's two-way price,
// de-vigged -- and the way this site's moneylines are priced (12 of 13 NBA
// favourites landed by Oct 25, while the box-score model ran about 52% at
// PrizePicks' lines). Each sharp book's Over/Under on the player, Shin
// de-vigged, gives its fair chance of the under at its own line; that chance
// fixes the projection the book is pricing (the mean whose distribution puts
// that much under its line, at the market's dispersion), and the projection
// prices the under at PrizePicks' line, so a book a half point off still
// counts. A whole-number book line is fair over the two non-push outcomes. The
// median over the sharp books that quote him; null when none does.
// FanDuel joined on 2026-10-27: Pikkit's 2024 NBA props ranking has it first
// (FanDuel, BookMaker, Propbuilder, Novig, Pinnacle), it quotes all five of
// the log's markets, and Pinnacle posts none in this feed. It was already
// read, as an execution book.
const NBA_PROP_SHARP = ['fanduel', ...NBA_SHARP];
function nbaSharpUnder(ev, mk, name, line, disp) {
  const below = (mu, b) => negBinomCdf(Math.ceil(b) - 1, mu, disp);                   // P(X < b)
  const under = (mu, b) => (Number.isInteger(b) ? below(mu, b) / (below(mu, b) + 1 - negBinomCdf(b, mu, disp)) : below(mu, b));
  const at = [];
  const src = [];
  for (const bk of NBA_PROP_SHARP) {
    const b = (ev.bookmakers || []).find((x) => x.key === bk);
    const m = b && (b.markets || []).find((x) => x.key === mk);
    if (!m) continue;
    // The book's line nearest PrizePicks' with both sides quoted.
    const mine = (m.outcomes || []).filter((o) => nbaName(o.description) === name && o.point != null && typeof o.price === 'number');
    const pts = [...new Set(mine.map((o) => o.point))].filter((p) => mine.some((o) => o.point === p && o.name === 'Over') && mine.some((o) => o.point === p && o.name === 'Under'));
    if (!pts.length) continue;
    const p = pts.sort((a, c) => Math.abs(a - line) - Math.abs(c - line))[0];
    const fair = shinDevig(mine.find((o) => o.point === p && o.name === 'Under').price, mine.find((o) => o.point === p && o.name === 'Over').price);
    if (fair == null || !(fair > 0 && fair < 1)) continue;
    let lo = 0.001, hi = Math.max(5, p * 4 + 5);                                       // under falls as the mean rises
    for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (under(mid, p) > fair) lo = mid; else hi = mid; }
    at.push(below((lo + hi) / 2, line));
    src.push(bk);
  }
  if (!at.length) return null;
  at.sort((a, c) => a - c);
  const med = at.length % 2 ? at[(at.length - 1) / 2] : (at[at.length / 2 - 1] + at[at.length / 2]) / 2;
  return { under: round1(med * 100), n: at.length, src: src.join(',') };
}
// Every book's own line and no-vig chance of the under there (2026-10-27),
// as a leg's book_unders (JSON, book -> [line, percent]): graded against the
// count, it scores each book on the same legs. A book's line is the one it
// quotes both ways nearest an even price -- its main line. NBA and NHL legs
// alike, each matching names its own way (nameOf).
function bookUndersJson(ev, mk, name, nameOf = nbaName) {
  const out = {};
  for (const b of (ev.bookmakers || [])) {
    const m = !DFS_BOOKS.has(b.key) && (b.markets || []).find((x) => x.key === mk);
    if (!m) continue;
    const mine = (m.outcomes || []).filter((o) => nameOf(o.description) === name && o.point != null && typeof o.price === 'number');
    let best = null;
    for (const p of new Set(mine.map((o) => o.point))) {
      const u = mine.find((o) => o.point === p && o.name === 'Under'), ov = mine.find((o) => o.point === p && o.name === 'Over');
      if (!u || !ov) continue;
      const f = shinDevig(u.price, ov.price);
      if (f == null || !(f > 0 && f < 1)) continue;
      if (!best || Math.abs(f - 0.5) < Math.abs(best[1] - 0.5)) best = [p, f];
    }
    if (best) out[b.key] = [best[0], round1(best[1] * 100)];
  }
  return Object.keys(out).length ? JSON.stringify(out) : null;
}

// Pure: one event's odds in, log rows out.
function nbaPpLegs(ev, pri, recent) {
  const out = [];
  if (!ev || !pri) return out;
  const pp = (ev.bookmakers || []).find((b) => b.key === 'prizepicks');
  if (!pp) return out;
  // The other pick'em apps' line on the same under (2026-10-25). The read has
  // carried them since Oct 22 at no extra credit; a higher number there is an
  // easier under than PrizePicks'.
  const dfsLine = (bk, mk, name) => {
    const b = (ev.bookmakers || []).find((x) => x.key === bk);
    const m = b && (b.markets || []).find((x) => x.key === mk);
    const u = m && (m.outcomes || []).find((o) => o.name === 'Under' && nbaName(o.description) === name);
    return u && u.point != null ? u.point : null;
  };
  const bookLine = (mk, name) => {
    for (const bk of ['draftkings', 'fanduel']) {
      const b = (ev.bookmakers || []).find((x) => x.key === bk);
      const m = b && (b.markets || []).find((x) => x.key === mk);
      const u = m && (m.outcomes || []).find((o) => o.name === 'Under' && nbaName(o.description) === name);
      if (u && u.point != null) return { line: u.point, price: typeof u.price === 'number' ? u.price : null };
    }
    return { line: null, price: null };
  };
  for (const m of (pp.markets || [])) {
    const market = NBA_PP_MARKETS[m.key];
    if (!market) continue;
    const seen = new Set();
    for (const o of (m.outcomes || [])) {
      // The line is the one PrizePicks takes an under on. A point it quotes
      // over-only (its demons and goblins) is not that, whichever comes first.
      if (o.name !== 'Under') continue;
      const name = nbaName(o.description);
      if (!name || seen.has(name) || o.point == null) continue;
      seen.add(name);
      const pl = pri.byName.get(name);
      if (!pl) continue;
      const rec = (recent.get(pl.id) || []).map((r) => r[market]).filter((v) => v != null);
      const priorAvg = pl.gp >= 5 && typeof pl[market] === 'number' ? pl[market] : null;
      let proj;
      if (priorAvg != null) proj = (rec.reduce((a, b) => a + b, 0) + NBA_PRIOR_K * priorAvg) / (rec.length + NBA_PRIOR_K);
      else if (rec.length >= 3) proj = rec.reduce((a, b) => a + b, 0) / rec.length;
      else continue;   // a rookie or a returner with no games yet: nothing to stand on
      const under = negBinomCdf(Math.ceil(o.point) - 1, proj, NBA_DISP[market]);
      // Minutes, blended the same way. The highest under-chances belong to the
      // bench -- an 0.5 line on a player who barely plays -- and those are the
      // players who sit out entirely; the card shows rotation players only.
      const recMin = (recent.get(pl.id) || []).map((r) => r.min).filter((v) => v != null);
      const priorMin = pl.gp >= 5 && typeof pl.min === 'number' ? pl.min : null;
      const minProj = priorMin != null
        ? (recMin.reduce((a, b) => a + b, 0) + NBA_PRIOR_K * priorMin) / (recMin.length + NBA_PRIOR_K)
        : (recMin.length ? recMin.reduce((a, b) => a + b, 0) / recMin.length : null);
      const bl = bookLine(m.key, name);
      const sh = nbaSharpUnder(ev, m.key, name, o.point, NBA_DISP[market]);
      // The sharp books' chance at Pick6's number too (2026-10-27): Pick6
      // seldom moves a line once posted, so where the market has moved since,
      // its number is stale (pickemEdges).
      const p6l = dfsLine('pick6', m.key, name);
      const sh6 = p6l != null ? nbaSharpUnder(ev, m.key, name, p6l, NBA_DISP[market]) : null;
      out.push({
        game_id: ev.id, commence: ev.commence_time, home: ev.home_team, away: ev.away_team,
        player: o.description, player_id: pl.id, team: pl.tm || null, market, point: o.point,
        proj: round1(proj), model_under: round1(under * 100), n_recent: rec.length, prior_gp: pl.gp || 0,
        min_proj: minProj != null ? round1(minProj) : null, book_line: bl.line, book_under: bl.price,
        ud_line: dfsLine('underdog', m.key, name), p6_line: p6l,
        sharp_under: sh ? sh.under : null, sharp_n: sh ? sh.n : null, sharp_src: sh ? sh.src : null,
        p6_sharp_under: sh6 ? sh6.under : null,
        book_unders: bookUndersJson(ev, m.key, name),
        // His games this season against this line (2026-10-25): context, not
        // a forecast -- recent form regresses, which is why the projection
        // blends it with last season.
        l10_n: rec.length, l10_under: rec.filter((v) => v < o.point).length,
      });
    }
  }
  return out;
}

// Pure: the PrizePicks names in one event that find no prior -- none by that
// name, or two (nbaPriors drops both). Every leg of theirs goes unlogged, and a
// name ESPN spells differently belongs in NBA_NAME_ALIAS.
function nbaPpUnmatched(ev, pri) {
  const pp = ev && pri && (ev.bookmakers || []).find((b) => b.key === 'prizepicks');
  if (!pp) return [];
  const out = new Map();
  for (const m of (pp.markets || [])) {
    const market = NBA_PP_MARKETS[m.key];
    if (!market) continue;
    for (const o of (m.outcomes || [])) {
      if (o.name !== 'Under' || !o.description) continue;
      const pl = pri.byName.get(nbaName(o.description));
      if (pl) continue;
      const u = out.get(o.description) || { name: o.description, why: pl === null ? 'two players' : 'no prior', markets: [] };
      if (!u.markets.includes(market)) u.markets.push(market);
      out.set(o.description, u);
    }
  }
  return [...out.values()];
}

// Pure: the misses across captures, last seen first. The raw payload is only
// ever the last game, and a miss in an earlier one went with it (opening
// night's 76ers @ Knicks), so each capture carries the list on. A name that
// matches now -- an alias added, the priors rebuilt -- comes off, and so does
// one not seen in NBA_PP_UNMATCHED_DAYS.
function nbaPpUnmatchedLog(prev, cur, pri, at, ev) {
  const stamp = new Date(at).toISOString();
  const out = new Map();
  for (const u of (prev || [])) {
    if ((pri && pri.byName.get(nbaName(u.name))) || !(Date.parse(u.last) >= at - NBA_PP_UNMATCHED_DAYS * 86400e3)) continue;
    out.set(u.name, u);
  }
  for (const u of cur) {
    const was = out.get(u.name);
    out.set(u.name, { name: u.name, why: u.why, markets: [...new Set([...(was ? was.markets : []), ...u.markets])],
      captures: (was ? was.captures : 0) + 1, first: was ? was.first : stamp, last: stamp,
      game: `${ev.away_team} @ ${ev.home_team}`, date: ptDateOf(Date.parse(ev.commence_time)) });
  }
  return [...out.values()].sort((a, b) => (a.last < b.last ? 1 : a.last > b.last ? -1 : 0));
}

// A leg is written once, at its first line; a later read (close: true) also
// fills its close_ columns, and a leg first seen then is written with both.
async function logNbaPp(db, lg, legs, close) {
  if (!legs.length) return 0;
  const stamp = new Date().toISOString();
  const stmts = [];
  for (const l of legs) {
    const day = ptDateOf(Date.parse(l.commence));
    stmts.push(db.prepare(
      `INSERT OR IGNORE INTO nbapp (date, game_id, player, market, league, commence, home, away, team, player_id, point, proj, model_under, n_recent, prior_gp, min_proj, book_line, book_under, model_ver, captured_at, ud_line, p6_line,
         sharp_under, sharp_n, sharp_src, l10_n, l10_under, book_unders, p6_sharp_under)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(day, l.game_id, l.player, l.market, lg, l.commence, l.home, l.away, l.team, l.player_id,
      l.point, l.proj, l.model_under, l.n_recent, l.prior_gp, l.min_proj, l.book_line, l.book_under, NBA_PP_VER, stamp,
      l.ud_line == null ? null : l.ud_line, l.p6_line == null ? null : l.p6_line,
      l.sharp_under == null ? null : l.sharp_under, l.sharp_n == null ? null : l.sharp_n, l.sharp_src || null,
      l.l10_n == null ? null : l.l10_n, l.l10_under == null ? null : l.l10_under, l.book_unders || null,
      l.p6_sharp_under == null ? null : l.p6_sharp_under));
    // book_unders as last read: the pre-tip read's lines are the sharper ones.
    // p6_line and its sharp chance likewise, a pair read together.
    if (close) stmts.push(db.prepare(
      'UPDATE nbapp SET close_point=?, close_under=?, close_book_line=?, close_book_under=?, close_at=?, ud_line=?, p6_line=?, close_sharp_under=?, l10_n=?, l10_under=?, book_unders=COALESCE(?, book_unders), p6_sharp_under=? WHERE date=? AND game_id=? AND player=? AND market=?'
    ).bind(l.point, l.model_under, l.book_line, l.book_under, stamp, l.ud_line == null ? null : l.ud_line, l.p6_line == null ? null : l.p6_line,
      l.sharp_under == null ? null : l.sharp_under, l.l10_n == null ? null : l.l10_n, l.l10_under == null ? null : l.l10_under, l.book_unders || null,
      l.p6_sharp_under == null ? null : l.p6_sharp_under, day, l.game_id, l.player, l.market));
  }
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
  return legs.length;
}

// Cron: each game watched from 36 hours out, read when PrizePicks posts it and
// again before tip (ppReadDue), the games taken from the free events list and
// the board's snapshot (ppWatchGames). A few calls a tick, pre-tip reads first.
async function nbaPpMaybeCapture(env) {
  if (!env || !env.DB || !env.ODDS_API_KEY) return null;
  const now = Date.now();
  const states = await ppReadStates(env.DB, 'nba_pp_games', now);
  const due = [];
  for (const lg of Object.keys(NBA_LEAGUES)) {
    for (const g of await ppWatchGames(env, 'nba', lg, NBA_LEAGUES[lg], now)) {
      const what = ppReadDue(g.commence, states[g.id], now);
      if (what) due.push({ lg, g, what });
    }
  }
  if (!due.length) return null;
  due.sort((a, b) => ((a.what === 'close' ? 0 : 1) - (b.what === 'close' ? 0 : 1)) || Date.parse(a.g.commence) - Date.parse(b.g.commence));
  await ensureNbaSchema(env.DB);
  let pri = null, recent = null;
  let calls = 0, logged = 0;
  const url = (lg, id, markets, books) => `https://api.the-odds-api.com/v4/sports/${NBA_LEAGUES[lg]}/events/${id}/odds?apiKey=${env.ODDS_API_KEY}`
    + `&markets=${markets}&oddsFormat=american&dateFormat=iso&bookmakers=${books}`;
  for (const { lg, g, what } of due) {
    if (calls >= NBA_PP_PER_TICK) break;
    const st = states[g.id] = { ...(states[g.id] || {}), commence: g.commence };
    try {
      if (what === 'check') {
        // PrizePicks alone, one market: free until it has posted.
        calls++;
        const c = await fetch(url(lg, g.id, 'player_rebounds', 'prizepicks'), { headers: { accept: 'application/json' } });
        await recordOddsUsage(env, c, `nba:${lg}:pp-check`);
        st.checked = now;
        const cb = c.ok ? await c.json() : null;
        if (!(cb && (cb.bookmakers || []).some((b) => b.key === 'prizepicks'))) continue;
        st.posted = now;
        if (calls >= NBA_PP_PER_TICK) continue;      // the full read takes the next tick
      }
      calls++;
      const r = await fetch(url(lg, g.id, Object.keys(NBA_PP_MARKETS).join(','), NBA_PP_BOOKS.join(',')),
        { headers: { accept: 'application/json' } });
      await recordOddsUsage(env, r, `nba:${lg}:pp`);
      if (!r.ok) continue;
      const body = await r.json();
      if (!pri) { pri = await nbaPriors(env); recent = await nbaRecentMap(env.DB); }
      const hasPP = !!(body && (body.bookmakers || []).some((b) => b.key === 'prizepicks'));
      logged += await logNbaPp(env.DB, lg, nbaPpLegs(body, pri, recent), what === 'close');
      if (what === 'close') st.close = now;
      if (hasPP) st.first = st.first || now; else { st.posted = null; st.checked = now; }
      // The last payload with PrizePicks on it, kept as it came so a test can
      // replay a real one (/api/nba-pp?raw=1). No extra call, no extra credit.
      // With it, the PrizePicks names that found no prior: this game's, and
      // the log carried on from earlier captures.
      if (body && (body.bookmakers || []).some((b) => b.key === 'prizepicks')) {
        const unmatched = nbaPpUnmatched(body, pri);
        const prev = await loadFeedCache(env.DB, NBA_PP_RAW_KEY);
        await saveFeedCache(env.DB, NBA_PP_RAW_KEY, { at: new Date().toISOString(), league: lg, game: g.id,
          credits: Number(r.headers.get('x-requests-last')) || null, unmatched,
          unmatchedLog: nbaPpUnmatchedLog(prev.present && prev.data && prev.data.unmatchedLog, unmatched, pri, Date.now(), body), body });
      }
    } catch (e) { /* this game waits for the next tick */ }
  }
  await saveFeedCache(env.DB, 'nba_pp_games', states);
  return { logged, calls, due: due.length };
}

// Pure: one ESPN box score in, one row per player out.
function nbaBoxRows(sum, gameId, date, seasonType) {
  const box = (sum && sum.gamepackageJSON && sum.gamepackageJSON.boxscore) || (sum && sum.boxscore) || {};
  const out = [];
  for (const team of (box.players || [])) {
    const st = (team.statistics || [])[0];
    if (!st) continue;
    const L = (st.labels || st.names || []).map((x) => String(x).toUpperCase());
    const at = (k) => L.indexOf(k);
    const iMin = at('MIN'), i3 = at('3PT'), iReb = at('REB'), iAst = at('AST');
    const iPts = at('PTS'), iFg = at('FG'), iFt = at('FT'), iOreb = at('OREB'), iDreb = at('DREB');
    const iStl = at('STL'), iBlk = at('BLK'), iTo = at('TO'), iPf = at('PF');
    for (const a of (st.athletes || [])) {
      const ath = a.athlete || {};
      if (!ath.id) continue;
      const v = a.stats || [];
      // "4-7" is made-attempted: part 0 is made, part 1 attempted. A column
      // ESPN did not send is no stat, not a zero.
      const part = (i, k) => {
        if (i < 0) return null;
        const n = Number(String(v[i] == null ? '' : v[i]).split('-')[k]); return Number.isFinite(n) ? n : null;
      };
      const num = (i) => part(i, 0), att = (i) => part(i, 1);
      const dnp = !!a.didNotPlay || !v.length;
      const line = {
        min: num(iMin), pts: num(iPts), reb: num(iReb), ast: num(iAst),
        threes: num(i3), fg3a: att(i3), fgm: num(iFg), fga: att(iFg), ftm: num(iFt), fta: att(iFt),
        oreb: num(iOreb), dreb: num(iDreb), stl: num(iStl), blk: num(iBlk), tov: num(iTo), pf: num(iPf),
      };
      out.push({
        game_id: String(gameId), date, season_type: seasonType, player_id: String(ath.id), player: ath.displayName || '',
        team: (team.team && team.team.abbreviation) || null,
        ...Object.fromEntries(Object.entries(line).map(([k, x]) => [k, dnp ? null : x])),
        starter: a.starter ? 1 : 0, dnp: dnp ? 1 : 0,
      });
    }
  }
  return out;
}

// Cron: an hourly scan of yesterday and today for finished games, then a few
// box scores a tick. Free -- ESPN's cdn host, the one a Worker can reach.
async function nbaBoxIngest(env) {
  if (!env || !env.DB) return null;
  await ensureNbaSchema(env.DB);
  const scan = await loadFeedCache(env.DB, 'nba_box_scan');
  const st = (scan.present && scan.data) || {};
  if (!st.checked || Date.now() - st.checked >= 3600e3) {
    for (const day of [slateDateOffset(-1), slateDate()]) {
      let evs = [];
      // ?date= (singular): ?dates= is ignored and answers with tonight's games.
      try { evs = await espnScoreboard(`nba/scoreboard?xhr=1&date=${day.replace(/-/g, '')}`); } catch (e) { continue; }
      const stmts = [];
      for (const ev of evs) {
        const name = (ev && ev.status && ev.status.type && ev.status.type.name) || '';
        if (!/FINAL/.test(name) || !ev.id) continue;
        stmts.push(env.DB.prepare('INSERT OR IGNORE INTO nba_box_games (game_id, date, season_type, done) VALUES (?,?,?,0)')
          .bind(String(ev.id), day, (ev.season && ev.season.type) || null));
      }
      if (stmts.length) await env.DB.batch(stmts);
    }
    await saveFeedCache(env.DB, 'nba_box_scan', { checked: Date.now() });
  }
  // Oldest found first, the order the scan this replaced returned them in.
  const todo = ((await env.DB.prepare('SELECT game_id, date, season_type FROM nba_box_games WHERE done = 0 ORDER BY rowid LIMIT ?')
    .bind(NBA_BOX_PER_TICK).all()).results || []);
  let read = 0;
  for (const g of todo) {
    try {
      const r = await fetch(`${ESPN_CDN_NBA}/boxscore?xhr=1&gameId=${g.game_id}`, { headers: { accept: 'application/json', 'user-agent': ESPN_UA } });
      if (!r.ok) continue;
      const rows = nbaBoxRows(await r.json(), g.game_id, g.date, g.season_type);
      if (!rows.length) continue;
      const cols = ['game_id', 'date', 'season_type', 'player_id', 'player', 'team', 'min', ...NBA_BOX_STATS, 'starter', 'dnp'];
      const stmts = rows.map((x) => env.DB.prepare(
        `INSERT OR REPLACE INTO nba_box (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(',')})`
      ).bind(...cols.map((c) => (x[c] === undefined ? null : x[c]))));
      stmts.push(env.DB.prepare('UPDATE nba_box_games SET done = 1 WHERE game_id = ?').bind(g.game_id));
      for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
      read++;
    } catch (e) { /* next tick */ }
  }
  const graded = await gradeNbaPp(env.DB);
  return { read, graded };
}

// Grade logged legs from the box scores. A player with a line and no minutes,
// or missing from a day whose games are all read, did not play: void, never a
// free under.
async function gradeNbaPp(db) {
  const open = ((await db.prepare('SELECT * FROM nbapp WHERE result IS NULL AND date < ?').bind(slateDate()).all()).results || []);
  if (!open.length) return 0;
  const stmts = [];
  for (const day of [...new Set(open.map((r) => r.date))]) {
    const box = ((await db.prepare('SELECT * FROM nba_box WHERE date = ?').bind(day).all()).results || []);
    const pend = await db.prepare('SELECT COUNT(*) AS n FROM nba_box_games WHERE date = ? AND done = 0').bind(day).first();
    const read = await db.prepare('SELECT COUNT(*) AS n FROM nba_box_games WHERE date = ? AND done = 1').bind(day).first();
    const settled = Number(read && read.n) > 0 && Number(pend && pend.n) === 0;
    const byId = new Map(box.map((b) => [b.player_id, b]));
    const byName = new Map(box.map((b) => [nbaName(b.player), b]));
    for (const r of open.filter((x) => x.date === day)) {
      const b = (r.player_id && byId.get(r.player_id)) || byName.get(nbaName(r.player));
      let result = null, actual = null;
      const v = nbaStat(b, r.market);
      if (b) {
        if (b.dnp || v == null) result = 'void';
        else { actual = v; result = actual < r.point ? 'under' : actual > r.point ? 'over' : 'push'; }
      } else if (settled) result = 'void';
      if (!result) continue;
      // And at the pre-tip line, where one was read (ppSide: the same rule).
      const close = r.close_point == null ? null : result === 'void' ? 'void' : ppSide(actual, r.close_point);
      stmts.push(db.prepare('UPDATE nbapp SET result=?, actual=?, close_result=? WHERE date=? AND game_id=? AND player=? AND market=?')
        .bind(result, actual, close, r.date, r.game_id, r.player, r.market));
    }
  }
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
  return stmts.length;
}

// GET /api/nba-pp?raw=1: the last capture's odds payload, from D1. Free.
// `unmatched` is that game's PrizePicks names with no prior; `unmatchedLog`,
// every such name seen in the last NBA_PP_UNMATCHED_DAYS that still misses.
async function nbaPpRaw(env) {
  if (!env || !env.DB) return { error: 'no DB binding' };
  const hit = await loadFeedCache(env.DB, NBA_PP_RAW_KEY);
  return hit.present ? hit.data : { none: 'no capture with PrizePicks on it yet' };
}
// ?day=YYYY-MM-DD (2026-10-27): every leg logged for one day's games, as the
// reads left it -- the first line and chance, the pre-tip read's, the books'
// and the sharp books' -- with its count and result, and where it stood on
// Picks of the day: on the list at tip, off it before (and why), or never on
// it. The card shows only legs still to play; this is the day after. Free:
// the log alone.
async function nbaPpDay(env, day) {
  if (!env || !env.DB) return { error: 'no DB binding' };
  await ensureNbaSchema(env.DB); await ensureDayPickSchema(env.DB);
  const rows = (await env.DB.prepare('SELECT * FROM nbapp WHERE date = ? ORDER BY commence, game_id, model_under DESC').bind(day).all()).results || [];
  const dp = (await env.DB.prepare('SELECT leg_id, kind, label, p, game_id, on_list, seen_at, result, in_pool, pool_p FROM daypicks WHERE date = ?').bind(day).all()).results || [];
  const onList = dp.filter((r) => r.on_list === 1);
  const byId = new Map(dp.map((r) => [r.leg_id, r]));
  const reread = new Set(rows.filter((r) => r.close_at).map((r) => r.game_id));
  const legs = rows.map((m) => {
    // A blocks More is its own leg on the list (2026-10-28), the line's Over.
    const d = byId.get(`nbapp:${m.game_id}:${m.player}:${m.market}`) || byId.get(`nbapp:${m.game_id}:${m.player}:${m.market}:over`);
    const other = onList.find((x) => String(x.game_id) === String(m.game_id)) || null;
    // A leg only in the entry's pool (2026-10-28) was never on the list.
    const listed = d && (d.on_list === 1 || d.seen_at);
    const picks = !listed ? null : d.on_list === 1 ? { on: true, p: d.p, result: d.result, ...(d.kind !== 'nba_pp' ? { side: 'Over' } : {}) }
      : { on: false, p: d.p, lastOn: d.seen_at, why: ppDropWhy(m, reread.has(m.game_id), other, d.kind) || (other ? dropOutranked(other) : 'off the list before its start') };
    return { game: `${m.away} @ ${m.home}`, game_id: m.game_id, commence: m.commence, player: m.player, team: m.team, market: m.market, min_proj: m.min_proj, proj: m.proj,
      first: { line: m.point, under: m.model_under, book: m.book_line, book_under: m.book_under, sharp: m.sharp_under, at: m.captured_at },
      tip: m.close_at ? { line: m.close_point, under: m.close_under, book: m.close_book_line, book_under: m.close_book_under, sharp: m.close_sharp_under, at: m.close_at } : null,
      pulled: reread.has(m.game_id) && m.close_point == null, ud: m.ud_line, p6: m.p6_line,
      season: m.l10_n ? { under: m.l10_under, n: m.l10_n } : null, actual: m.actual, result: m.result, tipResult: m.close_result, picks,
      // In the PrizePicks entry's pool at tip (2026-10-28), with its chance there.
      pool: d && d.in_pool === 1 ? { p: d.pool_p, result: d.result } : null };
  });
  return { day, n: legs.length, onPicks: legs.filter((l) => l.picks && l.picks.on).length, dropped: legs.filter((l) => l.picks && !l.picks.on).length, legs };
}
// ?raw=events: the events list the watch last read, as it came. Free.
async function ppEventsRaw(env, sport, lg) {
  if (!env || !env.DB) return { error: 'no DB binding' };
  const hit = await loadFeedCache(env.DB, `${sport}_pp_events:${lg}`);
  return hit.present ? hit.data : { none: 'no events list read yet' };
}

// GET /api/nba-pp: tonight's logged legs, best under first, and the record.
async function nbaPpBoard(env) {
  const out = {
    note: 'LOGGED, not posted. The model\u2019s chance the under lands at PrizePicks\u2019 line: a player\u2019s last ten games blended with last season. Threes, assists, rebounds, blocks, steals.',
    legs: [], record: null,
  };
  if (!env || !env.DB) { out.error = 'no DB binding'; return out; }
  try {
    await ensureNbaSchema(env.DB);
    const rows = ((await env.DB.prepare('SELECT * FROM nbapp WHERE date >= ? ORDER BY model_under DESC').bind(slateDateOffset(-1)).all()).results || []);
    const now = Date.now();
    // Each leg at its latest line (the pre-tip read's, once taken: the one that
    // can be played now), with the first line and chance beside it.
    out.legs = ppStanding(rows.filter((r) => Date.parse(r.commence) > now)).map((r) => ppCurrent(r)).map((r) => ({
      player: r.player, team: r.team, market: r.market, point: r.point, model_under: r.model_under, proj: r.proj,
      n_recent: r.n_recent, min_proj: r.min_proj, game: `${r.away} @ ${r.home}`, game_id: r.game_id, commence: r.commence, league: r.league,
      book_line: r.book_line, book_under: r.book_under, player_id: r.player_id,
      // PrizePicks' number minus the books': above 0, its under is easier.
      vsBook: r.book_line != null && r.point != null ? round1(r.point - r.book_line) : null,
      first_point: r.first_point, first_under: r.first_under, first_at: r.captured_at, close_at: r.close_at,
      ud_line: r.ud_line == null ? null : r.ud_line, p6_line: r.p6_line == null ? null : r.p6_line,
      sharp_under: r.sharp_under == null ? null : r.sharp_under, sharp_src: r.sharp_src || null,
      l10_n: r.l10_n == null ? null : r.l10_n, l10_under: r.l10_under == null ? null : r.l10_under,
    })).sort((a, b) => b.model_under - a.model_under);
    // The record is kept over the players the card shows. A bench player's 0.5
    // line tops any ranking by the model's chance, and he is the one who sits.
    // Graded rows only, and the NBA moneylines byGame reads, so kept until one
    // of them is written (recordCached).
    out.record = await recordCached(env, 'nba-record', async () => {
      const graded = ((await env.DB.prepare("SELECT date, game_id, market, model_under, point, book_line, min_proj, result, close_point, close_result, sharp_under FROM nbapp WHERE result IN ('under','over','push')").all()).results || [])
        .filter((g) => g.min_proj != null && g.min_proj >= NBA_ROTATION_MIN);
      const split = ppSplitRecord(graded.map((g) => ({
        p: g.model_under, won: g.result === 'under' ? 1 : (g.result === 'over' ? 0 : null),
        gap: g.book_line != null && g.point != null ? round1(g.point - g.book_line) : null,
      })));
      const decided = graded.filter((g) => g.result !== 'push');
      const by = {};
      for (const g of decided) {
        by[g.market] = by[g.market] || { n: 0, under: 0 };
        by[g.market].n++; if (g.result === 'under') by[g.market].under++;
      }
      const days = new Map();
      for (const g of decided) { if (!days.has(g.date)) days.set(g.date, []); days.get(g.date).push(g); }
      let t3n = 0, t3h = 0;
      for (const list of days.values()) {
        const top = list.sort((a, b) => b.model_under - a.model_under).slice(0, 3);
        t3n += top.length; t3h += top.filter((x) => x.result === 'under').length;
      }
      // The over side of the same legs (2026-10-22). The model's chance of the
      // over is 100 minus the under's and the log grades both sides, so overs are
      // judged on the legs where the model leaned over: by band of that chance,
      // by market, and by where PrizePicks' number sat against the books' -- for
      // an over, ppLower (PrizePicks below the books) is the easier side.
      const lean = graded.filter((g) => g.model_under != null && g.model_under < 50);
      const ov = ppSplitRecord(lean.map((g) => ({
        p: 100 - g.model_under, won: g.result === 'over' ? 1 : (g.result === 'under' ? 0 : null),
        gap: g.book_line != null && g.point != null ? round1(g.point - g.book_line) : null,
      })));
      const ovBy = {};
      for (const g of lean) {
        if (g.result === 'push') continue;
        ovBy[g.market] = ovBy[g.market] || { n: 0, hit: 0 };
        ovBy[g.market].n++; if (g.result === 'over') ovBy[g.market].hit++;
      }
      // By how lopsided the game was (2026-10-26): the moneyline log's chance
      // for the same game's favourite (gmpicks, keyed by the odds feed's event
      // id as nbapp is). Starters sit late in a blowout, which an under
      // should like; this says whether it does at PrizePicks' lines.
      // A moneyline log it cannot read leaves this split out, never the record
      // (and that record is not kept).
      let complete = true;
      const byGame = await env.DB.prepare("SELECT game_id, win_prob FROM gmpicks WHERE sport = 'nba' AND market = 'h2h'").all()
        .then((x) => ppGameRecord(graded, new Map((x.results || []).map((g) => [g.game_id, g.win_prob])))).catch(() => { complete = false; return null; });
      return { data: {
        scope: `rotation players (${NBA_ROTATION_MIN}+ projected minutes), as on the card`,
        graded: decided.length,
        byMarket: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, { n: v.n, hitRate: v.n ? round1(v.under / v.n * 100) : null }])),
        top3: { n: t3n, hit: t3h, hitRate: t3n ? round1(t3h / t3n * 100) : null },
        byBand: split.byBand,
        byLineGap: split.byLineGap,
        overs: { scope: 'the legs where the model leaned over, at PrizePicks’ line', graded: ov.n, hit: ov.hit, hitRate: ov.hitRate,
          byBand: ov.byBand, byLineGap: ov.byLineGap,
          byMarket: Object.fromEntries(Object.entries(ovBy).map(([k, v]) => [k, { n: v.n, hit: v.hit, hitRate: v.n ? round1(v.hit / v.n * 100) : null }])) },
        // Blocks More (2026-10-27, the user's call): the one NBA market whose
        // More side has landed -- 26 of 41 where the model leaned More through
        // Oct 26, 16 of 23 at 55%+, against 42-45% for threes and assists
        // Mores. Listed on the card, and on Picks of the day from Oct 28
        // (PICK_KINDS.nba_blk_more).
        blkMore: ppMoreRecord(lean.filter((g) => g.market === 'blk')),
        ...ppCloseRecord(graded),
        sharp: ppSharpRecord(graded),
        byGame,
      }, complete };
    });
    // Whether the box scores are coming in at all -- without them nothing is
    // projected past last season and nothing grades.
    const ig = await env.DB.prepare('SELECT COUNT(*) AS n, SUM(done) AS d, MAX(date) AS last FROM nba_box_games').first();
    out.ingest = { games: Number((ig && ig.n) || 0), read: Number((ig && ig.d) || 0), lastDay: (ig && ig.last) || null };
  } catch (e) { out.error = String((e && e.message) || e); }
  return out;
}
// How the unders landed by the sharp books' chance at the first line
// (2026-10-25), against the break-evens: 54.2% (5-6 flex) and 57.7% (2-pick
// power). The model's own bands sit beside it (byBand); a week of both says
// which one Picks of the day should rank by.
// Unders by the favourite's chance in their game: 75%+ (lopsided), 60-75,
// under 60 (close), and no moneyline logged; all rotation legs, and starters
// (28+ projected minutes) apart, since they are the ones a blowout sits.
function ppGameRecord(rows, fav) {
  const d = rows.filter((g) => g.result === 'under' || g.result === 'over');
  const cell = (l) => { const hit = l.filter((g) => g.result === 'under').length; return { n: l.length, hit, hitRate: l.length ? round1(hit / l.length * 100) : null }; };
  const split = (l) => {
    const p = (g) => fav.get(g.game_id);
    return { '75+': cell(l.filter((g) => p(g) >= 75)), '60-75': cell(l.filter((g) => p(g) >= 60 && p(g) < 75)),
      'under 60': cell(l.filter((g) => p(g) != null && p(g) < 60)), 'no line': cell(l.filter((g) => p(g) == null)) };
  };
  return { all: split(d), starters: split(d.filter((g) => g.min_proj >= 28)) };
}
function ppSharpRecord(rows) {
  const d = rows.filter((g) => g.sharp_under != null && (g.result === 'under' || g.result === 'over'));
  const band = (lo, hi) => { const l = d.filter((g) => g.sharp_under >= lo && g.sharp_under < hi); const hit = l.filter((g) => g.result === 'under').length;
    return { n: l.length, hit, hitRate: l.length ? round1(hit / l.length * 100) : null }; };
  return { n: d.length, byBand: { '<50': band(0, 50), '50-54': band(50, 54), '54-58': band(54, 58), '58+': band(58, 101) } };
}

// ---------------------------------------------------------------------------
// Soccer player props (2026-10-10)
// ---------------------------------------------------------------------------
// The PrizePicks soccer board: shots, shots on target, passes attempted,
// tackles, clearances, fouls and goalie saves (the user's list and app,
// 2026-10-10; crosses, dribbles and shots assisted are left out).
//
// What a season of box scores said (2025-26 Premier League and 2026 MLS,
// 11,600 starts, against a line set at the half point above a player's recent
// average): unders landed 58-62% for shots, shots on target, tackles,
// clearances and fouls; passes split 53/47 and turned almost entirely on the
// opponent (66-68% under against a side that keeps the ball, ~60% over
// against one that gives it away); a starter off before 70' (12-14% of starts)
// went under 68-83%; low lines flip (tackles and fouls at 0.5 lean over,
// goalie saves at 1.5-2.5 go over) and saves had no lean a model could see.
// A negative binomial at a player's average, moved half the way by the
// opponent's concession rate, was honest for every stat but saves. All of that
// is against a stand-in line: the real test is PrizePicks' own number.
//
// No feed carries PrizePicks' soccer lines (the odds feed's soccer props are
// FanDuel over-only; PrizePicks' own board is behind a captcha), so the card
// shows each starter's projection and the chance at a line the user sets to
// the one in the app, and a starred leg is logged and graded at that number.
// Every input is ESPN and free: lineups and fixtures from the site API, the
// box scores from sports.core.api.espn.com -- passes and tackles exist only
// per player, so a match costs ~30 requests and the ingest has its own cron.
// The Champions League since 2026-10-20 (see socUclCtx), and the Europa League
// since 2026-10-22, read the same way. ESPN serves their lineups, rosters and
// per-player statistics in the same shape as the leagues'.
const SOC_PROP_LEAGUES = { epl: 'eng.1', laliga: 'esp.1', seriea: 'ita.1', bundesliga: 'ger.1', mls: 'usa.1', ucl: 'uefa.champions', uel: 'uefa.europa' };
const SOC_PROP_LABEL = { epl: 'Premier League', laliga: 'La Liga', seriea: 'Serie A', bundesliga: 'Bundesliga', mls: 'MLS', ucl: 'Champions League', uel: 'Europa League' };
// The European cups: their clubs come from every league, so an opponent is
// read from its own league (socUclCtx) and the cup's own average is 1.
const SOC_CUPS = new Set(['ucl', 'uel']);
// The last five (2026-10-15) are more PrizePicks markets read from the same
// per-player statistics: crosses, shots assisted, a goalkeeper's goals
// conceded, fouls drawn, and goals + assists. ESPN carries no attempted
// dribbles, so that market cannot be built from it.
const SOC_PROP_STATS = ['shots', 'sot', 'passes', 'tackles', 'clear', 'fouls', 'saves', 'crosses', 'shot_ast', 'conceded', 'fouls_drawn', 'goal_ast'];
// A goalkeeper's markets: these, and passes. Everyone else: all but these.
const SOC_KEEPER_STATS = ['saves', 'conceded'];
// soc_box began with the first seven; the rest arrive forward-only.
const SOC_BOX_ADDED = [['crosses', 'INTEGER'], ['shot_ast', 'INTEGER'], ['conceded', 'INTEGER'], ['fouls_drawn', 'INTEGER'], ['goal_ast', 'INTEGER']];
// Fitted variance-to-mean ratios (both leagues agreed within 0.1-0.2). The
// last five: tools/build-soccer-priors.mjs backtest on EPL 2025-26 + MLS 2026
// (crosses 1.79, shot_ast 1.17, conceded 0.98, fouls_drawn 1.00, goal_ast
// 1.01), times 1.09 -- what the first seven run above the same fit (shots
// 1.11, sot 1.01, tackles 1.17, clear 1.50, fouls 1.01, saves 1.19).
const SOC_PROP_PHI = { shots: 1.2, sot: 1.15, passes: 2.9, tackles: 1.3, clear: 1.6, fouls: 1.1, saves: 1.3,
  crosses: 1.95, shot_ast: 1.3, conceded: 1.05, fouls_drawn: 1.1, goal_ast: 1.1 };
// No row below these: a line nobody posts.
const SOC_PROP_MIN = { shots: 0.6, sot: 0.4, passes: 12, tackles: 0.8, clear: 0.8, fouls: 0.6, saves: 0.5,
  crosses: 0.6, shot_ast: 0.5, conceded: 0.6, fouls_drawn: 0.6, goal_ast: 0.25 };
const SOC_PRIOR_K = 5;            // last season counts as five starts, as the NBA prior does
const SOC_CTX_W = 0.5;            // the opponent moves a projection half the way its rate says
const SOC_BOX_CRON = '2-59/5 * * * *';
const SOC_LINEUP_LEAD_MS = 100 * 60e3;   // lineups post about an hour out; read from 100 minutes
const SOC_PROPS_AHEAD_MS = 14 * 3600e3;
const SOC_SEASON_FROM = { epl: '2026-07-01', laliga: '2026-07-01', seriea: '2026-07-01', bundesliga: '2026-07-01', mls: '2026-01-01', ucl: '2026-07-01', uel: '2026-07-01' };
const ESPN_SOC_SITE = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
const ESPN_SOC_CORE = 'https://sports.core.api.espn.com/v2/sports/soccer/leagues';
let SOC_PRIORS = null;

async function ensureSocPropSchema(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS soc_box (
    game_id TEXT NOT NULL, league TEXT, date TEXT, player_id TEXT NOT NULL, player TEXT, team TEXT, opp TEXT,
    starter INTEGER, min INTEGER, sub_off INTEGER, gk INTEGER,
    shots INTEGER, sot INTEGER, passes INTEGER, tackles INTEGER, clear INTEGER, fouls INTEGER, saves INTEGER,
    PRIMARY KEY (game_id, player_id)
  )`).run();
  await addColumns(db, 'soc_box', SOC_BOX_ADDED);
  await db.prepare('CREATE INDEX IF NOT EXISTS soc_box_player ON soc_box (player_id, date)').run();
  // socContext reads one league's season at a time, seven leagues each
  // refresh, and each read scanned every box score of every league.
  await db.prepare('CREATE INDEX IF NOT EXISTS soc_box_league ON soc_box (league, date)').run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS soc_box_games (
    game_id TEXT PRIMARY KEY, league TEXT, date TEXT, home TEXT, away TEXT, home_cid TEXT, away_cid TEXT,
    done INTEGER, tries INTEGER
  )`).run();
  await db.prepare('CREATE INDEX IF NOT EXISTS soc_box_games_todo ON soc_box_games (done, date)').run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS socprops (
    date TEXT NOT NULL, game_id TEXT NOT NULL, player_id TEXT NOT NULL, market TEXT NOT NULL,
    player TEXT, team TEXT, opp TEXT, league TEXT, commence TEXT,
    proj REAL, line REAL, p_under REAL, p_over REAL, n_recent INTEGER, logged_at TEXT,
    actual REAL, result TEXT,
    PRIMARY KEY (date, game_id, player_id, market)
  )`).run();
  // The PrizePicks lines typed into the card (2026-10-15), one per starter and
  // stat: the number, the side the card showed there and the model's chance of
  // it, graded at that number beside the model's own row above.
  await db.prepare(`CREATE TABLE IF NOT EXISTS soc_pp_lines (
    game_id TEXT NOT NULL, player_id TEXT NOT NULL, market TEXT NOT NULL,
    date TEXT, league TEXT, commence TEXT, player TEXT, team TEXT, opp TEXT,
    line REAL, side TEXT, p REAL, p_under REAL, p_over REAL, proj REAL, default_line REAL,
    first_at TEXT, entered_at TEXT, edits INTEGER,
    actual REAL, result TEXT,
    PRIMARY KEY (game_id, player_id, market)
  )`).run();
  // The grader runs every five minutes and wants only the ungraded rows. Keyed
  // on result itself, so the rows come out in rowid order, as they did when
  // the grader scanned the table for them.
  await db.prepare('CREATE INDEX IF NOT EXISTS socprops_open ON socprops (result) WHERE result IS NULL').run();
  await db.prepare('CREATE INDEX IF NOT EXISTS soc_pp_lines_open ON soc_pp_lines (result) WHERE result IS NULL').run();
}

async function socPriors(env) {
  if (SOC_PRIORS) return SOC_PRIORS;
  try {
    const r = await env.ASSETS.fetch(new Request('https://x/soccer-priors.json'));
    if (r.ok) SOC_PRIORS = await r.json();
  } catch (e) { /* no asset -> nothing has a prior, and only players with 3+ starts this season project */ }
  return SOC_PRIORS;
}

const socJson = async (u) => {
  try { const r = await fetch(u, { headers: { accept: 'application/json' } }); return r.ok ? await r.json() : null; } catch (e) { return null; }
};
const socNum = (cats, cat, name) => {
  const c = (cats || []).find((x) => x.name === cat); const s = c && (c.stats || []).find((x) => x.name === name);
  return s ? Number(s.value) || 0 : 0;
};

// A finished match's appearance list, read once and kept: names and
// positions from the summary, each club's roster from the core API, and each
// player who appeared, with his statistics link. Three requests; null while
// any of them fails, so the next tick tries again.
async function socMatchMeta(db, g) {
  const key = `soc_box_meta:${g.game_id}`;
  const hit = await loadFeedCache(db, key);
  if (hit.present && hit.data && hit.data.apps) return hit.data;
  const slug = SOC_PROP_LEAGUES[g.league];
  const sum = await socJson(`${ESPN_SOC_SITE}/${slug}/summary?event=${g.game_id}`);
  if (!sum) return null;
  const names = {}, gkIds = new Set();
  for (const t of (sum.rosters || [])) for (const p of (t.roster || [])) {
    if (!p.athlete) continue;
    names[p.athlete.id] = p.athlete.displayName;
    if (p.position && p.position.abbreviation === 'G') gkIds.add(String(p.athlete.id));
  }
  const apps = [];
  for (const [cid, team, opp] of [[g.home_cid, g.home, g.away], [g.away_cid, g.away, g.home]]) {
    const ro = await socJson(`${ESPN_SOC_CORE}/${slug}/events/${g.game_id}/competitions/${g.game_id}/competitors/${cid}/roster`);
    if (!ro) return null;
    for (const p of (ro.entries || [])) {
      if (!p.starter && !(p.subbedIn && p.subbedIn.didSub)) continue;
      const id = String(p.playerId);
      apps.push({ id, name: names[id] || null, team, opp, starter: p.starter ? 1 : 0,
        subOff: p.subbedOut && p.subbedOut.didSub ? 1 : 0, gk: gkIds.has(id) ? 1 : 0,
        ref: p.statistics && p.statistics.$ref ? p.statistics.$ref.replace('http://', 'https://') : null });
    }
  }
  const meta = { apps };
  await saveFeedCache(db, key, meta);
  return meta;
}

// Up to `n` of a match's players not yet read, their statistics fetched.
async function socReadSome(g, meta, have, n) {
  const todo = meta.apps.filter((a) => a.ref && !have.has(a.id)).slice(0, n);
  const stats = await Promise.all(todo.map((a) => socJson(a.ref)));
  const rows = [];
  todo.forEach((a, i) => {
    const cats = stats[i] && stats[i].splits && stats[i].splits.categories;
    if (!cats) return;
    rows.push({ game_id: g.game_id, league: g.league, date: g.date, player_id: a.id, player: a.name, team: a.team, opp: a.opp,
      starter: a.starter, min: socNum(cats, 'general', 'minutes'), sub_off: a.subOff,
      gk: a.gk || socNum(cats, 'goalKeeping', 'saves') > 0 ? 1 : 0,
      shots: socNum(cats, 'offensive', 'totalShots'), sot: socNum(cats, 'offensive', 'shotsOnTarget'),
      passes: socNum(cats, 'offensive', 'totalPasses'), tackles: socNum(cats, 'defensive', 'totalTackles'),
      clear: socNum(cats, 'defensive', 'totalClearance'), fouls: socNum(cats, 'general', 'foulsCommitted'),
      saves: socNum(cats, 'goalKeeping', 'saves'),
      crosses: socNum(cats, 'offensive', 'totalCrosses'), shot_ast: socNum(cats, 'offensive', 'shotAssists'),
      // Every player carries the goals conceded while he was on; only a
      // goalkeeper's is a market (and the side's total, in socContext).
      conceded: socNum(cats, 'goalKeeping', 'goalsConceded'), fouls_drawn: socNum(cats, 'general', 'foulsSuffered'),
      goal_ast: socNum(cats, 'offensive', 'totalGoals') + socNum(cats, 'offensive', 'goalAssists') });
  });
  return { rows, tried: todo.length };
}

// The soccer box-score ingest. A tick either looks for newly finished
// matches (every 30 minutes) or reads part of one match -- `perTick` players'
// statistics, the progress kept in soc_box -- then grades.
//
// It was written for a trigger of its own (SOC_BOX_CRON) and a whole match a
// tick, ~30 requests. That trigger never fired after the deploy of 2026-10-09
// (the free plan's cron limit, or the Git deploy not registering a second
// one), so the five-minute cron carries it too, a dozen players a tick, which
// leaves the rest of that invocation's request budget alone. Should the second
// trigger ever fire, it simply goes faster.
async function socBoxTick(env, opts = {}) {
  if (!env || !env.DB) return null;
  const perTick = opts.perTick || 12;
  const db = env.DB;
  await ensureSocPropSchema(db);
  const now = Date.now();
  const disc = await loadFeedCache(db, 'soc_box_disc');
  if (!disc.present || now - ((disc.data && disc.data.at) || 0) > 30 * 60e3) {
    const days = [ptDateOf(now - 86400e3), ptDateOf(now)].map((d) => d.replace(/-/g, ''));
    const stmts = [];
    for (const [lg, slug] of Object.entries(SOC_PROP_LEAGUES)) {
      for (const d of days) {
        const sb = await socJson(`${ESPN_SOC_SITE}/${slug}/scoreboard?dates=${d}`);
        for (const e of ((sb && sb.events) || [])) {
          if (!(e.status && e.status.type && e.status.type.completed)) continue;
          const cs = (e.competitions && e.competitions[0] && e.competitions[0].competitors) || [];
          const h = cs.find((c) => c.homeAway === 'home'), a = cs.find((c) => c.homeAway === 'away');
          if (!h || !a) continue;
          stmts.push(db.prepare('INSERT OR IGNORE INTO soc_box_games (game_id, league, date, home, away, home_cid, away_cid, done, tries) VALUES (?,?,?,?,?,?,?,0,0)')
            .bind(String(e.id), lg, ptDateOf(Date.parse(e.date)), h.team.abbreviation, a.team.abbreviation, String(h.id), String(a.id)));
        }
      }
    }
    if (stmts.length) await db.batch(stmts);
    await saveFeedCache(db, 'soc_box_disc', { at: now, found: stmts.length, via: opts.via || null });
    // Grading reads only D1, so it runs on a looking tick too.
    await gradeSocProps(db);
    return { discovered: stmts.length };
  }
  const g = await db.prepare('SELECT * FROM soc_box_games WHERE done = 0 ORDER BY date LIMIT 1').first();
  if (g) {
    const meta = await socMatchMeta(db, g);
    if (!meta) {
      await db.prepare('UPDATE soc_box_games SET tries = tries + 1, done = CASE WHEN tries >= 2 THEN 1 ELSE 0 END WHERE game_id = ?').bind(g.game_id).run();
    } else {
      const have = new Set(((await db.prepare('SELECT player_id FROM soc_box WHERE game_id = ?').bind(g.game_id).all()).results || []).map((r) => r.player_id));
      const { rows, tried } = await socReadSome(g, meta, have, perTick);
      const cols = ['game_id', 'league', 'date', 'player_id', 'player', 'team', 'opp', 'starter', 'min', 'sub_off', 'gk', ...SOC_PROP_STATS];
      const stmts = rows.map((r) => db.prepare(`INSERT OR REPLACE INTO soc_box (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
        .bind(...cols.map((c) => r[c] == null ? null : r[c])));
      const left = meta.apps.filter((a) => a.ref && !have.has(a.id)).length - rows.length;
      // Done when every player who appeared is read. A tick that reads none of
      // the ones it tried counts as a failure; three and what was read stands.
      if (left <= 0) stmts.push(db.prepare('UPDATE soc_box_games SET done = 1 WHERE game_id = ?').bind(g.game_id));
      else if (tried > 0 && rows.length === 0) {
        stmts.push(db.prepare('UPDATE soc_box_games SET tries = tries + 1, done = CASE WHEN tries >= 2 THEN 1 ELSE 0 END WHERE game_id = ?').bind(g.game_id));
      }
      if (stmts.length) await db.batch(stmts);
    }
  }
  await gradeSocProps(db);
  return null;
}

// The model's own log, graded from the box scores: under / over / push at the
// line it showed, void for a starter who never appeared. Then the PrizePicks
// lines the user set, the same way at their own number, in their own table.
async function gradeSocProps(db) {
  for (const table of ['socprops', 'soc_pp_lines']) {
    // CROSS JOIN keeps the open rows the outer loop. As a JOIN, SQLite started
    // from soc_box_games' done = 1 index -- every match ever read, each tick --
    // or scanned socprops whole.
    const open = (await db.prepare(
      `SELECT s.date, s.game_id, s.player_id, s.market, s.line FROM ${table} s CROSS JOIN soc_box_games g ON g.game_id = s.game_id
        WHERE s.result IS NULL AND g.done = 1 LIMIT 200`).all()).results || [];
    if (!open.length) continue;
    const ids = [...new Set(open.map((r) => r.game_id))];
    const box = (await db.prepare(`SELECT * FROM soc_box WHERE game_id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all()).results || [];
    const by = new Map(box.map((b) => [`${b.game_id}|${b.player_id}`, b]));
    const ups = open.map((r) => {
      const b = by.get(`${r.game_id}|${r.player_id}`);
      const actual = b && b[r.market] != null ? b[r.market] : null;
      const result = actual == null ? 'void' : actual === r.line ? 'push' : actual < r.line ? 'under' : 'over';
      return db.prepare(`UPDATE ${table} SET actual = ?, result = ? WHERE date = ? AND game_id = ? AND player_id = ? AND market = ?`)
        .bind(actual, result, r.date, r.game_id, r.player_id, r.market);
    });
    await db.batch(ups);
  }
}

// POST/GET /api/soc-lines: the PrizePicks soccer lines set on the props card.
// No feed carries them (the Odds API has FanDuel overs only, and PrizePicks'
// own API is behind a captcha), so the number typed on the phone is the only
// record of PrizePicks' line there is. Private by the entries key and never
// cached or readable cross-origin, exactly as /api/entries is.
//
// POST { gameId, playerId, stat, line, proj } saves one line until kickoff
// (later changes replace it; after kickoff it is locked). The row must be one
// the model logged -- a starter on a posted lineup -- and the chance is the
// projection the card showed at that line, the side the one it favours, as
// the card draws it. GET lists the lines saved for matches not yet graded, so
// a reload shows them again.
async function socLinesApi(request, env) {
  if (!env || !env.DB) return entryResponse({ error: 'no DB binding' }, 500);
  const auth = await entryAuth(env, request);
  if (!auth.ok) return entryResponse({ error: auth.error }, auth.status);
  const db = env.DB;
  await ensureSocPropSchema(db);
  if (request.method === 'POST') {
    let b;
    try { b = await request.json(); } catch (e) { return entryResponse({ error: 'Body must be JSON.' }, 400); }
    const gid = String((b && b.gameId) || ''), pid = String((b && b.playerId) || ''), stat = String((b && b.stat) || '');
    const line = Number(b && b.line);
    if (!SOC_PROP_STATS.includes(stat)) return entryResponse({ error: 'Unknown stat.' }, 400);
    if (!(line >= 0 && line <= 200 && Number.isInteger(line * 2))) return entryResponse({ error: 'A line is a whole or half number.' }, 400);
    const row = await db.prepare('SELECT * FROM socprops WHERE game_id = ? AND player_id = ? AND market = ?').bind(gid, pid, stat).first();
    if (!row) return entryResponse({ error: 'No projection was logged for that player and stat.' }, 404);
    if (!(Date.parse(row.commence) > Date.now())) return entryResponse({ error: 'That match has kicked off: its lines are locked.' }, 409);
    const shown = Number(b.proj);
    const proj = isFinite(shown) && shown > 0 ? shown : row.proj;
    const ch = socChance(line, proj, SOC_PROP_PHI[stat]);
    const side = ch.under >= ch.over ? 'Under' : 'Over';
    const pu = round1(ch.under * 100), po = round1(ch.over * 100);
    const at = new Date().toISOString();
    await db.prepare(
      `INSERT INTO soc_pp_lines (game_id, player_id, market, date, league, commence, player, team, opp,
         line, side, p, p_under, p_over, proj, default_line, first_at, entered_at, edits)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)
       ON CONFLICT(game_id, player_id, market) DO UPDATE SET line = excluded.line, side = excluded.side, p = excluded.p,
         p_under = excluded.p_under, p_over = excluded.p_over, proj = excluded.proj, entered_at = excluded.entered_at,
         edits = soc_pp_lines.edits + 1`
    ).bind(gid, pid, stat, row.date, row.league, row.commence, row.player, row.team, row.opp,
      line, side, side === 'Under' ? pu : po, pu, po, proj, row.line, at, at).run();
    return entryResponse({ ok: true, line, side, p: side === 'Under' ? pu : po, claimed: !!auth.claimed });
  }
  const rows = (await db.prepare(
    'SELECT game_id, player_id, market, line, side, p, entered_at FROM soc_pp_lines WHERE result IS NULL ORDER BY commence LIMIT 500'
  ).all()).results || [];
  return entryResponse({ lines: rows });
}

// What each club has allowed its opponents per game this season, from the box
// scores, refreshed every six hours. A club with under five games falls back to
// last season's rate in the priors; a promoted club has neither and gets none.
async function socContext(env, pri) {
  const db = env.DB;
  const hit = await loadFeedCache(db, 'soc_ctx');
  if (hit.present && hit.ageMs < 6 * 3600e3) return hit.data;
  const out = {};
  // Every player carries the goals conceded while he was on, so the side's is
  // its goalkeeper's (or two keepers', after a change), never the sum of eleven.
  const sel = SOC_PROP_STATS.map((s) => (s === 'conceded' ? 'SUM(CASE WHEN gk = 1 THEN conceded END) AS conceded' : `SUM(${s}) AS ${s}`)).join(', ');
  for (const lg of Object.keys(SOC_PROP_LEAGUES)) {
    const rows = (await db.prepare(
      `SELECT game_id, team, ${sel} FROM soc_box WHERE league = ? AND date >= ? GROUP BY game_id, team`
    ).bind(lg, SOC_SEASON_FROM[lg]).all()).results || [];
    const games = new Map();
    for (const r of rows) { if (!games.has(r.game_id)) games.set(r.game_id, []); games.get(r.game_id).push(r); }
    const conc = {};
    for (const list of games.values()) {
      if (list.length !== 2) continue;
      for (const [t, o] of [[list[0], list[1]], [list[1], list[0]]]) {
        const c = conc[t.team] = conc[t.team] || { games: 0, sum: {}, n: {} };
        c.games++;
        // A match read before a stat's column existed has none of it: it is
        // not a game in which the opponent recorded zero.
        for (const s of SOC_PROP_STATS) if (o[s] != null) { c.sum[s] = (c.sum[s] || 0) + o[s]; c.n[s] = (c.n[s] || 0) + 1; }
      }
    }
    out[lg] = Object.fromEntries(Object.entries(conc).filter(([, c]) => c.games >= 5)
      .map(([t, c]) => [t, Object.fromEntries(SOC_PROP_STATS.map((s) => [s, c.n[s] >= 5 ? c.sum[s] / c.n[s] : null]))]));
  }
  await saveFeedCache(db, 'soc_ctx', out);
  return out;
}

// P(under) and P(over) at a line: a whole-number line can push.
function socChance(line, mean, phi) {
  const under = negBinomCdf(Math.ceil(line) - 1, mean, phi);
  const over = 1 - negBinomCdf(Math.floor(line), mean, phi);
  return { under, over };
}

// Pure: one posted lineup's starters in, projected rows out.
//   starters: [{ id, name, team, opp, pos, gk }]
//   recent: Map id -> this season's starts, newest first
//   ctx: { [team]: { [stat]: per game allowed } } for the league; pri: the priors doc
function socProjectRows(lg, starters, recent, ctx, pri) {
  const slug = SOC_PROP_LEAGUES[lg];
  const avgOf = (s) => {
    if (SOC_CUPS.has(lg)) return 1;      // its ctx holds ratios to each club's own league (socUclCtx)
    const cur = Object.values(ctx || {}).filter((c) => c[s] != null);
    if (cur.length >= 6) return cur.reduce((a, c) => a + c[s], 0) / cur.length;
    return pri && pri.leagueAvg && pri.leagueAvg[slug] ? pri.leagueAvg[slug][s] : null;
  };
  const allowed = (team, s) => {
    const c = ctx && ctx[team];
    if (c && c[s] != null) return c[s];
    const t = pri && pri.teams && pri.teams[slug] && pri.teams[slug][team];
    return t && t.conc ? t.conc[s] : null;
  };
  const out = [];
  for (const p of starters) {
    const rec = (recent.get(p.id) || []).slice(0, 10);
    const pr = pri && pri.players ? pri.players[p.id] : null;
    const isGk = p.gk || (pr && pr.gk) || rec.some((r) => r.gk);
    for (const s of SOC_PROP_STATS) {
      // Goalkeepers: saves, goals conceded and passes; nobody else the first two.
      if (SOC_KEEPER_STATS.includes(s) ? !isGk : (isGk && s !== 'passes')) continue;
      // A start read before this stat's column existed says nothing about it.
      const recS = rec.filter((r) => r[s] != null);
      const k = pr && pr.starts >= 3 && pr[s] != null ? Math.min(SOC_PRIOR_K, pr.starts) : 0;
      if (!k && recS.length < 3) continue;                             // nothing to stand on
      const base = (recS.reduce((a, r) => a + r[s], 0) + k * (k ? pr[s] : 0)) / (recS.length + k);
      const a = allowed(p.opp, s), lgAvg = avgOf(s);
      const ratio = a != null && lgAvg ? a / lgAvg : null;
      const mean = base * (ratio != null ? 1 + SOC_CTX_W * (ratio - 1) : 1);
      if (!(mean >= SOC_PROP_MIN[s])) continue;
      const line = Math.floor(mean) + 0.5;
      const ch = socChance(line, mean, SOC_PROP_PHI[s]);
      const early = rec.length >= 5 ? rec.filter((r) => r.sub_off && r.min < 70).length / rec.length : (pr ? pr.early : null);
      out.push({ id: p.id, player: p.name, team: p.team, opp: p.opp, pos: p.pos || null, stat: s,
        proj: Math.round(mean * 100) / 100, phi: SOC_PROP_PHI[s], line,
        pUnder: round1(ch.under * 100), pOver: round1(ch.over * 100),
        nRecent: recS.length, priorStarts: pr ? pr.starts : 0,
        ctx: ratio != null ? Math.round(ratio * 100) / 100 : null,
        early: early != null ? Math.round(early * 100) : null });
    }
  }
  return out;
}

// What a Champions League opponent allows (2026-10-20). Its clubs come from
// every league, so each one's rate is read from its own league -- this
// season's box scores, else last season's priors -- as a ratio to that
// league's average, and socProjectRows takes the Champions League average as
// 1. teams: [{ abbr, lg }], lg the club's own league (socTeamLeague). A club
// from a league the card does not read (Slovan, Viking) has no rate, so it
// moves nothing.
function socUclCtx(ctxAll, teams, pri) {
  const out = {};
  for (const t of teams) {
    if (!t || !t.abbr || !t.lg || SOC_CUPS.has(t.lg)) continue;
    const lgCtx = (ctxAll && ctxAll[t.lg]) || {};
    const slug = SOC_PROP_LEAGUES[t.lg];
    const prior = pri && pri.teams && pri.teams[slug] && pri.teams[slug][t.abbr];
    const row = {};
    for (const s of SOC_PROP_STATS) {
      const cur = Object.values(lgCtx).filter((x) => x[s] != null);
      const avg = cur.length >= 6 ? cur.reduce((a, x) => a + x[s], 0) / cur.length
        : (pri && pri.leagueAvg && pri.leagueAvg[slug] ? pri.leagueAvg[slug][s] : null);
      const rate = lgCtx[t.abbr] && lgCtx[t.abbr][s] != null ? lgCtx[t.abbr][s] : (prior && prior.conc ? prior.conc[s] : null);
      row[s] = rate != null && avg ? rate / avg : null;
    }
    out[t.abbr] = row;
  }
  return out;
}
// A club's own league, from the matches the box-score ingest has seen: by
// abbreviation AND ESPN team id, since abbreviations repeat across leagues
// ("SCP" is St. Pauli in the Bundesliga and Sporting CP in Europe).
async function socTeamLeague(db, abbr, id) {
  if (!abbr || !id) return null;
  const r = await db.prepare(
    "SELECT league FROM soc_box_games WHERE league NOT IN ('ucl', 'uel') AND ((home = ? AND home_cid = ?) OR (away = ? AND away_cid = ?)) ORDER BY date DESC LIMIT 1"
  ).bind(abbr, String(id), abbr, String(id)).first();
  return r ? r.league : null;
}

// Upcoming fixtures for a league and day, cached half an hour.
async function socFixtures(env, lg, ymd) {
  const key = `soc_fix:${lg}:${ymd}`;
  const hit = await loadFeedCache(env.DB, key);
  if (hit.present && hit.ageMs < 30 * 60e3) return hit.data;
  const sb = await socJson(`${ESPN_SOC_SITE}/${SOC_PROP_LEAGUES[lg]}/scoreboard?dates=${ymd.replace(/-/g, '')}`);
  if (!sb) return (hit.data || []);
  const list = (sb.events || []).map((e) => {
    const cs = (e.competitions && e.competitions[0] && e.competitions[0].competitors) || [];
    const h = cs.find((c) => c.homeAway === 'home') || {}, a = cs.find((c) => c.homeAway === 'away') || {};
    return { id: String(e.id), lg, commence: e.date, home: h.team && h.team.abbreviation, away: a.team && a.team.abbreviation,
      homeId: h.id != null ? String(h.id) : null, awayId: a.id != null ? String(a.id) : null,
      homeName: h.team && h.team.displayName, awayName: a.team && a.team.displayName,
      state: (e.status && e.status.type && e.status.type.state) || 'pre' };
  });
  await saveFeedCache(env.DB, key, list);
  return list;
}
// A match's posted lineup: the starters, or null until the cards are up.
// Cached until kickoff once posted, five minutes while it is not.
async function socLineup(env, f) {
  const key = `soc_lu:${f.id}`;
  const hit = await loadFeedCache(env.DB, key);
  if (hit.present && (hit.data || hit.ageMs < 5 * 60e3)) return hit.data;
  const sum = await socJson(`${ESPN_SOC_SITE}/${SOC_PROP_LEAGUES[f.lg]}/summary?event=${f.id}`);
  let starters = null;
  const rosters = (sum && sum.rosters) || [];
  if (rosters.length === 2 && rosters.every((t) => (t.roster || []).some((p) => p.starter))) {
    starters = [];
    for (const t of rosters) {
      const team = t.team && t.team.abbreviation;
      const opp = (rosters.find((x) => x !== t).team || {}).abbreviation;
      for (const p of (t.roster || [])) {
        if (!p.starter || !p.athlete) continue;
        starters.push({ id: String(p.athlete.id), name: p.athlete.displayName, team, opp,
          pos: p.position ? p.position.abbreviation : null, gk: p.position && p.position.abbreviation === 'G' ? 1 : 0 });
      }
    }
  }
  await saveFeedCache(env.DB, key, starters);
  return starters;
}

// GET /api/soccer-props: the next fourteen hours of fixtures in the five
// leagues and the two European cups; for each whose lineup is posted, every starter's projection in each
// stat, the line at the half point above it and the chance either way there.
// The card lets the user move the line to PrizePicks' number; the phi rides
// along so the chance can be recomputed in the browser.
async function socPropsBoard(env, url) {
  const summary = !!(url && url.searchParams && url.searchParams.get('summary') === '1');
  const out = {
    note: 'LOGGED, not posted. Each starter\'s projection: last season per start blended with this season, moved half the way by what the opponent allows. '
      + 'No feed carries PrizePicks\' soccer lines: set the line to the app\'s and the chance follows. A line you set is saved and graded at that number (ppRecord).',
    asOf: new Date().toISOString(), leagues: SOC_PROP_LABEL, matches: [], record: null,
  };
  if (!env || !env.DB) { out.error = 'no DB binding'; return out; }
  try {
    const db = env.DB;
    await ensureSocPropSchema(db);
    const now = Date.now();
    const pri = await socPriors(env);
    const days = [...new Set([ptDateOf(now), ptDateOf(now + SOC_PROPS_AHEAD_MS)])];
    const fixtures = [];
    for (const lg of Object.keys(SOC_PROP_LEAGUES)) for (const d of days) fixtures.push(...(await socFixtures(env, lg, d)));
    const up = fixtures.filter((f) => { const t = Date.parse(f.commence); return f.state === 'pre' && t > now && t <= now + SOC_PROPS_AHEAD_MS; })
      .sort((a, b) => Date.parse(a.commence) - Date.parse(b.commence));
    const ctxAll = await socContext(env, pri);
    const logs = [];
    for (const f of up) {
      const m = { id: f.id, league: f.lg, label: SOC_PROP_LABEL[f.lg], commence: f.commence, home: f.home, away: f.away,
        homeName: f.homeName, awayName: f.awayName, lineup: 'waiting', rows: [] };
      out.matches.push(m);
      if (Date.parse(f.commence) - now > SOC_LINEUP_LEAD_MS) continue;
      const starters = await socLineup(env, f);
      if (!starters) continue;
      m.lineup = 'posted';
      const ids = starters.map((s) => s.id);
      const recent = new Map();
      for (let i = 0; i < ids.length; i += 90) {
        const chunk = ids.slice(i, i + 90);
        const rs = (await db.prepare(`SELECT * FROM soc_box WHERE player_id IN (${chunk.map(() => '?').join(',')}) AND starter = 1 AND date >= ? ORDER BY date DESC`)
          .bind(...chunk, SOC_SEASON_FROM[f.lg]).all()).results || [];
        for (const r of rs) { if (!recent.has(r.player_id)) recent.set(r.player_id, []); recent.get(r.player_id).push(r); }
      }
      let ctx = ctxAll && ctxAll[f.lg];
      if (SOC_CUPS.has(f.lg)) {
        const teams = [];
        for (const [abbr, id] of [[f.home, f.homeId], [f.away, f.awayId]]) teams.push({ abbr, lg: await socTeamLeague(db, abbr, id) });
        ctx = socUclCtx(ctxAll, teams, pri);
      }
      m.rows = socProjectRows(f.lg, starters, recent, ctx, pri);
      const day = ptDateOf(Date.parse(f.commence));
      for (const r of m.rows) logs.push(db.prepare(
        `INSERT OR IGNORE INTO socprops (date, game_id, player_id, market, player, team, opp, league, commence, proj, line, p_under, p_over, n_recent, logged_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(day, f.id, r.id, r.stat, r.player, r.team, r.opp, f.lg, f.commence, r.proj, r.line, r.pUnder, r.pOver, r.nRecent, new Date(now).toISOString()));
    }
    // Logged once a lineup is seen: the first read after the cards post fixes
    // the row (INSERT OR IGNORE), so later reads do not move the record.
    for (let i = 0; i < logs.length; i += 50) await db.batch(logs.slice(i, i + 50));
    const byStat = (list) => Object.fromEntries(SOC_PROP_STATS.map((s) => { const c = ppSplitRecord(list.filter((x) => x.market === s)); return [s, { n: c.n, hit: c.hit, hitRate: c.hitRate }]; }));
    // Unders and overs apart (2026-10-22): the card shows whichever side the
    // chance favours, and a low line leans over (tackles and fouls at 0.5), so
    // each side keeps its own record, by stat and by band.
    const bySide = (list) => Object.fromEntries(['under', 'over'].map((sd) => {
      const l = list.filter((x) => x.side === sd);
      const c = ppSplitRecord(l);
      return [sd, { n: c.n, hit: c.hit, hitRate: c.hitRate, byBand: c.byBand, byMarket: byStat(l) }];
    }));
    // The record: each logged row's leaning side at the line it showed. Graded
    // rows only, so kept until one is graded (recordCached).
    out.record = await recordCached(env, 'soc-record', async () => {
      const graded = (await db.prepare("SELECT market, p_under, p_over, result FROM socprops WHERE result IN ('under','over','push')").all()).results || [];
      const items = graded.map((g) => {
        const under = g.p_under >= g.p_over;
        return { market: g.market, side: under ? 'under' : 'over', p: under ? g.p_under : g.p_over, won: g.result === 'push' ? null : ((g.result === 'under') === under ? 1 : 0), gap: null };
      });
      const split = ppSplitRecord(items);
      return { data: { scope: 'the side each row leans at the line it showed, before kickoff', graded: split.n, hit: split.hit, hitRate: split.hitRate,
        byBand: split.byBand, byMarket: byStat(items), bySide: bySide(items) }, complete: true };
    });
    // The record at PrizePicks' own numbers: each line set on the card, the
    // side the card showed there, graded from the same box scores. This, not
    // the default-line record above, is what decides whether soccer props
    // join Picks of the day -- once 100 to 150 of them have graded.
    const ppRows = (await db.prepare('SELECT market, side, p, result FROM soc_pp_lines').all()).results || [];
    const ppItems = ppRows.filter((g) => ['under', 'over', 'push'].includes(g.result)).map((g) => ({ market: g.market, side: g.side === 'Under' ? 'under' : 'over', p: g.p,
      won: g.result === 'push' ? null : (g.result === (g.side === 'Under' ? 'under' : 'over') ? 1 : 0), gap: null }));
    const pps = ppSplitRecord(ppItems), exF = ppSplitRecord(ppItems.filter((x) => x.market !== 'fouls'));
    out.ppRecord = { scope: 'the side the card showed at the PrizePicks line you set, before kickoff',
      saved: ppRows.length, open: ppRows.filter((g) => g.result == null).length, void: ppRows.filter((g) => g.result === 'void').length,
      graded: pps.n, hit: pps.hit, hitRate: pps.hitRate, byBand: pps.byBand, byMarket: byStat(ppItems), bySide: bySide(ppItems),
      exFouls: { n: exF.n, hit: exF.hit, hitRate: exF.hitRate },
      // Fouls on their own: the one stat whose leaning side landed under half
      // the time at the default line (7 of 15 by 2026-10-15), so it is shown
      // apart rather than left to sink or carry the rest.
      fouls: { atDefault: out.record.byMarket.fouls, atPP: byStat(ppItems).fouls,
        note: 'Fouls ran below 50% at the default line; read them apart from the other stats.' },
      picksGate: { need: 100, have: pps.n, note: 'Soccer props stay off Picks of the day until 100-150 legs have graded at real PrizePicks lines.' } };
    const ing = await db.prepare('SELECT COUNT(*) AS n, SUM(done) AS d, MAX(date) AS last FROM soc_box_games').first();
    const look = await loadFeedCache(db, 'soc_box_disc');
    out.ingest = { games: Number((ing && ing.n) || 0), read: Number((ing && ing.d) || 0), lastDay: (ing && ing.last) || null, priors: !!pri,
      lastLook: look.present && look.data && look.data.at ? new Date(look.data.at).toISOString() : null };
    // ?summary=1: what a scheduled check reads, without every row (a posted
    // Saturday runs past 100KB). The two effects the season of box scores
    // showed a check can name without knowing PrizePicks' number -- passes
    // against a side that keeps or gives away the ball, and starters who come
    // off early -- plus each keeper's saves.
    if (summary) {
      out.matches = out.matches.map((m) => {
        const r = m.rows || [];
        const pick = (l, n) => l.slice(0, n).map((x) => ({ player: x.player, team: x.team, proj: x.proj, ctx: x.ctx }));
        const passes = r.filter((x) => x.stat === 'passes' && x.proj >= 25 && x.ctx != null);
        const early = new Map();
        for (const x of r) {
          if (x.early == null || x.early < 30 || !['shots', 'sot', 'tackles'].includes(x.stat)) continue;
          const e = early.get(x.id) || { player: x.player, team: x.team, early: x.early, proj: {} };
          e.proj[x.stat] = x.proj; early.set(x.id, e);
        }
        return { id: m.id, league: m.league, label: m.label, commence: m.commence, home: m.home, away: m.away,
          homeName: m.homeName, awayName: m.awayName, lineup: m.lineup, rows: r.length,
          passesTight: pick(passes.filter((x) => x.ctx < 0.9).sort((a, b) => a.ctx - b.ctx), 4),
          passesOpen: pick(passes.filter((x) => x.ctx > 1.1).sort((a, b) => b.ctx - a.ctx), 3),
          earlyOff: [...early.values()].sort((a, b) => b.early - a.early).slice(0, 4),
          keepers: r.filter((x) => x.stat === 'saves').map((x) => ({ player: x.player, team: x.team, proj: x.proj, ctx: x.ctx })) };
      });
    }
  } catch (e) { out.error = String((e && e.message) || e); }
  return out;
}

// Three-way de-vig. Shin is a two-way construction and 1X2 has a draw, so the
// margin is stripped proportionally across all three outcomes. Proportional
// under-states heavy favourites slightly (the same bias that made us switch the
// moneyline to Shin), so the fair line here is labelled as what it is rather
// than presented as the sharpest possible number.
function devigThreeWay(prices) {
  const imps = prices.map((p) => amProb(p));
  if (imps.some((x) => x == null || !(x > 0))) return null;
  const sum = imps.reduce((a, b) => a + b, 0);
  return sum > 0 ? imps.map((x) => x / sum) : null;
}

// opts.log: write the picks even for an ?all=1 read, limited to fixtures inside
// the capture horizon. The cron uses it after every capture (see
// soccerMaybeIngest), so a matchday nobody opened still leaves a record.
async function soccerBoardData(env, url, opts = {}) {
  // leagueList, not just the keys: the chips used to be hardcoded in the HTML and
  // would have silently kept saying "three leagues" with two of them missing.
  const out = {
    leagues: Object.keys(SOCCER_LEAGUES),
    leagueList: Object.entries(SOCCER_LEAGUES).map(([k, v]) => ({ key: k, label: v.label, country: v.country || '' })),
    games: [], empty: true, asOf: null,
  };
  if (!env || !env.DB) { out.error = 'no DB binding'; return out; }
  const want = (url && url.searchParams && url.searchParams.get('league')) || null;
  try {
    await ensureSoccerSchema(env.DB);
    // The only index leads with league, and `commence > ?` alone could not use
    // it, so every read scanned every price ever stored -- after each capture,
    // and with the pre-start reads that is many a day (2026-10-23). The
    // leagues present are walked off the index one step each (`lg`) and each
    // is searched by kickoff. Ties on captured_at keep the order they had as a
    // scan, rowid, since the last row per key wins below.
    const rows = (await env.DB.prepare(
      `WITH RECURSIVE lg(l) AS (
         SELECT MIN(league) FROM soccer_lines
         UNION ALL SELECT (SELECT MIN(league) FROM soccer_lines WHERE league > lg.l) FROM lg WHERE lg.l IS NOT NULL)
       SELECT league, event_id, commence, home, away, market, selection, point, book, price, captured_at
         FROM soccer_lines WHERE league IN (SELECT l FROM lg) AND commence > ? ORDER BY captured_at ASC, rowid ASC`
    ).bind(new Date(Date.now() - 3 * 3600e3).toISOString()).all()).results || [];
    const latest = new Map();
    for (const r of rows) {
      if (want && r.league !== want) continue;
      latest.set(`${r.event_id}|${r.market}|${r.selection}|${r.book}`, r);
      if (!out.asOf || String(r.captured_at) > String(out.asOf)) out.asOf = r.captured_at;
    }
    const games = new Map();
    for (const r of latest.values()) {
      const g = games.get(r.event_id) || games.set(r.event_id, {
        id: r.event_id, league: r.league, leagueLabel: SOCCER_LEAGUES[r.league] ? SOCCER_LEAGUES[r.league].label : r.league,
        commence: r.commence, home: r.home, away: r.away, h2h: {}, totals: {},
      }).get(r.event_id);
      if (r.market === 'h2h') (g.h2h[r.selection] = g.h2h[r.selection] || {})[r.book] = r.price;
      else (g.totals[`${r.point}|${r.selection}`] = g.totals[`${r.point}|${r.selection}`] || {})[r.book] = r.price;
    }
    for (const g of games.values()) {
      const sides = [g.home, 'Draw', g.away];
      // Every book's de-vigged 1X2 where it quoted all three; the sharp ones make
      // the fair (sharpFair: Pinnacle's when it quotes, which every league now
      // takes -- before 2026-10-27 only pinnacleFallback leagues took it alone).
      const byBook = {};
      for (const bk of new Set(Object.values(g.h2h).flatMap((x) => Object.keys(x)))) {
        const ps = sides.map((s) => (g.h2h[s] || {})[bk]);
        if (ps.some((x) => typeof x !== 'number')) continue;
        const dv = devigThreeWay(ps);
        if (dv) byBook[bk] = dv;
      }
      const sf = sharpFair(Object.fromEntries(SOCCER_SHARP.filter((bk) => byBook[bk]).map((bk) => [bk, byBook[bk]])));
      const sharpN = sf.n;
      const fair = sf.fair;
      const fairSrc = sf.src;
      // A pick's chance at each book, for the log's book_fairs.
      const bookFairsOf = (sel) => { const i = sides.indexOf(sel); return i < 0 ? null : bookFairsJson(Object.fromEntries(Object.entries(byBook).map(([bk, dv]) => [bk, dv[i]]))); };
      const best = (sel) => {
        let bp = null, bb = null;
        for (const bk of SOCCER_EXEC) {
          const p = (g.h2h[sel] || {})[bk];
          if (typeof p !== 'number') continue;
          if (bp == null || amProb(p) < amProb(bp)) { bp = p; bb = bk; }
        }
        return { price: bp, book: bb };
      };
      const picks = sides.map((sel, i) => {
        const b = best(sel);
        const f = fair ? fair[i] : null;
        const imp = b.price != null ? amProb(b.price) : null;
        return {
          selection: sel === 'Draw' ? 'Draw' : sel,
          fair: f != null ? Math.round(f * 1000) / 10 : null,
          price: b.price, book: b.book,
          implied: imp != null ? Math.round(imp * 1000) / 10 : null,
          value: (f != null && imp != null) ? Math.round((f - imp) * 1000) / 10 : null,
          bookFairs: bookFairsOf(sel),
        };
      });
      const lead = picks.filter((p) => p.value != null).sort((a, b) => b.value - a.value)[0] || null;
      // The side the sharp books make likeliest to WIN (never the draw), whatever
      // its price. A different question from `lead`, which is the best value and
      // is often the draw; this one is logged under its own market so the two
      // records never mix.
      const fav = fair
        ? [picks[0], picks[2]].filter((p) => p.fair != null).sort((a, b) => b.fair - a.fair)[0] || null
        : null;
      // The most-quoted goals line, with both sides de-vigged two-way (Over/Under
      // is a true two-way market, so Shin applies as it does everywhere else).
      const points = [...new Set(Object.keys(g.totals).map((k) => Number(k.split('|')[0])).filter((x) => isFinite(x)))];
      let totalRead = null;
      if (points.length) {
        // Which line to read. "Nearest to 2.5" was the first rule and it never
        // logged a single total in production: the nearest line was usually one
        // only Pinnacle hangs (2.75, an Asian quarter line), with no DraftKings
        // or FanDuel price at it. The line has to be one we can both price (two
        // sharp books quoting both sides, or Pinnacle alone where the league
        // allows it, same as the 1X2) and bet (a DK or FD price). Nearest to 2.5
        // only breaks ties. `lines` keeps what each game offered, for checking.
        const pinOk = !!(SOCCER_LEAGUES[g.league] && SOCCER_LEAGUES[g.league].pinnacleFallback);
        const lineStats = points.map((pt) => {
          const o = g.totals[`${pt}|Over`] || {}, u = g.totals[`${pt}|Under`] || {};
          const sharp = SOCCER_SHARP.filter((bk) => typeof o[bk] === 'number' && typeof u[bk] === 'number');
          const exec = SOCCER_EXEC.filter((bk) => typeof o[bk] === 'number' || typeof u[bk] === 'number').length;
          const priceable = sharp.length >= 2 || (pinOk && sharp.includes('pinnacle'));
          return { pt, sharp: sharp.length, exec, usable: priceable && exec > 0 };
        });
        lineStats.sort((a, b) => (b.usable - a.usable) || (b.sharp - a.sharp) || (b.exec - a.exec)
          || (Math.abs(a.pt - 2.5) - Math.abs(b.pt - 2.5)));
        const point = lineStats[0].pt;
        const ov = g.totals[`${point}|Over`] || {}, un = g.totals[`${point}|Under`] || {};
        const dvs = SOCCER_SHARP.map((bk) => (typeof ov[bk] === 'number' && typeof un[bk] === 'number' ? shinDevig(ov[bk], un[bk]) : null)).filter((x) => x != null);
        let fairOver = dvs.length >= 2 ? median(dvs) : null;
        let totFairSrc = fairOver != null ? 'sharp-pool' : null;
        if (fairOver == null && pinOk && typeof ov.pinnacle === 'number' && typeof un.pinnacle === 'number') {
          fairOver = shinDevig(ov.pinnacle, un.pinnacle);
          totFairSrc = fairOver != null ? 'pinnacle' : null;
        }
        const bestSide = (rec) => {
          let bp = null, bb = null;
          for (const bk of SOCCER_EXEC) {
            const p = rec[bk];
            if (typeof p !== 'number') continue;
            if (bp == null || amProb(p) < amProb(bp)) { bp = p; bb = bk; }
          }
          return { price: bp, book: bb };
        };
        const bo = bestSide(ov), bu = bestSide(un);
        const val = (f, pr) => (f != null && pr != null && amProb(pr) != null) ? Math.round((f - amProb(pr)) * 1000) / 10 : null;
        totalRead = {
          point, sharpN: dvs.length, fairSrc: totFairSrc,
          lines: lineStats.map((x) => `${x.pt}:${x.sharp}s/${x.exec}x`).join(' '),
          overFair: fairOver != null ? Math.round(fairOver * 1000) / 10 : null,
          overPrice: bo.price, overBook: bo.book, overValue: val(fairOver, bo.price),
          underFair: fairOver != null ? Math.round((1 - fairOver) * 1000) / 10 : null,
          underPrice: bu.price, underBook: bu.book, underValue: val(fairOver != null ? 1 - fairOver : null, bu.price),
        };
      }
      out.games.push({
        id: g.id, league: g.league, leagueLabel: g.leagueLabel, commence: g.commence,
        home: g.home, away: g.away, sharpN, fairSrc,
        oneXtwo: picks, lead, fav, total: totalRead,
      });
    }
    out.games.sort((a, b) => Date.parse(a.commence || 0) - Date.parse(b.commence || 0));
    // One matchday, the same rule the NFL board uses: soccer weeks are clusters,
    // and a Saturday reader is not choosing between today and next Wednesday.
    const first = out.games.find((g) => g.commence);
    // ?all=1 keeps every upcoming fixture. The board itself never asks for it;
    // it exists so "why is the board showing that one?" is answerable from the
    // stored rows instead of another paid ingest.
    const showAll = !!(url && url.searchParams && url.searchParams.get('all'));
    if (first && !showAll) {
      out.gamesAllUpcoming = out.games.length;
      // The next matchday that is actually PRICED, rather than the next one
      // inside a fixed window.
      //
      // A 36h window was the first attempt and it was the wrong test. It went
      // blank whenever the next fixtures sat 38 hours out — which is most of a
      // Monday, and every midweek — while a hundred fully priced fixtures sat in
      // the store. What made that lone Oct 9 fixture useless was not that it was
      // 18 days away; it was that one book had quoted it and there was no fair
      // line behind it. So test for the fair line.
      const dayOf = (g) => ptDateOf(Date.parse(g.commence));
      const priced = out.games.filter((g) => g.fairSrc !== 'MKT');
      const target = priced.length ? dayOf(priced[0]) : null;
      if (target) {
        out.slateDay = target;
        out.games = out.games.filter((g) => g.commence && dayOf(g) === target);
        const withFair = out.games.filter((g) => g.fairSrc !== 'MKT').length;
        out.slateNote = `next matchday: ${out.slateDay} (${out.games.length} of ${out.gamesAllUpcoming} upcoming fixtures, ${withFair} with a sharp fair line)`;
      } else {
        // Fixtures exist but nothing carries two sharp books yet. Name the day
        // rather than implying the season has stopped.
        out.nextDay = ptDateOf(Date.parse(first.commence));
        out.games = [];
        out.slateNote = `no fixture priced yet — next matchday ${out.nextDay} (${out.gamesAllUpcoming} upcoming, none quoted by two sharp books)`;
      }
    }
    if (showAll) { out.gamesAllUpcoming = out.games.length; out.slateNote = 'all upcoming fixtures (?all=1)'; }
    // Keep the record: the side the board leads with, on fixtures that have a
    // fair line and have not kicked off. The tab still says context and still
    // posts nothing — this is written down, not shown.
    try {
      const horizon = opts.log ? Date.now() + SOCCER_HORIZON_MS : Infinity;
      const pre = out.games.filter((g) => g.lead && g.lead.price != null && g.lead.fair != null
        && g.fairSrc !== 'MKT' && Date.parse(g.commence || 0) > Date.now()
        && Date.parse(g.commence || 0) <= horizon);
      // Each pick is dated by its own kickoff's Pacific day. A page read only
      // ever logs one matchday, so this changes nothing there; the cron's read
      // spans two, and a Sunday fixture logged on Saturday is still Sunday's.
      const logByDay = async (rows) => {
        const days = new Map();
        for (const r of rows) {
          const d = ptDateOf(Date.parse(r.commence || 0));
          if (!days.has(d)) days.set(d, []);
          days.get(d).push(r);
        }
        for (const [d, list] of days) await logGamePicks(env.DB, 'soccer', d, list);
      };
      if (pre.length && (!showAll || opts.log)) {
        await logByDay(pre.map((g) => ({
          game_id: g.id, league: g.league, commence: g.commence,
          side: g.lead.selection === 'Draw' ? 'draw' : (g.lead.selection === g.home ? 'home' : 'away'),
          pick: g.lead.selection, home: g.home, away: g.away,
          win_prob: g.lead.fair, implied: g.lead.implied, edge: g.lead.value,
          price: g.lead.price, book: g.lead.book, fair_src: g.fairSrc, sharp_n: g.sharpN, book_fairs: g.lead.bookFairs,
        })));
        // The goals total is bought on the same call as the 1X2 and shown on the
        // same row, so logging it costs nothing and doubles what a matchday
        // leaves behind. Whichever side the sharp pool makes the better price.
        const tot = [];
        for (const g of pre) {
          const t = g.total;
          if (!t || t.point == null || t.overFair == null) continue;
          const over = { side: 'over', fair: t.overFair, price: t.overPrice, book: t.overBook, value: t.overValue };
          const under = { side: 'under', fair: t.underFair, price: t.underPrice, book: t.underBook, value: t.underValue };
          const cands = [over, under].filter((x) => x.fair != null && x.price != null);
          if (!cands.length) continue;
          const best = cands.sort((x, y) => (y.value == null ? -1e9 : y.value) - (x.value == null ? -1e9 : x.value))[0];
          tot.push({
            game_id: g.id, market: 'totals', league: g.league, commence: g.commence,
            side: best.side, point: t.point, pick: `${best.side === 'over' ? 'Over' : 'Under'} ${t.point}`,
            home: g.home, away: g.away,
            win_prob: best.fair, implied: best.price == null ? null : Math.round(amProb(best.price) * 1000) / 10,
            edge: best.value, price: best.price, book: best.book,
            fair_src: t.fairSrc || 'sharp-pool', sharp_n: t.sharpN,
          });
        }
        if (tot.length) await logByDay(tot);
        const favs = pre.filter((g) => g.fav && g.fav.price != null && g.fav.fair != null).map((g) => ({
          game_id: g.id, market: 'fav', league: g.league, commence: g.commence,
          side: g.fav.selection === g.home ? 'home' : 'away',
          pick: g.fav.selection, home: g.home, away: g.away,
          win_prob: g.fav.fair, implied: g.fav.implied, edge: g.fav.value,
          price: g.fav.price, book: g.fav.book, fair_src: g.fairSrc, sharp_n: g.sharpN, book_fairs: g.fav.bookFairs,
        }));
        if (favs.length) await logByDay(favs);
      }
    } catch (e) { /* logging never breaks the board */ }
    out.empty = out.games.length === 0;
  } catch (e) { out.error = String((e && e.message) || e); }
  return out;
}

// GET /api/sports-list — every sport the feed offers, and whether it is in
// season. FREE: /v4/sports bills nothing, the same way /events does, so asking
// "is this league even carried?" never costs credits. ?q= filters by substring
// so a soccer question does not print 200 lines of everything else.
async function sportsList(env, reqUrl) {
  const key = env && env.ODDS_API_KEY;
  if (!key) return cors(json({ error: 'ODDS_API_KEY not configured' }, 30));
  const q = ((reqUrl && reqUrl.searchParams && reqUrl.searchParams.get('q')) || '').toLowerCase();
  try {
    const r = await fetch(`https://api.the-odds-api.com/v4/sports?apiKey=${key}&all=true`, { headers: { accept: 'application/json' } });
    if (env) await recordOddsUsage(env, r, 'debug:sports-list');
    if (!r.ok) return cors(json({ error: `HTTP ${r.status}`, body: (await r.text()).slice(0, 200) }, 30));
    const all = await r.json();
    const rows = (Array.isArray(all) ? all : [])
      .filter((s) => !q || `${s.key} ${s.title} ${s.group}`.toLowerCase().includes(q))
      .map((s) => ({ key: s.key, title: s.title, group: s.group, active: !!s.active, outrights: !!s.has_outrights }));
    return cors(json({ note: 'free call — /v4/sports costs no credits', q: q || null, n: rows.length, sports: rows }, 600));
  } catch (e) {
    return cors(json({ error: String((e && e.message) || e) }, 30));
  }
}

// ---------------------------------------------------------------------------
// Last season's moneylines, read back (2026-10-22, on the owner's call).
//
// Picks of the day lists a moneyline favourite only at the bar where its
// stated chance has held up. Waiting for a live record takes months; the odds
// feed sells past snapshots instead (10 credits per market per region per
// snapshot). So each 2025-26 game day gets one snapshot of the sharp books'
// h2h prices, read the way the live boards read them -- the median Shin
// de-vig of two or more sharp books, else Pinnacle alone, labelled -- and each
// game is graded from the free scores (the NHL's own feed, ESPN for the NBA
// and the Europa League). The question: when the fair line said 65% or more,
// did the favourite win that often?
//
// GET /api/hist-backtest?job=nhl|nba|uel answers from what has been read
// (D1 only). &run=1 reads the next game days, paid (HIST_CHUNK, HIST_SCAN), and saves where
// it stopped; each job stops at its credit cap. A day with no games costs
// nothing (its scores are read first). Never cached: each run moves on.
const HIST_SHARP = ['pinnacle', 'lowvig', 'betonlineag', 'novig', 'prophetx'];
// Per run: at most 8 paid snapshots, and 20 days scanned, since every day costs
// a score request and a run is one invocation with a request budget.
const HIST_CHUNK = 8;
const HIST_SCAN = 20;
const HIST_JOBS = {
  nhl: { label: 'NHL 2025-26 regular season', sport: 'icehockey_nhl', from: '2025-10-07', to: '2026-04-16', snapUtc: '16:00', cap: 2200, way: 2 },
  nba: { label: 'NBA 2025-26 regular season', sport: 'basketball_nba', from: '2025-10-21', to: '2026-04-12', snapUtc: '16:00', cap: 2000, way: 2 },
  // ESPN's 2025-26 Europa League match days (189 matches). Each is read an hour
  // before its first kickoff.
  uel: { label: 'Europa League 2025-26', sport: 'soccer_uefa_europa_league', cap: 300, way: 3, espn: 'uefa.europa',
    dates: ['2025-09-24', '2025-09-25', '2025-10-02', '2025-10-23', '2025-11-06', '2025-11-27', '2025-12-11', '2026-01-22', '2026-01-29',
      '2026-02-19', '2026-02-26', '2026-03-12', '2026-03-18', '2026-03-19', '2026-04-08', '2026-04-09', '2026-04-16', '2026-04-30', '2026-05-07', '2026-05-20'] },
};
const HIST_BANDS = [[50, 55], [55, 60], [60, 65], [65, 70], [70, 75], [75, 80], [80, 101]];
function histDays(job) {
  if (job.dates) return job.dates;
  const out = [];
  for (let t = Date.parse(job.from + 'T12:00:00Z'); t <= Date.parse(job.to + 'T12:00:00Z'); t += 864e5) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}
// One day's finals, as the graders read them, with each game's start where
// the feed gives it (ESPN does; the NHL's score feed does too).
async function histFinals(job, date) {
  const ymd = date.replace(/-/g, '');
  if (job.sport === 'icehockey_nhl') {
    const r = await fetch(`https://api-web.nhle.com/v1/score/${date}`, { headers: { accept: 'application/json' } });
    if (!r.ok) return [];
    const j = await r.json();
    return nhlFinals(j).map((f, i) => ({ ...f, start: (((j.games || []).filter((g) => g.gameState === 'OFF' || g.gameState === 'FINAL')[i]) || {}).startTimeUTC || null }));
  }
  const evs = job.sport === 'basketball_nba'
    ? await espnScoreboard(`nba/scoreboard?xhr=1&date=${ymd}`)
    : await espnScoreboard(`soccer/scoreboard?xhr=1&league=${job.espn}&date=${ymd}`);
  const out = [];
  for (const ev of evs) {
    const st = (ev && ev.status && ev.status.type && ev.status.type.name) || '';
    if (!/FINAL|FULL_TIME/.test(String(st))) continue;
    const c = (ev.competitions || [])[0];
    const h = c && (c.competitors || []).find((t) => t.homeAway === 'home');
    const a = c && (c.competitors || []).find((t) => t.homeAway === 'away');
    if (!h || !a) continue;
    out.push({ home: (h.team && (h.team.displayName || h.team.name)) || '', away: (a.team && (a.team.displayName || a.team.name)) || '',
      hs: Number(h.score), as: Number(a.score), start: ev.date || null });
  }
  return out;
}
// Pure: a snapshot's events and a day's finals in, one graded row per game.
function histRows(job, date, snapIso, events, finals) {
  const same = job.sport === 'basketball_nba' ? nbaMatch : job.sport === 'icehockey_nhl' ? nhlMatch : clubMatch;
  const snap = Date.parse(snapIso);
  const rows = [], unmatched = [];
  for (const e of (Array.isArray(events) ? events : [])) {
    const t = Date.parse(e.commence_time);
    if (!isFinite(t) || t <= snap || t > snap + 864e5) continue;
    const home = e.home_team, away = e.away_team;
    const px = {};
    for (const bm of (e.bookmakers || [])) {
      const mk = (bm.markets || []).find((m) => m.key === 'h2h');
      if (!mk) continue;
      const o = (name) => { const x = (mk.outcomes || []).find((y) => y.name === name); return x && typeof x.price === 'number' ? x.price : null; };
      px[bm.key] = { home: o(home), away: o(away), draw: o('Draw') };
    }
    // The fair chance each side WINS: two-way Shin for hockey and basketball,
    // the three-way 1X2 for soccer (where a draw is a loss for either side).
    const fairOf = (q) => {
      if (!q || q.home == null || q.away == null) return null;
      if (job.way === 3) { if (q.draw == null) return null; const d = devigThreeWay([q.home, q.draw, q.away]); return d ? { home: d[0], away: d[2] } : null; }
      const f = shinDevig(q.home, q.away);
      return f != null && isFinite(f) ? { home: f, away: 1 - f } : null;
    };
    const fairs = HIST_SHARP.map((bk) => fairOf(px[bk])).filter(Boolean);
    let fair = null, src = 'MKT';
    if (fairs.length >= 2) { fair = { home: median(fairs.map((f) => f.home)), away: median(fairs.map((f) => f.away)) }; src = 'sharp-pool'; }
    else if (fairOf(px.pinnacle)) { fair = fairOf(px.pinnacle); src = 'pinnacle'; }
    if (!fair) continue;
    const favSide = fair.home >= fair.away ? 'home' : 'away';
    const f = finals.find((x) => same(x.home, home) && same(x.away, away))
      || (job.way === 3 ? (() => { const x = finals.find((y) => same(y.home, away) && same(y.away, home)); return x ? { ...x, hs: x.as, as: x.hs } : null; })() : null);
    if (!f || !isFinite(f.hs) || !isFinite(f.as)) { unmatched.push(`${away} @ ${home}`); continue; }
    const won = favSide === 'home' ? f.hs > f.as : f.as > f.hs;
    rows.push({ date, event_id: e.id, commence: e.commence_time, home, away, fav_side: favSide,
      fav_p: round1((favSide === 'home' ? fair.home : fair.away) * 100), sharp_n: src === 'pinnacle' ? 1 : fairs.length, fair_src: src,
      snap: snapIso, home_score: f.hs, away_score: f.as, won: won ? 1 : 0, lead_min: Math.round((t - snap) / 60e3) });
  }
  return { rows, unmatched };
}
async function ensureHistSchema(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS histml (
    job TEXT NOT NULL, date TEXT, event_id TEXT NOT NULL, commence TEXT, home TEXT, away TEXT,
    fav_side TEXT, fav_p REAL, sharp_n INTEGER, fair_src TEXT, snap TEXT, home_score INTEGER, away_score INTEGER,
    won INTEGER, lead_min INTEGER, PRIMARY KEY (job, event_id)
  )`).run();
}
// The record by band of the favourite's fair chance, and 65%+ on its own --
// the bar Picks of the day lists moneyline favourites at.
function histReport(rows) {
  const band = (lo, hi) => {
    const l = rows.filter((r) => r.fav_p >= lo && r.fav_p < hi);
    const won = l.filter((r) => r.won).length;
    return { band: hi > 100 ? `${lo}+` : `${lo}-${hi}`, n: l.length, won, winRate: l.length ? round1(won / l.length * 100) : null,
      stated: l.length ? round1(l.reduce((a, r) => a + r.fav_p, 0) / l.length) : null };
  };
  return { games: rows.length, byBand: HIST_BANDS.map(([lo, hi]) => band(lo, hi)), at65: band(65, 101), at70: band(70, 101),
    bySource: Object.fromEntries(['sharp-pool', 'pinnacle'].map((s) => [s, rows.filter((r) => r.fair_src === s).length])) };
}
async function histBacktest(env, url) {
  const key = String(url.searchParams.get('job') || '');
  const job = HIST_JOBS[key];
  if (!job) return { error: `job is one of ${Object.keys(HIST_JOBS).join(', ')}` };
  if (!env || !env.DB) return { error: 'no DB binding' };
  const db = env.DB;
  await ensureHistSchema(db);
  const stateKey = `hist_job:${key}`;
  const st = await loadFeedCache(db, stateKey);
  const state = (st.present && st.data) || { next: 0, credits: 0, unmatched: [], snapshots: 0, done: false };
  const days = histDays(job);
  const out = { job: key, label: job.label, cap: job.cap };
  if (url.searchParams.get('run') === '1' && !state.done) {
    if (!env.ODDS_API_KEY) return { ...out, error: 'ODDS_API_KEY not configured' };
    const stmts = [];
    let read = 0, scanned = 0;
    while (state.next < days.length && read < HIST_CHUNK && scanned < HIST_SCAN && state.credits < job.cap) {
      scanned++;
      const date = days[state.next];
      let finals = [];
      try { finals = await histFinals(job, date); } catch (e) { /* treated as no games */ }
      state.next++;
      if (!finals.length) continue;
      // The snapshot: the job's hour, or an hour before the day's first start.
      const starts = finals.map((f) => Date.parse(f.start)).filter(isFinite);
      const snapIso = job.snapUtc ? `${date}T${job.snapUtc}:00Z`
        : new Date(Math.min(...starts) - 3600e3).toISOString().replace(/\.\d{3}Z$/, 'Z');
      const r = await fetch(`https://api.the-odds-api.com/v4/historical/sports/${job.sport}/odds?apiKey=${env.ODDS_API_KEY}`
        + `&bookmakers=${HIST_SHARP.join(',')}&markets=h2h&oddsFormat=american&dateFormat=iso&date=${encodeURIComponent(snapIso)}`,
      { headers: { accept: 'application/json' } });
      await recordOddsUsage(env, r, `hist:${key}`);
      read++;
      state.snapshots++;
      const spent = Number(r.headers.get('x-requests-last'));
      state.credits += isFinite(spent) ? spent : 10;
      if (!r.ok) { out.lastError = `HTTP ${r.status} on ${date}`; continue; }
      const j = await r.json();
      const { rows, unmatched } = histRows(job, date, snapIso, j && j.data, finals);
      for (const u of unmatched) if (state.unmatched.length < 60) state.unmatched.push(`${date} ${u}`);
      for (const x of rows) stmts.push(db.prepare(
        `INSERT OR REPLACE INTO histml (job, date, event_id, commence, home, away, fav_side, fav_p, sharp_n, fair_src, snap, home_score, away_score, won, lead_min)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(key, x.date, x.event_id, x.commence, x.home, x.away, x.fav_side, x.fav_p, x.sharp_n, x.fair_src, x.snap, x.home_score, x.away_score, x.won, x.lead_min));
    }
    if (stmts.length) await db.batch(stmts);
    if (state.next >= days.length || state.credits >= job.cap) state.done = true;
    await saveFeedCache(db, stateKey, state);
    out.ran = { snapshots: read, rowsWritten: stmts.length };
  }
  const rows = (await db.prepare('SELECT fav_p, won, fair_src FROM histml WHERE job = ?').bind(key).all()).results || [];
  return { ...out, done: !!state.done, progress: `${state.next} of ${days.length} days`, creditsSpent: state.credits, snapshots: state.snapshots,
    unmatched: state.unmatched, report: histReport(rows) };
}

async function fairProbe(env, reqUrl) {
  const key = env && env.ODDS_API_KEY;
  if (!key) return cors(json({ error: 'ODDS_API_KEY not configured' }, 30));
  // ?sport=nfl retargets the probe. NFL has no single sharp book the way MLB has
  // Pinnacle, so which books to ask for is itself the open question — hence
  // ?books=, so alternate pools can be tested without a redeploy. Capped at 10
  // because past that the request bills as a second region equivalent.
  const qSport = reqUrl && reqUrl.searchParams ? reqUrl.searchParams.get('sport') : null;
  const sportKey = PROBE_SPORTS[(qSport || 'mlb').toLowerCase()];
  if (!sportKey) {
    return cors(json({ error: `unknown sport; expected one of ${Object.keys(PROBE_SPORTS).join(', ')}` }, 30));
  }
  const base = `https://api.the-odds-api.com/v4/sports/${sportKey}`;
  const qBooks = reqUrl && reqUrl.searchParams ? reqUrl.searchParams.get('books') : null;
  const allBooks = (qBooks
    ? qBooks.split(',').map((s) => s.trim()).filter(Boolean)
    : [...PROBE_FAIR_BOOKS, ...PROBE_EXEC_BOOKS]).slice(0, 10);
  // ?market=pitcher_strikeouts probes the K board instead of the batter board.
  // Coverage is per-market — Pinnacle posts total bases but not H+R+RBI — so a
  // batter-market result says nothing about strikeouts and has to be asked for
  // separately. Comma-separated values are accepted; default stays the batter set.
  const qMarket = reqUrl && reqUrl.searchParams ? reqUrl.searchParams.get('market') : null;
  const markets = qMarket
    ? qMarket.split(',').map((s) => s.trim()).filter(Boolean)
    : BATTER_MARKETS.map((m) => m.key);
  // Which of the requested books count as a fair source. Split out from ?books=
  // because the two lists are not the same question: ?books= is who to ask,
  // ?sharp= is whose answer may set a price. Defaults to the MLB sharp pool, so
  // an unlisted book added via ?books= is treated as execution-only until it is
  // named here deliberately.
  const qSharp = reqUrl && reqUrl.searchParams ? reqUrl.searchParams.get('sharp') : null;
  const sharpBooks = qSharp
    ? qSharp.split(',').map((s) => s.trim()).filter(Boolean)
    : PROBE_FAIR_BOOKS;
  const out = {
    question: `Do sharp books post ${markets.join(', ')}? If yes, a non-circular fair line is possible.`,
    sportProbed: sportKey,
    marketsProbed: markets,
    booksRequested: allBooks,
    sharpPool: sharpBooks,
    execPool: allBooks.filter((b) => !sharpBooks.includes(b)),
    regionEquivalents: Math.ceil(allBooks.length / 10),
    estimatedCredits: markets.length * Math.ceil(allBooks.length / 10),
  };
  try {
    // The events list is free (no markets requested) — pick one upcoming game.
    const evR = await fetch(`${base}/events?apiKey=${key}&dateFormat=iso`, { headers: { accept: 'application/json' } });
    await recordOddsUsage(env, evR, 'debug:fair-probe');
    const events = await evR.json();
    const now = Date.now();
    // ?games=N samples N upcoming games instead of one. Coverage varies by game
    // — a sharp book may quote a marquee matchup and skip a weekday afternoon —
    // so a single event can badly misrepresent a slate. Cost scales linearly:
    // markets x regionEquivalents PER GAME. Capped at 8 so a typo cannot burn
    // the quota.
    const qGames = reqUrl && reqUrl.searchParams ? parseInt(reqUrl.searchParams.get('games') || '1', 10) : 1;
    const nGames = Math.max(1, Math.min(8, isFinite(qGames) ? qGames : 1));
    const upcoming = (Array.isArray(events) ? events : [])
      .filter((e) => !e.commence_time || Date.parse(e.commence_time) > now)
      .slice(0, nGames);
    if (!upcoming.length) return cors(json({ ...out, error: 'no upcoming event to probe' }, 30));
    out.gamesProbed = upcoming.length;
    out.estimatedCredits = markets.length * Math.ceil(allBooks.length / 10) * upcoming.length;
    out.probedEvents = upcoming.map((e) => `${e.away_team} @ ${e.home_team}`);
    const ev = upcoming[0];
    out.probedEvent = `${ev.away_team} @ ${ev.home_team}`;

    // Accumulate across every probed game so coverage reflects the slate rather
    // than one matchup. acc[book][market] = { players, twoSided, games, sums[] }.
    const acc = {};
    // Per-book totals cannot answer "how many player-lines have TWO sharp books
    // on them" — 105 quotes from one book and 120 from another may or may not be
    // the same players. Overlap has to be keyed the way the pricer keys it.
    //
    // bestBookMarket requires `b.point === refLine`: a sharp book only counts if
    // it quotes the EXACT line being priced, two-sided. So the unit here is
    // (market, player, point), not (market, player). lineAcc[mk][player|point] =
    // { sharp:Set, exec:Set }. Costs no extra API calls — it reads the same
    // responses the loop already fetched.
    const lineAcc = {};
    // Which players each book quotes, any side: covAcc[market][book] = Map of
    // "event|player" -> point. Answers "do DraftKings and PrizePicks cover the
    // same players" from the same responses, at no extra cost (2026-10-14).
    const covAcc = {};
    for (const e of upcoming) {
      const url = `${base}/events/${e.id}/odds?apiKey=${key}&bookmakers=${allBooks.join(',')}`
        + `&markets=${markets.join(',')}&oddsFormat=american&dateFormat=iso`;
      const r = await fetch(url, { headers: { accept: 'application/json' } });
      await recordOddsUsage(env, r, 'debug:fair-probe');
      out.httpStatus = r.status;
      out.creditsUsed = r.headers.get('x-requests-last') || out.creditsUsed || null;
      out.creditsRemaining = r.headers.get('x-requests-remaining') || null;
      if (!r.ok) { out.body = (await r.text()).slice(0, 300); continue; }
      const d = await r.json();
      for (const bm of (d.bookmakers || [])) {
        const bAcc = acc[bm.key] || (acc[bm.key] = {});
        for (const mk of (bm.markets || [])) {
          const players = {};
          for (const oc of (mk.outcomes || [])) {
            const nm = oc.description || oc.name;
            const p = players[nm] || (players[nm] = {});
            if (oc.name === 'Over') p.over = oc.price; else if (oc.name === 'Under') p.under = oc.price;
            if (oc.point != null) p.point = oc.point;
          }
          const list = Object.values(players);
          const twoSided = list.filter((p) => p.over != null && p.under != null);
          // Overround on a two-sided quote — the vig this book charges. An
          // exchange is often assumed to sit near 1.00; ProphetX measured 1.085
          // on batter props, so this is worth reading rather than assuming.
          const sums = twoSided.map((p) => amProb(p.over) + amProb(p.under)).filter((x) => isFinite(x));
          const m = bAcc[mk.key] || (bAcc[mk.key] = { players: 0, twoSided: 0, games: 0, sums: [] });
          m.players += list.length; m.twoSided += twoSided.length; m.games += 1;
          for (const s of sums) m.sums.push(s);
          const cov = covAcc[mk.key] || (covAcc[mk.key] = {});
          const seen = cov[bm.key] || (cov[bm.key] = new Map());
          for (const nm of Object.keys(players)) seen.set(`${e.id}|${nm}`, players[nm].point ?? null);

          // Same pass, keyed by the line. Only two-sided quotes with a point can
          // ever serve as a fair source, so one-sided and point-less rows are
          // skipped here exactly as the pricer skips them.
          const isSharp = sharpBooks.includes(bm.key);
          const mkAcc = lineAcc[mk.key] || (lineAcc[mk.key] = {});
          for (const nm of Object.keys(players)) {
            const p = players[nm];
            if (p.over == null || p.under == null || p.point == null) continue;
            // Event id in the key so the same player name in two games can't merge.
            const k = `${e.id}|${nm}|${p.point}`;
            const slot = mkAcc[k] || (mkAcc[k] = { sharp: new Set(), exec: new Set() });
            (isSharp ? slot.sharp : slot.exec).add(bm.key);
          }
        }
      }
    }

    // For each book x market: did it post, and is it two-sided (de-viggable)?
    // A one-sided quote cannot be de-vigged, so it is useless as a fair source.
    const byBook = {};
    for (const book of Object.keys(acc)) {
      const entry = { markets: {} };
      for (const mkKey of Object.keys(acc[book])) {
        const m = acc[book][mkKey];
        entry.markets[mkKey] = {
          players: m.players,
          twoSided: m.twoSided,
          gamesQuoted: m.games,
          gamesProbed: upcoming.length,
          medianBooksum: m.sums.length ? Math.round(median(m.sums) * 1e4) / 1e4 : null,
        };
      }
      byBook[book] = entry;
    }
    out.byBook = byBook;

    // Sharp overlap per bettable line. The denominator is what matters: a line
    // nobody can bet is not a lost pick, so only lines an execution book (DK/FD)
    // quotes two-sided count as the universe. Of those, how many carry 1, 2, or
    // 3+ sharp books at the SAME point?
    //
    // This is the cost of the two-book-minimum rule. Note the current pricer
    // accepts a single sharp book (`if (pool.length)`), so `sharp1` rows are
    // priced today and would be SKIPPED under the new rule — that difference is
    // `wouldSkipUnderTwoBookRule`.
    try {
      const overlap = {};
      for (const mkKey of Object.keys(lineAcc)) {
        const rows = Object.values(lineAcc[mkKey]);
        const bettable = rows.filter((r) => r.exec.size > 0);
        const cnt = (n, set) => set.filter((r) => r.sharp.size === n).length;
        const atLeast = (n, set) => set.filter((r) => r.sharp.size >= n).length;
        const b = bettable;
        const two = atLeast(2, b);
        overlap[mkKey] = {
          linesQuotedByAnyBook: rows.length,
          bettableLines: b.length,               // DK or FD two-sided
          sharp0: cnt(0, b),
          sharp1: cnt(1, b),
          sharp2: cnt(2, b),
          sharp3plus: atLeast(3, b),
          pricedToday: atLeast(1, b),            // current rule: >=1 sharp book
          pricedUnderTwoBookRule: two,           // new rule: >=2
          wouldSkipUnderTwoBookRule: atLeast(1, b) - two,
          pctBettableWithTwoSharp: b.length ? Math.round(1000 * two / b.length) / 10 : null,
          // Every two-sided line, bettable or not: how many carry two or more
          // sharp books at the same number. With PrizePicks in ?books= it counts
          // as an execution book above, so "bettable" there includes PP-only lines.
          linesWith2PlusSharp: atLeast(2, rows),
          pctLossVsToday: atLeast(1, b)
            ? Math.round(1000 * (atLeast(1, b) - two) / atLeast(1, b)) / 10
            : null,
        };
      }
      out.sharpOverlap = overlap;
      const tot = Object.values(overlap).reduce((s, o) => ({
        priced: s.priced + o.pricedToday,
        two: s.two + o.pricedUnderTwoBookRule,
      }), { priced: 0, two: 0 });
      out.sharpOverlapVerdict = tot.priced
        ? `Two-book rule prices ${tot.two} of ${tot.priced} currently-priced lines `
          + `(${Math.round(1000 * tot.two / tot.priced) / 10}% kept, `
          + `${tot.priced - tot.two} skipped). Read per-market — H+R+RBI has only two `
          + `eligible books, so it has no redundancy under this rule.`
        : 'no bettable lines in the sample.';
    } catch (err) { out.sharpOverlapError = String(err && err.message || err); }
    // Player coverage between each pair of execution books (e.g. DraftKings and
    // PrizePicks): who quotes whom, and on how many both hang the same number.
    try {
      const exec = allBooks.filter((b) => !sharpBooks.includes(b));
      const nameOf = (k) => k.slice(k.indexOf('|') + 1);
      out.playerCoverage = {};
      for (const mkKey of Object.keys(covAcc)) {
        const cov = covAcc[mkKey], pairs = {};
        for (let i = 0; i < exec.length; i++) for (let j = i + 1; j < exec.length; j++) {
          const a = exec[i], b = exec[j], A = cov[a] || new Map(), B = cov[b] || new Map();
          if (!A.size && !B.size) continue;
          const both = [...A.keys()].filter((k) => B.has(k));
          pairs[`${a}|${b}`] = {
            [a]: A.size, [b]: B.size, both: both.length,
            [`${a}Only`]: A.size - both.length, [`${b}Only`]: B.size - both.length,
            bothSameNumber: both.filter((k) => A.get(k) != null && A.get(k) === B.get(k)).length,
            [`${a}OnlySample`]: [...A.keys()].filter((k) => !B.has(k)).slice(0, 6).map(nameOf),
            [`${b}OnlySample`]: [...B.keys()].filter((k) => !A.has(k)).slice(0, 6).map(nameOf),
          };
        }
        out.playerCoverage[mkKey] = pairs;
      }
    } catch (err) { out.playerCoverageError = String(err && err.message || err); }
    // A sharp book only counts if it posts a TWO-SIDED quote — a one-sided price
    // cannot be de-vigged, so it can't produce a fair line no matter who posts it.
    const deviggable = (b) => byBook[b] && Object.values(byBook[b].markets).some((m) => m.twoSided > 0);
    out.sharpBooksReturning = PROBE_FAIR_BOOKS.filter(deviggable);
    out.sharpBooksOneSidedOnly = PROBE_FAIR_BOOKS.filter((b) => byBook[b] && !deviggable(b));
    out.verdict = out.sharpBooksReturning.length
      ? `VIABLE — ${out.sharpBooksReturning.join(', ')} post ${markets.join(', ')} two-sided. A non-circular fair line is possible: de-vig the sharp book for fair, price the DK/FD number against it. Check gamesQuoted vs gamesProbed per book before relying on it — a book that quoted 1 of 6 games is not a fair source for the slate.`
      : `NOT VIABLE as-is — no sharp book returned ${markets.join(', ')} two-sided. The fair line would need another source (e.g. a consensus of soft books excluding the one you bet), or the edge stays circular.`;
    return cors(json(out, 30));
  } catch (e) {
    return cors(json({ ...out, error: String(e && e.message || e) }, 30));
  }
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function round1(n) { return Math.round(n * 10) / 10; }
function numOr(a, b) {
  if (typeof a === 'number') return a;
  if (typeof b === 'number') return b;
  return null;
}
function timeLabelPT(iso) {
  try {
    return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' }).format(new Date(iso)) + ' PT';
  } catch (e) { return ''; }
}
// Today's date on the US West Coast (YYYY-MM-DD) — the site's "slate" date.
// /api/ml-debug — read-only diagnostic for the moneyline pipeline. Shows the
// schedule games, what the h2h odds feed actually returns (names, book keys),
// and whether each schedule game finds a matching odds line via keyAbbr. The
// API key never appears in the output. Safe to leave in; it makes no extra paid
// calls beyond the one h2h fetch this endpoint does itself.
async function mlDebug(env) {
  const key = env && env.ODDS_API_KEY;
  const date = slateDate();
  const out = { slateDate: date, hasKey: !!key, schedule: [], odds: {}, matches: [] };
  try {
    const r = await fetch(`${STATS}/schedule?sportId=1&date=${date}&hydrate=team`, { headers: { accept: 'application/json' } });
    const d = await r.json();
    const games = (((d.dates || [])[0] || {}).games) || [];
    out.schedule = games.map((g) => ({
      matchup: `${teamAbbr(g.teams.away.team)} @ ${teamAbbr(g.teams.home.team)}`,
      homeName: (g.teams.home.team || {}).name,
      homeKey: keyAbbr((g.teams.home.team || {}).name),
      status: (g.status && g.status.abstractGameState) || '',
    }));
  } catch (e) { out.scheduleError = String(e && e.message || e); }

  const byKey = {};
  if (key) {
    try {
      // Pull h2h (moneyline) AND spreads (the run line) so this endpoint can
      // explain both an empty Moneyline board and an empty Run Line board.
      const r = await fetch(`${ODDS}/odds?apiKey=${key}&regions=us,eu&markets=h2h,spreads&oddsFormat=american&dateFormat=iso`, { headers: { accept: 'application/json' } });
      await recordOddsUsage(env, r, 'debug:ml-debug');
      out.odds.status = r.status;
      const events = await r.json();
      const hasMarket = (bk, k) => (bk.markets || []).some((m) => m.key === k);
      if (Array.isArray(events)) {
        out.odds.count = events.length;
        out.odds.events = events.map((ev) => {
          const books = ev.bookmakers || [];
          const info = {
            home: ev.home_team, homeKey: keyAbbr(ev.home_team),
            commence: ev.commence_time,
            dkfd: books.filter((b) => BOOKS[b.key]).map((b) => b.key),
            pinnacle: books.some((b) => b.key === REF_BOOK),
            // Run-line (spreads) coverage, separately from moneyline.
            dkfdSpread: books.filter((b) => BOOKS[b.key] && hasMarket(b, 'spreads')).map((b) => b.key),
            pinnacleSpread: books.some((b) => b.key === REF_BOOK && hasMarket(b, 'spreads')),
          };
          byKey[info.homeKey] = info;
          return info;
        });
      } else {
        // Odds API error bodies carry a message/error_code — never the key.
        out.odds.error = (events && (events.message || events.error_code)) || 'non-array response';
      }
    } catch (e) { out.odds.fetchError = String(e && e.message || e); }
  }

  out.matches = out.schedule.map((s) => {
    const m = byKey[s.homeKey];
    return {
      matchup: s.matchup, homeKey: s.homeKey, oddsFound: !!m,
      dkfd: m ? m.dkfd : [], pinnacle: m ? m.pinnacle : false,
      dkfdSpread: m ? m.dkfdSpread : [], pinnacleSpread: m ? m.pinnacleSpread : false,
    };
  });
  const matchedWithPinnacleSpread = out.matches.filter((m) => m.pinnacleSpread).length;
  out.summary = {
    scheduleGames: out.schedule.length,
    oddsEvents: out.odds.count || 0,
    matched: out.matches.filter((m) => m.oddsFound).length,
    matchedWithDkFd: out.matches.filter((m) => m.dkfd && m.dkfd.length).length,
    matchedWithPinnacle: out.matches.filter((m) => m.pinnacle).length,
    // Run line: a pick needs a DK/FD spread priced AND a Pinnacle spread to
    // anchor fair value. If matchedWithDkFdSpread is 0, the Run Line board is
    // empty because the book feed has no spreads yet — not a site bug.
    matchedWithDkFdSpread: out.matches.filter((m) => m.dkfdSpread && m.dkfdSpread.length).length,
    matchedWithPinnacleSpread,
    runLineReady: matchedWithPinnacleSpread > 0,
  };
  return cors(json(out, 10));
}

// Read-only pipeline health: is D1 bound, are picks logging for the current
// slate, and are prior days grading? Purely diagnostic — no writes, no model
// paths. GET /api/track-debug.
async function trackDebug(env) {
  const today = slateDate();
  const out = { slateDate: today, db: !!(env && env.DB) };
  if (!out.db) { out.note = 'env.DB is undefined — D1 binding not active; the site shows demo data.'; return cors(json(out, 10)); }
  try {
    await ensureSchema(env.DB);
    await ensureBatterSchema(env.DB);
    await ensureMlSchema(env.DB);
    await ensureMlPickSchema(env.DB);

    // Per-table counts by date (last 7 dates), plus graded/ungraded split.
    const tables = { picks: 'picks', bpicks: 'bpicks', mlpicks: 'mlpicks' };
    out.tables = {};
    for (const [label, tbl] of Object.entries(tables)) {
      const byDate = (await env.DB.prepare(
        `SELECT date, COUNT(*) AS n,
                SUM(CASE WHEN result IS NULL THEN 1 ELSE 0 END) AS ungraded,
                SUM(CASE WHEN result IS NOT NULL THEN 1 ELSE 0 END) AS graded
         FROM ${tbl} GROUP BY date ORDER BY date DESC LIMIT 7`
      ).all()).results || [];
      const total = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${tbl}`).first('n')) || 0;
      out.tables[label] = { total, byDate };
    }

    // Closing-line persistence snapshots (prop_lines, rl_lines) — browser-checkable
    // so persistence can be confirmed without the D1 query tools.
    try {
      await ensurePropSchema(env.DB);
      await ensureRlSchema(env.DB);
      const persist = {};
      for (const tbl of ['prop_lines', 'rl_lines']) {
        const total = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${tbl}`).first('n')) || 0;
        const byDate = (await env.DB.prepare(`SELECT date, COUNT(*) AS n, MAX(updated_at) AS updated FROM ${tbl} GROUP BY date ORDER BY date DESC LIMIT 5`).all()).results || [];
        persist[tbl] = { total, byDate };
      }
      out.persistence = persist;
      const pn = persist.prop_lines.total, rn = persist.rl_lines.total;
      out.persistenceVerdict = (pn > 0 && rn > 0)
        ? 'OK — both prop_lines and rl_lines have snapshots; closing lines persist.'
        : (pn === 0 && rn === 0)
          ? 'EMPTY — neither table has rows yet (expected until a pre-game window runs after deploy).'
          : `PARTIAL — prop_lines=${pn}, rl_lines=${rn} (the empty one had no qualifying pre-game snapshot).`;
    } catch (e) { out.persistenceError = String(e && e.message || e); }

    // Did-not-play reconciliation. Before the DNP fix a rostered batter who never
    // came off the bench carried an empty stats.batting object, which scored every
    // category 0 and graded an Under as a win. backfillBatterGrades re-derives
    // those rows from the boxscore, 4 games per /api/track-record hit, and stamps
    // grade_ver so the sweep terminates. Without a counter the only way to tell
    // "finished" from "silently retrying the same games" was to poll the aggregate
    // numbers and watch for movement — a stuck sweep looks exactly like a done one,
    // because the loop `continue`s when a boxscore fetch fails. pendingGames is the
    // honest answer: it is the sweep's own candidate query, so 0 means done.
    try {
      // bind() is skipped when there are no placeholders — a zero-arg bind is not
      // worth relying on across driver versions.
      const q = async (sql, ...b) => {
        const st = env.DB.prepare(sql);
        return (await (b.length ? st.bind(...b) : st).first('n')) || 0;
      };
      const voids = await q(`SELECT COUNT(*) AS n FROM bpicks WHERE result='void'`);
      const stamped = await q(`SELECT COUNT(*) AS n FROM bpicks WHERE grade_ver=?`, GRADE_VER);
      // Exactly the rows backfillBatterGrades selects, and the games it batches by.
      const pendingRows = await q(
        `SELECT COUNT(*) AS n FROM bpicks
          WHERE actual = 0 AND result IN ('win','loss')
            AND (grade_ver IS NULL OR grade_ver <> ?)`, GRADE_VER);
      const pendingGames = await q(
        `SELECT COUNT(*) AS n FROM (
           SELECT DISTINCT game_id FROM bpicks
            WHERE actual = 0 AND result IN ('win','loss')
              AND (grade_ver IS NULL OR grade_ver <> ?)) AS pend`, GRADE_VER);
      out.dnp = {
        gradeVer: GRADE_VER,
        voids,                                   // rows the fix correctly left ungraded
        stamped,                                 // rows this grader has reconciled
        pendingRows,
        pendingGames,
        passesRemaining: Math.ceil(pendingGames / 4), // sweep does 4 games per call
        verdict: pendingGames === 0
          ? `COMPLETE — no rows left with actual=0 graded win/loss and an unstamped grade_ver. ${voids} void${voids === 1 ? '' : 's'} recorded.`
          : `IN PROGRESS — ${pendingRows} row(s) across ${pendingGames} game(s) still to re-derive; ~${Math.ceil(pendingGames / 4)} more /api/track-record hit(s). If this number does not fall between checks, the boxscore fetch is failing and the sweep is stuck.`,
      };
    } catch (e) { out.dnpError = String(e && e.message || e); }

    // Rows that should have graded and did not. Anything ungraded on a date
    // before today has had its game finish, so a nonzero count here is a stuck
    // grader — the failure that used to be invisible because the sweeps skip
    // silently. Listed with game_id so a straggler can be looked up by gamePk.
    try {
      const stuck = {};
      let stuckTotal = 0;
      for (const [label, tbl] of Object.entries({ picks: 'picks', bpicks: 'bpicks', mlpicks: 'mlpicks' })) {
        const rows = (await env.DB.prepare(
          `SELECT date, game_id, COUNT(*) AS n FROM ${tbl}
            WHERE result IS NULL AND date < ?
            GROUP BY date, game_id ORDER BY date DESC LIMIT 12`
        ).bind(today).all()).results || [];
        const n = (await env.DB.prepare(
          `SELECT COUNT(*) AS n FROM ${tbl} WHERE result IS NULL AND date < ?`).bind(today).first('n')) || 0;
        stuckTotal += n;
        stuck[label] = { n, rows };
      }
      out.stuck = {
        total: stuckTotal,
        byTable: stuck,
        verdict: stuckTotal === 0
          ? 'OK — every pick on a completed date has graded.'
          : `${stuckTotal} row(s) ungraded on dates already past. The graders now resolve by gamePk and void abandoned games, so this should fall to 0; if it does not, the game_ids above are not resolving.`,
      };
    } catch (e) { out.stuckError = String(e && e.message || e); }

    // Freshest signal: what's logged for tonight, and is the newest date grading?
    const loggedToday = (await env.DB.prepare('SELECT COUNT(*) AS n FROM picks WHERE date=?').bind(today).first('n')) || 0;
    const bLoggedToday = (await env.DB.prepare('SELECT COUNT(*) AS n FROM bpicks WHERE date=?').bind(today).first('n')) || 0;
    const sample = (await env.DB.prepare('SELECT pitcher, team, line, side, price, tier FROM picks WHERE date=? LIMIT 6').bind(today).all()).results || [];
    out.tonight = { date: today, kPicks: loggedToday, batterPicks: bLoggedToday, sample };

    // Plain-language health read so it's obvious at a glance.
    const anyToday = loggedToday > 0 || bLoggedToday > 0;
    const latestPickDate = (out.tables.picks.byDate[0] || {}).date || null;
    out.health = {
      loggingTonight: anyToday,
      latestLoggedDate: latestPickDate,
      verdict: anyToday
        ? 'OK — picks are logging for tonight; check tomorrow that this date grades (ungraded → graded).'
        : (out.tables.picks.total > 0
            ? 'WARNING — history exists but nothing logged for tonight yet (expected before first pitch; recheck after lines post).'
            : 'EMPTY — no picks logged at all. Any numbers on the site are demo/backfill, not the live pipeline.'),
    };
  } catch (e) {
    out.error = String(e && e.message || e);
  }
  return cors(json(out, 10));
}

function slateDate() {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch (e) { return new Date().toISOString().slice(0, 10); }
}

// -------------------------------------------------------------------------
// /api/injuries — batters currently on the injured list for tonight's teams,
// read from each team's roster status (so a star who's been out for a week+
// still shows — not just the last 3 days of IL transactions). Falls back to
// the recent-transaction wire if the roster read comes back empty.
// -------------------------------------------------------------------------
async function injuries() {
  const season = new Date().getUTCFullYear();
  const date = slateDate();

  // Which teams play tonight (+ their abbreviations and each team's matchup, so
  // an alert can name the game — the client uses that to flag injuries in a game
  // you have a pick on).
  const teamIds = new Set();
  const abbrById = {};
  const gameByTeam = {};
  try {
    const r = await fetch(`${STATS}/schedule?sportId=1&date=${date}&hydrate=team`, { headers: { accept: 'application/json' } });
    if (r.ok) {
      const sd = await r.json();
      (((sd.dates || [])[0] || {}).games || []).forEach((g) => {
        const aw = g.teams && g.teams.away && g.teams.away.team;
        const hm = g.teams && g.teams.home && g.teams.home.team;
        const matchup = (aw && hm) ? `${keyAbbr(aw.name)} @ ${keyAbbr(hm.name)}` : '';
        ['away', 'home'].forEach((s) => {
          const t = g.teams && g.teams[s] && g.teams[s].team;
          if (t && t.id) { teamIds.add(t.id); abbrById[t.id] = keyAbbr(t.name); gameByTeam[t.id] = matchup; }
        });
      });
    }
  } catch (e) { /* fall through to the transaction wire below */ }

  // Current injured-list batters on those rosters.
  const cand = [];
  await Promise.all([...teamIds].map(async (tid) => {
    try {
      const r = await fetch(`${STATS}/teams/${tid}/roster?rosterType=fullSeason&season=${season}`, { headers: { accept: 'application/json' } });
      if (!r.ok) return;
      const d = await r.json();
      for (const e of (d.roster || [])) {
        const desc = (e.status && e.status.description) || '';
        // Roster status reads "Injured 10-Day" / "Injured 60-Day" / etc.
        if (!/injured/i.test(desc)) continue;            // currently on some IL
        const pos = e.position || {};
        if (pos.type === 'Pitcher' || pos.abbreviation === 'P') continue; // batters only
        const pid = e.person && e.person.id, name = e.person && e.person.fullName;
        if (pid && name) cand.push({ pid, name, team: tid, status: shortIL(desc) });
      }
    } catch (e) { /* skip this team */ }
  }));

  let rows;
  if (cand.length) {
    // Rank by season PA so everyday regulars lead; keep the notable ones.
    const paById = await batterPAs(cand.map((c) => c.pid), season);
    rows = cand
      .filter((c) => (paById[c.pid] || 0) >= STARTER_PA)
      .sort((a, b) => (paById[b.pid] || 0) - (paById[a.pid] || 0))
      .slice(0, 10)
      .map((c) => ({
        text: `${c.name}${abbrById[c.team] ? ' · ' + abbrById[c.team] : ''}`,
        time: c.status,
        teamAbbr: abbrById[c.team] || '',
        game: gameByTeam[c.team] || '',
      }));
  } else {
    // Fallback: the recent IL-transaction wire (widened to 14 days).
    rows = await recentILTransactions(season);
  }
  return cors(json(rows, 600)); // 10 min
}

// Roster status -> short IL label. "Injured 10-Day" -> "10-Day IL";
// "10-Day Injured List" -> "10-Day IL".
function shortIL(desc) {
  const s = String(desc).trim();
  const m = s.match(/^injured\s+(.+)$/i);      // "Injured 10-Day" -> "10-Day"
  if (m) return `${m[1].trim()} IL`;
  return s.replace(/injured list/i, 'IL').replace(/\s+/g, ' ').trim();
}

// Bulk season plate appearances by player id.
async function batterPAs(pids, season) {
  const paById = {};
  const ids = [...new Set(pids)].filter(Boolean);
  if (!ids.length) return paById;
  try {
    const r = await fetch(`${STATS}/people?personIds=${ids.join(',')}&hydrate=stats(group=[hitting],type=[season],season=${season})`, { headers: { accept: 'application/json' } });
    if (r.ok) {
      const d = await r.json();
      (d.people || []).forEach((pl) => {
        const sp = (((pl.stats || [])[0] || {}).splits || [])[0];
        paById[pl.id] = sp ? toNum(sp.stat.plateAppearances) : 0;
      });
    }
  } catch (e) { /* leave empty -> no PA gate */ }
  return paById;
}

// Fallback: recent IL placements from the transactions feed (MLB batters only).
async function recentILTransactions(season) {
  const end = slateDate();
  const start = slateDateOffset(-14);
  let data;
  try {
    const r = await fetch(`${STATS}/transactions?startDate=${start}&endDate=${end}`, { headers: { accept: 'application/json' } });
    if (!r.ok) return [];
    data = await r.json();
  } catch (e) { return []; }

  const txns = (data.transactions || []).filter((t) => {
    const d = t.description || '';
    const mlb = MLB_TEAM_IDS.has((t.toTeam || {}).id) || MLB_TEAM_IDS.has((t.fromTeam || {}).id);
    // Placements/transfers TO the IL — never activations/reinstatements FROM it
    // (those are players coming back healthy, not injury news).
    return mlb && /injured list/i.test(d) && !/activated|reinstated/i.test(d) && !isPitcherMove(d);
  });
  txns.sort((a, b) => String(b.effectiveDate || b.date || '').localeCompare(String(a.effectiveDate || a.date || '')));

  const seen = new Set(), cand = [];
  for (const t of txns) {
    const text = String(t.description || '').trim();
    const pid = t.person && t.person.id;
    if (!text || !pid || seen.has(text)) continue;
    seen.add(text);
    cand.push({ text, time: txnDateLabel(t.effectiveDate || t.date), pid });
  }
  if (!cand.length) return [];
  const paById = await batterPAs(cand.map((c) => c.pid), season);
  return cand
    .filter((c) => (paById[c.pid] || 0) >= STARTER_PA)
    .slice(0, 8)
    .map((c) => ({ text: c.text, time: c.time }));
}

// A "regular starter" bar: season plate appearances. Tune to taste (higher =
// only everyday regulars; lower = includes platoon/part-time starters).
const STARTER_PA = 150;

// The 30 MLB team ids (the transactions feed also carries every minor league).
const MLB_TEAM_IDS = new Set([108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121, 133, 134, 135, 136, 137, 138, 139, 140, 141, 142, 143, 144, 145, 146, 147, 158]);

// True when a transaction describes a pitcher (position code before the name
// is P/RHP/LHP/SP/RP). Unparseable -> treated as non-pitcher (kept).
function isPitcherMove(desc) {
  const m = String(desc).match(/\b(?:placed|activated|reinstated|transferred|optioned|recalled|designated|selected|claimed|signed)\s+([A-Z0-9]{1,3})\s+[A-Z][a-z]/);
  const pos = m ? m[1].toUpperCase() : '';
  return /^(P|RHP|LHP|SP|RP)$/.test(pos);
}

function slateDateOffset(days) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + days * 86400000));
  } catch (e) { return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10); }
}
function txnDateLabel(d) {
  if (!d) return '';
  try {
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles' }).format(new Date(String(d) + 'T18:00:00Z'));
  } catch (e) { return String(d); }
}

function shortName(full) {
  if (!full) return '';
  const parts = String(full).trim().split(/\s+/);
  if (parts.length < 2) return String(full);
  return parts[0][0] + '. ' + parts.slice(1).join(' ');
}
function toNum(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }
function avg3(v) {
  if (v === undefined || v === null || v === '') return '—';
  let s = String(v);
  if (s.startsWith('0.')) s = s.slice(1);   // 0.312 -> .312
  return s;
}
// OPS to three decimals with the leading zero dropped: 0.99 -> ".990".
function ops3(v) {
  if (v == null || isNaN(v)) return '—';
  let s = Number(v).toFixed(3);
  if (s.startsWith('0.')) s = s.slice(1);
  return s;
}
function teamAbbr(team) {
  if (!team) return '';
  if (team.abbreviation) return team.abbreviation;
  return TEAM_ABBR_BY_NAME[team.name]
    || String(team.name || '').split(' ').pop().slice(0, 3).toUpperCase();
}
// Keyed to the LEAGUE's own abbreviations (StatsAPI `team.abbreviation`), which
// is what the strikeout board prints, because that board reads them straight off
// the schedule. Arizona was the one club where this table disagreed — 'ARI' here
// against StatsAPI's 'AZ' — so the same game read "MIA @ ARI" on the batter board
// and "MIA @ AZ" on the strikeout board. Checked against all 30 clubs on
// 2026-09-16; Arizona was the only mismatch.
const TEAM_ABBR_BY_NAME = {
  'Arizona Diamondbacks': 'AZ', 'Atlanta Braves': 'ATL', 'Baltimore Orioles': 'BAL',
  'Boston Red Sox': 'BOS', 'Chicago Cubs': 'CHC', 'Chicago White Sox': 'CWS',
  'Cincinnati Reds': 'CIN', 'Cleveland Guardians': 'CLE', 'Colorado Rockies': 'COL',
  'Detroit Tigers': 'DET', 'Houston Astros': 'HOU', 'Kansas City Royals': 'KC',
  'Los Angeles Angels': 'LAA', 'Los Angeles Dodgers': 'LAD', 'Miami Marlins': 'MIA',
  'Milwaukee Brewers': 'MIL', 'Minnesota Twins': 'MIN', 'New York Mets': 'NYM',
  'New York Yankees': 'NYY', 'Oakland Athletics': 'ATH', 'Athletics': 'ATH',
  'Philadelphia Phillies': 'PHI', 'Pittsburgh Pirates': 'PIT', 'San Diego Padres': 'SD',
  'San Francisco Giants': 'SF', 'Seattle Mariners': 'SEA', 'St. Louis Cardinals': 'STL',
  'Tampa Bay Rays': 'TB', 'Texas Rangers': 'TEX', 'Toronto Blue Jays': 'TOR',
  'Washington Nationals': 'WSH',
};

// -------------------------------------------------------------------------
// Shared helpers
// -------------------------------------------------------------------------
async function proxy(upstream, env, ctx, route, maxAge) {
  let r;
  try {
    r = await fetch(upstream, { headers: { accept: 'application/json' } });
    // A paid call like any other. This was one of two spenders with no meter on
    // it at all, so it could never show up in the ledger no matter what it cost
    // -- and it turned out to be 29% of a day's quota.
    if (route && env) {
      const rec = recordOddsUsage(env, r, route);
      if (ctx && ctx.waitUntil) ctx.waitUntil(rec); else await rec;
    }
  } catch (e) {
    return err('upstream fetch failed: ' + e, 502);
  }
  const body = await r.text();
  return cors(new Response(body, {
    status: r.status,
    headers: {
      'content-type': 'application/json',
      // Caller-set, because 30 was shorter than the poll interval of the only
      // thing that reads this -- a TTL that expires before the next request is
      // a cache that can never be hit.
      'cache-control': `public, max-age=${maxAge || 30}`,
      'x-requests-remaining': r.headers.get('x-requests-remaining') || '',
      'x-requests-used': r.headers.get('x-requests-used') || '',
    },
  }));
}

function json(obj, maxAge) {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${maxAge || 30}` },
  });
}
function err(message, status) {
  return cors(new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'content-type': 'application/json' },
  }));
}
function cors(resp) {
  resp.headers.set('access-control-allow-origin', '*');
  resp.headers.set('access-control-allow-methods', 'GET,OPTIONS');
  resp.headers.set('access-control-expose-headers', 'x-requests-remaining,x-requests-used');
  return resp;
}

// GET /api/nfl-ingest — pulls the NFL game-line slate into nfl_lines and reports
// what it wrote. ?dry=1 parses and counts without writing, so the shape can be
// checked against a live payload before any row lands in D1.
async function nflIngest(env, url) {
  const dry = url && url.searchParams && url.searchParams.get('dry') === '1';
  const sport = (url && url.searchParams && url.searchParams.get('sport')) || 'nfl';
  // One-off repair for rows written before change-detection existed: every poll
  // stored a full snapshot, so identical prices repeat. Keeps the EARLIEST row of
  // each run of identical values -- which is exactly what appending-on-change
  // would have produced -- and deletes only rows an older identical twin already
  // covers. A price that genuinely moved and moved back keeps both entries.
  if (url && url.searchParams && url.searchParams.get('dedupe') === '1') {
    await ensureNflSchema(env.DB);
    const before = await env.DB.prepare('SELECT COUNT(*) AS n FROM nfl_lines').first();
    const del = await env.DB.prepare(
      'DELETE FROM nfl_lines WHERE rowid IN ('
      + '  SELECT a.rowid FROM nfl_lines a JOIN nfl_lines b'
      + '    ON a.event_id = b.event_id AND a.market = b.market AND a.book = b.book'
      + '   AND IFNULL(a.player,\'\') = IFNULL(b.player,\'\')'
      + '   AND IFNULL(a.point,-9999) = IFNULL(b.point,-9999)'
      + '   AND IFNULL(a.over,-9999) = IFNULL(b.over,-9999)'
      + '   AND IFNULL(a.under,-9999) = IFNULL(b.under,-9999)'
      + '   AND b.captured_at < a.captured_at)'
    ).run();
    const after = await env.DB.prepare('SELECT COUNT(*) AS n FROM nfl_lines').first();
    return cors(json({
      dedupe: true, before: before ? before.n : null, after: after ? after.n : null,
      deleted: (before && after) ? before.n - after.n : null,
      meta: del && del.meta ? del.meta : null,
    }, 30));
  }
  const res = await ingestNflLines(env, { dry, sport });

  if (env && env.DB && !res.errors.length) {
    try {
      await ensureNflSchema(env.DB);
      const tot = await env.DB.prepare('SELECT COUNT(*) AS n FROM nfl_lines').first();
      const wks = await env.DB.prepare(
        'SELECT week, COUNT(*) AS n FROM nfl_lines GROUP BY week ORDER BY week'
      ).all();
      const nullWk = await env.DB.prepare('SELECT COUNT(*) AS n FROM nfl_lines WHERE week IS NULL').first();
      res.tableRows = tot ? tot.n : null;
      res.byWeek = (wks.results || []).map((r) => `wk${r.week == null ? '?' : r.week}:${r.n}`);
      res.rowsWithoutWeek = nullWk ? nullWk.n : null;
    } catch (e) { res.errors.push('readback: ' + String((e && e.message) || e)); }
  }
  return cors(json(res, 30));
}

// ---------------------------------------------------------------------------
// GET /api/nfl-board — the NFL slate as game-line context.
//
// Context only, and structurally so: this endpoint has no player rows to return
// because no book is quoting NFL player props yet. It reads what the ingest
// stored rather than calling the Odds API, so loading the page costs nothing and
// the board always shows exactly what was last ingested.
//
// The gameline pool is Pinnacle / LowVig / BetOnline. Circa is not carried by
// the API, so the spec's third book is simply absent rather than substituted --
// quietly swapping in a retail book would make "sharp fair" mean something else.
// The Odds API returns full team names; every board on this site shows
// abbreviations, and a card reading "Tampa Bay Buccaneers at New York Jets"
// wraps to three lines on a phone. Mapped here so the abbreviation is decided
// once, server-side, instead of in each renderer.
const NFL_ABBR = {
  'Arizona Cardinals': 'ARI', 'Atlanta Falcons': 'ATL', 'Baltimore Ravens': 'BAL',
  'Buffalo Bills': 'BUF', 'Carolina Panthers': 'CAR', 'Chicago Bears': 'CHI',
  'Cincinnati Bengals': 'CIN', 'Cleveland Browns': 'CLE', 'Dallas Cowboys': 'DAL',
  'Denver Broncos': 'DEN', 'Detroit Lions': 'DET', 'Green Bay Packers': 'GB',
  'Houston Texans': 'HOU', 'Indianapolis Colts': 'IND', 'Jacksonville Jaguars': 'JAX',
  'Kansas City Chiefs': 'KC', 'Las Vegas Raiders': 'LV', 'Los Angeles Chargers': 'LAC',
  'Los Angeles Rams': 'LA', 'Miami Dolphins': 'MIA', 'Minnesota Vikings': 'MIN',
  'New England Patriots': 'NE', 'New Orleans Saints': 'NO', 'New York Giants': 'NYG',
  'New York Jets': 'NYJ', 'Philadelphia Eagles': 'PHI', 'Pittsburgh Steelers': 'PIT',
  'San Francisco 49ers': 'SF', 'Seattle Seahawks': 'SEA', 'Tampa Bay Buccaneers': 'TB',
  'Tennessee Titans': 'TEN', 'Washington Commanders': 'WAS',
};
// Falls back to the full name rather than an invented abbreviation: a relocation
// or a rename should read oddly and get fixed, not silently render as garbage.
const nflAbbr = (n) => NFL_ABBR[n] || n || '';
// Novig joined on 2026-10-27 (Pikkit's 2024 NFL main markets: Circa, Pinnacle,
// BookMaker, Novig), so a game Pinnacle has not hung still has two shops.
const NFL_GAMELINE_POOL = ['pinnacle', 'novig', 'lowvig', 'betonlineag'];
const NFL_EXEC = ['draftkings', 'fanduel', 'betmgm', 'betrivers', 'williamhill_us'];
// Sharp candidates for PLAYER PROPS, which is not the same list as the game
// lines. The 2026-09-09 probe found lowvig and betonlineag quote game lines but
// return nothing on props, while novig and prophetx only appear when asked for
// by key. Counted, not pooled: prophetx came back with a booksum of 0.70-0.76,
// which is below 1.0 and therefore not a real two-sided quote — unmatched
// exchange orders at week 1. It is reported so the thin coverage is visible,
// and deliberately not de-vigged into a fair number yet.
const NFL_PROPS_SHARP = ['pinnacle', 'novig', 'prophetx', 'lowvig', 'betonlineag'];

// -------------------------------------------------------------------------
// /api/nfl-compare — the frozen projection next to the line that was captured
// with it.
//
// This is a READER. It computes no fair line, no edge percentage, no tier, and
// posts nothing. The gap it reports is the model DISAGREEING with the market,
// which is not the same thing as value: the 58.9-61.8% under-mean the model was
// built on was measured against our own mean, never against a posted line, so
// calling the gap an edge would assert exactly the thing that has not been shown.
//
// It exists so the projections are legible and gradeable. Until nfl_proj.actual
// is filled from box scores, "does the model beat the line" stays open.
// -------------------------------------------------------------------------
const NFL_PROJ_TO_ODDS = { receiving: 'player_reception_yds', rushing: 'player_rush_yds' };

// -------------------------------------------------------------------------
// /api/nfl-grade — fill nfl_proj.actual from the box score. Costs nothing: the
// stats come from ESPN, not the paid odds feed.
//
// The distinction that matters is DNP versus zero. On 2026-09-09 three of ten
// projections were for players who recorded nothing — a 55.3-yard rushing
// projection for an inactive player is a guaranteed loss if it is ever posted,
// and averaging it in as a 0 would slander a model that was never given a
// chance to be wrong. But a player who dressed and gained nothing IS a real
// zero and has to count.
//
// They are told apart by whether the player appears ANYWHERE in his team's box
// score: present in some category but absent from receiving means he played and
// caught nothing; absent entirely means he did not play. Same rule the MLB side
// uses for a pitcher who struck nobody out.
//
// A graded DNP is stored as graded_at SET and actual NULL, so it leaves the
// pending pool without ever being scored. Ungraded rows have both NULL.
// -------------------------------------------------------------------------
// cdn.espn.com, NOT site.api.espn.com. The site.api host returns 403 to a
// Cloudflare Worker with or without a User-Agent while serving the identical URL
// to a laptop, which made the first grading run report "no ESPN event matched" —
// a refusal wearing the costume of a game nobody played. Confirmed by asking the
// Worker itself (/api/nfl-grade?probe=1): site.api 403, cdn.espn 200.
const ESPN_CDN = 'https://cdn.espn.com/core/nfl';
const ESPN_UA = 'aimplified-grader/1.0 (+https://aimplified.delexe.workers.dev)';
// ESPN puts generational suffixes in displayName ("Kyle Pitts Sr.", "James Cook
// III"). The projections are keyed by nflverse names, which often do not, and
// normName keeps the suffix — so the two never matched, and a player who dressed
// and gained yards was graded as a did-not-play. Week 1's first grading marked 27
// rows that way, with starters among them. The base name is a FALLBACK only, and
// only when a single athlete in that game has it (see nflGrade).
const NFL_NAME_SUFFIX = /\s+(jr|sr|ii|iii|iv|v)$/;
const nflBaseName = (s) => normName(s).replace(NFL_NAME_SUFFIX, '');

// Yardage projections used to be graded only when something called
// /api/nfl-grade: a one-off scheduled task did Week 1, and Weeks 2 and 3 sat
// ungraded. The cron now runs it every three hours. Free (ESPN box scores), and
// a run with nothing pending is one D1 query.
const NFL_GRADE_EVERY_MS = 3 * 3600e3;
async function nflGradeCron(env) {
  if (!env || !env.DB) return null;
  const key = 'nfl_grade_last';
  const hit = await loadFeedCache(env.DB, key);
  if (hit.present && hit.data && Date.now() - hit.data.at < NFL_GRADE_EVERY_MS) return null;
  await saveFeedCache(env.DB, key, { at: Date.now() });
  const res = await nflGrade(env, new URL('https://x/api/nfl-grade'));
  try { return await res.json(); } catch (e) { return null; }
}

async function nflGrade(env, url) {
  const out = { note: 'fills nfl_proj.actual from ESPN box scores — no Odds API call, no credits',
    pending: 0, events: 0, graded: 0, dnp: 0, unmatched: [], errors: [] };
  if (!env || !env.DB) { out.error = 'no DB binding'; return cors(json(out, 30)); }

  // ?probe=1 — which box-score hosts will actually answer a Worker?
  // site.api.espn.com returns 403 from Cloudflare while serving a laptop the
  // same URL, so "which source can this code reach" is a real question that
  // cannot be answered from a dev machine. Read-only, no DB, no credits.
  if (url && url.searchParams && url.searchParams.get('probe') === '1') {
    const UA = 'aimplified-grader/1.0 (+https://aimplified.delexe.workers.dev)';
    const cands = [
      ['site.api', 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=20260910'],
      ['cdn.espn', 'https://cdn.espn.com/core/nfl/scoreboard?xhr=1&dates=20260910'],
      ['sports.core', 'https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/events?dates=20260910'],
      ['github', 'https://raw.githubusercontent.com/nflverse/nflverse-data/master/README.md'],
    ];
    const res = {};
    for (const [name, u] of cands) {
      for (const withUa of [true, false]) {
        const tag = name + (withUa ? '' : ' (no UA)');
        try {
          const r = await fetch(u, { headers: withUa ? { accept: 'application/json', 'user-agent': UA } : { accept: 'application/json' } });
          const body = r.ok ? await r.text() : '';
          res[tag] = { status: r.status, bytes: body.length };
        } catch (e) { res[tag] = { error: String((e && e.message) || e) }; }
      }
    }
    return cors(json({ probe: 'box-score host reachability from the Worker', results: res }, 30));
  }

  try {
    await ensureNflSchema(env.DB);
    // A 5-hour buffer after kickoff: an NFL game runs ~3h10m, and grading a
    // game still in progress would freeze a partial stat line as the result.
    const cutoff = new Date(Date.now() - 5 * 3600 * 1000).toISOString();

    // ?regrade=dnp re-opens did-not-play rows so they are checked again. Needed
    // because the grader only looks at graded_at IS NULL: once a row was wrongly
    // marked DNP it was locked, and fixing the name match alone would change
    // nothing for rows already written. Scoped to actual IS NULL, so a row that
    // has a real stat line is never touched — the most this can do is turn a
    // wrong DNP into a result, or write the same DNP again.
    if (url && url.searchParams && url.searchParams.get('regrade') === 'dnp') {
      const r = await env.DB.prepare(
        `UPDATE nfl_proj SET graded_at = NULL
          WHERE actual IS NULL AND graded_at IS NOT NULL AND commence IS NOT NULL AND commence < ?`
      ).bind(cutoff).run();
      out.reopenedDnp = (r && r.meta && r.meta.changes) || 0;
    }

    const pend = (await env.DB.prepare(
      `SELECT event_id, player, market, game, commence, season, week FROM nfl_proj
        WHERE graded_at IS NULL AND commence IS NOT NULL AND commence < ? ORDER BY commence`
    ).bind(cutoff).all()).results || [];
    out.pending = pend.length;
    if (!pend.length) { out.note += ' (nothing pending)'; return cors(json(out, 30)); }

    // Full team names, not abbreviations. ESPN and nflverse disagree on several
    // codes (LA/LAR, WAS/WSH), and a silent abbreviation mismatch would look
    // exactly like a game nobody played.
    const evIds = [...new Set(pend.map((r) => r.event_id))];
    const names = new Map();
    for (let i = 0; i < evIds.length; i += 20) {
      const chunk = evIds.slice(i, i + 20);
      const q = await env.DB.prepare(
        'SELECT DISTINCT event_id, home, away, commence, season_type FROM nfl_lines WHERE event_id IN ('
        + chunk.map(() => '?').join(',') + ')'
      ).bind(...chunk).all();
      for (const r of (q.results || [])) if (r.home && r.away) names.set(r.event_id, r);
    }

    const dayCache = new Map();
    // ESPN's NFL scoreboard ignores a date and always answers with the CURRENT
    // week, so asking by date only ever worked during Week 1: by Sep 30 every
    // Week 2 and 3 projection (317 rows) matched no game and none was graded.
    // Asked by season/type/week instead, the same fix gradeGamePicks carries.
    // `key` is "year|seasontype|week", or a bare yyyymmdd for a row with no week.
    const scoreboard = async (key) => {
      if (dayCache.has(key)) return dayCache.get(key);
      let d = null;
      const [yr, st, wk] = String(key).split('|');
      const q = wk ? `year=${yr}&seasontype=${st}&week=${wk}` : `dates=${key}`;
      try {
        // A User-Agent is sent deliberately. ESPN serves this endpoint happily to
        // a browser and can refuse a datacenter request that arrives without one,
        // which is invisible from a laptop and total from a Worker.
        const r = await fetch(`${ESPN_CDN}/scoreboard?xhr=1&${q}`,
          { headers: { accept: 'application/json', 'user-agent': ESPN_UA } });
        // A non-OK response used to set nothing and record nothing, so an ESPN
        // refusal came back as "no ESPN event matched" -- indistinguishable from
        // a game that was never played. Status is captured either way.
        if (r.ok) d = await r.json();
        else out.errors.push(`scoreboard ${key}: HTTP ${r.status}`);
      } catch (e) { out.errors.push('scoreboard ' + key + ': ' + String((e && e.message) || e)); }
      dayCache.set(key, d);
      return d;
    };

    const stmts = [];
    const byEvent = {};
    for (const r of pend) (byEvent[r.event_id] = byEvent[r.event_id] || []).push(r);

    for (const [evId, rows] of Object.entries(byEvent)) {
      const meta = names.get(evId);
      if (!meta) { out.unmatched.push({ event: evId, why: 'no nfl_lines row to read team names from' }); continue; }
      // Kickoff is stored in UTC; a Sunday 13:00 ET game is already the next day
      // in UTC for late windows, so both days are tried rather than assuming.
      const t = Date.parse(meta.commence || rows[0].commence);
      const wk = rows[0].week;
      const days = wk != null
        ? [`${rows[0].season || new Date(t).getUTCFullYear()}|${String(meta.season_type || 'REG').toUpperCase() === 'PRE' ? 1 : 2}|${wk}`]
        : [new Date(t), new Date(t - 864e5)].map((d) => d.toISOString().slice(0, 10).replace(/-/g, ''));
      let espnId = null, final = false;
      for (const day of days) {
        const sb = await scoreboard(day);
        // The CDN nests the scoreboard under content.sbData; the bare .events
        // shape is kept as a fallback so a future host swap does not silently
        // grade nothing.
        const evs = (sb && sb.content && sb.content.sbData && sb.content.sbData.events)
          || (sb && sb.events) || [];
        for (const e of evs) {
          const comp = (e.competitions || [])[0] || {};
          const nm = (comp.competitors || []).map((c) => (c.team || {}).displayName);
          if (nm.includes(meta.home) && nm.includes(meta.away)) {
            espnId = e.id;
            final = (((comp.status || {}).type || {}).name) === 'STATUS_FINAL';
          }
        }
        if (espnId) break;
      }
      if (!espnId) { out.unmatched.push({ event: evId, game: `${meta.away} @ ${meta.home}`, why: 'no ESPN event matched' }); continue; }
      // Not final yet: leave it pending rather than grading a partial line.
      if (!final) { out.unmatched.push({ event: evId, game: `${meta.away} @ ${meta.home}`, why: 'not final yet' }); continue; }
      out.events++;

      let sum;
      try {
        const r = await fetch(`${ESPN_CDN}/boxscore?xhr=1&gameId=${espnId}`,
          { headers: { accept: 'application/json', 'user-agent': ESPN_UA } });
        if (!r.ok) { out.errors.push(`boxscore ${espnId}: HTTP ${r.status}`); continue; }
        sum = await r.json();
      } catch (e) { out.errors.push(`summary ${espnId}: ${String((e && e.message) || e)}`); continue; }

      // yardsBy[market][normName] = yards ; played = every name in the box score
      const yardsBy = { receiving: {}, rushing: {} };
      const played = new Set();
      // base name -> the full names that reduce to it. A set, because one athlete
      // appears in several stat categories and must count once; more than one
      // entry means two players share the base name and the fallback refuses.
      const byBase = {};
      const box = (sum.gamepackageJSON && sum.gamepackageJSON.boxscore) || sum.boxscore || {};
      for (const team of (box.players || [])) {
        for (const cat of (team.statistics || [])) {
          const labels = (cat.labels || []).map((l) => String(l).toUpperCase());
          const yi = labels.indexOf('YDS');
          for (const a of (cat.athletes || [])) {
            const display = ((a.athlete || {}).displayName) || '';
            const nm = normName(display);
            if (!nm) continue;
            played.add(nm);
            (byBase[nflBaseName(display)] = byBase[nflBaseName(display)] || new Set()).add(nm);
            const bucket = yardsBy[cat.name];
            if (!bucket || yi < 0) continue;
            const v = Number((a.stats || [])[yi]);
            if (Number.isFinite(v)) bucket[nm] = v;
          }
        }
      }

      const stamp = new Date().toISOString();
      for (const row of rows) {
        const bucket = yardsBy[row.market];
        let nm = normName(row.player);
        if (!played.has(nm)) {
          const same = byBase[nflBaseName(row.player)];
          if (same && same.size === 1) { nm = [...same][0]; out.matchedBySuffix = (out.matchedBySuffix || 0) + 1; }
        }
        let actual = null;
        if (bucket && Object.prototype.hasOwnProperty.call(bucket, nm)) actual = bucket[nm];
        else if (played.has(nm)) actual = 0;   // dressed, recorded nothing in this market
        // else: absent from the whole box score -> DNP, actual stays NULL
        if (actual == null) out.dnp++; else out.graded++;
        stmts.push(env.DB.prepare(
          'UPDATE nfl_proj SET actual=?, graded_at=? WHERE event_id=? AND player=? AND market=? AND graded_at IS NULL'
        ).bind(actual, stamp, row.event_id, row.player, row.market));
      }
    }

    for (let i = 0; i < stmts.length; i += 50) {
      try { await env.DB.batch(stmts.slice(i, i + 50)); }
      catch (e) { out.errors.push('write: ' + String((e && e.message) || e)); }
    }
  } catch (e) { out.error = String((e && e.message) || e); }
  return cors(json(out, 30));
}
async function nflCompare(env, url) {
  const out = {
    note: 'frozen projection vs the captured market line — NOT a price. No fair line, no edge, no tier, nothing posted.',
    gapMeans: 'proj minus line, in yards. A model/market disagreement, not value.',
    rows: [], games: 0,
  };
  if (!env || !env.DB) { out.error = 'no DB binding'; return cors(json(out, 60)); }
  try {
    await ensureNflSchema(env.DB);
    const all = url && url.searchParams && url.searchParams.get('all') === '1';
    const nowIso = new Date().toISOString();
    const projs = (await env.DB.prepare(
      `SELECT event_id, player, market, team, pos, game, commence, proj, p25, p50, p75, conf, actual, captured_at
         FROM nfl_proj WHERE season=2026 ${all ? '' : 'AND commence > ?'} ORDER BY commence, proj DESC`
    ).bind(...(all ? [] : [nowIso])).all()).results || [];
    if (!projs.length) { out.note += ' (no frozen projections for upcoming games — run /api/nfl-capture)'; return cors(json(out, 60)); }

    const eventIds = [...new Set(projs.map((r) => r.event_id))];
    out.games = eventIds.length;

    // Latest quote per (event, market, player, point, book). captured_at is in
    // the primary key so the table holds the full move history; only the most
    // recent snapshot is the current line.
    const latest = new Map();
    for (let i = 0; i < eventIds.length; i += 20) {
      const chunk = eventIds.slice(i, i + 20);
      const q = await env.DB.prepare(
        'SELECT event_id, market, player, point, book, over, under, captured_at FROM nfl_lines'
        + ' WHERE event_id IN (' + chunk.map(() => '?').join(',') + ')'
        + " AND market IN ('player_reception_yds','player_rush_yds')"
      ).bind(...chunk).all();
      for (const r of (q.results || [])) {
        const k = `${r.event_id}|${r.market}|${r.player}|${r.point}|${r.book}`;
        const prev = latest.get(k);
        if (!prev || String(prev.captured_at) < String(r.captured_at)) latest.set(k, r);
      }
    }
    // Regroup by (event, market, player) so each player's book quotes sit together.
    const byPlayer = new Map();
    for (const r of latest.values()) {
      // normName is what the MLB prop matching uses, so a feed spelling like
      // "A.J. Brown" joins the priors' "AJ Brown" instead of silently missing.
      const k = `${r.event_id}|${r.market}|${normName(r.player)}`;
      let bucket = byPlayer.get(k);
      if (!bucket) { bucket = []; byPlayer.set(k, bucket); }
      bucket.push(r);
    }

    for (const p of projs) {
      const oddsMkt = NFL_PROJ_TO_ODDS[p.market];
      const allQuotes = oddsMkt ? (byPlayer.get(`${p.event_id}|${oddsMkt}|${normName(p.player)}`) || []) : [];
      // PrizePicks hangs its own number and pays by entry type, not by price, so
      // it is carried beside the line and never counted in it: one vote for its
      // number in the "most books agree" line would let it move the line it is
      // being compared against.
      const ppQuotes = allQuotes.filter((q) => q.book === 'prizepicks');
      const quotes = allQuotes.filter((q) => q.book !== 'prizepicks');
      // How far ahead of kickoff this projection was locked. The freeze is
      // INSERT OR IGNORE on (season, event_id, player, market), so the FIRST
      // capture to see a game owns its projection for the rest of the season --
      // and the capture horizon is 10 days. Without this field there is no way
      // to tell a number frozen the morning of the game from one frozen a week
      // out on nothing but last season's priors, and the grader treats them
      // identically.
      const leadH = (p.captured_at && p.commence)
        ? Math.round((Date.parse(p.commence) - Date.parse(p.captured_at)) / 36e5 * 10) / 10
        : null;
      const row = {
        player: p.player, pos: p.pos, team: p.team, game: p.game, commence: p.commence,
        market: p.market, proj: p.proj, p25: p.p25, p50: p.p50, p75: p.p75, conf: p.conf,
        actual: p.actual, frozenAt: p.captured_at || null, frozenLeadHours: leadH,
      };
      // PrizePicks' current number: its latest capture, and of that capture the
      // point nearest the books' line when it hangs more than one.
      const ppLineNear = (ref) => {
        if (!ppQuotes.length) return null;
        const last = ppQuotes.reduce((m, q) => (String(q.captured_at) > m ? String(q.captured_at) : m), '');
        const cur = ppQuotes.filter((q) => String(q.captured_at) === last).map((q) => Number(q.point)).filter(Number.isFinite);
        if (!cur.length) return null;
        return ref == null ? cur.sort((a, b) => a - b)[0] : cur.sort((a, b) => Math.abs(a - ref) - Math.abs(b - ref) || a - b)[0];
      };
      if (!quotes.length) {
        // Named explicitly rather than left null: "no book quoted him" and "the
        // capture missed him" are different problems and only one is ours.
        row.line = null; row.lineStatus = 'no captured quote for this player/market';
        row.ppLine = ppLineNear(null);
        out.rows.push(row); continue;
      }
      // The main line is the point the most books agree on. Taking the first
      // book's number instead would let one outlier alternate line stand in for
      // the market.
      const byPoint = {};
      for (const q of quotes) byPoint[q.point] = (byPoint[q.point] || 0) + 1;
      const line = Number(Object.keys(byPoint).sort((a, b) => byPoint[b] - byPoint[a] || Number(a) - Number(b))[0]);
      const atLine = quotes.filter((q) => Number(q.point) === line);
      const best = (side) => {
        let price = null, book = null;
        for (const q of atLine) {
          if (!NFL_EXEC.includes(q.book)) continue;
          const v = q[side];
          if (typeof v !== 'number') continue;
          if (price == null || payoutMult(v) > payoutMult(price)) { price = v; book = q.book; }
        }
        return { price, book };
      };
      const o = best('over'), u = best('under');
      const sharp = [...new Set(atLine.filter((q) => NFL_PROPS_SHARP.includes(q.book)
        && typeof q.over === 'number' && typeof q.under === 'number').map((q) => q.book))];
      row.line = line;
      row.ppLine = ppLineNear(line);
      row.gap = round1(p.proj - line);
      row.overPrice = o.price; row.overBook = o.book;
      row.underPrice = u.price; row.underBook = u.book;
      row.books = atLine.length;
      row.sharpN = sharp.length;
      row.sharpBooks = sharp;
      // Whether a fair line COULD be built here under the two-book rule. Not
      // whether one was — none is.
      row.priceable = sharp.length >= 2;
      out.rows.push(row);
    }
    const withLine = out.rows.filter((r) => r.line != null);
    out.summary = {
      projections: out.rows.length,
      matchedToALine: withLine.length,
      priceableUnderTwoBookRule: withLine.filter((r) => r.priceable).length,
      note: 'matchedToALine < projections usually means the book has not quoted that player, not that the capture failed',
    };

    // The verdict block. Once rows are graded this settles the question the gap
    // alone cannot: the model sits ~3.4 yards above the market on average, and
    // that is either the model running hot or the market shading lines below the
    // mean. Whichever predicts the ACTUAL better is the one telling the truth.
    //
    // modelMae vs lineMae is the whole test. If the line predicts outcomes more
    // accurately than the projection does, the gap is model error and there is
    // nothing to bet. Only if the model wins is the disagreement worth pricing.
    //
    // underMeanRate is the number the backtest reported (58.9-61.8%).
    // underLineRate is the one that would actually pay. They are not the same
    // statistic and the difference between them is exactly the bias above.
    const g = withLine.filter((r) => typeof r.actual === 'number');
    if (g.length) {
      const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
      const mae = (f) => mean(g.map((r) => Math.abs(f(r) - r.actual)));
      out.graded = {
        n: g.length,
        meanActual: round1(mean(g.map((r) => r.actual))),
        meanProj: round1(mean(g.map((r) => r.proj))),
        meanLine: round1(mean(g.map((r) => r.line))),
        modelMae: round1(mae((r) => r.proj)),
        lineMae: round1(mae((r) => r.line)),
        underMeanRate: round1(g.filter((r) => r.actual < r.proj).length / g.length * 100),
        underLineRate: round1(g.filter((r) => r.actual < r.line).length / g.length * 100),
        read: 'modelMae < lineMae = the projection beats the market and the gap is worth pricing. '
          + 'modelMae > lineMae = the model runs hot and the gap is its own error. '
          + 'underMeanRate is what the backtest measured; underLineRate is what would actually pay.',
      };
      out.graded.verdict = out.graded.modelMae < out.graded.lineMae
        ? 'model predicts actuals better than the line — gap may be real'
        : 'the LINE predicts actuals better than the model — the gap is model error, do not price it';
    }
    // PrizePicks' number, graded (captured since 2026-10-06). Its under wins
    // below ITS number, and the split asks whether it wins more often where
    // that number sits above the books' line. No model involved: the verdict
    // above says the model loses to the line, so this is the other angle.
    const ppG = out.rows.filter((r) => typeof r.actual === 'number' && r.ppLine != null);
    if (ppG.length) {
      out.ppGraded = {
        ...ppSplitRecord(ppG.map((r) => ({
          p: null, won: r.actual < r.ppLine ? 1 : (r.actual > r.ppLine ? 0 : null),
          gap: r.line != null ? round1(r.ppLine - r.line) : null,
        }))),
        read: "hit = PrizePicks unders that landed below PrizePicks' number. byLineGap.ppHigher = its number sat above the books' line, so its under was easier than the market's.",
      };
    }
  } catch (e) { out.error = String((e && e.message) || e); }
  // ?summary=1 keeps the counts, the summary and the `graded` verdict and drops
  // the per-row detail. The full response runs past 100KB with ?all=1, far more
  // than a scheduled run can read inline, and `graded` — the one block it exists
  // to report — sits at the very end of it. The Week 1 capture run stalled
  // exactly there, writing a script to parse a response it could not read.
  if (url && url.searchParams && url.searchParams.get('summary') === '1') {
    out.rowCount = out.rows.length;
    // The scheduled pre-kickoff check reads this form too, and the one list it
    // reports is the largest projection/line disagreements for the upcoming
    // games -- so those ride along, trimmed to the fields it reads. Played
    // games (?all=1) are the grading run's business and get the verdict alone.
    if (url.searchParams.get('all') !== '1') {
      out.biggestGaps = out.rows.filter((r) => r.line != null && r.gap != null)
        .sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap)).slice(0, NFL_GAPS_TOP)
        .map((r) => ({ player: r.player, team: r.team, game: r.game, market: r.market,
          proj: r.proj, line: r.line, ppLine: r.ppLine == null ? null : r.ppLine, gap: r.gap, conf: r.conf }));
    }
    delete out.rows;
  }
  return cors(json(out, 60));
}
const NFL_GAPS_TOP = 20;

// Split so the projection endpoint can reuse the same slate without re-querying
// D1 or re-deriving fair from scratch. nflBoard is now only the response wrapper.
async function nflBoardData(env, url) {
  const out = { seasonType: null, games: [], empty: true, asOf: null };
  if (!env || !env.DB) { out.error = 'no DB binding'; return out; }
  const want = (url && url.searchParams && url.searchParams.get('type')) || null;
  try {
    await ensureNflSchema(env.DB);
    await nflSchedule(env);
    // Prefer the regular season once it has lines; fall back to preseason so the
    // board is never blank just because Week 1 has not been ingested yet.
    let type = want;
    if (!type) {
      // Whether one exists, not how many: a COUNT read every upcoming quote,
      // props and all, to answer a yes or no (2026-10-23).
      const reg = await env.DB.prepare(
        "SELECT 1 AS n FROM nfl_lines WHERE season_type='REG' AND commence > ? LIMIT 1"
      ).bind(new Date().toISOString()).first();
      type = reg ? 'REG' : 'PRE';
    }
    out.seasonType = type;

    const rows = (await env.DB.prepare(
      `SELECT event_id, commence, home, away, market, player, point, book, over, under, captured_at, week
         FROM nfl_lines WHERE season_type = ? AND commence > ?
        ORDER BY captured_at ASC`
    ).bind(type, new Date(Date.now() - 6 * 3600e3).toISOString()).all()).results || [];

    // Latest value per (event, market, selection, book). Rows are append-on-
    // change, so the last one seen in captured_at order is current.
    const latest = new Map();
    let asOf = null;
    for (const r of rows) {
      const k = `${r.event_id}|${r.market}|${r.player == null ? '' : r.player}|${r.book}`;
      latest.set(k, r);
      if (!asOf || String(r.captured_at) > String(asOf)) asOf = r.captured_at;
    }
    out.asOf = asOf;

    const games = new Map();
    for (const r of latest.values()) {
      const g = games.get(r.event_id) || games.set(r.event_id, {
        id: r.event_id, home: r.home, away: r.away, commence: r.commence,
        week: r.week, h2h: {}, spreads: {}, totals: {},
      }).get(r.event_id);
      if (r.market === 'h2h') (g.h2h[r.player] = g.h2h[r.player] || {})[r.book] = r.over;
      else if (r.market === 'spreads') (g.spreads[r.player] = g.spreads[r.player] || {})[r.book] = { price: r.over, point: r.point };
      else if (r.market === 'totals') g.totals[r.book] = { point: r.point, over: r.over, under: r.under };
    }

    const sched = NFL_SCHED && NFL_SCHED.games ? NFL_SCHED.games : [];
    for (const g of games.values()) {
      const teams = Object.keys(g.h2h);
      if (teams.length !== 2) continue;   // a half-quoted game is not a board row
      const [a, b] = g.away && teams.includes(g.away) ? [g.away, teams.find((t) => t !== g.away)] : teams;

      // Every book's no-vig chance of team a; the sharp ones make the fair
      // (sharpFair, 2026-10-27): Pinnacle's when it quotes, else two or more of
      // the rest, BetOnline and LowVig as one.
      const byBook = {};
      for (const bk of new Set([...Object.keys(g.h2h[a] || {}), ...Object.keys(g.h2h[b] || {})])) {
        const pa = g.h2h[a] && g.h2h[a][bk];
        const pb = g.h2h[b] && g.h2h[b][bk];
        if (typeof pa !== 'number' || typeof pb !== 'number') continue;
        const f = shinDevig(pa, pb);
        if (f != null && isFinite(f)) byBook[bk] = f;
      }
      const usedBooks = NFL_GAMELINE_POOL.filter((bk) => byBook[bk] != null);
      const sf = sharpFair(Object.fromEntries(usedBooks.map((bk) => [bk, byBook[bk]])));
      const sharpN = sf.n;
      const fair = sf.fair;
      const fairSrc = sf.src === 'sharp-pool' ? 'gameline-pool' : sf.src;

      // Best available price per side across execution books, book-attributed.
      const best = (team) => {
        let bp = null, bb = null;
        for (const bk of NFL_EXEC) {
          const p = g.h2h[team] && g.h2h[team][bk];
          if (typeof p !== 'number') continue;
          if (bp == null || amProb(p) < amProb(bp)) { bp = p; bb = bk; }
        }
        return { price: bp, book: bb };
      };
      const bestA = best(a), bestB = best(b);

      // Consensus spread and total, medianed across every book that quoted.
      const spreadOf = (team) => {
        const pts = Object.values(g.spreads[team] || {}).map((x) => x.point).filter((x) => x != null);
        return pts.length ? median(pts) : null;
      };
      const sA = spreadOf(a), sB = spreadOf(b);
      const totPts = Object.values(g.totals).map((x) => x.point).filter((x) => x != null);
      const total = totPts.length ? median(totPts) : null;
      // Implied team total: half the game total, shifted by half the spread.
      const impl = (sp) => (total != null && sp != null) ? Math.round((total / 2 - sp / 2) * 10) / 10 : null;

      // Moneyline read, in the same shape the MLB board uses: which side, at what
      // price, and how far our fair sits above what that price implies. Value is
      // fair-minus-implied in probability points -- the sharp pool's number
      // against the softest execution price, never against itself.
      let pickTeam = null, pickPrice = null, pickBook = null, pickFair = null, pickValue = null, pickImplied = null;
      if (fair != null) {
        const awayFair = fair, homeFair = 1 - fair;
        const takeAway = awayFair >= homeFair;
        pickTeam = takeAway ? nflAbbr(a) : nflAbbr(b);
        pickFair = takeAway ? awayFair : homeFair;
        const bp = takeAway ? bestA : bestB;
        pickPrice = bp.price; pickBook = bp.book;
        const imp = amProb(pickPrice);
        if (imp != null && isFinite(imp)) {
          pickImplied = Math.round(imp * 1000) / 10;
          pickValue = Math.round((pickFair - imp) * 1000) / 10;
        }
      }

      const sg = sched.find((x) => x.id && g.commence
        && Math.abs(Date.parse(`${x.d}T${x.t}:00Z`) - Date.parse(g.commence)) < 36 * 3600e3);

      out.games.push({
        id: g.id, away: nflAbbr(a), home: nflAbbr(b), awayFull: a, homeFull: b,
        commence: g.commence, week: g.week,
        standalone: sg ? !!sg.standalone : null,
        roof: sg ? sg.roof : null,
        fairSrc, sharpN, fairBooks: usedBooks, byBookA: byBook,
        away_fair: fair != null ? Math.round(fair * 1000) / 10 : null,
        home_fair: fair != null ? Math.round((1 - fair) * 1000) / 10 : null,
        away_price: bestA.price, away_book: bestA.book,
        home_price: bestB.price, home_book: bestB.book,
        away_spread: sA, home_spread: sB, total,
        away_implied: impl(sA), home_implied: impl(sB),
        pickTeam, pickPrice, pickBook,
        pickFair: pickFair != null ? Math.round(pickFair * 1000) / 10 : null,
        pickImplied, pickValue,
        books: new Set([...Object.keys(g.h2h[a] || {}), ...Object.keys(g.h2h[b] || {})]).size,
      });
    }
    out.games.sort((x, y) => Date.parse(x.commence || 0) - Date.parse(y.commence || 0));
    // ONE slate day, not the whole week (2026-09-17). The board carried every
    // remaining game of the week, so a Thursday showed the Thursday game plus
    // thirteen Sunday ones — and /api/nfl-props builds its player rows from this
    // list, so it projected a week of players at once. The NFL week is three
    // distinct slates (Thu, Sun, Mon) that are read on the day they are played.
    //
    // The day is taken from the EARLIEST remaining kickoff rather than from the
    // clock, so an off day rolls forward to the next slate instead of showing an
    // empty board, and a Sunday still shows Sunday's games all day. Pacific time,
    // like every other date in this file.
    const firstUp = out.games.find((g) => g.commence);
    if (firstUp) {
      out.slateDay = ptDateOf(Date.parse(firstUp.commence));
      out.gamesAllUpcoming = out.games.length;
      out.games = out.games.filter((g) => g.commence && ptDateOf(Date.parse(g.commence)) === out.slateDay);
      out.slateNote = `one slate day only: ${out.slateDay} (${out.games.length} of ${out.gamesAllUpcoming} upcoming games this season type)`;
    }
    out.empty = out.games.length === 0;
    out.postable = 0;   // no player props on the wire -> nothing is postable yet
    // Keep the record. Only games that have not kicked off, only ones with a
    // real fair line behind them, and only the side the board is leading with.
    try {
      const pre = out.games.filter((g) => g.pickTeam && g.pickPrice != null && g.pickFair != null
        && g.fairSrc !== 'MKT' && Date.parse(g.commence || 0) > Date.now());
      if (pre.length) {
        await logGamePicks(env.DB, 'nfl', out.slateDay || ptDateOf(Date.now()), pre.map((g) => ({
          game_id: g.id, league: out.seasonType, week: g.week, commence: g.commence,
          side: g.pickTeam === g.home ? 'home' : 'away', pick: g.pickTeam,
          home: g.home, away: g.away,
          win_prob: g.pickFair, implied: g.pickImplied, edge: g.pickValue,
          price: g.pickPrice, book: g.pickBook, fair_src: g.fairSrc, sharp_n: g.sharpN,
          // byBookA is each book's chance of the away side (team a).
          book_fairs: bookFairsJson(Object.fromEntries(Object.entries(g.byBookA || {}).map(([bk, p]) => [bk, g.pickTeam === g.away ? p : 1 - p]))),
        })));
      }
    } catch (e) { /* logging never breaks the board */ }
    // The board in the NBA and NHL tabs' shape (2026-10-25): each club's mark,
    // and, for the page, the log's record with its 65%+ favourites first --
    // the bar NFL moneylines are listed on Picks of the day at. The cron's own
    // reads (no url) skip the record.
    for (const g of out.games) { g.homeLogo = moneylineLogo('nfl', g.home); g.awayLogo = moneylineLogo('nfl', g.away); }
    if (url) {
      try {
        const rec = buildGmRecord(((await env.DB.prepare("SELECT * FROM gmpicks WHERE sport = 'nfl'").all()).results) || [], 'nfl');
        out.record = { logged: rec.logged, pending: rec.pending, n: rec.n, record: rec.record, winRate: rec.winRate, byBand: rec.byBand, bar: rec.bar };
      } catch (e) { /* no log yet */ }
    }
  } catch (e) { out.error = String((e && e.message) || e); }
  return out;
}

async function nflBoard(env, url) {
  return cors(json(await nflBoardData(env, url), 60));
}

// Slate as a plain array, with seasonType carried alongside.
async function nflBoardGames(env, url) {
  const d = await nflBoardData(env, url);
  const arr = Array.isArray(d.games) ? d.games : [];
  arr.seasonType = d.seasonType;
  return arr;
}

// GET /api/be-gate — would a break-even gate have improved the graded record?
//
// The board tiers on `edge`, which is model-minus-fair in probability points. It
// says nothing about the price actually paid, so a row can carry a healthy edge
// and still be a losing bet: on 2026-08-14 the T2 play was +5.1 edge at -179,
// needing 64.2% while the model gave it 51.4%.
//
// This asks the only question that decides whether that matters: over the rows
// already graded, does dropping every pick whose model probability sits below
// its break-even improve ROI? It changes nothing and writes nothing.
//
// Units are reported rather than assumed. model_over is stored as a PERCENT and
// entry_over as a FRACTION, which is exactly the kind of asymmetry that silently
// produces a confident wrong answer.
function bePayout(am) { return am > 0 ? am / 100 : 100 / (-am); }
function beProb(am) { return am > 0 ? 100 / (am + 100) : (-am) / ((-am) + 100); }

async function beGate(env, url) {
  const out = { question: 'Does gating on model >= break-even improve the graded record?' };
  if (!env || !env.DB) { out.error = 'no DB binding'; return cors(json(out, 60)); }
  try {
    await ensureBatterSchema(env.DB);
    const era = (url && url.searchParams && url.searchParams.get('era')) || BATTER_MODEL_VER;
    out.era = era;
    const rows = (await env.DB.prepare(
      `SELECT player, market, line, side, price, proj, model_over, entry_over, edge, tier, result, date
         FROM bpicks
        WHERE result IN ('win','loss') AND model_over IS NOT NULL AND price IS NOT NULL
          AND (model_ver = ? OR ? = 'all')`
    ).bind(era, era).all()).results || [];
    out.graded = rows.length;
    if (!rows.length) { out.note = 'no graded rows in this era'; return cors(json(out, 60)); }

    // Unit check, printed so a reader can see the assumption is tested.
    const mo = rows.map((r) => r.model_over).filter((x) => x != null);
    const eo = rows.map((r) => r.entry_over).filter((x) => x != null);
    out.units = {
      model_over: { min: round1(Math.min(...mo)), max: round1(Math.max(...mo)),
        reading: Math.max(...mo) > 1.5 ? 'percent' : 'fraction' },
      entry_over: eo.length ? { min: Math.round(Math.min(...eo) * 1e4) / 1e4,
        max: Math.round(Math.max(...eo) * 1e4) / 1e4,
        reading: Math.max(...eo) > 1.5 ? 'percent' : 'fraction' } : null,
    };
    // If model_over is ever stored as a fraction the arithmetic below is wrong,
    // so refuse rather than report a confident wrong number.
    if (out.units.model_over.reading !== 'percent') {
      out.error = 'model_over is not in percent; aborting rather than guessing';
      return cors(json(out, 60));
    }

    const scored = rows.map((r) => {
      const modelPick = (r.side === 'Under' ? 100 - r.model_over : r.model_over) / 100;
      const be = beProb(r.price);
      const w = bePayout(r.price);
      const won = r.result === 'win';
      return {
        ...r,
        modelPick, be, ev: modelPick * w - (1 - modelPick),
        profit: won ? w : -1, won,
        passes: modelPick >= be,
      };
    });

    const summarise = (set, label) => {
      const n = set.length;
      if (!n) return { label, n: 0 };
      const wins = set.filter((s) => s.won).length;
      const units = set.reduce((a, s) => a + s.profit, 0);
      const roi = units / n;
      // Per-pick variance of the profit series, so the SE reflects mixed prices
      // rather than assuming every bet is even money.
      const mean = roi;
      const varr = set.reduce((a, s) => a + (s.profit - mean) ** 2, 0) / Math.max(1, n - 1);
      const se = Math.sqrt(varr / n);
      const z = se > 0 ? roi / se : 0;
      // Two-sided normal tail.
      const p = 2 * (1 - 0.5 * (1 + erfApprox(Math.abs(z) / Math.SQRT2)));
      return {
        label, n, wins, winRate: round1((wins / n) * 100),
        units: Math.round(units * 100) / 100,
        roiPct: round1(roi * 100),
        se: round1(se * 100), z: round1(z), p: Math.round(p * 1e4) / 1e4,
        significant: p < 0.05,
      };
    };

    out.all = summarise(scored, 'every graded pick');
    out.gated = summarise(scored.filter((s) => s.passes), 'model >= break-even');
    out.dropped = summarise(scored.filter((s) => !s.passes), 'dropped by the gate');
    out.keptPct = round1((scored.filter((s) => s.passes).length / scored.length) * 100);

    // Does the gate help inside each tier, or only by reshuffling which tiers
    // survive? A gate that merely drops T3 is not the same finding.
    const byTier = {};
    for (const t of ['1', '2', '3', 'pass']) {
      const set = scored.filter((s) => String(s.tier) === t);
      if (!set.length) continue;
      byTier[t] = {
        all: summarise(set, 'all'),
        gated: summarise(set.filter((s) => s.passes), 'gated'),
      };
    }
    out.byTier = byTier;

    // Ranking check: if EV ranks better than edge, that is the actionable part.
    const decile = (key) => {
      const sorted = [...scored].sort((a, b) => b[key] - a[key]);
      const cut = Math.max(1, Math.floor(sorted.length / 5));
      return { top: summarise(sorted.slice(0, cut), `top fifth by ${key}`),
        bottom: summarise(sorted.slice(-cut), `bottom fifth by ${key}`) };
    };

    // ---------------------------------------------------------------------
    // EV buckets — the basis for retiering
    // ---------------------------------------------------------------------
    // Tiers currently cut on `edge` (model minus fair, in probability points),
    // which says nothing about the price actually paid. This reports ROI by EV
    // band so a cutoff can be read off the graded record instead of invented.
    //
    // Reported at a fixed grid rather than as quantiles: quantile cuts move with
    // the sample and would need re-deriving every time the record grows, while a
    // fixed grid can be compared across eras.
    const evGrid = [-0.20, -0.10, -0.05, -0.02, 0, 0.02, 0.05, 0.10, 0.20];
    const bandOf = (ev) => {
      for (let i = 0; i < evGrid.length; i++) if (ev < evGrid[i]) return i;
      return evGrid.length;
    };
    const bands = {};
    for (const s of scored) {
      const k = bandOf(s.ev);
      (bands[k] = bands[k] || []).push(s);
    }
    out.evBands = Object.keys(bands).sort((a, b) => a - b).map((k) => {
      const i = +k;
      const lo = i === 0 ? null : evGrid[i - 1];
      const hi = i === evGrid.length ? null : evGrid[i];
      const set = bands[k];
      const s = summarise(set, `EV ${lo == null ? '<' + (hi * 100).toFixed(0) : (hi == null ? '>=' + (lo * 100).toFixed(0) : (lo * 100).toFixed(0) + '..' + (hi * 100).toFixed(0))}%`);
      return s;
    });

    // Monotonicity is the question that decides whether EV can carry a tier at
    // all: does ROI actually rise with EV? A metric that ranks but does not
    // order is no better than the one being replaced.
    const ordered = out.evBands.filter((b) => b.n >= 50);
    let rises = 0, falls = 0;
    for (let i = 1; i < ordered.length; i++) {
      if (ordered[i].roiPct > ordered[i - 1].roiPct) rises++; else falls++;
    }
    out.evMonotonicity = { bandsWith50Plus: ordered.length, rises, falls,
      verdict: rises > falls ? 'ROI generally rises with EV' : 'no reliable ordering' };

    // Candidate cutoffs, evaluated as a tier set rather than one at a time.
    // Reported for several thresholds so the choice is visible, not smuggled in.
    out.evCutoffCandidates = [[0.04, 0.02, 0.00], [0.05, 0.02, 0.00], [0.03, 0.015, 0.00], [0.06, 0.03, 0.01]]
      .map((cuts) => {
        const tierOf = (ev) => ev >= cuts[0] ? 1 : ev >= cuts[1] ? 2 : ev >= cuts[2] ? 3 : 'pass';
        const byT = {};
        for (const s of scored) (byT[tierOf(s.ev)] = byT[tierOf(s.ev)] || []).push(s);
        const t = (k) => summarise(byT[k] || [], 'T' + k);
        const t1 = t(1), t2 = t(2), t3 = t(3), tp = t('pass');
        const played = [...(byT[1] || []), ...(byT[2] || []), ...(byT[3] || [])];
        return {
          cuts, t1, t2, t3, pass: tp,
          played: summarise(played, 'all tiered'),
          // The property the current edge tiers lack: T1 better than T2 better than T3.
          monotone: (t1.n && t2.n && t3.n) ? (t1.roiPct >= t2.roiPct && t2.roiPct >= t3.roiPct) : null,
        };
      });

    out.rankedByEdge = decile('edge');
    out.rankedByEv = decile('ev');

    out.verdict = (() => {
      const a = out.all, g = out.gated;
      if (!g.n || g.n < 100) return 'INCONCLUSIVE — too few rows survive the gate to judge';
      const lift = g.roiPct - a.roiPct;
      if (g.significant && g.roiPct > 0) return `GATE HELPS — gated ROI ${g.roiPct}% is significant (p=${g.p})`;
      if (lift > 0 && !g.significant) return `DIRECTIONAL ONLY — gate lifts ROI ${round1(lift)}pts but the result is not significant (p=${g.p})`;
      if (lift <= 0) return `GATE DOES NOT HELP — ROI moves ${round1(lift)}pts`;
      return 'INCONCLUSIVE';
    })();
  } catch (e) { out.error = String((e && e.message) || e); }
  return cors(json(out, 60));
}

// Abramowitz & Stegun 7.1.26 — enough precision for a p-value read to 4dp.
function erfApprox(x) {
  const s = x < 0 ? -1 : 1; x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const poly = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  return s * (1 - poly * Math.exp(-x * x));
}

// ---------------------------------------------------------------------------
// NFL yardage projections
// ---------------------------------------------------------------------------
// Receiving and rushing only. Passing is deliberately absent: backtested over
// 2024 and 2025 it never once cleared 50% on "actual below projected mean"
// (42.0% and 49.5%), because passing yards sum roughly twenty completions and
// the central limit theorem flattens the right skew the whole thesis rests on.
// A market that fails its own premise in both seasons does not get posted.
//
// Everything cascades from the two market numbers, same as the backtest:
//   spread + total -> plays -> pass/run split -> opportunity share
//   -> efficiency -> simulated stat line
//
// Constants below are the backtested ones. EFF_CAL is the only calibration and
// it is earned: the trailing efficiency prior read ~5% low in BOTH seasons.
const NFL_EFF_CAL = { receiving: 1.05, rushing: 1.05 };
const NFL_REC_DISP = 1.35;      // variance/mean on receptions
const NFL_RUSH_DISP = 2.6;      // carries swing on game script far more
const NFL_RUSH_SHIFT = 3;       // a carry can lose yards; gamma cannot go negative
const NFL_PACE_COEF = 0.006;    // plays per point of total
const NFL_SCRIPT_COEF = 0.0075; // pass rate per point of spread
const NFL_MIN_RP = 0.5;         // participation gate — RECEIVING only
const NFL_PRIOR_ELIGIBLE = new Set(['same-team', 'moved-current', 'rookie-current']);
const NFL_MIN_CARRIES = 20;     // rushing gate: volume, not routes
const NFL_DRAWS = 400;          // enough for the quantiles reported; see nflPropsCost

let NFL_PRIORS = null;
async function nflPriors(env) {
  if (NFL_PRIORS) return NFL_PRIORS;
  try {
    const r = await env.ASSETS.fetch(new Request('https://x/nfl-model-priors.json'));
    if (r.ok) NFL_PRIORS = await r.json();
  } catch (e) { /* asset missing -> no projections rather than wrong ones */ }
  return NFL_PRIORS;
}

// Deterministic RNG so the same slate renders the same numbers on every colo and
// every refresh. A projection that flickers between reloads is not a projection.
function nflRng(seed) {
  let s = seed | 0;
  return function () {
    s = s + 0x6D2B79F5 | 0;
    let t = Math.imul(s ^ s >>> 15, 1 | s);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
let nflSpare = null;
function nflGauss(rnd) {
  if (nflSpare !== null) { const v = nflSpare; nflSpare = null; return v; }
  let u, v, s;
  do { u = 2 * rnd() - 1; v = 2 * rnd() - 1; s = u * u + v * v; } while (s === 0 || s >= 1);
  const f = Math.sqrt(-2 * Math.log(s) / s); nflSpare = v * f; return u * f;
}
function nflGamma(shape, scale, rnd) {
  if (shape < 1) return nflGamma(shape + 1, scale, rnd) * Math.pow(rnd(), 1 / shape);
  const d = shape - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v;
    do { x = nflGauss(rnd); v = 1 + c * x; } while (v <= 0);
    v = v * v * v; const u = rnd();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v * scale;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v * scale;
  }
}
function nflPoisson(lam, rnd) {
  if (lam <= 0) return 0;
  if (lam < 30) { const L = Math.exp(-lam); let k = 0, p = 1; do { k++; p *= rnd(); } while (p > L); return k - 1; }
  return Math.max(0, Math.round(lam + Math.sqrt(lam) * nflGauss(rnd)));
}
function nflNegBin(m, disp, rnd) {
  if (m <= 0) return 0;
  if (disp <= 1) return nflPoisson(m, rnd);
  return nflPoisson(nflGamma(m / (disp - 1), disp - 1, rnd), rnd);
}

// Projection confidence, NOT a betting tier.
//
// With no line there is nothing to rank by value, so this ranks by how much the
// projection can be trusted: how many events the prior rests on, how stable the
// player's role is, and how tight the resulting distribution is. A reader should
// be able to use it to discount a thin projection, never to size a bet.
//
// Named `conf` rather than `tier` throughout so it cannot be mistaken for the
// MLB board's tier, which means something different and is measured against a
// price. On the MLB side tiering on edge turned out not to track profit at all;
// naming this the same thing would invite exactly that confusion.
function nflConfidence(market, p, q) {
  // Relative width of the 50% band. A projection whose middle half spans more
  // than the projection itself is not a confident number, however many carries
  // sit behind it.
  const width = q.proj > 0 ? (q.p75 - q.p25) / q.proj : 99;
  const events = market === 'receiving' ? p.recN : p.carN;
  const role = market === 'receiving' ? p.rp : p.carShare;

  const strongVol  = market === 'receiving' ? events >= 60 : events >= 150;
  const mediumVol  = market === 'receiving' ? events >= 30 : events >= 70;
  const strongRole = market === 'receiving' ? role >= 0.70 : role >= 0.45;
  const mediumRole = market === 'receiving' ? role >= 0.55 : role >= 0.28;

  if (strongVol && strongRole && width <= 1.05) return 1;
  if (mediumVol && mediumRole && width <= 1.45) return 2;
  return 3;
}

// GET /api/nfl-props — projections for the ingested slate.
// -------------------------------------------------------------------------
// Injury gate. One free fetch of nflverse's league-wide weekly report.
//
// Week 1 is the argument for it: the board projected TreVeyon Henderson for 55.3
// rushing yards and he did not play. He was listed Out with an ankle three days
// earlier. A projection for a player who will not take the field is not a weak
// projection, it is a guaranteed loss the moment anything is posted on it.
//
// Scope, stated honestly: this catches INJURY absences, not healthy scratches.
// Of week 1's three no-shows it would have caught one — Henderson — while
// Charbonnet and Boutte never appeared on a report at all. Worth having, not a
// complete solution, and it should not be described as one.
//
// Out and Doubtful gate. Questionable does NOT: most Questionable players play,
// and dropping them would throw away more signal than it saves.
const NFLVERSE_INJURIES = 'https://github.com/nflverse/nflverse-data/releases/download/injuries/injuries_2026.csv';
async function nflInjuryGate() {
  const gated = new Map();   // key -> { status, injury, player }
  try {
    const r = await fetch(NFLVERSE_INJURIES, { headers: { accept: 'text/csv' } });
    if (!r.ok) return { gated, error: `HTTP ${r.status}` };
    const text = await r.text();
    // Split on a plain newline rather than a regex literal. The CR/LF escapes
    // in one are easy to mangle when this file is edited programmatically, and
    // a broken regex throws at MODULE LOAD, taking every route down with it,
    // not just this one. trim() removes the stray carriage return.
    const lines = text.split(String.fromCharCode(10))
      .map(function (l) { return l.trim(); })
      .filter(Boolean);
    if (lines.length < 2) return { gated, error: 'empty file' };
    const cols = lines[0].split(',');
    const iWk = cols.indexOf('week'), iTm = cols.indexOf('team');
    const iNm = cols.indexOf('full_name'), iSt = cols.indexOf('report_status');
    const iInj = cols.indexOf('report_primary_injury');
    if (iWk < 0 || iTm < 0 || iNm < 0 || iSt < 0) return { gated, error: 'unexpected columns' };
    let n = 0, skew = 0;
    for (let i = 1; i < lines.length; i++) {
      const f = lines[i].split(',');
      // Split on commas with no quote handling, which the file currently allows:
      // no quoted fields, and no injury description containing a comma. If that
      // ever changes the columns shift and the wrong player gets gated, so a row
      // whose field count disagrees with the header is skipped and counted
      // rather than parsed into nonsense.
      if (f.length !== cols.length) { skew++; continue; }
      const st = (f[iSt] || '').trim();
      if (st !== 'Out' && st !== 'Doubtful') continue;
      const key = `${(f[iWk] || '').trim()}|${(f[iTm] || '').trim()}|${normName(f[iNm] || '')}`;
      gated.set(key, {
        status: st,
        injury: iInj >= 0 ? (f[iInj] || '').trim() : '',
        player: (f[iNm] || '').trim(),
      });
      n++;
    }
    return { gated, n, skew };
  } catch (e) { return { gated, error: String((e && e.message) || e) }; }
}
async function nflProps(env, url) {
  const out = { markets: ['receiving', 'rushing'], excluded: {
    passing: 'not posted — under-mean was 42.0% (2024) and 49.5% (2025); '
      + 'passing yards sum ~20 completions, so the right skew the model trades is absent',
  }, confidenceMeans: 'how much the projection can be trusted (prior size, role stability, distribution width) — NOT value, and not a betting tier', rows: [], games: 0 };
  if (!env || !env.DB) { out.error = 'no DB binding'; return cors(json(out, 120)); }
  try {
    const pri = await nflPriors(env);
    if (!pri || !pri.players) { out.error = 'priors asset unavailable'; return cors(json(out, 120)); }
    out.builtFrom = pri.builtFrom;

    const board = await nflBoardGames(env, url);
    out.games = board.length;
    out.seasonType = board.seasonType;

    // Injury gate, loaded once per request. Its outcome is REPORTED, not silent:
    // a gate that quietly removes players is indistinguishable from a model that
    // never knew about them, and the difference matters when the board is short.
    const inj = await nflInjuryGate();
    out.injuryGate = inj.error
      ? { active: false, error: inj.error, note: 'report unavailable — NOBODY was gated, projections include injured players' }
      : { active: true, listedOutOrDoubtful: inj.n, rowsSkipped: inj.skew || 0, gated: [],
          note: 'Out and Doubtful are dropped; Questionable is not, because most Questionable players play' };

    const byTeam = {};
    for (const [pid, p] of Object.entries(pri.players)) {
      // Only a prior earned with the club he plays for now. 'same-team' pools
      // last season with this one; a mover or rookie becomes '-current' once he
      // has three games of reps with his new club (tools/build-nfl-priors.py).
      // 'moved' and 'rookie-or-absent' are in the file for the priors page only.
      if (!NFL_PRIOR_ELIGIBLE.has(p.status)) continue;
      (byTeam[p.tm26 || p.tm] = byTeam[p.tm26 || p.tm] || []).push({ pid, ...p });
    }

    for (const g of board) {
      if (g.total == null) continue;
      for (const side of ['away', 'home']) {
        const abbr = g[side];
        const spread = side === 'away' ? g.away_spread : g.home_spread;
        if (spread == null) continue;
        const roster = byTeam[abbr] || [];
        const plays = pri.league.playsPerTeamGame * (1 + NFL_PACE_COEF * (g.total - 44));
        const passRate = Math.min(0.72, Math.max(0.45, pri.league.passRate + NFL_SCRIPT_COEF * spread));
        const teamPass = plays * passRate, teamRush = plays * (1 - passRate);

        const wk = g.week != null ? String(g.week) : '';
        for (const p of roster) {
          // Gated before any projection is built, so an Out player cannot reach
          // the board, the frozen record, or a captured line.
          // p.n, not p.name — the priors store the display name as `n` (see
          // nflRow). p.name is undefined, which would have normalised to '' and
          // matched nothing, leaving a gate that reported itself active while
          // gating nobody.
          const hit = inj.gated.get(`${wk}|${abbr}|${normName(p.n || '')}`);
          if (hit) {
            // Recorded with the designation and the injury, because the board
            // has to be able to SAY why a player vanished. A silent drop is
            // indistinguishable from a model that never knew him, which is the
            // failure this gate was built to end, not to repeat.
            if (out.injuryGate.gated) {
              out.injuryGate.gated.push({
                player: p.n, team: abbr, week: wk, pos: p.pos || null,
                status: hit.status, injury: hit.injury || null,
                game: `${g.away} @ ${g.home}`,
              });
            }
            continue;
          }
          const seed = (p.pid.length * 7919 + abbr.charCodeAt(0) * 104729 + Math.round(g.total * 10)) | 0;

          // Receiving carries the route-participation gate, as backtested.
          if (p.recN >= 12 && p.rp >= NFL_MIN_RP) {
            const ypr = ((p.ypr * p.recN + 12 * pri.league.yprCohort) / (p.recN + 12)) * NFL_EFF_CAL.receiving;
            const shape = Math.max(1.2, Math.min(6, ypr / 3.2));
            const q = nflSim(teamPass * p.recShare, NFL_REC_DISP, shape, ypr / shape, 0, nflRng(seed));
            out.rows.push({ ...nflRow(p, abbr, g, 'receiving'), ...q, conf: nflConfidence('receiving', p, q) });
          }
          // Rushing does not. A back who never runs a route still carries the
          // ball 300 times; the rushing backtest gated on carry volume alone and
          // this must match it or the deployed model is not the validated one.
          if (p.carN >= NFL_MIN_CARRIES) {
            const ypc = ((p.ypc * p.carN + 15 * pri.league.ypcCohort) / (p.carN + 15)) * NFL_EFF_CAL.rushing;
            const shifted = ypc + NFL_RUSH_SHIFT;
            const shape = Math.max(1.5, Math.min(9, shifted / 1.6));
            const q = nflSim(teamRush * p.carShare, NFL_RUSH_DISP, shape, shifted / shape, NFL_RUSH_SHIFT, nflRng(seed + 7));
            out.rows.push({ ...nflRow(p, abbr, g, 'rushing'), ...q, conf: nflConfidence('rushing', p, q) });
          }
        }
      }
    }
    // Biggest projections first — with no market line to rank against, volume is
    // the only honest ordering. It is explicitly NOT an edge ranking.
    out.rows.sort((a, b) => b.proj - a.proj);
    // Written before the prop capture existed, this used to claim no book quoted
    // NFL props through our feed. They do -- 96 of 145 rows carried DK, FD,
    // Pinnacle, NoVig and ProphetX quotes the day this was corrected -- and the
    // frozen projections are graded from box scores. What is still true is
    // narrower: THIS endpoint holds no prices, and nothing anywhere is posted.
    out.note = 'projections only — this endpoint carries no prices and ranks by volume, '
      + 'never by edge. Books do quote NFL player props through the feed; those are '
      + 'captured separately and joined to these projections in /api/nfl-compare, '
      + 'which also carries the graded result. Nothing on either endpoint is posted as a play.';
  } catch (e) { out.error = String((e && e.message) || e); }
  return cors(json(out, 120));
}

function nflRow(p, abbr, g, market) {
  return { player: p.n, pos: p.pos, team: abbr, market,
    game: `${g.away} @ ${g.home}`, commence: g.commence, rp: Math.round(p.rp * 100) };
}

function nflSim(countMean, disp, shape, scale, shift, rnd) {
  const d = new Array(NFL_DRAWS);
  for (let i = 0; i < NFL_DRAWS; i++) {
    const n = nflNegBin(Math.max(0.05, countMean), disp, rnd);
    let y = 0;
    for (let j = 0; j < n; j++) y += nflGamma(shape, scale, rnd) - shift;
    d[i] = y;
  }
  d.sort((a, b) => a - b);
  const q = (x) => Math.round(d[Math.min(d.length - 1, Math.floor(x * d.length))] * 10) / 10;
  return {
    proj: Math.round((d.reduce((s, x) => s + x, 0) / d.length) * 10) / 10,
    p25: q(0.25), p50: q(0.50), p75: q(0.75),
    count: Math.round(countMean * 10) / 10,
  };
}

// ---------------------------------------------------------------------------
// Odds API usage, recorded so a burn is visible before it becomes an outage
// ---------------------------------------------------------------------------
// The quota ran out with no warning anywhere in the product: nothing tracked how
// fast credits were going, so the first symptom was an empty board. Every Odds
// API response carries x-requests-remaining; this stores the latest reading and
// the day's low-water mark, which is enough to see a burn rate without spending
// a single extra credit.
async function ensureUsageSchema(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS odds_usage (
    day TEXT PRIMARY KEY, remaining INTEGER, low INTEGER, calls INTEGER, updated_at TEXT
  )`).run();
  // Per-route attribution. The day table says how much went out; this says what
  // bought it, which is the question you actually need answered when the bill is
  // twice what it should be. Without it the split between the batter board, the
  // strikeout board and the league-wide calls could only be inferred from the
  // billing arithmetic in the source, and inferring it got the ratio wrong.
  await db.prepare(`CREATE TABLE IF NOT EXISTS odds_route (
    day TEXT, route TEXT, credits INTEGER, calls INTEGER, blind INTEGER, updated_at TEXT,
    PRIMARY KEY (day, route)
  )`).run();
  // Ledger writes that failed, written down after the fact — see METER_FAIL.
  await db.prepare(`CREATE TABLE IF NOT EXISTS odds_meter_fail (
    day TEXT PRIMARY KEY, failures INTEGER, first_at TEXT, last_at TEXT, last_error TEXT
  )`).run();
}
// Best-effort and never awaited by a request path: telemetry must not be able to
// slow down or break the thing it is measuring.
//
// `route` names the CALL SITE, not the URL — two call sites can hit the same
// endpoint for different reasons and cost different amounts, and it is the
// reason that gets changed when the spend is wrong.
//
// Credits come from x-requests-last, the exact cost the API charges for that one
// call. Deriving it instead from the drop in x-requests-remaining would be wrong
// under any concurrency, and the per-event fetches are all issued in parallel.
// A response without the header is counted as `blind`: not silently folded into
// the total as a zero, because a route that looks free is exactly the kind of
// wrong number this table exists to prevent.
// Ledger writes that did not land, held in MEMORY. The likeliest reason a
// ledger write fails is that the database itself is refusing writes, so
// recording the failure in that database would fail right along with it.
//
// This is what the catch below used to swallow whole. On 2026-09-12 the last
// recorded call was at 19:51Z, mid-slate; nothing more was written until
// midnight UTC while about 632 credits went out, and the only trace was a gap in
// the reconciliation a day later, attributed to the wrong day.
//
// Per isolate, so it undercounts: Workers run many and recycle them freely. It is
// flushed to odds_meter_fail by the next write in this isolate that succeeds,
// which leaves a durable lower bound, and /api/usage also reports what this
// isolate has not flushed yet — because while the database is still down, that
// in-memory count is the only evidence there is.
const METER_FAIL = { pending: {}, total: 0, lastError: null, lastAt: null };

function noteMeterFailure(day, now, e) {
  const msg = String((e && e.message) || e).slice(0, 200);
  const p = METER_FAIL.pending[day] || (METER_FAIL.pending[day] = { n: 0, firstAt: now, lastAt: now, lastError: msg });
  p.n += 1; p.lastAt = now; p.lastError = msg;
  METER_FAIL.total += 1; METER_FAIL.lastError = msg; METER_FAIL.lastAt = now;
}

async function flushMeterFailures(db) {
  const days = Object.keys(METER_FAIL.pending);
  if (!days.length) return;
  // Swapped out synchronously, before any await, so two successful writes
  // landing together in this isolate cannot both flush the same failures and
  // count them twice.
  const taken = METER_FAIL.pending;
  METER_FAIL.pending = {};
  try {
    await db.batch(days.map((d) => db.prepare(
      `INSERT INTO odds_meter_fail (day, failures, first_at, last_at, last_error) VALUES (?,?,?,?,?)
       ON CONFLICT(day) DO UPDATE SET
         failures = failures + excluded.failures,
         first_at = MIN(first_at, excluded.first_at),
         last_at = MAX(last_at, excluded.last_at),
         last_error = excluded.last_error`
    ).bind(d, taken[d].n, taken[d].firstAt, taken[d].lastAt, taken[d].lastError)));
  } catch (e) {
    // Put them back for a later success to retry, merged with anything that
    // failed in the meantime.
    for (const d of days) {
      const cur = METER_FAIL.pending[d];
      if (!cur) { METER_FAIL.pending[d] = taken[d]; continue; }
      cur.n += taken[d].n;
      if (taken[d].firstAt < cur.firstAt) cur.firstAt = taken[d].firstAt;
    }
  }
}

async function recordOddsUsage(env, res, route) {
  let rem, last;
  try {
    if (!env || !env.DB || !res || !res.headers) return;
    rem = parseInt(res.headers.get('x-requests-remaining') || '', 10);
    last = parseInt(res.headers.get('x-requests-last') || '', 10);
  } catch (e) { return; }
  // No remaining header means there is nothing to record. That is not a failed
  // write and must not be counted as one.
  if (!Number.isFinite(rem)) return;
  const now = new Date().toISOString();
  const day = now.slice(0, 10);
  const cost = Number.isFinite(last) ? last : 0;
  const blind = Number.isFinite(last) ? 0 : 1;
  try {
    await ensureUsageSchema(env.DB);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO odds_usage (day, remaining, low, calls, updated_at) VALUES (?,?,?,1,?)
         ON CONFLICT(day) DO UPDATE SET
           remaining = excluded.remaining,
           low = MIN(low, excluded.remaining),
           calls = calls + 1,
           updated_at = excluded.updated_at`
      ).bind(day, rem, rem, now),
      env.DB.prepare(
        `INSERT INTO odds_route (day, route, credits, calls, blind, updated_at) VALUES (?,?,?,1,?,?)
         ON CONFLICT(day, route) DO UPDATE SET
           credits = credits + excluded.credits,
           calls = calls + 1,
           blind = blind + excluded.blind,
           updated_at = excluded.updated_at`
      ).bind(day, route || 'unattributed', cost, blind, now),
    ]);
  } catch (e) {
    // Still never worth an error to the request — but no longer silent.
    noteMeterFailure(day, now, e);
    return;
  }
  // The database is taking writes. If this isolate saw any fail earlier, write
  // them down now, while it can.
  await flushMeterFailures(env.DB);
}

// GET /api/usage — reads the stored numbers only. Costs nothing upstream, which
// is the point: checking the quota must not consume the quota.
async function oddsUsage(env) {
  const out = { note: 'read from stored response headers — this endpoint makes no upstream call' };
  // Attached BEFORE the database is touched. If the database is what is
  // failing, the reads below throw, and this is the one part of the answer that
  // can still be produced.
  const unflushed = Object.values(METER_FAIL.pending).reduce((a, p) => a + p.n, 0);
  out.meterFailures = {
    note: 'ledger writes that failed. `days` is what has been written down durably; '
      + '`thisIsolate` is what the Worker instance answering this request saw and has not '
      + 'written yet. Both undercount — isolates are many and short-lived — so any non-zero '
      + 'value means the ledger is incomplete for that day.',
    days: [],
    thisIsolate: {
      unflushed,
      byDay: JSON.parse(JSON.stringify(METER_FAIL.pending)),
      seenSinceStart: METER_FAIL.total,
      lastError: METER_FAIL.lastError,
      lastAt: METER_FAIL.lastAt,
    },
  };
  if (!env || !env.DB) { out.error = 'no DB binding'; return cors(json(out, 30)); }
  try {
    await ensureUsageSchema(env.DB);
    const rows = (await env.DB.prepare(
      'SELECT day, remaining, low, calls, updated_at FROM odds_usage ORDER BY day DESC LIMIT 14'
    ).all()).results || [];
    out.days = rows;

    const mf = (await env.DB.prepare(
      'SELECT day, failures, first_at, last_at, last_error FROM odds_meter_fail ORDER BY day DESC LIMIT 14'
    ).all()).results || [];
    out.meterFailures.days = mf;
    const failsByDay = {};
    for (const f of mf) failsByDay[f.day] = f.failures || 0;
    for (const [d, pnd] of Object.entries(METER_FAIL.pending)) failsByDay[d] = (failsByDay[d] || 0) + pnd.n;
    if (rows.length >= 2) {
      // Credits spent per day, from the drop in the low-water mark.
      out.burn = [];
      for (let i = 0; i < rows.length - 1; i++) {
        const spent = rows[i + 1].low - rows[i].low;
        out.burn.push({ day: rows[i].day, spent, calls: rows[i].calls });
      }
    }
    // Per-route attribution: what bought the credits, not just how many went.
    const rr = (await env.DB.prepare(
      'SELECT day, route, credits, calls, blind FROM odds_route ORDER BY day DESC, credits DESC LIMIT 200'
    ).all()).results || [];
    const byDay = {};
    for (const r of rr) (byDay[r.day] = byDay[r.day] || []).push(
      { route: r.route, credits: r.credits, calls: r.calls, blind: r.blind }
    );
    out.routes = byDay;

    // Reconciliation. The route table sums what each call REPORTED spending
    // (x-requests-last); the burn is what the quota counter actually dropped by.
    // They agree only if every paid call site is metered — so a gap is the
    // ledger telling you it is incomplete, which is the failure mode that made
    // the old `calls` number so misleading (it counted two call sites out of
    // ten and still looked like a total).
    const spentByDay = {};
    for (let i = 0; i < rows.length - 1; i++) spentByDay[rows[i].day] = rows[i + 1].low - rows[i].low;
    out.reconcile = Object.keys(byDay).sort().reverse().map((day) => {
      const metered = byDay[day].reduce((s, r) => s + (r.credits || 0), 0);
      const blind = byDay[day].reduce((s, r) => s + (r.blind || 0), 0);
      const spent = spentByDay[day];
      // A day still in progress has no closing low to difference against, so it
      // reports metered-only rather than a gap that is really just "not over yet".
      // A failed write freezes that day's low-water mark at its last recorded
      // call, so the unrecorded spend surfaces as a gap on the FOLLOWING day.
      // The failures that explain a gap are therefore looked for on both.
      const prev = new Date(Date.parse(day + 'T00:00:00Z') - 864e5).toISOString().slice(0, 10);
      const writeFailures = (failsByDay[day] || 0) + (failsByDay[prev] || 0);
      if (typeof spent !== 'number' || spent < 0) return { day, metered, blind, spent: null, writeFailures, note: 'day not closed — no burn to compare' };
      const closes = Math.abs(spent - metered) <= Math.max(20, spent * 0.05);
      return { day, metered, blind, spent, unattributed: spent - metered, writeFailures,
        note: closes ? 'ledger accounts for the burn'
          : writeFailures > 0
            ? `GAP — ${writeFailures} ledger write(s) failed on ${prev} or ${day}; the unrecorded spend is most likely from those calls`
            : 'GAP — some spend is not attributed to any route' };
    });

    const latest = rows[0];
    out.remaining = latest ? latest.remaining : null;
    out.verdict = !latest ? 'no readings yet'
      : latest.remaining <= 0 ? 'EXHAUSTED — nothing can be priced'
      : latest.remaining < 500 ? 'LOW — under 500 credits left'
      : 'ok';
  } catch (e) { out.error = String((e && e.message) || e); }
  return cors(json(out, 30));
}
