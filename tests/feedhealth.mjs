// A warning when a feed stops (2026-11-04).
//
// On Oct 12 ESPN's core host began refusing the Worker. Soccer's stats stopped, its record froze at
// 88, the Hot list went empty, and nothing on the page said so for three weeks: the read counters
// counted the give-ups as reads. What has to hold:
//   - the check compares what finished with what was saved, in the tables themselves, per league in
//     soccer, so one league failing shows, and it spends no requests at all
//   - a finished game with no stats counts once it has waited more than two days. A day old is normal.
//     So is a week between saved games: the NFL plays Sundays and the Champions League every other
//     week, and the hours after their games finish are not a gap
//   - games no longer being found at all warn too, in season only, past the longest break that sport has
//   - it runs a few times a day and reads the indexes, and the page reads one stored row
//   - the tab shows it for that tab's sport, Picks for all of them, and otherwise shows nothing
//
// The rows are the Oct 12 failure as it stood on Nov 1: matches found through Nov 1, stats through Oct 12.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');

const RealDate = Date;
let NOW = RealDate.parse('2026-11-01T20:00:00Z');        // Sunday noon Pacific
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
};
const cacheKept = new Map();
globalThis.caches = { default: { match: async (r) => { const x = cacheKept.get(r.url); return x ? x.clone() : undefined; }, put: async (r, v) => { cacheKept.set(r.url, v.clone()); } } };
const asked = [];
globalThis.fetch = async (u) => { asked.push(String(u)); return new Response('{"events":[]}', { status: 200, headers: { 'content-type': 'application/json' } }); };

const sq = new DatabaseSync(':memory:');
const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
const reads = [];
const exec = (sql, args, mode) => { const st = sq.prepare(sql); const a = args.map(norm); reads.push(sql);
  if (mode === 'all') return { results: st.all(...a), meta: {} }; if (mode === 'first') return st.get(...a) || null;
  return { success: true, meta: { changes: Number(st.run(...a).changes) } }; };
const DB = { prepare: (sql) => { const s = { sql, args: [], bind: (...x) => { s.args = x; return s; },
  all: async () => exec(s.sql, s.args, 'all'), first: async (c) => { const r = exec(s.sql, s.args, 'first'); return c && r ? r[c] : r; },
  run: async () => exec(s.sql, s.args, 'run') }; return s; }, batch: async (sts) => sts.map((x) => exec(x.sql, x.args, 'run')) };
const env = { DB };

const src = fs.readFileSync(BOARD + '/worker.js', 'utf8').replace(/\r\n/g, '\n');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const GRADE_CRON = (src.match(/const GRADE_CRON = '([^']+)'/) || [])[1];
const fire = async () => {
  const jobs = [];
  await mod.default.scheduled({ cron: GRADE_CRON, scheduledTime: NOW }, env, { waitUntil: (p) => jobs.push(p) });
  await Promise.allSettled(jobs);
};
const health = async () => JSON.parse(sq.prepare("SELECT data FROM feed_cache WHERE key = 'feed_health'").get()?.data || 'null');
const fresh = () => sq.prepare("DELETE FROM feed_cache WHERE key = 'feed_health'").run();

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

await fire();                                            // the tables
const socGame = (id, league, date, done = 1) => sq.prepare('INSERT OR REPLACE INTO soc_box_games (game_id, league, date, home, away, done, tries) VALUES (?,?,?,?,?,?,0)').run(id, league, date, 'A', 'B', done);
const socRow = (id, league, date) => sq.prepare('INSERT OR REPLACE INTO soc_box (game_id, league, date, player_id, player) VALUES (?,?,?,?,?)').run(id, league, date, 'p' + id, 'P');
const game = (t, id, date) => sq.prepare(t === 'nba_box_games' ? `INSERT OR REPLACE INTO ${t} (game_id, date, done) VALUES (?,?,1)` : `INSERT OR REPLACE INTO ${t} (game_id, date, done) VALUES (?,?,1)`).run(id, date);
const box = (t, id, date) => sq.prepare(`INSERT OR REPLACE INTO ${t} (game_id, date, player_id, player) VALUES (?,?,?,?)`).run(id, date, 'p' + id, 'P');
const both = (sport, id, date) => { game(`${sport}_box_games`, id, date); box(`${sport}_box`, id, date); };

console.log('-- all current, Nov 1 --');
both('nba', 'n1', '2026-10-31'); both('nhl', 'h1', '2026-10-31'); both('nfl', 'f1', '2026-10-29');
socGame('s1', 'epl', '2026-10-31'); socRow('s1', 'epl', '2026-10-31');
fresh(); await fire();
let h = await health();
ok(h && Object.values(h.sports).every((x) => !x.warn), `nothing to say: ${JSON.stringify(h && Object.fromEntries(Object.entries(h.sports).map(([k, v]) => [k, v.warn || 'ok'])))}`);
ok(h && h.sports.nba.finished === '2026-10-31' && h.sports.nba.saved === '2026-10-31', 'and it says what it read');

console.log('\n-- the failure of Oct 12, as it stood on Nov 1 --');
socGame('s2', 'seriea', '2026-10-12'); socRow('s2', 'seriea', '2026-10-12');
for (const [i, d] of ['2026-10-17', '2026-10-24', '2026-11-01'].entries()) socGame('s3' + i, 'seriea', d);
fresh(); await fire();
h = await health();
ok(h.sports.soccer.warn === 'behind' && h.sports.soccer.league === 'seriea', `soccer, though the Premier League is current: ${JSON.stringify(h.sports.soccer)}`);
ok(h.sports.soccer.saved === '2026-10-12' && h.sports.soccer.finished === '2026-11-01', 'saved through Oct 12, finished through Nov 1');
ok(!h.sports.nba.warn && !h.sports.nhl.warn && !h.sports.nfl.warn, 'and no other sport');
sq.prepare('DELETE FROM soc_box_games WHERE league = ?').run('seriea'); sq.prepare('DELETE FROM soc_box WHERE league = ?').run('seriea');

console.log('\n-- how long it may wait --');
const waited = async (d) => { game('nba_box_games', 'late', d); fresh(); await fire(); const v = (await health()).sports.nba; sq.prepare("DELETE FROM nba_box_games WHERE game_id = 'late'").run(); return v; };
ok(!(await waited('2026-11-01')).warn, 'finished today: no');
ok(!(await waited('2026-10-30')).warn, 'two days: no');
sq.prepare('DELETE FROM nba_box').run(); sq.prepare('DELETE FROM nba_box_games').run(); both('nba', 'n0', '2026-10-25');
ok((await waited('2026-10-29')).warn === 'behind', 'more than two days: yes');

console.log('\n-- a week between saved games is no gap --');
// Sunday night: Thursday's game saved, today's first finished an hour ago.
both('nfl', 'f2', '2026-10-29'); game('nfl_box_games', 'f3', '2026-11-01');
// The Champions League: the last matchday two weeks ago, this one's stats still coming in.
socGame('u1', 'ucl', '2026-10-20'); socRow('u1', 'ucl', '2026-10-20'); socGame('u2', 'ucl', '2026-11-01', 0);
fresh(); await fire();
h = await health();
ok(!h.sports.nfl.warn, `the NFL, three days after its last game, its next just over: ${JSON.stringify(h.sports.nfl)}`);
ok(!h.sports.soccer.warn, `the Champions League, twelve days after its last matchday: ${JSON.stringify(h.sports.soccer)}`);
sq.prepare("DELETE FROM soc_box_games WHERE game_id = 'u2'").run();

console.log('\n-- games no longer being found --');
sq.prepare('DELETE FROM nhl_box').run(); sq.prepare('DELETE FROM nhl_box_games').run();
both('nhl', 'h2', '2026-10-20');
fresh(); await fire();
h = await health();
ok(h.sports.nhl.warn === 'quiet', `the NHL, in season, nothing since Oct 20: ${JSON.stringify(h.sports.nhl)}`);
sq.prepare('DELETE FROM nhl_box').run(); sq.prepare('DELETE FROM nhl_box_games').run();
both('nhl', 'h3', '2026-10-27');
fresh(); await fire();
ok(!(await health()).sports.nhl.warn, 'five days is not a break it could not have');
NOW = RealDate.parse('2026-07-15T20:00:00Z');
fresh(); await fire();
h = await health();
ok(!h.sports.nhl.warn && !h.sports.nba.warn && !h.sports.nfl.warn, `July: every one of them off, and nothing to say: ${JSON.stringify(Object.values(h.sports).map((x) => x.warn || 'ok'))}`);
NOW = RealDate.parse('2026-11-01T20:00:00Z');

console.log('\n-- what it costs --');
fresh(); await fire();
const stamp = (await health()).at;
asked.length = 0; reads.length = 0;
await fire();
ok((await health()).at === stamp, 'not again for six hours');
ok(!reads.some((q) => /MAX\(date\)/.test(q)), 'and that pass reads no table');
NOW += 6 * 3600e3 + 1000;
await fire();
ok((await health()).at === NOW, 'after that it reads again');
NOW = RealDate.parse('2026-11-01T20:00:00Z');
ok(asked.every((u) => u.includes('hockey/nhl/scoreboard')), `no request for this: only the goalie read went out (${asked.length})`);
const plan = (sql, ...a) => sq.prepare('EXPLAIN QUERY PLAN ' + sql).all(...a).map((r) => r.detail).join('; ');
ok(/USING (COVERING )?INDEX soc_box_league/.test(plan('SELECT MAX(date) AS d FROM soc_box WHERE league = ? AND date >= ?', 'epl', '2026-10-01')), 'soccer stats by league, on the index');
ok(/USING (COVERING )?INDEX nba_box_date/.test(plan('SELECT MAX(date) AS d FROM nba_box')) && /USING (COVERING )?INDEX nhl_box_date/.test(plan('SELECT MAX(date) AS d FROM nhl_box')) && /USING (COVERING )?INDEX nfl_box_date/.test(plan('SELECT MAX(date) AS d FROM nfl_box')), 'and the others');

console.log('\n-- the route --');
const res = await mod.default.fetch(new Request('https://x/api/feed-health'), env, { waitUntil: () => {} });
const body = await res.json();
ok(res.status === 200 && body.sports && body.at, `open, no key: ${res.status}`);
ok(new RegExp("'/api/feed-health'").test(src), 'an API route');
const lockedList = (src.match(/const LOCKED_ROUTES = new Set\(\[([^\]]*)\]/) || [])[1] || '';
ok(!lockedList.includes('feed-health'), 'not locked: it reads one stored row');

console.log('\n-- the page --');
const app = fs.readFileSync(BOARD + '/app.js', 'utf8').replace(/\r\n/g, '\n');
const at = app.search(/\n {2}function feedWarnText\(/);
ok(at >= 0, 'the page has it');
let i = app.indexOf(') {', at) + 2, depth = 0;
for (; i < app.length; i++) { if (app[i] === '{') depth++; else if (app[i] === '}' && --depth === 0) break; }
const shortDay = (d) => ({ '2026-10-12': 'Oct 12', '2026-11-01': 'Nov 1', '2026-10-20': 'Oct 20' }[d] || d);
const namesAt = app.search(/\n {2}const FEED_LEAGUE = /);
const names = app.slice(namesAt, app.indexOf(';', namesAt) + 1);
const text = new Function('shortDay', `${names}\nreturn ${app.slice(at + 3, i + 1)}`)(shortDay);
const H = { sports: {
  soccer: { warn: 'behind', league: 'seriea', saved: '2026-10-12', finished: '2026-11-01' },
  nhl: { warn: 'quiet', saved: '2026-10-20', finished: '2026-10-20' },
  nba: { saved: '2026-10-31', finished: '2026-10-31' },
} };
const s = text(H, 'soccer');
console.log('  ' + s.join(' | '));
ok(s.length === 1 && s[0] === 'Soccer stats are behind in Serie A: saved through Oct 12, matches finished through Nov 1. Its records and Hot players may be out of date.', 'on its own tab, in words');
const n = text(H, 'nhl');
console.log('  ' + n.join(' | '));
ok(n.length === 1 && /^No finished NHL games found since Oct 20\./.test(n[0]), 'games no longer being found');
ok(text(H, 'nba').length === 0 && text(H, 'nfl').length === 0, 'a current sport, and one with no row: nothing');
ok(text(H, 'picks').length === 2, 'Picks draws on all of them, and says so');
ok(text(H, 'mlb').length === 0 && text(H, 'entries').length === 0, 'MLB and Entries have nothing to say');
ok(text(null, 'nba').length === 0, 'and no answer yet: nothing');
ok(text({ sports: { nfl: { warn: 'behind', saved: null, finished: '2026-11-01' } } }, 'nfl')[0].includes('none saved lately'), 'no stats saved at all, said plainly');
ok(/<div class="feed-warn" id="feedWarn"[^>]*hidden/.test(fs.readFileSync(BOARD + '/index.html', 'utf8')), 'a line on the page, hidden until there is something to say');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
