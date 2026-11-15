// A leg whose line moves gives its place in the PrizePicks entry to the next, and the page says
// it moved (2026-11-14, the owner's "yes build both").
//
// The owner: stepping a rebounds Less down to PrizePicks' number (8 to 6.5) took the player out
// of the entry and nothing took his place, so a 6-Flex became a 5. Following him to the new line
// would put a coin flip in it: when PrizePicks lowered a rebounds or assists line (Oct 20-31), the
// Less at the old number landed 62% (66 of 106), at the new one 48% (43 of 89). What has to hold:
//   - the worker sends the legs behind the entry (ppBench): the next best, each of another game,
//     the same day, never a second NFL team pick
//   - a leg your line takes off, or one under way, gives its place to the next of them, so the
//     entry keeps its count; the worker's own priced edge is no longer quoted
//   - a leg PrizePicks moved out of the entry (ppMoved, from the worker's reads) and one your
//     line took off are said under it: the old line, the new, the chance at the new, and to keep
//     a leg taken at the old number; gone once its game starts
//
// Real data: Sunday Nov 15's legs as production had them at midnight Pacific (tests/fixtures/
// nba-pp-20261115.json, nhl-pp-20261115.json) and the day's game lines (tests/fixtures/
// gm-20261114-15.json). At 10:30 AM, with the early NFL games under way, Domantas Sabonis's
// rebounds Less (PrizePicks 12.5, FanDuel 11.5) is in the entry. Real SQLite, the real worker,
// app.js's own functions.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const fx = (f) => JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', f), 'utf8'));
const NB = fx('nba-pp-20261115.json'), NH = fx('nhl-pp-20261115.json'), G = fx('gm-20261114-15.json');
const RealDate = Date;
let NOW = RealDate.parse('2026-11-15T08:00:00Z');        // midnight Pacific, Sunday
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
const t = (l) => (l || []).map((x) => `${x.title} ${x.p}`).join(' | ');
const pt = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new RealDate(iso));

await get('/api/picks'); await get('/api/nba-pp'); await get('/api/nhl-pp'); await get('/api/gmpicks-export');   // the tables
const nb = sq.prepare(`INSERT INTO nbapp (date, game_id, player, market, league, commence, home, away, team, player_id, point, proj, model_under, n_recent, min_proj, book_line, book_under,
  captured_at, ud_line, p6_line, sharp_under, sharp_src, l10_n, l10_under, model_ver, book_unders) VALUES (${Array(26).fill('?').join(',')})`);
for (const l of NB.legs) { const [away, home] = l.game.split(' @ ');
  nb.run('2026-11-15', l.game_id, l.player, l.market, l.league, l.commence, home, away, l.team, l.player_id, l.point, l.proj, l.model_under, l.n_recent, l.min_proj, l.book_line,
    typeof l.book_under === 'number' ? l.book_under : null, l.first_at, l.ud_line, l.p6_line, l.sharp_under, l.sharp_src, l.l10_n, l.l10_under, 'nbapp-v1', l.bookUnders); }
const nh = sq.prepare(`INSERT INTO nhlpp (date, game_id, player, market, commence, home, away, team, player_id, point, model_under, proj, toi_proj, captured_at) VALUES ('2026-11-15', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
for (const l of NH.legs) { const [away, home] = l.game.split(' @ '); nh.run(l.game_id, l.player, l.market, l.commence, home, away, l.team, l.player_id, l.point, l.model_under, l.proj, l.toi_proj, l.first_at); }
const cols = Object.keys(G.rows[0]);
const gins = sq.prepare(`INSERT INTO gmpicks (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
for (const r of G.rows) { const ahead = RealDate.parse(r.commence) > NOW; gins.run(...cols.map((k) => (ahead && (k === 'result' || k === 'away_score' || k === 'home_score') ? null : r[k]))); }

console.log('-- Sunday, midnight --');
let p = await get('/api/picks');
console.log('  entry: ' + t(p.ppPool));
console.log('  bench: ' + t(p.ppBench));
ok(t(p.ppPool) === 'Jaguars ML 83 | Deshaun Watson Under 1.5 Pass TDs 67.8 | Daniel Jones Under 1.5 Pass TDs 66.5 | Matthew Tkachuk Over 0.5 AST 66.4 | Geno Smith Under 1.5 Pass TDs 65.1 | Derrick Jones Over 0.5 BLK 63',
  "the entry production showed at that hour, leg for leg");
const games = (l) => l.map((x) => x.spec.gamePk);
ok(p.ppBench.length === 4 && new Set(games([...p.ppPool, ...p.ppBench])).size === 10 && p.ppBench.every((x) => pt(x.commence) === '2026-11-15')
  && p.ppBench.every((x, i) => x.p <= (i ? p.ppBench[i - 1].p : p.ppPool[5].p)),
  'four legs behind it, the next best, each of another game, the same day');
ok(!p.ppBench.some((x) => x.kind === 'nfl_ml'), 'no second NFL team pick among them');
ok(Array.isArray(p.ppMoved) && p.ppMoved.length === 0, 'nothing moved yet');

console.log('\n-- 10:30 AM, the early NFL games under way --');
NOW = RealDate.parse('2026-11-15T18:30:00Z');
p = await get('/api/picks');
console.log('  entry: ' + t(p.ppPool));
console.log('  bench: ' + t(p.ppBench));
const sab = p.ppPool.find((x) => /Sabonis/.test(x.title));
ok(sab && sab.kind === 'nba_reb_gap' && sab.title === 'Domantas Sabonis Under 12.5 REB' && sab.vsBook === 1, 'Sabonis is in it: Less 12.5 rebounds, a point above FanDuel\'s 11.5');

// ---- the page --------------------------------------------------------------------------------
const app = fs.readFileSync(BOARD + '/app.js', 'utf8').replace(/\r\n/g, '\n');
function lift(name) {
  let at = app.indexOf(`function ${name}(`);
  if (at >= 0) { let dp = 0; for (let i = app.indexOf(') {', at) + 2; i < app.length; i++) { if (app[i] === '{') dp++; else if (app[i] === '}' && --dp === 0) return app.slice(at, i + 1); } }
  at = app.indexOf(`const ${name} =`);
  if (at < 0) throw new Error(`could not lift ${name}`);
  let dp = 0;
  for (let i = at; i < app.length; i++) { const c = app[i]; if ('{(['.includes(c)) dp++; else if ('})]'.includes(c)) dp--; else if (c === ';' && dp === 0) return app.slice(at, i + 1); }
  throw new Error(`could not lift ${name}`);
}
const store = {};
const penv = {
  esc: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  state: { slip: {}, ppLines: {}, sport: 'picks' },
  localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
  LEG_OFFERS: new Map(), persistSlip: () => {}, renderSlip: () => {}, renderPicks: () => {}, renderNba: () => {},
};
const names = ['nbCdf', 'r1', 'pct0', 'PP_LINE_STORE', 'ppLineOf', 'ppLineSet', 'ppChanceAt', 'pickAtLine', 'ppPoolAtLines', 'ppEntryLegs', 'shortLeg', 'PP_MOVED_WHY', 'ppMovedHtml'];
const P = new Function(...Object.keys(penv), names.map(lift).join('\n') + `\nreturn { ${names.filter((n) => !/^[A-Z]/.test(n)).join(', ')} };`)(...Object.values(penv));
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

console.log('\n-- you step Sabonis down to 11.5 --');
let e = P.ppEntryLegs(p);
ok(e.whole && e.legs.length === p.ppPool.length && e.off.length === 0 && P.ppMovedHtml(p.ppMoved, e.off) === '', 'no line set: the entry the worker priced, whole, and no note');
P.ppLineSet(sab.legId, 11.5, 12.5, sab.commence);
e = P.ppEntryLegs(p);
console.log('  entry: ' + t(e.legs));
ok(!e.legs.some((x) => /Sabonis/.test(x.title)) && e.legs.length === p.ppPool.length, `he leaves it and it keeps its ${p.ppPool.length} legs`);
ok(e.legs[e.legs.length - 1].legId === p.ppBench[0].legId && e.legs.slice(0, -1).every((x) => p.ppPool.some((y) => y.legId === x.legId)),
  `the first leg behind it takes his place: ${p.ppBench[0].title}`);
ok(new Set(games(e.legs)).size === e.legs.length, 'still one leg a game');
ok(e.whole === false, "the worker's edge, priced on his leg, is no longer quoted");
let note = text(P.ppMovedHtml(p.ppMoved, e.off));
console.log('  ' + note);
const at115 = P.ppChanceAt(11.5, sab.proj, sab.disp).under;
ok(note === `Out of the entry: the line moved Sabonis Less 12.5 → 11.5 REB your line · ${Math.round(at115)}% at 11.5 · took 12.5? keep it`,
  `under it: "Sabonis Less 12.5 → 11.5 REB", ${Math.round(at115)}% at 11.5, keep a 12.5 already taken`);
ok(/title="When PrizePicks lowered a rebounds or assists line \(Oct 20-31\), the Less at the old number landed 62% \(66 of 106\), at the new one 48% \(43 of 89\)\./.test(P.ppMovedHtml(p.ppMoved, e.off)), 'and why, held on the row');
P.ppLineSet(sab.legId, null, 12.5, sab.commence);
ok(P.ppEntryLegs(p).whole && P.ppEntryLegs(p).legs.some((x) => /Sabonis/.test(x.title)), 'back to 12.5: he is back, the entry whole');

console.log('\n-- a leg under way before the next read --');
const first = p.ppPool[0];
NOW = RealDate.parse(first.commence) + 60e3;
e = P.ppEntryLegs(p);
ok(!e.legs.some((x) => x.legId === first.legId) && e.legs.length === p.ppPool.length && e.legs.some((x) => x.legId === p.ppBench[0].legId) && !e.whole,
  `${first.title} has started: the next leg takes its place there too`);
NOW = RealDate.parse('2026-11-15T18:30:00Z');

console.log('\n-- PrizePicks moves Sabonis to 11.5 --');
// The worker's re-read: PrizePicks at 11.5, the books still 11.5, the model's chance at the new line.
const close = Math.round(at115 * 10) / 10;
sq.prepare("UPDATE nbapp SET close_point = 11.5, close_under = ?, close_at = ?, close_book_line = 11.5 WHERE player = 'Domantas Sabonis' AND market = 'reb'").run(close, '2026-11-15T18:35:00Z');
NOW = RealDate.parse('2026-11-15T18:40:00Z');
p = await get('/api/picks');
console.log('  entry: ' + t(p.ppPool));
console.log('  moved: ' + JSON.stringify(p.ppMoved));
ok(!p.ppPool.some((x) => /Sabonis/.test(x.title)) && p.ppPool.length === 6, 'out of the entry at the worker\'s read, and the worker\'s entry refills itself');
ok(p.ppMoved.length === 1 && p.ppMoved[0].label === 'Domantas Sabonis Under 12.5 REB' && p.ppMoved[0].from === 12.5 && p.ppMoved[0].to === 11.5 && p.ppMoved[0].p === close && p.ppMoved[0].side === 'under' && p.ppMoved[0].was === 56.1,
  `the route says so: 12.5 to 11.5, ${close}% at 11.5, 56.1 when it was in`);
const row = sq.prepare("SELECT in_pool, pool_p FROM daypicks WHERE leg_id = ?").get(sab.legId);
ok(row && row.in_pool === 0 && row.pool_p === 56.1, 'the log: out of the entry before his start');
note = text(P.ppMovedHtml(p.ppMoved, P.ppEntryLegs(p).off));
console.log('  ' + note);
ok(note === `Out of the entry: the line moved Sabonis Less 12.5 → 11.5 REB ${Math.round(close)}% at 11.5 · took 12.5? keep it`, 'the page says it under the entry');
ok(/entryNextHtml\(d\.ppNextAt, ppLegs\)/.test(app) && /\+ ppMovedHtml\(d\.ppMoved, ppOff\)/.test(app) && /const \{ legs: ppLegs, whole, off: ppOff \} = ppEntryLegs\(d\);/.test(app),
  'the entry card builds from it, and the note sits under the legs');
ok(/: ppEntryLegs\(d\);/.test(lift('saveTicketImage')), 'the saved ticket is the same entry');

console.log('\n-- once his game starts --');
NOW = RealDate.parse(sab.commence) + 60e3;
p = await get('/api/picks');
ok(p.ppMoved.length === 0 && P.ppMovedHtml([{ label: 'Domantas Sabonis Under 12.5 REB', side: 'under', from: 12.5, to: 11.5, p: close, commence: sab.commence }], []) === '',
  'nothing more to say: the route and the page drop it');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
