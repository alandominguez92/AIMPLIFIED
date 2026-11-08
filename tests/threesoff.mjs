// NBA threes and assists unders off Picks of the day from Nov 1 (2026-11-01, the
// owner's call: listed at 70%+, they landed 14 of 25). What has to hold:
//   - no leg dated Nov 1 or later is on the list or in the entries' pool, even
//     read the evening before
//   - the page's "what gets on the list" stops naming the kind, and says it is
//     left off
//   - a leg already on the list when this shipped leaves it, and the record and
//     the day's page say why
//   - they stay logged on the NBA card; a day before Nov 1 replays as it was
//
// Real data: production's PrizePicks rows for Nov 1 (nbapp-20261101.json), in
// which Day'Ron Sharpe's assists and Andrew Nembhard's sit at 70%+ -- Sharpe's
// the leg production listed the night before this. Real SQLite and the real
// worker.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const PP = JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', 'nbapp-20261101.json'), 'utf8')).legs;
const RealDate = Date;
let NOW = RealDate.parse('2026-10-31T23:00:00Z');                 // 4 PM Pacific, Oct 31
globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } };
globalThis.fetch = async () => new Response('{}', { status: 404 });
const sq = new DatabaseSync(':memory:');
const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
const exec = (sql, args, mode) => { const st = sq.prepare(sql); const a = args.map(norm);
  if (mode === 'all') return { results: st.all(...a), meta: {} }; if (mode === 'first') return st.get(...a) || null;
  if (/^\s*(SELECT|WITH)/i.test(sql)) return { results: st.all(...a), meta: {} };
  return { success: true, meta: { changes: Number(st.run(...a).changes) } }; };
const DB = { prepare: (sql) => { const s = { sql, args: [], bind: (...x) => { s.args = x; return s; },
  all: async () => exec(s.sql, s.args, 'all'), first: async (c) => { const r = exec(s.sql, s.args, 'first'); return c && r ? r[c] : r; },
  run: async () => exec(s.sql, s.args, 'run') }; return s; }, batch: async (sts) => sts.map((x) => exec(x.sql, x.args, 'run')) };
const env = { DB };
const src = fs.readFileSync(BOARD + '/worker.js', 'utf8').replace(/\r\n/g, '\n');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const get = async (u) => (await mod.default.fetch(new Request('https://x' + u), env, { waitUntil: () => {} })).json();
let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

await get('/api/nba-pp'); await get('/api/picks');                // the tables
const ins = sq.prepare(`INSERT INTO nbapp (date, game_id, player, market, league, commence, home, away, team, point, proj, model_under, min_proj, book_line, book_under, sharp_under, captured_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const add = (date, gameId, commence, l) => { const [away, home] = l.game.split(' @ ');
  ins.run(date, gameId, l.player, l.market, 'reg', commence, home, away, l.team, l.first.line, l.proj, l.first.under, l.min_proj, l.first.book, l.first.book_under, l.first.sharp, l.first.at); };
for (const l of PP) add('2026-11-01', l.game_id, l.commence, l);
const OFF = PP.filter((l) => (l.market === 'threes' || l.market === 'ast') && l.first.under >= 70 && l.min_proj >= 20);
ok(OFF.length >= 2 && OFF.some((l) => l.player === "Day'Ron Sharpe"), `the rows hold legs the old bar would list: ${OFF.map((l) => `${l.player} ${l.market} ${l.first.under}`).join(', ')}`);
const titles = (d) => [...(d.legs || []), ...(d.ppPool || [])].map((x) => x.title);

console.log('-- 4 PM Oct 31: a game tonight, and tomorrow\'s inside the day ahead --');
const SH = OFF.find((l) => l.player === "Day'Ron Sharpe");
add('2026-10-31', 'tonight', '2026-11-01T02:00:00Z', SH);
let d = await get('/api/picks');
const onLeg = (d.legs || []).find((x) => x.kind === 'nba_pp');
ok(onLeg && onLeg.legId.startsWith('nbapp:tonight:') && !(d.legs || []).concat(d.ppPool || []).some((x) => x.kind === 'nba_pp' && !x.legId.startsWith('nbapp:tonight:')),
  `Oct 31's leg still lists, as that day did; Nov 1's, read in time, does not (${titles(d).join(' | ')})`);
ok(d.kinds.nba_pp && /3PM, AST/.test(d.rules.nba_pp), 'and the list still names the kind on Oct 31');

console.log('\n-- noon Nov 1 --');
NOW = RealDate.parse('2026-11-01T19:00:00Z');
// As production stood before this shipped: Sharpe's assists on the list.
sq.prepare(`INSERT INTO daypicks (date, leg_id, kind, src_date, game_id, player_key, market, team, label, p, commence, rank, on_list, seen_at)
  VALUES ('2026-11-01', ?, 'nba_pp', '2026-11-01', ?, ?, 'ast', ?, ?, ?, ?, 1, 1, '2026-11-01T04:10:00Z')`)
  .run(`nbapp:${SH.game_id}:${SH.player}:ast`, SH.game_id, SH.player, SH.team, `${SH.player} Under ${SH.first.line} AST`, SH.first.under, SH.commence);
// And a moneyline, so the day has a list to keep a record of. Shaped as Oct 31's
// were (production's gmpicks export), its teams and start the real game's.
const ORL = PP.find((l) => /Magic/.test(l.game)) || { game_id: 'f00dfeed0000000000000000000000d1', commence: '2026-11-01T20:30:00Z' };
sq.prepare(`INSERT INTO gmpicks (sport, date, game_id, market, league, commence, side, pick, home, away, win_prob, entry_price, close_price, result)
  VALUES ('nba', '2026-11-01', ?, 'h2h', 'reg', ?, 'home', 'Orlando Magic', 'Orlando Magic', 'Boston Celtics', 68.4, -210, -215, NULL)`).run(ORL.game_id, ORL.commence);
d = await get('/api/picks');
ok(!(d.legs || []).concat(d.ppPool || []).some((x) => x.kind === 'nba_pp') && !titles(d).some((t) => / (3PM|AST)$/.test(t)), `no threes or assists under on the list or in the pool (${titles(d).join(' | ') || 'empty'})`);
ok(!d.kinds.nba_pp && !d.rules.nba_pp && !!d.kinds.nba_reb_gap && !!d.kinds.nba_blk_more && !!d.kinds.nba_ml, "the list stops naming the kind; the NBA's others stay");
const dp = sq.prepare("SELECT on_list FROM daypicks WHERE date = '2026-11-01' AND kind = 'nba_pp'").get();
ok(dp && dp.on_list === 0, "the leg already on the list comes off it");
const card = await get('/api/nba-pp');
const onCard = (card.legs || []).find((x) => x.player === SH.player && x.market === 'ast');
ok(onCard && onCard.model_under === SH.first.under, `still logged on the NBA card (${SH.player} assists ${onCard && onCard.model_under})`);

console.log('\n-- after tip --');
NOW = RealDate.parse('2026-11-01T22:30:00Z');
d = await get('/api/picks');
const WHY = 'threes and assists unders came off Picks on Nov 1: listed at 70%+, they landed 56%';
const day = ((d.record && d.record.history && d.record.history.days) || []).find((x) => x.date === '2026-11-01');
const drop = day && (day.dropped || []).find((x) => /Sharpe/.test(x.label));
ok(drop && drop.why === WHY, `the record says why it left: "${drop && drop.why}"`);
const dayLegs = (await get('/api/nba-pp?day=2026-11-01')).legs || [];
const dl = dayLegs.find((x) => x.player === SH.player && x.market === 'ast');
ok(dl && dl.picks && dl.picks.on === false && dl.picks.why === WHY, 'and so does the day\'s page');

console.log('\n-- the page --');
const app = fs.readFileSync(BOARD + '/app.js', 'utf8');
// "NFL yardage" left that sentence with the projections (2026-11-08).
ok(/Strikeout unders, NBA threes and assists unders,[^<]*are left off/.test(app), '"What gets on the list" says they are left off');

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
