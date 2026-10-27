// NFL passing-TD unders on Picks of the day at 60%+ (2026-10-27).
//
// The passing-TD log has priced every starter's under 1.5 from the sharp
// books since Week 3 (passTdEntries), logged only. Through Week 7 its legs at
// 60%+ landed 26 of 37, against 62-67% stated, and on Oct 25 all six of them
// landed. The owner's call: list them at 60%+. What has to hold:
//   - a passing-TD under at 60%+ is a leg; under 60% it is not
//   - the chance is at the books' 1.5, so PrizePicks at another number keeps
//     it off; PrizePicks at 1.5, or not read yet (the leg says to check), keeps
//     it on
//   - one leg a game with the NFL moneyline: the event id leads both rows
//   - its record counts each quarterback once (the four duplicated rows from
//     before Sep 24 not twice), and the list's own record grades it from the
//     log
//
// Real data: production's passing-TD rows as /api/gmpicks-export served them
// at 1 AM Pacific on Oct 27 (tests/fixtures/gmpicks-nflptd-20261027.json) and
// its NFL moneyline rows (gmpicks-nfl-20261026.json). For the list, Sunday's
// rows are set back to ungraded and the clock to 6 AM that morning, before
// the London game (Steelers at Saints, 6:30 AM Pacific).
// PrizePicks' lines are written as the NFL props read would leave them:
// Mahomes at 1.5, and Brissett at 0.5 to show one at another number. Real
// SQLite and the real worker.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const read = (f) => JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', f), 'utf8'));
const PTD = read('gmpicks-nflptd-20261027.json').rows, ML = read('gmpicks-nfl-20261026.json').rows;
const RealDate = Date;
let NOW = RealDate.parse('2026-10-25T13:00:00Z');
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
};
globalThis.fetch = async () => new Response('{}', { status: 404 });
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
const mod = await import('data:text/javascript;base64,' + Buffer.from(fs.readFileSync(BOARD + '/worker.js', 'utf8')).toString('base64'));
const get = async (u) => (await mod.default.fetch(new Request('https://x' + u), env, { waitUntil: () => {} })).json();

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

await get('/api/gmpicks-export'); await get('/api/picks'); await get('/api/nfl-board');   // the tables
for (const rows of [PTD, ML]) {
  const cols = Object.keys(rows[0]);
  const ins = sq.prepare(`INSERT OR IGNORE INTO gmpicks (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
  for (const r of rows) ins.run(...cols.map((k) => r[k]));
}
sq.prepare("UPDATE gmpicks SET result = NULL, home_score = NULL, away_score = NULL WHERE date = '2026-10-25' AND sport IN ('nfl', 'nflptd')").run();
const sun = PTD.filter((r) => r.date === '2026-10-25');
const qb = (name) => sun.find((r) => r.pick.startsWith(name));
const pp = sq.prepare(`INSERT INTO nfl_lines (event_id, commence, home, away, market, player, point, book, over, under, captured_at, season_type, week)
  VALUES (?, ?, ?, ?, 'player_pass_tds', ?, ?, 'prizepicks', NULL, NULL, '2026-10-25T15:30:00Z', 'REG', 7)`);
for (const [name, point] of [['Patrick Mahomes', 1.5], ['Jacoby Brissett', 0.5]]) {
  const r = qb(name);
  pp.run(r.game_id.split('|')[0], r.commence, r.home, r.away, name, point);
}

// ---- 6 AM Sunday ----------------------------------------------------------------------------
console.log('-- Picks of the day, 6 AM Sunday --');
let p = await get('/api/picks');
const L = p.legs || [];
console.log('  ' + L.map((l) => `${l.rank}. ${l.title} ${l.p} [${l.kind}] ${l.sub}`).join('\n  '));
const ptd = L.filter((l) => l.kind === 'nfl_ptd');
const at60 = sun.filter((r) => r.win_prob >= 60).map((r) => r.pick.replace(/ under .*$/, ''));
ok(at60.length === 6 && ptd.length === 5 && ptd.every((l) => at60.includes(l.spec.player)) && !ptd.some((l) => l.spec.player === 'Jacoby Brissett'),
  `five of Sunday's six passing-TD unders at 60%+: ${ptd.map((l) => l.spec.player).join(', ')}`);
ok(!L.some((l) => /Brissett/.test(l.title)), 'Brissett, with PrizePicks at 0.5, is a different under: off');
ok(!L.some((l) => l.kind === 'nfl_ptd' && l.p < 60) && sun.some((r) => r.win_prob < 60 && r.win_prob > 50), 'and none under 60%, though Sunday had several');
const mah = ptd.find((l) => l.spec.player === 'Patrick Mahomes'), hunt = ptd.find((l) => l.spec.player === 'Tyler Huntley');
ok(mah && mah.title === 'Patrick Mahomes Under 1.5 Pass TDs' && mah.sub === 'KC @ SEA' && mah.spec.side === 'Under' && mah.spec.pp.line === 1.5 && mah.spec.pp.under === 63.5,
  "Mahomes, with PrizePicks' 1.5 read: the leg as it plays");
ok(hunt && hunt.sub === 'CIN @ BAL · check PrizePicks has 1.5' && hunt.legId === `nfl:ptd:${qb('Tyler Huntley').game_id.split('|')[0]}:Tyler Huntley`,
  "Huntley, with PrizePicks' line not read: the leg says to check it");
ok(L[0].title === 'HOU ML' && L.length === 6, 'the Texans at 80.9% lead; six legs');

// One leg a game: had the Seahawks been 76%, their moneyline takes Mahomes' game.
sq.prepare("UPDATE gmpicks SET win_prob = 76 WHERE sport = 'nfl' AND date = '2026-10-25' AND pick = 'SEA'").run();
const p2 = await get('/api/picks');
ok(p2.legs.some((l) => l.title === 'SEA ML') && !p2.legs.some((l) => /Mahomes/.test(l.title)), 'one leg a game: the moneyline at 76% takes the game from Mahomes at 63.5%');
sq.prepare("UPDATE gmpicks SET win_prob = 59.9 WHERE sport = 'nfl' AND date = '2026-10-25' AND pick = 'SEA'").run();
await get('/api/picks');                                        // the list back as it was

// ---- its record ---------------------------------------------------------------------------------
const k = (p.kinds || {}).nfl_ptd || {};
const dedupe = (rows) => [...new Map(rows.map((r) => [r.game_id, r])).values()];
const before = dedupe(PTD.filter((r) => r.date !== '2026-10-25' && (r.result === 'win' || r.result === 'loss') && r.win_prob >= 60));
ok(k.min === 60 && k.record && k.record.n === before.length && k.record.hit === before.filter((r) => r.result === 'win').length,
  `its record before Sunday, one row a quarterback: ${k.record && k.record.hit} of ${k.record && k.record.n}`);
ok(/NFL passing TDs under 1\.5 \(sharp books\), 60%\+/.test(JSON.stringify(p.rules)), 'the rules say so');

// ---- graded Monday morning ------------------------------------------------------------------------
console.log('\n-- graded --');
for (const r of [...PTD, ...ML].filter((x) => x.date === '2026-10-25')) {
  sq.prepare('UPDATE gmpicks SET result = ?, home_score = ?, away_score = ? WHERE sport = ? AND date = ? AND game_id = ? AND market = ?')
    .run(r.result, r.home_score, r.away_score, r.sport, r.date, r.game_id, r.market);
}
NOW = RealDate.parse('2026-10-26T16:00:00Z');
await get('/api/picks');                                        // the grader runs on every read
p = await get('/api/picks');
const day = p.record.history.days.find((d) => d.date === '2026-10-25') || {};
console.log('  ' + (day.legs || []).map((x) => `${x.label} ${x.result}`).join(', '));
ok(day.legs && day.legs.filter((x) => x.kind === 'nfl_ptd').length === 5 && day.legs.filter((x) => x.kind === 'nfl_ptd').every((x) => x.result === 'hit')
  && day.legs.find((x) => x.label === 'HOU ML').result === 'miss' && day.hit === 5 && day.decided === 6,
  'graded from the log: the five unders landed, the Texans did not -- 5 of 6');
ok(p.kinds.nfl_ptd.record.hit === 26 && p.kinds.nfl_ptd.record.n === 37, `with Sunday in, 26 of 37, as through Week 7 (${p.kinds.nfl_ptd.record.hit} of ${p.kinds.nfl_ptd.record.n})`);

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
