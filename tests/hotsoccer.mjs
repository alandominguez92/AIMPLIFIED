// Soccer's Hot players (2026-11-02, the owner's call: each league they follow, from a player's
// previous 5 games, moving to 10). What has to hold:
//   - a player's starts count in every competition; the team he plays is ranked on that league's
//     matches only, so a cup tie lists no one until the cup has 5 matches a team
//   - with 5 to 9 starts he is listed on five or more in a row above last season's average per
//     start. 60+ minutes a start over his last five, 10+ starts last season
//   - a keeper for saves, everyone else for the rest; one team match missed is rotation, two is out
//   - ESPN's soccer scoreboard takes one date, a range is a real 400, so seven leagues' week is
//     49 reads: a few a tick, each once, and the list is built when the last is in
//   - nothing claims a side: this has not been tested in soccer
//   - no call to the odds feed, no page reads a box score, not on the five-minute cron
//
// Real data: every real Premier League line of the 90 matches to Nov 2 2026, the real scoreboards
// of the next week and the real priors. Every run, rank and count is worked out here the long way
// from those rows and held against the real worker on real SQLite.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
const FIX = path.join(BOARD, 'tests', 'fixtures');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const read = (f) => JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));
const LEAGUE = read('soc-box-epl-to-20261102.json'), SLATES = read('espn-soc-slate-20261102.json');
const PRIORS = JSON.parse(fs.readFileSync(path.join(BOARD, 'soccer-priors.json'), 'utf8'));
const ROWS = LEAGUE.rows.map((r) => ({ game_id: LEAGUE.games[r[0]][0], league: 'epl', date: LEAGUE.games[r[0]][1], player_id: LEAGUE.players[r[1]][0], player: LEAGUE.players[r[1]][1], team: r[2], opp: r[3], starter: r[4], min: r[5], gk: r[6], shots: r[7], sot: r[8], passes: r[9], tackles: r[10], clear: r[11], fouls: r[12], saves: r[13] }))
  .sort((a, b) => a.date.localeCompare(b.date) || a.game_id.localeCompare(b.game_id));

const RealDate = Date;
const START = Date.parse('2026-11-02T23:00:00Z');
let NOW = START;
globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } };
const J = (x) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } });
const RANGE_400 = () => new Response('{"code":400,"message":"Failed to get events endpoint."}', { status: 400, headers: { 'content-type': 'application/json' } });

let S = null;
function scene({ rows = ROWS, assets = true } = {}) {
  const sq = new DatabaseSync(':memory:');
  const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
  const sqls = [];
  const exec = (sql, args, mode) => { sqls.push(sql); const st = sq.prepare(sql); const a = args.map(norm);
    if (mode === 'all') return { results: st.all(...a), meta: {} }; if (mode === 'first') return st.get(...a) || null;
    if (/^\s*(SELECT|WITH)/i.test(sql)) return { results: st.all(...a), meta: {} };
    return { success: true, meta: { changes: Number(st.run(...a).changes) } }; };
  const DB = { prepare: (sql) => { const s = { sql, args: [], bind: (...x) => { s.args = x; return s; },
    all: async () => exec(s.sql, s.args, 'all'), first: async (c) => { const r = exec(s.sql, s.args, 'first'); return c && r ? r[c] : r; },
    run: async () => exec(s.sql, s.args, 'run') }; return s; }, batch: async (sts) => sts.map((x) => exec(x.sql, x.args, 'run')) };
  const ASSETS = { fetch: async (req) => (assets && new URL(req.url).pathname === '/soccer-priors.json' ? J(PRIORS) : new Response('nope', { status: 404 })) };
  return { sq, sqls, env: { DB, ASSETS }, rows, oddsCalls: 0, sbCalls: [], ranges: 0 };
}
globalThis.fetch = async (u) => {
  const url = String(u);
  if (/the-odds-api\.com/.test(url)) { S.oddsCalls++; return new Response('{}', { status: 404 }); }
  const sb = url.match(/soccer\/([a-z.]+\.?[a-z0-9]*)\/scoreboard\?dates=([\d-]+)$/);
  if (sb) {
    S.sbCalls.push(`${sb[1]}/${sb[2]}`);
    if (sb[2].includes('-')) { S.ranges++; return RANGE_400(); }
    return J((SLATES[sb[1]] && SLATES[sb[1]][sb[2]]) || { events: [] });
  }
  return new Response('{}', { status: 404 });
};
const src = fs.readFileSync(BOARD + '/worker.js', 'utf8').replace(/\r\n/g, '\n');
let mod = null, scenes = 0;
const loadWorker = async () => { mod = await import('data:text/javascript;base64,' + Buffer.from(`${src}\n// scene ${++scenes}`).toString('base64')); };
const get = async (u) => (await mod.default.fetch(new Request('https://x' + u), S.env, { waitUntil: () => {} })).json();
const cron = async (c) => { const held = []; await mod.default.scheduled({ cron: c, scheduledTime: NOW }, S.env, { waitUntil: (p) => held.push(p) }); await Promise.all(held); };
const tick = () => cron('1-59/2 * * * *');
const COLS = ['game_id', 'league', 'date', 'player_id', 'player', 'team', 'opp', 'starter', 'min', 'gk', 'shots', 'sot', 'passes', 'tackles', 'clear', 'fouls', 'saves'];
const insBox = (rows) => { const ins = S.sq.prepare(`INSERT INTO soc_box (${COLS.join(',')}) VALUES (${COLS.map(() => '?').join(',')})`);
  for (const r of rows) ins.run(...COLS.map((c) => r[c])); };
const hasList = () => !!S.sq.prepare("SELECT 1 AS x FROM feed_cache WHERE key = 'hot_list:soccer'").get();
const fill = async () => { let n = 0; do { await tick(); n++; } while (!hasList() && n < 20); return n; };
// The table comes with the first list, which is empty; then the real rows, and the real one.
const prep = async () => { await loadWorker(); await fill(); S.sq.prepare("DELETE FROM feed_cache WHERE key IN ('hot_list:soccer', 'soc_hot_slate')").run(); S.sbCalls.length = 0; insBox(S.rows); };
const begin = async () => { await prep(); await fill(); };

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

// ---- The long way, from the box rows and last season's per-start numbers --------------------
const MK = ['shots', 'sot', 'passes', 'tackles', 'clear', 'fouls', 'saves'];
const round2 = (v) => Math.round(v * 100) / 100;
const mean = (xs) => xs.reduce((a, x) => a + x, 0) / xs.length;
const statOf = (r, m) => ((m === 'saves') === !!r.gk ? r[m] : null);
function allowedTable(rows, mk) {
  const t = new Map();
  for (const r of rows) { const g = t.get(r.opp) || new Map(); const v = statOf(r, mk); g.set(r.game_id, (g.get(r.game_id) || 0) + (v || 0)); t.set(r.opp, g); }
  return t;
}
function posRange(rows, team, mk, min) {
  const list = [...allowedTable(rows, mk)].filter(([, g]) => g.size >= min).map(([k, g]) => [k, mean([...g.values()])]).sort((a, b) => b[1] - a[1]);
  if (list.length < 14) return null;
  const i = list.findIndex(([k]) => k === team);
  if (i < 0) return null;
  const same = list.map(([, v], j) => (v === list[i][1] ? j + 1 : 0)).filter(Boolean);
  return { lo: same[0], hi: same[same.length - 1], of: list.length };
}
const eplFixtures = Object.values(SLATES['eng.1']).flatMap((d) => d.events).filter((e) => e.status.type.state === 'pre').sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
const sides = (e) => { const c = e.competitions[0].competitors, h = c.find((x) => x.homeAway === 'home').team, a = c.find((x) => x.homeAway === 'away').team; return [[h.abbreviation, a.abbreviation], [a.abbreviation, h.abbreviation]]; };
function expected(rows, fixtures = eplFixtures) {
  const starts = rows.filter((r) => r.starter === 1 && r.min > 0), league = rows.filter((r) => r.league === 'epl');
  const out = [], seen = new Set();
  for (const e of fixtures) for (const [team, opp] of sides(e)) {
    const dates = new Set(starts.filter((r) => r.team === team).map((r) => r.date));
    for (const id of new Set(starts.filter((r) => r.team === team).map((r) => r.player_id))) {
      const gs = starts.filter((r) => r.player_id === id);
      if (gs[gs.length - 1].team !== team || gs.length < 5 || seen.has(id) || !gs.some((r) => r.league === 'epl')) continue;
      if ([...dates].filter((d) => d > gs[gs.length - 1].date).length > 1 || mean(gs.slice(-5).map((r) => r.min)) < 60) continue;
      const pr = PRIORS.players[id];
      let any = false;
      for (const mk of MK) {
        const v = gs.map((r) => statOf(r, mk)).filter((x) => x != null);
        if (v.length < 5 || v.length >= 10 || !pr || pr.starts < 10 || pr[mk] == null) continue;
        let run = 0; for (let j = v.length - 1; j >= 0 && v[j] > pr[mk]; j--) run++;
        const p = posRange(league, opp, mk, 5);
        if (run >= 5 && p) { out.push({ id, mk, run, base: pr[mk], seen: v.length, last5: round2(mean(v.slice(-5))), ...p }); any = true; }
      }
      if (any) seen.add(id);
    }
  }
  return out;
}
const flat = (hot) => hot.players.flatMap((p) => p.markets.map((m) => ({ ...m, id: p.id, name: p.name, team: p.team, league: p.league })));
const key = (x) => `${x.id}|${x.mk || x.market}|${x.run}`;
const same = (hot, want) => JSON.stringify(flat(hot).map(key).sort()) === JSON.stringify(want.map(key).sort());

console.log('-- the slate is read a day at a time --');
S = scene();
await prep();
await tick();
ok(S.ranges === 0, 'never a date range: ESPN answers that with a 400');
ok(S.sbCalls.length === 8 && !hasList(), 'eight reads the first tick, and no list yet');
const firstScan = JSON.parse(S.sq.prepare("SELECT data FROM feed_cache WHERE key = 'soc_hot_slate'").get().data);
ok(firstScan.read === 8 && firstScan.from === '2026-11-02', 'where it got to is kept in a row');
let ticks = 1, most = 8;
while (!hasList() && ticks < 20) { const b = S.sbCalls.length; await tick(); ticks++; most = Math.max(most, S.sbCalls.length - b); }
const WANT_READS = 7 * 7;
ok(hasList() && ticks === 7 && S.sbCalls.length === WANT_READS && most <= 8, `${WANT_READS} reads over ${ticks} ticks, the most in one ${most}: the list built on the last`);
ok(new Set(S.sbCalls).size === WANT_READS, 'each league and day once');
ok(['eng.1', 'esp.1', 'ita.1', 'ger.1', 'usa.1', 'uefa.champions', 'uefa.europa'].every((lg) => S.sbCalls.filter((c) => c.startsWith(lg + '/')).length === 7) && S.sbCalls.includes('eng.1/20261108'), 'all seven leagues, today and the six days after');
const atList = S.sbCalls.length;
NOW += 30 * 60e3; await tick();
ok(S.sbCalls.length === atList, 'half an hour on: no read');
const scans = () => S.sqls.filter((q) => /FROM soc_box WHERE date/.test(q)).length;
const scansThen = scans();
await get('/api/hot-players?sport=soccer');
ok(scans() === scansThen, 'no page reads a box score');
NOW = START + 6 * 3600e3 + 60e3;
await tick();
ok(S.sbCalls.length === atList + 8, 'six hours on: the reads start over');
const shown = (await get('/api/hot-players?sport=soccer')).hot;
ok(shown && shown.players.length > 0, 'and the list it has stays up meanwhile');
let again = 0;
while (S.sq.prepare("SELECT data FROM feed_cache WHERE key = 'soc_hot_slate'").get().data !== '{}' && again < 20) { await tick(); again++; }
ok(S.sbCalls.length === atList + WANT_READS && again === 6 && scans() === scansThen + 1, 'all of them again, and built once');
NOW = START;

console.log('\n-- the coming week, on this season\'s real matches --');
S = scene();
await begin();
let hot = (await get('/api/hot-players?sport=soccer')).hot;
ok(S.oddsCalls === 0, 'not one call to the odds feed');
const teams5 = [...allowedTable(ROWS, 'shots')].filter(([, g]) => g.size >= 5).length, teams10 = [...allowedTable(ROWS, 'shots')].filter(([, g]) => g.size >= 10).length;
ok(hot && hot.ready === true && hot.early === true && hot.gamesNeeded === 5 && hot.teamsReady === teams5 && hot.teamsNeeded === 14 && teams5 === 20 && teams10 < 14, `${teams5} teams at 5 matches, ${teams10} at 10: ranked on 5+`);
const want = expected(ROWS);
console.log(`  ${hot.players.length} players: ${hot.players.map((p) => `${p.name} (${p.team} v ${p.oppNick}) ${p.markets.map((m) => `${m.market} ${m.run}x ${m.third}`).join(', ')}`).join(' | ')}`.slice(0, 1400));
ok(want.length >= 5 && same(hot, want), `every run on the ten Premier League matches, the long way: ${want.length}`);
const wantOf = (x) => want.find((y) => y.id === x.id && y.mk === x.market);
ok(flat(hot).every((x) => { const w = wantOf(x); return w && x.pos >= w.lo && x.pos <= w.hi && x.of === w.of; }), 'and where the team he plays ranks for that stat');
ok(flat(hot).every((x) => { const w = wantOf(x); return x.lastSeason === round2(w.base) && x.seasonAvg === undefined && x.last5 === w.last5 && x.seen === w.seen; }), 'against last season\'s real average, with his last five and how many starts');
ok(flat(hot).every((x) => !('read' in x) && !('line' in x)), 'nothing claims a side, or a number it has not got');
ok(hot.players.every((p) => p.role === null || p.role === undefined), 'no role flag: a start is a start');
ok(flat(hot).every((x) => x.league === 'epl'), 'the cups list no one: no team has 5 matches in them');
ok(hot.players.every((p) => p.name.includes(' ') || p.name.length > 2) && hot.players.every((p) => p.oppNick && p.commence), 'each with who he plays and when');
const gkRows = new Set(ROWS.filter((r) => r.gk).map((r) => r.player_id));
ok(flat(hot).every((x) => (x.market === 'saves') === gkRows.has(x.id)), 'a keeper for saves, everyone else for the rest');
const soft = (p) => (p.markets[0].third === 'soft' ? 1 : 0), best = (p) => Math.max(...p.markets.map((m) => m.run));
ok(hot.players.every((p, i, a) => !i || soft(a[i - 1]) > soft(p) || (soft(a[i - 1]) === soft(p) && best(a[i - 1]) >= best(p))), 'soft teams first, then the longest run');

console.log('\n-- who is not listed --');
const sample = hot.players[0];
const sDates = ROWS.filter((r) => r.player_id === sample.id && r.starter === 1).map((r) => r.date);
const benched = ROWS.map((r) => (r.player_id === sample.id && sDates.slice(-2).includes(r.date) ? { ...r, starter: 0 } : r));
S = scene({ rows: benched });
await begin();
hot = (await get('/api/hot-players?sport=soccer')).hot;
ok(!hot.players.some((p) => p.id === sample.id), `${sample.name} out of the side for his team's last two: left off`);
ok(same(hot, expected(benched)), 'and the rest as the long way has them');
const rotated = ROWS.map((r) => (r.player_id === sample.id && r.date === sDates[sDates.length - 1] ? { ...r, starter: 0 } : r));
S = scene({ rows: rotated });
await begin();
hot = (await get('/api/hot-players?sport=soccer')).hot;
const wantRot = expected(rotated);
ok(same(hot, wantRot), `out for one, on the bench: not held against him as missed, ${wantRot.filter((x) => x.id === sample.id).length} of his runs still stand the long way`);
const short = ROWS.map((r) => (r.player_id === sample.id ? { ...r, min: Math.min(r.min, 59) } : r));
S = scene({ rows: short });
await begin();
hot = (await get('/api/hot-players?sport=soccer')).hot;
ok(!hot.players.some((p) => p.id === sample.id), 'under 60 minutes a start over his last five: left off');
S = scene({ assets: false });
await begin();
hot = (await get('/api/hot-players?sport=soccer')).hot;
ok(hot && hot.ready === true && hot.players.length === 0, 'no last season to hold them to, and none has 10 starts: no one listed');

console.log('\n-- every competition counts for him, one league for the team he plays --');
const allDates = [...new Set(ROWS.map((r) => r.date))].sort();
const round3 = new Set(ROWS.filter((r) => r.date <= allDates[Math.floor(allDates.length / 3)]).map((r) => r.game_id));
const asCup = ROWS.map((r) => (round3.has(r.game_id) ? { ...r, league: 'ucl' } : r));
S = scene({ rows: asCup });
await begin();
hot = (await get('/api/hot-players?sport=soccer')).hot;
const wantCup = expected(asCup);
ok(same(hot, wantCup), `the first third of the matches relabelled a cup's, the same way: ${wantCup.length} runs`);
ok(flat(hot).every((x) => x.league === 'epl'), 'and no one on a cup tie, whose teams are still unranked');
const eplOnlyGames = allowedTable(asCup.filter((r) => r.league === 'epl'), 'shots').get('LEE');
const sumOf = (rows) => [...allowedTable(rows, 'shots').get('LEE').values()].length;
ok(eplOnlyGames.size < sumOf(asCup) && hot.teamsReady === [...allowedTable(asCup.filter((r) => r.league === 'epl'), 'shots')].filter(([, g]) => g.size >= 5).length, 'the ranks use the league\'s own matches');
const old = ROWS.map((r) => ({ ...r, game_id: `old${r.game_id}`, date: `2026-05-${r.date.slice(8)}`.replace(/-(3[1-9]|[4-9]\d)$/, '-30') }));
S = scene({ rows: [...old, ...ROWS].sort((a, b) => a.date.localeCompare(b.date) || a.game_id.localeCompare(b.game_id)) });
await begin();
hot = (await get('/api/hot-players?sport=soccer')).hot;
ok(same(hot, want), 'last spring\'s matches in the same table change nothing: the season starts when it starts');

console.log('\n-- too early --');
const early = ROWS.filter((r) => r.date <= allDates[Math.floor(allDates.length / 4)]);
const earlyTeams = [...allowedTable(early, 'shots')].filter(([, g]) => g.size >= 5).length;
S = scene({ rows: early });
await begin();
hot = (await get('/api/hot-players?sport=soccer')).hot;
ok(earlyTeams < 14 && hot.ready === false && hot.players.length === 0 && hot.teamsNeeded === 14 && hot.teamsReady === earlyTeams, `${earlyTeams} teams with 5 matches, 14 needed: none listed`);
S = scene({ rows: [] });
const hold = SLATES['eng.1'], holdU = SLATES['uefa.champions'];
SLATES['eng.1'] = {}; SLATES['uefa.champions'] = {};
await loadWorker();
await fill();
hot = (await get('/api/hot-players?sport=soccer')).hot;
const readsNone = S.sbCalls.length;
await tick();
ok(hot && hot.players.length === 0 && S.sbCalls.length === readsNone && readsNone === WANT_READS, 'no fixtures anywhere: an empty list, held for six hours like any other');
SLATES['eng.1'] = hold; SLATES['uefa.champions'] = holdU;

console.log('\n-- on its own request budget --');
S = scene();
await loadWorker();
await cron('*/5 * * * *');
const listed = () => S.sq.prepare("SELECT key FROM feed_cache WHERE key IN ('soc_hot_slate', 'hot_list:soccer')").all();
ok(listed().length === 0, 'the five-minute cron does not touch it');
await tick();
ok(listed().some((r) => r.key === 'soc_hot_slate'), 'the two-minute one does');

console.log('\n-- the page --');
S = scene();
await begin();
const payload = (await get('/api/hot-players?sport=soccer')).hot;
const app = fs.readFileSync(BOARD + '/app.js', 'utf8').replace(/\r\n/g, '\n');
const sect = app.slice(app.indexOf('  // ---- Hot players'), app.indexOf('  function renderNba('));
const state = { hot: { soccer: payload }, hotAll: { soccer: true } };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const card = new Function('state', 'esc', 'nbaNick', 'sharpTag', 'avatarHtml', 'soccerKick', 'nbaCardInjTag', `${sect}\nreturn hotCardHtml;`)(
  state, esc, (n) => n, () => '', (o) => `<span class="hs" data-sport="${o.sport}" data-id="${o.playerId}"></span>`, () => 'Sat 7:00 AM', () => '');
let html = card('soccer');
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
console.log(`  ${text(html).slice(0, 900)}`);
ok(/Hot players/.test(html) && /Five or more starts in a row/.test(html) && /with under 10 starts/.test(html) && /Not tested in soccer, so it shows no side/.test(html) && /off Picks and out of the entries/.test(html), 'in starts, and says it is untested and off Picks');
ok(/ranked for that stat on 5\+ games/.test(html), 'the team ranked on its games, not its starts');
ok(/data-sport="soccer"/.test(html), 'each face from the soccer photos');
ok(/ in a row · [\d.]+ last five, [\d.]+ last season/.test(html), 'the run in plain words');
ok(/allow the (\d+\w\w )?(most|fewest) /.test(html) && /(soft|middle|tough) team/.test(html), 'and the team he plays');
ok(!/Lean |Slight |No side:|PP \d/.test(html), 'no side, no number');
ok((html.match(/<li>/g) || []).length === payload.players.length, `the tap: all ${payload.players.length}`);
state.hot.soccer = { ...payload, ready: false, teamsReady: 8, teamsNeeded: 14, gamesNeeded: 5, players: [] };
ok(/Not enough games read yet: opponents are ranked once 14 teams have played 5, and 8 have so far/.test(card('soccer')), 'too early: how far off, in games');
state.hot.soccer = null;
ok(card('soccer') === '', 'no list: no section');
ok(/const props = socPropsCardHtml\(\) \+ hotCardHtml\('soccer'\);/.test(app), 'on the tab, under the props card');
ok(/fetchJson\('\/api\/hot-players\?sport=soccer'\)/.test(app), 'and fetched with it');
ok(/case 'hot-all': \{[\s\S]{0,260}renderSoccer\(\)/.test(app), 'the tap redraws the tab');

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
