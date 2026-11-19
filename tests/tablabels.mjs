// The sport tabs' sub-labels on a desktop screen (2026-11-19, the user's call). Since step 7 of the
// page brief the NBA, NHL, NFL and soccer tabs open on props legs, then the moneylines, but their
// labels still read "Game Lines", "Moneyline" and "Game Context".
import fs from 'node:fs';
import path from 'node:path';
const BOARD = path.join(import.meta.dirname, '..');
let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
const html = fs.readFileSync(BOARD + '/index.html', 'utf8');
const label = (sport) => (new RegExp(`data-sport="${sport}"[^>]*>[\\s\\S]*?<span class="mini">([^<]*)</span>`).exec(html) || [])[1];
for (const sport of ['nba', 'nhl', 'nfl', 'soccer']) ok(label(sport) === 'Props + ML', `${sport}: "${label(sport)}"`);
// The others say what they hold already.
ok(label('picks') === 'Most Likely' && label('mlb') === 'Model + Picks' && label('entries') === 'Your Bets', 'Picks, MLB and Entries as they were');
console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
