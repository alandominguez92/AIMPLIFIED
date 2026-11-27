// "What's on Picks, and why" on the Track Record page (2026-11-27): the PrizePicks doc's panel, on
// the owner's go-ahead, with the rules as they stand (the owner: "stick to what we have"). What has
// to hold:
//   - /api/pick-rules lists every kind of leg Picks of the day has carried, each with its record at
//     its bar (the cached copy /api/picks reads), its place on the list today (on, held off by
//     hand, or off) and every change to its rule, dated as the rules date them
//   - on first, then held, then off; within each, the tabs' order of sports
//   - free: no odds read; kept ten minutes at the edge, seconds when the records fail, and the
//     kinds still listed then, with no record rather than a zero
//   - the next call the owner set (the NBA props card's legs on Dec 1) shows until that day
//   - the page lays it out as the API says it: the place and its date, the record, a thin one said
//     to be thin, a full one under the 6-pick Flex's 54.2% marked, the NHL Mores by stat, every
//     change dated, and what is logged but never on Picks; its own read, above the MLB record
//
// Real data: production's /api/picks at 2:00 PM Pacific on Friday Nov 27, its kinds' records
// (tests/fixtures/pick-kinds-20261127.json). /api/picks leaves out the kinds off the list, so
// NBA threes and assists unders (off since Nov 1) have no record in it: here they stand for a kind
// whose record was not read.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
const K = JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', 'pick-kinds-20261127.json'), 'utf8'));
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const RealDate = Date;
let NOW = RealDate.parse(K.asOf);
globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } };
let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

const asked = [];
globalThis.fetch = async (u) => { asked.push(String(u)); return new Response('{}', { status: 404 }); };
const sq = new DatabaseSync(':memory:');
let dbDown = false;
const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
const exec = (sql, args, mode) => { if (dbDown) throw new Error('D1_ERROR: out of memory: SQLITE_NOMEM');
  const st = sq.prepare(sql); const a = args.map(norm);
  if (mode === 'all') return { results: st.all(...a), meta: {} }; if (mode === 'first') return st.get(...a) || null;
  return { success: true, meta: { changes: Number(st.run(...a).changes) } }; };
const DB = { prepare: (sql) => { const s = { sql, args: [], bind: (...x) => { s.args = x; return s; },
  all: async () => exec(s.sql, s.args, 'all'), first: async (c) => { const r = exec(s.sql, s.args, 'first'); return c && r ? r[c] : r; },
  run: async () => exec(s.sql, s.args, 'run') }; return s; },
  // A SELECT in a batch answers its rows, as D1's does: the kept record's generation is read so.
  batch: async (sts) => sts.map((x) => exec(x.sql, x.args, /^\s*SELECT/i.test(x.sql) ? 'all' : 'run')) };
const env = { DB };
const wsrc = fs.readFileSync(BOARD + '/worker.js', 'utf8').replace(/\r\n/g, '\n');
const mod = await import('data:text/javascript;base64,' + Buffer.from(wsrc).toString('base64'));
// A route the Worker does not know falls through to the static assets, which this env has none of:
// said as a failed answer rather than a stack trace.
const call = (u) => Promise.resolve().then(() => mod.default.fetch(new Request('https://x' + u), env, { waitUntil: () => {} }))
  .catch((e) => new Response(JSON.stringify({ thrown: String(e && e.message).slice(0, 120) }), { status: 599 }));

// The first read builds the kinds' records from the (empty) logs and keeps them, as production
// does; the kept copy then takes production's records of Nov 27, and the second read is served it.
const first = await call('/api/pick-rules');
ok(first.status === 200, `the route answers (${first.status})`);
if (first.status !== 200) { console.log('\n1 FAILED'); process.exit(1); }
const kept = sq.prepare("SELECT key, data FROM feed_cache WHERE key LIKE 'rec:pick-kinds:%'").get();
ok(!!kept, 'the records are kept, under the key /api/picks keeps them under');
const gen = JSON.parse(kept.data).gen;
sq.prepare('UPDATE feed_cache SET data = ? WHERE key = ?').run(JSON.stringify({ gen, data: K.records }), kept.key);

console.log('-- Friday Nov 27, 2 PM Pacific --');
const res = await call('/api/pick-rules');
const j = await res.json();
const by = Object.fromEntries(j.kinds.map((k) => [k.kind, k]));
for (const k of j.kinds) console.log(`  ${k.kind.padEnd(13)} ${(k.status + (k.since ? ' ' + k.since : '')).padEnd(16)} ${k.record ? `${k.record.hit}/${k.record.n}` : '-'}  ${k.changes.map((c) => c.date.slice(5)).join(' ')}`);
ok(/max-age=600/.test(res.headers.get('cache-control') || '') && !asked.length, 'kept ten minutes at the edge; nothing fetched, so no odds read');
const PICK_KINDS = (/const PICK_KINDS = \{([\s\S]*?)\n\};/.exec(wsrc) || ['', ''])[1];
const kindKeys = [...PICK_KINDS.matchAll(/^ {2}([a-z_]+): \{/gm)].map((m) => m[1]);
ok(kindKeys.length === 12 && j.kinds.length === 12 && kindKeys.every((k) => by[k]), `every kind Picks has carried, ${j.kinds.length} of ${kindKeys.length}`);
ok(j.kinds.map((k) => k.kind).join() === 'nfl_ml,nfl_ptd,nba_ml,nhl_ml,nhl_more,soccer_fav,ufc_ml,mlb_ml,mlb_pp,nba_blk_more,nba_reb_gap,nba_pp',
  "on first, held next, off last; the tabs' order of sports in each");
ok(by.nba_pp.status === 'off' && by.nba_pp.since === '2026-11-01', 'threes and assists unders: off since Nov 1');
ok(by.nba_blk_more.status === 'held' && by.nba_blk_more.since === '2026-11-24' && by.nba_reb_gap.status === 'held' && by.nba_reb_gap.since === '2026-11-24',
  'blocks Mores and rebounds Lesses: held off by hand since Nov 24');
ok(j.kinds.filter((k) => k.status === 'on').length === 9 && j.kinds.filter((k) => k.status === 'on').every((k) => !k.since), 'the other nine on, with no date of leaving');

console.log('\n-- the records --');
ok(by.nba_ml.record.n === 123 && by.nba_ml.record.hit === 94 && by.nba_ml.record.hitRate === 76.4 && by.nba_ml.record.proven === true, "NBA favourites at 65%+: 94 of 123, production's own");
ok(by.nba_blk_more.record.since && by.nba_blk_more.record.since.from === '2026-10-27' && by.nba_blk_more.record.since.n === 96 && by.nba_blk_more.record.since.hit === 50,
  'blocks Mores keep what they have done since their rule: 50 of 96 since Oct 27');
ok(JSON.stringify(by.nhl_more.parts) === JSON.stringify([{ label: 'points', n: 228, hit: 114, hitRate: 50 }, { label: 'assists', n: 141, hit: 81, hitRate: 57.4 }]) && !('byStat' in by.nhl_more.record),
  'the NHL Mores by stat at the first read, points 114 of 228 and assists 81 of 141, without the whole band table');
ok(by.nba_pp.record === null && !('parts' in by.nba_ml), 'a kind with no record kept shows none rather than a zero');

console.log('\n-- the changes, dated --');
const dates = (k) => by[k].changes.map((c) => c.date);
ok(j.kinds.every((k) => k.changes.length && k.changes.every((c, i, a) => /^\d{4}-\d{2}-\d{2}$/.test(c.date) && c.what && (!i || a[i - 1].date <= c.date))),
  'every kind has its changes, each dated, oldest first');
ok(['nba_ml', 'nba_pp', 'nfl_ml', 'soccer_fav', 'mlb_ml', 'mlb_pp'].every((k) => dates(k)[0] === '2026-10-09'), 'the first six kinds on from the list\'s first day, Oct 9');
ok(dates('nhl_ml')[0] === '2026-10-22' && dates('nfl_ptd')[0] === '2026-10-27' && dates('nba_blk_more')[0] === '2026-10-28' && dates('nhl_more')[0] === '2026-10-28'
  && dates('nba_reb_gap')[0] === '2026-10-30' && dates('ufc_ml')[0] === '2026-11-20', 'the rest from the day each came on: NHL Oct 22, passing TDs Oct 27, the Mores Oct 28, rebounds Oct 30, UFC Nov 20');
ok(j.kinds.filter((k) => k.since).every((k) => k.changes[k.changes.length - 1].date === k.since), "a kind held or off: its last change is the day it left");
ok(dates('nfl_ml').join() === '2026-10-09,2026-10-26' && /75%\+/.test(by.nfl_ml.changes[1].what), 'NFL favourites: on at 65%+, then the bar raised to 75%+ on Oct 26');
ok(dates('nba_reb_gap').join() === '2026-10-30,2026-11-18,2026-11-24' && dates('nhl_more').join() === '2026-10-28,2026-11-14,2026-11-19',
  'rebounds: on, the automatic hold on Nov 18, by hand on Nov 24; the NHL Mores: on, points by band on Nov 14, assists on Nov 19');
ok(dates('soccer_fav').join() === '2026-10-09,2026-10-22,2026-11-27' && /Bundesliga/.test(by.soccer_fav.changes[2].what), 'soccer: the Europa League on Oct 22, the Bundesliga in its place today');
ok(j.flex && j.flex.pct === 54.2 && j.flex.label === '6-pick flex' && j.provenN === 30, "the 6-pick Flex's 54.2% and the 30 graded a record needs, from the Worker's own tables");
ok(j.next && j.next.date === '2026-12-01' && /NBA props card/.test(j.next.what) && Array.isArray(j.loggedOnly) && j.loggedOnly.length >= 5 && j.loggedOnly.some((x) => /NHL points and assists Lesses/.test(x)),
  "the next call, Dec 1, and what is logged but never on Picks, the NHL Lesses among them");

console.log('\n-- the records failing --');
dbDown = true;
const down = await call('/api/pick-rules');
const jd = await down.json();
dbDown = false;
ok(down.status === 200 && /max-age=5\b/.test(down.headers.get('cache-control') || '') && /SQLITE_NOMEM/.test(jd.recordError || ''), 'a database refusal: said, and kept seconds');
ok(jd.kinds.length === 12 && jd.kinds.every((k) => k.record === null && k.changes.length), 'the kinds and their changes still listed, no record on any');
NOW = RealDate.parse('2026-12-02T20:00:00Z');
const after = await (await call('/api/pick-rules')).json();
ok(!('next' in after) && after.kinds.length === 12, 'Dec 2: the Dec 1 call is no longer shown as next');
NOW = RealDate.parse(K.asOf);

// ---- the page ----------------------------------------------------------------------------------
console.log('\n-- the page --');
const tr = fs.readFileSync(BOARD + '/track-record.js', 'utf8').replace(/\r\n/g, '\n');
const html = fs.readFileSync(BOARD + '/track-record.html', 'utf8').replace(/\r\n/g, '\n');
function lift(src, name) {
  let at = src.indexOf(`function ${name}(`);
  const isVar = at < 0;
  if (isVar) at = src.indexOf(`var ${name} =`);
  if (at < 0) throw new Error(`track-record.js has no ${name}`);
  let depth = 0;
  for (let i = at; i < src.length; i++) {
    const c = src[i];
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') { depth--; if (!isVar && c === '}' && depth === 0) return src.slice(at, i + 1); }
    else if (isVar && c === ';' && depth === 0) return src.slice(at, i + 1);
  }
  throw new Error(`could not lift ${name}`);
}
const els = {};
const $ = (id) => (els[id] = els[id] || { innerHTML: '', textContent: '', hidden: true });
let P;
try {
  P = new Function('$', ['esc', 'num', 'MONTHS', 'day', 'renderRules'].map((n) => lift(tr, n)).join('\n') + '\nreturn { day, renderRules };')($);
} catch (e) { console.log(`  FAIL  the panel lifts out of track-record.js (${e.message})`); console.log(`\n${fail + 1} FAILED`); process.exit(1); }
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
ok(P.day('2026-11-01') === 'Nov 1' && P.day('2026-10-09') === 'Oct 9' && P.day('2026-12-01') === 'Dec 1', 'dates read as written: Nov 1, Oct 9, Dec 1');
P.renderRules(j);
const rows = els.trRules.innerHTML.split('<div class="tr-rule ').slice(1).map((r) => text('<div class="tr-rule ' + r));
console.log('  ' + rows[0]);
console.log('  ' + rows[9]);
ok(els.trRulesSec.hidden === false && rows.length === 12, 'twelve rows, the section shown');
ok(/^NFL moneyline favourite on Picks listed at 75%\+ · landed 22 of 27 \(81\.5%\) fewer than 30 graded Oct 9 On at 65%\+ Oct 26 Bar raised to 75%\+/.test(rows[0]),
  'NFL favourites first: on Picks, at 75%+, 22 of 27 with too few graded to judge, then its two changes');
ok(/^NBA blocks More \(PrizePicks\) held off since Nov 24 listed at 55%\+ · landed 66 of 119 \(55\.5%\) · 50 of 96 \(52\.1%\) since Oct 27 /.test(rows[9]),
  'blocks Mores: held off since Nov 24, their whole record and the run since their rule');
const reb = rows.find((r) => r.startsWith('NBA rebounds Less'));
const nhl = rows.find((r) => r.startsWith('NHL points/assists More'));
ok(/landed 144 of 282 \(51\.1%\) under 54\.2%/.test(reb) && /landed 195 of 369 \(52\.8%\) under 54\.2%/.test(nhl), "a full record under the 6-pick Flex's 54.2% is marked: rebounds Lesses, the NHL Mores");
ok(/points 114 of 228 \(50\.0%\) · assists 81 of 141 \(57\.4%\)/.test(nhl) && /Nov 14 Points Mores only in a chance band that has landed 57\.7%\+ over 20 legs/.test(nhl),
  'the NHL Mores by stat, and the band rule with its date');
const ufc = rows.find((r) => r.startsWith('UFC moneyline'));
ok(/landed 2 of 4 \(50\.0%\) fewer than 30 graded/.test(ufc) && !/under 54\.2%/.test(ufc), 'a thin record, UFC 2 of 4, is said to be thin and not held to the bar');
ok(/^NBA PrizePicks under .* off Picks since Nov 1 listed at 70%\+ · record not read just now Oct 9 .* Oct 23 .* Nov 1 Off:/.test(rows[11]), 'threes and assists: off since Nov 1, no record read, three dated changes');
ok(!/under 54\.2%/.test(rows.find((r) => r.startsWith('NBA moneyline'))), 'a favourite over the bar carries no mark');
const foot = text(els.trRulesFoot.innerHTML);
console.log('  ' + foot.slice(0, 200) + '…');
ok(/^Against 54\.2% what each leg of a 6-pick flex has to land for the entry to break even/.test(foot) && /Off Picks never stops the logging/.test(foot)
  && /Logged and graded, never on Picks: NBA blocks and steals unders; NHL points and assists Lesses;/.test(foot) && /Dec 1 : The NBA props card's legs/.test(foot),
  'under it: the 54.2% said, the logging, what is never on Picks, and Dec 1');
P.renderRules(jd);
ok(els.trRules.innerHTML.split('record not read just now').length - 1 === 12, 'the records failing: every row says it, none reads a zero');

const rulesAt = html.indexOf('id="trRulesSec"'), stripAt = html.indexOf('id="trStrip"');
ok(rulesAt > 0 && rulesAt < stripAt && /<section class="tr-sec" id="trRulesSec" hidden>/.test(html) && /<h2>What's on Picks, and why<\/h2>/.test(html) && /<h2>MLB batter unders<\/h2>/.test(html),
  'the panel above the MLB record, hidden until it has drawn, the batter unders under their own heading');
ok(/fetch\(API \+ '\/api\/pick-rules'/.test(tr) && !/the one market we post/.test(tr), "its own read; the strip no longer calls batter unders the one market posted");
const css = fs.readFileSync(BOARD + '/style.css', 'utf8').replace(/\r\n/g, '\n');
ok(/\.tr-rule-log li \{ display:grid; grid-template-columns:52px minmax\(0,1fr\);/.test(css) && /\.tr-rule \{ padding:12px 14px; \}/.test(css), 'the changes in a date column; tighter on a phone');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
