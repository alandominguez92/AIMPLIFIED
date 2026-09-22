// Local preview of the batter board during the odds outage. Serves the real
// static board and routes /api/* through the real worker module, with every
// Odds API call forced to the same 401 the live feed is returning. StatsAPI is
// real, so what renders is what the deployed fix will render.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };

const realFetch = globalThis.fetch;
// PREGAME=1 rewrites today's schedule so every game is a Preview starting in a
// few hours. The board is a pre-game product, so most of its states are
// unreachable once the slate goes final — this makes them testable at any hour
// without waiting for tomorrow's card.
const PREGAME = process.env.PREGAME === '1';
// CARDS=1 posts a 9-man lineup for the first two games, so every other
// qualifying batter on those clubs becomes a pulled row. That is the real
// sequence -- a card posts and everyone not on it stops being a candidate --
// and it is otherwise unreachable until a manager files one.
const CARDS = process.env.CARDS === '1';
// HEALTHY=1 serves a synthetic props feed instead of the 401. The live quota is
// exhausted, so the board's NORMAL state -- priced rows, edges, play/pass calls,
// a populated compare panel -- is otherwise unreachable and cannot be reviewed.
// Books price twelve hitters per club; with CARDS=1 the card names nine, so the
// other three become pulled rows and the alert bar has real content.
const HEALTHY = process.env.HEALTHY === '1';
// MLGAP=1: see the moneyline fixture below.
const MLGAP = process.env.MLGAP === '1';
const oddsFixture = { events: [], props: {}, ks: {}, h2h: [] };

// Same day the board will be on. worker.js rolls a day ahead once every game
// today is Final, and the fixture has to roll with it or the two end up priced
// off different slates. That mismatch is near-invisible from the batter board,
// which is why it survived: batter props join on ROSTER names and the same
// clubs play both days, so they keep matching. Strikeouts join on the STARTER's
// name (propByName[normName(pp.fullName)]), and the starters turn over
// completely, so every K row silently read "awaiting line" instead.
// PREGAME rewrites each game to Preview, so the board never rolls -- and the
// fixture must not roll either, or it would desync in the other direction.
const slateDay = (offset) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' })
  .format(new Date(Date.now() + offset * 86400000));
const slateGames = async (d) => {
  const sch = await (await realFetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${d}&hydrate=team,probablePitcher`)).json();
  return (((sch.dates || [])[0] || {}).games || []);
};

async function buildOddsFixture() {
  let day = slateDay(0);
  let games = await slateGames(day);
  const allFinal = games.length > 0 && games.every((g) => (g.status || {}).abstractGameState === 'Final');
  if (!PREGAME && (!games.length || allFinal)) {
    const nextDay = slateDay(1);
    const nextGames = await slateGames(nextDay);
    if (nextGames.length) { day = nextDay; games = nextGames; }
  }
  const now = Date.now();
  for (const [i, g] of games.entries()) {
    const id = 'ev' + g.gamePk;
    oddsFixture.events.push({ id, commence_time: new Date(now + (90 + i * 25) * 60000).toISOString(),
      home_team: g.teams.home.team.name, away_team: g.teams.away.team.name });
    const roster = async (teamId) => {
      const d = await (await realFetch(`https://statsapi.mlb.com/api/v1/teams/${teamId}/roster?rosterType=active`)).json();
      return (d.roster || []).filter((p) => (p.position || {}).abbreviation !== 'P').slice(0, 12)
        .map((p) => p.person.fullName);
    };
    const names = [...await roster(g.teams.away.team.id), ...await roster(g.teams.home.team.id)];
    // Lines set a little above a typical projection so unders carry the edge --
    // the only side this board posts, so it is what exercises play/pass.
    const bk = (key) => ({ key, markets: [{ key: 'batter_total_bases',
      outcomes: names.flatMap((n) => ([
        // PrizePicks a half-run higher: the case worth seeing is their number
        // disagreeing with the one the books priced.
        { name: 'Over', description: n, point: key === 'prizepicks' ? 2.5 : 1.5, price: key === 'draftkings' ? -115 : -108 },
        { name: 'Under', description: n, point: key === 'prizepicks' ? 2.5 : 1.5, price: key === 'draftkings' ? -105 : -112 },
      ])) }] });
    // PrizePicks rides along, deliberately on a DIFFERENT number than DK/FD so the
    // "PP hangs another line" case is visible in the preview.
    oddsFixture.props[id] = { bookmakers: ['draftkings', 'fanduel', 'pinnacle', 'novig', 'prizepicks'].map(bk) };

    // Strikeouts. Without these the K board has no priced state at all: every
    // row reads "awaiting line", so the market column, the edge, the tier and
    // the line tick on the projection bar are all unreachable. 4.5 sits near a
    // typical starter's projection, so the slate lands on both sides of it.
    const arms = ['away', 'home']
      .map((sd) => (g.teams[sd].probablePitcher || {}).fullName)
      .filter(Boolean);
    if (arms.length) {
      const kbk = (key) => ({ key, markets: [{ key: 'pitcher_strikeouts',
        outcomes: arms.flatMap((n) => ([
          { name: 'Over', description: n, point: key === 'prizepicks' ? 5.5 : 4.5, price: key === 'draftkings' ? -110 : -105 },
          { name: 'Under', description: n, point: key === 'prizepicks' ? 5.5 : 4.5, price: key === 'draftkings' ? -110 : -115 },
        ])) }] });
      oddsFixture.ks[id] = { bookmakers: ['draftkings', 'fanduel', 'pinnacle', 'novig', 'prizepicks'].map(kbk) };
    }

    // Moneyline, league-wide shape (not per-event). The home side is priced a
    // little short of the model so the win-probability bar's tick sits off its
    // fill — with both numbers equal the tick is suppressed by design and the
    // priced branch never renders.
    const mlbk = (key) => ({ key, markets: [{ key: 'h2h', outcomes: [
      { name: g.teams.home.team.name, price: key === 'pinnacle' ? -145 : -150 },
      // MLGAP=1 dangles every other underdog at +175 on DK/FD against Pinnacle's
      // +128 — a gap past ML_EDGE_CHECK — so the "check news" state can be seen.
      { name: g.teams.away.team.name, price: key === 'pinnacle' ? +128 : (MLGAP && i % 2 === 0 ? +175 : +125) },
    ] }] });
    oddsFixture.h2h.push({ id, commence_time: new Date(now + (90 + i * 25) * 60000).toISOString(),
      home_team: g.teams.home.team.name, away_team: g.teams.away.team.name,
      bookmakers: ['draftkings', 'fanduel', 'pinnacle', 'novig'].map(mlbk) });
  }
  // Counted per board, not once. A single "priced" number was the props count,
  // so a fixture that priced no strikeouts at all still reported a healthy line
  // and the K board's "awaiting line" rows looked like a UI bug.
  console.log(`healthy fixture: ${day} · ${games.length} games`
    + ` · props ${Object.keys(oddsFixture.props).length}`
    + ` · ks ${Object.keys(oddsFixture.ks).length}`
    + ` · h2h ${oddsFixture.h2h.length}`);
}
if (HEALTHY) await buildOddsFixture();

globalThis.fetch = async (u, o) => {
  const url = String(u);
  if (url.includes('api.the-odds-api.com')) {
    if (HEALTHY) {
      const J = (x) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.includes('/events?')) return J(oddsFixture.events);
      const m = url.match(/\/events\/(ev\d+)\/odds/);
      if (m) {
        // One endpoint, two feeds: the board asks for strikeouts and for the
        // batter markets on the same per-event path and tells them apart only
        // by the markets= parameter.
        const store = url.includes('markets=pitcher_strikeouts') ? oddsFixture.ks : oddsFixture.props;
        return J(store[m[1]] || { bookmakers: [] });
      }
      // League-wide /odds — h2h and the run line. Unmatched, this fell through
      // to the per-event branch and returned an empty book list, which is why
      // every moneyline row said "awaiting line" on a HEALTHY board.
      if (url.includes('/odds?')) return J(oddsFixture.h2h);
      return J({ bookmakers: [] });
    }
    return new Response(JSON.stringify({ message: 'Usage quota has been reached' }), {
      status: 401, headers: { 'content-type': 'application/json' },
    });
  }
  const r = await realFetch(u, o);
  if (!PREGAME || !url.includes('/schedule?')) return r;
  const j = await r.json();
  let t = Date.now() + 3 * 3600 * 1000;
  for (const g of (((j.dates || [])[0] || {}).games || [])) {
    g.status = { ...(g.status || {}), abstractGameState: 'Preview', detailedState: 'Scheduled' };
    g.gameDate = new Date(t).toISOString();
    t += 5 * 60 * 1000;
    if (g.teams) { delete g.teams.away.score; delete g.teams.home.score; }
  }
  if (CARDS) {
    for (const g of (((j.dates || [])[0] || {}).games || []).slice(0, 2)) {
      const card = async (teamId) => {
        const d = await (await realFetch(
          'https://statsapi.mlb.com/api/v1/teams/' + teamId + '/roster?rosterType=active')).json();
        return (d.roster || []).filter((p) => (p.position || {}).abbreviation !== 'P')
          .slice(0, 9).map((p) => ({ id: p.person.id, fullName: p.person.fullName }));
      };
      g.lineups = { awayPlayers: await card(g.teams.away.team.id), homePlayers: await card(g.teams.home.team.id) };
    }
  }
  return new Response(JSON.stringify(j), { status: 200, headers: { 'content-type': 'application/json' } });
};

const src = fs.readFileSync(BOARD + '/worker.js', 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));

// NFLDEMO=1 stands in for D1's nfl_lines so the NFL board and its player
// projections render locally. D1 lives only in Cloudflare, so without this the
// NFL views answer "no DB binding" and cannot be reviewed at all. Two slate days
// on purpose (a Thursday night game and a Sunday afternoon), which is how the
// one-slate-day filter shows up: only Thursday should be on the board.
const NFLDEMO = process.env.NFLDEMO === '1';
// SOCCERDEMO=1 stands in for D1's soccer_lines, the same way NFLDEMO does for
// nfl_lines: without it the soccer board answers "no DB binding" and the tab
// cannot be reviewed at all. Two leagues, two fixtures today and one next week,
// so the one-matchday filter is visible.
const SOCCERDEMO = process.env.SOCCERDEMO === '1';
const soccerLines = (() => {
  if (!SOCCERDEMO) return [];
  const now = Date.now();
  const at = (h) => new Date(now + h * 3600e3).toISOString();
  // SOCCERBREAK=1 pushes every fixture past the 36h window, which is what an
  // international break looks like -- the state the live board was in the day it
  // shipped, and the one the "next matchday is <date>" empty text is written for.
  const brk = process.env.SOCCERBREAK === '1';
  const fixtures = brk ? [
    { league: 'laliga', id: 'sx9', commence: at(18 * 24), home: 'Malaga', away: 'Espanyol' },
    { league: 'epl', id: 'sx8', commence: at(19 * 24), home: 'Arsenal', away: 'Leeds United' },
  ] : [
    { league: 'epl', id: 'sx1', commence: at(6), home: 'Liverpool', away: 'Bournemouth' },
    { league: 'laliga', id: 'sx2', commence: at(9), home: 'Real Madrid', away: 'Getafe' },
    { league: 'ucl', id: 'sx3', commence: at(120), home: 'Bayern Munich', away: 'Inter' },
  ];
  const prices = {
    pinnacle: { h: -140, d: 260, a: 380, o: -105, u: -115 },
    lowvig: { h: -138, d: 255, a: 390, o: -108, u: -112 },
    betonlineag: { h: -145, d: 250, a: 370, o: -110, u: -110 },
    draftkings: { h: -130, d: 285, a: 400, o: -102, u: -120 },
    fanduel: { h: -135, d: 275, a: 395, o: -105, u: -115 },
  };
  const rows = [];
  for (const f of fixtures) {
    for (const [book, p] of Object.entries(prices)) {
      const base = { league: f.league, event_id: f.id, commence: f.commence, home: f.home, away: f.away, book, captured_at: new Date(now - 3600e3).toISOString() };
      rows.push({ ...base, market: 'h2h', selection: f.home, point: null, price: p.h });
      rows.push({ ...base, market: 'h2h', selection: 'Draw', point: null, price: p.d });
      rows.push({ ...base, market: 'h2h', selection: f.away, point: null, price: p.a });
      rows.push({ ...base, market: 'totals', selection: 'Over', point: 2.5, price: p.o });
      rows.push({ ...base, market: 'totals', selection: 'Under', point: 2.5, price: p.u });
    }
  }
  return rows;
})();
const nflLines = (() => {
  if (!NFLDEMO) return [];
  const rows = [];
  const day = (n) => {
    const d = new Date(Date.now() + n * 3600e3);
    return d.toISOString();
  };
  const games = [
    { id: 'demo-thu', commence: day(9), away: 'Detroit Lions', home: 'Buffalo Bills' },
    { id: 'demo-sun', commence: day(80), away: 'Kansas City Chiefs', home: 'Los Angeles Chargers' },
  ];
  for (const g of games) {
    for (const [team, price] of [[g.away, -155], [g.home, 135]]) {
      // pinnacle + lowvig are the game-line sharp pool; DK/FD are execution.
      for (const book of ['pinnacle', 'lowvig', 'draftkings', 'fanduel']) {
        // DK/FD hang a slightly longer price than the sharp pool, so the value
        // cell and the new fair-vs-price bar have something real to draw.
        const p = (book === 'draftkings' || book === 'fanduel') ? (price > 0 ? price + 15 : price + 10) : price;
        rows.push({ event_id: g.id, commence: g.commence, home: g.home, away: g.away, market: 'h2h',
          player: team, point: null, book, over: p, under: null, captured_at: new Date().toISOString(), week: 3 });
      }
    }
    rows.push({ event_id: g.id, commence: g.commence, home: g.home, away: g.away, market: 'spreads',
      player: g.away, point: -3.5, book: 'draftkings', over: -110, under: null, captured_at: new Date().toISOString(), week: 3 });
    rows.push({ event_id: g.id, commence: g.commence, home: g.home, away: g.away, market: 'totals',
      player: null, point: 47.5, book: 'draftkings', over: -110, under: -110, captured_at: new Date().toISOString(), week: 3 });
  }
  return rows;
})();
const nflDb = {
  prepare: (sql) => {
    const st = { bind: () => st, run: async () => ({ meta: { changes: 0 } }),
      first: async () => (/COUNT\(\*\)/i.test(sql) ? { n: nflLines.length } : null),
      all: async () => ({ results: /FROM nfl_lines/i.test(sql) ? nflLines
        : /FROM soccer_lines/i.test(sql) ? soccerLines : [] }) };
    return st;
  },
  batch: async () => [],
};
const env = {
  ODDS_API_KEY: 'test-key',
  DB: (NFLDEMO || SOCCERDEMO) ? nflDb : null,
  // The priors and schedule the NFL projections read, served off disk.
  ASSETS: { fetch: async (r) => {
    const name = new URL(r.url).pathname;
    const file = path.join(BOARD, name);
    if (!fs.existsSync(file)) return new Response('missing', { status: 404 });
    return new Response(fs.readFileSync(file, 'utf8'), { status: 200, headers: { 'content-type': 'application/json' } });
  } },
};

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const cache = new Map();

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:8788');
  if (url.pathname === '/api/track-record') {
    // D1 lives only in Cloudflare, so the record proxies from production. It is
    // a read-only endpoint that makes no upstream Odds call, so this costs
    // nothing while the quota is out.
    const r = await realFetch('https://aimplified.delexe.workers.dev/api/track-record?cb=' + Math.random());
    const body = await r.text();
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    return res.end(body);
  }
  if (url.pathname.startsWith('/api/')) {
    try {
      // Cache API responses so repeated renders don't re-hit StatsAPI.
      const key = url.pathname + url.search;
      let payload = cache.get(key);
      if (!payload) {
        const wres = await mod.default.fetch(new Request('https://x' + key), env, { waitUntil: () => {} });
        payload = { status: wres.status, body: await wres.text() };
        cache.set(key, payload);
      }
      res.writeHead(payload.status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      return res.end(payload.body);
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: String(e && e.stack || e) }));
    }
  }
  const rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.join(BOARD, rel);
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
  if (rel === '/index.html') {
    // app.js treats localhost as mock mode unless an API base is set explicitly,
    // so the preview would render demo data instead of the worker's response.
    const html = fs.readFileSync(file, 'utf8')
      .replace('window.AIMPLIFIED_API_BASE = "";', 'window.AIMPLIFIED_API_BASE = "same-origin";');
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(html);
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'text/plain' });
  fs.createReadStream(file).pipe(res);
}).listen(8788, () => console.log('board preview on http://localhost:8788'));
