// The Hot cards' order once every stat joined (2026-11-19, the Nov 19 page check). The worker lists
// soft runs longest first, so on Nov 19 four of the NBA card's five were stats added Nov 18 (no
// side, "not tested"), and Deni Avdija's threes, the one run with a side ("Under about 57%"), came
// fifth. What has to hold:
//   - on the soft-team view, a player with a run on a replayed stat comes before one without;
//     otherwise the worker's order, and a player ESPN lists out still last
//   - a player's run shown first is a replayed one when he has one
//   - "Show every run" keeps the worker's order
//   - soccer the same with its replayed stats; the NHL, with no percentage on any stat, unchanged
//
// Real data: the site's own /api/nba-pp and /api/hot-players (soccer, NHL) responses, read the
// morning of Nov 19. The one built case (a player with both kinds of soft run, which no list had
// that day) is two real rows from the same NBA response put on one player.
import fs from 'node:fs';
import path from 'node:path';
const BOARD = path.join(import.meta.dirname, '..');
const read = (f) => JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', f), 'utf8'));
const NBA = read('nba-pp-20261119.json').hot, SOC = read('hot-soccer-20261119.json').hot, NHL = read('hot-nhl-20261119.json').hot;
let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

const app = fs.readFileSync(BOARD + '/app.js', 'utf8').replace(/\r\n/g, '\n');
const sect = app.slice(app.indexOf('  // ---- Hot players'), app.indexOf('  function renderNba('));
const state = { nbaPp: { hot: NBA }, nbaHotAll: false, hot: { soccer: SOC, nhl: NHL }, hotAll: { soccer: false, nhl: false } };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const nbaNick = (name) => String(name || '').trim().split(/\s+/).pop();
const sharpTag = (p) => (typeof p === 'number' ? `<span class="tc-sharp">sharp ${Math.round(p)}%</span>` : '');
const miniBar = new Function(`${app.match(/  function miniBar\(fill, tick, axisPct\) \{[\s\S]*?\n  \}\n/)[0]} return miniBar;`)();
const OUT_FNS = new Function(app.match(/const injOut = .*\n/)[0] + app.match(/const outLast = .*\n/)[0] + 'return [injOut, outLast];')();
const [injOut] = OUT_FNS;
const [nbaCard, card] = new Function('state', 'esc', 'nbaNick', 'sharpTag', 'miniBar', 'avatarHtml', 'soccerKick', 'nbaCardInjTag', 'injOut', 'outLast', `${sect}\nreturn [nbaHotCardHtml, hotCardHtml];`)(
  state, esc, nbaNick, sharpTag, miniBar, (o) => `<span class="hs" data-id="${o.playerId}"></span>`, () => '5:10 PM', () => '', ...OUT_FNS);
// Each listed player and the stat of the first run under him, in page order.
const shown = (h) => h.split('<li>').slice(1).map((li) => ({ name: (/<span class="tc-l1"><b>([^<]+)<\/b>/.exec(li) || [])[1], first: (/<span class="hot-line"><b>([^<]+)<\/b>/.exec(li) || [])[1], li }));
const soft = (m) => m.third === 'soft';
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const softPlayers = (h) => [...h.players].sort((a, b) => injOut(a) - injOut(b)).filter((p) => p.markets.some(soft));

console.log('-- NBA, Nov 19 --');
const nbaRated = (m) => m.tested !== false;
const nbaSoft = softPlayers(NBA);
console.log(`  the worker's soft order: ${nbaSoft.map((p) => `${p.name} (${p.markets.filter(soft).map((m) => m.market + (nbaRated(m) ? '' : '*')).join(', ')})`).join(' · ')}   (* added Nov 18)`);
ok(nbaSoft.length === 6 && nbaSoft.slice(0, 4).every((p) => !p.markets.some((m) => soft(m) && nbaRated(m))) && nbaSoft[4].name === 'Deni Avdija' && nbaSoft[4].markets.some((m) => soft(m) && nbaRated(m)),
  'the list as sent: four runs on new stats first, Avdija\'s threes fifth, Lillard\'s shot attempts sixth');
let five = shown(nbaCard());
console.log(`  the card: ${five.map((x) => `${x.name} (${x.first})`).join(' · ')}`);
ok(five.map((x) => x.name).join(', ') === 'Deni Avdija, Cedric Coward, Javon Small, Jaden McDaniels, LJ Cryer', 'Avdija first, the four after him in the list\'s own order, Lillard behind the tap');
ok(five[0].first === 'Threes' && /Chance at PrizePicks' number: Under about \d+%/.test(text(five[0].li)), `his threes lead, with its chance at PrizePicks' number ("${(/Chance at PrizePicks' number: [^·]*?%/.exec(text(five[0].li)) || [''])[0]}")`);
ok(five.slice(1).every((x) => /not tested, so no side/i.test(x.li)), 'the four after him say not tested, so no side');
state.nbaHotAll = true;
const every = shown(nbaCard());
ok(every.map((x) => x.name).join('|') === [...NBA.players].sort((a, b) => injOut(a) - injOut(b)).map((p) => p.name).join('|'), `"Show every run" keeps the list's order (${every.length} players)`);
state.nbaHotAll = false;
// Built from real rows: Lillard's soft shot-attempts run put ahead of Avdija's own threes.
const lil = NBA.players.find((p) => p.name === 'Damian Lillard'), avd = NBA.players.find((p) => p.name === 'Deni Avdija');
const lilFga = lil.markets.find((m) => soft(m) && !nbaRated(m)), avdThrees = avd.markets.find((m) => soft(m) && nbaRated(m));
state.nbaPp = { hot: { ...NBA, players: NBA.players.map((p) => (p === avd ? { ...avd, markets: [lilFga, ...avd.markets] } : p)) } };
const mixed = shown(nbaCard()).find((x) => x.name === 'Deni Avdija');
ok(lilFga && avdThrees && mixed && mixed.first === 'Threes' && /Also on a run: FG attempted/.test(mixed.li), 'a player with a new-stat run listed first leads with his tested one, the other named under it');
state.nbaPp = { hot: NBA };

console.log('\n-- soccer, Nov 19 --');
const REPLAYED = new Set(['shots', 'sot', 'passes', 'tackles', 'clear', 'fouls', 'saves']);
const socSoft = softPlayers(SOC);
const sFive = shown(card('soccer'));
console.log(`  the list: ${socSoft.slice(0, 6).map((p) => `${p.name} (${p.markets.filter(soft).map((m) => m.market).join(', ')})`).join(' · ')}`);
console.log(`  the card: ${sFive.map((x) => `${x.name} (${x.first})`).join(' · ')}`);
const socWant = [...socSoft.filter((p) => p.markets.some((m) => soft(m) && REPLAYED.has(m.market))), ...socSoft.filter((p) => !p.markets.some((m) => soft(m) && REPLAYED.has(m.market)))].slice(0, 5).map((p) => p.name);
ok(socSoft[2].name === 'Idan Toklomati' && sFive.map((x) => x.name).join('|') === socWant.join('|') && !sFive.some((x) => x.name === 'Idan Toklomati'),
  'Toklomati\'s fouls drawn (added Nov 18) was third; the five are the replayed runs, in the list\'s order');
ok(sFive.every((x) => /Run goes on: about/.test(x.li)), 'each of the five with its "run goes on"');

console.log('\n-- NHL, Nov 19 --');
const nFive = shown(card('nhl'));
ok(nFive.map((x) => x.name).join('|') === softPlayers(NHL).slice(0, 5).map((p) => p.name).join('|'), `no percentage on any NHL stat: the list's own order (${nFive.map((x) => x.name).join(', ')})`);

// The averages (Nov 19, the user's call): the NHL and soccer lists send two decimals ("19.88
// season", "0.79 last season") where the NBA card shows one. One decimal, but two where one would
// round onto a game the run beat: Robin Koch's fouls, 0.97 last season, beaten by starts of 1.
console.log('\n-- the averages, every run --');
state.hotAll = { soccer: true, nhl: true };
const avgs = (h) => [...text(h).matchAll(/last five, ([\d.]+) (?:last )?season/g)].map((x) => x[1]);
const nAll = card('nhl'), sAll = card('soccer');
const n1988 = NHL.players.find((p) => p.markets.some((m) => m.seasonAvg === 19.88));
const n1988li = shown(nAll).find((x) => x.name === (n1988 && n1988.name));
ok(n1988li && /last five, 19\.9 season/.test(text(n1988li.li)) && !/19\.88/.test(n1988li.li), `${n1988 && n1988.name}'s 19.88 reads 19.9`);
const long = [...avgs(nAll), ...avgs(sAll)].filter((v) => /\.\d\d/.test(v));
console.log(`  ${avgs(nAll).length} NHL and ${avgs(sAll).length} soccer averages; two decimals on: ${long.join(', ') || 'none'}`);
ok(avgs(nAll).length === NHL.players.reduce((s, p) => s + p.markets.length, 0) && avgs(sAll).length === SOC.players.reduce((s, p) => s + p.markets.length, 0) && long.join() === '0.97',
  'every NHL and soccer average to one decimal but Koch\'s');
const koch = shown(sAll).find((x) => x.name === 'Robin Koch'), kochM = SOC.players.find((p) => p.name === 'Robin Koch').markets.find((m) => m.market === 'fouls');
ok(koch && kochM.lastSeason === 0.97 && kochM.last10.some((v, i) => v === 1 && kochM.up[i] === 1) && /Fouls · \d+ in a row · [\d.]+ last five, 0\.97 last season/.test(text(koch.li)) && /above last season's 0\.97/.test(koch.li),
  'Koch\'s fouls keep 0.97, on the line and under the boxes, where "1" would sit over his filled 1s');
state.hotAll = { soccer: false, nhl: false };
state.nbaHotAll = true;
const nbaWant = [...NBA.players].sort((a, b) => injOut(a) - injOut(b)).flatMap((p) => p.markets.map((m) => String(m.lastSeason != null ? m.lastSeason : m.seasonAvg)));
ok(avgs(nbaCard()).join() === nbaWant.join(), `the NBA card's averages as sent (${nbaWant.slice(0, 4).join(', ')}…)`);
state.nbaHotAll = false;

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
