// Verifies the cron's close-capture pass fetches only the games that are
// actually closing, and that the normal board path is untouched.
//
// Counts real per-event Odds API calls against a synthetic healthy feed, since
// the live quota is exhausted and would return zero events either way.
import fs from 'node:fs';
import path from 'node:path';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const realFetch = globalThis.fetch;

// A staggered slate: one game 8 minutes out (inside a 15-minute window), the
// rest spread hours later. This is the shape that made the whole-slate refresh
// expensive — one game closing, a dozen re-priced for no reason.
const NOW = Date.now();
const OFFSETS_MIN = [8, 45, 95, 140, 190, 240, 300, 355, 410, 465, 520];
const events = OFFSETS_MIN.map((m, i) => ({
  id: 'ev' + i,
  commence_time: new Date(NOW + m * 60000).toISOString(),
  home_team: 'Team H' + i, away_team: 'Team A' + i,
}));

// captureCloses decides whether anything is near pitch from the MLB SCHEDULE,
// not from the odds events — so the schedule has to carry the same slate or the
// cron correctly finds nothing to do and the test measures a no-op.
const schedule = {
  dates: [{
    games: OFFSETS_MIN.map((m, i) => ({
      gamePk: 700000 + i,
      gameDate: new Date(NOW + m * 60000).toISOString(),
      status: { abstractGameState: 'Preview' },
      teams: {
        away: { team: { id: 100 + i, name: 'Team A' + i } },
        home: { team: { id: 200 + i, name: 'Team H' + i } },
      },
      venue: { name: 'Park ' + i },
    })),
  }],
};

let perEventCalls = 0, eventListCalls = 0;
globalThis.fetch = async (u, o) => {
  const url = String(u);
  const J = (x) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.includes('/schedule?')) return J(schedule);
  if (!url.includes('api.the-odds-api.com')) return realFetch(u, o);
  if (url.includes('/events?')) { eventListCalls++; return J(events); }
  if (/\/events\/ev\d+\/odds/.test(url)) { perEventCalls++; return J({ bookmakers: [] }); }
  return J({});
};

const src = fs.readFileSync(BOARD + '/worker.js', 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));

// Reach the internals the cron uses. The module only exports its fetch handler,
// so the functions are exercised through the same entry points the cron uses:
// a normal request for the unscoped path, and a scheduled tick for the scoped one.
// captureCloses bails immediately without a DB ("nothing to freeze"), so the
// cron path is unreachable with DB:null — the first run measured a no-op and
// reported a 100% saving, which is what the "did not become a no-op" assertion
// is there to catch. A chainable stub is enough: this test counts fetches, and
// the writes are exercised elsewhere.
const stmt = {
  bind: () => stmt,
  run: async () => ({ success: true }),
  all: async () => ({ results: [] }),
  first: async () => null,
};
const env = { ODDS_API_KEY: 'k', DB: { prepare: () => stmt, batch: async () => [] } };
const ctx = { waitUntil: (p) => { if (p && p.catch) p.catch(() => {}); } };

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

console.log(`slate: ${events.length} games, first in ${OFFSETS_MIN[0]} min, last in ${OFFSETS_MIN[OFFSETS_MIN.length - 1]} min`);
console.log(`inside a 15-minute close window: ${OFFSETS_MIN.filter((m) => m <= 15).length}`);

// ---- normal board request: unscoped, should price the whole upcoming slate ---
perEventCalls = 0; eventListCalls = 0;
await mod.default.fetch(new Request('https://x/api/batters'), env, ctx);
const normal = perEventCalls;
console.log(`\nnormal /api/batters      : ${normal} per-event fetches`);

// ---- the cron's scheduled tick: scoped to the closing game only -------------
perEventCalls = 0;
await mod.default.scheduled({}, env, ctx);
// scheduled() runs captureCloses through waitUntil; give it a tick to finish.
await new Promise((r) => setTimeout(r, 2500));
const cron = perEventCalls;
console.log(`cron close-capture tick  : ${cron} per-event fetches`);

console.log('\n-- the normal board is unchanged --');
ok(normal >= 10, `a normal request still prices the slate (${normal} of ${events.length})`);

console.log('\n-- the cron only touches what is closing --');
ok(cron > 0, 'the cron still captures a close (it did not become a no-op)');
ok(cron < normal, `the cron fetches fewer than a full refresh (${cron} vs ${normal})`);
ok(cron <= 2, `the cron is scoped to the closing game(s), not the slate (${cron})`);
if (normal > 0) {
  const saved = Math.round((1 - cron / normal) * 100);
  console.log(`\n   saving on the close-capture pass: ${saved}% (${normal - cron} fetches per firing)`);
  ok(saved >= 60, `saving is substantial (${saved}%)`);
}

console.log('\n-- the window itself is untouched --');
const wsrc = fs.readFileSync(BOARD + '/worker.js', 'utf8');
ok(/const CLOSE_WINDOW_MIN = 15;/.test(wsrc),
  'CLOSE_WINDOW_MIN is still 15 — narrowing it would cost sharp-sourced closes');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
