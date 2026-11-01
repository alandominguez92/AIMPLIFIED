// How the site shows up outside its own cards (2026-11-01). What has to hold:
//   - a shared link: the title and description name what the site is now, not
//     August's "Tonight's Sharpest MLB Fades", and the preview image exists. It
//     was asked for at /og.png and came back 404, so links shared with no picture
//   - the theme button is an icon on all three pages, named for screen readers:
//     the words "Dark mode" took a third of a phone's header, and the track
//     record's and NFL priors' buttons were empty boxes
//   - the phone's status bar follows the page's theme
//   - a separator dot is glued to the text before it, so it cannot start a line
// The worker serves the repo root (wrangler.toml's [assets]), so a file here is
// the file at that address. Real files and the real app.js's own function. What
// the dots and the status bar do on a phone was measured in the preview at 375px.
import fs from 'node:fs';
import path from 'node:path';
const BOARD = path.join(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(BOARD, f), 'utf8').replace(/\r\n/g, '\n');

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

console.log('-- a shared link --');
const html = read('index.html');
const meta = (attr, name) => (html.match(new RegExp(`<meta ${attr}="${name}" content="([^"]*)"`)) || [])[1];
const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1];
const SPORTS = ['NBA', 'NFL', 'NHL', 'MLB', 'soccer'];
console.log(`  ${title}\n  ${meta('name', 'description')}`);
ok(title === 'Aimplified — Picks of the day' && meta('property', 'og:title') === title && meta('name', 'twitter:title') === title, 'the tab, the share card and the Twitter card say the same name');
const allText = [title, meta('name', 'description'), meta('property', 'og:title'), meta('property', 'og:description'), meta('name', 'twitter:title'), meta('name', 'twitter:description')];
ok(!allText.some((t) => /MLB Slate|MLB Fades|Batter unders|batter unders/.test(t)), "none of them is still selling MLB batter unders");
ok(SPORTS.every((s) => meta('name', 'description').includes(s) && meta('property', 'og:description').includes(s) && meta('name', 'twitter:description').includes(s)), 'each description names the five sports');
ok(/21\+/.test(meta('name', 'description')), 'the page description keeps its 21+ line');
ok(SPORTS.every((s) => JSON.parse(read('manifest.webmanifest')).description.includes(s)), 'and so does the home-screen manifest');

const imgUrl = new URL(meta('property', 'og:image'));
const imgFile = path.join(BOARD, imgUrl.pathname);
const png = fs.existsSync(imgFile) ? fs.readFileSync(imgFile) : null;
const isPng = png && png.subarray(1, 4).toString() === 'PNG';
console.log(`  ${imgUrl.pathname}: ${png ? `${png.length} bytes, ${png.readUInt32BE(16)} x ${png.readUInt32BE(20)}` : 'missing'}`);
ok(isPng, `the preview image exists at the repo root, as a real PNG (${imgUrl.pathname})`);
ok(isPng && String(png.readUInt32BE(16)) === meta('property', 'og:image:width') && String(png.readUInt32BE(20)) === meta('property', 'og:image:height'), 'at the size the page declares');
ok(meta('name', 'twitter:image') === meta('property', 'og:image'), 'the Twitter card asks for the same one');
ok(!read('.assetsignore').split('\n').some((l) => /^(og\.png|\*\.png)$/.test(l.trim())), 'and it is not kept back from the deploy');

console.log('\n-- the theme button --');
const PAGES = ['index.html', 'track-record.html', 'nfl-priors.html'];
ok(PAGES.every((p) => /<button class="theme-toggle"[^>]* aria-label="Switch between light and dark mode"/.test(read(p))), 'all three pages name the button for a screen reader');
const css = read('style.css');
const rule = (sel) => (css.match(new RegExp(`(?:^|\\n)${sel.replace(/[.[\]"=:]/g, '\\$&')} \\{([^}]*)\\}`)) || [])[1] || '';
ok(/mask:url\("data:image\/svg\+xml/.test(rule('.theme-toggle::before')) && /mask-image:url\("data:image\/svg\+xml/.test(rule('[data-theme="light"] .theme-toggle::before')), 'the stylesheet draws one icon in dark mode and another in light, so no page has to fill it in');
ok(/width:40px/.test(rule('.theme-toggle')) && /height:40px/.test(rule('.theme-toggle')), 'small, and still big enough for a thumb');
const app = read('app.js');
ok(!/'Light mode'|'Dark mode'/.test(app) && !/themeToggle/.test(app), 'the board no longer writes the words into it');

console.log('\n-- the status bar --');
const fieldOf = (theme) => (css.match(new RegExp(`\\[data-theme="${theme}"\\] \\{[^}]*?--field:(#[0-9a-fA-F]+)`)) || [])[1];
const dark = fieldOf('dark'), light = fieldOf('light');
console.log(`  --field: ${dark} dark, ${light} light`);
ok(dark && light && dark !== light, 'the page has a different background in each theme');
ok(PAGES.every((p) => read(p).includes(`<meta name="theme-color" content="${dark}">`)), 'all three pages start with the dark one, the default');
ok(['app.js', 'track-record.js', 'nfl-priors.js'].every((f) => { const s = read(f); return s.includes(`querySelector('meta[name="theme-color"]')`) && s.includes(`'${dark}'`) && s.includes(`'${light}'`); }), 'and each page\'s script switches it to the page\'s own colour');
ok(['track-record.js', 'nfl-priors.js'].every((f) => /setAttribute\('data-theme', next\);\n\s*paintStatusBar\(\);/.test(read(f))), 'on the other two pages, on the click as well as on load');

console.log('\n-- the separator dot --');
const body = (app.match(/const glueDots = (\(s\) => s\.replace\([^\n]*\));/) || [])[1];
const glue = body ? new Function(`return ${body};`)() : null;
ok(!!glue, 'the page has the function');
if (glue) {
  const real = '-205 · fair -170 · EV -6.3% · bet at -170 or better';
  const out = glue(real);
  ok(!/ ·/.test(out) && (out.match(/ · /g) || []).length === 3, "no ordinary space before a dot, where a line could break, in the day's real line");
  ok(out.replace(/ /g, ' ') === real, 'and nothing else about the line changes');
  ok(glue(out) === out, 'done twice, the same');
}
ok(/new MutationObserver\([^\n]*glueDotsIn[^\n]*\.observe\(document\.body, \{ childList: true, subtree: true \}\)/.test(app) && /glueDotsIn\(document\.body\);/.test(app), 'it runs on the page as loaded and on everything rendered after');

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
