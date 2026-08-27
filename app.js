(function () {
  'use strict';

  // ---------------------------------------------------------------------
  // DATA LAYER — mock data shaped like the real feeds it stands in for. Used
  // only offline (file:// / localhost); the deployed site pulls live data from:
  //   - MLB StatsAPI (schedule, scores, season stats, transactions)
  //   - The Odds API (DraftKings + FanDuel lines: strikeouts, batter props, h2h)
  // The model (projections, edges, tiers, percentiles) is computed in worker.js.
  // Keep the shape of each object identical and the rest of this file
  // (filtering, sorting, compare mode, theming) needs no changes.
  // ---------------------------------------------------------------------

  const RAW_GAMES = [
    { id: 'g1', matchup: 'DET @ LAD', subline: 'Skubal v. Yamamoto · 7:10 PT', time: 1, pick: 'Skubal O 6.5 Ks', odds: -115, edge: 5.8, interval: '5.6 – 9.1', tier: 1, weather: 'Out wind 6mph · Park +3% Ks', weatherTone: 'positive',
      stats: [ { label: 'CSW%', value: 94, tone: 'hot' }, { label: 'Whiff%', value: 91, tone: 'hot' }, { label: 'Opp Chase', value: 78, tone: 'warm' } ],
      ml: { pick: 'LAD ML', teamAbbr: 'LAD', winProb: 71, price: -225, edge: 4.2, tier: 1, homeAbbr: 'LAD', awayAbbr: 'DET', homeWinProb: 71, awayWinProb: 29 },
      rl: { pick: 'LAD -1.5', teamAbbr: 'LAD', side: 'fav', point: -1.5, price: -115, edge: 4.5, tier: 1, modelAgrees: true, fairSource: 'pinnacle', homeAbbr: 'LAD', awayAbbr: 'DET', homePoint: -1.5, awayPoint: 1.5, homePrice: -115, awayPrice: -105, homeCoverPct: 58, awayCoverPct: 42, homeEdge: 4.5, awayEdge: -2.0, modelFavAbbr: 'LAD', modelFavPct: 71 } },
    { id: 'g2', matchup: 'NYY @ HOU', subline: 'Cole v. Valdez · 5:10 PT', time: 3, pick: 'Valdez U 5.5 Ks', odds: 102, edge: 3.4, interval: '3.1 – 6.2', tier: 2, weather: 'Roof closed · Neutral park', weatherTone: 'textDim',
      stats: [ { label: 'CSW%', value: 82, tone: 'warm' }, { label: 'Whiff%', value: 77, tone: 'warm' }, { label: 'Opp Chase', value: 61, tone: 'warm' } ],
      ml: { pick: 'HOU ML', teamAbbr: 'HOU', winProb: 64, price: -166, edge: 3.1, tier: 2, homeAbbr: 'HOU', awayAbbr: 'NYY', homeWinProb: 64, awayWinProb: 36 },
      rl: { pick: 'NYY +1.5', teamAbbr: 'NYY', side: 'dog', point: 1.5, price: -140, edge: 2.2, tier: 'pass', modelAgrees: false, fairSource: 'pinnacle', homeAbbr: 'HOU', awayAbbr: 'NYY', homePoint: -1.5, awayPoint: 1.5, homePrice: 120, awayPrice: -140, homeCoverPct: 55, awayCoverPct: 45, homeEdge: -1.0, awayEdge: 2.2, modelFavAbbr: 'HOU', modelFavPct: 64 } },
    { id: 'g3', matchup: 'BOS @ TOR', subline: 'Bello v. Gausman · 4:07 PT', time: 2, pick: 'Bello U 4.5 Ks', odds: -120, edge: 4.6, interval: '2.8 – 5.5', tier: 1, weather: 'Roof closed · Neutral park', weatherTone: 'textDim',
      stats: [ { label: 'CSW%', value: 88, tone: 'hot' }, { label: 'Whiff%', value: 85, tone: 'hot' }, { label: 'Opp Chase', value: 70, tone: 'warm' } ],
      ml: { pick: 'TOR ML', teamAbbr: 'TOR', winProb: 55, price: -122, edge: 1.8, tier: 3, homeAbbr: 'TOR', awayAbbr: 'BOS', homeWinProb: 55, awayWinProb: 45 },
      rl: { pick: 'TOR -1.5', teamAbbr: 'TOR', side: 'fav', point: -1.5, price: 130, edge: 1.5, tier: 3, modelAgrees: true, fairSource: 'pinnacle', homeAbbr: 'TOR', awayAbbr: 'BOS', homePoint: -1.5, awayPoint: 1.5, homePrice: 130, awayPrice: -160, homeCoverPct: 44, awayCoverPct: 56, homeEdge: 1.5, awayEdge: -3.0, modelFavAbbr: 'TOR', modelFavPct: 55 } },
    { id: 'g4', matchup: 'ATL @ PHI', subline: 'Wheeler v. Sale · 4:05 PT', time: 2, pick: 'Wheeler O 7.5 Ks', odds: -108, edge: 2.1, interval: '5.9 – 9.4', tier: 2, weather: 'In wind 9mph · Park −2% Ks', weatherTone: 'warm',
      stats: [ { label: 'CSW%', value: 79, tone: 'warm' }, { label: 'Whiff%', value: 73, tone: 'warm' }, { label: 'Opp Chase', value: 55, tone: 'cool' } ],
      ml: { pick: 'PHI ML', teamAbbr: 'PHI', winProb: 59, price: -135, edge: 2.4, tier: 3, homeAbbr: 'PHI', awayAbbr: 'ATL', homeWinProb: 59, awayWinProb: 41 },
      rl: { pick: null, teamAbbr: null, side: null, point: null, price: null, edge: null, tier: 'pass', modelAgrees: false, fairSource: 'pinnacle', homeAbbr: 'PHI', awayAbbr: 'ATL', homePoint: -1.5, awayPoint: 1.5, homePrice: -150, awayPrice: 130, homeCoverPct: 57, awayCoverPct: 43, homeEdge: -0.5, awayEdge: -1.2, modelFavAbbr: 'PHI', modelFavPct: 59 } },
    { id: 'g5', matchup: 'MIL @ CHC', subline: 'Peralta v. Imanaga · 5:20 PT', time: 4, pick: 'Peralta O 6.5 Ks', odds: -102, edge: 1.2, interval: '4.6 – 8.2', tier: 3, weather: 'Wrigley crosswind · High variance', weatherTone: 'warm',
      stats: [ { label: 'CSW%', value: 68, tone: 'warm' }, { label: 'Whiff%', value: 64, tone: 'warm' }, { label: 'Opp Chase', value: 50, tone: 'cool' } ],
      ml: { pick: 'CHC ML', teamAbbr: 'CHC', winProb: 53, price: -110, edge: 0.9, tier: 'pass', homeAbbr: 'CHC', awayAbbr: 'MIL', homeWinProb: 53, awayWinProb: 47 },
      rl: { pick: null, teamAbbr: null, side: null, point: null, price: null, edge: null, tier: 'pass', modelAgrees: false, fairSource: 'none', homeAbbr: 'CHC', awayAbbr: 'MIL', homePoint: -1.5, awayPoint: 1.5, homePrice: -105, awayPrice: -115, homeCoverPct: null, awayCoverPct: null, homeEdge: null, awayEdge: null, modelFavAbbr: 'CHC', modelFavPct: 53 } },
    { id: 'g6', matchup: 'SD @ SF', subline: 'Cease v. Webb · 6:45 PT', time: 5, pick: 'No edge — pass', odds: null, edge: -0.6, interval: '4.4 – 8.0', tier: 'pass', weather: 'Marine layer · Park −4% Ks', weatherTone: 'positive',
      stats: [ { label: 'CSW%', value: 61, tone: 'cool' }, { label: 'Whiff%', value: 58, tone: 'cool' }, { label: 'Opp Chase', value: 44, tone: 'cool' } ],
      ml: { pick: 'SF ML', teamAbbr: 'SF', winProb: 54, price: null, edge: -0.4, tier: 'pass', homeAbbr: 'SF', awayAbbr: 'SD', homeWinProb: 54, awayWinProb: 46 } },
  ];

  const TONE_COLOR = { hot: 'var(--danger)', warm: 'var(--warm)', cool: 'var(--positive)' };
  const clampPct = (v) => Math.max(0, Math.min(100, v)); // bar width, 0–100
  // Tier shown as a compact letter+number heat chip (T1 brightest = strongest
  // lean) instead of stars — far easier to read at a glance across the board.
  // A posted play, whichever regime produced it: the batter board now emits
  // 'play', while K props and the run line still emit 1/2/3. Defined once so the
  // two never drift apart.
  const isPlayTier = (t) => t === 'play' || ['1', '2', '3'].includes(String(t));

  function tierChip(tierVal) {
    const v = String(tierVal);
    // The batter board no longer ranks — nothing in the graded record orders the
    // plays, so it says play or pass and stops there. K props and the run line
    // still rank, and keep the numeric chips.
    if (v === 'play') return `<span class="tier-chip play">Play</span>`;
    // The run line stops ranking too, but it posts nothing, so its positive case
    // is a lean rather than a play -- calling it Play would contradict that
    // board own banner, which says it is not posted and not graded.
    if (v === 'lean') return `<span class="tier-chip lean">Lean</span>`;
    if (v === '1' || v === '2' || v === '3') return `<span class="tier-chip t${v}">T${v}</span>`;
    if (v === 'pass') return `<span class="tier-chip pass">Pass</span>`;
    return `<span class="tier-dash">—</span>`; // 'model'/projection-only: no line to grade yet
  }

  // Honest reason a row has no price/edge, from the game's real status + time.
  // A blank cell should say WHY it's blank, never look broken.
  function projReason(g) {
    if (g.status === 'Live') return 'in play · line closed';
    if (g.status === 'Final') return 'final · line closed';
    // A projection-only row during a feed outage has no line because we cannot
    // read one, not because no book has posted. "awaiting line" would blame the
    // sportsbooks for our outage and imply a price is on its way.
    //
    // When the whole board is in that state the banner above says it once, so the
    // cell holds a quiet dash instead: forty rows repeating one sentence is the
    // same fact printed forty times, and it crowds out the projection that is the
    // reason the row is still on screen. A mixed board keeps the per-row reason,
    // where it distinguishes this row from the priced one above it.
    if (g.tier === 'model' && state.feedError) return batterModelOnly() ? '—' : 'no price · feed down';
    if (g.timeMs && g.timeMs - Date.now() > 12 * 3600 * 1000) return 'posts game-day AM';
    return 'awaiting line';
  }

  const INJURY_ALERTS = [
    { text: 'Yamamoto (LAD) removed from bullpen availability tonight — no impact on start.', time: '6:42 PM' },
    { text: 'Padres OF Fernando Tatis Jr. is a late scratch (back tightness) — lineup shifted.', time: '6:15 PM' },
  ];

  const HOT_HITTERS = [
    { name: 'A. Judge', team: 'NYY · RF', woba: '.512', streak: '11-game hit streak', hrs: 6, lhp: 402, rhp: 425 },
    { name: 'S. Ohtani', team: 'LAD · DH', woba: '.489', streak: '9-game hit streak', hrs: 5, lhp: 388, rhp: 401 },
    { name: 'B. Witt Jr.', team: 'KC · SS', woba: '.461', streak: '.410 AVG L10', hrs: 4, lhp: 355, rhp: 372 },
    { name: 'J. Chisholm Jr.', team: 'NYY · 2B', woba: '.447', streak: '6-game hit streak', hrs: 3, lhp: 298, rhp: 361 },
    { name: 'G. Stanton', team: 'NYY · DH', woba: '.431', streak: '7 XBH in L10', hrs: 4, lhp: 365, rhp: 340 },
    { name: 'C. Raleigh', team: 'SEA · C', woba: '.419', streak: '5-game hit streak', hrs: 4, lhp: 312, rhp: 355 },
    { name: 'F. Freeman', team: 'LAD · 1B', woba: '.408', streak: '.395 AVG L10', hrs: 2, lhp: 340, rhp: 348 },
    { name: 'K. Tucker', team: 'CHC · RF', woba: '.401', streak: '8-game hit streak', hrs: 3, lhp: 330, rhp: 342 },
    { name: 'J. Ramírez', team: 'CLE · 3B', woba: '.394', streak: '6 XBH in L10', hrs: 3, lhp: 322, rhp: 335 },
    { name: 'W. Contreras', team: 'MIL · C', woba: '.388', streak: '7-game hit streak', hrs: 2, lhp: 288, rhp: 330 },
  ];

  // vsL / vsR = opponent wOBA-against by batter handedness (lower = better).
  const HOT_PITCHERS = [
    { name: 'T. Skubal', team: 'DET · LHP', csw: 34.1, kRate: '12.4', era: '2.61', vsL: 258, vsR: 289 },
    { name: 'P. Skenes', team: 'PIT · RHP', csw: 33.6, kRate: '11.8', era: '2.02', vsL: 271, vsR: 244 },
    { name: 'Y. Yamamoto', team: 'LAD · RHP', csw: 31.2, kRate: '10.6', era: '3.08', vsL: 295, vsR: 268 },
    { name: 'G. Crochet', team: 'BOS · LHP', csw: 30.8, kRate: '11.1', era: '2.84', vsL: 262, vsR: 301 },
    { name: 'Z. Wheeler', team: 'PHI · RHP', csw: 30.1, kRate: '10.3', era: '2.71', vsL: 288, vsR: 275 },
    { name: 'C. Sale', team: 'ATL · LHP', csw: 29.7, kRate: '10.9', era: '3.15', vsL: 279, vsR: 312 },
    { name: 'L. Gilbert', team: 'SEA · RHP', csw: 29.2, kRate: '9.8', era: '3.22', vsL: 318, vsR: 284 },
    { name: 'H. Bello', team: 'BOS · RHP', csw: 28.6, kRate: '9.1', era: '3.34', vsL: 322, vsR: 297 },
    { name: 'F. Valdez', team: 'HOU · LHP', csw: 27.9, kRate: '8.7', era: '3.02', vsL: 290, vsR: 331 },
    { name: 'K. Gausman', team: 'TOR · RHP', csw: 27.3, kRate: '9.4', era: '3.41', vsL: 335, vsR: 308 },
  ];

  const CALIBRATION_BUCKETS = [
    { predicted: 10, actual: 12, n: 84 },
    { predicted: 20, actual: 18, n: 112 },
    { predicted: 30, actual: 33, n: 96 },
    { predicted: 40, actual: 38, n: 121 },
    { predicted: 50, actual: 52, n: 140 },
    { predicted: 60, actual: 57, n: 133 },
    { predicted: 70, actual: 74, n: 108 },
    { predicted: 80, actual: 79, n: 91 },
    { predicted: 90, actual: 86, n: 67 },
  ];

  // ---------------------------------------------------------------------
  // STATE
  // ---------------------------------------------------------------------

  // One definition, read by both the poll timer and the banner's countdown. Two
  // numbers here drift apart and the banner promises a retry that isn't coming.
  const BATTER_POLL_MS = 300000;
  const RETRY_COOLDOWN_MS = 30000;

  const state = {
    sport: 'mlb',
    nfl: null,
    nflOpen: null,
    nflView: 'receiving',
    nflProps: null,
    nflShowAll: false,
    feedError: null,
    // When the current outage started, when the next automatic retry lands, and
    // when a manual retry is allowed again. The banner reports all three, so a
    // reader can tell a blip from a sustained outage and knows something is
    // already happening without clicking anything.
    feedOutageSince: null,
    feedNextRetry: null,
    feedRetryAllowedAt: 0,
    nflFilter: 'all',
    nflSort: 'proj',
    nflSortAsc: false,
    nflSearch: '',
    batterShowPass: false,
    theme: 'dark',
    filter: 'all',
    sortBy: 'edge',
    sortDir: null, // null = the key's natural default (see SORT_DEFAULT_DIR)
    expandedId: null,
    tracked: {},
    compareMode: false,
    compareIds: [],
    hitterCompareMode: false,
    hitterCompareIds: [],
    pitcherCompareMode: false,
    pitcherCompareIds: [],
    searchQuery: '',
    winProb: 64,
    tickerScores: { g1: '0-0', g2: '2-1', g3: '0-2', g4: '3-3', g5: '1-0', g6: '0-0' },
    // Live feeds (null until the proxy returns data; each falls back to mock).
    liveTicker: null,
    liveHitters: null,
    livePitchers: null,
    liveBoard: null,
    liveBatters: null,
    liveNow: null,
    trackRecord: null,
    liveInjuries: null,
    injBarOpen: false,       // mobile injury bar collapsed by default
    injBarFilter: 'rel',     // 'rel' (in your picks) | 'all'
    alertsOpen: false,       // lineup-alerts bar collapsed by default
    injShowNoImpact: false,  // reveal the "no board impact" alerts
    injShowAllImpact: false, // reveal impact alerts beyond the first few
    injuriesFetchedAt: null, // ms timestamp of the last injuries fetch (for "updated Xm ago")
    ycOpen: false,           // "Yesterday's Card" collapsed by default — keeps the board up top
    boardView: 'batter', // 'batter' (Under Plays — the default) | 'kprops' | 'moneyline' | 'runline'
    slip: {},   // legId -> { id, board, matchup, pick, odds, tier }
    stake: 1,   // units per bet
    quotaRemaining: null,
  };

  // Real data when the feed has loaded. The built-in samples are ONLY for the
  // offline demo (file:// / localhost) — on the live site an empty/failed feed
  // shows an honest empty state, never fabricated data dressed up as real.
  const getHitters = () => (state.liveHitters && state.liveHitters.length ? state.liveHitters : (LIVE_MODE ? [] : HOT_HITTERS));
  const getPitchers = () => (state.livePitchers && state.livePitchers.length ? state.livePitchers : (LIVE_MODE ? [] : HOT_PITCHERS));
  const boardIsLive = () => !!(state.liveBoard && state.liveBoard.length);
  const isML = () => state.boardView === 'moneyline';
  const isBatter = () => state.boardView === 'batter';
  const isRL = () => state.boardView === 'runline';
  const battersLive = () => !!(state.liveBatters && state.liveBatters.length);
  // Whether the active view's feed hasn't returned yet (vs. returned empty).
  const isFeedLoading = () => (isBatter() ? state.liveBatters : state.liveBoard) === null;
  // The rows for the active view: batter props come from their own feed.
  const getGames = () => {
    if (isBatter()) return state.liveBatters || [];
    return boardIsLive() ? state.liveBoard : (LIVE_MODE ? [] : RAW_GAMES);
  };
  // A row's tier/edge for the active view. Batter + K-props both read g.tier/edge;
  // moneyline reads the nested ml object.
  const activeTier = (g) => isML() ? (g.ml ? g.ml.tier : 'model') : isRL() ? (g.rl ? g.rl.tier : 'pass') : g.tier;
  const activeEdge = (g) => isML() ? (g.ml ? g.ml.edge : null) : isRL() ? (g.rl ? g.rl.edge : null) : g.edge;
  // "Modeled" = the active board carries real market tiers, so tier filters +
  // edge sort are meaningful.
  const boardHasLive = () => isBatter() ? battersLive() : boardIsLive();
  const boardModeled = () => isRL()
    ? boardIsLive() && getGames().some((g) => g.rl && g.rl.edge != null) // real Pinnacle run line -> show tier/Pass controls
    : boardHasLive() && getGames().some((g) => isPlayTier(activeTier(g)));

  // How to reach the Odds API proxy. Empty => mock-only mode.
  //   "same-origin" (or "/") => Cloudflare Pages Functions at /api/* on this
  //                             origin (recommended — no CORS).
  //   full URL                => a separately-hosted proxy Worker.
  // Auto-detect: when the page is served over http(s) from a real host (i.e.
  // the deployed Worker), default to same-origin /api/* so live data works with
  // no config edit. Only file:// or localhost stays in built-in mock mode,
  // unless AIMPLIFIED_API_BASE is set explicitly.
  const rawBaseRaw = (window.AIMPLIFIED_API_BASE || '').trim();
  const isServed = /^https?:$/.test(location.protocol)
    && !/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/.test(location.hostname);
  const rawBase = rawBaseRaw.length > 0 ? rawBaseRaw : (isServed ? 'same-origin' : '');
  const LIVE_MODE = rawBase.length > 0;
  const API_BASE = (rawBase === 'same-origin' || rawBase === '/')
    ? ''
    : rawBase.replace(/\/$/, '');

  // The Odds API returns full team names; the ticker shows abbreviations.
  const TEAM_ABBR = {
    'Arizona Diamondbacks': 'ARI', 'Atlanta Braves': 'ATL', 'Baltimore Orioles': 'BAL',
    'Boston Red Sox': 'BOS', 'Chicago Cubs': 'CHC', 'Chicago White Sox': 'CWS',
    'Cincinnati Reds': 'CIN', 'Cleveland Guardians': 'CLE', 'Colorado Rockies': 'COL',
    'Detroit Tigers': 'DET', 'Houston Astros': 'HOU', 'Kansas City Royals': 'KC',
    'Los Angeles Angels': 'LAA', 'Los Angeles Dodgers': 'LAD', 'Miami Marlins': 'MIA',
    'Milwaukee Brewers': 'MIL', 'Minnesota Twins': 'MIN', 'New York Mets': 'NYM',
    'New York Yankees': 'NYY', 'Oakland Athletics': 'OAK', 'Athletics': 'ATH',
    'Philadelphia Phillies': 'PHI', 'Pittsburgh Pirates': 'PIT', 'San Diego Padres': 'SD',
    'San Francisco Giants': 'SF', 'Seattle Mariners': 'SEA', 'St. Louis Cardinals': 'STL',
    'Tampa Bay Rays': 'TB', 'Texas Rangers': 'TEX', 'Toronto Blue Jays': 'TOR',
    'Washington Nationals': 'WSH',
  };
  const abbr = (name) => TEAM_ABBR[name] || (name || '').split(' ').pop().slice(0, 3).toUpperCase();
  const americanOdds = (n) => (typeof n === 'number' ? (n > 0 ? '+' + n : String(n)) : '—');
  const timeLabel = (iso) => {
    try {
      return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' }).format(new Date(iso)) + ' PT';
    } catch (e) { return ''; }
  };

  try {
    const savedSlip = JSON.parse(localStorage.getItem('aimplified_slip') || '{}');
    if (savedSlip && typeof savedSlip === 'object') state.slip = savedSlip;
  } catch (e) {}
  try {
    const s = parseFloat(localStorage.getItem('aimplified_stake'));
    if (s > 0) state.stake = s;
  } catch (e) {}
  try {
    const savedTheme = localStorage.getItem('aimplified_theme');
    if (savedTheme === 'dark' || savedTheme === 'light') state.theme = savedTheme;
  } catch (e) {}

  function esc(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------------------------------------------------------------------
  // DOM refs
  // ---------------------------------------------------------------------

  const el = {
    themeToggle: document.querySelector('.theme-toggle'),
    ticker: document.getElementById('ticker'),
    winProbFill: document.getElementById('winProbFill'),
    winProbPct: document.getElementById('winProbPct'),
    heroEyebrow: document.getElementById('heroEyebrow'),
    heroTitle: document.getElementById('heroTitle'),
    heroDuel: document.getElementById('heroDuel'),
    injuryAlerts: document.getElementById('injuryAlerts'),
    injuryBar: document.getElementById('injuryBar'),
    yesterdayCard: document.getElementById('yesterdayCard'),
    slateSummary: document.getElementById('slateSummary'),
    nflBoard: document.getElementById('nflBoard'),
    nflBannerTag: document.getElementById('nflBannerTag'),
    nflBannerBody: document.getElementById('nflBannerBody'),
    nflBoardTitle: document.getElementById('nflBoardTitle'),
    nflCount: document.getElementById('nflCount'),
    nflPostable: document.getElementById('nflPostable'),
    nflGrid: document.getElementById('nflGrid'),
    passMore: document.getElementById('passMore'),
    nflStrip: document.getElementById('nflStrip'),
    nflEmpty: document.getElementById('nflEmpty'),
    nflFoot: document.getElementById('nflFoot'),
    liveNowSection: document.getElementById('liveNow'),
    liveNowGrid: document.getElementById('liveNowGrid'),
    liveNowNote: document.getElementById('liveNowNote'),
    liveNowDots: document.getElementById('liveNowDots'),
    navLive: document.getElementById('navLive'),
    gameCount: document.getElementById('gameCount'),
    trackedPill: document.getElementById('trackedPill'),
    searchInput: document.getElementById('searchInput'),
    compareModeBtn: document.getElementById('compareModeBtn'),
    compareHint: document.getElementById('compareHint'),
    boardRows: document.getElementById('boardRows'),
    boardHead: document.getElementById('boardHead'),
    noResults: document.getElementById('noResults'),
    comparePanel: document.getElementById('comparePanel'),
    hitterCompareModeBtn: document.getElementById('hitterCompareModeBtn'),
    hitterCompareHint: document.getElementById('hitterCompareHint'),
    hittersGrid: document.getElementById('hittersGrid'),
    hitterComparePanel: document.getElementById('hitterComparePanel'),
    splitRows: document.getElementById('splitRows'),
    pitchersGrid: document.getElementById('pitchersGrid'),
    pitcherCompareModeBtn: document.getElementById('pitcherCompareModeBtn'),
    pitcherCompareHint: document.getElementById('pitcherCompareHint'),
    pitcherComparePanel: document.getElementById('pitcherComparePanel'),
    pitcherSplitRows: document.getElementById('pitcherSplitRows'),
    calibrationPoints: document.getElementById('calibrationPoints'),
    calibrationVerdict: document.getElementById('calibrationVerdict'),
    calibrationTiers: document.getElementById('calibrationTiers'),
    proofStrip: document.getElementById('proofStrip'),
    kCtxBanner: document.getElementById('kCtxBanner'),
    eraNote: document.getElementById('eraNote'),
    tabnote: document.querySelector('.tabnote'),
    trkNote: document.getElementById('trkNote'),
    trkLabel1: document.getElementById('trkLabel1'),
    trkLabel2: document.getElementById('trkLabel2'),
    trkLabel3: document.getElementById('trkLabel3'),
    trkLabel4: document.getElementById('trkLabel4'),
    trkVal1: document.getElementById('trkVal1'),
    trkVal2: document.getElementById('trkVal2'),
    trkVal3: document.getElementById('trkVal3'),
    trkVal4: document.getElementById('trkVal4'),
    trkAggregate: document.getElementById('trkAggregate'),
    clvChipText: document.getElementById('clvChipText'),
    whyTitle: document.getElementById('whyTitle'),
    whyBody: document.getElementById('whyBody'),
    whyStats: document.getElementById('whyStats'),
    pinNote: document.getElementById('pinNote'),
    slip: document.getElementById('slip'),
    slipCount: document.getElementById('slipCount'),
    slipClearBtn: document.getElementById('slipClearBtn'),
    roiCard: document.getElementById('roiCard'),
    roiStats: document.getElementById('roiStats'),
    roiClvNote: document.getElementById('roiClvNote'),
    roiChart: document.getElementById('roiChart'),
    roiChartCap: document.getElementById('roiChartCap'),
    roiTables: document.getElementById('roiTables'),
  };

  // ---------------------------------------------------------------------
  // RENDER
  // ---------------------------------------------------------------------

  function renderTheme() {
    document.documentElement.dataset.theme = state.theme;
    el.themeToggle.textContent = state.theme === 'dark' ? 'Light mode' : 'Dark mode';
  }

  function renderTicker() {
    if (!el.ticker) return; // score ticker removed from the layout — no-op
    // Live feed from the Odds API proxy. The mock ticker is offline-demo only —
    // in live mode an empty feed leaves the ticker empty, never fabricated games.
    const items = state.liveTicker && state.liveTicker.length
      ? state.liveTicker
      : (LIVE_MODE ? [] : RAW_GAMES.map((g) => ({
          matchup: g.matchup,
          score: state.tickerScores[g.id] || '0-0',
          oddsLabel: g.tier === 'pass' ? 'PASS' : americanOdds(g.odds),
        })));
    el.ticker.innerHTML = items.map((it) =>
      `<span class="tick-item"><span class="live-dot"></span><b>${esc(it.matchup)}</b><span class="score">${esc(it.score)}</span><span class="odds">${esc(it.oddsLabel)}</span></span>`
    ).join('');
  }

  // ---------------------------------------------------------------------
  // LIVE DATA — The Odds API, via the proxy Worker (worker/worker.js).
  // Merges live scores + moneyline odds into the ticker. Everything else
  // stays on the documented mock layer until premium markets are enabled.
  // ---------------------------------------------------------------------

  // Loading the page with ?nofetch=1 makes every API call it fires dry too.
  //
  // Without this the guard covered only hand-made calls to /api/*, and missed the
  // path that actually burns credits: an uncached page load fans out to four
  // endpoints, and the batters call alone is markets x regions x games. A guard
  // that does not cover the main consumer is not a guard.
  const DRY_RUN = new URLSearchParams(location.search).get('nofetch') === '1';
  async function fetchJson(path) {
    const p = DRY_RUN ? path + (path.includes('?') ? '&' : '?') + 'nofetch=1' : path;
    const resp = await fetch(API_BASE + p, { headers: { accept: 'application/json' } });
    const remaining = resp.headers.get('x-requests-remaining');
    if (remaining !== null && remaining !== '') state.quotaRemaining = remaining;
    if (!resp.ok) throw new Error(`${path} -> ${resp.status}`);
    return resp.json();
  }

  function homeMoneyline(event) {
    const book = (event.bookmakers || [])[0];
    if (!book) return null;
    const h2h = (book.markets || []).find((m) => m.key === 'h2h');
    if (!h2h) return null;
    const outcome = (h2h.outcomes || []).find((o) => o.name === event.home_team);
    return outcome ? outcome.price : null;
  }

  function scoreFor(event, teamName) {
    const s = (event.scores || []).find((x) => x.name === teamName);
    return s ? s.score : '0';
  }

  async function refreshLiveData() {
    if (!LIVE_MODE) return;
    try {
      const [scores, odds] = await Promise.all([
        fetchJson('/api/scores').catch(() => []),
        fetchJson('/api/odds').catch(() => []),
      ]);
      const oddsById = {};
      (Array.isArray(odds) ? odds : []).forEach((e) => { oddsById[e.id] = e; });

      const source = Array.isArray(scores) && scores.length ? scores
        : (Array.isArray(odds) ? odds : []);

      const ticker = source.map((e) => {
        const away = e.away_team, home = e.home_team;
        const oddsEvent = oddsById[e.id] || e;
        const ml = homeMoneyline(oddsEvent);
        const hasScore = Array.isArray(e.scores) && e.scores.length;
        return {
          matchup: `${abbr(away)} @ ${abbr(home)}`,
          score: hasScore ? `${scoreFor(e, away)}-${scoreFor(e, home)}` : '0-0',
          oddsLabel: ml !== null ? americanOdds(ml) : '—',
        };
      });

      if (ticker.length) {
        state.liveTicker = ticker;
        renderTicker();
      }
    } catch (e) {
      // Network/quota error — keep whatever's on screen (mock or last live).
      console.warn('Live data refresh failed:', e.message);
    }
  }

  // Tonight's board — real matchups + the projected-K model priced against
  // real strikeout lines (/api/board). Falls back to the Odds-API slate.
  // Polled slower than the ticker because props cost API credits.
  async function refreshBoard() {
    if (!LIVE_MODE) return;
    try {
      const [apiBoard, scores, odds] = await Promise.all([
        fetchJson('/api/board').catch(() => []),
        fetchJson('/api/scores').catch(() => []),
        fetchJson('/api/odds').catch(() => []),
      ]);

      let board = [];
      if (Array.isArray(apiBoard) && apiBoard.length) {
        board = apiBoard.map((b) => {
          const names = b.pitcherNames && b.pitcherNames.length ? b.pitcherNames.join(' v. ') : 'Pitchers TBD';
          const scorePart = b.score ? `${b.status === 'Final' ? 'Final' : 'Live'} ${b.score}` : '';
          const subline = [names, b.timeLabel, scorePart].filter(Boolean).join(' · ');
          return {
            id: b.id,
            matchup: b.matchup,
            subline,
            time: b.timeMs || 0,
            status: b.status,
            timeLabel: b.timeLabel,
            pick: b.pick,
            odds: b.odds,
            oddsBooks: b.oddsBooks || null,
            edge: b.edge,
            interval: b.interval,
            tier: b.tier,
            weather: '', weatherTone: 'textDim',
            stats: [],
            scorePart,
            projRows: b.pitchers || [],
            ml: b.ml || null,
            // The run line was computed by the Worker and dropped here, so
            // getFilteredSortedGames' `isRL() && g.rl == null` test discarded
            // every row and the view rendered empty. That is why it had no tab.
            rl: b.rl || null,
          };
        }).sort((a, b) => a.time - b.time);
      } else {
        const oddsByHome = {};
        (Array.isArray(odds) ? odds : []).forEach((e) => { oddsByHome[e.home_team] = e; });
        board = (Array.isArray(scores) ? scores : [])
          .filter((e) => e.completed === false)
          .map((e) => {
            const oe = oddsByHome[e.home_team];
            const ml = oe ? homeMoneyline(oe) : null;
            const hasScore = Array.isArray(e.scores) && e.scores.length;
            const t = timeLabel(e.commence_time);
            const subline = hasScore
              ? `Live ${scoreFor(e, e.away_team)}-${scoreFor(e, e.home_team)}${t ? ' · ' + t : ''}`
              : (t ? `First pitch ${t}` : 'Scheduled');
            return {
              id: e.id,
              matchup: `${abbr(e.away_team)} @ ${abbr(e.home_team)}`,
              subline,
              time: Date.parse(e.commence_time) || 0,
              pick: '—', odds: ml, edge: null, interval: '—', tier: 'model',
              weather: '', weatherTone: 'textDim', stats: [],
            };
          })
          .sort((a, b) => a.time - b.time);
      }

      if (board.length) {
        const firstLoad = !state.liveBoard;
        state.liveBoard = board;
        if (firstLoad && !boardModeled()) state.filter = 'all';
        const ids = new Set(board.map((g) => g.id));
        state.compareIds = state.compareIds.filter((id) => ids.has(id));
        if (state.expandedId && !ids.has(state.expandedId)) state.expandedId = null;
        renderControls();
        renderBoard();
        renderComparePanel();
        renderHero();
        renderInjuryAlerts(); // board now known -> injury relevance can resolve
      }
    } catch (e) {
      console.warn('Board refresh failed:', e.message);
    }
  }

  // Real batter props (HR / total bases / H+R+RBI) from /api/batters. Rows are
  // reshaped to the board layout: the player is the "matchup" headline, the game
  // + time is the subline.
  async function refreshBatters() {
    if (!LIVE_MODE) return;
    try {
      // Accepts both shapes. The endpoint now returns { rows, feedError }, but a
      // worker and a client never deploy in the same instant — treating an array
      // as invalid would blank the board for the seconds in between.
      const payload = await fetchJson('/api/batters');
      const rows = Array.isArray(payload) ? payload : (payload && payload.rows);
      state.feedError = (payload && !Array.isArray(payload) && payload.feedError) || null;
      // Stamp the start of an outage once, not on every poll — otherwise "out for
      // N min" resets every five minutes and a six-hour outage never reads as one.
      // A dry run is not an outage: it is us declining to call, so it never starts
      // the clock.
      if (state.feedError && state.feedError.kind !== 'dry-run') {
        if (!state.feedOutageSince) state.feedOutageSince = Date.now();
      } else {
        state.feedOutageSince = null;
      }
      state.feedNextRetry = Date.now() + BATTER_POLL_MS;
      if (!Array.isArray(rows)) return;
      // Once a game starts the first-pitch time stops being the useful fact, so
      // the score replaces it — the same swap /api/board already does for the K
      // board. Scores are null on a Preview game, which is how "not started" is
      // told apart from a genuine 0-0.
      const scoreBit = (b) => {
        if (b.awayScore == null || b.homeScore == null) return null;
        const [away, home] = String(b.matchup || '').split('@').map((s) => s.trim());
        const state = b.status === 'Final' ? 'Final' : 'Live';
        return `${state} ${away} ${b.awayScore}–${home} ${b.homeScore}`;
      };
      const mapped = rows.map((b) => {
        const sc = scoreBit(b);
        return {
          ...b,
          matchup: b.name,
          // `matchup` becomes the player, so the game it belongs to would be lost
          // to the subline string. The group header needs it as a value.
          gameMatchup: b.matchup,
          subline: [b.matchup, sc || b.timeLabel].filter(Boolean).join(' · '),
          scorePart: sc,
          time: b.timeMs || 0,
        };
      });
      state.liveBatters = mapped;
      renderHero(); // the hero is now the top batter under
      if (isBatter()) {
        const ids = new Set(mapped.map((g) => g.id));
        if (state.expandedId && !ids.has(state.expandedId)) state.expandedId = null;
        // Chrome depends on the rows now: whether the board is priced or
        // projection-only decides which disclosure sits above it, and that is
        // only knowable once the payload lands.
        renderViewChrome();
        renderControls();
        renderBoard();
      }
    } catch (e) {
      console.warn('Batters refresh failed:', e.message);
    }
  }

  // Real season hitting leaders from MLB StatsAPI (via /api/hitters).
  async function refreshHitters() {
    if (!LIVE_MODE) return;
    try {
      const rows = await fetchJson('/api/hitters');
      if (Array.isArray(rows) && rows.length) {
        state.liveHitters = rows;
        // A live refresh can invalidate index-based compare selections.
        state.hitterCompareIds = state.hitterCompareIds.filter((i) => i < rows.length);
        renderHittersGrid();
        renderHitterComparePanel();
        renderSplits();
      }
    } catch (e) {
      console.warn('Hitters refresh failed:', e.message);
    }
  }

  // Real season pitching leaders from MLB StatsAPI (via /api/pitchers).
  async function refreshPitchers() {
    if (!LIVE_MODE) return;
    try {
      const rows = await fetchJson('/api/pitchers');
      if (Array.isArray(rows) && rows.length) {
        state.livePitchers = rows;
        state.pitcherCompareIds = state.pitcherCompareIds.filter((i) => i < rows.length);
        renderPitchers();
        renderPitcherComparePanel();
        renderPitcherSplits();
      }
    } catch (e) {
      console.warn('Pitchers refresh failed:', e.message);
    }
  }

  function renderWinProb() {
    // The old hero win-prob meter was replaced by the fade card; bail cleanly
    // if the elements aren't on the page.
    if (!el.winProbFill || !el.winProbPct) return;
    el.winProbFill.style.width = state.winProb + '%';
    el.winProbPct.textContent = state.winProb.toFixed(1) + '%';
  }

  // Teams that appear in a game we have a pick on tonight (non-pass tier on the
  // K-props board). Used to flag which injuries land in a game on your card.
  // null = board not loaded yet, so relevance is unknown (don't split).
  function actionTeamSet() {
    const games = boardIsLive() ? state.liveBoard : (LIVE_MODE ? null : RAW_GAMES);
    if (!Array.isArray(games) || !games.length) return null;
    const set = new Set();
    games.forEach((g) => {
      if (g.tier && g.tier !== 'pass') {
        const ml = g.ml || {};
        if (ml.awayAbbr) set.add(ml.awayAbbr);
        if (ml.homeAbbr) set.add(ml.homeAbbr);
      }
    });
    return set;
  }

  // Which of tonight's picks does this team touch? Returns the game + view + pick
  // label so an alert can link straight to it. Honest: only reports a real pick
  // (tier ≠ pass), never invents a numeric impact. Priority K-props → ML → RL.
  function boardPickForTeam(teamAbbr) {
    if (!teamAbbr) return null;
    const games = boardIsLive() ? state.liveBoard : (LIVE_MODE ? [] : RAW_GAMES);
    if (!Array.isArray(games)) return null;
    for (const g of games) {
      const parts = (g.matchup || '').split(' @ ');
      if (!parts.includes(teamAbbr)) continue;
      if (g.tier && g.tier !== 'pass' && g.pick && g.pick !== '—') return { id: g.id, view: 'kprops', pick: g.pick };
      if (g.ml && typeof g.ml.tier === 'number') return { id: g.id, view: 'moneyline', pick: g.ml.pick };
      return { id: g.id, view: 'kprops', pick: null }; // on the board, but no pick -> no impact
    }
    return null;
  }

  function ensureAlertStyle() {
    if (document.getElementById('ab2-style')) return;
    const s = document.createElement('style');
    s.id = 'ab2-style';
    s.textContent = `
      #injuryAlerts{display:block;} /* the old container was a 2-col grid — go full width */
      .ab2{border:1px solid var(--border);border-left:3px solid var(--danger);border-radius:12px;background:var(--board3,#0C1A26);overflow:hidden;}
      .ab2-rows{display:block;}
      .ab2-head{display:flex;align-items:center;gap:11px;padding:13px 16px;background:var(--board,#10202F);flex-wrap:wrap;}
      .ab2-dot{width:8px;height:8px;border-radius:99px;background:var(--danger);animation:ab2pulse 2s infinite;flex:none;}
      @keyframes ab2pulse{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--danger) 70%,transparent);}70%{box-shadow:0 0 0 7px transparent;}100%{box-shadow:0 0 0 0 transparent;}}
      .ab2-kicker{font-family:ui-monospace,monospace;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--danger);font-weight:700;}
      .ab2-badge{font-family:ui-monospace,monospace;font-size:10px;letter-spacing:.04em;text-transform:uppercase;font-weight:700;color:var(--field,#0A1622);background:var(--danger);border-radius:99px;padding:3px 10px;}
      .ab2-meta{font-family:ui-monospace,monospace;font-size:11.5px;color:var(--textDim);}
      .ab2-collapse{margin-left:auto;font-family:ui-monospace,monospace;font-size:11px;color:var(--textDim);background:none;border:1px solid var(--border);border-radius:6px;padding:6px 11px;cursor:pointer;}
      .ab2-collapse:hover{color:var(--text);border-color:var(--accent);}
      .ab2-row{display:flex;align-items:flex-start;gap:11px;padding:11px 16px;border-top:1px solid var(--border);min-width:0;}
      .ab2-row.impact{background:color-mix(in srgb,var(--danger) 5%,transparent);}
      .ab2-tag{font-family:ui-monospace,monospace;font-size:9px;letter-spacing:.03em;text-transform:uppercase;font-weight:700;border-radius:4px;padding:3px 7px;white-space:nowrap;flex:none;margin-top:1px;}
      .ab2-tag.hit{color:var(--danger);border:1px solid color-mix(in srgb,var(--danger) 50%,var(--border));background:color-mix(in srgb,var(--danger) 10%,transparent);}
      .ab2-tag.soft{color:var(--warm);border:1px solid color-mix(in srgb,var(--warm) 50%,var(--border));background:color-mix(in srgb,var(--warm) 10%,transparent);}
      .ab2-txt{flex:1;min-width:0;font-size:12.5px;line-height:1.5;color:var(--text);overflow-wrap:anywhere;}
      .ab2-hit{flex:none;display:flex;align-items:center;gap:9px;font-family:ui-monospace,monospace;font-size:11.5px;color:var(--warm);white-space:nowrap;margin-top:1px;}
      .ab2-hit b{color:var(--text);font-weight:600;}
      .ab2-jump{flex:none;color:var(--accent);cursor:pointer;text-decoration:none;white-space:nowrap;background:none;border:none;font:inherit;font-size:11.5px;padding:0;}
      .ab2-jump:hover{text-decoration:underline;}
      .ab2-more{display:block;width:100%;text-align:left;padding:11px 16px;font-family:ui-monospace,monospace;font-size:11.5px;color:var(--accent);background:none;border:none;border-top:1px solid var(--border);cursor:pointer;}
      .ab2-more:hover{color:var(--text);}
      @media(max-width:620px){.ab2-row{flex-wrap:wrap;gap:6px 9px;}.ab2-hit{flex-basis:100%;order:3;}.ab2-head{gap:8px 10px;}.ab2-collapse{margin-left:0;}}`;
    document.head.appendChild(s);
  }

  function renderInjuryAlerts() {
    // Real feed once loaded (even if empty); the sample banner only in the demo.
    const alerts = state.liveInjuries !== null ? state.liveInjuries : (LIVE_MODE ? [] : INJURY_ALERTS);
    if (el.injuryBar) el.injuryBar.innerHTML = ''; // the ab2 bar is responsive now — retire the separate mobile bar
    if (!el.injuryAlerts) return;
    if (!alerts.length) { el.injuryAlerts.innerHTML = ''; return; }
    ensureAlertStyle();

    // Split by real board exposure — impact rows lead, no-impact rows fold away.
    const enriched = alerts.map((a) => ({ a, hit: boardPickForTeam(a.teamAbbr) }));
    const impact = enriched.filter((e) => e.hit && e.hit.pick);
    const noimp = enriched.filter((e) => !(e.hit && e.hit.pick));

    const rowHtml = (e) => {
      const { a, hit } = e;
      const isHit = !!(hit && hit.pick);
      const tag = `<span class="ab2-tag ${isHit ? 'hit' : 'soft'}">${esc(a.time || 'IL')}</span>`;
      const txt = `<span class="ab2-txt">${esc(a.text || '')}</span>`;
      const impactHtml = isHit
        ? `<span class="ab2-hit"><b>${esc(hit.pick)}</b><button class="ab2-jump" data-action="jump-pick" data-view="${esc(hit.view)}" data-id="${esc(hit.id)}">View →</button></span>`
        : '';
      return `<div class="ab2-row${isHit ? ' impact' : ''}">${tag}${txt}${impactHtml}</div>`;
    };

    const ago = state.injuriesFetchedAt != null
      ? Math.max(0, Math.round((Date.now() - state.injuriesFetchedAt) / 60000)) : null;
    const agoStr = ago == null ? '' : ` · updated ${ago === 0 ? 'just now' : ago + 'm ago'}`;
    const open = state.alertsOpen;
    const badge = impact.length ? `<span class="ab2-badge">${impact.length} impact tonight</span>` : '';
    const head = `<div class="ab2-head"><span class="ab2-dot"></span><span class="ab2-kicker">Lineup Alerts</span>${badge}<span class="ab2-meta">${alerts.length} total${agoStr}</span><button class="ab2-collapse" data-action="alerts-toggle">${open ? 'Collapse ▴' : 'Expand ▾'}</button></div>`;

    let body = '';
    if (open) {
      let rows = '';
      if (impact.length) rows += impact.map(rowHtml).join('');
      else rows += `<div class="ab2-row"><span class="ab2-tag soft">Clear</span><span class="ab2-txt">No injuries touch tonight's picks.</span></div>`;
      if (noimp.length) {
        rows += state.injShowNoImpact
          ? noimp.map(rowHtml).join('')
          : `<button class="ab2-more" data-action="inj-shownoimpact">Show ${noimp.length} more with no board impact →</button>`;
      }
      body = `<div class="ab2-rows">${rows}</div>`;
    }
    el.injuryAlerts.innerHTML = `<div class="ab2">${head}${body}</div>`;
  }

  // "Yesterday's Card" — the most recent graded slate, pick by pick, with the
  // real result from the box score. Wins and losses both stay up. Data comes
  // from /api/track-record's `recent` field; renders nothing until picks grade.
  function ensureYcStyle() {
    if (document.getElementById('yc-style')) return;
    const s = document.createElement('style');
    s.id = 'yc-style';
    s.textContent = `
      #yesterdayCard{display:block;margin:0 0 6px;}
      #yesterdayCard:empty{display:none;}
      .yc{border:1px solid var(--border);border-radius:10px;background:var(--board3,#0C1A26);overflow:hidden;}
      .yc-ribbon{display:flex;align-items:center;gap:11px;padding:12px 16px;flex-wrap:wrap;}
      .yc-lead{font-family:ui-monospace,monospace;font-size:10.5px;letter-spacing:.11em;text-transform:uppercase;color:var(--textDim);font-weight:700;}
      .yc-rec{font-family:ui-monospace,monospace;font-size:12px;font-weight:700;color:var(--text);}
      .yc-units{font-family:ui-monospace,monospace;font-size:12px;font-weight:600;color:var(--textDim);}
      .yc-units.up{color:var(--positive);}
      .yc-units.down{color:var(--danger);}
      .yc-sep{color:var(--border);}
      .yc-clv{font-family:ui-monospace,monospace;font-size:12px;color:var(--textDim);}
      .yc-clv b{color:var(--clv);font-weight:600;}
      .yc-season{font-family:ui-monospace,monospace;font-size:11px;color:var(--textDim);}
      .yc-season b{color:var(--text);font-weight:600;}
      .yc-view{margin-left:auto;font-family:ui-monospace,monospace;font-size:11px;color:var(--accent);background:none;border:none;cursor:pointer;padding:0;white-space:nowrap;}
      .yc-view:hover{text-decoration:underline;}
      .yc-scope{display:flex;align-items:center;gap:8px;padding:8px 16px;border-top:1px solid var(--border);font-family:ui-monospace,monospace;font-size:10.5px;letter-spacing:.03em;text-transform:uppercase;color:var(--textDim);background:color-mix(in srgb,var(--accent) 4%,transparent);}
      .yc-scope b{color:var(--text);font-weight:700;}
      .yc-rows{display:grid;grid-template-columns:1fr 1fr;}
      .yc-row{display:flex;align-items:center;gap:10px;padding:10px 15px;border-top:1px solid var(--border);min-width:0;}
      .yc-rows .yc-row:nth-child(even){border-left:1px solid var(--border);}
      .yc-res{flex:none;width:20px;height:20px;border-radius:99px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;border:1px solid var(--border);color:var(--textDim);}
      .yc-res.w{background:color-mix(in srgb,var(--positive) 16%,transparent);color:var(--positive);border-color:color-mix(in srgb,var(--positive) 55%,var(--border));}
      .yc-res.l{background:color-mix(in srgb,var(--danger) 14%,transparent);color:var(--danger);border-color:color-mix(in srgb,var(--danger) 50%,var(--border));}
      .yc-pick{flex:none;display:flex;align-items:baseline;gap:7px;min-width:0;}
      .yc-nm{font-weight:700;font-size:13px;white-space:nowrap;}
      .yc-bet{font-family:ui-monospace,monospace;font-size:11.5px;color:var(--textDim);white-space:nowrap;}
      .yc-bet b{color:var(--text);font-weight:600;}
      .yc-actual{flex:1;min-width:0;text-align:right;font-family:ui-monospace,monospace;font-size:11.5px;color:var(--textDim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
      .yc-actual b{font-weight:700;font-size:13px;}
      .yc-actual .aw{color:var(--positive);}
      .yc-actual .al{color:var(--danger);}
      .yc-tier{flex:none;font-family:ui-monospace,monospace;font-size:9px;letter-spacing:.03em;text-transform:uppercase;font-weight:700;border-radius:4px;padding:2px 6px;white-space:nowrap;color:var(--textDim);border:1px solid var(--border);}
      .yc-tier.t1{color:var(--accent);border-color:color-mix(in srgb,var(--accent) 45%,var(--border));background:color-mix(in srgb,var(--accent) 8%,transparent);}
      .yc-foot{grid-column:1/-1;display:flex;align-items:center;gap:14px;padding:10px 16px;border-top:1px solid var(--border);font-family:ui-monospace,monospace;font-size:11px;color:var(--textDim);flex-wrap:wrap;}
      .yc-foot b{color:var(--text);}
      .yc-foot .up{color:var(--positive);}
      .yc-foot a{color:var(--accent);text-decoration:none;margin-left:auto;}
      .yc-foot a:hover{text-decoration:underline;}
      @media(max-width:720px){.yc-rows{grid-template-columns:1fr;}.yc-rows .yc-row:nth-child(even){border-left:none;}}
      @media(max-width:620px){.yc-row{flex-wrap:wrap;gap:5px 9px;}.yc-actual{flex-basis:100%;order:4;text-align:left;padding-left:30px;white-space:normal;}.yc-ribbon{gap:8px 10px;}.yc-season{flex-basis:100%;}.yc-view{margin-left:0;}}`;
    document.head.appendChild(s);
  }

  function ycDateLabel(d) {
    try {
      const [y, m, day] = String(d).split('-').map(Number);
      return new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles' })
        .format(new Date(Date.UTC(y, m - 1, day, 12))).replace(',', '');
    } catch (e) { return String(d || ''); }
  }

  function renderYesterdayCard() {
    if (!el.yesterdayCard) return;
    const tr = state.trackRecord;
    const rec = tr && tr.recent;
    if (!rec || !rec.picks || !rec.picks.length) { el.yesterdayCard.innerHTML = ''; return; }
    ensureYcStyle();

    const open = state.ycOpen;
    const upDown = rec.units > 0 ? ' up' : rec.units < 0 ? ' down' : '';
    const uStr = (rec.units > 0 ? '+' : '') + rec.units + 'u';
    const clvStr = tr.clv != null ? (tr.clv > 0 ? '+' : '') + tr.clv + '%' : null;

    // A lean one-line receipt. CLV and the season sample carry it — the daily
    // W/L is one noisy data point, so it's shown honestly but not shouted.
    const ribbon = `<div class="yc-ribbon">`
      + `<span class="yc-lead">Yesterday · ${esc(ycDateLabel(rec.date))}</span>`
      + `<span class="yc-rec">${esc(rec.record)}</span>`
      + `<span class="yc-units${upDown}">${uStr}</span>`
      + (clvStr ? `<span class="yc-sep">|</span><span class="yc-clv">CLV <b>${clvStr}</b></span>` : '')
      + (tr.record ? `<span class="yc-sep">|</span><span class="yc-season">Season <b>${esc(tr.record)}</b> · every pick graded &amp; kept up</span>` : '')
      + `<button class="yc-view" data-action="yc-toggle">${open ? 'Hide ▴' : 'View card →'}</button>`
      + `</div>`;

    if (!open) { el.yesterdayCard.innerHTML = `<div class="yc">${ribbon}</div>`; return; }

    const U = { K: 'Ks', HR: 'HR', TB: 'TB', HRR: 'H+R+RBI' };
    const odds = (n) => (n == null ? '' : (n > 0 ? '+' + n : String(n)));
    const betText = (p) => {
      if (p.market === 'ML') return `<b>ML</b>${p.price != null ? ' ' + odds(p.price) : ''}`;
      const s = p.side === 'Over' ? 'O' : p.side === 'Under' ? 'U' : '';
      return `<b>${s} ${p.line}</b> ${U[p.market] || esc(p.market)}${p.price != null ? ' ' + odds(p.price) : ''}`;
    };
    const actualText = (p) => {
      const cls = p.result === 'win' ? 'aw' : p.result === 'loss' ? 'al' : '';
      if (p.market === 'ML') {
        const verb = p.result === 'win' ? 'won' : p.result === 'loss' ? 'lost' : 'push';
        return `${verb} <b class="${cls}">${p.actual != null ? esc(String(p.actual)) : ''}</b>${p.opp ? ' · vs ' + esc(p.opp) : ''}`;
      }
      if (p.actual == null) return p.result === 'push' ? 'push' : '';
      return `<b class="${cls}">${esc(String(p.actual))}</b> ${U[p.market] || esc(p.market)} · line ${p.line}`;
    };
    const glyph = (r) => (r === 'win' ? '✓' : r === 'loss' ? '✗' : '–');
    const rcls = (r) => (r === 'win' ? 'w' : r === 'loss' ? 'l' : 'p');

    const rows = rec.picks.map((p) => {
      const t1 = String(p.tier) === '1' ? ' t1' : '';
      return `<div class="yc-row">`
        + `<span class="yc-res ${rcls(p.result)}">${glyph(p.result)}</span>`
        + `<span class="yc-pick"><span class="yc-nm">${esc(p.name)}</span><span class="yc-bet">${betText(p)}</span></span>`
        + `<span class="yc-tier${t1}">Tier ${esc(p.tier)}</span>`
        + `<span class="yc-actual">${actualText(p)}</span>`
        + `</div>`;
    }).join('');

    const seasonUnits = tr.units != null ? (tr.units > 0 ? '+' : '') + tr.units + 'u' : '—';
    const more = (rec.total != null && rec.total > rec.picks.length)
      ? `<a href="#record">See all ${rec.total} graded plays →</a>`
      : `<a href="#record">Full track record →</a>`;
    // Season record + CLV already live in the ribbon — the foot adds only what
    // the ribbon doesn't: the Tier 1 subset and season units.
    const foot = `<div class="yc-foot">`
      + (tr.tier1 ? `<span>Tier 1: <b>${esc(tr.tier1)}</b></span>` : '')
      + `<span>Season units: <b>${seasonUnits} flat</b></span>`
      + more
      + `</div>`;

    const scope = `<div class="yc-scope">Showing <b>Tier 1 + Tier 2 plays</b> · every pick stays up · graded from the box score</div>`;

    el.yesterdayCard.innerHTML = `<div class="yc">${ribbon}${scope}<div class="yc-rows">${rows}${foot}</div></div>`;
  }

  // Mobile: a collapsed-by-default alert bar with a relevance filter. Rows whose
  // team is in a game you have a pick on lead ("in tonight's picks"); the rest
  // fold under "also out". Conservative — it states the game, never a causal claim.
  function renderInjuryBar(alerts) {
    const bar = el.injuryBar;
    if (!bar) return;
    if (!alerts.length) { bar.innerHTML = ''; return; }

    const action = actionTeamSet();
    const rel = alerts.filter((a) => action && a.teamAbbr && action.has(a.teamAbbr));
    const rest = alerts.filter((a) => !(action && a.teamAbbr && action.has(a.teamAbbr)));
    const canSplit = rel.length > 0 && rest.length > 0;

    const row = (a, isRel) => `
      <div class="ialert ${isRel ? 'rel' : ''}">
        <div class="ialert-who">
          <div class="ialert-nm">${esc(a.text)}</div>
          ${isRel && a.game ? `<div class="ialert-game">${esc(a.game)} · on tonight's board</div>` : ''}
        </div>
        <span class="ialert-il">${esc(a.time)}</span>
      </div>`;

    const summary = canSplit
      ? `<b>${rel.length}</b> in tonight's picks <span class="ib-sep">·</span> <span class="ib-rest">${rest.length} more</span>`
      : `<b>${alerts.length}</b> ${alerts.length === 1 ? 'bat' : 'bats'} out tonight`;

    const filter = canSplit ? `
      <div class="ib-filter" role="tablist">
        <button data-action="injbar-filter" data-mode="rel" role="tab">In your picks <span class="cnt">· ${rel.length}</span></button>
        <button data-action="injbar-filter" data-mode="all" role="tab">All out <span class="cnt">· ${alerts.length}</span></button>
      </div>` : '';

    const listRel = rel.map((a) => row(a, true)).join('');
    const listRest = rest.map((a) => row(a, false)).join('');
    const body = canSplit
      ? `<div class="ib-group">In a game on your board</div>${listRel}<div class="ib-group ib-rest-group">Also out tonight</div><div class="ib-rest-rows">${listRest}</div>`
      : alerts.map((a) => row(a, false)).join('');

    bar.innerHTML = `
      <div class="alertbar${state.injBarOpen ? ' open' : ''}" data-filter="${state.injBarFilter}">
        <button class="ab-summary" data-action="injbar-toggle" aria-expanded="${state.injBarOpen ? 'true' : 'false'}">
          <span class="ab-dot"></span>
          <span class="ab-kicker">ALERTS</span>
          <span class="ab-lead">${summary}</span>
          <span class="ab-chev">⌄</span>
        </button>
        <div class="ab-panel"><div class="ab-panel-inner"><div class="ab-body">
          ${filter}
          <div class="ib-list">${body}</div>
        </div></div></div>
      </div>`;
  }

  // LIVE NOW — tonight's picks whose games are in progress, scored live.
  function liveVs(c) {
    const s = c.statLabel;
    if (s === 'K') return `${c.side} ${c.line} Ks`;
    if (s === 'TB') return `${c.side} ${c.line} Total Bases`;
    if (s === 'HR') return (c.side === 'Over' && c.line === 0.5) ? 'To Hit a HR' : `${c.side} ${c.line} HR`;
    return `${c.side} ${c.line} ${s}`; // H+R+RBI
  }
  function renderLiveNow() {
    const cards = state.liveNow;
    const has = Array.isArray(cards) && cards.length > 0;
    if (el.liveNowSection) el.liveNowSection.hidden = !has;
    if (el.navLive) el.navLive.hidden = !has;
    // While games are live, urgency leads: Live Now moves above the hero.
    // (Pre-game the hero leads; the section is hidden so no move happens.)
    if (has && el.liveNowSection) {
      const hero = document.querySelector('main .hero');
      if (hero && hero.parentNode && hero.previousElementSibling !== el.liveNowSection) {
        hero.parentNode.insertBefore(el.liveNowSection, hero);
      }
    }
    if (!has) { if (el.liveNowGrid) el.liveNowGrid.innerHTML = ''; return; }
    if (el.liveNowNote) el.liveNowNote.textContent = `${cards.length} in-progress · updating every pitch`;
    el.liveNowGrid.innerHTML = cards.map((c) => {
      const unit = c.statLabel === 'H+R+RBI' ? '' : c.statLabel;
      return `
        <div class="livecard ${esc(c.state)}">
          <div class="livecard-top">
            <div>
              <div class="livecard-name">${esc(c.name)}</div>
              <div class="livecard-meta">${esc(c.team)}${c.pos === 'P' ? ' · P' : ''}</div>
            </div>
            <span class="livecard-pill ${esc(c.state)}">${esc(c.state.toUpperCase())}</span>
          </div>
          <div class="livecard-stat">
            <span class="livecard-num ${esc(c.state)}">${esc(String(c.stat))}</span>
            ${unit ? `<span class="livecard-unit">${esc(unit)}</span>` : ''}
            <span class="livecard-vs">${esc(liveVs(c))}</span>
          </div>
          <div class="livecard-bar">
            <div class="livecard-fill ${esc(c.state)}" style="width:${c.fill}%"></div>
            <div class="livecard-tick" style="left:${c.tick}%"></div>
          </div>
          <div class="livecard-foot">
            <span class="livecard-dot ${esc(c.state)}"></span>
            <span class="livecard-game">${esc(c.matchup)}${c.inning ? ' · ' + esc(c.inning) : ''}</span>
          </div>
          ${c.note ? `<div class="livecard-note">${esc(c.note)}</div>` : ''}
        </div>`;
    }).join('');
    renderLiveNowDots(cards.length);
  }

  // Dot indicators for the mobile swipe carousel: one per card, the one nearest
  // the scroll position highlighted. CSS hides the row on desktop (grid layout).
  function renderLiveNowDots(n) {
    const dots = el.liveNowDots, grid = el.liveNowGrid;
    if (!dots || !grid) return;
    if (n <= 1) { dots.hidden = true; dots.innerHTML = ''; grid.onscroll = null; return; }
    dots.hidden = false;
    dots.innerHTML = Array.from({ length: n }, (_, i) =>
      `<span class="d${i === 0 ? ' active' : ''}" data-i="${i}"></span>`).join('');
    const activate = (i) => {
      [...dots.children].forEach((d, j) => d.classList.toggle('active', j === i));
    };
    grid.onscroll = () => {
      const cards = grid.children;
      if (cards.length < 2) return;
      const stride = cards[1].offsetLeft - cards[0].offsetLeft;
      if (stride <= 0) return;
      activate(Math.max(0, Math.min(n - 1, Math.round(grid.scrollLeft / stride))));
    };
    dots.onclick = (e) => {
      const d = e.target.closest('.d'); if (!d) return;
      const i = +d.dataset.i, cards = grid.children;
      if (cards[i] && cards[0]) grid.scrollTo({ left: cards[i].offsetLeft - cards[0].offsetLeft, behavior: 'smooth' });
    };
  }
  async function refreshLiveNow() {
    if (!LIVE_MODE) return;
    try {
      const rows = await fetchJson('/api/live-now');
      if (Array.isArray(rows)) { state.liveNow = rows; renderLiveNow(); }
    } catch (e) { console.warn('Live Now refresh failed:', e.message); }
  }

  // Real injured-list moves from MLB StatsAPI transactions (via /api/injuries).
  async function refreshInjuries() {
    if (!LIVE_MODE) return;
    try {
      const rows = await fetchJson('/api/injuries');
      if (Array.isArray(rows)) {
        state.liveInjuries = rows; // may be empty -> no alerts, which is honest
        state.injuriesFetchedAt = Date.now();
        state.injShowNoImpact = false; // fresh data -> re-collapse the no-impact list
        state.injShowAllImpact = false;
        renderInjuryAlerts();
      }
    } catch (e) {
      console.warn('Injuries refresh failed:', e.message);
    }
  }

  function getFilteredSortedGames() {
    let games = getGames().filter((g) => {
      // Run Line only has content once a run line is posted — omit games without
      // one (they'd render as blank cards). "All" then shows every posted run
      // line, each card self-labeled pick / value / no-play; the tier and Pass
      // tabs narrow from there. Other views are unaffected.
      if (isRL() && g.rl == null) return false;
      if (state.filter === 'all') return true;
      // Starred is a filter over the slip, not over a tier, so it is checked
      // before the tier comparison — activeTier() would never return 'starred'.
      if (state.filter === 'starred') return !!state.slip[legIdFor(g)];
      return String(activeTier(g)) === state.filter;
    });
    const q = state.searchQuery.trim().toLowerCase();
    if (q) {
      games = games.filter((g) => g.matchup.toLowerCase().includes(q) || (g.subline || '').toLowerCase().includes(q));
    }
    const byTime = (a, b) => a.time - b.time;
    // Descending on the metric, unpriced rows sinking to the bottom, ties (and
    // all-unpriced boards) falling back to first pitch.
    //
    // The null handling is load-bearing, not defensive: `-Infinity - -Infinity`
    // is NaN, and a comparator that returns NaN makes Array.prototype.sort's
    // order implementation-defined. Early in the day nothing is priced and
    // EVERY row is null, so the plain subtraction scrambled the board into an
    // arbitrary order instead of leaving it alone.
    // Nulls always sink, all-null falls back to first pitch, and an explicit
    // direction lets a chip flip high↔low. (A desc-only helper used to sit here
    // too; it was superseded when direction support landed and had no remaining
    // call sites.)
    const cmpBy = (metric, dir) => (a, b) => {
      const pa = metric(a), pb = metric(b);
      if (pa == null && pb == null) return byTime(a, b);
      if (pa == null) return 1;
      if (pb == null) return -1;
      return (dir === 'asc' ? pa - pb : pb - pa) || byTime(a, b);
    };
    // Sort by whatever key is selected. The old code forced time order whenever
    // the board carried no numeric tier, which on an all-'pass' moneyline slate
    // overrode a perfectly sortable Edge or Win Prob column and pinned the board
    // to Time. It was also redundant: cmpBy already falls back to byTime when a
    // metric is null on BOTH rows, so a genuinely empty column still degrades to
    // first-pitch order without a special case.
    games = [...games].sort(cmpBy(sortMetric(state.sortBy), sortDir()));
    return games;
  }

  // The four sort keys and the field each reads. Odds sorts on the price you'd
  // actually bet (best DK/FD on the batter board, the moneyline on ML); higher
  // = longer payout, so it defaults high-first like edge and model.
  const activeOdds = (g) => isML() ? (g.ml ? g.ml.price : null)
    : isRL() ? (g.rl ? g.rl.price : null)
    : (typeof g.odds === 'number' ? g.odds : null);
  const sortMetric = (key) => key === 'time' ? (g) => g.time
    : key === 'model' ? modelProbOf
    : key === 'odds' ? activeOdds
    : activeEdge;
  // The key the board is ACTUALLY ordered by. state.sortBy is what the reader
  // last chose, which is not the same thing: when a column empties out — every
  // edge null during a feed outage — that key stops being offered and the board
  // falls back to first pitch, while state.sortBy still says 'edge'.
  //
  // Three places needed this and each had derived it separately, so the sort chip
  // could highlight First pitch while the grouping logic read 'edge' and stayed
  // off. One definition, so the chip, the footer and the grouping cannot disagree
  // about what order the board is in.
  const effectiveSortKey = () => availableSortKeys().includes(state.sortBy) ? state.sortBy : 'time';
  const SORT_DEFAULT_DIR = { edge: 'desc', model: 'desc', odds: 'desc', time: 'asc' };
  const sortDir = () => state.sortDir || SORT_DEFAULT_DIR[state.sortBy] || 'desc';

  // The model's probability for the side each view leans, 0-100, or null when
  // nothing is priced. Deliberately mirrors what the row's own detail column
  // shows — sorting by a number you can see beats sorting by a hidden one.
  //   batter    P(under), the board's Model P(under) cell
  //   moneyline the fair win prob in the Win Prob cell
  //   K props   the lead pitcher's P of his leaned side (in the expand panel)
  //   run line  the model's favourite's win %
  function modelProbOf(g) {
    if (isML()) return g.ml && typeof g.ml.winProb === 'number' ? g.ml.winProb : null;
    if (isRL()) return g.rl && typeof g.rl.modelFavPct === 'number' ? g.rl.modelFavPct : null;
    if (isBatter()) {
      if (typeof g.modelOver !== 'number') return null;
      return g.side === 'Over' ? g.modelOver : 100 - g.modelOver;
    }
    // K props: the row's play is the priced starter with the biggest edge —
    // same rule the board itself uses to pick the row's headline lean.
    const priced = (Array.isArray(g.projRows) ? g.projRows : [])
      .filter((p) => p && p.market && p.market.price != null && typeof p.market.modelOver === 'number');
    if (!priced.length) return null;
    const lead = priced.reduce((m, p) => (!m || p.market.edge > m.market.edge ? p : m), null);
    return lead.market.side === 'Under' ? 100 - lead.market.modelOver : lead.market.modelOver;
  }

  // What the third sort option is called on the active view. Moneyline shows a
  // win probability, not a model P — naming it "Model P" there would describe a
  // column that doesn't exist.
  // Each view names the chip after its OWN column, so the two never disagree.
  // The run line was still saying "Model P" over a column headed Cover %.
  // K props keeps the generic name on purpose: it sorts on the lead starter's
  // model probability, not on projected Ks, and calling it "Proj Ks" would name
  // a different number than the one doing the ordering.
  const modelSortLabel = () => isML() ? 'Win Prob'
    : isRL() ? 'Cover %'
    : isBatter() ? 'P(under)'
    : 'Model P';

  // The sort chip row. One chip per key; the active one shows its direction
  // arrow and, on click, flips it. "Model P" renames to "Win Prob" on the
  // moneyline view, matching that view's own column, so the chip never labels a
  // number the board doesn't show.
  // "First pitch" rather than "Time": the board carries several times (first
  // pitch, last refresh, the outage countdown) and the chip orders exactly one.
  const SORT_LABELS = { edge: 'Edge', model: null, odds: 'Odds', time: 'First pitch' };

  // Which sort keys are actually meaningful for the board as it stands right now.
  // Edge and Win-Prob/Model-P only exist when the board carries model output, so
  // on a context view (ML/K) or a fallback slate with no tiers they'd sort by
  // all-null and are dropped. Odds shows only when some row has a price to sort.
  // Time is always meaningful (every game has a first pitch), so the group is
  // never empty — which is what stops the toolbar collapsing to a lone Compare
  // when /api/board falls back to the odds-only slate.
  function availableSortKeys() {
    const games = getGames();
    const has = (key) => games.some((g) => sortMetric(key)(g) != null);
    const keys = [];
    // Availability is "does this metric have values", NOT "did any row clear a
    // tier cutoff". These were tied to boardModeled(), which needs a NUMERIC
    // tier somewhere on the board — so on a moneyline slate where every game
    // priced under the T3 cutoff (all tier:'pass'), Edge and Win Prob vanished
    // from the sort even though every row displayed both. Whether a pick is
    // worth betting and whether a column can be ordered are different questions.
    if (has('edge')) keys.push('edge');
    if (has('model')) keys.push('model');
    if (has('odds')) keys.push('odds');
    keys.push('time');
    return keys;
  }

  function renderSortChips() {
    const host = document.getElementById('sortChips');
    if (!host) return;
    const keys = availableSortKeys();
    // getFilteredSortedGames force-sorts by time whenever the board isn't
    // modeled, so if the stored key isn't offered here, Time is the real order —
    // highlight it, rather than leaving a hidden key "active" with no chip.
    const active = effectiveSortKey();
    const arrow = sortDir() === 'asc' ? '↑' : '↓';
    host.innerHTML = keys.map((key) => {
      const label = key === 'model' ? modelSortLabel() : SORT_LABELS[key];
      const on = key === active;
      return `<button class="sort-btn${on ? ' active' : ''}" data-action="set-sort" data-sort="${key}"`
        + `${on ? ' aria-pressed="true"' : ''}>${esc(label)}${on ? ` <span class="sort-arrow">${arrow}</span>` : ''}</button>`;
    }).join('');
  }

  function renderControls() {
    const live = boardHasLive();
    const modeled = boardModeled();
    const noun = isBatter() ? 'batters' : 'games';
    // The qualifier is wrapped so CSS can drop it on a phone. At 390px the count
    // and the tracked pill came to 328px against 326px available — they missed
    // sharing a line by two pixels, which cost the section head a whole third
    // row. Only literals and a number are interpolated here, so innerHTML
    // carries nothing that could come from a feed.
    const n = getGames().length;
    const qualifier = modeled ? 'model vs. live lines' : 'tonight’s slate · live';
    el.gameCount.innerHTML = !live
      ? (LIVE_MODE
        ? (isFeedLoading()
          ? 'loading tonight’s slate…'
          // "no games posted yet" was false whenever games existed but carried no
          // battable lines — fifteen on the board and the header said none.
          : slateGames().length
            ? `${slateGames().length} game${slateGames().length === 1 ? '' : 's'}`
              // A feed error outranks both slate readings here for the same reason
              // it does in the empty state: "no lines up yet" points at the books.
              + `<span class="gc-more"> · ${state.feedError ? 'odds feed unavailable'
                : slateStarted() ? 'underway — no lines up' : 'no lines up yet'}</span>`
            : 'no games posted yet')
        : `${RAW_GAMES.length} games<span class="gc-more"> · odds refresh :30</span>`)
      : `${n} ${noun}<span class="gc-more"> · ${qualifier}</span>`;
    const trackedCount = Object.keys(state.slip).length;
    el.trackedPill.textContent = `${trackedCount} tracked`;
    renderSortChips();

    document.querySelectorAll('.viewtab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.view === state.boardView);
    });

    // Hide tier/edge controls only on a live slate with no market tiers.
    const hideModelControls = live && !modeled;
    // Tier filters grade PLAYS, and only the batter board posts plays — so hide
    // them on the context views (a "Tier 1 moneyline" is not a recommendation).
    const hideTiers = hideModelControls || !isBatter();

    // Live counts per tier chip — how many of tonight's plays fall in each
    // bucket, given the current search. Counted off the real board and kept
    // independent of the active tier filter, so you can see the other buckets'
    // sizes while filtered to one. Search-applied so the numbers track what you
    // typed. Only the batter board posts tiers, so only it gets counts.
    // Every filter key needs an entry. The fallback below reads the button own
    // rendered text, which already contains BOTH labels plus the count -- so a
    // missing key does not degrade, it compounds: Plays became PlaysPlays became
    // PlaysPlaysPlaysPlays on successive renders.
    const FILTER_LABEL = { all: 'All', play: 'Plays', pass: 'Pass' };
    // Both labels are rendered and CSS picks one, rather than measuring the
    // viewport here — a JS-chosen label would need a resize listener and would
    // be wrong for the first paint after an orientation change.
    //
    // "Tier 3" beside a count of 11 reads as "Tier 311" at a glance on a phone;
    // "T3" next to the count pill does not. Shortening also lets all five chips
    // sit on ONE row at 390px instead of wrapping 3+2 with a half-empty second
    // row, which is what made the filter block look unfinished.
    const FILTER_SHORT = { all: 'All', play: 'Plays', pass: 'Pass' };
    let tierCounts = null;
    if (isBatter() && !hideTiers) {
      const q = state.searchQuery.trim().toLowerCase();
      const pool = getGames().filter((g) => !q || g.matchup.toLowerCase().includes(q) || (g.subline || '').toLowerCase().includes(q));
      tierCounts = { all: pool.length, play: 0, pass: 0, starred: 0 };
      pool.forEach((g) => {
        const t = String(activeTier(g));
        if (t in tierCounts) tierCounts[t] += 1;
        if (state.slip[legIdFor(g)]) tierCounts.starred += 1;
      });
    }
    // The star chip appears only once something is starred, and disappears again
    // when the slip empties — including when the filter is still set to it, which
    // would otherwise strand the board on an empty view with no way back.
    const starredN = Object.keys(state.slip).length;
    if (!starredN && state.filter === 'starred') state.filter = 'all';

    document.querySelectorAll('.filter-btn').forEach((btn) => {
      const f = btn.dataset.filter;
      const isTierBtn = f !== 'all';
      if (f === 'starred') {
        // Deliberately NOT gated on hideTiers. Tiers hide when the board has no
        // play/pass call to make — during a feed outage, every row is projection
        // only — but what you have starred is still yours and still worth
        // filtering to. Tying the two hid the chip exactly when the board was
        // least useful to scroll.
        btn.hidden = !starredN;
        btn.style.display = btn.hidden ? 'none' : '';
        // A star needs no abbreviation, so it skips the long/short pair the other
        // chips carry — rendering both spans printed the glyph twice.
        btn.classList.toggle('active', state.filter === 'starred');
        btn.innerHTML = `<span class="fl-star">★</span><span class="chip-count">${starredN}</span>`;
        btn.setAttribute('aria-label', `Starred, ${starredN}`);
        return;
      }
      btn.style.display = hideTiers && isTierBtn ? 'none' : '';
      const active = f === state.filter;
      btn.classList.toggle('active', active);
      // Read the long-label span when falling back, never the whole button: once
      // rendered it holds long + short + count, so reading it back compounds.
      const priorLong = btn.querySelector(".fl-long");
      const label = FILTER_LABEL[f] || (priorLong ? priorLong.textContent : btn.textContent);
      const short = FILTER_SHORT[f] || label;
      const labelHtml = `<span class="fl-long">${esc(label)}</span><span class="fl-short">${esc(short)}</span>`;
      if (tierCounts) {
        const n = tierCounts[f] ?? 0;
        btn.innerHTML = `${labelHtml}<span class="chip-count">${n}</span>`;
        // Dim a bucket that's empty tonight — unless it's the one you're on,
        // which must stay legible even at zero.
        btn.classList.toggle('chip-empty', n === 0 && !active);
      } else {
        btn.innerHTML = labelHtml;
        btn.classList.remove('chip-empty');
      }
      // Screen readers and the a11y tree get the full label, never "T3".
      btn.setAttribute('aria-label', tierCounts ? `${label}, ${tierCounts[f] ?? 0}` : label);
    });
    // Sort shows whenever there are rows to order — Time alone is reason enough,
    // and it's always available. Tying this to hideModelControls made the group
    // vanish on the fallback ML/K slate, so the same tab's toolbar rearranged
    // between data refreshes and read as a glitch. renderSortChips trims the
    // chips to the meaningful keys, so an unmodeled board shows just Time.
    const anyGames = getGames().length > 0;
    const sortGroup = document.getElementById('sortGroup');
    if (sortGroup) sortGroup.style.display = anyGames ? '' : 'none';
    // The divider only earns its keep between the tier filters and sort. Tier
    // filters exist only when !hideTiers (the modeled batter board), so key the
    // divider off that — never off sort, which now shows on context views too.
    const toolbarDiv = document.getElementById('toolbarDiv');
    if (toolbarDiv) toolbarDiv.style.display = (!hideTiers && anyGames) ? '' : 'none';

    el.compareModeBtn.textContent = state.compareMode ? 'Exit Compare' : 'Compare';
    el.compareModeBtn.classList.toggle('active', state.compareMode);
    el.compareHint.classList.toggle('visible', state.compareMode);
    el.compareHint.textContent = `Compare mode — pick up to 2 games to compare side-by-side (${state.compareIds.length}/2 selected)`;

    el.hitterCompareModeBtn.textContent = state.hitterCompareMode ? 'Exit Compare' : 'Compare';
    el.hitterCompareModeBtn.classList.toggle('active', state.hitterCompareMode);
    el.hitterCompareModeBtn.setAttribute('aria-pressed', state.hitterCompareMode);
    el.hitterCompareHint.classList.toggle('visible', state.hitterCompareMode);
    el.hitterCompareHint.textContent = `Compare mode — pick up to 2 hitters (${state.hitterCompareIds.length}/2 selected)`;

    el.pitcherCompareModeBtn.textContent = state.pitcherCompareMode ? 'Exit Compare' : 'Compare';
    el.pitcherCompareModeBtn.classList.toggle('active', state.pitcherCompareMode);
    el.pitcherCompareModeBtn.setAttribute('aria-pressed', state.pitcherCompareMode);
    el.pitcherCompareHint.classList.toggle('visible', state.pitcherCompareMode);
    el.pitcherCompareHint.textContent = `Compare mode — pick up to 2 pitchers (${state.pitcherCompareIds.length}/2 selected)`;

    el.compareModeBtn.setAttribute('aria-pressed', state.compareMode);
  }

  // Park + weather chips for a pitcher's projection detail. Only shows a factor
  // when it actually moves the number (park ≠ 1.00) or a real temp is posted.
  function parkWxHtml(p) {
    const out = [];
    if (typeof p.parkK === 'number' && p.parkK !== 1) {
      const pct = Math.round((p.parkK - 1) * 100);
      const col = pct > 0 ? 'var(--danger)' : 'var(--positive)';
      out.push(`<span style="font-family:'IBM Plex Mono';font-size:12px;color:${col}" title="${esc(p.park || '')} park strikeout factor">${p.park || 'park'} ${pct > 0 ? '+' : ''}${pct}% K</span>`);
    }
    if (typeof p.temp === 'number' && p.temp > 0) {
      const wxAdj = typeof p.wxK === 'number' && p.wxK !== 1 ? ` (${p.wxK > 1 ? '+' : ''}${Math.round((p.wxK - 1) * 100)}% K)` : '';
      out.push(`<span style="font-family:'IBM Plex Mono';font-size:12px;color:var(--textDim)" title="game-time weather">${p.temp}°F${p.wxCond ? ' ' + esc(p.wxCond) : ''}${wxAdj}</span>`);
    }
    return out.join('');
  }

  // Two-book odds cell (DraftKings / FanDuel), best payout highlighted in teal.
  // Falls back to a single price when per-book data isn't available (mock mode).
  // The win rate a price alone demands — no model in it. Shared by the hero and
  // every row's price read so the arithmetic is defined in exactly one place.
  function oddsBreakeven(odds) {
    if (odds == null) return null;
    const p = odds > 0 ? 100 / (odds + 100) : -odds / (-odds + 100);
    return Math.round(p * 1000) / 10;
  }

  // Per-row price read: the same price-play argument as the hero, in one line,
  // for whatever the row's leaned side is. Break-even is straight from the price;
  // the model P is the leaned side's probability. "clear/short of break-even" is
  // model-minus-break-even — a DIFFERENT number from the board's edge (which is
  // model vs. the sharp fair line), so both are stated as what they are and the
  // panel never conflates them. Styled neutral (analysis blue), with only the
  // signed gap coloured, so it never fights the row's own green edge.
  function rowPriceRead(g) {
    if (!isBatter() || g.odds == null || typeof g.modelOver !== 'number' || !g.side) return '';
    const be = oddsBreakeven(g.odds);
    if (be == null) return '';
    const pSide = g.side === 'Under' ? Math.round((100 - g.modelOver) * 10) / 10 : Math.round(g.modelOver * 10) / 10;
    const clear = Math.round((pSide - be) * 10) / 10;
    const price = g.odds > 0 ? '+' + g.odds : String(g.odds);
    const verdict = clear > 0 ? `<b class="pr-clear pos">${clear} pts</b> clear of break-even`
      : clear < 0 ? `<b class="pr-clear neg">${Math.abs(clear)} pts</b> short of break-even`
      : 'right at break-even';
    const edgeBit = typeof g.edge === 'number'
      ? ` The board's <b>+${g.edge}%</b> is that price against the sharp fair line.` : '';
    return `<div class="price-read"><span class="pr-k">Price read</span><span>At <b>${esc(price)}</b> the ${esc(g.side)} needs <b>${be}%</b> to profit; the model gives it <b>${pSide}%</b> — ${verdict}.${edgeBit}</span></div>`;
  }

  function oddsBooksCell(g, money) {
    const books = g.oddsBooks;
    if (!Array.isArray(books) || !books.length) {
      return `<span class="odds-cell mono">${esc(money(g.odds))}</span>`;
    }
    const rows = books.map((b) => {
      const lineTag = b.off && b.line != null ? `<span class="bk-line">${esc(String(b.line))}</span>` : '';
      return `<span class="bk${b.best ? ' best' : ''}">
        <span class="bk-name">${esc(b.book)}</span>${lineTag}
        <span class="bk-price">${esc(money(b.price))}</span>
        <span class="bk-chk">✓</span>
      </span>`;
    }).join('');
    // Line movement since the pick posted (batter board only; the field only
    // exists there). Arrow + text carry the sign, so it reads without colour.
    const move = (isBatter() && typeof g.moveSincePost === 'number') ? moveCaption(g.moveSincePost) : '';
    return `<span class="odds-books">${rows}${move}</span>`;
  }

  // "since post" caption: how far the vig-free fair has moved toward our side
  // since the pick first logged, in probability points. It's the CLV thesis —
  // "we're early" — made visible at the moment of decision instead of only in
  // the season aggregate.
  function moveCaption(mv) {
    const cls = mv >= 0.1 ? 'up' : mv <= -0.1 ? 'down' : 'flat';
    const txt = mv >= 0.1 ? `▲ ${mv.toFixed(1)} since post`
      : mv <= -0.1 ? `▼ ${Math.abs(mv).toFixed(1)} since post`
      : 'flat since post';
    const title = 'Vig-free line movement since this pick posted, in probability points. Up = the market moved toward our side — we were early.';
    return `<span class="bk-move ${cls}" title="${esc(title)}">${txt}</span>`;
  }

  // Model bars fill from zero the first time they're shown. Gated by key,
  // because the board re-renders on a five-minute poll and on every sort,
  // filter and search: a whole page of bars re-filling on a silent data refresh
  // reads as a glitch, not as feedback. A key is claimed once and never
  // replayed — except a panel's, which is retired on collapse, since
  // re-opening a row IS a fresh request to see that model.
  const shownBars = new Set();
  function barsIn(key) {
    if (shownBars.has(key)) return '';
    shownBars.add(key);
    return ' bars-in';
  }
  function retirePanelBars() {
    shownBars.forEach((k) => { if (k.startsWith('panel:')) shownBars.delete(k); });
  }

  function renderBoardHead() {
    const cols = isBatter()
      // "Edge · vs sharp fair" matters: the prices are DK/FD, but the edge is
      // measured against the sharp books, not against the book you bet at.
      // Without the qualifier the number reads as edge-over-DraftKings.
      ? ['Batter', 'The fade · model vs line', 'Price · DK/FD', 'Edge · vs sharp fair', 'Model P(under)', 'Call', '']
      : isML()
        ? ['Matchup', 'Team to win', 'Moneyline', 'Line value', 'Win Prob', '', '']
        : isRL()
          ? ['Matchup', 'Value side', 'Run line', 'Edge', 'Cover %', '', '']
        : ['Matchup', 'Model lean', 'Price · DK/FD', 'Edge', '80% Interval', '', ''];
    el.boardHead.innerHTML = cols.map((c) => c ? `<span class="col-label">${c}</span>` : '<span></span>').join('');
  }

  // Honest empty-state copy for the board — distinguishes "still loading",
  // "no two-way lines posted yet", "genuinely no games tonight", and
  // "filter/search hid everything".
  // Has tonight's slate already started? Games exist and none is still a Preview.
  // Separates "lines are not up YET" from "lines are gone" — identical from an
  // empty board, completely different to a reader. The run line already drew this
  // distinction; the batter board did not, so at 3pm on a Sunday it was telling
  // people to check back closer to first pitch while seven games were final.
  function slateGames() {
    return boardIsLive() ? (state.liveBoard || []) : [];
  }
  function slateStarted() {
    const rows = slateGames();
    return rows.length > 0 && rows.every((g) => g.status === 'Live' || g.status === 'Final');
  }

  function emptyBoardMessage() {
    if (isFeedLoading()) return `Loading tonight’s ${isBatter() ? 'batter props' : 'slate'}…`;
    // Batters get their own line because "no props" reads as broken when a book
    // visibly HAS batter markets up. What is missing is the two-way Over/Under
    // line; books post the milestone board ("2+ Total Bases") first and those
    // quote only the over, which cannot be de-vigged and cannot be bet on the
    // side we play. We never request the milestone keys, so this describes what
    // books usually do rather than claiming to have checked what is up now.
    if (LIVE_MODE && !boardHasLive()) {
      // A feed failure is ours, not the books'. Saying "no lines posted yet" over
      // a 401 points the reader at the wrong party and invites them to wait for
      // something that is not coming.
      if (state.feedError) {
        return state.feedError.kind === 'quota'
          ? 'Odds feed unavailable — our data plan is out of credits, so nothing can be priced right now. This is on us, not the sportsbooks. The graded record below is unaffected.'
          : 'Odds feed unavailable — we can’t reach the pricing data right now, so there is nothing to price. This is on us, not the sportsbooks. The graded record below is unaffected.';
      }
      if (isBatter()) {
        return slateStarted()
          ? 'Batter market closed — tonight’s games are underway or final, so books have pulled the props. Lines return before first pitch tomorrow.'
          : 'No two-way batter lines posted yet — books put the milestone markets (“2+ Total Bases”) up first, and those quote only the over. Pricing a fair number needs both sides. Check back closer to first pitch.';
      }
      return slateStarted()
        ? 'Tonight’s games are underway — the board returns with tomorrow’s slate.'
        : 'No games on tonight’s board yet.';
    }
    if (state.searchQuery.trim()) return 'No games match your search.';
    // Run Line depends on sportsbooks posting spreads — often later than K props.
    if (isRL() && state.filter === 'all') {
      return slateStarted()
        ? 'Run line market closed — tonight’s games are underway. Spreads return before first pitch tomorrow.'
        : 'No run lines posted yet — spreads usually go up closer to first pitch. Check back soon.';
    }
    return 'No games match this filter.';
  }

  // Sticky "tonight at a glance" bar under the header: plays (Tier 1–2),
  // best edge, watching (model likes it, no line yet), slate size. Computed
  // from the K-props base rows — the flagship market — and only in live mode.
  // Slate summary for the Under Plays board: a play is a tiered under with a
  // live price; tiered rows still waiting on a line are "watching".
  function renderBatterSlateSummary() {
    const rows = state.liveBatters;
    if (!rows || !rows.length) { el.slateSummary.hidden = true; return; }
    const tiered = (g) => isPlayTier(g.tier);
    const plays = rows.filter((g) => tiered(g) && g.odds != null);
    // "Watching" = we have a projection but no line to price it against. That
    // covers both a tiered row whose book quote dropped out and a projection-only
    // row from a feed outage — same state, same reason, so it counts the same.
    const watching = rows.filter((g) => g.odds == null && (tiered(g) || g.tier === 'model'));
    const best = plays.reduce((m, g) => (g.edge != null && g.edge > m ? g.edge : m), -Infinity);
    const bestStr = best > -Infinity ? '+' + best.toFixed(1) + '%' : '—';
    el.slateSummary.innerHTML = `<div class="ss-in">`
      + `<span><span class="k">Under plays</span><b style="color:var(--positive)">${plays.length}</b></span>`
      + `<span><span class="k">Best edge</span><b style="color:${best > -Infinity ? 'var(--positive)' : 'var(--textDim)'}">${bestStr}</b></span>`
      + `<span><span class="k">Watching</span><b style="color:var(--model)">${watching.length}</b></span>`
      + `<span><span class="k">Batters</span><b>${rows.length}</b></span>`
      + `<span class="upd">odds refresh every 5 min</span>`
      + `</div>`;
    el.slateSummary.hidden = false;
  }

  function renderSlateSummary() {
    if (!el.slateSummary) return;
    // On the Under Plays board the plays come from the batter feed; the K/ML/RL
    // views keep the game-board basis.
    if (isBatter()) return renderBatterSlateSummary();
    const rows = boardIsLive() ? state.liveBoard : (LIVE_MODE ? null : RAW_GAMES);
    if (!rows || !rows.length) { el.slateSummary.hidden = true; return; }
    const t = (g) => String(g.tier);
    // A play needs a real tier and a live price; tiered rows with no line yet
    // are "watching", and a closed (persisted) line is no longer a live play.
    const plays = rows.filter((g) => (t(g) === '1' || t(g) === '2') && g.odds != null && !g.closed);
    const watching = rows.filter((g) => g.odds == null && t(g) !== 'pass');
    const best = plays.reduce((m, g) => (g.edge != null && g.edge > m ? g.edge : m), -Infinity);
    const bestStr = best > -Infinity ? '+' + best.toFixed(1) + '%' : '—';
    el.slateSummary.innerHTML = `<div class="ss-in">`
      + `<span><span class="k">Plays</span><b style="color:var(--positive)">${plays.length}</b></span>`
      + `<span><span class="k">Best edge</span><b style="color:${best > -Infinity ? 'var(--positive)' : 'var(--textDim)'}">${bestStr}</b></span>`
      + `<span><span class="k">Watching</span><b style="color:var(--model)">${watching.length}</b></span>`
      + `<span><span class="k">Slate</span><b>${rows.length} game${rows.length === 1 ? '' : 's'}</b></span>`
      + `<span class="upd">odds refresh every 5 min</span>`
      + `</div>`;
    el.slateSummary.hidden = false;
  }

  // The "Why Under" cue under each pick: the model's cushion (its real reason to
  // fade) plus the factual matchup — who he faces and the park. Everything after
  // the cushion is optional and simply omitted when absent, so a pick with no
  // posted pitcher/park shows just the cushion — never a broken half-cue. We show
  // the park/hand DIRECTION (↓/↑), never the adjustment's unproven magnitude,
  // until platoon+park finishes validating.
  const LABEL_METRIC = { HR: 'hr', TB: 'tb', 'H+R+RBI': 'hrr' };

  // MLB club colors for the team badge — [background, readable text]. Keyed by
  // the abbreviations the feed emits, plus StatsAPI variants (AZ, CHW, OAK, …).
  // Any team not listed falls back to the neutral gold badge, so it never breaks.
  // Dark-primary clubs use a bright secondary as the text so they stay legible.
  const TEAM_COLORS = {
    ARI: ['#A71930', '#E3D4AD'], AZ: ['#A71930', '#E3D4AD'],
    ATL: ['#CE1141', '#ffffff'], BAL: ['#DF4601', '#111111'],
    BOS: ['#BD3039', '#ffffff'], CHC: ['#0E3386', '#ffffff'],
    CWS: ['#27251F', '#ffffff'], CHW: ['#27251F', '#ffffff'],
    CIN: ['#C6011F', '#ffffff'], CLE: ['#E31937', '#ffffff'],
    COL: ['#333366', '#C4CED4'], DET: ['#0C2340', '#FA4616'],
    HOU: ['#002D62', '#EB6E1F'], KC: ['#004687', '#ffffff'], KCR: ['#004687', '#ffffff'],
    LAA: ['#BA0021', '#ffffff'], LAD: ['#005A9C', '#ffffff'],
    MIA: ['#00A3E0', '#111111'], MIL: ['#12284B', '#FFC52F'],
    MIN: ['#002B5C', '#ffffff'], NYM: ['#002D72', '#FF5910'],
    NYY: ['#0C2340', '#ffffff'], ATH: ['#003831', '#EFB21E'], OAK: ['#003831', '#EFB21E'],
    PHI: ['#E81828', '#ffffff'], PIT: ['#27251F', '#FDB827'],
    SD: ['#2F241D', '#FFC425'], SDP: ['#2F241D', '#FFC425'],
    SF: ['#FD5A1E', '#111111'], SFG: ['#FD5A1E', '#111111'],
    SEA: ['#0C2C56', '#C4CED4'], STL: ['#C41E3A', '#FEDB00'],
    TB: ['#092C5C', '#8FBCE6'], TBR: ['#092C5C', '#8FBCE6'],
    TEX: ['#003278', '#ffffff'], TOR: ['#134A8E', '#ffffff'],
    WSH: ['#AB0003', '#ffffff'], WSN: ['#AB0003', '#ffffff'],
  };

  // Which tier of book produced the fair line this edge was measured against.
  // Shown on BOTH outcomes on purpose: "sharp" means an independent sharp
  // consensus priced it, "mkt" means no sharp book quoted this exact number and
  // it fell back to the book we bet at — the weaker, self-referential case. A
  // badge that only appeared on the good case would be marketing, not data.
  function fairSrcTag(g) {
    if (!isBatter() || !g.fairSrc) return '';
    const sharp = g.fairSrc === 'sharp';
    const title = sharp
      ? 'Fair line from the sharp books (Shin de-vigged median) — independent of DK/FD'
      : 'No sharp book quoted this line; fair fell back to the book being bet';
    return `<span class="fsrc${sharp ? ' sharp' : ''}" title="${esc(title)}">${sharp ? 'sharp' : 'mkt'}</span>`;
  }

  function whyUnderCue(g) {
    const cushion = Math.round((g.line - g.projVal) * 100) / 100;
    const cushTxt = cushion > 0
      ? `model <b>${g.projVal}</b> · <b class="u">${cushion} under</b> the ${g.line} line${cushion < 0.4 ? ' — thin' : ''}`
      : `model <b>${g.projVal}</b> · right at the ${g.line} line`;
    // The note is prose (what the model thinks); the two factors below it are
    // chips (what moved it). Splitting them stops the row reading as one long
    // mono sentence and lets the eye find the arrows.
    const chips = [];
    const hand = g.facingHand === 'L' ? 'LHP' : g.facingHand === 'R' ? 'RHP' : null;
    // Name the arm, not just the hand. The opposing starter now moves the
    // projection more than platoon or park, so showing who he is (and an arrow
    // when his own factor moved this metric) makes the adjustment legible.
    if (hand || g.oppPitcher) {
      const metric = LABEL_METRIC[g.marketLabel];
      const pa = g.oppPitcherAdj && metric ? g.oppPitcherAdj[metric] : null;
      let arrow = '';
      if (pa != null && pa < 0.98) arrow = ` <span class="bw-dn">↓</span>`;
      else if (pa != null && pa > 1.02) arrow = ` <span class="bw-up">↑</span>`;
      const last = g.oppPitcher ? String(g.oppPitcher).split(' ').slice(-1)[0] : null;
      const who = [hand, last].filter(Boolean).join(' ');
      chips.push(`<span class="bw-chip">vs ${esc(who)}${arrow}</span>`);
    }
    if (g.park) {
      const metric = LABEL_METRIC[g.marketLabel];
      const a = g.adj && metric ? g.adj[metric] : null;
      let arrow = '';
      if (a != null && a < 0.98) arrow = ` <span class="bw-dn">↓</span>`;
      else if (a != null && a > 1.02) arrow = ` <span class="bw-up">↑</span>`;
      const short = String(g.park).replace(/ (Park|Stadium|Field|Ballpark)$/i, '');
      chips.push(`<span class="bw-chip">${esc(short)}${arrow}</span>`);
    }
    return `<span class="bw-cush">${cushTxt}</span>`
      + (chips.length ? `<span class="bwhy">${chips.join('')}</span>` : '');
  }

  // One header per game, carrying the facts every row under it shares: the
  // matchup, first pitch (or the score once it starts), and both starters. Those
  // were repeating on all forty rows, which is forty copies of four facts and the
  // reason a phone row needed two lines for its subline.
  //
  // Working out which starter is which side: a row stores the arm ITS batter
  // faces, so that pitcher throws for the opponent. Read against "AWAY @ HOME",
  // a row whose team is the away side is facing the home starter, and vice
  // versa. Rows from one side only leave the other starter as a dash rather
  // than guessing.
  // Spelled out, not the column shorthand: the pick cell already says "TB", and
  // repeating the abbreviation under the name explains nothing to a reader who
  // didn't already know it.
  const MARKET_NAME = { tb: 'total bases', hrr: 'hits + runs + RBI', hr: 'home runs' };

  function gameGroupHeader(lead, games) {
    const rows = games.filter((g) => g.gamePk === lead.gamePk);
    const matchup = lead.gameMatchup || '';
    const [away, home] = matchup.split('@').map((s) => s.trim());
    let awayP = null, homeP = null;
    for (const r of rows) {
      if (!r.oppPitcher) continue;
      const hand = r.facingHand ? ` ${r.facingHand}` : '';
      // r.team faces r.oppPitcher, so that arm belongs to the other club.
      if (r.team === away) homeP = homeP || r.oppPitcher + hand;
      else if (r.team === home) awayP = awayP || r.oppPitcher + hand;
    }
    const arms = (awayP || homeP)
      ? `${awayP || '—'} vs ${homeP || '—'}`
      : '';
    // Once a game is underway the score is the useful fact, not the start time —
    // the same swap the row subline already makes.
    const when = lead.scorePart || lead.timeLabel || '';
    const n = rows.length;
    // A group whose rows are all folded away must fold with them, or the phone
    // shows a header standing over nothing.
    const allPass = rows.every((r) => String(activeTier(r)) === 'pass');
    const foldable = allPass && state.filter !== 'pass';
    return `<div class="game-group${foldable ? ' bp-pass' : ''}" role="presentation">
        <span class="gg-match">${esc(matchup)}</span>
        ${when ? `<span class="gg-when">${esc(when)}</span>` : ''}
        ${arms ? `<span class="gg-arms">${esc(arms)}</span>` : ''}
        <span class="gg-n">${n} batter${n === 1 ? '' : 's'}</span>
      </div>`;
  }

  function renderBoard() {
    const games = getFilteredSortedGames();
    // Same-game correlation: count how many board picks share each game so we can
    // warn when multiple unders ride the same matchup (they hit/miss together).
    // Batter board only — keyed by gamePk, which every batter row carries.
    // Only priced rows count: the warning is about bets riding the same game, so
    // on a projection-only board there is nothing to be correlated about, and the
    // tag would read as a same-game parlay hint over rows that aren't playable.
    const gameCounts = {};
    if (isBatter()) games.forEach((g) => {
      if (g.gamePk != null && g.tier !== 'model') gameCounts[g.gamePk] = (gameCounts[g.gamePk] || 0) + 1;
    });
    renderSlateSummary();
    el.noResults.hidden = games.length !== 0;
    if (!games.length) el.noResults.textContent = emptyBoardMessage();

    // "showing 12 of 40 batters" — tells you a filter is hiding rows, which a
    // bare list can't. Total is the unfiltered pool for the active view.
    // Fold gate, computed before the label so both agree. It is also read by the
    // row map and the toggle button further down.
    // Grouping is a property of the ORDER, not a display toggle: a header only
    // means anything when the rows it covers are adjacent. Sorted by first pitch
    // they are; sorted by edge the same game's batters are scattered down the
    // board and heading each one would emit a header per row. So it follows the
    // sort rather than fighting it.
    //
    // Batter only. K props, moneyline and the run line are already one row per
    // game, so a header would restate the row directly beneath it. (The design
    // groups K props too, but that assumes a row per STARTER; ours is per game.)
    // Declared here rather than beside the row map because the footer label
    // below reports it, and that runs first.
    const grouped = isBatter() && effectiveSortKey() === 'time';

    const PLAY_FLOOR = 5;
    const playCount = isBatter()
      ? games.filter((g) => isPlayTier(activeTier(g))).length : 0;
    const foldPasses = playCount >= PLAY_FLOOR;
    const passCount = isBatter() && state.filter !== 'pass' && foldPasses
      ? games.filter((g) => String(activeTier(g)) === 'pass').length : 0;
    const foldActive = passCount > 0 && !state.batterShowPass;

    const shownEl = document.getElementById('shownLabel');
    if (shownEl) {
      const total = getGames().length;
      const noun = isBatter() ? 'batter' : 'game';
      const plural = (n) => `${noun}${n === 1 ? '' : 's'}`;
      // Two labels ship and CSS picks one, the same pattern as the tier chips and
      // the count qualifier. The fold is a CSS decision keyed on width, so JS
      // cannot know whether rows are actually hidden — but it does know whether a
      // fold WOULD apply, which is enough to render both readings and let the
      // media query choose. Without this the footer read "showing 29 of 29" over
      // a board displaying 14.
      // Name the ordering, and say when rows are grouped. Both are visible in the
      // toolbar, but the footer is where someone looks to explain a board that
      // isn't in the order they expected — and grouping is otherwise only
      // inferable from the headers themselves.
      const sortKey = effectiveSortKey();
      const sortName = (sortKey === 'model' ? modelSortLabel() : SORT_LABELS[sortKey] || '').toLowerCase();
      const order = sortName ? ` · sorted by ${sortName}` : '';
      const groupNote = grouped ? ' · grouped by game' : '';
      shownEl.className = foldActive ? 'sl-has-fold' : '';
      shownEl.innerHTML = total
        ? `<span class="sl-full">showing ${games.length} of ${total} ${plural(total)}${order}${groupNote}</span>`
          + (foldActive
            ? `<span class="sl-folded">showing ${games.length - passCount} of ${total} ${plural(total)}`
              + ` · ${passCount} pass ${passCount === 1 ? 'row' : 'rows'} folded${groupNote}</span>`
            : '')
        : '';
    }

    // Run Line renders as game cards, not table rows — hide the table head and
    // the panel border so the cards stand free, then bail before the row map.
    // The active view drives --bcols (see style.css): each board gets its own
    // column template, and the head row and data rows read it from the same
    // place so they can never fall out of step.
    const boardWrap = document.getElementById('boardWrap');
    if (boardWrap) boardWrap.className = 'board view-' + state.boardView;
    if (el.boardHead) el.boardHead.style.display = '';
    if (boardWrap) { boardWrap.style.border = ''; boardWrap.style.background = ''; }
    renderBoardHead();
    // The run line has no DK/FD price of its own to pin, so the note stays off
    // there even though it is now a table like the rest.
    if (el.pinNote) el.pinNote.hidden = isRL()
      || !getGames().some((g) => Array.isArray(g.oddsBooks) && g.oddsBooks.length);

    if (isRL()) {
      el.boardRows.innerHTML = renderRunlineRows(games);
      el.boardRows.className = '';
      if (el.passMore) el.passMore.hidden = true;
      return;
    }

    el.boardRows.innerHTML = games.map((g, i) => {
      // Emitted ahead of the row it belongs to, so it inherits the row's place
      // in the sorted list instead of needing a second pass.
      const groupHtml = grouped && (i === 0 || games[i - 1].gamePk !== g.gamePk)
        ? gameGroupHeader(g, games)
        : '';
      const ml = g.ml || {};
      const isTracked = !!state.slip[legIdFor(g)];
      const isSelected = state.compareIds.includes(g.id);
      const isExpanded = state.expandedId === g.id;

      const edgeVal = activeEdge(g);
      const hasEdge = edgeVal != null;
      // Green/red edge is a PLAY signal — reserve it for the batter board. On the
      // context views (ML/K/RL) the edge is information, not a recommendation, so
      // it renders neutral: a losing moneyline can't masquerade as green "value".
      const edgeColor = (!hasEdge || !isBatter()) ? 'var(--textDim)' : (edgeVal > 0 ? 'var(--positive)' : 'var(--danger)');
      const edgeLabel = !hasEdge ? '—' : (edgeVal > 0 ? '+' : '') + edgeVal.toFixed(1) + '%';
      const tierVal = activeTier(g);
      // How many board picks share this pick's game (batter view) — drives the
      // same-game correlation flag + a faint row tint that groups the cluster.
      const corrN = isBatter() && g.gamePk != null ? (gameCounts[g.gamePk] || 0) : 0;

      // Post-pivot: only batter unders are plays. Context views (K/ML) show an
      // "analysis" chip instead of a tier, and no slip star.
      const isPlayView = isBatter();
      // Built here rather than beside the row template because the batter cell
      // renders the star inline with the name — it tracks that pick, so it sits
      // with it instead of floating in a column of its own.
      const leadingHtml = state.compareMode
        ? `<span class="leading checkbox${isSelected ? ' selected' : ''}" data-action="leading-click" data-id="${g.id}" role="checkbox" tabindex="0" aria-checked="${isSelected}" aria-label="Select ${esc(g.matchup)} to compare" title="Select to compare">${isSelected ? '\u2713' : ''}</span>`
        : (isPlayView
          ? `<span class="leading${isTracked ? ' tracked' : ''}" data-action="leading-click" data-id="${g.id}" role="button" tabindex="0" aria-pressed="${isTracked}" aria-label="Track ${esc(g.matchup)}" title="Track this pick">${isTracked ? '\u2605' : '\u2606'}</span>`
          : '');

      // The four view-specific cells (pick, odds, [edge — shared], detail).
      const money = (v) => v == null ? '—' : (v > 0 ? '+' + v : String(v));
      let pickCell, oddsCell, detailCell;
      if (isML()) {
        pickCell = esc(ml.pick || '—');
        oddsCell = ml.price != null
          ? `<span class="odds-cell mono">${esc(money(ml.price))}</span>`
          : `<span class="odds-blank">${esc(projReason(g))}</span>`;
        detailCell = `<span class="interval-cell" style="color:var(--model)">${ml.winProb != null ? ml.winProb + '%' : '—'}</span>`;
      } else if (isBatter()) {
        // The fade cell: pick + mini model-vs-line scale + cushion, all real fields.
        pickCell = esc(g.pick);
        if (g.line != null && g.projVal != null) {
          const axisMax = g.line <= 1 ? 2 : Math.max(4, Math.ceil(g.line + 1.5));
          const pct = (v) => Math.max(3, Math.min(97, v / axisMax * 100));
          const lp = pct(g.line), mp = pct(g.projVal);
          // Fill runs to where the model lands; the tick marks the posted line.
          // The gap between them IS the cushion — the thing being bet.
          pickCell = `<span class="fade-pick">${esc(g.pick)}</span>`
            + `<span class="bmini"><span class="uz" style="width:${mp}%"></span>`
            + `<span class="tick" style="left:${lp}%"></span></span>`
            + whyUnderCue(g);
        }
        const priced = hasEdge || g.odds != null || (Array.isArray(g.oddsBooks) && g.oddsBooks.length);
        oddsCell = g.closed
          ? `<span class="odds-cell mono closed">${esc(money(g.odds))}<span class="closed-tag">closed</span></span>`
          : (priced ? oddsBooksCell(g, money) : `<span class="odds-blank">${esc(projReason(g))}</span>`);
        const pUnder = typeof g.modelOver === 'number' ? Math.round((100 - g.modelOver) * 10) / 10 : null;
        detailCell = `<span class="interval-cell" style="color:var(--model)">${pUnder != null ? pUnder + '%' : esc(g.interval)}</span>`;
      } else {
        pickCell = esc(g.pick);
        // Reason only when truly projection-only: no edge AND no price. An
        // evaluated Pass (has an edge) still shows its price, never "awaiting line".
        const priced = hasEdge || g.odds != null || (Array.isArray(g.oddsBooks) && g.oddsBooks.length);
        oddsCell = g.closed
          // Persisted closing line — show the final price, marked closed (not bettable).
          ? `<span class="odds-cell mono closed">${esc(money(g.odds))}<span class="closed-tag">closed</span></span>`
          : (priced ? oddsBooksCell(g, money) : `<span class="odds-blank">${esc(projReason(g))}</span>`);
        detailCell = `<span class="interval-cell">${esc(g.interval)}</span>`;
      }

      const rowClasses = ['board-row'];
      // Keyed on the row, so a batter's bar fills when he first reaches the
      // board and stays put through every later refresh.
      const rowAnim = barsIn('row:' + g.id);
      if (rowAnim) rowClasses.push(rowAnim.trim());
      if (isSelected) rowClasses.push('selected');
      else if (isExpanded) rowClasses.push('expanded');
      if (corrN >= 2) rowClasses.push('corr');
      // Passes fold on a phone. Only on the batter board, only when the reader
      // has not explicitly filtered TO passes, and never on desktop. Plays are
      // never folded — the board recommends them, so they stay on screen; these
      // are the rows the model already declined to back.
      if (isPlayView && String(tierVal) === 'pass' && state.filter !== 'pass' && foldPasses) rowClasses.push('bp-pass');

      const rowA11y = state.compareMode
        ? `role="button" tabindex="0" aria-pressed="${isSelected}" aria-label="Compare ${esc(g.matchup)}"`
        : `role="button" tabindex="0" aria-expanded="${isExpanded}" aria-label="${esc(g.matchup)} — toggle breakdown"`;

      // Matchup cell. K-props lead with the pitcher duel (the arm is the play);
      // moneyline/batter views keep the team-led headline.
      const weatherHtml = g.weather ? `<span class="weather-label" style="color:var(--${g.weatherTone || 'textDim'})">${esc(g.weather)}</span>` : '';
      const starters = (!isML() && !isBatter() && Array.isArray(g.projRows)) ? g.projRows.filter((p) => p && p.name) : [];
      let matchupCell;
      if (starters.length >= 2) {
        const lastName = (n) => String(n).replace(/^[A-Z]\.\s+/, '');
        const handTag = (h) => h === 'L' ? 'LHP' : h === 'R' ? 'RHP' : '';
        const duel = starters.slice(0, 2).map((p) => {
          const isPick = g.pick && g.pick.indexOf(p.name) === 0;
          const ht = handTag(p.hand);
          return `<span class="mp-name${isPick ? ' pick' : ''}">${esc(lastName(p.name))}${ht ? `<span class="mp-hand">${ht}</span>` : ''}</span>`;
        }).join('<span class="mp-vs">vs</span>');
        const sub = [g.matchup, g.timeLabel, g.scorePart].filter(Boolean).join(' · ');
        matchupCell = `<div class="matchup-cell">
            <div class="mc-head">${leadingHtml}<span class="mp-duel">${duel}</span></div>
            <span class="matchup-sub">${esc(sub)}</span>
            ${weatherHtml}
          </div>`;
      } else {
        // On the batter board g.matchup is the player's name; g.team is the club
        // he plays for. Badge it so you can tell at a glance which side he's on
        // without knowing the player. (Other views reuse this branch without a
        // per-player team, so the badge only shows when g.team is present.)
        let teamBadge = '';
        if (isBatter() && g.team) {
          const tc = TEAM_COLORS[g.team];
          teamBadge = tc
            ? ` <span class="team-badge tc" style="background:${tc[0]};color:${tc[1]}">${esc(g.team)}</span>`
            : ` <span class="team-badge">${esc(g.team)}</span>`;
        }
        const corrTag = corrN >= 2 ? `<span class="corr-tag" title="Correlated: these unders share one game and tend to hit or miss together">${corrN} in this game</span>` : '';
        // Under a group header the subline would repeat the header verbatim, so
        // the line goes to the market instead — which the row otherwise only
        // states inside its pick, in shorthand.
        const sub = grouped ? MARKET_NAME[g.metric] || '' : g.subline;
        matchupCell = `<div class="matchup-cell">
            <span class="mc-head">${leadingHtml}<b>${esc(g.matchup)}</b>${teamBadge}</span>
            ${sub ? `<span class="matchup-sub">${esc(sub)}</span>` : ''}
            ${weatherHtml}${corrTag}
          </div>`;
      }

      const rowHtml = `
        <div class="${rowClasses.join(' ')}" data-action="row-click" data-id="${g.id}" ${rowA11y}>
          ${matchupCell}
          <span>${pickCell}</span>
          ${oddsCell}
          <span class="edge-cell" style="color:${edgeColor}">${esc(edgeLabel)}${fairSrcTag(g)}</span>
          ${detailCell}
          <span class="tier-cell">${isPlayView ? tierChip(tierVal) : '<span class="ctx-chip">analysis</span>'}</span>
          <span class="chevron">${isExpanded ? '▲' : '▼'}</span>
        </div>
      `;

      let detailHtml = '';
      if (isExpanded && isBatter()) {
        // Markets with no posted line can't be bet, so they don't earn a row each.
        // Price the ones that are live, then roll the rest into a single summary
        // line — on a phone those unpriced rows were half the table's height.
        const allMarkets = g.batterMarkets || [];
        const priced = allMarkets.filter((m) => !m.none);
        const unpriced = allMarkets.filter((m) => m.none);
        const bm = priced.map((m) => {
          const booksStr = Array.isArray(m.books) && m.books.length
            ? m.books.map((b) => `${b.book} ${b.off && b.line != null ? b.line + ' ' : ''}${b.price > 0 ? '+' + b.price : b.price}${b.best ? ' ✓' : ''}`).join(' · ')
            : '';
          return `<div class="bm-row">
            <span class="bm-label">${esc(m.label)}</span>
            <span class="bm-proj">proj ${esc(String(m.proj))} · model ${m.modelOver}% over</span>
            <span class="bm-pick" style="color:${m.edge >= 1.5 ? 'var(--positive)' : 'var(--textDim)'}">${m.side} ${m.line} · +${m.edge}%</span>
            <span class="bm-books">${esc(booksStr)}</span>
          </div>`;
        }).join('');
        // "No line posted: HR proj 0 · TB proj 0.33" measured 40 characters, which
        // wraps to two lines inside the 264px this row gets on a phone and made a
        // one-line summary 60px tall. Saying "proj" once in the lead instead of
        // per market drops it to ~30 and back onto a single line, without losing
        // what the numbers are.
        const noLine = unpriced.length
          ? `<div class="bm-row noline"><span class="bm-none">No line (proj): ${
              unpriced.map((m) => `<b>${esc(m.label)}</b> ${esc(String(m.proj))}`).join(' · ')
            }</span></div>`
          : '';
        const statsHtml = (g.stats || []).map((s) => `
          <div class="stat-row">
            <span class="stat-label">${esc(s.label)}</span>
            <div class="track"><div class="fill" style="width:${s.value}%;background:${TONE_COLOR[s.tone]}"></div></div>
            <span class="badge" style="color:${TONE_COLOR[s.tone]}">${s.value}</span>
          </div>`).join('');
        detailHtml = `<div class="expanded-detail${barsIn('panel:' + g.id)}">
          ${rowPriceRead(g)}
          <div class="expanded-title">Batter props — model vs. market</div>
          <div class="bm-table">${bm}${noLine}</div>
          <details class="pctl"${window.innerWidth > 640 ? ' open' : ''}><summary>Season percentiles (vs. priced pool)</summary>${statsHtml}</details>
          <details class="method"${window.innerWidth > 640 ? ' open' : ''}><summary>How this projection is built</summary>
          <p class="expanded-note">Projection: season rate × expected PAs, adjusted for the <b>opposing starter</b>, the <b>hand</b> he throws and the <b>ballpark</b>, then spread with a <b>negative binomial</b> — real batter outcomes are more dispersed than a Poisson allows. Edge = model P(under) vs. the <b>fair line</b> — the Shin de-vigged median across the sharp books (Pinnacle, novig, ProphetX), never the book you bet at. The model is regressed toward that fair line while it builds a track record, so edges stay conservative until results justify more.</p>
          </details>
        </div>`;
      } else if (isExpanded && isML()) {
        if (g.ml) {
          const priceStr = g.ml.price == null ? '—' : money(g.ml.price);
          const edgeStr = g.ml.edge == null ? '—' : `+${g.ml.edge}% edge`;

          // Head-to-head starting-pitcher duel, built from the two real starters
          // on this game (projRows). Pick's side is ordered first so it's on top
          // when the two columns stack on a phone. Bars are a 0–100 "goodness"
          // score (same thresholds as the batter percentile bars); the badge
          // shows the real stat. ERA is inverted — lower is better.
          const toneOf = (v) => v >= 66 ? 'cool' : v >= 33 ? 'warm' : 'hot';
          const wpFor = (t) => t === g.ml.homeAbbr ? g.ml.homeWinProb : t === g.ml.awayAbbr ? g.ml.awayWinProb : null;
          const modelFor = (t) => t === g.ml.homeAbbr ? g.ml.homeModelProb : t === g.ml.awayAbbr ? g.ml.awayModelProb : null;
          const starters = (Array.isArray(g.projRows) ? g.projRows : []).filter((p) => p && p.name);
          const ordered = starters.slice().sort((a, b) =>
            (b.team === g.ml.teamAbbr ? 1 : 0) - (a.team === g.ml.teamAbbr ? 1 : 0));

          let duelHtml = '';
          if (ordered.length) {
            const bar = (score, tone) => `<div class="track"><div class="fill" style="width:${clampPct(score)}%;background:${TONE_COLOR[tone]}"></div></div>`;
            const statRow = (label, score, tone, badge) =>
              `<div class="stat-row"><span class="stat-label">${label}</span>${bar(score, tone)}<span class="badge" style="color:${TONE_COLOR[tone]}">${badge}</span></div>`;
            duelHtml = `<div class="ml-duel">` + ordered.map((p) => {
              const isPick = p.team === g.ml.teamAbbr;
              const wp = wpFor(p.team);
              const mp = modelFor(p.team);
              // Show our log5 model next to the sharp fair line, with the gap.
              // Positive delta = model is more bullish on this team than Pinnacle.
              const showModel = mp != null && g.ml.fairSource !== 'model';
              const delta = (showModel && wp != null) ? mp - wp : null;
              const deltaCls = delta == null ? '' : Math.abs(delta) >= 5 ? ' big' : '';
              const modelLine = showModel
                ? `<span class="ml-pmodel">model ${mp}%${delta != null ? `<span class="ml-delta${deltaCls}">${delta > 0 ? '+' : ''}${delta}</span>` : ''}</span>`
                : '';
              const eraNum = p.era != null ? parseFloat(p.era) : null;
              const projScore = p.proj != null ? p.proj / 10 * 100 : 0;
              const k9Score = p.k9 != null ? p.k9 / 14 * 100 : 0;
              const eraScore = eraNum != null ? (6 - eraNum) / 6 * 100 : 0;
              return `<div class="ml-pcol${isPick ? ' pick-side' : ''}">
                <div class="ml-phead">
                  <span class="ml-pname">${esc(p.name)}${isPick ? '<span class="ml-picktag">◄ pick</span>' : ''}</span>
                  <span class="ml-pwp-wrap">
                    <span class="ml-pwp ${isPick ? 'on' : 'off'}">${esc(p.team)} · ${wp != null ? wp + '%' : '—'}</span>
                    ${modelLine}
                  </span>
                </div>
                ${statRow('Proj Ks', projScore, toneOf(projScore), p.proj != null ? p.proj : '—')}
                ${statRow('K/9', k9Score, toneOf(k9Score), p.k9 != null ? p.k9 : '—')}
                ${statRow('ERA', eraScore, toneOf(eraScore), p.era != null ? p.era : '—')}
              </div>`;
            }).join('') + `</div>`;
          } else {
            duelHtml = `<div style="display:flex;gap:24px;margin-top:6px;font-family:'IBM Plex Mono';font-size:14px">
              <span>${esc(g.ml.awayAbbr || '')} <b style="color:var(--accent)">${g.ml.awayWinProb != null ? g.ml.awayWinProb + '%' : '—'}</b></span>
              <span>${esc(g.ml.homeAbbr || '')} <b style="color:var(--accent)">${g.ml.homeWinProb != null ? g.ml.homeWinProb + '%' : '—'}</b></span>
            </div>`;
          }

          const fairNote = g.ml.fairSource === 'pinnacle'
            ? `Win% is Pinnacle's sharp de-vigged line (the fair number). Edge = how much the DK/FD price you'd bet beats that fair line.`
            : g.ml.fairSource === 'dkfd'
              ? `No Pinnacle line yet — win% is the DK/FD vig-free line and edge is our model vs. that.`
              : `No market line yet — win% is our log5 model (team rating + home field + starter ERA).`;
          detailHtml = `<div class="expanded-detail${barsIn('panel:' + g.id)}">
            <div class="expanded-title">Starting pitchers — model matchup</div>
            ${duelHtml}
            <div class="ml-pickline">pick ${esc(g.ml.pick || '—')} <span style="color:var(--text)">(${esc(priceStr)})</span> · ${esc(edgeStr)}</div>
            <div style="color:var(--textDim);font-size:12px;margin-top:12px">${fairNote} Bars score each starter's projected Ks, season K/9, and ERA (lower is better).</div></div>`;
        } else {
          detailHtml = `<div class="expanded-detail${barsIn('panel:' + g.id)}"><div class="expanded-title">Moneyline pending</div><div style="color:var(--textDim);font-size:13px">No moneyline posted for this game yet.</div></div>`;
        }
      } else if (isExpanded) {
        if (g.stats && g.stats.length) {
          const statsHtml = g.stats.map((s) => `
            <div class="stat-row">
              <span class="stat-label">${esc(s.label)}</span>
              <div class="track"><div class="fill" style="width:${s.value}%;background:${TONE_COLOR[s.tone]}"></div></div>
              <span class="badge" style="color:${TONE_COLOR[s.tone]}">${s.value}</span>
            </div>
          `).join('');
          detailHtml = `<div class="expanded-detail${barsIn('panel:' + g.id)}"><div class="expanded-title">Percentile breakdown</div>${statsHtml}</div>`;
        } else if (g.projRows && g.projRows.length) {
          const rowsHtml = g.projRows.map((p) => {
            const m = p.market;
            const booksStr = m && Array.isArray(m.books) && m.books.length
              ? m.books.map((b) => `${b.book} ${b.off && b.line != null ? b.line + ' ' : ''}${b.price > 0 ? '+' + b.price : b.price}${b.best ? ' ✓' : ''}`).join(' · ')
              : '';
            // Consensus fair: median de-vigged P(over) across the pooled books.
            // Only shown when >1 book actually agreed on the line (else it's just
            // one book and there's nothing to "consensus"). MGM is reference-only.
            const fairPct = m ? Math.round(m.fairOver * 1000) / 10 : null;
            const consensusStr = m && Array.isArray(m.fairBooks) && m.fairBooks.length >= 2
              ? `fair ${fairPct}% · ${m.fairBooks.map((b) => `${b.book} ${(b.over * 100).toFixed(1)}`).join(' · ')}`
              : '';
            const marketHtml = m
              ? `<span style="font-family:'IBM Plex Mono';font-size:12.5px;color:var(--text)">line ${m.line} · model ${m.modelOver}% over</span>
                 <span style="font-family:'IBM Plex Mono';font-size:12.5px;color:${m.edge >= 1.5 ? 'var(--positive)' : 'var(--textDim)'}">${m.side} ${m.line} · +${m.edge}% edge</span>
                 ${consensusStr ? `<span style="font-family:'IBM Plex Mono';font-size:12px;color:var(--textDim)" title="median de-vigged P(over) across the books that posted this line">${esc(consensusStr)}</span>` : ''}
                 ${booksStr ? `<span style="font-family:'IBM Plex Mono';font-size:12.5px;color:var(--textDim)">${esc(booksStr)}</span>` : ''}`
              : `<span style="font-family:'IBM Plex Mono';font-size:12px;color:var(--textDim)">no prop line</span>`;
            return `
            <div style="display:flex;align-items:baseline;gap:10px;margin-top:10px;flex-wrap:wrap">
              <span style="font-family:'Archivo',sans-serif;font-weight:700;font-size:16px;text-transform:uppercase;min-width:120px">${esc(p.name)}</span>
              <span style="font-family:'IBM Plex Mono';font-size:14px;color:var(--accent);font-weight:600">${p.proj} K</span>
              <span style="font-family:'IBM Plex Mono';font-size:12.5px;color:var(--textDim)">80% ${p.lo} – ${p.hi}</span>
              <span style="font-family:'IBM Plex Mono';font-size:12px;color:var(--textDim)">opp K ${p.oppKpct}%</span>
              ${parkWxHtml(p)}
              ${marketHtml}
            </div>`;
          }).join('');
          detailHtml = `<div class="expanded-detail${barsIn('panel:' + g.id)}"><div class="expanded-title">Projected strikeouts — model vs. market</div>${rowsHtml}<div style="color:var(--textDim);font-size:12px;margin-top:12px">Projection: K/9 × expected innings × opponent K-rate × park × weather. Edge = model P(over) vs. the <b>fair line</b> — the median de-vigged P(over) across DK, FD &amp; MGM. MGM is a sharpness reference only; you still bet the best of DK/FD.</div></div>`;
        } else {
          detailHtml = `<div class="expanded-detail${barsIn('panel:' + g.id)}"><div class="expanded-title">Model projection pending</div><div style="color:var(--textDim);font-size:13px">Live game from tonight's slate — probable pitcher not posted yet.</div></div>`;
        }
      }

      return groupHtml + rowHtml + detailHtml;
    }).join('');

    // Pass-fold plumbing, set after the rows exist. The container class drives
    // the CSS; the button names how many rows are folded so the count is never a
    // mystery. Desktop ignores both -- see the 640px rule.
    el.boardRows.className = state.batterShowPass ? 'show-pass' : '';
    if (el.passMore) {
      const passN = passCount;
      el.passMore.hidden = passN === 0;
      el.passMore.textContent = state.batterShowPass
        ? 'Hide ' + passN + ' Pass row' + (passN === 1 ? '' : 's')
        : 'Show ' + passN + ' Pass row' + (passN === 1 ? '' : 's') + ' the model declined';
    }
  }

  // Run Line view — game cards. The value side (DK/FD price beats Pinnacle's
  // de-vigged run line) is the Pick, and it only lights up when the win% model
  // agrees the game breaks that way; otherwise the card sits under the Pass tab.
  // Styles are injected once so style.css stays untouched.




  function renderComparePanel() {
    const showPanel = state.compareMode && state.compareIds.length === 2;
    if (!showPanel) { el.comparePanel.innerHTML = ''; return; }
    const compareGames = getGames().filter((g) => state.compareIds.includes(g.id));
    const sidesHtml = compareGames.map((g) => {
      const ml = g.ml || {};
      const pick = isML() ? (ml.pick || '—') : g.pick;
      const edgeVal = activeEdge(g);
      const tierVal = activeTier(g);
      const hasEdge = edgeVal != null;
      const edgeLabel = !hasEdge ? '—' : (edgeVal > 0 ? '+' : '') + edgeVal.toFixed(1) + '%';
      const edgeColor = !hasEdge ? 'var(--textDim)' : (edgeVal > 0 ? 'var(--positive)' : 'var(--danger)');
      const third = isML()
        ? `<div><div class="stat-k">Win prob</div><div class="stat-v" style="color:var(--model)">${ml.winProb != null ? ml.winProb + '%' : '—'}</div></div>`
        : `<div><div class="stat-k">Tier</div><div class="stat-v tier">${tierChip(tierVal)}</div></div>`;
      return `
        <div class="compare-side">
          <div class="name">${esc(g.matchup)}</div>
          <div class="sub">${esc(g.subline)}</div>
          <div class="stats-row">
            <div><div class="stat-k">Pick</div><div class="stat-v">${esc(pick)}</div></div>
            <div><div class="stat-k">Edge</div><div class="stat-v" style="color:${edgeColor}">${esc(edgeLabel)}</div></div>
            ${third}
          </div>
        </div>
      `;
    }).join('');
    el.comparePanel.innerHTML = `
      <div class="compare-panel">
        <div class="compare-panel-head">
          <span class="title">Side-by-side comparison</span>
          <button class="clear-btn" data-action="clear-compare">Clear</button>
        </div>
        <div class="compare-grid">${sidesHtml}</div>
      </div>
    `;
  }

  function renderHittersGrid() {
    if (!getHitters().length) {
      el.hittersGrid.innerHTML = `<div class="leaders-empty">${state.liveHitters === null ? 'Loading season leaders…' : 'Leaders appear once the season’s stats post.'}</div>`;
      return;
    }
    el.hittersGrid.innerHTML = getHitters().map((h, i) => {
      const isSelected = state.hitterCompareIds.includes(i);
      const cardClasses = ['hitter-card'];
      if (state.hitterCompareMode) cardClasses.push('compare-active');
      if (isSelected) cardClasses.push('selected');
      const checkboxHtml = state.hitterCompareMode
        ? `<span class="checkbox${isSelected ? ' selected' : ''}">${isSelected ? '✓' : ''}</span>`
        : '';
      const clickAttr = state.hitterCompareMode
        ? ` data-action="hitter-card-click" data-idx="${i}" role="checkbox" tabindex="0" aria-checked="${isSelected}" aria-label="Select ${esc(h.name)} to compare"`
        : '';
      const statVal = h.statVal || h.woba;
      const statLabel = h.statLabel || 'wOBA · L10';
      return `
        <div class="${cardClasses.join(' ')}"${clickAttr}>
          <div class="top-row">
            <span class="rank">#${i + 1}</span>
            ${checkboxHtml}
            <span class="stat-num">${esc(statVal)}</span>
          </div>
          <div class="name">${esc(h.name)}</div>
          <div class="team">${esc(h.team)}</div>
          <div class="stat-sub">${esc(statLabel)}</div>
          <div class="chip-row">
            <span class="chip positive">${esc(h.streak)}</span>
            <span class="chip plain">${h.hrs} HR</span>
          </div>
        </div>
      `;
    }).join('');
  }

  function renderHitterComparePanel() {
    const showPanel = state.hitterCompareMode && state.hitterCompareIds.length === 2;
    if (!showPanel) { el.hitterComparePanel.innerHTML = ''; return; }
    const hitters = getHitters();
    const compareHitters = state.hitterCompareIds.map((i) => hitters[i]).filter(Boolean);
    const sidesHtml = compareHitters.map((h) => `
      <div class="compare-side">
        <div class="name">${esc(h.name)}</div>
        <div class="sub">${esc(h.team)}</div>
        <div class="stats-row">
          <div><div class="stat-k">${esc(h.statLabel ? h.statLabel.split(' · ')[0] : 'wOBA L10')}</div><div class="stat-v big accent">${esc(h.statVal || h.woba)}</div></div>
          <div><div class="stat-k">HR</div><div class="stat-v big">${h.hrs}</div></div>
          <div><div class="stat-k">${h.statLabel ? 'AVG' : 'Streak'}</div><div class="stat-v positive">${esc(h.streak)}</div></div>
        </div>
      </div>
    `).join('');
    el.hitterComparePanel.innerHTML = `
      <div class="compare-panel">
        <div class="compare-panel-head">
          <span class="title">Hitter comparison</span>
          <button class="clear-btn" data-action="clear-hitter-compare">Clear</button>
        </div>
        <div class="compare-grid">${sidesHtml}</div>
      </div>
    `;
  }

  function renderSplits() {
    // Live = OPS split (higher better); mock = wOBA-ish integer.
    const opsTone = (v) => v >= 800 ? 'var(--positive)' : v >= 700 ? 'var(--accent)' : 'var(--textDim)';
    const wobaTone = (v) => v >= 370 ? 'var(--positive)' : v >= 330 ? 'var(--accent)' : 'var(--textDim)';
    el.splitRows.innerHTML = getHitters().map((h) => {
      let lL = '—', rL = '—', lT = 'var(--textDim)', rT = 'var(--textDim)';
      if (h.splitL != null || h.splitR != null) {
        if (h.splitL != null) { lL = h.splitL; lT = opsTone(h.splitLnum || 0); }
        if (h.splitR != null) { rL = h.splitR; rT = opsTone(h.splitRnum || 0); }
      } else if (typeof h.lhp === 'number') {
        lL = '.' + h.lhp; rL = '.' + h.rhp; lT = wobaTone(h.lhp); rT = wobaTone(h.rhp);
      }
      return `
        <div class="split-row">
          <span class="split-name">${esc(h.name)}</span>
          <span class="split-val" style="color:${lT}">${esc(lL)}</span>
          <span class="split-val" style="color:${rT}">${esc(rL)}</span>
        </div>`;
    }).join('');
  }

  function renderPitchers() {
    if (!getPitchers().length) {
      el.pitchersGrid.innerHTML = `<div class="leaders-empty">${state.livePitchers === null ? 'Loading season leaders…' : 'Leaders appear once the season’s stats post.'}</div>`;
      return;
    }
    el.pitchersGrid.innerHTML = getPitchers().map((p, i) => {
      const isSelected = state.pitcherCompareIds.includes(i);
      const cardClasses = ['hitter-card'];
      if (state.pitcherCompareMode) cardClasses.push('compare-active');
      if (isSelected) cardClasses.push('selected');
      const checkboxHtml = state.pitcherCompareMode
        ? `<span class="checkbox${isSelected ? ' selected' : ''}">${isSelected ? '✓' : ''}</span>`
        : '';
      const clickAttr = state.pitcherCompareMode
        ? ` data-action="pitcher-card-click" data-idx="${i}" role="checkbox" tabindex="0" aria-checked="${isSelected}" aria-label="Select ${esc(p.name)} to compare"`
        : '';
      const statVal = p.statVal || (p.csw + '%');
      const statLabel = p.statLabel || 'CSW% · L3 starts';
      const chip1 = p.chip1 || (p.kRate + ' K/9');
      const chip2 = p.chip2 || (p.era + ' ERA');
      return `
        <div class="${cardClasses.join(' ')}"${clickAttr}>
          <div class="top-row">
            <span class="rank">#${i + 1}</span>
            ${checkboxHtml}
            <span class="stat-num">${esc(statVal)}</span>
          </div>
          <div class="name">${esc(p.name)}</div>
          <div class="team">${esc(p.team)}</div>
          <div class="stat-sub">${esc(statLabel)}</div>
          <div class="chip-row">
            <span class="chip positive">${esc(chip1)}</span>
            <span class="chip plain">${esc(chip2)}</span>
          </div>
        </div>
      `;
    }).join('');
  }

  function renderPitcherComparePanel() {
    const showPanel = state.pitcherCompareMode && state.pitcherCompareIds.length === 2;
    if (!showPanel) { el.pitcherComparePanel.innerHTML = ''; return; }
    const pitchers = getPitchers();
    const comparePitchers = state.pitcherCompareIds.map((i) => pitchers[i]).filter(Boolean);
    const sidesHtml = comparePitchers.map((p) => {
      const cmp = p.cmp || [
        { k: 'CSW% L3', v: p.csw + '%' },
        { k: 'K/9', v: p.kRate },
        { k: 'ERA', v: p.era },
      ];
      const cls = ['big accent', 'big', 'positive'];
      const cells = cmp.map((m, j) => `<div><div class="stat-k">${esc(m.k)}</div><div class="stat-v ${cls[j] || ''}">${esc(m.v)}</div></div>`).join('');
      return `
      <div class="compare-side">
        <div class="name">${esc(p.name)}</div>
        <div class="sub">${esc(p.team)}</div>
        <div class="stats-row">${cells}</div>
      </div>
    `;
    }).join('');
    el.pitcherComparePanel.innerHTML = `
      <div class="compare-panel">
        <div class="compare-panel-head">
          <span class="title">Pitcher comparison</span>
          <button class="clear-btn" data-action="clear-pitcher-compare">Clear</button>
        </div>
        <div class="compare-grid">${sidesHtml}</div>
      </div>
    `;
  }

  function renderPitcherSplits() {
    if (!el.pitcherSplitRows) return; // section removed — nothing to render
    // Opponent OPS-against — lower is better for a pitcher, so tone inverts.
    const opsTone = (v) => v <= 650 ? 'var(--positive)' : v <= 720 ? 'var(--accent)' : 'var(--textDim)';
    const wobaTone = (v) => v <= 275 ? 'var(--positive)' : v <= 305 ? 'var(--accent)' : 'var(--textDim)';
    el.pitcherSplitRows.innerHTML = getPitchers().map((p) => {
      let lL = '—', rL = '—', lT = 'var(--textDim)', rT = 'var(--textDim)';
      if (p.splitL != null || p.splitR != null) {
        if (p.splitL != null) { lL = p.splitL; lT = opsTone(p.splitLnum || 999); }
        if (p.splitR != null) { rL = p.splitR; rT = opsTone(p.splitRnum || 999); }
      } else if (typeof p.vsL === 'number') {
        lL = '.' + p.vsL; rL = '.' + p.vsR; lT = wobaTone(p.vsL); rT = wobaTone(p.vsR);
      }
      return `
        <div class="split-row">
          <span class="split-name">${esc(p.name)}</span>
          <span class="split-val" style="color:${lT}">${esc(lL)}</span>
          <span class="split-val" style="color:${rT}">${esc(rL)}</span>
        </div>`;
    }).join('');
  }

  function renderCalibration() {
    const tr = state.trackRecord;
    // Sample dots only in the offline demo; live shows real buckets or nothing.
    const buckets = (tr && tr.calibration && tr.calibration.length) ? tr.calibration : (LIVE_MODE ? [] : CALIBRATION_BUCKETS);

    // Plain-language verdict from the overall predicted-vs-actual gap.
    const sum = tr && tr.calibrationSummary;
    if (el.calibrationVerdict) {
      if (sum) {
        const gap = Math.round((sum.actual - sum.predicted) * 10) / 10;
        const read = Math.abs(gap) <= 3
          ? 'the model is <b>well-calibrated</b>, tracking reality closely.'
          : gap > 0
            ? `picks hit <b>${Math.abs(gap)} pts more often</b> than predicted, so the model is running conservative.`
            : `the model is <b>${Math.abs(gap)} pts optimistic</b>, so edges are overstated by about that much.`;
        el.calibrationVerdict.innerHTML = `Across <b>${sum.n}</b> graded strikeout picks, the model predicted <b>${sum.predicted}%</b> to go over on average and <b>${sum.actual}%</b> actually did — ${read}`;
        el.calibrationVerdict.hidden = false;
      } else {
        el.calibrationVerdict.hidden = true;
      }
    }

    // Per-tier: predicted win prob vs actual win rate, sharpest claim first (T1).
    if (el.calibrationTiers) {
      const byTier = (tr && tr.calibrationByTier) || [];
      el.calibrationTiers.innerHTML = byTier.map((t) => {
        const d = Math.round((t.actual - t.predicted) * 10) / 10;
        const tone = Math.abs(d) <= 4 ? 'ok' : (d < 0 ? 'over' : 'under');
        return `<div class="cal-tier">
          ${tierChip(t.tier)}
          <span class="cal-tier-nums">predicted <b>${t.predicted}%</b> → hit <b class="${tone}">${t.actual}%</b></span>
          <span class="cal-tier-n">n=${t.n}</span>
        </div>`;
      }).join('');
    }

    if (!buckets.length) {
      el.calibrationPoints.innerHTML = LIVE_MODE ? '<div class="calibration-empty">Calibration plots here as tonight’s picks grade.</div>' : '';
      return;
    }
    // Dot area scales with sample size, so trustworthy buckets read heavier.
    el.calibrationPoints.innerHTML = buckets.map((b) => {
      const size = Math.max(10, Math.min(22, 9 + b.n * 0.5));
      const off = size / 2;
      return `<div class="calibration-dot" style="width:${size}px;height:${size}px;left:calc(${b.predicted}% - ${off}px);bottom:calc(${b.actual}% - ${off}px)" title="Predicted ${b.predicted}% · Actual ${b.actual}% (n=${b.n})"></div>`;
    }).join('');
  }

  // Credibility receipt near the hero — anchored to the batter-UNDER record (the
  // posted product). Win rate is the platform-agnostic headline; units/ROI read
  // as flat-stake sportsbook basis, not a promise of parlay returns.
  function renderProofStrip() {
    const strip = el.proofStrip;
    if (!strip) return;
    const tr = state.trackRecord;
    const bu = tr && tr.batterUnders;
    if (!LIVE_MODE || !bu || !bu.n || bu.n < 20) { strip.hidden = true; return; }
    const pieces = [`<span class="ps-chk"><span class="ps-dot"></span>Batter unders</span>`];
    pieces.push(`<span class="ps-it"><b>${bu.record}</b></span>`);
    if (bu.winRate != null) pieces.push(`<span class="ps-it"><b>${bu.winRate}%</b> hit</span>`);
    if (typeof bu.units === 'number') pieces.push(`<span class="ps-it"><b>${bu.units > 0 ? '+' : ''}${bu.units}u</b> flat</span>`);
    strip.innerHTML = pieces.join('<span class="ps-sep">·</span>')
      + '<a class="ps-lnk" href="#record">See the receipts ↓</a>';
    strip.hidden = false;
  }

  // Full-model aggregate, phrased as honest disclosure — never the headline.
  // These are every graded output including the K/ML/RL context we DON'T post as
  // plays, so the winning batter-under slice can't read as cherry-picked.
  function aggregateDisclosure(tr) {
    if (!tr || tr.empty || !tr.tracked) return '';
    const bits = [`${tr.tracked} graded`];
    if (tr.winRate != null) bits.push(`${tr.winRate}% win`);
    if (typeof tr.units === 'number') bits.push(`${tr.units > 0 ? '+' : ''}${tr.units}u flat`);
    if (tr.clv != null) bits.push(`${tr.clv > 0 ? '+' : ''}${tr.clv}% CLV`);
    // The closing clause used to assert "the one market with a proven edge".
    // That was hardcoded, and it kept asserting a proof while the same page
    // showed an era note saying the edge had not cleared a test — the two lines
    // contradicted each other on screen. Gate it on the same field the note
    // uses, so the strongest claim the page makes is the one the record earns.
    const ee = tr.eraEdge;
    const proven = ee && ee.established;
    const claim = proven
      ? `it’s the one market whose edge has cleared a significance test (p ${ee.roiP}), not the only one we track.`
      : `it’s the only market we post, and on the current record that edge is not yet statistically separable from break-even. That’s why the losses stay up too.`;
    return `<b>Full model log</b>, including the K / moneyline / run-line context we grade but don’t post as plays: ${bits.join(' · ')}. `
      + `We show the whole thing so the batter-under record above can’t read as cherry-picked — ${claim}`;
  }

  function renderRecord() {
    const tr = state.trackRecord;
    if (!tr) return;
    const bu = tr.batterUnders;
    // Headline the tiles on batter unders — the posted product — whenever we have
    // a graded under sample. The full aggregate drops to a labeled note below.
    if (bu && bu.n > 0) {
      el.trkLabel1.textContent = 'Under hit rate';
      el.trkVal1.textContent = (bu.winRate != null ? bu.winRate : 0) + '%';
      el.trkLabel2.textContent = 'Under plays';
      el.trkVal2.textContent = String(bu.n);
      el.trkLabel3.textContent = 'Record';
      el.trkVal3.textContent = bu.record;
      el.trkLabel4.textContent = 'Units (flat)';
      el.trkVal4.textContent = (bu.units > 0 ? '+' : '') + bu.units + 'u';
      el.trkNote.textContent = `${bu.n} graded batter unders · hit rate is the number that transfers to any platform`;
      if (el.trkAggregate) {
        el.trkAggregate.innerHTML = aggregateDisclosure(tr);
        el.trkAggregate.hidden = !el.trkAggregate.innerHTML;
      }
    } else if (!tr.empty) {
      // No graded unders yet, but the model has a graded log — show it honestly,
      // still framed as the full model rather than a posted-play record.
      el.trkLabel1.textContent = 'Win Rate';
      el.trkVal1.textContent = (tr.winRate != null ? tr.winRate : 0) + '%';
      el.trkLabel2.textContent = 'Tracked (all model)';
      el.trkVal2.textContent = String(tr.tracked);
      el.trkLabel3.textContent = 'Tier 1 Record';
      el.trkVal3.textContent = tr.tier1;
      el.trkLabel4.textContent = 'Units (flat)';
      el.trkVal4.textContent = (tr.units > 0 ? '+' : '') + tr.units + 'u';
      el.trkNote.textContent = `${tr.tracked} graded model outputs · batter-under plays grade in as they finalize`;
      if (el.trkAggregate) { el.trkAggregate.hidden = true; el.trkAggregate.innerHTML = ''; }
    } else {
      // No graded results yet — never show placeholder numbers as if they were real.
      el.trkLabel1.textContent = 'Under hit rate';
      el.trkVal1.textContent = '—';
      el.trkLabel2.textContent = 'Under plays';
      el.trkVal2.textContent = tr.logged > 0 ? String(tr.logged) : '—';
      el.trkLabel3.textContent = 'Record';
      el.trkVal3.textContent = '—';
      el.trkLabel4.textContent = 'Units (flat)';
      el.trkVal4.textContent = '—';
      el.trkNote.textContent = tr.logged > 0
        ? `${tr.logged} picks logged · grading as tonight's games finalize`
        : 'Tracking begins with tonight’s slate · wins and losses both stay up';
      if (el.trkAggregate) { el.trkAggregate.hidden = true; el.trkAggregate.innerHTML = ''; }
    }
    renderClvChip();
  }

  // Header chip: real season numbers from the track record, or an honest
  // "tracking" state. Never the old hardcoded "CLV +2.4% · 312 bets".
  function renderClvChip() {
    if (!el.clvChipText) return;
    if (!LIVE_MODE) { el.clvChipText.textContent = 'Model preview'; return; }
    const tr = state.trackRecord;
    const bu = tr && tr.batterUnders;
    // Lead with the batter-under proof — it's the posted product and the one
    // number with a real edge. Full-model CLV (~0%) would undercut it up here.
    if (bu && bu.n > 0) {
      const cls = bu.units >= 0 ? 'clv-pos' : 'clv-neg';
      const u = (bu.units > 0 ? '+' : '') + bu.units + 'u';
      el.clvChipText.innerHTML = `BATTER UNDERS <b class="${cls}">${esc(u)}</b> · ${bu.winRate}% · ${bu.n} graded`;
    } else if (tr && tr.clvN > 0 && tr.clv != null) {
      // Real closing-line value — the truest credibility metric.
      const cls = tr.clv >= 0 ? 'clv-pos' : 'clv-neg';
      const v = (tr.clv > 0 ? '+' : '') + tr.clv + '%';
      el.clvChipText.innerHTML = `SEASON CLV <b class="${cls}">${esc(v)}</b> · ${tr.clvN} picks`;
    } else if (tr && !tr.empty && tr.tracked > 0) {
      const cls = tr.roi >= 0 ? 'clv-pos' : 'clv-neg';
      const roi = (tr.roi > 0 ? '+' : '') + tr.roi + '%';
      el.clvChipText.innerHTML = `SEASON ROI <b class="${cls}">${esc(roi)}</b> · ${tr.tracked} graded picks`;
    } else if (tr && tr.logged > 0) {
      el.clvChipText.textContent = `${tr.logged} picks logged · grading nightly`;
    } else {
      el.clvChipText.textContent = 'Model live · tracking picks';
    }
  }

  // ---------------------------------------------------------------------
  // MY SLIP — cross-board bet slip, persisted, with true parlay math.
  // ---------------------------------------------------------------------
  const toDecimal = (a) => (typeof a !== 'number' ? null : (a > 0 ? 1 + a / 100 : 1 + 100 / -a));
  const decToAmerican = (d) => (d >= 2 ? Math.round((d - 1) * 100) : -Math.round(100 / (d - 1)));
  const fmtAm = (a) => (a == null ? '—' : (a > 0 ? '+' + a : String(a)));
  const u1 = (n) => (Math.round(n * 100) / 100);

  function renderSlip() {
    if (!el.slip) return;
    const legs = Object.values(state.slip);
    const n = legs.length;
    if (el.slipCount) el.slipCount.textContent = `${n} leg${n === 1 ? '' : 's'}`;
    if (el.slipClearBtn) el.slipClearBtn.hidden = n === 0;

    if (!n) {
      el.slip.innerHTML = `<div class="slip-empty">Tap the ★ on any pick above to build your slip. Picks persist across visits and every board.</div>`;
      return;
    }

    const boardTag = { 'K Prop': 'kprop', 'ML': 'ml', 'Batter': 'batter' };
    const legHtml = legs.map((leg) => `
      <div class="slip-leg">
        <span class="slip-tag ${boardTag[leg.board] || ''}">${esc(leg.board)}</span>
        <span class="slip-leg-main">
          <span class="slip-leg-title">${esc(leg.title)}</span>
          <span class="slip-leg-sub">${esc(leg.sub || '')}</span>
        </span>
        ${typeof leg.edge === 'number' ? `<span class="slip-leg-edge ${leg.edge >= 0 ? 'pos' : 'neg'}">${leg.edge > 0 ? '+' : ''}${leg.edge}%</span>` : ''}
        <span class="slip-leg-odds mono">${esc(fmtAm(leg.odds))}</span>
        <button class="slip-remove" data-action="remove-leg" data-leg="${esc(leg.id)}" title="Remove" aria-label="Remove leg">✕</button>
      </div>`).join('');

    // Parlay math over legs that carry a real price.
    const priced = legs.filter((l) => typeof l.odds === 'number');
    const stake = state.stake > 0 ? state.stake : 0;
    let summaryHtml;
    if (!priced.length) {
      summaryHtml = `<div class="slip-note">None of these legs has a posted price yet — add priced picks to see parlay and straight-bet returns.</div>`;
    } else {
      const parlayDec = priced.reduce((d, l) => d * toDecimal(l.odds), 1);
      const parlayAm = decToAmerican(parlayDec);
      const parlayProfit = u1(stake * (parlayDec - 1));
      const parlayReturn = u1(stake * parlayDec);
      const straightProfit = u1(priced.reduce((s, l) => s + stake * (toDecimal(l.odds) - 1), 0));
      const missing = legs.length - priced.length;

      summaryHtml = `
        <div class="slip-stake">
          <label for="stakeInput">Unit stake</label>
          <input type="number" id="stakeInput" min="0" step="0.5" value="${stake}" inputmode="decimal">
          <span class="slip-stake-note">1u = 1% of bankroll</span>
        </div>
        <div class="slip-summary">
          <div class="slip-metric">
            <div class="slip-metric-k">${priced.length}-leg parlay</div>
            <div class="slip-metric-v accent">${fmtAm(parlayAm)}</div>
            <div class="slip-metric-sub">${parlayDec.toFixed(2)}× decimal</div>
          </div>
          <div class="slip-metric">
            <div class="slip-metric-k">Parlay returns ${stake}u</div>
            <div class="slip-metric-v g">+${parlayProfit}u</div>
            <div class="slip-metric-sub">${parlayReturn}u back incl. stake</div>
          </div>
          <div class="slip-metric">
            <div class="slip-metric-k">If bet straight (${stake}u each)</div>
            <div class="slip-metric-v">${straightProfit >= 0 ? '+' : ''}${straightProfit}u</div>
            <div class="slip-metric-sub">total if all ${priced.length} win</div>
          </div>
        </div>
        ${missing ? `<div class="slip-note">${missing} leg${missing === 1 ? '' : 's'} without a posted price ${missing === 1 ? 'is' : 'are'} excluded from the parlay.</div>` : ''}`;
    }

    // Average edge across legs that carry one. Labeled "leg" edge — never
    // "parlay" edge — with a caveat, so it can't read as the parlay's true edge.
    const withEdge = legs.filter((l) => typeof l.edge === 'number');
    const avgEdge = withEdge.length ? Math.round(withEdge.reduce((s, l) => s + l.edge, 0) / withEdge.length * 10) / 10 : null;
    const avgHtml = avgEdge != null
      ? `<div class="slip-avg">
          <span class="slip-avg-k">Avg leg edge</span>
          <span class="slip-avg-v ${avgEdge >= 0 ? 'pos' : 'neg'}">${avgEdge > 0 ? '+' : ''}${avgEdge}%</span>
          <span class="slip-avg-note">Each leg is priced on its own — a parlay's true edge is lower after combined vig${withEdge.length > 1 ? ' and any correlation' : ''}.</span>
        </div>` : '';
    el.slip.innerHTML = `<div class="slip-legs">${legHtml}</div>${avgHtml}${summaryHtml}`;

    const stakeInput = document.getElementById('stakeInput');
    if (stakeInput) stakeInput.addEventListener('change', (e) => setStake(e.target.value));
  }

  // ROI, cumulative-units chart, per-tier / per-side / per-market breakdowns.
  // Hidden until real graded picks exist; degrades field-by-field if any are absent.
  function renderRoi() {
    const tr = state.trackRecord;
    if (!el.roiCard) return;
    if (!tr || tr.empty || !tr.tracked) { el.roiCard.hidden = true; return; }
    el.roiCard.hidden = false;

    const sign = (n, suf) => (n > 0 ? '+' : '') + n + (suf || '');
    const roiTxt = tr.roi == null ? '—' : sign(tr.roi, '%');
    const uTxt = tr.units == null ? '—' : sign(tr.units, 'u');
    const clvTxt = tr.clv == null ? '—' : sign(tr.clv, '%');
    // Four tiles keep the grid symmetric (2×2 mobile, 4-up desktop). Strikeout
    // MAE lives with the K breakdown below — it's context, not the product.
    const stats = [
      { k: 'CLV vs close', v: clvTxt, tone: tr.clv == null ? '' : (tr.clv >= 0 ? 'g' : 'r') },
      { k: 'ROI', v: roiTxt, tone: tr.roi == null ? '' : (tr.roi >= 0 ? 'g' : 'r') },
      { k: 'Units (flat)', v: uTxt, tone: tr.units == null ? '' : (tr.units >= 0 ? 'g' : 'r') },
      { k: 'Graded plays', v: String(tr.tracked), tone: '' },
    ];
    el.roiStats.innerHTML = stats.map((s) => `
      <div class="roi-stat"><div class="roi-stat-k">${s.k}</div><div class="roi-stat-v ${s.tone}">${esc(s.v)}</div></div>`).join('');

    if (el.roiClvNote) {
      if (tr.clvN > 0) {
        const moved = tr.clvLineMoved ? ` · ${tr.clvLineMoved} excluded (line moved)` : '';
        el.roiClvNote.hidden = false;
        el.roiClvNote.textContent = `Beat the close on ${tr.clvBeatRate}% of ${tr.clvN} comparable picks${moved}.`;
      } else {
        el.roiClvNote.hidden = false;
        el.roiClvNote.textContent = 'CLV builds as picks reach game time — closing lines are captured pre-game.';
      }
    }

    renderRoiChart(tr.cumulative || []);

    const tierRows = (tr.tierBreakdown || []).map((t) => ({ label: 'Tier ' + t.tier, r: t.record, u: t.units, roi: t.roi }));
    const sideRows = (tr.sideBreakdown || []).map((s) => ({ label: s.side, r: s.record, u: s.units, roi: s.roi }));
    const marketRows = (tr.marketBreakdown || []).map((m) => ({ label: m.market, r: m.record, u: m.units, roi: m.roi }));
    const tbl = (title, rows) => rows.length ? `
      <div class="roi-table">
        <div class="roi-table-head"><span>${title}</span><span>W–L</span><span>Units</span><span>ROI</span></div>
        ${rows.map((x) => `<div class="roi-table-row">
          <span>${esc(x.label)}</span>
          <span>${esc(x.r)}</span>
          <span class="${x.u >= 0 ? 'g' : 'r'}">${(x.u > 0 ? '+' : '') + x.u}u</span>
          <span class="${x.roi == null ? '' : (x.roi >= 0 ? 'g' : 'r')}">${x.roi == null ? '—' : (x.roi > 0 ? '+' : '') + x.roi + '%'}</span>
        </div>`).join('')}
      </div>` : '';
    el.roiTables.innerHTML = tbl('By market', marketRows) + tbl('By tier', tierRows) + tbl('By side', sideRows);
  }

  function renderRoiChart(series) {
    const W = 320, H = 96, padX = 8, padY = 10;
    if (!series.length) { el.roiChart.innerHTML = ''; el.roiChartCap.textContent = ''; return; }
    const vals = series.map((p) => p.units).concat(0);
    let min = Math.min(...vals), max = Math.max(...vals);
    if (min === max) { min -= 1; max += 1; }
    const n = series.length;
    const xFor = (i) => padX + (n === 1 ? (W - 2 * padX) / 2 : i / (n - 1) * (W - 2 * padX));
    const yFor = (u) => H - padY - (u - min) / (max - min) * (H - 2 * padY);
    const last = series[n - 1].units;
    const stroke = last >= 0 ? 'var(--positive)' : 'var(--danger)';
    const zeroY = yFor(0);
    const pts = series.map((p, i) => `${xFor(i).toFixed(1)},${yFor(p.units).toFixed(1)}`).join(' ');
    const area = `${padX},${zeroY.toFixed(1)} ${pts} ${xFor(n - 1).toFixed(1)},${zeroY.toFixed(1)}`;
    el.roiChart.innerHTML = `
      <line x1="${padX}" y1="${zeroY.toFixed(1)}" x2="${W - padX}" y2="${zeroY.toFixed(1)}" stroke="var(--border)" stroke-width="1" stroke-dasharray="3 3"/>
      <polygon points="${area}" fill="${stroke}" opacity="0.12"/>
      ${n === 1
        ? `<circle cx="${xFor(0).toFixed(1)}" cy="${yFor(last).toFixed(1)}" r="3.5" fill="${stroke}"/>`
        : `<polyline points="${pts}" fill="none" stroke="${stroke}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
           <circle cx="${xFor(n - 1).toFixed(1)}" cy="${yFor(last).toFixed(1)}" r="3" fill="${stroke}"/>`}`;
    el.roiChartCap.textContent = `${n} day${n > 1 ? 's' : ''} · ${last > 0 ? '+' : ''}${last}u to date`;
  }

  // Real, self-building track record from graded picks (via /api/track-record).
  async function refreshTrackRecord() {
    if (!LIVE_MODE) return;
    try {
      const tr = await fetchJson('/api/track-record');
      if (tr && typeof tr === 'object') {
        state.trackRecord = tr;
        renderEraNote();
        renderProofStrip();
        renderRecord();
        renderCalibration();
        renderRoi();
        renderYesterdayCard();
      }
    } catch (e) {
      console.warn('Track record refresh failed:', e.message);
    }
  }

  // ---------------------------------------------------------------------
  // HERO — "Tonight's Ace Duel". Auto-selects the marquee upcoming matchup
  // (highest combined projected Ks) from the live board and renders it from
  // real data. Leaves the static mock hero in place when the board isn't live.
  // ---------------------------------------------------------------------
  function heroDateLabel(ms) {
    try {
      return new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles' })
        .format(new Date(ms)).replace(',', '');
    } catch (e) { return ''; }
  }
  function lastName(name) {
    const parts = String(name || '').trim().split(/\s+/);
    return parts.length ? parts[parts.length - 1] : String(name || '');
  }
  function heroBar(label, badge, fillPct, tone) {
    const w = Math.max(2, Math.min(98, fillPct));
    return `<div class="row"><span class="stat">${esc(label)}</span><div class="track"><div class="fill ${tone}" style="width:${w}%"></div></div><span class="badge ${tone}">${esc(String(badge))}</span></div>`;
  }
  function heroSide(p, isLead) {
    const handLabel = p.hand === 'L' ? 'LHP' : p.hand === 'R' ? 'RHP' : '';
    const meta = [p.team, handLabel, p.era ? p.era + ' ERA' : ''].filter(Boolean).join(' · ');
    const bars = [];
    if (typeof p.k9 === 'number' && p.k9 > 0) {
      const t = p.k9 >= 10 ? 'elite' : p.k9 >= 8 ? 'good' : 'low';   // good-for-play heat
      bars.push(heroBar('K/9', p.k9.toFixed(1), (p.k9 - 5) / 8 * 100, t));
    }
    if (typeof p.oppKpct === 'number' && p.oppKpct > 0) {
      const t = p.oppKpct >= 23 ? 'elite' : p.oppKpct >= 20 ? 'good' : 'low'; // whiffy / avg / contact
      bars.push(heroBar('Opp K%', p.oppKpct, (p.oppKpct - 16) / 12 * 100, t));
    }
    if (p.market && p.market.modelOver != null) {
      // Clear-line % = the model's chance the pitcher goes over (clears) his
      // line. It's a model output, so it takes the model (cyan) color.
      const mo = p.market.modelOver;
      bars.push(heroBar('Clear-line %', mo, mo, 'model'));
    }
    const lineTxt = p.market ? ` · Line: O/U ${p.market.line}` : '';
    const badge = isLead ? '<span class="badge-edge">◆ Model edge</span>' : '';
    return `
      <div class="side">
        ${badge}
        <div class="name">${esc(p.fullName || p.name)}</div>
        <div class="team">${esc(meta)}</div>
        <div class="proj">
          <div class="label"><span class="label-long">Projected strikeouts</span><span class="label-short">Proj Ks</span></div>
          <div class="num">${p.proj}</div>
          <div class="ci">80% interval: ${p.lo} – ${p.hi}${lineTxt}</div>
        </div>
        <div class="pct">${bars.join('')}</div>
      </div>`;
  }
  function kellyUnits(prob, price) {
    const dec = price > 0 ? price / 100 + 1 : 100 / (-price) + 1;
    const b = dec - 1;
    const f = (prob * dec - 1) / b;
    if (f <= 0) return 0;
    // Half-Kelly, 1u = 1% of bankroll, capped at 2.5u (edges are still being calibrated).
    return Math.min(2.5, Math.round(f * 0.5 * 100 * 10) / 10);
  }
  // Honest hero placeholder for the fade hero. Three states, not two: 'nolines'
  // means nothing was priced because the two-way lines are not up, which is very
  // different from 'none' — evaluated the slate and nothing cleared the bar.
  // Saying "no under clears our threshold" when we never had a line to measure
  // claims work we did not do, and "the projections are on the board below"
  // points at an empty board.
  // The hero's "Why" — a price-play argument built only from numbers we have,
  // each stated as exactly what it is. Two DISTINCT spreads live here and must
  // not be conflated:
  //   priceEdge  = model P(under) − break-even implied by the price you'd bet.
  //   f.edge     = model P(under) − the SHARP FAIR line (what the board's % is).
  // They are different quantities; an earlier draft called the first one "the
  // +6.2% edge", which was the second. The price-play frame only holds when the
  // model actually beats the price (priceEdge > 0) — because the board edge is
  // measured against fair, not against the book, the two can disagree in sign,
  // so we fall back to a plain projection line when it does.
  function heroWhy(f, pUnder, breakevenPct, cushion, priceStr, propLabel) {
    const proj = `it projects <b>${f.projVal}</b>, ${cushion > 0 ? `a <b>${cushion}</b> cushion under the ${esc(String(f.line))} line` : `right at the ${esc(String(f.line))} line`}`;
    if (pUnder != null && breakevenPct != null && pUnder > breakevenPct) {
      const priceEdge = Math.round((pUnder - breakevenPct) * 10) / 10;
      return `This is a price play, not a projection play. At <b>${priceStr}</b> the Under only needs <b>${breakevenPct}%</b> to turn a profit, and the model gives it <b>${pUnder}%</b> — <b>${priceEdge} pts</b> clear of break-even, ${proj}. The board's <b>+${f.edge}%</b> measures that same price against the sharp fair line, where casual over-money shades the Under cheapest.`;
    }
    return `Casual money pounds the over on a name like ${esc(f.name)}, so the book sets this line high. The model projects <b>${f.projVal} ${esc(propLabel.toLowerCase())}</b>${cushion > 0 ? `, a <b>${cushion}</b> cushion under the ${esc(String(f.line))} line` : `, right at the ${esc(String(f.line))} line`}. That gap is the <b>+${f.edge}%</b> edge vs. the sharp fair line.`;
  }

  // Four states, not three. 'closed' was previously folded into 'nolines', so a
  // finished slate said "Waiting on Tonight's Lines" — waiting on something that
  // had already been and gone.
  const HERO_PLACEHOLDER = {
    loading: ['Loading tonight’s fades…', 'Tonight’s Slate',
      'Pulling tonight’s batter props, model projections, and DK/FD lines…'],
    nolines: ['Lines Pending', 'Waiting on Tonight’s Lines',
      'Books haven’t posted two-way batter lines yet. The milestone markets (“2+ Total Bases”) usually go up first, but those quote only the over — we need both sides to strip the vig and find a fair number. Nothing to price until then.'],
    closed: ['Market Closed', 'Tonight’s Games Are Underway',
      'Books pull batter props once a game starts, so there is nothing left to price tonight. The board returns with tomorrow’s slate — the graded record below does not move in the meantime.'],
    feed: ['Feed Unavailable', 'Odds Feed Is Down',
      'We can’t reach the pricing data right now, so nothing on tonight’s slate can be priced. This is on us, not the sportsbooks — the graded record below is unaffected and does not move while the feed is out.'],
    none: ['Tonight’s Fades', 'No Fade Meets the Bar Tonight',
      'No batter under clears the bar tonight — so we post nothing. The projections are on the board below; we only lead with a fade when the price is better than the model thinks the outcome is worth.'],
  };
  function renderHeroPlaceholder(kind) {
    const [eyebrow, title, body] = HERO_PLACEHOLDER[kind] || HERO_PLACEHOLDER.none;
    el.heroEyebrow.textContent = eyebrow;
    el.heroTitle.innerHTML = title;
    el.heroDuel.innerHTML = `<div class="hero-empty"><p>${body}</p></div>`;
  }

  // HERO — tonight's sharpest batter-under fade. Auto-selects the highest-edge
  // priced UNDER from the live batter feed and renders the market-vs-line scale.
  function renderHero() {
    if (!LIVE_MODE) return; // offline demo keeps the static sample fade hero
    const batters = state.liveBatters;
    if (batters === null) { renderHeroPlaceholder('loading'); return; }
    // Empty array = nothing was priced at all (no two-way lines), which is a
    // different story from a full slate where no under cleared the bar.
    // No batter rows means one of two very different things: the books have not
    // posted yet, or they have already pulled. The slate itself says which.
    if (!batters.length) {
      renderHeroPlaceholder(state.feedError ? 'feed' : slateStarted() ? 'closed' : 'nolines');
      return;
    }
    const qualifies = (g) => g.side === 'Under' && g.odds != null && g.line != null
      && typeof g.projVal === 'number' && isPlayTier(g.tier);
    const unders = batters.filter(qualifies);
    const preview = unders.filter((g) => g.status === 'Preview');
    const pool = preview.length ? preview : unders;
    if (!pool.length) {
      // "No fade meets the bar" claims we looked at prices and none cleared. That
      // is only true if there were prices to look at. With a projection-only board
      // nothing could be evaluated, so it gets the same story the empty board got.
      const anyPriced = batters.some((g) => g.odds != null);
      renderHeroPlaceholder(anyPriced ? 'none'
        : state.feedError ? 'feed' : slateStarted() ? 'closed' : 'nolines');
      return;
    }
    const f = pool.reduce((m, g) => (!m || (g.edge || 0) > (m.edge || 0) ? g : m), null);

    const propLabel = f.marketLabel || 'prop';
    const priceStr = f.odds > 0 ? '+' + f.odds : String(f.odds);
    const pUnder = typeof f.modelOver === 'number' ? Math.round((100 - f.modelOver) * 10) / 10 : null;
    // Break-even: the win rate the posted price alone demands, straight from the
    // odds — no model in it. Pairing it with the model's P(under) turns the pitch
    // from "trust our projection" into arithmetic anyone can check: the edge is
    // exactly model P minus break-even.
    const breakevenPct = oddsBreakeven(f.odds); // shared helper — one definition
    const kelly = pUnder != null ? kellyUnits(pUnder / 100, f.odds) : 0;
    const cushion = Math.round((f.line - f.projVal) * 100) / 100;
    const axisMax = f.line <= 1 ? 2 : Math.max(4, Math.ceil(f.line + 1.5));
    const pct = (v) => Math.max(4, Math.min(96, v / axisMax * 100));
    const lp = pct(f.line), mp = pct(f.projVal);
    let ticks = ''; for (let i = 0; i <= axisMax; i++) ticks += `<span>${i}</span>`;

    el.heroEyebrow.textContent = `Tonight's Sharpest Fade · ${heroDateLabel(f.timeMs || f.time)} · ${f.timeLabel || ''}`.replace(/ · $/, '');
    el.heroTitle.innerHTML = `${esc(f.name)} <span class="vs">·</span> ${esc(propLabel)}`;

    // Keyed on the pick, so the hero's scale draws itself when tonight's fade
    // first resolves (or changes) and holds still through the refresh cycle.
    el.heroDuel.innerHTML = `
      <div class="fade-card${barsIn('hero:' + f.id)}">
        <div class="fc-top">
          <div>
            <div class="fc-pick">UNDER ${esc(String(f.line))} ${esc(propLabel)} <span class="fc-odds">(${priceStr})</span></div>
            <div class="fc-meta">${esc([f.team, f.matchup, f.timeLabel, "tonight's largest model-vs-line gap"].filter(Boolean).join(' · '))}</div>
          </div>
        </div>
        <div class="fc-scale-wrap">
          <div class="fc-scale-label"><span>Where the model lands vs. the market line</span><span>${esc(propLabel)}</span></div>
          <div class="fc-tagrow">
            <span class="fc-model">Model ${f.projVal}</span>
            <span class="fc-linetag">Line ${esc(String(f.line))}</span>
          </div>
          <div class="fc-track">
            <div class="fc-under-zone" style="width:${lp}%"></div>
            <span class="fc-under-tag">◄ Value: Under</span>
            <span class="fc-over-tag" style="left:${Math.min(86, lp + 8)}%">Over — public side</span>
            ${mp < lp ? `<span class="fc-gap" style="left:${mp}%;width:${lp - mp}%"></span>` : ''}
            <span class="fc-dot" style="left:${mp}%"></span>
          </div>
          <div class="fc-axis">${ticks}</div>
        </div>
        <div class="pick-strip has-play">
          ${tierChip(f.tier)}
          <span class="pick">${esc(f.name)} <b>UNDER ${esc(String(f.line))} ${esc(propLabel)}</b> <span class="pick-odds">(${priceStr})</span></span>
          <span class="tier">${kelly > 0 ? kelly + 'u Kelly' : ''}</span>
          <span class="edge">+${f.edge}% edge</span>
          <button class="hero-add" data-action="hero-add" data-id="${esc(f.id)}">★ Add to slip</button>
        </div>
        <div class="hero-why"><span class="wk">Why</span><span>${heroWhy(f, pUnder, breakevenPct, cushion, priceStr, propLabel)}</span></div>
        <div class="hero-note">Fair-value read priced on DK/FD lines. Availability and exact lines vary by book/app — confirm the Under is offered before placing.</div>
      </div>`;
  }

  // Fill the "Why" card with the hero pick's real model numbers (no fabricated
  // narrative). Leaves the methodology default in place if elements are absent.
  function renderWhyCard(lead, m, modelPct) {
    if (!el.whyTitle || !el.whyBody || !el.whyStats) return;
    const side = m.side.toLowerCase();
    let parkNote = '';
    if (typeof lead.parkK === 'number' && lead.parkK !== 1) {
      const pct = Math.round((lead.parkK - 1) * 100);
      parkNote = `, in a park that runs ${pct > 0 ? '+' : ''}${pct}% on strikeouts`;
    }
    const wxNote = (typeof lead.temp === 'number' && lead.temp > 0) ? ` with ${lead.temp}°F conditions` : '';
    el.whyTitle.textContent = `Why ${lead.name} ${m.side} ${m.line} — the model's read`;
    el.whyBody.innerHTML = `The model projects <b>${lead.proj} strikeouts</b> for ${esc(lead.name)} against a line of <b>${m.line}</b> — about a <b>${modelPct}%</b> chance to land ${esc(side)}. The opposing lineup strikes out <b>${lead.oppKpct}%</b> of the time${parkNote}${wxNote}. That puts the model <b>${m.edge}%</b> ahead of the vig-free line.`;
    el.whyStats.innerHTML = [
      ['K/9', lead.k9], ['Opp K%', lead.oppKpct + '%'],
      [`Model ${m.side}`, modelPct + '%'], ['Proj', lead.proj + ' K'],
    ].map(([k, v]) => `<span>${esc(k)} <i>${esc(String(v))}</i></span>`).join('');
  }

  function renderAll() {
    renderTheme();
    renderTicker();
    renderWinProb();
    renderHero();
    renderLiveNow();
    renderInjuryAlerts();
    renderControls();
    renderBoard();
    renderComparePanel();
    renderSlip();
    renderClvChip();
    renderHittersGrid();
    renderHitterComparePanel();
    renderSplits();
    renderPitchers();
    renderPitcherComparePanel();
    renderPitcherSplits();
    renderCalibration();
  }

  // ---------------------------------------------------------------------
  // ACTIONS
  // ---------------------------------------------------------------------

  function toggleTheme() {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('aimplified_theme', state.theme); } catch (e) {}
    renderAll();
  }

  function setFilter(f) {
    state.filter = f;
    renderControls();
    renderBoard();
  }

  function setView(v) {
    if (state.boardView === v) return;
    state.boardView = v;
    state.filter = 'all';       // tiers differ between views
    state.expandedId = null;
    state.compareIds = [];
    if (v === 'batter' && !battersLive()) refreshBatters(); // lazy first load
    renderViewChrome();
    renderControls();
    renderBoard();
    renderComparePanel();
  }

  // Honest "context, not plays" banner on the de-listed markets (K props and
  // moneyline). The batter board is the only one that posts plays; these show the
  // model's read so nothing's hidden, but the graded record has no edge to bet.
  const CTX_BANNERS = {
    kprops: ['Projections · not plays', 'Our graded record found <b>no betting edge in strikeout props</b> — the market prices them efficiently. The projections stay because they’re honest analysis, but we don’t post K bets we wouldn’t make ourselves.'],
    moneyline: ['Context · not plays', 'Our graded record shows <b>no reliable edge in moneylines</b> — a heavy favorite can show a number and still be a bad bet. Win probability is shown as context (model vs. the market), not posted as a play.'],
    runline: ['Context · not plays', 'The run line is <b>not graded and not posted</b> — no track record stands behind it. It is shown so the model’s read on the 1.5 is visible next to the moneyline, and the two can be compared. Treat it as analysis only.'],
  };
  // True when the batter board is populated but nothing on it carries a price --
  // the projection survived a feed outage, the pricing did not.
  function batterModelOnly() {
    const rows = state.liveBatters;
    return isBatter() && LIVE_MODE && !!(rows && rows.length) && rows.every((r) => r.tier === 'model');
  }
  // "out for 6 min" tells a reader whether this is a blip or a sustained outage —
  // the same 401 reads very differently at 30 seconds and at three hours.
  function outageAgeLabel() {
    if (!state.feedOutageSince) return 'just now';
    const mins = Math.floor((Date.now() - state.feedOutageSince) / 60000);
    if (mins < 1) return 'out for <1 min';
    if (mins < 60) return `out for ${mins} min`;
    const h = Math.floor(mins / 60);
    return `out for ${h}h ${mins % 60}m`;
  }
  // Saying when the next attempt lands is what makes the Retry button optional
  // rather than the only way to find out whether anything is happening.
  function retryCountdownLabel() {
    const ms = (state.feedNextRetry || 0) - Date.now();
    if (ms <= 0) return 'retrying…';
    const s = Math.ceil(ms / 1000);
    return `auto-retry in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
  function renderViewChrome() {
    renderEraNote();
    // The tabnote opens "Plays = batter unders only", which describes this tab
    // and only this tab. On the three analysis tabs it was 177px explaining a
    // board the reader is not looking at, directly above a context banner
    // explaining the one they are. The banner is the accurate disclosure there,
    // so the note steps aside rather than both being shown.
    // It also steps aside when nothing is priced: promising "plays" above a board
    // that has none, and can have none, describes a board that isn't there.
    if (el.tabnote) el.tabnote.hidden = state.boardView !== 'batter' || batterModelOnly();
    if (!el.kCtxBanner) return;
    // A priced-out batter board gets the same disclosure the analysis tabs get,
    // because that is exactly what it has become for as long as the feed is down.
    if (batterModelOnly()) {
      // Why there is no price decides who the reader should be waiting on, so the
      // two causes never share a sentence. A feed outage is ours; an unposted
      // market is the books', and normal this far from first pitch.
      const fe = state.feedError;
      const why = !fe
        ? 'books haven’t posted two-way batter lines yet'
        : fe.kind === 'quota' ? 'our data plan is out of credits'
          : 'we can’t reach the pricing feed';
      const blame = fe
        ? 'This is on us, not the sportsbooks.'
        : 'Nothing is wrong — the market simply isn’t up yet.';
      // Split the board into what survived and what didn't, rather than leading
      // with the failure. The reader's real question is "is anything here still
      // worth reading", and the answer is yes — so answer it first.
      //
      // NOTE: "every projection below" is only true while nothing can be withdrawn
      // from the board. When lineup alerts land, a scratched batter's projection is
      // pulled and this must become "every projection we still have", pointing at
      // the alert bar. Feed state and lineup state are independent; this sentence
      // covers one of them and must be revisited when the other exists.
      const still = 'every projection on the board, its matchup, first pitch and opposing starter';
      const waiting = 'the edge, the play/pass call, and posting';
      el.kCtxBanner.className = 'ctx-banner ctx-banner-outage';
      el.kCtxBanner.innerHTML = `<div class="cb-head">`
        + `<span class="cb-dot"></span>`
        + `<b>${fe ? 'Book prices are out — you’re seeing projections only'
          : 'No lines posted yet — you’re seeing projections only'}</b>`
        + (fe ? `<span class="cb-age">${outageAgeLabel()}</span>` : '')
        + `</div>`
        + `<p class="cb-body">${why.charAt(0).toUpperCase() + why.slice(1)}, so nothing tonight can be `
        + `measured against a line. <b>Still good below:</b> ${still}. `
        + `<b>Waiting on prices:</b> ${waiting}. `
        + `The graded record is unaffected and does not move while this lasts. ${blame}</p>`
        + (fe ? `<div class="cb-act">`
          + `<button type="button" class="cb-retry" data-action="feed-retry"${
            Date.now() < state.feedRetryAllowedAt ? ' disabled' : ''}>Retry now</button>`
          + `<span class="cb-next">${retryCountdownLabel()}</span>`
          + `</div>` : '');
      el.kCtxBanner.hidden = false;
      return;
    }
    const b = CTX_BANNERS[state.boardView];
    el.kCtxBanner.className = 'ctx-banner'; // drop the outage variant if it was on
    if (b) {
      el.kCtxBanner.innerHTML = `<span class="ctx-banner-tag">${b[0]}</span><span>${b[1]}</span>`;
      el.kCtxBanner.hidden = false;
    } else {
      el.kCtxBanner.hidden = true;
    }
  }

  // Data-gated era note. Three ways it stays silent rather than misleading:
  // no track record yet, no eraEdge in the payload (older Worker, or nothing
  // graded in this era), or a tab that posts no plays. It never renders a
  // hardcoded claim — every word comes from what actually graded.
  function renderEraNote() {
    if (!el.eraNote) return;
    const ee = state.trackRecord && state.trackRecord.eraEdge;
    if (!ee || !ee.n || state.boardView !== 'batter') { el.eraNote.hidden = true; return; }
    // The backend already decides `established`; the UI must not re-derive it
    // from roi alone, or a positive-but-untested number would read as proven.
    el.eraNote.classList.toggle('is-sig', !!ee.established);
    el.eraNote.innerHTML = ee.established
      ? `<b>${ee.n}</b> graded this era · edge significant <b>p ${ee.roiP}</b>`
      : `<b>${ee.n}</b> graded this era · edge not yet significant`;
    el.eraNote.title = `${ee.era} · ${ee.record} · ROI ${ee.roi > 0 ? '+' : ''}${ee.roi}%`
      + (ee.roiP != null ? ` · two-tailed p ${ee.roiP}` : ' · too few graded picks to test')
      + '. Current pricing era only — the headline record spans every era.';
    el.eraNote.hidden = false;
  }

  // Click a different key → switch to it at its natural direction. Click the key
  // you're already on → flip the direction. Mirrors how every sortable table
  // behaves, so no explaining needed.
  function setSort(key) {
    if (state.sortBy === key) {
      state.sortDir = sortDir() === 'desc' ? 'asc' : 'desc';
    } else {
      state.sortBy = key;
      state.sortDir = SORT_DEFAULT_DIR[key] || 'desc';
    }
    renderControls();
    renderBoard();
  }

  function toggleExpand(id) {
    // Closing or switching rows retires the open panel's key so its bars play
    // again next time it's opened.
    retirePanelBars();
    state.expandedId = state.expandedId === id ? null : id;
    renderBoard();
  }

  // The slip is keyed per view, so the same game can carry a K-props leg, a
  // moneyline leg, and batter legs independently.
  function legIdFor(g) {
    if (isBatter()) return 'batter:' + g.id;
    return (isML() ? 'ml:' : 'kprops:') + g.id;
  }
  function buildLeg(g) {
    if (isML()) {
      const ml = g.ml || {};
      return { id: legIdFor(g), board: 'ML', title: ml.pick || '—', sub: g.matchup, odds: typeof ml.price === 'number' ? ml.price : null, tier: ml.tier, edge: typeof ml.edge === 'number' ? ml.edge : null };
    }
    if (isBatter()) {
      // g.matchup is the batter name; g.subline is "EVENT · TIME".
      return { id: legIdFor(g), board: 'Batter', title: `${g.matchup} ${g.pick}`, sub: (g.subline || '').split(' · ')[0], odds: typeof g.odds === 'number' ? g.odds : null, tier: g.tier, edge: typeof g.edge === 'number' ? g.edge : null };
    }
    return buildKPropLeg(g);
  }
  // K-prop leg from a raw game, independent of the active board view — so the
  // hero's "Add to slip" adds exactly what the board's star would for that game.
  function buildKPropLeg(g) {
    return { id: 'kprops:' + g.id, board: 'K Prop', title: g.pick, sub: g.matchup, odds: typeof g.odds === 'number' ? g.odds : null, tier: g.tier, edge: typeof g.edge === 'number' ? g.edge : null };
  }
  // Batter under leg, view-independent — the hero's featured fade.
  function buildBatterLeg(g) {
    return { id: 'batter:' + g.id, board: 'Under', title: `${g.name || g.matchup} ${g.pick}`, sub: (g.subline || g.matchup || '').split(' · ')[0], odds: typeof g.odds === 'number' ? g.odds : null, tier: g.tier, edge: typeof g.edge === 'number' ? g.edge : null };
  }
  function addHeroToSlip(id) {
    const g = (state.liveBatters || []).find((x) => x.id === id);
    if (!g) return;
    const leg = buildBatterLeg(g);
    if (state.slip[leg.id]) { toast('Already in your slip'); return; }
    state.slip = { ...state.slip, [leg.id]: leg };
    persistSlip();
    renderControls(); renderBoard(); renderSlip();
    toast(`★ Added ${leg.title} · ${Object.keys(state.slip).length} leg${Object.keys(state.slip).length === 1 ? '' : 's'}`);
  }
  // Minimal toast — one line, auto-dismisses; respects reduced-motion via CSS.
  let toastTimer = null;
  function toast(msg) {
    let t = document.getElementById('toast');
    if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; document.body.appendChild(t); }
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
  }
  function persistSlip() {
    try { localStorage.setItem('aimplified_slip', JSON.stringify(state.slip)); } catch (e) {}
  }
  function toggleSlip(id) {
    const g = getGames().find((x) => x.id === id);
    if (!g) return;
    const leg = buildLeg(g);
    const adding = !state.slip[leg.id];
    // A closed K-prop line is shown for reference only — block adding it (but
    // still allow removing one added earlier while the line was live).
    if (adding && g.closed && !isML() && !isBatter() && !isRL()) {
      toast('Line closed — no longer bettable'); return;
    }
    const next = { ...state.slip };
    if (next[leg.id]) delete next[leg.id];
    else next[leg.id] = leg;
    state.slip = next;
    persistSlip();
    renderControls();
    renderBoard();
    renderSlip();
  }
  function removeLeg(legId) {
    if (!state.slip[legId]) return;
    const next = { ...state.slip };
    delete next[legId];
    state.slip = next;
    persistSlip();
    renderControls();
    renderBoard();
    renderSlip();
  }
  function clearSlip() {
    state.slip = {};
    persistSlip();
    renderControls();
    renderBoard();
    renderSlip();
  }
  function setStake(v) {
    const n = parseFloat(v);
    state.stake = n > 0 ? n : 0;
    try { localStorage.setItem('aimplified_stake', String(state.stake)); } catch (e) {}
    renderSlip();
  }

  function toggleCompareMode() {
    state.compareMode = !state.compareMode;
    state.compareIds = [];
    renderControls();
    renderBoard();
    renderComparePanel();
  }

  function toggleCompareSelect(id) {
    if (state.compareIds.includes(id)) {
      state.compareIds = state.compareIds.filter((x) => x !== id);
    } else if (state.compareIds.length >= 2) {
      state.compareIds = [state.compareIds[1], id];
    } else {
      state.compareIds = [...state.compareIds, id];
    }
    renderControls();
    renderBoard();
    renderComparePanel();
  }

  function clearCompare() {
    state.compareIds = [];
    renderControls();
    renderBoard();
    renderComparePanel();
  }

  function toggleHitterCompareMode() {
    state.hitterCompareMode = !state.hitterCompareMode;
    state.hitterCompareIds = [];
    renderControls();
    renderHittersGrid();
    renderHitterComparePanel();
  }

  function toggleHitterCompareSelect(idx) {
    if (state.hitterCompareIds.includes(idx)) {
      state.hitterCompareIds = state.hitterCompareIds.filter((x) => x !== idx);
    } else if (state.hitterCompareIds.length >= 2) {
      state.hitterCompareIds = [state.hitterCompareIds[1], idx];
    } else {
      state.hitterCompareIds = [...state.hitterCompareIds, idx];
    }
    renderControls();
    renderHittersGrid();
    renderHitterComparePanel();
  }

  function clearHitterCompare() {
    state.hitterCompareIds = [];
    renderControls();
    renderHittersGrid();
    renderHitterComparePanel();
  }

  function togglePitcherCompareMode() {
    state.pitcherCompareMode = !state.pitcherCompareMode;
    state.pitcherCompareIds = [];
    renderControls();
    renderPitchers();
    renderPitcherComparePanel();
  }

  function togglePitcherCompareSelect(idx) {
    if (state.pitcherCompareIds.includes(idx)) {
      state.pitcherCompareIds = state.pitcherCompareIds.filter((x) => x !== idx);
    } else if (state.pitcherCompareIds.length >= 2) {
      state.pitcherCompareIds = [state.pitcherCompareIds[1], idx];
    } else {
      state.pitcherCompareIds = [...state.pitcherCompareIds, idx];
    }
    renderControls();
    renderPitchers();
    renderPitcherComparePanel();
  }

  function clearPitcherCompare() {
    state.pitcherCompareIds = [];
    renderControls();
    renderPitchers();
    renderPitcherComparePanel();
  }

  function onRowClick(id) {
    if (state.compareMode) toggleCompareSelect(id);
    else toggleExpand(id);
  }

  function onLeadingClick(id) {
    if (state.compareMode) toggleCompareSelect(id);
    else toggleSlip(id);
  }

  function onHitterCardClick(idx) {
    if (state.hitterCompareMode) toggleHitterCompareSelect(idx);
  }

  function onPitcherCardClick(idx) {
    if (state.pitcherCompareMode) togglePitcherCompareSelect(idx);
  }

  // ---------------------------------------------------------------------
  // EVENTS
  // ---------------------------------------------------------------------

  function dispatchAction(target, e) {
    const action = target.dataset.action;
    switch (action) {
      case 'toggle-theme': toggleTheme(); break;
      case 'set-filter': setFilter(target.dataset.filter); break;
      case 'set-view': setView(target.dataset.view); break;
      case 'set-sport': setSport(target.dataset.sport); break;
      case 'nfl-view': setNflView(target.dataset.nflview); break;
      case 'nfl-filter': setNflFilter(target.dataset.nflfilter); break;
      case 'nfl-sort': setNflSort(target.dataset.nflsort); break;
      case 'toggle-pass': state.batterShowPass = !state.batterShowPass; renderBoard(); break;
      // Rate-limited on purpose. Every retry is a real upstream call, and the
      // batter fetch is the expensive one (one request per game, three markets
      // each). An un-throttled button next to an outage message is an invitation
      // to hammer the quota that caused the outage.
      case 'feed-retry': {
        if (Date.now() < state.feedRetryAllowedAt) break;
        state.feedRetryAllowedAt = Date.now() + RETRY_COOLDOWN_MS;
        state.feedNextRetry = Date.now() + BATTER_POLL_MS;
        renderViewChrome();          // reflect the disabled button immediately
        refreshBatters();
        break;
      }
      case 'nfl-showall': state.nflShowAll = !state.nflShowAll; renderNfl(); break;
      case 'nfl-toggle': {
        const id = target.dataset.id;
        state.nflOpen = state.nflOpen === id ? null : id;
        renderNfl();
        break;
      }
      case 'set-sort': setSort(target.dataset.sort); break;
      case 'toggle-compare-mode': toggleCompareMode(); break;
      case 'toggle-hitter-compare-mode': toggleHitterCompareMode(); break;
      case 'toggle-pitcher-compare-mode': togglePitcherCompareMode(); break;
      case 'clear-compare': clearCompare(); break;
      case 'clear-hitter-compare': clearHitterCompare(); break;
      case 'clear-pitcher-compare': clearPitcherCompare(); break;
      case 'leading-click':
        // Star/checkbox sits inside a clickable row — don't also toggle the row.
        if (e) e.stopPropagation();
        onLeadingClick(target.dataset.id);
        break;
      case 'row-click': onRowClick(target.dataset.id); break;
      case 'hero-add': if (e) e.stopPropagation(); addHeroToSlip(target.dataset.id); break;
      case 'remove-leg': if (e) e.stopPropagation(); removeLeg(target.dataset.leg); break;
      case 'clear-slip': clearSlip(); break;
      case 'hitter-card-click': onHitterCardClick(Number(target.dataset.idx)); break;
      case 'pitcher-card-click': onPitcherCardClick(Number(target.dataset.idx)); break;
      case 'injbar-toggle': state.injBarOpen = !state.injBarOpen; renderInjuryAlerts(); break;
      case 'alerts-toggle': state.alertsOpen = !state.alertsOpen; renderInjuryAlerts(); break;
      case 'yc-toggle': state.ycOpen = !state.ycOpen; renderYesterdayCard(); break;
      case 'inj-shownoimpact': state.injShowNoImpact = true; renderInjuryAlerts(); break;
      case 'inj-showallimpact': state.injShowAllImpact = true; renderInjuryAlerts(); break;
      case 'jump-pick': {
        if (e) e.stopPropagation();
        const v = target.dataset.view, id = target.dataset.id;
        if (v && v !== state.boardView) setView(v);
        state.filter = 'all';
        state.expandedId = id;
        renderControls();
        renderBoard();
        const bw = document.getElementById('boardWrap');
        if (bw) bw.scrollIntoView({ behavior: 'smooth', block: 'start' });
        break;
      }
      case 'injbar-filter':
        if (e) e.stopPropagation();
        state.injBarFilter = target.dataset.mode; renderInjuryAlerts(); break;
    }
  }

  document.body.addEventListener('click', (e) => {
    const target = e.target.closest('[data-action]');
    if (!target) return;
    dispatchAction(target, e);
  });

  // A toggle re-renders #boardRows from scratch, so the focused element is
  // destroyed. Re-focus the same row by id afterwards to keep the keyboard on
  // the row it just acted on — otherwise focus falls back to <body> and arrow
  // nav dead-ends after every expand.
  function refocusRow(id) {
    const again = document.querySelector(`.board-row[data-id="${(window.CSS && CSS.escape) ? CSS.escape(id) : id}"]`);
    if (again) again.focus();
  }

  // Keyboard on the board rows: arrows walk the list, Escape collapses the open
  // row, Enter/Space toggles (handled by the generic activator below). Rows are
  // real role=button/tabindex controls, so this is the expected behaviour.
  document.body.addEventListener('keydown', (e) => {
    const row = e.target.closest && e.target.closest('.board-row[data-action="row-click"]');
    if (row) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const rows = Array.from(row.parentElement.querySelectorAll('.board-row[data-action="row-click"]'));
        const next = rows[rows.indexOf(row) + (e.key === 'ArrowDown' ? 1 : -1)];
        if (next) next.focus();
        return;
      }
      if (e.key === 'Escape' && state.expandedId === row.dataset.id) {
        e.preventDefault();
        const id = row.dataset.id;
        toggleExpand(id);   // collapses + re-renders
        refocusRow(id);
        return;
      }
    }

    // Generic: activate any focusable [data-action] control with Enter/Space.
    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
    const target = e.target.closest('[data-action]');
    if (!target || !target.hasAttribute('tabindex')) return;
    e.preventDefault(); // stop Space from scrolling the page
    dispatchAction(target, e);
    // Keep focus on a toggled row so the next arrow/Enter lands where expected.
    if (target.matches('.board-row[data-action="row-click"]')) refocusRow(target.dataset.id);
  });

  {
    const nq = document.getElementById('nflSearch');
    if (nq) nq.addEventListener('input', (e) => {
      state.nflSearch = e.target.value;
      renderNfl();
    });
  }
  el.searchInput.addEventListener('input', (e) => {
    state.searchQuery = e.target.value;
    renderBoard();
  });

  // ---------------------------------------------------------------------
  // TIMERS
  // ---------------------------------------------------------------------

  if (LIVE_MODE) {
    // Live mode: the hero shows the real model win probability (static),
    // so no simulated ticking. Poll the real feeds.
    refreshLiveData();
    setInterval(refreshLiveData, 60000);
    // Season leaderboards change slowly — load once, refresh every 10 min.
    refreshHitters();
    setInterval(refreshHitters, 600000);
    refreshPitchers();
    setInterval(refreshPitchers, 600000);
    // Board carries the model + real prop lines (credits) — poll every 5 min.
    refreshBoard();
    setInterval(refreshBoard, 300000);
    // Under Plays is the landing board, so its feed must load on boot — without
    // this the hero + default board sat on "Loading…" until the first interval
    // tick (up to 5 min). The edge cache still shares one upstream burst per TTL
    // across viewers, so this doesn't multiply the Odds-API spend. Ongoing polls
    // stay gated to when the tab is actually open.
    refreshBatters();
    setInterval(() => { if (isBatter()) refreshBatters(); }, BATTER_POLL_MS);
    // Tick the outage banner's age and countdown. Only touches the two text nodes
    // — re-rendering the banner every second would fight the Retry button's focus
    // and disabled state, and it only runs while the banner is actually up.
    setInterval(() => {
      if (!el.kCtxBanner || el.kCtxBanner.hidden || !state.feedError) return;
      const age = el.kCtxBanner.querySelector('.cb-age');
      const next = el.kCtxBanner.querySelector('.cb-next');
      if (age) age.textContent = outageAgeLabel();
      if (next) next.textContent = retryCountdownLabel();
      const btn = el.kCtxBanner.querySelector('.cb-retry');
      if (btn) btn.disabled = Date.now() < state.feedRetryAllowedAt;
    }, 1000);
    // Track record grades finished games on read — refresh every 10 min.
    refreshTrackRecord();
    setInterval(refreshTrackRecord, 600000);
    // Injury wire (recent IL moves) — refresh every 10 min.
    refreshInjuries();
    setInterval(refreshInjuries, 600000);
    // Live Now — in-progress picks scored live; poll every 45s.
    refreshLiveNow();
    setInterval(refreshLiveNow, 45000);
  } else {
    // Mock mode: keep the demo lively — simulated win-prob and score nudges.
    setInterval(() => {
      const delta = Math.random() * 4 - 2;
      const next = Math.min(80, Math.max(50, state.winProb + delta));
      state.winProb = Math.round(next * 10) / 10;
      renderWinProb();
    }, 4000);
    setInterval(() => {
      const scores = { ...state.tickerScores };
      Object.keys(scores).forEach((id) => {
        if (Math.random() < 0.35) {
          const [a, b] = scores[id].split('-').map(Number);
          scores[id] = Math.random() < 0.5 ? (a + 1) + '-' + b : a + '-' + (b + 1);
        }
      });
      state.tickerScores = scores;
      renderTicker();
    }, 5000);
  }

  // ---------------------------------------------------------------------
  // INIT
  // ---------------------------------------------------------------------

  el.searchInput.value = state.searchQuery;
  renderAll();

  // -------------------------------------------------------------------------
  // NFL — game-line context board
  // -------------------------------------------------------------------------
  // Sections that belong to the MLB product. Switching sport hides them rather
  // than trying to make them sport-agnostic: the hero argues the batter-unders
  // thesis and the track record is an MLB record, so showing either under an NFL
  // tab would be a claim we have not earned.
  const MLB_ONLY = ['.hero', '#liveNow', '#slate', '#slipSection', '#record'];

  function setSport(s) {
    if (state.sport === s) return;
    state.sport = s;
    document.querySelectorAll('.stab[data-sport]').forEach((t) =>
      t.classList.toggle('active', t.dataset.sport === s));
    const nfl = s === 'nfl';
    for (const sel of MLB_ONLY) {
      const n = document.querySelector(sel);
      if (n) n.hidden = nfl;
    }
    applySportChrome(s);
    if (el.nflBoard) el.nflBoard.hidden = !nfl;
    if (el.slateSummary && nfl) el.slateSummary.hidden = true;
    if (nfl && !state.nfl) refreshNfl();          // lazy first load
    if (nfl && state.nflView !== 'lines' && !state.nflProps) refreshNflProps();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function refreshNfl() {
    if (!LIVE_MODE) return;
    try {
      const d = await fetchJson('/api/nfl-board');
      state.nfl = (d && Array.isArray(d.games)) ? d : { games: [], empty: true };
    } catch (e) {
      state.nfl = { games: [], empty: true, error: 'unreachable' };
    }
    renderNfl();
  }

  const AM = (n) => (n == null ? '—' : (n > 0 ? '+' + n : String(n)));
  const BOOK_LABEL = {
    draftkings: 'DK', fanduel: 'FD', betmgm: 'MGM', betrivers: 'BR',
    williamhill_us: 'CZR', pinnacle: 'PIN', lowvig: 'LV', betonlineag: 'BOL',
    novig: 'NOVIG', prophetx: 'PX',
  };
  const bkLabel = (k) => BOOK_LABEL[k] || (k || '').toUpperCase();
  const num = (v) => (v == null ? '—' : String(v));
  const signed = (v) => (v == null ? '—' : (v > 0 ? '+' + v : String(v)));

  function renderNfl() {
    const d = state.nfl;
    if (!d || !el.nflGrid) return;
    const games = d.games || [];
    const pre = d.seasonType === 'PRE';

    const isLines = state.nflView === 'lines';
    const props = (state.nflProps && state.nflProps.rows) || [];
    // Everything the toolbar can act on, before it acts.
    const base = isLines ? games : props.filter((r) => r.market === state.nflView);
    renderNflControls(base);
    const propRows = nflVisibleRows(base);

    document.querySelectorAll('.nflm[data-nflview]').forEach((b) =>
      b.classList.toggle('is-on', b.dataset.nflview === state.nflView));

    if (el.nflBannerTag) el.nflBannerTag.textContent = pre ? 'Preseason · context only' : 'Context · not plays';
    if (el.nflBannerBody) {
      el.nflBannerBody.innerHTML = isLines
        ? 'No book quotes <b>NFL player props</b> yet, so nothing here is postable. Below is the game-line '
          + 'read — spread, total and implied team totals — priced against the sharp pool where two or more '
          + 'sharp books agree.'
        : 'These are <b>projections, not plays</b>. No book quotes NFL yardage props through our feed, so '
          + 'there is no line to price against and nothing here is graded. <b>Passing yards are not shown</b>: '
          + 'backtested over two seasons the outcome landed below the projected mean only 42% and 49% of the '
          + 'time, so the skew this model trades on is not there.'
        ;
      if (pre) el.nflBannerBody.innerHTML += ' Preseason starters play a quarter: <b>nothing enters the public '
        + 'record</b>, and preseason snaps and routes never reach the model’s priors.';
    }
    if (el.nflBoardTitle) el.nflBoardTitle.textContent = pre ? 'Preseason Board' : 'NFL Board';
    if (el.nflCount) {
      const wk = games.find((g) => g.week != null);
      el.nflCount.textContent = isLines
        ? (propRows.length ? propRows.length + ' of ' + games.length + ' game' + (games.length === 1 ? '' : 's')
            + (wk ? ' · week ' + wk.week : '') + ' · game lines only' : '')
        : (propRows.length ? propRows.length + ' of ' + base.length + ' players · ' + state.nflView + ' yards · projection only' : '');
    }
    if (el.nflPostable) el.nflPostable.textContent = (d.postable || 0) + ' postable';

    const shown = propRows.length;
    if (el.nflEmpty) el.nflEmpty.hidden = shown > 0;
    // Why the board is empty, distinguished the way the MLB board distinguishes
    // it. "No play clears the bar" claims we evaluated a slate and declined it;
    // saying that when there are simply no games is a claim about analysis that
    // never happened.
    if (el.nflEmpty && shown === 0) {
      const loading = !isLines && !state.nflProps;
      const filtered = base.length > 0;
      const k = el.nflEmpty.querySelector('.nfe-k');
      const d = el.nflEmpty.querySelector('.nfe-d');
      if (k && d) {
        if (loading) {
          k.textContent = 'Loading projections…';
          d.textContent = '';
        } else if (filtered) {
          k.textContent = 'Nothing matches this filter.';
          d.textContent = `${base.length} row${base.length === 1 ? '' : 's'} on the board — clear the search or choose All to see them.`;
        } else if (isLines) {
          k.textContent = 'No NFL games in range.';
          d.textContent = 'Preseason has finished for now and the regular season is still outside the ten-day ingest window. '
            + 'The board fills again once Week 1 comes into range.';
        } else {
          k.textContent = 'No NFL games in range.';
          d.textContent = 'Projections need a slate to price against — a game supplies the spread and total everything else '
            + 'cascades from. Nothing is scheduled inside the ingest window right now.';
        }
      }
    }
    // A toolbar over an empty board is furniture. Hide it when there is nothing
    // it could act on, but keep it the moment a filter is what emptied the list.
    const tb = document.querySelector('#nflBoard .board-toolbar');
    if (tb) tb.hidden = base.length === 0;

    el.nflGrid.innerHTML = shown
      ? (isLines ? nflTable(propRows) : nflPropTable(propRows, state.nflView))
      : '';

    // The standalone strip belongs to the game-line read; a player board is not
    // about one kickoff window.
    const solo = isLines && (games.length === 1 || (games.length > 0 && games.every((g) => g.standalone)));
    if (el.nflStrip) {
      el.nflStrip.hidden = !solo;
      if (solo) el.nflStrip.innerHTML = nflStrip(games[0]);
    }

    if (el.nflFoot) {
      if (!isLines) {
        el.nflFoot.innerHTML = propRows.length
          ? 'Volume-ordered — with no line to compare against there is no edge to rank by. '
            + 'Priors from the <b>' + ((state.nflProps && state.nflProps.builtFrom) || '—') + '</b> season; '
            + 'players who changed teams and rookies are held back until they have current-season usage.'
          : (state.nflProps ? 'No projections for this slate.' : 'Loading projections…');
        return;
      }
      const mkt = games.filter((g) => g.fairSrc === 'MKT').length;
      el.nflFoot.innerHTML = games.length
        ? 'Fair from the sharp pool (Pinnacle · LowVig · BetOnline), Shin de-vigged, <b>two books minimum</b>. '
          + mkt + ' of ' + games.length + ' game' + (games.length === 1 ? '' : 's')
          + ' did not clear that bar and show as <span class="nfl-mkt">MKT</span> — market price only, no fair line.'
          + (d.asOf ? ' Lines as of ' + new Date(d.asOf).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + '.' : '')
        : '';
    }
  }

  function kickoff(iso) {
    if (!iso) return '';
    const t = new Date(iso);
    if (isNaN(t)) return '';
    return t.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  }



  function nflStrip(g) {
    const cell = (k, v) => '<div><span>' + k + '</span><b>' + v + '</b></div>';
    return '<div class="nfs">'
      + '<div class="nfs-t">' + g.away + ' <span>at</span> ' + g.home + '</div>'
      + '<div class="nfs-g">'
      + cell('Spread', g.away + ' ' + signed(g.away_spread))
      + cell('Total', num(g.total))
      + cell('Implied ' + g.away, num(g.away_implied))
      + cell('Implied ' + g.home, num(g.home_implied))
      + cell('Plays', '0')
      + '</div></div>';
  }


  // NFL moneyline table. Deliberately emits the same .board / .board-row markup
  // the MLB moneyline view uses rather than a parallel component: it inherits the
  // column widths, the row chrome, the expand styling and — the part that would
  // otherwise have to be rebuilt — the mobile collapse, which keys on
  // .board-row:not(.expanded).
  //
  // Columns match the MLB moneyline head exactly:
  //   Matchup | Team to win | Moneyline | Line value | Win Prob | (chip) | (chev)
  const NFL_ML_COLS = ['Matchup', 'Team to win', 'Moneyline', 'Line value', 'Win Prob', '', ''];

  function nflTable(games) {
    const head = NFL_ML_COLS
      .map((c) => (c ? `<span class="col-label">${c}</span>` : '<span></span>'))
      .join('');
    // view-moneyline carries --bcols. Without it .board-row has no column template
    // and every cell collapses to content width -- rows went 201px instead of 97px.
    return `<div class="board view-moneyline" id="nflBoardWrap"><div class="board-inner">`
      + `<div class="board-head-row">${head}</div>`
      + `<div>${games.map(nflRow).join('')}</div>`
      + `</div></div>`;
  }

  function nflRow(g) {
    const open = state.nflOpen === g.id;
    const isMkt = g.fairSrc === 'MKT';

    // Sub-line carries what the card used to: kickoff, the market's own numbers,
    // and the roof when it is not simply outdoors.
    const sub = [
      kickoff(g.commence),
      g.away_spread != null ? `${g.away} ${signed(g.away_spread)}` : null,
      g.total != null ? `O/U ${g.total}` : null,
      g.roof && g.roof !== 'outdoors' ? g.roof : null,
    ].filter(Boolean).join(' · ');

    // An MKT row has no fair line, so it carries no team-to-win, no value and no
    // win probability. Those cells stay empty rather than borrowing the market's
    // number and presenting it as ours.
    const pick = isMkt ? '<span class="odds-blank">fewer than two sharp books</span>' : (g.pickTeam || '—');
    const odds = isMkt
      ? (g.away_price != null
        ? `<span class="odds-cell mono">${AM(g.away_price)} / ${AM(g.home_price)}</span>`
        : '<span class="odds-blank">no price</span>')
      : `<span class="odds-cell mono">${AM(g.pickPrice)}<i class="bk-tag">${bkLabel(g.pickBook)}</i></span>`;
    const val = (!isMkt && g.pickValue != null) ? g.pickValue : null;
    // Green only when the fair line actually sits above the price. Value is the
    // one number here that says "this price is better than fair", so it is the
    // one that earns the positive colour.
    const valColor = val == null ? 'var(--textFaint)' : (val > 0 ? 'var(--positive)' : 'var(--textDim)');
    const valLabel = val == null ? '—' : (val > 0 ? '+' : '') + val + '%';
    const winProb = (!isMkt && g.pickFair != null)
      ? `<span class="interval-cell" style="color:var(--model)">${g.pickFair}%</span>`
      : '<span class="interval-cell">—</span>';
    const chip = isMkt
      ? '<span class="ctx-chip nfl-mktchip">MKT</span>'
      : `<span class="ctx-chip">sharp ${g.sharpN}</span>`;

    const row = `<div class="board-row${open ? ' expanded' : ''}" data-action="nfl-toggle" data-id="${g.id}"
        role="button" tabindex="0" aria-expanded="${open ? 'true' : 'false'}"
        aria-label="${g.away} at ${g.home} — toggle breakdown">
        <div class="matchup-cell">
          <span class="mc-head">${nflBadge(g.away)}<span class="nfl-at">@</span>${nflBadge(g.home)}</span>
          <span class="matchup-sub">${sub}</span>
        </div>
        <span>${pick}</span>
        ${odds}
        <span class="edge-cell" style="color:${valColor}">${valLabel}</span>
        ${winProb}
        <span class="tier-cell">${chip}</span>
        <span class="chevron">${open ? '▲' : '▼'}</span>
      </div>`;
    return row + (open ? nflDetail(g) : '');
  }

  function nflDetail(g) {
    const isMkt = g.fairSrc === 'MKT';
    const cell = (k, v) => `<div class="nfd-c"><span>${k}</span><b>${v}</b></div>`;
    const read = isMkt
      ? `Only ${g.sharpN} sharp book${g.sharpN === 1 ? '' : 's'} quoted this game, so there is no fair line to price against. `
        + `The prices shown are the market's, not a value read.`
      : `Fair from ${(g.fairBooks || []).map(bkLabel).join(' · ')}, Shin de-vigged and medianed. `
        + `<b>${g.pickTeam}</b> is fair at <b>${g.pickFair}%</b>; the best price of ${AM(g.pickPrice)} at `
        + `${bkLabel(g.pickBook)} implies ${g.pickImplied}%. `
        + (g.pickValue > 0
          ? `That is <b>${g.pickValue} points of value</b>.`
          : `That is ${Math.abs(g.pickValue)} points the wrong way — no value at this price.`);
    return `<div class="expanded-detail nfl-detail">
      <div class="nfd-k">Price read</div>
      <div class="nfd-read">${read}</div>
      <div class="nfd-grid">
        ${cell('Spread', g.away + ' ' + signed(g.away_spread))}
        ${cell('Total', num(g.total))}
        ${cell('Implied ' + g.away, num(g.away_implied))}
        ${cell('Implied ' + g.home, num(g.home_implied))}
        ${cell('Books', g.books)}
        ${cell('Roof', g.roof || '—')}
      </div>
      <div class="nfd-foot">Context only — the run line and moneyline are not graded and not posted.</div>
    </div>`;
  }


  // -------------------------------------------------------------------------
  // NFL yardage projections — board
  // -------------------------------------------------------------------------
  // A projections board, not a plays board, and the columns say so. There is no
  // line, no price, no edge and no tier, because none of those exist for a
  // market no book quotes through our feed. Inventing a tier here would be the
  // one dishonest thing this table could do.
  const NFL_PROP_COLS = ['Player', 'Projection', '50% range', 'Median', 'Usage', 'Confidence', ''];

  async function refreshNflProps() {
    if (!LIVE_MODE) return;
    try {
      const d = await fetchJson('/api/nfl-props');
      state.nflProps = (d && Array.isArray(d.rows)) ? d : { rows: [], error: 'empty' };
    } catch (e) {
      state.nflProps = { rows: [], error: 'unreachable' };
    }
    renderNfl();
  }

  function setNflView(v) {
    if (state.nflView === v) return;
    state.nflView = v;
    state.nflOpen = null;
    // The two views share no sort keys, so carrying one over would leave the
    // board sorted by something it cannot measure.
    state.nflFilter = 'all';
    state.nflSort = v === 'lines' ? 'edge' : 'proj';
    state.nflSortAsc = false;
    if (v !== 'lines' && !state.nflProps) refreshNflProps();   // lazy first load
    renderNfl();
  }

  function nflPropTable(rows, market) {
    const head = NFL_PROP_COLS
      .map((c) => (c ? `<span class="col-label">${c}</span>` : '<span></span>'))
      .join('');
    return `<div class="board view-nflprops"><div class="board-inner">`
      + `<div class="board-head-row">${head}</div>`
      + `<div class="np-rows${state.nflShowAll ? ' show-all' : ''}">${rows.map((r) => nflPropRow(r, market)).join('')}</div>`
      + (() => {
        const low = rows.filter((r) => r.conf === 3).length;
        if (!low) return '';
        return `<button class="np-more" data-action="nfl-showall">${state.nflShowAll
          ? 'Hide ' + low + ' low-confidence row' + (low === 1 ? '' : 's')
          : 'Show ' + low + ' low-confidence row' + (low === 1 ? '' : 's')}</button>`;
      })()
      + `</div></div>`;
  }

  function nflPropRow(r, market) {
    const id = r.player + '|' + r.market;
    const open = state.nflOpen === id;
    // Usage is a different measurement per market and is labelled as such rather
    // than collapsed into one number that means two things.
    const usage = market === 'receiving'
      ? `${r.rp}%<i class="bk-tag">routes</i>`
      : `${r.count}<i class="bk-tag">carries</i>`;
    // Low-confidence rows fold on a phone, the same rule the batter board uses
    // for its Pass tier: what the model has least faith in gives way, everything
    // it stands behind stays on screen. Marked here, hidden by CSS only.
    const tail = r.conf === 3 ? ' np-low' : '';
    const row = `<div class="board-row${open ? ' expanded' : ''}${tail}" data-action="nfl-toggle" data-id="${esc(id)}"
        role="button" tabindex="0" aria-expanded="${open ? 'true' : 'false'}"
        aria-label="${esc(r.player)} — toggle breakdown">
        <div class="matchup-cell">
          <span class="mc-head"><b>${esc(r.player)}</b> ${nflBadge(r.team)}</span>
          <span class="matchup-sub">${esc(r.pos)} · ${esc(r.game)}</span>
        </div>
        <span class="np-proj">${r.proj}<i>yds</i></span>
        <span class="np-range">${r.p25} – ${r.p75}</span>
        <span class="interval-cell" style="color:var(--model)">${r.p50}</span>
        <span class="np-usage">${usage}</span>
        <span class="tier-cell">${confChip(r.conf)}</span>
        <span class="chevron">${open ? '▲' : '▼'}</span>
      </div>`;
    return row + (open ? nflPropDetail(r, market) : '');
  }

  function nflPropDetail(r, market) {
    const skew = Math.round((r.proj - r.p50) * 10) / 10;
    const cell = (k, v) => `<div class="nfd-c"><span>${k}</span><b>${v}</b></div>`;
    return `<div class="expanded-detail nfl-detail">
      <div class="nfd-k">How this number is built</div>
      <div class="nfd-read">
        The game's spread and total set the team's plays and pass/run split; ${esc(r.player)}'s
        share of that volume sets his opportunity; his own efficiency turns it into yards.
        ${market === 'receiving'
          ? 'Receptions are drawn from a negative binomial and each catch\'s yards from a gamma, then multiplied — receiving yards are a compound outcome, not a bell curve.'
          : 'Carries are drawn from a negative binomial and each carry\'s yards from a shifted gamma, so a stuffed run can lose yardage.'}
        The mean sits <b>${skew} yds above the median</b>, which is the whole reason this market is worth
        fading: a line set near the mean is above the outcome that actually happens most often.
      </div>
      <div class="nfd-grid">
        ${cell('Mean', r.proj)}
        ${cell('Median', r.p50)}
        ${cell('25th pct', r.p25)}
        ${cell('75th pct', r.p75)}
        ${cell(market === 'receiving' ? 'Routes' : 'Carries', market === 'receiving' ? r.rp + '%' : r.count)}
        ${cell('Prior', state.nflProps && state.nflProps.builtFrom ? state.nflProps.builtFrom : '—')}
      </div>
      <div class="nfd-foot">No book quotes this market through our feed, so there is no line to price
        against — this is a projection, not a play, and nothing here is graded.</div>
    </div>`;
  }

  // Confidence chip. Deliberately not tierChip(): that renders the MLB board's
  // T1/T2/T3, which is measured against a price and means "how strong is the
  // play". This means "how much is the projection worth trusting", and reusing
  // the same component would quietly merge two different claims.
  function confChip(c) {
    const label = c === 1 ? 'High' : c === 2 ? 'Med' : 'Low';
    return `<span class="conf-chip c${c}" title="Projection confidence — prior size, role stability and distribution width. Not a betting tier.">${label}</span>`;
  }


  // Run Line as table rows. Was the last view still built from cards, which made
  // it 220px a row against 81px everywhere else. The data was always table-
  // shaped — two sides, a price, a fair cover percentage and a verdict — so the
  // card format was buying height without buying information.
  //
  // Uses the shared .board-row markup and its own --bcols, so it inherits the
  // column grid, the expand chrome and the mobile collapse like every other view.
  function renderRunlineRows(games) {
    const money = (v) => v == null ? '—' : (v > 0 ? '+' + v : String(v));
    return games.map((g) => {
      const rl = g.rl || {};
      const isExpanded = state.expandedId === g.id;
      const isPick = typeof rl.tier === 'number' && rl.modelAgrees;

      const sideObj = (abbr, point, price, cover) => ({ abbr, point, price, cover });
      const sides = [
        sideObj(rl.homeAbbr, rl.homePoint, rl.homePrice, rl.homeCoverPct),
        sideObj(rl.awayAbbr, rl.awayPoint, rl.awayPrice, rl.awayCoverPct),
      ].sort((a, b) => (a.point ?? 0) - (b.point ?? 0));
      const pt = (v) => v == null ? '' : (v > 0 ? '+' : '') + v;

      // The side the value sits on, which is what the card led with.
      const val = sides.find((s) => s.abbr === rl.teamAbbr) || sides[0];
      const other = sides.find((s) => s !== val);

      const status = (g.status === 'Live' || g.status === 'Final') && g.score && g.score.includes('-')
        ? `${g.status === 'Live' ? '● Live' : 'Final'} ${esc(g.score)}`
        : esc(g.timeLabel || 'TBD');
      // The matchup already leads the head cell; repeating it here printed
      // "NYY @ TOR NYY @ TOR · 10:37 AM PT". The sub-line carries time and score.
      const sub = status;

      const edgeVal = rl.edge;
      const edgeColor = edgeVal == null ? 'var(--textFaint)'
        : (isPick ? 'var(--positive)' : edgeVal > 0 ? 'var(--textDim)' : 'var(--textFaint)');
      const edgeLabel = edgeVal == null ? '—' : (edgeVal > 0 ? '+' : '') + edgeVal + '%';

      // T1/T2/T3 came off the same edge ranking the batter board just dropped --
      // and with no graded run-line record at all, an ordering here rests on less
      // evidence than the one that was removed, not more.
      const chip = isPick ? tierChip('lean') : tierChip('pass');

      const row = `<div class="board-row${isExpanded ? ' expanded' : ''}${rl.closed ? ' rl-closed-row' : ''}"
          data-action="row-click" data-id="${esc(g.id)}"
          role="button" tabindex="0" aria-expanded="${isExpanded}"
          aria-label="${esc(g.matchup || '')} — toggle breakdown">
          <div class="matchup-cell">
            <span class="mc-head"><b>${esc(g.matchup || '—')}</b>${rl.closed ? '<span class="rl-closed">closed</span>' : ''}</span>
            <span class="matchup-sub">${sub}</span>
          </div>
          <span>${esc(val.abbr || '—')} ${esc(pt(val.point))}</span>
          <span class="odds-cell mono">${esc(money(val.price))}</span>
          <span class="edge-cell" style="color:${edgeColor}">${edgeLabel}</span>
          <span class="interval-cell" style="color:var(--model)">${val.cover == null ? '—' : val.cover + '%'}</span>
          <span class="tier-cell">${chip}</span>
          <span class="chevron">${isExpanded ? '▲' : '▼'}</span>
        </div>`;

      if (!isExpanded) return row;

      // The panel carries what the card's second half used to: both sides side by
      // side, and the model's verdict in words.
      const lean = isPick
        ? `<span class="rl-ok">✓</span> model backs <b>${esc(rl.teamAbbr)}</b> ${esc(pt(val.point))}`
        : (rl.edge != null && rl.edge > 0
          ? `<span class="rl-no">✕</span> value shows on <b>${esc(val.abbr)} ${esc(pt(val.point))}</b>, but the model does not back it — <b>no play</b>`
          : 'no value against the sharp fair line');
      const box = (s) => `<div class="nfd-c"><span>${esc(s.abbr || '—')} ${esc(pt(s.point))}</span>`
        + `<b>${esc(money(s.price))}</b><span class="rl-cov">${s.cover == null ? '' : 'fair ' + s.cover + '%'}</span></div>`;
      return row + `<div class="expanded-detail nfl-detail">
        <div class="nfd-k">Run line read</div>
        <div class="nfd-read">${lean}</div>
        <div class="nfd-grid">
          ${box(val)}${box(other || {})}
          <div class="nfd-c"><span>Edge</span><b>${edgeLabel}</b></div>
          <div class="nfd-c"><span>Fair source</span><b>${esc(rl.fairSource || '—')}</b></div>
        </div>
        <div class="nfd-foot">Context only — the run line is not graded and not posted.</div>
      </div>`;
    }).join('');
  }


  // -------------------------------------------------------------------------
  // NFL toolbar — search, filter, sort
  // -------------------------------------------------------------------------
  // Same shape and styling as the MLB board, but the keys are per view and are
  // never borrowed. The game-line read has an edge, a price and a win
  // probability to sort on; the projection boards have none of those, because
  // no book quotes the market. Offering Edge and Odds there would ship chips
  // that sort nothing — the exact bug fixed on the MLB moneyline board, where a
  // chip now appears only when the metric actually has values.
  const NFL_VIEW_CFG = {
    lines: {
      filters: [['all', 'All'], ['sharp', 'Sharp'], ['mkt', 'MKT']],
      sorts: [['edge', 'Edge'], ['fair', 'Win Prob'], ['odds', 'Odds'], ['time', 'Time']],
      // Higher is better for the first three, soonest first for time.
      metric: {
        edge: (g) => g.pickValue,
        fair: (g) => g.pickFair,
        odds: (g) => (g.pickPrice == null ? null : amProbLocal(g.pickPrice)),
        time: (g) => Date.parse(g.commence || 0) || null,
      },
      match: (g, q) => `${g.away} ${g.home} ${g.awayFull || ''} ${g.homeFull || ''}`.toLowerCase().includes(q),
      keep: (g, f) => f === 'all' || (f === 'sharp' ? g.fairSrc !== 'MKT' : g.fairSrc === 'MKT'),
    },
    props: {
      // Confidence, not tiers. The board has no price, so it has no tier — see
      // the confidence chip comment. Labels match the chips exactly.
      filters: [['all', 'All'], ['1', 'High'], ['2', 'Med'], ['3', 'Low']],
      sorts: [['proj', 'Projection'], ['p50', 'Median'], ['usage', 'Usage'], ['time', 'Time']],
      metric: {
        proj: (r) => r.proj,
        p50: (r) => r.p50,
        usage: (r) => (r.market === 'receiving' ? r.rp : r.count),
        time: (r) => Date.parse(r.commence || 0) || null,
      },
      // Deliberately NOT r.game. That string is "DAL @ SEA", so including it made
      // a search for SEA return every Cowboy in the fixture too -- which
      // contradicts the placeholder and makes a team search useless for
      // isolating a team. Player, club and position only.
      match: (r, q) => `${r.player} ${r.team} ${r.pos}`.toLowerCase().includes(q),
      keep: (r, f) => f === 'all' || String(r.conf) === f,
    },
  };
  const amProbLocal = (odds) => (typeof odds !== 'number' ? null
    : odds > 0 ? 100 / (odds + 100) : -odds / (-odds + 100));

  const nflCfg = () => (state.nflView === 'lines' ? NFL_VIEW_CFG.lines : NFL_VIEW_CFG.props);

  // Time reads soonest-first; everything else reads biggest-first. Same default
  // direction rule the MLB board uses, so a reader moving between them is not
  // surprised by an inverted list.
  const nflSortDefaultAsc = (key) => key === 'time';

  function setNflSort(key) {
    if (state.nflSort === key) state.nflSortAsc = !state.nflSortAsc;
    else { state.nflSort = key; state.nflSortAsc = nflSortDefaultAsc(key); }
    renderNfl();
  }
  function setNflFilter(f) { state.nflFilter = f; renderNfl(); }

  // Rows the toolbar acts on, in display order.
  function nflVisibleRows(all) {
    const cfg = nflCfg();
    const q = (state.nflSearch || '').trim().toLowerCase();
    let rows = all.filter((r) => cfg.keep(r, state.nflFilter));
    if (q) rows = rows.filter((r) => cfg.match(r, q));
    const get = cfg.metric[state.nflSort] || cfg.metric[cfg.sorts[0][0]];
    const asc = state.nflSortAsc;
    return rows.slice().sort((a, b) => {
      const x = get(a), y = get(b);
      // A row with no value for the active key sinks, rather than being treated
      // as zero and jumping to the top of an ascending sort.
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return asc ? x - y : y - x;
    });
  }

  function renderNflControls(all) {
    const cfg = nflCfg();
    const fEl = document.getElementById('nflFilters');
    const sEl = document.getElementById('nflSorts');
    if (fEl) {
      fEl.innerHTML = cfg.filters.map(([key, label]) => {
        const n = all.filter((r) => cfg.keep(r, key)).length;
        const active = state.nflFilter === key ? ' active' : '';
        const empty = n === 0 && key !== 'all' ? ' chip-empty' : '';
        return `<button class="filter-btn${active}${empty}" data-action="nfl-filter" data-nflfilter="${key}">`
          + `${label}<span class="chip-count">${n}</span></button>`;
      }).join('');
    }
    if (sEl) {
      // Only offer a key something actually carries a value for.
      sEl.innerHTML = cfg.sorts.filter(([key]) => all.some((r) => cfg.metric[key](r) != null))
        .map(([key, label]) => {
          const on = state.nflSort === key;
          const arrow = on ? `<span class="sort-arrow">${state.nflSortAsc ? '↑' : '↓'}</span>` : '';
          return `<button class="sort-btn${on ? ' active' : ''}" data-action="nfl-sort" data-nflsort="${key}">`
            + `${label}${arrow}</button>`;
        }).join('');
    }
    const q = document.getElementById('nflSearch');
    if (q && q.value !== (state.nflSearch || '')) q.value = state.nflSearch || '';
  }


  // Team colours, same treatment the batter board already gives MLB clubs: a
  // badge you can pick out without reading it. Each pair is [background, text],
  // and the text colour is chosen per club for contrast rather than defaulting
  // to white — several of these grounds (Rams gold, Steelers yellow, Chargers
  // powder) are unreadable with white on top.
  const NFL_TEAM_COLORS = {
    ARI: ['#97233F', '#ffffff'], ATL: ['#A71930', '#ffffff'], BAL: ['#241773', '#ffffff'],
    BUF: ['#00338D', '#ffffff'], CAR: ['#0085CA', '#111111'], CHI: ['#0B162A', '#C83803'],
    CIN: ['#FB4F14', '#111111'], CLE: ['#311D00', '#FF3C00'], DAL: ['#041E42', '#869397'],
    DEN: ['#FB4F14', '#002244'], DET: ['#0076B6', '#ffffff'], GB:  ['#203731', '#FFB612'],
    HOU: ['#03202F', '#A71930'], IND: ['#002C5F', '#ffffff'], JAX: ['#101820', '#D7A22A'],
    KC:  ['#E31837', '#ffffff'], LV:  ['#000000', '#A5ACAF'], LAC: ['#0080C6', '#FFC20E'],
    LA:  ['#003594', '#FFA300'], MIA: ['#008E97', '#FC4C02'], MIN: ['#4F2683', '#FFC62F'],
    NE:  ['#002244', '#C60C30'], NO:  ['#101820', '#D3BC8D'], NYG: ['#0B2265', '#A71930'],
    NYJ: ['#125740', '#ffffff'], PHI: ['#004C54', '#A5ACAF'], PIT: ['#101820', '#FFB612'],
    SF:  ['#AA0000', '#B3995D'], SEA: ['#002244', '#69BE28'], TB:  ['#D50A0A', '#FF7900'],
    TEN: ['#0C2340', '#4B92DB'], WAS: ['#5A1414', '#FFB612'],
  };
  // Falls back to the plain badge rather than an invented colour, so a
  // relocation or a code we do not know reads as unstyled instead of wrong.
  function nflBadge(abbr) {
    const t = NFL_TEAM_COLORS[abbr];
    return t
      ? `<span class="team-badge tc" style="background:${t[0]};color:${t[1]}">${esc(abbr)}</span>`
      : `<span class="team-badge">${esc(abbr || '')}</span>`;
  }

  // Chrome that belongs to the MLB product. Hiding the sections was not enough:
  // the header carried an MLB track record over an NFL board, the tab title said
  // MLB, and two nav links pointed at sections that are now hidden, so they
  // scrolled nowhere.
  //
  // The CLV chip is the sharpest case. "BATTER UNDERS -28.1u · 55% · 1938 graded"
  // is a performance claim from a different sport; sitting it above a board that
  // grades nothing invites the reader to attach it to what they are looking at.
  // There is no NFL equivalent to swap in, because nothing NFL has been graded,
  // so it goes away rather than being replaced with a hollow version.
  const MLB_ONLY_NAV = ['#slate', '#record'];
  // The MLB title is captured from the document rather than duplicated here.
  // Written out by hand it drifted by one character -- a curly apostrophe against
  // the straight one in the markup -- so the tab quietly changed on the first
  // sport switch and never changed back.
  const DOC_TITLE = { mlb: document.title, nfl: 'Aimplified — NFL Board' };

  function applySportChrome(sport) {
    const nfl = sport === 'nfl';
    document.title = DOC_TITLE[sport] || DOC_TITLE.mlb;
    const chip = document.getElementById('clvChip');
    if (chip) chip.hidden = nfl;
    document.querySelectorAll('.nav-links a').forEach((a) => {
      const href = a.getAttribute('href');
      if (MLB_ONLY_NAV.includes(href)) a.hidden = nfl;
    });
    // The live-now link is an MLB feed too; it manages its own hidden flag, so
    // only force it off rather than on.
    const live = document.getElementById('navLive');
    if (live && nfl) live.hidden = true;
  }

})();
