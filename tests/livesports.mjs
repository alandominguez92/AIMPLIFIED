// Live Now across every sport followed (2026-10-23).
//
// Live Now scored only the MLB model's picks, and the MLB season ends with the
// World Series. It now scores, beside them, the NBA and NHL PrizePicks unders
// and Picks of the day's NBA and NHL moneylines whose games are under way,
// from the leagues' own live feeds: ESPN's NBA box scores, the NHL's own. No
// odds are read. What has to hold:
//   - a leg is on Live Now only while its game is in progress: not before tip,
//     not after the final
//   - its number is the box score's, its clock and score the scoreboard's
//   - an under reads cashing when held under it with a quarter of the game
//     left, cooling once over the line or on pace to pass it, live otherwise
//   - the list's own legs are followed, then each game's best three, one card
//     a player; Picks of the day's moneylines show the score and the lead
//   - each card names its sport, and the page shows a tab's own -- every
//     sport's on Picks, the list's legs first
//
// Real payloads, recorded at 6:27 PM Pacific on Oct 23 with six NBA games and
// two NHL games under way (tests/fixtures/espn-nba-live-20261023.json and
// nhl-live-20261023.json). The legs are production's: the NBA's as /api/nba-pp
// served them that morning (nba-pp-board-20261023.json) plus Dyson Daniels'
// threes, logged at the pre-tip read; the NHL's as the card showed them, with
// the NHL's own ids from the box scores. Picks of the day is the list as it
// stood at 3:14 PM. Real SQLite, the real worker.
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

const asked = [];
globalThis.fetch = async (u) => {
  const url = String(u);
  asked.push(url);
  const J = (x) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url === 'https://cdn.espn.com/core/nba/scoreboard?xhr=1&date=20261023') return J(NBA.scoreboard);
  const nb = url.match(/^https:\/\/cdn\.espn\.com\/core\/nba\/boxscore\?xhr=1&gameId=(\d+)$/);
  if (nb && NBA.boxes[nb[1]]) return J(NBA.boxes[nb[1]]);
  if (url === 'https://api-web.nhle.com/v1/score/2026-10-23') return J(NHL.score);
  const hb = url.match(/^https:\/\/api-web\.nhle\.com\/v1\/gamecenter\/(\d+)\/boxscore$/);
  if (hb && NHL.boxes[hb[1]]) return J(NHL.boxes[hb[1]]);
  if (url.includes('statsapi.mlb.com')) return J({ dates: [] });          // no MLB game tonight
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
const game = (name) => LEGS.find((x) => x.game === name);
const ATL = game('Atlanta Hawks @ Charlotte Hornets'), NYK = game('New York Knicks @ Boston Celtics'), TOR = game('Toronto Raptors @ Washington Wizards');
insNba.run('2026-10-23', ATL.game_id, 'Dyson Daniels', 'threes', 'reg', ATL.commence, 'Charlotte Hornets', 'Atlanta Hawks', 'ATL', '4869342',
  0.5, 0.3, 79.2, 3, 33.5, null, null, '2026-10-23T21:40:47.264Z');
const dp = sq.prepare(`INSERT INTO daypicks (date, leg_id, kind, src_date, game_id, player_key, market, team, label, p, commence, rank, on_list, seen_at)
  VALUES ('2026-10-23', ?, ?, '2026-10-23', ?, ?, ?, ?, ?, ?, ?, ?, 1, '2026-10-23T22:14:00Z')`);
dp.run(`nbapp:${ATL.game_id}:Dyson Daniels:threes`, 'nba_pp', ATL.game_id, 'Dyson Daniels', 'threes', 'ATL', 'Dyson Daniels Under 0.5 3PM', 79.2, ATL.commence, 2);
dp.run(`nbapp:${NYK.game_id}:Karl-Anthony Towns:ast`, 'nba_pp', NYK.game_id, 'Karl-Anthony Towns', 'ast', 'NY', 'Karl-Anthony Towns Under 4 AST', 71.5, NYK.commence, 6);
dp.run(`nba:ml:${TOR.game_id}:away`, 'nba_ml', TOR.game_id, null, 'h2h', 'Toronto Raptors', 'Raptors ML', 74.9, TOR.commence, 4);
sq.prepare(`INSERT INTO gmpicks (sport, date, game_id, market, league, commence, side, pick, home, away, win_prob, entry_price, close_price)
  VALUES ('nba', '2026-10-23', ?, 'h2h', 'reg', ?, 'away', 'Toronto Raptors', 'Washington Wizards', 'Toronto Raptors', 74.9, -320, -320)`).run(TOR.game_id, TOR.commence);
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

// ---- Live Now ---------------------------------------------------------------------------------
const cards = await get('/api/live-now');
const nba = cards.filter((c) => c.sport === 'nba' && c.kind !== 'ml'), nhl = cards.filter((c) => c.sport === 'nhl'), ml = cards.filter((c) => c.kind === 'ml');
console.log('-- NBA, six games under way --');
console.log('  ' + nba.map((c) => `${c.name} ${c.stat}/${c.line} ${c.statLabel} ${c.state} [${c.inning}]`).join(' | '));
const liveGames = ['Atlanta Hawks @ Charlotte Hornets', 'New York Knicks @ Boston Celtics', 'Dallas Mavericks @ Indiana Pacers', 'Minnesota Timberwolves @ Orlando Magic',
  'Toronto Raptors @ Washington Wizards', 'Detroit Pistons @ Miami Heat'];
const legOf = (c) => [...LEGS, { player: 'Dyson Daniels', market: 'threes', game: ATL.game }].find((x) => x.player === c.name);
ok(nba.length > 0 && nba.length <= 9 && nba.every((c) => liveGames.includes(legOf(c).game)),
  `${nba.length} cards, all from the six games under way: none from the Bulls' final, none from the four still to tip`);
ok(new Set(nba.map((c) => c.name)).size === nba.length, 'one card a player');
const dd = nba.find((c) => c.name === 'Dyson Daniels');
ok(dd && dd.onPicks && dd.stat === espnStat('401909843', '4869342', '3PT') && dd.stat === 0 && dd.line === 0.5 && dd.statLabel === '3PM',
  `Dyson Daniels, on Picks: ${dd && dd.stat} threes against under 0.5, from the box score (0 of 1)`);
ok(dd && dd.state === 'cashing' && dd.inning === 'Q4 4:56' && dd.matchup === 'ATL 113 – CHA 73' && /^23 of 34 min$/.test(dd.note),
  `held under it with five minutes left: ${dd && dd.state}, "${dd && dd.matchup} · ${dd && dd.inning}", "${dd && dd.note}"`);
const kat = nba.find((c) => c.name === 'Karl-Anthony Towns');
const katAst = espnStat('401909095', '3136195', 'AST');
ok(kat && kat.onPicks && kat.stat === katAst && kat.line === 4 && kat.inning === 'Q4 9:59',
  `Towns, on Picks: ${kat && kat.stat} assists against under 4, as the box score has it (${katAst}), Q4 9:59`);
ok(kat && kat.state === (katAst > 4 ? 'cooling' : katAst < 4 ? 'cashing' : 'cooling'),
  `and read the way the rule says for ${katAst} with ten minutes left: ${kat && kat.state}`);
ok(nba.filter((c) => c.stat > c.line).every((c) => c.state === 'cooling'), 'every under already over its line reads cooling');
const order = { cashing: 0, live: 1, cooling: 2 };
ok(nba.every((c, i) => i === 0 || order[nba[i - 1].state] <= order[c.state]), 'cashing first, then live, then cooling');

// Nine Q4 legs held under their lines fill the nine slots, so the Pistons and
// Heat, at halftime and only live, are cut. Alone, they show.
const DET = game('Detroit Pistons @ Miami Heat');
const saved = sq.prepare('SELECT * FROM nbapp').all();
sq.prepare('DELETE FROM nbapp WHERE game_id != ?').run(DET.game_id);
const half = (await get('/api/live-now')).filter((c) => c.sport === 'nba' && c.kind !== 'ml');
console.log('  alone: ' + half.map((c) => `${c.name} ${c.stat}/${c.line} ${c.state} [${c.inning}]`).join(' | '));
ok(half.length === 3 && half.every((c) => c.inning === 'Half' && c.matchup === 'DET 65 – MIA 53' && (c.stat > c.line ? c.state === 'cooling' : c.state !== 'cashing')),
  `the game at halftime says so, and half a game is too early to call an under cashing: ${half.map((c) => c.name + ' ' + c.state).join(', ')}`);
sq.prepare('DELETE FROM nbapp').run();
const cols = Object.keys(saved[0]);
const back = sq.prepare(`INSERT INTO nbapp (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
for (const r of saved) back.run(...cols.map((k) => r[k]));

console.log('\n-- NHL, two games under way --');
console.log('  ' + nhl.map((c) => `${c.name} ${c.side} ${c.stat}/${c.line} ${c.statLabel} ${c.state} [${c.matchup} ${c.inning}]`).join(' | '));
// Since 2026-10-27 Live follows the NHL card's Mores at 55%+ (tests/morelegs.mjs).
// Of these eight legs one leans that way: Brock Nelson, 44.9% to stay under.
// The under side of the rest -- Kantserov's 71.7%, Kadri's point -- is no
// longer followed.
ok(nhl.length === 1 && nhl[0].name === 'Brock Nelson' && nhl[0].side === 'Over' && nhl[0].statLabel === 'PTS',
  `each game's best three Mores at 55%+: ${nhl.map((c) => c.name).join(', ')} alone`);
const nel = nhl[0] || {};
ok(nel.stat === nhlLine('2026020167', '8475754').points && nel.stat === 0 && nel.state === 'live' && nel.matchup === 'TBL 0 – COL 2' && nel.inning === 'P1 12:25',
  `Nelson: ${nel.stat} points at ${nel.inning}, over 0.5 with the game to play: ${nel.state}`);

console.log('\n-- the moneylines on Picks --');
const rap = ml.find((c) => c.name === 'Raptors ML');
console.log('  ' + ml.map((c) => `${c.name} ${c.stat} ${c.vs} ${c.state} [${c.matchup} ${c.inning}]`).join(' | '));
ok(ml.length === 1 && rap && rap.sport === 'nba' && rap.onPicks, 'the Raptors, on the list and under way; the Blazers and Lakers have not tipped');
ok(rap && rap.stat === '94–89' && rap.vs === 'up 5' && rap.matchup === 'TOR 94 – WSH 89' && rap.inning === 'Q4 7:28' && rap.state === 'cashing',
  `Raptors 94-89 with seven minutes left: "${rap && rap.vs}", ${rap && rap.state}`);

ok(!asked.some((u) => u.includes('the-odds-api.com')), `no odds read for any of it (${asked.length} feed reads, all ESPN and the NHL)`);
ok(cards.every((c) => !('_pid' in c) && !('_edge' in c) && !('_started' in c)), 'and the ranking fields stay in the worker');

// ---- the page ------------------------------------------------------------------------------------
console.log('\n-- the page --');
const app = fs.readFileSync(BOARD + '/app.js', 'utf8').replace(/\r\n/g, '\n');
const lift = (name) => {
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
const state = { liveNow: [...cards, { sport: 'mlb', name: 'An MLB Arm', state: 'live' }] };
const forTab = new Function('state', lift('liveCardsFor') + '\nreturn liveCardsFor;')(state);
ok(forTab('nba').every((c) => c.sport === 'nba') && forTab('nba').length === nba.length + ml.length, 'the NBA tab shows the NBA cards, props and the Raptors');
ok(forTab('nhl').length === nhl.length && forTab('mlb').map((c) => c.name).join() === 'An MLB Arm', 'the NHL tab its own; the MLB tab its own');
const pk = forTab('picks');
ok(pk.length <= 12 && pk.slice(0, 3).every((c) => c.onPicks) && pk.some((c) => c.sport === 'nhl'), `Picks shows every sport, the list's three first (${pk.slice(0, 3).map((c) => c.name).join(', ')})`);
ok(cards.every((c) => typeof c.started === 'boolean') && cards.filter((c) => c.kind !== 'ml').some((c) => c.started),
  'each card says whether its player is in action yet (started), for the Picks tab to order by');
// Production's answer at 5:04 PM Pacific on Oct 24 (live-now-20261024.json),
// before cards carried `started`: the World Series' nine, none yet at bat or
// on the mound (0-for-0, 0 pitches), filled the Picks strip ahead of the NBA
// and NHL legs in play. Flagged the way the worker now flags them:
const PROD = read('live-now-20261024.json').cards;
const flagged = PROD.map((c) => ({ ...c, started: c.kind === 'ml' ? true : c.sport === 'mlb' ? !/^(0 pitches|0-for-0)/.test(c.note || '') : !/^0 of /.test(c.note || '') }));
state.liveNow = flagged;
const pk2 = forTab('picks');
console.log('  Oct 24 Picks strip: ' + pk2.map((c) => `${c.sport}:${c.name}`).join(', '));
ok(PROD.filter((c) => c.sport === 'mlb').length === 9 && flagged.filter((c) => c.sport === 'mlb').every((c) => !c.started),
  'the recorded answer: nine MLB cards, not one of them yet in action');
ok(pk2.slice(0, 2).every((c) => c.kind === 'ml' && c.onPicks) && !pk2.some((c) => c.sport === 'mlb')
  && pk2.filter((c) => c.sport === 'nba' && c.kind !== 'ml').length >= 4 && pk2.filter((c) => c.sport === 'nhl').length >= 4,
  `the list's two moneylines, then NBA and NHL legs in play taking turns; the World Series waits for its first pitch`);
ok(!/'#liveNow'/.test(app.slice(app.indexOf('const MLB_ONLY'), app.indexOf('const MLB_ONLY') + 200)) && /applySportChrome\(s\);\n\s*renderLiveNow\(\);/.test(app),
  'the strip is no longer MLB-only, and every tab change redraws it for the tab');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
