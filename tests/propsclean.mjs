// The props cards' record since the clean reads (2026-11-23, the owner's call: "build all three").
//
// e80d6f3, live at 00:35 UTC Nov 21 (4:35 PM Pacific Nov 20), left out prices no one could bet:
// Novig's and ProphetX's one-sided alternates, whose 60%+ legs landed 48% last season. The card's
// "Sharp 54%+" record runs from Nov 5 and mixes rows read before it with rows read after, so
// whether card legs join Picks can't be decided on it. What has to hold:
//   - beside the whole record, a count of the 54%+ rows read after the fix, by read time: a Nov 20
//     game read that afternoon is out, one read that evening is in; Nov 5's reads are out
//   - the record is added to, never re-scanned: the count starts from the log once, on the first
//     grading pass with or without anything to grade, and each row then adds to it as it grades,
//     never twice; the rest of the record is untouched by its start
//   - the board carries it as record.clean; a sport with no record yet has none
//   - by market too (2026-11-26, the owner's yes to the Dec 1 rule: NBA card legs join Picks without
//     threes and assists if those read after the fix land 55%+ over 100+ legs). Production's count,
//     kept without the split, gets it from the log once, its total unchanged
//
// Real data: production's NBA board of 4:36 PM Pacific Nov 21 (tests/fixtures/nba-props-20261121.json):
// its 382 reads, all after the fix, and its record as kept then (8,539 graded). Production's board of
// Nov 5 (nba-props-board-20261105.json) for reads before it. Mikal Bridges' and Isaiah Stewart's real
// Nov 21 box lines (nba-box-20261121-two.json) grade their two reads through the real trigger. No free
// route returns graded rows, so the other reads' results are the test's, set by a fixed rule.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
const read = (f) => JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', f), 'utf8'));
const B21 = read('nba-props-20261121.json'), B05 = read('nba-props-board-20261105.json'), BOX = read('nba-box-20261121-two.json').rows;
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const RealDate = Date;
let NOW = RealDate.parse('2026-11-24T08:00:00Z');
globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } };
globalThis.fetch = async () => new Response('{}', { status: 404 });
const sq = new DatabaseSync(':memory:');
const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
const exec = (sql, args, mode) => { const st = sq.prepare(sql); const a = args.map(norm);
  if (mode === 'all') return { results: st.all(...a), meta: {} }; if (mode === 'first') return st.get(...a) || null;
  if (/^\s*(SELECT|WITH)/i.test(sql)) return { results: st.all(...a), meta: {} };
  return { success: true, meta: { changes: Number(st.run(...a).changes) } }; };
const DB = { prepare: (sql) => { const s = { sql, args: [], bind: (...x) => { s.args = x; return s; },
  all: async () => exec(s.sql, s.args, 'all'), first: async (c) => { const r = exec(s.sql, s.args, 'first'); return c && r ? r[c] : r; },
  run: async () => exec(s.sql, s.args, 'run') }; return s; }, batch: async (sts) => sts.map((x) => exec(x.sql, x.args, 'run')) };
const env = { DB, ASSETS: { fetch: async () => new Response('{}', { status: 404 }) } };
const src = fs.readFileSync(BOARD + '/worker.js', 'utf8').replace(/\r\n/g, '\n');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const get = async (u) => (await mod.default.fetch(new Request('https://x' + u), env, { waitUntil: () => {} })).json();
const tick = async () => { const held = []; await mod.default.scheduled({ cron: '*/5 * * * *' }, env, { waitUntil: (p) => held.push(p) }); await Promise.allSettled(held); };
let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
await get('/api/nba-props'); await get('/api/nhl-props');      // the tables

const FIX = RealDate.parse('2026-11-21T00:35:02Z');
// A board's reads into the log, as the card's read wrote them. Graded by a fixed rule: three in
// five land on the sharp books' side, every 37th is void; the two with real box lines stay open.
const OPEN = new Set(['Mikal Bridges|pts', 'Isaiah Stewart|pts']);
let i = 0;
const put = (b, p, market, l, over = {}) => {
  const g = b.games[p.g], k = i++;
  const won = k % 5 < 3;
  const result = OPEN.has(`${p.name}|${market}`) && !over.date ? null : k % 37 === 0 ? 'void' : l.u == null ? (k % 2 ? 'under' : 'over') : (l.u >= 50) === won ? 'under' : 'over';
  const r = { sport: 'nba', date: g.date, pkey: p.k, market, player: p.name, player_id: String(p.id), team: p.team, game_id: g.id, home: g.home, away: g.away, commence: g.commence,
    read_point: l.l, read_sharp: l.u, read_at: l.at, result, ...over };
  const c = Object.keys(r);
  sq.prepare(`INSERT INTO pp_props (${c.join(', ')}) VALUES (${c.map(() => '?').join(',')})`).run(...c.map((x) => norm(r[x])));
};
for (const b of [B21, B05]) for (const p of b.players) for (const [m, l] of Object.entries(p.lines || {})) if (l.at) put(b, p, m, l);
// Two of Nov 21's reads as Nov 20 games: one read at 3:10 PM Pacific, before the fix went live; one
// at 5:05 PM, after it (a late tip). Both landed.
const P21 = (name) => B21.players.find((p) => p.name === name);
put(B21, P21('Jrue Holiday'), 'pts', P21('Jrue Holiday').lines.pts, { date: '2026-11-20', read_at: '2026-11-20T23:10:00.000Z', result: 'under' });
put(B21, P21('Brook Lopez'), 'reb_ast', P21('Brook Lopez').lines.reb_ast, { date: '2026-11-20', read_at: '2026-11-21T01:05:00.000Z', result: 'under' });
// The record as production kept it on Nov 21, before the count.
const REC0 = { graded: B21.record.graded, bands: B21.record.bands, byMarket: B21.record.byMarket };
sq.prepare("INSERT OR REPLACE INTO feed_cache (key, data, updated_at, claimed_until) VALUES ('pp_props_rec:nba', ?, ?, 0)").run(JSON.stringify(REC0), NOW);
// The box: Bridges' and Stewart's lines in, and a Nov 21 game still to read, so the day isn't settled.
const cols = ['game_id', 'date', 'season_type', 'player_id', 'player', 'team', 'min', 'pts', 'reb', 'ast', 'threes', 'stl', 'blk', 'tov', 'starter', 'dnp'];
const addBox = (r) => sq.prepare(`INSERT OR REPLACE INTO nba_box (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => norm(r[c])));
sq.prepare("INSERT OR IGNORE INTO nba_box_games (game_id, date, season_type, done) VALUES ('401910026', '2026-11-21', 2, 1), ('401910024', '2026-11-21', 2, 0)").run();
addBox(BOX.find((r) => r.player === 'Isaiah Stewart'));

// By hand, from the log: the 54%+ rows graded, on the side the sharp books took.
const byHand = (after) => {
  const c = { n: 0, hit: 0, byMarket: {} };
  for (const r of sq.prepare("SELECT market, read_sharp, typed_line, typed_sharp, result, read_at FROM pp_props WHERE sport = 'nba'").all()) {
    if (r.result !== 'under' && r.result !== 'over') continue;
    if (after && !(RealDate.parse(r.read_at) >= FIX)) continue;
    const u = r.typed_line != null ? r.typed_sharp : r.read_sharp;
    if (u == null || Math.max(u, 100 - u) < 54) continue;
    const m = c.byMarket[r.market] || (c.byMarket[r.market] = { n: 0, hit: 0 });
    c.n++; m.n++; if ((r.result === 'under') === (u >= 50)) { c.hit++; m.hit++; }
  }
  return c;
};
// The same markets with the same counts, in any order.
const sameSplit = (a, b) => !!a && !!b && Object.keys(a).length === Object.keys(b).length && Object.entries(b).every(([k, v]) => a[k] && a[k].n === v.n && a[k].hit === v.hit);
const stored = () => JSON.parse(sq.prepare("SELECT data FROM feed_cache WHERE key = 'pp_props_rec:nba'").get().data);
const row = (p, m) => sq.prepare('SELECT result, actual FROM pp_props WHERE player = ? AND market = ? AND date = ?').get(p, m, '2026-11-21');

console.log('-- the real reads --');
ok(B21.players.flatMap((p) => Object.values(p.lines || {})).filter((l) => l.at).every((l) => RealDate.parse(l.at) >= FIX), "every read on Nov 21's board came after the fix");
ok(B05.players.flatMap((p) => Object.values(p.lines || {})).filter((l) => l.at).every((l) => RealDate.parse(l.at) < FIX), "and every one on Nov 5's before it");
const s21 = P21('Isaiah Stewart').lines.pts, b21 = P21('Mikal Bridges').lines.pts;
ok(s21.l === 9.5 && s21.u === 56.5 && b21.l === 11.5 && b21.u === 55.4, 'Stewart Under 9.5 points at 56.5%, Bridges Under 11.5 at 55.4%');

console.log('\n-- the first pass: Stewart grades, the count starts from the log --');
await tick();
ok(row('Isaiah Stewart', 'pts').result === 'over' && row('Isaiah Stewart', 'pts').actual === 10, 'Stewart scored 10: over, his sharp side missed');
ok(row('Mikal Bridges', 'pts').result == null, 'Bridges waits: his game is still to read');
let r = stored(), want = byHand(true);
const all = byHand(false);
console.log(`  clean ${r.clean && `${r.clean.hit} of ${r.clean.n}`}; by hand ${want.hit} of ${want.n}; every 54%+ row in the log ${all.hit} of ${all.n}`);
ok(r.clean && r.clean.n === want.n && r.clean.hit === want.hit, 'the count is the log\'s 54%+ rows read after the fix, Stewart among them');
ok(all.n - want.n === 6, "Nov 5's five 54%+ reads and the Nov 20 game read before the fix are not in it; the one read after is");
console.log(`  by market: ${r.clean && r.clean.byMarket && Object.entries(r.clean.byMarket).map(([k, v]) => `${k} ${v.hit}/${v.n}`).join(', ')}`);
ok(r.clean && sameSplit(r.clean.byMarket, want.byMarket) && Object.keys(want.byMarket).length > 3 && want.byMarket.ast && !want.byMarket.threes,
  'and by market, the log by hand: assists among them (no threes read at 54%+ that day)');
ok(r.graded === REC0.graded + 1 && r.bands['56+'].n === REC0.bands['56+'].n + 1 && r.bands['56+'].hit === REC0.bands['56+'].hit, 'the rest of the record: Stewart added, nothing re-scanned');

console.log('\n-- nothing new --');
await tick();
r = stored();
ok(r.clean.n === want.n && r.clean.hit === want.hit && r.graded === REC0.graded + 1, 'a pass with nothing to grade changes nothing');

console.log('\n-- Bridges grades --');
addBox(BOX.find((r) => r.player === 'Mikal Bridges'));
sq.prepare("UPDATE nba_box_games SET done = 1 WHERE game_id = '401910024'").run();
await tick();
ok(row('Mikal Bridges', 'pts').result === 'over' && row('Mikal Bridges', 'pts').actual === 12, 'Bridges scored 12: over, his sharp side missed');
r = stored();
ok(r.clean.n === want.n + 1 && r.clean.hit === want.hit, `one more in the count, no more landed (${r.clean.hit} of ${r.clean.n})`);
ok(r.clean.n === byHand(true).n && r.clean.hit === byHand(true).hit, 'which is the log by hand again');
ok(r.clean.byMarket.pts.n === want.byMarket.pts.n + 1 && r.clean.byMarket.pts.hit === want.byMarket.pts.hit && sameSplit(r.clean.byMarket, byHand(true).byMarket),
  'his row adds to points, as it grades, and the split is still the log by hand');
await tick();
ok(stored().clean.n === want.n + 1 && stored().graded === REC0.graded + 2, 'grading again counts nothing twice');

console.log('\n-- the deploy, with nothing to grade --');
// Production's record as it stood when this shipped: no count, and the night's games all graded.
const was = stored(); delete was.clean;
sq.prepare("UPDATE feed_cache SET data = ? WHERE key = 'pp_props_rec:nba'").run(JSON.stringify(was));
await tick();
r = stored();
ok(r.clean && r.clean.n === byHand(true).n && r.clean.hit === byHand(true).hit && r.graded === was.graded && JSON.stringify(r.bands) === JSON.stringify(was.bands),
  'the first pass gives it the count from the log, and leaves the rest as it was');

console.log('\n-- the split\'s deploy: production\'s count, kept without it --');
const kept = stored(); kept.clean = { n: kept.clean.n, hit: kept.clean.hit };
sq.prepare("UPDATE feed_cache SET data = ? WHERE key = 'pp_props_rec:nba'").run(JSON.stringify(kept));
await tick();
r = stored();
ok(r.clean.n === kept.clean.n && r.clean.hit === kept.clean.hit && sameSplit(r.clean.byMarket, byHand(true).byMarket) && r.graded === kept.graded && JSON.stringify(r.bands) === JSON.stringify(kept.bands),
  'a pass with nothing to grade gives it the split from the log: its total, and the rest, as they were');
await tick();
ok(JSON.stringify(stored()) === JSON.stringify(r), 'and only once');
const rule = Object.entries(r.clean.byMarket).filter(([k]) => k !== 'threes' && k !== 'ast').reduce((a, [, v]) => ({ n: a.n + v.n, hit: a.hit + v.hit }), { n: 0, hit: 0 });
const ast = r.clean.byMarket.ast;
console.log(`  the Dec 1 rule's count here: ${rule.hit} of ${rule.n}, without assists ${ast.hit}/${ast.n}`);
ok(rule.n === r.clean.n - ast.n && rule.hit === r.clean.hit - ast.hit, 'the rule\'s count reads straight off it');

console.log('\n-- the boards --');
const nba = (await get('/api/nba-props')).record;
ok(nba.clean && nba.clean.from === '2026-11-21T00:35:02.000Z' && nba.clean.n === r.clean.n && nba.clean.hit === r.clean.hit, `NBA: record.clean ${nba.clean && `${nba.clean.hit} of ${nba.clean.n} from ${nba.clean.from}`}`);
ok(sameSplit(nba.clean.byMarket, r.clean.byMarket), 'with its split by market');
ok(nba.at54.n === r.bands['54-56'].n + r.bands['56+'].n, 'beside the whole record, unchanged in form');
const nhl = (await get('/api/nhl-props')).record;
ok(nhl && nhl.clean === null && nhl.graded === 0, 'NHL, with no record yet: none');

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
