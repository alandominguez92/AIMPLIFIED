// ESPN's injury report on the NBA legs (2026-11-01, the owner's call: the
// page said "check injuries" on every NBA leg and nothing more). What has to hold:
//   - the cron reads the day's games from ESPN's scoreboard, then each game's
//     report from its game feed -- the soonest first, two a tick, again every
//     half hour inside twelve hours of tip -- into one row a day
//   - a leg whose game has been read says what the report lists for him, or
//     that it lists nothing; one not read yet keeps "check injuries"
//   - one ESPN lists out leaves the list and the pool, and once his game has
//     started the record says that is why
//   - Out only where ESPN says so both ways: on Nov 1 it had Adou Thiero
//     "Out" with a fantasy status of GTD
//
// Real data: ESPN's Nov 1 scoreboard and the four games' feeds as read at 9
// PM Pacific Oct 31 (tests/fixtures/espn-nba-sb-20261101.json,
// espn-nba-game-injuries-20261101.json), and production's PrizePicks rows for
// Nov 1 (nbapp-20261101.json), their ESPN ids from ESPN's rosters. The 12:30
// PM read of Nets @ Pacers is the 9 PM one with two entries added, each a
// copy of a real one beside it: Day'Ron Sharpe out (rest), as Mikel Brown Jr.
// was, and Andrew Nembhard day-to-day (back soreness), as Obi Toppin was.
// Real SQLite and the real worker.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
const FIX = path.join(BOARD, 'tests', 'fixtures');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const read = (f) => JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));
const SB = read('espn-nba-sb-20261101.json'), GAMES = read('espn-nba-game-injuries-20261101.json').games, PP = read('nbapp-20261101.json').legs;
// ESPN's athlete ids (site.api teams/bkn and teams/ind rosters, Oct 31).
const ESPN_ID = { "Day'Ron Sharpe": '4432194', 'Andrew Nembhard': '4395712', 'Keon Ellis': '4702177', 'Michael Porter Jr': '4278104', 'Julius Randle': '3064514',
  'Jay Huff': '4065731', 'Aaron Nesmith': '4396909', 'Kelly Oubre Jr.': '3133603', 'Pascal Siakam': '3149673', 'Obi Toppin': '4278355' };
const RealDate = Date;
let NOW = RealDate.parse('2026-11-01T19:00:00Z');                 // noon Pacific
globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } };
let feeds = GAMES;
const asked = [];
globalThis.fetch = async (u) => {
  const url = String(u);
  asked.push(url);
  const J = (x) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url === 'https://cdn.espn.com/core/nba/scoreboard?xhr=1&date=20261101') return J(SB);
  if (url === 'https://cdn.espn.com/core/nba/scoreboard?xhr=1&date=20261102') return J({ content: { sbData: { events: [] } } });
  const g = url.match(/^https:\/\/cdn\.espn\.com\/core\/nba\/game\?xhr=1&gameId=(\d+)$/);
  if (g && feeds[g[1]]) return J(feeds[g[1]]);
  return new Response('{}', { status: 404 });
};
const sq = new DatabaseSync(':memory:');
const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
const exec = (sql, args, mode) => { const st = sq.prepare(sql); const a = args.map(norm);
  if (mode === 'all') return { results: st.all(...a), meta: {} }; if (mode === 'first') return st.get(...a) || null;
  if (/^\s*(SELECT|WITH)/i.test(sql)) return { results: st.all(...a), meta: {} };
  return { success: true, meta: { changes: Number(st.run(...a).changes) } }; };
const DB = { prepare: (sql) => { const s = { sql, args: [], bind: (...x) => { s.args = x; return s; },
  all: async () => exec(s.sql, s.args, 'all'), first: async (c) => { const r = exec(s.sql, s.args, 'first'); return c && r ? r[c] : r; },
  run: async () => exec(s.sql, s.args, 'run') }; return s; }, batch: async (sts) => sts.map((x) => exec(x.sql, x.args, 'run')) };
const env = { DB };
const src = fs.readFileSync(BOARD + '/worker.js', 'utf8').replace(/\r\n/g, '\n');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const get = async (u) => (await mod.default.fetch(new Request('https://x' + u), env, { waitUntil: () => {} })).json();
const tick = async () => { const held = []; await mod.default.scheduled({ cron: '*/5 * * * *', scheduledTime: NOW }, env, { waitUntil: (p) => held.push(p) }); await Promise.allSettled(held); };

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
await get('/api/gmpicks-export'); await get('/api/nba-pp'); await get('/api/picks');      // the tables
for (const l of PP) {
  const [away, home] = l.game.split(' @ ');
  sq.prepare(`INSERT INTO nbapp (date, game_id, player, market, league, commence, home, away, team, player_id, point, proj, model_under, min_proj, book_line, book_under, sharp_under, captured_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('2026-11-01', l.game_id, l.player, l.market, 'reg', l.commence, home, away, l.team, ESPN_ID[l.player] || null,
    l.first.line, l.proj, l.first.under, l.min_proj, l.first.book, l.first.book_under, l.first.sharp, l.first.at);
}
const cached = () => JSON.parse(sq.prepare("SELECT data FROM feed_cache WHERE key = 'nba_inj:2026-11-01'").get().data);
const feedReads = (from) => asked.slice(from).filter((u) => /core\/nba\/game\?/.test(u)).map((u) => u.split('gameId=')[1]);
const legsOf = (d) => [...(d.legs || []), ...(d.ppPool || [])];
const leg = (d, who) => legsOf(d).find((x) => x.title.startsWith(who));

console.log('-- noon Pacific: the first tick --');
let a0 = asked.length;
await tick();
let c = cached();
ok(c.games.length === 4 && feedReads(a0).join() === '401909903,401909904',
  `the day's four games from the scoreboard; the two soonest read: ${feedReads(a0).join(', ')}`);
const ind = c.games.find((g) => g.id === '401909904');
ok(ind.inj['4278355'] && ind.inj['4278355'].f === 'GTD' && ind.inj['4278355'].what === 'back soreness' && ind.inj['4017837'].s === 'Out' && ind.inj['4017837'].what === 'ankle sprain',
  "Nets @ Pacers: Obi Toppin GTD (back soreness), Ivica Zubac out (ankle sprain)");
a0 = asked.length;
NOW += 5 * 60e3;
await tick();
ok(feedReads(a0).join() === '401909905,401909906', `five minutes on, the other two; the first two not again yet (${feedReads(a0).join(', ')})`);
c = cached();
const thiero = c.games.find((g) => g.id === '401909906').inj['5060631'];
ok(thiero && thiero.s === 'Out' && thiero.f === 'GTD', 'Adou Thiero as ESPN has him: "Out", fantasy GTD');

let d = await get('/api/picks');
const sh = leg(d, "Day'Ron Sharpe");
console.log(`  ${legsOf(d).filter((x) => x.sport === 'nba').map((x) => `${x.title} ${JSON.stringify(x.inj || null)}`).join(' | ')}`);
ok(sh && sh.inj && sh.inj.status === null && sh.inj.at === new RealDate(RealDate.parse('2026-11-01T19:00:00Z')).toISOString(),
  "Day'Ron Sharpe's assists: not on the report, as read at noon");

console.log('\n-- 12:35 PM: ESPN rules Sharpe out, Nembhard questionable --');
const g4 = structuredClone(GAMES['401909904']);
const bkn = g4.gamepackageJSON.injuries.find((t) => t.team.abbreviation === 'BKN'), indT = g4.gamepackageJSON.injuries.find((t) => t.team.abbreviation === 'IND');
const brown = bkn.injuries.find((i) => i.athlete.displayName === 'Mikel Brown Jr.'), toppin = indT.injuries.find((i) => i.athlete.displayName === 'Obi Toppin');
bkn.injuries.push({ ...structuredClone(brown), date: '2026-11-01T19:30Z', athlete: { ...brown.athlete, id: '4432194', displayName: "Day'Ron Sharpe", fullName: "Day'Ron Sharpe" } });
indT.injuries.push({ ...structuredClone(toppin), date: '2026-11-01T19:31Z', athlete: { ...toppin.athlete, id: '4395712', displayName: 'Andrew Nembhard', fullName: 'Andrew Nembhard' } });
feeds = { ...GAMES, '401909904': g4 };
NOW = RealDate.parse('2026-11-01T19:35:00Z');
a0 = asked.length;
await tick();
ok(feedReads(a0).includes('401909904'), 'half an hour on, Nets @ Pacers read again');
d = await get('/api/picks');
const nem = leg(d, 'Andrew Nembhard');
console.log(`  ${legsOf(d).filter((x) => x.sport === 'nba').map((x) => `${x.title} ${JSON.stringify(x.inj || null)}`).join(' | ')}`);
ok(!leg(d, "Day'Ron Sharpe"), 'Sharpe, out: off the list and the pool');
ok(nem && nem.inj && nem.inj.status === 'GTD' && nem.inj.what === 'back soreness' && !nem.inj.out && (d.ppPool || []).some((x) => x.legId === nem.legId),
  "Nembhard's assists take the game's place, flagged GTD (back soreness)");

console.log('\n-- after tip --');
NOW = RealDate.parse('2026-11-01T22:30:00Z');
d = await get('/api/picks');
const day = ((d.record && d.record.history && d.record.history.days) || []).find((x) => x.date === '2026-11-01');
const drop = day && (day.dropped || []).find((x) => /Sharpe/.test(x.label));
ok(drop && drop.why === 'ESPN listed him out (rest)', `the record says why Sharpe left: "${drop && drop.why}"`);

// ---- the page -------------------------------------------------------------------------------------
console.log('\n-- the page --');
const app = fs.readFileSync(BOARD + '/app.js', 'utf8').replace(/\r\n/g, '\n');
const at = app.indexOf('  function injuryTag(');
const IT = new Function('Date', app.slice(at, app.indexOf('\n  }\n', at) + 4) + '\nreturn injuryTag;')(globalThis.Date);
NOW = RealDate.parse('2026-11-01T19:47:00Z');
const t1 = IT(nem), t2 = IT(sh), t3 = IT({ sport: 'nba', spec: { sport: 'nba', playerId: '1' } }), t4 = IT({ sport: 'nhl', spec: {} });
ok(t1.warn && t1.text === 'GTD: back soreness' && t1.title === "ESPN's injury report, read 12 min ago", `Nembhard: "${t1.text}" (${t1.title})`);
ok(!t2.warn && t2.text === 'no injury listed', `Sharpe at noon: "${t2.text}"`);
ok(t3.warn && t3.text === 'check injuries' && t4 === null, 'a game not read yet keeps "check injuries"; an NHL leg, nothing');
ok(/const it = injuryTag\(x\);\n\s+if \(it\) notes\.push\(it\.text\);/.test(app) && /const it = injuryTag\(x\);\n\s+if \(it\) tags\.push/.test(app) && !/'check injuries'\)/.test(app),
  "on the list's rows and the hero, where the fixed reminder was");

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
