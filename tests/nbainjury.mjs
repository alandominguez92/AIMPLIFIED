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
//   - a moneyline names who each side is missing, the picked side first
//
// Real data: ESPN's Nov 1 scoreboard and the four games' feeds as read at 9
// PM Pacific Oct 31 (tests/fixtures/espn-nba-sb-20261101.json,
// espn-nba-game-injuries-20261101.json), and production's PrizePicks rows for
// Nov 1 (nbapp-20261101.json), their ESPN ids from ESPN's rosters. The 12:30
// PM read of Nets @ Pacers is the 9 PM one with two entries added, each a
// copy of a real one beside it: Day'Ron Sharpe out (rest), as Mikel Brown Jr.
// was, and Keon Ellis day-to-day (back soreness), as Obi Toppin was. Threes and
// assists left Picks on Nov 1 (tests/threesoff.mjs), so the player legs here are
// those two's rebounds: their rows are real, the sharp lines beside them (read
// only near tip, and these rows are from the night before) shaped as
// tests/rebgap.mjs records them.
// Nov 1's moneylines are logged on the day, so the Clippers @ Warriors row is
// shaped as Oct 31's were (production's gmpicks export), its teams and start
// ESPN's. Real SQLite and the real worker.
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
sq.prepare(`INSERT INTO gmpicks (sport, date, game_id, market, league, commence, side, pick, home, away, win_prob, entry_price, close_price, result)
  VALUES ('nba', '2026-11-01', 'f00dfeed00000000000000000000c1a5', 'h2h', 'reg', '2026-11-02T01:40:00Z', 'away', 'Los Angeles Clippers', 'Golden State Warriors', 'Los Angeles Clippers', 70.2, -230, -245, NULL)`).run();
const unders = (bk, line, u) => JSON.stringify({ [bk]: [line, u] });
sq.prepare("UPDATE nbapp SET book_unders = ? WHERE player = ? AND market = 'reb'").run(unders('pinnacle', 7.5, 50.4), "Day'Ron Sharpe");
sq.prepare("UPDATE nbapp SET book_unders = ? WHERE player = ? AND market = 'reb'").run(unders('fanduel', 1.5, 49.8), 'Keon Ellis');
const cached = () => JSON.parse(sq.prepare("SELECT data FROM feed_cache WHERE key = 'nba_inj:2026-11-01'").get().data);
const feedReads = (from) => asked.slice(from).filter((u) => /core\/nba\/game\?/.test(u)).map((u) => u.split('gameId=')[1]);
const legsOf = (d) => [...(d.legs || []), ...(d.ppPool || [])];
const leg = (d, who) => legsOf(d).find((x) => x.title.startsWith(who));

// The NBA tab, the same report (2026-11-01, the owner's call). Nothing read yet: no flag.
const npLeg = (dd, who, m) => dd.legs.find((l) => l.player === who && l.market === m);
const np0 = await get('/api/nba-pp');
ok(np0.legs.length > 0 && np0.legs.every((l) => l.inj === undefined), 'the NBA tab before any report is read: no flags');

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
  "Day'Ron Sharpe's rebounds: not on the report, as read at noon");
const ml = leg(d, 'Clippers ML');
const T = (ml && ml.inj && ml.inj.teams) || [];
console.log(`  ${ml && ml.title}: ${JSON.stringify(T)}`);
ok(T.length === 2 && T[0].team === 'Clippers' && T[1].team === 'Warriors'
  && T[0].out.map((p) => p.n).join() === 'Niederhauser,Strus,Ingram,Beal,Miller' && T[0].gtd.length === 0
  && T[1].out.map((p) => p.n).join() === 'Green,Curry,Porzingis,Moody' && T[1].gtd.map((p) => p.n).join() === 'Santos'
  && T[1].out[0].what === 'rest' && T[1].out[3].what === 'knee surgery',
  'the Clippers moneyline: who each side is missing, the picked side first, newest news first -- Warriors without Green and Curry (rest), Santos GTD');

console.log('\n-- 12:35 PM: ESPN rules Sharpe out, Ellis questionable --');
const g4 = structuredClone(GAMES['401909904']);
const bkn = g4.gamepackageJSON.injuries.find((t) => t.team.abbreviation === 'BKN'), indT = g4.gamepackageJSON.injuries.find((t) => t.team.abbreviation === 'IND');
const brown = bkn.injuries.find((i) => i.athlete.displayName === 'Mikel Brown Jr.'), toppin = indT.injuries.find((i) => i.athlete.displayName === 'Obi Toppin');
bkn.injuries.push({ ...structuredClone(brown), date: '2026-11-01T19:30Z', athlete: { ...brown.athlete, id: '4432194', displayName: "Day'Ron Sharpe", fullName: "Day'Ron Sharpe" } });
indT.injuries.push({ ...structuredClone(toppin), date: '2026-11-01T19:31Z', athlete: { ...toppin.athlete, id: '4702177', displayName: 'Keon Ellis', fullName: 'Keon Ellis' } });
feeds = { ...GAMES, '401909904': g4 };
NOW = RealDate.parse('2026-11-01T19:35:00Z');
a0 = asked.length;
await tick();
ok(feedReads(a0).includes('401909904'), 'half an hour on, Nets @ Pacers read again');
d = await get('/api/picks');
const ell = leg(d, 'Keon Ellis');
console.log(`  ${legsOf(d).filter((x) => x.sport === 'nba').map((x) => `${x.title} ${JSON.stringify(x.inj || null)}`).join(' | ')}`);
ok(!leg(d, "Day'Ron Sharpe"), 'Sharpe, out: off the list and the pool');
ok(ell && ell.inj && ell.inj.status === 'GTD' && ell.inj.what === 'back soreness' && !ell.inj.out && (d.ppPool || []).some((x) => x.legId === ell.legId),
  "Ellis's rebounds take the game's place, flagged GTD (back soreness)");

// On the NBA tab: Toppin as ESPN really had him, unlike the two copies above.
const npd = await get('/api/nba-pp');
const tTop = npLeg(npd, 'Obi Toppin', 'reb'), tSh = npLeg(npd, "Day'Ron Sharpe", 'reb'), tNem = npLeg(npd, 'Andrew Nembhard', 'ast');
console.log(`  ${JSON.stringify(tTop && tTop.inj)} | ${JSON.stringify(tSh && tSh.inj)} | ${JSON.stringify(tNem && tNem.inj)}`);
ok(tTop && tTop.inj.status === 'GTD' && tTop.inj.what === 'back soreness' && !tTop.inj.out, 'the NBA tab: Obi Toppin GTD (back soreness)');
ok(tSh && tSh.inj.out === true && tSh.inj.what === 'rest', 'Sharpe, out: still on the tab, unlike Picks, and says so');
ok(tNem && tNem.inj.status === null, 'Nembhard: read, and not on the report');

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
const t1 = IT(ell), t2 = IT(sh), t3 = IT({ sport: 'nba', spec: { sport: 'nba', playerId: '1' } }), t4 = IT({ sport: 'nhl', spec: {} });
ok(t1.warn && t1.text === 'GTD: back soreness' && t1.title === "ESPN's injury report, read 12 min ago", `Ellis: "${t1.text}" (${t1.title})`);
ok(!t2.warn && t2.text === 'no injury listed', `Sharpe at noon: "${t2.text}"`);
ok(t3.warn && t3.text === 'check injuries' && t4 === null, 'a game not read yet keeps "check injuries"; an NHL leg, nothing');
const t5 = IT(ml);
ok(t5.warn && JSON.stringify(t5.parts) === JSON.stringify(['Clippers out: Niederhauser, Strus, Ingram +2', 'Warriors out: Green, Curry, Porzingis +1', 'Warriors GTD: Santos'])
  && /Curry \(rest\)/.test(t5.title) && /Moody \(knee surgery\)/.test(t5.title), `the moneyline row: ${(t5.parts || []).join(' | ')}`);
const t6 = IT({ sport: 'nba', spec: { sport: 'nba', market: 'ml' }, inj: { teams: [{ team: 'Nets', out: [], gtd: [] }, { team: 'Pacers', out: [], gtd: [] }], at: ml.inj.at } });
ok(!t6.warn && t6.text === 'no injuries listed', 'neither side listed: "no injuries listed"');
// The NBA tab's rows: a listed player only.
const cardAt = app.indexOf('  function nbaCardInjTag(');
const CT = new Function('esc', 'injuryTag', app.slice(cardAt, app.indexOf('\n  }\n', cardAt) + 4) + '\nreturn nbaCardInjTag;')((s) => String(s), IT);
const flagged = CT(tTop);
console.log(`  ${flagged}`);
// A moneyline's tag can run long (Nov 4: "Timberwolves out: Shannon Jr., Edwards, DiVincenzo",
// 295px in a 202px row), and held to one line it widened the whole page on a phone.
const waitCss = (fs.readFileSync(path.join(BOARD, 'style.css'), 'utf8').match(/\.tc-wait \{[^}]*\}/) || [''])[0];
ok(waitCss && !/nowrap/.test(waitCss) && /max-width:100%/.test(waitCss), 'a tag longer than its row wraps instead of widening the page');
ok(/class="tc-wait"/.test(flagged) && />GTD: back soreness</.test(flagged) && /ESPN's injury report, read /.test(flagged), 'the NBA tab flags Toppin, with when it was read');
ok(/>Out: rest</.test(CT(tSh)), 'and an out player reads Out');
ok(CT(tNem) === '' && CT({ player: 'x' }) === '', 'not listed or not read: no tag, on a tab of a few rows that would all carry one');
const cardFn = app.slice(app.indexOf('  function nbaPpCardHtml('), app.indexOf('  function nbaBlkMoreHtml('));
const moreFn = app.slice(app.indexOf('  function ppMoreListHtml('), app.indexOf('  function ppMoreLineHtml('));
ok(/soccerKick\(x\.commence\)\)\}\$\{nbaCardInjTag\(x\)\}\$\{same\}\$\{gap\}/.test(cardFn) && /soccerKick\(x\.commence\)\)\}\$\{nbaCardInjTag\(x\)\}\$\{same\}<\/span>/.test(moreFn), 'on the under rows and the blocks Overs');
ok(/const it = injuryTag\(x\);\n\s+if \(it\) notes\.push\(it\.text\);/.test(app) && /const it = injuryTag\(x\);\n\s+if \(it\) for \(const t of it\.parts \|\| \[it\.text\]\) tags\.push/.test(app) && !/'check injuries'\)/.test(app),
  "on the list's rows and the hero, where the fixed reminder was");

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
