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
      stats: [ { label: 'CSW%', value: 94, tone: 'hot' }, { label: 'Whiff%', value: 91, tone: 'hot' }, { label: 'Opp Chase', value: 78, tone: 'warm' } ] },
    { id: 'g2', matchup: 'NYY @ HOU', subline: 'Cole v. Valdez · 5:10 PT', time: 3, pick: 'Valdez U 5.5 Ks', odds: 102, edge: 3.4, interval: '3.1 – 6.2', tier: 2, weather: 'Roof closed · Neutral park', weatherTone: 'textDim',
      stats: [ { label: 'CSW%', value: 82, tone: 'warm' }, { label: 'Whiff%', value: 77, tone: 'warm' }, { label: 'Opp Chase', value: 61, tone: 'warm' } ] },
    { id: 'g3', matchup: 'BOS @ TOR', subline: 'Bello v. Gausman · 4:07 PT', time: 2, pick: 'Bello U 4.5 Ks', odds: -120, edge: 4.6, interval: '2.8 – 5.5', tier: 1, weather: 'Roof closed · Neutral park', weatherTone: 'textDim',
      stats: [ { label: 'CSW%', value: 88, tone: 'hot' }, { label: 'Whiff%', value: 85, tone: 'hot' }, { label: 'Opp Chase', value: 70, tone: 'warm' } ] },
    { id: 'g4', matchup: 'ATL @ PHI', subline: 'Wheeler v. Sale · 4:05 PT', time: 2, pick: 'Wheeler O 7.5 Ks', odds: -108, edge: 2.1, interval: '5.9 – 9.4', tier: 2, weather: 'In wind 9mph · Park −2% Ks', weatherTone: 'warm',
      stats: [ { label: 'CSW%', value: 79, tone: 'warm' }, { label: 'Whiff%', value: 73, tone: 'warm' }, { label: 'Opp Chase', value: 55, tone: 'cool' } ] },
    { id: 'g5', matchup: 'MIL @ CHC', subline: 'Peralta v. Imanaga · 5:20 PT', time: 4, pick: 'Peralta O 6.5 Ks', odds: -102, edge: 1.2, interval: '4.6 – 8.2', tier: 3, weather: 'Wrigley crosswind · High variance', weatherTone: 'warm',
      stats: [ { label: 'CSW%', value: 68, tone: 'warm' }, { label: 'Whiff%', value: 64, tone: 'warm' }, { label: 'Opp Chase', value: 50, tone: 'cool' } ] },
    { id: 'g6', matchup: 'SD @ SF', subline: 'Cease v. Webb · 6:45 PT', time: 5, pick: 'No edge — pass', odds: null, edge: -0.6, interval: '4.4 – 8.0', tier: 'pass', weather: 'Marine layer · Park −4% Ks', weatherTone: 'positive',
      stats: [ { label: 'CSW%', value: 61, tone: 'cool' }, { label: 'Whiff%', value: 58, tone: 'cool' }, { label: 'Opp Chase', value: 44, tone: 'cool' } ] },
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
    // Live feed (null until the Odds API proxy returns data; falls back to mock).
    liveTicker: null,
    quotaRemaining: null,
  };

  // How to reach the Odds API proxy. Empty => mock-only mode.
  //   "same-origin" (or "/") => Cloudflare Pages Functions at /api/* on this
  //                             origin (recommended — no CORS).
  //   full URL                => a separately-hosted proxy Worker.
  const rawBase = (window.AIMPLIFIED_API_BASE || '').trim();
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
    injuryAlerts: document.getElementById('injuryAlerts'),
    gameCount: document.getElementById('gameCount'),
    trackedPill: document.getElementById('trackedPill'),
    searchInput: document.getElementById('searchInput'),
    sortLabel: document.getElementById('sortLabel'),
    compareModeBtn: document.getElementById('compareModeBtn'),
    compareHint: document.getElementById('compareHint'),
    boardRows: document.getElementById('boardRows'),
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

  function renderWinProb() {
    el.winProbFill.style.width = state.winProb + '%';
    el.winProbPct.textContent = state.winProb.toFixed(1) + '%';
  }

  function renderInjuryAlerts() {
    el.injuryAlerts.innerHTML = INJURY_ALERTS.map((a) => `
      <div class="alert">
        <span class="alert-dot"></span>
        <b>ALERT</b>
        <span>${esc(a.text)}</span>
        <span class="alert-time">${esc(a.time)}</span>
      </div>
    `).join('');
  }

  function getFilteredSortedGames() {
    let games = RAW_GAMES.filter((g) => state.filter === 'all' ? true : String(g.tier) === state.filter);
    const q = state.searchQuery.trim().toLowerCase();
    if (q) {
      games = games.filter((g) => g.matchup.toLowerCase().includes(q) || g.subline.toLowerCase().includes(q));
    }
    games = [...games].sort((a, b) => state.sortBy === 'edge' ? b.edge - a.edge : a.time - b.time);
    return games;
  }

  function renderControls() {
    el.gameCount.textContent = `${RAW_GAMES.length} games · odds refresh :30`;
    const trackedCount = Object.values(state.tracked).filter(Boolean).length;
    el.trackedPill.textContent = `${trackedCount} tracked`;
    el.sortLabel.textContent = state.sortBy === 'edge' ? 'Edge' : 'Time';

    document.querySelectorAll('.filter-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.filter === state.filter);
    });

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

  function renderBoard() {
    const games = getFilteredSortedGames();
    el.noResults.hidden = games.length !== 0;

    el.boardRows.innerHTML = games.map((g) => {
      const isPass = g.tier === 'pass';
      const isTracked = !!state.tracked[g.id];
      const isSelected = state.compareIds.includes(g.id);
      const isExpanded = state.expandedId === g.id;
      const edgeColor = g.edge > 0 ? 'var(--positive)' : 'var(--danger)';
      const oddsLabel = isPass ? '—' : (g.odds > 0 ? '+' + g.odds : String(g.odds));
      const edgeLabel = (g.edge > 0 ? '+' : '') + g.edge.toFixed(1) + '%';

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
          <span>${esc(g.pick)}</span>
          <span class="odds-cell mono">${esc(oddsLabel)}</span>
          <span class="edge-cell" style="color:${edgeColor}">${esc(edgeLabel)}</span>
          <span class="interval-cell">${esc(g.interval)}</span>
          <span class="tier-cell${isPass ? ' pass' : ''}" style="${isPass ? '' : 'color:var(--accent)'}">${esc(TIER_LABEL[g.tier])}</span>
          <span class="chevron">${isExpanded ? '▲' : '▼'}</span>
        </div>
      `;

      let detailHtml = '';
      if (isExpanded) {
        const statsHtml = g.stats.map((s) => `
          <div class="stat-row">
            <span class="stat-label">${esc(s.label)}</span>
            <div class="track"><div class="fill" style="width:${s.value}%;background:${TONE_COLOR[s.tone]}"></div></div>
            <span class="badge" style="background:${TONE_COLOR[s.tone]}">${s.value}</span>
          </div>
        `).join('');
        detailHtml = `<div class="expanded-detail"><div class="expanded-title">Percentile breakdown</div>${statsHtml}</div>`;
      }

      return rowHtml + detailHtml;
    }).join('');
  }

  function renderComparePanel() {
    const showPanel = state.compareMode && state.compareIds.length === 2;
    if (!showPanel) { el.comparePanel.innerHTML = ''; return; }
    const compareGames = RAW_GAMES.filter((g) => state.compareIds.includes(g.id));
    const sidesHtml = compareGames.map((g) => {
      const edgeLabel = (g.edge > 0 ? '+' : '') + g.edge.toFixed(1) + '%';
      const edgeClass = g.edge > 0 ? 'positive' : '';
      const edgeColor = g.edge > 0 ? 'var(--positive)' : 'var(--danger)';
      return `
        <div class="compare-side">
          <div class="name">${esc(g.matchup)}</div>
          <div class="sub">${esc(g.subline)}</div>
          <div class="stats-row">
            <div><div class="stat-k">Pick</div><div class="stat-v">${esc(g.pick)}</div></div>
            <div><div class="stat-k">Edge</div><div class="stat-v" style="color:${edgeColor}">${esc(edgeLabel)}</div></div>
            <div><div class="stat-k">Tier</div><div class="stat-v tier">${esc(TIER_LABEL[g.tier])}</div></div>
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
    el.hittersGrid.innerHTML = HOT_HITTERS.map((h, i) => {
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
      return `
        <div class="${cardClasses.join(' ')}"${clickAttr}>
          <div class="top-row">
            <span class="rank">#${i + 1}</span>
            ${checkboxHtml}
          </div>
          <div class="name">${esc(h.name)}</div>
          <div class="team">${esc(h.team)}</div>
          <div class="stat-num">${esc(h.woba)}</div>
          <div class="stat-sub">wOBA · L10</div>
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
    const compareHitters = state.hitterCompareIds.map((i) => HOT_HITTERS[i]);
    const sidesHtml = compareHitters.map((h) => `
      <div class="compare-side">
        <div class="name">${esc(h.name)}</div>
        <div class="sub">${esc(h.team)}</div>
        <div class="stats-row">
          <div><div class="stat-k">wOBA L10</div><div class="stat-v big accent">${esc(h.woba)}</div></div>
          <div><div class="stat-k">HR</div><div class="stat-v big">${h.hrs}</div></div>
          <div><div class="stat-k">Streak</div><div class="stat-v positive">${esc(h.streak)}</div></div>
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
    const tone = (v) => v >= 370 ? 'var(--positive)' : v >= 330 ? 'var(--accent)' : 'var(--textDim)';
    el.splitRows.innerHTML = HOT_HITTERS.map((h) => `
      <div class="split-row">
        <span class="split-name">${esc(h.name)}</span>
        <span class="split-val" style="color:${tone(h.lhp)}">.${h.lhp}</span>
        <span class="split-val" style="color:${tone(h.rhp)}">.${h.rhp}</span>
      </div>
    `).join('');
  }

  function renderPitchers() {
    el.pitchersGrid.innerHTML = HOT_PITCHERS.map((p, i) => {
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
      return `
        <div class="${cardClasses.join(' ')}"${clickAttr}>
          <div class="top-row">
            <span class="rank">#${i + 1}</span>
            ${checkboxHtml}
          </div>
          <div class="name">${esc(p.name)}</div>
          <div class="team">${esc(p.team)}</div>
          <div class="stat-num">${p.csw}%</div>
          <div class="stat-sub">CSW% · L3 starts</div>
          <div class="chip-row">
            <span class="chip positive">${esc(p.kRate)} K/9</span>
            <span class="chip plain">${esc(p.era)} ERA</span>
          </div>
        </div>
      `;
    }).join('');
  }

  function renderPitcherComparePanel() {
    const showPanel = state.pitcherCompareMode && state.pitcherCompareIds.length === 2;
    if (!showPanel) { el.pitcherComparePanel.innerHTML = ''; return; }
    const comparePitchers = state.pitcherCompareIds.map((i) => HOT_PITCHERS[i]);
    const sidesHtml = comparePitchers.map((p) => `
      <div class="compare-side">
        <div class="name">${esc(p.name)}</div>
        <div class="sub">${esc(p.team)}</div>
        <div class="stats-row">
          <div><div class="stat-k">CSW% L3</div><div class="stat-v big accent">${p.csw}%</div></div>
          <div><div class="stat-k">K/9</div><div class="stat-v big">${esc(p.kRate)}</div></div>
          <div><div class="stat-k">ERA</div><div class="stat-v positive">${esc(p.era)}</div></div>
        </div>
      </div>
    `).join('');
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
    // Lower wOBA-against is better for a pitcher, so the tone scale inverts.
    const tone = (v) => v <= 275 ? 'var(--positive)' : v <= 305 ? 'var(--accent)' : 'var(--textDim)';
    el.pitcherSplitRows.innerHTML = HOT_PITCHERS.map((p) => `
      <div class="split-row">
        <span class="split-name">${esc(p.name)}</span>
        <span class="split-val" style="color:${tone(p.vsL)}">.${p.vsL}</span>
        <span class="split-val" style="color:${tone(p.vsR)}">.${p.vsR}</span>
      </div>
    `).join('');
  }

  function renderCalibration() {
    el.calibrationPoints.innerHTML = CALIBRATION_BUCKETS.map((b) => `
      <div class="calibration-dot" style="left:calc(${b.predicted}% - 6px);bottom:calc(${b.actual}% - 6px)" title="Predicted ${b.predicted}% · Actual ${b.actual}% (n=${b.n})"></div>
    `).join('');
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

  setInterval(() => {
    const delta = Math.random() * 4 - 2;
    const next = Math.min(80, Math.max(50, state.winProb + delta));
    state.winProb = Math.round(next * 10) / 10;
    renderWinProb();
  }, 4000);

  if (LIVE_MODE) {
    // Live mode: poll the real feed. Proxy caches 30s; poll every 60s to
    // stay well within The Odds API monthly credit quota.
    refreshLiveData();
    setInterval(refreshLiveData, 60000);
  } else {
    // Mock mode: keep the ticker lively with simulated score nudges.
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
