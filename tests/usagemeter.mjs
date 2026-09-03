// Guards per-route credit attribution.
//
// The old telemetry metered two call sites out of ten and still presented its
// `calls` number as a total — 64 calls against 6,811 credits on 2026-09-03. That
// is worse than no number, because it reads like one. This checks both halves of
// the fix: that every paid call site is attributed, and that a NEW one cannot be
// added without a meter (the static half, which is the part that rots).
import fs from 'node:fs';
import path from 'node:path';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const realFetch = globalThis.fetch;

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

// ---- static: no paid call site without a meter -------------------------------
// Deliberately a source check. The functional half below only covers the paths a
// test happens to drive; this covers the ones nobody remembered to drive, which
// is exactly how board()'s strikeout fetch went unmetered for its whole life.
{
  const src = fs.readFileSync(BOARD + '/worker.js', 'utf8').split('\n');
  const at = [];
  for (let i = 0; i < src.length; i++) {
    if (!/await fetch\(/.test(src[i])) continue;
    // A multi-line fetch puts its URL on a following line, so look at the call
    // and the two lines under it before deciding it is not a paid one.
    const near = src.slice(i, i + 3).join('\n');
    // `upstream` is proxy()'s parameter — /api/odds and /api/scores reach the
    // paid API through a variable, so a pattern that only knew literal URLs
    // could not see the two call sites that had never been metered at all.
    if (/\$\{ODDS\}|the-odds-api\.com|eventsUrl\(|\$\{base\}|fetch\(upstream/.test(near)) at.push(i);
  }
  // The meter has to appear before the NEXT paid call, so one site's meter can
  // never be mistaken for its neighbour's. A fixed lookahead did exactly that in
  // reverse: the NFL fetch wraps over four lines and its meter fell outside the
  // window, reporting a site that was in fact metered.
  const paid = at.map((i, n) => {
    const end = n + 1 < at.length ? at[n + 1] : Math.min(src.length, i + 14);
    return { line: i + 1, metered: /recordOddsUsage\(/.test(src.slice(i, end).join('\n')) };
  });
  console.log(`-- every paid call site carries a meter --`);
  console.log(`         call sites at worker.js:${paid.map((p) => p.line).join(', :')}`);
  ok(paid.length >= 9, `found the paid call sites to check (${paid.length})`);
  const bare = paid.filter((p) => !p.metered).map((p) => p.line);
  ok(bare.length === 0,
    bare.length ? `UNMETERED Odds API fetch at worker.js:${bare.join(', :')}`
      : `all ${paid.length} spend credits through a recorded call`);
}

// ---- functional: the routes are real and the credits are the API's own ------
const NOW = Date.now();
const OFFSETS_MIN = [70, 95, 120];
const events = OFFSETS_MIN.map((m, i) => ({
  id: 'ev' + i,
  commence_time: new Date(NOW + m * 60000).toISOString(),
  home_team: 'Team H' + i, away_team: 'Team A' + i,
}));
const schedule = {
  dates: [{
    games: OFFSETS_MIN.map((m, i) => ({
      gamePk: 700000 + i,
      gameDate: new Date(NOW + m * 60000).toISOString(),
      status: { abstractGameState: 'Preview' },
      teams: {
        away: { team: { id: 100 + i, name: 'Team A' + i }, probablePitcher: { id: 900 + i, fullName: 'Arm A' + i } },
        home: { team: { id: 200 + i, name: 'Team H' + i }, probablePitcher: { id: 950 + i, fullName: 'Arm H' + i } },
      },
      venue: { name: 'Park ' + i },
    })),
  }],
};

// COST is what the API says the call cost. The meter must use this number and
// not, say, count calls and multiply — the whole point is to stop inferring.
const COST = { perEvent: 3, list: 0, league: 4 };
let sendCostHeader = true;
const J = (x, credits) => {
  const h = { 'content-type': 'application/json', 'x-requests-remaining': '90000' };
  if (sendCostHeader && credits != null) h['x-requests-last'] = String(credits);
  return new Response(JSON.stringify(x), { status: 200, headers: h });
};
globalThis.fetch = async (u, o) => {
  const url = String(u);
  if (url.includes('/schedule?')) return new Response(JSON.stringify(schedule), { headers: { 'content-type': 'application/json' } });
  if (!url.includes('api.the-odds-api.com')) return realFetch(u, o);
  if (url.includes('/events?')) return J(events, COST.list);
  if (/\/events\/ev\d+\/odds/.test(url)) return J({ bookmakers: [] }, COST.perEvent);
  if (url.includes('/odds?')) return J([], COST.league);
  return J({}, 0);
};

const src = fs.readFileSync(BOARD + '/worker.js', 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));

// D1 stub that actually applies the odds_route upsert, so the summing is tested
// rather than assumed. batch() is modelled because recordOddsUsage writes both
// tables in one.
function makeDb() {
  const routes = new Map();   // "day|route" -> {credits, calls, blind}
  const apply = (sql, a) => {
    if (/^INSERT INTO odds_route/i.test(sql)) {
      const [day, route, credits, blind] = a;
      const k = day + '|' + route;
      const cur = routes.get(k) || { route, credits: 0, calls: 0, blind: 0 };
      cur.credits += credits; cur.calls += 1; cur.blind += blind;
      routes.set(k, cur);
    }
    return { success: true, meta: { changes: 1 } };
  };
  const prepare = (sql) => {
    const st = { sql, args: [], bind: (...a) => { st.args = a; return st; },
      run: async () => apply(st.sql, st.args), first: async () => null, all: async () => ({ results: [] }) };
    return st;
  };
  return { db: { prepare, batch: async (sts) => sts.map((s) => apply(s.sql, s.args)) }, routes };
}

const pending = [];
const ctx = { waitUntil: (p) => { if (p && p.then) pending.push(p.catch(() => {})); } };
const settle = async () => { await Promise.all(pending.splice(0)); };
const env0 = { ODDS_API_KEY: 'k' };

{
  const { db, routes } = makeDb();
  await mod.default.fetch(new Request('https://x/api/batters'), { ...env0, DB: db }, ctx);
  await settle();
  const seen = [...routes.values()];
  const byRoute = Object.fromEntries(seen.map((r) => [r.route, r]));
  console.log('\n-- /api/batters attributes its own spend --');
  ok(!!byRoute['batters:props'], 'the per-event prop fetches are attributed to batters:props');
  ok(!!byRoute['batters:events'], 'the event list is attributed to batters:events');
  ok(!seen.some((r) => r.route === 'unattributed'), 'nothing lands in unattributed');
  const props = byRoute['batters:props'];
  ok(props && props.credits === props.calls * COST.perEvent,
    `credits are summed from x-requests-last (${props && props.credits} = ${props && props.calls} x ${COST.perEvent})`);
  ok(seen.every((r) => r.blind === 0), 'no blind calls when the API reports its cost');
}

{
  const { db, routes } = makeDb();
  await mod.default.fetch(new Request('https://x/api/board'), { ...env0, DB: db }, ctx);
  await settle();
  const names = [...routes.values()].map((r) => r.route).sort();
  console.log('\n-- /api/board attributes the three that were never metered --');
  for (const want of ['board:events', 'board:kprops', 'board:h2h+runline']) {
    ok(names.includes(want), `${want} is recorded`);
  }
}

{
  // A response with no x-requests-last must not be silently counted as free.
  sendCostHeader = false;
  const { db, routes } = makeDb();
  await mod.default.fetch(new Request('https://x/api/batters'), { ...env0, DB: db }, ctx);
  await settle();
  sendCostHeader = true;
  const seen = [...routes.values()];
  console.log('\n-- a cost the API did not report is flagged, not assumed zero --');
  ok(seen.length > 0 && seen.every((r) => r.blind === r.calls),
    'every unreported call is counted as blind');
  ok(seen.every((r) => r.credits === 0),
    'and contributes 0 credits rather than a guess');
}

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
