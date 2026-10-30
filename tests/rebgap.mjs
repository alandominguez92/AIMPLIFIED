// Rebounds Less where PrizePicks' line sits above the sharp books' (2026-10-30,
// the owner's call: "betting against would be the best option"). Last season's
// backtest had those unders at 408 of 727 (56.1%), 52.6% where the lines met
// and 48.7% below. What has to hold:
//   - a rebounds row is a leg when its line, as read last, sits above the
//     sharp books' main line -- Pinnacle's, else FanDuel's, else the median of
//     the other sharp books' -- for a rotation player, inside the list's day
//   - level with it, or below, it is not; nor a row whose books have not
//     posted yet: a leg can come on at the pre-tip read
//   - its chance is the backtest's 56.1%, it is a PrizePicks leg (the pool),
//     and it grades at the line it was shown, a push as a push
//   - it leaves the list, with the reason, when the sharp line comes up to it
//   - its record counts this season's rebounds rows the same way
//
// Real data: production's rebounds rows of Oct 27, 28 and 29 from
// /api/nba-pp?day= (tests/fixtures/nbapp-reb-20261027-29.json): each first and
// pre-tip read, every book's main line as last read, and the results. On Oct
// 29 Dyson Daniels' 6 sat over the sharp books' 5.5 at the 3:40 PM read, and
// Toumani Camara's 4 over their 3.5 at the 5:41 PM pre-tip read -- his first
// read, a day before, had no books yet. Real SQLite and the real worker.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const F = JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', 'nbapp-reb-20261027-29.json'), 'utf8')).days;
const RealDate = Date;
let NOW = RealDate.parse('2026-10-29T22:45:00Z');
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
await get('/api/gmpicks-export'); await get('/api/nba-pp'); await get('/api/picks');      // the tables

// A row as the log held it: the first read, and the pre-tip read where there was one.
const put = (date, l, { open = false, tipped = true } = {}) => {
  const [away, home] = l.game.split(' @ ');
  // The day view's tip is the pre-tip read wherever the row had one (close_at),
  // stamped the same as the first read when that read was the first.
  const reread = tipped && !!l.tip;
  sq.prepare(`INSERT OR REPLACE INTO nbapp (date, game_id, player, market, league, commence, home, away, team, point, proj, model_under, min_proj, book_line, book_under, sharp_under, captured_at,
      close_point, close_under, close_book_line, close_book_under, close_sharp_under, close_at, book_unders, actual, result, close_result)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(date, l.game_id, l.player, 'reb', 'reg', l.commence, home, away, l.team,
    l.first.line, l.proj, l.first.under, l.min_proj, l.first.book, l.first.book_under, l.first.sharp, l.first.at,
    reread ? l.tip.line : null, reread ? l.tip.under : null, reread ? l.tip.book : null, reread ? l.tip.book_under : null, reread ? l.tip.sharp : null, reread ? l.tip.at : null,
    tipped || !reread ? l.bookUnders : null,
    open ? null : l.actual, open ? null : l.result, open || !reread ? null : l.tipResult);
};
const row = (date, who) => F[date].find((l) => l.player === who);
const legOf = (d, who) => [...(d.legs || []), ...(d.ppPool || [])].find((x) => x.kind === 'nba_reb_gap' && x.title.startsWith(who));

console.log('-- 3:45 PM Pacific, Oct 29 --');
// Tonight's rows as the log held them then: Camara's first read only, no books yet.
for (const l of F['2026-10-29']) put('2026-10-29', l, { open: true, tipped: l.player !== 'Toumani Camara' });
sq.prepare("UPDATE nbapp SET close_point = NULL, close_under = NULL, close_book_line = NULL, close_book_under = NULL, close_sharp_under = NULL, close_at = NULL, book_unders = NULL WHERE player = 'Toumani Camara'").run();
let d = await get('/api/picks');
const dan = legOf(d, 'Dyson Daniels');
console.log(`  ${[...new Map([...(d.legs || []), ...(d.ppPool || [])].filter((x) => x.kind === 'nba_reb_gap').map((x) => [x.legId, x])).values()].map((x) => `${x.title} ${x.p}% (PP +${x.vsBook})`).join(' | ') || 'none'}`);
ok(dan && dan.title === 'Dyson Daniels Under 6 REB' && dan.p === 56.1 && dan.vsBook === 0.5 && dan.kindLabel === 'NBA rebounds Less, PrizePicks above the sharp line',
  "Dyson Daniels' 6 over the sharp books' 5.5 (Pinnacle's): a leg at the backtest's 56.1%");
ok((d.ppPool || []).some((x) => x.legId === dan.legId) && dan.spec.side === 'Under' && dan.spec.pp.line === 6, 'a PrizePicks leg: in the pool, the Less at his line');
ok(!legOf(d, 'C.J. McCollum') && !legOf(d, 'Toumani Camara'), "McCollum's 2.5 level with the books' 2.5 is not one; nor Camara's 3.5 before any book had posted");
// (A bench player's is not one either -- the unders' own rotation bar, NBA_ROTATION_MIN
// -- but none of these three days' rows above the sharp line was a bench player's.)

console.log('\n-- 3:55 PM: the sharp books come up to Daniels\' 6 --');
NOW = RealDate.parse('2026-10-29T22:55:00Z');
sq.prepare("UPDATE nbapp SET close_point = 6, close_under = 47.5, close_at = ?, book_unders = ? WHERE player = 'Dyson Daniels'").run('2026-10-29T22:54:00Z', JSON.stringify({ pinnacle: [6, 50.4], fanduel: [6, 49.8] }));
d = await get('/api/picks');
ok(!legOf(d, 'Dyson Daniels'), 'off the list');

console.log('\n-- 5:45 PM: Camara\'s pre-tip read --');
NOW = RealDate.parse('2026-10-30T00:45:00Z');
put('2026-10-29', row('2026-10-29', 'Toumani Camara'), { open: true });
d = await get('/api/picks');
const cam = legOf(d, 'Toumani Camara');
ok(cam && cam.title === 'Toumani Camara Under 4 REB' && cam.vsBook === 0.5, "PrizePicks moved him to 4 and the books posted 3.5 (Pinnacle's): on at the pre-tip read");
const drop = ((d.record.history.days.find((x) => x.date === '2026-10-29') || {}).dropped || []).find((x) => /Dyson Daniels/.test(x.label));
ok(drop && drop.why === "the sharp books' line moved to 6, level with PrizePicks' 6", `Daniels, started, says why he left: "${drop && drop.why}"`);

console.log('\n-- the finals --');
for (const l of F['2026-10-29']) if (l.player !== 'Dyson Daniels') put('2026-10-29', l);
sq.prepare("UPDATE nbapp SET actual = 6, result = 'push', close_result = 'push' WHERE player = 'Dyson Daniels'").run();
NOW = RealDate.parse('2026-10-30T09:00:00Z');
d = await get('/api/picks');
const dp = sq.prepare("SELECT leg_id, kind, result FROM daypicks WHERE kind = 'nba_reb_gap'").all();
console.log('  ' + dp.map((x) => `${x.leg_id.split(':')[2]} ${x.result}`).join(' | '));
ok(dp.find((x) => /Toumani Camara/.test(x.leg_id)).result === 'hit', 'Camara: 2 rebounds under his 4');

console.log('\n-- the record --');
for (const date of ['2026-10-27', '2026-10-28']) for (const l of F[date]) put(date, l);
d = await get('/api/picks');
const rec = d.kinds && d.kinds.nba_reb_gap && d.kinds.nba_reb_gap.record;
// The same count from the rows: the line read last against the books' as last read.
const SH = ['pinnacle', 'fanduel', 'novig', 'prophetx', 'betonlineag', 'lowvig'];
const med = (xs) => { const s = xs.slice().sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const main = (bu) => { const o = JSON.parse(bu); for (const k of ['pinnacle', 'fanduel']) if (o[k]) return o[k][0]; const r = SH.filter((k) => o[k]).map((k) => o[k][0]); return r.length ? med(r) : null; };
const all = Object.values(F).flat().filter((l) => l.bookUnders && l.min_proj >= 20).map((l) => {
  const re = !!l.tip;
  return { line: re ? l.tip.line : l.first.line, res: l.player === 'Dyson Daniels' && l.game_id === row('2026-10-29', 'Dyson Daniels').game_id ? 'push' : re ? l.tipResult : l.result, main: main(l.bookUnders) };
}).filter((x) => x.main != null && x.line > x.main && (x.res === 'under' || x.res === 'over'));
const hit = all.filter((x) => x.res === 'under').length;
console.log(`  this season: ${rec && rec.hit} of ${rec && rec.n}; from the rows ${hit} of ${all.length}`);
ok(rec && rec.n === all.length && rec.hit === hit && all.length > 15, `its record: this season's rebounds rows above the sharp line, ${hit} of ${all.length} under, pushes and voids aside`);

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
