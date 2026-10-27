// The sharp books' chance of a PrizePicks under, and his season against the
// line (2026-10-25).
//
// Every +EV pick'em guide prices a leg the same way: a sharp book's two-way
// price on the same player line, de-vigged, against the entry's break-even.
// This site's moneylines are priced that way and went 12 of 13 in the NBA by
// Oct 25, while its own box-score prop model ran about 52% at PrizePicks'
// lines. So the NBA read now asks the sharp books too (Pinnacle, LowVig,
// BetOnline, Novig, ProphetX: ten books, still one region), and each leg
// carries the sharp chance of the under at PrizePicks' number beside the
// model's, plus his games this season against the line. What has to hold:
//   - one sharp book at PrizePicks' number: its de-vigged under, unchanged
//   - a book a line away: its price fixes the projection it is pricing, and
//     the projection prices PrizePicks' line (a higher line, a likelier under)
//   - several books: the median; none: nothing, never a guess
//   - the leg, the card, the record by sharp band and Picks of the day carry it
//
// The prices are real: Pinnacle, Novig and ProphetX on Mammoth @ Kraken points,
// Oct 22 (tests/fixtures/odds-nhl-pp-ec5f71ec-20261022.json) -- the recorded
// read with sharp books on a player prop -- and the Hawks @ Rockets NBA read of
// Oct 25 for the pipeline (odds-nba-pp-b57695c1-20261025.json). Real SQLite,
// the real worker.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const read = (f) => JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', f), 'utf8'));
const UTA = read('odds-nhl-pp-ec5f71ec-20261022.json').payload, HOU = read('odds-nba-pp-b57695c1-20261025.json');
const worker = fs.readFileSync(BOARD + '/worker.js', 'utf8').replace(/\r\n/g, '\n');

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

// ---- the price, lifted out of worker.js -----------------------------------------------------
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
const names = ['NBA_SHARP', 'NBA_PROP_SHARP', 'amProb', 'shinDevig', 'poissonCdf', 'negBinomCdf', 'round1', 'normName', 'NFL_NAME_SUFFIX', 'nflBaseName', 'nbaBaseName',
  'NBA_NAME_ALIAS', 'NBA_ALIAS', 'nbaName', 'nbaSharpUnder'];
const F = new Function(names.map((n) => lift(n, worker)).join('\n') + '\nreturn { nbaSharpUnder, shinDevig };')();

console.log('-- Vincent Trocheck, points, Oct 22 --');
const quote = (bk, who) => { const m = UTA.bookmakers.find((b) => b.key === bk).markets.find((x) => x.key === 'player_points');
  const o = (side) => m.outcomes.find((x) => x.description === who && x.name === side); return { over: o('Over'), under: o('Under') }; };
const fairOf = (bk, who) => { const q = quote(bk, who); return F.shinDevig(q.under.price, q.over.price); };
const books = ['pinnacle', 'novig', 'prophetx'];
const fairs = books.map((b) => fairOf(b, 'Vincent Trocheck')).sort((a, b) => a - b);
console.log('  de-vigged unders at 0.5: ' + books.map((b) => `${b} ${(fairOf(b, 'Vincent Trocheck') * 100).toFixed(1)}%`).join(', '));
const at05 = F.nbaSharpUnder(UTA, 'player_points', 'vincent trocheck', 0.5, 1);
ok(at05 && at05.n === 3 && at05.src === 'pinnacle,novig,prophetx' && Math.abs(at05.under - fairs[1] * 100) < 0.11,
  `at PrizePicks' 0.5, the books' own number: the median of their de-vigged unders, ${at05 && at05.under}% from ${at05 && at05.src}`);
const pin = fairOf('pinnacle', 'Vincent Trocheck');
ok(Math.abs(pin - 0.4925) < 0.005, `Pinnacle alone, -117/-113, is ${(pin * 100).toFixed(1)}% under: the vig taken out, not the -113's 53%`);
const at15 = F.nbaSharpUnder(UTA, 'player_points', 'vincent trocheck', 1.5, 1);
ok(at15 && at15.under > at05.under + 20 && at15.under < 100, `at a line of 1.5, the same prices put the under at ${at15 && at15.under}%: the projection they price, read at the higher line`);
ok(F.nbaSharpUnder(UTA, 'player_points', 'somebody else', 0.5, 1) === null && F.nbaSharpUnder(UTA, 'player_rebounds', 'vincent trocheck', 0.5, 1) === null,
  'no sharp book on the player, or on the market: nothing, never a guess');

// ---- the NBA pipeline --------------------------------------------------------------------------
console.log('\n-- the NBA read, the log and the card --');
const RealDate = Date;
let NOW = RealDate.parse(HOU.commence_time) - 45 * 60e3;
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
};
const READ_URL = `https://api.the-odds-api.com/v4/sports/basketball_nba/events/${HOU.id}/odds?apiKey=k`
  + '&markets=player_threes,player_assists,player_rebounds,player_blocks,player_steals&oddsFormat=american&dateFormat=iso'
  + '&bookmakers=prizepicks,underdog,pick6,draftkings,fanduel,pinnacle,lowvig,betonlineag,novig,prophetx';
const asked = [];
globalThis.fetch = async (u) => {
  const url = String(u);
  asked.push(url);
  const J = (x) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json', 'x-requests-last': '5', 'x-requests-remaining': '86000' } });
  if (url === READ_URL) return J(HOU);
  if (url.startsWith('https://api.the-odds-api.com/')) return J([]);
  if (url.includes('statsapi.mlb.com')) return J({ dates: [] });
  return new Response('{}', { status: 404 });
};
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
const PRIORS = fs.readFileSync(path.join(BOARD, 'nba-priors.json'), 'utf8');
const priors = JSON.parse(PRIORS).players;
const env = { DB, ODDS_API_KEY: 'k', ASSETS: { fetch: async (r) => (new URL(r.url).pathname === '/nba-priors.json'
  ? new Response(PRIORS, { status: 200, headers: { 'content-type': 'application/json' } }) : new Response('{}', { status: 404 })) } };
const mod = await import('data:text/javascript;base64,' + Buffer.from(fs.readFileSync(BOARD + '/worker.js', 'utf8')).toString('base64'));
const get = async (u) => (await mod.default.fetch(new Request('https://x' + u), env, { waitUntil: () => {} })).json();
const tick = async () => { const held = []; await mod.default.scheduled({}, env, { waitUntil: (p) => held.push(p) }); await Promise.allSettled(held); };

await tick();                                                   // tables made
// Jalen Johnson's four games this season, as the box-score ingest keeps them.
const [jjId] = Object.entries(priors).find(([, p]) => p.n === 'Jalen Johnson');
const box = sq.prepare(`INSERT INTO nba_box (game_id, date, season_type, player_id, player, team, min, threes, ast, reb, blk, stl, starter, dnp)
  VALUES (?, ?, 2, ?, 'Jalen Johnson', 'ATL', 34, 1, ?, 9, 0, 1, 1, 0)`);
[['r1', '2026-10-20', 8], ['r2', '2026-10-21', 5], ['r3', '2026-10-23', 6], ['r4', '2026-10-24', 9]].forEach(([g, d, a]) => box.run(g, d, jjId, a));
sq.prepare('INSERT OR REPLACE INTO feed_cache (key, data, updated_at) VALUES (?, ?, ?)').run('nba_board:reg',
  JSON.stringify({ asOf: new RealDate(NOW).toISOString(), games: [{ id: HOU.id, league: 'reg', commence: HOU.commence_time, home: HOU.home_team, away: HOU.away_team }] }), NOW);
await tick();
ok(asked.includes(READ_URL), 'the read asks the five sharp books with the others: ten books, one region');
const jj = sq.prepare("SELECT point, l10_n, l10_under, sharp_under, sharp_n FROM nbapp WHERE game_id = ? AND player = 'Jalen Johnson' AND market = 'ast'").get(HOU.id);
ok(jj && jj.point === 6.5 && jj.l10_n === 4 && jj.l10_under === 2, `Johnson under 6.5 assists: his season against it, under 2 of 4 (8, 5, 6, 9) (${jj && `${jj.l10_under} of ${jj.l10_n}`})`);
ok(jj && jj.sharp_under == null && jj.sharp_n == null, 'no sharp book quoted this game in the recorded read: no sharp chance logged');

// The card's third line and the record, as they read once the sharp books quote.
const app = fs.readFileSync(BOARD + '/app.js', 'utf8').replace(/\r\n/g, '\n');
const liftApp = (name) => {
  let at = app.indexOf(`function ${name}(`);
  const isConst = at < 0;
  if (isConst) at = app.indexOf(`const ${name} =`);
  let depth = 0;
  for (let i = at; i < app.length; i++) {
    const c = app[i];
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') { depth--; if (!isConst && c === '}' && depth === 0) return app.slice(at, i + 1); }
    else if (isConst && c === ';' && depth === 0 && app[i + 1] === '\n') return app.slice(at, i + 1);
  }
  throw new Error('could not lift ' + name);
};
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const P = new Function('esc', ['AM', 'sharpTag', 'ppBookLine'].map(liftApp).join('\n') + '\nreturn { sharpTag, ppBookLine };')(esc);
const text = (h) => h.replace(/<[^>]+>/g, '').trim();
const line = P.ppBookLine({ book_line: 6.5, book_under: -115, sharp_under: 59.4, sharp_src: 'pinnacle,novig', l10_n: 4, l10_under: 2 });
ok(text(line) === 'book u6.5 -115 · sharp 59% · season: under 2 of 4' && /class="tc-sharp up"/.test(line) && /Pinnacle, Novig/.test(line),
  `the card: "${text(line)}", the sharp chance coloured at a 2-pick power's 57.7% and naming its books`);
ok(/tc-sharp down/.test(P.sharpTag(48)) && !/ up| down/.test(P.sharpTag(55)) && P.sharpTag(null) === '' && P.ppBookLine({}) === '',
  'under 50% cautionary, in between plain, none: nothing');
ok(/\$\{ppBookLine\(x\)\}<\/span>`/.test(liftApp('nbaPpCardHtml')) && /tags\.push\(sharpTag\(x\.sharp, null, true\)\)/.test(app), 'on every NBA card leg, and as a tag on Picks of the day');

console.log('\n-- the record by the sharp chance --');
const g = sq.prepare(`INSERT INTO nbapp (date, game_id, player, market, point, model_under, min_proj, sharp_under, result)
  VALUES ('2026-10-24', 'evOLD', ?, 'ast', 4.5, 60, 30, ?, ?)`);
[['A', 61, 'under'], ['B', 59, 'under'], ['C', 58.5, 'over'], ['D', 55, 'under'], ['E', 52, 'over'], ['F', 45, 'over'], ['G', null, 'under']].forEach(([p, s, r]) => g.run(p, s, r));
const rec = (await get('/api/nba-pp')).record.sharp;
console.log('  ' + JSON.stringify(rec));
ok(rec && rec.n === 6 && rec.byBand['58+'].n === 3 && rec.byBand['58+'].hit === 2 && rec.byBand['54-58'].hit === 1 && rec.byBand['50-54'].n === 1 && rec.byBand['<50'].n === 1,
  "graded legs by the sharp chance at their first line, 58%+ first; a leg with none is left out");

console.log('\n-- Picks of the day --');
sq.prepare(`INSERT INTO nbapp (date, game_id, player, market, league, commence, home, away, team, player_id, point, proj, model_under, n_recent, min_proj,
  book_line, book_under, captured_at, close_point, close_under, close_book_line, close_book_under, close_at, sharp_under, close_sharp_under)
  VALUES (?, ?, 'Test Shooter', 'threes', 'reg', ?, ?, ?, 'HOU', '1', 1.5, 0.6, 80, 5, 30, 1.5, -130, ?, 1.5, 80, 1.5, -130, ?, 57, 61.2)`)
  .run(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new RealDate(HOU.commence_time)), HOU.id, HOU.commence_time, HOU.home_team, HOU.away_team,
    new RealDate(NOW).toISOString(), new RealDate(NOW).toISOString());
const leg = ((await get('/api/picks')).legs || []).find((x) => x.title === 'Test Shooter Under 1.5 3PM');
ok(leg && leg.sharp === 61.2, `a leg on the list carries the sharp chance at the line it shows, the pre-tip read's (${leg && leg.sharp})`);

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
