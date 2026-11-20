// NHL assists Mores held to the points Mores' rule (2026-11-19, the owner's call), and an NHL
// More's "Legs like this" read from its own stat.
//
// The night of Nov 18 Picks' top legs were four assists Mores at 60-65% (Marner, LaCombe,
// Draisaitl, Kaprizov), each saying "Legs like this: 156 of 290 landed (54%)": that was points and
// assists together. Assists alone had landed 67 of 115 (58%), at 60-65% 22 of 39 (56%), under the
// 57.7% a 2-pick Power needs. What has to hold:
//   - from Nov 19 (Pacific) an assists More is on Picks and in the entry only where its band, at
//     the read it is on, has landed 57.7% or better over 20 legs, as the points Mores have since
//     Nov 14; before it, as production had them
//   - the NHL card keeps them, each held one with the record it went by
//   - a band that comes good puts its legs back; one listed that goes bad again leaves saying why
//   - an NHL More's record is its own stat's at the bar; the rules list keeps the kind's
//
// Real data: production's /api/picks at 11:24 PM Pacific on Nov 18 (tests/fixtures/
// picks-nhl-20261119.json): its four NHL legs as listed, and the record by stat and band, which
// the graded rows here are built to (one row a leg, at the band's middle). Real SQLite and the real
// worker.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const F = JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', 'picks-nhl-20261119.json'), 'utf8'));
const RealDate = Date;
let NOW = RealDate.parse('2026-11-19T07:30:00Z');       // 11:30 PM Pacific, Nov 18
globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } };
globalThis.fetch = async () => new Response('{}', { status: 404 });
const sq = new DatabaseSync(':memory:');
const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
const exec = (sql, args, mode) => { const st = sq.prepare(sql); const a = args.map(norm);
  if (mode === 'all') return { results: st.all(...a), meta: {} }; if (mode === 'first') return st.get(...a) || null;
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
const names = (l) => (l || []).map((x) => x.title);
const nhlOf = (l) => names((l || []).filter((x) => x.kind === 'nhl_more'));

await get('/api/picks'); await get('/api/nhl-pp');      // the tables

// ---- the record production had, and the four legs ---------------------------------------------
const BY = F.nhlMore.record.byStat;
ok(F.nhlMore.record.hit === 156 && F.nhlMore.record.n === 290 && BY.ast.first.atBar.hit === 67 && BY.ast.first.atBar.n === 115
  && BY.ast.first.byBand['60-65'].hit === 22 && BY.ast.first.byBand['60-65'].n === 39 && BY.pts.first.atBar.hit === 89 && BY.pts.first.atBar.n === 175,
  'the real record: NHL Mores 156 of 290; assists 67 of 115, at 60-65% 22 of 39; points 89 of 175');
ok(F.nhlLegs.every((l) => l.record.hit === 156 && l.record.n === 290 && l.spec.market === 'ast' && l.p >= 60 && l.p < 65),
  `each of the four, all assists at 60-65%, said 156 of 290 (${F.nhlLegs.map((l) => `${l.spec.player} ${l.p}`).join(', ')})`);
const MID = { '55-60': 57.5, '60-65': 62.5, '65+': 67 };
const gins = sq.prepare(`INSERT INTO nhlpp (date, game_id, player, market, commence, point, model_under, result, close_point, close_under, close_result)
  VALUES (?, ?, ?, ?, ?, 0.5, ?, ?, ?, ?, ?)`);
let seq = 0;
const graded = (mk, read, band, hit, n) => {
  for (let i = 0; i < n; i++) {
    const won = i < hit, p = MID[band], id = `g${++seq}`;
    // A first read at the band; a pre-start read on a row whose first read was no lean.
    if (read === 'first') gins.run('2026-11-01', id, `P${seq}`, mk, '2026-11-02T00:00:00Z', 100 - p, won ? 'over' : 'under', null, null, null);
    else gins.run('2026-11-01', id, `P${seq}`, mk, '2026-11-02T00:00:00Z', 50, won ? 'over' : 'under', 0.5, 100 - p, won ? 'over' : 'under');
  }
};
for (const mk of ['pts', 'ast']) for (const read of ['first', 'close']) for (const [band, c] of Object.entries(BY[mk][read].byBand)) graded(mk, read, band, c.hit, c.n);
const lins = sq.prepare(`INSERT INTO nhlpp (date, game_id, player, market, commence, home, away, team, player_id, point, model_under, proj, captured_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
for (const l of F.nhlLegs) { const [away, home] = l.sub.split(' @ '), s = l.spec;
  lins.run(s.date, s.gamePk, s.player, s.market, l.commence, home, away, s.team, s.playerId, s.pp.line, 100 - l.modelP, l.proj, l.firstAt || l.readAt); }

console.log('-- 11:30 PM Nov 18, the night they were listed --');
let h = await get('/api/nhl-pp');
ok(JSON.stringify(h.record.more.byStat) === JSON.stringify(BY), 'the rows give the record production had, by stat and band');
let p = await get('/api/picks');
console.log('  pool: ' + nhlOf(p.ppPool).join(' | '));
ok(nhlOf(p.ppPool).join() === F.poolListed.map((id) => F.nhlLegs.find((l) => l.legId === id).title).join(), 'before Nov 19, the pool production had: Marner, LaCombe, Draisaitl, Kaprizov');
const rec = (p.legs.find((l) => l.kind === 'nhl_more') || {}).record || {};
console.log(`  Marner's record: ${JSON.stringify(rec)}`);
ok([...p.legs, ...p.ppPool].filter((l) => l.kind === 'nhl_more').every((l) => l.record.hit === 67 && l.record.n === 115 && l.record.hitRate === 58.3 && l.record.stat === 'ast' && l.record.proven && !l.record.byStat),
  'each says assists\' own record: 67 of 115 (58.3%), not 156 of 290');
ok(p.kinds.nhl_more.record.hit === 156 && p.kinds.nhl_more.record.n === 290, 'the rules list keeps the kind\'s: 156 of 290');

console.log('\n-- 8 AM Nov 19 --');
NOW = RealDate.parse('2026-11-19T16:00:00Z');
p = await get('/api/picks');
ok(!nhlOf(p.ppPool).length && !nhlOf(p.legs).length, `no assists More on Picks or in the entry (pool: ${names(p.ppPool).join(' | ') || 'empty'})`);
h = await get('/api/nhl-pp');
const held = h.legs.filter((l) => l.market === 'ast');
console.log('  on the NHL board: ' + held.map((l) => `${l.player} ${JSON.stringify(l.offPicks)}`).join(' · '));
ok(held.length === 4 && held.every((l) => JSON.stringify(l.offPicks) === JSON.stringify({ band: '60-65', hit: 22, n: 39 })),
  'the NHL board keeps all four, each saying what held it: at 60-65%, 22 of 39');

console.log('\n-- the 60-65 band comes good at 4:20 PM --');
// Four more first-read assists legs at 60-65, all landed: 26 of 43, 60.5%.
graded('ast', 'first', '60-65', 4, 4);
NOW = RealDate.parse('2026-11-20T00:20:00Z');
p = await get('/api/picks');
console.log('  pool: ' + nhlOf(p.ppPool).join(' | '));
ok(nhlOf(p.ppPool).length === 4 && nhlOf(p.legs).includes('Mitch Marner Over 0.5 AST') && nhlOf(p.legs).includes('Leon Draisaitl Over 0.5 AST'), 'its legs come back, Marner and Draisaitl on the list');
// Then bad again: Draisaitl's game starts at 4:40 with him listed; the others' haven't.
sq.prepare("DELETE FROM nhlpp WHERE date = '2026-11-01' AND CAST(substr(game_id, 2) AS INTEGER) > ?").run(seq - 4);
NOW = RealDate.parse('2026-11-20T00:55:00Z');          // the kinds record is half an hour behind at most
p = await get('/api/picks');
ok(!nhlOf(p.legs).includes('Mitch Marner Over 0.5 AST'), 'back to 22 of 39: Marner leaves the list');
NOW = RealDate.parse('2026-11-20T03:30:00Z');          // after the last puck drop, Marner's at 7:10 PM
p = await get('/api/picks');
const day = p.record.history.days.find((d) => d.date === '2026-11-19');
const mar = day && (day.dropped || []).find((x) => /Marner/.test(x.label));
console.log('  dropped: ' + JSON.stringify(mar));
ok(mar && mar.why === 'assists Mores at 60-65% had landed 22 of 39, under the 57.7% bar', `off before the start, saying why: "${mar && mar.why}"`);
ok(day && !(day.dropped || []).some((x) => /Draisaitl/.test(x.label)), 'Draisaitl, listed at his start, isn\'t among them');

ok(/const NHL_AST_HOLD_SINCE = '2026-11-19';/.test(src), 'the rule starts on Nov 19 (Pacific)');
console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
