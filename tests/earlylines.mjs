// Early lines: games on the displayed slate are priced before the 12-hour gate.
//
// PROP_LEAD_MS alone meant nothing was bought for a game until 12 hours before
// first pitch, so at 2 AM PT an afternoon slate read "awaiting line" on every row
// while DraftKings and FanDuel were already quoting it. The fix prices those
// games too — but on an hourly, global cadence, because the gate existed to stop
// the quota bleeding. So this test is mostly about what is NOT bought:
//   - a game more than 12h out on today's slate IS priced, and shows its line;
//   - it is bought once, then not again inside the hour, from any location;
//   - after the hour it is bought again;
//   - a game on tomorrow's slate (inside 24h but after PT midnight) is NOT bought;
//   - the near tier is untouched: a near game is still bought on its own cadence;
//   - an empty early answer (books not posted yet) is remembered, not re-asked.
//
// The clock is pinned so "today" in Pacific time is deterministic.
import fs from 'node:fs';
import path from 'node:path';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };

// 2026-09-14 01:00 PT.
const T0 = Date.parse('2026-09-14T08:00:00Z');
let offsetMs = 0;
const RealDate = Date;
class FakeDate extends RealDate {
  constructor(...a) { if (a.length) super(...a); else super(T0 + offsetMs); }
  static now() { return T0 + offsetMs; }
}
globalThis.Date = FakeDate;

const H = 3600e3;
// id, hours from T0, PT date, expected tier
const SLATE = [
  { id: 'near', h: 9, abbr: ['NA', 'NH'] },     // 10:00 PT today  -> near
  { id: 'early', h: 18, abbr: ['EA', 'EH'] },   // 19:00 PT today  -> early
  { id: 'late', h: 22.5, abbr: ['LA', 'LH'] },  // 23:30 PT today  -> early
  { id: 'tmrw', h: 23.5, abbr: ['TA', 'TH'] },  // 00:30 PT tomorrow, inside 24h -> not bought
];
const iso = (ms) => new RealDate(ms).toISOString();
const team = (id, abbr) => ({ id, abbreviation: abbr, name: abbr + ' Club' });
const games = SLATE.map((g, i) => ({
  gamePk: 920000 + i,
  gameDate: iso(T0 + g.h * H),
  status: { abstractGameState: 'Preview' },
  venue: { name: 'Park' },
  teams: {
    away: { team: team(300 + i * 2, g.abbr[0]), probablePitcher: { id: 9100 + i * 2, fullName: `Away Arm ${g.id}` } },
    home: { team: team(301 + i * 2, g.abbr[1]), probablePitcher: { id: 9101 + i * 2, fullName: `Home Arm ${g.id}` } },
  },
}));
const events = SLATE.map((g, i) => ({
  id: g.id, commence_time: iso(T0 + g.h * H),
  away_team: g.abbr[0] + ' Club', home_team: g.abbr[1] + ' Club',
}));

let booksPosted = true;
const calls = { k: {}, b: {} };
const resetCalls = () => { calls.k = {}; calls.b = {}; };
const count = (bucket, id) => { bucket[id] = (bucket[id] || 0) + 1; };
const kBody = (id) => ({
  bookmakers: booksPosted ? ['draftkings', 'fanduel'].map((key) => ({
    key,
    markets: [{
      key: 'pitcher_strikeouts',
      outcomes: [`Away Arm ${id}`, `Home Arm ${id}`].flatMap((n) => ([
        { name: 'Over', description: n, point: 5.5, price: -137 },
        { name: 'Under', description: n, point: 5.5, price: 111 },
      ])),
    }],
  })) : [],
});
const bBody = (id) => ({
  bookmakers: booksPosted ? ['draftkings', 'fanduel'].map((key) => ({
    key,
    markets: [{
      key: 'batter_total_bases',
      outcomes: [`Hitter ${id}`].flatMap((n) => ([
        { name: 'Over', description: n, point: 1.5, price: -115 },
        { name: 'Under', description: n, point: 1.5, price: -105 },
      ])),
    }],
  })) : [],
});

const realFetch = globalThis.fetch;
globalThis.fetch = async (u, o) => {
  const url = String(u);
  const J = (x, s) => new Response(JSON.stringify(x), { status: s || 200, headers: { 'content-type': 'application/json' } });
  if (url.includes('/schedule?')) return J({ dates: [{ games }] });
  if (url.includes('/teams/stats')) {
    return J({ stats: [{ splits: games.flatMap((g) => [g.teams.away.team.id, g.teams.home.team.id]).map((id) => ({
      team: { id }, stat: { hits: 1300, plateAppearances: 6000, strikeOuts: 1330, inningsPitched: '1400.0' },
    })) }] });
  }
  if (url.includes('/people?')) {
    const ids = (url.match(/personIds=([^&]*)/) || [])[1] || '';
    return J({ people: decodeURIComponent(ids).split(',').filter(Boolean).map((id) => ({
      id: Number(id), fullName: 'Arm ' + id, pitchHand: { code: 'R' },
      stats: [{ splits: [{ stat: { strikeoutsPer9Inn: 9, hitsPer9Inn: 8, inningsPitched: '150.0', gamesStarted: 25, era: '3.50' } }] }],
    })) });
  }
  if (url.includes('cdn.espn.com')) return J({ content: { sbData: { events: [] } } });
  if (url.includes('api.the-odds-api.com')) {
    if (/\/events\?/.test(url)) return J(events);
    const m = url.match(/\/events\/([a-z]+)\/odds\?.*markets=([^&]+)/);
    if (m) {
      if (m[2] === 'pitcher_strikeouts') { count(calls.k, m[1]); return J(kBody(m[1])); }
      count(calls.b, m[1]); return J(bBody(m[1]));
    }
    return J([]);
  }
  if (url.includes('statsapi.mlb.com')) return J({});
  return realFetch(u, o);
};

const src = fs.readFileSync(BOARD + '/worker.js', 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));

// feed_cache stand-in, same statements as sharedlines.mjs. Every other query
// answers empty, which the worker's best-effort D1 paths already tolerate.
function makeDb() {
  const rows = new Map();
  const run = (sql, args) => {
    if (/^INSERT OR IGNORE INTO feed_cache/i.test(sql)) {
      if (rows.has(args[0])) return { success: true, meta: { changes: 0 } };
      rows.set(args[0], { data: null, updated_at: 0, claimed_until: 0 });
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
const hit = async (env, route) => {
  const r = await mod.default.fetch(new Request('https://x' + route), env, ctx);
  await Promise.all(pending.splice(0));
  return r.json();
};

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
const fmt = (b) => JSON.stringify(b);

// ---- strikeout board ------------------------------------------------------------
{
  const { db, rows } = makeDb();
  const env = { ODDS_API_KEY: 'k', DB: db };
  offsetMs = 0; resetCalls();
  const board = await hit(env, '/api/board');
  const bought = { ...calls.k };
  console.log('-- strikeout board at 1:00 AM PT --  bought ' + fmt(bought));
  ok(bought.near === 1, 'the near game is bought, as before');
  ok(bought.early === 1 && bought.late === 1, 'both of today\'s games more than 12h out are bought');
  ok(!bought.tmrw, 'the game after PT midnight is not bought, though it is inside 24h');
  const earlyRow = (Array.isArray(board) ? board : []).find((r) => /EA|EH/.test(r.matchup || ''));
  ok(!!earlyRow && (earlyRow.pitchers || []).some((p) => p.market && p.market.line === 5.5 && (p.market.books || []).length === 2),
    'the early game\'s row carries the book line');
  ok([...rows.keys()].some((k) => k.startsWith('kprop_lines_early:') && k.includes('2026-09-14')),
    `early lines were stored under today's slate (${[...rows.keys()].join(', ')})`);

  offsetMs = 20 * 60e3; resetCalls();
  await hit(env, '/api/board');                 // another location, 20 min later
  console.log('-- 20 min later, another location --  bought ' + fmt(calls.k));
  ok(calls.k.near === 1, 'the near game is still bought on its own cadence');
  ok(!calls.k.early && !calls.k.late, 'the early games are NOT bought again inside the hour');

  offsetMs = 61 * 60e3; resetCalls();
  await hit(env, '/api/board');
  console.log('-- 61 min later --  bought ' + fmt(calls.k));
  // Two cadences, split at 18h out: hourly inside it, every three hours beyond.
  // The far one exists because both boards roll to tomorrow's slate overnight,
  // which would otherwise re-buy a full schedule eight times before anyone woke
  // up, for lines that barely move that far from first pitch.
  ok(calls.k.early === 1, 'after the hour the game inside 18h is bought again');
  ok(!calls.k.late, 'the one further out than 18h is not — it is on the slower cadence');

  offsetMs = 181 * 60e3; resetCalls();
  await hit(env, '/api/board');
  console.log('-- 181 min later --  bought ' + fmt(calls.k));
  ok(calls.k.late === 1, 'after three hours the far game is bought again');
}

// ---- batter board ----------------------------------------------------------------
{
  const { db, rows } = makeDb();
  const env = { ODDS_API_KEY: 'k', DB: db };
  offsetMs = 0; resetCalls();
  await hit(env, '/api/batters');
  console.log('\n-- batter board at 1:00 AM PT --  bought ' + fmt(calls.b));
  ok(calls.b.near === 1, 'the near game is bought, as before');
  ok(calls.b.early === 1 && calls.b.late === 1, 'today\'s games more than 12h out are bought');
  ok(!calls.b.tmrw, 'tomorrow\'s game is not bought');
  const early = rows.get([...rows.keys()].find((k) => k.startsWith('batter_lines_early:') && k.includes('2026-09-14')) || '');
  const stored = early && early.data ? JSON.parse(early.data) : {};
  ok(!!stored[Object.keys(stored).find((k) => /early/.test(k))], 'the early hitters were stored under today\'s slate');
  const near = rows.get([...rows.keys()].find((k) => k.startsWith('batter_lines:')) || '');
  const nearStored = near && near.data ? JSON.parse(near.data) : {};
  ok(Object.keys(nearStored).length === 1 && Object.keys(nearStored).every((k) => /near/.test(k)),
    `the near store holds only the near game (${Object.keys(nearStored).join(', ')})`);

  offsetMs = 20 * 60e3; resetCalls();
  await hit(env, '/api/batters');
  console.log('-- 20 min later --  bought ' + fmt(calls.b));
  ok(!calls.b.early && !calls.b.late, 'the early games are NOT bought again inside the hour');
  ok([...rows.keys()].some((k) => k.endsWith(':far')),
    'the far-out game has its own store key, so the two cadences cannot overwrite each other');
}

// ---- books not posted yet: the empty answer is remembered ------------------------------
{
  const { db } = makeDb();
  const env = { ODDS_API_KEY: 'k', DB: db };
  booksPosted = false;
  offsetMs = 0; resetCalls();
  await hit(env, '/api/batters');
  const firstEarly = (calls.b.early || 0) + (calls.b.late || 0);
  offsetMs = 10 * 60e3; resetCalls();
  await hit(env, '/api/batters');
  const secondEarly = (calls.b.early || 0) + (calls.b.late || 0);
  console.log('\n-- nothing posted yet --');
  ok(firstEarly === 2, `the early games are asked once (${firstEarly})`);
  ok(secondEarly === 0, `and an empty answer is not re-asked inside the hour (${secondEarly})`);
  booksPosted = true;
}

// ---- close capture never reads the early store -------------------------------------
{
  const s = src;
  const kBlock = s.slice(s.indexOf('const earlyK'), s.indexOf('const earlyK') + 200);
  const bBlock = s.slice(s.indexOf('const earlyB'), s.indexOf('const earlyB') + 200);
  console.log('\n-- close capture --');
  ok(/closeOnly\)\s*\?\s*\[\]/.test(kBlock) && /closeOnly\s*\?\s*\[\]/.test(bBlock),
    'a close-capture pass buys no early lines on either board');
}

globalThis.Date = RealDate;
console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
