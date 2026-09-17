// The NFL board shows ONE slate day, not the rest of the week.
//
// nfl_lines holds every upcoming game, so the board carried the Thursday game
// plus all of Sunday's — and /api/nfl-props builds its player rows from that
// list, so a Thursday projected a week of players at once. The NFL week is three
// separate slates (Thu, Sun, Mon) read on the day they are played.
//
// The day comes from the earliest remaining kickoff, not the clock, so an off
// day rolls forward to the next slate instead of showing an empty board.
import fs from 'node:fs';
import path from 'node:path';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };

// Thursday night, then four Sunday games three days later. Kickoffs in UTC;
// 00:15Z Friday is Thursday 5:15 PM Pacific, which is the case that matters —
// the slate day is Pacific, so a late Thursday kickoff must not read as Friday.
const THU = '2026-09-18T00:15:00Z';
const SUN = ['2026-09-20T17:00:00Z', '2026-09-20T17:00:00Z', '2026-09-20T20:25:00Z', '2026-09-21T00:20:00Z'];
const GAMES = [
  { id: 'thu1', commence: THU, away: 'Detroit Lions', home: 'Buffalo Bills' },
  ...SUN.map((c, i) => ({ id: 'sun' + i, commence: c, away: `Away ${i} Team`, home: `Home ${i} Team` })),
];
// Two sharp books per side so each game has a fair line and a real board row.
const rows = [];
for (const g of GAMES) {
  for (const [team, price] of [[g.away, -130], [g.home, 110]]) {
    for (const book of ['pinnacle', 'lowvig', 'draftkings', 'fanduel']) {
      rows.push({ event_id: g.id, commence: g.commence, home: g.home, away: g.away, market: 'h2h',
        player: team, point: null, book, over: price, under: null, captured_at: '2026-09-17T12:00:00Z', week: 3 });
    }
  }
  rows.push({ event_id: g.id, commence: g.commence, home: g.home, away: g.away, market: 'totals',
    player: null, point: 44.5, book: 'draftkings', over: -110, under: -110, captured_at: '2026-09-17T12:00:00Z', week: 3 });
}

const db = {
  prepare: (sql) => {
    const st = { bind: () => st, run: async () => ({ meta: { changes: 0 } }),
      first: async () => (/COUNT\(\*\)/i.test(sql) ? { n: rows.length } : null),
      all: async () => ({ results: /FROM nfl_lines/i.test(sql) ? rows : [] }) };
    return st;
  },
  batch: async () => [],
};
const env = { DB: db, ASSETS: { fetch: async () => new Response('{}', { status: 404 }) } };

const realFetch = globalThis.fetch;
globalThis.fetch = async (u, o) => {
  const url = String(u);
  if (url.includes('espn.com') || url.includes('statsapi')) return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  return realFetch(u, o);
};

const src = fs.readFileSync(BOARD + '/worker.js', 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const board = await (await mod.default.fetch(new Request('https://x/api/nfl-board'), env, { waitUntil() {} })).json();

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
console.log(`  slateDay ${board.slateDay}; ${board.games.length} of ${board.gamesAllUpcoming} upcoming shown: ${board.games.map((g) => g.away + '@' + g.home).join(', ')}\n`);

ok(board.gamesAllUpcoming === 5, `all five games are in the table (${board.gamesAllUpcoming})`);
ok(board.games.length === 1, `only one slate day is shown (${board.games.length} game${board.games.length === 1 ? '' : 's'})`);
ok(board.games[0] && board.games[0].away === 'DET', `and it is the Thursday game (${board.games[0] && board.games[0].away})`);
ok(board.slateDay === '2026-09-17', `the Thursday-night kickoff counts as Thursday in Pacific time (${board.slateDay})`);
ok(!board.empty && /one slate day/.test(board.slateNote || ''), `the payload says what it filtered (${board.slateNote})`);

// With Thursday gone, the board rolls to Sunday rather than emptying.
rows.length = 0;
for (const g of GAMES.slice(1)) {
  for (const [team, price] of [[g.away, -130], [g.home, 110]]) {
    for (const book of ['pinnacle', 'lowvig', 'draftkings', 'fanduel']) {
      rows.push({ event_id: g.id, commence: g.commence, home: g.home, away: g.away, market: 'h2h',
        player: team, point: null, book, over: price, under: null, captured_at: '2026-09-17T12:00:00Z', week: 3 });
    }
  }
}
const later = await (await mod.default.fetch(new Request('https://x/api/nfl-board?type=REG'), env, { waitUntil() {} })).json();
console.log(`\n  with Thursday played: slateDay ${later.slateDay}, ${later.games.length} games`);
// All four: the 00:20Z kickoff is Sunday Night Football, 5:20 PM Pacific, so it
// belongs to Sunday's slate — which is the point of using Pacific dates.
ok(later.games.length === 4 && later.slateDay === '2026-09-20',
  `the next slate day shows its games, Sunday night included (${later.games.length} on ${later.slateDay})`);
ok(!later.empty, 'an off day rolls forward instead of showing an empty board');

// The player projections build from this same list.
ok(/const board = await nflBoardGames\(env, url\)/.test(src), 'nfl-props takes its games from the board, so players follow the same day');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
