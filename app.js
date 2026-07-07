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
      ml: { pick: 'LAD ML', teamAbbr: 'LAD', winProb: 71, price: -225, edge: 4.2, tier: 1, homeAbbr: 'LAD', awayAbbr: 'DET', homeWinProb: 71, awayWinProb: 29 } },
    { id: 'g2', matchup: 'NYY @ HOU', subline: 'Cole v. Valdez · 5:10 PT', time: 3, pick: 'Valdez U 5.5 Ks', odds: 102, edge: 3.4, interval: '3.1 – 6.2', tier: 2, weather: 'Roof closed · Neutral park', weatherTone: 'textDim',
      stats: [ { label: 'CSW%', value: 82, tone: 'warm' }, { label: 'Whiff%', value: 77, tone: 'warm' }, { label: 'Opp Chase', value: 61, tone: 'warm' } ],
      ml: { pick: 'HOU ML', teamAbbr: 'HOU', winProb: 64, price: -166, edge: 3.1, tier: 2, homeAbbr: 'HOU', awayAbbr: 'NYY', homeWinProb: 64, awayWinProb: 36 } },
    { id: 'g3', matchup: 'BOS @ TOR', subline: 'Bello v. Gausman · 4:07 PT', time: 2, pick: 'Bello U 4.5 Ks', odds: -120, edge: 4.6, interval: '2.8 – 5.5', tier: 1, weather: 'Roof closed · Neutral park', weatherTone: 'textDim',
      stats: [ { label: 'CSW%', value: 88, tone: 'hot' }, { label: 'Whiff%', value: 85, tone: 'hot' }, { label: 'Opp Chase', value: 70, tone: 'warm' } ],
      ml: { pick: 'TOR ML', teamAbbr: 'TOR', winProb: 55, price: -122, edge: 1.8, tier: 3, homeAbbr: 'TOR', awayAbbr: 'BOS', homeWinProb: 55, awayWinProb: 45 } },
    { id: 'g4', matchup: 'ATL @ PHI', subline: 'Wheeler v. Sale · 4:05 PT', time: 2, pick: 'Wheeler O 7.5 Ks', odds: -108, edge: 2.1, interval: '5.9 – 9.4', tier: 2, weather: 'In wind 9mph · Park −2% Ks', weatherTone: 'warm',
      stats: [ { label: 'CSW%', value: 79, tone: 'warm' }, { label: 'Whiff%', value: 73, tone: 'warm' }, { label: 'Opp Chase', value: 55, tone: 'cool' } ],
      ml: { pick: 'PHI ML', teamAbbr: 'PHI', winProb: 59, price: -135, edge: 2.4, tier: 3, homeAbbr: 'PHI', awayAbbr: 'ATL', homeWinProb: 59, awayWinProb: 41 } },
    { id: 'g5', matchup: 'MIL @ CHC', subline: 'Peralta v. Imanaga · 5:20 PT', time: 4, pick: 'Peralta O 6.5 Ks', odds: -102, edge: 1.2, interval: '4.6 – 8.2', tier: 3, weather: 'Wrigley crosswind · High variance', weatherTone: 'warm',
      stats: [ { label: 'CSW%', value: 68, tone: 'warm' }, { label: 'Whiff%', value: 64, tone: 'warm' }, { label: 'Opp Chase', value: 50, tone: 'cool' } ],
      ml: { pick: 'CHC ML', teamAbbr: 'CHC', winProb: 53, price: -110, edge: 0.9, tier: 'pass', homeAbbr: 'CHC', awayAbbr: 'MIL', homeWinProb: 53, awayWinProb: 47 } },
    { id: 'g6', matchup: 'SD @ SF', subline: 'Cease v. Webb · 6:45 PT', time: 5, pick: 'No edge — pass', odds: null, edge: -0.6, interval: '4.4 – 8.0', tier: 'pass', weather: 'Marine layer · Park −4% Ks', weatherTone: 'positive',
      stats: [ { label: 'CSW%', value: 61, tone: 'cool' }, { label: 'Whiff%', value: 58, tone: 'cool' }, { label: 'Opp Chase', value: 44, tone: 'cool' } ],
      ml: { pick: 'SF ML', teamAbbr: 'SF', winProb: 54, price: null, edge: -0.4, tier: 'pass', homeAbbr: 'SF', awayAbbr: 'SD', homeWinProb: 54, awayWinProb: 46 } },
  ];

  const TONE_COLOR = { hot: 'var(--danger)', warm: 'var(--warm)', cool: 'var(--positive)' };
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
  const activeTier = (g) => isML() ? (g.ml ? g.ml.tier : 'model') : g.tier;
  const activeEdge = (g) => isML() ? (g.ml ? g.ml.edge : null) : g.edge;
  // "Modeled" = the active board carries real market tiers, so tier filters +
  // edge sort are meaningful.
  const boardHasLive = () => isBatter() ? battersLive() : boardIsLive();
  const boardModeled = () => boardHasLive() && getGames().some((g) => typeof activeTier(g) === 'number');

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
    liveNowSection: document.getElementById('liveNow'),
    liveNowGrid: document.getElementById('liveNowGrid'),
    liveNowNote: document.getElementById('liveNowNote'),
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

  function renderInjuryAlerts() {
    // Real feed once loaded (even if empty); the sample banner only in the demo.
    const alerts = state.liveInjuries !== null ? state.liveInjuries : (LIVE_MODE ? [] : INJURY_ALERTS);
    el.injuryAlerts.innerHTML = alerts.map((a) => `
      <div class="alert">
        <span class="alert-dot"></span>
        <b>ALERT</b>
        <span class="alert-who">${esc(a.text)}</span>
        <span class="alert-time">${esc(a.time)}</span>
      </div>
    `).join('');
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
        renderInjuryAlerts();
      }
    } catch (e) {
      console.warn('Injuries refresh failed:', e.message);
    }
  }

  function getFilteredSortedGames() {
    // Only force time-sort on a live slate with no market tiers.
    const forceTime = boardIsLive() && !boardModeled();
    let games = getGames().filter((g) => state.filter === 'all' ? true : String(activeTier(g)) === state.filter);
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
      : ['', 'Matchup', 'Pick', 'Odds · DK/FD', 'Edge', '80% Interval', 'Tier', ''];
    el.boardHead.innerHTML = cols.map((c) => c ? `<span class="col-label">${c}</span>` : '<span></span>').join('');
  }

  // Honest empty-state copy for the board — distinguishes "still loading",
  // "genuinely no games tonight", and "filter/search hid everything".
  function emptyBoardMessage() {
    if (isFeedLoading()) return `Loading tonight’s ${isBatter() ? 'batter props' : 'slate'}…`;
    if (LIVE_MODE && !boardHasLive()) return `No ${isBatter() ? 'batter props' : 'games'} on tonight’s board yet.`;
    return state.searchQuery.trim() ? 'No games match your search.' : 'No games match this filter.';
  }

  function renderBoard() {
    renderBoardHead();
    const games = getFilteredSortedGames();
    el.noResults.hidden = games.length !== 0;
    if (!games.length) el.noResults.textContent = emptyBoardMessage();
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
        detailCell = `<span class="interval-cell" style="color:var(--accent)">${ml.winProb != null ? ml.winProb + '%' : '—'}</span>`;
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

      const rowHtml = `
        <div class="${rowClasses.join(' ')}" data-action="row-click" data-id="${g.id}" ${rowA11y}>
          ${leadingHtml}
          <div>
            <b>${esc(g.matchup)}</b>
            <span class="matchup-sub">${esc(g.subline)}</span>
            ${g.weather ? `<span class="weather-label" style="color:var(--${g.weatherTone || 'textDim'})">${esc(g.weather)}</span>` : ''}
          </div>
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
          detailHtml = `<div class="expanded-detail"><div class="expanded-title">Model win probability</div>
            <div style="display:flex;gap:24px;margin-top:6px;font-family:'IBM Plex Mono';font-size:14px">
              <span>${esc(g.ml.awayAbbr || '')} <b style="color:var(--accent)">${g.ml.awayWinProb != null ? g.ml.awayWinProb + '%' : '—'}</b></span>
              <span>${esc(g.ml.homeAbbr || '')} <b style="color:var(--accent)">${g.ml.homeWinProb != null ? g.ml.homeWinProb + '%' : '—'}</b></span>
              <span style="color:var(--textDim)">pick ${esc(g.ml.pick || '—')} (${esc(priceStr)}) · ${esc(edgeStr)}</span>
            </div>
            <div style="color:var(--textDim);font-size:12px;margin-top:12px">Team win% (log5) + home field + starting-pitcher ERA, priced vs. the vig-free moneyline.</div></div>`;
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
            const marketHtml = m
              ? `<span style="font-family:'IBM Plex Mono';font-size:12.5px;color:var(--text)">line ${m.line} · model ${m.modelOver}% over</span>
                 <span style="font-family:'IBM Plex Mono';font-size:12.5px;color:${m.edge >= 1.5 ? 'var(--positive)' : 'var(--textDim)'}">${m.side} ${m.line} · +${m.edge}% edge</span>
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
          detailHtml = `<div class="expanded-detail"><div class="expanded-title">Projected strikeouts — model vs. market</div>${rowsHtml}<div style="color:var(--textDim);font-size:12px;margin-top:12px">Projection: K/9 × expected innings × opponent K-rate × park × weather. Edge = model P(over) vs. the vig-free line.</div></div>`;
        } else {
          detailHtml = `<div class="expanded-detail"><div class="expanded-title">Model projection pending</div><div style="color:var(--textDim);font-size:13px">Live game from tonight's slate — probable pitcher not posted yet.</div></div>`;
        }
      }

      return rowHtml + detailHtml;
    }).join('');
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
        ? `<div><div class="stat-k">Win prob</div><div class="stat-v" style="color:var(--accent)">${ml.winProb != null ? ml.winProb + '%' : '—'}</div></div>`
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

    el.slip.innerHTML = `<div class="slip-legs">${legHtml}</div>${summaryHtml}`;

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
  function heroSide(p) {
    const handLabel = p.hand === 'L' ? 'LHP' : p.hand === 'R' ? 'RHP' : '';
    const meta = [p.team, handLabel, p.era ? p.era + ' ERA' : ''].filter(Boolean).join(' · ');
    const bars = [];
    if (typeof p.k9 === 'number' && p.k9 > 0) {
      const t = p.k9 >= 10 ? 'hot' : p.k9 >= 8 ? 'warm' : 'cool';   // elite / good / low
      bars.push(heroBar('K/9', p.k9.toFixed(1), (p.k9 - 5) / 8 * 100, t));
    }
    if (typeof p.oppKpct === 'number' && p.oppKpct > 0) {
      const t = p.oppKpct >= 23 ? 'hot' : p.oppKpct >= 20 ? 'warm' : 'cool'; // whiffy / avg / contact
      bars.push(heroBar('Opp K%', p.oppKpct, (p.oppKpct - 16) / 12 * 100, t));
    }
    if (p.market && p.market.modelOver != null) {
      const mo = p.market.modelOver;
      const t = mo >= 55 ? 'hot' : mo >= 45 ? 'warm' : 'cool';   // over lean / neutral / under lean
      bars.push(heroBar('Model O%', mo, mo, t));
    }
    const lineTxt = p.market ? ` · Line: O/U ${p.market.line}` : '';
    return `
      <div class="side">
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

    let pickStrip, winprob = '';
    if (lead) {
      const m = lead.market;
      const modelPct = m.side === 'Over' ? m.modelOver : Math.round((100 - m.modelOver) * 10) / 10;
      const kelly = kellyUnits(modelPct / 100, m.price);
      const kellyTxt = kelly > 0 ? ` · ${kelly}u Kelly` : '';
      const priceStr = m.price > 0 ? '+' + m.price : String(m.price);
      pickStrip = `
        <div class="pick-strip">
          <span class="stars">${esc(TIER_LABEL[m.tier] || '—')}</span>
          <span class="pick">${esc(lead.name)} <b>${m.side.toUpperCase()} ${m.line} Ks (${priceStr})</b></span>
          <span class="tier">Tier ${esc(String(m.tier))}${kellyTxt}</span>
          <span class="edge">+${m.edge}% edge vs. line</span>
        </div>`;
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
    } else {
      pickStrip = `<div class="pick-strip"><span class="pick">No strikeout prop posted yet — projection only</span></div>`;
    }

    el.heroDuel.innerHTML = heroSide(a) + heroSide(b) + pickStrip + winprob;
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
      return { id: legIdFor(g), board: 'ML', title: ml.pick || '—', sub: g.matchup, odds: typeof ml.price === 'number' ? ml.price : null, tier: ml.tier };
    }
    if (isBatter()) {
      // g.matchup is the batter name; g.subline is "EVENT · TIME".
      return { id: legIdFor(g), board: 'Batter', title: `${g.matchup} ${g.pick}`, sub: (g.subline || '').split(' · ')[0], odds: typeof g.odds === 'number' ? g.odds : null, tier: g.tier };
    }
    return { id: legIdFor(g), board: 'K Prop', title: g.pick, sub: g.matchup, odds: typeof g.odds === 'number' ? g.odds : null, tier: g.tier };
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
      case 'remove-leg': if (e) e.stopPropagation(); removeLeg(target.dataset.leg); break;
      case 'clear-slip': clearSlip(); break;
      case 'hitter-card-click': onHitterCardClick(Number(target.dataset.idx)); break;
      case 'pitcher-card-click': onPitcherCardClick(Number(target.dataset.idx)); break;
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
