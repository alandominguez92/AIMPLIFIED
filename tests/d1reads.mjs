// D1 rows read, by job and route (2026-11-07).
//
// The free tier's 5M rows read a day ran out on Sep 13, Oct 22 and Nov 7, and every query failed
// until midnight UTC: the page showed nothing and the crons stopped. Nothing said which job had
// read them. What has to hold:
//   - every statement's meta.rows_read is counted under the job or route that ran it: each cron
//     job by its own name, a route by its path, anything unlabelled by its trigger
//   - the handle changes nothing a statement answers: first() with and without a column, a row
//     that isn't there, a batch of the handle's own statements
//   - counts are written by the UTC hour once 2,000 rows wait or ten minutes have passed, and a
//     write that fails keeps them for the next
//   - a database whose answers carry no rows_read (every other test's) gets no table and no write
//   - /api/d1-reads gives a UTC day by label and by hour
//
// META is workerd's own D1 answer, recorded through wrangler's getPlatformProxy on 2026-11-07;
// only rows_read is changed below.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
const META = { served_by: 'miniflare.db', duration: 0, changes: 0, last_row_id: 2083, changed_db: false, size_after: 5885952, rows_read: 260, rows_written: 0 };

const RealDate = Date;
let NOW = RealDate.parse('2026-11-01T20:00:00Z');
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
};
const cacheKept = new Map();
globalThis.caches = { default: { match: async (r) => { const x = cacheKept.get(r.url); return x ? x.clone() : undefined; }, put: async (r, v) => { cacheKept.set(r.url, v.clone()); } } };
globalThis.fetch = async () => new Response('{"events":[]}', { status: 200, headers: { 'content-type': 'application/json' } });

const sq = new DatabaseSync(':memory:');
const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
let PER_SELECT = 0;                         // 0: answers carry no rows_read, as in the other tests
let failD1Write = 0;
const exec = (sql, args, mode) => {
  if (failD1Write && /INTO d1_reads/.test(sql)) { failD1Write--; throw new Error('D1_ERROR: Your account has exceeded D1\'s free tier daily row read limit.'); }
  const st = sq.prepare(sql), a = args.map(norm);
  const meta = PER_SELECT ? { ...META, rows_read: /^\s*(SELECT|WITH)/i.test(sql) ? PER_SELECT : 0 } : {};
  if (mode === 'all') return { results: st.all(...a), meta };
  if (mode === 'first') return st.get(...a) || null;
  return { success: true, meta: { ...meta, changes: Number(st.run(...a).changes) } };
};
// bind() gives a new statement, as D1's does, so one prepared statement bound twice is two.
const stmt = (sql, args = []) => ({ sql, args, bind: (...x) => stmt(sql, x),
  all: async () => exec(sql, args, 'all'), first: async (c) => { const r = exec(sql, args, 'first'); return c && r ? r[c] : r; },
  run: async () => exec(sql, args, 'run') });
const DB = { prepare: (sql) => stmt(sql), batch: async (sts) => sts.map((x) => exec(x.sql, x.args, 'run')) };
const env = { DB };

const src = fs.readFileSync(BOARD + '/worker.js', 'utf8').replace(/\r\n/g, '\n') + '\nexport { d1Env, d1Flush };';
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const cronOf = (name) => (src.match(new RegExp(`const ${name} = '([^']+)'`)) || [])[1];
const fire = async (cron) => { const held = []; await mod.default.scheduled({ cron, scheduledTime: NOW }, env, { waitUntil: (p) => held.push(p) }); await Promise.allSettled(held); };
const get = async (p) => { const held = []; const r = await mod.default.fetch(new Request('https://x' + p), env, { waitUntil: (x) => held.push(x) }); await Promise.allSettled(held); return r; };
const hasTable = () => !!sq.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'd1_reads'").get();
const kept = () => Object.fromEntries(sq.prepare('SELECT label, SUM(rows) AS rows FROM d1_reads GROUP BY label').all().map((r) => [r.label, r.rows]));

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

console.log('answers with no rows_read: nothing kept');
{
  await fire(cronOf('GRADE_CRON'));
  await fire('*/5 * * * *');
  await get('/api/live-now');
  ok(!hasTable(), 'no d1_reads table when no answer says what it read');
}

console.log('a cron tick: each job under its own name');
{
  PER_SELECT = 700;
  await fire(cronOf('GRADE_CRON'));
  ok(hasTable(), 'the tick read past 2,000 rows, so it was written at once');
  const k = kept();
  ok(k.gradeTonight > 0 && k.gradeTonight % 700 === 0, `gradeTonight counted: ${k.gradeTonight}`);
  ok(k.feedHealthTick > 0, `feedHealthTick counted: ${k.feedHealthTick}`);
  ok(Object.keys(k).every((l) => !/^cron /.test(l) || k[l] < k.gradeTonight), 'the jobs are not lumped under the trigger');
  const hour = sq.prepare('SELECT DISTINCT hour FROM d1_reads').all().map((r) => r.hour);
  ok(hour.length === 1 && hour[0] === '2026-11-01T20', `kept by the UTC hour: ${hour}`);
  await fire(cronOf('HIST_CRON'));
  const h = kept();
  ok(h.nbaPropsFormTick > 0 && h.socHotTick > 0, `the two-minute jobs by name: nbaPropsFormTick ${h.nbaPropsFormTick}, socHotTick ${h.socHotTick}`);
}

console.log('a route: under its path, written once enough waits or ten minutes pass');
{
  const before = kept();
  await get('/api/feed-health');
  ok(!kept()['/api/feed-health'] && !before['/api/feed-health'], 'one small read waits');
  NOW += 11 * 60e3;
  await get('/api/hot-players?sport=nhl');
  const k = kept();
  ok(k['/api/feed-health'] === 700, `ten minutes on, it is written: ${k['/api/feed-health']}`);
  ok(k['/api/hot-players?sport=nhl'] > 0, 'the Hot list is kept by sport');
}

console.log('Picks: each part under its own label');
{
  // /api/picks led the counter on Nov 8 (375k rows by 11 PM Pacific), all under one label.
  await get('/api/picks');
  const k = kept();
  ok(k['/api/picks kinds'] > 0, `the kinds' record: ${k['/api/picks kinds']}`);
  ok(k['/api/picks candidates'] > 0, `the candidate legs: ${k['/api/picks candidates']}`);
  ok(k['/api/picks record'] > 0, `the list's record: ${k['/api/picks record']}`);
  ok(k['/api/picks log'] > 0, `the log and its grades: ${k['/api/picks log']}`);
}

console.log('the handle answers as the database does');
{
  const e = mod.d1Env(env, 'check');
  ok(e !== env && e.DB !== env.DB && env.DB === DB, 'a copy of env: the original is untouched');
  ok(mod.d1Env(e, 'again').DB.__d1Raw === DB, 'labelling twice wraps the database once');
  ok((await e.DB.prepare('SELECT 5 AS n').first('n')) === 5, 'first(column) gives the value');
  const row = await e.DB.prepare('SELECT 5 AS n, ? AS s').bind('x').first();
  ok(row && row.n === 5 && row.s === 'x', 'first() gives the row, bound');
  ok((await e.DB.prepare('SELECT 1 AS n WHERE 0').first()) === null, 'no row is null');
  ok((await e.DB.prepare('SELECT 1 AS n WHERE 0').first('n')) === null, 'no row, with a column, is null');
  await e.DB.prepare('CREATE TABLE IF NOT EXISTS t_check (a INTEGER)').run();
  const ins = e.DB.prepare('INSERT INTO t_check (a) VALUES (?)');
  const r = await e.DB.batch([ins.bind(1), ins.bind(2), e.DB.prepare('INSERT INTO t_check (a) VALUES (3)')]);
  ok(r.length === 3 && sq.prepare('SELECT COUNT(*) AS n FROM t_check').get().n === 3, 'a batch of the handle\'s statements runs');
  const all = await e.DB.prepare('SELECT a FROM t_check ORDER BY a').all();
  ok(all.results.map((x) => x.a).join() === '1,2,3' && all.meta.rows_read === 700, 'all() gives results and meta');
}

console.log('a write that fails keeps the counts');
{
  const e = mod.d1Env(env, 'kept-through');
  for (let i = 0; i < 3; i++) await e.DB.prepare('SELECT 1').all();
  failD1Write = 1;
  ok((await mod.d1Flush(env.DB, NOW)) === false, 'the write failed');
  ok(!kept()['kept-through'], 'nothing written');
  ok((await mod.d1Flush(env.DB, NOW)) === true && kept()['kept-through'] === 2100, `the next write has them: ${kept()['kept-through']}`);
}

console.log('/api/d1-reads');
{
  NOW += 3600e3;
  const e = mod.d1Env(env, 'later');
  for (let i = 0; i < 3; i++) await e.DB.prepare('SELECT 1').all();
  await mod.d1Flush(env.DB, NOW);
  const r = await get('/api/d1-reads?day=2026-11-01');
  const d = await r.json();
  const sum = sq.prepare("SELECT SUM(rows) AS n FROM d1_reads WHERE hour LIKE '2026-11-01%'").get().n;
  ok(d.day === '2026-11-01' && d.limit === 5e6 && d.total === sum, `the day's total: ${d.total} of ${d.limit}`);
  ok(d.byLabel.length > 3 && d.byLabel.every((x, i) => !i || d.byLabel[i - 1].rows >= x.rows), 'labels, most read first');
  ok(d.byHour.map((x) => x.hour).join() === '2026-11-01T20,2026-11-01T21' && d.byHour[1].rows === 2100, `by hour: ${JSON.stringify(d.byHour)}`);
  const none = await (await get('/api/d1-reads?day=2026-10-01')).json();
  ok(none.total === 0 && none.byLabel.length === 0, 'a day with nothing is empty');
  ok(/max-age=120/.test(r.headers.get('cache-control') || ''), 'kept at the edge two minutes');
}

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
