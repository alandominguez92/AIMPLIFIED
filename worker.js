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
const LINE_SHRINK = 0.37;  // fraction of the projection pulled toward the line

// The books we price against (the user's accounts). Odds API bookmaker keys ->
// short display labels. Prices are pinned to these two only, and the better of
// the two is highlighted so the board doubles as a line-shop.
const BOOKS = { draftkings: 'DK', fanduel: 'FD' };
// Extra soft books pulled ONLY to sharpen the strikeout fair line — never shown
// in the Odds column and never bet (you only have DK/FD accounts). They already
// ride along in the us-region prop response we pay for, so pooling them is free
// quota. More de-vigged books -> a median fair that rejects one soft/stale line.
const FAIR_EXTRA = { betmgm: 'MGM' };
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
const PROP_BOOKS = { ...BOOKS, ...FAIR_EXTRA, ...SHARP_BOOKS };
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
const BATTER_MODEL_VER = 'sharp-shin-nb-evgate';
// Same idea for the strikeout board, which moved from a DK/FD/MGM consensus fair
// (circular — two of the three are the books we bet) to the sharp pool with that
// consensus demoted to a middle fallback rung.
const K_MODEL_VER = 'k-sharp-shin';
// Moneyline pricing era. 'ml-shin' covers Shin de-vig on the sharp pair,
// grading at entry price rather than close, and de-vigging each book's own
// two sides instead of the best-of pair. fair_source is logged alongside so
// a Pinnacle-priced pick is distinguishable from a soft-book fallback.
const ML_MODEL_VER = 'ml-shin';

const API_ROUTES = new Set([
  '/api/odds', '/api/scores', '/api/hitters', '/api/pitchers',
  '/api/board', '/api/batters', '/api/track-record', '/api/injuries', '/api/live-now',
  '/api/ml-debug', '/api/track-debug', '/api/edge-debug', '/api/batter-debug',
  '/api/fair-probe', '/api/nfl-ingest', '/api/nfl-board', '/api/be-gate', '/api/nfl-props', '/api/usage',
]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;

    if (!API_ROUTES.has(p)) return env.ASSETS.fetch(request); // static site

    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));

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

    if (p === '/api/nfl-ingest') return handleApi(p, env, ctx, url);   // writes; caching it would skip the write
    const cacheKey = new Request(url.origin + p + (p === '/api/fair-probe' ? url.search : ''));
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
    ctx.waitUntil(captureCloses(env, ctx));
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

// Props post the morning of game day, so a game more than ~12h out has no lines
// yet — pricing it spends a paid per-event call to receive an empty book list.
//
// board() has gated its strikeout fetch on this since the board started rolling
// a day ahead into projections. batters() never did: it asked /events with no
// upper bound and priced everything with a future start, which in season is
// today's slate PLUS tomorrow's once books post it. That is the expensive call
// (three markets per event against strikeouts' one), so the ungated path was
// the costly one, and it was silently paying double through the evening.
//
// Hoisted to module scope so the two cannot drift apart again, and applied to
// the /events request itself as commenceTimeTo — bounding the list upstream is
// strictly better than fetching it whole and discarding half locally.
const PROP_LEAD_MS = 12 * 3600 * 1000;
// Odds API wants ISO8601 with no sub-second part; toISOString always emits ms.
const oddsTime = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const eventsUrl = (key) => `${ODDS}/events?apiKey=${key}&dateFormat=iso`
  + `&commenceTimeTo=${oddsTime(Date.now() + PROP_LEAD_MS)}`;

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
  if (p === '/api/board') return board(env, ctx);
  if (p === '/api/batters') return batters(env, ctx);
  if (p === '/api/track-record') return trackRecord(env);
  if (p === '/api/injuries') return injuries();
  if (p === '/api/live-now') return liveNow(env);
  if (p === '/api/ml-debug') return mlDebug(env);
  if (p === '/api/track-debug') return trackDebug(env);
  if (p === '/api/edge-debug') return edgeDebug(env);
  if (p === '/api/batter-debug') return batterDebug(env);
  if (p === '/api/fair-probe') return fairProbe(env, url);
  if (p === '/api/nfl-ingest') return nflIngest(env, url);
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
  return proxy(`${ODDS}/odds?apiKey=${key}&regions=us&markets=h2h,totals&oddsFormat=american&dateFormat=iso`,
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
        const upcoming = (opts && opts.closeOnly)
          ? closingSoon(events, opts.closeOnly)
          : (Array.isArray(events) ? events : [])
            .filter((ev) => {
              if (!ev.commence_time) return true;
              const t = Date.parse(ev.commence_time);
              return t > now && (t - now) <= PROP_LEAD_MS;
            });
        await Promise.all(upcoming.map(async (ev) => {
          try {
            const pr = await fetch(`${ODDS}/events/${ev.id}/odds?apiKey=${key}&bookmakers=${Object.keys(PROP_BOOKS).join(',')}&markets=pitcher_strikeouts&oddsFormat=american&dateFormat=iso`, { headers: { accept: 'application/json' } });
            if (ctx && ctx.waitUntil) ctx.waitUntil(recordOddsUsage(env, pr, 'board:kprops'));
            if (!pr.ok) return;
            const pd = await pr.json();
            for (const bm of (pd.bookmakers || [])) {
              const label = PROP_BOOKS[bm.key]; // DK/FD (bet) + MGM and the sharp pool (fair only)
              if (!label) continue;
              const mk = (bm.markets || []).find((m) => m.key === 'pitcher_strikeouts');
              if (!mk) continue;
              for (const oc of (mk.outcomes || [])) {
                const nm = normName(oc.description);
                if (!nm) continue;
                const rec = propByName[nm] || (propByName[nm] = {});
                const b = rec[label] || (rec[label] = {});
                if (oc.point != null) b.point = oc.point;
                if (oc.name === 'Over') b.over = oc.price;
                else if (oc.name === 'Under') b.under = oc.price;
              }
            }
          } catch (e) { /* skip this event */ }
        }));
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

  // Real moneylines + run lines — one call across US (DraftKings/FanDuel, the
  // books we bet) and EU (Pinnacle, the sharp reference we price value against).
  // Adding `spreads` (the run line) to the same call costs no extra quota.
  const mlByHome = {};   // DK/FD best price per side — what you'd actually bet
  const mlBookPairs = {}; // per-book {book,home,away} — real quotes, for de-vigging
  const pinByHome = {};  // Pinnacle price per side — the sharp fair line
  const rlByHome = {};   // DK/FD best run-line price+point per side
  const pinRlByHome = {}; // Pinnacle run-line price+point per side (sharp fair)
  if (key) {
    try {
      const r = await fetch(`${ODDS}/odds?apiKey=${key}&regions=us,eu&markets=h2h,spreads&oddsFormat=american&dateFormat=iso`, { headers: { accept: 'application/json' } });
      if (ctx && ctx.waitUntil) ctx.waitUntil(recordOddsUsage(env, r, 'board:h2h+runline'));
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
  // Last-known run lines (spread pairs) from D1 — same fallback for the run line.
  const savedRl = (env && env.DB) ? await loadRlLines(env.DB, date) : {};

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
      const projK = (k9 * expIP / 9) * (lgK > 0 ? oppK / lgK : 1) * parkK * wxK;
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
    };
  }).sort((a, b) => a.timeMs - b.timeMs);

  // Log tonight's priced picks to the track record (idempotent) — non-blocking.
  if (env && env.DB) {
    const write = logPicks(env.DB, rows, date).catch(() => {});
    if (ctx && ctx.waitUntil) ctx.waitUntil(write);
    const writeMl = logMlPicks(env.DB, rows, date).catch(() => {});
    if (ctx && ctx.waitUntil) ctx.waitUntil(writeMl);

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

  // 5 min near first pitch, 15 while the slate is still hours out — see
  // BOARD_TTL_NEAR. Props are the expensive part, and they do not move overnight.
  return cors(json(rows, ttlForSoonest(soonestStart(rows, 'timeMs'))));
}

// Moneyline for one game. Fair line = Pinnacle's de-vigged probability (the
// sharpest read available); edge = how much the DK/FD price you'd actually bet
// beats that fair number. If Pinnacle is missing we fall back to DK/FD-de-vig vs
// our log5 model, and if there's no market at all, to the model favorite.
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
      modelProb: Math.round(model[side] * 100),
    };
  };
  const h = sideFor('home'), a = sideFor('away');

  // Bet the side with the larger edge; with no edge, name the fair favorite.
  let chosen;
  if (h.edge == null || a.edge == null) chosen = fairH >= 0.5 ? h : a;
  else chosen = h.edge >= a.edge ? h : a;

  const e = chosen.edge;
  const tier = e == null ? 'model' : e >= 4 ? 1 : e >= 2.5 ? 2 : e >= 1 ? 3 : 'pass';
  return {
    pick: `${chosen.teamAbbr} ML`,
    teamAbbr: chosen.teamAbbr,
    winProb: chosen.winProb,   // fair (sharp) win prob of the pick
    price: chosen.price,       // DK/FD price you'd bet
    edge: e,
    tier,
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
const battersPayload = (rows, feedError, ttlSec) => cors(json(
  { rows, feedError: feedError || null },
  feedError ? 30 : (ttlSec || ttlForSoonest(soonestStart(rows, 'timeMs'))),
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
  const lineupSlotById = {};        // playerId -> batting slot 1-9
  const lineupById = {};            // playerId -> { name, teamId } for posted starters
  const lineupPostedTeamIds = new Set(); // teams whose lineup is posted
  const oppPPIdByTeamId = {};       // teamId -> the OPPONENT's probable pitcher id
  const oppPPNameByTeamId = {};     // teamId -> that pitcher's name (display/debug)
  const parkByTeamId = {};          // teamId -> tonight's venue name (for park factor)
  const ppIds = new Set();          // probable-pitcher ids to resolve throwing hand
  try {
    // Adds probablePitcher (opposing arm) + venue (park factor) to the same
    // schedule call — no extra request, and both feed the batter projection.
    const r = await fetch(`${STATS}/schedule?sportId=1&date=${slateDate()}&hydrate=team,lineups,probablePitcher,venue`, { headers: { accept: 'application/json' } });
    if (r.ok) {
      const sd = await r.json();
      (((sd.dates || [])[0] || {}).games || []).forEach((g) => {
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
        if (g.teams.away.team && g.teams.away.team.id) gameByTeamId[g.teams.away.team.id] = ident;
        if (g.teams.home.team && g.teams.home.team.id) gameByTeamId[g.teams.home.team.id] = ident;

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
  const upcomingB = opts && opts.closeOnly
    ? closingSoon(events, opts.closeOnly)
    : events.filter((ev) => {
      if (!ev.commence_time) return true;
      const t = Date.parse(ev.commence_time);
      return t > nowB && (t - nowB) <= PROP_LEAD_MS;
    });
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
  const feedKey = `batter_lines:${slateDate()}:${marketKeys}`;
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
  if (seeded) {
    for (const [nm, s] of Object.entries(seeded)) {
      if (!s || !s.props) continue;
      // The same window the fetch path applies. Without it a stored line would
      // outlive its game and quote a price on something already underway.
      const t = s.timeMs || 0;
      if (!(t > nowB && (t - nowB) <= PROP_LEAD_MS)) continue;
      // Status and score are re-derived from tonight's schedule rather than
      // stored: the lines are what was bought, but a score read from cache
      // would be wrong the moment the game moves.
      const sc = schedByMatchup[`${s.awayAb}@${s.homeAb}`] || null;
      byName[nm] = {
        name: s.name, matchup: `${s.awayAb} @ ${s.homeAb}`,
        timeMs: t, timeLabel: s.timeLabel,
        gamePk: sc ? sc.gamePk : null, gameStatus: sc ? sc.status : 'Preview',
        awayScore: sc ? sc.awayScore : null, homeScore: sc ? sc.homeScore : null,
        props: s.props,
      };
    }
  }
  await Promise.all((doFetch ? upcomingB : []).map(async (ev) => {
    try {
      // Explicit bookmaker list rather than `regions=us`: it pulls the sharp fair
      // sources (which sit outside the us region) at the same 1 region-equivalent
      // price, since Odds API bills ceil(books/10) and we ask for 7.
      const r = await fetch(`${ODDS}/events/${ev.id}/odds?apiKey=${key}&bookmakers=${Object.keys(PROP_BOOKS).join(',')}&markets=${marketKeys}&oddsFormat=american&dateFormat=iso`, { headers: { accept: 'application/json' } });
      if (ctx && ctx.waitUntil) ctx.waitUntil(recordOddsUsage(env, r, 'batters:props'));
      if (!r.ok) { if (!propsFeedError) propsFeedError = await feedErrorFrom(r); return; }
      const d = await r.json();
      const awayAb = keyAbbr(ev.away_team);
      const homeAb = keyAbbr(ev.home_team);
      const matchup = `${awayAb} @ ${homeAb}`;
      const sched = schedByMatchup[`${awayAb}@${homeAb}`] || null;
      for (const bm of (d.bookmakers || [])) {
        const label = PROP_BOOKS[bm.key]; // DK/FD = bet, MGM + sharps = fair only
        if (!label) continue;
        for (const spec of BATTER_MARKETS) {
          const mk = (bm.markets || []).find((m) => m.key === spec.key);
          if (!mk) continue;
          for (const oc of (mk.outcomes || [])) {
            const nm = normName(oc.description);
            if (!nm) continue;
            const rec = byName[nm] || (byName[nm] = { name: oc.description, matchup, awayAb, homeAb, timeMs: Date.parse(ev.commence_time) || 0, timeLabel: timeLabelPT(ev.commence_time), gamePk: sched ? sched.gamePk : null, gameStatus: sched ? sched.status : 'Preview', awayScore: sched ? sched.awayScore : null, homeScore: sched ? sched.homeScore : null, props: {} });
            const mp = rec.props[spec.metric] || (rec.props[spec.metric] = {});
            const b = mp[label] || (mp[label] = {});
            if (oc.point != null) b.point = oc.point;
            if (oc.name === 'Over') b.over = oc.price;
            else if (oc.name === 'Under') b.under = oc.price;
          }
        }
      }
    } catch (e) { /* skip this event */ }
  }));
  if (propsFeedError && !feedError) feedError = propsFeedError;

  // Publish what we just bought so the next colo does not buy it again. Only on
  // a clean fetch that actually produced lines: caching a slate emptied by a 401
  // would spread the outage to every colo for the rest of the window, and the
  // whole point of the store is that one colo's bad luck is not everyone's.
  if (doFetch && useStore && !propsFeedError && Object.keys(byName).length) {
    const toStore = {};
    for (const [nm, r] of Object.entries(byName)) {
      toStore[nm] = { name: r.name, awayAb: r.awayAb, homeAb: r.homeAb, timeMs: r.timeMs, timeLabel: r.timeLabel, props: r.props };
    }
    const w = saveFeedCache(env.DB, feedKey, toStore);
    if (ctx && ctx.waitUntil) ctx.waitUntil(w); else await w;
  }

  // No priced players -- but that does not mean nothing is knowable. Everything
  // the projection needs (batting slot when posted, opposing arm, park, season
  // rates) comes from StatsAPI, which is independent of the odds feed. The
  // seeding happens below, once season stats are in hand, because the player
  // universe has to come from the stats pool when no lineup card is up yet.
  const modelSeeded = !Object.keys(byName).length;
  // Nothing priced AND no game on the schedule: genuinely nothing to show.
  if (modelSeeded && !Object.keys(gameByTeamId).length) return battersPayload([], feedError, boardTtlSec);

  // 2) Season hitting stats for every batter, keyed by name for matching.
  const statByName = {};
  try {
    const r = await fetch(`${STATS}/stats?stats=season&group=hitting&gameType=R&season=${season}&sportId=1&playerPool=All&limit=2000`, { headers: { accept: 'application/json' } });
    if (r.ok) {
      const d = await r.json();
      ((d.stats || [])[0] || {}).splits?.forEach((s) => {
        const nm = normName((s.player || {}).fullName);
        // fullName is kept for display: the key is normalized, so it can't be
        // shown, and the model-only path has no book description to fall back on.
        if (nm) statByName[nm] = { st: s.stat || {}, id: (s.player || {}).id, name: (s.player || {}).fullName || null, team: teamAbbr(s.team), teamId: (s.team || {}).id };
      });
    }
  } catch (e) { /* projections fall back to rate-only where possible */ }

  // 2a) Model-only seeding. With no book quotes there is no priced player list,
  // so the universe comes from who is playing tonight instead of who got priced.
  //
  // Preference order matters. A posted lineup card is fact, so it wins outright.
  // Before cards go up -- which is most of the day, since they post ~3h out --
  // fall back to each club's qualified hitters from the season pool. That is a
  // projection of who plays, not a claim about it, and it self-corrects: the
  // moment a card posts, the slot filter in step 3 drops everyone not on it.
  if (modelSeeded) {
    const seed = (name, teamId) => {
      const g = gameByTeamId[teamId];
      if (!g) return;
      const nm = normName(name);
      if (!nm || byName[nm]) return;
      byName[nm] = {
        name, matchup: g.matchup, timeMs: g.timeMs, timeLabel: g.timeLabel,
        gamePk: g.gamePk, gameStatus: g.gameStatus,
        awayScore: g.awayScore, homeScore: g.homeScore,
        props: {},               // no book quotes -> no line, no price, no edge
      };
    };
    const posted = Object.keys(lineupById).length > 0;
    if (posted) {
      for (const pid of Object.keys(lineupById)) seed(lineupById[pid].name, lineupById[pid].teamId);
    } else {
      // Rank each club's hitters by season plate appearances and keep the top 9 --
      // playing time is the best available predictor of who is in tonight's card.
      const byTeam = {};
      for (const nm of Object.keys(statByName)) {
        const s = statByName[nm];
        if (!s.teamId || !gameByTeamId[s.teamId]) continue;
        (byTeam[s.teamId] || (byTeam[s.teamId] = [])).push({ nm, pa: toNum((s.st || {}).plateAppearances) });
      }
      for (const teamId of Object.keys(byTeam)) {
        byTeam[teamId].sort((a, b) => b.pa - a.pa).slice(0, 9)
          .forEach((x) => seed(statByName[x.nm].name || x.nm, teamId));
      }
    }
  }

  // 2b) Platoon splits: each batter's TB / HR / (H+R+RBI) per PA vs LHP and vs
  // RHP, so tonight's projection can lean on how he hits the hand he's facing.
  // One bulk statSplits call (chunked for URL length); any miss -> no platoon
  // adjustment for that batter, i.e. neutral. splitByPlayerId[id] = { L, R }
  // where each side is { pa, hr, tb, hrr } season totals for that split.
  const splitByPlayerId = {};
  const batterIds = [...new Set(Object.values(statByName).map((x) => x.id).filter(Boolean))];
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
  for (const k of Object.keys(statByName)) {
    const s = statByName[k].st || {};
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
    const match = statByName[nm];
    if (!match) continue;              // no stats -> can't project; skip
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

    const lambda = {
      hr: baseRate.hr * expPA * BATTER_PROJ_CAL.hr * adj.hr,
      tb: baseRate.tb * expPA * BATTER_PROJ_CAL.tb * adj.tb,
      hrr: (slot ? baseRate.hrr * expPA : (hits + runs + rbi) / gp) * BATTER_PROJ_CAL.hrr * adj.hrr,
    };
    const markets = {};
    for (const spec of BATTER_MARKETS) {
      markets[spec.metric] = priceBatterProp(rec.props[spec.metric], lambda[spec.metric], spec.metric);
    }
    // oppPFac = the pitcher-only multiplier per metric, kept separate from the
    // combined `adj` so a projection can be traced back to which factor moved it.
    const oppPFac = oppP ? { hr: round2(pitcherMult('hr')), tb: round2(pitcherMult('tb')), hrr: round2(pitcherMult('hrr')) } : null;
    draft.push({ nm, rec, match, st, lambda, iso, slg: toNum(st.slg), kpct, bbpct, markets, slot, pulled, facingHand, venue, adj, seasonPA: pa, oppPName: oppPPNameByTeamId[match.teamId] || null, oppPFac });
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
    const lead = unders.reduce((best, x) => (!best || x.m.edge > best.m.edge ? x : best), null);
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
        return m ? { label: spec.label, metric: spec.metric, line: m.line, side: m.side, price: m.price, edge: m.edge, modelOver: m.modelOver, fairOver: m.fairOver, fairSrc: m.fairSrc, fairBooks: m.fairBooks, tier: m.tier, proj: expFor(spec.metric), books: m.books } : { label: spec.label, metric: spec.metric, none: true, proj: expFor(spec.metric) };
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
  const pricedRows = all.filter((r) => r.odds != null)
    .sort((a, b) => (b.edge || 0) - (a.edge || 0))
    .slice(0, 40);
  // Nothing priced anywhere: fall back to the model-only view rather than an
  // empty board. Ranked by projected total bases, since with no line there is no
  // edge to rank by. Batting order breaks ties -- it is the one ordering that is
  // real information here and not an artifact of the projection.
  const live = pricedRows.length ? pricedRows
    : all.filter((r) => r.tier === 'model')
      .sort((a, b) => (b.projVal || 0) - (a.projVal || 0) || (a.lineupSlot || 99) - (b.lineupSlot || 99))
      .slice(0, 40);
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
      ).bind(slateDate()).all()).results || [];
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

    const write = logBatterPicks(env.DB, logRows, slateDate()).catch(() => {});
    if (ctx && ctx.waitUntil) ctx.waitUntil(write); else await write;
  }

  // 5 min — batter props are the expensive call. propsFeedError rides along even
  // on a good slate: some events can 401 while others succeed, and a partial
  // slate presented as complete is its own quiet lie.
  return battersPayload(rows, feedError, boardTtlSec);
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

async function liveNow(env) {
  const date = slateDate();
  if (!env || !env.DB) return cors(json([], 30));

  // 1) Which of tonight's games are in progress (+ score / inning).
  let games = [];
  try {
    const r = await fetch(`${STATS}/schedule?sportId=1&date=${date}&hydrate=linescore,team`, { headers: { accept: 'application/json' } });
    if (!r.ok) return cors(json([], 30));
    games = (((await r.json()).dates || [])[0] || {}).games || [];
  } catch (e) { return cors(json([], 30)); }

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
  if (!Object.keys(meta).length) return cors(json([], 30));

  // 2) Tonight's logged picks (lines/sides) from D1.
  let picks = [], bpicks = [];
  try {
    await ensureSchema(env.DB); await ensureBatterSchema(env.DB);
    picks = (await env.DB.prepare('SELECT * FROM picks WHERE date=?').bind(date).all()).results || [];
    bpicks = (await env.DB.prepare('SELECT * FROM bpicks WHERE date=?').bind(date).all()).results || [];
  } catch (e) { return cors(json([], 30)); }

  // 3) One boxscore per live game that carries a pick.
  const need = [...new Set([...picks, ...bpicks].map((p) => p.game_id).filter((id) => meta[id]))];
  if (!need.length) return cors(json([], 30));
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
      note: `${st.pitches} pitches · ${st.ip} IP`, progress: st.outs / (EXP_IP * 3), pitches: st.pitches, edge: p.edge,
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
    }));
  }

  // One card per player — a batter carries multiple markets, so keep the one
  // where they're doing best (highest fill), breaking ties by model edge.
  const byPid = new Map();
  for (const c of cards) {
    const ex = byPid.get(c._pid);
    if (!ex || c.fill > ex.fill || (c.fill === ex.fill && c._edge > ex._edge)) byPid.set(c._pid, c);
  }
  // Rank: cashing (the fun ones) first, then live, then cooling; within a state
  // put the players with the most going on (higher fill) up top.
  const order = { cashing: 0, live: 1, cooling: 2 };
  const ranked = [...byPid.values()].sort((a, b) =>
    (order[a.state] - order[b.state]) || (b.fill - a.fill) || (b._edge - a._edge));
  const out = ranked.slice(0, 9).map(({ _pid, _edge, ...c }) => c);
  return cors(json(out, 30)); // 30s — live data
}

function liveCard(o) {
  const state = liveState(o.stat, o.line, o.side, o.progress, o.pos, o.pitches);
  const scale = Math.max(o.line * 1.7, o.stat + 0.5, o.line + 1);
  return {
    id: o.id, name: o.name, team: o.team, pos: o.pos,
    stat: o.stat, statLabel: o.label, line: o.line, side: o.side,
    matchup: `${o.m.away} ${o.m.awayR} – ${o.m.home} ${o.m.homeR}`,
    inning: o.m.inning, note: o.note, state,
    fill: Math.round(Math.min(100, Math.max(0, o.stat / scale * 100))),
    tick: Math.round(Math.min(100, o.line / scale * 100)),
    _pid: o.pid, _edge: o.edge || 0,
  };
}

// cashing = already cleared the number; live = still on track / chances remain;
// cooling = trending to miss. Pitchers read off K pace (Ks accrue steadily);
// batters read off at-bats remaining (hits are lumpy, so pace is noisy early).
function liveState(stat, line, side, progress, type, pitches) {
  const oppFrac = 1 - progress;              // fraction of the start / plate appearances left
  const pace = stat / Math.max(progress, 0.2);
  if (side === 'Over') {
    if (stat > line) return 'cashing';
    if (type === 'P') {
      if ((pitches || 0) >= 105) return 'cooling';   // near the pitch limit and still short
      return pace >= line ? 'live' : 'cooling';
    }
    if (line <= 0.5) return oppFrac > 0.1 ? 'live' : 'cooling'; // to-hit props: live while an AB remains
    return oppFrac >= 0.3 ? 'live' : 'cooling';                 // enough at-bats left to get there
  }
  // Under
  if (stat > line) return 'cooling';         // already over the number
  if (type === 'P') return pace <= line ? 'live' : 'cooling';
  return oppFrac < 0.3 ? 'cashing' : 'live'; // held under with few at-bats left = nearly there
}

function pitchingLive(box, pid) {
  let s = null;
  ['away', 'home'].forEach((side) => {
    const players = ((box.teams || {})[side] || {}).players || {};
    Object.keys(players).forEach((k) => {
      const pl = players[k];
      if (pl.person && pl.person.id === pid && pl.stats && pl.stats.pitching && Object.keys(pl.stats.pitching).length) s = pl.stats.pitching;
    });
  });
  if (!s) return null;
  const ip = String(s.inningsPitched || '0.0');
  const [whole, frac] = ip.split('.');
  const outs = (parseInt(whole, 10) || 0) * 3 + (parseInt(frac, 10) || 0);
  return { k: toNum(s.strikeOuts), outs, pitches: toNum(s.numberOfPitches != null ? s.numberOfPitches : s.pitchesThrown), ip };
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
async function trackRecord(env) {
  if (!env || !env.DB) return cors(json({ empty: true, logged: 0 }, 60));
  try {
    await ensureSchema(env.DB);
    await ensureBatterSchema(env.DB);
    await gradeUngraded(env);
    await gradeBatterPicks(env);
    await backfillBatterGrades(env);
    await gradeMlPicks(env);
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
    } catch (e) { /* ML record is additive — never break the props track record */ }
    out.recent = buildRecent(unified, mlRows);
    return cors(json(out, 120));
  } catch (e) {
    return cors(json({ empty: true, logged: 0, error: String(e) }, 60));
  }
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
}

// Stamped on every row this grader touches. Bump only if the grading RULE
// changes — it is what tells the backfill which rows still need re-deriving.
const GRADE_VER = 'dnp-void-1';

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

// Run lines (spreads) persist the same way — snapshot the DK/FD + Pinnacle
// spread pairs per game while offered, so the closing run line survives the
// book pulling the spread market once the game starts (shown closed, not bettable).
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
async function addColumns(db, table, cols) {
  for (const [name, type] of cols) {
    try { await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`).run(); }
    catch (e) { /* column already exists */ }
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
// Books are named explicitly rather than pulled by region. Three reasons, all
// found by dry-running the live payload: regions=us,eu returned 23 books, 13 of
// them European retail we will never price against; it billed 6 credits where a
// named list of <=10 bills 3; and it did NOT include novig or prophetx, which
// are the exchanges the props pool depends on -- they only appear when asked for
// by key. Keep this at 10 or fewer or the request bills as a second region.
const NFL_BOOKS = [
  'pinnacle', 'lowvig', 'betonlineag', 'novig', 'prophetx',   // fair candidates
  'draftkings', 'fanduel', 'williamhill_us', 'betmgm', 'betrivers', // execution
];
// How far ahead to ingest. The Odds API returns the entire remaining season --
// 272 events, 4,743 rows on one call -- and re-writing all of it on every poll
// would bury the slate we actually price in months of untouched future games.
// Ten days covers a full Tue-to-Mon game week with room either side.
const NFL_HORIZON_DAYS = 10;
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
    try {
      const ids = events.map((e) => e.id);
      for (let i = 0; i < ids.length; i += 40) {
        const chunk = ids.slice(i, i + 40);
        const marks = chunk.map(() => '?').join(',');
        const q = await env.DB.prepare(
          'SELECT event_id, market, player, point, book, over, under, captured_at'
          + ' FROM nfl_lines WHERE event_id IN (' + marks + ')'
        ).bind(...chunk).all();
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
        `INSERT OR IGNORE INTO bpicks (date,game_id,player_id,player,team,market,line,side,price,proj,model_over,edge,tier,entry_over,fair_src,model_ver,fair_books,season_pa)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(date, gid, r.playerId, r.name, r.team, m.metric, m.line, m.side, m.price, m.proj, m.modelOver, m.edge, String(m.tier), m.fairOver ?? null, m.fairSrc ?? null, BATTER_MODEL_VER, m.fairBooks ? JSON.stringify(m.fairBooks) : null, r.seasonPA ?? null));
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
    `SELECT DISTINCT game_id, date FROM bpicks
      WHERE actual = 0 AND result IN ('win','loss')
        AND (grade_ver IS NULL OR grade_ver <> ?)
      ORDER BY date DESC LIMIT 4`
  ).bind(GRADE_VER).all()).results || [];
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
      `SELECT * FROM bpicks WHERE game_id=? AND actual = 0 AND result IN ('win','loss')`
    ).bind(g.game_id).all()).results || [];
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

async function gradeUngraded(env) {
  const db = env.DB;
  const today = slateDate();
  const rows = (await db.prepare('SELECT DISTINCT game_id, date FROM picks WHERE result IS NULL AND date < ?').bind(today).all()).results || [];
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
async function logMlPicks(db, rows, date) {
  await ensureMlPickSchema(db);
  const stmts = [];
  for (const r of rows) {
    if (r.status !== 'Preview') continue;
    const ml = r.ml;
    if (!ml || ml.price == null || !ml.teamAbbr) continue;
    const isHome = ml.teamAbbr === ml.homeAbbr ? 1 : 0;
    const opp = isHome ? ml.awayAbbr : ml.homeAbbr;
    stmts.push(db.prepare(
      `INSERT OR IGNORE INTO mlpicks (date,game_id,team,opp,is_home,tier,win_prob,edge,entry_price,close_price,model_ver,fair_source)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(date, r.id, ml.teamAbbr, opp || '', isHome, String(ml.tier), ml.winProb ?? null, ml.edge ?? null, ml.price, ml.price, ML_MODEL_VER, ml.fairSource ?? null));
    // Refresh close only while the logged side is still the model's pick, so a
    // mid-day side flip can't overwrite our entry side's closing price.
    stmts.push(db.prepare(
      'UPDATE mlpicks SET close_price=?, edge=?, tier=?, win_prob=? WHERE date=? AND game_id=? AND team=?'
    ).bind(ml.price, ml.edge ?? null, String(ml.tier), ml.winProb ?? null, date, r.id, ml.teamAbbr));
  }
  if (stmts.length) await db.batch(stmts);
}

// Grade past-day moneyline picks from final scores (schedule linescore). The
// picked team wins the bet if it outscored its opponent. MLB has no ties, but
// equal scores grade as push defensively.
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
      const voids = [];
      for (const [gid, g] of Object.entries(byPk)) {
        if (g.state === 'Final' && g.homeR != null && g.awayR != null) {
          scoreByGame[gid] = { homeR: g.homeR, awayR: g.awayR };
        } else if (isAbandoned(g)) {
          voids.push(gid);
        }
      }
      if (voids.length) {
        try {
          await db.batch(voids.map((gid) => db.prepare(
            "UPDATE mlpicks SET result='void' WHERE game_id=? AND result IS NULL").bind(gid)));
        } catch (e) { /* retry next pass */ }
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

function buildMlRecord(rows) {
  const played = rows.filter((r) => (r.result === 'win' || r.result === 'loss') && r.tier !== 'pass');
  const byTier = { '1': { w: 0, l: 0, units: 0 }, '2': { w: 0, l: 0, units: 0 }, '3': { w: 0, l: 0, units: 0 } };
  let w = 0, l = 0, units = 0, t1w = 0, t1l = 0, clvBeat = 0, clvN = 0;
  const profits = [], clvPts = [];
  for (const r of played) {
    const win = r.result === 'win';
    if (win) w++; else l++;
    // Graded at ENTRY price — the number actually available when the pick
    // posted. Grading at close_price scores a bet nobody could have placed, and
    // shifts ROI by exactly the line movement CLV is separately measuring.
    const u = profitUnits(r.result, r.entry_price ?? r.close_price);
    units += u;
    profits.push(u);
    const bt = byTier[String(r.tier)];
    if (bt) { if (win) bt.w++; else bt.l++; bt.units += u; }
    if (String(r.tier) === '1') { if (win) t1w++; else t1l++; }
    if (r.entry_price != null && r.close_price != null) {
      const ie = amProb(r.entry_price), ic = amProb(r.close_price);
      if (ie != null && ic != null) {
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
    // Era + fair source split. Rows before attribution existed carry NULL and
    // group as '(untagged)' rather than being folded into the current era.
    byModelVer: (() => {
      const m = {};
      for (const r of played) { const k = r.model_ver || '(untagged)'; (m[k] = m[k] || []).push(r); }
      return Object.keys(m).map((k) => {
        const arr = m[k];
        let w = 0, u = 0;
        for (const r of arr) { if (r.result === 'win') w++; u += profitUnits(r.result, r.entry_price ?? r.close_price); }
        return { modelVer: k, n: arr.length, record: `${w}-${arr.length - w}`, roi: round1(u / arr.length * 100), units: Math.round(u * 10) / 10 };
      }).sort((a, b) => b.n - a.n);
    })(),
    fairSourceMix: (() => {
      const m = {};
      for (const r of rows) { const k = r.fair_source || '(untagged)'; m[k] = (m[k] || 0) + 1; }
      return Object.keys(m).map((k) => ({ fairSource: k, n: m[k] })).sort((a, b) => b.n - a.n);
    })(),
    // Magnitude + error bars. On a market this efficient a beat rate near 50%
    // and avgCLV near 0 is the expected null result, and p >= 0.05 means exactly
    // that — no established effect, regardless of how the ROI reads.
    avgCLVpts: clvPts.length ? round1(mlMean(clvPts)) : null,
    sig: { roiT: mlR2(mlT(profits)), roiP: mlP(mlT(profits)), clvT: mlR2(mlT(clvPts)), clvP: mlP(mlT(clvPts)) },
    pending: rows.filter((r) => r.result == null).length,
  };
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
const BATTER_PROJ_CAL = { hr: 1.00, tb: 1.00, hrr: 1.00 };
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
      if (hr.length) {
        const n = hr.length;
        const mp = hr.reduce((s, r) => s + r.proj, 0) / n;
        const ma = hr.reduce((s, r) => s + r.actual, 0) / n;
        const mae = hr.reduce((s, r) => s + Math.abs(r.proj - r.actual), 0) / n;
        const varA = hr.reduce((s, r) => s + (r.actual - ma) ** 2, 0) / n;
        hitsProj = {
          n, meanProj: round2(mp), meanActual: round2(ma),
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
    const projCalSuggest = (() => {
      const CUR_WEEK_MIN = '2026-W33';   // first week priced entirely at 1.00
      const out = { basis: `projBiasByWeek from ${CUR_WEEK_MIN} (post-fix pricing only)`, current: BATTER_PROJ_CAL, markets: [] };
      for (const mk of ['HRR', 'TB']) {
        const wks = projBiasByWeek.filter((w) => w.market === mk && w.week >= CUR_WEEK_MIN && w.avgProj > 0);
        const n = wks.reduce((s, w) => s + w.n, 0);
        if (!n) { out.markets.push({ market: mk, n: 0, note: 'no graded rows on the current pricing yet' }); continue; }
        const k = wks.reduce((s, w) => s + w.n * (w.avgActual / w.avgProj), 0) / n;
        const cur = mk === 'HRR' ? BATTER_PROJ_CAL.hrr : BATTER_PROJ_CAL.tb;
        out.markets.push({
          market: mk, n,
          avgProj: round2(wks.reduce((s, w) => s + w.n * w.avgProj, 0) / n),
          avgActual: round2(wks.reduce((s, w) => s + w.n * w.avgActual, 0) / n),
          k: round2(k),
          current: cur,
          suggestedFull: round2(cur * k),
          suggestedAt85: round2(cur * (1 + 0.85 * (k - 1))),
          direction: k > 1 ? 'raise (under-projecting)' : k < 1 ? 'lower (over-projecting)' : 'hold',
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
};
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
const TEAM_ABBR_BY_NAME = {
  'Arizona Diamondbacks': 'ARI', 'Atlanta Braves': 'ATL', 'Baltimore Orioles': 'BAL',
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
const NFL_GAMELINE_POOL = ['pinnacle', 'lowvig', 'betonlineag'];
const NFL_EXEC = ['draftkings', 'fanduel', 'betmgm', 'betrivers', 'williamhill_us'];

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
      const reg = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM nfl_lines WHERE season_type='REG' AND commence > ?"
      ).bind(new Date().toISOString()).first();
      type = (reg && reg.n > 0) ? 'REG' : 'PRE';
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

      // Fair from the sharp pool only, Shin de-vigged per book then medianed.
      // Two books minimum: one book's number is that book's opinion, not a fair
      // line, and it can never be checked against a second source.
      const fairs = [];
      const usedBooks = [];
      for (const bk of NFL_GAMELINE_POOL) {
        const pa = g.h2h[a] && g.h2h[a][bk];
        const pb = g.h2h[b] && g.h2h[b][bk];
        if (typeof pa !== 'number' || typeof pb !== 'number') continue;
        const f = shinDevig(pa, pb);
        if (f != null && isFinite(f)) { fairs.push(f); usedBooks.push(bk); }
      }
      const sharpN = fairs.length;
      const fair = sharpN >= 2 ? median(fairs) : null;
      const fairSrc = sharpN >= 2 ? 'gameline-pool' : 'MKT';

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
        fairSrc, sharpN, fairBooks: usedBooks,
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
    out.empty = out.games.length === 0;
    out.postable = 0;   // no player props on the wire -> nothing is postable yet
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

    const byTeam = {};
    for (const [pid, p] of Object.entries(pri.players)) {
      // Week-1 carry-over rule: only a player still on the team he earned the
      // prior with is eligible. Movers and rookies wait for current-season reps.
      if (p.status !== 'same-team') continue;
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

        for (const p of roster) {
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
    out.note = 'projections only — no book quotes NFL player props through our feed, '
      + 'so nothing here is priced, graded or postable';
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
async function recordOddsUsage(env, res, route) {
  try {
    if (!env || !env.DB || !res || !res.headers) return;
    const rem = parseInt(res.headers.get('x-requests-remaining') || '', 10);
    const last = parseInt(res.headers.get('x-requests-last') || '', 10);
    if (!Number.isFinite(rem)) return;
    await ensureUsageSchema(env.DB);
    const now = new Date().toISOString();
    const day = now.slice(0, 10);
    const cost = Number.isFinite(last) ? last : 0;
    const blind = Number.isFinite(last) ? 0 : 1;
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
  } catch (e) { /* telemetry is never worth an error */ }
}

// GET /api/usage — reads the stored numbers only. Costs nothing upstream, which
// is the point: checking the quota must not consume the quota.
async function oddsUsage(env) {
  const out = { note: 'read from stored response headers — this endpoint makes no upstream call' };
  if (!env || !env.DB) { out.error = 'no DB binding'; return cors(json(out, 30)); }
  try {
    await ensureUsageSchema(env.DB);
    const rows = (await env.DB.prepare(
      'SELECT day, remaining, low, calls, updated_at FROM odds_usage ORDER BY day DESC LIMIT 14'
    ).all()).results || [];
    out.days = rows;
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
      if (typeof spent !== 'number' || spent < 0) return { day, metered, blind, spent: null, note: 'day not closed — no burn to compare' };
      return { day, metered, blind, spent, unattributed: spent - metered,
        note: Math.abs(spent - metered) <= Math.max(20, spent * 0.05)
          ? 'ledger accounts for the burn'
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
