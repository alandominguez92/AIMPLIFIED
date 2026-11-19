// Rebounds Less goes on Picks only while its record clears what a 6-Flex needs (2026-11-18, the
// owner's call after that night's replay: "use the hold rule").
//
// Picks' own rebounds legs had landed 29 of 60 (48%) since Oct 10 against the 56.1% shown, and
// the kind 117 of 218 (53.7%), under the 54.2% a 5- or 6-pick Flex needs a leg. What has to hold:
//   - while the kind's record is under 54.2%, no rebounds Less is on the list or in the entry
//   - the kinds say so (held, with the bar), and the page says so: "What gets on the list" and
//     the NBA tab
//   - the record goes on counting, and once it clears, the legs come back at 56.1%
//   - a listed leg that leaves when it goes under again says why
//   - before Nov 18 nothing changes (tests/rebgap.mjs, Oct 29)
//
// Real data: production's rebounds rows of Nov 18 that sat above the sharp books' line, from
// /api/nba-pp?day=2026-11-18, and its kinds record then, 117 of 218, from /api/picks
// (tests/fixtures/nba-pp-reb-20261118.json). Edgecombe's 6, Giannis' 12, Okongwu's 8 and Sarr's 7
// were in that night's 6-Flex pool. The graded rows here are built to the record's count. Real
// SQLite and the real worker.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const F = JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', 'nba-pp-reb-20261118.json'), 'utf8'));
const RealDate = Date;
// The tables are made an hour before, so the kinds record built then is past its half hour.
let NOW = RealDate.parse('2026-11-18T20:00:00Z');
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

// The night's rows open, each at its last read (the first read, then the pre-tip one), the books'
// lines as last read; and Queen's blocks More, a leg on the list that day beside them.
for (const l of [...F.legs, ...F.blkLegs]) {
  const [away, home] = l.game.split(' @ ');
  sq.prepare(`INSERT INTO nbapp (date, game_id, player, market, league, commence, home, away, team, point, proj, model_under, min_proj, book_line, book_under, sharp_under, captured_at,
      close_point, close_under, close_book_line, close_book_under, close_sharp_under, close_at, book_unders)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('2026-11-18', l.game_id, l.player, l.market, 'reg', l.commence, home, away, l.team,
    l.first.line, l.proj, l.first.under, l.min_proj, l.first.book, l.first.book_under, l.first.sharp, l.first.at,
    l.tip.line, l.tip.under, l.tip.book, l.tip.book_under, l.tip.sharp, l.tip.at, l.bookUnders);
}
NOW = RealDate.parse('2026-11-18T21:00:00Z');
// The graded legs the record counts: PrizePicks' 6 over the sharp books' 5.5, a rotation player.
let seq = 0;
const graded = (under, n) => { for (let i = 0; i < n; i++) sq.prepare(`INSERT INTO nbapp (date, game_id, player, market, league, commence, point, model_under, min_proj, book_unders, result)
  VALUES ('2026-11-01', ?, ?, 'reb', 'reg', '2026-11-02T00:00:00Z', 6, 50, 30, '{"pinnacle":[5.5,50]}', ?)`).run(`g${++seq}`, `P${seq}`, i < under ? 'under' : 'over'); };
graded(F.kindRecord.hit, F.kindRecord.n);
const reb = (d) => [...new Map([...(d.legs || []), ...(d.ppPool || [])].filter((x) => x.kind === 'nba_reb_gap').map((x) => [x.legId, x])).values()];

console.log('-- 1 PM Pacific, Nov 18 --');
let d = await get('/api/picks');
const k = d.kinds && d.kinds.nba_reb_gap;
ok(k && k.record.hit === 117 && k.record.n === 218 && F.kindRecord.hit === 117 && F.kindRecord.n === 218, `the record production had: ${k && k.record.hit} of ${k && k.record.n} (53.7%)`);
ok(reb(d).length === 0, `no rebounds Less on the list or in the entry (${reb(d).map((x) => x.title).join(', ') || 'none'})`);
ok(k && k.held && k.held.bar === 54.2, 'the kind says it is held, under the 54.2% bar');
ok(!d.kinds.nba_blk_more.held && !d.kinds.nhl_more.held, 'no other kind is');
ok((d.ppPool || []).some((x) => x.title === 'Derik Queen Over 0.5 BLK'), "Queen's blocks More is in the entry as before");

console.log('\n-- two more land: 119 of 220, 54.1% --');
graded(2, 2);
NOW += 35 * 60e3;                                       // the kinds record is half an hour behind at most
d = await get('/api/picks');
ok(d.kinds.nba_reb_gap.record.n === 220 && reb(d).length === 0 && d.kinds.nba_reb_gap.held, 'still under the bar: still held');

console.log('\n-- one more: 120 of 221, 54.3% --');
graded(1, 1);
NOW += 35 * 60e3;
d = await get('/api/picks');
const back = reb(d);
console.log('  ' + back.map((x) => `${x.title} ${x.p}%`).join(' | '));
ok(back.length >= 4 && back.every((x) => x.p === 56.1) && back.some((x) => x.title === 'VJ Edgecombe Under 6 REB') && back.some((x) => x.title === 'Alex Sarr Under 7 REB'),
  "over it: the legs come back at 56.1%, Edgecombe's 6 and Sarr's 7 among them");
ok(!d.kinds.nba_reb_gap.held, 'and the kind is no longer held');
const listed = (d.legs || []).filter((x) => x.kind === 'nba_reb_gap');
ok(listed.length >= 1, `on the list: ${listed.map((x) => x.title).join(', ')}`);

console.log('\n-- three miss: back to 120 of 224, 53.6% --');
graded(0, 3);
NOW += 35 * 60e3;
d = await get('/api/picks');
ok(reb(d).length === 0 && d.kinds.nba_reb_gap.held, 'under again: off the list and the entry');
NOW = RealDate.parse('2026-11-19T03:15:00Z');           // every game under way
d = await get('/api/picks');
const day = d.record.history.days.find((x) => x.date === '2026-11-18');
const gone = listed.map((l) => ((day && day.dropped) || []).find((x) => x.label === l.title));
console.log('  ' + gone.map((x, i) => `${listed[i].title}: ${x ? x.why : 'not listed as dropped'}`).join(' | '));
ok(gone.length && gone.every((x) => x && x.why === 'rebounds Lesses had landed 120 of 224, under the 54.2% bar'),
  `each listed leg says why it left: "${gone[0] && gone[0].why}"`);

// ---- the page ---------------------------------------------------------------------------------
console.log('\n-- the page --');
const app = fs.readFileSync(BOARD + '/app.js', 'utf8').replace(/\r\n/g, '\n');
const at = app.indexOf('  function nbaRebHeldHtml(');
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const ui = { picks: { kinds: { nba_reb_gap: { ...k } } } };
const H = new Function('state', 'esc', app.slice(at, app.indexOf('\n  }\n', at) + 4) + '\nreturn nbaRebHeldHtml;')(ui, esc);
const text = (x) => x.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
console.log('  ' + text(H()));
ok(text(H()) === 'Rebounds Less above the sharp line is off Picks while it lands under the 54.2% a 6-Flex needs: 117 of 218 so far. Its rows stay on the props card.',
  'the NBA tab says it is off Picks, with the record');
ui.picks.kinds.nba_reb_gap = { ...k, held: undefined };
ok(H() === '' && (ui.picks = null, H() === ''), 'nothing when it is on, or before Picks has loaded');
ok(/\+ nbaRebHeldHtml\(\);\n/.test(app.slice(app.indexOf('  function nbaPpCardHtml('), app.indexOf('  function nbaRebHeldHtml('))), 'under the PrizePicks unders heading on the NBA tab');
ok(/const held = k\.held \? ` · <span class="tc-wait">off Picks while under the \$\{esc\(String\(k\.held\.bar\)\)\}% a 6-Flex needs<\/span>` : '';/.test(app)
  && /\$\{held\}<\/li>`;/.test(app), '"What gets on the list" tags it: "off Picks while under the 54.2% a 6-Flex needs"');

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
