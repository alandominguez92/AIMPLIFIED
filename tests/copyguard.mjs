// The methodology page says only what the record shows (2026-10-12).
//
// It called batter unders "the one market our graded results show a real
// edge" while those unders stood at -1.3% ROI on 2,776 graded (p about 0.47),
// and said moneylines are context, not posted, while the moneyline board tiers
// T1-T3 picks and the record counts them as posted. Neither statement errored;
// both just read as true. Pinned here:
//   - no claim of a real or proven edge
//   - the moneyline is not described as unposted
//   - edge is signed: "positive means value" cannot sit beside an absolute value
import fs from 'node:fs';
import path from 'node:path';
const BOARD = path.join(import.meta.dirname, '..');
const html = fs.readFileSync(BOARD + '/methodology.html', 'utf8');
const text = html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

const sentences = text.split(/(?<=[.!?])\s+/);
const edgeClaim = sentences.filter((s) => /\b(real|proven|graded) edge\b|show(s)? (a|an) (real )?edge\b|one edge\b/i.test(s));
ok(!edgeClaim.length, edgeClaim.length ? `claims an edge the record does not show: "${edgeClaim[0].slice(0, 120)}"` : 'no claim of an edge the record does not show');

const mlUnposted = sentences.filter((s) => /moneyline/i.test(s) && /(don't|do not|never|not) post/i.test(s));
ok(!mlUnposted.length, mlUnposted.length ? `says the moneyline is not posted: "${mlUnposted[0].slice(0, 120)}"` : 'does not call the moneyline unposted');
ok(/moneyline board<\/b> posts plays/i.test(html), 'and says the moneyline board posts plays');

const formula = (html.match(/<div class="formula">([^<]*)<\/div>/) || [])[1] || '';
ok(formula && !formula.includes('|'), `the edge formula is signed (${formula.trim()})`);

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
