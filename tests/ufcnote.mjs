// The UFC tab says "prices as of" only when its card has a price (2026-11-23 phone check).
//
// The board's mlAsOf is the last moneyline read, and it stays on the card it was read for. After
// UFC Fight Night: Prochazka vs. Stirling (Nov 21), the next card, Adesanya vs Magomedov on Dec 5,
// came up on the tab with none of its 14 fights priced (moneylines are read from 36 hours before
// the first fight), and the line under the heading said "prices as of Sat 9:35 AM": last
// Saturday's read, for the card before. What has to hold:
//   - a card with prices says "prices as of" the read
//   - a card with none yet says when they are read
//   - a finished card (every fight over, prices gone) says neither
//
// Real data, production's /api/ufc-board as read: Nov 20 at 5:45 PM Pacific (the Nov 21 card, 11 of
// 12 fights priced), Nov 21 at 4:36 PM (that card over, no prices left) and Nov 23 at 10:40 PM
// (the Dec 5 card, none priced, mlAsOf still Nov 21's).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOARD = path.join(HERE, '..');
const read = (f) => JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', f), 'utf8'));
const PRE = read('ufc-board-20261120.json'), POST = read('ufc-board-20261121.json'), NEXT = read('ufc-board-20261123.json');

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fail++; };

const app = fs.readFileSync(path.join(BOARD, 'app.js'), 'utf8').replace(/\r\n/g, '\n');
function lift(name) {
  const at = app.indexOf(`function ${name}(`);
  if (at < 0) throw new Error(`app.js has no ${name}`);
  let depth = 0;
  for (let i = at; i < app.length; i++) {
    const c = app[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return app.slice(at, i + 1); }
  }
  throw new Error(`could not close ${name}`);
}

const priced = (d) => d.bouts.filter((b) => b.ml && b.fighters.some((f) => b.ml[f.id] && b.ml[f.id].fair != null)).length;
console.log('-- the real reads --');
ok(PRE.event.name.startsWith('UFC Fight Night: Proch') && PRE.bouts.length === 12 && priced(PRE) === 11 && PRE.bouts.every((b) => b.state === 'pre'),
  'Nov 20: the Nov 21 card, 11 of its 12 fights priced, none started');
ok(POST.event.name === PRE.event.name && priced(POST) === 0 && POST.bouts.every((b) => b.state === 'post') && POST.mlAsOf === '2026-11-21T17:35:51.646Z',
  'Nov 21: the same card over, no prices left, last read 9:35 AM Pacific that day');
ok(NEXT.event.name === 'UFC Fight Night: Adesanya vs Magomedov' && NEXT.event.date.startsWith('2026-12-05') && NEXT.bouts.length === 14
  && priced(NEXT) === 0 && NEXT.bouts.every((b) => b.state === 'pre') && NEXT.mlAsOf === POST.mlAsOf,
  'Nov 23: the Dec 5 card, none of its 14 fights priced, mlAsOf still the Nov 21 read');

// renderUfc as the page has it, with the bout and record markup left out (not what this is about).
const els = {};
const document = { getElementById: (id) => (els[id] = els[id] || { id, textContent: '', innerHTML: '' }) };
const state = {};
const esc = (s) => String(s == null ? '' : s);
const soccerKick = (iso) => `KICK(${iso})`;
const UFC_VIEWS = { time: 'Fight time', sig: 'Sig. strikes', td: 'Takedowns' };
const ufcView = () => 'time';
const ufcRecordHtml = () => '';
const ufcBoutHtml = () => '';
const renderUfc = new Function('document', 'state', 'esc', 'soccerKick', 'UFC_VIEWS', 'ufcView', 'ufcRecordHtml', 'ufcBoutHtml',
  `${lift('renderUfc')}\nreturn renderUfc;`)(document, state, esc, soccerKick, UFC_VIEWS, ufcView, ufcRecordHtml, ufcBoutHtml);
const noteFor = (d) => { state.ufc = d; els.ufcNote = null; renderUfc(); return document.getElementById('ufcNote').textContent; };

console.log('\n-- the line under the heading --');
const pre = noteFor(PRE);
ok(pre.includes(`prices as of KICK(${PRE.mlAsOf})`) && !/36 hours/.test(pre), `a priced card: "prices as of" its read ("${pre}")`);
const next = noteFor(NEXT);
ok(!/prices as of/.test(next), `the next card, none priced: no "prices as of" last Saturday ("${next}")`);
ok(/moneylines are read from 36 hours before the first fight/.test(next) && next.startsWith('UFC Fight Night: Adesanya vs Magomedov'),
  'it says when they are read instead');
const post = noteFor(POST);
ok(!/prices as of/.test(post) && !/36 hours/.test(post) && post.startsWith(POST.event.name), `a finished card says neither ("${post}")`);
ok(els.ufcCount && els.ufcCount.textContent === '12 fights', 'the count beside the heading is unchanged');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
