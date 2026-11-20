// UFC significant strikes and takedowns (2026-11-20, the owner's go-ahead after the replay: "yes,
// build punches and takedowns onto the UFC tab"). What has to hold:
//   - the fight history comes from ESPN's season calendars and each past card's fight center, on
//     site.api.espn.com with no User-Agent, two cards a tick of the every-other-minute cron,
//     newest first; a card that will not read is asked again later, not every tick; a card still
//     to come is not read
//   - each finished fight is two history rows, each fighter's strikes and takedowns and what the
//     opponent landed on them, the length, a fight past three rounds a five-round one
//   - before any history, no fighter has a chance and a typed line is refused, not priced at a guess
//   - with it, every fighter of a fight to come has a projection and a curve: falling, from near
//     100 to under half a percent, adding up to the projection (the mean of a count is the sum of
//     its chances of more than 0, 1, 2 ...); the strikes 50/50 line sits where the curve crosses 50
//   - a fighter's own output and the opponent's leaks go the right way round: Hooker against
//     Ortega, who has no fight in the history (so starts at 0.85 of the division), comes out at the
//     ratio the formula gives from Hooker's one fight
//   - a bout with no goes-the-distance price takes the last 180 days' share once 20 fights of its
//     length are in, and not before
//   - PrizePicks' typed lines: half numbers only, saved by the entries key, priced at the curve,
//     never on the public board, logged with every fighter on the cron, graded with the bout, and
//     a fight called off is off
//
// Real data: ESPN's 2024, 2025 and 2026 UFC calendars (scoreboard?dates=YYYY0615) recorded Nov 20;
// the fight centers of Nov 21 (to come), Nov 14 (UFC 334), Nov 8 and Sep 5, recorded Nov 19.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
const FIX = (f) => JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', f), 'utf8'));
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const RealDate = Date;
let NOW = RealDate.parse('2026-11-20T20:00:00Z');        // Friday noon Pacific
globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } };

const SB21 = FIX('ufc-sb-20261121.json'), FC21 = FIX('ufc-fc-600061665.json');
const SB14 = FIX('ufc-sb-20261114.json');
const CAL = { 20240615: FIX('ufc-sb-20240615.json'), 20250615: FIX('ufc-sb-20250615.json'), 20260615: FIX('ufc-sb-20260615.json') };
const FCS = { 600061665: FC21, 600061400: FIX('ufc-fc-600061400.json'), 600061268: FIX('ufc-fc-600061268.json'), 600059993: FIX('ufc-fc-600059993.json') };

const asked = [];
let card = 'nov21';
globalThis.fetch = async (u, init) => {
  const url = String(u);
  const h = (init && init.headers) || {};
  asked.push({ url, ua: Object.keys(h).some((k) => k.toLowerCase() === 'user-agent') });
  const json = (o, extra = {}) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json', ...extra } });
  if (url.startsWith('https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard')) {
    const m = /dates=(\d+)/.exec(url);
    if (m && CAL[m[1]]) return json(CAL[m[1]]);
    if (m && m[1] === '20261114') return json(SB14);
    if (m) return json({ events: [] });
    return json(card === 'nov21' ? SB21 : SB14);
  }
  const fc = /^https:\/\/site\.api\.espn\.com\/apis\/common\/v3\/sports\/mma\/ufc\/fightcenter\/(\d+)/.exec(url);
  if (fc) return FCS[fc[1]] ? json(FCS[fc[1]]) : new Response('{}', { status: 404 });
  if (url.includes('api.the-odds-api.com')) return json([], { 'x-requests-last': '0', 'x-requests-remaining': '9999' });
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
const post = async (body, key = KEY) => { const r = await call('/api/ufc-lines', { method: 'POST', headers: { 'content-type': 'application/json', 'x-entry-key': key }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() }; };
const fire = async (cron) => { const jobs = []; await mod.default.scheduled({ cron, scheduledTime: NOW }, env, { waitUntil: (p) => jobs.push(p) }); await Promise.allSettled(jobs); };
const MAIN_CRON = '*/5 * * * *', HIST_CRON = '1-59/2 * * * *';
let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
const fcReads = () => asked.filter((a) => a.url.includes('/fightcenter/')).map((a) => a.url.split('/').pop());
const meta = () => JSON.parse((sq.prepare("SELECT data FROM feed_cache WHERE key = 'ufc_hist_meta'").get() || {}).data || 'null');
const HOOKER = '3109135', ORTEGA = '3045737';

console.log('-- before any history --');
let b = await get('/api/ufc-board');
ok(b.bouts.length === 12 && b.bouts.every((x) => x.props === null) && b.history === null, `12 bouts, none with a strikes or takedowns chance yet (history ${JSON.stringify(b.history)})`);
const ho = b.bouts.find((x) => x.fighters.some((f) => f.id === HOOKER)) || { fighters: [] };
let r = await post({ boutId: ho.id, fighterId: HOOKER, stat: 'sig', line: 40.5 });
ok(r.status === 503, `a typed strikes line is refused, not priced at a guess (${r.status}: ${r.body.error})`);

console.log('-- the history, two cards a tick --');
let before = asked.length;
await fire(HIST_CRON);
const t1 = asked.slice(before).filter((a) => a.url.includes('mma/ufc'));
const cals = t1.filter((a) => /scoreboard\?dates=\d{4}0615/.test(a.url)).map((a) => /dates=(\d{4})/.exec(a.url)[1]);
ok(cals.join(' ') === '2024 2025 2026', `the first tick reads each season's calendar once: ${cals.join(', ')}`);
ok(t1.length && t1.every((a) => a.url.startsWith('https://site.api.espn.com/') && !a.ua), `all on site.api with no User-Agent (${t1.length} reads)`);
const read1 = t1.filter((a) => a.url.includes('/fightcenter/')).map((a) => a.url.split('/').pop());
ok(read1.join(' ') === '600061400 600061268', `then the two newest past cards, UFC 334 and Nov 8: ${read1.join(', ')}`);
let n = sq.prepare('SELECT COUNT(*) AS n FROM ufcfights').get().n;
ok(n === 54, `27 fights in, two rows each (${n})`);
const hk = sq.prepare("SELECT * FROM ufcfights WHERE bout_id = '401922638' AND fighter_id = '4332765'").get() || {};
ok(hk.sig === 25 && hk.sig_att === 41 && hk.td === 3 && hk.td_att === 9 && hk.opp_sig === 31 && hk.opp_td === 2 && hk.won === 1,
  `Harrison v Nunes from the fight center: Harrison ${hk.sig} of ${hk.sig_att} strikes, ${hk.td} of ${hk.td_att} takedowns, Nunes landed ${hk.opp_sig} and ${hk.opp_td}, won ${hk.won}`);
ok(hk.rounds === 5 && hk.method === 'sub' && Math.abs(hk.minutes - 16.48) < 0.01 && hk.weight === "Women's Bantamweight", `a five-round ${hk.weight} fight, a submission at ${hk.minutes} min`);
ok(!read1.includes('600061665') && !sq.prepare("SELECT 1 FROM ufcfights WHERE event_id = '600061665'").get(), 'the card still to come is not read as history');

// The cards between Nov 8 and Sep 5 have no fixture here: each is asked once and left for an hour.
const perTick = [];
for (let i = 0; i < 12 && !fcReads().includes('600059993'); i++) {
  before = asked.length;
  await fire(HIST_CRON);
  perTick.push(asked.slice(before).filter((a) => a.url.includes('/fightcenter/')).length);
}
const reads = fcReads(), asked2 = new Map();
for (const id of reads) asked2.set(id, (asked2.get(id) || 0) + 1);
ok(reads.includes('600059993') && perTick.every((x) => x <= 2), `Sep 5 reached ${perTick.length + 1} ticks in, at most two cards a tick (${perTick.join(' ')})`);
ok([...asked2.values()].every((x) => x === 1), `a card that would not read was asked once, then left for later (${reads.length} cards asked, none twice)`);
n = sq.prepare('SELECT COUNT(*) AS n FROM ufcfights').get().n;
const M = meta() || {};
ok(n === 82 && M.fights === 41, `41 fights, 82 rows (${n}; the summary says ${M.fights})`);
// 37 three-round and 4 five-round fights in the three cards (counted by the replay's own loader).
ok(M.distBouts && M.distBouts[3] === 37 && M.distBouts[5] === 4 && M.dist[3] > 20 && M.dist[3] < 70 && M.dist[5] == null,
  `the last 180 days: ${M.distBouts && M.distBouts[3]} three-round fights, ${M.dist && M.dist[3]}% went the distance; ${M.distBouts && M.distBouts[5]} five-round, too few for a share`);

console.log('-- the board with the history --');
NOW += 16 * 60e3;                                          // the card read again
b = await get('/api/ufc-board');
ok(b.history && b.history.fights === 41, `the board says what the history holds: ${b.history && b.history.fights} fights`);
ok(b.bouts.every((x) => x.props && x.fighters.every((f) => x.props[f.id] && x.props[f.id].sig && x.props[f.id].td)), 'every fighter of every fight to come has strikes and takedowns');
const three = b.bouts.filter((x) => x.rounds === 3), five = b.bouts.filter((x) => x.rounds === 5);
ok(three.every((x) => x.distBase === M.dist[3]) && five.every((x) => x.distBase == null),
  `three-round bouts carry the last 180 days' ${M.dist[3]}% for when DraftKings has no distance price; the five-round one the old rate`);
let shape = 0, sums = [], mids = 0;
for (const x of b.bouts) for (const f of x.fighters) for (const s of ['sig', 'td']) {
  const m = x.props[f.id][s], c = m.curve;
  if (c.every((v, i) => i === 0 || v <= c[i - 1]) && c[c.length - 1] <= 0.5 && (s === 'td' || c[0] > 90)) shape++;
  sums.push(Math.abs(c.reduce((a, v) => a + v, 0) / 100 - m.mean) <= (s === 'sig' ? 0.6 : 0.06));
  if (s === 'sig' && c[m.mid - 0.5] < 50 && (m.mid === 0.5 || c[m.mid - 1.5] >= 50)) mids++;
}
ok(shape === 48, `every curve falls to under half a percent (${shape} of 48)`);
ok(sums.every(Boolean), `every curve adds up to its projection (${sums.filter(Boolean).length} of ${sums.length})`);
ok(mids === 24, `every strikes 50/50 line is where the curve crosses 50 (${mids} of 24)`);
const hb = b.bouts.find((x) => x.fighters.some((f) => f.id === HOOKER));
const H = hb.props[HOOKER], O = hb.props[ORTEGA];
ok(H.fights === 1 && !H.newcomer && O.fights === 0 && O.newcomer, `Hooker has his Sep 5 fight in (${H.fights}); Ortega none, marked new`);
{
  const row = sq.prepare(`SELECT * FROM ufcfights WHERE fighter_id = '${HOOKER}'`).get();
  const k = String(hb.weight).toLowerCase(), dv = M.div[k] && M.div[k].min > 300 ? M.div[k] : M.all, d = dv.sig / dv.min;
  const own = (row.sig + 25 * d) / (row.minutes + 25), leak = (row.opp_sig + 25 * d) / (row.minutes + 25);
  const want = Math.pow(own / d, 0.8) / (Math.pow(0.85, 0.8) * Math.pow(leak / d, 0.8)), got = H.sig.mean / O.sig.mean;
  ok(Math.abs(got / want - 1) < 0.01, `Hooker ${H.sig.mean} v Ortega ${O.sig.mean} strikes: ratio ${got.toFixed(3)}, the formula's ${want.toFixed(3)} from Hooker's ${row.sig} landed and ${row.opp_sig} taken in ${row.minutes} min`);
}

console.log('-- PrizePicks lines typed on a fighter --');
r = await post({ boutId: hb.id, fighterId: HOOKER, stat: 'sig', line: 40.5 });
ok(r.status === 200 && r.body.line === 40.5 && r.body.pOver === H.sig.curve[40], `Hooker 40.5 strikes saved: More ${r.body.pOver}%, the curve's ${H.sig.curve[40]}%`);
const sigP = r.body.pOver;
r = await post({ boutId: hb.id, fighterId: HOOKER, stat: 'td', line: 1.5 });
ok(r.status === 200 && r.body.pOver === H.td.curve[1], `and 1.5 takedowns: More ${r.body.pOver}%`);
const bad = [await post({ boutId: hb.id, fighterId: HOOKER, stat: 'sig', line: 40 }), await post({ boutId: hb.id, fighterId: HOOKER, stat: 'td', line: 15.5 }),
  await post({ boutId: hb.id, fighterId: '1', stat: 'sig', line: 40.5 }), await post({ boutId: 'nope', fighterId: HOOKER, stat: 'sig', line: 40.5 })].map((x) => x.status);
ok(bad.join(' ') === '400 400 404 404', `no whole-number line, no 15.5 takedowns, no fighter not in the bout, no bout not on the card (${bad.join(', ')})`);
const mine = await (await call('/api/ufc-lines', { headers: { 'x-entry-key': KEY } })).json();
const hp = (mine.props || []).find((x) => x.fighter_id === HOOKER) || {};
ok(hp.sig_line === 40.5 && hp.td_line === 1.5, `GET returns both (${hp.sig_line}, ${hp.td_line})`);
ok((await (await call('/api/ufc-lines', { headers: { 'x-entry-key': 'z'.repeat(24) } })).json()).error, 'another key is refused');
b = await get('/api/ufc-board');
ok(!/sig_line|td_line/.test(JSON.stringify(b)), 'the public board does not show the typed lines');

console.log('-- the five-minute cron logs every fighter --');
await fire(MAIN_CRON);
const logged = sq.prepare("SELECT * FROM ufcprops WHERE event_id = '600061665'").all();
const hl = logged.find((x) => x.fighter_id === HOOKER) || {};
ok(logged.length === 24 && logged.every((x) => x.sig_mean > 0 && x.sig_mid != null && x.td_p05 != null && x.graded_at == null), `the card's 24 fighters logged with their projections (${logged.length})`);
ok(hl.sig_line === 40.5 && hl.sig_p_over === sigP && hl.fights === 1, `Hooker's line priced on the log: ${hl.sig_p_over}% at ${hl.sig_line}`);

console.log('-- UFC 334, Nov 14: graded with the bout --');
const bi = sq.prepare(`INSERT INTO ufcbouts (bout_id, event_id, event, date, commence, rounds, weight, f1_id, f1, f2_id, f2, first_at)
  VALUES (?, ?, 'UFC 334', ?, ?, ?, ?, ?, ?, ?, ?, '2026-11-13T00:00:00Z')`);
bi.run('401922638', '600061400', '2026-11-14', '2026-11-15T02:00:00.000Z', 5, "Women's Bantamweight", '2516131', 'Amanda Nunes', '4332765', 'Kayla Harrison');
bi.run('401922643', '600061400', '2026-11-14', '2026-11-15T00:00:00.000Z', 3, 'Lightweight', '4425604', 'Terrance McKinney', '2335718', 'Jim Miller');
bi.run('401999999', '600061400', '2026-11-12', '2026-11-12T00:00:00.000Z', 3, 'Lightweight', '1', 'Called Off', '2', 'Not Fought');
const pi = sq.prepare(`INSERT INTO ufcprops (bout_id, fighter_id, event_id, date, commence, name, fights, sig_mean, sig_mid, sig_p_mid, td_mean, td_p05, sig_line, sig_p_over, td_line, td_p_over, first_at)
  VALUES (?, ?, '600061400', '2026-11-14', ?, ?, 3, ?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-11-13T00:00:00Z')`);
// Harrison landed 25 strikes and 3 takedowns, Nunes 31 and 2, McKinney 19 and 0, Miller 16 and 0.
pi.run('401922638', '4332765', '2026-11-15T02:00:00.000Z', 'Kayla Harrison', 30, 29.5, 48, 1.5, 70, 20.5, 60, 2.5, 45);   // Over 60 lands; Less 55 does not
pi.run('401922638', '2516131', '2026-11-15T02:00:00.000Z', 'Amanda Nunes', 28, 27.5, 49, 1, 55, 35.5, 40, null, null);   // Less 60 lands
pi.run('401922643', '4425604', '2026-11-15T00:00:00.000Z', 'Terrance McKinney', 20, 19.5, 49, 0.4, 30, 15.5, 52, null, null); // Over 52 lands
pi.run('401922643', '2335718', '2026-11-15T00:00:00.000Z', 'Jim Miller', 18, 17.5, 47, 0.3, 25, null, null, 0.5, 30);     // Less 70 lands
pi.run('401999999', '1', '2026-11-12T00:00:00.000Z', 'Called Off', 30, 29.5, 49, 1, 50, 10.5, 90, null, null);
NOW = RealDate.parse('2026-11-15T10:00:00Z');
await fire(MAIN_CRON);
const gp = Object.fromEntries(sq.prepare("SELECT * FROM ufcprops WHERE event_id = '600061400'").all().map((x) => [x.fighter_id, x]));
ok(gp['4332765'].sig_landed === 25 && gp['4332765'].td_landed === 3 && gp['4332765'].method === 'sub' && gp['2335718'].td_landed === 0 && gp['2335718'].method === 'ko',
  `graded from UFC 334's fight center: Harrison ${gp['4332765'].sig_landed} and ${gp['4332765'].td_landed} (${gp['4332765'].method}), Miller ${gp['2335718'].td_landed} takedowns (${gp['2335718'].method})`);
ok(gp['1'].method === 'off' && gp['1'].graded_at, 'the fighter of a bout on no card two days on is off');
NOW += 16 * 60e3;
b = await get('/api/ufc-board');
const pr = b.propsRecord || {};
ok(pr.sig && pr.sig.atPp.n === 3 && pr.sig.atPp.hit === 3 && pr.td.atPp.n === 2 && pr.td.atPp.hit === 1,
  `at the typed lines: strikes ${pr.sig && pr.sig.atPp.hit} of ${pr.sig && pr.sig.atPp.n}, takedowns ${pr.td && pr.td.atPp.hit} of ${pr.td && pr.td.atPp.n}`);
ok(pr.sig.atMid.n === 4 && pr.sig.atMid.over === 1 && pr.td.at05.n === 4 && pr.td.at05.over === 2 && pr.td.at05.shown === 45,
  `the model's own lines: strikes More at the 50/50 ${pr.sig.atMid.over} of ${pr.sig.atMid.n}; a takedown at 0.5 shown ${pr.td.at05.shown}%, landed ${pr.td.at05.over} of ${pr.td.at05.n}`);
ok(pr.sig.proj.n === 4 && pr.sig.proj.shown === 24 && pr.sig.proj.landed === 22.8, `projected v landed: ${pr.sig.proj.shown} v ${pr.sig.proj.landed} strikes (${pr.sig.proj.n})`);

console.log('-- a finished card shows what was projected --');
card = 'nov14';
NOW = RealDate.parse('2026-11-20T21:00:00Z');               // after the last read of the Nov 21 card
b = await get('/api/ufc-board');
const hn = b.bouts.find((x) => x.id === '401922638') || {};
ok(hn.result && hn.projected && hn.projected['4332765'] && hn.projected['4332765'].sig === 30 && hn.projected['2516131'].td === 1 && hn.props === null,
  `Harrison v Nunes, over: projected ${JSON.stringify(hn.projected)}, no chances on a finished fight`);

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
