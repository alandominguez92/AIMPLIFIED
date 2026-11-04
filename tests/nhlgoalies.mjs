// The NHL goalie by name (2026-11-04).
//
// An NHL leg said only "check the goalie", though the starter moves an NHL line more than anything
// and ESPN lists it free. What has to hold:
//   - ESPN's starters are read on the grading trigger, for today and tomorrow, at no Odds API cost,
//     and written only when they change
//   - an NHL leg carries its game's two names and how sure ESPN is, by the leg's own day, so a team
//     that plays twice in two days gets the right one
//   - a game with no starter listed, or only one, still says to check the goalie
//   - an empty answer doesn't wipe the names already read, since it is a failed read as often as a day off
//   - the page says who, and says when it's only expected
//
// Recorded from ESPN: Nov 4's board (all Expected), Nov 3's (all Confirmed), and Nov 10's, too far out
// for anyone to be listed. The host is site.api.espn.com, which refuses the Worker when it sends a
// user agent (2026-11-03), so none is sent.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
const FIX = (f) => JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', f), 'utf8'));
const EXPECTED = FIX('espn-nhl-sb-expected-20261104.json');
const CONFIRMED = FIX('espn-nhl-sb-confirmed-20261103.json');
const UNLISTED = FIX('espn-nhl-sb-unlisted-20261110.json');

const RealDate = Date;
let NOW = RealDate.parse('2026-11-04T17:00:00Z');        // Wednesday 9 AM Pacific
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
};
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };

const boards = { 20261104: EXPECTED };
const asked = [];
let sentUa = false;
globalThis.fetch = async (u, o) => {
  const url = String(u);
  asked.push(url);
  if (url.includes('site.api.espn.com') && url.includes('hockey/nhl/scoreboard')) {
    if (o && o.headers && Object.keys(o.headers).some((k) => k.toLowerCase() === 'user-agent')) sentUa = true;
    const day = (url.match(/dates=(\d{8})/) || [])[1];
    return new Response(JSON.stringify(boards[day] || { events: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response('{}', { status: 404 });
};

const sq = new DatabaseSync(':memory:');
const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
const exec = (sql, args, mode) => { const st = sq.prepare(sql); const a = args.map(norm);
  if (mode === 'all') return { results: st.all(...a), meta: {} }; if (mode === 'first') return st.get(...a) || null;
  return { success: true, meta: { changes: Number(st.run(...a).changes) } }; };
const writes = [];
const DB = { prepare: (sql) => { const s = { sql, args: [], bind: (...x) => { s.args = x; return s; },
  all: async () => exec(s.sql, s.args, 'all'), first: async (c) => { const r = exec(s.sql, s.args, 'first'); return c && r ? r[c] : r; },
  run: async () => { if (/feed_cache/.test(s.sql) && /INSERT|REPLACE/.test(s.sql)) writes.push(s.args[0]); return exec(s.sql, s.args, 'run'); } }; return s; },
  batch: async (sts) => sts.map((x) => exec(x.sql, x.args, 'run')) };
const env = { DB };

const src = fs.readFileSync(BOARD + '/worker.js', 'utf8').replace(/\r\n/g, '\n');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const GRADE_CRON = (src.match(/const GRADE_CRON = '([^']+)'/) || [])[1];
const fire = async () => {
  const jobs = [];
  await mod.default.scheduled({ cron: GRADE_CRON, scheduledTime: NOW }, env, { waitUntil: (p) => jobs.push(p) });
  await Promise.allSettled(jobs);
};
const hit = async (u) => (await mod.default.fetch(new Request('https://x' + u), env, { waitUntil: () => {} })).json();

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

await hit('/api/gmpicks-export');
const ins = sq.prepare(`INSERT INTO gmpicks (sport, date, game_id, market, league, commence, side, pick, home, away, win_prob, implied, edge, entry_price, close_price, book, fair_src, sharp_n, model_ver, entry_win_prob)
  VALUES ('nhl', ?, ?, 'h2h', 'reg', ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, 'draftkings', 'sharp-pool', 4, 'gm-v1', ?)`);
const row = (date, id, commence, side, home, away, p, price) => ins.run(date, id, commence, side, side === 'home' ? home : away, home, away, p, price, price, p);

console.log('-- the read --');
await fire();
const days = asked.filter((u) => u.includes('hockey/nhl/scoreboard')).map((u) => u.match(/dates=(\d{8})/)[1]);
ok(days.includes('20261104') && days.includes('20261105'), `today and tomorrow, Pacific: ${days.join(', ')}`);
ok(asked.every((u) => !u.includes('the-odds-api')), 'no Odds API request');
ok(!sentUa, 'and no user agent, which that host refuses');
const stored = JSON.parse(sq.prepare("SELECT data FROM feed_cache WHERE key = 'nhl_goalies:2026-11-04'").get()?.data || '{}');
const fla = (stored.games || []).find((g) => g.home === 'Florida Panthers');
ok(fla && fla.homeG === 'Jacob Markstrom' && fla.awayG === 'Spencer Knight' && fla.homeS === 'Expected', `kept by game: ${JSON.stringify(fla)}`);
writes.length = 0;
await fire();
ok(!writes.includes('nhl_goalies:2026-11-04'), 'the same answer again writes nothing');

console.log('\n-- on the legs --');
row('2026-11-04', 'chi-fla', '2026-11-05T00:30:00Z', 'home', 'Florida Panthers', 'Chicago Blackhawks', 70, -233);
row('2026-11-04', 'sj-la', '2026-11-05T03:00:00Z', 'home', 'Los Angeles Kings', 'San Jose Sharks', 68, -212);
// The same two teams the next day, inside the list's day ahead: its own day, its own names.
boards[20261105] = FIX('espn-nhl-sb-expected-20261104.json');
boards[20261105].events = [{ ...boards[20261105].events[0], id: '1', date: '2026-11-06T00:00Z', competitions: [{ date: '2026-11-06T00:00Z', competitors: [
  { homeAway: 'home', team: { abbreviation: 'FLA', displayName: 'Florida Panthers' }, probables: [{ name: 'probableStartingGoalie', status: { name: 'Expected' }, athlete: { displayName: 'Sergei Bobrovsky' } }] },
  { homeAway: 'away', team: { abbreviation: 'CHI', displayName: 'Chicago Blackhawks' }, probables: [{ name: 'probableStartingGoalie', status: { name: 'Expected' }, athlete: { displayName: 'Arvid Soderblom' } }] },
] }] }];
await fire();
row('2026-11-05', 'chi-fla-2', '2026-11-05T16:00:00Z', 'home', 'Florida Panthers', 'Chicago Blackhawks', 69, -222);
// A game ESPN has nobody listed for.
row('2026-11-04', 'none', '2026-11-05T02:00:00Z', 'home', 'Anaheim Ducks', 'Colorado Avalanche', 67, -203);
let d = await hit('/api/picks');
const leg = (id) => (d.legs || []).find((x) => x.legId === `nhl:ml:${id}:home`);
ok(leg('chi-fla') && leg('chi-fla').goalies && leg('chi-fla').goalies.home === 'Jacob Markstrom' && leg('chi-fla').goalies.away === 'Spencer Knight' && leg('chi-fla').goalies.confirmed === false,
  `Blackhawks @ Panthers: ${JSON.stringify(leg('chi-fla') && leg('chi-fla').goalies)}`);
ok(leg('sj-la') && leg('sj-la').goalies && leg('sj-la').goalies.home === 'Darcy Kuemper' && leg('sj-la').goalies.away === 'Yaroslav Askarov', `Sharks @ Kings: ${JSON.stringify(leg('sj-la') && leg('sj-la').goalies)}`);
ok(leg('chi-fla-2') && leg('chi-fla-2').goalies && leg('chi-fla-2').goalies.home === 'Sergei Bobrovsky', `the same two teams the next day, that day's: ${JSON.stringify(leg('chi-fla-2') && leg('chi-fla-2').goalies)}`);
ok(leg('none') && !leg('none').goalies, 'a game ESPN does not list: no names');

console.log('\n-- how sure --');
boards[20261104] = { events: EXPECTED.events.map((e) => {
  const c = e.competitions[0], sure = (t) => ({ ...t, probables: t.probables.map((p) => ({ ...p, status: { name: 'Confirmed' } })) });
  return !c.competitors.some((t) => t.team.displayName === 'Florida Panthers') ? e
    : { ...e, competitions: [{ ...c, competitors: [sure(c.competitors[0]), c.competitors[1]] }] };
}) };
await fire();
d = await hit('/api/picks');
ok(leg('chi-fla').goalies.confirmed === false, 'one side confirmed and one expected is not confirmed');
const both = { ...CONFIRMED };
boards[20261104] = { events: EXPECTED.events.map((e) => {
  const c = e.competitions[0], sure = (t) => ({ ...t, probables: t.probables.map((p) => ({ ...p, status: { name: 'Confirmed' } })) });
  return { ...e, competitions: [{ ...c, competitors: c.competitors.map(sure) }] };
}) };
await fire();
d = await hit('/api/picks');
ok(leg('chi-fla').goalies.confirmed === true, 'both confirmed is');
ok(both.events.every((e) => e.competitions[0].competitors.every((t) => t.probables[0].status.name === 'Confirmed')), "ESPN's word for it, as recorded on Nov 3's board");

console.log('\n-- what an answer can take away --');
const before = sq.prepare("SELECT data FROM feed_cache WHERE key = 'nhl_goalies:2026-11-04'").get().data;
boards[20261104] = { events: [] };
await fire();
ok(sq.prepare("SELECT data FROM feed_cache WHERE key = 'nhl_goalies:2026-11-04'").get().data === before, 'an empty answer leaves the names read');
boards[20261104] = UNLISTED;
await fire();
d = await hit('/api/picks');
ok(leg('chi-fla') && !leg('chi-fla').goalies, 'a real board with nobody listed: no names');

console.log('\n-- the page --');
const app = fs.readFileSync(BOARD + '/app.js', 'utf8').replace(/\r\n/g, '\n');
const at = app.search(/\n {2}function goalieNote\(/);
ok(at >= 0, 'the page has the note');
let i = app.indexOf(') {', at) + 2, depth = 0;
for (; i < app.length; i++) { if (app[i] === '{') depth++; else if (app[i] === '}' && --depth === 0) break; }
const goalieNote = new Function(`return ${app.slice(at + 3, i + 1)}`)();
const note = (g) => goalieNote({ sport: 'nhl', goalies: g });
ok(note({ home: 'Jacob Markstrom', away: 'Spencer Knight', confirmed: false }).text === 'Knight @ Markstrom, expected' && note({ home: 'Jacob Markstrom', away: 'Spencer Knight', confirmed: false }).warn === true,
  `expected, the away goalie first, as the game reads: "${note({ home: 'Jacob Markstrom', away: 'Spencer Knight', confirmed: false }).text}"`);
ok(note({ home: 'Andrei Vasilevskiy', away: 'John Gibson', confirmed: true }).text === 'Gibson @ Vasilevskiy, confirmed' && !note({ home: 'Andrei Vasilevskiy', away: 'John Gibson', confirmed: true }).warn,
  `confirmed: "${note({ home: 'Andrei Vasilevskiy', away: 'John Gibson', confirmed: true }).text}"`);
ok(goalieNote({ sport: 'nhl' }).text === 'check the goalie' && goalieNote({ sport: 'nhl' }).warn === true, 'no names: still says to check');
ok(goalieNote({ sport: 'nba' }) === null && goalieNote({ spec: { sport: 'nba' } }) === null, 'and nothing on another sport');
ok(/\(x\.sport \|\| s\.sport\) === 'nhl'/.test(app) === false || /goalieNote\(\{ \.\.\.x, sport: x\.sport \|\| s\.sport \}\)/.test(app), 'the top card reads it');
ok(/goalieNote\(x\)/.test(app), 'and so does the list');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
