// Sharp lines, Pinnacle first, and quarter-Kelly stakes (2026-10-27).
//
// The owner: "keep it as sharp betting -- Pinnacle where possible", and size
// by Kelly at a quarter. Pikkit's 2024 rankings: Pinnacle first or second on
// main markets in every sport ranked (Circa, not in The Odds API, the other);
// FanDuel first on NBA props; Pinnacle then FanDuel on NFL props. What has to
// hold:
//   - a moneyline's fair is Pinnacle's no-vig line when it quotes; without it
//     the median of the rest, BetOnline and LowVig counted once (one shop) --
//     so those two alone are no fair line at all
//   - each logged row keeps every book's no-vig chance of its pick
//   - NBA props count FanDuel among the sharp books; each leg keeps every
//     book's own line and no-vig under
//   - passing TDs: Pinnacle, then FanDuel, then two of the rest
//   - every Picks leg with a price carries its edge (EV at the best price)
//     and a quarter-Kelly stake, on a chance never above the stated one and
//     pulled toward its kind's record; with no edge, the price that would be
//     one. Every entry carries its EV at PrizePicks' payouts and its stake.
//
// Real data: production's NBA props read of Celtics at Pistons on Oct 20
// (tests/fixtures/odds-nba-pp-26b036ff-20261020.json, FanDuel and DraftKings
// both quoting), and the Oct 25 NFL logs for the list (gmpicks-nflptd-20261027,
// gmpicks-nfl-20261026). The moneyline and passing-TD quotes are written in
// the Odds API's shape, as tests/nba.mjs writes them. Real SQLite, the real
// worker.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
const worker = fs.readFileSync(BOARD + '/worker.js', 'utf8').replace(/\r\n/g, '\n');
const read = (f) => JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', f), 'utf8'));

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
const lift = (name, from) => {
  const fn = from.indexOf(`\nfunction ${name}(`);
  if (fn >= 0) {
    let depth = 0;
    for (let i = from.indexOf('{', fn); i < from.length; i++) { if (from[i] === '{') depth++; else if (from[i] === '}' && --depth === 0) return from.slice(fn + 1, i + 1); }
  }
  const at = from.search(new RegExp(`\\n(const|let) ${name} =`));
  if (at < 0) throw new Error('worker.js has no ' + name);
  let depth = 0;
  for (let i = at + 1; i < from.length; i++) {
    const c = from[i];
    if ('{(['.includes(c)) depth++; else if ('})]'.includes(c)) depth--;
    else if (c === ';' && depth === 0) return from.slice(at + 1, i + 1);
  }
  throw new Error('could not lift ' + name);
};
const names = ['amProb', 'shinDevig', 'round1', 'median', 'sharpFair', 'bookFairsJson', 'h2hGames', 'h2hEntries',
  'NFL_PASS_TD_LINE', 'NFL_PASS_TD_BASE', 'PTD_SHARP', 'PTD_EXEC', 'passTdEntries',
  'NBA_SHARP', 'NBA_PROP_SHARP', 'poissonCdf', 'negBinomCdf', 'normName', 'NFL_NAME_SUFFIX', 'nflBaseName', 'nbaBaseName',
  'NBA_NAME_ALIAS', 'NBA_ALIAS', 'nbaName', 'nhlName', 'nbaSharpUnder', 'DFS_BOOKS', 'bookUndersJson', 'NBA_DISP',
  'PP_POWER', 'PP_FLEX', 'KELLY_FRACTION', 'KELLY_PRIOR_N', 'PROP_STAKE_CAP', 'ENTRY_STAKE_CAP', 'capStake', 'decOf', 'amOfChance', 'kellyChance', 'legStake', 'entryStake'];
let W;
try {
  W = new Function(names.map((n) => lift(n, worker)).join('\n') + `\nreturn { ${names.join(', ')} };`)();
} catch (e) { console.log(`  FAIL  the pieces lift out of worker.js (${e.message})`); process.exit(1); }

// ---- moneylines: Pinnacle first ----------------------------------------------------------------
console.log('-- a moneyline\'s fair line --');
const NOW = Date.parse('2026-10-27T12:00:00Z');
const cfg = { sharp: ['pinnacle', 'lowvig', 'betonlineag', 'novig', 'prophetx'], exec: ['draftkings', 'fanduel'], horizon: 36 * 3600e3 };
const game = (id, quotes) => ({ id, commence_time: '2026-10-27T23:40:00Z', home_team: 'Boston Celtics', away_team: 'Brooklyn Nets',
  bookmakers: Object.entries(quotes).map(([key, [h, a]]) => ({ key, markets: [{ key: 'h2h', outcomes: [{ name: 'Boston Celtics', price: h }, { name: 'Brooklyn Nets', price: a }] }] })) });
const evs = [
  game('pin', { pinnacle: [-560, 420], novig: [-600, 480], betonlineag: [-650, 470], lowvig: [-640, 480], draftkings: [-575, 425], fanduel: [-600, 440] }),
  game('bol', { betonlineag: [-650, 470], lowvig: [-640, 480], draftkings: [-575, 425] }),
  game('pool', { betonlineag: [-650, 470], lowvig: [-640, 480], novig: [-600, 480], draftkings: [-575, 425] }),
];
const G = W.h2hGames(cfg, evs, 'reg', NOW);
const E = W.h2hEntries(cfg, evs, 'reg', NOW);
const gOf = (id) => G.find((g) => g.id === id) || {};
const pinFair = W.shinDevig(-560, 420) * 100;
ok(gOf('pin').fairSrc === 'pinnacle' && Math.abs(gOf('pin').homeFair - pinFair) < 0.06 && gOf('pin').sharpN === 4,
  `with Pinnacle quoting, its no-vig line is the fair (${gOf('pin').homeFair}% against ${pinFair.toFixed(1)}%), four sharp books counted`);
ok(gOf('bol').fairSrc === 'MKT' && !E.some((e) => e.game_id === 'bol'), 'BetOnline and LowVig alone are one shop: no fair line, nothing logged');
const poolFair = W.median([W.shinDevig(-650, 470), W.shinDevig(-600, 480)]) * 100;
ok(gOf('pool').fairSrc === 'sharp-pool' && Math.abs(gOf('pool').homeFair - poolFair) < 0.06,
  `without Pinnacle: BetOnline (LowVig set aside) and Novig, medianed (${gOf('pool').homeFair}%)`);
const ep = E.find((e) => e.game_id === 'pin');
const bf = ep && JSON.parse(ep.book_fairs);
ok(bf && Object.keys(bf).sort().join() === 'betonlineag,draftkings,fanduel,lowvig,novig,pinnacle' && bf.pinnacle === ep.win_prob,
  `the row keeps every book's no-vig chance of its pick, Pinnacle's the fair (${ep && ep.book_fairs})`);

// ---- NBA props: FanDuel counts ---------------------------------------------------------------------
console.log('\n-- NBA props, Celtics at Pistons, Oct 20 --');
const NBA = read('odds-nba-pp-26b036ff-20261020.json');
const name = W.nbaName('Derrick White');
const sh = W.nbaSharpUnder(NBA, 'player_threes', name, 2.5, W.NBA_DISP.threes);
console.log('  ' + JSON.stringify(sh));
ok(sh && sh.src === 'fanduel' && sh.n === 1 && Math.abs(sh.under - 50) < 1,
  `FanDuel's -113/-113 at 2.5 is the sharp chance at PrizePicks' 2.5: ${sh && sh.under}% (no other sharp book quoted)`);
const bu = JSON.parse(W.bookUndersJson(NBA, 'player_threes', name) || '{}');
ok(bu.fanduel && bu.fanduel[0] === 2.5 && bu.draftkings && !bu.prizepicks, `every book's own line and no-vig under: ${JSON.stringify(bu)}`);
// The NHL log keeps the same (2026-10-27): production's points and assists
// read of Utah at Seattle on Oct 22 (odds-nhl-pp-ec5f71ec-20261022.json).
const NHL = read('odds-nhl-pp-ec5f71ec-20261022.json').payload;
const mon = JSON.parse(W.bookUndersJson(NHL, 'player_assists', W.nhlName('Brandon Montour'), W.nhlName) || '{}');
ok(mon.pinnacle && mon.pinnacle[0] === 0.5 && Math.abs(mon.pinnacle[1] - W.shinDevig(-248, 180) * 100) < 0.06 && mon.novig && mon.prophetx && mon.draftkings
  && !mon.prizepicks && !mon.underdog && !mon.pick6, `an NHL leg: every priced book's line and no-vig under, Pinnacle's ${mon.pinnacle && mon.pinnacle[1]}% (${Object.keys(mon).join(', ')})`);
const nhlSrc = worker.slice(worker.indexOf('\nfunction nhlPpLegs('), worker.indexOf('\nasync function logNhlPp('));
ok(/book_unders: bookUndersJson\(ev, m\.key, name, nhlName\)/.test(nhlSrc) && /book_unders\)\s*\n\s*VALUES/.test(worker.slice(worker.indexOf('\nasync function logNhlPp(')))
  && /book_unders=COALESCE\(\?, book_unders\)/.test(worker.slice(worker.indexOf('\nasync function logNhlPp('), worker.indexOf('\nasync function logNhlPp(') + 2500)),
  'and the NHL read writes it, at the first read and refreshed at the pre-tip one');

// ---- passing TDs: Pinnacle, then FanDuel ---------------------------------------------------------------
console.log('\n-- passing TDs --');
const row = (player, book, over, under) => ({ market: 'player_pass_tds', point: 1.5, event_id: 'ev1', player, commence: '2026-11-01T18:00:00Z', home: 'A', away: 'B', book, over, under });
const ptd = W.passTdEntries([
  row('Pin QB', 'pinnacle', 150, -180), row('Pin QB', 'fanduel', 160, -200), row('Pin QB', 'betonlineag', 155, -185), row('Pin QB', 'draftkings', 165, -205),
  row('FD QB', 'fanduel', 140, -170), row('FD QB', 'betonlineag', 145, -175), row('FD QB', 'novig', 150, -160), row('FD QB', 'draftkings', 150, -190),
  row('Pool QB', 'betonlineag', 145, -175), row('Pool QB', 'novig', 150, -160), row('Pool QB', 'draftkings', 150, -190),
], 9, 'REG');
const qb = (n) => ptd.find((e) => e.pick.startsWith(n)) || {};
ok(qb('Pin QB').fair_src === 'pinnacle' && qb('FD QB').fair_src === 'fanduel' && qb('Pool QB').fair_src === 'sharp-pool',
  `Pinnacle, then FanDuel, then the pool (${qb('Pin QB').fair_src}, ${qb('FD QB').fair_src}, ${qb('Pool QB').fair_src})`);
ok(Math.abs(qb('FD QB').win_prob - (1 - W.shinDevig(140, -170)) * 100) < 0.06 && JSON.parse(qb('FD QB').book_fairs).novig != null,
  `FanDuel's no-vig under is the fair when Pinnacle is missing (${qb('FD QB').win_prob}%), every book kept`);

// ---- Kelly ---------------------------------------------------------------------------------------------
console.log('\n-- edge and stake --');
const s110 = W.legStake(50, 110, null);
ok(s110.ev === 5 && s110.stake === 1.1 && s110.betAt === -100, `+110 on a 50% chance: edge +${s110.ev}%, a quarter of 4.5% is ${s110.stake}% (break-even ${s110.betAt})`);
const s300 = W.legStake(78, -300, null);
ok(s300.ev === 4 && s300.stake === 3, `-300 on 78%: edge +${s300.ev}%, quarter Kelly ${s300.stake}% -- a short price stakes more for the same edge`);
const sCel = W.legStake(84, -575, null);
ok(sCel.ev === -1.4 && sCel.stake === 0 && sCel.betAt === -525, `the Celtics at -575 on 84%: ${sCel.ev}%, no stake, a bet at ${sCel.betAt} or better`);
ok(W.kellyChance(72, { n: 15, hit: 9 }) === Math.min(72, (900 + 20 * 72) / 35) && Math.abs(W.kellyChance(67, { n: 7, hit: 3 }) - 60.74) < 0.01 && W.kellyChance(64, { n: 37, hit: 26 }) === 64,
  'the chance is pulled toward its kind (72% on 9 of 15 -> 66.9%; 67% on 3 of 7 -> 60.7%), and never above the stated one (64% on 26 of 37 stays 64%)');
const pw = W.entryStake([0.7, 0.7], 'power');
// A quarter of Kelly's 23.5% is 5.9%; since 2026-10-27 an entry stakes at most
// 2% (ENTRY_STAKE_CAP), whatever Kelly says.
ok(pw.ev === 47 && pw.stake === 2 && pw.capped === true, `a 2-pick Power at 70% a leg: +${pw.ev}% at 3x; Kelly (2 x 0.49 - 0.51) / 2 = 23.5%, a quarter 5.9%, held to ${pw.stake}%`);
const fx = W.entryStake([0.8, 0.8, 0.8], 'flex');
let best = 0, bestG = -1;
const dist = [0.008, 0.096, 0.384, 0.512], pay = [0, 0, 1.25, 2.25];
for (let f = 0; f < 1; f += 0.0005) { const g = dist.reduce((s, v, k) => s + v * Math.log(1 + f * (pay[k] - 1)), 0); if (g > bestG) { bestG = g; best = f; } }
ok(fx.ev === 63.2 && best * 25 > 2 && fx.stake === 2 && fx.capped === true,
  `a 3-pick Flex at 80%: +${fx.ev}%, the growth-maximising stake ${(best * 100).toFixed(1)}%, a quarter ${(best * 25).toFixed(1)}%, held to ${fx.stake}%`);
const small = W.entryStake([0.6, 0.6, 0.6], 'flex');
ok(small.stake > 0 && small.stake < 2 && !small.capped, `under the cap, the quarter-Kelly stake itself (3-pick Flex at 60%: ${small.ev}%, ${small.stake}%)`);
ok(W.legStake(64, -150, null, 1).stake === 1 && W.legStake(64, -150, null, 1).capped === true && W.legStake(64, -150, null).stake > 1,
  `a prop at a price stakes at most 1% (64% at -150: ${W.legStake(64, -150, null).stake}% uncapped)`);
ok(W.entryStake([0.55, 0.55], 'power').stake === 0, 'a Power at 55% a leg (needs 57.7%): no stake');

// ---- on the list ---------------------------------------------------------------------------------------
console.log('\n-- Picks of the day, 6 AM Sunday Oct 25 --');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const RealDate = Date;
const CLOCK = RealDate.parse('2026-10-25T13:00:00Z');
globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [CLOCK])); } static now() { return CLOCK; } };
globalThis.fetch = async () => new Response('{}', { status: 404 });
const sq = new DatabaseSync(':memory:');
const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
const exec = (sql, args, mode) => { const st = sq.prepare(sql); const a = args.map(norm);
  if (mode === 'all') return { results: st.all(...a), meta: {} }; if (mode === 'first') return st.get(...a) || null;
  return { success: true, meta: { changes: Number(st.run(...a).changes) } }; };
const DB = { prepare: (sql) => { const s = { sql, args: [], bind: (...x) => { s.args = x; return s; },
  all: async () => exec(s.sql, s.args, 'all'), first: async (c) => { const r = exec(s.sql, s.args, 'first'); return c && r ? r[c] : r; },
  run: async () => exec(s.sql, s.args, 'run') }; return s; }, batch: async (sts) => sts.map((x) => exec(x.sql, x.args, 'run')) };
const env = { DB };
const mod = await import('data:text/javascript;base64,' + Buffer.from(worker).toString('base64'));
const get = async (u) => (await mod.default.fetch(new Request('https://x' + u), env, { waitUntil: () => {} })).json();
await get('/api/gmpicks-export'); await get('/api/picks');
for (const rows of [read('gmpicks-nflptd-20261027.json').rows, read('gmpicks-nfl-20261026.json').rows]) {
  const cols = Object.keys(rows[0]);
  const ins = sq.prepare(`INSERT OR IGNORE INTO gmpicks (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
  for (const r of rows) ins.run(...cols.map((k) => r[k]));
}
sq.prepare("UPDATE gmpicks SET result = NULL WHERE date = '2026-10-25' AND sport IN ('nfl', 'nflptd')").run();
const p = await get('/api/picks');
for (const l of p.legs) console.log(`  ${l.title} ${l.p}% at ${l.odds}: Kelly chance ${l.kellyP}%, edge ${l.ev}%, stake ${l.stake}%, bet at ${l.betAt}`);
const hou = p.legs.find((l) => l.title === 'HOU ML');
const want = W.legStake(hou.p, hou.odds, p.kinds.nfl_ml.record);
ok(hou && hou.ev === want.ev && hou.stake === 0 && hou.betAt === want.betAt && hou.ev < 0,
  `the Texans at ${hou.odds} on ${hou.p}%: no edge (${hou.ev}%), a bet at ${hou.betAt} or better`);
ok(p.legs.every((l) => typeof l.ev === 'number' && typeof l.stake === 'number' && typeof l.betAt === 'number' && l.kellyP <= l.p),
  'every leg on the list carries its edge, stake and break-even price, on a chance never above its own');
ok(p.entries.length && p.entries.every((e) => typeof e.ev === 'number' && typeof e.stake === 'number'),
  `every entry its EV and stake: ${p.entries.map((e) => `${e.entry} ${e.ev}%/${e.stake}%`).join(', ')}`);

// ---- the page ------------------------------------------------------------------------------------------
const app = fs.readFileSync(BOARD + '/app.js', 'utf8').replace(/\r\n/g, '\n');
const at = app.indexOf('function pickEdgeHtml(');
let d = 0, body = '';
for (let i = app.indexOf('{', at); i < app.length; i++) { if (app[i] === '{') d++; else if (app[i] === '}' && --d === 0) { body = app.slice(at, i + 1); break; } }
const AM = (o) => (o > 0 ? '+' + o : String(o));
const pct0 = (v) => `${Math.round(v)}%`;
// A stake reads in dollars once a bankroll is set (2026-10-28,
// tests/edgebets.mjs); none here, so as a share.
const stakeTxt = (v) => `${v}%`;
const edge = new Function('esc', 'AM', 'pct0', 'stakeTxt', body + '\nreturn pickEdgeHtml;')((s) => String(s), AM, pct0, stakeTxt);
const txt = (h) => h.replace(/<[^>]+>/g, '');
// Every priced leg: its fair price and EV beside the best price; the stake
// when it has an edge, the price to beat when it does not.
ok(txt(edge({ odds: 110, ...s110 })) === ' · fair -100 · EV +5% · ¼ Kelly 1.1%' && txt(edge({ odds: -575, ...sCel })) === ' · fair -525 · EV -1.4% · bet at -525 or better',
  `the leg's line: "${txt(edge({ odds: 110, ...s110 }))}", "${txt(edge({ odds: -575, ...sCel }))}"`);

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
