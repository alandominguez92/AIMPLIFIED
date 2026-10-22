// The soccer props card by lean, and the best of each stat on Picks (2026-10-21).
//
// The card listed each match's starters in lineup order, under abbreviations
// ("Tkl 2.4 · Clr 3.1 · CD-L"), and a player had to be opened to see a chance.
// It now opens each match on its strongest leans -- one row a starter, best
// first -- with chips to list one stat at a time, the way PrizePicks lays out
// its own board, in plain words. A tap opens the line setter.
//
// And the Picks tab shows the best soccer prop in each stat, in a strip of its
// own: not on the ranked list, which admits only kinds whose chance has held
// up, while these have not graded at PrizePicks' numbers yet.
//
// Real payloads: /api/soccer-props run in-process on the recorded Fulham v
// Tottenham lineup (tests/fixtures/espn-soc-740870.json) and the real
// soccer-priors.json, as tests/socpplines.mjs does; the default-line record
// by stat is production's on Oct 21 (fouls 7 of 15, tackles 15 of 17). The
// card's functions are lifted out of app.js, so the test runs what ships.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const RealDate = Date;
const NOW = RealDate.parse('2026-03-08T23:00:00Z');
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
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
const REC = JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', 'espn-soc-740870.json'), 'utf8'));
const SUMMARY = Object.entries(REC).find(([u]) => u.includes('/summary'))[1];
const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new RealDate(NOW)).replace(/-/g, '');
const KICK = NOW + 45 * 60e3;
const FEED = {
  [`https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard?dates=${day}`]: { events: [{ id: 'NEXT1', date: iso(KICK),
    status: { type: { state: 'pre', completed: false } },
    competitions: [{ competitors: [{ id: '370', homeAway: 'home', team: { abbreviation: 'FUL', displayName: 'Fulham' } },
      { id: '367', homeAway: 'away', team: { abbreviation: 'TOT', displayName: 'Tottenham Hotspur' } }] }] }] },
  'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/summary?event=NEXT1': SUMMARY,
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
const m1 = (board.matches || []).find((m) => m.id === 'NEXT1') || { rows: [] };
// Production's default-line record by stat, Oct 21.
board.record = { graded: 88, hit: 62, hitRate: 70.5, byMarket: { fouls: { n: 15, hit: 7, hitRate: 46.7 }, tackles: { n: 17, hit: 15, hitRate: 88.2 },
  passes: { n: 21, hit: 17, hitRate: 81 }, saves: { n: 2, hit: 1, hitRate: 50 } } };

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
  'LEG_OFFERS', 'offerLeg', 'socpLeg', 'socSaveHtml', 'socRecB', 'socPropRow', 'SOC_BEST_N', 'socRankP', 'socPropsCardHtml',
  'socWeakStat', 'socBestByStat', 'socBestStripHtml', 'initialsOf', 'headshotUrl', 'avatarHtml'];
const state = { socProps: board, socLines: {}, socSaved: {}, socSaving: {}, socOpen: {}, slip: {}, soccerLeague: 'all', socStat: 'best', socQuery: '' };
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const soccerKick = (t) => new RealDate(t).toISOString().slice(11, 16);
let F;
try {
  F = new Function('state', 'esc', 'soccerKick', NAMES.map(lift).join('\n')
    + '\nreturn { socPropsCardHtml, socBestByStat, socBestStripHtml, socLean, socKey, socPosWords };')(state, esc, soccerKick);
} catch (e) { console.log(`  FAIL  the card's functions lift out of app.js (${e.message})`); process.exit(1); }

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
const text = (h) => h.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
// The rows a card draws, in order: their keys and the chance shown.
const rowsOf = (h) => [...h.matchAll(/<li class="sp-row[^"]*" data-sprow="([^"]+)">[\s\S]*?<span class="tc-p([^"]*)">(\d+)%<\/span>/g)]
  .map((x) => ({ key: x[1], strong: /sp-strong/.test(x[2]), pct: Number(x[3]), r: m1.rows.find((r) => F.socKey(m1, r) === x[1]) }));
const starters = new Set(m1.rows.map((r) => r.id));
const leanOf = (r) => F.socLean(r, r.line);
console.log(`-- NEXT1 ${m1.lineup}, ${m1.rows.length} rows, ${starters.size} starters --`);

console.log('\n-- Best: one lean a starter, best first --');
let h = F.socPropsCardHtml();
let rows = rowsOf(h);
ok(/<button[^>]*class="sp-chip on"[^>]*data-stat="best"[^>]*>Best<\/button>/.test(h) && /data-stat="tackles"[^>]*>Tackles</.test(h) && /data-stat="saves"[^>]*>Goalie saves</.test(h),
  'the card opens on Best, with a chip for each stat in words');
ok(rows.length === 8 && new Set(rows.map((x) => x.r.id)).size === 8, `the top eight starters, one row each (${rows.length})`);
ok(rows.every((x, i) => !i || leanOf(rows[i - 1].r).p >= leanOf(x.r).p), 'best first, by the chance at the line shown');
const bestOf = (id) => Math.max(...m1.rows.filter((r) => r.id === id).map((r) => leanOf(r).p));
ok(rows.every((x) => leanOf(x.r).p === bestOf(x.r.id)), 'and each row is that starter\'s strongest stat');
const ranked = [...starters].map(bestOf).sort((a, b) => b - a);
ok(rows.every((x, i) => leanOf(x.r).p === ranked[i]), 'the eight shown are the eight strongest of the match');
ok(rows.every((x) => x.strong === (leanOf(x.r).p >= 60)) && rows.some((x) => x.strong), 'teal is 60% or more, and only that');
ok(/data-action="socp-all"[^>]*>All 22 starters</.test(h), 'with a tap to see all 22');
state.socAll = { NEXT1: true };
ok(rowsOf(F.socPropsCardHtml()).length === starters.size, 'which lists every starter');
state.socAll = {};

console.log('\n-- plain words --');
const t = text(h);
const codes = [...new Set(m1.rows.map((r) => r.pos).filter((p) => p && p !== 'G'))];
ok(codes.length > 5 && !codes.some((c) => new RegExp(`(^|[ ·])${c}( |$)`).test(t)), `no ESPN position code on the card (${codes.join(', ')})`);
ok(!/\b(Tkl|SOT|ShAst|Clr|Crs|Pass \d|G\+A|GA \d)\b/.test(t), 'no stat abbreviation');
ok(codes.every((c) => F.socPosWords(c)) && F.socPosWords('CD-L') === 'centre back' && F.socPosWords('G') === 'goalkeeper', 'every position on the lineup has words');
const first = rows[0].r;
ok(new RegExp(`${leanOf(first).side} ${first.line} ${String(board.matches[0].rows.find((r) => r === first).stat === 'sot' ? 'shots on target' : '')}`).test(t)
  && /(Under|Over) \d+(\.5)? [a-z +]+ · proj [\d.]+ · [a-z -]+/.test(t), `a row reads "${(t.match(/(Under|Over) \d+(\.5)? [a-z +]+ · proj [\d.]+ · [a-z -]+/) || [''])[0].trim()}"`);

console.log('\n-- the line setter, on a tap --');
ok(!/class="sp-in"/.test(h), 'no stepper until a row is tapped');
const k0 = rows[0].key;
state.socOpen = { [k0]: true };
h = F.socPropsCardHtml();
const open = [...h.matchAll(/data-socp="([^"]+)"/g)].map((x) => x[1]);
ok(open.length === 1 && open[0] === k0 && new RegExp(`value="${rows[0].r.line}" data-socp="${k0.replace(/[.:]/g, '\\$&')}"`).test(h)
  && /data-action="socp-save"/.test(h), 'the tapped row opens its stepper at its line, with Save line');
// Stepping the line moves neither the row nor the order under the finger.
const before = rowsOf(h).map((x) => x.key).join();
state.socLines = { [k0]: rows[0].r.line + 4 };
h = F.socPropsCardHtml();
const after = rowsOf(h);
ok(after.map((x) => x.key).join() === before, 'a line stepped far keeps the row and the order (ranked at the default line)');
ok(after[0].pct === Math.round(F.socLean(rows[0].r, rows[0].r.line + 4).p), `and the row shows the chance at the new line (${after[0].pct}%)`);
// A starter's other stat, opened from a search, keeps its place in Best.
const other = m1.rows.find((r) => r.id === rows[1].r.id && r.stat !== rows[1].r.stat);
state.socLines = {}; state.socOpen = { [F.socKey(m1, other)]: true }; state.socAll = { NEXT1: true };
const held = rowsOf(F.socPropsCardHtml()).find((x) => x.r.id === other.id);
ok(held && held.key === F.socKey(m1, other), 'an open row is the one Best shows for that starter');
state.socOpen = {}; state.socAll = {};

console.log('\n-- a stat at a time, and the search --');
state.socStat = 'tackles';
h = F.socPropsCardHtml();
rows = rowsOf(h);
const tk = m1.rows.filter((r) => r.stat === 'tackles');
ok(/class="sp-chip on"[^>]*data-stat="tackles"/.test(h) && rows.length === tk.length && rows.every((x) => x.r.stat === 'tackles'),
  `Tackles lists every starter with a tackles projection (${rows.length} of ${tk.length})`);
ok(rows.every((x, i) => !i || leanOf(rows[i - 1].r).p >= leanOf(x.r).p), 'best first');
state.socStat = 'best'; state.socQuery = 'Leno';
rows = rowsOf(F.socPropsCardHtml());
const leno = m1.rows.filter((r) => r.player === 'Bernd Leno');
ok(rows.length === leno.length && rows.every((x) => x.r.player === 'Bernd Leno'), `a search shows every stat of the player found (${rows.length})`);
state.socQuery = ''; state.socStat = 'not-a-stat';
ok(/class="sp-chip on"[^>]*data-stat="best"/.test(F.socPropsCardHtml()), 'a stat no match has falls back to Best');
state.socStat = 'best';

console.log('\n-- Picks: the best of each stat --');
const list = F.socBestByStat(board, NOW);
const stats = [...new Set(m1.rows.map((r) => r.stat))];
ok(list.length === stats.length - 1 && new Set(list.map((x) => x.r.stat)).size === list.length && !list.some((x) => x.r.stat === 'fouls'),
  `one per stat, fouls left off at 7 of 15 (${list.map((x) => x.r.stat).join(', ')})`);
ok(new Set(list.map((x) => x.r.id)).size === list.length, `and one per player (${list.map((x) => x.r.player).join(', ')})`);
// Each the strongest lean in its stat, unless that player is already above
// for a stronger one.
ok(list.every(({ r, l }, i) => m1.rows.filter((x) => x.stat === r.stat && leanOf(x).p > l.p).every((x) => list.slice(0, i).some((y) => y.r.id === x.id))),
  'each the strongest in its stat among players not already on the strip');
ok(list.every((x, i) => !i || list[i - 1].l.p >= x.l.p), 'best first');
let s = F.socBestStripHtml();
ok((s.match(/data-action="socp-go"/g) || []).length === list.length && !/data-action="leg-add"/.test(s),
  'each taps through to the Soccer tab, and none stars from here (a star saves the line as PrizePicks\')');
ok(/At the app’s line, not PrizePicks’/.test(s) && /Not on the list above until these grade at PrizePicks’ lines/.test(s),
  'it says the line is the app\'s and why it is off the ranked list');
ok(/Fouls left off: the lean has landed 7 of 15\./.test(s) && (!list.some((x) => x.r.stat === 'tackles') || /Tackles at the default line: 15 of 17 landed/.test(s)),
  'with each stat\'s record at the default line, and why fouls are left off');
// At the line shown: PrizePicks' number set for the best tackles row moves it.
const bt = list.find((x) => x.r.stat === 'tackles');
if (bt) {
  const kt = F.socKey(bt.m, bt.r);
  state.socLines = { [kt]: bt.l.side === 'Under' ? Math.floor(bt.r.proj) - 0.5 : Math.ceil(bt.r.proj) + 0.5 };
  const moved = F.socBestByStat(board, NOW).find((x) => x.r.stat === 'tackles');
  ok(moved && (moved.r !== bt.r || moved.l.p < bt.l.p), `a line set to PrizePicks' counts: ${bt.r.player} at ${state.socLines[kt]} (${Math.round(F.socLean(bt.r, state.socLines[kt]).p)}%), tackles now ${moved.r.player} ${Math.round(moved.l.p)}%`);
  state.socLines = {};
}
// A line saved as PrizePicks' (the default one happens to match) says so.
const k1 = F.socKey(list[0].m, list[0].r);
state.socSaved = { [k1]: list[0].l.line };
s = F.socBestStripHtml();
ok((s.match(/at your PrizePicks line/g) || []).length === 1 && new RegExp(`data-key="${k1}"[\\s\\S]*?at your PrizePicks line`).test(s),
  'a line saved as PrizePicks\' says so on its row');
state.socSaved = {};
const waiting = { ...board, matches: board.matches.map((m) => ({ ...m, lineup: 'waiting', rows: [] })) };
state.socProps = waiting;
ok(/Lineups not posted yet \(about an hour before kickoff\)\. Next: TOT @ FUL/.test(F.socBestStripHtml()), 'before lineups post it names the next match');
state.socProps = { ...board, matches: [] };
ok(F.socBestStripHtml() === '', 'and with no match it is not drawn');
state.socProps = board;

console.log('\n-- wired in --');
const body = lift('renderPicks');
// (Since 2026-10-22 "How the list did" follows it in the same tail:
// tests/pickhistory.mjs.)
ok(/const after = socBestStripHtml\(\) \+ /.test(body) && (body.match(/\+ after;/g) || []).length === 3
  && /Picks unavailable \(\$\{esc\(d\.error\)\}\)\.<\/div>` \+ after;/.test(body),
  'Picks draws the strip after the list, an empty list and an error alike');
const rp = lift('refreshPicks');
ok(/state\.sport === 'picks' && \(!state\.socProps \|\| Date\.now\(\) - \(state\.socPropsAt \|\| 0\) > 120e3\)/.test(rp) && /fetchJson\('\/api\/soccer-props'\)/.test(rp),
  'and reads the props feed only on the Picks tab, at most every two minutes');
ok(/case 'socp-go': \{[\s\S]*?state\.socStat = stat;[\s\S]*?state\.socOpen = \{ \.\.\.\(state\.socOpen \|\| \{\}\), \[k\]: true \};[\s\S]*?setSport\('soccer'\);/.test(app),
  'a tap there opens the Soccer tab on that stat, with the row\'s line setter open');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
