// Guards the postponed-game rule in the MLB game-line graders (moneyline, run
// line, totals) and the /api/mlb-void-moved repair.
//
// ALCS Game 4, TB @ CLE, was scheduled 2026-10-16 as gamePk 849817 and rained
// out. StatsAPI moved that SAME gamePk to 2026-10-18, where it was played as
// Game 5 (TB 3, CLE 1); Game 4 itself was played 10-17 as 849816. The 10-16
// moneyline row found no score on its own date, was looked up by gamePk, got
// Game 5's final, and graded loss 1-3 -- the same game graded on two dates.
// Books void a postponed MLB moneyline not played that day, so the 10-16 row is
// void. The row logged on 10-18, the day it was played, grades as normal.
//
// Every StatsAPI answer is a recorded payload (tests/fixtures), and the stub
// answers only the exact URLs the graders ask for. Rows live in a real SQLite
// database because the repair is an UPDATE whose WHERE clause is the safety
// argument: it must void the moved row and leave the played-date row alone.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
const FIX = path.join(BOARD, 'tests', 'fixtures');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };

const sq = new DatabaseSync(':memory:');
const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
const exec = (sql, args, mode) => {
  const st = sq.prepare(sql); args = args.map(norm);
  if (mode === 'all') return { results: st.all(...args), meta: {} };
  if (mode === 'first') return st.get(...args) || null;
  return { success: true, meta: { changes: Number(st.run(...args).changes) } };
};
const DB = {
  prepare: (sql) => { const s = { sql, args: [], bind: (...a) => { s.args = a; return s; },
    all: async () => exec(s.sql, s.args, 'all'), first: async (c) => { const r = exec(s.sql, s.args, 'first'); return c && r ? r[c] : r; },
    run: async () => exec(s.sql, s.args, 'run') }; return s; },
  batch: async (sts) => sts.map((x) => exec(x.sql, x.args, 'run')),
};

const fixture = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');
const STATS = 'https://statsapi.mlb.com/api/v1';
const ANSWERS = {
  [`${STATS}/schedule?sportId=1&date=2026-10-16&hydrate=linescore,team`]: fixture('statsapi-schedule-20261016.json'),
  [`${STATS}/schedule?sportId=1&date=2026-10-18&hydrate=linescore,team`]: fixture('statsapi-schedule-20261018.json'),
  [`${STATS}/schedule?sportId=1&gamePks=849817&hydrate=linescore,team`]: fixture('statsapi-schedule-pk849817.json'),
  // Suspended 2026-06-16, finished 06-17: the case the rule must NOT void.
  [`${STATS}/schedule?sportId=1&date=2026-06-16&hydrate=linescore,team`]: fixture('statsapi-schedule-20260616.json'),
  [`${STATS}/schedule?sportId=1&date=2026-06-17&hydrate=linescore,team`]: fixture('statsapi-schedule-20260617.json'),
  [`${STATS}/schedule?sportId=1&gamePks=824912&hydrate=linescore,team`]: fixture('statsapi-schedule-pk824912.json'),
};
const asked = [];
let pkDown = false;
globalThis.fetch = async (u) => {
  const url = String(u);
  asked.push(url);
  if (pkDown && url.includes('gamePks=')) return new Response('upstream error', { status: 503 });
  if (ANSWERS[url]) return new Response(ANSWERS[url], { status: 200, headers: { 'content-type': 'application/json' } });
  return new Response('{}', { status: 404 });
};

const src = fs.readFileSync(BOARD + '/worker.js', 'utf8').replace(/\r\n/g, '\n');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const env = { DB };
const ctx = { waitUntil: (p) => { if (p && p.then) p.catch(() => {}); } };
const hit = async (p) => {
  try { return await (await mod.default.fetch(new Request('https://x' + p), env, ctx)).json(); }
  catch (e) { return { thrown: String((e && e.message) || e) }; }
};
const rebuild = async () => {
  try { sq.exec("DELETE FROM feed_cache WHERE key LIKE 'track-record%'"); } catch (e) { /* no cache table yet */ }
  return hit('/api/track-record');
};

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

// The premise, read off the recorded range (?startDate=2026-10-16&endDate=2026-10-18).
const RANGE = JSON.parse(fixture('statsapi-schedule-20261016-18.json'));
const listed = RANGE.dates.flatMap((d) => d.games.map((g) => ({ on: d.date, ...g })));
const pp = listed.filter((g) => g.gamePk === 849817);
ok(pp.length === 2 && pp[0].on === '2026-10-16' && pp[0].status.detailedState === 'Postponed'
  && pp[0].officialDate === '2026-10-18' && pp[1].on === '2026-10-18' && pp[1].rescheduledFromDate === '2026-10-16',
  'fixture: 849817 is listed Postponed on 10-16 (officialDate already 10-18) and Final on 10-18, makeup of 10-16');

await rebuild();   // creates every table through the worker's own ensure* functions

const insert = (table, row) => {
  const cols = Object.keys(row);
  sq.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => norm(row[c])));
};
// The two production rows for g849817, as /api/mlpicks-export read them on
// 2026-10-19, with the grade taken off: the 10-16 pass logged before the rainout
// and the 10-18 row posted at T3 +114.
const ML16 = { date: '2026-10-16', game_id: 'g849817', team: 'CLE', opp: 'TB', is_home: 1, tier: 'pass', win_prob: 49, edge: -0.5,
  entry_price: -102, close_price: 102, model_ver: 'ml-shin-check25', fair_source: 'pinnacle', entry_win_prob: 50, entry_edge: -0.7,
  entry_tier: 'pass', entry_fair_source: 'pinnacle', entry_at: '2026-10-16T03:10:21.088Z', close_at: '2026-10-17T00:23:19.562Z',
  close_fair: 0.4904, close_fair_source: 'pinnacle' };
const ML18 = { date: '2026-10-18', game_id: 'g849817', team: 'CLE', opp: 'TB', is_home: 1, tier: 'pass', win_prob: 46, edge: -0.5,
  entry_price: 107, close_price: 113, model_ver: 'ml-shin-check25', fair_source: 'dkfd', entry_win_prob: 46, entry_edge: 0,
  entry_tier: 'pass', entry_fair_source: 'dkfd', entry_at: '2026-10-18T03:20:19.587Z', posted_at: '2026-10-18T10:38:18.929Z',
  posted_price: 114, posted_win_prob: 45, posted_edge: 1.9, posted_tier: '3', close_at: '2026-10-18T20:40:18.588Z',
  close_fair: 0.4642, close_fair_source: 'pinnacle' };
insert('mlpicks', ML16);
insert('mlpicks', ML18);
// SF @ ATL, suspended 06-16 and finished 06-17 under the same gamePk. It keeps
// officialDate 06-16, so a 06-16 row is a real result (ATL lost 2-7).
insert('mlpicks', { date: '2026-06-16', game_id: 'g824912', team: 'ATL', opp: 'SF', is_home: 1, tier: 'pass', entry_price: -130, close_price: -130 });
// The 06-17 schedule lists it again, Final 7-2, with officialDate 06-16. A row
// logged on the resume day is that game a second time.
insert('mlpicks', { date: '2026-06-17', game_id: 'g824912', team: 'ATL', opp: 'SF', is_home: 1, tier: 'pass', entry_price: -125, close_price: -125 });
for (const date of ['2026-10-16', '2026-10-18']) {
  insert('rlpicks', { date, game_id: 'g849817', team: 'CLE', opp: 'TB', is_home: 1, point: 1.5, side: 'CLE', tier: 'pass', entry_price: -190, close_price: -190 });
  insert('totpicks', { date, game_id: 'g849817', side: 'Under', point: 7.5, entry_price: -110, close_price: -110 });
}
for (const date of ['2026-06-16', '2026-06-17']) {
  insert('rlpicks', { date, game_id: 'g824912', team: 'ATL', opp: 'SF', is_home: 1, point: 1.5, side: 'ATL', tier: 'pass', entry_price: -180, close_price: -180 });
  insert('totpicks', { date, game_id: 'g824912', side: 'Over', point: 8.5, entry_price: -110, close_price: -110 });
}

const ml = (date, gid = 'g849817') => sq.prepare('SELECT result, team_score, opp_score FROM mlpicks WHERE date=? AND game_id=?').get(date, gid);
const rl = (date) => sq.prepare("SELECT result, team_score, opp_score FROM rlpicks WHERE date=? AND game_id='g849817'").get(date);
const tot = (date) => sq.prepare("SELECT result, total_runs FROM totpicks WHERE date=? AND game_id='g849817'").get(date);
const show = (r) => JSON.stringify(r);

console.log('\n-- grading: a row logged for the day a game was rained out is void --');
const tr = await rebuild();
ok(!tr.thrown && !tr.error, `the track record built (${tr.thrown || tr.error || 'ok'})`);
ok(ml('2026-10-16').result === 'void' && ml('2026-10-16').team_score === null && ml('2026-10-16').opp_score === null,
  `moneyline 10-16 is void with no score, not graded off Game 5 (${show(ml('2026-10-16'))})`);
ok(ml('2026-10-18').result === 'loss' && ml('2026-10-18').team_score === 1 && ml('2026-10-18').opp_score === 3,
  `moneyline 10-18, the day it was played, grades loss 1-3 (${show(ml('2026-10-18'))})`);
ok(rl('2026-10-16').result === 'void' && rl('2026-10-16').team_score === null, `run line 10-16 is void (${show(rl('2026-10-16'))})`);
ok(rl('2026-10-18').result === 'loss' && rl('2026-10-18').team_score === 1, `run line 10-18 grades: CLE +1.5 lost by 2 (${show(rl('2026-10-18'))})`);
ok(tot('2026-10-16').result === 'void' && tot('2026-10-16').total_runs === null, `total 10-16 is void (${show(tot('2026-10-16'))})`);
ok(tot('2026-10-18').result === 'win' && tot('2026-10-18').total_runs === 4, `total 10-18 grades: 4 runs, under 7.5 (${show(tot('2026-10-18'))})`);
ok(ml('2026-06-16', 'g824912').result === 'loss' && ml('2026-06-16', 'g824912').team_score === 2,
  `a suspended-and-resumed game still grades on its original date (${show(ml('2026-06-16', 'g824912'))})`);
ok(ml('2026-06-17', 'g824912').result === 'void',
  `and a row on its resume day is void, though that day's listing reads Final 7-2 (${show(ml('2026-06-17', 'g824912'))})`);
const rlS = (date) => sq.prepare("SELECT result FROM rlpicks WHERE date=? AND game_id='g824912'").get(date).result;
const totS = (date) => sq.prepare("SELECT result, total_runs FROM totpicks WHERE date=? AND game_id='g824912'").get(date);
ok(rlS('2026-06-16') === 'loss' && rlS('2026-06-17') === 'void',
  `run line: the suspended game grades on 06-16 and voids on 06-17 (${rlS('2026-06-16')}, ${rlS('2026-06-17')})`);
ok(totS('2026-06-16').result === 'win' && totS('2026-06-16').total_runs === 9 && totS('2026-06-17').result === 'void',
  `totals: 9 runs over 8.5 on 06-16, void on 06-17 (${show(totS('2026-06-16'))}, ${totS('2026-06-17').result})`);

console.log('\n-- and the record leaves the void row out --');
const m = tr.ml || {};
ok(m.record === '0–1' && m.tracked === 1, `posted record is the 10-18 T3 loss alone (${m.record}, ${m.tracked} tracked)`);
ok(m.pending === 0, `nothing left pending (${m.pending})`);
ok(m.vsSharpClose && m.vsSharpClose.all && m.vsSharpClose.all.n === 1,
  `vs-Pinnacle-close counts only the 10-18 row (${m.vsSharpClose && JSON.stringify(m.vsSharpClose.all)})`);
const bandN = Object.values(m.byPriceBand || {}).reduce((s, b) => s + b.n, 0);
ok(bandN === 2, `price bands hold the two graded rows, 10-18 and the suspended game (${bandN})`);

console.log('\n-- /api/mlb-void-moved repairs rows graded before the rule --');
// Put the 10-16 rows back the way production has them: graded off Game 5.
sq.prepare("UPDATE mlpicks SET result='loss', team_score=1, opp_score=3 WHERE date='2026-10-16'").run();
sq.prepare("UPDATE rlpicks SET result='loss', team_score=1, opp_score=3 WHERE date='2026-10-16'").run();
sq.prepare("UPDATE totpicks SET result='win', total_runs=4 WHERE date='2026-10-16'").run();

const outside = await hit('/api/mlb-void-moved?since=2026-10-17');
ok(!outside.thrown && Array.isArray(outside.voided) && outside.voided.length === 0 && ml('2026-10-16').result === 'loss',
  `a window that starts after 10-16 touches nothing (${outside.thrown || show(outside.voided)}, 10-16 still ${ml('2026-10-16').result})`);

pkDown = true;
const down = await hit('/api/mlb-void-moved?since=2026-10-10');
pkDown = false;
ok(Array.isArray(down.voided) && down.voided.length === 0 && ml('2026-10-16').result === 'loss' && tot('2026-10-16').result === 'win',
  `with the gamePk lookup failing, nothing is voided on a guess (${down.thrown || show(down.voided)})`);

asked.length = 0;
const fix = await hit('/api/mlb-void-moved?since=2026-10-10');
const v = (fix.voided || []).map((x) => `${x.table} ${x.date} ${x.was}->void (played ${x.playedOn})`).sort();
ok(v.join(' | ') === 'mlpicks 2026-10-16 loss->void (played 2026-10-18) | rlpicks 2026-10-16 loss->void (played 2026-10-18) | totpicks 2026-10-16 win->void (played 2026-10-18)',
  `voids the three 10-16 rows and says so (${v.join(' | ') || fix.thrown || fix.error})`);
ok(fix.checked === 6, `checked both dates in all three tables (${fix.checked})`);
ok(asked.filter((u) => u.includes('statsapi')).length === 1, `in one StatsAPI call (${asked.length})`);
ok(ml('2026-10-16').result === 'void' && ml('2026-10-16').team_score === null && rl('2026-10-16').team_score === null && tot('2026-10-16').total_runs === null,
  `the 10-16 rows read void with their scores cleared (${show(ml('2026-10-16'))} ${show(tot('2026-10-16'))})`);
ok(ml('2026-10-18').result === 'loss' && ml('2026-10-18').team_score === 1 && rl('2026-10-18').result === 'loss' && tot('2026-10-18').result === 'win',
  `the 10-18 rows, whose date matches the game, are untouched (${show(ml('2026-10-18'))})`);
ok(ml('2026-06-16', 'g824912').result === 'loss', 'and so is every row outside the window');

const again = await hit('/api/mlb-void-moved?since=2026-10-10');
ok(Array.isArray(again.voided) && again.voided.length === 0, `a second run changes nothing (${show(again.voided)})`);

const after = (await rebuild()).ml || {};
ok(after.record === '0–1' && after.tracked === 1, `the posted record is unchanged by the repair (${after.record})`);

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
