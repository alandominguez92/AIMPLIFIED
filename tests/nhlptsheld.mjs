// NHL points Mores go on Picks only where legs like them have landed (2026-11-14, the owner:
// "let's keep it for now, let's just not add it to the picks of the day if they are not
// favorable to hit").
//
// At 55%+ the points Mores had landed 48% at the pre-start read (41 of 85) and 52% at the first
// (71 of 136), under the 57.7% a 2-pick Power needs, with no chance band past it; the assists 61%
// and 60%. Saturday's PrizePicks pool was six NHL Mores, four of them points. What has to hold:
//   - a points More is on Picks and in the entry only where its band (55-60, 60-65, 65+), at the
//     read it is on, has landed 57.7% or better over 20 legs or more; else the points Mores at
//     the bar go for it
//   - assists aren't held to it; the rule starts on Nov 14
//   - the points Mores stay on the NHL card, each held one saying so with the record it went by
//   - a band that comes good puts its legs back; one listed that goes bad again leaves the list
//     saying why
//
// Real data: production's /api/nhl-pp at 12:30 AM Pacific on Nov 14 (tests/fixtures/
// nhl-pp-20261114.json): Saturday's legs as logged, and the record's counts by stat and band,
// which the graded rows here are built to (one row a leg, at the band's middle). Real SQLite and
// the real worker.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const N = JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', 'nhl-pp-20261114.json'), 'utf8'));
const RealDate = Date;
let NOW = RealDate.parse('2026-11-14T08:40:00Z');
globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } };
globalThis.fetch = async () => new Response('{}', { status: 404 });
const sq = new DatabaseSync(':memory:');
const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
const exec = (sql, args, mode) => { const st = sq.prepare(sql); const a = args.map(norm);
  if (mode === 'all') return { results: st.all(...a), meta: {} }; if (mode === 'first') return st.get(...a) || null;
  return { success: true, meta: { changes: Number(st.run(...a).changes) } }; };
const DB = { prepare: (sql) => { const s = { sql, args: [], bind: (...x) => { s.args = x; return s; },
  all: async () => exec(s.sql, s.args, 'all'), first: async (c) => { const r = exec(s.sql, s.args, 'first'); return c && r ? r[c] : r; },
  run: async () => exec(s.sql, s.args, 'run') }; return s; }, batch: async (sts) => sts.map((x) => exec(x.sql, x.args, 'run')) };
const env = { DB };
const src = fs.readFileSync(BOARD + '/worker.js', 'utf8').replace(/\r\n/g, '\n');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const get = async (u) => (await mod.default.fetch(new Request('https://x' + u), env, { waitUntil: () => {} })).json();
let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
const names = (l) => (l || []).map((x) => x.title);

await get('/api/picks'); await get('/api/nhl-pp');      // the tables

// ---- the record production had, and Saturday's legs ---------------------------------------
const BY = N.record.more.byStat;
ok(BY.pts.close.atBar.hit === 41 && BY.pts.close.atBar.n === 85 && BY.pts.first.atBar.hit === 71 && BY.pts.first.atBar.n === 136
  && BY.ast.close.atBar.hit === 48 && BY.ast.close.atBar.n === 79,
  'the real record: points 41 of 85 at the pre-start read, 71 of 136 at the first; assists 48 of 79');
const MID = { '55-60': 57.5, '60-65': 62.5, '65+': 67 };
const gins = sq.prepare(`INSERT INTO nhlpp (date, game_id, player, market, commence, point, model_under, result, close_point, close_under, close_result)
  VALUES (?, ?, ?, ?, ?, 0.5, ?, ?, ?, ?, ?)`);
let seq = 0;
const graded = (mk, read, band, hit, n) => {
  for (let i = 0; i < n; i++) {
    const won = i < hit, p = MID[band], id = `g${++seq}`;
    // A first read at the band; a pre-start read on a row whose first read was no lean.
    if (read === 'first') gins.run('2026-11-01', id, `P${seq}`, mk, '2026-11-02T00:00:00Z', 100 - p, won ? 'over' : 'under', null, null, null);
    else gins.run('2026-11-01', id, `P${seq}`, mk, '2026-11-02T00:00:00Z', 50, won ? 'over' : 'under', 0.5, 100 - p, won ? 'over' : 'under');
  }
};
for (const mk of ['pts', 'ast']) for (const read of ['first', 'close']) for (const [band, c] of Object.entries(BY[mk][read].byBand)) graded(mk, read, band, c.hit, c.n);
const lins = sq.prepare(`INSERT INTO nhlpp (date, game_id, player, market, commence, home, away, team, player_id, point, model_under, proj, toi_proj, captured_at)
  VALUES ('2026-11-14', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
for (const l of N.legs) { const [away, home] = l.game.split(' @ '); lins.run(l.game_id, l.player, l.market, l.commence, home, away, l.team, l.player_id, l.point, l.model_under, l.proj, l.toi_proj, l.first_at); }

console.log('-- 12:40 AM Saturday --');
let h = await get('/api/nhl-pp');
ok(JSON.stringify(h.record.more.byStat.pts) === JSON.stringify(BY.pts) && JSON.stringify(h.record.more.byStat.ast) === JSON.stringify(BY.ast), 'the rows give the record production had, by stat and band');
let p = await get('/api/picks');
console.log('  pool: ' + names(p.ppPool).join(' | '));
const PTS = ['Evgeni Malkin Over 0.5 PTS', 'Seth Jarvis Over 0.5 PTS', 'Jack Roslovic Over 0.5 PTS', 'Artturi Lehkonen Over 0.5 PTS'];
ok(!p.ppPool.some((l) => / PTS$/.test(l.title)) && !p.legs.some((l) => / PTS$/.test(l.title)), 'no points More on Picks or in the entry: Malkin, Jarvis, Roslovic, Lehkonen held');
ok(names(p.ppPool).join() === ['Matthew Tkachuk Over 0.5 AST', 'Jackson LaCombe Over 0.5 AST', 'David Pastrnak Over 0.5 AST', 'Jack Hughes Over 0.5 AST', 'Erik Karlsson Over 0.5 AST', 'Mark Scheifele Over 0.5 AST'].join(),
  'the entry: the assists Mores, one a game, Tkachuk and LaCombe first');
const leg = (name) => h.legs.find((l) => l.player === name && l.market === 'pts');
ok(JSON.stringify(leg('Evgeni Malkin').offPicks) === JSON.stringify({ band: '60-65', hit: 20, n: 38 }) && JSON.stringify(leg('Seth Jarvis').offPicks) === JSON.stringify({ band: '55-60', hit: 44, n: 84 }),
  'on the NHL board each says what held it: Malkin at 60-65% (20 of 38), Jarvis at 55-60% (44 of 84)');
ok(!h.legs.some((l) => l.market === 'ast' && l.offPicks) && !h.legs.some((l) => l.market === 'pts' && 100 - l.model_under < 55 && l.offPicks), 'assists, and points under the bar, carry nothing');

// The card, lifted from app.js.
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
const text = (x) => x.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const ui = { nbaPp: null, nhlPp: h, slip: {} };
const CARD = ['TEAM_COLORS', 'MLB_TEAM_ID', 'NHL_PHOTO_SEASON', 'headshotUrl', 'teamMarkUrl', 'initialsOf', 'avatarHtml',
  'miniBar', 'projLineHtml', 'LEG_OFFERS', 'offerLeg', 'ptDayOf', 'soccerKick', 'AM', 'MARKET_SHORT', 'NBA_ROTATION_MIN', 'NBA_MK', 'NHL_MK', 'nbaPpLeg', 'nbaOversLineHtml', 'ppMovedTag',
  'ppCloseLineHtml', 'dfsLinesHtml', 'sharpTag', 'ppBookLine', 'ppGameLineHtml', 'PP_MORE_MIN', 'ppMoreP', 'ppMoreMk', 'ppMoreLeg', 'ppMoreTop', 'nbaNick', 'NBA_CODE_NICK', 'NHL_CODE_NICK', 'legOppText', 'ppMoreListHtml',
  'shortDay', 'recSinceText', 'ppMoreLineHtml', 'nbaBlkMoreHtml', 'nbCdf', 'r1', 'pct0', 'PP_LINE_MARKETS', 'ppLineOf', 'ppChanceAt', 'nbaLegAtLine', 'readAgeTag', 'INJ_ROLE_WORD', 'injRoleText', 'injuryTag', 'nbaCardInjTag', 'ppLineTags', 'ppLineStepHtml', 'NBA_BANDS', 'NBA_BAND_MIN', 'nbaBandLandedHtml', 'nbaPpCardHtml', 'nhlPpCardHtml'];
const C = new Function('state', 'esc', CARD.map(lift).join('\n') + '\nreturn { nhlPpCardHtml };')(ui, esc);
const card = C.nhlPpCardHtml();
const rowOf = (name) => (card.split('<li>').find((r) => r.includes(`<b>${name}</b>`)) || '');
console.log('  ' + text(rowOf('Evgeni Malkin')).slice(0, 160));
// The card's More list is its top five: Tkachuk, Malkin, LaCombe, Carlsson and one of the 59.5s.
const ptsRows = card.split('<li>').filter((r) => /Over 0\.5 points/.test(text(r)));
console.log('  points rows on the card: ' + ptsRows.map((r) => (r.match(/<b>([^<]+)<\/b>/) || [])[1]).join(', '));
ok(/off Picks: at 60-65% these landed 20 of 38<\/span>/.test(rowOf('Evgeni Malkin')) && ptsRows.length === 2
  && /off Picks: at 55-60% these landed 44 of 84<\/span>/.test(ptsRows[1]),
  'the card keeps them, each saying so: "off Picks: at 60-65% these landed 20 of 38", the 59.5 at 55-60% 44 of 84');
ok(!/off Picks/.test(rowOf('Matthew Tkachuk')) && /<b>Matthew Tkachuk<\/b>/.test(card), 'an assists row says nothing of it');

// ---- a band that comes good, then goes bad again ------------------------------------------------
console.log('\n-- the 55-60 band comes good --');
// Twenty more first-read points legs at 55-60, all landed: 64 of 104, 61.5%.
graded('pts', 'first', '55-60', 20, 20);
NOW = RealDate.parse('2026-11-14T09:15:00Z');        // the kinds record is half an hour behind at most
p = await get('/api/picks');
console.log('  pool: ' + names(p.ppPool).join(' | '));
ok(['Seth Jarvis Over 0.5 PTS', 'Jack Roslovic Over 0.5 PTS', 'Artturi Lehkonen Over 0.5 PTS'].every((t) => names(p.ppPool).includes(t) || names(p.legs).includes(t))
  && !names(p.ppPool).includes('Evgeni Malkin Over 0.5 PTS') && !names(p.legs).includes('Evgeni Malkin Over 0.5 PTS'),
  'its legs come back (Jarvis, Roslovic, Lehkonen at 59%); Malkin at 64%, his band still 20 of 38, stays held');
ok(names(p.legs).includes('Seth Jarvis Over 0.5 PTS'), "Jarvis, the best leg of the Kraken's game, is on the list");
sq.prepare("DELETE FROM nhlpp WHERE date = '2026-11-01' AND CAST(substr(game_id, 2) AS INTEGER) > ?").run(seq - 20);
NOW = RealDate.parse('2026-11-14T09:50:00Z');
p = await get('/api/picks');
ok(!names(p.legs).includes('Seth Jarvis Over 0.5 PTS'), 'back to 44 of 84: Jarvis leaves the list');
NOW = RealDate.parse('2026-11-14T18:05:00Z');        // after the Kraken's puck drop
p = await get('/api/picks');
const day = p.record.history.days.find((d) => d.date === '2026-11-14');
const jar = day && (day.dropped || []).find((x) => /Jarvis/.test(x.label));
console.log('  dropped: ' + JSON.stringify(jar));
ok(jar && jar.why === 'NHL points Mores go on Picks only where legs like them land 57.7%+: at 55-60% they had landed 44 of 84',
  `off before the start, saying why: "${jar && jar.why}"`);

// ---- before the rule ---------------------------------------------------------------------------
console.log('\n-- the day before --');
ok(/const NHL_PTS_HOLD_SINCE = '2026-11-14';/.test(src), 'the rule starts on Nov 14 (Pacific)');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
