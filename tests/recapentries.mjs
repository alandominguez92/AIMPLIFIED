// "Last night" names each entry, with its own count and units (2026-11-13, the owner's "do all
// three").
//
// The box at the top of Picks read the PrizePicks entry's legs and units and said neither: on the
// morning after Nov 12 it read "Last night Nov 12 2 of 9" and two red −1.00u, while the moneyline
// entry won all six legs (+2.00u, +1.25u) and was nowhere in it. And Jayden Daniels' passing TDs,
// which left the list for six moneylines and stayed the entry's first leg, showed twice: a ✗ in the
// entry and "Off before the start, would have missed". What has to hold:
//   - its face names each entry, then its count and its dots: the PrizePicks entry, then the
//     moneyline entry where that day had one (two legs or more, from Nov 1)
//   - opened, each entry's legs and units sit under its name; the edge bets and the list after
//   - "Off before the start" leaves out a leg an entry kept, which is graded above with it
//   - today's box: an entry still waiting on a game says how many to go and shows no units
//   - a day before the PrizePicks entry says its legs were the list's
//
// Real data: production's /api/picks at 12:02 AM Pacific on Nov 13, the first read after Nov 12 was
// graded (tests/fixtures/picks-20261113.json), drawn by the page's own functions.
import fs from 'node:fs';
import path from 'node:path';
const BOARD = path.join(import.meta.dirname, '..');
const P = JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', 'picks-20261113.json'), 'utf8'));
const h = P.record.history;
const RealDate = Date;
let NOW = RealDate.parse(P.asOf);

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
const app = fs.readFileSync(BOARD + '/app.js', 'utf8').replace(/\r\n/g, '\n');
const css = fs.readFileSync(BOARD + '/style.css', 'utf8').replace(/\r\n/g, '\n');
function lift(name) {
  let at = app.search(new RegExp(`\\n  (async )?function ${name}\\(`));
  if (at >= 0) { at++; let d = 0; for (let i = app.indexOf(') {', at) + 2; i < app.length; i++) { if (app[i] === '{') d++; else if (app[i] === '}' && --d === 0) return app.slice(at, i + 1); } }
  throw new Error(`app.js has no ${name}`);
}
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const text = (x) => x.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const store = {};
const env = {
  esc, Date: class extends RealDate { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } },
  localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
  AM: (n) => (n == null ? '—' : (n > 0 ? '+' + n : String(n))), bkLabel: (k) => ({ draftkings: 'DK', fanduel: 'FD', betrivers: 'BR' }[k] || String(k).toUpperCase()),
  ptDayOf: (ms) => (ms ? new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new RealDate(ms)) : null),
  shortDay: (ymd) => new RealDate(ymd + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }),
};
const cap = (app.match(/\n  (const RECAP_ENTRY_MAX = \d+;)/) || [])[1] || '';
const build = () => new Function(...Object.keys(env), `let recapSeenAtLoad = null;\n${cap}\n${['shortLeg', 'recapHtml', 'recapDay'].map(lift).join('\n')}\nreturn { recapHtml, recapDay };`)(...Object.values(env));
const R = build();
// The face: what the folded box says.
const faceOf = (x) => text((x.match(/<summary>([^]*?)<\/summary>/) || [])[1] || '');
const dayOf = (date) => h.days.find((d) => d.date === date);

console.log('-- the morning after Nov 12 --');
const top = R.recapHtml(h, P.edgeRecord);
console.log('  ' + text(top));
ok(!/Today so far/.test(top), "Friday's legs not started: no box for today yet");
// Its pool had nine legs; an entry is the top six at most (see "past the top six" below).
ok(faceOf(top) === 'Last night Nov 12 PrizePicks entry 1 of 6 ✗✓✗✗✗✗ Moneyline entry 6 of 6 ✓✓✓✓✓✓',
  `its face names both entries, each with its count and its dots ("${faceOf(top)}")`);
ok(/<span class="rc-es"><span class="rc-g"><span class="rc-w">PrizePicks entry<\/span><b class="rc-n">1 of 6<\/b><span class="rc-x"><span class="rc-dots">✗✓✗✗✗✗<\/span><\/span><\/span><span class="rc-g"><span class="rc-w">Moneyline entry<\/span><b class="rc-n">6 of 6<\/b>/.test(top),
  'a row an entry: its name, its count, its dots');
const body = text(top.slice(top.indexOf('</summary>')));
ok(/^PrizePicks entry ✗ Daniels U1\.5 Pass TDs ✓ Jones O0\.5 PTS ✗ Makar O0\.5 AST ✗ Roslovic O0\.5 PTS ✗ Pastrnak O0\.5 AST ✗ Strome O0\.5 PTS Top 2 Power −1\.00u Top 3 Flex −1\.00u Past the top 6, in no entry: ✗ Hughes O0\.5 AST · ✗ Reed Jr U7 REB · ✓ Gobert U11 REB Moneyline entry ✓ Spain ✓ Pistons ✓ England ✓ Montenegro ✓ Hurricanes ✓ 76ers Top 2 Power \+2\.00u Top 3 Flex \+1\.25u Edge bets 1 of 4 · −1\.52u · beat the close 4 of 4 The list 6 of 6 /.test(body),
  "opened: the PrizePicks entry's six legs and units, the three past them, then the moneyline entry's, then the edge bets and the list");
ok(/<div class="rc-ent"><div class="rc-cw">Moneyline entry<\/div>[^]*?<li><span>Top 2 Power<\/span><b class="u">\+2\.00u<\/b><\/li><li><span>Top 3 Flex<\/span><b class="u">\+1\.25u<\/b><\/li><\/ul><\/div>/.test(top),
  "the moneyline entry's units in its own block, in the up colour");
ok(/Off before the start: Suns, would have landed · Bedard O0\.5 PTS, would have landed · Tkachuk O0\.5 AST, would have landed<\/div>/.test(top)
  && dayOf('2026-11-12').dropped.some((x) => x.label === 'Jayden Daniels Under 1.5 Pass TDs') && !/Daniels U1\.5 Pass TDs, would have/.test(top),
  "off before the start: the Suns and the two lines PrizePicks pulled, not Daniels, who left the list but stayed the entry's first leg");

console.log('\n-- Nov 11, the night before --');
const n11 = R.recapDay(h, P.edgeRecord, '2026-11-11', false);
ok(faceOf(n11) === 'Last night Nov 11 PrizePicks entry 4 of 6 ✓✗✗✓✓✓ Moneyline entry 2 of 3 ✓✓✗', `"${faceOf(n11)}"`);
ok(/Off before the start: Oilers, would have landed · Celtics, would have landed · LaCombe O0\.5 AST, would have missed · Karlsson O0\.5 AST, would have landed<\/div>/.test(n11)
  && /✓ Keller O0\.5 AST/.test(n11) && !/Keller O0\.5 AST, would have/.test(n11),
  'Keller, off the list and kept in the entry, is graded with it, not listed as off');

console.log('\n-- today, as its games finish --');
// Friday as it would read once Scotland's match is over, every other leg still to play.
const fri = { ...h, days: h.days.map((d) => (d.date !== '2026-11-13' ? d : { ...d, ml: d.ml.map((x) => (x.label === 'Scotland ML' ? { ...x, result: 'hit' } : x)) })) };
NOW = RealDate.parse('2026-11-13T20:00:00Z');
const today = build().recapDay(fri, P.edgeRecord, '2026-11-13', true);
console.log('  ' + text(today));
ok(faceOf(today) === 'Today so far Nov 13 PrizePicks entry 2 to go Moneyline entry 1 of 1 5 to go ✓', `the PrizePicks entry waits, the moneyline entry 1 of 1 ("${faceOf(today)}")`);
ok(!/Top 2 Power|Top 3 Flex/.test(today), 'no units for either while a game is still to come');
ok(build().recapDay(h, P.edgeRecord, '2026-11-13', true) === '', 'nothing decided yet: no box');

console.log('\n-- an entry is the top six (2026-11-13, the owner\'s "do both fixes") --');
// Production's /api/picks at 11:45 PM Pacific on Nov 13, every leg final
// (tests/fixtures/picks-20261113-2345.json). The moneyline pool had nine legs: the top six all won
// (+24u as a 6-Flex) and the box read "6 of 9", counting the three below them that no entry held.
const L = JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', 'picks-20261113-2345.json'), 'utf8'));
const lh = L.record.history, l13 = lh.days.find((d) => d.date === '2026-11-13');
NOW = RealDate.parse(L.asOf);
ok(l13.ml.length === 9 && l13.ml.slice(0, 6).every((x) => x.result === 'hit') && l13.mlEntries.f6.net === 24 && l13.pool.length === 5,
  'the real night: nine moneylines, the top six won, +24u as a 6-Flex; five PrizePicks legs');
const late = build().recapDay(lh, L.edgeRecord, '2026-11-13', true);
console.log('  ' + text(late));
ok(faceOf(late) === 'Today so far Nov 13 PrizePicks entry 4 of 5 ✓✓✓✗✓ Moneyline entry 6 of 6 ✓✓✓✓✓✓', `"6 of 6", the entry's own legs ("${faceOf(late)}")`);
ok(/<div class="rc-ent"><div class="rc-cw">Moneyline entry<\/div><div class="rc-chips">(<span class="rc-chip rc-hit">✓ [A-Za-z]+<\/span>){6}<\/div>/.test(late),
  'opened: its six legs as chips');
ok(/<li><span>Top 2 Power<\/span><b class="u">\+2\.00u<\/b><\/li><li><span>Top 3 Flex<\/span><b class="u">\+1\.25u<\/b><\/li><\/ul><div class="rc-past">Past the top 6, in no entry: ✗ Knicks · ✗ Hawks · ✗ Thunder<\/div><\/div>/.test(late),
  'its units, then the three below the six, apart: "Past the top 6, in no entry: ✗ Knicks · ✗ Hawks · ✗ Thunder"');
ok(!/rc-past/.test(late.slice(0, late.indexOf('Moneyline entry</div>'))), 'five PrizePicks legs: nothing past the six');
ok(/The list<\/span><b>6 of 9<\/b>/.test(late), 'the list keeps all nine: 6 of 9');
// The same night with the Thunder, eighth, still to play: the six are in, the units wait for it,
// since a leg still to start can move into the six.
const thunder = { ...lh, days: lh.days.map((d) => (d.date !== '2026-11-13' ? d : { ...d, ml: d.ml.map((x) => (x.label === 'Thunder ML' ? { ...x, result: null } : x)) })) };
const tw = build().recapDay(thunder, L.edgeRecord, '2026-11-13', true);
const twMl = tw.slice(tw.indexOf('Moneyline entry</div>'));
ok(/Moneyline entry 6 of 6 ✓✓✓✓✓✓$/.test(faceOf(tw)) && !/Top 2 Power/.test(twMl.split('rc-past')[0]) && /Past the top 6, in no entry: ✗ Knicks · ✗ Hawks · · Thunder/.test(twMl),
  'a leg past the six still to play: the face says 6 of 6, no units yet, the Thunder open below');
NOW = RealDate.parse(P.asOf);

console.log('\n-- older days --');
const o31 = R.recapDay(h, null, '2026-10-31', false);
ok(/^Last night Oct 31 PrizePicks entry \d+ of \d+ [✓✗]+$/.test(faceOf(o31)) && !/Moneyline entry/.test(o31), `before the moneyline entry: the PrizePicks entry alone ("${faceOf(o31)}")`);
const prePool = { ...h, days: [{ ...dayOf('2026-10-31'), pool: undefined }] };
ok(/^Last night Oct 31 The list \d+ of \d+ [✓✗]+$/.test(faceOf(R.recapDay(prePool, null, '2026-10-31', false))), 'a day before the PrizePicks entry: its legs were the list\'s');
const oneMl = { ...h, days: h.days.map((d) => (d.date !== '2026-11-12' ? d : { ...d, ml: d.ml.slice(0, 1) })) };
ok(!/Moneyline entry/.test(R.recapDay(oneMl, null, '2026-11-12', false)), 'one moneyline is no entry: no row for it');

console.log('\n-- the page --');
ok(/\.rc-past \{ margin-top:6px; font-size:12px; color:var\(--textFaint\); \}/.test(css), 'the legs past the six in small, faint type under the entry');
ok(/\.rc-es \{ flex-basis:100%; display:grid; grid-template-columns:auto auto minmax\(0, 1fr\);/.test(css) && /\.rc-g \{ display:contents; \}/.test(css) && /\.rc-x \{ display:flex; flex-wrap:wrap;/.test(css),
  'the rows on their own line under the day, names, counts and dots in columns');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
