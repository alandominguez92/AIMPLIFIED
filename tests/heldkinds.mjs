// Blocks Mores and rebounds Lesses held off Picks by hand from Nov 24 (2026-11-23, the owner's call:
// "build all three").
//
// Blocks Mores had landed 45 of 86 (52.3%) since their rule and 71 of 131 (54.2%) as the list read
// them before tip: a 6-Flex's break-even, under every smaller entry's, and a higher stated chance
// landed no more often. The rebounds Lesses' automatic hold let them back whenever the record crept
// over 54.2% (on Nov 20 they came back and went 1 of 6). What has to hold:
//   - from games on Nov 24, no blocks More and no rebounds Less is on the list or in the entry,
//     whatever their records do: a rebounds record back over the bar does not bring them back
//   - games before Nov 24 keep what they had: the same blocks row a day earlier is in the entry
//   - the kinds say so (held, from Nov 24), and nothing else is held by hand
//   - a leg listed before the hold that leaves says why
//   - the page: "What gets on the list", the NBA tab's rebounds line, the blocks section and each
//     blocks leg say it is off Picks, with the count since the rule
//
// Real data: production's blocks and rebounds rows for Nov 24, read 11:22 PM Pacific Nov 23
// (tests/fixtures/nba-pp-held-20261124.json): Kevin Huerter's blocks More at 0.5, 59.1%, was the
// Nov 24 entry's NBA leg and "Tomorrow's best leg" on Picks. The rebounds rows of Nov 18 that sat
// above the sharp line (tests/fixtures/nba-pp-reb-20261118.json, as tests/rebhold.mjs uses them),
// moved to Nov 24. Real SQLite and the real worker.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const read = (f) => JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', f), 'utf8'));
const H24 = read('nba-pp-held-20261124.json'), R18 = read('nba-pp-reb-20261118.json');
const RealDate = Date;
let NOW = RealDate.parse('2026-11-24T17:00:00Z');
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

// A row open, as its reads left it, on the date given and its start moved by the days between.
const put = (l, date, shiftDays = 0) => {
  const [away, home] = l.game.split(' @ ');
  const t = l.tip || {};
  const mv = (iso) => new RealDate(RealDate.parse(iso) + shiftDays * 864e5).toISOString();
  sq.prepare(`INSERT INTO nbapp (date, game_id, player, market, league, commence, home, away, team, point, proj, model_under, min_proj, book_line, book_under, sharp_under, captured_at,
      close_point, close_under, close_book_line, close_book_under, close_sharp_under, close_at, book_unders)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(date, l.game_id + (shiftDays ? `-${date}` : ''), l.player, l.market, 'reg', mv(l.commence), home, away, l.team,
    l.first.line, l.proj, l.first.under, l.min_proj, l.first.book, l.first.book_under, l.first.sharp, mv(l.first.at),
    t.at ? t.line : null, t.at ? t.under : null, t.at ? t.book : null, t.at ? t.book_under : null, t.at ? t.sharp : null, t.at ? mv(t.at) : null, l.bookUnders);
};
const kindLegs = (d, kind) => [...new Map([...(d.legs || []), ...(d.ppPool || [])].filter((x) => x.kind === kind).map((x) => [x.legId, x])).values()];

console.log('-- the real rows --');
const huerter = H24.legs.find((l) => l.player === 'Kevin Huerter' && l.market === 'blk');
ok(huerter && huerter.first.line === 0.5 && Math.round((100 - huerter.first.under) * 10) / 10 === 59.1 && huerter.min_proj >= 20 && huerter.commence === '2026-11-25T00:11:00Z',
  "Nov 24: Kevin Huerter's blocks More at 0.5, 59.1%, Pistons @ Magic at 4:11 PM Pacific");

console.log('\n-- the same row on Nov 23, the day before the hold --');
NOW = RealDate.parse('2026-11-23T17:00:00Z');
put(huerter, '2026-11-23', -1);
let d = await get('/api/picks');
const before = kindLegs(d, 'nba_blk_more');
ok(before.some((x) => x.title === 'Kevin Huerter Over 0.5 BLK'), `in the entry as before (${before.map((x) => `${x.title} ${x.p}%`).join(', ') || 'none'})`);

console.log('\n-- Nov 24, 9 AM Pacific --');
NOW = RealDate.parse('2026-11-24T17:00:00Z');
for (const l of H24.legs) put(l, '2026-11-24');
d = await get('/api/picks');
ok(kindLegs(d, 'nba_blk_more').length === 0, `no blocks More on the list or in the entry (${kindLegs(d, 'nba_blk_more').map((x) => x.title).join(', ') || 'none'})`);
ok(d.kinds.nba_blk_more && d.kinds.nba_blk_more.held && d.kinds.nba_blk_more.held.since === '2026-11-24', 'the blocks kind says it is held from Nov 24');
ok(d.kinds.nba_reb_gap && d.kinds.nba_reb_gap.held && d.kinds.nba_reb_gap.held.since === '2026-11-24', 'and the rebounds kind');
ok(Object.entries(d.kinds).filter(([, v]) => v.held && v.held.since).map(([k]) => k).sort().join() === 'nba_blk_more,nba_reb_gap', 'no other kind is held by hand');
ok(d.kinds.nba_blk_more.record && typeof d.kinds.nba_blk_more.record.n === 'number', 'its record is still kept');

console.log('\n-- rebounds Lesses over the sharp line, their record back over the bar --');
for (const l of R18.legs) put(l, '2026-11-24', 6);
let seq = 0;
const graded = (under, n) => { for (let i = 0; i < n; i++) sq.prepare(`INSERT INTO nbapp (date, game_id, player, market, league, commence, point, model_under, min_proj, book_unders, result)
  VALUES ('2026-11-01', ?, ?, 'reb', 'reg', '2026-11-02T00:00:00Z', 6, 50, 30, '{"pinnacle":[5.5,50]}', ?)`).run(`g${++seq}`, `P${seq}`, i < under ? 'under' : 'over'); };
graded(120, 221);                                      // 54.3%: where the automatic hold let them back
NOW += 35 * 60e3;                                      // the kinds record is half an hour behind at most
d = await get('/api/picks');
ok(d.kinds.nba_reb_gap.record.hit === 120 && d.kinds.nba_reb_gap.record.n === 221, 'the record reads 120 of 221 (54.3%)');
ok(kindLegs(d, 'nba_reb_gap').length === 0 && d.kinds.nba_reb_gap.held.since === '2026-11-24', 'still none on the list or in the entry: held by hand, not by the bar');

console.log('\n-- a leg listed before the hold leaves, and says why --');
// As production's list had him at 11:22 PM on Nov 23, before the hold was deployed.
// A day shows in the history only with a leg on it, so one that started earlier stays listed.
sq.prepare(`INSERT INTO daypicks (date, leg_id, kind, src_date, game_id, player_key, market, team, label, p, commence, rank, on_list, seen_at)
  VALUES ('2026-11-24', 'earlier', 'nhl_ml', '2026-11-24', 'e1', NULL, 'h2h', 'X', 'a leg that started earlier', 60, '2026-11-24T17:00:00.000Z', 2, 1, '2026-11-24T16:50:00.000Z')`).run();
sq.prepare(`INSERT OR REPLACE INTO daypicks (date, leg_id, kind, src_date, game_id, player_key, market, team, label, p, commence, rank, on_list, seen_at)
  VALUES ('2026-11-24', ?, 'nba_blk_more', '2026-11-24', ?, 'Kevin Huerter', 'blk', 'DET', 'Kevin Huerter Over 0.5 BLK', 59.1, ?, 1, 1, '2026-11-24T07:22:00.000Z')`)
  .run(`nbapp:${huerter.game_id}:Kevin Huerter:blk:over`, huerter.game_id, huerter.commence);
d = await get('/api/picks');                            // the list read without him
NOW = RealDate.parse('2026-11-25T00:30:00Z');           // under way
d = await get('/api/picks');
const day = d.record && d.record.history && d.record.history.days.find((x) => x.date === '2026-11-24');
const gone = day && (day.dropped || []).find((x) => x.label === 'Kevin Huerter Over 0.5 BLK');
console.log(`  ${gone ? gone.why : 'not listed as dropped'}`);
ok(gone && gone.why === 'blocks Mores came off Picks on Nov 24: since Oct 27 they had landed 52%, under the 54.2% a 6-Flex needs', 'Huerter says why he left');

// ---- the page ---------------------------------------------------------------------------------
console.log('\n-- the page --');
const app = fs.readFileSync(BOARD + '/app.js', 'utf8').replace(/\r\n/g, '\n');
const fn = (name) => { const at = app.indexOf(`  function ${name}(`); return app.slice(at, app.indexOf('\n  }\n', at) + 4); };
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const text = (x) => x.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
const shortDay = new Function(fn('shortDay') + '\nreturn shortDay;')();
const blkRec = { leaned: { n: 211, hit: 117 }, atBar: { n: 109, hit: 61, hitRate: 56 }, since: { from: '2026-10-27', n: 86, hit: 45, hitRate: 52.3 } };
const ui = { picks: { kinds: { nba_blk_more: { ...d.kinds.nba_blk_more }, nba_reb_gap: { ...d.kinds.nba_reb_gap, record: { n: 261, hit: 134 } } } }, nbaPp: { record: { blkMore: blkRec } } };

const reb = new Function('state', 'esc', 'shortDay', fn('nbaRebHeldHtml') + '\nreturn nbaRebHeldHtml;')(ui, esc, shortDay);
console.log('  ' + text(reb()));
ok(text(reb()) === 'Rebounds Less above the sharp line is off Picks from Nov 24: 134 of 261 landed, under the 54.2% a 6-Flex needs. Its rows stay on the props card.',
  'the NBA tab: rebounds off Picks from Nov 24, no "while"');

const ppMoreLineHtml = () => '', legCardHtml = (x) => `<li>${x.title}</li>`, pickLegView = () => 'detailed', PP_MORE_MIN = 55;
const blk = new Function('state', 'esc', 'shortDay', 'ppMoreLineHtml', 'legCardHtml', 'pickLegView', 'PP_MORE_MIN', fn('nbaBlkMoreHtml') + '\nreturn nbaBlkMoreHtml;')(ui, esc, shortDay, ppMoreLineHtml, legCardHtml, pickLegView, PP_MORE_MIN);
const sec = text(blk([{ title: 'Kevin Huerter Over 0.5 BLK' }], {}));
console.log('  ' + sec);
ok(/Off Picks of the day from Nov 24: since Oct 27 they landed 45 of 86, under the 54\.2% a 6-Flex needs\. Still logged and graded here\./.test(sec)
  && !/On Picks of the day too/.test(sec) && !/the one NBA market where/.test(sec), 'the blocks section says it is off Picks, with the count since the rule');
ui.picks = null;
ok(/On Picks of the day too, since Oct 28/.test(text(blk([{ title: 'x' }], {}))), 'before Picks has loaded (or before the hold), as it was');

// Each blocks leg on the tab, as the card makes it, says so too.
ui.picks = { kinds: { nba_blk_more: { ...d.kinds.nba_blk_more } } };
const r1 = (x) => Math.round(x * 10) / 10;
const leg = new Function('state', 'shortDay', 'ppMoreLeg', 'ppMoreP', 'r1', 'nbaGameSub', 'NBA_MORE_MODEL_W', 'NBA_PROVEN_N', 'propTrend', fn('nbaBlkCardLeg') + '\nreturn nbaBlkCardLeg;')(
  ui, shortDay, () => ({ id: 'nbapp:g:Kevin Huerter:blk:over', title: 'Kevin Huerter Over 0.5 BLK', spec: {} }), () => 59.1, r1, () => 'Pistons @ Magic', 0.25, 30, () => null);
const L = leg({ commence: huerter.commence, proj: 1 }, { blkMore: blkRec });
ok(L.offPicks && L.offPicks.text === 'off Picks: these landed 45 of 86 since Oct 27' && /from Nov 24/.test(L.offPicks.title), `each blocks leg: "${L.offPicks && L.offPicks.text}"`);
ok(/if \(op && op\.text\) tags\.push\(`<span class="tc-wait" title="\$\{esc\(op\.title \|\| ''\)\}">\$\{esc\(op\.text\)\}<\/span>`\);/.test(fn('legCardHtml')), 'and the leg card draws that tag');

// "What gets on the list".
const rules = app.slice(app.indexOf('const rules = `<details class="pk-rules">'), app.indexOf("join('')}</ul><p>Only the best leg", app.indexOf('const rules = `<details class="pk-rules">')));
const li = new Function('esc', 'shortDay', 'pct0', 'kinds', `return Object.values(kinds).map((k) => {${rules.slice(rules.indexOf('const r = k.record')).replace(/\}\)\.\s*$/, '})')};`)
  (esc, shortDay, (v) => `${Math.round(v)}%`, { b: { label: 'NBA blocks More (PrizePicks)', min: 55, record: { n: 109, hit: 61, hitRate: 56, proven: true, since: blkRec.since }, held: { since: '2026-11-24' } } });
console.log('  ' + text(li.join('')));
ok(text(li.join('')) === 'NBA blocks More (PrizePicks) at 55%+ · 61 of 109 landed (56%) · off Picks from Nov 24, 45 of 86 since Oct 27', '"What gets on the list" tags it, with the count since the rule');

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
