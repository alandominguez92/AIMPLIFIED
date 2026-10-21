// Five more soccer markets (2026-10-15): crosses, shots assisted, a
// goalkeeper's goals allowed, fouls drawn, and goal + assist -- PrizePicks
// markets read from the same ESPN per-player statistics the box scores already
// fetch, so they cost no request. (ESPN has no attempted dribbles at all.)
//
// Real SQLite (node:sqlite), the recorded ESPN payloads for Fulham 2,
// Tottenham 1 (tests/fixtures/espn-soc-740870.json) and the real
// soccer-priors.json, rebuilt with the five.
//
// What has to hold:
//   - soc_box gains the five columns forward-only: a table made with the first
//     seven keeps its rows, which carry none of the new stats (NULL, not 0)
//   - each is read from ESPN's own field: totalCrosses, shotAssists,
//     goalsConceded, foulsSuffered, totalGoals + goalAssists
//   - goals allowed is a goalkeeper's market only (every player carries the
//     goals conceded while he was on); outfield players get the other four
//   - a start read before the columns existed does not count as a zero, in a
//     projection or in what an opponent allows; a side's goals conceded is its
//     keeper's, never eleven players' sum
//   - they log, grade and settle an entry leg like the first seven
//   - the priors carry them, and the labels exist wherever a stat is named
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };

const RealDate = Date;
let NOW = RealDate.parse('2026-03-01T23:00:00Z');   // the evening of the recorded match
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
};
const iso = (ms) => new RealDate(ms).toISOString();

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
const PRIORS = fs.readFileSync(path.join(BOARD, 'soccer-priors.json'), 'utf8');
const pri = JSON.parse(PRIORS);
const env = { DB, ASSETS: { fetch: async (r) => (new URL(r.url).pathname === '/soccer-priors.json'
  ? new Response(PRIORS, { status: 200 }) : new Response('{}', { status: 404 })) } };

const REC = JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', 'espn-soc-740870.json'), 'utf8'));
const SUMMARY = Object.entries(REC).find(([u]) => u.includes('/summary'))[1];
const extra = {};
globalThis.fetch = async (u) => {
  const url = String(u);
  const body = extra[url] || REC[url];
  if (body) return new Response(JSON.stringify(body), { status: 200 });
  if (url.includes('/scoreboard?dates=')) return new Response(JSON.stringify({ events: [] }), { status: 200 });
  return new Response('{}', { status: 404 });
};
const src = fs.readFileSync(BOARD + '/worker.js', 'utf8').replace(/\r\n/g, '\n');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const tick = async (cron) => { const held = []; await mod.default.scheduled({ cron }, env, { waitUntil: (p) => held.push(p) }); await Promise.allSettled(held); };
const hit = async (u) => (await mod.default.fetch(new Request('https://x' + u), env, { waitUntil: () => {} })).json();
const NEW = ['crosses', 'shot_ast', 'conceded', 'fouls_drawn', 'goal_ast'];

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

// ---- forward-only ----------------------------------------------------------------------
console.log('-- soc_box grows, forward-only --');
// The table as it was made from 2026-10-09, with a start already read.
sq.exec(`CREATE TABLE soc_box (
    game_id TEXT NOT NULL, league TEXT, date TEXT, player_id TEXT NOT NULL, player TEXT, team TEXT, opp TEXT,
    starter INTEGER, min INTEGER, sub_off INTEGER, gk INTEGER,
    shots INTEGER, sot INTEGER, passes INTEGER, tackles INTEGER, clear INTEGER, fouls INTEGER, saves INTEGER,
    PRIMARY KEY (game_id, player_id))`);
sq.prepare(`INSERT INTO soc_box (game_id, league, date, player_id, player, team, opp, starter, min, sub_off, gk, shots, sot, passes, tackles, clear, fouls, saves)
  VALUES ('OLD1','epl','2026-02-20','999','Old Read','FUL','XXX',1,90,0,0,2,1,40,3,2,1,0)`).run();
await tick('*/5 * * * *');
for (let i = 0; i < 8 && !(sq.prepare("SELECT done FROM soc_box_games WHERE game_id = '740870'").get() || {}).done; i++) await tick('*/5 * * * *');
const cols = sq.prepare('PRAGMA table_info(soc_box)').all().map((c) => c.name);
ok(NEW.every((c) => cols.includes(c)), `the five columns are added to a table made without them (${NEW.filter((c) => cols.includes(c)).join(', ')})`);
const old = sq.prepare("SELECT * FROM soc_box WHERE game_id = 'OLD1'").get();
ok(old && old.shots === 2 && NEW.every((c) => old[c] === null), 'a start read before them keeps its row, with none of the new stats (NULL, not 0)');

// ---- read from ESPN's own fields -------------------------------------------------------
console.log('\n-- read from the recorded statistics --');
const box = sq.prepare("SELECT * FROM soc_box WHERE game_id = '740870'").all();
const v = (cats, c, n) => { const x = cats.find((y) => y.name === c); const s = x && x.stats.find((y) => y.name === n); return s ? Number(s.value) || 0 : 0; };
const want = {};
for (const [u, b] of Object.entries(REC)) {
  const m = /competitors\/\d+\/roster\/(\d+)\/statistics/.exec(u);
  if (!m || !(b && b.splits && b.splits.categories)) continue;
  const c = b.splits.categories;
  want[m[1]] = { crosses: v(c, 'offensive', 'totalCrosses'), shot_ast: v(c, 'offensive', 'shotAssists'), conceded: v(c, 'goalKeeping', 'goalsConceded'),
    fouls_drawn: v(c, 'general', 'foulsSuffered'), goal_ast: v(c, 'offensive', 'totalGoals') + v(c, 'offensive', 'goalAssists') };
}
const mismatched = box.filter((r) => !want[r.player_id] || NEW.some((s) => r[s] !== want[r.player_id][s]));
ok(box.length >= 22 && !mismatched.length, `every player read carries the five, as ESPN wrote them (${box.length} players, ${mismatched.length} off)`);
const by = (name) => box.find((r) => r.player === name) || {};
const top = box.slice().sort((a, b) => b.crosses + b.shot_ast - a.crosses - a.shot_ast)[0];
console.log(`  e.g. ${top.player}: ${top.crosses} crosses, ${top.shot_ast} shots assisted, G+A ${top.goal_ast}; Leno conceded ${by('Bernd Leno').conceded}, Vicario ${by('Guglielmo Vicario').conceded}`);
ok(by('Bernd Leno').conceded === 1 && by('Guglielmo Vicario').conceded === 2 && box.filter((r) => r.goal_ast > 0).length >= 3,
  'Fulham 2, Tottenham 1: Leno allowed 1, Vicario 2, and the scorers and assisters carry goal + assist');

// ---- the card -------------------------------------------------------------------------
console.log('\n-- on the card --');
NOW += 7 * 864e5;
const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new RealDate(NOW)).replace(/-/g, '');
extra[`https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard?dates=${day}`] = { events: [{ id: 'NEXT1', date: iso(NOW + 45 * 60e3),
  status: { type: { state: 'pre', completed: false } },
  competitions: [{ competitors: [{ id: '370', homeAway: 'home', team: { abbreviation: 'FUL', displayName: 'Fulham' } },
    { id: '367', homeAway: 'away', team: { abbreviation: 'TOT', displayName: 'Tottenham Hotspur' } }] }] }] };
extra['https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/summary?event=NEXT1'] = SUMMARY;
// Three starts for Leno read before the columns existed: six saves each, no goals-allowed value.
for (const i of [1, 2, 3]) {
  sq.prepare(`INSERT INTO soc_box (game_id, league, date, player_id, player, team, opp, starter, min, sub_off, gk, shots, sot, passes, tackles, clear, fouls, saves)
    VALUES (?, 'epl', ?, ?, 'Bernd Leno', 'FUL', 'XXX', 1, 90, 0, 1, 0, 0, 30, 0, 1, 0, 6)`).run('PRE' + i, '2026-08-0' + i, String(by('Bernd Leno').player_id));
}
const card = await hit('/api/soccer-props');
const rows = ((card.matches || []).find((m) => m.id === 'NEXT1') || { rows: [] }).rows;
const row = (name, stat) => rows.find((r) => r.player === name && r.stat === stat);
const keepers = ['Bernd Leno', 'Guglielmo Vicario'];
console.log(`  ${rows.length} rows; by stat: ${NEW.map((s) => `${s} ${rows.filter((r) => r.stat === s).length}`).join(', ')}`);
ok(keepers.every((k) => row(k, 'conceded')) && rows.filter((r) => r.stat === 'conceded').every((r) => keepers.includes(r.player)),
  'goals allowed: the two goalkeepers, nobody else');
ok(rows.filter((r) => keepers.includes(r.player)).every((r) => ['saves', 'conceded', 'passes'].includes(r.stat)),
  `a goalkeeper gets saves, goals allowed and passes only (${rows.filter((r) => r.player === 'Bernd Leno').map((r) => r.stat).sort().join(', ')})`);
ok(['crosses', 'shot_ast', 'fouls_drawn', 'goal_ast'].every((s) => rows.filter((r) => r.stat === s).length >= 5 && rows.filter((r) => r.stat === s).every((r) => !keepers.includes(r.player))),
  'outfield starters get crosses, shots assisted, fouls drawn and goal + assist');
// Leno's goals allowed: last season per start, moved half the way by what
// Tottenham score -- the three old starts with no value are not three zeros.
const lenoP = pri.players[String(by('Bernd Leno').player_id)];
const ctxC = pri.teams['eng.1'].TOT.conc.conceded / pri.leagueAvg['eng.1'].conceded;
const wantC = Math.round(lenoP.conceded * (1 + 0.5 * (ctxC - 1)) * 100) / 100;
const lc = row('Bernd Leno', 'conceded'), ls = row('Bernd Leno', 'saves');
ok(lc && lc.proj === wantC && lc.nRecent === 0 && ls && ls.nRecent === 3,
  `Leno allows ${lc && lc.proj} (want ${wantC}: ${lenoP.conceded} a start, Spurs at ${Math.round(ctxC * 100) / 100} of the league); his three old starts count for saves (${ls && ls.nRecent}) and not for goals allowed (${lc && lc.nRecent})`);
ok(rows.filter((r) => NEW.includes(r.stat)).every((r) => r.proj >= { crosses: 0.6, shot_ast: 0.5, conceded: 0.6, fouls_drawn: 0.6, goal_ast: 0.25 }[r.stat]
  && Math.abs(r.pUnder + r.pOver - 100) < 0.2 && r.phi > 0), 'no row below the smallest line posted, and a half-point line splits to 100');
const logged = sq.prepare(`SELECT market, COUNT(*) AS n FROM socprops WHERE game_id = 'NEXT1' GROUP BY market`).all();
ok(NEW.every((s) => (logged.find((x) => x.market === s) || {}).n === rows.filter((r) => r.stat === s).length), 'each is logged with the rest');

// ---- what an opponent allows ----------------------------------------------------------
console.log('\n-- what an opponent allows --');
// Six MLS matches between two clubs: every player carries the goals conceded
// while he was on (11 a side), and one more match was read before the columns.
const mls = (g, d, team, opp, gkConc, cr) => {
  for (let i = 0; i < 11; i++) {
    sq.prepare(`INSERT INTO soc_box (game_id, league, date, player_id, player, team, opp, starter, min, sub_off, gk, shots, sot, passes, tackles, clear, fouls, saves, crosses, shot_ast, conceded, fouls_drawn, goal_ast)
      VALUES (?, 'mls', ?, ?, 'P', ?, ?, 1, 90, 0, ?, 1, 0, 30, 1, 1, 1, 0, ?, 0, ?, 1, 0)`).run(g, d, `${team}${i}`, team, opp, i === 0 ? 1 : 0, cr, gkConc);
  }
};
for (let g = 1; g <= 6; g++) { mls('M' + g, `2026-02-1${g}`, 'AAA', 'BBB', 1, 1); mls('M' + g, `2026-02-1${g}`, 'BBB', 'AAA', 3, 2); }
for (const [team, opp] of [['AAA', 'BBB'], ['BBB', 'AAA']]) for (let i = 0; i < 11; i++) {
  sq.prepare(`INSERT INTO soc_box (game_id, league, date, player_id, player, team, opp, starter, min, sub_off, gk, shots, sot, passes, tackles, clear, fouls, saves)
    VALUES ('M0', 'mls', '2026-02-01', ?, 'P', ?, ?, 1, 90, 0, ?, 1, 0, 30, 1, 1, 1, 0)`).run(`${team}${i}`, team, opp, i === 0 ? 1 : 0);
}
sq.prepare("DELETE FROM feed_cache WHERE key = 'soc_ctx'").run();
NOW += 60e3;
await hit('/api/soccer-props?summary=1');
const ctx = JSON.parse(sq.prepare("SELECT data FROM feed_cache WHERE key = 'soc_ctx'").get().data).mls || {};
console.log(`  AAA allows: conceded ${ctx.AAA && ctx.AAA.conceded}, crosses ${ctx.AAA && ctx.AAA.crosses}, shots ${ctx.AAA && ctx.AAA.shots}`);
ok(ctx.AAA && ctx.AAA.conceded === 3 && ctx.BBB && ctx.BBB.conceded === 1,
  'a side\'s goals conceded is its keeper\'s: AAA\'s opponents\' keeper let in 3 a game, not 33');
ok(ctx.AAA.crosses === 22 && ctx.AAA.shots === 11,
  `a match read before the columns is no game of zero crosses (22 a game over six, not ${Math.round(22 * 6 / 7 * 10) / 10} over seven), while it still counts for shots`);

// The league's average is taken over the clubs that have the stat: seven
// Premier League clubs a round each, and every match of one of them (ZZZ) read
// before the columns -- so ZZZ allows no crosses at all, rather than none.
const clubs = ['TOT', 'FUL', 'AAA', 'BBB', 'CCC', 'DDD', 'ZZZ'];
let gi = 0;
for (let i = 0; i < clubs.length; i++) for (let j = i + 1; j < clubs.length; j++) {
  const gid = 'E' + (++gi), d = `2026-08-${String(gi).padStart(2, '0')}`, pre = clubs[i] === 'ZZZ' || clubs[j] === 'ZZZ';
  for (const [team, opp] of [[clubs[i], clubs[j]], [clubs[j], clubs[i]]]) {
    const cr = pre ? null : 2 + clubs.indexOf(team);   // each club crosses at its own rate
    sq.prepare(`INSERT INTO soc_box (game_id, league, date, player_id, player, team, opp, starter, min, sub_off, gk, shots, sot, passes, tackles, clear, fouls, saves, crosses)
      VALUES (?, 'epl', ?, ?, 'P', ?, ?, 1, 90, 0, 0, 1, 0, 30, 1, 1, 1, 0, ?)`).run(gid, d, `${team}-x`, team, opp, cr);
  }
}
sq.prepare("DELETE FROM feed_cache WHERE key = 'soc_ctx'").run();
NOW += 60e3;
const card2 = await hit('/api/soccer-props');
const epl = JSON.parse(sq.prepare("SELECT data FROM feed_cache WHERE key = 'soc_ctx'").get().data).epl || {};
const have = Object.values(epl).filter((c) => c.crosses != null);
const xFul = ((card2.matches || []).find((m) => m.id === 'NEXT1') || { rows: [] }).rows.find((r) => r.stat === 'crosses' && r.opp === 'TOT');
const wantX = epl.TOT && Math.round(epl.TOT.crosses / (have.reduce((a, c) => a + c.crosses, 0) / have.length) * 100) / 100;
ok(Object.keys(epl).length === 7 && epl.ZZZ && epl.ZZZ.crosses === null && have.length === 6 && xFul && xFul.ctx === wantX,
  `the league's crosses are averaged over the six clubs that have them: Spurs at ${wantX} of it (${xFul && xFul.player}'s row says ${xFul && xFul.ctx})`);

// ---- graded, and an entry leg ---------------------------------------------------------
console.log('\n-- graded --');
const lr = sq.prepare("SELECT * FROM socprops WHERE game_id = 'NEXT1' AND market = 'conceded' AND player = 'Bernd Leno'").get();
const xr = sq.prepare("SELECT * FROM socprops WHERE game_id = 'NEXT1' AND market = 'crosses' ORDER BY line DESC LIMIT 1").get();
sq.prepare("INSERT INTO soc_box_games (game_id, league, date, home, away, home_cid, away_cid, done, tries) VALUES ('NEXT1','epl',?,'FUL','TOT','370','367',1,1)").run(lr.date);
const put = (r, vals) => sq.prepare(`INSERT INTO soc_box (game_id, league, date, player_id, player, team, opp, starter, min, sub_off, gk, shots, sot, passes, tackles, clear, fouls, saves, crosses, shot_ast, conceded, fouls_drawn, goal_ast)
  VALUES ('NEXT1','epl',?,?,?,?,?,1,90,0,?,0,0,20,0,0,0,0,?,0,?,0,0)`).run(lr.date, r.player_id, r.player, r.team, r.opp, r.market === 'conceded' ? 1 : 0, vals.crosses || 0, vals.conceded || 0);
put(lr, { conceded: Math.ceil(lr.line) });
put(xr, { crosses: 0 });
NOW += 4 * 3600e3;
await tick('2-59/5 * * * *');
const g = (r) => sq.prepare('SELECT result, actual FROM socprops WHERE game_id = ? AND player_id = ? AND market = ?').get('NEXT1', r.player_id, r.market);
ok(g(lr).result === 'over' && g(lr).actual === Math.ceil(lr.line) && g(xr).result === 'under' && g(xr).actual === 0,
  `graded from the box score like the rest: Leno ${g(lr).actual} allowed at ${lr.line} (${g(lr).result}), ${xr.player} 0 crosses at ${xr.line} (${g(xr).result})`);
const KEY = 'phone-key-0123456789abcdef';
const entries = async (method, body) => (await mod.default.fetch(new Request('https://x/api/entries', { method,
  headers: { 'content-type': 'application/json', 'x-entry-key': KEY }, body: body ? JSON.stringify(body) : undefined }), env, { waitUntil: () => {} })).json();
const made = await entries('POST', { action: 'create', entry: { book: 'pp', kind: 'power', stake: 5, legs: [
  { sport: 'soccer', date: lr.date, gamePk: 'NEXT1', playerId: Number(lr.player_id), player: lr.player, market: 'conceded', line: lr.line, side: 'Under' },
  { sport: 'soccer', date: xr.date, gamePk: 'NEXT1', playerId: Number(xr.player_id), player: xr.player, market: 'crosses', line: 0.5, side: 'Under' }] } });
await entries('GET');
const el = sq.prepare('SELECT market, result, actual FROM entry_legs WHERE entry_id = ? ORDER BY idx').all(made.id);
ok(el.length === 2 && el[0].result === 'loss' && el[1].result === 'win', `an entry leg on either settles itself (${el.map((x) => `${x.market} ${x.result}`).join(', ')})`);
const sm = await hit('/api/soccer-props?summary=1');
ok(sm.record && sm.record.byMarket && NEW.every((s) => sm.record.byMarket[s]) && sm.record.byMarket.conceded.n === 1, 'and the record keeps them by stat');

// ---- priors and labels ----------------------------------------------------------------
console.log('\n-- priors and labels --');
const players = Object.values(pri.players);
const withAll = players.filter((p) => NEW.every((s) => typeof p[s] === 'number')).length;
ok(withAll === players.length, `every player in the priors carries the five (${withAll} of ${players.length})`);
const lgC = Object.entries(pri.leagueAvg).map(([k, a]) => `${k} ${a.conceded}`);
ok(Object.values(pri.leagueAvg).every((a) => a.conceded > 0.9 && a.conceded < 2.2) && Object.values(pri.teams['eng.1']).every((t) => t.conc.conceded < 3.5),
  `a league's goals conceded per side is a score, not eleven players' sum (${lgC.join(', ')})`);
const keeperC = players.filter((p) => p.gk && p.starts >= 10).map((p) => p.conceded);
ok(keeperC.length > 50 && keeperC.every((c) => c > 0.3 && c < 3), `goalkeepers allow between 0.3 and 3 a start (${keeperC.length} with 10+ starts)`);
const app = fs.readFileSync(BOARD + '/app.js', 'utf8').replace(/\r\n/g, '\n');
const keysOf = (name, text) => { const m = new RegExp(`const ${name} = \\{([\\s\\S]*?)\\};`).exec(text); return m ? [...m[1].matchAll(/(\w+):\s*'/g)].map((x) => x[1]) : []; };
const stats = (/const SOC_PROP_STATS = \[([^\]]*)\]/.exec(src) || [])[1].match(/'(\w+)'/g).map((x) => x.slice(1, -1));
// (SOC_SHORT went with the abbreviations on 2026-10-21: the card is in plain words.)
const missing = ['SOC_STAT', 'MARKET_SHORT'].map((n) => [n, stats.filter((s) => !keysOf(n, app).includes(s))])
  .concat([['ENTRY_MARKET_LABEL', stats.filter((s) => !keysOf('ENTRY_MARKET_LABEL', src).includes(s))]]).filter(([, l]) => l.length);
ok(stats.length === 12 && !missing.length, `every stat the worker logs has a label on the card, the slip and the entries record${missing.length ? ' -- MISSING ' + JSON.stringify(missing) : ''}`);

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
