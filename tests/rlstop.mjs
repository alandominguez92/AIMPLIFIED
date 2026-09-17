// The run line is no longer logged.
//
// It was logged — never posted — to learn whether the model read the 1.5 at all.
// The record answered: 31-54, -18.2u, -21.4% ROI over 85 graded games by
// 2026-09-17. This pins that a board build writes nothing new to rlpicks, with
// the moneyline as the control: same fetch, same pass, and it must still log —
// otherwise "no rlpicks rows" could just mean nothing was priced at all.
import fs from 'node:fs';
import path from 'node:path';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };

const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const START = NOW + 5 * 3600e3;
const game = {
  gamePk: 970001, gameDate: iso(START), status: { abstractGameState: 'Preview' }, venue: { name: 'Park' },
  teams: {
    away: { team: { id: 119, abbreviation: 'LAD', name: 'Los Angeles Dodgers' }, probablePitcher: { id: 5001, fullName: 'Away Arm' } },
    home: { team: { id: 113, abbreviation: 'CIN', name: 'Cincinnati Reds' }, probablePitcher: { id: 5002, fullName: 'Home Arm' } },
  },
};
const book = (key) => ({
  key,
  markets: [
    { key: 'h2h', outcomes: [{ name: 'Cincinnati Reds', price: 150 }, { name: 'Los Angeles Dodgers', price: -170 }] },
    { key: 'spreads', outcomes: [{ name: 'Cincinnati Reds', price: -135, point: 1.5 }, { name: 'Los Angeles Dodgers', price: 115, point: -1.5 }] },
  ],
});

const realFetch = globalThis.fetch;
globalThis.fetch = async (u, o) => {
  const url = String(u);
  const J = (x) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.includes('/schedule?')) return J({ dates: [{ games: [game] }] });
  if (url.includes('/teams/stats')) return J({ stats: [{ splits: [119, 113].map((id) => ({ team: { id }, stat: { hits: 1300, plateAppearances: 6000, strikeOuts: 1330, inningsPitched: '1400.0', runs: 700, gamesPlayed: 150 } })) }] });
  if (url.includes('/people?')) {
    const ids = decodeURIComponent((url.match(/personIds=([^&]*)/) || [])[1] || '');
    return J({ people: ids.split(',').filter(Boolean).map((id) => ({ id: Number(id), fullName: 'Arm ' + id, pitchHand: { code: 'R' },
      stats: [{ splits: [{ stat: { strikeoutsPer9Inn: 9, hitsPer9Inn: 8, inningsPitched: '150.0', gamesStarted: 25, era: id === '5001' ? '2.80' : '4.60', whip: '1.20' } }] }] })) });
  }
  if (url.includes('cdn.espn.com')) return J({ content: { sbData: { events: [] } } });
  if (url.includes('api.the-odds-api.com')) {
    if (/\/odds\?/.test(url) && /markets=h2h/.test(url)) {
      return J([{ id: 'e1', commence_time: iso(START), home_team: 'Cincinnati Reds', away_team: 'Los Angeles Dodgers', bookmakers: ['draftkings', 'fanduel', 'pinnacle'].map(book) }]);
    }
    return J([]);
  }
  if (url.includes('statsapi.mlb.com')) return J({});
  return realFetch(u, o);
};

const inserts = { ml: 0, rl: 0 };
const note = (sql) => {
  if (/INSERT[^;]*INTO mlpicks/i.test(sql)) inserts.ml++;
  if (/INSERT[^;]*INTO rlpicks/i.test(sql)) inserts.rl++;
};
const db = {
  prepare: (sql) => { const st = { sql, bind: () => st, run: async () => { note(sql); return { meta: { changes: 1 } }; }, first: async () => null, all: async () => ({ results: [] }) }; return st; },
  batch: async (l) => { for (const x of (l || [])) note(x.sql); return []; },
};

const src = fs.readFileSync(BOARD + '/worker.js', 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const pending = [];
await mod.default.fetch(new Request('https://x/api/board'), { ODDS_API_KEY: 'k', DB: db }, { waitUntil: (p) => pending.push(p) });
await Promise.all(pending);

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
ok(inserts.ml > 0, `the moneyline still logs from the same pass (${inserts.ml} mlpicks writes) — so the board did price this game`);
ok(inserts.rl === 0, `the run line logs nothing (${inserts.rl} rlpicks writes)`);
console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
