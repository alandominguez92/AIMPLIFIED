// Guards the failed-write counter on the credit ledger.
//
// On 2026-09-12 the last ledger write landed at 19:51Z, mid-slate. Nothing more
// was recorded until midnight UTC while about 632 credits went out, and the only
// sign was a reconciliation gap the next day, pinned on the wrong date. The
// write sat in a catch that swallowed everything, so the failure left no trace.
//
// The counter lives in memory for a reason this file tests directly: if the
// database is what is refusing writes, a failure record written to it fails
// too. So the checks run in the order an outage does — database down, calls keep
// going, someone asks /api/usage while it is STILL down, then it comes back.
import fs from 'node:fs';
import path from 'node:path';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const realFetch = globalThis.fetch;

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

const NOW = Date.now();
const OFFSETS_MIN = [70, 95, 120];
const events = OFFSETS_MIN.map((m, i) => ({
  id: 'ev' + i, commence_time: new Date(NOW + m * 60000).toISOString(),
  home_team: 'Team H' + i, away_team: 'Team A' + i,
}));
const schedule = { dates: [{ games: OFFSETS_MIN.map((m, i) => ({
  gamePk: 700000 + i, gameDate: new Date(NOW + m * 60000).toISOString(),
  status: { abstractGameState: 'Preview' },
  teams: {
    away: { team: { id: 100 + i, name: 'Team A' + i }, probablePitcher: { id: 900 + i, fullName: 'Arm A' + i } },
    home: { team: { id: 200 + i, name: 'Team H' + i }, probablePitcher: { id: 950 + i, fullName: 'Arm H' + i } },
  },
  venue: { name: 'Park ' + i },
})) }] };

let sendRemaining = true;
const J = (x, credits) => {
  const h = { 'content-type': 'application/json' };
  if (sendRemaining) { h['x-requests-remaining'] = '90000'; h['x-requests-last'] = String(credits); }
  return new Response(JSON.stringify(x), { status: 200, headers: h });
};
globalThis.fetch = async (u, o) => {
  const url = String(u);
  if (url.includes('/schedule?')) return new Response(JSON.stringify(schedule), { headers: { 'content-type': 'application/json' } });
  if (!url.includes('api.the-odds-api.com')) return realFetch(u, o);
  if (url.includes('/events?')) return J(events, 0);
  if (/\/events\/ev\d+\/odds/.test(url)) return J({ bookmakers: [] }, 3);
  if (url.includes('/odds?')) return J([], 4);
  return J({}, 0);
};

const src = fs.readFileSync(BOARD + '/worker.js', 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));

// A database that can be switched off. When down, EVERY statement throws with a
// D1-shaped message, reads included — that is the outage being modelled.
const D1_MSG = 'D1_ERROR: exceeded daily rows written limit';
const state = { down: false, meterFail: new Map(), routeCalls: 0, flushes: 0 };
function prepare(sql) {
  const st = {
    sql, args: [],
    bind: (...a) => { st.args = a; return st; },
    run: async () => { if (state.down) throw new Error(D1_MSG); return apply(st); },
    first: async () => { if (state.down) throw new Error(D1_MSG); return null; },
    all: async () => {
      if (state.down) throw new Error(D1_MSG);
      if (/FROM odds_meter_fail/i.test(st.sql)) {
        return { results: [...state.meterFail.entries()].map(([day, v]) => ({ day, ...v })) };
      }
      return { results: [] };
    },
  };
  return st;
}
function apply(st) {
  if (/^INSERT INTO odds_route/i.test(st.sql)) state.routeCalls++;
  if (/^INSERT INTO odds_meter_fail/i.test(st.sql)) {
    state.flushes++;
    const [day, n, firstAt, lastAt, lastError] = st.args;
    const cur = state.meterFail.get(day);
    if (!cur) state.meterFail.set(day, { failures: n, first_at: firstAt, last_at: lastAt, last_error: lastError });
    else { cur.failures += n; cur.last_at = lastAt; cur.last_error = lastError; }
  }
  return { success: true, meta: { changes: 1 } };
}
// A real batch takes network time. Without some here every write resolves in the
// same microtask, the recovered writes never overlap, and the double-flush race
// the next section guards cannot happen — the first version of this test passed
// with the guard deleted, which is how that was found.
const db = {
  prepare,
  batch: async (sts) => {
    if (state.down) throw new Error(D1_MSG);
    await new Promise((r) => setTimeout(r, 8));
    return sts.map(apply);
  },
};

const pending = [];
const ctx = { waitUntil: (p) => { if (p && p.then) pending.push(p.catch(() => {})); } };
const settle = async () => { await Promise.all(pending.splice(0)); };
const env = { ODDS_API_KEY: 'k', DB: db };
const usage = async () => (await mod.default.fetch(new Request('https://x/api/usage?cb=' + Math.random()), env, ctx)).json();

// ---- 1. the database goes down and calls keep happening ---------------------
state.down = true;
await mod.default.fetch(new Request('https://x/api/batters'), env, ctx);
await settle();
const downCalls = 4;   // the event list plus one prop fetch per game — the metered calls that failed to write

console.log('-- while the database is down, the failures are still visible --');
const u1 = await usage();
ok(!!u1.error, `/api/usage cannot read the database either (${u1.error && u1.error.slice(0, 40)}...)`);
ok(u1.meterFailures && u1.meterFailures.thisIsolate,
  'but it still answers with this isolate\'s failure count — attached before any read');
const iso1 = (u1.meterFailures || {}).thisIsolate || {};
ok(iso1.unflushed >= downCalls,
  `every metered call that could not be written is counted (${iso1.unflushed} >= ${downCalls})`);
ok(iso1.lastError === D1_MSG, `and the database's own error is kept: "${iso1.lastError}"`);
ok(state.meterFail.size === 0, 'nothing reached the failure table — the database was refusing writes');

// ---- 2. the database comes back ----------------------------------------------
state.down = false;
// Two boards at once, so a dozen recovered writes land together and each one
// reaches flushMeterFailures while the first flush is still awaiting its batch.
await Promise.all([
  mod.default.fetch(new Request('https://x/api/batters?again=1'), env, ctx),
  mod.default.fetch(new Request('https://x/api/board?again=1'), env, ctx),
]);
await settle();

console.log('\n-- the next write that succeeds writes the failures down --');
const today = new Date().toISOString().slice(0, 10);
const row = state.meterFail.get(today);
ok(!!row, 'a failure row now exists for today');
ok(row && row.failures === iso1.unflushed,
  `with exactly the count seen in memory, not a multiple of it (${row && row.failures} = ${iso1.unflushed})`);
// The successful writes that come back land concurrently, and each one tries to
// flush. Without the synchronous swap every one of them would write the same
// failures, and the durable count would be inflated by however many landed together.
ok(state.flushes === 1, `flushed once even though several writes succeeded together (${state.flushes})`);
ok(row && row.last_error === D1_MSG, 'the error survives the round trip');

const u2 = await usage();
ok(!u2.error, 'with the database back, /api/usage reads normally');
ok((u2.meterFailures.days || []).some((d) => d.day === today && d.failures === iso1.unflushed),
  'and reports the durable count under meterFailures.days');
ok(u2.meterFailures.thisIsolate.unflushed === 0, 'nothing is left waiting in memory');

console.log('\n-- a missing quota header is not a failed write --');
// An upstream response without x-requests-remaining has nothing to record. Counting
// it as a failure would report a database problem that does not exist.
const before = (await usage()).meterFailures.thisIsolate.seenSinceStart;
sendRemaining = false;
await mod.default.fetch(new Request('https://x/api/batters?nohdr=1'), env, ctx);
await settle();
sendRemaining = true;
const after = (await usage()).meterFailures.thisIsolate.seenSinceStart;
ok(after === before, `no failure counted for a response with no quota header (${before} -> ${after})`);

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
