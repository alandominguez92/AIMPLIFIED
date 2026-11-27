// The sport tabs (2026-11-27): the PrizePicks doc's option D, on the owner's go-ahead. A tab greys
// on a day its sport has no games and wears a red dot while one is under way. What has to hold:
//   - /api/tabs counts each sport's games on the Pacific day and those under way, from the free
//     scoreboards: ESPN's cdn (NBA, NFL, the soccer leagues read that day, each on its own date
//     and the next), the NHL's own, MLB's StatsAPI, and the UFC card as ufcCard keeps it
//   - a feed that fails leaves its sport out rather than reading as "no games": a grey tab must
//     mean there are none
//   - the page greys the tabs with none, dots the ones live, titles both, and leaves alone a sport
//     the answer left out, Picks and Entries
//
// Real data: every scoreboard the route reads, as each answered at 1:42 PM Pacific on Friday
// Nov 27 (tests/fixtures/tabs-20261127.json, cut to the fields the route reads): the NBA's 11
// games from 4 PM, none started; the NFL's Broncos at Steelers under way; the NHL's 15, 7 under
// way and 4 over; six soccer matches, three under way; MLB out of season. The UFC card is ESPN's
// Dec 5 card as read the same morning (ufc-sb-20261127.json, ufc-fc-600062700.json).
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
const FIX = (f) => JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', f), 'utf8'));
const T = FIX('tabs-20261127.json'), SB = FIX('ufc-sb-20261127.json'), FC = FIX('ufc-fc-600062700.json');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const RealDate = Date;
let NOW = RealDate.parse(T.at);
globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } };
let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

let down = () => false;
const asked = [];
globalThis.fetch = async (u) => {
  const url = String(u);
  asked.push(url);
  const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
  if (down(url)) return new Response('{}', { status: 503 });
  if (T.bodies[url]) return json(T.bodies[url]);
  if (url.startsWith('https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard')) return json(url.includes('dates=') ? { events: [] } : SB);
  if (url.startsWith('https://site.api.espn.com/apis/common/v3/sports/mma/ufc/fightcenter/600062700')) return json(FC);
  return new Response('{}', { status: 404 });
};
const sq = new DatabaseSync(':memory:');
const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
const exec = (sql, args, mode) => { const st = sq.prepare(sql); const a = args.map(norm);
  if (mode === 'all') return { results: st.all(...a), meta: {} }; if (mode === 'first') return st.get(...a) || null;
  return { success: true, meta: { changes: Number(st.run(...a).changes) } }; };
const DB = { prepare: (sql) => { const s = { sql, args: [], bind: (...x) => { s.args = x; return s; },
  all: async () => exec(s.sql, s.args, 'all'), first: async (c) => { const r = exec(s.sql, s.args, 'first'); return c && r ? r[c] : r; },
  run: async () => exec(s.sql, s.args, 'run') }; return s; }, batch: async (sts) => sts.map((x) => exec(x.sql, x.args, 'run')) };
const env = { DB };
const wsrc = fs.readFileSync(BOARD + '/worker.js', 'utf8').replace(/\r\n/g, '\n');
const mod = await import('data:text/javascript;base64,' + Buffer.from(wsrc).toString('base64'));
const call = (u) => mod.default.fetch(new Request('https://x' + u), env, { waitUntil: () => {} });

console.log('-- Friday Nov 27, 1:42 PM Pacific --');
const r = await call('/api/tabs');
const t = await r.json();
console.log('  ' + Object.entries(t.sports).map(([k, v]) => `${k} ${v.today} today, ${v.live} live`).join(' · '));
const s = t.sports;
ok(r.status === 200 && t.day === '2026-11-27' && /max-age=60/.test(r.headers.get('cache-control') || ''), 'answers for the Pacific day, cached a minute');
ok(s.nba && s.nba.today === 11 && s.nba.live === 0, "the NBA: 11 games from 4 PM, none started");
ok(s.nfl && s.nfl.today === 1 && s.nfl.live === 1, 'the NFL: the week has 16, one today, Broncos at Steelers, under way');
ok(s.nhl && s.nhl.today === 15 && s.nhl.live === 7, 'the NHL: 15 today, 7 under way (4 over, 4 to come)');
ok(s.soccer && s.soccer.today === 6 && s.soccer.live === 3,
  "soccer: six matches today across the leagues read (Chelsea's, Gladbach's and Bologna's under way; Levante's and two MLS still to come), none of Saturday's");
ok(s.mlb && s.mlb.today === 0 && s.mlb.live === 0, 'MLB: none, out of season');
ok(s.ufc && s.ufc.today === 0 && s.ufc.live === 0, "the UFC: none, its card is Dec 5");
const soc = asked.filter((u) => u.includes('soccer/scoreboard'));
ok(soc.length === 16 && soc.some((u) => u.includes('league=ger.1&date=20261128')) && !soc.some((u) => u.includes('uefa.europa')),
  "soccer reads each league read that day on its date and the next: the Bundesliga in, the Europa League out (16 reads)");
ok(!asked.some((u) => u.includes('the-odds-api.com')), 'no odds read: free');

console.log('\n-- feeds that fail --');
down = (u) => u.includes('nba/scoreboard?xhr=1&date=');
let x = (await (await call('/api/tabs')).json()).sports;
ok(!('nba' in x) && x.nhl && x.nhl.live === 7, "the NBA's dated scoreboard failing leaves the NBA out, not at none; the rest as they were");
down = (u) => u.includes('api-web.nhle.com') || u.includes('statsapi.mlb.com');
x = (await (await call('/api/tabs')).json()).sports;
ok(!('nhl' in x) && !('mlb' in x) && x.nba.today === 11, 'the NHL and MLB failing: both left out');
down = (u) => u.includes('soccer/scoreboard');
x = (await (await call('/api/tabs')).json()).sports;
ok(!('soccer' in x), 'every soccer league failing: soccer left out');
down = (u) => u.includes('league=eng.1');
x = (await (await call('/api/tabs')).json()).sports;
ok(x.soccer && x.soccer.today === 5 && x.soccer.live === 2, "the Premier League's two reads failing: the other five matches still count (5, 2 live)");
down = (u) => u.includes('soccer/scoreboard') && !u.includes('league=uefa.champions');
x = (await (await call('/api/tabs')).json()).sports;
ok(!('soccer' in x), 'only the Champions League answering, with nothing on: not known to be none, so left out');
down = () => false;

console.log('\n-- the page --');
const app = fs.readFileSync(BOARD + '/app.js', 'utf8').replace(/\r\n/g, '\n');
const css = fs.readFileSync(BOARD + '/style.css', 'utf8').replace(/\r\n/g, '\n');
const lift = (name) => {
  let at = app.indexOf(`function ${name}(`);
  const isConst = at < 0;
  if (isConst) at = app.indexOf(`const ${name} =`);
  if (at < 0) throw new Error(`app.js has no ${name}`);
  let d = 0;
  for (let i = at; i < app.length; i++) {
    const c = app[i];
    if (c === '{' || c === '(' || c === '[') d++;
    else if (c === '}' || c === ')' || c === ']') { d--; if (!isConst && c === '}' && d === 0) return app.slice(at, i + 1); }
    else if (isConst && c === ';' && d === 0 && app[i + 1] === '\n') return app.slice(at, i + 1);
  }
  throw new Error(`could not lift ${name}`);
};
let P;
try { P = new Function(['TAB_SPORT_NAME', 'applyTabs'].map(lift).join('\n') + '\nreturn { applyTabs };')(); }
catch (e) { console.log(`  FAIL  the tabs lift out of app.js (${e.message})`); console.log('\n1 FAILED'); process.exit(1); }
const tabOf = (sport, cls = []) => { const c = new Set(cls), at = {};
  return { dataset: { sport }, classList: { toggle: (k, on) => { if (on) c.add(k); else c.delete(k); }, contains: (k) => c.has(k) },
    setAttribute: (k, v) => { at[k] = v; }, removeAttribute: (k) => { delete at[k]; }, get title() { return at.title; }, cls: c }; };
const order = ['picks', 'mlb', 'nfl', 'nba', 'nhl', 'soccer', 'ufc', 'entries'];
let tabs = order.map((k) => tabOf(k, k === 'picks' ? ['active'] : []));
P.applyTabs(t, tabs);
const tab = (k) => tabs.find((x) => x.dataset.sport === k);
for (const k of order) console.log(`  ${k}: ${[...tab(k).cls].join(' ') || '-'}${tab(k).title ? ` (${tab(k).title})` : ''}`);
ok(['mlb', 'ufc'].every((k) => tab(k).cls.has('idle') && !tab(k).cls.has('live')) && tab('mlb').title === 'No MLB games today' && tab('ufc').title === 'No UFC fights today',
  'MLB and the UFC grey, and say why');
ok(['nfl', 'nhl', 'soccer'].every((k) => tab(k).cls.has('live') && !tab(k).cls.has('idle')) && tab('nhl').title === '7 NHL games live'
  && tab('nfl').title === '1 NFL game live' && tab('soccer').title === '3 soccer matches live', 'the NFL, the NHL and soccer wear the dot, with how many');
ok(!tab('nba').cls.has('idle') && !tab('nba').cls.has('live') && tab('nba').title === undefined, 'the NBA, 11 games still to come: neither, and no title');
ok(tab('picks').cls.size === 1 && tab('entries').cls.size === 0 && !tab('picks').title && !tab('entries').title, 'Picks and Entries untouched');
// A later answer with the NHL left out (its feed failed): its tab keeps what it had.
P.applyTabs({ sports: { ...t.sports, nhl: undefined, nfl: { today: 1, live: 0 } } }, tabs);
ok(tab('nhl').cls.has('live') && tab('nhl').title === '7 NHL games live' && !tab('nfl').cls.has('live') && !tab('nfl').title,
  "an answer without the NHL leaves its tab as it was; the NFL's game over, its dot and title go");
ok(/\.stab\.idle:not\(\.active\), \.stab\.idle:not\(\.active\) \.mini \{ color:var\(--textDisabled\); \}/.test(css) && /\.stab\.live > span:first-of-type::after \{[^}]*background:var\(--danger\)/.test(css),
  'the grey is the disabled text colour, the name and its desktop label, never on the open tab; the dot is the live red');
ok(/refreshTabs\(\);\n\s+setInterval\(refreshTabs, 60000\);/.test(app) && /if \(!LIVE_MODE \|\| document\.hidden\) return;/.test(lift('refreshTabs')),
  'read on load and each minute, only while the page is in view');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
