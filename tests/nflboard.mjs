// The NFL tab in the NBA and NHL tabs' shape (2026-10-25).
//
// The NFL tab was built in August as a research board: a "Context · not
// plays" banner and "0 postable" over yardage projections, with the
// moneylines one button away. Since then NFL moneylines at 65%+ went onto
// Picks of the day with a record of their own. Now the tab opens the way the
// NBA and NHL tabs do, and the projections fold underneath. What has to hold:
//   - /api/nfl-board carries the log's record, 65%+ favourites first, and each
//     club's mark (WAS and LA by ESPN's codes, wsh and lar)
//   - the table lists only games still to kick off: the feed's prices for a
//     game under way are in-game ones (Panthers +3000, "56.7% value", Oct 25)
//   - Live Now scores Picks of the day's NFL moneylines in progress
//
// Real data: production's /api/nfl-board and its NFL moneyline log as
// /api/gmpicks-export served them at 3:18 PM Pacific on Oct 25, Week 7, with
// the late games under way (tests/fixtures/nfl-board-20261025.json), and
// ESPN's NFL scoreboard at 3:09 PM (espn-nfl-live-20261025.json). Real SQLite
// and the real worker.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const read = (f) => JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', f), 'utf8'));
const REC = read('nfl-board-20261025.json'), LIVE = read('espn-nfl-live-20261025.json');
const RealDate = Date;
let NOW = RealDate.parse(REC.at);
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
};
const asked = [];
globalThis.fetch = async (u) => {
  const url = String(u);
  asked.push(url);
  const J = (x) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url === 'https://cdn.espn.com/core/nfl/scoreboard?xhr=1') return J(LIVE.scoreboard);
  if (url.includes('statsapi.mlb.com')) return J({ dates: [] });
  return new Response('{}', { status: 404 });
};
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
const env = { DB };
const src = fs.readFileSync(BOARD + '/worker.js', 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const get = async (u) => (await mod.default.fetch(new Request('https://x' + u), env, { waitUntil: () => {} })).json();

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

// ---- the log, as production had it -----------------------------------------------------------
await get('/api/gmpicks-export'); await get('/api/picks');      // the tables
const cols = Object.keys(REC.gmpicks[0]);
const ins = sq.prepare(`INSERT INTO gmpicks (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
for (const r of REC.gmpicks) ins.run(...cols.map((k) => r[k]));
const graded = REC.gmpicks.filter((r) => r.result === 'win' || r.result === 'loss');
const hi = graded.filter((r) => r.win_prob >= 65);
const hiWon = hi.filter((r) => r.result === 'win').length;

// Two of the board's games as the feed quotes them, written the way the
// capture keeps nfl_lines rows: tonight's Chiefs at Seahawks, and the Rams,
// whose code is LA here and LAR at ESPN.
await get('/api/nfl-board');                                    // its tables
const g = (away, home) => REC.board.games.find((x) => x.away === away && x.home === home);
const KC = g('KC', 'SEA'), LA = g('LA', 'LV');
const line = sq.prepare(`INSERT INTO nfl_lines (event_id, commence, home, away, market, player, point, book, over, under, captured_at, season_type, week)
  VALUES (?, ?, ?, ?, 'h2h', ?, NULL, ?, ?, NULL, ?, 'REG', 7)`);
for (const x of [KC, LA]) {
  for (const book of ['pinnacle', 'lowvig', 'betonlineag', 'draftkings', 'fanduel']) {
    line.run(x.id, x.commence, x.homeFull, x.awayFull, x.awayFull, book, x.away_price, '2026-10-25T20:00:36Z');
    line.run(x.id, x.commence, x.homeFull, x.awayFull, x.homeFull, book, x.home_price, '2026-10-25T20:00:36Z');
  }
}

console.log('-- /api/nfl-board --');
const b = await get('/api/nfl-board?cb=1');
const r = b.record || {};
console.log('  record ' + JSON.stringify(r).slice(0, 200));
ok(r.n === graded.length && r.record === `${graded.filter((x) => x.result === 'win').length}–${graded.filter((x) => x.result === 'loss').length}`,
  `the log's record: ${r.record} over ${r.n} graded games`);
const b65 = (r.byBand || {})['65+'] || {};
ok(b65.n === hi.length && b65.n === 22 && String(b65.record).startsWith(`${hiWon}–`) && hiWon === 15,
  `its 65%+ favourites, the bar Picks lists them at: ${b65.record} (${b65.n}), as Picks of the day's NFL record has them`);
const bk = (b.games || []).find((x) => x.id === KC.id), bl = (b.games || []).find((x) => x.id === LA.id);
ok(bk && bk.homeLogo === 'nfl/500/sea.png' && bk.awayLogo === 'nfl/500/kc.png' && bl && bl.awayLogo === 'nfl/500/lar.png',
  `each club's mark, the Rams' by ESPN's code (${bk && bk.awayLogo}, ${bk && bk.homeLogo}, ${bl && bl.awayLogo})`);

// ---- Live Now -----------------------------------------------------------------------------------
console.log('\n-- Live Now: the Broncos, on Picks, in the 3rd --');
NOW = RealDate.parse(LIVE.at);
const den = REC.gmpicks.find((x) => x.date === '2026-10-25' && x.pick === 'DEN');
sq.prepare(`INSERT INTO daypicks (date, leg_id, kind, src_date, game_id, market, team, label, p, commence, rank, on_list, seen_at)
  VALUES ('2026-10-25', ?, 'nfl_ml', '2026-10-25', ?, 'h2h', 'DEN', 'DEN ML', 67.3, ?, 8, 1, '2026-10-25T19:55:00Z')`).run(`nfl:ml:${den.game_id}:DEN`, den.game_id, den.commence);
const cards = await get('/api/live-now');
const c = cards.find((x) => x.name === 'DEN ML');
console.log('  ' + (c ? `${c.name} ${c.stat} ${c.vs} [${c.matchup} · ${c.inning}] ${c.state}` : 'no card'));
ok(c && c.sport === 'nfl' && c.kind === 'ml' && c.onPicks && c.stat === '20–6' && c.vs === 'up 14' && c.matchup === 'DEN 20 – ARI 6' && c.inning === 'Q3 10:26',
  'the score and the clock from ESPN: Broncos 20-6, Q3 10:26, up 14');
ok(c && c.state === 'live', `ahead with most of the 3rd and the 4th to play: live, not yet cashing (${c && c.state})`);
ok(!asked.some((u) => u.includes('the-odds-api.com')), 'no odds read for it');

// ---- the page -------------------------------------------------------------------------------------
console.log('\n-- the tab --');
const app = fs.readFileSync(BOARD + '/app.js', 'utf8').replace(/\r\n/g, '\n');
const html = fs.readFileSync(BOARD + '/index.html', 'utf8').replace(/\r\n/g, '\n');
const lift = (name) => {
  const at = app.indexOf(`function ${name}(`);
  let depth = 0;
  for (let i = app.indexOf('{', at); i < app.length; i++) { if (app[i] === '{') depth++; else if (app[i] === '}' && --depth === 0) return app.slice(at, i + 1); }
  throw new Error('could not lift ' + name);
};
NOW = RealDate.parse(REC.at);
const els = {};
const fakeEl = () => ({ textContent: '', innerHTML: '' });
const document = { getElementById: (id) => (els[id] = els[id] || fakeEl()) };
const el = { nflBoardTitle: fakeEl(), nflCount: fakeEl() };
let tabled = null;
const esc = (s) => String(s == null ? '' : s);
const draw = new Function('document', 'el', 'esc', 'soccerKick', 'nflTable', lift('gmRecordHtml') + '\n' + lift('renderNflMoneyline') + '\nreturn renderNflMoneyline;')(
  document, el, esc, (iso) => iso, (games) => { tabled = games; return '<table>'; });
draw({ ...REC.board, record: b.record }, false);
ok(tabled && tabled.map((x) => `${x.away}@${x.home}`).join() === 'KC@SEA',
  `at 3:18 PM the table is tonight's game alone; the ten under way or over, Panthers +3000 among them, are left out (${tabled && tabled.length})`);
ok(el.nflCount.textContent === '1 game · week 7' && /prices as of/.test(els.nflNote.textContent), `"${el.nflCount.textContent}", "${els.nflNote.textContent}"`);
ok(/Record so far <b>[\d–]+<\/b> · favourites at 65%\+ <b>15 of 22<\/b>/.test(els.nflMlGrid.innerHTML), `the record line above it: ${els.nflMlGrid.innerHTML.replace(/<[^>]+>/g, '').split('.')[0]}`);
ok(/const NFL_ML_COLS = \['Game', 'Likelier winner', 'Best price', 'Value', 'Fair', 'Books', ''\];/.test(app)
  && /\$\{club\(g\.away, g\.awayLogo\)\}<span class="at-sep">@<\/span>\$\{club\(g\.home, g\.homeLogo\)\}/.test(lift('nflRow')),
  "the NBA and NHL tabs' heads, and each club's mark beside its name");
const sec = html.slice(html.indexOf('<section id="nflBoard"'), html.indexOf('</section>', html.indexOf('<section id="nflBoard"')));
ok(sec.indexOf('id="nflMlGrid"') < sec.indexOf('<details class="nfl-proj"') && /<details class="nfl-proj"[\s\S]*data-nflview="receiving"[\s\S]*id="nflGrid"[\s\S]*<\/details>/.test(sec)
  && !/data-nflview="lines"/.test(sec) && !/0 postable|nflPostable/.test(sec),
  'the moneylines first, the yardage projections folded under them, no "0 postable" and no lines button');
ok(/nfl: '#nflBoard'/.test(app) && /nfl: 'NFL'/.test(app), 'and Live Now sits on the NFL tab too');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
