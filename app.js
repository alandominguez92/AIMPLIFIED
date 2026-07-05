(function () {
  'use strict';

  // ---------------------------------------------------------------------
  // DATA LAYER — mock data shaped like the real feeds it stands in for.
  // To go live, replace RAW_GAMES / HOT_HITTERS / HOT_PITCHERS /
  // INJURY_ALERTS / CALIBRATION_BUCKETS / tickerScores with fetches to:
  //   - MLB StatsAPI (schedule, live scores, lineups/injuries)
  //   - Baseball Savant (Statcast: CSW%, whiff%, chase%, xERA)
  //   - An odds provider (The Odds API, Pinnacle, etc.) for live lines
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
    trackRecord: null,
    liveInjuries: null,
    boardView: 'kprops', // 'kprops' | 'moneyline'
    quotaRemaining: null,
  };

  // Real data when the feed has loaded, otherwise the built-in sample.
  const getHitters = () => (state.liveHitters && state.liveHitters.length ? state.liveHitters : HOT_HITTERS);
  const getPitchers = () => (state.livePitchers && state.livePitchers.length ? state.livePitchers : HOT_PITCHERS);
  const boardIsLive = () => !!(state.liveBoard && state.liveBoard.length);
  const getGames = () => (boardIsLive() ? state.liveBoard : RAW_GAMES);
  const isML = () => state.boardView === 'moneyline';
  // A game's tier/edge for the active view (K props vs moneyline).
  const activeTier = (g) => isML() ? (g.ml ? g.ml.tier : 'model') : g.tier;
  const activeEdge = (g) => isML() ? (g.ml ? g.ml.edge : null) : g.edge;
  // "Modeled" = the board carries real market tiers, so tier filters + edge
  // sort are meaningful. (Moneyline is always live-modeled when the board is.)
  const boardModeled = () => boardIsLive() && state.liveBoard.some((g) => typeof activeTier(g) === 'number');

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
    const savedTracked = JSON.parse(localStorage.getItem('aimplified_tracked') || '{}');
    state.tracked = savedTracked;
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
    pinNote: document.getElementById('pinNote'),
    roiCard: document.getElementById('roiCard'),
    roiStats: document.getElementById('roiStats'),
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
    // Prefer live feed from the Odds API proxy; fall back to mock ticker.
    const items = state.liveTicker && state.liveTicker.length
      ? state.liveTicker
      : RAW_GAMES.map((g) => ({
          matchup: g.matchup,
          score: state.tickerScores[g.id] || '0-0',
          oddsLabel: g.tier === 'pass' ? 'PASS' : americanOdds(g.odds),
        }));
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
    // Real feed once loaded (even if empty); the sample banner until then.
    const alerts = state.liveInjuries !== null ? state.liveInjuries : INJURY_ALERTS;
    el.injuryAlerts.innerHTML = alerts.map((a) => `
      <div class="alert">
        <span class="alert-dot"></span>
        <b>ALERT</b>
        <span>${esc(a.text)}</span>
        <span class="alert-time">${esc(a.time)}</span>
      </div>
    `).join('');
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
    const live = boardIsLive();
    const modeled = boardModeled();
    el.gameCount.textContent = !live
      ? `${RAW_GAMES.length} games · odds refresh :30`
      : (modeled ? `${getGames().length} games · model vs. live lines` : `${getGames().length} games · tonight's slate · live`);
    const trackedCount = Object.values(state.tracked).filter(Boolean).length;
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

  function renderBoard() {
    renderBoardHead();
    const games = getFilteredSortedGames();
    el.noResults.hidden = games.length !== 0;
    if (el.pinNote) el.pinNote.hidden = !getGames().some((g) => Array.isArray(g.oddsBooks) && g.oddsBooks.length);

    el.boardRows.innerHTML = games.map((g) => {
      const ml = g.ml || {};
      const isTracked = !!state.tracked[g.id];
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
            <span class="weather-label" style="color:var(--${g.weatherTone})">${esc(g.weather)}</span>
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
      if (isExpanded && isML()) {
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
          </div>
          <div class="name">${esc(h.name)}</div>
          <div class="team">${esc(h.team)}</div>
          <div class="stat-num">${esc(statVal)}</div>
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
          </div>
          <div class="name">${esc(p.name)}</div>
          <div class="team">${esc(p.team)}</div>
          <div class="stat-num">${esc(statVal)}</div>
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
    const buckets = (tr && tr.calibration && tr.calibration.length) ? tr.calibration : CALIBRATION_BUCKETS;
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
    } else if (tr.logged > 0) {
      // Picks logged but none graded yet — say so, keep the placeholder tiles.
      el.trkNote.textContent = `${tr.logged} picks logged · grading as tonight's games finalize`;
    }
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
    const stats = [
      { k: 'ROI', v: roiTxt, tone: tr.roi == null ? '' : (tr.roi >= 0 ? 'g' : 'r') },
      { k: 'Units (flat)', v: uTxt, tone: tr.units == null ? '' : (tr.units >= 0 ? 'g' : 'r') },
      { k: 'Proj. error (MAE)', v: tr.mae == null ? '—' : '±' + tr.mae + ' K', tone: '' },
      { k: 'Graded plays', v: String(tr.tracked), tone: '' },
    ];
    el.roiStats.innerHTML = stats.map((s) => `
      <div class="roi-stat"><div class="roi-stat-k">${s.k}</div><div class="roi-stat-v ${s.tone}">${esc(s.v)}</div></div>`).join('');

    renderRoiChart(tr.cumulative || []);

    const tierRows = (tr.tierBreakdown || []).map((t) => ({ label: 'Tier ' + t.tier, r: t.record, u: t.units, roi: t.roi }));
    const sideRows = (tr.sideBreakdown || []).map((s) => ({ label: s.side, r: s.record, u: s.units, roi: s.roi }));
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
    el.roiTables.innerHTML = tbl('By tier', tierRows) + tbl('By side', sideRows);
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
          <div class="label">Projected strikeouts</div>
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
  function renderHero() {
    if (!boardIsLive()) return; // keep the static mock hero
    const hasDuo = (g) => g.projRows && g.projRows.length === 2 && g.projRows.every((p) => typeof p.proj === 'number');
    const preview = state.liveBoard.filter((g) => g.status === 'Preview' && hasDuo(g));
    const pool = preview.length ? preview : state.liveBoard.filter(hasDuo);
    if (!pool.length) return;
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
    } else {
      pickStrip = `<div class="pick-strip"><span class="pick">No strikeout prop posted yet — projection only</span></div>`;
    }

    el.heroDuel.innerHTML = heroSide(a) + heroSide(b) + pickStrip + winprob;
  }

  function renderAll() {
    renderTheme();
    renderTicker();
    renderWinProb();
    renderInjuryAlerts();
    renderControls();
    renderBoard();
    renderComparePanel();
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

  function toggleTrack(id) {
    state.tracked = { ...state.tracked, [id]: !state.tracked[id] };
    try { localStorage.setItem('aimplified_tracked', JSON.stringify(state.tracked)); } catch (e) {}
    renderControls();
    renderBoard();
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
    else toggleTrack(id);
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
    // Track record grades finished games on read — refresh every 10 min.
    refreshTrackRecord();
    setInterval(refreshTrackRecord, 600000);
    // Injury wire (recent IL moves) — refresh every 10 min.
    refreshInjuries();
    setInterval(refreshInjuries, 600000);
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
