// Form against the line (2026-10-29, the owner's call): "keep players that
// are constantly reaching a favorable stat in mind". Before form changes any
// chance on Picks, the backtest says whether it adds anything the sharp books
// miss. What has to hold:
//   - each graded leg is read against the player's own previous games with a
//     line in that market: how often he cleared THAT night's line, over the
//     last ten, from five games on -- never a game played after it
//   - legs fall in bands by that rate (8+ of 10 down to 0-1), each with how
//     often it went over, how often the sharp books said it would at that
//     line, the gap between, and the line against his recent average
//   - a push decides nothing; a voided leg is no game
//
// Real data: production's backtest rows for Jalen Brunson (63 games) and
// Nikola Jokic (53) on Oct 29, from /api/hist-props?player=
// (tests/fixtures/hist-props-form-20261029.json). The bands are worked out
// here a second way, from the rows themselves. Real SQLite and the real worker.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const F = JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', 'hist-props-form-20261029.json'), 'utf8'));
const RealDate = Date;
const NOW = RealDate.parse('2026-10-29T19:43:00Z');
globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } };
globalThis.fetch = async () => new Response('{}', { status: 404 });
const sq = new DatabaseSync(':memory:');
const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
const exec = (sql, args, mode) => { const st = sq.prepare(sql); const a = args.map(norm);
  if (mode === 'all') return { results: st.all(...a), meta: {} }; if (mode === 'first') return st.get(...a) || null;
  return { success: true, meta: { changes: Number(st.run(...a).changes) } }; };
const DB = { prepare: (sql) => { const s = { sql, args: [], bind: (...x) => { s.args = x; return s; },
  all: async () => exec(s.sql, s.args, 'all'), first: async (c) => { const r = exec(s.sql, s.args, 'first'); return c && r ? r[c] : r; },
  run: async () => exec(s.sql, s.args, 'run') }; return s; }, batch: async (sts) => sts.map((x) => exec(x.sql, x.args, 'run')) };
const env = { DB };
const src = fs.readFileSync(BOARD + '/worker.js', 'utf8').replace(/\r\n/g, '\n');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const get = async (u) => (await mod.default.fetch(new Request('https://x' + u), env, { waitUntil: () => {} })).json();

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
const r1 = (v) => Math.round(v * 10) / 10;

await get('/api/hist-props?job=nba');                     // the table
// Both players' games: a game both played is one row with both men's legs.
const games = new Map();
for (const pl of F.players) for (const r of pl.rows) {
  const k = `${r.date}|${r.game}`;
  const g = games.get(k) || games.set(k, { ...r, legs: [] }).get(k);
  g.legs.push(...JSON.parse(r.legs));
}
let id = 0;
for (const g of games.values()) sq.prepare('INSERT INTO histpropgames (job, event_id, date, commence, game, legs, graded) VALUES (?,?,?,?,?,?,2)')
  .run('nba', `e${++id}`, g.date, g.commence, g.game, JSON.stringify(g.legs));
console.log(`-- ${games.size} games: ${F.players.map((p) => `${p.player} ${p.rows.length}`).join(', ')} --`);

const d = await get('/api/hist-props?job=nba&form=1');
const f = d.form;
console.log('  ' + (f ? f.all.map((b) => `${b.band}: ${b.n} legs, over ${b.overRate}%, sharp said ${b.sharpSaid}% (${b.beat > 0 ? '+' : ''}${b.beat}), line vs avg ${b.lineVsAvg}`).join('\n  ') : JSON.stringify(d).slice(0, 300)));

// ---- the same bands, a second way -----------------------------------------------------------------
// The sharp chance at PrizePicks' line: Pinnacle's, else the median of the rest that quote it.
// The backtest's sharp books (HIST_PROP_SHARP): DraftKings and BetMGM are not among them.
const SHARP = ['pinnacle', 'fanduel', 'novig', 'prophetx', 'betonlineag', 'lowvig'];
const med = (xs) => { const s = xs.slice().sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const sharpUnder = (l) => {
  const at = Object.fromEntries(Object.entries(l.q || {}).map(([bk, pts]) => [bk, (pts.find((x) => x[0] === l.pp) || [])[1]]).filter(([, v]) => v != null));
  if (at.pinnacle != null) return at.pinnacle;
  const rest = Object.entries(at).filter(([bk]) => SHARP.includes(bk) && !(bk === 'lowvig' && at.betonlineag != null)).map(([, v]) => v);
  return rest.length ? med(rest) : null;
};
const want = [];
for (const pl of F.players) {
  const byMk = {};
  for (const r of pl.rows) for (const l of JSON.parse(r.legs)) if (l.a != null && !l.v) (byMk[l.mk] = byMk[l.mk] || []).push({ ...l, t: r.commence });
  for (const ls of Object.values(byMk)) {
    ls.sort((a, b) => (a.t < b.t ? -1 : 1));
    ls.forEach((l, i) => {
      const prior = ls.slice(Math.max(0, i - 10), i).map((x) => x.a);
      if (prior.length < 5 || l.a === l.pp) return;
      const u = sharpUnder(l);
      want.push({ mk: l.mk, over: prior.filter((v) => v > l.pp).length / prior.length, won: l.a > l.pp, sharpOver: u == null ? null : r1(100 - u),
        gap: l.pp - prior.reduce((a, v) => a + v, 0) / prior.length });
    });
  }
}
const BANDS = [[0.8, 1.01], [0.6, 0.8], [0.4, 0.6], [0.2, 0.4], [0, 0.2]];
const expect = BANDS.map(([lo, hi]) => {
  const b = want.filter((x) => x.over >= lo && x.over < hi), pr = b.filter((x) => x.sharpOver != null);
  return { n: b.length, overRate: b.length ? r1(b.filter((x) => x.won).length / b.length * 100) : null,
    sharpSaid: pr.length ? r1(pr.reduce((a, x) => a + x.sharpOver, 0) / pr.length) : null,
    lineVsAvg: b.length ? r1(b.reduce((a, x) => a + x.gap, 0) / b.length) : null };
});
const graded = F.players.flatMap((p) => p.rows.flatMap((r) => JSON.parse(r.legs))).filter((l) => l.a != null && !l.v);
ok(f && f.legs === want.length && want.length > 400 && f.legs < graded.length,
  `${f && f.legs} legs read against form: every graded one from his sixth game in a market on, pushes aside (${graded.length} graded)`);
ok(f && f.all.every((b, i) => b.n === expect[i].n && b.overRate === expect[i].overRate && b.sharpSaid === expect[i].sharpSaid && b.lineVsAvg === expect[i].lineVsAvg),
  'each band as worked out from the rows: its legs, how often they went over, what the sharp books said, the line against his average');
ok(f && f.all.every((b) => b.beat == null || b.beat === r1(b.pricedOverRate - b.sharpSaid)), 'beat is how far the band went over past what the sharp books said');
ok(f && f.byMarket.pts && f.byMarket.pra && Object.values(f.byMarket).reduce((a, t) => a + t.reduce((x, b) => x + b.n, 0), 0) === f.legs, 'and the same by market, adding up to the whole');

// ---- nothing from after the game ------------------------------------------------------------------
// Brunson's last game, changed to 60 points: no band but the games after it could move -- there are none.
const last = [...games.values()].filter((g) => g.legs.some((l) => l.p === 'Jalen Brunson')).sort((a, b) => (a.commence < b.commence ? -1 : 1)).pop();
const bump = last.legs.map((l) => (l.p === 'Jalen Brunson' && l.mk === 'pts' ? { ...l, a: 60 } : l));
sq.prepare('UPDATE histpropgames SET legs = ? WHERE date = ? AND game = ?').run(JSON.stringify(bump), last.date, last.game);
const d2 = await get('/api/hist-props?job=nba&form=1');
const pts1 = f.byMarket.pts, pts2 = d2.form.byMarket.pts;
const moved = pts1.map((b, i) => [b.n, pts2[i].n]).filter(([a, b]) => a !== b).length;
const lastPts = JSON.parse(F.players[0].rows.find((r) => r.date === last.date).legs).find((l) => l.mk === 'pts');
ok(moved === 0 && pts2.reduce((a, b) => a + b.n, 0) === pts1.reduce((a, b) => a + b.n, 0), "a game's own result never reads into its form: the last game's points changed, no earlier leg's band moves");
ok(lastPts && pts2.some((b, i) => b.overRate !== pts1[i].overRate) === (lastPts.a !== 60 && (lastPts.a > lastPts.pp) !== (60 > lastPts.pp)),
  'only its own leg\'s result does, where it flips');

// ---- one player's legs --------------------------------------------------------------------------
const pj = await get('/api/hist-props?job=nba&player=Nikola%20Jokic');
ok(pj.rows && pj.rows.length === 53 && pj.rows.every((r, i, a) => !i || a[i - 1].commence <= r.commence) && pj.rows.every((r) => JSON.parse(r.legs).every((l) => l.p === 'Nikola Jokic')),
  "one player's games by date, his legs only");

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
