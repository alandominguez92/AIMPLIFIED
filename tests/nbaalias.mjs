// A PrizePicks NBA name that is not ESPN's (2026-10-21).
//
// The NBA PrizePicks log finds each player's prior by name. Case, accents and
// suffixes were already allowed for; a different first name was not. On
// opening night PrizePicks quoted "Ron Holland" rebounds in Celtics @ Pistons,
// nba-priors.json (ESPN) has him as "Ronald Holland II", and the leg was never
// logged -- in any market it would have been the same. worker.js now maps
// PrizePicks' name to ESPN's (NBA_NAME_ALIAS) inside nbaName, so the priors,
// the capture and the grading of your own entries all read one name.
//
// He was the only PrizePicks name that missed in the two payloads there are:
// this one, and Thunder @ Spurs the same night (/api/nba-pp?raw=1, 21:30Z).
//
// Real SQLite underneath (node:sqlite, as tests/nbablkstl.mjs). Real payload:
// the Odds API's answer to the first live capture
// (tests/fixtures/odds-nba-pp-26b036ff-20261020.json), served for the exact
// request the cron makes. Real priors: nba-priors.json.
//
// What has to hold:
//   - Holland's rebounds leg is logged under PrizePicks' name, with ESPN's id
//     and team, projected from Ronald Holland II's season
//   - every PrizePicks player in the payload is logged; nothing else moves
//   - a player whose own name is the alias collides with the aliased one, and
//     both are dropped, as two players with one name always are
//   - your entry on "Ron Holland" grades from Ronald Holland II's box score,
//     not void
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
const FIX = path.join(BOARD, 'tests', 'fixtures');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };

const RealDate = Date;
let NOW = RealDate.parse('2026-10-20T15:01:05Z');        // when production captured it: 8:01 AM Pacific
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
};
const iso = (ms) => new RealDate(ms).toISOString();

const ODDS = fs.readFileSync(path.join(FIX, 'odds-nba-pp-26b036ff-20261020.json'), 'utf8');
const ev = JSON.parse(ODDS);
const ODDS_URL = `https://api.the-odds-api.com/v4/sports/basketball_nba/events/${ev.id}/odds?apiKey=k`
  + '&markets=player_threes,player_assists,player_rebounds,player_blocks,player_steals&oddsFormat=american&dateFormat=iso'
  + '&bookmakers=prizepicks,draftkings,fanduel';
let paid = 0;
globalThis.fetch = async (u) => {
  if (String(u) === ODDS_URL) {
    paid++;
    return new Response(ODDS, { status: 200, headers: { 'content-type': 'application/json', 'x-requests-last': '5' } });
  }
  return new Response('{}', { status: 404 });
};

const PRIORS = fs.readFileSync(path.join(BOARD, 'nba-priors.json'), 'utf8');
const priors = JSON.parse(PRIORS).players;
const HOLLAND = '4683771';
const src = fs.readFileSync(path.join(BOARD, 'worker.js'), 'utf8').replace(/\r\n/g, '\n');

// One Worker, its own database and priors, captured at 8:01 AM Pacific.
async function world(priorsJson, tag) {
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
    ? new Response(priorsJson, { status: 200, headers: { 'content-type': 'application/json' } }) : new Response('{}', { status: 404 })) } };
  // Its own module, so its priors are read afresh (worker.js keeps them once read).
  const mod = await import('data:text/javascript;base64,' + Buffer.from(src + `\n// ${tag}\n`).toString('base64'));
  const tick = async () => { const held = []; await mod.default.scheduled({}, env, { waitUntil: (p) => held.push(p) }); await Promise.allSettled(held); };
  await tick();                                          // tables made; nothing in the window yet
  sq.prepare('INSERT OR REPLACE INTO feed_cache (key, data, updated_at) VALUES (?, ?, ?)').run('nba_board:reg',
    JSON.stringify({ asOf: iso(NOW), games: [{ id: ev.id, league: 'reg', commence: ev.commence_time, home: ev.home_team, away: ev.away_team }] }), NOW);
  await tick();
  return { sq, env, mod, tick, rows: sq.prepare('SELECT * FROM nbapp').all() };
}

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
const r1 = (x) => Math.round(x * 10) / 10;
// worker.js negBinomCdf, P(X <= k) at mean m, dispersion (variance / mean) phi.
const nbCdf = (k, m, phi) => {
  const r = m / (phi - 1), q = m / (r + m);
  let t = Math.pow(r / (r + m), r), s = t;
  for (let i = 1; i <= k; i++) { t *= (r + i - 1) / i * q; s += t; }
  return Math.min(1, s);
};
const pp = ev.bookmakers.find((b) => b.key === 'prizepicks');
const ppHolland = pp.markets.find((m) => m.key === 'player_rebounds').outcomes.find((o) => o.name === 'Under' && o.description === 'Ron Holland');
ok(ppHolland && ppHolland.point === 2.5 && priors[HOLLAND].n === 'Ronald Holland II',
  `the payload has PrizePicks' "Ron Holland" under 2.5 rebounds; the priors have ${HOLLAND} as "${priors[HOLLAND].n}"`);

// ---- logged ----------------------------------------------------------------------------------
console.log('\n-- opening night, Celtics @ Pistons --');
const A = await world(PRIORS, 'priors');
ok(paid === 1, `one paid call, as before (${paid})`);
const leg = (rows, p, m) => rows.find((l) => l.player === p && l.market === m);
const h = leg(A.rows, 'Ron Holland', 'reb');
const hp = priors[HOLLAND];
ok(!!h, `Ron Holland's rebounds under is logged (${h ? `u${h.point} proj ${h.proj} ${h.model_under}%` : 'missing'})`);
ok(h && h.player_id === HOLLAND && h.team === 'DET' && h.prior_gp === hp.gp && h.min_proj === hp.min,
  `under PrizePicks' name, with ESPN's id, team, games and minutes (${h && `${h.player_id}, ${h.team}, ${h.prior_gp} gp, ${h.min_proj} min`})`);
ok(h && h.point === 2.5 && h.n_recent === 0 && h.proj === r1(hp.reb) && h.model_under === r1(nbCdf(2, hp.reb, 1.2) * 100),
  `projected from Ronald Holland II's ${hp.reb} rebounds a game at the rebounds dispersion 1.2 (${h && h.model_under}%, want ${r1(nbCdf(2, hp.reb, 1.2) * 100)})`);
const ppNames = new Set(pp.markets.flatMap((m) => m.outcomes.filter((o) => o.name === 'Under').map((o) => o.description)));
const logged = new Set(A.rows.map((l) => l.player));
const missing = [...ppNames].filter((n) => !logged.has(n));
ok(!missing.length, `every PrizePicks player in the payload is logged: ${logged.size} of ${ppNames.size} (${missing.join(', ') || 'none missing'})`);
const by = (m) => A.rows.filter((l) => l.market === m).length;
ok(A.rows.length === 30 && by('reb') === 12 && by('blk') === 1 && by('stl') === 6 && by('threes') === 6 && by('ast') === 5,
  `30 legs: production's 29 and his (${A.rows.length} = ${['blk', 'stl', 'threes', 'ast', 'reb'].map(by).join(', ')})`);

// ---- two players, one name -------------------------------------------------------------------
console.log('\n-- a player whose own name is the alias --');
const two = JSON.parse(PRIORS);
two.players['9999001'] = { n: 'Ron Holland', tm: 'BOS', gp: 60, min: 24, threes: 1, ast: 2, reb: 6, blk: 0.5, stl: 1 };
const B = await world(JSON.stringify(two), 'two-hollands');
ok(!B.rows.some((l) => /Holland/.test(l.player)),
  `with a second "Ron Holland" in the priors, neither is given the leg (${B.rows.filter((l) => /Holland/.test(l.player)).map((l) => l.player_id).join(', ') || 'no Holland leg'})`);
ok(B.rows.length === 29, `and the other 29 legs are logged as before (${B.rows.length})`);
// The raw payload says which names went unlogged, and why (tests/nbaunmatched.mjs).
const raw = async (W) => (await W.mod.default.fetch(new Request('https://x/api/nba-pp?raw=1'), W.env, { waitUntil: () => {} })).json();
const rawA = await raw(A), rawB = await raw(B);
ok(Array.isArray(rawA.unmatched) && !rawA.unmatched.length && !rawA.unmatchedLog.length,
  `with the real priors nothing goes unmatched (${JSON.stringify(rawA.unmatched)})`);
ok(JSON.stringify(rawB.unmatched) === JSON.stringify([{ name: 'Ron Holland', why: 'two players', markets: ['reb'] }]),
  `with two, the raw payload lists him as two players (${JSON.stringify(rawB.unmatched)})`);

// ---- your entries ----------------------------------------------------------------------------
console.log('\n-- your entry on "Ron Holland" --');
// Opening night's box scores, read: his line as ESPN names him. (Not his real
// line -- the grade only has to come from this row.)
A.sq.prepare(`INSERT INTO nba_box (game_id, date, season_type, player_id, player, team, min, threes, ast, reb, blk, stl, starter, dnp)
  VALUES ('401850001', '2026-10-20', 2, ?, 'Ronald Holland II', 'DET', 22, 0, 1, 2, 0, 1, 0, 0)`).run(HOLLAND);
A.sq.prepare("INSERT INTO nba_box_games (game_id, date, season_type, done) VALUES ('401850001', '2026-10-20', 2, 1)").run();
NOW = RealDate.parse('2026-10-21T15:00:00Z');           // the morning after
const KEY = 'phone-key-0123456789abcdef';
const entries = async (method, body) => (await A.mod.default.fetch(new Request('https://x/api/entries', { method,
  headers: { 'content-type': 'application/json', 'x-entry-key': KEY }, body: body ? JSON.stringify(body) : undefined }), A.env, { waitUntil: () => {} })).json();
const hl = (market, line, side) => ({ sport: 'nba', date: '2026-10-20', gamePk: ev.id, player: 'Ron Holland', team: 'DET', market, line, side });
const e = await entries('POST', { action: 'create', entry: { book: 'pp', kind: 'power', stake: 5, legs: [
  hl('reb', 2.5, 'Under'), hl('stl', 0.5, 'Over')] } });
await entries('GET');
const el = A.sq.prepare('SELECT market, result, actual FROM entry_legs WHERE entry_id = ? ORDER BY idx').all(e.id || '')
  .map((x) => `${x.market}:${x.result}:${x.actual}`).join(' ');
ok(el === 'reb:win:2 stl:win:1', `graded from Ronald Holland II's 2 rebounds and 1 steal: wins, not void (${el || e.error})`);
await A.tick();
const hg = A.sq.prepare("SELECT result, actual FROM nbapp WHERE player = 'Ron Holland' AND market = 'reb'").get() || {};
ok(hg.result === 'under' && hg.actual === 2, `and the logged leg grades by his ESPN id (${hg.result} ${hg.actual})`);
ok(paid === 2, `the only paid calls are the two captures (${paid})`);

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
