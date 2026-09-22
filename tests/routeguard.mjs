// Every route handleApi answers must be in API_ROUTES.
//
// fetch() checks that Set first and hands anything missing to env.ASSETS, so a
// route added to handleApi alone is not "unrouted" in a way anyone would
// notice while writing it — it is a plain 404 from the static site, with no
// worker header on it and nothing in the logs. /api/pppicks-export shipped that
// way and read as a failed deploy for ten minutes.
//
// This reads the source rather than calling the worker, because the point is to
// catch the route nobody thought to write a test for.
import fs from 'node:fs';
import path from 'node:path';
const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'worker.js'), 'utf8');

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

const setBlock = (src.match(/const API_ROUTES = new Set\(\[([\s\S]*?)\]\);/) || [])[1] || '';
const allowed = new Set([...setBlock.matchAll(/'(\/api\/[a-z0-9-]+)'/g)].map((m) => m[1]));

// Everything handleApi dispatches on. Both spellings appear in the file:
// `p === '/api/x'` and the write-route list up in fetch().
const handled = new Set([...src.matchAll(/\bp === '(\/api\/[a-z0-9-]+)'/g)].map((m) => m[1]));

console.log(`  ${allowed.size} allowed, ${handled.size} handled\n`);
ok(allowed.size > 0 && handled.size > 0, `both lists were actually parsed out of the source (${allowed.size}/${handled.size})`);

const unrouted = [...handled].filter((r) => !allowed.has(r)).sort();
ok(!unrouted.length, `every handled route is reachable${unrouted.length ? ' — MISSING FROM API_ROUTES: ' + unrouted.join(', ') : ''}`);

// The other direction is a smaller problem (a dead allowlist entry 404s from
// handleApi's fallthrough) but it means the two have drifted.
// /api/odds is handleApi's fallthrough — it has no `p === ` of its own, the
// function just ends in the proxy call. Everything else needs a real branch.
const FALLTHROUGH = '/api/odds';
ok(/return proxy\(`\$\{ODDS\}\/odds\?/.test(src), `the fallthrough route is still the one this test exempts (${FALLTHROUGH})`);
const unhandled = [...allowed].filter((r) => !handled.has(r) && r !== FALLTHROUGH).sort();
ok(!unhandled.length, `no allowlist entry without a handler${unhandled.length ? ' — ORPHANED: ' + unhandled.join(', ') : ''}`);

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
