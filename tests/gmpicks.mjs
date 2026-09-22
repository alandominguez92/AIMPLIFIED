// NFL and soccer game lines are written down and graded.
//
// The MLB moneyline has 763 graded rows behind it. NFL and soccer had none —
// the boards computed a fair number, a best price and a gap every time anyone
// loaded them, and then threw all three away. This keeps them, in one table,
// because they are one shape: a side, the sharp pool's number for it, the price
// standing against that number, and what happened.
//
// The parts that would be wrong quietly: a soccer draw is a side you can be on
// and has to grade as one (a two-outcome grader scores every draw as a loss for
// both teams); an NFL tie is a push, because no draw price is offered; and the
// grader has to match "Bournemouth" to ESPN's "AFC Bournemouth" or every row
// stays ungraded forever while looking merely quiet.
import fs from 'node:fs';
import path from 'node:path';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };

const HOUR = 3600e3;
const RealDate = Date;
const NOW = RealDate.parse('2026-09-22T19:00:00Z');   // Tuesday, noon Pacific
// The boards show ONE slate day, taken from the earliest remaining kickoff. With
// kickoffs placed against the real clock, a run near midnight Pacific puts them
// on two different days and the board drops half the fixture — a test that
// passes all afternoon and fails at 11pm. Freeze the clock instead.
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
};
const iso = (ms) => new RealDate(ms).toISOString();
const SOON = iso(NOW + 6 * HOUR);                 // 6pm Pacific, not yet kicked off
const GONE = iso(NOW - 2 * HOUR);                 // 10am Pacific, already started
const ptDay = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new RealDate(ms));

// ---- soccer fixtures -------------------------------------------------------------------
// Three sharp books so there is a fair line; DK/FD for the executable price.
const SP = {
  pinnacle:    { home: -140, draw: 260, away: 380, over: -105, under: -115 },
  lowvig:      { home: -138, draw: 255, away: 390, over: -108, under: -112 },
  betonlineag: { home: -145, draw: 250, away: 370, over: -110, under: -110 },
  draftkings:  { home: -130, draw: 285, away: 400, over: -102, under: -120 },
  fanduel:     { home: -135, draw: 275, away: 395, over: -105, under: -115 },
};
const sEv = (id, commence, home, away) => ({
  id, commence_time: commence, home_team: home, away_team: away,
  bookmakers: Object.entries(SP).map(([key, p]) => ({
    key,
    markets: [
      { key: 'h2h', outcomes: [{ name: home, price: p.home }, { name: 'Draw', price: p.draw }, { name: away, price: p.away }] },
      { key: 'totals', outcomes: [{ name: 'Over', point: 2.5, price: p.over }, { name: 'Under', point: 2.5, price: p.under }] },
    ],
  })),
});
// The odds feed's names, which are NOT ESPN's.
const SOCCER_EVENTS = {
  soccer_epl: [sEv('s1', SOON, 'Bournemouth', 'Liverpool')],
  soccer_spain_la_liga: [sEv('s2', SOON, 'Malaga', 'Getafe')],
  soccer_uefa_champs_league: [],
};

// ---- NFL lines -------------------------------------------------------------------------
const NFL_GAMES = [
  { id: 'n1', commence: SOON, away: 'New York Giants', home: 'Los Angeles Rams' },
  { id: 'n2', commence: SOON, away: 'Detroit Lions',   home: 'Buffalo Bills' },
  { id: 'n3', commence: GONE, away: 'Chicago Bears',   home: 'Minnesota Vikings' }, // already kicked off
];
const nflRows = [];
for (const g of NFL_GAMES) {
  for (const [team, price] of [[g.away, 240], [g.home, -290]]) {
    for (const book of ['pinnacle', 'lowvig', 'betonlineag', 'draftkings', 'fanduel']) {
      nflRows.push({ event_id: g.id, commence: g.commence, home: g.home, away: g.away, market: 'h2h',
        player: team, point: null, book, over: price, under: null, captured_at: iso(NOW - HOUR), week: 3 });
    }
  }
}

// ---- ESPN finals -----------------------------------------------------------------------
// Liverpool (away) win, a La Liga draw, a Rams (home) win, and an NFL tie.
const espnEvent = (home, away, hs, as, status, homeAb, awayAb) => ({
  status: { type: { name: status } },
  competitions: [{ competitors: [
    { homeAway: 'home', team: { displayName: home, abbreviation: homeAb }, score: String(hs) },
    { homeAway: 'away', team: { displayName: away, abbreviation: awayAb }, score: String(as) },
  ] }],
});
const ESPN = {
  'eng.1': [espnEvent('AFC Bournemouth', 'Liverpool', 0, 1, 'STATUS_FULL_TIME')],
  'esp.1': [espnEvent('Málaga', 'Getafe', 1, 1, 'STATUS_FULL_TIME')],
  'uefa.champions': [],
  nfl: [
    espnEvent('Los Angeles Rams', 'New York Giants', 27, 20, 'STATUS_FINAL', 'LAR', 'NYG'),
    espnEvent('Buffalo Bills', 'Detroit Lions', 17, 17, 'STATUS_FINAL', 'BUF', 'DET'),
  ],
};

let espnCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, o) => {
  const url = String(u);
  const J = (x) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json', 'x-requests-last': '2', 'x-requests-remaining': '100' } });
  if (url.includes('cdn.espn.com')) {
    espnCalls.push(url);
    const lg = (url.match(/league=([a-z0-9.]+)/) || [])[1];
    return J({ content: { sbData: { events: url.includes('/nfl/') ? ESPN.nfl : (ESPN[lg] || []) } } });
  }
  if (url.includes('api.the-odds-api.com')) {
    const m = new URL(url).pathname.match(/^\/v4\/sports\/([a-z_]+)\/(odds|events)$/);
    if (m) return J(SOCCER_EVENTS[m[1]] || []);
    return J([]);
  }
  return realFetch(u, o);
};

// ---- D1 stub ---------------------------------------------------------------------------
const soccerLines = [];
const gm = new Map();
const cache = new Map();
const gmKey = (a) => `${a[0]}|${a[1]}|${a[2]}`;
const run = (sql, a) => {
  if (/^\s*INSERT INTO soccer_lines/i.test(sql)) {
    const [league, event_id, commence, home, away, market, selection, point, book, price, captured_at] = a;
    soccerLines.push({ league, event_id, commence, home, away, market, selection, point, book, price, captured_at });
  } else if (/^\s*INSERT OR IGNORE INTO gmpicks/i.test(sql)) {
    const c = ['sport', 'date', 'game_id', 'league', 'commence', 'side', 'pick', 'home', 'away', 'win_prob', 'implied', 'edge', 'entry_price', 'close_price', 'book', 'fair_src', 'sharp_n', 'model_ver'];
    const row = Object.fromEntries(c.map((k, i) => [k, a[i]]));
    const k = gmKey([row.sport, row.date, row.game_id]);
    if (!gm.has(k)) gm.set(k, { ...row, result: null, home_score: null, away_score: null });
  } else if (/^\s*UPDATE gmpicks SET close_price/i.test(sql)) {
    const [cp, edge, wp, imp, sport, date, gid] = a;
    const r = gm.get(gmKey([sport, date, gid])); if (r) { r.close_price = cp; r.edge = edge; r.win_prob = wp; r.implied = imp; }
  } else if (/^\s*UPDATE gmpicks SET result/i.test(sql)) {
    const [res, hs, as, sport, date, gid] = a;
    const r = gm.get(gmKey([sport, date, gid])); if (r) { r.result = res; r.home_score = hs; r.away_score = as; }
  } else if (/^INSERT OR IGNORE INTO feed_cache/i.test(sql)) {
    if (!cache.has(a[0])) cache.set(a[0], { data: null, updated_at: 0 });
  } else if (/^INSERT OR REPLACE INTO feed_cache/i.test(sql)) {
    cache.set(a[0], { data: a[1], updated_at: a[2] });
  }
  return { meta: { changes: 1 } };
};
const db = {
  prepare: (sql) => {
    const st = { sql, args: [], bind: (...x) => { st.args = x; return st; },
      run: async () => run(sql, st.args),
      first: async () => {
        if (/COUNT\(\*\)/i.test(sql)) return { n: nflRows.length };
        if (/FROM feed_cache WHERE key=\?/i.test(sql)) {
          const c = cache.get(st.args[0]);
          return c && c.data ? { data: c.data, updated_at: c.updated_at } : null;
        }
        return null;
      },
      all: async () => {
        if (/FROM nfl_lines/i.test(sql)) return { results: nflRows };
        if (/FROM soccer_lines/i.test(sql)) {
          const lg = st.args.length > 1 ? st.args[0] : null;
          return { results: soccerLines.filter((r) => !lg || r.league === lg) };
        }
        if (/FROM gmpicks/i.test(sql)) {
          let rs = [...gm.values()];
          if (/result IS NULL/i.test(sql)) rs = rs.filter((r) => r.result == null && r.date < st.args[0]);
          return { results: rs };
        }
        return { results: [] };
      } };
    return st;
  },
  batch: async (l) => (l || []).map((x) => run(x.sql, x.args)),
};
const env = { ODDS_API_KEY: 'k', DB: db };
const ctx = { waitUntil: (p) => { if (p && p.then) p.catch(() => {}); } };

const src = fs.readFileSync(BOARD + '/worker.js', 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const hit = async (u, e) => (await mod.default.fetch(new Request('https://x' + u), e || env, ctx)).json();

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

// ---- log -------------------------------------------------------------------------------
await hit('/api/soccer-ingest');
await hit('/api/soccer-board');
await hit('/api/nfl-board');
const logged = [...gm.values()];
console.log('  logged: ' + logged.map((r) => `${r.sport}:${r.pick}@${r.entry_price}`).join(' | ') + '\n');

const soc = logged.filter((r) => r.sport === 'soccer');
const nfl = logged.filter((r) => r.sport === 'nfl');
ok(soc.length === 2 && nfl.length === 2, `both boards write a row per game (soccer ${soc.length}, nfl ${nfl.length})`);
ok(nfl.every((r) => r.game_id !== 'n3'), 'a game that already kicked off is not logged as a pick');
ok(soc.every((r) => r.win_prob != null && r.entry_price != null && r.sharp_n >= 2),
  'each row carries the fair number, the price taken against it and how many sharp books were behind it');
ok(logged.every((r) => r.date === ptDay(NOW)), `dated by Pacific slate day (${[...new Set(logged.map((r) => r.date))].join(',')})`);
ok(soc.some((r) => r.side === 'draw'), `the draw is logged as a side of its own (${soc.map((r) => r.side).join(',')})`);
ok(nfl.every((r) => r.side === 'home' || r.side === 'away'), `NFL has no draw side (${nfl.map((r) => r.side).join(',')})`);

// Logging twice must not double up, and must not move the entry price.
const before = JSON.stringify([...gm.values()].map((r) => [r.game_id, r.entry_price]));
await hit('/api/nfl-board');
await hit('/api/soccer-board');
ok(gm.size === 4 && JSON.stringify([...gm.values()].map((r) => [r.game_id, r.entry_price])) === before,
  `a second board load re-freezes nothing (${gm.size} rows)`);

// ---- grade -----------------------------------------------------------------------------
// Yesterday's rows, so the grader picks them up.
const yday = ptDay(NOW - 86400e3);
for (const r of [...gm.values()]) { gm.delete(gmKey([r.sport, r.date, r.game_id])); r.date = yday; gm.set(gmKey([r.sport, r.date, r.game_id]), r); }
espnCalls = [];
const tr = await hit('/api/track-record', { DB: db });
const by = (id) => [...gm.values()].find((r) => r.game_id === id);
console.log('\n  graded: ' + [...gm.values()].map((r) => `${r.pick} ${r.away_score}-${r.home_score} ${r.result}`).join(' | ') + '\n');

ok(by('s1') && by('s1').result != null,
  `"Bournemouth" is matched to ESPN's "AFC Bournemouth" — an unmatched row would just look quiet (${by('s1') && by('s1').result})`);
// Liverpool won away 1-0; the board's lead was the draw at +285, so it lost.
ok(by('s1') && by('s1').side === 'draw' && by('s1').result === 'loss',
  `a draw pick on a 1-0 away win grades as a loss (${by('s1') && by('s1').result})`);
// Malaga v Getafe finished 1-1: whatever side was led, the draw is what happened.
const s2 = by('s2');
ok(s2 && (s2.side === 'draw' ? s2.result === 'win' : s2.result === 'loss'),
  `a 1-1 result is a win for the draw and a loss for either team (${s2 && s2.side} -> ${s2 && s2.result})`);
ok(by('n1') && by('n1').result === 'win' && by('n1').home_score === 27,
  `the Rams' home win grades the home side, with the score kept (${by('n1') && by('n1').result} ${by('n1') && by('n1').away_score}-${by('n1') && by('n1').home_score})`);
ok(by('n2') && by('n2').result === 'push',
  `an NFL tie is a push — there was no draw price to be on (${by('n2') && by('n2').result})`);
ok(espnCalls.length && espnCalls.every((u) => u.includes('cdn.espn.com')),
  `graded off the free ESPN scoreboard, and off the host a Worker can actually reach (${espnCalls.length} calls)`);

// ---- report ----------------------------------------------------------------------------
console.log('  nflMl:    ' + JSON.stringify(tr.nflMl && { logged: tr.nflMl.logged, n: tr.nflMl.n, record: tr.nflMl.record, pushed: tr.nflMl.pushed, units: tr.nflMl.units }));
console.log('  soccerMl: ' + JSON.stringify(tr.soccerMl && { logged: tr.soccerMl.logged, n: tr.soccerMl.n, record: tr.soccerMl.record, byLeague: tr.soccerMl.byLeague }) + '\n');
ok(tr.nflMl && tr.soccerMl, 'both records are exposed for reading');
ok(tr.nflMl && tr.nflMl.n === 1 && tr.nflMl.pushed === 1,
  `a push is counted as a push, not as a win or a loss (${tr.nflMl && tr.nflMl.record}, ${tr.nflMl && tr.nflMl.pushed} pushed)`);
ok(tr.soccerMl && tr.soccerMl.byLeague && Object.keys(tr.soccerMl.byLeague).length >= 1,
  `soccer is split by league (${Object.keys((tr.soccerMl || {}).byLeague || {}).join(',')})`);
ok(tr.ml && tr.ml.record, 'and the MLB moneyline record is untouched on its own table');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
