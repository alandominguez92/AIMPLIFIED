// The moneyline-only PrizePicks entry on Picks of the day (2026-11-01).
//
// The owner: PrizePicks takes all moneylines, and DraftKings and FanDuel won't
// take moneyline-only picks. So the moneylines get an entry of their own beside
// the player-led one. What has to hold:
//   - its pool is the best moneyline of each game, any sport, from what clears
//     its kind's bar: moneylines only, one a game, best first, six at most
//   - the entry beside it keeps its own pool
//   - its entries are priced at PrizePicks' payouts on each leg's shrunk chance,
//     the stake held to the 2% an entry is allowed
//   - the log keeps the pool as it stood at each start, on the list or off it;
//     a leg that leaves before its start comes out, one that has started stays
//   - a leg off the list is graded, adds nothing to the list's record, and is
//     not called pulled from a list it was never on
//   - its units are its own, from its first logged day
//   - on the page: a card under the entry with its own ticket size and image
//
// Real data: production's moneylines and the NBA unders at 1:31 PM on Oct 26,
// with the final scores (tests/fixtures/picks-drops-20261026.json), and Nov 1's
// moneylines, which reach all four sports (tests/fixtures/mlentry-20261101.json).
// Real SQLite, the real worker, the real app.js's own functions. Followed on Live
// Now: tests/livesports.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const D = JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', 'picks-drops-20261026.json'), 'utf8'));
const N = JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', 'mlentry-20261101.json'), 'utf8'));
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

// What each kind has to clear, from the rows themselves: the pool worked out here
// without the worker's code.
const BAR = { nba: 65, nhl: 65, soccer: 65, nfl: 75 };
const expectedPool = (rows) => {
  const seen = new Set(), out = [];
  for (const r of rows.filter((x) => (x.market === 'h2h' || x.market === 'fav') && x.win_prob >= BAR[x.sport]).sort((a, b) => b.win_prob - a.win_prob)) {
    if (out.length >= 6 || seen.has(r.game_id)) continue;
    seen.add(r.game_id);
    out.push(r);
  }
  return out;
};
const insertGm = (rows) => {
  const cols = Object.keys(rows[0]);
  const ins = sq.prepare(`INSERT INTO gmpicks (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
  for (const r of rows) ins.run(...cols.map((k) => r[k]));
};
const row = (legId) => sq.prepare('SELECT * FROM daypicks WHERE leg_id = ?').get(legId);

// ---- Oct 26, 1:31 PM ------------------------------------------------------------------------
await get('/api/picks'); await get('/api/nba-pp'); await get('/api/nhl-pp'); await get('/api/gmpicks-export');   // the tables
const under = sq.prepare(`INSERT INTO nbapp (date, game_id, player, market, league, commence, home, away, team, player_id, point, proj, model_under, n_recent,
  min_proj, book_line, book_under, captured_at, ud_line, p6_line, sharp_under, sharp_src, l10_n, l10_under, model_ver) VALUES (${Array(25).fill('?').join(',')})`);
for (const l of D.board.filter((x) => x.market !== 'blk')) {
  const [away, home] = l.game.split(' @ ');
  under.run('2026-10-26', l.game_id, l.player, l.market, l.league, l.commence, home, away, l.team, l.player_id, l.point, l.proj, l.model_under, l.n_recent,
    l.min_proj, l.book_line, typeof l.book_under === 'number' ? l.book_under : null, l.first_at, l.ud_line, l.p6_line, l.sharp_under, l.sharp_src, l.l10_n, l.l10_under, 'nbapp-v1');
}
// The list keeps one leg a game, so a stronger under in the Rockets' game leaves
// their moneyline in this entry alone. Jalen Johnson's was 63 at 1:31 PM.
sq.prepare("UPDATE nbapp SET model_under = 72 WHERE player = 'Jalen Johnson' AND market = 'threes'").run();
let p = await get('/api/picks');
const propsOnly = titles(p.ppPool);
ok(Array.isArray(p.mlPool) && p.mlPool.length === 0 && Array.isArray(p.mlEntries) && p.mlEntries.length === 0, 'no moneylines logged: an empty pool, and no entries');
sq.prepare('DELETE FROM daypicks').run();                         // that read was the test's, not the day's
insertGm(D.gm1331);

console.log('-- Oct 26, 1:31 PM --');
p = await get('/api/picks');
console.log('  list:      ' + titles(p.legs).join(' | '));
console.log('  entry:     ' + titles(p.ppPool).join(' | '));
console.log('  moneyline: ' + titles(p.mlPool).join(' | '));
const want = expectedPool(D.gm1331);
ok(p.mlPool.length === 4 && p.mlPool.map((x) => x.p).join() === want.map((r) => r.win_prob).join() && p.mlPool.map((x) => x.p).join() === '77.5,74.2,72.3,65.5',
  'the best moneyline of each game that clears its bar, best first: 77.5, 74.2, 72.3, 65.5');
ok(p.mlPool.every((x) => /_ml$/.test(x.kind)) && new Set(p.mlPool.map((x) => x.spec.gamePk)).size === p.mlPool.length, 'moneylines only, one a game');
ok(!p.mlPool.some((x) => x.title === 'Cowboys ML') && D.gm1331.some((r) => r.pick === 'DAL' && r.win_prob === 67.7), "the Cowboys at 67.7 stay out: the NFL's bar is 75");
ok(titles(p.ppPool).join() === propsOnly.join() && !p.ppPool.some((x) => /^(nba|nhl|mlb)_ml$|^soccer_fav$/.test(x.kind)), "the entry beside it keeps its pool, moneylines or none");

console.log('\n-- its entries --');
const POWER = { 2: 3 }, FLEX = { 3: { 3: 2.25, 2: 1.25 }, 4: { 4: 5, 3: 1.5 }, 5: { 5: 10, 4: 2, 3: 0.4 }, 6: { 6: 25, 5: 2, 4: 0.4 } };
const evOf = (ps) => {                                            // each count landing, and what it pays
  const n = ps.length;
  let dist = [1];
  for (const q of ps) { const nx = new Array(dist.length + 1).fill(0); dist.forEach((v, k) => { nx[k] += v * (1 - q); nx[k + 1] += v * q; }); dist = nx; }
  const ev = dist.reduce((s, v, k) => s + v * (n === 2 ? (k === 2 ? POWER[2] : 0) : (FLEX[n][k] || 0)), 0) - 1;
  return Math.round(ev * 1000) / 10;
};
for (const e of p.mlEntries) console.log(`  ${e.entry}: ${e.avgLeg}% a leg, all ${e.allLand}%, EV ${e.ev}%, stake ${e.stake}%${e.capped ? ' (capped)' : ''}`);
ok(p.mlEntries.map((e) => e.legs).join() === '2,3,4', 'entries of two to four, off four legs');
ok(p.mlPool.every((x) => typeof x.kellyP === 'number' && x.kellyP <= x.p), 'each leg carries its shrunk chance, never above the stated one');
ok(p.mlEntries.every((e) => e.ev === evOf(p.mlPool.slice(0, e.legs).map((x) => x.kellyP / 100))), "each edge is PrizePicks' payouts on those chances, worked out here");
ok(p.mlEntries.every((e) => e.stake <= 2) && p.mlEntries.some((e) => e.capped), 'and the stake is held to the 2% an entry is allowed');
const e4 = p.mlEntries.find((e) => e.legs === 4);
ok(e4.avgLeg === Math.round((77.5 + 74.2 + 72.3 + 65.5) / 4 * 10) / 10, `the average leg on the stated chances: ${e4.avgLeg}`);

console.log('\n-- the log --');
const onList = new Set(p.legs.map((x) => x.legId));
const rows = p.mlPool.map((x) => row(x.legId));
ok(rows.every((r, i) => r && r.in_ml === 1 && r.ml_rank === i + 1 && r.ml_p === p.mlPool[i].p), 'each leg logged with its place and chance');
const offList = p.mlPool.filter((x) => !onList.has(x.legId));
console.log('  off the list: ' + titles(offList).join(' | '));
ok(offList.length === 1 && offList[0].title === 'Rockets ML', 'the Rockets are not on the list: its leg of that game is the under');
const off = offList[0] || { spec: {} };
const rockets = row(off.legId) || {};
ok(rockets.on_list === 0 && rockets.seen_at == null && rockets.in_pool !== 1, 'a leg in this entry alone is off the list and out of the other entry');
const offGame = off.spec.gamePk;
sq.prepare("UPDATE gmpicks SET win_prob = 60 WHERE game_id = ? AND market = 'h2h'").run(offGame);
p = await get('/api/picks');
ok(!p.mlPool.some((x) => x.legId === off.legId) && row(off.legId).in_ml === 0 && row(off.legId).ml_rank == null, 'a leg that falls under its bar before its start leaves the pool and the log');
sq.prepare("UPDATE gmpicks SET win_prob = ? WHERE game_id = ? AND market = 'h2h'").run(off.p, offGame);
p = await get('/api/picks');
ok(row(off.legId).in_ml === 1 && row(off.legId).ml_rank === p.mlPool.findIndex((x) => x.legId === off.legId) + 1, 'and is back if it clears it again');
// The Heat tipped at 23:30 UTC, the first of these. Their chance falls after it; they stay as they stood.
const heat = p.mlPool.find((x) => x.title === 'Heat ML');
NOW = RealDate.parse('2026-10-26T23:45:00Z');
sq.prepare("UPDATE gmpicks SET win_prob = 50 WHERE game_id = ? AND market = 'h2h'").run(heat.spec.gamePk);
p = await get('/api/picks');
const heatRow = row(heat.legId);
ok(heatRow.in_ml === 1 && heatRow.ml_p === 74.2 && heatRow.ml_rank === 2, 'one that has started stays as it stood at its start');
ok(!p.mlPool.some((x) => x.legId === heat.legId), 'and is off the page, which lists what is still to play');

console.log('\n-- graded, Oct 27 --');
NOW = RealDate.parse('2026-10-27T15:00:00Z');
sq.prepare("UPDATE gmpicks SET win_prob = 74.2 WHERE game_id = ? AND market = 'h2h'").run(heat.spec.gamePk);
for (const [k, g] of Object.entries(D.gmResults)) {
  const [gid, market] = k.split(':');
  sq.prepare('UPDATE gmpicks SET result = ?, home_score = ?, away_score = ? WHERE game_id = ? AND market = ?').run(g.result, g.home_score, g.away_score, gid, market);
}
await get('/api/picks');                                          // the grader runs on every read
p = await get('/api/picks');
const hist = p.record.history;
const day = hist.days.find((d) => d.date === '2026-10-26') || {};
console.log('  ' + (day.ml || []).map((x) => `${x.label} ${x.p} ${x.result}`).join(' | '));
console.log('  ' + hist.mlEntries.filter((e) => e.days).map((e) => `${e.label}: ${e.won} of ${e.days}, ${e.units}u`).join(' · '));
// From the final scores: 77.5 Thunder won, 74.2 Heat lost, 72.3 Nuggets lost, 65.5 Rockets won.
const res = want.map((r) => (D.gmResults[`${r.game_id}:h2h`].result === 'win' ? 'hit' : 'miss'));
ok(res.join() === 'hit,miss,miss,hit' && (day.ml || []).map((x) => x.result).join() === res.join(), 'its legs, best first, graded on the final scores: won, lost, lost, won');
ok((day.ml || []).map((x) => x.p).join() === '77.5,74.2,72.3,65.5', 'at their chances as they stood at each start');
ok(row(off.legId).result != null, 'the leg off the list is graded with the rest');
ok(hist.mlSince === '2026-10-26', 'graded from its first logged day');
const tot = (k) => (hist.mlEntries || []).find((e) => e.key === k) || {};
// Two of the top three would need the 1.25x; one of three pays nothing; two of four nothing.
ok(tot('p2').days === 1 && tot('p2').won === 0 && tot('p2').units === -1, 'Top 2 Power: the Thunder won, the Heat lost, -1u');
ok(tot('f3').days === 1 && tot('f3').won === 0 && tot('f3').units === -1, 'Top 3 Flex: one of three, -1u');
ok(tot('f4').days === 1 && tot('f4').won === 0 && tot('f4').units === -1, 'Top 4 Flex: two of four, -1u');
ok(tot('f5').days === 0 && tot('f6').days === 0, 'no five- or six-pick off four legs');
ok(day.mlEntries && day.mlEntries.p2 && day.mlEntries.p2.net === -1, "and the day says so");
const list = day.legs || [];
ok(!list.some((x) => x.label === off.title), "the leg off the list stays off the list's own day");
ok(!(day.dropped || []).some((x) => x.label === off.title), 'and is not called pulled from a list it was never on');
const listN = sq.prepare("SELECT COUNT(*) AS n FROM daypicks WHERE on_list = 1 AND result IN ('hit', 'miss')").get().n;
ok(p.record.legs.n === listN, `the list's record counts its own legs alone (${listN})`);
// The other entry's legs, the unders, have no grades in this recording.
ok(hist.entriesFrom === 'pool' && hist.entries.every((e) => e.days === 0), "and none of it reaches the other entry's totals");

// ---- Nov 1: every sport -------------------------------------------------------------------------
console.log('\n-- Nov 1, all four sports --');
NOW = RealDate.parse(N._recorded);
insertGm(N.rows);
p = await get('/api/picks');
console.log('  moneyline: ' + titles(p.mlPool).join(' | '));
const wantN = expectedPool(N.rows);
ok(p.mlPool.length === 6 && p.mlPool.map((x) => x.p).join() === wantN.map((r) => r.win_prob).join()
  && titles(p.mlPool).join() === 'Jaguars ML 80.7,Real Madrid ML 79.1,Patriots ML 76.6,Como ML 73.6,Hurricanes ML 71.8,Celtics ML 70.3',
  "six legs across the NFL, soccer, the NHL and the NBA: the day's real best moneylines");
ok(new Set(p.mlPool.map((x) => x.kind)).size === 4 && p.mlPool.some((x) => x.kind === 'soccer_fav'), 'a soccer favourite counts as a moneyline');
ok(N.rows.some((r) => r.pick === 'Lazio' && r.win_prob === 65.6) && !p.mlPool.some((x) => /Lazio/.test(x.title)), 'Lazio clears its bar and is seventh: six at most');
ok(N.rows.some((r) => r.pick === 'DAL' && r.win_prob === 74.7) && !p.mlPool.some((x) => x.title === 'Cowboys ML'), 'the Cowboys at 74.7 stay under the NFL bar');
ok(p.mlEntries.map((e) => e.legs).join() === '2,3,4,5,6' && p.mlEntries.every((e) => e.ev === evOf(p.mlPool.slice(0, e.legs).map((x) => x.kellyP / 100))), 'entries of two to six, each worked out here');
for (const e of p.mlEntries) console.log(`  ${e.entry}: EV ${e.ev}%, stake ${e.stake}%${e.capped ? ' (capped)' : ''}`);

// ---- the page -----------------------------------------------------------------------------------
console.log('\n-- the page --');
const app = fs.readFileSync(BOARD + '/app.js', 'utf8').replace(/\r\n/g, '\n');
function lift(name) {
  let at = app.indexOf(`function ${name}(`);
  if (at >= 0) {
    let d = 0;
    for (let i = at; i < app.length; i++) { if (app[i] === '{') d++; else if (app[i] === '}' && --d === 0) return app.slice(at, i + 1); }
  }
  at = app.indexOf(`const ${name} =`);
  let d = 0;
  for (let i = at; i < app.length; i++) { const c = app[i]; if ('{(['.includes(c)) d++; else if ('})]'.includes(c)) d--; else if (c === ';' && d === 0) return app.slice(at, i + 1); }
  throw new Error(`could not lift ${name}`);
}
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const penv = {
  esc, state: { bank: { amount: null, cap: 5 }, ticketN: 2, ticketMlN: 5 },
  localStorage: { getItem: () => null, setItem: () => {} },
  shortDay: (ymd) => new RealDate(ymd + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }),
  pct0: (v) => (typeof v === 'number' ? `${Math.round(v)}%` : '—'),
  pickFace: () => '<i class="face"></i>', movedLineHtml: () => '',
};
const names = ['pickIsTeam', 'pickTeamCode', 'pickTeamTag', 'moneyTxt', 'stakeTxt', 'shortLeg', 'PP_PAY', 'ticketData', 'ticketHtml', 'HIST_DAY_KEYS', 'ppEntryRecordHtml', 'pickHistoryHtml'];
let P;
try {
  P = new Function(...Object.keys(penv), names.map(lift).join('\n') + '\nreturn { ticketData, ticketHtml, ppEntryRecordHtml, pickHistoryHtml };')(...Object.values(penv));
} catch (e) { console.log(`  FAIL  the pieces lift out of app.js (${e.message})`); process.exit(1); }
const mlT = P.ticketData(p, p.mlPool, true, true);
const mlH = P.ticketHtml(mlT, true);
console.log('  ' + text(mlH));
ok(mlT.n === 5 && mlT.name === '5-pick Flex' && mlT.ev === p.mlEntries.find((e) => e.legs === 5).ev, "the ticket takes its own size and the moneyline entry's own edge");
ok(mlT.legs.map((l) => l.short).join() === 'Jaguars,Real Madrid,Patriots,Como,Hurricanes' && mlT.legs.every((l) => l.pick === 'to win'), 'its legs read as teams to win');
ok(/data-action="ticket-ml-n"/.test(mlH) && /data-action="ticket-ml-save"/.test(mlH) && !/data-action="ticket-n"/.test(mlH) && !/data-action="ticket-save"/.test(mlH), 'its buttons are its own, so a tap leaves the other entry alone');
const ppH = P.ticketHtml(P.ticketData(p, p.mlPool, true));
ok(P.ticketData(p, p.mlPool, true).n === 2 && /data-action="ticket-n"/.test(ppH) && !/ticket-ml/.test(ppH), "and the entry's ticket keeps its own");
ok(/case 'ticket-ml-n': state\.ticketMlN = Number\(target\.dataset\.n\) \|\| 3; renderPicks\(\); break;/.test(app) && /case 'ticket-ml-save': saveTicketImage\(true\); break;/.test(app), 'both wired up');
ok(/const all = \(ml \? d\.mlPool : d\.ppPool\) \|\| \[\];/.test(lift('saveTicketImage')), 'the saved image draws the moneyline legs');

const rec = P.ppEntryRecordHtml(hist, true);
console.log('  ' + text(rec));
ok(/^The moneyline entry since Oct 26: /.test(text(rec)) && /Top 2 Power won 0 of 1 ?, −1.00u/.test(text(rec)) && /Top 3 Flex won 0 of 1 ?, −1.00u/.test(text(rec)), 'its record on its card');
ok(/^This entry is graded from Oct 26: none settled yet/.test(text(P.ppEntryRecordHtml(hist))), "and the other's stays the other's");
ok(P.ppEntryRecordHtml({ entriesFrom: 'pool', poolSince: '2026-10-26', entries: [] }, true) === '', 'nothing before the moneyline entry has a day');
const histHtml = P.pickHistoryHtml(hist);
ok(/The moneyline entry, best first/.test(histHtml) && /The moneyline entry since Oct 26/.test(text(histHtml)), 'and in the history: the day and the totals');
ok((histHtml.match(/The moneyline entry, best first/g) || []).length === hist.days.filter((d) => (d.ml || []).length).length, 'on the days it has');

const rp = lift('renderPicks');
ok(/bankHtml\(\) \+ ppCard \+ mlCard \+ evBetsHtml\(d\) \+ listCard \+ after;/.test(rp), 'the card sits under the entry, above the sportsbook bets');
ok(/const mlCard = mlLegs\.length < 2 \? '' :/.test(rp), 'no card under two legs still to play');
ok(/Date\.parse\(x\.commence\) > Date\.now\(\)/.test(rp.slice(rp.indexOf('const mlLegs'), rp.indexOf('const mlWhole'))) && /entryRows\(mlLegs, mlWhole && \(d\.mlEntries \|\| \[\]\)\)/.test(rp), 'still to play only; a started leg takes the priced edge away, as on the entry');
ok(/check what the app shows before you place it/.test(rp), "and it says the edge is at PrizePicks' standard payouts, to be checked");
ok(/\$\{mlLegs\.map\(\(x\) => legRow\(x, true\)\)\.join\(''\)\}/.test(rp) && /const itemHtml = \(x\) => legRow\(x, false\);/.test(rp), 'its legs compact, since the same legs sit in full in the list below');

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
