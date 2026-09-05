// Guards the hits-allowed projection: the shrinkage, the calibration, and the
// grading that turns it into a record.
//
// The shrinkage is the part worth a test. Unregressed, an arm with a dozen
// innings and an H/9 of 15.3 projected 11.6 hits — against any real line that
// reads as an enormous edge and is entirely sample noise. Nothing about that is
// visible on the board; it just looks like a strong opinion. So it is asserted
// numerically rather than eyeballed.
//
// Nothing here is priced or bet: the market is projection-only, and these
// checks are about accuracy, not ROI.
import fs from 'node:fs';
import path from 'node:path';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const realFetch = globalThis.fetch;

// Constants under test, mirrored from worker.js. If they are retuned there this
// file should be retuned with them — deliberately duplicated so a silent edit
// to one shows up as a failure rather than as two files agreeing on a new value.
const LG_H9 = 8.32, PRIOR_IP = 60, CAL = 0.923;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const expect = (h9, ip, gs) => {
  const shrunk = (h9 * ip + LG_H9 * PRIOR_IP) / (ip + PRIOR_IP);
  return shrunk * clamp(ip / gs, 4, 6.8) / 9 * CAL;   // opponent factor is 1 below
};

const ARMS = {
  901: { name: 'Ace Workhorse', h9: 5.5, ip: 180, gs: 30 },   // long sample, keeps his rate
  902: { name: 'Small Sample', h9: 15.3, ip: 12, gs: 1 },     // the Kade Morris case
};
const NOW = Date.now();
const games = [{
  gamePk: 770001,
  gameDate: new Date(NOW + 3 * 3600000).toISOString(),
  status: { abstractGameState: 'Preview' },
  teams: {
    away: { team: { id: 111, name: 'Team Away', abbreviation: 'AWY' }, probablePitcher: { id: 901, fullName: 'Ace Workhorse' } },
    home: { team: { id: 222, name: 'Team Home', abbreviation: 'HOM' }, probablePitcher: { id: 902, fullName: 'Small Sample' } },
  },
  venue: { name: 'Neutral Park' },
}];

// Every team hits at exactly the league rate, so oppH/lgH is 1 and the expected
// numbers above are the whole model. A skewed opponent would make a failure here
// ambiguous between the shrinkage and the context term.
const teamHitting = {
  stats: [{
    splits: [111, 222].map((id) => ({
      team: { id }, stat: { hits: 1300, plateAppearances: 6000, strikeOuts: 1330 },
    })),
  }],
};
const people = {
  people: Object.entries(ARMS).map(([id, a]) => ({
    id: Number(id), fullName: a.name, pitchHand: { code: 'R' },
    stats: [{ splits: [{ stat: {
      strikeoutsPer9Inn: 8.5, hitsPer9Inn: a.h9, inningsPitched: String(a.ip),
      gamesStarted: a.gs, era: '3.50',
    } }] }],
  })),
};

globalThis.fetch = async (u, o) => {
  const url = String(u);
  const J = (x) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.includes('/schedule?')) return J({ dates: [{ games }] });
  if (url.includes('/teams/stats') && url.includes('group=hitting')) return J(teamHitting);
  if (url.includes('/people?')) return J(people);
  if (url.includes('api.the-odds-api.com')) return new Response(JSON.stringify({ message: 'no key' }), { status: 401, headers: { 'content-type': 'application/json' } });
  if (url.includes('statsapi.mlb.com')) return J({});
  return realFetch(u, o);
};

const src = fs.readFileSync(BOARD + '/worker.js', 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));

// D1 stub that really applies the proj_log statements, so INSERT OR IGNORE and
// the "only fill actual when NULL" grading rule are exercised, not assumed.
function makeDb() {
  const log = new Map();                      // key -> row
  const key = (gid, pid, mkt) => `${gid}|${pid}|${mkt}`;
  const apply = (sql, a) => {
    if (/^INSERT OR IGNORE INTO proj_log/i.test(sql)) {
      const [date, gid, pid, mkt, proj] = a;
      const k = key(gid, pid, mkt);
      if (log.has(k)) return { meta: { changes: 0 } };      // pre-game value stands
      log.set(k, { date, gid, pid, mkt, proj, actual: null });
      return { meta: { changes: 1 } };
    }
    if (/^UPDATE proj_log SET actual=/i.test(sql)) {
      const [actual, , gid, pid, mkt] = a;
      const r = log.get(key(gid, pid, mkt));
      if (!r || r.actual != null) return { meta: { changes: 0 } };
      r.actual = actual;
      return { meta: { changes: 1 } };
    }
    return { meta: { changes: 0 } };
  };
  const prepare = (sql) => {
    const st = { sql, args: [], bind: (...a) => { st.args = a; return st; },
      run: async () => apply(st.sql, st.args), first: async () => null, all: async () => ({ results: [] }) };
    return st;
  };
  return { db: { prepare, batch: async (s) => s.map((x) => apply(x.sql, x.args)) }, log };
}

const pending = [];
const ctx = { waitUntil: (p) => { if (p && p.then) pending.push(p.catch(() => {})); } };
let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const { db, log } = makeDb();
const res = await mod.default.fetch(new Request('https://x/api/board'), { ODDS_API_KEY: 'k', DB: db }, ctx);
const rows = await res.json();
await Promise.all(pending.splice(0));

const arms = rows.flatMap((r) => r.pitchers || []);
const byId = Object.fromEntries(arms.map((a) => [a.id, a]));
const ace = byId[901], small = byId[902];

// The grading pass fetches a boxscore per game, and it decides WHICH games from
// a SQL query. That query originally read the picks table alone, which coupled
// hits grading to there being an ungraded K pick: a game with no priced K prop
// never appeared, and any game dropped out for good the moment its picks graded
// or voided. proj_log writes a row for every probable starter, so the surviving
// sample would have been "games the book priced" — the wrong population to judge
// a projection on, and wrong in a way no output would ever show.
//
// Asserted on the source because the failure is an absence: nothing errors, the
// rows just stay NULL forever.
{
  const src = fs.readFileSync(BOARD + '/worker.js', 'utf8');
  const fn = src.slice(src.indexOf('async function gradeUngraded('));
  const head = fn.slice(0, fn.indexOf('if (!rows.length) return;'));
  console.log('-- grading is driven by projections, not only by picks --');
  ok(/FROM proj_log WHERE actual IS NULL/.test(head),
    'the game list includes games with an ungraded projection');
  ok(/FROM picks WHERE result IS NULL/.test(head),
    'and still includes games with an ungraded pick');
}

console.log('\n-- the model matches its own arithmetic --');
ok(!!ace && !!small, 'both starters projected');
ok(ace && near(ace.projH, expect(5.5, 180, 30), 0.12),
  `long sample: projH ${ace && ace.projH} vs expected ${expect(5.5, 180, 30).toFixed(2)}`);
ok(small && near(small.projH, expect(15.3, 12, 1), 0.12),
  `short sample: projH ${small && small.projH} vs expected ${expect(15.3, 12, 1).toFixed(2)}`);

console.log('\n-- shrinkage keeps a short sample from inventing an edge --');
const raw = 15.3 * 6.8 / 9;   // what the unregressed rate would have projected
ok(small && small.h9 < 10, `H/9 15.3 is pulled to ${small && small.h9}, not carried at full strength`);
ok(small && small.h9raw === 15.3, 'the raw rate is still reported, so the shrink is visible not hidden');
ok(small && small.projH < raw - 3,
  `projH ${small && small.projH} is far below the unregressed ${raw.toFixed(1)}`);
ok(ace && small && (small.h9raw / ace.h9raw) > 2.5 && (small.projH / ace.projH) < 2,
  'a 2.8x gap in raw rate becomes under 2x in the projection');

console.log('\n-- the interval is built on the measured dispersion --');
ok(ace && ace.loH < ace.projH && ace.hiH > ace.projH, 'the 80% interval brackets the projection');
ok(ace && ace.loH >= 0, 'the interval never goes negative — a pitcher cannot allow fewer than zero hits');

console.log('\n-- it is logged as a projection, not a pick --');
const logged = [...log.values()];
ok(logged.length === 2, `one proj_log row per starter (${logged.length})`);
ok(logged.every((r) => r.mkt === 'H' && r.actual === null), "market 'H', ungraded until the game is final");
ok(rows.every((r) => !/hits/i.test(String(r.pick || ''))), 'the row headline is still the K pick — hits are not posted');

console.log('\n-- grading fills it from the boxscore, once --');
const before = logged.find((r) => Number(r.pid) === 901).proj;
const loggedGameId = logged[0].gid;
// A starter with a shutout must grade as 0, not be skipped as falsy.
const box = { teams: {
  away: { players: { ID901: { person: { id: 901 }, stats: { pitching: { gamesStarted: 1, hits: 0, strikeOuts: 7 } } } } },
  home: { players: {
    ID902: { person: { id: 902 }, stats: { pitching: { gamesStarted: 1, hits: 9, strikeOuts: 2 } } },
    ID999: { person: { id: 999 }, stats: { pitching: { hits: 4, strikeOuts: 1 } } },   // reliever
  } },
} };
// Drive the extractor the way the grading pass does.
const extract = (b) => {
  const out = {};
  for (const side of ['away', 'home']) {
    for (const pl of Object.values((b.teams[side] || {}).players || {})) {
      const p = (pl.stats || {}).pitching;
      if (pl.person && p && p.gamesStarted && p.hits != null && p.hits !== '') out[pl.person.id] = p.hits;
    }
  }
  return out;
};
const hById = extract(box);
ok(hById[901] === 0, 'a shutout grades as 0 hits, not as missing');
ok(hById[999] === undefined, 'a reliever is not graded against a starter projection');
for (const pid of Object.keys(hById)) {
  await db.prepare('UPDATE proj_log SET actual=?, updated_at=? WHERE game_id=? AND pitcher_id=? AND market=? AND actual IS NULL')
    // The board logs its own row id ('g' + gamePk), and the grading pass binds
    // that same value — so the test must use what was actually stored, not the
    // bare gamePk. Binding the unprefixed id matched nothing and silently graded
    // zero rows, which is exactly the failure this asserts against.
    .bind(hById[pid], Date.now(), loggedGameId, Number(pid), 'H').run();
}
const graded = [...log.values()];
ok(graded.find((r) => Number(r.pid) === 901).actual === 0, 'the shutout is recorded as 0');
ok(graded.find((r) => Number(r.pid) === 902).actual === 9, 'the other start is recorded as 9');
ok(graded.find((r) => Number(r.pid) === 901).proj === before,
  'grading does not overwrite the projection it is grading');

// A second slate render must not replace a pre-game projection with a newer one.
await mod.default.fetch(new Request('https://x/api/board'), { ODDS_API_KEY: 'k', DB: db }, ctx);
await Promise.all(pending.splice(0));
ok([...log.values()].find((r) => Number(r.pid) === 901).actual === 0,
  're-rendering the board does not reset a graded row');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
