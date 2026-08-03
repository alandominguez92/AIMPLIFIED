# Expanded panel — mobile height fix

Measured on a faithful reconstruction of the panel at 390px (Chromium, real CSS
from the shipped file). Absolute px will vary a few percent against the live
build; the proportions are what matter.

## Diagnosis — 826px for ONE expanded row (a full phone screen)

| section          | height | share |
|------------------|--------|-------|
| price read       | 143px  | 17%   |
| title            |  29px  |  4%   |
| **props table**  |**233px**|**28%**|
| title            |  55px  |  7%   |
| percentiles      | 105px  | 13%   |
| **methodology**  |**219px**|**27%**|

Two findings:

1. **53% of the props table is markets with no line.** HR and TB each render a
   full 62px row to say "no line · proj 0.02" — 124px telling you about markets
   you cannot bet. Only H+R+RBI (105px) is actionable.
2. **The methodology paragraph is 27% of the panel.** It is read-once reference
   text, repeated identically inside every row you open.

Together: 42% of the panel is non-actionable or read-once.

## Fix (mobile only, <=640px) — measured 826px -> 550px, 33% shorter

### 1. Collapse the methodology behind a disclosure (saves 160px)
Wrap the existing `<p class="expanded-note">` in a `<details>`, closed by default.

```css
.method { margin-top:20px; }
.method > summary { list-style:none; cursor:pointer; font-family:'IBM Plex Mono',ui-monospace,monospace;
  font-size:10px; letter-spacing:.14em; text-transform:uppercase; color:var(--textDim);
  border:1px solid var(--border); border-radius:8px; padding:9px 12px; }
.method > summary::-webkit-details-marker { display:none; }
.method > summary::after { content:' \25BE'; color:var(--textFaint); }
.method .expanded-note { margin-top:12px; }
```
app.js — in the batter panel template, replace the bare `<p class="expanded-note">…</p>` with:
```js
`<details class="method"><summary>How this projection is built</summary>
   <p class="expanded-note">…existing text unchanged…</p>
 </details>`
```
Desktop can stay open by default: add `${window.innerWidth > 640 ? ' open' : ''}` to the `<details>`.

### 2. Roll the no-line markets into one line (saves 112px)
Today each unpriced market gets its own `.bm-row`. Emit the priced ones as rows,
then a single summary row for the rest:

```js
const priced   = (g.batterMarkets||[]).filter(m => !m.none);
const unpriced = (g.batterMarkets||[]).filter(m =>  m.none);
// …render `priced` as today…
const noLine = unpriced.length
  ? `<div class="bm-row noline"><span class="bm-none">No line posted: ${
      unpriced.map(m => `<b>${esc(m.label)}</b> proj ${esc(String(m.proj))}`).join(' · ')
    }</span></div>`
  : '';
```
```css
.bm-row.noline { grid-template-columns:1fr; padding:9px 13px; }
.bm-row.noline b { color:var(--textDim); font-weight:600; }
```

### 3. Two columns instead of one for the priced row
```css
@media (max-width:640px) {
  .bm-row { grid-template-columns:1fr 1fr; column-gap:10px; }
  .bm-row.noline { grid-template-columns:1fr; }
}
```
(Replaces the current `grid-template-columns:1fr` mobile rule — that single
column is what turns the priced market into four stacked lines.)

## Not changed
Price read, percentile bars and both titles stay as-is — all per-pick data.
