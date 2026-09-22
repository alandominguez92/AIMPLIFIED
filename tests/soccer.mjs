// Soccer game lines: three leagues, context only, twice a matchday.
//
// The 2026-09-20 coverage probe decided the shape. Pinnacle, lowvig and
// betonlineag quote 1X2 and goals totals for EPL, La Liga and the Champions
// League; DK and FanDuel quote them too; PrizePicks is absent from soccer
// entirely; and player props come back over-only from one book, so there is no
// under to fade and nothing to price. Hence: a sharp fair line, the best price
// against it, and the gap — no model, no props, no plays.
//
// The parts worth pinning are the ones that would be wrong quietly: a 1X2 fair
// must de-vig across THREE outcomes (a two-way de-vig would silently ignore the
// draw and sum past 1), a price that has not moved must not be written again,
// and the board must show one matchday rather than the next fortnight.
import fs from 'node:fs';
import path from 'node:path';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };

const SOON = new Date(Date.now() + 6 * 3600e3).toISOString();      // today
const LATER = new Date(Date.now() + 5 * 86400e3).toISOString();     // next week
// Pinnacle and lowvig agree; betonlineag is a touch different so the median has
// something to do. DK/FD hang a longer price on the draw than the sharps imply.
const PRICES = {
  pinnacle:    { home: -140, draw: 260, away: 380, over: -105, under: -115 },
  lowvig:      { home: -138, draw: 255, away: 390, over: -108, under: -112 },
  betonlineag: { home: -145, draw: 250, away: 370, over: -110, under: -110 },
  draftkings:  { home: -130, draw: 285, away: 400, over: -102, under: -120 },
  fanduel:     { home: -135, draw: 275, away: 395, over: -105, under: -115 },
};
const ev = (id, commence, home, away) => ({
  id, commence_time: commence, home_team: home, away_team: away,
  bookmakers: Object.entries(PRICES).map(([key, p]) => ({
    key,
    markets: [
      { key: 'h2h', outcomes: [{ name: home, price: p.home }, { name: 'Draw', price: p.draw }, { name: away, price: p.away }] },
      { key: 'totals', outcomes: [{ name: 'Over', point: 2.5, price: p.over }, { name: 'Under', point: 2.5, price: p.under }] },
    ],
  })),
});
const EVENTS = {
  soccer_epl: [ev('epl1', SOON, 'Liverpool', 'Bournemouth'), ev('epl2', LATER, 'Arsenal', 'Chelsea')],
  soccer_spain_la_liga: [ev('ll1', SOON, 'Real Madrid', 'Getafe')],
  soccer_uefa_champs_league: [],
};

let calls = [];
const badPaths = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, o) => {
  const url = String(u);
  const J = (x) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json', 'x-requests-last': '2' } });
  if (url.includes('api.the-odds-api.com')) {
    // Match the path EXACTLY, the way the API does. A loose /sports/<key>/odds
    // regex also matches .../sports/baseball_mlb/sports/soccer_epl/odds, which
    // is what shipped: the soccer calls were built off the MLB base constant,
    // every request 404'd, and because a 404 carries no quota header the usage
    // ledger recorded nothing either. The stub answered it happily. Anything
    // that is not a real path now 404s here too.
    const u = new URL(url);
    const m = u.pathname.match(/^\/v4\/sports\/([a-z_]+)\/(odds|events)$/);
    if (m) {
      calls.push({ sport: m[1], kind: m[2], path: u.pathname, markets: u.searchParams.get('markets'), books: u.searchParams.get('bookmakers') });
      return J(EVENTS[m[1]] || []);
    }
    badPaths.push(u.pathname);
    return new Response('{"message":"Not found"}', { status: 404, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(u, o);
};

// D1 stub with a working soccer_lines table and feed_cache (for the day counter).
const lines = [];
const cache = new Map();
const run = (sql, a) => {
  if (/^\s*INSERT INTO soccer_lines/i.test(sql)) {
    const [league, event_id, commence, home, away, market, selection, point, book, price, captured_at] = a;
    lines.push({ league, event_id, commence, home, away, market, selection, point, book, price, captured_at });
  } else if (/^INSERT OR IGNORE INTO feed_cache/i.test(sql)) {
    if (!cache.has(a[0])) cache.set(a[0], { data: null, updated_at: 0, claimed_until: 0 });
  } else if (/^INSERT OR REPLACE INTO feed_cache/i.test(sql)) {
    cache.set(a[0], { data: a[1], updated_at: a[2], claimed_until: 0 });
  }
  return { meta: { changes: 1 } };
};
const db = {
  prepare: (sql) => { const st = { sql, args: [], bind: (...x) => { st.args = x; return st; },
    run: async () => run(sql, st.args),
    first: async () => (/FROM feed_cache WHERE key=\?/i.test(sql)
      ? ((cache.get(st.args[0]) || {}).data ? { data: cache.get(st.args[0]).data, updated_at: cache.get(st.args[0]).updated_at } : null) : null),
    all: async () => {
      if (!/FROM soccer_lines/i.test(sql)) return { results: [] };
      const lg = st.args.length > 1 ? st.args[0] : null;
      return { results: lines.filter((r) => !lg || r.league === lg) };
    } };
    return st; },
  batch: async (l) => (l || []).map((x) => run(x.sql, x.args)),
};
const env = { ODDS_API_KEY: 'k', DB: db };
const ctx = { waitUntil: (p) => { if (p && p.then) p.catch(() => {}); } };

const src = fs.readFileSync(BOARD + '/worker.js', 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const hit = async (u) => (await mod.default.fetch(new Request('https://x' + u), env, ctx)).json();

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

const ing = await hit('/api/soccer-ingest');
console.log(`  ingest: ${ing.wrote} rows, ${ing.credits} credits, leagues ${ing.leagues.map((l) => l.league + ':' + l.events).join(' ')}\n`);
ok(ing.wrote > 0 && lines.length === ing.wrote, `lines are stored (${lines.length})`);
ok(calls.length === ing.leagues.length && calls.length > 0 && calls.every((c) => c.markets === 'h2h,totals'),
  `one call per league, both markets (${calls.length} calls for ${ing.leagues.length} leagues, markets ${[...new Set(calls.map((c) => c.markets))].join(',') || 'none'})`);
ok(calls.length > 0 && calls.every((c) => (c.books || '').split(',').length <= 10), 'book list stays inside one region-equivalent');
ok(!badPaths.length && calls.length > 0 && calls.every((c) => c.path === `/v4/sports/${c.sport}/odds` || c.path === `/v4/sports/${c.sport}/events`),
  `every call goes to a real Odds API path (${badPaths.length ? 'bad: ' + [...new Set(badPaths)].join(' ') : [...new Set(calls.map((c) => c.path))].join(' ')})`);
ok(lines.some((r) => r.event_id === 'epl2'), "next week's fixture is stored too (the board filters, not the ingest)");

// Re-ingest with nothing moved: append-on-change means no new rows.
const before = lines.length;
calls = [];
const again = await hit('/api/soccer-ingest');
ok(lines.length === before && again.unchanged > 0,
  `a second pass with unchanged prices writes nothing (${lines.length - before} new, ${again.unchanged} unchanged)`);

const board = await hit('/api/soccer-board');
const g = (board.games || [])[0];
console.log(`\n  board: ${board.games.length} of ${board.gamesAllUpcoming} fixtures on ${board.slateDay}`);
if (g) {
  console.log(`   ${g.away} @ ${g.home} (${g.leagueLabel}) sharpN ${g.sharpN}`);
  for (const p of g.oneXtwo) console.log(`     ${String(p.selection).padEnd(12)} fair ${p.fair}%  best ${p.price} (${p.book})  implied ${p.implied}%  value ${p.value}`);
  console.log(`     total ${g.total && g.total.point}: over fair ${g.total && g.total.overFair}% @ ${g.total && g.total.overPrice}, under fair ${g.total && g.total.underFair}% @ ${g.total && g.total.underPrice}`);
}
ok(!!g && g.oneXtwo.length === 3, 'each fixture carries all three 1X2 outcomes, draw included');
const fairSum = g ? g.oneXtwo.reduce((s, p) => s + (p.fair || 0), 0) : 0;
ok(Math.abs(fairSum - 100) < 0.6, `the 1X2 fair line sums to 100% — de-vigged across three outcomes, not two (${fairSum.toFixed(1)}%)`);
ok(g && g.sharpN >= 2 && g.fairSrc === 'sharp-pool', `priced against the sharp pool (${g && g.sharpN} books)`);
ok(g && g.oneXtwo.every((p) => p.book === 'draftkings' || p.book === 'fanduel' || p.price == null),
  'the price shown is one you could actually take (DK/FD), never the sharp book');
ok(g && g.total && g.total.point === 2.5 && g.total.overFair != null && Math.abs((g.total.overFair + g.total.underFair) - 100) < 0.6,
  `the goals total is de-vigged two-way and sums to 100% (${g && g.total && (g.total.overFair + g.total.underFair).toFixed(1)}%)`);
ok(board.games.length === 2 && board.gamesAllUpcoming === 3,
  `one matchday only: today's two fixtures, not next week's (${board.games.length} of ${board.gamesAllUpcoming})`);
ok(/next matchday/.test(board.slateNote || ''), `the payload says what it filtered (${board.slateNote})`);
ok((board.games || []).some((x) => x.league === 'epl') && (board.games || []).some((x) => x.league === 'laliga'),
  'leagues share one board and are labelled');


// ---- a fixture far out ----------------------------------------------------------------
// The first rule here was a 36h window, and it was the wrong test. It blanked the
// board whenever the next fixtures sat 38 hours away — most of a Monday, and
// every midweek — while a hundred fully priced fixtures sat in the store. What
// made a lone fixture useless was never its distance; it was having one book on
// it and no fair line behind it.
//
// So: priced far out still shows. Unpriced does not, however close.
lines.splice(0);
calls = [];
const FAR = new Date(Date.now() + 18 * 86400e3).toISOString();
EVENTS.soccer_epl = [ev('far1', FAR, 'Arsenal', 'Leeds United')];
EVENTS.soccer_spain_la_liga = [];
await hit('/api/soccer-ingest');
const far = await hit('/api/soccer-board');
console.log(`\n  far but priced: ${far.games.length} shown — "${far.slateNote}"`);
ok(far.games.length === 1 && far.empty === false,
  `a fixture 18 days out still shows when the sharp pool has priced it — a blank board with a hundred priced fixtures behind it helps nobody (${far.games.length} shown)`);
ok(far.games[0] && far.games[0].sharpN >= 2 && far.games[0].lead && far.games[0].lead.fair != null,
  `and it shows because it has a fair line, not because it is close (sharp ${far.games[0] && far.games[0].sharpN})`);

// Now the same fixture with a single book on it: no fair line, nothing to show.
lines.splice(0);
const solo = JSON.parse(JSON.stringify(EVENTS.soccer_epl[0]));
solo.bookmakers = solo.bookmakers.filter((b) => b.key === 'draftkings');
EVENTS.soccer_epl = [solo];
await hit('/api/soccer-ingest');
const thin = await hit('/api/soccer-board');
console.log(`  one book only:  ${thin.games.length} shown — "${thin.slateNote}"`);
ok(thin.games.length === 0 && thin.empty === true,
  `one book is not a fair line, so it is not a board (${thin.games.length} shown)`);
ok(thin.nextDay === new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.parse(FAR))),
  `the board names the day instead of implying the season stopped (${thin.nextDay})`);
ok(/none quoted by two sharp books/.test(thin.slateNote || ''),
  `and says why it is empty, which is not the same as "no fixtures" (${thin.slateNote})`);

EVENTS.soccer_epl = [ev('far1', FAR, 'Arsenal', 'Leeds United')];
lines.splice(0);
await hit('/api/soccer-ingest');
const allq = await hit('/api/soccer-board?all=1');
ok(allq.games.length === 1, `?all=1 still shows them, for reading the store without a paid ingest (${allq.games.length})`);

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
