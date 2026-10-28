// PrizePicks More legs: NBA blocks, and the NHL read again for its points and
// assists Mores (2026-10-27).
//
// Through Oct 26, where the model leaned More, NBA blocks landed 26 of 41 and
// 16 of 23 at a More chance of 55%+ (threes and assists Mores 42-45%), and
// NHL points and assists 29 of 51. The NHL's reads had been paused on Oct 25
// for its unders (39 of 84). The owner's call: list both Mores, logged, not
// on Picks of the day, and read the NHL again. (On Oct 28 both joined Picks
// of the day at 55%+: tests/morepicks.mjs.) What has to hold:
//   - the NBA record carries blocks' More: every leg the model leaned More on,
//     and those at 55%+
//   - the NBA card lists the best three blocks Mores to come, at 55%+, one a
//     player, each a star that takes the Over to the slip under its own id
//   - the NHL is read again (NHL_PP_PAUSED off); its card lists Mores at 55%+
//     with their record, and its unders only as a record
//   - Live Now follows the NHL's Mores, and an over in progress is judged as
//     one: past the line it has landed; short, the chance the time left
//     brings it
//
// Real data (tests/fixtures/more-20261027.json): every NBA blocks leg Oct
// 20-26 as production's /api/nba-pp?day= served it, and the NHL legs
// production served on Oct 26 at 1:31 PM Pacific, graded from the NHL's box
// scores. Real SQLite and the real worker.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const F = JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', 'more-20261027.json'), 'utf8'));
const RealDate = Date;
let NOW = RealDate.parse('2026-10-26T20:00:00Z');
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
const src = fs.readFileSync(BOARD + '/worker.js', 'utf8').replace(/\r\n/g, '\n');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const get = async (u) => (await mod.default.fetch(new Request('https://x' + u), env, { waitUntil: () => {} })).json();

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
const rec = (l, side) => `${l.filter((x) => x.result === side).length} of ${l.length}`;

// ---- the logs: Oct 20-25 graded, Monday's still to play ------------------------------------
await get('/api/nba-pp'); await get('/api/nhl-pp');               // the tables
const nba = sq.prepare(`INSERT INTO nbapp (date, game_id, player, market, commence, home, away, team, point, model_under, min_proj, actual, result, model_ver)
  VALUES (?, ?, ?, 'blk', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'nbapp-v1')`);
for (const l of F.nbaBlk) {
  const [away, home] = l.game.split(' @ ');
  const later = l.day === '2026-10-26';
  nba.run(l.day, l.game_id, l.player, l.commence, home, away, l.team, l.first.line, l.first.under, l.min_proj, later ? null : l.actual, later ? null : l.result);
}
const rot = F.nbaBlk.filter((l) => l.min_proj >= 20);
const lean = (l) => l.filter((x) => x.first.under < 50 && (x.result === 'over' || x.result === 'under'));
const bar = (l) => l.filter((x) => 100 - x.first.under >= 55);
const before = rot.filter((l) => l.day < '2026-10-26');

console.log('-- NBA, Monday afternoon --');
let b = await get('/api/nba-pp');
let m = b.record.blkMore || {};
console.log('  blkMore ' + JSON.stringify(m));
ok(m.bar === 55 && m.leaned && m.leaned.n === lean(before).length && m.leaned.hit === lean(before).filter((x) => x.result === 'over').length
  && m.atBar.n === bar(lean(before)).length, `through Oct 25: leaned More ${rec(lean(before), 'over')}, at 55%+ ${rec(bar(lean(before)), 'over')}`);

// The card, lifted from app.js.
const app = fs.readFileSync(BOARD + '/app.js', 'utf8').replace(/\r\n/g, '\n');
function lift(name) {
  let at = app.indexOf(`function ${name}(`);
  const isConst = at < 0;
  if (isConst) at = app.indexOf(`const ${name} =`);
  if (at < 0) throw new Error(`app.js has no ${name}`);
  let depth = 0;
  for (let i = at; i < app.length; i++) {
    const c = app[i];
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') { depth--; if (!isConst && c === '}' && depth === 0) return app.slice(at, i + 1); }
    else if (isConst && c === ';' && depth === 0 && app[i + 1] === '\n') return app.slice(at, i + 1);
  }
  throw new Error(`could not close ${name}`);
}
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const ui = { nbaPp: b, nhlPp: null, slip: {} };
const CARD = ['TEAM_COLORS', 'MLB_TEAM_ID', 'NHL_PHOTO_SEASON', 'headshotUrl', 'teamMarkUrl', 'initialsOf', 'avatarHtml',
  'miniBar', 'projLineHtml', 'LEG_OFFERS', 'offerLeg', 'ptDayOf', 'soccerKick', 'AM', 'MARKET_SHORT', 'NBA_ROTATION_MIN', 'NBA_MK', 'NHL_MK', 'nbaPpLeg', 'nbaOversLineHtml', 'ppMovedTag',
  'ppCloseLineHtml', 'dfsLinesHtml', 'sharpTag', 'ppBookLine', 'ppGameLineHtml', 'PP_MORE_MIN', 'ppMoreP', 'ppMoreMk', 'ppMoreLeg', 'ppMoreTop', 'ppMoreListHtml',
  'ppMoreLineHtml', 'nbaBlkMoreHtml', 'nbaPpCardHtml', 'nhlPpCardHtml'];
let C;
try {
  C = new Function('state', 'esc', CARD.map(lift).join('\n') + '\nreturn { nbaPpCardHtml, nhlPpCardHtml, LEG_OFFERS, liveVs: null };')(ui, esc);
} catch (e) { console.log(`  FAIL  the cards lift out of app.js (${e.message})`); process.exit(1); }
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const card = C.nbaPpCardHtml();
const more = card.split('<span class="tc-title">Blocks: More</span>')[1] || '';
const mon = bar(rot.filter((l) => l.day === '2026-10-26' && l.first.under < 50)).sort((a, x) => a.first.under - x.first.under);
const want = [...new Map(mon.map((l) => [l.player, l])).values()].slice(0, 3);
console.log('  ' + text(more).slice(0, 360));
ok(want.length === 3 && want.every((l) => more.includes(`<b>${l.player}</b><span class="tc-p">${Math.round(100 - l.first.under)}%</span>`))
  && (more.match(/<li>/g) || []).length === 3, `Monday's best three blocks Mores at 55%+: ${want.map((l) => `${l.player} ${Math.round(100 - l.first.under)}%`).join(', ')}`);
ok(/Blocks: where the model leaned More <b>\d+ of \d+<\/b> · at 55%\+ <b>\d+ of \d+<\/b>/.test(more) && /On Picks of the day too, since Oct 28/.test(more), 'with its record (on Picks of the day since Oct 28)');
ok(!/null|undefined/.test(text(more)), 'and no leg prints a projection it does not have (the day view carries none)');
const top = want[0];
const lg = C.LEG_OFFERS.get(`nbapp:${top.game_id}:${top.player}:blk:over`);
ok(lg && lg.spec.side === 'Over' && lg.title === `${top.player} Over ${top.first.line} blocks` && lg.spec.pp.under === top.first.under,
  `its star takes the Over, under its own id (${lg && lg.title})`);
ok(card.indexOf('PrizePicks unders') < card.indexOf('Blocks: More'), 'under the unders');

console.log('\n-- NBA, graded --');
for (const l of F.nbaBlk.filter((x) => x.day === '2026-10-26')) sq.prepare('UPDATE nbapp SET actual = ?, result = ? WHERE date = ? AND game_id = ? AND player = ? AND market = \'blk\'').run(l.actual, l.result, l.day, l.game_id, l.player);
NOW = RealDate.parse('2026-10-27T15:00:00Z');
m = (await get('/api/nba-pp')).record.blkMore;
ok(m.leaned.hit === 26 && m.leaned.n === 41 && m.atBar.hit === 16 && m.atBar.n === 23, `through Oct 26, as production had it: ${m.leaned.hit} of ${m.leaned.n}, at 55%+ ${m.atBar.hit} of ${m.atBar.n}`);

// ---- the NHL ------------------------------------------------------------------------------------
console.log('\n-- NHL, read again --');
ok(/const NHL_PP_PAUSED = false;/.test(src), 'NHL_PP_PAUSED is off: the cron reads PrizePicks again');
NOW = RealDate.parse('2026-10-26T21:00:00Z');
const nhl = sq.prepare(`INSERT INTO nhlpp (date, game_id, player, market, commence, home, away, team, player_id, point, model_under, proj, captured_at)
  VALUES ('2026-10-26', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
for (const l of F.nhlLegs) { const [away, home] = l.game.split(' @ '); nhl.run(l.game_id, l.player, l.market, l.commence, home, away, l.team, l.player_id, l.point, l.model_under, l.proj, l.first_at); }
let h = await get('/api/nhl-pp');
ok(h.paused === undefined, 'the board no longer says paused');
ui.nhlPp = h;
const nc = C.nhlPpCardHtml();
const nMore = F.nhlLegs.filter((l) => 100 - l.model_under >= 55).sort((a, x) => a.model_under - x.model_under);
console.log('  ' + text(nc).slice(0, 420));
ok(/<span class="tc-title">PrizePicks: More<\/span>/.test(nc) && (nc.match(/<li>/g) || []).length === nMore.length
  && nMore.every((l) => nc.includes(`<b>${l.player}</b><span class="tc-p">${Math.round(100 - l.model_under)}%</span>`)),
  `the NHL card lists Mores at 55%+: ${nMore.map((l) => `${l.player} ${Math.round(100 - l.model_under)}%`).join(', ')}`);
ok(!/Easton Cowan/.test(nc) && !/Under 0\.5/.test(nc), 'Cowan at 54.6% and every under are left off');
ok(/Over 1\.5 points/.test(nc) && C.LEG_OFFERS.get(`nhlpp:${nMore[1].game_id}:Leon Draisaitl:pts:over`).spec.side === 'Over', "Draisaitl's Over 1.5 points, a star that takes the Over");

console.log('\n-- NHL, graded --');
for (const l of F.nhlLegs) {
  const a = F.nhlActual[`${l.player}:${l.market}`];
  sq.prepare('UPDATE nhlpp SET actual = ?, result = ? WHERE player = ? AND market = ?').run(a, a < l.point ? 'under' : a > l.point ? 'over' : 'push', l.player, l.market);
}
NOW = RealDate.parse('2026-10-27T15:00:00Z');
h = await get('/api/nhl-pp');
const graded = F.nhlLegs.map((l) => ({ ...l, result: F.nhlActual[`${l.player}:${l.market}`] < l.point ? 'under' : 'over' }));
const nl = graded.filter((l) => l.model_under < 50), nb = nl.filter((l) => 100 - l.model_under >= 55);
console.log('  more ' + JSON.stringify(h.record.more));
ok(h.record.more.leaned.n === nl.length && h.record.more.leaned.hit === nl.filter((l) => l.result === 'over').length && h.record.more.atBar.hit === 2 && h.record.more.atBar.n === 3,
  `Monday's: leaned More ${rec(nl, 'over')}, at 55%+ ${rec(nb, 'over')} (Draisaitl had one point against 1.5)`);
ui.nhlPp = h;
ok(/More: where the model leaned More <b>5 of 6<\/b> · at 55%\+ <b>2 of 3<\/b>/.test(C.nhlPpCardHtml()) && /Unders, no longer listed: <b>\d+ of \d+<\/b>/.test(C.nhlPpCardHtml()),
  'the card: the Mores record, and the unders as a record only');

// ---- Live Now ----------------------------------------------------------------------------------
console.log('\n-- Live: an over in progress --');
const wlift = (name) => { const at = src.indexOf(`function ${name}(`); let d = 0;
  for (let i = src.indexOf('{', at); i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}' && --d === 0) return src.slice(at, i + 1); } };
const liveOverState = new Function(wlift('liveOverState') + '\nreturn liveOverState;')();
// Podkolzin, 0.89 points a game, over 0.5.
ok(liveOverState(1, 0.5, 0.3, 0.89) === 'cashing', 'a point against 0.5: landed');
ok(liveOverState(0, 0.5, 0.2, 0.89) === 'live' && liveOverState(0, 0.5, 0.6, 0.89) === 'cooling',
  'none yet: live with most of the game left (51%), cooling past the second intermission (30%)');
ok(liveOverState(1, 1.5, 0.5, 1.9) === 'live' && liveOverState(0, 1.5, 0.5, 1.9) === 'cooling', 'Draisaitl over 1.5 at half: one point in, live; none, cooling (two more needed)');
ok(/liveMeta\(g\), 'Over'\)\);/.test(wlift('nhlLiveCards')) && /more\(r\) >= PP_MORE_MIN/.test(wlift('nhlLiveCards')), "and Live follows the NHL's Mores at 55%+");

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
