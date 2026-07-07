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
// Burn-in period (Jul 7 - ~Aug 4, 2026): shrink raised 0.20 -> 0.30 while the
// graded-pick sample accrues; plan is to drop to 0.24 after, unless the CLV
// beat rate / Brier on real picks argues otherwise.
const LINE_SHRINK = 0.30;  // fraction of the projection pulled toward the line

// The books we price against (the user's accounts). Odds API bookmaker keys ->
// short display labels. Prices are pinned to these two only, and the better of
// the two is highlighted so the board doubles as a line-shop.
const BOOKS = { draftkings: 'DK', fanduel: 'FD' };

const API_ROUTES = new Set([
  '/api/odds', '/api/scores', '/api/hitters', '/api/pitchers',
  '/api/board', '/api/batters', '/api/track-record', '/api/injuries', '/api/live-now',
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
    const cacheKey = new Request(url.origin + p); // ignore any query string
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    const resp = await handleApi(p, env, ctx);
    // Only cache real successes — never an error (so a transient failure can't
    // stick). Empty [] uses a short TTL in its handler, so it self-heals fast.
    if (resp && resp.status === 200 && ctx && ctx.waitUntil) {
      ctx.waitUntil(cache.put(cacheKey, resp.clone()));
    }
    return resp;
  },
};

async function handleApi(p, env, ctx) {
  if (p === '/api/hitters') return hitters();
  if (p === '/api/pitchers') return pitchers();
  if (p === '/api/board') return board(env, ctx);
  if (p === '/api/batters') return batters(env, ctx);
  if (p === '/api/track-record') return trackRecord(env);
  if (p === '/api/injuries') return injuries();
  if (p === '/api/live-now') return liveNow(env);

  const key = env.ODDS_API_KEY;
  if (!key) return err('ODDS_API_KEY is not configured', 500);
  const upstream = p === '/api/odds'
    ? `${ODDS}/odds?apiKey=${key}&regions=us&markets=h2h,totals&oddsFormat=american&dateFormat=iso`
    : `${ODDS}/scores?apiKey=${key}&daysFrom=1&dateFormat=iso`;
  return proxy(upstream);
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
async function board(env, ctx) {
  const season = new Date().getUTCFullYear();
  const date = slateDate(); // the site's slate day, in Pacific time

  let sched;
  try {
    const r = await fetch(`${STATS}/schedule?sportId=1&date=${date}&hydrate=probablePitcher,linescore,team`, { headers: { accept: 'application/json' } });
    if (!r.ok) return cors(json([], 60));
    sched = await r.json();
  } catch (e) { return cors(json([], 60)); }

  const games = (sched.dates && sched.dates[0] && sched.dates[0].games) || [];
  if (!games.length) return cors(json([], 60));

  // Real strikeout prop lines (paid Odds API player props), keyed by pitcher
  // name. Per-event requests — cached 5 min below to protect the quota.
  const propByName = {};
  const key = env && env.ODDS_API_KEY;
  if (key) {
    try {
      const evR = await fetch(`${ODDS}/events?apiKey=${key}&dateFormat=iso`, { headers: { accept: 'application/json' } });
      if (evR.ok) {
        const events = await evR.json();
        await Promise.all((Array.isArray(events) ? events : []).map(async (ev) => {
          try {
            const pr = await fetch(`${ODDS}/events/${ev.id}/odds?apiKey=${key}&regions=us&markets=pitcher_strikeouts&oddsFormat=american&dateFormat=iso`, { headers: { accept: 'application/json' } });
            if (!pr.ok) return;
            const pd = await pr.json();
            for (const bm of (pd.bookmakers || [])) {
              const label = BOOKS[bm.key]; // 'DK' | 'FD'
              if (!label) continue;        // only DraftKings + FanDuel
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

  // Team strikeout rate + league baseline (one call).
  const teamK = {}; let lgSO = 0, lgPA = 0;
  try {
    const r = await fetch(`${STATS}/teams/stats?season=${season}&sportId=1&group=hitting&stats=season`, { headers: { accept: 'application/json' } });
    if (r.ok) {
      const d = await r.json();
      const splits = ((d.stats || [])[0] || {}).splits || [];
      splits.forEach((sp) => {
        const st = sp.stat || {};
        const id = sp.team && sp.team.id;
        const so = toNum(st.strikeOuts), pa = toNum(st.plateAppearances);
        if (id && pa > 0) { teamK[id] = so / pa; lgSO += so; lgPA += pa; }
      });
    }
  } catch (e) { /* opponent adjustment falls back to neutral */ }
  const lgK = lgPA > 0 ? lgSO / lgPA : 0.222;

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

  // Real moneylines (paid Odds API h2h) — one call, keyed by home team name.
  const mlByHome = {};
  if (key) {
    try {
      const r = await fetch(`${ODDS}/odds?apiKey=${key}&regions=us&markets=h2h&oddsFormat=american&dateFormat=iso`, { headers: { accept: 'application/json' } });
      if (r.ok) {
        const events = await r.json();
        (Array.isArray(events) ? events : []).forEach((ev) => {
          // Best moneyline across DraftKings + FanDuel only.
          const wanted = (ev.bookmakers || []).filter((b) => BOOKS[b.key]);
          const priceBest = (name) => {
            let best = null;
            for (const b of wanted) {
              const mk = (b.markets || []).find((m) => m.key === 'h2h');
              const o = mk && (mk.outcomes || []).find((x) => x.name === name);
              if (o && o.price != null && (best == null || payoutMult(o.price) > payoutMult(best))) best = o.price;
            }
            return best;
          };
          if (!wanted.length) return;
          mlByHome[ev.home_team] = { home: priceBest(ev.home_team), away: priceBest(ev.away_team) };
        });
      }
    } catch (e) { /* no moneylines -> ml pick is model-only */ }
  }

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

      // Market: price the projection against the DK/FD strikeout lines, taking
      // the better of the two prices for the chosen side.
      const market = priceStrikeouts(propByName[normName(pp.fullName)], projK);

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

    // Moneyline model: team win% via log5 + home field + starting-pitcher ERA,
    // priced against the real moneyline.
    const ml = moneyline(g, home, away, teamWinP, pmap, mlByHome[home.team && home.team.name]);

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
      oddsBooks: lead ? lead.market.books : null,
      edge: lead ? lead.market.edge : null,
      tier: lead ? lead.market.tier : 'model',
      interval: lead ? `${lead.lo} – ${lead.hi}` : (projLean ? `${projLean.lo} – ${projLean.hi}` : '—'),
      pitchers,
      ml,
    };
  }).sort((a, b) => a.timeMs - b.timeMs);

  // Log tonight's priced picks to the track record (idempotent) — non-blocking.
  if (env && env.DB) {
    const write = logPicks(env.DB, rows, date).catch(() => {});
    if (ctx && ctx.waitUntil) ctx.waitUntil(write);
  }

  return cors(json(rows, 300)); // 5 min — props are the expensive part
}

// Moneyline model for one game. Team win% -> log5 matchup, plus home-field
// and a modest starting-pitcher ERA adjustment, priced vs the real moneyline.
function moneyline(g, home, away, teamWinP, pmap, oddsPair) {
  const pH = teamWinP(home.team && home.team.id);
  const pA = teamWinP(away.team && away.team.id);
  // log5: probability the home team beats the away team on neutral ground.
  let homeWin = (pH - pH * pA) / (pH + pA - 2 * pH * pA);
  if (!isFinite(homeWin)) homeWin = 0.5;
  homeWin += 0.035; // home-field advantage

  // Starting-pitcher edge: better (lower) ERA nudges that side.
  const eraOf = (pp) => { const s = pp && pp.id ? pmap[pp.id] : null; return s && s.era != null ? parseFloat(s.era) : null; };
  const hERA = eraOf(home.probablePitcher), aERA = eraOf(away.probablePitcher);
  if (hERA != null && aERA != null) homeWin += clamp((aERA - hERA) * 0.025, -0.08, 0.08);
  homeWin = clamp(homeWin, 0.05, 0.95);

  const model = { home: homeWin, away: 1 - homeWin };
  const price = oddsPair || {};
  const impH = amProb(price.home), impA = amProb(price.away);
  let fairH = null;
  if (impH != null && impA != null) { const v = impH + impA; fairH = v > 0 ? impH / v : impH; }

  const sideFor = (side) => {
    const teamObj = side === 'home' ? home.team : away.team;
    const p = model[side];
    const pr = side === 'home' ? price.home : price.away;
    const fair = fairH == null ? null : (side === 'home' ? fairH : 1 - fairH);
    const edge = fair == null ? null : round1((p - fair) * 100);
    return { side, teamAbbr: teamAbbr(teamObj), winProb: Math.round(p * 100), price: pr != null ? pr : null, edge };
  };
  const h = sideFor('home'), a = sideFor('away');

  // Pick the +EV side (largest edge); with no market, pick the model favorite.
  let chosen;
  if (h.edge == null || a.edge == null) chosen = model.home >= model.away ? h : a;
  else chosen = h.edge >= a.edge ? h : a;

  const e = chosen.edge;
  const tier = e == null ? 'model' : e >= 4 ? 1 : e >= 2.5 ? 2 : e >= 1 ? 3 : 'pass';
  return {
    pick: `${chosen.teamAbbr} ML`,
    teamAbbr: chosen.teamAbbr,
    winProb: chosen.winProb,
    price: chosen.price,
    edge: e,
    tier,
    homeAbbr: h.teamAbbr, awayAbbr: a.teamAbbr,
    homeWinProb: h.winProb, awayWinProb: a.winProb,
  };
}

// -------------------------------------------------------------------------
// /api/batters — tonight's real batter props (HR, total bases, H+R+RBI) from
// the paid Odds API, priced against a per-game rate model. Percentile bars
// (power / slugging / contact / discipline) are computed from real season
// stats across the priced pool. Empty [] on any trouble so the tab degrades.
// -------------------------------------------------------------------------
const BATTER_MARKETS = [
  { key: 'batter_home_runs', label: 'HR', metric: 'hr' },
  { key: 'batter_total_bases', label: 'TB', metric: 'tb' },
  { key: 'batter_hits_runs_rbis', label: 'H+R+RBI', metric: 'hrr' },
];

async function batters(env, ctx) {
  const season = new Date().getUTCFullYear();
  const key = env && env.ODDS_API_KEY;
  if (!key) return cors(json([], 300));

  // 1) Which events are on, and their batter prop lines (DK/FD), per player.
  let events;
  try {
    const evR = await fetch(`${ODDS}/events?apiKey=${key}&dateFormat=iso`, { headers: { accept: 'application/json' } });
    if (!evR.ok) return cors(json([], 300));
    events = await evR.json();
  } catch (e) { return cors(json([], 300)); }
  if (!Array.isArray(events) || !events.length) return cors(json([], 300));

  // Map each "AWAY@HOME" to its real MLB gamePk + status, so batter picks can
  // be logged and later graded from the boxscore (needs the gamePk). The same
  // request hydrates posted starting lineups: once a manager's card is up we
  // know who actually plays tonight and where they bat.
  const schedByMatchup = {};
  const lineupSlotById = {};        // playerId -> batting slot 1-9
  const lineupPostedTeamIds = new Set(); // teams whose lineup is posted
  try {
    const r = await fetch(`${STATS}/schedule?sportId=1&date=${slateDate()}&hydrate=team,lineups`, { headers: { accept: 'application/json' } });
    if (r.ok) {
      const sd = await r.json();
      (((sd.dates || [])[0] || {}).games || []).forEach((g) => {
        // Key by team NAME through the same table the Odds events use, so
        // StatsAPI abbreviations that differ (e.g. AZ vs ARI) still match.
        const away = keyAbbr((g.teams.away.team || {}).name), home = keyAbbr((g.teams.home.team || {}).name);
        schedByMatchup[`${away}@${home}`] = { gamePk: g.gamePk, status: (g.status && g.status.abstractGameState) || 'Preview' };
        const lp = g.lineups || {};
        [['awayPlayers', g.teams.away.team], ['homePlayers', g.teams.home.team]].forEach(([k, team]) => {
          const arr = lp[k] || [];
          if (!arr.length || !team || !team.id) return;
          lineupPostedTeamIds.add(team.id);
          arr.forEach((p, i) => { if (p && p.id) lineupSlotById[p.id] = i + 1; });
        });
      });
    }
  } catch (e) { /* no gamePk mapping -> batter picks just won't be logged */ }

  const marketKeys = BATTER_MARKETS.map((m) => m.key).join(',');
  const byName = {}; // normName -> { name, matchup, timeMs, timeLabel, props:{metric:{DK,FD}} }
  await Promise.all(events.map(async (ev) => {
    try {
      const r = await fetch(`${ODDS}/events/${ev.id}/odds?apiKey=${key}&regions=us&markets=${marketKeys}&oddsFormat=american&dateFormat=iso`, { headers: { accept: 'application/json' } });
      if (!r.ok) return;
      const d = await r.json();
      const awayAb = keyAbbr(ev.away_team);
      const homeAb = keyAbbr(ev.home_team);
      const matchup = `${awayAb} @ ${homeAb}`;
      const sched = schedByMatchup[`${awayAb}@${homeAb}`] || null;
      for (const bm of (d.bookmakers || [])) {
        const label = BOOKS[bm.key];
        if (!label) continue;
        for (const spec of BATTER_MARKETS) {
          const mk = (bm.markets || []).find((m) => m.key === spec.key);
          if (!mk) continue;
          for (const oc of (mk.outcomes || [])) {
            const nm = normName(oc.description);
            if (!nm) continue;
            const rec = byName[nm] || (byName[nm] = { name: oc.description, matchup, timeMs: Date.parse(ev.commence_time) || 0, timeLabel: timeLabelPT(ev.commence_time), gamePk: sched ? sched.gamePk : null, gameStatus: sched ? sched.status : 'Preview', props: {} });
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
  if (!Object.keys(byName).length) return cors(json([], 300));

  // 2) Season hitting stats for every batter, keyed by name for matching.
  const statByName = {};
  try {
    const r = await fetch(`${STATS}/stats?stats=season&group=hitting&gameType=R&season=${season}&sportId=1&playerPool=All&limit=2000`, { headers: { accept: 'application/json' } });
    if (r.ok) {
      const d = await r.json();
      ((d.stats || [])[0] || {}).splits?.forEach((s) => {
        const nm = normName((s.player || {}).fullName);
        if (nm) statByName[nm] = { st: s.stat || {}, id: (s.player || {}).id, team: teamAbbr(s.team), teamId: (s.team || {}).id };
      });
    }
  } catch (e) { /* projections fall back to rate-only where possible */ }

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
    const slot = lineupSlotById[match.id] || 0;
    if (!slot && match.teamId && lineupPostedTeamIds.has(match.teamId)) continue;
    const expPA = slot ? SLOT_PA[slot - 1] : pa / gp;
    const hr = toNum(st.homeRuns), tb = toNum(st.totalBases);
    const hits = toNum(st.hits), runs = toNum(st.runs), rbi = toNum(st.rbi);
    const iso = Math.max(0, toNum(st.slg) - toNum(st.avg));
    const kpct = pa > 0 ? toNum(st.strikeOuts) / pa : 0;
    const bbpct = pa > 0 ? toNum(st.baseOnBalls) / pa : 0;
    pool.iso.push(iso); pool.slg.push(toNum(st.slg)); pool.contact.push(1 - kpct); pool.disc.push(bbpct);

    const lambda = {
      hr: (hr / pa) * expPA,
      tb: (tb / pa) * expPA,
      hrr: slot ? ((hits + runs + rbi) / pa) * expPA : (hits + runs + rbi) / gp,
    };
    const markets = {};
    for (const spec of BATTER_MARKETS) {
      markets[spec.metric] = priceBatterProp(rec.props[spec.metric], lambda[spec.metric]);
    }
    draft.push({ nm, rec, match, st, lambda, iso, slg: toNum(st.slg), kpct, bbpct, markets, slot });
  }
  if (!draft.length) return cors(json([], 300));

  const pr = (arr, v) => arr.length ? Math.round(arr.filter((x) => x <= v).length / arr.length * 100) : 0;
  const tone = (v) => v >= 66 ? 'cool' : v >= 33 ? 'warm' : 'hot';

  const rows = draft.map((b) => {
    const priced = BATTER_MARKETS
      .map((spec) => ({ spec, m: b.markets[spec.metric] }))
      .filter((x) => x.m && x.m.price != null);
    // Headline = the market with the biggest edge.
    const lead = priced.reduce((best, x) => (!best || x.m.edge > best.m.edge ? x : best), null);
    const expFor = (metric) => round2(b.lambda[metric]);
    const power = pr(pool.iso, b.iso), slug = pr(pool.slg, b.slg);
    const contact = pr(pool.contact, 1 - b.kpct), disc = pr(pool.disc, b.bbpct);

    return {
      id: 'b' + (b.match.id || b.nm.replace(/\s/g, '')),
      name: shortName(b.rec.name),
      team: b.match.team,
      playerId: b.match.id || null,
      gamePk: b.rec.gamePk || null,
      status: b.rec.gameStatus || 'Preview',
      matchup: b.rec.matchup,
      timeMs: b.rec.timeMs,
      timeLabel: b.rec.timeLabel,
      lineupSlot: b.slot || null,
      pick: lead ? `${lead.m.side === 'Over' ? 'O' : 'U'} ${lead.m.line} ${lead.spec.label}` : '—',
      odds: lead ? lead.m.price : null,
      oddsBooks: lead ? lead.m.books : null,
      edge: lead ? lead.m.edge : null,
      tier: lead ? lead.m.tier : 'pass',
      interval: lead ? `proj ${expFor(lead.spec.metric)} ${lead.spec.label}` : '—',
      // Per-market detail for the expanded row (also carries what logging needs).
      batterMarkets: BATTER_MARKETS.map((spec) => {
        const m = b.markets[spec.metric];
        return m ? { label: spec.label, metric: spec.metric, line: m.line, side: m.side, price: m.price, edge: m.edge, modelOver: m.modelOver, fairOver: m.fairOver, tier: m.tier, proj: expFor(spec.metric), books: m.books } : { label: spec.label, metric: spec.metric, none: true, proj: expFor(spec.metric) };
      }),
      // Real percentile bars from the priced pool.
      stats: [
        { label: 'Power (ISO)', value: power, tone: tone(power) },
        { label: 'Slugging', value: slug, tone: tone(slug) },
        { label: 'Contact', value: contact, tone: tone(contact) },
        { label: 'Discipline', value: disc, tone: tone(disc) },
      ],
    };
  }).filter((r) => r.odds != null)
    .sort((a, b) => (b.edge || 0) - (a.edge || 0))
    .slice(0, 40);

  // Log tonight's priced batter picks to the track record (idempotent).
  if (env && env.DB) {
    const write = logBatterPicks(env.DB, rows, slateDate()).catch(() => {});
    if (ctx && ctx.waitUntil) ctx.waitUntil(write); else await write;
  }

  return cors(json(rows, 300)); // 5 min — batter props are the expensive call
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
    const kres = await env.DB.prepare('SELECT * FROM picks').all();
    const bres = await env.DB.prepare('SELECT * FROM bpicks').all();
    // Normalize both feeds to one row shape: pitcher picks are market 'K' with
    // actual_k; batter picks map their per-market actual into the same field.
    const unified = [
      ...(kres.results || []).map((r) => ({ ...r, market: 'K' })),
      ...(bres.results || []).map((r) => ({ ...r, actual_k: r.actual, market: String(r.market || '').toUpperCase() })),
    ];
    return cors(json(buildTrackRecord(unified), 120));
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
        `INSERT OR IGNORE INTO bpicks (date,game_id,player_id,player,team,market,line,side,price,proj,model_over,edge,tier,entry_over)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(date, gid, r.playerId, r.name, r.team, m.metric, m.line, m.side, m.price, m.proj, m.modelOver, m.edge, String(m.tier), m.fairOver ?? null));
      // Continuous close capture: latest line/price always; the vig-free over%
      // only when the line still matches entry (so a late line move never
      // clobbers the last comparable close).
      stmts.push(db.prepare('UPDATE bpicks SET close_line=?, close_price=? WHERE date=? AND game_id=? AND player_id=? AND market=?')
        .bind(m.line, m.price, date, gid, r.playerId, m.metric));
      if (m.fairOver != null) {
        stmts.push(db.prepare('UPDATE bpicks SET close_over=? WHERE date=? AND game_id=? AND player_id=? AND market=? AND line=?')
          .bind(m.fairOver, date, gid, r.playerId, m.metric, m.line));
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
      if (actual == null) continue; // didn't play / not found -> leave ungraded (void)
      const result = gradePick(p.side, p.line, actual);
      stmts.push(db.prepare('UPDATE bpicks SET actual=?, result=? WHERE date=? AND game_id=? AND player_id=? AND market=?').bind(actual, result, p.date, p.game_id, p.player_id, p.market));
    }
    if (stmts.length) { try { await db.batch(stmts); } catch (e) { /* skip */ } }
  }
}

// A batter's actual value for a market from the boxscore batting line.
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
        `INSERT OR IGNORE INTO picks (date,game_id,pitcher_id,pitcher,team,line,side,price,proj,model_over,edge,tier,entry_over)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(date, r.id, p.id, p.name, p.team, m.line, m.side, m.price, p.proj, m.modelOver, m.edge, String(m.tier), m.fairOver ?? null));
      // Continuous close capture (see logBatterPicks for the rationale).
      stmts.push(db.prepare('UPDATE picks SET close_line=?, close_price=? WHERE date=? AND game_id=? AND pitcher_id=?')
        .bind(m.line, m.price, date, r.id, p.id));
      if (m.fairOver != null) {
        stmts.push(db.prepare('UPDATE picks SET close_over=? WHERE date=? AND game_id=? AND pitcher_id=? AND line=?')
          .bind(m.fairOver, date, r.id, p.id, m.line));
      }
    }
  }
  if (stmts.length) await db.batch(stmts);
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
    const picks = (await db.prepare('SELECT * FROM picks WHERE game_id=? AND result IS NULL').bind(g.game_id).all()).results || [];
    const stmts = [];
    for (const p of picks) {
      const k = kById[p.pitcher_id];
      if (k == null) continue;
      const result = gradePick(p.side, p.line, k);
      stmts.push(db.prepare('UPDATE picks SET actual_k=?, result=? WHERE date=? AND game_id=? AND pitcher_id=?').bind(k, result, p.date, p.game_id, p.pitcher_id));
    }
    if (stmts.length) { try { await db.batch(stmts); } catch (e) { /* skip */ } }
  }
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

  // Calibration: bucket graded picks by model P(over), compare to actual over-rate.
  const buckets = {};
  for (const r of graded) {
    if (r.model_over == null || r.actual_k == null) continue;
    const b = Math.min(9, Math.max(0, Math.floor(r.model_over / 10)));
    (buckets[b] = buckets[b] || []).push(r);
  }
  const calibration = Object.keys(buckets).map((b) => {
    const arr = buckets[b];
    const predicted = round1(arr.reduce((s, r) => s + r.model_over, 0) / arr.length);
    const overs = arr.filter((r) => r.actual_k > r.line).length;
    return { predicted, actual: round1(overs / arr.length * 100), n: arr.length };
  }).sort((a, b) => a.predicted - b.predicted);

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
  };
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

  // Vig-free fair over% from a two-sided book at the reference line (prefer DK).
  const atRef = [dk, fd].filter((b) => b && b.point === refLine);
  const twoSided = atRef.find((b) => b.over != null && b.under != null);
  let fairOver;
  if (twoSided) { const io = amProb(twoSided.over), iu = amProb(twoSided.under); const v = io + iu; fairOver = v > 0 ? io / v : io; }
  else { const one = atRef.find((b) => b.over != null || b.under != null); if (!one) return null; fairOver = one.over != null ? amProb(one.over) : 1 - amProb(one.under); }

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

  return {
    line: refLine,
    side,
    price: best,        // the better of DK/FD for the chosen side — what you'd bet
    edge: edgePts,
    modelOver: round1(pOver * 100),
    fairOver: Math.round(fairOver * 1e4) / 1e4, // vig-free market P(over) — for CLV
    tier: edgePts >= tiers[0] ? 1 : edgePts >= tiers[1] ? 2 : edgePts >= tiers[2] ? 3 : 'pass',
    books,              // [{ book, price, line, off, best }]
  };
}

// Strikeout prop: overdispersed normal around the projection, regressed to line.
function priceStrikeouts(prop, projK) {
  return bestBookMarket(prop, (L) => {
    const lam = (1 - LINE_SHRINK) * projK + LINE_SHRINK * L;
    const sigma = Math.sqrt(Math.max(lam, 1) * DISPERSION);
    return 1 - normCdf((L - lam) / sigma);
  });
}

// The batter model is a Poisson approximation and not yet calibrated (early
// grading shows it wildly overstates edges), so until it has a track record we
// regress it hard toward the market and price it on stricter tiers. This keeps
// batter picks honest — most land Tier 2/3/pass, not a board full of Tier 1.
const BATTER_SHRINK = 0.25;      // keep ~25% of the raw model-vs-market gap
const BATTER_TIERS = [8, 5, 3];  // T1/T2/T3 edge cutoffs (vs 5/3/1.5 for Ks)

// Expected plate appearances by batting-order slot (league-typical: leadoff
// ~4.65, dropping ~0.11 per slot to ~3.77 in the 9-hole). Used once tonight's
// lineup is posted; before that, a batter's own season PA/G stands in.
const SLOT_PA = [4.65, 4.54, 4.43, 4.32, 4.21, 4.10, 3.99, 3.88, 3.77];

// Batter counting-stat prop (HR / total bases / H+R+RBI): Poisson around the
// per-game expectation, then regressed toward the market (see BATTER_SHRINK).
function priceBatterProp(prop, lambda) {
  return bestBookMarket(prop, (L) => 1 - poissonCdf(Math.floor(L), lambda), { shrink: BATTER_SHRINK, tiers: BATTER_TIERS });
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
async function proxy(upstream) {
  let r;
  try {
    r = await fetch(upstream, { headers: { accept: 'application/json' } });
  } catch (e) {
    return err('upstream fetch failed: ' + e, 502);
  }
  const body = await r.text();
  return cors(new Response(body, {
    status: r.status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=30',
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
