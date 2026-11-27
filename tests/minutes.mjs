// His minutes on the NBA and NHL legs (2026-11-17, the owner: "should we add a minutes played along
// players to get an idea on how many minutes a player plays to consider the stats?", then "yes, add
// minutes for NBA and NHL"). What has to hold:
//   - an NBA player's minutes over his last five beside his usual, on every props row and leg card;
//     4 or more apart keeps the props card's "playing more" tag (2026-11-07)
//   - an NHL skater's time on ice over his last five, as the clock reads it (26:42); goalies none
//   - the numbers are the props card's own (the worker's form row): Picks carries them for its legs
//     (picks.minutes), read after the log is written; a tab with the card loaded has them already
//   - a team leg, the NFL and soccer get none
//
// Read on recorded responses: Picks at 00:40 PT Nov 16 (Jabari Smith Jr's blocks More, Derik Queen's
// rebounds Less) and 00:04 PT Nov 14 (Jackson LaCombe's More), the NBA props card of Nov 8 and the
// NHL's of Nov 17, whose players are the form rows the worker keeps.
//
//   node tests/minutes.mjs
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n');
const src = read('app.js');
const wsrc = read('worker.js');
const J = (f) => JSON.parse(read(`tests/fixtures/${f}`));
const PK16 = J('picks-20261116-0040.json');
const PK14 = J('picks-20261114-0004.json');
const NBA = J('nba-props-board-20261108.json');
const NHL = J('nhl-props-board-20261117.json');
const RealDate = Date;
let NOW = RealDate.parse(PK16.asOf);
globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } };

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
// Ends a const at the semicolon that closes it (a bracket-only close takes in the next const too).
function lifter(code, file) {
  return (name) => {
    let at = code.indexOf(`function ${name}(`);
    const isConst = at < 0;
    if (isConst) at = code.indexOf(`const ${name} =`);
    if (at < 0) throw new Error(`${file} has no ${name}`);
    let depth = 0;
    for (let i = at; i < code.length; i++) {
      const c = code[i];
      if (c === '{' || c === '(' || c === '[') depth++;
      else if (c === '}' || c === ')' || c === ']') { depth--; if (!isConst && c === '}' && depth === 0) return (code[at - 6] === 'a' ? 'async ' : '') + code.slice(at, i + 1); }
      else if (isConst && c === ';' && depth === 0 && code[i + 1] === '\n') return code.slice(at, i + 1);
    }
    throw new Error(`could not close ${name}`);
  };
}
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const legsOf = (pk) => [...(pk.legs || []), ...(pk.ppPool || []), ...(pk.ppBench || []), ...(pk.mlPool || [])];
// Each player by his Picks leg's id, as the worker matches him (the box score's name can differ).
const byLeg = (d, pk, who) => { const l = legsOf(pk).find((x) => x.spec && x.spec.player === who); return l && d.players.find((p) => String(p.id) === String(l.spec.playerId)); };
const lacombe = byLeg(NHL, PK14, 'Jackson LaCombe');
const jabari = byLeg(NBA, PK16, 'Jabari Smith Jr'), queen = byLeg(NBA, PK16, 'Derik Queen');

console.log('-- 1. the worker: the card\'s players\' minutes, off the form rows --');
let W, asked = [];
try {
  if (!/async function picksMinutes\(/.test(wsrc)) throw new Error('worker.js has no picksMinutes');
  const wl = lifter(wsrc, 'worker.js');
  // The form rows as the trigger keeps them: the props cards' players are those rows' players.
  const rows = new Map([['pp_props_form:nba', { players: NBA.players }], ['pp_props_form:nhl', { players: NHL.players }]]);
  const loadFeedCaches = async (db, keys) => { asked.push(keys); return new Map(keys.filter((k) => rows.has(k)).map((k) => [k, rows.get(k)])); };
  const form = (/const PP_PROP_FORM = '([^']+)';/.exec(wsrc) || [])[1];
  if (form !== 'pp_props_form:') throw new Error(`the form rows' key is ${form}`);
  W = new Function('loadFeedCaches', 'PP_PROP_FORM', wl('picksMinutes') + '\nreturn { picksMinutes };')(loadFeedCaches, form);
} catch (e) { console.log(`  FAIL  picksMinutes lifts out of worker.js (${e.message})`); console.log('\n1 FAILED'); process.exit(1); }
const m16 = await W.picksMinutes(null, legsOf(PK16));
console.log('        ' + JSON.stringify(m16));
ok(m16[`nba:${jabari.id}`] && m16[`nba:${jabari.id}`].join('/') === '35.6/35' && m16[`nba:${queen.id}`].join('/') === '21.2/23.4',
  "the NBA legs' players: his last five's minutes and his usual, Jabari Smith Jr 35.6 and 35, Derik Queen 21.2 and 23.4");
ok(Object.keys(m16).every((k) => k.startsWith('nba:')) && Object.keys(m16).length === 2, 'only the players on the card, none for a moneyline or a soccer team');
ok(asked.length === 1 && asked[0].join() === 'pp_props_form:nba', 'one read, of the NBA row alone: no NHL leg on that card');
asked = [];
const m14 = await W.picksMinutes(null, legsOf(PK14));
ok(m14[`nhl:${lacombe.id}`] && m14[`nhl:${lacombe.id}`].join('/') === '26.7', "an NHL skater's time on ice over his last five, alone: Jackson LaCombe 26.7 minutes");
// The card's rows don't flag a goalie (the form row's `goalie` stays on the worker): his saves do.
const goalie = NHL.players.find((p) => p.proj && p.proj.saves != null && typeof p.min === 'number');
const formRow = { players: NHL.players.map((p) => (p === goalie ? { ...p, goalie: true } : p)) };
const Wg = new Function('loadFeedCaches', 'PP_PROP_FORM', lifter(wsrc, 'worker.js')('picksMinutes') + '\nreturn { picksMinutes };')(async () => new Map([['pp_props_form:nhl', formRow]]), 'pp_props_form:');
const gm = await Wg.picksMinutes(null, [{ spec: { sport: 'nhl', playerId: goalie.id } }]);
ok(goalie && !Object.keys(gm).length, `a goalie none (${goalie && goalie.name}'s ${goalie && goalie.min} is a whole game)`);
asked = [];
ok(!Object.keys(await W.picksMinutes(null, legsOf(PK16).filter((x) => x.kind === 'nba_ml'))).length && !asked.length, 'no player leg on the card: nothing read');

console.log('\n-- 2. the worker: read after the log, and the legs stand without it --');
const pb = wsrc.slice(wsrc.indexOf('async function picksBoard('));
const at = pb.indexOf("out.minutes = await picksMinutes(part('minutes').DB, onCard)");
ok(at > 0 && at > pb.indexOf('await logDayPicks(') && /try \{ out\.minutes = await picksMinutes\(part\('minutes'\)\.DB, onCard\); \} catch \(e\)/.test(pb),
  'set on the Picks payload after logDayPicks, inside its own try');

console.log('\n-- 3. the page: what the tag says --');
const names = ['TEAM_COLORS', 'MLB_TEAM_ID', 'NHL_PHOTO_SEASON', 'headshotUrl', 'teamMarkUrl', 'initialsOf', 'avatarHtml', 'LEG_OFFERS', 'offerLeg',
  'PICK_BOARD', 'PICK_SPORT', 'pickLeg', 'pct0', 'AM', 'soccerKick', 'pickIsTeam', 'pickTeamCode', 'pickTeamTag', 'miniBar', 'projLineHtml', 'mlChanceLineHtml', 'mlStakeTitle', 'pickBarHtml', 'RING_C', 'chanceRingSvg', 'pickFace', 'ptDayOf', 'pickMoved',
  'trendTag', 'readAgeTag', 'INJ_ROLE_WORD', 'injRoleText', 'injuryTag', 'goalieNote', 'PROP_MIN_MOVE', 'legMinutes', 'toiText', 'minutesTagHtml', 'propMinTag',
  'trendBarsHtml', 'impPct', 'priceSparkHtml', 'LINK_BOOK', 'STATE_SLOT', 'betLinkHtml', 'legLink', 'stakeTxt', 'moneyTxt', 'pickEdgeHtml',
  'nbCdf', 'r1', 'ppLineOf', 'ppChanceAt', 'pickAtLine', 'ppLineStepHtml', 'pickLineSetTag', 'shortDay', 'recSinceText',
  'PP_BREAK_EVEN', 'BOOK_LABEL', 'bkLabel', 'booksHtml', 'PICK_SAME', 'pickGameKey', 'pickShortName', 'PICK_TOP', 'pickDayWord', 'PICK_OPEN', 'legCardHtml'];
const state = { slip: {}, picks: { ...PK16, minutes: m16 }, legView: 'detailed', entrySize: 6, ppLines: {} };
let F;
try {
  if (!/function minutesTagHtml\(/.test(src)) throw new Error('app.js has no minutesTagHtml');
  F = new Function('state', 'esc', names.map(lifter(src, 'app.js')).join('\n') + '\nreturn { legMinutes, minutesTagHtml, propMinTag, legCardHtml };')(state, esc);
} catch (e) { console.log(`  FAIL  the minutes lift out of app.js (${e.message})`); console.log('\n1 FAILED'); process.exit(1); }
const tagText = (h) => text(h);
ok(tagText(F.minutesTagHtml('nba', 35.6, 35)) === '35.6 min last 5, usually 35' && /^<span class="pk-asof"/.test(F.minutesTagHtml('nba', 35.6, 35)),
  'NBA: "35.6 min last 5, usually 35", in the quiet colour');
const moved = NBA.players.find((p) => typeof p.mw === 'number' && typeof p.min === 'number' && Math.abs(p.min - p.mw) >= 4);
const mt = F.minutesTagHtml('nba', moved.min, moved.mw);
console.log(`        ${moved.name}: ${tagText(mt)}`);
ok(/^<span class="tc-wait"/.test(mt) && tagText(mt) === `playing ${moved.min > moved.mw ? 'more' : 'less'}: ${moved.min} min, usually ${moved.mw}`, '4 or more off his usual: the "playing more" tag it had, in the warning colour');
ok(tagText(F.minutesTagHtml('nba', 18.5, null)) === '18.5 min last 5', 'no usual yet (a rookie): the last five alone');
ok(tagText(F.minutesTagHtml('nhl', lacombe.min)) === '26:42 on ice last 5', 'NHL: "26:42 on ice last 5", minutes and seconds as the clock reads');
ok(tagText(F.minutesTagHtml('nhl', 19.99)) === '19:59 on ice last 5' && tagText(F.minutesTagHtml('nhl', 14)) === '14:00 on ice last 5', 'the seconds never read :60');
ok(F.minutesTagHtml('nfl', 1) === '' && F.minutesTagHtml('soccer', 90) === '', 'the NFL and soccer: none');

console.log('\n-- 4. the props card\'s rows: on every NBA and NHL row now --');
ok(text(F.propMinTag('nba', jabari)) === '35.6 min last 5, usually 35' && text(F.propMinTag('nba', queen)) === '21.2 min last 5, usually 23.4',
  "an NBA row whose minutes haven't moved says them too (it said nothing before)");
ok(text(F.propMinTag('nhl', lacombe)) === '26:42 on ice last 5' && F.propMinTag('nhl', goalie) === '', 'an NHL skater his time on ice, a goalie none');
const nhlShown = NHL.players.filter((p) => F.propMinTag('nhl', p)).length;
ok(nhlShown === NHL.players.filter((p) => !(p.proj && p.proj.saves != null) && typeof p.min === 'number').length && nhlShown >= 25,
  `the NHL card's skaters have it, its two goalies not: ${nhlShown} of ${NHL.players.length} players`);
state.props = { nhl: NHL };
ok(F.legMinutes('nhl', goalie.id) === null && F.legMinutes('nhl', lacombe.id).min === 26.7, "a leg looked up on the tab's card: a goalie none there either");
state.props = null;
ok(/\$\{propMinTag\(sport, p\)\}/.test(src.slice(src.indexOf('function propRow('), src.indexOf('function spBarHtml('))), 'the props row draws it, where it drew the "playing more" tag');

console.log('\n-- 5. the leg cards: Picks\' own legs --');
const cards = (h) => h.split('<li class="lc').slice(1);
const tagsOf = (h) => text((/<span class="lc-tags">([\s\S]*?)<\/span><\/div><div class="lc-p">/.exec(h) || ['', ''])[1]);
const jLeg = legsOf(PK16).find((x) => x.kind === 'nba_blk_more' && x.spec.playerId === jabari.id);
const qLeg = legsOf(PK16).find((x) => x.kind === 'nba_reb_gap' && x.spec.playerId === queen.id);
const ml = legsOf(PK16).find((x) => x.kind === 'nba_ml');
const jCard = F.legCardHtml(jLeg, true, '', false), qCard = F.legCardHtml(qLeg, false, '', false);
console.log(`        ${jLeg.title}: ${tagsOf(jCard)}`);
ok(tagsOf(jCard).includes('35.6 min last 5, usually 35') && tagsOf(qCard).includes('21.2 min last 5, usually 23.4'), "on Picks' NBA legs, Simple and Detailed: Picks' own numbers");
ok(!/ min last 5|on ice/.test(F.legCardHtml(ml, false, '', false)), 'a moneyline none');
const best = F.legCardHtml(jLeg, false, '', true);
ok(/<span class="lc-tags">[^]*35\.6 min last 5, usually 35/.test(best), 'the best card too');
state.picks = PK16;
state.props = { nba: NBA };
ok(tagsOf(F.legCardHtml(jLeg, true, '', false)).includes('35.6 min last 5, usually 35'), "a Picks payload without them, on a tab with the props card loaded: the card's own");
state.props = null;
ok(!/ min last 5/.test(F.legCardHtml(jLeg, true, '', false)), 'neither: no tag, and nothing guessed');

console.log('\n-- 6. the NHL tab\'s legs --');
NOW = RealDate.parse(PK14.asOf);
state.picks = PK14;
state.props = { nhl: NHL };
const lLeg = legsOf(PK14).find((x) => x.spec && x.spec.playerId === lacombe.id);
const lCard = F.legCardHtml(lLeg, true, '', false);
console.log(`        ${lLeg.title}: ${tagsOf(lCard)}`);
ok(tagsOf(lCard).includes('26:42 on ice last 5'), "LaCombe's More: his time on ice");
ok(cards(lCard).length === 1, 'one card');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
