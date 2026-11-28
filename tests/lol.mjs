// League of Legends, step one (2026-11-28, the owner's OK of the recommended build): the LCK, LPL,
// LEC and LCS from Leaguepedia, each team's rating from its map results this season, each series'
// chance logged until its start and graded, on a tab of its own. What has to hold:
//   - Leaguepedia is read on HIST_CRON's invocation only, never on a page view, under the Worker's
//     own client name: the schedule, the scoreboards from the first map not in, and the leagues'
//     tournament dates, each only when due
//   - a map is kept with its ten players; the season's ratings are the replay's (K 24, every team
//     level in January, map by map in the order played), and a series' chance is its format's
//   - a series not yet started takes the current chance; from its start the logged one stands,
//     and it is graded on its favourite; one that started before it was ever logged is not graded
//   - the board: each match's two chances, maps behind each team, the Picks bar (75%+ with both
//     teams eight maps in), results from the start only, and the record by the replay's bands
//   - the tabs: today's series and any on now
//   - a refusal is shown on the board and Leaguepedia is left alone for half an hour
//
// Real data: every LCK, LPL, LEC and LCS map of 2026 before Aug 6 (tests/fixtures/lol-games-2026.json,
// from Leaguepedia's scoreboards read Nov 27) and Leaguepedia's raw answers to the Worker's own
// queries with its clock at Aug 8 12:00 and Aug 9 08:00 UTC (tests/fixtures/lol-cargo-202608.json,
// read Nov 28). A replay: the schedule read on Nov 28 carries the results of matches still to come
// at those moments, which the Worker must not show early. One stand-in, said where it is: the rate
// limit's answer, in the shape Leaguepedia gave on Nov 27.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
const FIX = (f) => JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', f), 'utf8'));
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const RealDate = Date;
let NOW = RealDate.parse('2026-08-08T12:00:00Z');
globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } };
let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

const GAMES = FIX('lol-games-2026.json').games, READS = FIX('lol-cargo-202608.json').reads;
const asked = [], unknown = [];
let refuse = false;
globalThis.fetch = async (u, init) => {
  const url = String(u);
  if (!url.startsWith('https://lol.fandom.com/')) return new Response('{}', { status: 404 });
  asked.push({ url, ua: init && init.headers && init.headers['user-agent'], at: NOW });
  if (refuse) return new Response(JSON.stringify({ error: { code: 'ratelimited', info: "You've exceeded your rate limit. Please wait some time and try again." } }), { status: 200 });
  const hit = READS.find((r) => r.url === url);
  if (!hit) { unknown.push(url); return new Response('{}', { status: 404 }); }
  return new Response(hit.body, { status: hit.status, headers: { 'content-type': 'application/json' } });
};
const sq = new DatabaseSync(':memory:');
const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
const exec = (sql, args, mode) => { const st = sq.prepare(sql); const a = args.map(norm);
  if (mode === 'all') return { results: st.all(...a), meta: {} }; if (mode === 'first') return st.get(...a) || null;
  return { success: true, meta: { changes: Number(st.run(...a).changes) } }; };
const DB = { prepare: (sql) => { const s = { sql, args: [], bind: (...x) => { s.args = x; return s; },
  all: async () => exec(s.sql, s.args, 'all'), first: async (c) => { const r = exec(s.sql, s.args, 'first'); return c && r ? r[c] : r; },
  run: async () => exec(s.sql, s.args, 'run') }; return s; },
  batch: async (sts) => sts.map((x) => exec(x.sql, x.args, /^\s*SELECT/i.test(x.sql) ? 'all' : 'run')) };
const env = { DB };
const src = fs.readFileSync(BOARD + '/worker.js', 'utf8').replace(/\r\n/g, '\n');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const call = async (u) => { try { return await mod.default.fetch(new Request('https://x' + u), env, { waitUntil: () => {} }); } catch (e) { return new Response(JSON.stringify({ thrown: String(e) }), { status: 599 }); } };
const get = async (u) => { const r = await call(u); return { status: r.status, body: await r.json().catch(() => null) }; };
const fire = async () => { const jobs = []; await mod.default.scheduled({ cron: '1-59/2 * * * *', scheduledTime: NOW }, env, { waitUntil: (p) => jobs.push(p) }); await Promise.allSettled(jobs); };
const tablesOf = (a) => decodeURIComponent(new URL(a.url).searchParams.get('tables'));

console.log('-- the board answers from what is stored, and reads nothing --');
let b = await get('/api/lol-board');
ok(b.status === 200 && b.body && Array.isArray(b.body.matches), `/api/lol-board answers (${b.status})`);
ok(asked.length === 0, `a page view asks Leaguepedia nothing (${asked.length})`);
const ins = sq.prepare('INSERT INTO lolgames (game_id, match_id, league, year, start, blue, red, winner) VALUES (?,?,?,2026,?,?,?,?)');
for (const g of GAMES) ins.run(g[0], g[1], g[2], g[3], g[4], g[5], g[6]);
console.log(`        seeded ${GAMES.length} maps of 2026 before Aug 6`);

console.log('\n-- Aug 8, 12:00 UTC: the first tick --');
await fire();
ok(asked.length === 3 && asked.map(tablesOf).join(',') === 'MatchSchedule=MS,ScoreboardPlayers=SP,Tournaments=T',
  `the schedule, the scoreboards and the tournaments: ${asked.map(tablesOf).join(', ')}`);
ok(asked.every((a) => a.ua === 'aimplified/1.0 (personal, non-commercial)'), 'under the Worker\'s own client name, nothing personal');
ok(unknown.length === 0, `every query is one recorded (${unknown.length} not)`);
const series = () => sq.prepare('SELECT * FROM lolseries ORDER BY start, match_id').all();
const sched0 = JSON.parse(READS[0].body).cargoquery.map((x) => x.title);
ok(series().length === sched0.filter((r) => !/^tbd$/i.test(r.Team1) && !/^tbd$/i.test(r.Team2)).length && series().length > 60,
  `the schedule's ${series().length} series stored, Aug 5 to Aug 18`);
const maps = sq.prepare('SELECT COUNT(*) AS n FROM lolgames').get().n, players = sq.prepare('SELECT COUNT(*) AS n FROM lolplayers').get().n;
ok(maps > GAMES.length && players === 10 * (maps - GAMES.length) + 10 * sq.prepare("SELECT COUNT(*) AS n FROM lolgames WHERE start >= '2026-08-04T13:29:00.000Z' AND start < '2026-08-06T00:00:00.000Z'").get().n,
  `the scoreboards: ${maps - GAMES.length} maps to Aug 8 added, each with its ten players (${players})`);
ok(sq.prepare("SELECT COUNT(*) AS n FROM lolgames WHERE start > '2026-08-08T12:00:00.000Z'").get().n === 0, 'and no map from after the tick');

// The replay's rating, written out again here: K 24, every team at 1500, map by map.
const R = new Map(), M = new Map();
for (const g of sq.prepare('SELECT * FROM lolgames WHERE year = 2026 ORDER BY start, game_id').all()) {
  const a = `${g.league}|${g.blue}`, c = `${g.league}|${g.red}`, ra = R.get(a) ?? 1500, rc = R.get(c) ?? 1500;
  const d = 24 * ((g.winner === g.blue ? 1 : 0) - 1 / (1 + Math.pow(10, (rc - ra) / 400)));
  R.set(a, ra + d); R.set(c, rc - d); M.set(a, (M.get(a) || 0) + 1); M.set(c, (M.get(c) || 0) + 1);
}
// Unrounded: the log keeps a tenth, so it sits within half a tenth of this.
const want = (s) => { const p = 1 / (1 + Math.pow(10, ((R.get(`${s.league}|${s.team2}`) ?? 1500) - (R.get(`${s.league}|${s.team1}`) ?? 1500)) / 400));
  return (s.bo === 3 ? p * p * (3 - 2 * p) : s.bo === 5 ? Math.pow(p, 3) * (10 - 15 * p + 6 * p * p) : p) * 100; };
const pre = series().filter((s) => s.start > '2026-08-08T12:00:00.000Z'), before = series().filter((s) => s.start <= '2026-08-08T12:00:00.000Z');
const off = pre.filter((s) => !(s.p1 != null && Math.abs(s.p1 - want(s)) <= 0.0501 && s.maps1 === (M.get(`${s.league}|${s.team1}`) || 0) && s.maps2 === (M.get(`${s.league}|${s.team2}`) || 0)));
ok(pre.length > 30 && off.length === 0,
  `every series to come logs the replay's chance and each team's maps (${pre.length - off.length} of ${pre.length})`
  + off.slice(0, 4).map((s) => `\n          ${s.match_id}: ${s.team1} v ${s.team2} Bo${s.bo} logged ${s.p1}% (${s.maps1}, ${s.maps2} maps), the replay ${want(s).toFixed(3)}% (${M.get(`${s.league}|${s.team1}`) || 0}, ${M.get(`${s.league}|${s.team2}`) || 0})`).join(''));
ok(before.every((s) => s.p1 == null && s.result === 'unlogged'), `the ${before.length} already played when the log began count for nothing ('unlogged')`);

console.log('\n-- the board at Aug 8, 12:00 --');
b = await get('/api/lol-board');
const d1 = b.body;
const m = (id) => (d1.matches || []).find((x) => x.id === id) || {};
const C9 = 'LCS/2026 Season/Summer Season_Week 3_1', SK = 'LEC/2026 Season/Summer Season_Week 3_3';
const c9 = m(C9);
console.log(`        ${c9.league} ${c9.teams && c9.teams.map((t) => `${t.name} ${t.p}% (${t.maps} maps)`).join(' v ')}, Bo${c9.bo}, ${c9.state}`);
ok(d1.matches.length > 30 && d1.matches.every((x) => x.start >= '2026-08-07T12:00:00.000Z' && x.start <= '2026-08-16T12:00:00.000Z'), `yesterday to a week on: ${d1.matches.length} series`);
ok(c9.state === 'pre' && !c9.score && c9.teams.every((t) => !t.won) && Math.abs(c9.teams[0].p + c9.teams[1].p - 100) < 0.11,
  'a series to come: two chances adding to 100, and no result, though the schedule read on Nov 28 has it');
ok(d1.matches.filter((x) => x.state === 'pre').every((x) => x.warm === (x.teams[0].maps >= 8 && x.teams[1].maps >= 8)
  && x.bar === (x.pFav >= 75 && x.warm)), 'warm once both teams have eight maps; the Picks bar at 75%+ on warm teams only');
const bars = d1.matches.filter((x) => x.bar);
console.log(`        at the bar: ${bars.map((x) => `${x.teams[x.fav - 1].name} ${x.pFav}%`).join(', ') || 'none'}`);
const played = d1.matches.filter((x) => x.state === 'post');
ok(played.length > 0 && played.every((x) => x.score && x.teams.filter((t) => t.won).length === 1 && x.teams[0].p == null),
  `the ${played.length} played: a score and a winner, and no chance (never logged)`);
ok(d1.season && d1.season.year === 2026 && d1.season.maps === maps, `the season: ${d1.season && d1.season.maps} maps, ${d1.season && d1.season.teams} teams`);
ok(d1.next === null, 'nothing to say about next season while matches are scheduled');

console.log('\n-- Aug 9, 08:00 UTC: the night\'s series graded --');
asked.length = 0;
NOW = RealDate.parse('2026-08-09T08:00:00Z');
await fire();
ok(asked.map(tablesOf).join(',') === 'MatchSchedule=MS,ScoreboardPlayers=SP' && unknown.length === 0,
  `the schedule and the scoreboards again; the tournaments not due (${asked.map(tablesOf).join(', ')})`);
const night = series().filter((s) => s.start > '2026-08-08T12:00:00.000Z' && s.start <= '2026-08-09T08:00:00.000Z');
ok(night.length >= 4 && night.every((s) => s.graded_at && s.result === ((s.p1 >= 50 ? 1 : 2) === s.winner ? 'win' : 'loss')),
  `each graded on its favourite at the chance logged before it: ${night.map((s) => `${s.team1} v ${s.team2} ${s.p1}% ${s.result}`).join('; ')}`);
const c9row = night.find((s) => s.match_id === C9);
ok(c9row && c9row.p1 === c9.teams[0].p, `Cloud9 v Disguised graded at the ${c9row && c9row.p1}% the board showed`);
b = await get('/api/lol-board');
const d2 = b.body, rec = d2.record || {};
const bandN = Object.values(rec.byBand || {}).reduce((a, x) => a + x.n, 0);
ok(rec.n === night.length && bandN === rec.n && rec.byBand['75+'] && rec.picks,
  `the record: ${rec.n} graded, by band ${Object.entries(rec.byBand || {}).map(([k, x]) => `${k} ${x.hit}/${x.n}`).join(', ')}; at the Picks bar ${rec.picks && rec.picks.hit}/${rec.picks && rec.picks.n}`);
const c92 = d2.matches.find((x) => x.id === C9) || {};
ok(c92.state === 'post' && c92.score && c92.teams[0].p === c9.teams[0].p && c92.teams.filter((t) => t.won).length === 1,
  `Cloud9 v Disguised on the board: ${c92.score && c92.score.join('-')}, the logged chance kept`);

console.log('\n-- the tabs --');
const t = await get('/api/tabs');
const lol = t.body && t.body.sports && t.body.sports.lol;
const aug9 = series().filter((s) => s.date === '2026-08-09');
ok(lol && lol.today === aug9.length && lol.live === 0, `League of Legends: ${lol && lol.today} series today (Pacific), ${lol && lol.live} on now`);

console.log('\n-- nothing due, nothing asked --');
asked.length = 0;
NOW += 2 * 60e3;
await fire();
ok(asked.length === 0, `two minutes on: ${asked.length} reads`);

console.log('\n-- a refusal (stand-in: the rate limit\'s answer) --');
NOW = RealDate.parse('2026-08-09T11:30:00Z');                  // the schedule due again
refuse = true;
await fire();
ok(asked.length === 1 && tablesOf(asked[0]) === 'MatchSchedule=MS', 'one read, refused, and nothing more that tick');
b = await get('/api/lol-board');
ok(b.body.status && b.body.status.error && b.body.status.error.error === 'ratelimited' && b.body.status.error.what === 'schedule', `the board says so: ${JSON.stringify(b.body.status && b.body.status.error)}`);
NOW += 20 * 60e3;
await fire();
ok(asked.length === 1, 'twenty minutes on, still left alone');
NOW += 12 * 60e3;
refuse = false;
await fire();
ok(asked.length === 2, 'half an hour on, asked again');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
