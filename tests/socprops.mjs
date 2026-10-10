// Soccer player props (2026-10-10): box scores in, starters projected, the
// chance at the user's line, logged and graded.
//
// Real SQLite (node:sqlite) and real ESPN payloads: tests/fixtures/
// espn-soc-740870.json is every response the pipeline reads for Fulham 2,
// Tottenham 1 (2026-03-01) -- the scoreboard, the summary with both lineups,
// each club's match roster and each player's full statistics. The priors are
// the real soccer-priors.json.
//
// What has to hold:
//   - the soccer cron runs on its own trigger; one tick finds finished
//     matches, the next reads one box score: passes and tackles per player,
//     which no match-level feed carries
//   - only starters project, once both lineups are posted; a goalkeeper gets
//     saves and passes, an outfield player everything but saves
//   - a projection is last season per start blended with this season's starts,
//     moved half the way by what the opponent allows
//   - the model's own row is logged once, at the line it showed, and graded
//     under / over / push, void for a starter who never appeared
//   - a starred leg in an entry grades from the same box score at the user's line
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

// ---- the feeds ------------------------------------------------------------------------
const REC = JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', 'espn-soc-740870.json'), 'utf8'));
const SUMMARY = Object.entries(REC).find(([u]) => u.includes('/summary'))[1];
const extra = {};   // responses a step adds: an upcoming fixture and its lineup
let calls = 0;
globalThis.fetch = async (u) => {
  const url = String(u);
  calls++;
  const body = extra[url] || REC[url];
  if (body) return new Response(JSON.stringify(body), { status: 200 });
  if (url.includes('/scoreboard?dates=')) return new Response(JSON.stringify({ events: [] }), { status: 200 });
  return new Response('{}', { status: 404 });
};
const src = fs.readFileSync(BOARD + '/worker.js', 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const socTick = async () => { const held = []; await mod.default.scheduled({ cron: '2-59/5 * * * *' }, env, { waitUntil: (p) => held.push(p) }); await Promise.allSettled(held); };
const mainTick = async () => { const held = []; await mod.default.scheduled({ cron: '*/5 * * * *' }, env, { waitUntil: (p) => held.push(p) }); await Promise.allSettled(held); };
const hit = async (u) => (await mod.default.fetch(new Request('https://x' + u), env, { waitUntil: () => {} })).json();

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

// ---- box scores ----------------------------------------------------------------------
console.log('-- box scores in --');
await socTick();
const g0 = sq.prepare('SELECT * FROM soc_box_games').all();
ok(g0.length === 1 && g0[0].game_id === '740870' && g0[0].home === 'FUL' && g0[0].done === 0,
  `the first tick finds the finished match and queues it (${g0.map((g) => g.game_id + ' ' + g.away + '@' + g.home).join(', ')})`);
ok(sq.prepare('SELECT COUNT(*) AS n FROM soc_box').get().n === 0, 'and reads no box score on the same tick');
calls = 0;
await socTick();
const box = sq.prepare('SELECT * FROM soc_box').all();
const b = (name) => box.find((r) => r.player === name) || {};
console.log(`  read ${box.length} players with ${calls} requests`);
ok(sq.prepare('SELECT done FROM soc_box_games').get().done === 1 && box.length >= 22, `the next tick reads every player who appeared (${box.length})`);
ok(calls <= 40, `inside one invocation's request budget (${calls} requests)`);
const leno = b('Bernd Leno');
ok(leno.gk === 1 && leno.starter === 1 && leno.min === 90, 'a goalkeeper is marked, with his minutes');
const pass = box.filter((r) => r.passes > 0).length, tack = box.filter((r) => r.tackles > 0).length;
ok(pass >= 20 && tack >= 8, `passes and tackles come through per player (${pass} with passes, ${tack} with tackles)`);
const subbed = box.filter((r) => r.sub_off === 1);
ok(subbed.length >= 3 && subbed.every((r) => r.min < 90), `a starter taken off carries his shorter minutes (${subbed.map((r) => r.player + ' ' + r.min).join(', ')})`);

// ---- the card ------------------------------------------------------------------------
console.log('\n-- the card --');
// A week on: the same two clubs again, kicking off in 45 minutes with both
// lineups posted (the recorded summary's), and a second fixture later in the day.
NOW += 7 * 864e5;
const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new RealDate(NOW)).replace(/-/g, '');
const ev = (id, mins, home, away) => ({ id, date: iso(NOW + mins * 60e3), status: { type: { state: 'pre', completed: false } },
  competitions: [{ competitors: [{ id: '370', homeAway: 'home', team: { abbreviation: home, displayName: home } }, { id: '367', homeAway: 'away', team: { abbreviation: away, displayName: away } }] }] });
extra[`https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard?dates=${day}`] = { events: [ev('NEXT1', 45, 'FUL', 'TOT'), ev('NEXT2', 300, 'TOT', 'FUL')] };
extra['https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/summary?event=NEXT1'] = SUMMARY;
const card = await hit('/api/soccer-props');
const m1 = (card.matches || []).find((m) => m.id === 'NEXT1') || {}, m2 = (card.matches || []).find((m) => m.id === 'NEXT2') || {};
console.log(`  ${(card.matches || []).length} fixtures; NEXT1 ${m1.lineup} with ${(m1.rows || []).length} rows; NEXT2 ${m2.lineup}` + (card.error ? ' ERROR ' + card.error : ''));
ok(m1.lineup === 'posted' && m1.rows.length > 30 && m2.lineup === 'waiting' && !(m2.rows || []).length,
  'the match inside the lineup window is projected; the one five hours out waits for its lineups');
const rows = m1.rows || [];
const row = (name, stat) => rows.find((r) => r.player === name && r.stat === stat);
const starters = SUMMARY.rosters.flatMap((t) => t.roster.filter((p) => p.starter).map((p) => p.athlete.displayName));
ok(rows.every((r) => starters.includes(r.player)), 'only starters have rows');
const lenoRows = rows.filter((r) => r.player === 'Bernd Leno').map((r) => r.stat).sort();
ok(lenoRows.join(',') === 'passes,saves' && !rows.some((r) => r.stat === 'saves' && r.player !== 'Bernd Leno' && r.player !== 'Guglielmo Vicario'),
  `a goalkeeper gets saves and passes, nobody else gets saves (${lenoRows.join(', ')})`);
// The projection is last season per start (this season has no starts for them
// yet), moved half the way by what the opponent allowed last season.
const lenoP = pri.players[SUMMARY.rosters.find((t) => t.team.abbreviation === 'FUL').roster.find((p) => p.athlete.displayName === 'Bernd Leno').athlete.id];
const totConc = pri.teams['eng.1'].TOT.conc.saves, lgSaves = pri.leagueAvg['eng.1'].saves;
const want = Math.round(lenoP.saves * (1 + 0.5 * (totConc / lgSaves - 1)) * 100) / 100;
const ls = row('Bernd Leno', 'saves');
ok(ls && ls.proj === want && ls.line === Math.floor(want) + 0.5 && ls.ctx === Math.round(totConc / lgSaves * 100) / 100,
  `Leno's saves: ${lenoP.saves} a start last season, Tottenham's attack at ${ls && ls.ctx} of the league's, projects ${ls && ls.proj} (want ${want}), line ${ls && ls.line}`);
ok(ls && Math.abs(ls.pUnder + ls.pOver - 100) < 0.2 && ls.phi === 1.3, 'at a half-point line the two sides add to 100');
ok(rows.every((r) => r.proj >= { shots: 0.6, sot: 0.4, passes: 12, tackles: 0.8, clear: 0.8, fouls: 0.6, saves: 0.5 }[r.stat]),
  'no row below the smallest line anyone posts');
const logged = sq.prepare('SELECT COUNT(*) AS n FROM socprops').get().n;
ok(logged === rows.length, `every row is logged once its lineup is seen (${logged})`);
await hit('/api/soccer-props');
ok(sq.prepare('SELECT COUNT(*) AS n FROM socprops').get().n === logged, 'and a second read does not log it again');

// This season's starts move the projection: three for Leno at 6 saves each.
for (const [i, sv] of [6, 6, 6].entries()) {
  sq.prepare(`INSERT INTO soc_box (game_id, league, date, player_id, player, team, opp, starter, min, sub_off, gk, shots, sot, passes, tackles, clear, fouls, saves)
    VALUES (?, 'epl', ?, ?, 'Bernd Leno', 'FUL', 'XXX', 1, 90, 0, 1, 0, 0, 30, 0, 1, 0, ?)`).run('S' + i, '2026-08-0' + (i + 1), String(ls.id), sv);
}
sq.prepare("DELETE FROM feed_cache WHERE key LIKE 'soc_ctx%'").run();
NOW += 60e3;
const card2 = await hit('/api/soccer-props');
const ls2 = ((card2.matches || []).find((m) => m.id === 'NEXT1') || { rows: [] }).rows.find((r) => r.player === 'Bernd Leno' && r.stat === 'saves');
const k = Math.min(5, lenoP.starts);
const base2 = (18 + k * lenoP.saves) / (3 + k);
const want2 = Math.round(base2 * (1 + 0.5 * (totConc / lgSaves - 1)) * 100) / 100;
ok(ls2 && ls2.nRecent === 3 && ls2.proj === want2, `three starts this season at 6 blend with last season's ${lenoP.saves} as ${k} starts' worth: ${ls2 && ls2.proj} (want ${want2})`);

// ---- graded --------------------------------------------------------------------------
console.log('\n-- graded --');
// NEXT1 is played: two starters' lines, and one starter who never appears.
const lr = sq.prepare("SELECT * FROM socprops WHERE game_id = 'NEXT1' AND market = 'saves' AND player = 'Bernd Leno'").get();
const pr = sq.prepare("SELECT * FROM socprops WHERE game_id = 'NEXT1' AND market = 'passes' AND player = 'Bernd Leno'").get();
const gone = sq.prepare("SELECT * FROM socprops WHERE game_id = 'NEXT1' AND player = 'Raúl Jiménez' LIMIT 1").get();
sq.prepare("INSERT INTO soc_box_games (game_id, league, date, home, away, home_cid, away_cid, done, tries) VALUES ('NEXT1','epl',?, 'FUL','TOT','370','367',1,1)").run(lr.date);
sq.prepare(`INSERT INTO soc_box (game_id, league, date, player_id, player, team, opp, starter, min, sub_off, gk, shots, sot, passes, tackles, clear, fouls, saves)
  VALUES ('NEXT1','epl',?,?,'Bernd Leno','FUL','TOT',1,90,0,1,0,0,?,0,0,0,?)`).run(lr.date, lr.player_id, Math.ceil(pr.line) + 3, Math.floor(lr.line) - 1);
await socTick();
const after = (q) => sq.prepare(`SELECT result, actual FROM socprops WHERE game_id = 'NEXT1' AND ${q}`).get();
ok(after("player = 'Bernd Leno' AND market = 'saves'").result === 'under', `Leno's saves below the line: an under (${JSON.stringify(after("player = 'Bernd Leno' AND market = 'saves'"))})`);
ok(after("player = 'Bernd Leno' AND market = 'passes'").result === 'over', 'his passes above it: an over');
ok(gone && after(`player = 'Raúl Jiménez' AND market = '${gone.market}'`).result === 'void', 'a starter missing from the read box score is void, never a free under');
const r3 = (await hit('/api/soccer-props')).record;
ok(r3 && r3.graded === 2 && r3.byMarket.saves.n === 1, `the record counts what graded, by market (${JSON.stringify(r3 && r3.byMarket && { saves: r3.byMarket.saves, passes: r3.byMarket.passes })})`);

// ---- your entries ----------------------------------------------------------------------
console.log('\n-- an entry with soccer props --');
const KEY = 'phone-key-0123456789abcdef';
const entries = async (method, body) => (await mod.default.fetch(new Request('https://x/api/entries', { method,
  headers: { 'content-type': 'application/json', 'x-entry-key': KEY }, body: body ? JSON.stringify(body) : undefined }), env, { waitUntil: () => {} })).json();
const leg = (market, line, side, playerId, player) => ({ sport: 'soccer', date: lr.date, gamePk: 'NEXT1', playerId: Number(playerId), player, team: 'FUL', market, line, side });
const made = await entries('POST', { action: 'create', entry: { book: 'pp', kind: 'power', stake: 10, legs: [
  leg('saves', 3, 'Over', lr.player_id, 'Bernd Leno'), leg('passes', pr.line, 'Over', lr.player_id, 'Bernd Leno')] } });
await mainTick();
await entries('GET');
const el = sq.prepare('SELECT market, line, side, result, actual FROM entry_legs WHERE entry_id = ? ORDER BY idx').all(made.id);
console.log('  ' + el.map((x) => `${x.market} ${x.side} ${x.line} -> ${x.result} (${x.actual})`).join(' | '));
const savesActual = Math.floor(lr.line) - 1;
ok(el[0] && el[0].result === (savesActual > 3 ? 'win' : savesActual === 3 ? 'push' : 'loss') && el[1] && el[1].result === 'win',
  'a starred leg grades at the line the user played, from the same box score (a whole-number line can push)');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
