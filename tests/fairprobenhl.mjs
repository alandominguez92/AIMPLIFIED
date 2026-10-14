// The fair-line probe can be pointed at the NHL, and says which players each
// book quotes (2026-10-14).
//
// Probe-only: nothing NHL is ingested. Before any hockey is built, two
// questions: does shots on goal have a sharp fair line (two sharp books on the
// same number, two-sided), and do DraftKings and PrizePicks quote the same
// players? The probe's per-book counts could not answer the second -- 40
// quotes from each book may or may not be the same 40 players -- so it now
// reports player coverage per pair of execution books, from the same
// responses (no extra calls). Pinned here too: ?games=3 makes exactly three
// paid calls.
import fs from 'node:fs';
import path from 'node:path';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };

const later = (h) => new Date(Date.now() + h * 3600e3).toISOString();
const events = [
  { id: 'n1', commence_time: later(3), away_team: 'Montréal Canadiens', home_team: 'Washington Capitals' },
  { id: 'n2', commence_time: later(4), away_team: 'Dallas Stars', home_team: 'Colorado Avalanche' },
  { id: 'n3', commence_time: later(27), away_team: 'Boston Bruins', home_team: 'Florida Panthers' },
  { id: 'n4', commence_time: later(28), away_team: 'Seattle Kraken', home_team: 'Vegas Golden Knights' },
];
const two = (who, point, over, under) => [
  { name: 'Over', description: who, point, price: over }, { name: 'Under', description: who, point, price: under }];
const sog = (outcomes) => ({ markets: [{ key: 'player_shots_on_goal', outcomes }] });
// Game n1: Ovechkin at 3.5 on both sharp books, DK and PP; Suzuki at 2.5 on
// Pinnacle only and on DK at 2.5, PP at 3.5; Caufield on PrizePicks only.
const odds = {
  n1: { id: 'n1', bookmakers: [
    { key: 'pinnacle', ...sog([...two('Alex Ovechkin', 3.5, -110, -110), ...two('Nick Suzuki', 2.5, 105, -125)]) },
    { key: 'novig', ...sog(two('Alex Ovechkin', 3.5, -105, -105)) },
    { key: 'draftkings', ...sog([...two('Alex Ovechkin', 3.5, -120, -105), ...two('Nick Suzuki', 2.5, 100, -130)]) },
    { key: 'prizepicks', ...sog([...two('Alex Ovechkin', 3.5, -137, -137), ...two('Nick Suzuki', 3.5, -137, -137), ...two('Cole Caufield', 3.5, -137, -137)]) },
  ] },
  n2: { id: 'n2', bookmakers: [
    { key: 'pinnacle', ...sog(two('Nathan MacKinnon', 4.5, -115, -105)) },
    { key: 'prophetx', ...sog(two('Nathan MacKinnon', 4.5, -110, -110)) },
    { key: 'draftkings', ...sog([...two('Nathan MacKinnon', 4.5, -125, 100), ...two('Jason Robertson', 2.5, -110, -110)]) },
  ] },
  n3: { id: 'n3', bookmakers: [] },
};
let paid = 0;
globalThis.fetch = async (u) => {
  const url = String(u);
  const J = (x) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json', 'x-requests-last': '1', 'x-requests-remaining': '999' } });
  if (url.includes('/sports/icehockey_nhl/events?')) return J(events);
  const m = url.match(/\/sports\/icehockey_nhl\/events\/(n\d)\/odds\?/);
  if (m) { paid++; return J(odds[m[1]] || { bookmakers: [] }); }
  return J({});
};

const src = fs.readFileSync(BOARD + '/worker.js', 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const q = 'sport=nhl&market=player_shots_on_goal&books=pinnacle,novig,prophetx,draftkings,fanduel,prizepicks&games=3';
const out = await (await mod.default.fetch(new Request('https://x/api/fair-probe?' + q), { ODDS_API_KEY: 'k' }, { waitUntil() {} })).json();

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
const ov = (out.sharpOverlap || {}).player_shots_on_goal || {};
const cov = ((out.playerCoverage || {}).player_shots_on_goal || {})['draftkings|prizepicks'] || {};
console.log('  ' + JSON.stringify({ sport: out.sportProbed, games: out.gamesProbed, est: out.estimatedCredits, ov, cov }));

ok(out.sportProbed === 'icehockey_nhl', `?sport=nhl probes icehockey_nhl (${out.sportProbed || out.error})`);
ok(out.gamesProbed === 3 && paid === 3 && out.estimatedCredits === 3, `three games, three paid calls, 3 credits estimated (${paid})`);
ok(ov.linesWith2PlusSharp === 2, `two lines carry two sharp books on the same number, two-sided (${ov.linesWith2PlusSharp})`);
ok(cov.draftkings === 4 && cov.prizepicks === 3, `DraftKings quotes 4 players, PrizePicks 3 (${cov.draftkings}, ${cov.prizepicks})`);
ok(cov.both === 2 && cov.draftkingsOnly === 2 && cov.prizepicksOnly === 1, `2 on both, 2 DraftKings-only, 1 PrizePicks-only (${cov.both}/${cov.draftkingsOnly}/${cov.prizepicksOnly})`);
ok(cov.bothSameNumber === 1, `of the shared players, 1 at the same number (${cov.bothSameNumber})`);
ok(Array.isArray(cov.prizepicksOnlySample) && cov.prizepicksOnlySample.includes('Cole Caufield'), 'and it names who is missing from which book');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
