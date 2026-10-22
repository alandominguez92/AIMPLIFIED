// Overs kept apart (2026-10-22), and the NBA tab's "prices as of".
//
// The NBA PrizePicks log grades every leg both ways, but its record only told
// how the unders did. On Oct 22 the model leaned over on 31 of 39 legs --
// mostly last season's numbers on players in new roles -- and nothing on the
// site could say whether over leans have landed. Now /api/nba-pp's record
// carries `overs`: the legs where the model leaned over, graded at PrizePicks'
// line, by band of the over's chance, by market and by where PrizePicks'
// number sat against the books' (ppLower: the easier over). The soccer props
// record splits the same way (`bySide`), at the default line and at the
// PrizePicks lines saved on the card.
//
// And the NBA tab said "prices as of Oct 16" through opening week: the board
// took the oldest read of any league, and the finished preseason's was Oct 16.
// Now only a league with a game still to come counts.
//
// Rows are written into the worker's own tables (nbapp, socprops,
// soc_pp_lines, feed_cache) as the capture and grader leave them, from the
// Oct 22 PrizePicks lines (Tyson reb 4 vs the books' 4.5, Murray ast 6 vs
// 5.5, ...). Real SQLite and the real worker; the card lines are lifted out of
// app.js.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const RealDate = Date;
const NOW = RealDate.parse('2026-10-23T16:00:00Z');
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
};
globalThis.fetch = async (u) => (String(u).includes('scoreboard')
  ? new Response(JSON.stringify({ events: [], content: { sbData: { events: [] } } }), { status: 200 })
  : new Response('{}', { status: 404 }));
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
const PRIORS = fs.readFileSync(path.join(BOARD, 'soccer-priors.json'), 'utf8');
const env = { DB, ASSETS: { fetch: async (r) => (new URL(r.url).pathname === '/soccer-priors.json' ? new Response(PRIORS, { status: 200 }) : new Response('{}', { status: 404 })) } };
const src = fs.readFileSync(BOARD + '/worker.js', 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const hit = async (u) => (await mod.default.fetch(new Request('https://x' + u), env, { waitUntil: () => {} })).json();

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

console.log('-- NBA: the over side of the log --');
await hit('/api/nba-pp');                                   // the tables
const ins = sq.prepare(`INSERT INTO nbapp (date, game_id, player, market, commence, point, model_under, min_proj, book_line, result)
  VALUES ('2026-10-22', ?, ?, ?, '2026-10-22T23:10:00Z', ?, ?, ?, ?, ?)`);
// [player, market, PrizePicks line, model under %, projected minutes, book line, result]
const LEGS = [
  ['Jaylon Tyson', 'reb', 4, 27.7, 26.9, 4.5, 'over'],             // over 72%, PP below book: landed
  ['Christian Braun', 'reb', 4, 31.9, 31.8, 4.5, 'over'],          // over 68%, PP below book: landed
  ['Jaylen Brown', 'reb', 6, 31.4, 34.5, 6.5, 'under'],            // over 69%, PP below book: missed
  ['Jamal Murray', 'ast', 6, 31.7, 35.4, 5.5, 'under'],            // over 68%, PP ABOVE book: missed
  ['Marvin Bagley III', 'reb', 3.5, 16.7, 20, 3.5, 'under'],       // over 83%, same as book: missed
  ['Chet Holmgren', 'reb', 8, 39.3, 29.3, 8.5, 'push'],            // over 61%: a tie, not graded
  ['Isaiah Hartenstein', 'stl', 0.5, 37.9, 23, null, 'over'],      // over 62%, no book line: landed
  ['Bench Guy', 'reb', 2.5, 20, 12, 2.5, 'over'],                  // 12 minutes: off the card and the record
  ['LeBron James', 'ast', 7.5, 57.7, 33.3, 7.5, 'under'],          // leaned UNDER: not an over leg
  ['Shai Gilgeous-Alexander', 'ast', 6.5, 58.3, 33.7, 6.5, 'over'], // leaned under, lost
];
LEGS.forEach(([p, m, pt, mu, min, bl, res], i) => ins.run(`g${i}`, p, m, pt, mu, min, bl, res));
const d = await hit('/api/nba-pp');
const ov = d.record && d.record.overs;
console.log(`  overs: ${JSON.stringify(ov && { graded: ov.graded, hit: ov.hit, hitRate: ov.hitRate })}`);
ok(ov && ov.graded === 6 && ov.hit === 3, `the over leans of rotation players, a tie left out: 3 of 6 landed (${ov && ov.hit} of ${ov && ov.graded})`);
ok(ov.byBand['65-70'].n === 3 && ov.byBand['65-70'].hit === 1 && ov.byBand['70+'].n === 2 && ov.byBand['70+'].hit === 1,
  'banded by the OVER\'s chance: Braun, Brown and Murray at 65-70 (1 landed), Tyson and Bagley at 70+ (1)');
ok(ov.byLineGap.ppLower.n === 3 && ov.byLineGap.ppLower.hit === 2 && ov.byLineGap.ppHigher.n === 1 && ov.byLineGap.ppHigher.hit === 0,
  'where PrizePicks sat below the books (the easier over) 2 of 3; above them, Murray, 0 of 1');
ok(ov.byMarket.reb.n === 4 && ov.byMarket.reb.hit === 2 && ov.byMarket.stl.hit === 1 && ov.byMarket.ast.n === 1, 'and by market');
ok(d.record.graded === 8 && d.record.byMarket.ast.n === 3, `the unders' record is as it was: every decided rotation leg, the tie left out (${d.record.graded})`);

console.log('\n-- soccer: unders and overs apart --');
await hit('/api/soccer-props?summary=1');                   // the tables
const sp = sq.prepare(`INSERT INTO socprops (date, game_id, player_id, market, player, league, commence, proj, line, p_under, p_over, result)
  VALUES ('2026-10-18', 'm1', ?, ?, ?, 'epl', '2026-10-18T14:00:00Z', ?, ?, ?, ?, ?)`);
sp.run('1', 'tackles', 'A', 2.2, 2.5, 62, 38, 'under');      // leaned under, landed
sp.run('2', 'tackles', 'B', 1.1, 0.5, 33, 67, 'over');       // a 0.5 line leans over, landed
sp.run('3', 'fouls', 'C', 0.9, 0.5, 41, 59, 'under');        // leaned over, missed
sp.run('4', 'shots', 'D', 1.2, 1.5, 66, 34, 'under');        // leaned under, landed
const pl = sq.prepare(`INSERT INTO soc_pp_lines (game_id, player_id, market, date, line, side, p, result) VALUES ('m1', ?, ?, '2026-10-18', ?, ?, ?, ?)`);
pl.run('1', 'tackles', 2.5, 'Under', 62, 'over');            // PP line, under shown, missed
pl.run('2', 'tackles', 0.5, 'Over', 67, 'over');             // PP line, over shown, landed
const s = await hit('/api/soccer-props?summary=1');
const bs = s.record && s.record.bySide, ps = s.ppRecord && s.ppRecord.bySide;
console.log(`  default line: ${JSON.stringify(bs && { u: [bs.under.hit, bs.under.n], o: [bs.over.hit, bs.over.n] })}; PP lines: ${JSON.stringify(ps && { u: [ps.under.hit, ps.under.n], o: [ps.over.hit, ps.over.n] })}`);
ok(bs && bs.under.n === 2 && bs.under.hit === 2 && bs.over.n === 2 && bs.over.hit === 1 && bs.over.byMarket.tackles.hit === 1,
  'at the default line: unders 2 of 2, overs 1 of 2, each by stat');
ok(ps && ps.under.n === 1 && ps.under.hit === 0 && ps.over.n === 1 && ps.over.hit === 1, 'and at the PrizePicks lines saved: unders 0 of 1, overs 1 of 1');
ok(s.record.graded === 4 && s.record.hit === 3, 'the overall record is unchanged');

console.log('\n-- the NBA tab says how old the prices it shows are --');
const fc = sq.prepare('INSERT OR REPLACE INTO feed_cache (key, data, updated_at, claimed_until) VALUES (?,?,?,0)');
fc.run('nba_board:pre', JSON.stringify({ asOf: '2026-10-16T20:55:34.560Z', games: [{ id: 'p1', commence: '2026-10-17T00:00:00Z', home: 'Miami Heat', away: 'Detroit Pistons' }] }), NOW);
fc.run('nba_board:reg', JSON.stringify({ asOf: '2026-10-23T15:30:00.000Z', games: [{ id: 'r1', commence: '2026-10-23T23:00:00Z', home: 'Boston Celtics', away: 'New York Knicks' }] }), NOW);
let nb = await hit('/api/nba-board');
ok(nb.asOf === '2026-10-23T15:30:00.000Z' && nb.games.length === 1, `the finished preseason's Oct 16 read no longer sets it (${nb.asOf})`);
fc.run('nba_board:reg', JSON.stringify({ asOf: '2026-10-23T15:30:00.000Z', games: [{ id: 'r1', commence: '2026-10-23T03:00:00Z', home: 'Boston Celtics', away: 'New York Knicks' }] }), NOW);
nb = await hit('/api/nba-board');
ok(nb.asOf === '2026-10-23T15:30:00.000Z' && nb.games.length === 0, 'with nothing to come it is the last read anywhere, for "lines last read"');

console.log('\n-- the cards --');
const app = fs.readFileSync(BOARD + '/app.js', 'utf8').replace(/\r\n/g, '\n');
function lift(name) {
  const at = app.indexOf(`function ${name}(`);
  if (at < 0) throw new Error(`app.js has no ${name}`);
  let depth = 0;
  for (let i = app.indexOf('{', at); i < app.length; i++) {
    if (app[i] === '{') depth++; else if (app[i] === '}' && --depth === 0) return app.slice(at, i + 1);
  }
  throw new Error(`could not close ${name}`);
}
let C;
try {
  const socRecB = (h, n) => `<b>${h} of ${n}</b>`;
  C = new Function('socRecB', ['nbaOversLineHtml', 'socSideLineHtml'].map(lift).join('\n') + '\nreturn { nbaOversLineHtml, socSideLineHtml };')(socRecB);
} catch (e) { console.log(`  FAIL  the card lines lift out of app.js (${e.message})`); process.exit(1); }
const t = (h) => h.replace(/<[^>]*>/g, '');
ok(t(C.nbaOversLineHtml(ov)) === 'Overs: leaned over 3 of 6 · 65%+ 2 of 5 · PP line below book 2 of 3', `the NBA card: "${t(C.nbaOversLineHtml(ov))}"`);
ok(C.nbaOversLineHtml(null) === '' && C.nbaOversLineHtml({ graded: 0 }) === '', 'nothing before an over lean has graded');
ok(t(C.socSideLineHtml(s.record, s.ppRecord)) === 'At the app’s line: unders 2 of 2, overs 1 of 2 · At your PP lines: unders 0 of 1, overs 1 of 1',
  `the soccer card: "${t(C.socSideLineHtml(s.record, s.ppRecord))}"`);
ok(/Unders: \$\{recLine\}<\/div>` : ''\)\s*\+ nbaOversLineHtml\(r\.overs\);/.test(app)
  && /\+ socSideLineHtml\(d\.record, d\.ppRecord\)/.test(app), 'both cards draw them');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
