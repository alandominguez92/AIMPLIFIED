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
  const TIER_LABEL = { 1: '★★★★☆', 2: '★★★☆☆', 3: '★★☆☆☆', pass: 'Pass' };

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

  const state = {
    theme: 'dark',
    filter: 'all',
    sortBy: 'edge',
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
    boardView: 'kprops', // 'kprops' | 'moneyline' | 'batter'
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
    : boardHasLive() && getGames().some((g) => typeof activeTier(g) === 'number');

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
    liveNowSection: document.getElementById('liveNow'),
    liveNowGrid: document.getElementById('liveNowGrid'),
    liveNowNote: document.getElementById('liveNowNote'),
    liveNowDots: document.getElementById('liveNowDots'),
    navLive: document.getElementById('navLive'),
    gameCount: document.getElementById('gameCount'),
    trackedPill: document.getElementById('trackedPill'),
    searchInput: document.getElementById('searchInput'),
    sortLabel: document.getElementById('sortLabel'),
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
    trkNote: document.getElementById('trkNote'),
    trkLabel1: document.getElementById('trkLabel1'),
    trkVal1: document.getElementById('trkVal1'),
    trkVal2: document.getElementById('trkVal2'),
    trkVal3: document.getElementById('trkVal3'),
    trkVal4: document.getElementById('trkVal4'),
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

  async function fetchJson(path) {
    const resp = await fetch(API_BASE + path, { headers: { accept: 'application/json' } });
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
      const rows = await fetchJson('/api/batters');
      if (!Array.isArray(rows)) return;
      const mapped = rows.map((b) => ({
        ...b,
        matchup: b.name,
        subline: `${b.matchup}${b.timeLabel ? ' · ' + b.timeLabel : ''}`,
        time: b.timeMs || 0,
      }));
      state.liveBatters = mapped;
      if (isBatter()) {
        const ids = new Set(mapped.map((g) => g.id));
        if (state.expandedId && !ids.has(state.expandedId)) state.expandedId = null;
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
      if (g.rl && typeof g.rl.tier === 'number' && g.rl.modelAgrees) return { id: g.id, view: 'runline', pick: g.rl.pick };
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
    // Only force time-sort on a live slate with no market tiers.
    const forceTime = boardIsLive() && !boardModeled();
    let games = getGames().filter((g) => {
      // Run Line only has content once a run line is posted — omit games without
      // one (they'd render as blank cards). "All" then shows every posted run
      // line, each card self-labeled pick / value / no-play; the tier and Pass
      // tabs narrow from there. Other views are unaffected.
      if (isRL() && g.rl == null) return false;
      if (state.filter === 'all') return true;
      return String(activeTier(g)) === state.filter;
    });
    const q = state.searchQuery.trim().toLowerCase();
    if (q) {
      games = games.filter((g) => g.matchup.toLowerCase().includes(q) || (g.subline || '').toLowerCase().includes(q));
    }
    const byTime = (a, b) => a.time - b.time;
    const byEdge = (a, b) => (activeEdge(b) ?? -Infinity) - (activeEdge(a) ?? -Infinity);
    games = [...games].sort(forceTime || state.sortBy !== 'edge' ? byTime : byEdge);
    return games;
  }

  function renderControls() {
    const live = boardHasLive();
    const modeled = boardModeled();
    const noun = isBatter() ? 'batters' : 'games';
    el.gameCount.textContent = !live
      ? (LIVE_MODE ? (isFeedLoading() ? 'loading tonight’s slate…' : 'no games posted yet') : `${RAW_GAMES.length} games · odds refresh :30`)
      : (modeled ? `${getGames().length} ${noun} · model vs. live lines` : `${getGames().length} ${noun} · tonight's slate · live`);
    const trackedCount = Object.keys(state.slip).length;
    el.trackedPill.textContent = `${trackedCount} tracked`;
    el.sortLabel.textContent = state.sortBy === 'edge' ? 'Edge' : 'Time';

    document.querySelectorAll('.viewtab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.view === state.boardView);
    });

    // Hide tier/edge controls only on a live slate with no market tiers.
    const hideModelControls = live && !modeled;
    document.querySelectorAll('.filter-btn').forEach((btn) => {
      const isTierBtn = btn.dataset.filter !== 'all';
      btn.style.display = hideModelControls && isTierBtn ? 'none' : '';
      btn.classList.toggle('active', btn.dataset.filter === state.filter);
    });
    const sortBtn = document.querySelector('[data-action="toggle-sort"]');
    if (sortBtn) sortBtn.style.display = hideModelControls ? 'none' : '';

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
    return `<span class="odds-books">${rows}</span>`;
  }

  function renderBoardHead() {
    const cols = isML()
      ? ['', 'Matchup', 'Team to win', 'Moneyline', 'Edge', 'Win Prob', 'Tier', '']
      : ['', 'Matchup', 'Pick', 'Price · DK/FD', 'Edge', '80% Interval', 'Tier', ''];
    el.boardHead.innerHTML = cols.map((c) => c ? `<span class="col-label">${c}</span>` : '<span></span>').join('');
  }

  // Honest empty-state copy for the board — distinguishes "still loading",
  // "genuinely no games tonight", and "filter/search hid everything".
  function emptyBoardMessage() {
    if (isFeedLoading()) return `Loading tonight’s ${isBatter() ? 'batter props' : 'slate'}…`;
    if (LIVE_MODE && !boardHasLive()) return `No ${isBatter() ? 'batter props' : 'games'} on tonight’s board yet.`;
    if (state.searchQuery.trim()) return 'No games match your search.';
    // Run Line depends on sportsbooks posting spreads — often later than K props.
    if (isRL() && state.filter === 'all') return 'No run lines posted yet — spreads usually go up closer to first pitch. Check back soon.';
    return 'No games match this filter.';
  }

  // Sticky "tonight at a glance" bar under the header: plays (Tier 1–2),
  // best edge, watching (model likes it, no line yet), slate size. Computed
  // from the K-props base rows — the flagship market — and only in live mode.
  function renderSlateSummary() {
    if (!el.slateSummary) return;
    const rows = boardIsLive() ? state.liveBoard : (LIVE_MODE ? null : RAW_GAMES);
    if (!rows || !rows.length) { el.slateSummary.hidden = true; return; }
    const t = (g) => String(g.tier);
    // A play needs both a real tier and a real price; tiered rows with no
    // line yet are "watching", never counted as plays.
    const plays = rows.filter((g) => (t(g) === '1' || t(g) === '2') && g.odds != null);
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

  function renderBoard() {
    const games = getFilteredSortedGames();
    renderSlateSummary();
    el.noResults.hidden = games.length !== 0;
    if (!games.length) el.noResults.textContent = emptyBoardMessage();

    // Run Line renders as game cards, not table rows — hide the table head and
    // the panel border so the cards stand free, then bail before the row map.
    const boardWrap = document.getElementById('boardWrap');
    if (isRL()) {
      if (el.boardHead) el.boardHead.style.display = 'none';
      if (boardWrap) { boardWrap.style.border = 'none'; boardWrap.style.background = 'none'; }
      if (el.pinNote) el.pinNote.hidden = true;
      el.boardRows.innerHTML = renderRunlineCards(games);
      return;
    }
    if (el.boardHead) el.boardHead.style.display = '';
    if (boardWrap) { boardWrap.style.border = ''; boardWrap.style.background = ''; }
    renderBoardHead();
    if (el.pinNote) el.pinNote.hidden = !getGames().some((g) => Array.isArray(g.oddsBooks) && g.oddsBooks.length);

    el.boardRows.innerHTML = games.map((g) => {
      const ml = g.ml || {};
      const isTracked = !!state.slip[legIdFor(g)];
      const isSelected = state.compareIds.includes(g.id);
      const isExpanded = state.expandedId === g.id;

      const edgeVal = activeEdge(g);
      const hasEdge = edgeVal != null;
      const edgeColor = !hasEdge ? 'var(--textDim)' : (edgeVal > 0 ? 'var(--positive)' : 'var(--danger)');
      const edgeLabel = !hasEdge ? '—' : (edgeVal > 0 ? '+' : '') + edgeVal.toFixed(1) + '%';
      const tierVal = activeTier(g);
      const tierLabel = TIER_LABEL[tierVal] || '—';
      const tierIsPlain = !TIER_LABEL[tierVal] || tierVal === 'pass';

      // The four view-specific cells (pick, odds, [edge — shared], detail).
      const money = (v) => v == null ? '—' : (v > 0 ? '+' + v : String(v));
      let pickCell, oddsCell, detailCell;
      if (isML()) {
        pickCell = esc(ml.pick || '—');
        oddsCell = `<span class="odds-cell mono">${esc(money(ml.price))}</span>`;
        detailCell = `<span class="interval-cell" style="color:var(--model)">${ml.winProb != null ? ml.winProb + '%' : '—'}</span>`;
      } else {
        pickCell = esc(g.pick);
        oddsCell = oddsBooksCell(g, money);
        detailCell = `<span class="interval-cell">${esc(g.interval)}</span>`;
      }

      const leadingHtml = state.compareMode
        ? `<span class="leading checkbox${isSelected ? ' selected' : ''}" data-action="leading-click" data-id="${g.id}" role="checkbox" tabindex="0" aria-checked="${isSelected}" aria-label="Select ${esc(g.matchup)} to compare" title="Select to compare">${isSelected ? '✓' : ''}</span>`
        : `<span class="leading${isTracked ? ' tracked' : ''}" data-action="leading-click" data-id="${g.id}" role="button" tabindex="0" aria-pressed="${isTracked}" aria-label="Track ${esc(g.matchup)}" title="Track this pick">${isTracked ? '★' : '☆'}</span>`;

      const rowClasses = ['board-row'];
      if (isSelected) rowClasses.push('selected');
      else if (isExpanded) rowClasses.push('expanded');

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
        matchupCell = `<div>
            <div class="mp-duel">${duel}</div>
            <span class="matchup-sub">${esc(sub)}</span>
            ${weatherHtml}
          </div>`;
      } else {
        matchupCell = `<div>
            <b>${esc(g.matchup)}</b>
            <span class="matchup-sub">${esc(g.subline)}</span>
            ${weatherHtml}
          </div>`;
      }

      const rowHtml = `
        <div class="${rowClasses.join(' ')}" data-action="row-click" data-id="${g.id}" ${rowA11y}>
          ${leadingHtml}
          ${matchupCell}
          <span>${pickCell}</span>
          ${oddsCell}
          <span class="edge-cell" style="color:${edgeColor}">${esc(edgeLabel)}</span>
          ${detailCell}
          <span class="tier-cell${tierIsPlain ? ' pass' : ''}" style="${tierIsPlain ? '' : 'color:var(--accent)'}">${esc(tierLabel)}</span>
          <span class="chevron">${isExpanded ? '▲' : '▼'}</span>
        </div>
      `;

      let detailHtml = '';
      if (isExpanded && isBatter()) {
        const bm = (g.batterMarkets || []).map((m) => {
          if (m.none) return `<div class="bm-row"><span class="bm-label">${esc(m.label)}</span><span class="bm-none">no line · proj ${esc(String(m.proj))}</span></div>`;
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
        const statsHtml = (g.stats || []).map((s) => `
          <div class="stat-row">
            <span class="stat-label">${esc(s.label)}</span>
            <div class="track"><div class="fill" style="width:${s.value}%;background:${TONE_COLOR[s.tone]}"></div></div>
            <span class="badge" style="background:${TONE_COLOR[s.tone]}">${s.value}</span>
          </div>`).join('');
        detailHtml = `<div class="expanded-detail">
          <div class="expanded-title">Batter props — model vs. market</div>${bm}
          <div class="expanded-title" style="margin-top:16px">Season percentiles (vs. priced pool)</div>${statsHtml}
          <div style="color:var(--textDim);font-size:12px;margin-top:12px">Projection: season rate × expected PAs, priced Poisson, then regressed toward the market while the batter model builds a track record — so edges stay conservative until results justify more.</div>
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
          detailHtml = `<div class="expanded-detail">
            <div class="expanded-title">Starting pitchers — model matchup</div>
            ${duelHtml}
            <div class="ml-pickline">pick ${esc(g.ml.pick || '—')} <span style="color:var(--text)">(${esc(priceStr)})</span> · ${esc(edgeStr)}</div>
            <div style="color:var(--textDim);font-size:12px;margin-top:12px">${fairNote} Bars score each starter's projected Ks, season K/9, and ERA (lower is better).</div></div>`;
        } else {
          detailHtml = `<div class="expanded-detail"><div class="expanded-title">Moneyline pending</div><div style="color:var(--textDim);font-size:13px">No moneyline posted for this game yet.</div></div>`;
        }
      } else if (isExpanded) {
        if (g.stats && g.stats.length) {
          const statsHtml = g.stats.map((s) => `
            <div class="stat-row">
              <span class="stat-label">${esc(s.label)}</span>
              <div class="track"><div class="fill" style="width:${s.value}%;background:${TONE_COLOR[s.tone]}"></div></div>
              <span class="badge" style="background:${TONE_COLOR[s.tone]}">${s.value}</span>
            </div>
          `).join('');
          detailHtml = `<div class="expanded-detail"><div class="expanded-title">Percentile breakdown</div>${statsHtml}</div>`;
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
              <span style="font-family:'Barlow Condensed';font-weight:600;font-size:16px;text-transform:uppercase;min-width:120px">${esc(p.name)}</span>
              <span style="font-family:'IBM Plex Mono';font-size:14px;color:var(--accent);font-weight:600">${p.proj} K</span>
              <span style="font-family:'IBM Plex Mono';font-size:12.5px;color:var(--textDim)">80% ${p.lo} – ${p.hi}</span>
              <span style="font-family:'IBM Plex Mono';font-size:12px;color:var(--textDim)">opp K ${p.oppKpct}%</span>
              ${parkWxHtml(p)}
              ${marketHtml}
            </div>`;
          }).join('');
          detailHtml = `<div class="expanded-detail"><div class="expanded-title">Projected strikeouts — model vs. market</div>${rowsHtml}<div style="color:var(--textDim);font-size:12px;margin-top:12px">Projection: K/9 × expected innings × opponent K-rate × park × weather. Edge = model P(over) vs. the <b>fair line</b> — the median de-vigged P(over) across DK, FD &amp; MGM. MGM is a sharpness reference only; you still bet the best of DK/FD.</div></div>`;
        } else {
          detailHtml = `<div class="expanded-detail"><div class="expanded-title">Model projection pending</div><div style="color:var(--textDim);font-size:13px">Live game from tonight's slate — probable pitcher not posted yet.</div></div>`;
        }
      }

      return rowHtml + detailHtml;
    }).join('');
  }

  // Run Line view — game cards. The value side (DK/FD price beats Pinnacle's
  // de-vigged run line) is the Pick, and it only lights up when the win% model
  // agrees the game breaks that way; otherwise the card sits under the Pass tab.
  // Styles are injected once so style.css stays untouched.
  function ensureRlStyle() {
    if (document.getElementById('rl-style')) return;
    const s = document.createElement('style');
    s.id = 'rl-style';
    s.textContent = `
      .rl-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;}
      @media(max-width:680px){.rl-grid{grid-template-columns:1fr;}}
      .rl-card{border:1px solid var(--border);border-radius:12px;background:var(--board3,#0C1A26);padding:16px 17px;}
      .rl-top{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:3px;}
      .rl-match{font-family:'Barlow Condensed','Arial Narrow',sans-serif;font-weight:700;font-size:17px;letter-spacing:.01em;}
      .rl-edge{font-family:ui-monospace,monospace;font-size:12px;color:var(--positive);}
      .rl-edge.pass{color:var(--textDim);}
      .rl-status{font-family:ui-monospace,monospace;font-size:11px;color:var(--textDim);margin-bottom:13px;}
      .rl-live{color:var(--danger);}
      .rl-sides{display:grid;grid-template-columns:1fr 1fr;gap:10px;}
      .rl-side{border:1px solid var(--border);border-radius:9px;padding:11px 13px;background:var(--board,#10202F);position:relative;}
      .rl-lbl{font-family:'Barlow Condensed','Arial Narrow',sans-serif;font-weight:700;font-size:15px;}
      .rl-prc{font-family:ui-monospace,monospace;font-size:13px;color:var(--textDim);margin-top:2px;}
      .rl-cov{font-family:ui-monospace,monospace;font-size:11px;color:var(--textDim);margin-top:5px;}
      .rl-side.pick{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 12%,var(--board,#10202F));}
      .rl-side.pick .rl-lbl{color:var(--accent);}
      .rl-side.pick .rl-prc{color:var(--text);}
      .rl-tag{position:absolute;top:-8px;right:10px;font-family:ui-monospace,monospace;font-size:9px;letter-spacing:.06em;text-transform:uppercase;background:var(--accent);color:#10202F;border-radius:99px;padding:1px 7px;font-weight:700;}
      .rl-lean{display:flex;align-items:center;gap:7px;margin-top:12px;font-family:ui-monospace,monospace;font-size:11.5px;flex-wrap:wrap;}
      .rl-ok{color:var(--positive);}
      .rl-no{color:var(--danger);}
      .rl-dim{color:var(--textDim);}
      .rl-dim b{color:var(--text);}
      .rl-nolabel{color:var(--danger)!important;}
      .rl-stars{margin-left:auto;color:var(--accent);letter-spacing:1px;font-size:11px;white-space:nowrap;}
      .rl-stars.pass{color:var(--textDim);letter-spacing:0;}`;
    document.head.appendChild(s);
  }

  function renderRunlineCards(games) {
    ensureRlStyle();
    const money = (v) => v == null ? '—' : (v > 0 ? '+' + v : String(v));
    return `<div class="rl-grid">${games.map((g) => {
      const rl = g.rl || {};
      const isPickCard = typeof rl.tier === 'number' && rl.modelAgrees;

      // Two sides, favorite (−1.5) first.
      const sideObj = (abbr, point, price, cover) => ({ abbr, point, price, cover, pick: isPickCard && abbr === rl.teamAbbr });
      const sides = [
        sideObj(rl.homeAbbr, rl.homePoint, rl.homePrice, rl.homeCoverPct),
        sideObj(rl.awayAbbr, rl.awayPoint, rl.awayPrice, rl.awayCoverPct),
      ].sort((a, b) => (a.point ?? 0) - (b.point ?? 0));
      const sideBox = (s) => {
        const ptStr = s.point == null ? '' : (s.point > 0 ? '+' : '') + s.point;
        const cov = s.cover == null ? '' : `fair ${s.cover}%${s.pick ? ' ✓' : ''}`;
        return `<div class="rl-side${s.pick ? ' pick' : ''}">${s.pick ? '<span class="rl-tag">Pick</span>' : ''}
          <div class="rl-lbl">${esc(s.abbr || '—')} ${esc(ptStr)}</div>
          <div class="rl-prc">${esc(money(s.price))}</div>
          <div class="rl-cov">${esc(cov)}</div></div>`;
      };

      // Status / score line (matchup is "AWAY @ HOME", score is "away-home").
      const parts = (g.matchup || ' @ ').split(' @ ');
      const awayT = parts[0] || '', homeT = parts[1] || '';
      let statusLine;
      if ((g.status === 'Live' || g.status === 'Final') && g.score && g.score.includes('-')) {
        const sc = g.score.split('-');
        const tag = g.status === 'Live' ? '<span class="rl-live">● Live</span>' : 'Final';
        statusLine = `${tag} · ${esc(awayT)} ${esc(sc[0])} – ${esc(homeT)} ${esc(sc[1])}`;
      } else {
        statusLine = `${esc(g.timeLabel || 'TBD')} · scheduled`;
      }

      let badge = '';
      if (isPickCard && rl.edge != null) badge = `<span class="rl-edge">+${rl.edge}% edge</span>`;
      else if (rl.edge != null && rl.edge > 0) badge = `<span class="rl-edge pass">+${rl.edge}% value</span>`;

      // Model-lean line — the filter, shown explicitly.
      const pickModelWin = (rl.teamAbbr && rl.teamAbbr === rl.modelFavAbbr)
        ? rl.modelFavPct : (rl.modelFavPct != null ? 100 - rl.modelFavPct : null);
      let lean, stars;
      if (isPickCard) {
        const backs = rl.side === 'fav' ? 'backs the −1.5' : 'backs the +1.5';
        const verb = rl.side === 'fav'
          ? `likes <b>${esc(rl.teamAbbr)}</b> to win (${pickModelWin}%)`
          : `gives <b>${esc(rl.teamAbbr)}</b> a live ${pickModelWin}%`;
        lean = `<span class="rl-ok">✓</span> <span class="rl-dim">model ${verb} — ${backs}</span>`;
        stars = `<span class="rl-stars">${esc(TIER_LABEL[rl.tier] || '')}</span>`;
      } else if (rl.edge != null && rl.edge > 0) {
        const ptStr = rl.point != null ? (rl.point > 0 ? '+' : '') + rl.point : '';
        lean = `<span class="rl-no">✕</span> <span class="rl-dim">value on <b>${esc(rl.teamAbbr || '')} ${esc(ptStr)}</b>, model has it ${pickModelWin}% — <b class="rl-nolabel">no play</b></span>`;
        stars = `<span class="rl-stars pass">pass</span>`;
      } else if (rl.fairSource !== 'pinnacle') {
        lean = `<span class="rl-dim">no sharp run line posted yet</span>`;
        stars = `<span class="rl-stars pass">—</span>`;
      } else {
        lean = `<span class="rl-dim">no value vs Pinnacle's fair</span>`;
        stars = `<span class="rl-stars pass">pass</span>`;
      }

      return `<div class="rl-card">
        <div class="rl-top"><span class="rl-match">${esc(g.matchup || '—')}</span>${badge}</div>
        <div class="rl-status">${statusLine}</div>
        <div class="rl-sides">${sides.map(sideBox).join('')}</div>
        <div class="rl-lean">${lean}${stars}</div></div>`;
    }).join('')}</div>`;
  }

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
        : `<div><div class="stat-k">Tier</div><div class="stat-v tier">${esc(TIER_LABEL[tierVal] || '—')}</div></div>`;
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
    if (!buckets.length) {
      el.calibrationPoints.innerHTML = LIVE_MODE ? '<div class="calibration-empty">Calibration plots here as tonight’s picks grade.</div>' : '';
      return;
    }
    el.calibrationPoints.innerHTML = buckets.map((b) => `
      <div class="calibration-dot" style="left:calc(${b.predicted}% - 6px);bottom:calc(${b.actual}% - 6px)" title="Predicted ${b.predicted}% · Actual ${b.actual}% (n=${b.n})"></div>
    `).join('');
  }

  function renderRecord() {
    const tr = state.trackRecord;
    if (!tr) return;
    if (!tr.empty) {
      // Real graded results are in — swap the tiles to live numbers.
      el.trkLabel1.textContent = 'Win Rate';
      el.trkVal1.textContent = (tr.winRate != null ? tr.winRate : 0) + '%';
      el.trkVal2.textContent = String(tr.tracked);
      el.trkVal3.textContent = tr.tier1;
      el.trkVal4.textContent = (tr.units > 0 ? '+' : '') + tr.units + 'u';
      el.trkNote.textContent = `${tr.tracked} graded picks · updated as games finalize`;
    } else {
      // No graded results yet — never show placeholder numbers as if they were real.
      el.trkLabel1.textContent = 'Win Rate';
      el.trkVal1.textContent = '—';
      el.trkVal2.textContent = tr.logged > 0 ? String(tr.logged) : '—';
      el.trkVal3.textContent = '—';
      el.trkVal4.textContent = '—';
      el.trkNote.textContent = tr.logged > 0
        ? `${tr.logged} picks logged · grading as tonight's games finalize`
        : 'Tracking begins with tonight’s slate · wins and losses both stay up';
    }
    renderClvChip();
  }

  // Header chip: real season numbers from the track record, or an honest
  // "tracking" state. Never the old hardcoded "CLV +2.4% · 312 bets".
  function renderClvChip() {
    if (!el.clvChipText) return;
    if (!LIVE_MODE) { el.clvChipText.textContent = 'Model preview'; return; }
    const tr = state.trackRecord;
    if (tr && tr.clvN > 0 && tr.clv != null) {
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

  // ROI, cumulative-units chart, per-tier / per-side breakdowns, projection MAE.
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
    const stats = [
      { k: 'CLV vs close', v: clvTxt, tone: tr.clv == null ? '' : (tr.clv >= 0 ? 'g' : 'r') },
      { k: 'ROI', v: roiTxt, tone: tr.roi == null ? '' : (tr.roi >= 0 ? 'g' : 'r') },
      { k: 'Units (flat)', v: uTxt, tone: tr.units == null ? '' : (tr.units >= 0 ? 'g' : 'r') },
      { k: 'Proj. error (MAE)', v: tr.mae == null ? '—' : '±' + tr.mae + ' K', tone: '' },
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
  // Honest hero placeholder for live mode when there's no duel to show.
  function renderHeroPlaceholder(hasGames) {
    const loading = state.liveBoard === null;
    el.heroEyebrow.textContent = loading ? 'Loading tonight’s slate…' : (hasGames ? 'Tonight’s slate' : 'No games scheduled');
    el.heroTitle.innerHTML = loading || hasGames ? 'Tonight’s Slate' : 'No Games Tonight';
    el.heroDuel.innerHTML = `<div class="hero-empty">${
      loading ? 'Pulling tonight’s probable pitchers, lines, and model projections…'
        : hasGames ? 'Model projections are on the board below — no marquee two-ace duel posted for tonight.'
          : 'No MLB games are posted right now. The board fills in on game days.'
    }</div>`;
  }

  function renderHero() {
    if (!LIVE_MODE) return; // offline demo keeps the static sample hero
    if (!boardIsLive()) { renderHeroPlaceholder(false); return; }
    const hasDuo = (g) => g.projRows && g.projRows.length === 2 && g.projRows.every((p) => typeof p.proj === 'number');
    const preview = state.liveBoard.filter((g) => g.status === 'Preview' && hasDuo(g));
    const pool = preview.length ? preview : state.liveBoard.filter(hasDuo);
    if (!pool.length) { renderHeroPlaceholder(true); return; }
    const combined = (g) => g.projRows.reduce((s, p) => s + p.proj, 0);
    const feature = pool.reduce((m, g) => (!m || combined(g) > combined(m) ? g : m), null);
    const [a, b] = feature.projRows;

    el.heroEyebrow.textContent = `Tonight's Ace Duel · ${heroDateLabel(feature.time)} · ${feature.timeLabel || ''}`.replace(/ · $/, '');
    el.heroTitle.innerHTML = `${esc(lastName(a.fullName || a.name))} <span class="vs">vs</span> ${esc(lastName(b.fullName || b.name))}`;

    const priced = feature.projRows.filter((p) => p.market && p.market.price != null);
    const lead = priced.length ? priced.reduce((m, p) => (!m || p.market.edge > m.market.edge ? p : m), null) : null;
    // Only assert a bet when the marquee duel actually contains a play — a real
    // tier and a positive edge. A great matchup with no edge says so honestly.
    const isPlay = !!(lead && lead.market.edge > 0 && ['1', '2', '3'].includes(String(lead.market.tier)));

    const impliedPct = (price) => {
      const p = Number(price);
      if (!isFinite(p) || p === 0) return null;
      return Math.round((p > 0 ? 100 / (p + 100) : -p / (-p + 100)) * 100);
    };

    let pickStrip, whyLine = '', winprob = '';
    if (isPlay) {
      const m = lead.market;
      const modelPct = m.side === 'Over' ? m.modelOver : Math.round((100 - m.modelOver) * 10) / 10;
      const kelly = kellyUnits(modelPct / 100, m.price);
      const kellyTxt = kelly > 0 ? ` · ${kelly}u Kelly` : '';
      const priceStr = m.price > 0 ? '+' + m.price : String(m.price);
      pickStrip = `
        <div class="pick-strip has-play">
          <span class="stars">${esc(TIER_LABEL[m.tier] || '—')}</span>
          <span class="pick">${esc(lead.name)} <b>${m.side.toUpperCase()} ${m.line} Ks</b> <span class="pick-odds">(${priceStr})</span></span>
          <span class="tier">Tier ${esc(String(m.tier))}${kellyTxt}</span>
          <span class="edge">+${m.edge}% edge</span>
          <button class="hero-add" data-action="hero-add" data-id="${esc(feature.id)}">★ Add to slip</button>
        </div>`;
      // Honest WHY: model's clear chance vs. the price's implied chance = the gap.
      const imp = impliedPct(m.price);
      const verb = m.side === 'Over' ? 'clear' : 'stay under';
      const oppTxt = (typeof lead.oppKpct === 'number') ? ` — against a lineup striking out ${lead.oppKpct}% of the time` : '';
      whyLine = `<div class="hero-why"><span class="wk">Why</span><span>The model gives ${esc(lead.name)} a <b>${modelPct}% chance to ${verb} ${m.line} Ks</b>${imp != null ? `; the ${priceStr} price implies just <b>${imp}%</b>` : ''}. That gap${oppTxt} is the edge.</span></div>`;
      winprob = `
        <div class="winprob">
          <div class="winprob-head"><span class="live-dot"></span><span class="winprob-label">Model win probability</span></div>
          <div class="winprob-row">
            <span class="winprob-team">${esc(lead.name)} ${m.side === 'Over' ? 'O' : 'U'} ${m.line}</span>
            <div class="track big"><div class="fill accent-fill" style="width:${modelPct}%"></div></div>
            <span class="winprob-pct">${modelPct}%</span>
          </div>
        </div>`;
      renderWhyCard(lead, m, modelPct);
    } else if (lead) {
      // Priced, but no edge — the model agrees with the market here. Say so.
      const m = lead.market;
      const modelPct = m.side === 'Over' ? m.modelOver : Math.round((100 - m.modelOver) * 10) / 10;
      const imp = impliedPct(m.price);
      pickStrip = `
        <div class="pick-strip nopl">
          <span class="nopl-dot"></span>
          <span class="pick">No edge in this duel — the model and the market <b>agree here</b>. A great watch, not a bet.</span>
          <span class="nopl-go">Tonight's plays are on the board below ↓</span>
        </div>`;
      whyLine = `<div class="hero-why pass"><span class="wk">Why</span><span>The model lands close to the line and the price already reflects it — model <b>${modelPct}%</b>${imp != null ? ` vs. implied <b>${imp}%</b>` : ''}. No gap, no play. We only post edges.</span></div>`;
    } else {
      pickStrip = `<div class="pick-strip nopl"><span class="nopl-dot"></span><span class="pick">No strikeout props posted for this duel yet — projection only. Priced plays land on the board below when lines post.</span></div>`;
    }

    el.heroDuel.innerHTML = heroSide(a, isPlay && lead === a) + heroSide(b, isPlay && lead === b) + pickStrip + whyLine + winprob;
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
    renderControls();
    renderBoard();
    renderComparePanel();
  }

  function toggleSort() {
    state.sortBy = state.sortBy === 'edge' ? 'time' : 'edge';
    renderControls();
    renderBoard();
  }

  function toggleExpand(id) {
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
  function addHeroToSlip(id) {
    const g = (state.liveBoard || []).find((x) => x.id === id);
    if (!g) return;
    const leg = buildKPropLeg(g);
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
      case 'toggle-sort': toggleSort(); break;
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

  // Keyboard: activate any focusable [data-action] control with Enter/Space.
  document.body.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
    const target = e.target.closest('[data-action]');
    if (!target || !target.hasAttribute('tabindex')) return;
    e.preventDefault(); // stop Space from scrolling the page
    dispatchAction(target, e);
  });

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
    // Batter props are a second per-event props call — only poll while that tab
    // is open, to protect the Odds API quota.
    setInterval(() => { if (isBatter()) refreshBatters(); }, 300000);
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
})();
