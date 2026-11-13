// Live Now follows the PrizePicks entry's legs (2026-11-12, the owner's "do both").
//
// Live Now followed the list's legs, the moneyline entry's, and each game's best three from the
// model. The PrizePicks entry, which came after it (Oct 28), was never wired in: on Nov 11 its six
// legs were Keller's and Carlsson's assists Mores and four rebounds Lesses, and with Jokic's and
// Zion's games in the 3rd, Live Now had three other Nuggets and Grizzlies on it and neither of
// them. Keller showed only because he was his game's best More, and unmarked. What has to hold:
//   - a leg in the entry at its start is followed and marked on Picks, though the model would not
//     have picked it out
//   - a More reads as one: the NBA's blocks More and the NHL's Mores are Overs, the box score's
//     number against the line
//   - the legs on Picks always make the nine a sport is cut to
//   - a leg that left the entry before its start is not followed for it
//
// Real payloads, recorded at 6:27 PM Pacific on Oct 23 with six NBA games and two NHL games under
// way, as tests/livesports.mjs uses them (espn-nba-live-20261023.json, nhl-live-20261023.json,
// nba-pp-board-20261023.json, odds-nhl-events-20261023.json). Real SQLite, the real worker.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
const FIX = path.join(BOARD, 'tests', 'fixtures');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const read = (f) => JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));
const NBA = read('espn-nba-live-20261023.json'), NHL = read('nhl-live-20261023.json');
const LEGS = read('nba-pp-board-20261023.json').legs;
const NHL_EV = read('odds-nhl-events-20261023.json').events;
const RealDate = Date;
const NOW = RealDate.parse(NBA.at);
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
};
globalThis.fetch = async (u) => {
  const url = String(u);
  const J = (x) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url === 'https://cdn.espn.com/core/nba/scoreboard?xhr=1&date=20261023') return J(NBA.scoreboard);
  const nb = url.match(/^https:\/\/cdn\.espn\.com\/core\/nba\/boxscore\?xhr=1&gameId=(\d+)$/);
  if (nb && NBA.boxes[nb[1]]) return J(NBA.boxes[nb[1]]);
  if (url === 'https://api-web.nhle.com/v1/score/2026-10-23') return J(NHL.score);
  const hb = url.match(/^https:\/\/api-web\.nhle\.com\/v1\/gamecenter\/(\d+)\/boxscore$/);
  if (hb && NHL.boxes[hb[1]]) return J(NHL.boxes[hb[1]]);
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
const env = { DB };
const src = fs.readFileSync(BOARD + '/worker.js', 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const get = async (u) => (await mod.default.fetch(new Request('https://x' + u), env, { waitUntil: () => {} })).json();

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

// ---- the logs, as they stood ------------------------------------------------------------------
await get('/api/picks'); await get('/api/nhl-pp');               // the tables
const ptDay = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new RealDate(iso));
const insNba = sq.prepare(`INSERT INTO nbapp (date, game_id, player, market, league, commence, home, away, team, player_id, point, proj, model_under, n_recent, min_proj, book_line, book_under, captured_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
for (const x of LEGS) {
  const [away, home] = x.game.split(' @ ');
  insNba.run(ptDay(x.commence), x.game_id, x.player, x.market, x.league, x.commence, home, away, x.team, x.player_id,
    x.point, x.proj, x.model_under, x.n_recent, x.min_proj, x.book_line, x.book_under, x.first_at);
}
const ev = (away) => NHL_EV.find((e) => e.away_team === away);
const MTL = ev('Montréal Canadiens'), TBL = ev('Tampa Bay Lightning');
const insNhl = sq.prepare(`INSERT INTO nhlpp (date, game_id, player, market, commence, home, away, team, player_id, point, model_under, toi_proj)
  VALUES ('2026-10-23', ?, ?, ?, ?, ?, ?, ?, ?, 0.5, ?, 17)`);
for (const [e, player, market, team, id, mu] of [
  [MTL, 'Roman Kantserov', 'pts', 'CHI', '8484390', 71.7], [MTL, 'Chris Kreider', 'pts', 'MTL', '8475184', 59.2],
  [MTL, 'Teuvo Teravainen', 'pts', 'CHI', '8476882', 54.3], [MTL, 'Tyler Bertuzzi', 'pts', 'CHI', '8477479', 53.8],
  [MTL, 'Connor Bedard', 'ast', 'CHI', '8484144', 51.8],
  [TBL, 'Martin Necas', 'ast', 'COL', '8480039', 51.4], [TBL, 'Nazem Kadri', 'pts', 'COL', '8475172', 50.5], [TBL, 'Brock Nelson', 'pts', 'COL', '8475754', 44.9],
]) insNhl.run(e.id, player, market, e.commence_time, e.home_team, e.away_team, team, id, mu);

// What the box scores say, read here straight from the recorded payloads.
const espnStat = (gid, pid, label) => {
  for (const t of NBA.boxes[gid].gamepackageJSON.boxscore.players) {
    const s = t.statistics[0], L = (s.labels || s.names).map((x) => x.toUpperCase());
    const a = s.athletes.find((x) => x.athlete.id === pid);
    if (a) return Number(String(a.stats[L.indexOf(label)]).split('-')[0]);
  }
  return null;
};
const nhlLine = (gid, pid) => { const p = NHL.boxes[gid].playerByGameStats; return [...p.awayTeam.forwards, ...p.awayTeam.defense, ...p.homeTeam.forwards, ...p.homeTeam.defense].find((x) => String(x.playerId) === pid); };

// The entry's legs, picked from the recording: in Mavericks @ Pacers (Q4 10:32), a rebounds Less
// for a rotation player outside the model's three best there, and Cooper Flagg's blocks More (42.2%
// to stay under, so 57.8% More); in Blackhawks @ Canadiens, Connor Bedard's assists More, 48.2%,
// under the 55% the NHL card lists Mores at.
const DAL = LEGS.find((x) => x.game === 'Dallas Mavericks @ Indiana Pacers');
const rot = LEGS.filter((x) => x.game_id === DAL.game_id && x.min_proj >= 20).sort((a, b) => b.model_under - a.model_under);
const top3 = [...new Set(rot.map((x) => x.player))].slice(0, 3);
const REB = rot.find((x) => x.market === 'reb' && !top3.includes(x.player) && x.player !== 'Cooper Flagg');
const FLAGG = LEGS.find((x) => x.game_id === DAL.game_id && x.player === 'Cooper Flagg' && x.market === 'blk');
const DAL_BOX = '401909844';

console.log(`-- before: ${REB.player}'s rebounds Less, Flagg's blocks More, Bedard's assists More, none yet in the entry --`);
const before = await get('/api/live-now');
console.log('  ' + before.filter((c) => c.kind !== 'ml').map((c) => `${c.name} ${c.side} ${c.stat}/${c.line} ${c.statLabel}${c.onPicks ? ' (Picks)' : ''}`).join(' | '));
ok(!before.some((c) => [REB.player, 'Cooper Flagg', 'Connor Bedard'].includes(c.name)),
  `the model's own picks leave all three out (Mavericks @ Pacers' three: ${top3.join(', ')})`);

// ---- the entry, as the list logs it at each start ------------------------------------------------
const pool = sq.prepare(`INSERT INTO daypicks (date, leg_id, kind, src_date, game_id, player_key, market, team, label, p, commence, on_list, in_pool, pool_p, pool_rank, seen_at)
  VALUES ('2026-10-23', ?, ?, '2026-10-23', ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?, '2026-10-23T22:14:00Z')`);
pool.run(`nbapp:${DAL.game_id}:${REB.player}:reb`, 'nba_reb_gap', DAL.game_id, REB.player, 'reb', REB.team, `${REB.player} Under ${REB.point} REB`, 56.1, DAL.commence, 56.1, 3);
pool.run(`nbapp:${DAL.game_id}:Cooper Flagg:blk:over`, 'nba_blk_more', DAL.game_id, 'Cooper Flagg', 'blk', 'DAL', `Cooper Flagg Over ${FLAGG.point} BLK`, 57.8, DAL.commence, 57.8, 2);
pool.run(`nhlpp:${MTL.id}:Connor Bedard:ast:over`, 'nhl_more', MTL.id, 'Connor Bedard', 'ast', 'CHI', 'Connor Bedard Over 0.5 AST', 48.2, MTL.commence_time, 48.2, 4);

console.log('\n-- with them in the PrizePicks entry --');
const cards = await get('/api/live-now');
const nba = cards.filter((c) => c.sport === 'nba' && c.kind !== 'ml'), nhl = cards.filter((c) => c.sport === 'nhl');
console.log('  NBA ' + nba.map((c) => `${c.name} ${c.side} ${c.stat}/${c.line} ${c.statLabel} ${c.state}${c.onPicks ? ' (Picks)' : ''}`).join(' | '));
console.log('  NHL ' + nhl.map((c) => `${c.name} ${c.side} ${c.stat}/${c.line} ${c.statLabel} ${c.state}${c.onPicks ? ' (Picks)' : ''}`).join(' | '));
const reb = nba.find((c) => c.name === REB.player);
const rebGot = espnStat(DAL_BOX, String(REB.player_id), 'REB');
ok(reb && reb.onPicks && reb.side === 'Under' && reb.statLabel === 'REB' && reb.line === REB.point && reb.stat === rebGot,
  `${REB.player}: on Picks, ${reb && reb.stat} rebounds against Under ${REB.point}, as the box score has it (${rebGot})`);
const fl = nba.find((c) => c.name === 'Cooper Flagg');
const flBlk = espnStat(DAL_BOX, String(FLAGG.player_id), 'BLK');
ok(fl && fl.onPicks && fl.side === 'Over' && fl.statLabel === 'BLK' && fl.line === FLAGG.point && fl.stat === flBlk,
  `Flagg's blocks More reads as an Over: ${fl && fl.side} ${fl && fl.line}, ${fl && fl.stat} blocks (box score ${flBlk})`);
ok(fl && (flBlk > FLAGG.point ? fl.state === 'cashing' : fl.state !== 'cashing'),
  `and read the way an Over is: ${fl && fl.state} with ${flBlk} and the 4th to play`);
const bed = nhl.find((c) => c.name === 'Connor Bedard');
const bedGame = Object.keys(NHL.boxes).find((k) => nhlLine(k, '8484144'));
const bedLine = bedGame && nhlLine(bedGame, '8484144');
ok(bed && bed.onPicks && bed.side === 'Over' && bed.statLabel === 'AST' && bed.stat === Number(bedLine && bedLine.assists),
  `Bedard: on Picks at 48.2%, ${bed && bed.stat} assists against Over 0.5, as the NHL's box has it (${bedLine && bedLine.assists})`);
ok(nhl.some((c) => c.name === 'Brock Nelson' && !c.onPicks), "the NHL card's own More still alongside, unmarked");
ok(nba.length === 9 && nba.filter((c) => c.onPicks).length === 2 && !nba.some((c) => c.name === 'Giannis Antetokounmpo'),
  `two of the nine are the entry's (${nba.filter((c) => c.onPicks).map((c) => c.name).join(', ')}); the model's ninth, Giannis, gives way`);

// ---- the nine ---------------------------------------------------------------------------------
// Nine Q4 legs held under their lines are enough to fill the nine; the entry's legs stay in
// whatever state they are in.
const crowd = sq.prepare(`INSERT INTO daypicks (date, leg_id, kind, src_date, game_id, player_key, market, team, label, p, commence, on_list, in_pool, pool_p, seen_at)
  VALUES ('2026-10-23', ?, 'nba_pp', '2026-10-23', ?, ?, ?, ?, ?, 60, ?, 0, 1, 60, '2026-10-23T22:14:00Z')`);
const ATL = LEGS.find((x) => x.game === 'Atlanta Hawks @ Charlotte Hornets');
const more = LEGS.filter((x) => x.game_id === ATL.game_id && x.min_proj >= 20)
  .filter((x, i, a) => a.findIndex((y) => y.player === x.player) === i).slice(0, 8);
for (const x of more) crowd.run(`nbapp:${x.game_id}:${x.player}:${x.market}`, x.game_id, x.player, x.market, x.team, `${x.player} Under ${x.point}`, x.commence);
const full = (await get('/api/live-now')).filter((c) => c.sport === 'nba' && c.kind !== 'ml');
const wanted = new Set([REB.player, 'Cooper Flagg', ...more.map((x) => x.player)]);
console.log(`  ${wanted.size} NBA legs on Picks: ${full.length} cards, ${full.filter((c) => c.onPicks).length} of them on Picks`);
ok(full.length === 9 && full.every((c) => c.onPicks), 'more legs on Picks than slots: the nine are all legs on Picks, none of the model\'s own');
sq.prepare("DELETE FROM daypicks WHERE kind = 'nba_pp'").run();

// ---- left before the start ---------------------------------------------------------------------
sq.prepare("UPDATE daypicks SET in_pool = 0 WHERE kind = 'nba_blk_more'").run();
const after = await get('/api/live-now');
ok(!after.some((c) => c.name === 'Cooper Flagg') && after.some((c) => c.name === REB.player && c.onPicks),
  "Flagg's More, out of the entry by his start, is not followed; the rest still are");

// ---- the page --------------------------------------------------------------------------------
const app = fs.readFileSync(BOARD + '/app.js', 'utf8');
ok(/c\.pos === 'P' \? 'P' : '', c\.onPicks \? 'on Picks' : ''\]/.test(app), 'each card on Picks says so, on the Picks tab too, where the model\'s own share the strip');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
