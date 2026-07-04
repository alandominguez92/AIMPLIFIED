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
const LINE_SHRINK = 0.20;  // fraction of the projection pulled toward the line

export default {
  async fetch(request, env, ctx) {
    const p = new URL(request.url).pathname;

    if (p === '/api/odds' || p === '/api/scores' || p === '/api/hitters' || p === '/api/pitchers' || p === '/api/board' || p === '/api/track-record' || p === '/api/injuries') {
      if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));

      if (p === '/api/hitters') return hitters();
      if (p === '/api/pitchers') return pitchers();
      if (p === '/api/board') return board(env, ctx);
      if (p === '/api/track-record') return trackRecord(env);
      if (p === '/api/injuries') return injuries();

      const key = env.ODDS_API_KEY;
      if (!key) return err('ODDS_API_KEY is not configured', 500);
      const upstream = p === '/api/odds'
        ? `${ODDS}/odds?apiKey=${key}&regions=us&markets=h2h,totals&oddsFormat=american&dateFormat=iso`
        : `${ODDS}/scores?apiKey=${key}&daysFrom=1&dateFormat=iso`;
      return proxy(upstream);
    }

    // Everything else: serve the static site.
    return env.ASSETS.fetch(request);
  },
};

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

  return cors(json(rows, 300));
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
              const mk = (bm.markets || []).find((m) => m.key === 'pitcher_strikeouts');
              if (!mk) continue;
              for (const oc of (mk.outcomes || [])) {
                const nm = normName(oc.description);
                if (!nm) continue;
                const cur = propByName[nm] || {};
                if (oc.point != null) cur.point = oc.point;
                if (oc.name === 'Over') cur.over = oc.price;
                else if (oc.name === 'Under') cur.under = oc.price;
                propByName[nm] = cur;
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

  const rows = games.map((g) => {
    const away = g.teams.away, home = g.teams.home;
    const projFor = (side) => {
      const pp = g.teams[side].probablePitcher;
      if (!pp || !pp.id) return null;
      const st = pmap[pp.id] || {};
      const oppTeam = g.teams[side === 'away' ? 'home' : 'away'].team;
      const oppK = teamK[oppTeam.id] || lgK;
      const k9 = st.k9 > 0 ? st.k9 : 8.5;
      const expIP = clamp(st.gs > 0 ? st.ip / st.gs : 5.5, 4, 6.8);
      const projK = (k9 * expIP / 9) * (lgK > 0 ? oppK / lgK : 1);
      const sd = Math.sqrt(Math.max(projK, 1) * DISPERSION);

      // Market: compare the projection to the real strikeout line.
      let market = null;
      const prop = propByName[normName(pp.fullName)];
      if (prop && prop.point != null && (prop.over != null || prop.under != null)) {
        const L = prop.point;
        // Overdispersed normal, with the projection regressed toward the line.
        const lam = (1 - LINE_SHRINK) * projK + LINE_SHRINK * L;
        const sigma = Math.sqrt(Math.max(lam, 1) * DISPERSION);
        const pOver = 1 - normCdf((L - lam) / sigma); // P(K over the line)
        const impO = prop.over != null ? amProb(prop.over) : null;
        const impU = prop.under != null ? amProb(prop.under) : null;
        let fairOver;
        if (impO != null && impU != null) { const v = impO + impU; fairOver = v > 0 ? impO / v : impO; }
        else if (impO != null) fairOver = impO;
        else fairOver = 1 - impU;
        const edgeOver = pOver - fairOver;
        const over = edgeOver >= 0;
        const price = over ? prop.over : prop.under;
        const edgePts = round1(Math.abs(edgeOver) * 100);
        market = {
          line: L,
          side: over ? 'Over' : 'Under',
          price: price != null ? price : null,
          edge: edgePts,
          modelOver: round1(pOver * 100),
          tier: edgePts >= 5 ? 1 : edgePts >= 3 ? 2 : edgePts >= 1.5 ? 3 : 'pass',
        };
      }

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
      edge: lead ? lead.market.edge : null,
      tier: lead ? lead.market.tier : 'model',
      interval: lead ? `${lead.lo} – ${lead.hi}` : (projLean ? `${projLean.lo} – ${projLean.hi}` : '—'),
      pitchers,
    };
  }).sort((a, b) => a.timeMs - b.timeMs);

  // Log tonight's priced picks to the track record (idempotent) — non-blocking.
  if (env && env.DB) {
    const write = logPicks(env.DB, rows, date).catch(() => {});
    if (ctx && ctx.waitUntil) ctx.waitUntil(write);
  }

  return cors(json(rows, 300)); // 5 min — props are the expensive part
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
    await gradeUngraded(env);
    const res = await env.DB.prepare('SELECT * FROM picks').all();
    return cors(json(buildTrackRecord(res.results || []), 120));
  } catch (e) {
    return cors(json({ empty: true, logged: 0, error: String(e) }, 60));
  }
}

async function ensureSchema(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS picks (
    date TEXT, game_id TEXT, pitcher_id INTEGER, pitcher TEXT, team TEXT,
    line REAL, side TEXT, price INTEGER, proj REAL, model_over REAL,
    edge REAL, tier TEXT, actual_k INTEGER, result TEXT,
    PRIMARY KEY (date, game_id, pitcher_id)
  )`).run();
}

async function logPicks(db, rows, date) {
  await ensureSchema(db);
  const stmts = [];
  for (const r of rows) {
    // Only log genuine pre-game picks — never a game already under way/final.
    if (r.status !== 'Preview') continue;
    for (const p of (r.pitchers || [])) {
      if (!p.market || p.market.price == null || p.id == null) continue;
      stmts.push(db.prepare(
        `INSERT OR IGNORE INTO picks (date,game_id,pitcher_id,pitcher,team,line,side,price,proj,model_over,edge,tier)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(date, r.id, p.id, p.name, p.team, p.market.line, p.market.side, p.market.price, p.proj, p.market.modelOver, p.market.edge, String(p.market.tier)));
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
    calibration,
  };
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
// /api/injuries — real recent injured-list moves from MLB StatsAPI
// transactions (last 3 days), newest first. Shaped like the alert banner.
// -------------------------------------------------------------------------
async function injuries() {
  const end = slateDate();
  const start = slateDateOffset(-3);
  let data;
  try {
    const r = await fetch(`${STATS}/transactions?startDate=${start}&endDate=${end}`, { headers: { accept: 'application/json' } });
    if (!r.ok) return cors(json([], 300));
    data = await r.json();
  } catch (e) { return cors(json([], 300)); }

  // Batters only — pitcher IL moves don't change tonight's known starters,
  // but a hurt/scratched hitter shifts the opposing lineup's strikeout profile.
  const txns = (data.transactions || []).filter((t) => {
    const d = t.description || '';
    return /injured list/i.test(d) && !isPitcherMove(d);
  });
  txns.sort((a, b) => String(b.effectiveDate || b.date || '').localeCompare(String(a.effectiveDate || a.date || '')));

  const seen = new Set();
  const rows = [];
  for (const t of txns) {
    const text = String(t.description || '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    rows.push({ text, time: txnDateLabel(t.effectiveDate || t.date) });
    if (rows.length >= 8) break;
  }
  return cors(json(rows, 600)); // 10 min
}

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
