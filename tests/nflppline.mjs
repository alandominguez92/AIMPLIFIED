// PrizePicks' NFL yardage number rides beside the books' line, never in it.
//
// The props capture took PrizePicks in BetRivers' place on 2026-10-06, so NFL
// legs in the slip can be logged at PrizePicks' number -- a probe of two Week 5
// games found it on 18 receivers and 9 rushers, more than DraftKings posts.
//
// What would be wrong quietly: the comparison takes its line as the point the
// most books agree on. Counted as one more book, PrizePicks' number could move
// the very line it is shown against. And PrizePicks lists players no book does;
// dropping those because they have no "line" would hide exactly the extra legs
// the change was for.
import fs from 'node:fs';
import path from 'node:path';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };

const KO = new Date(Date.now() + 30 * 3600e3).toISOString();
const proj = [
  { event_id: 'ev1', player: 'CeeDee Lamb', market: 'receiving', team: 'DAL', pos: 'WR', game: 'TB @ DAL', commence: KO, proj: 82, p25: 50, p50: 76, p75: 110, conf: 1, actual: null, captured_at: '2026-10-06T08:00:00Z' },
  { event_id: 'ev1', player: 'Bucky Irving', market: 'rushing', team: 'TB', pos: 'RB', game: 'TB @ DAL', commence: KO, proj: 66, p25: 40, p50: 62, p75: 88, conf: 1, actual: null, captured_at: '2026-10-06T08:00:00Z' },
];
const q = (player, market, book, point, over, under, at) => ({ event_id: 'ev1', market, player, point, book, over, under, captured_at: at || '2026-10-06T09:00:00Z' });
const quotes = [
  // The books split, 79.5 and 80.5, and a split breaks to the lower number.
  // PrizePicks hangs 80.5 in its latest read: counted as a vote it would tip the
  // line to 80.5. Its latest read also has 65.5, and an earlier read 74.5.
  q('CeeDee Lamb', 'player_reception_yds', 'draftkings', 79.5, -110, -110),
  q('CeeDee Lamb', 'player_reception_yds', 'fanduel', 80.5, -112, -108),
  q('CeeDee Lamb', 'player_reception_yds', 'prizepicks', 74.5, -137, -137, '2026-10-06T07:00:00Z'),
  q('CeeDee Lamb', 'player_reception_yds', 'prizepicks', 80.5, -137, -137),
  q('CeeDee Lamb', 'player_reception_yds', 'prizepicks', 65.5, -137, -137),
  // No book quotes Irving; PrizePicks does.
  q('Bucky Irving', 'player_rush_yds', 'prizepicks', 61.5, -137, -137),
];
const db = { prepare: (sql) => {
  const st = { sql, args: [], bind: (...a) => { st.args = a; return st; },
    run: async () => ({ meta: { changes: 0 } }), first: async () => null,
    all: async () => {
      if (/FROM nfl_proj/i.test(sql)) return { results: proj };
      if (/FROM nfl_lines/i.test(sql)) return { results: quotes };
      return { results: [] };
    } };
  return st;
}, batch: async (s) => s.map(() => ({ meta: { changes: 0 } })) };
globalThis.fetch = async () => new Response('{}', { status: 404 });

const src = fs.readFileSync(BOARD + '/worker.js', 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const get = async (u) => (await mod.default.fetch(new Request('https://x' + u), { DB: db }, { waitUntil: () => {} })).json();

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

const cmp = await get('/api/nfl-compare');
const row = (p) => (cmp.rows || []).find((r) => r.player === p) || {};
const lamb = row('CeeDee Lamb');
console.log('  Lamb: ' + JSON.stringify({ line: lamb.line, ppLine: lamb.ppLine, books: lamb.books, underBook: lamb.underBook }));
ok(lamb.line === 79.5 && lamb.books === 1, `the line is the books' number, with PrizePicks out of the vote (${lamb.line}, ${lamb.books} book at it)`);
ok(lamb.ppLine === 80.5, `PrizePicks' number rides beside it: its latest read, nearest the line (${lamb.ppLine})`);
ok(lamb.underBook !== 'prizepicks' && lamb.overBook !== 'prizepicks', 'and PrizePicks is never the "best price"');
const irv = row('Bucky Irving');
ok(irv.line == null && irv.ppLine === 61.5, `a player only PrizePicks lists keeps its number (${irv.ppLine})`);
const sum = await get('/api/nfl-compare?summary=1');
ok((sum.biggestGaps || []).some((g) => g.player === 'CeeDee Lamb' && g.ppLine === 80.5),
  'and the compact summary the scheduled checks read carries it too');

// Graded at PrizePicks' number. The model loses to the books' line, so the angle
// left is PrizePicks' own number: does its under land more often where that
// number sits above the books'? Lamb's 80.5 is a point above the books' 79.5 and
// he finishes on 70; Irving, PrizePicks-only, beats 61.5 with 65.
proj[0].actual = 70; proj[1].actual = 65;
const g = await get('/api/nfl-compare?all=1&summary=1');
console.log('  ppGraded: ' + JSON.stringify(g.ppGraded && { n: g.ppGraded.n, hit: g.ppGraded.hit, byLineGap: g.ppGraded.byLineGap }));
ok(g.ppGraded && g.ppGraded.n === 2 && g.ppGraded.hit === 1,
  "PrizePicks unders graded at PrizePicks' number, in the summary the scheduled check reads (1 of 2)");
ok(g.ppGraded && g.ppGraded.byLineGap.ppHigher.n === 1 && g.ppGraded.byLineGap.ppHigher.hit === 1
  && g.ppGraded.byLineGap.noBook.n === 1 && g.ppGraded.byLineGap.noBook.hit === 0,
  "split by where PrizePicks' number sat: above the books' (Lamb, under) and with no book at all (Irving, over)");

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
