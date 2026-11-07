// The NFL props card: read from the capture the site already pays for (2026-11-05).
//
// The owner: "For NFL let's add passing yards, Recording yards, Rush yards, catches, etc." The NBA
// and NHL cards' rules, and what is the NFL's own:
//   - no credits of its own: the capture keeps PrizePicks' and the sharp books' prices of a game it
//     just bought, and a trigger logs one game a tick. No call to the odds feed comes from the card
//   - each capture is a full picture, so a later one moves the number, and leaves one set by hand
//   - a box score lists a player only in the tables he has a line in, so a stat he has no line in
//     was a zero, for his log, his projection and his grade
//   - a stat a player doesn't do isn't on his row; a player with no number shows only as a regular
//   - rows and an entry's legs grade from the box scores; a leg from another NFL board goes its own way
//
// Real data: Commanders @ Dolphins' odds payload of Nov 16 2025 and that game's box score, with its
// kickoff moved to the test's day, and the two clubs' box rows from this season, weeks 1-8.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOARD = path.join(HERE, '..');
const fx = (f) => JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', f), 'utf8'));
const EVENT = fx('hist-props-nfl-20251116.json').odds.data;
const SB = fx('espn-nfl-sb-2025-w11.json'), BOX = fx('espn-nfl-box-401772631.json'), LEAGUE = fx('nfl-box-league-to-20261102.json');
const PRIORS = fs.readFileSync(path.join(BOARD, 'nfl-hot-priors.json'), 'utf8');

globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const TIP = Date.parse('2026-11-08T18:00:00Z');       // 10 AM Pacific, Sunday Nov 8
const DAY = '2026-11-08';
let NOW = TIP - 40 * 3600e3;
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
};
const ISO = new RealDate(TIP).toISOString();

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
const env = { DB, ODDS_API_KEY: 'k', ADMIN_KEY: 't', ASSETS: { fetch: async (r) => (new URL(r.url).pathname === '/nfl-hot-priors.json'
  ? new Response(PRIORS, { status: 200 }) : new Response('{}', { status: 404 })) } };

// ---- the feeds ----------------------------------------------------------------------------
const THE_GAME = (SB.content.sbData.events).find((e) => e.id === '401772631');
const scheduled = { ...THE_GAME, date: ISO, week: { number: 10 }, season: { year: 2026, type: 2 }, status: { type: { name: 'STATUS_SCHEDULED' } } };
let oddsReads = [], scoreReads = 0, upstream = 0, ppBump = 0, payloadMarkets = null;
// A later read's PrizePicks number on Samuel's catches, when the test moves it.
const payload = () => ({ ...EVENT, commence_time: ISO, bookmakers: EVENT.bookmakers.map((b) => (b.key !== 'prizepicks' ? b : { ...b,
  markets: b.markets.map((m) => (m.key !== 'player_receptions' ? m : { ...m, outcomes: m.outcomes.map((o) => (o.description === 'Deebo Samuel Sr.' ? { ...o, point: o.point + ppBump } : o)) })) })) });
const J = (x, h = {}) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json', 'x-requests-remaining': '59000', ...h } });
globalThis.fetch = async (u) => {
  const url = String(u);
  upstream++;
  if (/americanfootball_nfl\/events\/.+\/odds/.test(url)) { oddsReads.push(url); return J(payload(), { 'x-requests-last': '3' }); }
  if (/americanfootball_nfl\/events\?/.test(url)) return J([{ id: EVENT.id, sport_key: 'americanfootball_nfl', commence_time: ISO, home_team: EVENT.home_team, away_team: EVENT.away_team }], { 'x-requests-last': '0' });
  if (/the-odds-api\.com/.test(url)) return new Response('{}', { status: 404 });
  if (url === 'https://cdn.espn.com/core/nfl/scoreboard?xhr=1') { scoreReads++; return J({ content: { sbData: { events: [scheduled] } } }); }
  if (/core\/nfl\/scoreboard\?xhr=1&year=/.test(url)) return J({ content: { sbData: { events: [] } } });
  if (url === 'https://cdn.espn.com/core/nfl/boxscore?xhr=1&gameId=401772631') return J(BOX);
  return new Response('{}', { status: 404 });
};

const src = fs.readFileSync(path.join(BOARD, 'worker.js'), 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const ctx = { waitUntil: () => {} };
const res = (u, init) => mod.default.fetch(new Request('https://x' + u, init), env, ctx);
const hit = async (u) => (await res(u)).json();
const capture = () => res('/api/nfl-capture', { headers: { 'x-admin-key': 't' } }).then((r) => r.json());
const KEY = 'phone-key-0123456789abcdef';
const line = (body, key = KEY) => res('/api/prop-lines', { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { 'x-entry-key': key } : {}) }, body: JSON.stringify(body) });
const tick = async (cron = '1-59/2 * * * *') => {
  const held = [];
  await mod.default.scheduled({ cron }, env, { waitUntil: (p) => held.push(p) });
  await Promise.allSettled(held);
};
const lf = src.replace(/\r\n/g, '\n');
const fnOf = (name) => { const at = lf.indexOf(`function ${name}(`); return lf.slice(at, lf.indexOf('\n}\n', at) + 2); };
const shin = new Function(`${fnOf('amProb')}\n${fnOf('shinDevig')}\nreturn shinDevig;`)();
const fair = (u, o) => Math.round(shin(u, o) * 1000) / 10;
const row = (player, market) => sq.prepare('SELECT * FROM pp_props WHERE player = ? AND market = ?').get(player, market);
const save = (k, data) => sq.prepare('INSERT OR REPLACE INTO feed_cache (key, data, updated_at, claimed_until) VALUES (?,?,?,0)').run(k, JSON.stringify(data), NOW);
const cache = (k) => { const r = sq.prepare('SELECT data FROM feed_cache WHERE key = ?').get(k); return r ? JSON.parse(r.data) : null; };

console.log('\n-- nothing to show yet --');
const empty = await hit('/api/nfl-props');
ok(Array.isArray(empty.players) && !empty.players.length && empty.sport === 'nfl' && empty.record.need === 100 && empty.readHours == null, 'an empty board, with no read time of its own');
ok(upstream === 0, 'and asks no one');

// The two clubs' games this season, as ESPN's box scores gave them.
const CLUBS = new Set(['WSH', 'MIA']);
const old = LEAGUE.rows.map((r) => ({ game_id: LEAGUE.games[r[0]][0], date: LEAGUE.games[r[0]][1], player_id: LEAGUE.players[r[1]][0], player: LEAGUE.players[r[1]][1], team: r[2], opp: r[3],
  // The file packs a non-passer's passing table as zeros; the box-score reader leaves it empty.
  ...(r[4] ? { pass_att: r[4], pass_yds: r[5], pass_td: r[6] } : {}), car: r[7], rush_yds: r[8], tgt: r[9], rec: r[10], rec_yds: r[11] })).filter((r) => CLUBS.has(r.team));
const cols = ['game_id', 'date', 'player_id', 'player', 'team', 'opp', 'pass_att', 'pass_yds', 'pass_td', 'car', 'rush_yds', 'tgt', 'rec', 'rec_yds'];
const addOld = sq.prepare(`INSERT INTO nfl_box (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(',')})`);
for (const r of old) addOld.run(...cols.map((c) => norm(r[c])));
for (const id of new Set(old.map((r) => r.game_id))) sq.prepare('INSERT OR IGNORE INTO nfl_box_games (game_id, date, done) VALUES (?,?,1)').run(id, old.find((r) => r.game_id === id).date);
save('nfl_box_scan', { week: 10, current: 10, checked: NOW });

console.log('\n-- the games and the form --');
await tick();
const slate = cache('pp_props_slate:nfl');
ok(slate && slate.games.length === 1 && slate.games[0].id === '401772631' && slate.games[0].home === 'MIA' && slate.games[0].away === 'WSH', `ESPN's game, with the codes the box scores use: ${slate && slate.games[0].away} @ ${slate && slate.games[0].home}`);
const readsThen = scoreReads;
await tick();
ok(scoreReads === readsThen, 'the games list isn\'t asked for each tick');
ok(!oddsReads.length, 'and no tick asks the odds feed for the card');
const form = cache('pp_props_form:nfl');
const F = (n) => form.players.find((p) => p.name === n);
const NAMES = [...new Set(old.map((r) => r.player))];
const qb = NAMES.find((n) => old.filter((r) => r.player === n).reduce((a, r) => a + (r.pass_att || 0), 0) > 100 && old.find((r) => r.player === n).team === 'MIA');
const fq = F(qb);
ok(fq && fq.proj.pass_yds > 100 && fq.proj.rec_yds == null && fq.proj.rec == null, `${qb}: passing yards projected, not catches (${fq && fq.proj.pass_yds})`);
const lastOf = (n) => old.filter((r) => r.player === n).sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 10);
const receiver = NAMES.find((n) => { const l = lastOf(n); return l.length >= 6 && l.reduce((a, r) => a + (r.rec || 0), 0) / l.length > 3 && l.some((r) => !r.car); });
const fr = F(receiver), rlast = lastOf(receiver), priorsOf = JSON.parse(PRIORS).players[fr.id];
const recs = rlast.reduce((a, r) => a + (r.rec || 0), 0);
const wantRec = priorsOf && priorsOf.g >= 6 ? (recs + 5 * priorsOf.rec) / (rlast.length + 5) : recs / rlast.length;
ok(fr.proj.rec === Math.round(wantRec * 10) / 10, `${receiver}'s catches: the last ${rlast.length} plus five of last season (${fr.proj.rec}, by hand ${Math.round(wantRec * 10) / 10})`);
ok(fr.log.every((g) => g[2] !== null) && fr.log.some((g) => g[2] === 0), 'a game with no rushing line reads as a zero in his log, not a gap');
ok(fr.proj.rush_rec === undefined || fr.proj.rush_rec >= 15, `rush + receiving, its parts added up (${fr.proj.rush_rec})`);

console.log('\n-- before any capture --');
let b = await hit('/api/nfl-props');
ok(b.games.length === 1 && b.games[0].id === 'nfl:401772631' && b.games[0].homeAb === 'MIA' && b.games[0].date === DAY, 'the game under ESPN\'s id, until a capture gives the odds feed\'s');
ok(b.players.some((p) => p.name === receiver) && b.players.every((p) => !Object.keys(p.lines).length), 'regulars on it with their projections, no numbers');
const fringe = form.players.find((p) => CLUBS.has(p.team) && p.min < 0.5);
ok(fringe && !b.players.some((p) => p.name === fringe.name), `${fringe && fringe.name}, little used and no number: not listed`);

console.log('\n-- a capture: no new credits --');
NOW = TIP - 3 * 3600e3;
save('nfl_box_scan', { week: 10, current: 10, checked: NOW });
const cap = await capture();
ok(oddsReads.length === 1 && cap.errors.length === 0, `the capture's own one read of the game (${oddsReads.length}), no errors: ${JSON.stringify(cap.errors)}`);
const usage = sq.prepare('SELECT route, credits FROM odds_route').all();
ok(usage.every((x) => !/props$/.test(x.route) || x.route === 'nfl:props') && usage.filter((x) => x.route === 'nfl:props')[0].credits === 3, `billed to the capture's line and no other: ${usage.map((x) => `${x.route} ${x.credits}`).join(', ')}`);
const raw = cache(`nfl_props_raw:${EVENT.id}`);
const keptBooks = raw.body.bookmakers.map((x) => x.key).sort().join();
ok(keptBooks === 'betonlineag,fanduel,novig,pinnacle,prizepicks,prophetx', `PrizePicks and the sharp books kept, no others: ${keptBooks}`);
ok(!/"link"|last_update/.test(JSON.stringify(raw)), 'prices alone');
ok(!sq.prepare('SELECT 1 FROM pp_props').get(), 'and nothing logged yet: the capture isn\'t made longer');
await tick();
ok(!cache(`nfl_props_raw:${EVENT.id}`), 'the trigger takes it, and it\'s gone');
ok(oddsReads.length === 1, 'with no call of its own');

console.log('\n-- the figure --');
const deebo = row('Deebo Samuel Sr.', 'rec');
ok(deebo && deebo.read_point === 4.5 && deebo.read_sharp === fair(-105, -120) && deebo.sharp_src === 'pinnacle', `Samuel's catches at PrizePicks' 4.5: Pinnacle's Under -105 / Over -120, de-vigged to ${fair(-105, -120)} (${deebo && deebo.read_sharp})`);
ok(deebo.read_at === new RealDate(NOW).toISOString(), 'read at the time of the capture');
const yds = row('Deebo Samuel Sr.', 'rec_yds');
ok(yds.read_point === 47.5 && yds.read_sharp === fair(-113, -111), `his receiving yards at 47.5: ${fair(-113, -111)} (${yds.read_sharp})`);
ok(row('De\'Von Achane', 'rush_yds').read_point === 81.5 && row('De\'Von Achane', 'rush_yds').read_sharp === fair(-112, -112), 'Achane\'s rushing yards at 81.5');
const markets = sq.prepare('SELECT DISTINCT market FROM pp_props').all().map((r) => r.market).sort().join();
ok(markets === 'rec,rec_yds,rush_yds', `what the payload had: ${markets}`);
ok(!sq.prepare("SELECT 1 FROM pp_props WHERE sport != 'nfl'").get(), 'filed under the NFL');
const sharpOnly = sq.prepare('SELECT player, market, fairs FROM pp_props WHERE read_point IS NULL').all();
ok(sharpOnly.length > 0 && sharpOnly.every((r) => JSON.parse(r.fairs).length > 0), `${sharpOnly.length} rows the sharp books quote and PrizePicks doesn't, with their numbers and no figure`);

console.log('\n-- the board --');
upstream = 0;
b = await hit('/api/nfl-props');
ok(upstream === 0, 'it calls no one');
ok(b.games.length === 1 && b.games[0].id === EVENT.id && b.games[0].home === 'Miami Dolphins' && b.games[0].away === 'Washington Commanders', 'the game under the odds feed\'s id, as the capture named it');
ok(b.readHours == null && b.cols.join() === 'pass_yds,pass_td,rush_yds,rec,rec_yds' && b.sums.rush_rec.join() === 'rush_yds,rec_yds', 'the columns the page adds up from');
ok(!/model_under|model_prob/.test(JSON.stringify(b)), 'no model percentage anywhere in it');
const P = (n) => b.players.find((p) => p.name === n);
const ds = P('Deebo Samuel Sr.');
ok(ds && ds.lines.rec.l === 4.5 && ds.lines.rec.u === fair(-105, -120), 'Samuel: 4.5 catches with the figure');
const wash = P('Malik Washington');
ok(wash && wash.team === 'MIA' && wash.log.length > 0 && wash.lines.rec.l === 3.5 && wash.proj.rec > 0, `Malik Washington, as ESPN names him and PrizePicks does: MIA, his log beside 3.5 catches (proj ${wash && wash.proj.rec})`);
const chosen = P('Robbie Chosen');
ok(chosen && chosen.log.length === 0 && Object.keys(chosen.lines).length > 0, 'PrizePicks has a player up with no box score this season: on the card from the read alone');
ok(b.players.every((p) => p.g === 0) && b.record.graded === 0 && b.record.need === 100, 'nothing graded of the 100');

console.log('\n-- who to expect, and a number before PrizePicks posts --');
// Ahead of time, as the soccer card's expected rows (2026-11-05): the passer to expect is who threw
// most in his team's last game; everyone else, how many of its last five he had a role in.
for (const club of CLUBS) {
  const games = [...new Set(old.filter((r) => r.team === club).sort((a, c) => (a.date < c.date ? 1 : -1)).map((r) => r.game_id))];
  const thrower = old.filter((r) => r.team === club && r.game_id === games[0]).sort((a, c) => (c.pass_att || 0) - (a.pass_att || 0))[0];
  const qbs = b.players.filter((p) => p.team === club && p.qb1);
  ok(qbs.length === 1 && qbs[0].name === thrower.player, `${club}: ${qbs.map((p) => p.name).join(', ')}, who threw ${thrower.pass_att} times last game`);
}
const w5 = [...new Set(old.filter((r) => r.team === 'MIA').sort((a, c) => (a.date < c.date ? 1 : -1)).map((r) => r.game_id))].slice(0, 5);
const roleIn = w5.filter((g) => old.some((r) => r.game_id === g && r.player === 'Malik Washington' && Math.max((r.pass_att || 0) / 15, (r.car || 0) / 8, (r.tgt || 0) / 4) >= 0.5)).length;
ok(wash.st && wash.st.join() === `${roleIn},${w5.length}`, `Washington had a role in ${wash.st} of the Dolphins' last games, by hand ${roleIn}`);
// Last week's PrizePicks number: what his row stands at before this week's is up.
sq.prepare('INSERT INTO pp_props (sport, date, pkey, market, player, read_point, result) VALUES (?,?,?,?,?,?,?)').run('nfl', '2026-11-01', wash.k, 'pass_yds', 'Malik Washington', 0.5, 'under');
sq.prepare('INSERT INTO pp_props (sport, date, pkey, market, player, read_point, result) VALUES (?,?,?,?,?,?,?)').run('nfl', '2026-11-01', wash.k, 'rush_rec', 'Malik Washington', 44.5, 'over');
const formNow = cache('pp_props_form:nfl');
ok(formNow.v === 3 && !formNow.players.some((p) => p.last) && !formNow.players.some((p) => p.mw != null), 'no number from an earlier game yet, and no NBA minutes on football');
delete formNow.v;
save('pp_props_form:nfl', formNow);
await tick();
const wl = (await hit('/api/nfl-props')).players.find((p) => p.name === 'Malik Washington');
ok(wl.last && wl.last.rush_rec.join() === '44.5,2026-11-01' && wl.last.pass_yds[0] === 0.5, `the form row built again: last week's numbers, ${JSON.stringify(wl.last)}`);
sq.prepare("DELETE FROM pp_props WHERE date = '2026-11-01'").run();

console.log('\n-- a line set on the card, and a later capture --');
const leg = { sport: 'nfl', gameId: EVENT.id, player: 'Deebo Samuel Sr.', playerId: ds.id, team: 'WSH', stat: 'rush_rec', line: 60.5 };
ok((await line(leg, null)).status === 401, 'no key: refused');
ok((await line({ ...leg, stat: 'saves' })).status === 400, 'a stat of the NHL\'s: refused');
const r1 = await (await line(leg)).json();
ok(r1.ok && r1.sharp == null, 'rush + receiving, which no market has: saved, with no figure');
const r2 = await (await line({ ...leg, stat: 'rec', line: 5 })).json();
ok(r2.ok, 'his catches moved to 5');
ok((await (await line({ ...leg, player: 'Marcus Mariota', playerId: null, team: 'WSH', stat: 'rec_yds', line: 0.5 })).json()).ok, 'a quarterback\'s receiving yards set by hand');
ok((await (await line({ ...leg, player: 'Jaylen Waddle', playerId: null, team: 'MIA', stat: 'pass_yds', line: 0.5 })).json()).ok, 'a receiver\'s passing yards set by hand');
ppBump = 1;
NOW += 600e3;
await capture();
await tick();
const moved = row('Deebo Samuel Sr.', 'rec');
ok(moved.read_point === 5.5 && moved.typed_line === 5, 'a later capture moves the number read, and the one set stands');
ok(sq.prepare("SELECT COUNT(*) AS n FROM feed_cache WHERE key LIKE 'nfl_props_raw:%'").get().n === 0, 'nothing left waiting');
ppBump = 0;

console.log('\n-- a game that starts before its turn --');
save(`nfl_props_raw:another`, { id: 'another', home: 'Miami Dolphins', away: 'Washington Commanders', commence: new RealDate(NOW - 60e3).toISOString(), at: NOW - 3600e3, body: { bookmakers: [] } });
const before = sq.prepare('SELECT COUNT(*) AS n FROM pp_props').get().n;
await tick();
ok(!cache('nfl_props_raw:another') && sq.prepare('SELECT COUNT(*) AS n FROM pp_props').get().n === before, 'is dropped: its lines are locked');

console.log('\n-- grading --');
sq.prepare("INSERT INTO pp_props (sport, date, pkey, market, player, game_id, home, away, commence, read_point, read_sharp, read_at) VALUES ('nfl', ?, 'no such back', 'rush_yds', 'No Such Back', ?, ?, ?, ?, 24.5, 50, ?)").run(DAY, EVENT.id, EVENT.home_team, EVENT.away_team, ISO, ISO);
sq.prepare('UPDATE pp_props SET player_id = NULL WHERE player = ?').run('Malik Washington');
sq.prepare("INSERT INTO nfl_box_games (game_id, date, done) VALUES ('401772631', ?, 0), ('401772632', ?, 0)").run(DAY, DAY);
NOW = TIP + 5 * 3600e3;
await tick();
await tick('4-59/10 * * * *');
const g = (p, m) => { const r = row(p, m); return r && `${r.result}|${r.actual}`; };
ok(g('Deebo Samuel Sr.', 'rec') === 'over|7', `Samuel's 7 catches against the 5 set: ${g('Deebo Samuel Sr.', 'rec')}`);
const boxOf = sq.prepare("SELECT * FROM nfl_box WHERE game_id = '401772631' AND player = ?");
const dsBox = boxOf.get('Deebo Samuel Sr.');
const dsSum = (dsBox.rush_yds || 0) + (dsBox.rec_yds || 0);
ok(g('Deebo Samuel Sr.', 'rush_rec') === `${dsSum > 60.5 ? 'over' : 'under'}|${dsSum}`, `his rush + receiving, added up, against the 60.5 set: ${g('Deebo Samuel Sr.', 'rush_rec')}`);
const waddle = boxOf.get('Jaylen Waddle');
ok(waddle && g('Jaylen Waddle', 'rec_yds') === `${waddle.rec_yds > 78.5 ? 'over' : 'under'}|${waddle.rec_yds}`, `Waddle's yards against 78.5: ${g('Jaylen Waddle', 'rec_yds')}`);
const mw = boxOf.get('Malik Washington');
ok(mw && g('Malik Washington', 'rec_yds') === `${mw.rec_yds > row('Malik Washington', 'rec_yds').read_point ? 'over' : 'under'}|${mw.rec_yds}`, `Washington found by name with no id: ${g('Malik Washington', 'rec_yds')}`);
const mar = boxOf.get('Marcus Mariota');
ok(mar && mar.rec === 0 && mar.rec_yds === 0 && mar.rush_yds === 49, `Mariota caught nothing and ran for 49: ${mar && [mar.rec, mar.rec_yds, mar.rush_yds].join('/')}`);
ok(g('Marcus Mariota', 'rec_yds') === 'under|0', `his receiving yards grade on that zero: ${g('Marcus Mariota', 'rec_yds')}`);
ok(boxOf.get('Jaylen Waddle').pass_yds == null && g('Jaylen Waddle', 'pass_yds') === 'under|0', `a table he has no line in counts as the zero it was: Waddle's passing yards ${g('Jaylen Waddle', 'pass_yds')}`);
const bare = sq.prepare("SELECT p.player, p.result FROM pp_props p JOIN nfl_box b ON b.game_id = '401772631' AND b.player = p.player WHERE p.sport = 'nfl' AND p.read_point IS NULL AND p.typed_line IS NULL").all();
ok(bare.length > 0 && bare.every((r) => r.result === 'void'), `a row with no number at all is void, not a result (${bare.length})`);
ok(row('No Such Back', 'rush_yds').result == null, 'a player not in the box, with a game still to read: he waits');
const rec1 = (await hit('/api/nfl-props')).record;
const finished = sq.prepare("SELECT result, read_sharp, typed_line, typed_sharp FROM pp_props WHERE sport = 'nfl' AND result IN ('under','over')").all();
ok(rec1.graded === finished.length && finished.length >= 10, `the record: ${rec1.graded} decided`);
await tick('4-59/10 * * * *');
ok((await hit('/api/nfl-props')).record.graded === rec1.graded, 'grading again counts nothing twice');

console.log('\n-- an entry\'s legs --');
const entry = async (legs) => (await (await res('/api/entries', { method: 'POST', headers: { 'content-type': 'application/json', 'x-entry-key': KEY },
  body: JSON.stringify({ action: 'create', entry: { book: 'pp', kind: 'flex', stake: 10, legs } }) })).json()).id;
const eleg = (player, playerId, market, ln, side) => ({ sport: 'nfl', date: DAY, gamePk: EVENT.id, player, playerId, team: 'WSH', market, line: ln, side });
const id = await entry([eleg('Deebo Samuel Sr.', dsBox.player_id, 'rec', 4.5, 'Under'), eleg('Deebo Samuel Sr.', null, 'rush_rec', dsSum - 0.5, 'Over'), eleg('Marcus Mariota', mar.player_id, 'rec', 0.5, 'Under'), eleg('No Such Back', null, 'rush_yds', 24.5, 'Under')]);
await res('/api/entries', { headers: { 'x-entry-key': KEY } });
const legs = () => sq.prepare('SELECT player, market, result, actual FROM entry_legs WHERE entry_id = ? ORDER BY idx').all(id);
ok(legs()[0].result === 'loss' && legs()[0].actual === 7, `Samuel's catches Under 4.5, by his id: ${legs()[0].result}`);
ok(legs()[1].result === 'win' && legs()[1].actual === dsSum, `his rush + receiving, by name: ${legs()[1].result}`);
ok(legs()[2].result === 'win' && legs()[2].actual === 0, `Mariota, Under 0.5 catches with no line in the box: ${legs()[2].result}`);
ok(legs()[3].result == null, 'a player not in today\'s box: open');

console.log('\n-- the next day --');
sq.prepare("UPDATE nfl_box_games SET done = 1 WHERE game_id = '401772632'").run();
NOW = TIP + 24 * 3600e3;
const held = [];
await mod.default.scheduled({ cron: '*/5 * * * *' }, env, { waitUntil: (p) => held.push(p) });
await Promise.allSettled(held);
ok(row('No Such Back', 'rush_yds').result === 'void', `every game read and he isn't in one: void (${row('No Such Back', 'rush_yds').result})`);
await res('/api/entries', { headers: { 'x-entry-key': KEY } });
ok(legs()[3].result === 'void', `and his leg (${legs()[3].result})`);

if (process.env.PROPS_DUMP) fs.writeFileSync(process.env.PROPS_DUMP, JSON.stringify(b));
console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
