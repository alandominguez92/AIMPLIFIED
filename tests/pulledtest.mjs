// Verifies the pulled-row contract against the real worker.
//
// Reproduces the sequence that actually produces one: books price a batter in
// the morning, and at 3pm the card posts without him. That needs a HEALTHY props
// feed — the player universe has to come from prices, not from the card, or
// everyone on the board is on the card by construction and nothing can be
// pulled. An earlier version of this test seeded from the card and passed only
// because of a stray name collision.
import fs from 'node:fs';
import path from 'node:path';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const realFetch = globalThis.fetch;

const slate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const sched = await (await realFetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${slate}&hydrate=team`)).json();
const games = (((sched.dates || [])[0] || {}).games || []).slice(0, 2);
if (!games.length) { console.log('no games on the slate today — cannot run'); process.exit(0); }

// Real hitters, so the season-stats join is real.
const rosterOf = async (teamId) => {
  const d = await (await realFetch(`https://statsapi.mlb.com/api/v1/teams/${teamId}/roster?rosterType=active`)).json();
  return (d.roster || []).filter((p) => (p.position || {}).abbreviation !== 'P')
    .map((p) => ({ id: p.person.id, fullName: p.person.fullName }));
};

const NOW = Date.now();
const events = [], propsByEvent = {}, cardByGamePk = {};
let pricedTotal = 0, cardedTotal = 0;
for (const [i, g] of games.entries()) {
  const id = 'ev' + g.gamePk;
  events.push({ id, commence_time: new Date(NOW + (90 + i * 30) * 60000).toISOString(),
    home_team: g.teams.home.team.name, away_team: g.teams.away.team.name });

  const away = await rosterOf(g.teams.away.team.id);
  const home = await rosterOf(g.teams.home.team.id);
  // Books price twelve per club; the card names only the first nine. The three
  // priced-but-not-carded are the rows that must come back pulled.
  const priced = [...away.slice(0, 12), ...home.slice(0, 12)];
  pricedTotal += priced.length;
  cardByGamePk[g.gamePk] = { awayPlayers: away.slice(0, 9), homePlayers: home.slice(0, 9) };
  cardedTotal += 18;

  const mk = (key) => ({ key, markets: [{ key: 'batter_total_bases',
    outcomes: priced.flatMap((p) => ([
      { name: 'Over', description: p.fullName, point: 1.5, price: key === 'draftkings' ? -115 : -108 },
      { name: 'Under', description: p.fullName, point: 1.5, price: key === 'draftkings' ? -105 : -112 },
    ])) }] });
  propsByEvent[id] = { bookmakers: ['draftkings', 'fanduel', 'pinnacle', 'novig'].map(mk) };
}

globalThis.fetch = async (u, o) => {
  const url = String(u);
  const J = (x) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.includes('api.the-odds-api.com')) {
    if (url.includes('/events?')) return J(events);
    const m = url.match(/\/events\/(ev\d+)\/odds/);
    return J(m && propsByEvent[m[1]] ? propsByEvent[m[1]] : { bookmakers: [] });
  }
  const r = await realFetch(u, o);
  if (!url.includes('/schedule?')) return r;
  // Post the card, and make every game a Preview a while out.
  const j = await r.json();
  let t = NOW + 90 * 60000;
  for (const g of (((j.dates || [])[0] || {}).games || [])) {
    g.status = { ...(g.status || {}), abstractGameState: 'Preview', detailedState: 'Scheduled' };
    g.gameDate = new Date(t).toISOString(); t += 30 * 60000;
    if (g.teams) { delete g.teams.away.score; delete g.teams.home.score; }
    if (cardByGamePk[g.gamePk]) g.lineups = cardByGamePk[g.gamePk];
  }
  return new Response(JSON.stringify(j), { status: 200, headers: { 'content-type': 'application/json' } });
};

const src = fs.readFileSync(BOARD + '/worker.js', 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const res = await mod.default.fetch(new Request('https://x/api/batters'),
  { ODDS_API_KEY: 'k', DB: null }, { waitUntil: () => {} });
const rows = (await res.json()).rows || [];

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

const pulled = rows.filter((r) => r.pulled);
const active = rows.filter((r) => !r.pulled);
console.log(`priced by books: ${pricedTotal} · named on the card: ${cardedTotal}`);
console.log(`rows: ${rows.length}  active: ${active.length}  pulled: ${pulled.length}`);
if (pulled.length) {
  const p = pulled[0];
  console.log('sample pulled row:');
  for (const k of ['name', 'team', 'tier', 'pulled', 'pick', 'odds', 'edge', 'projVal', 'hasPriced', 'wasTier', 'wasEdge'])
    console.log('  ' + k.padEnd(11) + JSON.stringify(p[k]));
}

console.log('\n-- a priced batter left off the card still reaches the board --');
ok(pulled.length > 0, `rows marked pulled are returned (${pulled.length})`);
ok(active.length > 0, `carded batters still price normally (${active.length})`);

console.log('\n-- nothing conditioned on tonight survives --');
for (const f of ['odds', 'edge', 'projVal', 'modelOver', 'fairOver', 'line', 'side', 'marketLabel', 'metric', 'oddsBooks', 'moveSincePost']) {
  ok(pulled.every((r) => r[f] == null), `${f} is null on every pulled row`);
}
ok(pulled.every((r) => r.pick === '—' && r.interval === '—'), 'pick and interval read as absent');
ok(pulled.every((r) => r.tier === 'out'), 'tier is "out", not play/pass/model');
ok(pulled.every((r) => r.hasPriced === false), 'no pulled row claims to be priced');

console.log('\n-- what the alert bar needs, and only it --');
ok(pulled.every((r) => 'wasTier' in r), 'wasTier is carried for the alert copy');
ok(pulled.some((r) => r.wasEdge != null || r.wasTier), 'at least one says what the board lost');
ok(pulled.every((r) => r.name && r.team), 'identity survives so the alert can name him');

console.log('\n-- the player, as opposed to tonight, survives --');
ok(pulled.every((r) => Array.isArray(r.stats) && r.stats.length === 4), 'season percentile bars are kept');

console.log('\n-- a pulled row can never be posted --');
ok(pulled.every((r) => !r.hasPriced), 'the logging filter (hasPriced) admits none of them');
ok(pulled.every((r) => !['play', '1', '2', '3'].includes(String(r.tier))), 'none can pass a play-tier test');

console.log('\n-- active rows are untouched --');
ok(active.every((r) => r.pulled !== true), 'no active row is marked pulled');
ok(active.every((r) => r.tier !== 'out'), 'no active row carries the out tier');
ok(active.some((r) => r.odds != null), 'carded batters still carry a price');

if (pulled.length) {
  console.log('\npulled:');
  pulled.slice(0, 8).forEach((r) => console.log(
    `  ${String(r.name).padEnd(20)} ${String(r.team).padEnd(4)} ${r.matchup}  wasTier=${r.wasTier}`));
}
console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
