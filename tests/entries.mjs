// Your entries: logged, graded from real box scores, paid the way the app pays.
//
// Every other record here grades the board's own picks. This one grades what
// was actually played — PrizePicks power and flex, DraftKings straights and
// parlays — so "which options win" has an answer that is about real money.
//
// Real SQLite underneath (node:sqlite, the same D1 adapter tests/readpaths.mjs
// uses), because this feature is mostly SQL and a regex stub would only prove
// the stub agrees with itself. Real StatsAPI responses too, recorded 2026-09-25
// from a finished game: STL 1 at PIT 2. Nathan Church had 1 total base and
// 1 H+R+RBI, Paul Skenes struck out 8, Nolan Gorman did not play.
//
// What has to hold, or the numbers mislead:
//   - the log is private: no key, no access; a second key cannot read the first
//   - a player who did not play voids his leg, never a free under
//   - payouts follow the entry type: a flex pays on partial hits, a power does
//     not, and an entry reduced by a void pays at its reduced size
//   - a payout typed in from the app survives re-grading
//   - nothing about it is cached or readable cross-origin
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
const FIX = path.join(BOARD, 'tests', 'fixtures');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };

const sq = new DatabaseSync(':memory:');
const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
function exec(sql, args, mode) {
  const st = sq.prepare(sql);
  const a = args.map(norm);
  if (mode === 'all') return { results: st.all(...a), meta: {} };
  if (mode === 'first') return st.get(...a) || null;
  return { success: true, meta: { changes: Number(st.run(...a).changes) } };
}
const DB = {
  prepare: (sql) => { const s = { sql, args: [], bind: (...x) => { s.args = x; return s; },
    all: async () => exec(s.sql, s.args, 'all'), first: async (c) => { const r = exec(s.sql, s.args, 'first'); return c && r ? r[c] : r; },
    run: async () => exec(s.sql, s.args, 'run') }; return s; },
  batch: async (sts) => sts.map((x) => exec(x.sql, x.args, 'run')),
};

const SCHED = fs.readFileSync(path.join(FIX, 'statsapi-schedule-823326.json'), 'utf8');
const BOX = fs.readFileSync(path.join(FIX, 'statsapi-boxscore-823326.json'), 'utf8');
let statsCalls = 0;
globalThis.fetch = async (u) => {
  const url = String(u);
  const J = (t) => new Response(t, { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.includes('statsapi.mlb.com')) {
    statsCalls++;
    if (url.includes('/game/823326/boxscore')) return J(BOX);
    if (url.includes('/schedule') && url.includes('823326')) return J(SCHED);
    return J('{"dates":[]}');
  }
  return J('{}');
};

const src = fs.readFileSync(BOARD + '/worker.js', 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const env = { DB, ODDS_API_KEY: 'k' };
const ctx = { waitUntil: (p) => { if (p && p.then) p.catch(() => {}); } };
const KEY = 'phone-key-0123456789abcdef';
const call = async (method, body, key = KEY) => {
  const headers = { 'content-type': 'application/json' };
  if (key) headers['x-entry-key'] = key;
  const r = await mod.default.fetch(new Request('https://x/api/entries', { method, headers, body: body ? JSON.stringify(body) : undefined }), env, ctx);
  return { status: r.status, headers: r.headers, body: await r.json() };
};
const create = (entry) => call('POST', { action: 'create', entry });

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

// ---- private -------------------------------------------------------------------------------
ok((await call('GET', null, null)).status === 401, 'no key, no log');
const first = await call('GET');
ok(first.status === 200, 'the first key to arrive opens it');
ok((await call('GET', null, 'someone-elses-key-0000000000')).status === 403, 'and a second key is refused');
ok(first.headers.get('cache-control') === 'private, no-store' && !first.headers.get('access-control-allow-origin'),
  `never cached, never readable from another site (${first.headers.get('cache-control')})`);

// ---- refused shapes --------------------------------------------------------------------------
const leg = (o) => ({ sport: 'mlb', date: '2026-09-24', gamePk: 823326, ...o });
const CHURCH = { playerId: 701675, player: 'Nathan Church', team: 'STL' };
const SKENES = { playerId: 694973, player: 'Paul Skenes', team: 'PIT' };
const GORMAN = { playerId: 669357, player: 'Nolan Gorman', team: 'STL' };
ok((await create({ book: 'pp', kind: 'power', stake: 10, legs: [leg({ ...CHURCH, market: 'tb', line: 1.5, side: 'Under' })] })).status === 400,
  'a one-pick PrizePicks power entry is refused — the app has none');
ok((await create({ book: 'dk', kind: 'parlay', stake: 10, legs: [leg({ market: 'ml', side: 'home', player: 'PIT' }), leg({ market: 'ml', side: 'away', player: 'STL' })] })).status === 400,
  'a DraftKings parlay without its odds is refused — the payout is computed from them');

// ---- five real entries -----------------------------------------------------------------------
// A: 3-pick flex, 2 of 3 hit -> 1.25x. $10 returns $12.50.
const A = await create({ book: 'pp', kind: 'flex', stake: 10, legs: [
  leg({ ...CHURCH, market: 'hrr', line: 1.5, side: 'Under', modelProb: 62 }),   // 1 -> win
  leg({ ...SKENES, market: 'K', line: 6.5, side: 'Over', modelProb: 58 }),      // 8 -> win
  leg({ ...CHURCH, market: 'tb', line: 0.5, side: 'Under', modelProb: 47 }),    // 1 -> loss
] });
// B: 2-pick power, one leg did not play -> reduced below two -> refunded.
const B = await create({ book: 'pp', kind: 'power', stake: 10, legs: [
  leg({ ...CHURCH, market: 'tb', line: 1.5, side: 'Under', modelProb: 71 }),    // win
  leg({ ...GORMAN, market: 'tb', line: 0.5, side: 'Under', modelProb: 66 }),    // did not play
] });
// C: DraftKings straight, Pittsburgh -150 at home, won. $10 returns $16.67.
const C = await create({ book: 'dk', kind: 'straight', stake: 10, legs: [leg({ market: 'ml', side: 'home', player: 'PIT', price: -150, modelProb: 57 })] });
// D: DraftKings parlay, St. Louis +130 lost -> nothing back.
const D = await create({ book: 'dk', kind: 'parlay', stake: 10, legs: [
  leg({ market: 'ml', side: 'away', player: 'STL', price: 130, modelProb: 44 }),
  leg({ ...SKENES, market: 'K', line: 6.5, side: 'Over', price: -120, modelProb: 58 }),
] });
// E: an NFL leg nothing grades yet — one tap.
const E = await create({ book: 'dk', kind: 'straight', stake: 10, legs: [{ sport: 'nfl', date: '2026-09-27', player: 'Buffalo Bills', market: 'ml', side: 'Win', price: -200 }] });
ok([A, B, C, D, E].every((x) => x.status === 200 && x.body.id), `five entries saved (${[A, B, C, D, E].map((x) => x.status).join(',')})`);

const log = await call('GET');
const byId = (id) => log.body.entries.find((e) => e.id === id);
const a = byId(A.body.id), b = byId(B.body.id), c = byId(C.body.id), d = byId(D.body.id), e = byId(E.body.id);
console.log('\n  ' + [a, b, c, d, e].map((x) => `${x.type}: ${x.legs.map((l) => l.result).join('/')} -> $${x.payout} (${x.status})`).join('\n  ') + '\n');

ok(a.legs.map((l) => l.result).join() === 'win,win,loss' && a.legs[1].actual === 8,
  `graded from the box score: Church 1 H+R+RBI under 1.5, Skenes 8 K over 6.5, Church 1 TB over the 0.5 under (${a.legs.map((l) => l.actual).join(', ')})`);
ok(a.payout === 12.5 && a.status === 'settled', `a 3-pick flex with two hits pays 1.25x — $10 back as $12.50 (${a.payout})`);
ok(b.legs[1].result === 'void' && b.legs[1].actual == null,
  'Gorman never came off the bench — his leg voids, it does not score a free under');
ok(b.payout === 10, `and a 2-pick power reduced to one live pick is refunded (${b.payout})`);
ok(c.payout === 16.67, `DraftKings pays from the odds: Pittsburgh -150 won, $10 back as $16.67 (${c.payout})`);
ok(d.payout === 0, `a parlay with a losing leg returns nothing (${d.payout})`);
ok(e.status === 'open' && e.legs[0].result == null, 'an NFL leg waits for a tap rather than guessing');

// ---- the tap, and the override ----------------------------------------------------------------
await call('POST', { action: 'leg', id: E.body.id, idx: 0, result: 'win' });
const e2 = (await call('GET')).body.entries.find((x) => x.id === E.body.id);
ok(e2.status === 'settled' && e2.payout === 15, `one tap settles it at its odds — -200 on $10 is $15 back (${e2.payout})`);

// A demon or a promo pays off the table: what the app actually paid wins, and stays.
await call('POST', { action: 'payout', id: A.body.id, payout: 30 });
const again = (await call('GET')).body.entries.find((x) => x.id === A.body.id);
ok(again.payout === 30 && again.payout_src === 'manual', `a payout typed in from the app survives re-grading (${again.payout}, ${again.payout_src})`);

// ---- what wins ----------------------------------------------------------------------------------
const sum = (await call('GET')).body.summary;
console.log('\n  overall: ' + JSON.stringify(sum.overall));
console.log('  by type: ' + sum.byType.map((t) => `${t.key} ${t.profit >= 0 ? '+' : ''}${t.profit}`).join(' | '));
console.log('  legs by market: ' + sum.legsByMarket.map((m) => `${m.key} ${m.hit}/${m.n}`).join(' | '));
console.log('  legs by model probability: ' + sum.legsByModelProb.map((m) => `${m.key} ${m.hit}/${m.n}`).join(' | ') + '\n');
// staked 50; back 30 + 10 + 16.67 + 0 + 15 = 71.67
ok(sum.overall.entries === 5 && sum.overall.staked === 50 && sum.overall.returned === 71.67 && sum.overall.profit === 21.67,
  `the overall line adds up: $50 staked, $71.67 back (${sum.overall.staked} / ${sum.overall.returned})`);
ok(sum.byType.some((t) => t.key === 'PrizePicks 3-pick flex') && sum.byType.some((t) => t.key === 'DraftKings straight' && t.entries === 2),
  'grouped by the entry type actually played — the question "which options win"');
ok(sum.legsByMarket.some((m) => m.key === 'Strikeouts' && m.n === 2 && m.hit === 2),
  'legs grouped by market, so a weak market shows up whatever entry it rode in');
// Nine legs logged, one of them Gorman's void: eight decided, six hit.
ok(sum.legs.n === 8 && sum.legs.hit === 6, `a void is neither a hit nor a miss — 9 legs, 8 decided (${sum.legs.hit}/${sum.legs.n})`);
ok(sum.legsByModelProb.length >= 3, 'and by the model probability at entry, which ties back to the top-legs ranking');

// ---- delete ---------------------------------------------------------------------------------------
await call('POST', { action: 'delete', id: D.body.id });
ok(!(await call('GET')).body.entries.some((x) => x.id === D.body.id), 'an entry can be removed');
ok(statsCalls > 0, `graded off StatsAPI, which is free (${statsCalls} calls)`);

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exitCode = fail ? 1 : 0;
