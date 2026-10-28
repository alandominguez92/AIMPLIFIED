// Three things from Unabated's prop guides (2026-10-27).
//
//   - Pick6 lines off the market. DraftKings Pick6 seldom moves a line once
//     it posts it ("Introducing Market-Based Prop Projections"), so when the
//     books move during the day its number goes stale. Each NBA leg the reads
//     see on Pick6 carries the sharp books' chance at Pick6's own line, and
//     either side at 58%+ (a 2-pick needs 57.7% a leg) is listed.
//   - The market blended into the NBA unders chance. Unabated blends a
//     market-based projection into its own; here the market has been the
//     honest one (the model's 70%+ unders 10 of 16; the sharp books' sub-50%
//     legs 32 of 64), so where the sharp books priced him the chance Picks
//     ranks and stakes on is a quarter the model's and three quarters theirs.
//     Qualifying is still the model's 70%+.
//   - Smaller stakes on props ("Profitable Prop Betting in 3 Easy Steps":
//     Kelly overstates prop edges, and books limit prop winners): a prop at a
//     price stakes at most 1% of the bankroll, a pick'em entry 2%.
//
// Real data: production's NBA props read of Nets at Celtics at 10:45 PM
// Pacific on Oct 26 (tests/fixtures/odds-nba-pp-raw-20261027.json: Pick6 at
// 7.5 on Day'Ron Sharpe's rebounds, FanDuel and Novig at 8.5), and the NBA
// legs the model rated 70%+ at 12:40 AM Pacific on Oct 28, before the books
// had posted them (nba-pp-legs-20261028.json). The pre-tip read's sharp
// chance on Wendell Carter Jr is written as that read would leave it. Real
// SQLite and the real worker.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const read = (f) => JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', f), 'utf8'));
const RAW = read('odds-nba-pp-raw-20261027.json'), LEGS = read('nba-pp-legs-20261028.json').legs;
const RealDate = Date;
let NOW = RealDate.parse('2026-10-28T08:00:00Z');
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
const worker = fs.readFileSync(BOARD + '/worker.js', 'utf8').replace(/\r\n/g, '\n');
const mod = await import('data:text/javascript;base64,' + Buffer.from(worker).toString('base64'));
const get = async (u) => (await mod.default.fetch(new Request('https://x' + u), env, { waitUntil: () => {} })).json();
const lift = (name) => { const fn = worker.indexOf(`\nfunction ${name}(`);
  if (fn >= 0) { let d = 0; for (let i = worker.indexOf('{', fn); i < worker.length; i++) { if (worker[i] === '{') d++; else if (worker[i] === '}' && --d === 0) return worker.slice(fn + 1, i + 1); } }
  const at = worker.search(new RegExp(`\\n(const|let) ${name} =`)); let d = 0;
  for (let i = at + 1; i < worker.length; i++) { const c = worker[i]; if ('{(['.includes(c)) d++; else if ('})]'.includes(c)) d--; else if (c === ';' && d === 0) return worker.slice(at + 1, i + 1); } };
const W = new Function(['NBA_SHARP', 'NBA_PROP_SHARP', 'amProb', 'shinDevig', 'poissonCdf', 'negBinomCdf', 'round1', 'normName', 'NFL_NAME_SUFFIX', 'nflBaseName',
  'nbaBaseName', 'NBA_NAME_ALIAS', 'NBA_ALIAS', 'nbaName', 'nbaSharpUnder', 'NBA_DISP'].map(lift).join('\n') + '\nreturn { nbaSharpUnder, nbaName, NBA_DISP, round1 };')();

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
const ptDay = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new RealDate(iso));
await get('/api/picks'); await get('/api/nba-pp');                // the tables
const ins = sq.prepare(`INSERT INTO nbapp (date, game_id, player, market, commence, home, away, team, player_id, point, proj, model_under, min_proj, book_line,
  sharp_under, p6_line, p6_sharp_under, captured_at, model_ver) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'nbapp-v1')`);

// ---- the blend --------------------------------------------------------------------------------
console.log('-- NBA unders on Picks, 1 AM Wednesday --');
for (const l of LEGS) { const [away, home] = l.game.split(' @ ');
  ins.run(...[ptDay(l.commence), l.game_id, l.player, l.market, l.commence, home, away, l.team, l.player_id, l.point, l.proj, l.model_under, l.min_proj, l.book_line,
    l.sharp_under, null, null, l.first_at].map(norm)); }
let p = await get('/api/picks');
const np = (pk) => (pk.legs || []).filter((x) => x.kind === 'nba_pp');
console.log('  ' + np(p).map((x) => `${x.title} ${x.p}% (model ${x.modelP}%)`).join(' | '));
ok(np(p).length && np(p).every((x) => x.p === x.modelP && LEGS.some((l) => l.model_under === x.modelP)),
  'no sharp book has priced them yet: the chance is the model\'s own');
// The pre-tip read, as it would write Carter's row once the books post him.
const carter = LEGS.find((l) => l.player === 'Wendell Carter Jr');
sq.prepare("UPDATE nbapp SET close_point = point, close_under = model_under, close_sharp_under = 55, close_at = '2026-10-28T22:10:00Z' WHERE player = 'Wendell Carter Jr' AND market = 'ast'").run();
p = await get('/api/picks');
const c = np(p).find((x) => /Wendell Carter/.test(x.title));
const want = W.round1(0.25 * carter.model_under + 0.75 * 55);
ok(c && c.p === want && c.modelP === carter.model_under && c.sharp === 55 && c.spec.pp.under === want,
  `with the sharp books at 55%, Carter's 76.8% reads ${c && c.p}%: a quarter the model's, three quarters theirs, on the slip too`);
const rank = np(p).map((x) => x.title);
ok(rank.indexOf(c.title) === rank.length - 1, `and he drops to the bottom of the NBA unders (${rank.join(', ')})`);
ok((p.kinds.nba_pp.min === 70) && LEGS.every((l) => l.model_under >= 70), 'qualifying is still the model\'s 70%+');

// ---- the caps ----------------------------------------------------------------------------------
console.log('\n-- the stakes --');
const pe = p.entries || [];
console.log('  ' + pe.map((e) => `${e.entry} +${e.ev}% stake ${e.stake}%${e.capped ? ' (cap)' : ''}`).join(' | '));
ok(pe.length && pe.every((e) => e.stake <= 2) && pe.some((e) => e.capped), 'no PrizePicks entry stakes more than 2% of the bankroll, however big its edge reads');

// ---- Pick6 off the market ----------------------------------------------------------------------
console.log('\n-- Pick6, Nets at Celtics, 11 PM Monday --');
NOW = RealDate.parse('2026-10-27T06:00:00Z');
const ev = RAW.payload;
const p6 = ev.bookmakers.find((b) => b.key === 'pick6');
const MK = { player_rebounds: 'reb', player_assists: 'ast', player_threes: 'threes' };
const priced = [];
for (const m of p6.markets) for (const o of m.outcomes.filter((x) => x.name === 'Under')) {
  const sh = W.nbaSharpUnder(ev, m.key, W.nbaName(o.description), o.point, W.NBA_DISP[MK[m.key]]);
  priced.push({ player: o.description, market: MK[m.key], line: o.point, under: sh && sh.under });
  ins.run(...[ptDay(ev.commence_time), ev.id, o.description, MK[m.key], ev.commence_time, ev.home_team, ev.away_team, null, null,
    o.description === "Day'Ron Sharpe" && MK[m.key] === 'reb' ? 8 : o.point, 1, 50, 25, null, null, o.point, sh && sh.under, RAW.at].map(norm));
}
console.log('  ' + priced.map((x) => `${x.player} ${x.market} ${x.line}: sharp under ${x.under}%`).join(' | '));
p = await get('/api/picks');
const pk = p.pickemEdges || [];
console.log('  ' + pk.map((x) => `${x.label} ${x.chance}% (+${x.edge})`).join(' | '));
const sharpe = priced.find((x) => x.player === "Day'Ron Sharpe" && x.market === 'reb');
ok(sharpe.under === 42 && pk.length === 1 && pk[0].label === "Day'Ron Sharpe More 7.5 REB" && pk[0].chance === 58 && pk[0].edge === 0.3 && pk[0].ppLine === 8,
  "Sharpe's rebounds: Pick6 still at 7.5 with FanDuel and Novig at 8.5 -- More at 58% by the sharp books, PrizePicks at 8");
ok(!pk.some((x) => /Randle|assists|AST/.test(x.label)), 'his assists (More 53.7%) and Randle\'s rebounds (Less 51.9%) are not enough');
ok(/const sh6 = p6l != null \? nbaSharpUnder\(ev, m\.key, name, p6l, NBA_DISP\[market\]\) : null;/.test(worker) && /p6_sharp_under=\? WHERE/.test(worker),
  'the NBA read prices Pick6\'s line with the sharp books, and the pre-tip read refreshes it');

// ---- the page ----------------------------------------------------------------------------------
console.log('\n-- the page --');
const app = fs.readFileSync(BOARD + '/app.js', 'utf8').replace(/\r\n/g, '\n');
const alift = (name) => { const at = app.indexOf(`function ${name}(`); let d = 0;
  for (let i = app.indexOf('{', at); i < app.length; i++) { if (app[i] === '{') d++; else if (app[i] === '}' && --d === 0) return app.slice(at, i + 1); } };
const pick6 = new Function('esc', 'pct0', 'soccerKick', alift('pickemHtml') + '\nreturn pickemHtml;')((s) => String(s), (v) => `${Math.round(v)}%`, (t) => t);
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const ph = text(pick6(p));
console.log('  ' + ph.slice(0, 300));
ok(/Pick6 lines off the market/.test(ph) && /Day'Ron Sharpe More 7\.5 REB 58%/.test(ph) && /sharp 58% · \+0\.3 over 57\.7% · PrizePicks 8/.test(ph), 'the edge card lists it, with PrizePicks\' own number beside');
ok(pick6({ pickemEdges: [] }) === '', 'and nothing when no Pick6 line is off');
ok(/model \$\{esc\(pct0\(x\.modelP\)\)\}/.test(app) && /\(cap\)/.test(app), "a Picks leg shows the model's chance beside the blended one, and a capped stake says so");

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
