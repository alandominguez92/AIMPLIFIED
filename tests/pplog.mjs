// PrizePicks lines are logged and graded at THEIR number.
//
// The whole record so far is graded against DK/FD lines — batter unders hit
// 54.8% there. That number cannot be carried to pick'em, because PrizePicks
// hangs a different one (mostly 0.5 TB and 1.5 H+R+RBI where the books post 1.5
// and 2.5), and an under at 1.5 is a different bet from an under at 2.5. So the
// number a pick'em entry actually turns on has never been measured.
//
// What this pins: a row with NO book line still logs (those are most of them),
// the grade is taken against the PrizePicks number rather than the book's, and a
// player who never appeared voids instead of scoring a free under.
import fs from 'node:fs';
import path from 'node:path';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };

const START = Date.now() + 5 * 3600e3;
const iso = (ms) => new Date(ms).toISOString();
const PK = 994001;
const game = {
  gamePk: PK, gameDate: iso(START), status: { abstractGameState: 'Preview' }, venue: { name: 'Park' },
  teams: {
    away: { team: { id: 119, abbreviation: 'LAD', name: 'Los Angeles Dodgers' }, probablePitcher: { id: 5551, fullName: 'Away Arm' } },
    home: { team: { id: 113, abbreviation: 'CIN', name: 'Cincinnati Reds' }, probablePitcher: { id: 5552, fullName: 'Home Arm' } },
  },
};
// PLAYED lands under the PrizePicks number, BENCH never appears, BOOKED also has
// a DK/FD line so the "PP-only" and "both" cases are both covered.
const HITTERS = [['CIN Played', 880011], ['CIN Bench', 880012], ['CIN Booked', 880013]];
const statSplits = HITTERS.map(([nm, id]) => ({
  player: { id, fullName: nm }, team: { id: 113, abbreviation: 'CIN' },
  stat: { gamesPlayed: 140, plateAppearances: 600, atBats: 540, hits: 150, runs: 80, rbi: 75, homeRuns: 20, totalBases: 250, strikeOuts: 120, baseOnBalls: 55, avg: '.278', slg: '.463' },
}));
const propBook = (key) => ({ key, markets: [{
  key: 'batter_total_bases',
  outcomes: [
    // Only PrizePicks quotes the first two; everyone quotes 'Booked'.
    ...(key === 'prizepicks' ? HITTERS : [HITTERS[2]]).flatMap(([nm]) => ([
      { name: 'Over', description: nm, point: key === 'prizepicks' ? 1.5 : 2.5, price: -115 },
      { name: 'Under', description: nm, point: key === 'prizepicks' ? 1.5 : 2.5, price: -105 },
    ])),
  ],
}] });

let graded = false;   // flips the schedule + boxscore to a finished game
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, o) => {
  const url = String(u);
  const J = (x) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.includes('/boxscore')) {
    const bat = (hits, runs, rbi, gp) => ({ batting: { gamesPlayed: gp, plateAppearances: gp ? 4 : 0, atBats: gp ? 4 : 0, hits, doubles: 0, triples: 0, homeRuns: 0, runs, rbi } });
    return J({ teams: { home: { players: {
      ID880011: { person: { id: 880011 }, stats: bat(1, 0, 0, 1) },    // 1 TB -> under 1.5
      ID880012: { person: { id: 880012 }, stats: { batting: {} } },     // never played -> void
      ID880013: { person: { id: 880013 }, stats: bat(2, 1, 1, 1) },     // 2 TB -> over 1.5 (PP), under 2.5 (book)
    } }, away: { players: {} } } });
  }
  if (url.includes('/schedule?')) {
    const g = graded ? { ...game, status: { abstractGameState: 'Final' } } : game;
    return J({ dates: [{ games: [g] }] });
  }
  if (url.includes('/stats?stats=season') && url.includes('group=hitting')) return J({ stats: [{ splits: statSplits }] });
  if (url.includes('/teams/stats')) return J({ stats: [{ splits: [113, 119].map((id) => ({ team: { id }, stat: { hits: 1300, plateAppearances: 6000, strikeOuts: 1330, inningsPitched: '1400.0' } })) }] });
  if (url.includes('/people?')) {
    const ids = decodeURIComponent((url.match(/personIds=([^&]*)/) || [])[1] || '');
    return J({ people: ids.split(',').filter(Boolean).map((id) => ({ id: Number(id), fullName: 'Arm ' + id, pitchHand: { code: 'R' },
      stats: [{ splits: [{ stat: { strikeoutsPer9Inn: '9.00', inningsPitched: '150.0', gamesStarted: 25, era: '3.50', hitsPer9Inn: '8.00' } }] }] })) });
  }
  if (url.includes('cdn.espn.com')) return J({ content: { sbData: { events: [] } } });
  if (url.includes('api.the-odds-api.com')) {
    if (/\/events\?/.test(url)) return J([{ id: 'ev1', commence_time: iso(START), home_team: 'Cincinnati Reds', away_team: 'Los Angeles Dodgers' }]);
    if (/\/events\/ev1\/odds/.test(url)) return J({ bookmakers: ['draftkings', 'fanduel', 'prizepicks'].map(propBook) });
    return J([]);
  }
  if (url.includes('statsapi.mlb.com')) return J({});
  return realFetch(u, o);
};

// D1 stub with a working pppicks table.
const pp = new Map();
const key = (a) => `${a[0]}|${a[1]}|${a[2]}|${a[3]}`;
const run = (sql, a) => {
  if (/^\s*INSERT OR IGNORE INTO pppicks/i.test(sql)) {
    const [date, game_id, player_id, player, team, market, point, model_under, close_point, close_model_under, model_ver] = a;
    const k = key([date, game_id, player_id, market]);
    if (!pp.has(k)) pp.set(k, { date, game_id, player_id, player, team, market, point, model_under, close_point, close_model_under, model_ver, actual: null, result: null });
  } else if (/^\s*UPDATE pppicks SET close_point/i.test(sql)) {
    const [cp, cmu, date, gid, pid, mkt] = a; const r = pp.get(key([date, gid, pid, mkt])); if (r) { r.close_point = cp; r.close_model_under = cmu; }
  } else if (/^\s*UPDATE pppicks SET actual/i.test(sql)) {
    const [actual, result, date, gid, pid, mkt] = a; const r = pp.get(key([date, gid, pid, mkt])); if (r) { r.actual = actual; r.result = result; }
  }
  return { meta: { changes: 1 } };
};
const db = {
  prepare: (sql) => { const st = { sql, args: [], bind: (...x) => { st.args = x; return st; },
    run: async () => run(sql, st.args), first: async () => null,
    all: async () => {
      if (!/FROM pppicks/i.test(sql)) return { results: [] };
      let rs = [...pp.values()];
      if (/result IS NULL/i.test(sql)) rs = rs.filter((r) => r.result == null);
      if (/DISTINCT game_id, date/i.test(sql)) {
        const seen = new Set(); const out = [];
        for (const r of rs) { const k = r.date + '|' + r.game_id; if (!seen.has(k)) { seen.add(k); out.push({ game_id: r.game_id, date: r.date }); } }
        return { results: out };
      }
      if (/WHERE game_id=\?/i.test(sql)) rs = rs.filter((r) => r.game_id === st.args[0]);
      // The export filters by market, and does it COLLATE NOCASE. If the stub
      // ignored the clause the case test below would pass on any implementation.
      const mm = /WHERE market = \?( COLLATE NOCASE)?/i.exec(sql);
      if (mm) rs = mm[1]
        ? rs.filter((r) => String(r.market).toLowerCase() === String(st.args[0]).toLowerCase())
        : rs.filter((r) => r.market === st.args[0]);
      return { results: rs };
    } };
    return st; },
  batch: async (l) => (l || []).map((x) => run(x.sql, x.args)),
};

const src = fs.readFileSync(BOARD + '/worker.js', 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const pending = [];
await mod.default.fetch(new Request('https://x/api/batters'), { ODDS_API_KEY: 'k', DB: db }, { waitUntil: (p) => pending.push(p) });
await Promise.all(pending.splice(0));

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
const logged = [...pp.values()];
const by = (n) => logged.find((r) => (r.player || '').includes(n) && r.market === 'tb');
console.log('logged:', logged.map((r) => `${r.player} ${r.market} @${r.point} p(under) ${r.model_under}`).join(' | '), '\n');

ok(logged.length >= 3, `every PrizePicks number is logged, book line or not (${logged.length} rows)`);
ok(!!by('Played') && by('Played').point === 1.5, `at PrizePicks' number, not the book's 2.5 (${by('Played') && by('Played').point})`);
ok(by('Played') && by('Played').model_under > 0 && by('Played').model_under < 100,
  `with the model's probability of landing under it (${by('Played') && by('Played').model_under}%)`);
ok(!!by('Bench'), 'a player the books never quoted is logged too — those are most of them');

// ---- grade it -------------------------------------------------------------------------
const yday = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' })
  .format(new Date(Date.now() - 86400e3));
for (const r of logged) { pp.delete(key([r.date, r.game_id, r.player_id, r.market])); r.date = yday; pp.set(key([r.date, r.game_id, r.player_id, r.market]), r); }
graded = true;
const tr = await (await mod.default.fetch(new Request('https://x/api/track-record'), { DB: db }, { waitUntil() {} })).json();
console.log('graded:', [...pp.values()].map((r) => `${r.player} actual ${r.actual} -> ${r.result}`).join(' | '), '\n');

ok(by('Played').result === 'under' && by('Played').actual === 1, `1 total base against a 1.5 line grades under (${by('Played').result})`);
ok(by('Booked').result === 'over' && by('Booked').actual === 2,
  `2 total bases grades OVER at PrizePicks' 1.5 — the book's 2.5 would have called it under (${by('Booked').result})`);
ok(by('Bench').result === 'void' && by('Bench').actual == null, `a player who never appeared voids, never a free under (${by('Bench').result})`);
ok(tr.prizepicks && tr.prizepicks.graded === 2 && tr.prizepicks.underRate === 50,
  `the record reports it for reading (${JSON.stringify(tr.prizepicks && { graded: tr.prizepicks.graded, underRate: tr.prizepicks.underRate })})`);
ok(tr.prizepicks && tr.prizepicks.byModelUnder && tr.prizepicks.byMarket,
  'banded by the probability claimed, so it reads against the entry break-evens');


// The export has to find the strikeout rows. They are stored as 'K' while the
// batter markets are lowercase, so a lower-casing export answered ?market=K
// with zero rows -- indistinguishable from "none were ever logged".
const exp = async (q) => (await (await mod.default.fetch(new Request('https://x/api/pppicks-export' + q), { DB: db }, { waitUntil() {} })).json());
// Strikeouts are stored as 'K' where the batter markets are lowercase, so seed
// one directly: an export that lower-cases the query answers ?market=K with
// nothing, which reads exactly like "none were ever logged".
pp.set('seed|g|9|K', { date: '2026-09-20', game_id: 'g', player_id: 9, player: 'Some Arm', team: 'CIN',
  market: 'K', point: 4.5, model_under: 51, close_point: 4.5, close_model_under: 51, actual: 6, result: 'over', model_ver: 'x' });
const eAll = await exp('');
const eUpper = await exp('?market=K'), eLower = await exp('?market=k');
ok(eUpper.n === 1 && eLower.n === 1,
  `?market=K and ?market=k both find the strikeout row (${eUpper.n} / ${eLower.n})`);
ok(eAll.n === 4 && (await exp('?market=tb')).n === 3,
  `and the filter is real, not a pass-through (${eAll.n} logged, tb ${(await exp('?market=tb')).n})`);

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
