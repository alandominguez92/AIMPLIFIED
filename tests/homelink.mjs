// The wordmark goes to Picks of the day (2026-11-11, the owner's "when ever we click the name lets
// link it to the picks page"). What has to hold:
//   1. on the main page the name is a link to / that runs the page's own switch: a tap opens Picks
//      without a reload, and on Picks already it goes back to the top
//   2. a ctrl/cmd/shift click is left to the browser (a new tab on /, which opens on Picks)
//   3. a page opened on #slate or #nflBoard loses the hash, so a reload stays on Picks
//   4. the track record, methodology and legal pages link the name to / as well, and / opens on Picks
//
// The real index.html, track-record.html, methodology.html, legal.html, style.css and app.js's own goHome.
import fs from 'node:fs';
import path from 'node:path';
const BOARD = path.join(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(BOARD, f), 'utf8').replace(/\r\n/g, '\n');
const src = read('app.js'), css = read('style.css');

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
function lift(name) {
  const at = src.indexOf(`function ${name}(`);
  if (at < 0) throw new Error(`app.js has no ${name}`);
  let depth = 0, seen = false;
  for (let i = at; i < src.length; i++) {
    const c = src[i];
    if (c === '{') { depth++; seen = true; } else if (c === '}') depth--;
    if (seen && depth === 0) return src.slice(at, i + 1);
  }
  throw new Error(`could not close ${name}`);
}

console.log('\n-- the pages --');
const head = (f) => { const h = read(f); return h.slice(h.indexOf('<header'), h.indexOf('</header>')); };
const main = head('index.html');
ok(/<a class="logo" href="\/" data-action="go-home"[^>]*>AIMPLIFIED<span>\.<\/span><\/a>/.test(main), 'the main page: the name is a link to / with the page\'s own switch');
ok(!/<div class="logo">/.test(main), 'no longer plain text');
ok(/<div class="wrap bar">\s*<a class="logo"/.test(main), 'still the first thing in the header bar');
ok(/<a href="\/"[^>]*>AIMPLIFIED<span>\.<\/span><\/a>/.test(head('track-record.html')), 'the track record page links it to /');
for (const f of ['methodology.html', 'legal.html']) {
  const nav = read(f).match(/<nav class="docnav">([\s\S]*?)<\/nav>/);
  ok(nav && /<a class="brand" href="\/">AIMPLIFIED<span class="d">\.<\/span><\/a>/.test(nav[1]), `${f} links it to /`);
  ok(nav && /<a class="back" href="\/">← Picks of the day<\/a>/.test(nav[1]), `${f}: the way back says where it goes (it said "Tonight's slate", the MLB board's name)`);
}
ok(/const START_SPORT = !LIVE_MODE \? 'mlb'\s*: \(\{ '#slate': 'mlb', '#nflBoard': 'nfl' \}\[location\.hash\] \|\| 'picks'\);/.test(src), '/ with no hash opens on Picks');
ok(/^\.logo \{ font-family:var\(--sans\); font-weight:800;/m.test(css) && /^a \{ color:inherit; text-decoration:none; \}/m.test(css),
  'it looks as it did: .logo carries the type, and links take the text colour with no underline');

console.log('\n-- a tap --');
let goHome = null;
const page = { sport: 'nba', calls: [], url: '/#slate' };
const state = { get sport() { return page.sport; } };
const setSport = (s) => { page.calls.push('setSport:' + s); page.sport = s; };
// As a browser has it: a bare "#" on the address leaves location.hash empty.
const location = { get hash() { const h = page.url.includes('#') ? page.url.slice(page.url.indexOf('#')) : ''; return h === '#' ? '' : h; },
  get href() { return 'https://aimplified.delexe.workers.dev' + page.url; }, pathname: '/', search: '' };
const history = { replaceState: (a, b, u) => { page.calls.push('replace:' + u); page.url = u; } };
const window = { scrollTo: (o) => page.calls.push('scroll:' + o.top) };
try {
  goHome = new Function('state', 'setSport', 'location', 'history', 'window', lift('goHome') + '\nreturn goHome;')(state, setSport, location, history, window);
} catch (e) { ok(false, `goHome comes from app.js: ${e.message}`); }
const click = (mods = {}) => { const e = { button: 0, ...mods, prevented: false, preventDefault() { this.prevented = true; } }; goHome(e); return e; };
if (goHome) {
  let e = click();
  ok(e.prevented && page.calls.includes('setSport:picks'), 'from NBA: Picks opens, and the page does not reload');
  ok(page.calls.includes('replace:/') && page.url === '/', 'the #slate the page was opened with is gone, so a reload stays on Picks');
  page.calls.length = 0;
  e = click();
  ok(e.prevented && page.calls.join() === 'scroll:0', 'on Picks already: back to the top, nothing redrawn');
  page.sport = 'entries'; page.calls.length = 0;
  for (const m of ['ctrlKey', 'metaKey', 'shiftKey']) {
    e = click({ [m]: true });
    ok(!e.prevented && page.calls.length === 0, `${m.replace('Key', '')}-click: left to the browser, a new tab on /`);
  }
  e = click();
  ok(page.calls.join() === 'setSport:picks', 'a plain tap from Entries: Picks, and no hash to clear');
  page.sport = 'nhl'; page.url = '/#'; page.calls.length = 0;
  e = click();
  ok(page.calls.join() === 'replace:/,setSport:picks' && page.url === '/', 'the bare "#" a sport tab leaves on the address goes too');
}
ok(/case 'go-home': goHome\(e\); break;/.test(lift('dispatchAction')), 'the page\'s click handler sends the name to goHome');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
