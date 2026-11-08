// The soccer props card shows one day's matches (2026-11-08).
//
// The owner: "only add the teams that play the day of. Once the final game ends, we can start
// getting the teams for the next day, that way it's not so confusing." /api/soccer-props now
// sends the matches under way beside the ones to come (until ESPN calls them over), and the card
// lists the Pacific day of the earliest match not yet over, the next day's held until then.
//
// The worker runs in-process on an ESPN scoreboard shaped as tests/socbest.mjs's is (one match
// over, one under way, one to come today, one tomorrow), with the real soccer-priors.json, and
// the card's functions are lifted out of app.js, so the test runs what ships.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const RealDate = Date;
const NOW = RealDate.parse('2026-11-08T19:00:00Z'); // 11:00 AM PT, Sunday
let CLOCK = NOW;
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [CLOCK])); }
  static now() { return CLOCK; }
};
const iso = (ms) => new RealDate(ms).toISOString();

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
const PRIORS = fs.readFileSync(path.join(BOARD, 'soccer-priors.json'), 'utf8');
const env = { DB, ASSETS: { fetch: async (r) => (new URL(r.url).pathname === '/soccer-priors.json'
  ? new Response(PRIORS, { status: 200 }) : new Response('{}', { status: 404 })) } };
const ev = (id, kick, state, home, away) => ({ id, date: iso(kick), status: { type: { state, completed: state === 'post' } },
  competitions: [{ competitors: [{ id: home[0], homeAway: 'home', team: { abbreviation: home[1], displayName: home[2] } },
    { id: away[0], homeAway: 'away', team: { abbreviation: away[1], displayName: away[2] } }] }] });
const FUL = ['370', 'FUL', 'Fulham'], TOT = ['367', 'TOT', 'Tottenham Hotspur'], ARS = ['359', 'ARS', 'Arsenal'], CHE = ['363', 'CHE', 'Chelsea'];
const LIV = ['364', 'LIV', 'Liverpool'], MCI = ['382', 'MCI', 'Manchester City'], NEW = ['361', 'NEW', 'Newcastle United'], AVL = ['362', 'AVL', 'Aston Villa'];
const H = 3600e3;
const SB = 'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard?dates=';
const FEED = {
  [`${SB}20261108`]: { events: [
    ev('DONE1', NOW - 5 * H, 'post', ARS, CHE),          // 6:00 AM PT, over
    ev('LIVE1', NOW - 0.5 * H, 'in', LIV, MCI),          // 10:30 AM PT, under way
    ev('NEXT1', NOW + 2 * H, 'pre', FUL, TOT),           // 1:00 PM PT
  ] },
  [`${SB}20261109`]: { events: [ev('TMRW1', NOW + 25 * H, 'pre', NEW, AVL)] }, // Monday noon PT
};
globalThis.fetch = async (u) => {
  const url = String(u);
  if (FEED[url]) return new Response(JSON.stringify(FEED[url]), { status: 200 });
  if (url.includes('/scoreboard?dates=')) return new Response(JSON.stringify({ events: [] }), { status: 200 });
  return new Response('{}', { status: 404 });
};
const wsrc = fs.readFileSync(BOARD + '/worker.js', 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(wsrc).toString('base64'));
const board = await (await mod.default.fetch(new Request('https://x/api/soccer-props'), env, { waitUntil: () => {} })).json();

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
const text = (h) => h.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

console.log('-- the worker: the matches to come, and the one under way beside them --');
const ids = (xs) => (xs || []).map((x) => x.id).join(',');
ok(ids(board.matches) === 'NEXT1,TMRW1', `to come: today's and tomorrow's (${ids(board.matches)})`);
ok(ids(board.underway) === 'LIVE1', `under way: the one ESPN hasn't called over, not the one it has (${ids(board.underway)})`);
const u = (board.underway || [])[0] || {};
ok(u.league === 'epl' && u.commence === iso(NOW - 0.5 * H) && u.home === 'Liverpool' && u.away === 'Manchester City', 'with its league, kickoff and clubs');

// ---- the card's functions, out of app.js ------------------------------------------------
const app = fs.readFileSync(BOARD + '/app.js', 'utf8').replace(/\r\n/g, '\n');
function lift(name) {
  let at = app.indexOf(`function ${name}(`);
  const isConst = at < 0;
  if (isConst) at = app.indexOf(`const ${name} =`);
  if (at < 0) throw new Error(`app.js has no ${name}`);
  let depth = 0;
  for (let i = at; i < app.length; i++) {
    const c = app[i];
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') { depth--; if (!isConst && c === '}' && depth === 0) return app.slice(at, i + 1); }
    else if (isConst && c === ';' && depth === 0 && app[i + 1] === '\n') return app.slice(at, i + 1);
  }
  throw new Error(`could not close ${name}`);
}
const NAMES = ['SOC_STAT', 'nbCdf', 'socChanceAt', 'socKey', 'socLineOf', 'socLean', 'socStatWords', 'SOC_POS', 'socPosWords', 'ptDayOf', 'pct1', 'pct0',
  'miniBar', 'projLineHtml', 'LEG_OFFERS', 'offerLeg', 'socpLeg', 'socSaveHtml', 'socRecB', 'socPropRow', 'SOC_BEST_N', 'socRankP', 'socSideLineHtml', 'spBarHtml',
  'PROP_GAME_HOURS', 'propDay', 'propDayName', 'propDayTitle', 'propDayWait', 'socPropsCardHtml'];
const state = { socProps: board, socLines: {}, socSaved: {}, socSaving: {}, socOpen: {}, slip: {}, soccerLeague: 'all', socStat: 'best', socQuery: '' };
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const soccerKick = (t) => new RealDate(t).toISOString().slice(11, 16);
let F;
try {
  F = new Function('state', 'esc', 'soccerKick', NAMES.map(lift).join('\n') + '\nreturn { socPropsCardHtml };')(state, esc, soccerKick);
} catch (e) { console.log(`  FAIL  the card's functions lift out of app.js (${e.message})`); process.exit(1); }

console.log('\n-- the card: today\'s until the last of today\'s is over --');
let h = text(F.socPropsCardHtml());
ok(/Lineups not posted yet: Tottenham Hotspur @ Fulham/.test(h) || /Lineups not posted yet: TOT @ FUL/.test(h), 'today\'s match to come is listed');
ok(!/Aston Villa|AVL|Newcastle|NEW @/.test(h), 'tomorrow\'s is not');

// Fulham v Tottenham under way too: the day's all started, tomorrow's held till Liverpool's is over.
CLOCK = NOW + 2.5 * H;
state.socProps = { ...board, matches: board.matches.filter((m) => m.id === 'TMRW1'),
  underway: [...board.underway, { id: 'NEXT1', league: 'epl', commence: iso(NOW + 2 * H), home: 'Fulham', away: 'Tottenham Hotspur' }] };
h = text(F.socPropsCardHtml());
ok(h.includes('All of today’s matches are under way. Tomorrow’s match shows here once the last one is over, by about 4:00 PM.') && !/Aston Villa|AVL/.test(h),
  `all of today's under way: tomorrow's waits, and when it comes ("${(/All of[^.]+\.[^.]+\./.exec(h) || [''])[0]}")`);
// ESPN calls both over: they leave the list, and tomorrow's shows.
state.socProps = { ...state.socProps, underway: [] };
h = text(F.socPropsCardHtml());
ok(/Lineups not posted yet: (Aston Villa @ Newcastle|AVL @ NEW)/.test(h), 'both called over: tomorrow\'s shows');
// A league picked with nothing today says so, rather than jumping to its next day.
CLOCK = NOW;
state.socProps = { ...board, matches: [...board.matches, { ...board.matches[1], id: 'TMRW2', league: 'laliga', label: 'La Liga' }] };
state.soccerLeague = 'laliga';
state.socProps.leagues = { ...(board.leagues || {}), laliga: 'La Liga' };
h = text(F.socPropsCardHtml());
ok(h.includes('No La Liga match today.'), `a league with none today: "${(/No [^.]+\./.exec(h) || [''])[0]}"`);

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
