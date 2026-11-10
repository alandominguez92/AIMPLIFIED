// MLB's feeds load on the MLB tab and nowhere else (2026-11-04).
//
// /api/board and /api/batters are the page's routes that buy odds on a read,
// about 45 credits for an uncached fifteen-game slate, and every page open paid
// for them whichever tab it landed on; a phone left on Picks went on paying every
// five minutes. The owner's call: MLB loads on the MLB tab. What has to hold:
//   - opening the site reads none of MLB's feeds, and no timer does on another tab
//   - the MLB tab reads all of them on the way in, its timers keep them fresh, and
//     coming back inside five minutes doesn't read them again
//   - Picks' MLB legs come from the logs those feeds write, so in season, until the
//     tab has been opened, Picks says so instead of quietly going without MLB
//   - the sports that don't need them still load as they did
//
// The timers are run as they are in app.js, against recording stubs. Real data:
// /api/picks on Nov 4, 2026 (tests/fixtures/picks-pool-teams-20261104.json).
import fs from 'node:fs';
import path from 'node:path';

const BOARD = path.join(import.meta.dirname, '..');
const app = fs.readFileSync(BOARD + '/app.js', 'utf8').replace(/\r\n/g, '\n');
const { ppPool, legs } = JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', 'picks-pool-teams-20261104.json'), 'utf8'));

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

const MLB = ['refreshBoard', 'refreshBatters', 'refreshTopLegs', 'refreshInjuries'];
// boardTick (2026-11-10): the NBA, NHL, soccer and NFL boards again once five minutes old (tests/boardrefresh.mjs).
const OTHER = ['refreshLiveData', 'refreshTrackRecord', 'refreshPicks', 'refreshFeedHealth', 'refreshLiveNow', 'boardTick'];

// ---- the timers, as app.js has them -------------------------------------------------------
const at = app.indexOf('  if (LIVE_MODE) {\n    // Live mode:');
const end = app.indexOf('  } else {\n    // Mock mode:', at);
if (at < 0 || end < 0) { console.log('  FAIL  the timers block is where this test expects it'); process.exit(1); }
const block = app.slice(at, end) + '  }';
const calls = [];
const timers = [];
const state = { sport: 'picks', boardView: 'batter' };
const stubs = Object.fromEntries([...MLB, ...OTHER].map((n) => [n, () => { calls.push(n); }]));
new Function('LIVE_MODE', 'state', 'el', 'isBatter', 'BATTER_POLL_MS', 'TOP_HOST', 'document', 'setInterval', ...Object.keys(stubs), block)(
  true, state, {}, () => state.boardView === 'batter', 300000, { mlb: 'slate', nba: 'nbaBoard' }, { hidden: false, addEventListener: () => {} },
  (f, ms) => { timers.push({ f, ms }); return timers.length; }, ...Object.values(stubs));
const mlbCalls = () => calls.filter((n) => MLB.includes(n));
const fireAll = (ms) => { for (const t of timers) if (!ms || t.ms === ms) t.f(); };

console.log('\n-- opening the site --');
ok(mlbCalls().length === 0, `none of MLB's feeds on load (${mlbCalls().join(', ') || 'none'})`);
ok(['refreshLiveData', 'refreshTrackRecord', 'refreshFeedHealth', 'refreshLiveNow'].every((n) => calls.includes(n)), 'the rest load as they did');

console.log('\n-- the timers, on another tab --');
for (const s of ['picks', 'nba', 'nhl', 'nfl', 'soccer', 'entries']) {
  state.sport = s;
  calls.length = 0;
  fireAll();
  ok(mlbCalls().length === 0, `on ${s}: none (${mlbCalls().join(', ') || 'none'})`);
}

console.log('\n-- the timers, on the MLB tab --');
state.sport = 'mlb';
calls.length = 0;
fireAll();
ok(MLB.every((n) => calls.includes(n)), `all of them: ${mlbCalls().join(', ')}`);
state.boardView = 'kprops';
calls.length = 0;
fireAll();
ok(calls.includes('refreshBoard') && !calls.includes('refreshBatters'), 'and the batters feed only on the batter board, as before');
state.boardView = 'batter';

// ---- going in -----------------------------------------------------------------------------
function lift(name) {
  let start = app.indexOf(`function ${name}(`);
  const isConst = start < 0;
  if (isConst) start = app.indexOf(`const ${name} =`);
  if (start < 0) throw new Error(`app.js has no ${name}`);
  let depth = 0;
  for (let i = start; i < app.length; i++) {
    const c = app[i];
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') { depth--; if (!isConst && c === '}' && depth === 0) return app.slice(start, i + 1); }
    else if (isConst && c === ';' && depth === 0 && app[i + 1] === '\n') return app.slice(start, i + 1);
  }
  throw new Error(`could not close ${name}`);
}
const RealDate = Date;
let NOW = RealDate.parse('2026-04-15T19:00:00Z');
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
};
const ui = { liveBoard: null, liveBatters: null };
let L;
try {
  L = new Function('state', 'LIVE_MODE', 'BATTER_POLL_MS', ...Object.keys(stubs), ['loadMlb', 'mlbInSeason', 'mlbUnreadHtml'].map(lift).join('\n')
    + '\nreturn { loadMlb, mlbInSeason, mlbUnreadHtml };')(ui, true, 300000, ...Object.values(stubs));
} catch (e) { console.log(`  FAIL  the MLB helpers lift out of app.js (${e.message})`); process.exit(1); }

console.log('\n-- going to the MLB tab --');
calls.length = 0;
L.loadMlb();
ok(MLB.every((n) => calls.includes(n)) && calls.length === MLB.length, `the first visit reads them: ${calls.join(', ')}`);
calls.length = 0;
NOW += 299000;
L.loadMlb();
ok(calls.length === 0, 'back inside five minutes: nothing, its timers keep them fresh');
calls.length = 0;
NOW += 2000;
L.loadMlb();
ok(calls.length === MLB.length, 'after five minutes: read again');
const setSportSrc = lift('setSport');
ok(/if \(s === 'mlb'\) loadMlb\(\);/.test(setSportSrc), 'setSport does it, so a link to #slate lands the same way');
const mock = {};
const M = new Function('state', 'LIVE_MODE', 'BATTER_POLL_MS', ...Object.keys(stubs), lift('loadMlb') + '\nreturn loadMlb;')(mock, false, 300000, ...Object.values(stubs));
calls.length = 0;
M();
ok(calls.length === 0, 'the demo mode has no feeds to read');

console.log('\n-- Picks says so, in season --');
const mlbLeg = { ...ppPool[0], kind: 'mlb_pp', sport: 'mlb' };
const noMlb = { legs, ppPool };
NOW = RealDate.parse('2026-04-15T19:00:00Z');
const note = L.mlbUnreadHtml(noMlb);
ok(/MLB legs are read when the MLB tab opens, or 15 minutes before each game/.test(note), `in April with none on the list: "${note.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}"`);
ok(/data-action="set-sport" data-sport="mlb"/.test(note), 'with a button to it');
ok(L.mlbUnreadHtml({ legs: [mlbLeg], ppPool: [] }) === '' && L.mlbUnreadHtml({ legs: [], ppPool: [mlbLeg] }) === '', 'an MLB leg on the list or in the pool: nothing to say');
ui.liveBatters = [];
ok(L.mlbUnreadHtml(noMlb) === '', 'the tab already opened, even on an empty slate: nothing to say');
ui.liveBatters = null;
ui.liveBoard = [];
ok(L.mlbUnreadHtml(noMlb) === '', 'the same for the board feed');
ui.liveBoard = null;
for (const [when, want] of [['2026-11-04T19:00:00Z', false], ['2026-12-15T19:00:00Z', false], ['2027-02-15T19:00:00Z', false], ['2027-03-15T19:00:00Z', true], ['2026-10-15T19:00:00Z', true]]) {
  NOW = RealDate.parse(when);
  ok(L.mlbInSeason() === want && (L.mlbUnreadHtml(noMlb) !== '') === want, `${when.slice(0, 10)}: ${want ? 'in season' : 'off season, no line'}`);
}
ok((app.match(/recapHtml\(d\.record && d\.record\.history, d\.edgeRecord\) \+ mlbUnreadHtml\(d\)/g) || []).length === 2, 'drawn in both of the list\'s states, with legs and with none');
const css = fs.readFileSync(BOARD + '/style.css', 'utf8').replace(/\r\n/g, '\n');
ok(/\.pk-mlb-note \{/.test(css), 'and styled');

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
