// How the list did (2026-10-22): what the Picks list's legs would have paid.
//
// The list kept its record as "32 of 42 landed" and "top two both landed 5 of
// 8 days", which says how often, not what it paid. /api/picks now carries a
// history: one unit an entry at PrizePicks' standard payouts (the PP_POWER and
// PP_FLEX the Entries tab already pays from), the day's top two by chance as a
// 2-pick Power and its top three to six as a Flex, each entry type's units and
// return over every graded day, and each day's legs. An entry waits until all
// its legs grade; a void or tie in it is a refund, neither won nor lost. The
// top-two count is now the Power entry's, so the two never disagree.
//
// Real SQLite and the real worker; the rows are written into the worker's own
// daypicks table as logDayPicks and gradeDayPicks leave them (date, label, p,
// on_list, result). The card is lifted out of app.js and drawn from the
// worker's answer.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const RealDate = Date;
const NOW = RealDate.parse('2026-10-22T20:00:00Z');       // Thursday, 1 PM Pacific
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
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
globalThis.fetch = async () => new Response('{}', { status: 404 });
const src = fs.readFileSync(BOARD + '/worker.js', 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const hit = async (u) => (await mod.default.fetch(new Request('https://x' + u), { DB }, { waitUntil: () => {} })).json();

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

await hit('/api/picks');                                    // the tables
const ins = sq.prepare(`INSERT INTO daypicks (date, leg_id, kind, label, p, commence, rank, on_list, result) VALUES (?,?,?,?,?,?,?,?,?)`);
// A leg's game time: the evening before, unless given. (A leg whose game has
// not started is re-read each time the list is: it can still drop off.)
const day = (date, legs) => legs.forEach(([label, p, result, on = 1, at = `${date}T02:00:00Z`], i) => ins.run(date, `${date}:${i}`, 'nba_ml', label, p, at, on ? i + 1 : null, on, result));
day('2026-10-18', [['A ML', 81, 'hit'], ['B ML', 77, 'hit'], ['C ML', 74, 'miss'], ['D ML', 71, 'hit'], ['E ML', 69, 'hit'], ['F ML', 66, 'miss'],
  ['Off ML', 90, 'miss', 0]]);                              // dropped off before its game: not the list's
day('2026-10-19', [['G ML', 72, 'hit'], ['H ML', 79, 'miss'], ['I ML', 68, 'hit']]);   // ranked by chance, not by insert order
day('2026-10-20', [['J ML', 80, 'hit'], ['K ML', 70, 'void']]);
day('2026-10-21', [['L ML', 78, 'hit'], ['M ML', 75, 'hit'], ['N ML', 70, 'hit'], ['O ML', 67, 'hit']]);
// Today: one game graded, two started at noon and still to grade.
day('2026-10-22', [['P ML', 82, 'hit', 1, '2026-10-22T16:45:00Z'], ['Q ML', 76, null, 1, '2026-10-22T19:00:00Z'], ['R ML', 71, null, 1, '2026-10-22T19:00:00Z']]);

const d = await hit('/api/picks');
const h = d.record && d.record.history;
const e = (k) => (h && h.entries.find((x) => x.key === k)) || {};
console.log('-- each entry, over every graded day --');
for (const x of (h ? h.entries : [])) console.log(`  ${x.label}: ${x.days} days, won ${x.won}, refunds ${x.refunds}, ${x.units}u, ${x.roi}%`);
ok(!!h && h.since === '2026-10-18', '/api/picks carries the list\'s history, from its first day');
ok(e('p2').days === 3 && e('p2').won === 2 && e('p2').refunds === 1 && e('p2').units === 3 && e('p2').roi === 100,
  'Top 2 Power: paid 3x on the 18th and 21st, lost the 19th, refunded the 20th (a void), today not settled: +3u on 3, +100%');
ok(e('f3').days === 3 && e('f3').units === 1.75 && e('f3').won === 3, 'Top 3 Flex: 2 of 3 twice (1.25x) and 3 of 3 once (2.25x): +1.75u');
ok(e('f4').days === 2 && e('f4').units === 4.5, 'Top 4 Flex: 3 of 4 (1.5x) and 4 of 4 (5x): +4.5u');
ok(e('f5').days === 1 && e('f5').units === 1 && e('f6').days === 1 && e('f6').units === -0.6 && e('f6').won === 0,
  'Top 5 Flex 4 of 5 pays 2x; Top 6 Flex 4 of 6 pays 0.4x, which loses 0.6 and is not counted as won');
ok(d.record.top2.days === e('p2').days && d.record.top2.bothHit === e('p2').won, 'the "top two both landed" count is the Power entry\'s');
ok(d.record.legs.n === 15 && d.record.legs.hit === 12, `the legs' record is unchanged: off-list and void legs left out (${d.record.legs.hit} of ${d.record.legs.n})`);

console.log('\n-- day by day --');
const dd = (date) => (h ? h.days.find((x) => x.date === date) : null) || {};
ok(h && h.days.map((x) => x.date).join() === '2026-10-22,2026-10-21,2026-10-20,2026-10-19,2026-10-18', 'latest first');
ok(dd('2026-10-19').legs.map((x) => x.label).join() === 'H ML,G ML,I ML' && dd('2026-10-19').entries.p2.net === -1,
  'each day ranked by chance: H at 79% heads the 19th, so its Power lost');
ok(dd('2026-10-18').legs.length === 6 && !dd('2026-10-18').legs.some((x) => x.label === 'Off ML'), 'a leg off the list at its start is not one of the day\'s');
ok(dd('2026-10-20').entries.p2.refund === true && dd('2026-10-20').entries.f3 === undefined, 'a void is a refund; a day of two legs has no Flex');
ok(dd('2026-10-22').pending === 2 && !dd('2026-10-22').entries.p2 && dd('2026-10-22').hit === 1, 'today: one in, two to play, no entry settled yet');

console.log('\n-- the card --');
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
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
let card;
try {
  card = new Function('esc', ['shortDay', 'pct0', 'HIST_DAY_KEYS', 'pickHistoryHtml'].map(lift).join('\n') + '\nreturn pickHistoryHtml;')(esc);
} catch (err) { console.log(`  FAIL  the card lifts out of app.js (${err.message})`); process.exit(1); }
const html = card(h);
const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
ok(/How the list did/.test(text) && /standard payouts/.test(text) && /Your own entries are on the Entries tab/.test(text),
  'titled, with what it assumes and where the user\'s own entries are');
ok(/Top 2 Power won 2 of 3 \+3\.00u \+100%/.test(text) && /Top 6 Flex won 0 of 1 −0\.60u −60%/.test(text),
  `each entry with its days, units and return (${(text.match(/Top 2 Power[^T]*/) || [''])[0].trim()})`);
ok(/class="pk-u pk-up">\+3\.00u/.test(html) && /class="pk-u pk-down">−0\.60u/.test(html), 'teal up, amber down');
ok((html.match(/<details class="pk-day">/g) || []).length === 5, 'a line a day, each opening to its legs');
ok(/Top 2 Power refund/.test(text) && /Top 2 Power −1\.00u/.test(text) && /Top 3 Flex \+1\.25u/.test(text), 'each day says what its Power and Flex paid');
ok(/1 of 1 landed · 2 still to play/.test(text) && /pk-lr pk-open/.test(html) && /pk-lr pk-void">void/.test(html), 'legs still to play and voids are marked as such');
ok(card(null) === '' && card({ days: [] }) === '', 'nothing is drawn before a day has graded');
ok(/const after = socBestStripHtml\(\) \+ pickHistoryHtml\(d\.record && d\.record\.history\);/.test(app), 'and the Picks tab draws it after the list, in every state');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
