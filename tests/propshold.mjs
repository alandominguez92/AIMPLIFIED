// Prices no one could bet, off the props cards (2026-11-20).
//
// The owner, on the NBA card's "Strongest": Walker Kessler's points + assists Under 14.5 at 70%
// with his projection 16.1 over the line. The 70% was ProphetX's 14.5, Over -136 / Under -25000:
// a pair 57% over an even book, de-vigged as if it were a price, while FanDuel and Novig had 15.5
// at about 55% Under. Off the books' main line only the exchanges quote PrizePicks' number, and
// the card let one of them decide. Pinnacle, FanDuel and BetOnline never held more than 9% on
// that day's NBA, NHL or NFL reads. What has to hold:
//   - a two-way pair holding more than 10% (or both sides paying) is dropped from the card's read,
//     both sides, before anything is de-vigged; every sportsbook price stays
//   - Kessler's 14.5 then has no figure (no real price there), half of a point off FanDuel's
//     main line, and his ladder keeps 15.5 and loses 14.5
//   - a row whose prices were all real reads as it did: Doncic's points, Pinnacle first
//   - NFL's card, read from the capture, is cleaned the same way
//   - ?raw=1 still shows the read as it came; the backtest's reading of a payload is unchanged
//
// Real data: the card's last reads as production kept them (?raw=1), Kings @ Lakers Nov 20,
// Golden Knights @ Stars Nov 19, and the NFL capture of Nov 19.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOARD = path.join(HERE, '..');
const fx = (f) => JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', f), 'utf8'));
const NBA = fx('nba-props-raw-20261120.json'), NHL = fx('nhl-props-raw-20261119.json'), NFL = fx('nfl-props-raw-20261119.json');

globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const TIP = Date.parse(NBA.body.commence_time);           // 7:10 PM Pacific, Nov 20
const DAY = '2026-11-20';
let NOW = TIP - 3.9 * 3600e3;
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
};

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

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
const env = { DB, ODDS_API_KEY: 'k', ASSETS: { fetch: async () => new Response('{}', { status: 404 }) } };

const GAME = NBA.game;
const reads = [];
globalThis.fetch = async (u) => {
  const url = String(u);
  if (/the-odds-api\.com\/v4\/sports\/basketball_nba\/events\?/.test(url)) {
    return new Response(JSON.stringify([{ id: GAME, sport_key: 'basketball_nba', commence_time: NBA.body.commence_time, home_team: NBA.body.home_team, away_team: NBA.body.away_team }]), { status: 200 });
  }
  if (/the-odds-api\.com\/v4\/sports\/basketball_nba\/events\/.+\/odds/.test(url)) {
    reads.push(url);
    return new Response(JSON.stringify(NBA.body), { status: 200, headers: { 'x-requests-last': '5', 'x-requests-remaining': '59000' } });
  }
  if (/the-odds-api\.com\/v4\/sports\/[a-z_]+\/events\?/.test(url)) return new Response('[]', { status: 200 });
  return new Response('{}', { status: 404 });
};

const src = fs.readFileSync(path.join(BOARD, 'worker.js'), 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const res = (u, init) => mod.default.fetch(new Request('https://x' + u, init), env, { waitUntil: () => {} });
const hit = async (u) => (await res(u)).json();
const tick = async (cron = '1-59/2 * * * *') => {
  const held = [];
  await mod.default.scheduled({ cron }, env, { waitUntil: (p) => held.push(p) });
  await Promise.allSettled(held);
};
const lf = src.replace(/\r\n/g, '\n');
const fnOf = (name) => { const at = lf.indexOf(`function ${name}(`); return lf.slice(at, lf.indexOf('\n}\n', at) + 2); };
const shin = new Function(`${fnOf('amProb')}\n${fnOf('shinDevig')}\nreturn shinDevig;`)();
const imp = (p) => (p < 0 ? -p / (-p + 100) : 100 / (p + 100));
const row = (sport, player, market) => sq.prepare('SELECT * FROM pp_props WHERE sport = ? AND player = ? AND market = ?').get(sport, player, market);
const save = (k, data) => sq.prepare('INSERT OR REPLACE INTO feed_cache (key, data, updated_at, claimed_until) VALUES (?,?,?,0)').run(k, JSON.stringify(data), NOW);

// The price a book had on a player at a number, from the recorded payload.
const quote = (body, book, market, who, point) => {
  const b = body.bookmakers.find((x) => x.key === book), m = b && b.markets.find((x) => x.key === market);
  const mine = m ? m.outcomes.filter((o) => o.description === who && o.point === point) : [];
  const o = mine.find((x) => x.name === 'Over'), u = mine.find((x) => x.name === 'Under');
  return o && u ? { over: o.price, under: u.price, hold: imp(o.price) + imp(u.price) - 1 } : null;
};

console.log('\n-- what was in the read --');
const kx = quote(NBA.body, 'prophetx', 'player_points_assists', 'Walker Kessler', 14.5);
ok(kx && kx.over === -136 && kx.under === -25000 && kx.hold > 0.5, `ProphetX had Kessler's 14.5 at ${kx && kx.over} / ${kx && kx.under}, ${kx && Math.round(kx.hold * 100)}% over an even book`);
const kf = quote(NBA.body, 'fanduel', 'player_points_assists', 'Walker Kessler', 15.5);
ok(kf && Math.round(shin(kf.under, kf.over) * 100) === 53, `FanDuel had him at 15.5, Under ${kf && Math.round(shin(kf.under, kf.over) * 1000) / 10}%`);
const holds = {};
for (const body of [NBA.body, NHL.body, NFL.body]) for (const b of body.bookmakers) for (const m of b.markets) {
  const by = {};
  for (const o of m.outcomes) (by[`${o.description}|${o.point}`] = by[`${o.description}|${o.point}`] || {})[o.name] = o.price;
  for (const s of Object.values(by)) if (s.Over != null && s.Under != null) (holds[b.key] = holds[b.key] || []).push(imp(s.Over) + imp(s.Under) - 1);
}
const most = (bk) => Math.max(...holds[bk]);
ok(['pinnacle', 'fanduel', 'betonlineag'].every((bk) => most(bk) < 0.09), `the sportsbooks' widest pairs: ${['pinnacle', 'fanduel', 'betonlineag'].map((bk) => `${bk} ${(most(bk) * 100).toFixed(1)}%`).join(', ')}`);
ok(holds.novig.filter((h) => h > 0.1).length > 20 && holds.prophetx.filter((h) => h > 0.1).length > 50,
  `the exchanges' pairs over 10%: Novig ${holds.novig.filter((h) => h > 0.1).length}, ProphetX ${holds.prophetx.filter((h) => h > 0.1).length}`);

console.log('\n-- the NBA card\'s read --');
await hit('/api/nba-props');
save('nba_pp_games', { [GAME]: { commence: NBA.body.commence_time, first: NOW - 3600e3 } });
await tick();
ok(reads.length === 1, `one read (${reads.length})`);
const kess = row('nba', 'Walker Kessler', 'pts_ast');
ok(kess && kess.read_point === 14.5, `Kessler's points + assists at PrizePicks' 14.5 (${kess && kess.read_point})`);
ok(kess && kess.read_sharp == null, `no figure: nothing real was quoted at 14.5 (was 70%; now ${kess && kess.read_sharp})`);
ok(kess && kess.gap === -1, `a point under FanDuel's main line (gap ${kess && kess.gap})`);
const kl = JSON.parse((kess && kess.fairs) || '[]');
ok(kl.some((f) => f[0] === 15.5) && !kl.some((f) => f[0] === 14.5) && !kl.some((f) => f[0] === 24.5),
  `his ladder keeps 15.5 and loses 14.5 and Novig's 24.5 at -99900: ${JSON.stringify(kl)}`);
const luka = row('nba', 'Luka Doncic', 'pts');
const lp = quote(NBA.body, 'pinnacle', 'player_points', 'Luka Doncic', 36.5);
ok(luka && luka.read_point === 36.5 && luka.read_sharp === Math.round(shin(lp.under, lp.over) * 1000) / 10 && luka.sharp_src === 'pinnacle',
  `Doncic's points: Pinnacle's own 36.5 as before (${luka && luka.read_sharp}, ${luka && luka.sharp_src})`);
const ll = JSON.parse((luka && luka.fairs) || '[]');
ok(ll.some((f) => f[0] === 34.5) && !ll.some((f) => f[0] === 27.5), `his ladder keeps Novig's 34.5 (a 2.6% pair) and loses ProphetX's 27.5 at -800 / -25000: ${ll.map((f) => f[0]).join(' ')}`);
// Every ladder now runs one way: the Under can't be less likely at a higher number.
const all = sq.prepare("SELECT player, market, fairs FROM pp_props WHERE sport = 'nba' AND fairs IS NOT NULL").all();
const bent = all.filter((r) => { const f = JSON.parse(r.fairs); return f.some((x, i) => i && x[1] < f[i - 1][1] - 1); });
ok(bent.length <= 2, `ladders that dip as the line rises: ${bent.length} of ${all.length}${bent.length ? ` (${bent.map((r) => `${r.player} ${r.market}`).join(', ')})` : ''}`);
const strong = sq.prepare("SELECT player, market, read_sharp FROM pp_props WHERE sport = 'nba' AND read_sharp IS NOT NULL AND (read_sharp >= 60 OR read_sharp <= 40)").all();
ok(!strong.length, `no figure at 60%+ either side in this game (${strong.map((r) => `${r.player} ${r.market} ${r.read_sharp}`).join(', ') || 'none'})`);

console.log('\n-- as it came, and the backtest\'s reading --');
const raw = await hit('/api/nba-props?raw=1');
ok(JSON.stringify(raw.body).includes('-25000'), '?raw=1 still shows the read as it came');
ok(!/ppPropClean/.test(fnOf('histPropLegs')) && !/ppPropClean/.test(fnOf('histPropRead')), 'the backtest\'s and the held logs\' reading is untouched');

console.log('\n-- the NFL card, from the capture --');
const NFL_T = NOW + 20 * 3600e3;
save(`nfl_props_raw:${NFL.game}`, { id: NFL.game, home: 'Home', away: 'Away', commence: new RealDate(NFL_T).toISOString(), at: NOW, body: NFL.body });
await tick();
const nfl = sq.prepare("SELECT player, market, read_point, read_sharp, fairs FROM pp_props WHERE sport = 'nfl'").all();
ok(nfl.length > 0, `${nfl.length} NFL rows logged`);
const nflOver = nfl.filter((r) => JSON.parse(r.fairs || '[]').some((f) => {
  for (const b of NFL.body.bookmakers) for (const m of b.markets) {
    const mine = m.outcomes.filter((o) => o.description === r.player && o.point === f[0]);
    const o = mine.find((x) => x.name === 'Over'), u = mine.find((x) => x.name === 'Under');
    if (o && u && imp(o.price) + imp(u.price) - 1 <= 0.1) return false;
  }
  return true;
}));
ok(!nflOver.length, `every NFL rung has a real price behind it (${nflOver.length ? nflOver.map((r) => r.player).join(', ') : 'all do'})`);

console.log(fail ? `\n${fail} FAILED` : '\nall ok');
process.exit(fail ? 1 : 0);
