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
const oddsFixture = { events: [], props: {}, ks: {}, h2h: [] };

async function buildOddsFixture() {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const sch = await (await realFetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${day}&hydrate=team,probablePitcher`)).json();
  const games = (((sch.dates || [])[0] || {}).games || []);
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
        { name: 'Over', description: n, point: 1.5, price: key === 'draftkings' ? -115 : -108 },
        { name: 'Under', description: n, point: 1.5, price: key === 'draftkings' ? -105 : -112 },
      ])) }] });
    oddsFixture.props[id] = { bookmakers: ['draftkings', 'fanduel', 'pinnacle', 'novig'].map(bk) };

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
          { name: 'Over', description: n, point: 4.5, price: key === 'draftkings' ? -110 : -105 },
          { name: 'Under', description: n, point: 4.5, price: key === 'draftkings' ? -110 : -115 },
        ])) }] });
      oddsFixture.ks[id] = { bookmakers: ['draftkings', 'fanduel', 'pinnacle', 'novig'].map(kbk) };
    }

    // Moneyline, league-wide shape (not per-event). The home side is priced a
    // little short of the model so the win-probability bar's tick sits off its
    // fill — with both numbers equal the tick is suppressed by design and the
    // priced branch never renders.
    const mlbk = (key) => ({ key, markets: [{ key: 'h2h', outcomes: [
      { name: g.teams.home.team.name, price: key === 'pinnacle' ? -145 : -150 },
      { name: g.teams.away.team.name, price: key === 'pinnacle' ? +128 : +125 },
    ] }] });
    oddsFixture.h2h.push({ id, commence_time: new Date(now + (90 + i * 25) * 60000).toISOString(),
      home_team: g.teams.home.team.name, away_team: g.teams.away.team.name,
      bookmakers: ['draftkings', 'fanduel', 'pinnacle', 'novig'].map(mlbk) });
  }
  console.log('healthy fixture: ' + games.length + ' games, ' + Object.keys(oddsFixture.props).length + ' priced');
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
const env = { ODDS_API_KEY: 'test-key', DB: null };

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
