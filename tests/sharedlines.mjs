// Guards the shared line store (feed_cache) that collapses per-colo spend.
//
// caches.default is per-colo, so before this the site bought the same slate once
// per Cloudflare colo per TTL — the quota bill scaled with how geographically
// spread the traffic happened to be. The store is in D1, which is global, so the
// first colo to ask pays and the rest read what it bought.
//
// Counts real per-event Odds API calls, same method as crontest: a saving that
// only exists in the comments is not a saving. Every request here goes through
// the handler with a permanently-missing colo cache, which is exactly what a
// second colo looks like.
import fs from 'node:fs';
import path from 'node:path';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const realFetch = globalThis.fetch;

const NOW = Date.now();
// Well inside PROP_LEAD_MS (12h) so the lead-time gate is not what is being
// measured, and >3h out so the far TTL applies.
const SLATE_MIN = [220, 245, 270, 295, 320, 345];
// The cron only acts on a game inside CLOSE_WINDOW_MIN, so the close-capture
// case needs its own slate — with none near pitch, captureCloses correctly does
// nothing and the assertion would be measuring a no-op.
const CLOSING_MIN = [8, 245, 270, 295, 320, 345];

const buildSlate = (offsets) => ({
  events: offsets.map((m, i) => ({
    id: 'ev' + i,
    commence_time: new Date(NOW + m * 60000).toISOString(),
    home_team: 'Team H' + i, away_team: 'Team A' + i,
  })),
  schedule: {
    dates: [{
      games: offsets.map((m, i) => ({
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
  },
});
let slate = buildSlate(SLATE_MIN);
const events = slate.events;
// Two priced hitters per event, so byName is populated and the store has
// something real to hold. Whether these match a roster does not matter: the save
// happens on the lines as bought, before any player matching.
const propBody = (i) => ({
  bookmakers: ['draftkings', 'fanduel'].map((key) => ({
    key,
    markets: [{
      key: 'batter_total_bases',
      outcomes: [`Hitter A${i}`, `Hitter B${i}`].flatMap((n) => ([
        { name: 'Over', description: n, point: 1.5, price: -115 },
        { name: 'Under', description: n, point: 1.5, price: -105 },
      ])),
    }],
  })),
});

let perEventCalls = 0;
let failEveryPropCall = false;
globalThis.fetch = async (u, o) => {
  const url = String(u);
  const J = (x, s) => new Response(JSON.stringify(x), { status: s || 200, headers: { 'content-type': 'application/json' } });
  if (url.includes('/schedule?')) return J(slate.schedule);
  if (!url.includes('api.the-odds-api.com')) return realFetch(u, o);
  if (url.includes('/events?')) return J(slate.events);
  const m = url.match(/\/events\/ev(\d+)\/odds/);
  if (m) {
    perEventCalls++;
    if (failEveryPropCall) return J({ message: 'Usage quota has been reached' }, 401);
    return J(propBody(m[1]));
  }
  return J({});
};

const src = fs.readFileSync(BOARD + '/worker.js', 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));

// An in-memory stand-in for the feed_cache table. Only the four statements the
// store issues are modelled; everything else answers empty, which is what the
// worker's other D1 paths already tolerate (they are all best-effort).
// meta.changes is reported honestly, because the single-flight claim is decided
// on exactly that number.
function makeDb() {
  const rows = new Map();
  const run = (sql, args) => {
    if (/^INSERT OR IGNORE INTO feed_cache/i.test(sql)) {
      const [key] = args;
      if (rows.has(key)) return { success: true, meta: { changes: 0 } };
      rows.set(key, { data: null, updated_at: 0, claimed_until: 0 });
      return { success: true, meta: { changes: 1 } };
    }
    if (/^UPDATE feed_cache SET claimed_until/i.test(sql)) {
      const [until, key, now] = args;
      const r = rows.get(key);
      if (!r || !(r.claimed_until <= now)) return { success: true, meta: { changes: 0 } };
      r.claimed_until = until;
      return { success: true, meta: { changes: 1 } };
    }
    if (/^INSERT OR REPLACE INTO feed_cache/i.test(sql)) {
      const [key, data, updated] = args;
      rows.set(key, { data, updated_at: updated, claimed_until: 0 });
      return { success: true, meta: { changes: 1 } };
    }
    return { success: true, meta: { changes: 0 } };
  };
  const first = (sql, args) => {
    if (/FROM feed_cache WHERE key=\?/i.test(sql)) {
      const r = rows.get(args[0]);
      return (r && r.data) ? { data: r.data, updated_at: r.updated_at } : null;
    }
    return null;
  };
  const prepare = (sql) => {
    let args = [];
    const st = {
      bind: (...a) => { args = a; return st; },
      run: async () => run(sql, args),
      first: async () => first(sql, args),
      all: async () => ({ results: [] }),
    };
    return st;
  };
  return { db: { prepare, batch: async () => [] }, rows };
}

const pending = [];
const ctx = { waitUntil: (p) => { if (p && p.then) pending.push(p.catch(() => {})); } };
const settle = async () => { await Promise.all(pending.splice(0)); };

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

const hit = async (env, url) => {
  const r = await mod.default.fetch(new Request(url || 'https://x/api/batters'), env, ctx);
  await settle();
  return r;
};

console.log(`slate: ${events.length} games, all >3h out (far TTL), inside the 12h prop window\n`);

// ---- colo 1 pays, colo 2 does not -------------------------------------------
{
  const { db, rows } = makeDb();
  const env = { ODDS_API_KEY: 'k', DB: db };

  perEventCalls = 0;
  await hit(env);
  const first = perEventCalls;

  perEventCalls = 0;
  await hit(env);
  const second = perEventCalls;

  console.log('-- a second colo in the same window --');
  ok(first === events.length, `first colo prices the slate (${first} of ${events.length} per-event fetches)`);
  ok(second === 0, `second colo spends nothing (${second} per-event fetches)`);
  const stored = [...rows.values()].find((r) => r.data);
  ok(!!stored, 'the lines were published to the shared store');
  const parsed = stored ? JSON.parse(stored.data) : {};
  ok(Object.keys(parsed).length === events.length * 2,
    `the store holds every priced hitter (${Object.keys(parsed).length} of ${events.length * 2})`);
  const one = Object.values(parsed)[0] || {};
  ok(!!(one.props && one.props.tb), 'a stored record carries its book lines');
  ok(one.awayAb != null && one.homeAb != null,
    'a stored record carries the abbreviations its matchup is rebuilt from');
  ok(one.gameStatus === undefined && one.awayScore === undefined,
    'status and score are NOT stored — they are re-read from the schedule each time');
}

// ---- the TTL follows first pitch ---------------------------------------------
// The saving here is entirely in the far window: a flat 300 re-bought the slate
// twelve times an hour while the nearest start was still half a day away. The
// near window is asserted unchanged, because tightening it would quietly hand
// back the saving somewhere no one was looking.
{
  const maxAge = (r) => Number((/max-age=(\d+)/.exec(r.headers.get('cache-control') || '') || [])[1]);

  slate = buildSlate(SLATE_MIN);                 // nearest start 220 min (>3h)
  let env = { ODDS_API_KEY: 'k', DB: makeDb().db };
  const far = maxAge(await hit(env));

  slate = buildSlate([45, 90, 150, 200]);        // nearest start 45 min (<3h)
  env = { ODDS_API_KEY: 'k', DB: makeDb().db };
  const near = maxAge(await hit(env));

  console.log('\n-- the TTL follows first pitch --');
  ok(far === 900, `hours from first pitch, the board caches for 15 min (${far}s)`);
  ok(near === 300, `inside three hours it is unchanged at 5 min (${near}s)`);
  slate = buildSlate(SLATE_MIN);
}

// ---- single flight: two colos expiring the same warm window ------------------
// The case that actually recurs. A cold store is deliberately NOT single-flighted
// (see the fallthrough in batters(): a colo that loses the claim with nothing
// stored fetches anyway rather than opening the board empty), and that happens
// once a day. This happens every window.
{
  const { db, rows } = makeDb();
  const env = { ODDS_API_KEY: 'k', DB: db };
  await hit(env);                                  // warm it
  for (const r of rows.values()) if (r.data) r.updated_at = Date.now() - 3600000; // now stale

  perEventCalls = 0;
  await Promise.all([
    mod.default.fetch(new Request('https://x/api/batters'), env, ctx),
    mod.default.fetch(new Request('https://x/api/batters'), env, ctx),
  ]);
  await settle();
  console.log('\n-- two colos expiring the same window at once --');
  ok(perEventCalls === events.length,
    `only one of them re-buys the slate (${perEventCalls} fetches, not ${events.length * 2})`);
}

// ---- an outage is never published -------------------------------------------
{
  const { db, rows } = makeDb();
  const env = { ODDS_API_KEY: 'k', DB: db };
  failEveryPropCall = true;
  perEventCalls = 0;
  await hit(env);
  failEveryPropCall = false;

  console.log('\n-- a 401 slate is not cached --');
  const stored = [...rows.values()].find((r) => r.data);
  ok(!stored, 'a feed error is not published to the store');

  // ...and the next colo is therefore free to try again rather than inheriting it.
  perEventCalls = 0;
  await hit(env);
  ok(perEventCalls === events.length,
    `the next colo re-tries the feed (${perEventCalls} fetches) instead of serving the outage`);
}

// ---- the close capture always sees the live book -----------------------------
{
  slate = buildSlate(CLOSING_MIN);      // one game 8 min out, inside the window
  const { db } = makeDb();
  const env = { ODDS_API_KEY: 'k', DB: db };
  await hit(env);                       // fill the store
  perEventCalls = 0;
  await mod.default.scheduled({}, env, ctx);
  await new Promise((r) => setTimeout(r, 2500));
  console.log('\n-- closing lines are never read from cache --');
  ok(perEventCalls > 0,
    `the cron still calls the book with a warm store (${perEventCalls} fetches)`);
  ok(perEventCalls < CLOSING_MIN.length,
    `and only for what is closing (${perEventCalls} of ${CLOSING_MIN.length} games)`);
}

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
