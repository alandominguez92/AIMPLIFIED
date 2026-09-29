// The compact reads the scheduled checks rely on.
//
// A scheduled check reads a response straight off the terminal, and anything
// past ~30KB is cut off. The full track record is ~96KB and the moneyline log
// ~100KB, so a morning check asked "how did last night's picks do" could only
// see the first third of either. /api/track-record?summary=1 keeps the headline
// numbers; /api/mlpicks-export?date= returns one day.
//
// Pinned: the summary carries the fields the checks quote and not the logs; it
// is cached apart from the full record (a shared cache key would serve one as
// the other); the date filter returns that day only and ignores a malformed date.
import fs from 'node:fs';
import path from 'node:path';
const BOARD = path.join(import.meta.dirname, '..');

// A real cache, keyed by URL, so a collision would show.
const store = new Map();
globalThis.caches = { default: {
  match: async (req) => { const r = store.get(typeof req === 'string' ? req : req.url); return r ? r.clone() : undefined; },
  put: async (req, res) => { store.set(typeof req === 'string' ? req : req.url, res.clone()); },
} };

const src = fs.readFileSync(BOARD + '/worker.js', 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

const ml = [
  { date: '2026-09-28', game_id: 'g1', team: 'BOS', opp: 'NYY', is_home: 0, tier: '1', win_prob: 58, edge: 3, entry_price: -130, close_price: -135, result: 'win', team_score: 5, opp_score: 3 },
  { date: '2026-09-29', game_id: 'g2', team: 'PHI', opp: 'ATL', is_home: 0, tier: 'pass', win_prob: 52, edge: 0, entry_price: 110, close_price: 105, result: 'loss', team_score: 2, opp_score: 4 },
  { date: '2026-09-29', game_id: 'g3', team: 'SD', opp: 'CHC', is_home: 1, tier: '2', win_prob: 55, edge: 2, entry_price: -120, close_price: -125, result: 'win', team_score: 6, opp_score: 1 },
];
const seen = [];
const db = { prepare: (sql) => {
  const st = { sql, args: [], bind: (...a) => { st.args = a; return st; },
    run: async () => ({ meta: { changes: 1 } }), first: async () => null,
    all: async () => {
      seen.push({ sql, args: st.args });
      if (/FROM mlpicks/i.test(sql) && /date = \?/.test(sql)) return { results: ml.filter((r) => r.date === st.args[0]) };
      if (/FROM mlpicks/i.test(sql)) return { results: ml };
      return { results: [] };
    } };
  return st;
}, batch: async () => [] };
const ctx = { waitUntil() {} };
const get = async (u) => { const r = await mod.default.fetch(new Request('https://x' + u), { DB: db }, ctx); return { text: await r.text() }; };

// ---- track-record?summary=1 -------------------------------------------------------------
const full = await get('/api/track-record');
const sum = await get('/api/track-record?summary=1');
const F = JSON.parse(full.text), S = JSON.parse(sum.text);
console.log(`  full ${full.text.length} bytes, summary ${sum.text.length} bytes`);
ok(S.summary === true && S.ml && S.ml.record === F.ml.record && S.ml.byPriceBand,
  `the summary carries the moneyline record and its price ranges (${S.ml && S.ml.record})`);
ok(!('log' in S) && !('logAll' in S) && sum.text.length < full.text.length,
  'and none of the logs, so it stays small');
ok(['recent', 'batterUnders', 'prizepicks', 'soccerFav', 'soccerMl', 'nflMl', 'nflPassTds'].every((k) => k in S),
  'every headline a scheduled check quotes is present');
// Cache separation: the full path must still serve the full record after the
// summary has been cached, and the other way round.
const full2 = JSON.parse((await get('/api/track-record')).text);
const sum2 = JSON.parse((await get('/api/track-record?summary=1')).text);
ok(!full2.summary && sum2.summary === true,
  'the full record and the summary are cached apart, so neither is served as the other');

// ---- mlpicks-export?date= ----------------------------------------------------------------
const day = JSON.parse((await get('/api/mlpicks-export?date=2026-09-29')).text);
ok(day.n === 2 && day.rows.every((r) => r[day.cols.indexOf('date')] === '2026-09-29'),
  `?date= returns that day's graded picks only (${day.n})`);
const bad = JSON.parse((await get('/api/mlpicks-export?date=yesterday')).text);
ok(bad.n === 3, `a malformed date is ignored rather than returning nothing (${bad.n})`);
const all = JSON.parse((await get('/api/mlpicks-export')).text);
ok(all.n === 3, 'and the plain export is unchanged');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exitCode = fail ? 1 : 0;
