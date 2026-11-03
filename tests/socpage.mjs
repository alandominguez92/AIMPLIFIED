// ESPN's core host has refused the Worker since about 2026-10-12: a 403, while it serves a laptop
// the same URL. Every match after that was given up on, marked read with no rows, and the grader
// voided what was logged on it, so the props record stopped at 88 and the Hot list stayed empty.
// What has to hold:
//   - with core refused, a match is read whole from the summary: both queues, one tick each
//   - its numbers are core's own: shots, shots on target, fouls, saves, fouls drawn, goals + assists
//     and starters exactly, minutes within one, against core as recorded from a laptop
//   - what the summary hasn't got is NULL, never 0: a zero would read as a real bad game
//   - a match with no rows stays open, in the record and on an entry: unread is not unplayed
//   - once, what was given up on goes back in both queues and its voids reopen, to grade on real
//     numbers; a void in a match that has rows stays, and a later give-up isn't re-queued
//   - a stat the summary hasn't got voids (nothing to grade it on), the rest grade
//   - no call to the odds feed
//
// Real data: Liverpool at Ipswich (Sep 4, 2026) and a Champions League match (Oct 20, 2026), the
// summaries and the core host's numbers for every player, recorded from a laptop on 2026-11-03.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
const fixture = (f) => JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', f), 'utf8'));
const EPL = fixture('espn-soc-summary-401879288.json'), UCL = fixture('espn-soc-summary-401915403.json');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };

const RealDate = Date;
let NOW = Date.parse('2026-11-03T20:00:00Z');
globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } };
const J = (x, status = 200) => new Response(JSON.stringify(x), { status, headers: { 'content-type': 'application/json' } });

let S = null;
function scene() {
  const sq = new DatabaseSync(':memory:');
  const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
  const exec = (sql, args, mode) => { const st = sq.prepare(sql); const a = args.map(norm);
    if (mode === 'all') return { results: st.all(...a), meta: {} }; if (mode === 'first') return st.get(...a) || null;
    if (/^\s*(SELECT|WITH)/i.test(sql)) return { results: st.all(...a), meta: {} };
    return { success: true, meta: { changes: Number(st.run(...a).changes) } }; };
  const DB = { prepare: (sql) => { const s = { sql, args: [], bind: (...x) => { s.args = x; return s; },
    all: async () => exec(s.sql, s.args, 'all'), first: async (c) => { const r = exec(s.sql, s.args, 'first'); return c && r ? r[c] : r; },
    run: async () => exec(s.sql, s.args, 'run') }; return s; }, batch: async (sts) => sts.map((x) => exec(x.sql, x.args, 'run')) };
  return { sq, env: { DB, ASSETS: { fetch: async () => new Response('nope', { status: 404 }) } }, oddsCalls: 0, coreCalls: 0, sumCalls: 0 };
}
globalThis.fetch = async (u) => {
  const url = String(u);
  if (/the-odds-api\.com/.test(url)) { S.oddsCalls++; return new Response('{}', { status: 404 }); }
  if (/sports\.core\.api\.espn\.com/.test(url)) { S.coreCalls++; return new Response('', { status: 403 }); }
  const sum = url.match(/\/summary\?event=(\d+)$/);
  if (sum) { S.sumCalls++; const f = sum[1] === EPL.game.game_id ? EPL : sum[1] === UCL.game.game_id ? UCL : null; return f ? J(f.summary) : new Response('', { status: 404 }); }
  if (/scoreboard/.test(url)) return J({ events: [] });
  return new Response('{}', { status: 404 });
};
const src = fs.readFileSync(BOARD + '/worker.js', 'utf8').replace(/\r\n/g, '\n');
let mod = null, scenes = 0;
const loadWorker = async () => { mod = await import('data:text/javascript;base64,' + Buffer.from(`${src}\n// scene ${++scenes}`).toString('base64')); };
const cron = async (c) => { const held = []; await mod.default.scheduled({ cron: c, scheduledTime: NOW }, S.env, { waitUntil: (p) => held.push(p) }); await Promise.all(held); };
const tick = () => cron('1-59/2 * * * *');
// The job looks for finished matches first (every 30 minutes), and reads on the tick after.
const read = async () => { await tick(); await tick(); };
const addGame = (table, f, league, done = 0) => S.sq.prepare(`INSERT INTO ${table} (game_id, league, date, home, away, home_cid, away_cid, done, tries) VALUES (?,?,?,?,?,?,?,?,0)`)
  .run(f.game.game_id, league, f.game.date, f.game.home, f.game.away, f.game.home_cid, f.game.away_cid, done);
const addProp = (table, f, id, market, line, result = null) => {
  const c = S.sq.prepare(`PRAGMA table_info(${table})`).all().map((x) => x.name);
  const row = { date: f.game.date, game_id: f.game.game_id, player_id: id, market, player: 'x', team: f.game.home, opp: f.game.away, league: 'epl', commence: `${f.game.date}T19:00:00Z`,
    proj: 1, line, p_under: 60, p_over: 40, p: 60, n_recent: 5, logged_at: 'x', result };
  const cols = c.filter((k) => k in row);
  S.sq.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((k) => row[k]));
};
const box = (id, g) => S.sq.prepare('SELECT * FROM soc_box WHERE game_id = ? AND player_id = ?').get(g, id);

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
const SAME = ['starter', 'shots', 'sot', 'fouls', 'saves', 'fouls_drawn', 'goal_ast'];
const NOT_THERE = ['passes', 'tackles', 'clear', 'crosses', 'shot_ast'];

// ---- Read whole from the summary, with core refusing ------------------------------------------
for (const [f, league, name] of [[EPL, 'epl', 'Premier League'], [UCL, 'ucl', 'Champions League']]) {
  S = scene();
  await loadWorker();
  await tick();                                    // the tables, and the first look at the scoreboards
  addGame('soc_box_games', f, league);
  await read();
  const rows = S.sq.prepare('SELECT * FROM soc_box WHERE game_id = ?').all(f.game.game_id);
  const ids = Object.keys(f.core);
  ok(rows.length === ids.length && ids.length >= 22, `${name}: every player who appeared, in one read (${rows.length} of ${ids.length})`);
  ok(S.sq.prepare('SELECT done FROM soc_box_games').get().done === 1, 'and the match is done');
  ok(S.coreCalls <= 2 && S.sumCalls <= 2, `two requests or so, not thirty: ${S.coreCalls} refused, ${S.sumCalls} summaries`);
  const off = rows.filter((r) => SAME.some((k) => r[k] !== f.core[r.player_id][k]));
  ok(rows.length && !off.length, `the same numbers as core's, player by player, on ${SAME.join(', ')}${off.length ? ` -- OFF ${off.map((r) => r.player).join(', ')}` : ''}`);
  const mins = rows.map((r) => Math.abs(r.min - f.core[r.player_id].min));
  ok(rows.length && Math.max(...mins) <= 1, `minutes within one of core's: ${mins.filter((x) => x === 0).length} exact of ${mins.length}`);
  ok(rows.length && rows.every((r) => NOT_THERE.every((k) => r[k] === null)), 'what the summary has not got is NULL, never 0');
  ok(rows.filter((r) => r.conceded != null).every((r) => r.gk === 1) && rows.some((r) => r.gk === 1 && r.conceded != null), 'goals conceded on a keeper only');
  ok(rows.length && rows.every((r) => r.team === f.game.home || r.team === f.game.away) && rows.every((r) => r.opp !== r.team), 'each on his own side, against the other');
  ok(S.oddsCalls === 0, 'not one call to the odds feed');
}

// ---- The Hot backfill reads the same way ------------------------------------------------------
S = scene();
await loadWorker();
await tick();
addGame('soc_hot_games', EPL, 'epl');
await tick();
const hotRows = S.sq.prepare('SELECT * FROM soc_hot_box').all();
ok(hotRows.length === Object.keys(EPL.core).length, `the Hot backfill saves them too, in its own table: ${hotRows.length}`);
ok(hotRows.every((r) => r.shots === EPL.core[r.player_id].shots && r.passes === null), 'with the same numbers, and the same NULLs');
ok(S.sq.prepare('SELECT done FROM soc_hot_games').get().done === 1, 'and the match is done');
ok(!S.sq.prepare('SELECT COUNT(*) AS n FROM soc_box').get().n, 'the props table is left alone');

// ---- A summary that fails too is still a try ---------------------------------------------------
S = scene();
await loadWorker();
await tick();
S.sq.prepare("INSERT INTO soc_box_games (game_id, league, date, home, away, home_cid, away_cid, done, tries) VALUES ('999','epl','2026-11-01','A','B','1','2',0,0)").run();
for (let i = 0; i < 4; i++) await tick();
ok(S.sq.prepare("SELECT done, tries FROM soc_box_games WHERE game_id = '999'").get().done === 1, 'a match nothing answers for is given up on after three tries, as before');

// ---- Unread is not unplayed --------------------------------------------------------------------
S = scene();
await loadWorker();
await tick();
const [someone] = Object.keys(EPL.core);
addGame('soc_box_games', EPL, 'epl', 1);           // given up on: done, and no rows
addProp('socprops', EPL, someone, 'shots', 0.5);
addGame('soc_box_games', UCL, 'ucl');              // the tick's own work, which grades after
await read();
ok(S.sq.prepare('SELECT result FROM socprops').get().result === null, 'a match with no rows stays open, it is not a void');
// The same row once the match has been read.
S.sq.prepare("UPDATE soc_box_games SET done = 0 WHERE game_id = ?").run(EPL.game.game_id);
await read();
const g1 = S.sq.prepare('SELECT result, actual FROM socprops').get();
ok(g1.actual === EPL.core[someone].shots && g1.result === (EPL.core[someone].shots > 0.5 ? 'over' : 'under'), `and grades on the real number once read: ${g1.actual} shots, ${g1.result}`);

// ---- Rosters that answer and statistics that don't ------------------------------------------------
S = scene();
await loadWorker();
await tick();
addGame('soc_box_games', EPL, 'epl');
S.sq.prepare('INSERT OR REPLACE INTO feed_cache (key, data, updated_at, claimed_until) VALUES (?,?,?,0)').run(`soc_box_meta:${EPL.game.game_id}`,
  JSON.stringify({ apps: [{ id: someone, name: 'x', team: EPL.game.home, opp: EPL.game.away, starter: 1, subOff: 0, gk: 0, ref: 'https://sports.core.api.espn.com/v2/x/statistics/0' }] }), NOW);
await read();
ok(S.sq.prepare('SELECT COUNT(*) AS n FROM soc_box').get().n === Object.keys(EPL.core).length && S.sq.prepare('SELECT done FROM soc_box_games').get().done === 1, 'statistics refused after the roster answered: the summary fills the match');

// ---- On an entry too ----------------------------------------------------------------------------
S = scene();
await loadWorker();
await tick();
addGame('soc_box_games', EPL, 'epl', 1);
const KEY = 'phone-key-0123456789abcdef';
const entries = async (method, body) => (await mod.default.fetch(new Request('https://x/api/entries', { method,
  headers: { 'content-type': 'application/json', 'x-entry-key': KEY }, body: body ? JSON.stringify(body) : undefined }), S.env, { waitUntil: () => {} })).json();
const made = await entries('POST', { action: 'create', entry: { book: 'pp', kind: 'power', stake: 5, legs: [
  { sport: 'soccer', date: EPL.game.date, gamePk: EPL.game.game_id, playerId: Number(someone), player: 'x', market: 'shots', line: 0.5, side: 'Under' },
  { sport: 'soccer', date: EPL.game.date, gamePk: EPL.game.game_id, playerId: Number(someone), player: 'x', market: 'fouls', line: 0.5, side: 'Under' }] } });
await entries('GET');
const legs = () => S.sq.prepare('SELECT result, actual FROM entry_legs WHERE entry_id = ? ORDER BY idx').all(made.id);
ok(made.id && legs().length === 2 && legs().every((l) => l.result === null), 'a leg on a match with no rows stays open, not voided');
S.sq.prepare('UPDATE soc_box_games SET done = 0 WHERE game_id = ?').run(EPL.game.game_id);
await read();
await entries('GET');
ok(legs().every((l) => l.result === 'win' || l.result === 'loss' || l.result === 'push') && legs()[0].actual === EPL.core[someone].shots, `and settles on the real number once read: ${legs().map((l) => `${l.actual} ${l.result}`).join(', ')}`);

// ---- Once: what was given up on goes back -------------------------------------------------------
S = scene();
await loadWorker();
// As the live tables stood: the tables made, the flag not yet set.
await tick();
S.sq.prepare("DELETE FROM feed_cache WHERE key = 'soc_requeue_20261103'").run();
await loadWorker();
addGame('soc_box_games', EPL, 'epl', 1);
addGame('soc_hot_games', UCL, 'ucl', 1);
S.sq.prepare("INSERT INTO soc_box_games (game_id, league, date, home, away, home_cid, away_cid, done, tries) VALUES ('777','epl','2026-10-11','C','D','3','4',1,0)").run();
S.sq.prepare("INSERT INTO soc_box (game_id, league, date, player_id, player, team, opp, starter, min, shots) VALUES ('777','epl','2026-10-11','5','Read','C','D',1,90,2)").run();
const lines = [['socprops', EPL, someone, 'shots', 0.5, 'void'], ['socprops', EPL, someone, 'passes', 20.5, 'void']];
for (const [t, f, id, mk, line, res] of lines) addProp(t, f, id, mk, line, res);
S.sq.prepare("INSERT INTO socprops (date, game_id, player_id, market, player, team, opp, league, commence, proj, line, p_under, p_over, result) VALUES ('2026-10-11','777','9','shots','Absent','C','D','epl','x',1,0.5,60,40,'void')").run();
// A match whose rosters were read and kept before the refusal: its statistics links now answer 403.
const kept = { apps: [{ id: someone, name: 'x', team: EPL.game.home, opp: EPL.game.away, starter: 1, subOff: 0, gk: 0, ref: 'https://sports.core.api.espn.com/v2/x/statistics/0' }] };
S.sq.prepare('INSERT OR REPLACE INTO feed_cache (key, data, updated_at, claimed_until) VALUES (?,?,?,0)').run(`soc_box_meta:${EPL.game.game_id}`, JSON.stringify(kept), NOW);
await read();
ok(!S.sq.prepare("SELECT 1 AS x FROM feed_cache WHERE key LIKE 'soc_box_meta:%'").get(), 'the rosters kept from before are dropped');
ok(S.sq.prepare('SELECT COUNT(*) AS n FROM soc_box WHERE game_id = ?').get(EPL.game.game_id).n === Object.keys(EPL.core).length, 'a match given up on goes back and is read');
ok(S.sq.prepare('SELECT COUNT(*) AS n FROM soc_hot_box').get().n === Object.keys(UCL.core).length, 'on the Hot queue too');
const reg = (mk) => S.sq.prepare('SELECT result, actual FROM socprops WHERE game_id = ? AND market = ?').get(EPL.game.game_id, mk);
ok(reg('shots').result !== 'void' && reg('shots').result !== null && reg('shots').actual === EPL.core[someone].shots, `its void reopens and grades on the real number: ${reg('shots').actual} shots, ${reg('shots').result}`);
ok(reg('passes').result === 'void' && reg('passes').actual === null, 'a stat the summary has not got voids again: nothing to grade it on');
ok(S.sq.prepare("SELECT result FROM socprops WHERE game_id = '777'").get().result === 'void', 'a void in a match that has rows stays: he did not play');
ok(S.sq.prepare("SELECT done FROM soc_box_games WHERE game_id = '777'").get().done === 1, 'and that match is not read again');
S.sq.prepare("INSERT INTO soc_box_games (game_id, league, date, home, away, home_cid, away_cid, done, tries) VALUES ('888','epl','2026-11-02','E','F','6','7',1,3)").run();
await loadWorker();
await tick();
ok(S.sq.prepare("SELECT done FROM soc_box_games WHERE game_id = '888'").get().done === 1, 'and it runs once: a later give-up is not put back');

// ---- The route says how far stats have really got -----------------------------------------------
S = scene();
await loadWorker();
await tick();
addGame('soc_box_games', EPL, 'epl');
await read();
const sm = await (await mod.default.fetch(new Request('https://x/api/soccer-props?summary=1'), S.env, { waitUntil: () => {} })).json();
ok(sm.ingest && sm.ingest.lastStats === EPL.game.date && sm.ingest.lastStatsVia === 'summary', `the last match with stats, and from where: ${JSON.stringify(sm.ingest && { lastStats: sm.ingest.lastStats, via: sm.ingest.lastStatsVia })}`);

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
