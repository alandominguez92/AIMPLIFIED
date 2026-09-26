// Does ranking by confidence beat taking one of everything?
//
// Split by market, three days of PrizePicks legs clear nothing: H+R+RBI 53.7%,
// total bases 52.4%, strikeouts 39.6%, everything together 51.5%. Pooled across
// markets and ranked by the model's own probability, the top three legs of a day
// ran 77.8%. Nine legs is a hypothesis, not a finding — this is the instrument
// for testing it, read-only over rows already logged.
//
// What has to be right or the instrument lies:
//   - the ranking is per DAY, not across the whole history. Ranked globally, the
//     top three would be three legs from one good Saturday and the number would
//     measure that Saturday.
//   - a leg that pushed or voided is neither a hit nor a miss and must not sit in
//     a band taking a slot a real leg could have had.
//   - MLB ranks on a model probability and the others on a gap to a sharp line.
//     Those are different claims; reporting them under one word would hide which
//     one was actually tested.
import fs from 'node:fs';
import path from 'node:path';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };

// Two days. Day one: the three best legs all land, the rest miss. Day two the
// same. Ranked per day the top 3 is 6/6; taking everything is 6/14. If the
// ranking were global the bands would read differently, and a pushed leg sitting
// in the top three would drag it to 5/6.
const pp = [];
const mk = (date, id, prob, result, market) => ({
  date, game_id: 'g' + id, player_id: id, player: 'P' + id, team: 'CIN',
  market: market || 'hrr', point: 1.5, model_under: prob, close_model_under: prob,
  close_point: 1.5, actual: 1, result, model_ver: 'pp-v1',
});
for (const date of ['2026-09-20', '2026-09-21']) {
  const tag = date.endsWith('20') ? 0 : 100;
  // best three hit
  pp.push(mk(date, tag + 1, 78, 'under', 'tb'), mk(date, tag + 2, 71, 'under', 'hrr'), mk(date, tag + 3, 66, 'under', 'K'));
  // then four that miss
  pp.push(mk(date, tag + 4, 58, 'over'), mk(date, tag + 5, 55, 'over'), mk(date, tag + 6, 52, 'over'), mk(date, tag + 7, 44, 'over'));
}
// A push and a void: neither is a result, and both are ranked high enough that a
// grader counting them would put them in the top three.
pp.push({ ...mk('2026-09-20', 900, 99, 'push', 'tb') });
pp.push({ ...mk('2026-09-20', 901, 98, null, 'hrr'), actual: null });
// A leg whose player sat: graded 'void'. Ranked second that day, it is exactly
// the kind of leg the played-only bands hide.
pp.push({ ...mk('2026-09-20', 902, 97, 'void', 'tb'), actual: null });

// Today's ungraded legs, dated the way the worker dates its slate. Two share a
// game (g500, one from each club) and one stands alone, so the same-game count
// has something real to find.
const todayYmd = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
pp.push({ ...mk(todayYmd, 501, 70, null, 'tb'), game_id: 'g500', team: 'SEA', actual: null });
pp.push({ ...mk(todayYmd, 502, 68, null, 'hrr'), game_id: 'g500', team: 'LAA', actual: null });
pp.push({ ...mk(todayYmd, 503, 66, null, 'tb'), game_id: 'g600', team: 'HOU', actual: null });

const gm = [
  // soccer, ranked on edge rather than on a model probability
  { sport: 'soccer', date: '2026-09-20', game_id: 's1', market: 'h2h', league: 'epl', side: 'home', pick: 'Liverpool',
    home: 'Liverpool', away: 'Bournemouth', win_prob: 54, implied: 48, edge: 6.0, entry_price: 110, close_price: 110, result: 'win' },
  { sport: 'soccer', date: '2026-09-20', game_id: 's2', market: 'h2h', league: 'epl', side: 'draw', pick: 'Draw',
    home: 'Arsenal', away: 'Chelsea', win_prob: 26, implied: 27, edge: -1.0, entry_price: 260, close_price: 260, result: 'loss' },
  { sport: 'nfl', date: '2026-09-20', game_id: 'n1', market: 'h2h', league: 'REG', week: 3, side: 'home', pick: 'LA',
    home: 'LA', away: 'NYG', win_prob: 72, implied: 70, edge: 2.0, entry_price: -230, close_price: -230, result: 'win' },
];

const db = {
  prepare: (sql) => {
    const st = { sql, args: [], bind: (...x) => { st.args = x; return st; },
      run: async () => ({ meta: { changes: 1 } }), first: async () => null,
      all: async () => {
        if (/FROM pppicks/i.test(sql)) return { results: pp };
        if (/FROM gmpicks/i.test(sql)) {
          const want = st.args[0];
          return { results: want ? gm.filter((r) => r.sport === want) : gm };
        }
        return { results: [] };
      } };
    return st;
  },
  batch: async () => [],
};

const src = fs.readFileSync(BOARD + '/worker.js', 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const hit = async (u) => (await mod.default.fetch(new Request('https://x' + u), { DB: db }, { waitUntil() {} })).json();

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

const m = await hit('/api/top-legs?sport=mlb');
console.log('  mlb bands: ' + Object.entries(m.bands).map(([k, v]) => `${k} ${v.hit}/${v.n}=${v.hitRate}%`).join('  ') + '\n');

ok(m.bands['top 3'].n === 6 && m.bands['top 3'].hitRate === 100,
  `the top three of each DAY, not of the history — two days, six legs, all winners (${m.bands['top 3'].hit}/${m.bands['top 3'].n})`);
ok(m.bands.everything.n === 14 && m.bands.everything.hitRate < 50,
  `taking everything is the comparison, and it is worse (${m.bands.everything.hit}/${m.bands.everything.n} = ${m.bands.everything.hitRate}%)`);
ok(m.bands['top 3'].hitRate > m.bands.everything.hitRate,
  'which is the whole question: does ranking beat taking one of everything');
ok(m.bands['top 3'].voided === 1 && m.bands['top 3'].slots === 6 && m.bands.everything.voided === 1,
  `a leg that never played is counted against the band it would have sat in (top 3: ${m.bands['top 3'].voided} of ${m.bands['top 3'].slots} slots voided)`);
ok(m.bands['top 3'].n === 6 && m.bands['top 3'].hit === 6,
  'while the played-only record is unchanged, so both readings are there side by side');
ok(m.graded === 14, `a push and an ungraded leg are neither hit nor miss and take no slot (${m.graded} graded of ${m.logged} logged)`);
ok(!JSON.stringify(m.byDay).includes('P900') && !JSON.stringify(m.byDay).includes('P901'),
  'and neither appears in a day\'s top legs, though both outrank every real one');
ok(Array.isArray(m.bands['top 3'].clears) && m.bands['top 3'].clears.includes('2-pick power'),
  `each band says which entry break-evens it clears (${(m.bands['top 3'].clears || []).join(', ')})`);
ok(m.byDay.length === 2 && m.byDay.every((d) => d.top.length && d.top[0].score >= d.top[d.top.length - 1].score),
  'and each day lists its best legs, best first, to be read rather than trusted');

// The sports are not the same experiment and the payload has to say so.
const sc = await hit('/api/top-legs?sport=soccer');
const nf = await hit('/api/top-legs?sport=nfl');
console.log('\n  mlb    rankedBy: ' + m.rankedBy);
console.log('  soccer rankedBy: ' + sc.rankedBy + '\n');
ok(/model/.test(m.rankedBy) && /sharp/.test(sc.rankedBy) && sc.rankedBy !== m.rankedBy,
  'MLB ranks a model probability, soccer a gap to a sharp line — named apart, because they fail differently');
ok(sc.graded === 2 && sc.bands['top 3'].hit === 1,
  `soccer ranks on edge: the +6.0 won, the -1.0 lost (${sc.bands['top 3'].hit}/${sc.bands['top 3'].n})`);
ok(nf.graded === 1 && !JSON.stringify(nf.byDay).includes('Liverpool'),
  'and the sports do not bleed into each other');
ok(/LOGGED ONLY/.test(m.note) && /nothing shown on the site/.test(m.note),
  'nothing here is posted or shown — it is an instrument');

// Today's legs carry their club and game, and count how many of the list share
// that game, so a check can warn about stacking one game into an entry.
const byLeg = Object.fromEntries((m.today || []).map((t) => [String(t.leg).split(' ')[0], t]));
console.log('\n  today: ' + (m.today || []).map((t) => `${t.leg} ${t.team} ${t.game} x${t.sameGame}`).join(' | '));
ok((m.today || []).length === 3, `today lists the three ungraded legs dated ${todayYmd} (${(m.today || []).length})`);
ok(byLeg.P501 && byLeg.P501.team === 'SEA' && byLeg.P501.game === 'g500', 'each leg says which club and game it is from');
ok(byLeg.P501 && byLeg.P502 && byLeg.P501.sameGame === 2 && byLeg.P502.sameGame === 2,
  'the two legs from one game are marked as sharing it');
ok(byLeg.P503 && byLeg.P503.sameGame === 1, 'and the leg on its own is not');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exitCode = fail ? 1 : 0;
