// Strikeout projections carry K_PROJ_CAL.
//
// 881 graded starts projected 5.21 strikeouts against 4.76 recorded (0.913), and
// the model leaned over on 74% of starts, the losing side. The fixture neutralises
// every other input — league-average opponent, a park factor of 1.00, no weather —
// so the projection is exactly K/9 x innings/9 x the calibration, and anything
// else showing up in the number is a regression.
import fs from 'node:fs';
import path from 'node:path';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };

const START = Date.now() + 5 * 3600e3;
const game = {
  gamePk: 995001, gameDate: new Date(START).toISOString(), status: { abstractGameState: 'Preview' }, venue: { name: 'PNC Park' },
  teams: {
    away: { team: { id: 117, abbreviation: 'HOU', name: 'Houston Astros' }, probablePitcher: { id: 7001, fullName: 'Away Arm' } },
    home: { team: { id: 134, abbreviation: 'PIT', name: 'Pittsburgh Pirates' }, probablePitcher: { id: 7002, fullName: 'Home Arm' } },
  },
};
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, o) => {
  const url = String(u);
  const J = (x) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.includes('/schedule?')) return J({ dates: [{ games: [game] }] });
  if (url.includes('/people?')) {
    const ids = decodeURIComponent((url.match(/personIds=([^&]*)/) || [])[1] || '');
    // 9 K/9 over 150 IP in 25 starts: exactly 6 innings a start, 6.0 raw strikeouts.
    return J({ people: ids.split(',').filter(Boolean).map((id) => ({ id: Number(id), fullName: 'Arm ' + id, pitchHand: { code: 'R' },
      stats: [{ splits: [{ stat: { strikeoutsPer9Inn: '9.00', inningsPitched: '150.0', gamesStarted: 25, era: '3.50', hitsPer9Inn: '8.00' } }] }] })) });
  }
  if (url.includes('cdn.espn.com')) return J({ content: { sbData: { events: [] } } });
  if (url.includes('api.the-odds-api.com')) return J([]);
  if (url.includes('statsapi.mlb.com')) return J({});          // no team rates, no weather -> neutral
  return realFetch(u, o);
};

const src = fs.readFileSync(BOARD + '/worker.js', 'utf8');
const CAL = Number((src.match(/const K_PROJ_CAL = ([\d.]+)/) || [])[1]);
const PARK = Number((src.match(/PIT: ([\d.]+)/) || [])[1]);
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const rows = await (await mod.default.fetch(new Request('https://x/api/board'), {}, { waitUntil() {} })).json();
const home = ((rows[0] || {}).pitchers || []).find((p) => p.team === 'PIT');

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
// Pinned to 0.93 rather than read from the source, so a missing constant cannot
// quietly turn the expectation back into the uncalibrated 6.0.
const projK = 6 * PARK * 0.93;
const want = Math.round(projK * 10) / 10;
const wantHi = Math.round((projK + 1.28 * Math.sqrt(Math.max(projK, 1) * 1.55)) * 10) / 10;
console.log(`  calibration ${CAL}, PIT park factor ${PARK}, home starter projects ${home && home.proj} (${home && home.lo}-${home && home.hi})\n`);
ok(CAL > 0.85 && CAL < 0.99, `a strikeout calibration below 1 is in force (${CAL})`);
ok(home && home.proj === want, `6.0 raw strikeouts project as ${want}, not 6.0 (${home && home.proj})`);
ok(home && home.hi === wantHi, `the 80% range is built around the calibrated number too (hi ${home && home.hi}, expected ${wantHi})`);
ok(src.includes("K_MODEL_VER = 'k-sharp-shin-cal93'"), 'strikeout picks log under a new model version');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
