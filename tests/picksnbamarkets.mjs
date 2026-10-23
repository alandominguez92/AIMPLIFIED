// Picks of the day carries NBA threes and assists unders only, and none under a
// PrizePicks line below the books' (2026-10-23).
//
// After the first three nights at PrizePicks' own lines, the NBA log read:
// assists unders 63.1% (84), threes 63.4% (41), rebounds 50.4% (133), and by
// where PrizePicks' number sat against the books': below 45.1% (71), level
// 60.3% (141), above 58% (50). A PrizePicks leg needs about 57% to pay, the
// Oct 19 backtest had rebounds near 51% too, so rebounds come off the list
// and so does any leg whose PrizePicks line is below the books'. Both stay
// logged and graded on the NBA card. What has to hold:
//   - a rebounds under is never on the list, however high its chance
//   - nor a threes or assists under at a PrizePicks line below the books'
//   - level with or above the books', or with no book, a leg still qualifies
//   - the kind's record counts only the legs the list can carry
//
// The legs are production's own, as /api/nba-pp served them at 2:50 AM Pacific
// on Oct 23 (tests/fixtures/nba-pp-board-20261023.json): 198 legs from twelve
// games, read the night before by the early reads. They are written back into
// nbapp as the capture logged them. Real SQLite and the real worker.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const RealDate = Date;
const NOW = RealDate.parse('2026-10-23T09:50:00Z');           // when production served it
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
};
globalThis.fetch = async () => new Response('{}', { status: 404 });
const LIVE = JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', 'nba-pp-board-20261023.json'), 'utf8'));

const sq = new DatabaseSync(':memory:');
const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
function exec(sql, args, mode) {
  const st = sq.prepare(sql);
  const a = args.map(norm);
  if (mode === 'all') return { results: st.all(...a), meta: {} };
  if (mode === 'first') return st.get(...a) || null;
  return { success: true, meta: { changes: Number(st.run(...a).changes) } };
}
const DB = {
  prepare: (sql) => { const s = { sql, args: [], bind: (...x) => { s.args = x; return s; },
    all: async () => exec(s.sql, s.args, 'all'), first: async (c) => { const r = exec(s.sql, s.args, 'first'); return c && r ? r[c] : r; },
    run: async () => exec(s.sql, s.args, 'run') }; return s; },
  batch: async (sts) => sts.map((x) => exec(x.sql, x.args, 'run')),
};
const env = { DB };
const src = fs.readFileSync(BOARD + '/worker.js', 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const get = async (u) => (await mod.default.fetch(new Request('https://x' + u), env, { waitUntil: () => {} })).json();

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

await get('/api/picks');                                        // the tables
const ptDay = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new RealDate(iso));
const ins = sq.prepare(`INSERT INTO nbapp (date, game_id, player, market, league, commence, home, away, team, player_id, point, proj, model_under, n_recent, min_proj, book_line, book_under, captured_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
for (const x of LIVE.legs) {
  const [away, home] = x.game.split(' @ ');
  ins.run(ptDay(x.commence), x.game_id, x.player, x.market, x.league, x.commence, home, away, x.team, x.player_id,
    x.point, x.proj, x.model_under, x.n_recent, x.min_proj, x.book_line, x.book_under, x.first_at);
}
const live = (p, m) => LIVE.legs.find((x) => x.player === p && x.market === m);
ok(live('Gui Santos', 'reb').model_under === 76 && live('Rui Hachimura', 'reb').model_under === 76
  && live('Karl-Anthony Towns', 'ast').point === 4 && live('Karl-Anthony Towns', 'ast').book_line === 4.5,
  'the recorded legs: two 76% rebounds unders, and Towns under 4 assists at PrizePicks against the books\' 4.5');

const picks = await get('/api/picks');
const nba = (picks.legs || []).filter((x) => x.kind === 'nba_pp');
console.log('  ' + nba.map((x) => `${x.title} ${x.p}% (${x.sub})`).join(' | '));
ok(!nba.some((x) => / REB$/.test(x.title)), `no rebounds under on the list, the 76% ones included (${nba.map((x) => x.title).join(', ')})`);
ok(!nba.some((x) => /^Karl-Anthony Towns /.test(x.title)), 'nor Towns: PrizePicks\' 4 is below the books\' 4.5, the harder under');
ok(nba.length && nba.every((x) => /(3PM|AST)$/.test(x.title) && (x.vsBook == null || x.vsBook >= 0) && x.p >= 70),
  'every NBA leg left is a threes or assists under at 70%+, at or above the books\' line or with none');
const titles = nba.map((x) => x.title).sort();
ok(JSON.stringify(titles) === JSON.stringify(['Daniel Gafford Under 1.5 AST', 'Franz Wagner Under 5 AST', 'Keegan Murray Under 1.5 3PM']),
  `Gafford (no book), Wagner (PrizePicks above the books' 4.5) and Murray (level): ${titles.join(', ')}`);
ok(/3PM, AST/.test(picks.kinds.nba_pp.label) && !/REB/.test(picks.kinds.nba_pp.label) && /below the book/.test(picks.kinds.nba_pp.label),
  `the kind says what it carries (${picks.kinds.nba_pp.label})`);

console.log('\n-- the kind\'s record --');
// Graded legs from an earlier night, as the grader leaves them, all 70%+ and
// rotation: an assists under level with the book that landed, a threes under
// with no book that missed, a rebounds under that landed, and an assists
// under below the books' line that missed.
const g = sq.prepare(`INSERT INTO nbapp (date, game_id, player, market, league, commence, home, away, point, model_under, min_proj, book_line, result)
  VALUES ('2026-10-21', 'evOLD', ?, ?, 'reg', '2026-10-22T00:00:00Z', 'Utah Jazz', 'Denver Nuggets', ?, 74, 30, ?, ?)`);
g.run('Level Assist', 'ast', 4.5, 4.5, 'under');
g.run('No Book Three', 'threes', 1.5, null, 'over');
g.run('Board Rebound', 'reb', 7.5, 7.5, 'under');
g.run('Low Line Assist', 'ast', 4, 4.5, 'over');
const kr = (await get('/api/picks')).kinds.nba_pp.record;
ok(kr.n === 2 && kr.hit === 1, `the record is the two the list could have carried: 1 of 2, not the rebounds or the low-line leg (${kr.hit} of ${kr.n})`);

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
