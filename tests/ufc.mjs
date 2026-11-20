// UFC (2026-11-19, the owner's call): the moneyline on Picks at the other moneylines' bar; fight
// time priced at DraftKings' number and at a PrizePicks line typed on the card, logged and graded;
// how it ends shown, logged and graded, never a pick. What has to hold:
//   - the card is ESPN's fight center and scoreboard from site.api.espn.com, asked with no
//     User-Agent (the Worker is refused with one, and refused site.web.api.espn.com either way)
//   - a page read of the UFC board buys nothing from the odds feed, not even the first
//   - the cron's capture keeps the UFC's fights of the feed's every-promotion MMA list, in ESPN's
//     spelling and at ESPN's start of the bout's part of the card, and never asks the feed's
//     events list; a fight not on the card logs nothing
//   - fight time: DraftKings' over at its own number reads back as DraftKings', the chance falls
//     as the line rises, and a typed line is priced, saved by the entries key and locked once the
//     bout starts; how it ends adds to 100
//   - Picks lists a UFC favourite at 65%+ with the fighter's ESPN id for the photo, and not one under
//   - the grader: a decision and a submission win and lose, a draw pushes, a fight called off is
//     void, but only at the midnight run, never on the evening trigger
//   - a logged bout whose card has left the scoreboard is graded by its card's id; one on no card
//     two days on is marked off
//
// Real data: ESPN's UFC scoreboard and fight center for Saturday Nov 21 (UFC Fight Night,
// Procházka v Stirling, not yet fought) and Nov 14 (UFC 334, over), recorded on Nov 19. No MMA odds
// response has been recorded yet (the first capture keeps one at /api/ufc-odds-raw): the odds
// here are production's real NFL h2h response of Oct 29, ten books, the same endpoint and market,
// with only the names and the sport key changed to the card's. It is to be replaced by the first
// real MMA capture.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
const FIX = (f) => JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', f), 'utf8'));
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const RealDate = Date;
let NOW = RealDate.parse('2026-11-20T20:00:00Z');        // Friday noon Pacific: the prelims in 19 hours
globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } };

const SB21 = FIX('ufc-sb-20261121.json'), FC21 = FIX('ufc-fc-600061665.json');
const SB14 = FIX('ufc-sb-20261114.json'), FC14 = FIX('ufc-fc-600061400.json');
const NFL = FIX('odds-nfl-links-20261029.json');
// The stand-in MMA response: the Packers-Panthers fight as Procházka (home) v Stirling, the Cowboys-
// Cardinals one as Sterling v Vallejos, and the first again as a fight on another promotion's card.
const rename = (e, H, A, id) => ({ ...e, id, sport_key: 'mma_mixed_martial_arts', sport_title: 'MMA', commence_time: '2026-11-21T19:00:00Z', home_team: H, away_team: A,
  bookmakers: e.bookmakers.map((b) => ({ ...b, markets: b.markets.map((m) => ({ ...m, outcomes: m.outcomes.map((o) => ({ ...o, name: o.name === e.home_team ? H : A })) })) })) });
const MMA = [rename(NFL.events[0], 'Jiri Prochazka', 'Navajo Stirling', 'mma-proch'), rename(NFL.events[1], 'Aljamain Sterling', 'Kevin Vallejos', 'mma-sterl'),
  rename(NFL.events[0], 'Fighter Of Pfl', 'Another Pfl Fighter', 'mma-pfl')];

const asked = [];
let card = 'nov21';
globalThis.fetch = async (u, init) => {
  const url = String(u);
  const h = (init && init.headers) || {};
  asked.push({ url, ua: Object.keys(h).some((k) => k.toLowerCase() === 'user-agent') });
  const json = (o, extra = {}) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json', ...extra } });
  if (url.startsWith('https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard')) {
    if (url.includes('dates=20261114')) return json(SB14);
    if (url.includes('dates=')) return json({ events: [] });
    return json(card === 'nov21' ? SB21 : SB14);
  }
  if (url.startsWith('https://site.api.espn.com/apis/common/v3/sports/mma/ufc/fightcenter/600061665')) return json(FC21);
  if (url.startsWith('https://site.api.espn.com/apis/common/v3/sports/mma/ufc/fightcenter/600061400')) return json(FC14);
  if (url.includes('api.the-odds-api.com/v4/sports/mma_mixed_martial_arts/odds')) return json(MMA, { 'x-requests-last': '1', 'x-requests-remaining': '9999' });
  if (url.includes('api.the-odds-api.com')) return json([], { 'x-requests-last': '0' });
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
const env = { DB, ODDS_API_KEY: 'k' };
const src = fs.readFileSync(BOARD + '/worker.js', 'utf8').replace(/\r\n/g, '\n');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const call = (u, init) => mod.default.fetch(new Request('https://x' + u, init), env, { waitUntil: () => {} });
const get = async (u) => (await call(u)).json();
const KEY = 'k'.repeat(24);
const line = async (boutId, l) => { const r = await call('/api/ufc-lines', { method: 'POST', headers: { 'content-type': 'application/json', 'x-entry-key': KEY }, body: JSON.stringify({ boutId, line: l }) });
  return { status: r.status, body: await r.json() }; };
const fire = async (cron) => { const jobs = []; await mod.default.scheduled({ cron, scheduledTime: NOW }, env, { waitUntil: (p) => jobs.push(p) }); await Promise.allSettled(jobs); };
const MAIN_CRON = '*/5 * * * *', GRADE_CRON = '4-59/10 * * * *';
let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
const oddsMma = () => asked.filter((a) => a.url.includes('mma_mixed_martial_arts'));

console.log('-- Friday noon Pacific: the board before any capture --');
let b = await get('/api/ufc-board');
ok(b.event && b.event.id === '600061665' && b.bouts.length === 12, `the card: ${b.event && b.event.name}, ${b.bouts.length} bouts`);
const main = b.bouts.find((x) => x.mainEvent) || {};
ok(main.order === 1 && main.rounds === 5 && main.segment === 'Main card' && main.fighters.map((f) => f.name).join(' v ') === 'Jiří Procházka v Navajo Stirling',
  `the main event: ${(main.fighters || []).map((f) => f.name).join(' v ')}, ${main.rounds} rounds, ${main.segment}`);
ok(oddsMma().length === 0, 'a page read bought nothing from the odds feed');
const espn = asked.filter((a) => a.url.includes('mma/ufc'));
ok(espn.length >= 2 && espn.every((a) => a.url.startsWith('https://site.api.espn.com/') && !a.ua), `ESPN read on site.api with no User-Agent (${espn.length} reads)`);
ok(main.time && main.time.line === 2.5 && main.time.minutes === 12.5 && Math.abs(main.time.pOver - main.dk.rounds.pOver) < 0.15,
  `fight time at DraftKings' 2.5 rounds (12:30): ${main.time && main.time.pOver}% over, DraftKings' own ${main.dk && main.dk.rounds && main.dk.rounds.pOver}%`);
const e = main.ends || {};
ok(Math.abs(e.ko + e.sub + e.dec - 100) < 0.2 && e.src === 'dk' && e.dec === main.pDist, `how it ends: KO ${e.ko}, sub ${e.sub}, decision ${e.dec} (DraftKings' distance ${main.pDist})`);
const noDist = b.bouts.find((x) => !x.dk || !x.dk.dist);
ok(!noDist || (noDist.ends.src === 'base' && noDist.ends.dec === (noDist.rounds === 5 ? 42.7 : 48.2)), `a bout with no distance price takes the UFC's rate (${noDist ? noDist.fighters.map((f) => f.name).join(' v ') + ': ' + noDist.ends.dec : 'none'})`);
ok(b.bouts.every((x) => !x.ml), 'no moneyline before the first capture');

console.log('-- the five-minute cron --');
await fire(MAIN_CRON);
ok(oddsMma().length === 1 && oddsMma()[0].url.includes('/odds?') && !asked.some((a) => a.url.includes('mma_mixed_martial_arts/events')),
  `one capture of the MMA list, and no events-list read (${oddsMma().map((a) => a.url.split('?')[0].split('/').slice(-2).join('/')).join(', ')})`);
const rows = sq.prepare("SELECT * FROM gmpicks WHERE sport = 'ufc' ORDER BY game_id").all();
ok(rows.length === 2, `two UFC fights logged, the other promotion's left off (${rows.map((r) => r.pick).join(', ')})`);
const pro = rows.find((r) => r.game_id === 'mma-proch') || {}, ster = rows.find((r) => r.game_id === 'mma-sterl') || {};
ok(pro.home === 'Jiří Procházka' && pro.away === 'Navajo Stirling' && ster.pick === 'Aljamain Sterling', `in ESPN's spelling: ${pro.home} v ${pro.away}; ${ster.pick} the pick`);
ok(pro.commence === '2026-11-21T18:00:00.000Z' && pro.date === '2026-11-21', `at the main card's start (${pro.commence}, dated ${pro.date}), not the feed's 19:00`);
const logged = sq.prepare('SELECT * FROM ufcbouts').all();
ok(logged.length === 12 && logged.every((r) => r.first_at && r.p_ko != null), `the card's 12 bouts logged with their chances (${logged.length})`);
const raw = await get('/api/ufc-odds-raw');
ok(raw.events && raw.events.length === 2 && raw.listed === 3 && raw.events.some((x) => x.home_team === 'Jiri Prochazka'), 'the feed\'s own copy of the two kept for a fixture, as it spelled them');
const before = oddsMma().length;
await fire(MAIN_CRON);
ok(oddsMma().length === before, 'the next tick buys nothing: the day\'s first capture is in');

console.log('-- the board after it --');
b = await get('/api/ufc-board');
const st = b.bouts.find((x) => x.fighters.some((f) => f.name === 'Aljamain Sterling')) || {};
const sid = (st.fighters || []).find((f) => f.name === 'Aljamain Sterling') || {};
ok(st.ml && st.ml[sid.id] && st.ml[sid.id].fair > 70 && st.ml.pick === sid.id, `Sterling: fair ${st.ml && st.ml[sid.id] && st.ml[sid.id].fair}%, best ${st.ml && st.ml[sid.id] && st.ml[sid.id].price}, the logged side`);
ok(b.mlRecord && b.mlRecord.bar === 65 && b.mlRecord.logged === 2, `the moneyline record, at the 65% bar: ${b.mlRecord && b.mlRecord.logged} logged`);

console.log('-- Picks --');
const p = await get('/api/picks');
const ufcLegs = (p.legs || []).filter((l) => l.kind === 'ufc_ml');
ok(ufcLegs.length === 1 && ufcLegs[0].title === 'Aljamain Sterling ML' && ufcLegs[0].spec.playerId === sid.id && ufcLegs[0].spec.sport === 'ufc',
  `on Picks: ${ufcLegs.map((l) => `${l.title} ${l.p}% (${l.sub}), ESPN id ${l.spec.playerId}`).join('; ')}`);
ok(!(p.legs || []).some((l) => /Proch/.test(l.title)), `Procházka at ${pro.win_prob}% is under the bar and off`);
ok((p.mlPool || []).some((l) => l.kind === 'ufc_ml'), 'and in the moneyline entry\'s pool');

console.log('-- a PrizePicks fight-time line --');
let r = await line(main.id, 9.5);
ok(r.status === 200 && r.body.line === 9.5 && r.body.pOver > main.time.pOver, `9.5 minutes saved on the main event: ${r.body.pOver}% over (12:30 was ${main.time.pOver}%)`);
ok((await line(main.id, 25)).status === 400 && (await line('nope', 7.5)).status === 404, 'no line of 25 minutes, none on a bout not on the card');
const three = b.bouts.find((x) => x.rounds === 3);
ok((await line(three.id, 15)).status === 400, 'none at a three-round fight\'s full 15 minutes');
b = await get('/api/ufc-board');
const m2 = b.bouts.find((x) => x.id === main.id);
ok(!('pp' in m2) && !JSON.stringify(b).includes('pp_line'), 'the public board does not show the typed line: it is the key\'s');
ok(m2.curve.length === 49 && m2.curve[18] === r.body.pOver && m2.curve[24] === main.time.pOver && m2.curve[48] < m2.curve[0],
  `its curve prices any number the page steps to: 9.5 min ${m2.curve[18]}%, 12.5 min ${m2.curve[24]}%, 24.5 min ${m2.curve[48]}%`);
const lines = [];
for (const t of [5, 9.5, 14.5, 20.5]) lines.push((await line(main.id, t)).body.pOver);
ok(lines.every((v, i) => i === 0 || v < lines[i - 1]), `the chance falls as the line rises: ${lines.join(' > ')}`);
await line(main.id, 9.5);
const lines2 = await (await call('/api/ufc-lines', { headers: { 'x-entry-key': KEY } })).json();
ok(lines2.lines.length === 1 && lines2.lines[0].pp_line === 9.5, 'GET returns the saved line');
ok((await (await call('/api/ufc-lines', { headers: { 'x-entry-key': 'z'.repeat(24) } })).json()).error, 'another key is refused');

console.log('-- UFC 334, Nov 14: grading --');
const ins = sq.prepare(`INSERT INTO gmpicks (sport, date, game_id, market, league, commence, side, pick, home, away, win_prob, entry_price, book)
  VALUES ('ufc', ?, ?, 'h2h', 'reg', ?, ?, ?, ?, ?, ?, ?, 'draftkings')`);
ins.run('2026-11-14', 'u-gane', '2026-11-15T02:00:00.000Z', 'home', 'Ciryl Gane', 'Ciryl Gane', 'Josh Hokit', 80, -400);
ins.run('2026-11-14', 'u-nunes', '2026-11-15T02:00:00.000Z', 'away', 'Amanda Nunes', 'Kayla Harrison', 'Amanda Nunes', 55, -120);
ins.run('2026-11-14', 'u-draw', '2026-11-15T02:00:00.000Z', 'home', 'Kevin Holland', 'Kevin Holland', 'Uros Medic', 60, -150);
ins.run('2026-11-14', 'u-off', '2026-11-15T00:00:00.000Z', 'home', 'Someone Pulled', 'Someone Pulled', 'His Opponent', 66, -190);
const res = () => Object.fromEntries(sq.prepare("SELECT game_id, result FROM gmpicks WHERE sport = 'ufc' AND date = '2026-11-14'").all().map((x) => [x.game_id, x.result]));
NOW = RealDate.parse('2026-11-15T06:30:00Z');             // 10:30 PM Pacific, the card over
await fire(GRADE_CRON);
let g = res();
ok(g['u-gane'] === 'win' && g['u-nunes'] === 'loss' && g['u-draw'] === 'push', `the evening trigger: Gane ${g['u-gane']}, Nunes ${g['u-nunes']}, Holland-Medić (a draw) ${g['u-draw']}`);
ok(g['u-off'] == null, 'a fight on no card waits for the midnight run');
NOW = RealDate.parse('2026-11-15T09:00:00Z');             // 1 AM Pacific, Nov 15
await fire(MAIN_CRON);
g = res();
ok(g['u-off'] === 'void', `at midnight, called off: ${g['u-off']}`);

console.log('-- a UFC moneyline in an entry grades from the log --');
const entries = async (method, body) => (await call('/api/entries', { method,
  headers: { 'content-type': 'application/json', 'x-entry-key': KEY }, body: body ? JSON.stringify(body) : undefined })).json();
const eleg = (id, name, side, price) => ({ sport: 'ufc', date: '2026-11-14', gamePk: id, player: name, market: 'ml', side, price });
const made = await entries('POST', { action: 'create', entry: { book: 'pp', kind: 'flex', stake: 10,
  legs: [eleg('u-gane', 'Ciryl Gane', 'home', -400), eleg('u-nunes', 'Amanda Nunes', 'away', -120),
    eleg('u-draw', 'Kevin Holland', 'home', -150), eleg('u-off', 'Someone Pulled', 'home', -190)] } });
await entries('GET');
const eLegs = sq.prepare('SELECT result, graded_by FROM entry_legs WHERE entry_id = ? ORDER BY idx').all(made.id);
ok(eLegs.map((l) => l.result).join(' ') === 'win loss push void' && eLegs.every((l) => l.graded_by === 'auto'),
  `Gane, Nunes, the draw and the fight called off: ${eLegs.map((l) => `${l.result} (${l.graded_by})`).join(', ')}`);

console.log('-- bouts whose card has left the scoreboard --');
const bi = sq.prepare(`INSERT INTO ufcbouts (bout_id, event_id, event, date, commence, rounds, weight, f1_id, f1, f2_id, f2, dk_line, p_over, p_ko, p_sub, p_dec, pp_line, pp_p_over, first_at)
  VALUES (?, '600061400', 'UFC 334', '2026-11-14', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-11-13T00:00:00Z')`);
bi.run('401922638', '2026-11-15T02:00:00.000Z', 5, "Women's Bantamweight", '2516131', 'Amanda Nunes', '4332765', 'Kayla Harrison', 2.5, 55, 20, 25, 55, 10.5, 60);
bi.run('401922643', '2026-11-15T00:00:00.000Z', 3, 'Lightweight', '4425604', 'Terrance McKinney', '2335718', 'Jim Miller', 1.5, 35, 50, 20, 30, 4.5, 40);
bi.run('401999999', '2026-11-12T00:00:00.000Z', 3, 'Lightweight', '1', 'Called Off', '2', 'Not Fought', 1.5, 50, 30, 20, 50, null, null);
NOW = RealDate.parse('2026-11-15T10:00:00Z');
await fire(MAIN_CRON);
const gb = Object.fromEntries(sq.prepare("SELECT bout_id, method, end_round, minutes, winner_id, stats FROM ufcbouts WHERE event_id = '600061400'").all().map((x) => [x.bout_id, x]));
ok(gb['401922638'].method === 'sub' && gb['401922638'].end_round === 4 && gb['401922638'].winner_id === '4332765' && Math.abs(gb['401922638'].minutes - 16.48) < 0.01,
  `Harrison-Nunes graded from UFC 334's fight center: ${gb['401922638'].method}, round ${gb['401922638'].end_round}, ${gb['401922638'].minutes} min`);
const sts = JSON.parse(gb['401922638'].stats || '{}')['4332765'] || {};
ok(sts.sig != null && sts.td != null, `with the fighters' stats: Harrison ${sts.sig} of ${sts.sigAtt} significant strikes, ${sts.td} of ${sts.tdAtt} takedowns`);
ok(gb['401922643'].method === 'ko' && gb['401922643'].end_round === 1, `McKinney-Miller: ${gb['401922643'].method} in round ${gb['401922643'].end_round}`);
ok(gb['401999999'].method === 'off', 'a bout on no card two days on is marked off');
b = await get('/api/ufc-board');
const rec = b.record || {};
// Harrison-Nunes went 16:29 (over 2.5 rounds and over 10.5, the sides at 55% and 60%); McKinney-
// Miller 1:53 (under 1.5 rounds and under 4.5, the sides at 65% and 60%): all four landed.
ok(rec.bouts === 2 && rec.timeAtDk.n === 2 && rec.timeAtDk.hit === 2 && rec.timeAtPp.n === 2 && rec.timeAtPp.hit === 2,
  `the record: fight time at DraftKings' number ${rec.timeAtDk && rec.timeAtDk.hit} of ${rec.timeAtDk && rec.timeAtDk.n}, at PrizePicks' ${rec.timeAtPp && rec.timeAtPp.hit} of ${rec.timeAtPp && rec.timeAtPp.n}`);
// The likeliest ending: a decision for Harrison-Nunes (a submission), a knockout for McKinney-Miller.
ok(rec.ends && rec.ends.n === 2 && rec.ends.hit === 1, `the likeliest ending landed ${rec.ends && rec.ends.hit} of ${rec.ends && rec.ends.n}`);

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
