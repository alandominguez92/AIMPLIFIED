// The batter board rolls to tomorrow's slate once tonight's games are done.
//
// /api/board has rolled for as long as it has had projections; /api/batters
// never did. So from the last out until the next morning's schedule, the batter
// board was empty — not "no plays tonight", nothing at all — while the strikeout
// board beside it was already showing tomorrow's starters. Same complaint as the
// unquoted games, at a different hour.
//
// The parts worth guarding are the ones that are wrong quietly: it must NOT roll
// while a game is still being played, it must not roll into an empty day, and a
// pick made on a rolled board has to be logged under the day its game is played
// — log it under the wall-clock day and grading would look for a box score that
// does not exist.
import fs from 'node:fs';
import path from 'node:path';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };

// 2026-09-14 21:00 PT — tonight is over, and tomorrow's first pitch is still
// more than 18h away, which is the case the slower overnight cadence exists for.
// (The hourly bucket, inside 18h, is covered by earlylines.mjs.)
const T0 = Date.parse('2026-09-15T04:00:00Z');
const RealDate = Date;
class FakeDate extends RealDate {
  constructor(...a) { if (a.length) super(...a); else super(T0); }
  static now() { return T0; }
}
globalThis.Date = FakeDate;
const TODAY = '2026-09-14';
const TOMORROW = '2026-09-15';
const iso = (ms) => new RealDate(ms).toISOString();

const mkGame = (pk, away, awayName, home, homeName, startMs, state) => ({
  gamePk: pk,
  gameDate: iso(startMs),
  status: { abstractGameState: state },
  venue: { name: 'Park' },
  teams: {
    away: { team: { id: pk * 10 + 1, abbreviation: away, name: awayName }, score: 3, probablePitcher: { id: pk + 1, fullName: `Away Arm ${pk}` } },
    home: { team: { id: pk * 10 + 2, abbreviation: home, name: homeName }, score: 5, probablePitcher: { id: pk + 2, fullName: `Home Arm ${pk}` } },
  },
});
// Tonight: played out. Tomorrow: 15:40 PT, ~18.7h out — inside the early-lines
// horizon, so the rolled slate can be priced, and past the far threshold.
const TONIGHT_FINAL = [mkGame(940001, 'SEA', 'Seattle Mariners', 'LAA', 'Los Angeles Angels', T0 - 4 * 3600e3, 'Final')];
const TONIGHT_LIVE = [
  TONIGHT_FINAL[0],
  mkGame(940002, 'MIA', 'Miami Marlins', 'AZ', 'Arizona Diamondbacks', T0 - 2 * 3600e3, 'Live'),
];
const TOMORROW_START = Date.parse('2026-09-15T22:40:00Z');
const TOMORROW_GAMES = [mkGame(940003, 'LAD', 'Los Angeles Dodgers', 'CIN', 'Cincinnati Reds', TOMORROW_START, 'Preview')];

let tonight = TONIGHT_FINAL;
let tomorrow = TOMORROW_GAMES;
const HITTERS = ['CIN Hitter 1', 'CIN Hitter 2', 'LAD Hitter 1'];
// Arizona's own hitters, for the spelling case at the bottom. Their team id is
// the one mkGame(940004, ...) assigns the home club.
const AZ_SPLITS = ['AZ Hitter 1', 'AZ Hitter 2'].map((h, i) => ({
  player: { id: 610000 + i, fullName: h },
  team: { id: 940004 * 10 + 2, abbreviation: 'AZ' },
  stat: {
    gamesPlayed: 140, plateAppearances: 600 - i, atBats: 540, hits: 150, runs: 80, rbi: 75,
    homeRuns: 20, totalBases: 250, strikeOuts: 120, baseOnBalls: 55, avg: '.278', slg: '.463',
  },
}));
const statSplits = [
  ...TOMORROW_GAMES.flatMap((g) => [[g.teams.away, 'LAD'], [g.teams.home, 'CIN']].flatMap(([side, ab]) => (
    HITTERS.filter((h) => h.startsWith(ab)).map((h, i) => ({
      player: { id: 600000 + ab.charCodeAt(0) + i, fullName: h },
      team: { id: side.team.id, abbreviation: ab },
      stat: {
        gamesPlayed: 140, plateAppearances: 600 - i, atBats: 540, hits: 150, runs: 80, rbi: 75,
        homeRuns: 20, totalBases: 250, strikeOuts: 120, baseOnBalls: 55, avg: '.278', slg: '.463',
      },
    }))
  ))),
  ...AZ_SPLITS,
];

const TOMORROW_EVENTS = [{
  id: 'tmrw', commence_time: iso(TOMORROW_START),
  away_team: 'Los Angeles Dodgers', home_team: 'Cincinnati Reds',
}];
let events = TOMORROW_EVENTS;
// Off for the empty-board case: with no season stats nothing can be projected,
// which is one of the real ways the board comes back empty.
let statsOn = true;

let perEventCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, o) => {
  const url = String(u);
  const J = (x, s) => new Response(JSON.stringify(x), { status: s || 200, headers: { 'content-type': 'application/json' } });
  if (url.includes('/schedule?')) {
    const d = (url.match(/date=([\d-]+)/) || [])[1];
    const games = d === TODAY ? tonight : d === TOMORROW ? tomorrow : [];
    return J({ dates: [{ games }] });
  }
  if (url.includes('/stats?stats=season') && url.includes('group=hitting')) return J({ stats: [{ splits: statsOn ? statSplits : [] }] });
  if (url.includes('/teams/stats')) {
    return J({ stats: [{ splits: statSplits.map((s) => ({ team: { id: s.team.id }, stat: { hits: 1300, plateAppearances: 6000, strikeOuts: 1330, inningsPitched: '1400.0' } })) }] });
  }
  if (url.includes('/people?')) {
    const ids = decodeURIComponent((url.match(/personIds=([^&]*)/) || [])[1] || '');
    return J({ people: ids.split(',').filter(Boolean).map((id) => ({
      id: Number(id), fullName: 'Person ' + id, pitchHand: { code: 'R' },
      stats: [{ splits: [{ stat: { strikeoutsPer9Inn: 9, hitsPer9Inn: 8, inningsPitched: '150.0', gamesStarted: 25, era: '3.50', battersFaced: 600, hits: 150, homeRuns: 18, totalBases: 240, runs: 70 } }] }],
    })) });
  }
  if (url.includes('cdn.espn.com')) return J({ content: { sbData: { events: [] } } });
  if (url.includes('api.the-odds-api.com')) {
    if (/\/events\?/.test(url)) return J(events);
    const evm = url.match(/\/events\/([a-z0-9]+)\/odds/);
    if (evm && evm[1] !== 'tmrw') { perEventCalls++; return J({ bookmakers: [] }); }  // posted no props
    if (evm) {
      perEventCalls++;
      return J({ bookmakers: ['draftkings', 'fanduel'].map((key) => ({
        key,
        markets: [{
          key: 'batter_total_bases',
          outcomes: ['CIN Hitter 1'].flatMap((n) => ([
            { name: 'Over', description: n, point: 1.5, price: -115 },
            { name: 'Under', description: n, point: 1.5, price: -105 },
          ])),
        }],
      })) });
    }
    return J([]);
  }
  if (url.includes('statsapi.mlb.com')) return J({});
  return realFetch(u, o);
};

// D1 stub. bpicks writes go through db.batch, and the DATE they carry is the
// whole point of the last assertion, so both paths are recorded.
function makeDb() {
  const logged = [];
  const store = new Map();
  const note = (sql, args) => { if (/INTO bpicks/i.test(sql)) logged.push(args); };
  const run = (sql, args) => {
    note(sql, args);
    if (/^INSERT OR IGNORE INTO feed_cache/i.test(sql)) {
      if (store.has(args[0])) return { meta: { changes: 0 } };
      store.set(args[0], { data: null, updated_at: 0, claimed_until: 0 });
      return { meta: { changes: 1 } };
    }
    if (/^UPDATE feed_cache SET claimed_until/i.test(sql)) {
      const [until, key, now] = args;
      const r = store.get(key);
      if (!r || !(r.claimed_until <= now)) return { meta: { changes: 0 } };
      r.claimed_until = until; return { meta: { changes: 1 } };
    }
    if (/^INSERT OR REPLACE INTO feed_cache/i.test(sql)) {
      store.set(args[0], { data: args[1], updated_at: args[2], claimed_until: 0 });
      return { meta: { changes: 1 } };
    }
    return { meta: { changes: 0 } };
  };
  const prepare = (sql) => {
    const st = {
      sql, args: [],
      bind: (...a) => { st.args = a; return st; },
      run: async () => run(sql, st.args),
      first: async () => (/FROM feed_cache WHERE key=\?/i.test(sql)
        ? ((store.get(st.args[0]) || {}).data ? { data: store.get(st.args[0]).data, updated_at: store.get(st.args[0]).updated_at } : null)
        : null),
      all: async () => ({ results: [] }),
    };
    return st;
  };
  return { db: { prepare, batch: async (l) => (l || []).map((x) => run(x.sql, x.args)) }, logged, store };
}

const src = fs.readFileSync(BOARD + '/worker.js', 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const load = async () => {
  const { db, logged, store } = makeDb();
  const pending = [];
  const ctx = { waitUntil: (p) => { if (p && p.then) pending.push(p.catch(() => {})); } };
  const res = await mod.default.fetch(new Request('https://x/api/batters'), { ODDS_API_KEY: 'k', DB: db }, ctx);
  const ttl = Number((/max-age=(\d+)/.exec(res.headers.get('cache-control') || '') || [])[1]);
  const body = await res.json();
  await Promise.all(pending.splice(0));
  return { rows: body.rows || [], slate: body.slate, ttl, logged, store };
};

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

// ---- tonight is over -> show tomorrow ----------------------------------------------
{
  const { rows, logged, store } = await load();
  console.log(`-- 10 PM PT, tonight final -- ${rows.length} rows`);
  ok(rows.length > 0, 'the board is not empty');
  ok(rows.every((r) => r.matchup === 'LAD @ CIN'), `every row is tomorrow's game (${[...new Set(rows.map((r) => r.matchup))].join(', ')})`);
  ok(!rows.some((r) => r.matchup === 'SEA @ LAA'), "tonight's finished game is gone");
  ok(rows.some((r) => r.odds != null), 'tomorrow\'s posted lines are already on it');

  const dates = [...new Set(logged.map((a) => a[0]))];
  ok(logged.length > 0 && dates.length === 1 && dates[0] === TOMORROW,
    `picks are logged under the day they are played (${dates.join(', ') || 'nothing logged'}), not the wall-clock day (${TODAY})`);
  ok([...store.keys()].some((k) => k.includes(TOMORROW)),
    `the line store is keyed to the rolled slate (${[...store.keys()].filter((k) => k.startsWith('batter_lines')).join(', ')})`);
}

// ---- a game still in progress -> do NOT roll ----------------------------------------
{
  tonight = TONIGHT_LIVE;
  const { rows } = await load();
  console.log('\n-- one game still being played --');
  ok(rows.some((r) => r.matchup === 'MIA @ AZ') || rows.length === 0,
    'the board stays on tonight while a game is live');
  ok(!rows.some((r) => r.matchup === 'LAD @ CIN'), 'it has NOT rolled to tomorrow');
  tonight = TONIGHT_FINAL;
}

// ---- nothing tomorrow -> stay put rather than invent a day ---------------------------
{
  tomorrow = [];
  const { rows } = await load();
  console.log('\n-- no games tomorrow (end of season) --');
  ok(rows.length === 0, `the board is correctly empty rather than rolled into nothing (${rows.length} rows)`);
  tomorrow = TOMORROW_GAMES;
}

// ---- an empty board is never cached for long --------------------------------------
// The TTL follows first pitch: hours out, a board holds for 15 minutes because
// its lines are not moving. Applied to an EMPTY board that reasoning inverts —
// every way of having no rows (slate just went final and is about to roll, books
// have not posted yet) resolves by itself within minutes, and a 15-minute hold
// keeps an empty page in front of readers long after there is something to show.
// It is why the roll took a quarter of an hour to appear in production on
// 2026-09-15. So the fixture is a game far enough out to earn the long TTL, with
// nothing projectable in it.
{
  const soonMs = T0 + 5 * 3600e3;                       // 5h out: past TTL_FAR_MS
  tonight = [mkGame(940005, 'SEA', 'Seattle Mariners', 'LAA', 'Los Angeles Angels', soonMs, 'Preview')];
  events = [{ id: 'soon', commence_time: iso(soonMs), away_team: 'Seattle Mariners', home_team: 'Los Angeles Angels' }];
  statsOn = false;                                      // nothing can be projected
  const { rows, ttl } = await load();
  console.log('\n-- an empty board, 5h before first pitch --');
  ok(rows.length === 0, `the board is empty (${rows.length} rows)`);
  ok(ttl === 300, `and cached for 5 min, not the 15 its first pitch would earn (${ttl}s)`);
  statsOn = true;
  events = TOMORROW_EVENTS;
  tonight = TONIGHT_FINAL;
}

// ---- the TTL follows first pitch, on a board with rows -----------------------------
// The other half of the rule above: a POPULATED board hours from first pitch
// holds for 15 minutes, because its lines are not moving and re-buying them is
// what the shared store exists to avoid. Asserted here rather than in
// sharedlines.mjs, whose fixture has no season stats and so was measuring an
// empty board — it read 900 only because the empty-board rule did not exist yet.
{
  const populated = async (hoursOut) => {
    const startMs = T0 + hoursOut * 3600e3;
    tonight = [mkGame(940003, 'LAD', 'Los Angeles Dodgers', 'CIN', 'Cincinnati Reds', startMs, 'Preview')];
    tomorrow = [];
    events = [{ id: 'tmrw', commence_time: iso(startMs), away_team: 'Los Angeles Dodgers', home_team: 'Cincinnati Reds' }];
    return load();
  };
  const far = await populated(5);          // 5h out: past TTL_FAR_MS
  const near = await populated(2);         // 2h out: inside it
  console.log('\n-- the TTL follows first pitch --');
  ok(far.rows.length > 0 && near.rows.length > 0,
    `both fixtures have rows (${far.rows.length}, ${near.rows.length}) — otherwise this measures the empty-board rule`);
  ok(far.ttl === 900, `hours from first pitch, a full board caches for 15 min (${far.ttl}s)`);
  ok(near.ttl === 300, `inside three hours it tightens to 5 min (${near.ttl}s)`);
  tonight = TONIGHT_FINAL;
  tomorrow = TOMORROW_GAMES;
  events = TOMORROW_EVENTS;
}

// ---- the league's spelling, on both boards -------------------------------------
// Arizona was the one club whose name->abbreviation table disagreed with
// StatsAPI: the same game read "MIA @ ARI" on the batter board and "MIA @ AZ" on
// the strikeout board, which reads as two different games. Checked against all 30
// clubs on 2026-09-16 — Arizona was the only one.
{
  tonight = [mkGame(940004, 'MIA', 'Miami Marlins', 'AZ', 'Arizona Diamondbacks', T0 + 6 * 3600e3, 'Preview')];
  tomorrow = [];
  const { rows } = await load();
  console.log('\n-- team spelling --');
  const mu = [...new Set(rows.map((r) => r.matchup))];
  ok(rows.length > 0, `Arizona's game is on the board (${rows.length} rows)`);
  ok(mu.every((m) => m === 'MIA @ AZ'),
    `spelled the way the league and the strikeout board spell it (${mu.join(', ') || 'no rows'})`);
  tonight = TONIGHT_FINAL;
  tomorrow = TOMORROW_GAMES;
}

// ---- the overnight cadence ----------------------------------------------------------
// A rolled slate sits in the early tier all night. At the hourly cadence that is
// ~8 refreshes of every game before anyone is awake; past 18h out it drops to 3h.
{
  const far = (Date.parse('2026-09-15T22:40:00Z') - T0) / 3600e3;
  console.log(`\n-- overnight cadence (tomorrow's first pitch is ${far.toFixed(1)}h out) --`);
  const { store } = await load();
  const keys = [...store.keys()].filter((k) => k.startsWith('batter_lines_early'));
  ok(keys.some((k) => k.endsWith(':far')), `the far bucket is used, not the hourly one (${keys.join(', ') || 'none'})`);
  ok(perEventCalls > 0, 'and it did buy the rolled slate');
}

globalThis.Date = RealDate;
console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
