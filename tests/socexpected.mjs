// Expected starters on the soccer card, before a lineup posts (2026-11-05).
//
// The card showed nobody until ESPN posted a lineup, about an hour out, which for a
// Saturday's early kickoff is 3:30 in the morning in California. The owner asked for
// it earlier. Two seasons of box scores said who can be shown: a player who started 5
// of his club's last 5 started the next match 85-86% of the time (81% in the European
// cups), 4 of 5 70-72% (67%), 3 of 5 56%. A guessed whole eleven got 8 right. So the
// regulars are shown, and no one else. What has to hold:
//   - two days ahead, not fourteen hours, and only the regulars of each club's last
//     five whole matches, across its league and the cups
//   - a club with under five matches, or none lately, waits for its lineup
//   - the reading happens on a trigger, a few matches a tick, and is kept: the page
//     only reads what's stored, and asks for it (Picks doesn't carry the weight)
//   - nothing is logged until a real lineup posts, so the record is starters only
//   - a line can be set on an expected row, and counts only if he starts: a late sub,
//     or a player who never appears, is void
//   - the real lineup replaces the guess, and a starred leg who isn't in it is called
//     out on the slip
//
// Real data: Fulham 2, Tottenham 1 on Mar 1, 2026 (tests/fixtures/espn-soc-740870.json,
// every response the pipeline reads, both real lineups) and the sixteen matches of
// theirs before it (tests/fixtures/soc-expected-ful-tot.json). The guess had 13
// regulars and 11 started: Joachim Andersen wasn't in the squad, and Pape Matar Sarr
// came on from the bench. Real SQLite, the real worker, the real soccer-priors.json.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const KICK = Date.parse('2026-03-01T14:00:00Z');
let NOW = KICK - 30 * 3600e3;
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
};

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

// ---- the database ----------------------------------------------------------------------
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
const env = { DB, ASSETS: { fetch: async (r) => (new URL(r.url).pathname === '/soccer-priors.json'
  ? new Response(PRIORS, { status: 200 }) : new Response('{}', { status: 404 })) } };

// ---- the feeds -------------------------------------------------------------------------
const REC = JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', 'espn-soc-740870.json'), 'utf8'));
const { games: PAST } = JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', 'soc-expected-ful-tot.json'), 'utf8'));
const SB_URL = Object.keys(REC).find((u) => u.includes('/scoreboard'));
const SUM_URL = Object.keys(REC).find((u) => u.includes('/summary'));
const realSb = REC[SB_URL];
const preSb = (events) => ({ ...realSb, events: events.map((e) => ({ ...e, status: { ...e.status, type: { ...e.status.type, state: 'pre', completed: false } } })) });
let sbNow = preSb(realSb.events);       // the fixture before it's played
let lineupUp = false;
let summaryReads = 0;
globalThis.fetch = async (u) => {
  const url = String(u);
  if (url === SB_URL) return new Response(JSON.stringify(sbNow), { status: 200 });
  if (url === SUM_URL) {
    summaryReads++;
    if (!lineupUp) return new Response(JSON.stringify({ ...REC[SUM_URL], rosters: [] }), { status: 200 });
    return new Response(JSON.stringify(REC[SUM_URL]), { status: 200 });
  }
  if (REC[url]) return new Response(JSON.stringify(REC[url]), { status: 200 });
  if (url.includes('/scoreboard')) return new Response(JSON.stringify({ events: [] }), { status: 200 });
  return new Response('{}', { status: 404 });
};
const src = fs.readFileSync(BOARD + '/worker.js', 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const ctx = { waitUntil: () => {} };
const hit = async (u) => (await mod.default.fetch(new Request('https://x' + u), env, ctx)).json();
const tick = async (cron) => { const held = []; await mod.default.scheduled({ cron }, env, { waitUntil: (p) => held.push(p) }); await Promise.allSettled(held); };
const histTick = () => tick('1-59/2 * * * *');
const boxTick = () => tick('2-59/5 * * * *');
const KEY = 'phone-key-0123456789abcdef';
const lines = async (method, body) => {
  const r = await mod.default.fetch(new Request('https://x/api/soc-lines', { method, headers: { 'content-type': 'application/json', 'x-entry-key': KEY }, body: body ? JSON.stringify(body) : undefined }), env, ctx);
  return { status: r.status, body: await r.json() };
};

// The tables, by a first read, then the real past matches into them.
await hit('/api/soccer-props');
const ptDay = (iso) => new RealDate(Date.parse(iso) - 8 * 3600e3).toISOString().slice(0, 10);
function seed() {
  sq.exec('DELETE FROM soc_box; DELETE FROM soc_box_games; DELETE FROM socprops; DELETE FROM soc_pp_lines;');
  sq.exec("DELETE FROM feed_cache WHERE key LIKE 'soc_exp%'");
  const ins = sq.prepare('INSERT OR IGNORE INTO soc_box_games (game_id, league, date, home, away, home_cid, away_cid, done, tries) VALUES (?,?,?,?,?,?,?,1,0)');
  const box = sq.prepare('INSERT OR IGNORE INTO soc_box (game_id, league, date, player_id, player, team, opp, starter, min, gk, shots, sot, fouls, saves) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  for (const g of PAST) {
    const lg = g.slug === 'eng.1' ? 'epl' : g.slug === 'uefa.champions' ? 'ucl' : 'uel';
    ins.run(g.id, lg, ptDay(g.date), g.home, g.away, g.home_cid, g.away_cid);
    for (const r of g.rows) box.run(g.id, lg, ptDay(g.date), r.player_id, r.player, r.team, r.opp, r.starter, r.min, r.gk, r.shots, r.sot, r.fouls, r.saves);
  }
}
seed();

// The regulars, worked out here from the same matches, not by the worker's code.
function regulars(team, skip = () => false) {
  const mine = PAST.filter((g) => [g.home, g.away].includes(team)).sort((a, b) => (a.date < b.date ? 1 : -1))
    .filter((g) => !skip(g) && g.rows.filter((r) => r.team === team && r.starter === 1).length === 11).slice(0, 5);
  const n = new Map();
  for (const g of mine) for (const r of g.rows) if (r.team === team && r.starter === 1) n.set(r.player, (n.get(r.player) || 0) + 1);
  return new Map([...n].filter(([, k]) => k >= 4));
}
const FUL = regulars('FUL'), TOT = regulars('TOT');
const playersOf = (m) => new Set((m.rows || []).map((r) => r.player));
const FIX = '740870';
const fixOf = (b) => (b.matches || []).find((m) => m.id === FIX);
const stored = () => sq.prepare("SELECT COUNT(*) AS n FROM feed_cache WHERE key LIKE 'soc_exp:%'").get().n;
const afterGate = () => { NOW += 5 * 60e3 + 1000; };

console.log('\n-- the real regulars, from the sixteen matches --');
ok(FUL.size === 7 && [...FUL.keys()].includes('Joachim Andersen'), `Fulham, 4 or 5 of the last 5: ${[...FUL].map(([p, k]) => `${p} ${k}`).join(', ')}`);
ok(TOT.size === 6 && TOT.get('Pape Matar Sarr') === 4, `Tottenham: ${[...TOT].map(([p, k]) => `${p} ${k}`).join(', ')}`);

console.log('\n-- two days ahead --');
NOW = KICK - 49 * 3600e3;
let b = await hit('/api/soccer-props?expected=1');
ok(!fixOf(b), '49 hours out: not on the card');
NOW = KICK - 47 * 3600e3;
sq.exec("DELETE FROM feed_cache WHERE key LIKE 'soc_fix:%'");
b = await hit('/api/soccer-props?expected=1');
ok(fixOf(b) && fixOf(b).lineup === 'waiting', '47 hours out: on the card, waiting');

console.log('\n-- the page only reads what is stored --');
summaryReads = 0;
ok(!(fixOf(b).rows || []).length && stored() === 0, 'nothing worked out on a page read');
ok(summaryReads === 0, 'and no lineup looked for this far out');

console.log('\n-- a tick works it out --');
await histTick();
ok(stored() === 1, 'the two-minute trigger stores the match');
b = await hit('/api/soccer-props?expected=1');
let m = fixOf(b);
ok(m.lineup === 'expected', `the card reads it as expected (${m.lineup})`);
const got = playersOf(m);
const want = new Set([...FUL.keys(), ...TOT.keys()]);
ok([...got].every((p) => want.has(p)), `only regulars listed: ${[...got].join(', ')}`);
ok(got.size >= 10 && ['Bernd Leno', 'Alex Iwobi', 'Guglielmo Vicario', 'Conor Gallagher', 'Pape Matar Sarr', 'Joachim Andersen'].every((p) => got.has(p)), `${got.size} of the ${want.size} have a projection, the two who won't start among them`);
ok(!got.has('Dominic Solanke') && !got.has('Ryan Sessegnon'), 'not Solanke or Sessegnon, 3 of the last 5 (who did start: the rule misses some)');
const rowOf = (mm, player, stat) => (mm.rows || []).find((r) => r.player === player && (!stat || r.stat === stat));
ok(rowOf(m, 'Bernd Leno').expected === 5 && rowOf(m, 'Pape Matar Sarr').expected === 4, 'each row says how many of 5: Leno 5, Sarr 4');
ok(rowOf(m, 'Alex Iwobi').team === 'FUL' && rowOf(m, 'Alex Iwobi').opp === 'TOT', 'Iwobi of Fulham, against Tottenham');
ok(typeof rowOf(m, 'Alex Iwobi').proj === 'number' && typeof rowOf(m, 'Alex Iwobi').pUnder === 'number', 'priced the way a starter is');

console.log('\n-- nothing goes on the record --');
ok(sq.prepare('SELECT COUNT(*) AS n FROM socprops').get().n === 0, 'no row logged for an expected player');

console.log('\n-- Picks does not carry the weight --');
const plain = fixOf(await hit('/api/soccer-props'));
ok(plain.lineup === 'waiting' && !(plain.rows || []).length, 'without ?expected=1: waiting, no rows');
const sum = fixOf(await hit('/api/soccer-props?summary=1'));
ok(sum.lineup === 'waiting' && sum.rows === 0, 'and the summary the same');
const kb = (o) => Math.round(JSON.stringify(o).length / 1024);
console.log(`        this one match: ${kb(m)}KB as JSON`);

console.log('\n-- a line on an expected row --');
const iwobi = rowOf(m, 'Alex Iwobi', 'shots');
const sarr = rowOf(m, 'Pape Matar Sarr', 'shots') || rowOf(m, 'Pape Matar Sarr');
const anders = rowOf(m, 'Joachim Andersen');
let r = await lines('POST', { gameId: FIX, playerId: iwobi.id, stat: iwobi.stat, line: 1.5, proj: iwobi.proj });
ok(r.status === 200 && r.body.ok, `Iwobi, ${iwobi.stat} 1.5: saved (${r.status} ${JSON.stringify(r.body).slice(0, 70)})`);
const saved = sq.prepare('SELECT * FROM soc_pp_lines WHERE player_id = ?').get(iwobi.id);
ok(saved && saved.player === 'Alex Iwobi' && saved.team === 'FUL' && saved.league === 'epl' && saved.date === '2026-03-01' && saved.line === 1.5, 'stored with the match and the player');
ok(saved && saved.default_line === iwobi.line && saved.proj === iwobi.proj, 'at the projection the card showed');
const smith = rowOf(m, 'Emile Smith Rowe', 'shots') || rowOf(m, 'Emile Smith Rowe');
r = await lines('POST', { gameId: FIX, playerId: sarr.id, stat: sarr.stat, line: sarr.line, proj: sarr.proj });
ok(r.status === 200, 'Sarr too');
r = await lines('POST', { gameId: FIX, playerId: anders.id, stat: anders.stat, line: anders.line, proj: anders.proj });
ok(r.status === 200, 'Andersen too');
r = await lines('POST', { gameId: FIX, playerId: smith.id, stat: smith.stat, line: 0.5, proj: smith.proj });
ok(r.status === 200, 'and Smith Rowe');
const solanke = PAST.flatMap((g) => g.rows).find((x) => x.player === 'Dominic Solanke');
r = await lines('POST', { gameId: FIX, playerId: solanke.player_id, stat: 'shots', line: 1.5, proj: 2 });
ok(r.status === 404, `a player not listed: refused (${r.status})`);
r = await lines('POST', { gameId: 'NOPE', playerId: iwobi.id, stat: iwobi.stat, line: 1.5, proj: 1 });
ok(r.status === 404, 'a match with nothing stored: refused');
ok((await lines('GET')).body.lines.length === 4, 'and a reload shows the four saved');

console.log('\n-- kept, and read a few at a time --');
ok(/socBoxCatchUp, socExpectedTick\]\) await job\((env|d1Env\(env,)/.test(src), 'it runs last on the trigger: what goes on the record reads first');
const before = sq.prepare("SELECT updated_at FROM feed_cache WHERE key = ?").get(`soc_exp:${FIX}`).updated_at;
NOW += 60e3;
await histTick();
ok(sq.prepare("SELECT updated_at FROM feed_cache WHERE key = ?").get(`soc_exp:${FIX}`).updated_at === before, 'a tick a minute later does nothing');
afterGate();
await histTick();
ok(sq.prepare("SELECT updated_at FROM feed_cache WHERE key = ?").get(`soc_exp:${FIX}`).updated_at === before, 'five minutes later, still kept');
const fixRows = () => sq.prepare("SELECT COUNT(*) AS n FROM feed_cache WHERE key LIKE 'soc_fix:%'").get().n;
sq.exec("DELETE FROM feed_cache WHERE key LIKE 'soc_fix:%'");
NOW += 60 * 60e3;
await histTick();
ok(fixRows() === 0, 'nothing left to work out: an hour on, not one scoreboard read');
NOW += 61 * 60e3;
await histTick();
ok(fixRows() === 21, `two hours on it looks again: ${fixRows()} scoreboards, seven leagues over three days`);
NOW = before + 12 * 3600e3 + 1000;
await histTick();
ok(sq.prepare("SELECT updated_at FROM feed_cache WHERE key = ?").get(`soc_exp:${FIX}`).updated_at > before, 'after twelve hours it is read again, as a club may have played');
// Twenty matches of the real shape, on one day: eight a tick.
const many = Array.from({ length: 20 }, (_, i) => ({ ...realSb.events[0], id: `MANY${i}` }));
sbNow = preSb(many);
sq.exec("DELETE FROM feed_cache WHERE key LIKE 'soc_fix:%'");
sq.exec("DELETE FROM feed_cache WHERE key LIKE 'soc_exp%'");
await histTick();
const first = stored();
afterGate();
await histTick();
ok(first === 8 && stored() === 16, `twenty matches: ${first} on the first tick, ${stored()} after the second`);
sbNow = preSb(realSb.events);
sq.exec("DELETE FROM feed_cache WHERE key LIKE 'soc_fix:%'");

console.log('\n-- who waits for the lineup --');
seed();
const dropFul = (keep) => {
  const keepIds = PAST.filter((g) => [g.home, g.away].includes('FUL')).sort((a, c) => (a.date < c.date ? 1 : -1)).slice(0, keep).map((g) => g.id);
  sq.exec(`DELETE FROM soc_box_games WHERE (home_cid = '370' OR away_cid = '370') AND game_id NOT IN (${keepIds.map((x) => `'${x}'`).join(',')})`);
};
const reread = async () => { sq.exec("DELETE FROM feed_cache WHERE key LIKE 'soc_exp%'"); afterGate(); await histTick(); return fixOf(await hit('/api/soccer-props?expected=1')); };
dropFul(4);
m = await reread();
ok(![...playersOf(m)].some((p) => FUL.has(p)) && [...playersOf(m)].some((p) => TOT.has(p)), 'a club with four matches read: none of its players, the other club\'s stay');
seed();
sq.exec("DELETE FROM soc_box_games WHERE home_cid = '367' OR away_cid = '367'");
sq.exec("DELETE FROM soc_box_games WHERE home_cid = '370' OR away_cid = '370'");
m = await reread();
ok(m.lineup === 'waiting' && !(m.rows || []).length, 'neither club read: waiting');
seed();
sq.exec("UPDATE soc_box_games SET date = '2026-01-01' WHERE home_cid = '370' OR away_cid = '370'");
m = await reread();
ok(![...playersOf(m)].some((p) => FUL.has(p)), 'a club whose last match was over 45 days ago: none of its players (last season\'s side)');
seed();
// A match given up on, or half read, isn't one of the five.
const latest = PAST.filter((g) => [g.home, g.away].includes('FUL')).sort((a, c) => (a.date < c.date ? 1 : -1))[0];
sq.prepare("DELETE FROM soc_box WHERE game_id = ? AND team = 'FUL'").run(latest.id);
m = await reread();
const shifted = regulars('FUL', (g) => g.id === latest.id);
ok([...playersOf(m)].filter((p) => !TOT.has(p)).every((p) => shifted.has(p)), `Fulham's last match unread: the five before it (${[...shifted.keys()].join(', ')})`);
seed();

console.log('\n-- the real lineup replaces the guess --');
await reread();
const keepLines = async () => {
  await lines('POST', { gameId: FIX, playerId: iwobi.id, stat: iwobi.stat, line: 1.5, proj: iwobi.proj });
  await lines('POST', { gameId: FIX, playerId: sarr.id, stat: sarr.stat, line: sarr.line, proj: sarr.proj });
  await lines('POST', { gameId: FIX, playerId: anders.id, stat: anders.stat, line: anders.line, proj: anders.proj });
};
await keepLines();
NOW = KICK - 90 * 60e3;
sq.exec("DELETE FROM feed_cache WHERE key LIKE 'soc_fix:%'");
m = fixOf(await hit('/api/soccer-props?expected=1'));
ok(m.lineup === 'expected', '90 minutes out, lineups not up: still expected');
lineupUp = true;
NOW += 6 * 60e3;   // past the five minutes "not posted" is kept for
m = fixOf(await hit('/api/soccer-props?expected=1'));
const posted = m;
ok(m.lineup === 'posted', `the lineups post: ${m.lineup}`);
ok(!playersOf(m).has('Joachim Andersen') && !playersOf(m).has('Pape Matar Sarr'), 'Andersen and Sarr are off the card');
ok(playersOf(m).has('Dominic Solanke') && playersOf(m).has('Ryan Sessegnon') && playersOf(m).has('Alex Iwobi'), 'Solanke, Sessegnon and Iwobi, who started, are on it');
ok((m.rows || []).every((x) => !x.expected), 'and none says expected now');
ok(Array.isArray(m.starterIds) && m.starterIds.length === 22 && m.starterIds.includes(iwobi.id) && !m.starterIds.includes(sarr.id), `the match carries who started (${m.starterIds.length}), for the slip`);
const logged = new Set(sq.prepare('SELECT player FROM socprops').all().map((x) => x.player));
ok(logged.has('Alex Iwobi') && !logged.has('Pape Matar Sarr') && !logged.has('Joachim Andersen'), `only now on the record, starters only (${logged.size} players)`);

console.log('\n-- graded: only if he started --');
NOW = KICK + 3 * 3600e3;
sbNow = realSb;
sq.exec("DELETE FROM feed_cache WHERE key LIKE 'soc_fix:%'");
sq.exec("DELETE FROM feed_cache WHERE key = 'soc_box_disc'");
for (let i = 0; i < 4; i++) { await boxTick(); NOW += 60e3; }
const res = (name) => sq.prepare('SELECT * FROM soc_pp_lines WHERE player = ?').get(name);
const iw = res('Alex Iwobi');
ok(iw && iw.actual != null && ['under', 'over', 'push'].includes(iw.result), `Iwobi, who started: ${iw && iw.result} at ${iw && iw.line}, ${iw && iw.actual} ${iwobi.stat}`);
const pms = res('Pape Matar Sarr');
ok(pms && pms.result === 'void', `Sarr, on from the bench: ${pms && pms.result}`);
ok(sq.prepare("SELECT starter FROM soc_box WHERE player = 'Pape Matar Sarr' AND game_id = ?").get(FIX).starter === 0, 'and he did play: the box score has him as a sub');
const ja = res('Joachim Andersen');
ok(ja && ja.result === 'void', `Andersen, not in the squad: ${ja && ja.result}`);
const rec = await hit('/api/soccer-props?summary=1');
ok(rec.ppRecord.graded === 1 && rec.ppRecord.void === 2, `the record counts the one who started (${rec.ppRecord.graded} graded, ${rec.ppRecord.void} void)`);
const defaults = sq.prepare("SELECT COUNT(*) AS n FROM socprops WHERE result IN ('under','over','push')").get().n;
ok(defaults > 0, `the model's own rows still grade (${defaults})`);

// ---- the page --------------------------------------------------------------------------
const app = fs.readFileSync(BOARD + '/app.js', 'utf8').replace(/\r\n/g, '\n');
function lift(name) {
  let at = app.indexOf(`function ${name}(`);
  const isConst = at < 0;
  if (isConst) at = app.indexOf(`const ${name} =`);
  if (at < 0) throw new Error(`app.js has no ${name}`);
  let depth = 0;
  for (let i = at; i < app.length; i++) {
    const c = app[i];
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') { depth--; if (!isConst && c === '}' && depth === 0) return app.slice(at, i + 1); }
    else if (isConst && c === ';' && depth === 0 && app[i + 1] === '\n') return app.slice(at, i + 1);
  }
  throw new Error(`could not close ${name}`);
}
NOW = KICK - 30 * 3600e3;
seed();
lineupUp = false;
sbNow = preSb(realSb.events);
sq.exec("DELETE FROM feed_cache WHERE key LIKE 'soc_fix:%' OR key LIKE 'soc_lu:%'");
await reread();
const expBoard = await hit('/api/soccer-props?expected=1');
const NAMES = ['socKeepExpected', 'SOC_STAT', 'nbCdf', 'socChanceAt', 'socKey', 'socLineOf', 'socLean', 'socStatWords', 'SOC_POS', 'socPosWords', 'ptDayOf', 'pct1', 'pct0',
  'miniBar', 'projLineHtml', 'LEG_OFFERS', 'offerLeg', 'socpLeg', 'socSaveHtml', 'socRecB', 'socPropRow', 'SOC_BEST_N', 'socRankP', 'socSideLineHtml', 'spBarHtml', 'socPropsCardHtml',
  'socWeakStat', 'socBestByStat', 'socBestStripHtml', 'initialsOf', 'headshotUrl', 'avatarHtml', 'socLegOut'];
const ui = { socProps: expBoard, socLines: {}, socSaved: {}, socSaving: {}, socOpen: {}, slip: {}, soccerLeague: 'all', socStat: 'best', socQuery: '', socMatchOpen: {}, socAll: {} };
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const soccerKick = (t) => new RealDate(t).toISOString().slice(11, 16);
let F;
try {
  F = new Function('state', 'esc', 'soccerKick', NAMES.map(lift).join('\n') + '\nreturn { socPropsCardHtml, socBestByStat, socBestStripHtml, socLegOut, socpLeg, socKeepExpected };')(ui, esc, soccerKick);
} catch (e) { console.log(`  FAIL  the card's functions lift out of app.js (${e.message})`); process.exit(1); }
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

console.log('\n-- the card --');
let card = F.socPropsCardHtml();
ok(/Confirmed starters show about an hour before kickoff/.test(text(card)), 'says when the real ones come');
ok(/started 5 of their club.s last 5 \(about 85% start the next match, 81% in European cups\) or 4 of 5 \(about 70%, 67%\)/.test(text(card)), 'and what expected is worth, from the two seasons');
const m0 = expBoard.matches.find((x) => x.id === FIX);
const nExp = new Set(m0.rows.map((x) => x.id)).size;
ok(new RegExp(`${nExp} expected`).test(text(card)) && !/Lineups not posted yet/.test(text(card)), `the match says "${nExp} expected", and isn't listed as waiting`);
// On a phone the note ran most of a screen before the first player (2026-11-05): folded behind a tap.
ok(/<button type="button" class="pr-how" data-action="pr-how" data-sport="soccer" aria-expanded="false">How to read this ▸<\/button><div class="tc-sub" hidden>At the app’s line/.test(card), 'the note folded: a tap opens it');
ui.prHow = { soccer: true };
ok(/aria-expanded="true">How to read this ▾<\/button><div class="tc-sub">At the app’s line/.test(F.socPropsCardHtml()), 'and open once tapped');
ui.prHow = {};
ok(/class="sp-tap"/.test(card), 'the only match, so it is open');
ok(/expected: started 5 of 5/.test(text(card)) && /expected: started 4 of 5/.test(text(card)), 'each row says how many of 5');
ok(/data-action="socp-row"/.test(card) && /data-action="leg-add"/.test(card), 'and takes a line and a star as a starter\'s does');
ui.socStat = 'shots';
ok(/Shots: every player, best first/.test(text(F.socPropsCardHtml())), 'a stat chip works on them');
ui.socStat = 'best';

console.log('\n-- Picks stays on the real ones --');
ok(F.socBestByStat(expBoard, NOW).length === 0, 'the best-in-each-stat strip takes no expected row');
const wait = (hours) => ({ matches: [{ id: 'W', home: 'FUL', away: 'TOT', league: 'epl', commence: new RealDate(NOW + hours * 3600e3).toISOString(), lineup: 'waiting', rows: [] }] });
ui.socProps = wait(13);
ok(/Lineups not posted yet \(about an hour before kickoff\)\. Next: TOT @ FUL/.test(F.socBestStripHtml()), 'thirteen hours out, the strip names the next match, as it did');
ui.socProps = wait(30);
ok(F.socBestStripHtml() === '', 'thirty hours out it says nothing: the card on Picks does not appear for two days');
const rs = lift('refreshSoccer');
const rp = lift('refreshPicks');
ok(/\/api\/soccer-props\?expected=1/.test(rs) && !/\/api\/soccer-props\?expected=1/.test(rp), 'the Soccer tab asks for expected rows, Picks does not');

console.log('\n-- a read from Picks does not wipe them --');
const plainBoard = await hit('/api/soccer-props');
let kept = F.socKeepExpected(plainBoard, expBoard).matches.find((x) => x.id === FIX);
ok(kept.lineup === 'expected' && kept.rows.length === expBoard.matches.find((x) => x.id === FIX).rows.length, 'Picks reads the plain card: the Soccer tab keeps its expected rows');
const postedBoard = { matches: [posted] };
kept = F.socKeepExpected(postedBoard, expBoard).matches[0];
ok(kept.lineup === 'posted' && !kept.rows.some((x) => x.expected), 'and a lineup that has posted wins');
ok(F.socKeepExpected(plainBoard, null) === plainBoard, 'nothing read yet: the plain card as it came');
const sw = lift('setSport');
ok(/s === 'soccer' && Date\.now\(\) - \(state\.socPropsAt \|\| 0\) > 120e3\) refreshSocProps\(\)/.test(sw), 'back on the tab after two minutes it reads again, so a page left open gets the lineup');
ok(!/soccer-board/.test(lift('refreshSocProps')) && /\/api\/soccer-props\?expected=1/.test(lift('refreshSocProps')), 'the props alone, not the odds board');
ok(/renderSlip\(\)/.test(lift('refreshPicks')), 'and the slip hears of it on Picks too');

console.log('\n-- the slip --');
const legFor = (mm, row) => F.socpLeg(mm, row, row.line, 'Under', 50);
const ex = expBoard.matches.find((x) => x.id === FIX);
const sarrLeg = legFor(ex, ex.rows.find((x) => x.player === 'Pape Matar Sarr'));
const iwobiLeg = legFor(ex, ex.rows.find((x) => x.player === 'Alex Iwobi'));
ui.socProps = expBoard;
ok(!F.socLegOut(sarrLeg), 'before the lineup: nothing to say');
ui.socProps = { matches: [posted] };
ok(F.socLegOut(sarrLeg), 'the lineup is up without Sarr: he is called out');
ok(!F.socLegOut(iwobiLeg), 'Iwobi is in it');
ok(!F.socLegOut({ id: 'nba:ml:1:home', spec: { gamePk: FIX } }), 'and another sport\'s leg is left alone');
ui.socProps = null;
ok(!F.socLegOut(sarrLeg), 'and nothing when the card has not loaded');
const slip = lift('renderSlip');
ok(/socLegOut\(leg\)/.test(slip) && /\$\{deadHtml\}\$\{socOutHtml\}/.test(slip), 'the slip says so above the legs');

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
