// The ?v= on style.css and app.js has to match what is in those files.
//
// index.html asks for them as style.css?v=... and app.js?v=..., which is this
// project's cache-busting mechanism: a returning browser only re-fetches when
// the query string changes. The version was last bumped on 2026-09-01 and the
// two files changed in eight commits after that — sport icons, the PrizePicks
// line, the Pinnacle-gap flags, the soccer tab, the sticky sport tabs, the
// soccer moneyline. Anyone whose browser had cached the September 1st copy
// could still be looking at it, which is exactly how "I shipped that on Monday"
// meets "it is not on my phone".
//
// The version is the first ten hex characters of sha256(style.css + app.js), so
// it cannot be forgotten: change either file and this fails until it is updated,
// and the failure prints the value to paste in.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const BOARD = path.join(import.meta.dirname, '..');

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

const h = crypto.createHash('sha256');
for (const f of ['style.css', 'app.js']) h.update(fs.readFileSync(path.join(BOARD, f)));
const want = h.digest('hex').slice(0, 10);

const html = fs.readFileSync(path.join(BOARD, 'index.html'), 'utf8');
const refs = [...html.matchAll(/(style\.css|app\.js)\?v=([A-Za-z0-9]+)/g)].map((m) => ({ file: m[1], v: m[2] }));

console.log(`\n   content hash: ${want}`);
console.log(`   index.html:   ${refs.map((r) => r.file + '?v=' + r.v).join('  ')}\n`);

ok(refs.length === 2, `both assets are referenced with a version (${refs.length})`);
const stale = refs.filter((r) => r.v !== want);
ok(stale.length === 0, stale.length
  ? `STALE CACHE BUSTER: ${stale.map((r) => r.file + '?v=' + r.v).join(', ')} — style.css or app.js changed. Set both to ?v=${want}`
  : `the version matches the files it is busting (?v=${want})`);

// Both must carry the SAME version, or one can update while the other does not
// and the page runs new script against old styles.
ok(new Set(refs.map((r) => r.v)).size === 1,
  `both are on the same version, so they can never go out of step (${[...new Set(refs.map((r) => r.v))].join(', ')})`);

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exitCode = fail ? 1 : 0;
