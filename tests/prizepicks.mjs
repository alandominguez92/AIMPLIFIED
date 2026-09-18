// PrizePicks is shown, never priced against.
//
// It is where most of the betting actually happens here, so its number belongs
// on the board — but pick'em pays by entry type (2-pick power, 6-pick flex...),
// not by the line, so its "odds" must never set a price, an edge, a fair line or
// the best-price pick. What IS decision-grade is the NUMBER: PrizePicks hangs a
// different line often enough that under 2.5 vs under 1.5 is the whole bet.
//
// The fixture gives PrizePicks a better price AND a different number than DK/FD,
// so if it ever leaked into pricing it would win the best-price comparison and
// the failure would be loud.
import fs from 'node:fs';
import path from 'node:path';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };

const START = Date.now() + 5 * 3600e3;
const iso = (ms) => new Date(ms).toISOString();
const game = {
  gamePk: 993001, gameDate: iso(START), status: { abstractGameState: 'Preview' }, venue: { name: 'Park' },
  teams: {
    away: { team: { id: 119, abbreviation: 'LAD', name: 'Los Angeles Dodgers' }, probablePitcher: { id: 7701, fullName: 'Away Arm' } },
    home: { team: { id: 113, abbreviation: 'CIN', name: 'Cincinnati Reds' }, probablePitcher: { id: 7702, fullName: 'Home Arm' } },
  },
};
const HITTER = 'CIN Bat';
const statSplits = [{
  player: { id: 880001, fullName: HITTER }, team: { id: 113, abbreviation: 'CIN' },
  stat: { gamesPlayed: 140, plateAppearances: 600, atBats: 540, hits: 150, runs: 80, rbi: 75, homeRuns: 20, totalBases: 250, strikeOuts: 120, baseOnBalls: 55, avg: '.278', slg: '.463' },
}];
// DK/FD and the sharps on 1.5; PrizePicks on 2.5 at a much longer price.
const propBook = (key) => ({ key, markets: [{
  key: 'batter_total_bases',
  outcomes: [
    { name: 'Over', description: HITTER, point: key === 'prizepicks' ? 2.5 : 1.5, price: key === 'prizepicks' ? 400 : -115 },
    { name: 'Under', description: HITTER, point: key === 'prizepicks' ? 2.5 : 1.5, price: key === 'prizepicks' ? 400 : -105 },
  ],
}] });
const kBook = (key) => ({ key, markets: [{
  key: 'pitcher_strikeouts',
  outcomes: [
    { name: 'Over', description: 'Home Arm', point: key === 'prizepicks' ? 6.5 : 4.5, price: key === 'prizepicks' ? 400 : -110 },
    { name: 'Under', description: 'Home Arm', point: key === 'prizepicks' ? 6.5 : 4.5, price: key === 'prizepicks' ? 400 : -110 },
  ],
}] });
const BOOKS = ['draftkings', 'fanduel', 'pinnacle', 'novig', 'prophetx', 'prizepicks'];

let requestedBooks = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, o) => {
  const url = String(u);
  const J = (x) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.includes('/schedule?')) return J({ dates: [{ games: [game] }] });
  if (url.includes('/stats?stats=season') && url.includes('group=hitting')) return J({ stats: [{ splits: statSplits }] });
  if (url.includes('/teams/stats')) return J({ stats: [{ splits: [113, 119].map((id) => ({ team: { id }, stat: { hits: 1300, plateAppearances: 6000, strikeOuts: 1330, inningsPitched: '1400.0' } })) }] });
  if (url.includes('/people?')) {
    const ids = decodeURIComponent((url.match(/personIds=([^&]*)/) || [])[1] || '');
    return J({ people: ids.split(',').filter(Boolean).map((id) => ({ id: Number(id), fullName: 'Arm ' + id, pitchHand: { code: 'R' },
      stats: [{ splits: [{ stat: { strikeoutsPer9Inn: '9.00', inningsPitched: '150.0', gamesStarted: 25, era: '3.50', hitsPer9Inn: '8.00' } }] }] })) });
  }
  if (url.includes('cdn.espn.com')) return J({ content: { sbData: { events: [] } } });
  if (url.includes('api.the-odds-api.com')) {
    // Only the PER-EVENT prop calls matter here; the game-odds call legitimately
    // asks for three books, and capturing that one measured the wrong request.
    const bk = (url.match(/bookmakers=([^&]*)/) || [])[1];
    if (bk && /markets=(batter_|pitcher_)/.test(url)) requestedBooks = decodeURIComponent(bk).split(',');
    if (/\/events\?/.test(url)) return J([{ id: 'ev1', commence_time: iso(START), home_team: 'Cincinnati Reds', away_team: 'Los Angeles Dodgers' }]);
    if (/markets=pitcher_strikeouts/.test(url)) return J({ bookmakers: BOOKS.map(kBook) });
    if (/\/events\/ev1\/odds/.test(url)) return J({ bookmakers: BOOKS.map(propBook) });
    return J([]);
  }
  if (url.includes('statsapi.mlb.com')) return J({});
  return realFetch(u, o);
};

const src = fs.readFileSync(BOARD + '/worker.js', 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const env = { ODDS_API_KEY: 'k' };
const ctx = { waitUntil() {} };
const batters = await (await mod.default.fetch(new Request('https://x/api/batters'), env, ctx)).json();
const board = await (await mod.default.fetch(new Request('https://x/api/board'), env, ctx)).json();

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
const row = (batters.rows || [])[0];
const tb = row ? (row.batterMarkets || []).find((m) => m.metric === 'tb') : null;
const arm = ((board[0] || {}).pitchers || []).find((p) => p.team === 'CIN');
console.log(`  batter: priced ${tb && tb.side} ${tb && tb.line} at ${tb && tb.price}; PP ${tb && tb.pp && tb.pp.point} (model ${tb && tb.pp && tb.pp.modelUnder}% under)`);
console.log(`  arm:    priced ${arm && arm.market && arm.market.line} at ${arm && arm.market && arm.market.price}; PP ${arm && arm.pp && arm.pp.point} (model ${arm && arm.pp && arm.pp.modelUnder}% under)\n`);

ok(!!tb && tb.pp && tb.pp.point === 2.5, `the batter row carries PrizePicks' own number (${tb && tb.pp && tb.pp.point})`);
ok(tb && tb.pp && tb.pp.modelUnder > 0 && tb.pp.modelUnder < 100,
  `with the model's probability of landing under IT, not under the book line (${tb && tb.pp && tb.pp.modelUnder}%)`);
ok(tb && tb.line === 1.5, `the priced line is still the book's (${tb && tb.line}), not PrizePicks'`);
ok(tb && tb.price === -105, `and the price is the book's (${tb && tb.price}) — PrizePicks' +400 never wins best price`);
ok(tb && Array.isArray(tb.books) && tb.books.every((b) => b.book !== 'PP'),
  `PrizePicks is not in the bettable books list (${(tb && tb.books || []).map((b) => b.book).join(', ')})`);
ok(tb && tb.fairSrc !== 'PP' && tb.fairSrc !== 'prizepicks', `nor the fair source (${tb && tb.fairSrc})`);
ok(arm && arm.pp && arm.pp.point === 6.5 && arm.market && arm.market.line === 4.5,
  `the strikeout row shows PrizePicks' number (${arm && arm.pp && arm.pp.point}) beside the priced one (${arm && arm.market && arm.market.line})`);
ok(arm && arm.pp && arm.pp.modelUnder != null, 'with its own under probability');

// Billing: the Odds API charges ceil(books/10) region-equivalents, so the 8th
// book is free — but a 11th would silently double every per-event call.
ok(Array.isArray(requestedBooks) && requestedBooks.includes('prizepicks'),
  `PrizePicks is requested in the same call (${(requestedBooks || []).length} books)`);
ok(Array.isArray(requestedBooks) && requestedBooks.length <= 10,
  `and the book list stays inside one region-equivalent (${(requestedBooks || []).length} of 10)`);

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
