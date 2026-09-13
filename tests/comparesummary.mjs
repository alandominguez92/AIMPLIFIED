// Guards /api/nfl-compare's summary mode and its edge-cache key.
//
// Two failures, both of which would read as "grading did not work" rather than
// as what they are.
//
// 1. SIZE. With ?all=1 the response ran past 100KB, and the `graded` block — the
//    verdict a scheduled run exists to report — sat at the very end. The Week 1
//    capture run could not read it inline, wrote a script to parse it, hit a
//    permission prompt nobody was there to answer, and stalled.
//
// 2. CACHE. The edge cache keyed this route by path alone. ?all=1 (played games
//    included) could therefore be answered from a cached upcoming-only body left
//    by anyone who opened the NFL board within the minute: zero graded rows. And
//    a ?summary=1 body, which has no rows, could be cached under the plain path
//    the board reads, blanking the board for a minute.
import fs from 'node:fs';
import path from 'node:path';
const BOARD = path.join(import.meta.dirname, '..');

// A real key->response cache, so the collision is exercised rather than assumed.
const store = new Map();
globalThis.caches = { default: {
  match: async (req) => { const r = store.get(typeof req === 'string' ? req : req.url); return r ? r.clone() : undefined; },
  put: async (req, res) => { store.set(typeof req === 'string' ? req : req.url, res); },
} };

const NOW = Date.now();
const PAST = new Date(NOW - 20 * 3600e3).toISOString();    // a played game
const FUTURE = new Date(NOW + 20 * 3600e3).toISOString();  // an upcoming one

// 40 players per game, so the full body is large and summary mode has to be small.
const proj = [];
for (const [evt, commence, graded] of [['evPast', PAST, true], ['evNext', FUTURE, false]]) {
  for (let i = 0; i < 40; i++) {
    proj.push({ event_id: evt, player: `Player ${evt} ${i}`, market: 'receiving', team: 'AAA', pos: 'WR',
      game: evt === 'evPast' ? 'AAA @ BBB' : 'CCC @ DDD', commence,
      proj: 60 + (i % 7), p25: 40, p50: 58, p75: 80, conf: 1 + (i % 3),
      actual: graded ? 50 + (i % 9) : null, captured_at: PAST });
  }
}
const quotes = proj.map((p) => ({ event_id: p.event_id, market: 'player_reception_yds', player: p.player,
  point: 55.5, book: 'draftkings', over: -110, under: -110, captured_at: PAST }));

const db = { prepare: (sql) => {
  const st = { sql, args: [], bind: (...a) => { st.args = a; return st; },
    run: async () => ({ meta: { changes: 0 } }), first: async () => null,
    all: async () => {
      if (/FROM nfl_proj/i.test(sql)) {
        // Without ?all=1 the route adds `commence > ?`: upcoming games only.
        const upcomingOnly = /commence > \?/i.test(sql);
        return { results: proj.filter((p) => !upcomingOnly || p.commence > new Date(NOW).toISOString()) };
      }
      if (/FROM nfl_lines/i.test(sql)) return { results: quotes };
      return { results: [] };
    } };
  return st;
}, batch: async (s) => s.map(() => ({ meta: { changes: 0 } })) };

globalThis.fetch = async () => new Response('{}', { status: 404 });

const src = fs.readFileSync(BOARD + '/worker.js', 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const env = { DB: db };
const get = async (q) => {
  const pending = [];
  const ctx = { waitUntil: (p) => { if (p && p.then) pending.push(p.catch(() => {})); } };
  const res = await mod.default.fetch(new Request('https://x/api/nfl-compare' + q), env, ctx);
  const text = await res.text();
  await Promise.all(pending);   // let the cache.put land before the next request
  return { body: JSON.parse(text), bytes: text.length };
};

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

console.log('-- summary mode is small and still carries the verdict --');
const full = await get('?all=1');
const sum = await get('?all=1&summary=1');
ok(Array.isArray(full.body.rows) && full.body.rows.length === 80, `the full body has every row (${full.body.rows && full.body.rows.length})`);
ok(!('rows' in sum.body), 'summary mode drops the rows');
ok(sum.body.rowCount === 80, `but says how many there were (${sum.body.rowCount})`);
ok(sum.body.graded && sum.body.graded.n === 40 && typeof sum.body.graded.verdict === 'string',
  `and keeps the graded block, verdict included (n=${sum.body.graded && sum.body.graded.n})`);
ok(sum.body.summary && sum.body.summary.projections === 80, 'and the capture summary');
ok(sum.bytes < full.bytes / 10, `at a tenth of the size or less (${sum.bytes} vs ${full.bytes} bytes)`);

console.log('\n-- the edge cache keeps the three forms apart --');
store.clear();
// The board loads first and caches the upcoming-only body under the plain path.
const board1 = await get('');
ok(board1.body.rows.length === 40 && !board1.body.graded, `plain: upcoming games only, nothing graded (${board1.body.rows.length})`);
// The grading run arrives within the same minute. It must not be handed that body.
const grading = await get('?all=1&summary=1');
ok(grading.body.graded && grading.body.graded.n === 40,
  `?all=1 is not served the board's cached upcoming-only body (graded n=${grading.body.graded && grading.body.graded.n})`);
ok(!('rows' in grading.body), 'and gets the summary shape it asked for');
// And the rowless summary must not now be served to the board.
const board2 = await get('');
ok(Array.isArray(board2.body.rows) && board2.body.rows.length === 40,
  `the board still gets its rows after a summary request was cached (${board2.body.rows && board2.body.rows.length})`);
ok(store.size === 2, `two cache entries, one per form (${store.size})`);

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
