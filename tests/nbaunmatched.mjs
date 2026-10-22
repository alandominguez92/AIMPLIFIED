// The PrizePicks names the NBA log could not place, kept where they can be read
// (2026-10-21).
//
// A PrizePicks name that finds no prior is dropped without a trace: on opening
// night "Ron Holland" (ESPN's "Ronald Holland II") was found only by reading a
// payload by hand, and 76ers @ Knicks could never be checked because
// /api/nba-pp?raw=1 keeps only the last capture. Now each capture writes, beside
// the payload, `unmatched` (that game's names with no prior, and why) and
// `unmatchedLog` (every such name in the last 30 days, carried from capture to
// capture). Reading it is free, as the payload is.
//
// Real SQLite underneath (node:sqlite). Real payloads, both opening night's,
// read back from /api/nba-pp?raw=1, each billed 5 credits:
//   - Celtics @ Pistons, captured 15:01Z (tests/fixtures/odds-nba-pp-26b036ff-20261020.json)
//   - Thunder @ Spurs, captured 21:30Z (tests/fixtures/odds-nba-pp-bccd283d-20261020.json)
// Real priors (nba-priors.json). "Before the alias" is worker.js with
// NBA_NAME_ALIAS emptied -- the code production ran that night.
//
// What has to hold:
//   - a capture lists the PrizePicks names it could not place, with the markets
//     that went unlogged; every PrizePicks name is either logged or listed
//   - the next game's capture replaces the payload but not the log
//   - a name that matches now (the alias deployed) comes off the log; so does
//     one not seen for 30 days, and not before
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
const FIX = path.join(BOARD, 'tests', 'fixtures');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };

const RealDate = Date;
let NOW = 0;
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
};
const iso = (ms) => new RealDate(ms).toISOString();
const DAY = 86400e3;

const PAY = Object.fromEntries(['odds-nba-pp-26b036ff-20261020.json', 'odds-nba-pp-bccd283d-20261020.json'].map((f) => {
  const text = fs.readFileSync(path.join(FIX, f), 'utf8');
  return [JSON.parse(text).id, text];
}));
const [BOS_DET, OKC_SA] = Object.keys(PAY).map((id) => JSON.parse(PAY[id]));
const AT_BOS = RealDate.parse('2026-10-20T15:01:05Z');   // when production captured each
const AT_OKC = RealDate.parse('2026-10-20T21:30:37Z');
let paid = 0;
globalThis.fetch = async (u) => {
  // (Underdog and Pick6 are asked for since 2026-10-22; the payloads were recorded before, with neither.)
  const m = /^https:\/\/api\.the-odds-api\.com\/v4\/sports\/basketball_nba\/events\/(\w+)\/odds\?apiKey=k&markets=player_threes,player_assists,player_rebounds,player_blocks,player_steals&oddsFormat=american&dateFormat=iso&bookmakers=prizepicks,underdog,pick6,draftkings,fanduel$/.exec(String(u));
  if (m && PAY[m[1]]) {
    paid++;
    return new Response(PAY[m[1]], { status: 200, headers: { 'content-type': 'application/json', 'x-requests-last': '5' } });
  }
  return new Response('{}', { status: 404 });
};

const PRIORS = fs.readFileSync(path.join(BOARD, 'nba-priors.json'), 'utf8');
const SRC = fs.readFileSync(path.join(BOARD, 'worker.js'), 'utf8').replace(/\r\n/g, '\n');
const ALIAS_LINE = "const NBA_NAME_ALIAS = { 'Ron Holland': 'Ronald Holland II' };";
const BEFORE = SRC.replace(ALIAS_LINE, 'const NBA_NAME_ALIAS = {};');

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
ok(BEFORE !== SRC, 'worker.js has the Ron Holland alias to take out for "before the alias"');

// One database; each capture by the worker.js given, at the time given, with
// the game on the board's snapshot (tipping two hours on, if it says so).
let worlds = 0;
async function world() {
  const sq = new DatabaseSync(':memory:');
  const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
  const exec = (sql, args, mode) => {
    const st = sq.prepare(sql);
    const a = args.map(norm);
    if (mode === 'all') return { results: st.all(...a), meta: {} };
    if (mode === 'first') return st.get(...a) || null;
    return { success: true, meta: { changes: Number(st.run(...a).changes) } };
  };
  const DB = {
    prepare: (sql) => { const s = { sql, args: [], bind: (...x) => { s.args = x; return s; },
      all: async () => exec(s.sql, s.args, 'all'), first: async (c) => { const r = exec(s.sql, s.args, 'first'); return c && r ? r[c] : r; },
      run: async () => exec(s.sql, s.args, 'run') }; return s; },
    batch: async (sts) => sts.map((x) => exec(x.sql, x.args, 'run')),
  };
  const env = { DB, ODDS_API_KEY: 'k', ASSETS: { fetch: async (r) => (new URL(r.url).pathname === '/nba-priors.json'
    ? new Response(PRIORS, { status: 200, headers: { 'content-type': 'application/json' } }) : new Response('{}', { status: 404 })) } };
  const w = worlds++;
  const capture = async (src, ev, at, tipsLater) => {
    NOW = at;
    const mod = await import('data:text/javascript;base64,' + Buffer.from(src + `\n// world ${w}, ${iso(at)}\n`).toString('base64'));
    const tick = async () => { const held = []; await mod.default.scheduled({}, env, { waitUntil: (p) => held.push(p) }); await Promise.allSettled(held); };
    await tick();                                        // tables made
    sq.prepare('INSERT OR REPLACE INTO feed_cache (key, data, updated_at) VALUES (?, ?, ?)').run('nba_board:reg',
      JSON.stringify({ asOf: iso(NOW), games: [{ id: ev.id, league: 'reg', commence: tipsLater ? iso(NOW + 2 * 3600e3) : ev.commence_time,
        home: ev.home_team, away: ev.away_team }] }), NOW);
    await tick();
    return (await mod.default.fetch(new Request('https://x/api/nba-pp?raw=1'), env, { waitUntil: () => {} })).json();
  };
  return { sq, capture };
}

// ---- one capture ----------------------------------------------------------------------------
console.log('\n-- opening night before the alias: Celtics @ Pistons --');
const A = await world();
const a1 = await A.capture(BEFORE, BOS_DET, AT_BOS);
ok(paid === 1 && a1.game === BOS_DET.id && a1.body && a1.body.id === BOS_DET.id, `the payload is kept as before (${a1.game})`);
ok(JSON.stringify(a1.unmatched) === JSON.stringify([{ name: 'Ron Holland', why: 'no prior', markets: ['reb'] }]),
  `beside it, the one PrizePicks name with no prior and the market that went unlogged (${JSON.stringify(a1.unmatched)})`);
const pp = BOS_DET.bookmakers.find((b) => b.key === 'prizepicks');
const ppNames = new Set(pp.markets.flatMap((m) => m.outcomes.filter((o) => o.name === 'Under').map((o) => o.description)));
const logged = new Set(A.sq.prepare('SELECT DISTINCT player FROM nbapp').all().map((r) => r.player));
const listed = new Set((a1.unmatched || []).map((u) => u.name));
const lost = [...ppNames].filter((n) => !logged.has(n) && !listed.has(n));
ok(!lost.length && ![...listed].some((n) => logged.has(n)),
  `every PrizePicks name is logged or listed, never both: ${logged.size} logged + ${listed.size} listed of ${ppNames.size} (${lost.join(', ') || 'none lost'})`);
const h1 = (a1.unmatchedLog || [])[0] || {};
ok((a1.unmatchedLog || []).length === 1 && h1.name === 'Ron Holland' && h1.why === 'no prior' && h1.markets.join() === 'reb'
  && h1.captures === 1 && h1.first === iso(AT_BOS) && h1.last === iso(AT_BOS)
  && h1.game === 'Boston Celtics @ Detroit Pistons' && h1.date === '2026-10-20',
  `and on the log, with the game and when (${JSON.stringify(h1)})`);

// ---- the next game ----------------------------------------------------------------------------
console.log('\n-- Thunder @ Spurs, six and a half hours later --');
const a2 = await A.capture(BEFORE, OKC_SA, AT_OKC);
ok(paid === 2 && a2.game === OKC_SA.id && a2.body.id === OKC_SA.id, `the payload is now the Thunder and Spurs (${a2.game})`);
ok(Array.isArray(a2.unmatched) && a2.unmatched.length === 0, `every name in it found a prior: nothing unmatched (${JSON.stringify(a2.unmatched)})`);
ok(JSON.stringify(a2.unmatchedLog) === JSON.stringify(a1.unmatchedLog),
  `but the log still has Ron Holland from the Pistons game, as it was (${(a2.unmatchedLog || []).map((u) => `${u.name} ${u.last}`).join(', ') || 'empty'})`);

// ---- off the log ----------------------------------------------------------------------------
console.log('\n-- coming off --');
const B = await world();
await B.capture(BEFORE, BOS_DET, AT_BOS);
const b2 = await B.capture(SRC, OKC_SA, AT_OKC);
ok(Array.isArray(b2.unmatchedLog) && b2.unmatchedLog.length === 0,
  `with the alias deployed before the next capture, Ron Holland matches and is off the log (${(b2.unmatchedLog || []).map((u) => u.name).join(', ') || 'empty'})`);
const C = await world();
await C.capture(BEFORE, BOS_DET, AT_BOS);
const c2 = await C.capture(BEFORE, OKC_SA, AT_BOS + 29 * DAY, true);
ok((c2.unmatchedLog || []).map((u) => u.name).join() === 'Ron Holland', `still missing, he is kept 29 days on (${(c2.unmatchedLog || []).map((u) => u.name).join(', ') || 'empty'})`);
const D = await world();
await D.capture(BEFORE, BOS_DET, AT_BOS);
const d2 = await D.capture(BEFORE, OKC_SA, AT_BOS + 31 * DAY, true);
ok(Array.isArray(d2.unmatchedLog) && d2.unmatchedLog.length === 0, `and not seen for 31 days, he is gone (${(d2.unmatchedLog || []).map((u) => u.name).join(', ') || 'empty'})`);
ok(paid === 8, `one paid call a capture, as before (${paid} for 8)`);

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
