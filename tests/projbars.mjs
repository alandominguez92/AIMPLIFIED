// The MLB board's projection bar under every player leg (2026-10-28).
//
// The owner: "for each player I want to continue to show the bar projection
// under, like the one we use for the MLB." The batter board draws, under each
// player, a bar whose fill runs to his projection and whose tick marks the
// line, then "proj 0.67 · line 1.5 · 0.83 cushion". What has to hold:
//   - one helper draws it the batter board's way, on the batter board's axis:
//     J. Mateo's row on Oct 28 (proj 0.67 against 1.5) filled 16.75% with the
//     tick at 37.5%, and so does this
//   - an Under's cushion is the line above the projection; an Over's (a
//     More), the projection above the line
//   - it is under every player leg: the NBA unders card, the blocks and NHL
//     Mores, the soccer props card, and Picks of the day's player legs and
//     its hero
//   - Picks of the day's NBA legs carry the projection to draw it
//
// Real data: the NBA legs the model rated 70%+ at 12:40 AM Pacific on Oct 28
// (tests/fixtures/nba-pp-legs-20261028.json). Real SQLite and the real worker.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const LEGS = JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', 'nba-pp-legs-20261028.json'), 'utf8')).legs;
const RealDate = Date;
const NOW = RealDate.parse('2026-10-28T08:00:00Z');
globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } };
globalThis.fetch = async () => new Response('{}', { status: 404 });

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
const app = fs.readFileSync(BOARD + '/app.js', 'utf8').replace(/\r\n/g, '\n');
const lift = (name) => { const at = app.indexOf(`function ${name}(`); if (at < 0) throw new Error('app.js has no ' + name); let d = 0;
  for (let i = app.indexOf('{', at); i < app.length; i++) { if (app[i] === '{') d++; else if (app[i] === '}' && --d === 0) return app.slice(at, i + 1); } };
let P;
try { P = new Function('esc', [lift('miniBar'), lift('projLineHtml')].join('\n') + '\nreturn { projLineHtml };')((s) => String(s)); }
catch (e) { console.log(`  FAIL  the bar lifts out of app.js (${e.message})`); process.exit(1); }
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

console.log('-- the bar --');
const mateo = P.projLineHtml(0.67, 1.5, 'Under');
console.log('  ' + text(mateo));
ok(/class="uz" style="width:16\.75%"/.test(mateo) && /class="tick" style="left:37\.5%"/.test(mateo) && text(mateo) === 'proj 0.67 · line 1.5 · 0.83 cushion',
  "J. Mateo's under 1.5 H+R+RBI as the batter board drew it: fill 16.75%, tick 37.5%, 0.83 cushion");
ok(text(P.projLineHtml(0.89, 0.5, 'Over')) === 'proj 0.89 · line 0.5 · 0.39 cushion' && /class="uz" style="width:44\.5%"/.test(P.projLineHtml(0.89, 0.5, 'Over')),
  "an Over's cushion is the projection above the line (Podkolzin's 0.89 points against 0.5)");
ok(text(P.projLineHtml(9.1, 8.5, 'Under')) === 'proj 9.1 · line 8.5 · 0.6 over the line' && text(P.projLineHtml(0.4, 0.5, 'More')) === 'proj 0.4 · line 0.5 · 0.1 short of the line',
  'and says so when the projection is on the wrong side');
ok(P.projLineHtml(null, 1.5, 'Under') === '' && P.projLineHtml(1, null, 'Over') === '', 'nothing without a projection or a line');

console.log('\n-- under every player leg --');
const has = (fn, re) => re.test(lift(fn));
ok(has('nbaPpCardHtml', /projLineHtml\(x\.proj, x\.point, 'Under'\)/), 'the NBA unders card');
ok(has('ppMoreListHtml', /projLineHtml\(x\.proj, x\.point, 'Over'\)/), 'the NBA blocks Mores and the NHL Mores');
ok(has('socPropRow', /projLineHtml\(r\.proj, l\.line, l\.side\)/), 'the soccer props card');
ok(/x\.spec && x\.spec\.pp \? projLineHtml\(x\.proj, x\.spec\.pp\.line, x\.spec\.side\)/.test(app) && has('heroLegHtml', /projLineHtml\(x\.proj, s\.pp\.line, s\.side\)/),
  "Picks of the day's player legs and its hero");

// ---- Picks of the day's NBA legs carry the projection --------------------------------------------
console.log('\n-- the list --');
const sq = new DatabaseSync(':memory:');
const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
const exec = (sql, args, mode) => { const st = sq.prepare(sql); const a = args.map(norm);
  if (mode === 'all') return { results: st.all(...a), meta: {} }; if (mode === 'first') return st.get(...a) || null;
  return { success: true, meta: { changes: Number(st.run(...a).changes) } }; };
const DB = { prepare: (sql) => { const s = { sql, args: [], bind: (...x) => { s.args = x; return s; },
  all: async () => exec(s.sql, s.args, 'all'), first: async (c) => { const r = exec(s.sql, s.args, 'first'); return c && r ? r[c] : r; },
  run: async () => exec(s.sql, s.args, 'run') }; return s; }, batch: async (sts) => sts.map((x) => exec(x.sql, x.args, 'run')) };
const env = { DB };
const mod = await import('data:text/javascript;base64,' + Buffer.from(fs.readFileSync(BOARD + '/worker.js', 'utf8')).toString('base64'));
const get = async (u) => (await mod.default.fetch(new Request('https://x' + u), env, { waitUntil: () => {} })).json();
await get('/api/picks'); await get('/api/nba-pp');
const ptDay = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new RealDate(iso));
const ins = sq.prepare(`INSERT INTO nbapp (date, game_id, player, market, commence, home, away, team, player_id, point, proj, model_under, min_proj, captured_at, model_ver)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'nbapp-v1')`);
for (const l of LEGS) { const [away, home] = l.game.split(' @ ');
  ins.run(...[ptDay(l.commence), l.game_id, l.player, l.market, l.commence, home, away, l.team, l.player_id, l.point, l.proj, l.model_under, l.min_proj, l.first_at].map(norm)); }
const p = await get('/api/picks');
const np = (p.legs || []).filter((x) => x.kind === 'nba_pp');
console.log('  ' + np.map((x) => `${x.title}: proj ${x.proj} against ${x.spec.pp.line}`).join(' | '));
ok(np.length && np.every((x) => LEGS.some((l) => l.player === x.spec.player && l.proj === x.proj)), 'each NBA leg on the list carries its projection');
const wc = np.find((x) => /Wendell Carter/.test(x.title));
ok(wc && text(P.projLineHtml(wc.proj, wc.spec.pp.line, wc.spec.side)) === `proj ${wc.proj} · line 2.5 · ${Math.round((2.5 - wc.proj) * 100) / 100} cushion`,
  `and it draws: "${wc && text(P.projLineHtml(wc.proj, wc.spec.pp.line, wc.spec.side))}"`);

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
