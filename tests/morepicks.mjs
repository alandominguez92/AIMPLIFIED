// The PrizePicks entry from its own pool, and the two Mores on Picks of the
// day (2026-10-28).
//
// On Oct 28 the list's six were four moneylines and two PrizePicks legs, so
// the entry it priced was a 2-pick power. The owner's call: build the entry
// from the legs PrizePicks takes, the best of each game among everything that
// qualifies, and list the two Mores that have held up -- NBA blocks and NHL
// points/assists at 55%+. What has to hold:
//   - both Mores are kinds of leg on Picks of the day at 55%+, each with its
//     record from its own log at that bar
//   - a blocks More the sharp books priced is blended the way the unders are,
//     on the More side, and has to clear 55% on that chance as well as the
//     model's (55% is near PrizePicks' break-even)
//   - the entry's pool is the best PrizePicks leg of each game, from every leg
//     that qualifies -- the list as it would be without the sportsbook bets --
//     and the entries are priced over it
//   - a More grades on the over, and a More that leaves the list says why on
//     its own side and bar
//   - the page lists the pool's legs when it reaches past the list
//   - and the day record's Power and Flex units grade that pool, as it stood
//     at each start, from its first logged day; the list's own top-two count
//     stays the list's, and its units from before the pool stay as a line
//     (2026-10-28, the owner's call)
//
// Real data: production on Monday Oct 26 -- the NBA unders at 1:31 PM and the
// moneyline log then (tests/fixtures/picks-drops-20261026.json), every NBA
// blocks leg Oct 20-26 with its first and pre-tip reads, and the NHL legs at
// 1:31 PM with the box-score counts (tests/fixtures/more-20261027.json). The
// unders' pre-tip reads are not in the recording: where a game had one, its
// unders are written as kept at their first lines. Real SQLite and the real
// worker.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const D = JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', 'picks-drops-20261026.json'), 'utf8'));
const M = JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', 'more-20261027.json'), 'utf8'));
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
const titles = (l) => (l || []).map((x) => `${x.title} ${x.p}`);

// ---- the logs as production had them at 1:31 PM --------------------------------------------
await get('/api/picks'); await get('/api/nba-pp'); await get('/api/nhl-pp'); await get('/api/gmpicks-export');   // the tables
const under = sq.prepare(`INSERT INTO nbapp (date, game_id, player, market, league, commence, home, away, team, player_id, point, proj, model_under, n_recent,
  min_proj, book_line, book_under, captured_at, ud_line, p6_line, sharp_under, sharp_src, l10_n, l10_under, model_ver) VALUES (${Array(25).fill('?').join(',')})`);
for (const l of D.board.filter((x) => x.market !== 'blk')) {          // blocks from the blocks recording below
  const [away, home] = l.game.split(' @ ');
  under.run('2026-10-26', l.game_id, l.player, l.market, l.league, l.commence, home, away, l.team, l.player_id, l.point, l.proj, l.model_under, l.n_recent,
    l.min_proj, l.book_line, typeof l.book_under === 'number' ? l.book_under : null, l.first_at, l.ud_line, l.p6_line, l.sharp_under, l.sharp_src, l.l10_n, l.l10_under, 'nbapp-v1');
}
const blk = sq.prepare(`INSERT INTO nbapp (date, game_id, player, market, commence, home, away, team, point, model_under, min_proj, book_line, book_under, sharp_under,
  captured_at, actual, result, model_ver) VALUES (?, ?, ?, 'blk', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'nbapp-v1')`);
const blkIn = new Set();
const seedBlocks = () => {                                        // each as its first read posted it
  for (const l of M.nbaBlk) {
    const k = `${l.day}:${l.game_id}:${l.player}`;
    if (blkIn.has(k) || Date.parse(l.first.at) > NOW) continue;
    blkIn.add(k);
    const [away, home] = l.game.split(' @ ');
    const later = l.day === '2026-10-26';
    blk.run(l.day, l.game_id, l.player, l.commence, home, away, l.team, l.first.line, l.first.under, l.min_proj, l.first.book,
      typeof l.first.book_under === 'number' ? l.first.book_under : null, l.first.sharp, l.first.at, later ? null : l.actual, later ? null : l.result);
  }
};
seedBlocks();
const nhl = sq.prepare(`INSERT INTO nhlpp (date, game_id, player, market, commence, home, away, team, player_id, point, model_under, proj, toi_proj, captured_at)
  VALUES ('2026-10-26', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
for (const l of M.nhlLegs) { const [away, home] = l.game.split(' @ '); nhl.run(l.game_id, l.player, l.market, l.commence, home, away, l.team, l.player_id, l.point, l.model_under, l.proj, l.toi_proj, l.first_at); }

// The PrizePicks legs alone: what the list would be without the sportsbook bets.
let p = await get('/api/picks');
const ppOnly = titles(p.legs);
sq.prepare('DELETE FROM daypicks').run();                         // that read was the test's, not the day's
const gcols = Object.keys(D.gm1331[0]);
const gins = sq.prepare(`INSERT INTO gmpicks (${gcols.join(',')}) VALUES (${gcols.map(() => '?').join(',')})`);
for (const r of D.gm1331) gins.run(...gcols.map((k) => r[k]));

console.log('-- 1:31 PM --');
p = await get('/api/picks');
const reads = [{ at: NOW, pool: p.ppPool }];              // each read's pool, for the record below
console.log('  list: ' + titles(p.legs).join(' | '));
console.log('  pool: ' + titles(p.ppPool).join(' | '));
ok(p.rules.nba_blk_more === 'NBA blocks More (PrizePicks), 55%+' && p.rules.nhl_more === 'NHL points/assists More (PrizePicks), 55%+',
  'both Mores are kinds of leg on the list, at 55%+');
const rot = M.nbaBlk.filter((l) => l.min_proj >= 20 && (l.result === 'over' || l.result === 'under') && 100 - l.first.under >= 55);
const thru25 = rot.filter((l) => l.day < '2026-10-26');
const kb = p.kinds.nba_blk_more.record;
ok(kb.n === thru25.length && kb.hit === thru25.filter((l) => l.result === 'over').length,
  `the blocks More's record, rotation players at 55%+ through Oct 25: ${kb.hit} of ${kb.n}`);
ok(p.kinds.nhl_more.record.n === 0, 'the NHL More has none graded yet');
const real1331 = D.picks1331.filter((l) => l.kind !== 'soccer_fav' && l.kind !== 'nfl_ml').map((l) => `${l.title} ${l.p}`);
const wil = (p.legs || []).find((x) => /Caleb Wilson/.test(x.title));
ok(real1331.every((t) => titles(p.legs).includes(t)) && wil && wil.kind === 'nba_blk_more' && wil.p === 71.1 && wil.spec.side === 'Over' && wil.title === 'Caleb Wilson Over 0.5 BLK',
  `the list as production had it, and Caleb Wilson's blocks More beside it (${wil && `${wil.title} ${wil.p}`})`);

console.log('\n-- the entry\'s pool --');
ok(p.ppPool && p.ppPool.length === 6 && titles(p.ppPool).join() === ppOnly.join(), 'the pool is the list as it would be without the sportsbook bets: six PrizePicks legs, one a game');
ok(new Set(p.ppPool.map((x) => x.spec.gamePk)).size === p.ppPool.length && p.ppPool.every((x, i, a) => !i || a[i - 1].p >= x.p), 'one a game, best first');
const offList = p.ppPool.filter((x) => !p.legs.some((l) => l.legId === x.legId));
ok(offList.length === 4 && offList.some((x) => x.title === 'Cooper Flagg Under 5.5 AST'),
  `four of them not on the list, where a moneyline held the game: ${offList.map((x) => x.title).join(', ')}`);
ok(p.legs.filter((x) => x.ppOk).map((x) => x.title).join() === 'Sion James Under 1.5 3PM,Caleb Wilson Over 0.5 BLK' && !p.legs.some((x) => /ML$/.test(x.title) && x.ppOk),
  "the list's own PrizePicks legs are marked; its moneylines are not");
const e2 = p.entries.find((e) => e.legs === 2), e6 = p.entries.find((e) => e.legs === 6);
ok(p.entries.length === 5 && e2.avgLeg === Math.round((p.ppPool[0].p + p.ppPool[1].p) / 2 * 10) / 10
  && e6.avgLeg === Math.round(p.ppPool.reduce((a, x) => a + x.p, 0) / 6 * 10) / 10,
  `entries of two to six, priced over the pool (2-pick ${e2 && e2.avgLeg}%, 6-pick ${e6 && e6.avgLeg}% a leg)`);

// ---- 3:10 PM: the pre-tip reads of Wilson's game -------------------------------------------
console.log('\n-- 3:10 PM: the pre-tip read of Bulls at Celtics --');
NOW = RealDate.parse('2026-10-26T22:10:45Z');
const tipRead = () => {
  for (const l of M.nbaBlk.filter((x) => x.day === '2026-10-26' && x.tip && Date.parse(x.tip.at) <= NOW)) {
    sq.prepare(`UPDATE nbapp SET close_point = ?, close_under = ?, close_book_line = ?, close_book_under = ?, close_sharp_under = ?, close_at = ?
      WHERE date = '2026-10-26' AND game_id = ? AND player = ? AND market = 'blk'`)
      .run(l.tip.line, l.tip.under, l.tip.book, typeof l.tip.book_under === 'number' ? l.tip.book_under : null, l.tip.sharp, l.tip.at, l.game_id, l.player);
    // The unders in a game read before tip, kept at their first lines.
    sq.prepare(`UPDATE nbapp SET close_point = point, close_under = model_under, close_book_line = book_line, close_book_under = book_under, close_at = ?
      WHERE date = '2026-10-26' AND game_id = ? AND market <> 'blk' AND close_at IS NULL`).run(l.tip.at, l.game_id);
  }
};
seedBlocks(); tipRead();
p = await get('/api/picks');
reads.push({ at: NOW, pool: p.ppPool });
console.log('  list: ' + titles(p.legs).join(' | '));
const wil2 = [...p.legs, ...p.ppPool].find((x) => /Caleb Wilson/.test(x.title));
ok(wil2 && wil2.p === 56.2 && wil2.sharp === 51.2 && wil2.modelP === 71.1,
  `the sharp books had his More at 51.2%: a quarter the model's 71.1 and three quarters theirs, 56.2 (${wil2 && wil2.p})`);
const wilOn = p.legs.some((x) => /Caleb Wilson/.test(x.title));

// ---- 6 PM: the late games ------------------------------------------------------------------
console.log('\n-- 6 PM: Red Wings at Oilers to come --');
NOW = RealDate.parse('2026-10-27T01:00:00Z');
seedBlocks(); tipRead();
p = await get('/api/picks');
reads.push({ at: NOW, pool: p.ppPool });
console.log('  list: ' + titles(p.legs).join(' | '));
console.log('  pool: ' + titles(p.ppPool).join(' | '));
const pod = [...p.legs, ...p.ppPool].find((x) => /Podkolzin/.test(x.title));
ok(pod && pod.kind === 'nhl_more' && pod.title === 'Vasily Podkolzin Over 0.5 PTS' && pod.p === 59 && pod.sub === 'Red Wings @ Oilers' && pod.spec.side === 'Over' && pod.proj === 0.89,
  `the NHL's best More of the game, with his projection for the bar: ${pod && `${pod.title} ${pod.p}% (${pod.sub})`}`);
ok(![...p.legs, ...p.ppPool].some((x) => /Draisaitl/.test(x.title)), 'and Draisaitl, in the same game at 56.7, is not');
ok(p.legs.some((x) => x.legId === pod.legId) && pod.legId === `nhlpp:${pod.spec.gamePk}:Vasily Podkolzin:pts:over`, "on the list, under the id the NHL card's star uses");
// Zach Edey's More: the model's 55.8 clears the bar, but the sharp books had
// it at 42.5, so the chance the list would state is 45.8 -- under break-even.
const edey = M.nbaBlk.find((l) => l.day === '2026-10-26' && l.player === 'Zach Edey');
ok(100 - edey.first.under >= 55 && Math.round((0.25 * (100 - edey.first.under) + 0.75 * (100 - edey.first.sharp)) * 10) / 10 === 45.8
  && ![...p.legs, ...p.ppPool].some((x) => /Edey/.test(x.title)), 'a More has to clear the bar on the chance the list states: Edey at 45.8 stays off');

// ---- graded, the next morning -----------------------------------------------------------------
console.log('\n-- Oct 27, graded --');
NOW = RealDate.parse('2026-10-27T15:00:00Z');
for (const l of M.nbaBlk.filter((x) => x.day === '2026-10-26')) {
  sq.prepare(`UPDATE nbapp SET actual = ?, result = ?, close_result = ? WHERE date = '2026-10-26' AND game_id = ? AND player = ? AND market = 'blk'`)
    .run(l.actual, l.result, l.tipResult, l.game_id, l.player);
}
for (const l of M.nhlLegs) {
  const a = M.nhlActual[`${l.player}:${l.market}`];
  sq.prepare('UPDATE nhlpp SET actual = ?, result = ? WHERE player = ? AND market = ?').run(a, a < l.point ? 'under' : a > l.point ? 'over' : 'push', l.player, l.market);
}
for (const [who, mk, n] of [['Sion James', 'threes', D.box['Sion James'].threes], ['Cooper Flagg', 'ast', D.box['Cooper Flagg'].ast]]) {
  sq.prepare('UPDATE nbapp SET actual = ?, result = ? WHERE player = ? AND market = ?').run(n, n < (mk === 'ast' ? 5.5 : 1.5) ? 'under' : 'over', who, mk);
}
for (const [k, g] of Object.entries(D.gmResults)) {
  const [gid, market] = k.split(':');
  sq.prepare('UPDATE gmpicks SET result = ?, home_score = ?, away_score = ? WHERE game_id = ? AND market = ?').run(g.result, g.home_score, g.away_score, gid, market);
}
await get('/api/picks');                                        // the grader runs on every read
p = await get('/api/picks');
const day = (p.record.history.days || []).find((d) => d.date === '2026-10-26') || {};
const lab = (l) => (l || []).map((x) => `${x.label} ${x.result}`);
console.log('  listed: ' + lab(day.legs).join(', '));
for (const x of day.dropped || []) console.log(`  off: ${x.label} ${x.p}% -- ${x.why} -- ${x.result}`);
ok(lab(day.legs).includes('Vasily Podkolzin Over 0.5 PTS hit'), 'a More grades on the over: Podkolzin had a point against 0.5, so his landed');
const wd = wilOn ? (day.legs || []).find((x) => /Caleb Wilson/.test(x.label)) : (day.dropped || []).find((x) => /Caleb Wilson/.test(x.label));
ok(wd && wd.result === 'hit', `Caleb Wilson had two blocks against 0.5: ${wd && wd.result}${wilOn ? ', on the list at tip' : ` -- off before tip: "${wd && wd.why}"`}`);
ok(p.kinds.nba_blk_more.record.hit === 16 && p.kinds.nba_blk_more.record.n === 23 && p.kinds.nhl_more.record.hit === 2 && p.kinds.nhl_more.record.n === 3,
  `the records through Oct 26, as the cards count them: blocks ${p.kinds.nba_blk_more.record.hit} of ${p.kinds.nba_blk_more.record.n}, NHL ${p.kinds.nhl_more.record.hit} of ${p.kinds.nhl_more.record.n}`);

// ---- the entry's record (2026-10-28) ---------------------------------------------------------
// The units are the pool's at each start: each leg as the last read before
// its game had it, ranked by that chance.
console.log('\n-- the entry, graded --');
const wantPool = [];
for (const id of new Set(reads.flatMap((r) => r.pool.map((x) => x.legId)))) {
  const start = Date.parse(reads.flatMap((r) => r.pool).find((x) => x.legId === id).commence);
  const last = reads.filter((r) => r.at < start).pop();
  const x = last && last.pool.find((y) => y.legId === id);
  if (x) wantPool.push({ label: x.title, p: x.p });
}
wantPool.sort((a, b) => b.p - a.p);
const h = p.record.history;
console.log('  pool at each start: ' + (day.pool || []).map((x) => `${x.label} ${x.p} ${x.result}`).join(', '));
console.log('  units: ' + h.entries.filter((e) => e.days || e.refunds).map((e) => `${e.label} ${e.units} (${e.won} of ${e.days}, ${e.refunds} refunds)`).join(' | '));
ok(h.entriesFrom === 'pool' && h.poolSince === '2026-10-26' && (day.pool || []).map((x) => `${x.label} ${x.p}`).join() === wantPool.map((x) => `${x.label} ${x.p}`).join(),
  `the day's entry is the pool at each start, best first (${wantPool.length} legs)`);
// Each graded from its own log, against the box scores: James one three,
// Flagg eleven assists, Holmgren did not play, Wilson two blocks, Podkolzin and
// Roslovic a point each.
const blkRes = (who) => ({ over: 'hit', under: 'miss', void: 'void' })[M.nbaBlk.find((l) => l.day === '2026-10-26' && l.player === who).result];
const truth = { 'Sion James Under 1.5 3PM': D.box['Sion James'].threes < 1.5 ? 'hit' : 'miss', 'Cooper Flagg Under 5.5 AST': D.box['Cooper Flagg'].ast < 5.5 ? 'hit' : 'miss',
  'Chet Holmgren Over 1.5 BLK': blkRes('Chet Holmgren'), 'Caleb Wilson Over 0.5 BLK': blkRes('Caleb Wilson'),
  'Vasily Podkolzin Over 0.5 PTS': M.nhlActual['Vasily Podkolzin:pts'] > 0.5 ? 'hit' : 'miss', 'Jack Roslovic Over 0.5 PTS': M.nhlActual['Jack Roslovic:pts'] > 0.5 ? 'hit' : 'miss' };
ok((day.pool || []).length === 6 && day.pool.every((x) => truth[x.label] === x.result), 'every leg of it graded, its pool-only legs too, as the box scores had them');
const pe = (k) => h.entries.find((e) => e.key === k) || {};
ok(day.entries.p2 && day.entries.p2.net === -1 && pe('p2').days === 1 && pe('p2').units === -1 && day.entries.f3.refund === true && pe('f6').refunds === 1 && pe('f6').days === 0,
  "the units are the entry's: the top two (James landed, Flagg missed) lost the Power; Holmgren's void made each Flex a refund");
const lp2 = h.listTotals.find((e) => e.key === 'p2');
ok(p.record.top2.days === 1 && p.record.top2.bothHit === 1 && lp2.units === 2 && (h.listEntries || []).every((e) => !e.days),
  "and the list's own top two (James and the Thunder, both landed) stay the list's count; no list days before the pool");

// A More that leaves the list says why on its own side and bar: had the
// pre-tip read put his More at 47%.
sq.prepare("UPDATE daypicks SET on_list = 0 WHERE label LIKE 'Vasily Podkolzin%'").run();
sq.prepare("UPDATE nhlpp SET close_point = 0.5, close_under = 53, close_at = ? WHERE player = 'Vasily Podkolzin'").run('2026-10-27T01:10:00Z');
let pd = ((await get('/api/picks')).record.history.days.find((d) => d.date === '2026-10-26').dropped || []).find((x) => /Podkolzin/.test(x.label));
ok(pd && pd.why === 'the chance at 0.5 was 47%, under the 55% bar' && pd.result === 'hit', `"${pd && pd.why}", and it would have landed`);
sq.prepare("UPDATE nhlpp SET close_point = NULL, close_under = NULL WHERE player = 'Vasily Podkolzin'").run();
pd = ((await get('/api/picks')).record.history.days.find((d) => d.date === '2026-10-26').dropped || []).find((x) => /Podkolzin/.test(x.label));
ok(pd && pd.why === 'PrizePicks took the line down before puck drop, most often a player ruled out', `taken down: "${pd && pd.why}"`);
// And had the sharp books priced Wilson's More as they did Edey's (42.5).
sq.prepare("UPDATE nbapp SET close_sharp_under = 57.5 WHERE date = '2026-10-26' AND player = 'Caleb Wilson' AND market = 'blk'").run();
const wd2 = ((await get('/api/picks')).record.history.days.find((d) => d.date === '2026-10-26').dropped || []).find((x) => /Caleb Wilson/.test(x.label));
ok(wd2 && wd2.why === "the sharp books had it at 42.5%, 49.7% with the model's, under the 55% bar", `the sharp books: "${wd2 && wd2.why}"`);

// ---- /api/nba-pp?day= ------------------------------------------------------------------------
const v = await get('/api/nba-pp?day=2026-10-26');
const vw = (v.legs || []).find((l) => l.player === 'Caleb Wilson' && l.market === 'blk') || {};
ok(vw.picks && vw.picks.on === wilOn && (wilOn ? vw.picks.side === 'Over' : typeof vw.picks.why === 'string'), "the day view finds his blocks More on the list's log");

// ---- the page ---------------------------------------------------------------------------------
console.log('\n-- the page --');
const app = fs.readFileSync(BOARD + '/app.js', 'utf8').replace(/\r\n/g, '\n');
// Since 2026-10-28 the pool is the Picks tab's first card, its legs under
// its hero (tests/edgebets.mjs).
ok(/const allPool = d\.ppPool \|\| \[\];/.test(app) && /<ol class="tc-legs pk-pool">\$\{ppLegs\.slice\(1\)\.map\(itemHtml\)\.join\(''\)\}<\/ol>/.test(app),
  "the entry table reads the pool, and the entry's card lists its legs");
ok(/nba_blk_more: 'PrizePicks'/.test(app) && /nhl_more: 'PrizePicks'/.test(app), 'a More starred from the list goes on the slip as a PrizePicks leg');
ok(/On Picks of the day too, since Oct 28/.test(app) && !/Logged, not on Picks of the day/.test(app), 'the cards say the Mores are on the list now');
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
  throw new Error(`could not lift ${name}`);
}
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const hist = new Function('esc', ['shortDay', 'pct0', 'HIST_DAY_KEYS', 'movedLineHtml', 'pickHistoryHtml'].map(lift).join('\n') + '\nreturn pickHistoryHtml;')(esc);
const txt = (x) => x.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const hh = txt(hist(h));
console.log('  ' + hh.slice(0, 520));
ok(/What the PrizePicks entry would have paid, since Oct 26/.test(hh) && /Oct 26 .*Top 2 Power −1\.00u Top 3 Flex refund/.test(hh)
  && /The PrizePicks entry, best first ✓ Sion James Under 1\.5 3PM 78% ✗ Cooper Flagg Under 5\.5 AST 72% void Chet Holmgren Over 1\.5 BLK 65%/.test(hh),
  "the card: the entry's units, and under the day its legs at each start");
ok(/Before Oct 26, from the list's own top legs, moneylines included: Top 2 Power won 1 of 1, \+2\.00u/.test(txt(hist({ ...h, listEntries: h.listTotals }))) && !/Before Oct/.test(hh),
  "the list's own units from before the pool, as a line, when there are any");

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
