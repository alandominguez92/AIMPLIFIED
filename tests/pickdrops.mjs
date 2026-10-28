// Legs that left Picks of the day before their start, and why (2026-10-27).
//
// On Oct 26 Sion James's threes under led the list at 2 PM (78%). At tip the
// list had Dennis Schroder's threes under in that game instead, posted only at
// the pre-tip read, and James's was gone. He made one three, so his under
// would have landed. Nothing on the page said he had left or why. What has to
// hold:
//   - each day in "How the list did" lists the legs the list showed and
//     dropped before their start, with why and how each would have gone
//   - the reasons come from the log each leg came from: PrizePicks took the
//     line down, moved it, its chance fell under the bar, its line sat below
//     the books', a moneyline fell under its bar, or another leg took its
//     game's place
//   - the day's own count and entries are the list at each start, as before
//   - /api/nba-pp?day= shows one day's legs after the fact, each with where it
//     stood on the list
//
// Real data: production's reads on Oct 26 (tests/fixtures/
// picks-drops-20261026.json) -- the NBA PrizePicks legs at 1:31 PM Pacific as
// the first reads left them, the moneyline log at 1:31 and 1:52 PM, the list
// at 1:31 PM, the day as it graded, and the box-score counts. The pre-tip read
// of Wizards at Hornets is written as it would leave the log if PrizePicks had
// taken James's line down and posted Schroder's threes; which of the reasons
// it actually was, production's own rows say once this is live. Real SQLite
// and the real worker.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const F = JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', 'picks-drops-20261026.json'), 'utf8'));
const RealDate = Date;
let NOW = RealDate.parse('2026-10-26T20:31:48Z');
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
};
globalThis.fetch = async () => new Response('{}', { status: 404 });
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
const mod = await import('data:text/javascript;base64,' + Buffer.from(fs.readFileSync(BOARD + '/worker.js', 'utf8')).toString('base64'));
const get = async (u) => (await mod.default.fetch(new Request('https://x' + u), env, { waitUntil: () => {} })).json();

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

// ---- the logs as production had them at 1:31 PM --------------------------------------------
await get('/api/picks'); await get('/api/nba-pp'); await get('/api/gmpicks-export');   // the tables
const leg = sq.prepare(`INSERT INTO nbapp (date, game_id, player, market, league, commence, home, away, team, player_id, point, proj, model_under, n_recent,
  min_proj, book_line, book_under, captured_at, ud_line, p6_line, sharp_under, sharp_src, l10_n, l10_under, model_ver) VALUES (${Array(25).fill('?').join(',')})`);
// The blocks legs stay out: blocks Mores joined the list on Oct 28, after
// this day, and the test is the list as production had it (2026-10-28).
const BOARD_LEGS = F.board.filter((l) => l.market !== 'blk');
for (const l of BOARD_LEGS) {
  const [away, home] = l.game.split(' @ ');
  leg.run('2026-10-26', l.game_id, l.player, l.market, l.league, l.commence, home, away, l.team, l.player_id, l.point, l.proj, l.model_under, l.n_recent,
    l.min_proj, l.book_line, typeof l.book_under === 'number' ? l.book_under : null, l.first_at, l.ud_line, l.p6_line, l.sharp_under, l.sharp_src, l.l10_n, l.l10_under, 'nbapp-v1');
}
const gcols = Object.keys(F.gm1331[0]);
const gins = sq.prepare(`INSERT INTO gmpicks (${gcols.join(',')}) VALUES (${gcols.map(() => '?').join(',')})`);
for (const r of F.gm1331) gins.run(...gcols.map((k) => r[k]));
const titles = (p) => (p.legs || []).map((l) => `${l.title} ${l.p}`);

console.log('-- 1:31 PM --');
let p = await get('/api/picks');
console.log('  ' + titles(p).join(' | '));
const real1331 = F.picks1331.filter((l) => l.kind !== 'soccer_fav' && l.kind !== 'nfl_ml').map((l) => `${l.title} ${l.p}`);
ok(real1331.every((t) => titles(p).includes(t)) && titles(p)[0] === 'Sion James Under 1.5 3PM 77.9',
  `the list as production showed it, Sion James first (${real1331.join(', ')})`);

console.log('\n-- 1:52 PM: the Heat at 71.3, the Rockets at 64.3 --');
NOW = RealDate.parse('2026-10-26T20:52:44Z');
const upd = sq.prepare('UPDATE gmpicks SET win_prob = ?, close_price = ? WHERE sport = ? AND game_id = ? AND market = ?');
for (const r of F.gm1352) upd.run(r.win_prob, r.close_price, r.sport, r.game_id, r.market);
p = await get('/api/picks');
console.log('  ' + titles(p).join(' | '));
ok(titles(p).includes('Cooper Flagg Under 5.5 AST 71.7') && !titles(p).some((t) => /Heat|Rockets/.test(t)), 'Flagg takes the Heat game; the Rockets leave');

console.log('\n-- 2:40 PM: the pre-tip read of Wizards at Hornets --');
NOW = RealDate.parse('2026-10-26T21:40:00Z');
const game = F.board.find((l) => l.player === 'Sion James').game_id;
sq.prepare(`UPDATE nbapp SET close_point = point, close_under = model_under, close_book_line = book_line, close_book_under = book_under, close_at = ?
  WHERE game_id = ? AND NOT (player = 'Sion James' AND market = 'threes')`).run('2026-10-26T21:40:00Z', game);
const sch = F.board.find((l) => l.player === 'Dennis Schroder');
leg.run('2026-10-26', game, 'Dennis Schroder', 'threes', sch.league, sch.commence, 'Charlotte Hornets', 'Washington Wizards', sch.team, sch.player_id, 1.5, 1.4, 71.5, 10,
  sch.min_proj, null, null, '2026-10-26T21:40:00Z', null, null, null, null, null, null, 'nbapp-v1');
sq.prepare("UPDATE nbapp SET close_point = 1.5, close_under = 71.5, close_at = ? WHERE game_id = ? AND player = 'Dennis Schroder' AND market = 'threes'").run('2026-10-26T21:40:00Z', game);
p = await get('/api/picks');
console.log('  ' + titles(p).join(' | '));
ok(titles(p).includes('Dennis Schroder Under 1.5 3PM 71.5') && !titles(p).some((t) => /Sion James/.test(t)), 'Schroder holds the game at tip, as production had it');

// ---- graded, the next morning -----------------------------------------------------------------
console.log('\n-- Oct 27, graded --');
NOW = RealDate.parse('2026-10-27T15:00:00Z');
const grade = sq.prepare('UPDATE nbapp SET actual = ?, result = ?, close_result = CASE WHEN close_point IS NULL THEN NULL WHEN ? < close_point THEN \'under\' ELSE \'over\' END WHERE game_id = ? AND player = ? AND market = ?');
for (const [who, mk, n] of [['Sion James', 'threes', F.box['Sion James'].threes], ['Dennis Schroder', 'threes', F.box['Dennis Schroder'].threes], ['Cooper Flagg', 'ast', F.box['Cooper Flagg'].ast]]) {
  const line = mk === 'ast' ? 5.5 : 1.5;
  grade.run(n, n < line ? 'under' : 'over', n, F.board.find((l) => l.player === who).game_id, who, mk);
}
for (const [k, g] of Object.entries(F.gmResults)) {
  const [gid, market] = k.split(':');
  sq.prepare('UPDATE gmpicks SET result = ?, home_score = ?, away_score = ? WHERE game_id = ? AND market = ?').run(g.result, g.home_score, g.away_score, gid, market);
}
await get('/api/picks');                                        // the grader runs on every read
p = await get('/api/picks');
const day = (p.record.history.days || []).find((d) => d.date === '2026-10-26') || {};
const lab = (l) => (l || []).map((x) => `${x.label} ${x.result}`);
console.log('  listed: ' + lab(day.legs).join(', '));
const real = lab(F.picksDay.legs);
ok(lab(day.legs).sort().join() === real.sort().join() && day.hit === F.picksDay.hit && day.decided === F.picksDay.decided,
  `the day's own record is the list at each start, as production graded it: ${day.hit} of ${day.decided}`);
const off = day.dropped || [];
for (const x of off) console.log(`  off: ${x.label} ${x.p}% -- ${x.why} -- ${x.result}`);
const offOf = (re) => off.find((x) => re.test(x.label)) || {};
const sj = offOf(/Sion James/), heat = offOf(/Heat/), hou = offOf(/Rockets/);
ok(off.length === 3, `three legs left before their start (${off.length})`);
ok(sj.p === 77.9 && /^PrizePicks took the line down before tip/.test(sj.why) && sj.result === 'hit' && sj.actual === 1,
  'Sion James: taken down at the pre-tip read; one three, so his under would have landed');
ok(/^Cooper Flagg Under 5\.5 AST \(72%\) took its game.s place$/.test(heat.why) && heat.result === 'miss', `the Heat: "${heat.why}", and they lost`);
ok(hou.why === 'its chance was 64.3% by the start, under the 65% bar' && hou.result === 'hit', `the Rockets: "${hou.why}", and they won`);
ok(!off.some((x) => /Thunder|Nuggets|Flagg|Schroder/.test(x.label)), 'no leg that was on the list at its start');

// The other reasons, on the same leg: had the pre-tip read moved his line, or
// left it below the books'.
sq.prepare("UPDATE nbapp SET close_point = 0.5, close_under = 41, close_at = ? WHERE game_id = ? AND player = 'Sion James' AND market = 'threes'").run('2026-10-26T21:40:00Z', game);
let w = offOf.call(null, /Sion James/) && ((await get('/api/picks')).record.history.days.find((d) => d.date === '2026-10-26').dropped || []).find((x) => /Sion James/.test(x.label));
ok(w && w.why === 'PrizePicks moved the line from 1.5 to 0.5; the chance at 0.5 was 41%, under the 70% bar' && w.result === 'hit',
  `moved: "${w && w.why}" -- still graded at the 1.5 the list showed`);
sq.prepare("UPDATE nbapp SET close_point = 1.5, close_under = 77.9, close_book_line = 2.5 WHERE game_id = ? AND player = 'Sion James' AND market = 'threes'").run(game);
w = ((await get('/api/picks')).record.history.days.find((d) => d.date === '2026-10-26').dropped || []).find((x) => /Sion James/.test(x.label));
ok(w && w.why === "PrizePicks' 1.5 sat below the books' 2.5", `below the books: "${w && w.why}"`);
// Back as the test has it: a leg the pre-tip read did not see keeps no close.
sq.prepare("UPDATE nbapp SET close_point = NULL, close_under = NULL, close_book_line = NULL, close_at = NULL WHERE game_id = ? AND player = 'Sion James' AND market = 'threes'").run(game);

// ---- one day's legs, after the fact --------------------------------------------------------------
console.log('\n-- /api/nba-pp?day=2026-10-26 --');
const v = await get('/api/nba-pp?day=2026-10-26');
const vl = (who, mk) => (v.legs || []).find((l) => l.player === who && l.market === mk) || {};
const vs = vl('Sion James', 'threes'), vd = vl('Dennis Schroder', 'threes'), vf = vl('Cooper Flagg', 'ast');
console.log(`  ${v.n} legs, ${v.onPicks} on the list at tip, ${v.dropped} off before`);
ok(v.n === BOARD_LEGS.filter((l) => l.commence < '2026-10-27T07:00:00Z').length + 1 && v.onPicks === 2 && v.dropped === 1, 'every leg of the day, two on the list at tip and one off before');
ok(vs.pulled === true && vs.tip === null && vs.first.line === 1.5 && vs.first.under === 77.9 && vs.actual === 1 && vs.result === 'under'
  && vs.picks && vs.picks.on === false && /^PrizePicks took the line down/.test(vs.picks.why), "Sion James's: first read, taken down, one three, off the list and why");
ok(vd.picks && vd.picks.on === true && vd.picks.result === 'hit' && vd.tip && vd.tip.line === 1.5, "Schroder's: read at tip, on the list, landed");
ok(vf.picks && vf.picks.on === true && vf.picks.result === 'miss' && vf.actual === 11, "Flagg's: on the list, eleven assists");
ok(vl('Sion James', 'ast').picks === null, 'and a leg never on the list says so');
ok(!(await get('/api/nba-pp?day=yesterday')).day, 'only a date opens it');

// ---- the page -----------------------------------------------------------------------------------
console.log('\n-- the page --');
const app = fs.readFileSync(BOARD + '/app.js', 'utf8').replace(/\r\n/g, '\n');
function lift(name) {
  let at = app.indexOf(`function ${name}(`);
  const isConst = at < 0;
  if (isConst) at = app.indexOf(`const ${name} =`);
  let depth = 0;
  for (let i = at; i < app.length; i++) {
    const c = app[i];
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') { depth--; if (!isConst && c === '}' && depth === 0) return app.slice(at, i + 1); }
    else if (isConst && c === ';' && depth === 0 && app[i + 1] === '\n') return app.slice(at, i + 1);
  }
  throw new Error(`could not lift ${name}`);
}
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const card = new Function('esc', ['shortDay', 'pct0', 'HIST_DAY_KEYS', 'movedLineHtml', 'pickHistoryHtml'].map(lift).join('\n') + '\nreturn pickHistoryHtml;')(esc);
const h = (await get('/api/picks')).record.history;
const html = card(h);
const dayHtml = html.split('<details class="pk-day">').find((x) => />Oct 26</.test(x)) || '';
const text = dayHtml.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
console.log('  ' + text.slice(0, 400));
ok(/Oct 26 2 of 4 landed · 3 off before the start/.test(text), 'the day: its count, and how many left before the start');
ok(/Off the list before the start/.test(text) && /Sion James Under 1\.5 3PM PrizePicks took the line down before tip, most often a player ruled out · would have landed 78%/.test(text),
  'his leg under the day, with why and how it went');
ok(/its chance was 64\.3% by the start, under the 65% bar · would have landed/.test(text) && /would have missed/.test(text), 'the Rockets and the Heat beside it');
ok(!/Off the list/.test(card({ ...h, days: h.days.map((d) => ({ ...d, dropped: undefined })) })), 'a day with none shows none');
const css = fs.readFileSync(BOARD + '/style.css', 'utf8');
ok(/\.pk-why \{[^}]*display:block/.test(css), 'the reason sits on its own line under the leg, for a phone');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
