// The home-screen icon: present, the size it claims, and opaque where it must be.
//
// Read straight from the PNG headers rather than trusted from the manifest.
// iPhone uses apple-touch-icon, wants 180x180, and draws any transparent
// pixel as black; Android reads the manifest and crops a "maskable" icon to a
// circle or squircle. A manifest pointing at a missing file, or an icon that is
// not the size it declares, fails quietly — the phone falls back to a
// screenshot of the page.
import fs from 'node:fs';
import path from 'node:path';
const BOARD = path.join(import.meta.dirname, '..');

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

// PNG IHDR: width and height at bytes 16-23, colour type at byte 25
// (2 = RGB, 6 = RGBA).
function png(rel) {
  const f = path.join(BOARD, rel.replace(/^\//, ''));
  if (!fs.existsSync(f)) return null;
  const b = fs.readFileSync(f);
  if (b.toString('ascii', 1, 4) !== 'PNG') return { bad: true };
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), colour: b[25] };
}

const html = fs.readFileSync(path.join(BOARD, 'index.html'), 'utf8');
const man = JSON.parse(fs.readFileSync(path.join(BOARD, 'manifest.webmanifest'), 'utf8'));

ok(/<link rel="manifest" href="\/manifest\.webmanifest">/.test(html), 'index.html links the manifest');
const touch = (html.match(/<link rel="apple-touch-icon" href="([^"]+)">/) || [])[1];
const t = touch && png(touch);
ok(!!t && t.w === 180 && t.h === 180, `iPhone's icon is there and 180x180 (${t ? t.w + 'x' + t.h : 'missing'})`);
ok(!!t && t.colour === 2, 'and opaque — iPhone paints transparent pixels black');

ok(man.display === 'standalone' && man.start_url === '/', 'opens full-screen at the board');
for (const i of man.icons || []) {
  const p = png(i.src);
  const [w, h] = String(i.sizes).split('x').map(Number);
  ok(!!p && p.w === w && p.h === h, `${i.src} is the ${i.sizes} it declares (${p ? p.w + 'x' + p.h : 'missing'})`);
}
ok((man.icons || []).some((i) => i.purpose === 'maskable') && (man.icons || []).some((i) => i.sizes === '512x512' && i.purpose === 'any'),
  'a 512 icon for install screens and a maskable one for Android\'s crop');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exitCode = fail ? 1 : 0;
