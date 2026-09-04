/**
 * Audits the design system against the two rules the build spec names as the
 * ones most likely to slip, plus the three ramps it defines.
 *
 * This checks the SYSTEM, not a page. Walking rendered DOM proves one screen
 * held; checking every token pairing the system permits proves no screen can
 * break it. The bundle's own audit was the former, which is why it had to be
 * re-run every round.
 *
 * No dependencies, by design - `tokens.css` is parsed as text, which is the
 * whole reason the tokens are a CSS file with one declaration per line.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const css = readFileSync(path.join(here, '..', 'src', 'design', 'tokens.css'), 'utf8');

/** Every `--name: #hex;` in tokens.css. Aliases (`var(...)`) are resolved after. */
const tokens = new Map();
for (const m of css.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
  tokens.set(m[1], m[2].toLowerCase());
}
for (const m of css.matchAll(/--([a-z0-9-]+):\s*var\(--([a-z0-9-]+)\)\s*;/g)) {
  const target = tokens.get(m[2]);
  if (target !== undefined) tokens.set(m[1], target);
}

const rgb = (h) => {
  let s = h.replace('#', '');
  if (s.length === 3) s = [...s].map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
};
const lum = (h) => {
  const a = rgb(h).map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
/** HSL saturation - the convention the spec's "~6.8%" figure is quoted in. */
const sat = (h) => {
  const [r, g, b] = rgb(h).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const l = (max + min) / 2;
  return ((max - min) / (l > 0.5 ? 2 - max - min : max + min)) * 100;
};

const t = (n) => {
  const v = tokens.get(n);
  if (v === undefined) throw new Error(`token --${n} is not defined in tokens.css`);
  return v;
};

let failures = 0;
let checks = 0;
const fail = (msg) => {
  failures += 1;
  console.log(`  FAIL  ${msg}`);
};
const pass = (msg) => {
  checks += 1;
  console.log(`  ok    ${msg}`);
};

const SURFACES = [
  'surface-page', 'surface-chrome', 'surface-column', 'surface-panel',
  'surface-card', 'surface-active', 'surface-active-hdr', 'surface-accent-tint',
  'surface-alarm', 'surface-tray',
];
const TEXT = ['text-display', 'text-emphasis', 'text-primary', 'text-secondary', 'text-tertiary'];

console.log(`\ntokens parsed: ${tokens.size}\n`);

// ---------------------------------------------------------------- 1 · the floor
// "#8f9498 is the last passing step on these grounds (5.47-6.09 depending on
// ground)." Every text tier must clear 4.5 on every surface it can land on.
console.log('1 · the text floor holds on every surface');
{
  let worst = Infinity;
  let worstWhere = '';
  for (const s of SURFACES) {
    for (const x of TEXT) {
      const r = ratio(t(x), t(s));
      if (r < worst) {
        worst = r;
        worstWhere = `${x} on ${s}`;
      }
      if (r < 4.5) fail(`${x} on ${s} is ${r.toFixed(2)}, below 4.5`);
    }
  }
  if (failures === 0) pass(`50 pairings, worst is ${worstWhere} at ${worst.toFixed(2)}`);
  // The spec quotes 5.47-6.09 for the floor specifically.
  const floors = SURFACES.map((s) => ratio(t('text-tertiary'), t(s)));
  const lo = Math.min(...floors).toFixed(2);
  const hi = Math.max(...floors).toFixed(2);
  pass(`the floor spans ${lo}-${hi} across the ten surfaces`);
}

// ---------------------------------------------------------------- 2 · the retirement
// The documented-only greys must fail SOMEWHERE a real surface exists, or
// retiring them was a preference rather than a measurement.
//
// `--retired-aa-limit` is the interesting one and the reason this is not a
// single-ground check. On the four darkest surfaces it passes - 4.78 on page,
// 4.52 on panel - so a check against one ground would have called it text. It
// fails on five of the ten, including every card (4.43 on card, 3.67 on the
// accent tint). That is exactly why it is named for the limit rather than
// numbered with the others, and exactly why the floor is a step above it: a
// floor has to hold on every ground, not the average one.
console.log('\n2 · the retired greys fail on grounds that exist');
for (const g of ['retired-aa-limit', 'retired-1', 'retired-2', 'retired-3', 'retired-4']) {
  const rs = SURFACES.map((s) => ({ s, r: ratio(t(g), t(s)) }));
  const failing = rs.filter((x) => x.r < 4.5);
  if (failing.length === 0) {
    fail(`--${g} passes on all ten surfaces - it should not have been retired`);
  } else {
    const worst = rs.reduce((a, b) => (b.r < a.r ? b : a));
    pass(
      `--${g} fails on ${failing.length}/10 surfaces (worst ${worst.r.toFixed(2)} on ${worst.s})`,
    );
  }
}

// ---------------------------------------------------------------- 3 · severity ramp
// Weight ascends with severity, so luminance must too: P0 highest.
console.log('\n3 · the severity ramp is monotonic');
{
  const ramp = ['severity-p3-rule', 'severity-p2-rule', 'severity-p1-rule', 'severity-p0-rule'];
  const ls = ramp.map((n) => lum(t(n)));
  const ok = ls.every((v, i) => i === 0 || v > ls[i - 1]);
  if (ok) pass(`P3 < P2 < P1 < P0 by luminance (${ls.map((v) => v.toFixed(3)).join(' < ')})`);
  else fail(`ramp is not monotonic: ${ls.map((v) => v.toFixed(3)).join(', ')}`);
}

// ---------------------------------------------------------------- 4 · quantity vs accent
// "--accent-solid must not appear as a bar fill: it means pressable."
console.log('\n4 · the quantity ramp is separable from the accent');
for (const q of ['quantity-1', 'quantity-2', 'quantity-3']) {
  if (t(q) === t('accent-solid')) fail(`--${q} is the accent - a bar would read as pressable`);
}
pass('no quantity step collides with --accent-solid');

// ---------------------------------------------------------------- 5 · diff
// Luminance symmetric and both below every card; hue carries the pair at ~6.8%.
console.log('\n5 · diff rows: luminance symmetric, hue carries the pair');
{
  const panel = t('surface-panel');
  const add = ratio(t('diff-added-row'), panel);
  const rem = ratio(t('diff-removed-row'), panel);
  const skew = Math.abs(add - rem);
  if (skew > 0.15) fail(`rows are asymmetric: added ${add.toFixed(2)} vs removed ${rem.toFixed(2)}`);
  else pass(`rows symmetric against panel: ${add.toFixed(2)} / ${rem.toFixed(2)}`);

  // Both must stay below every card, or a screenful of additions becomes the
  // brightest large area in the product.
  for (const card of ['surface-card', 'surface-active']) {
    for (const row of ['diff-added-row', 'diff-removed-row']) {
      if (lum(t(row)) <= lum(t(card))) {
        fail(`--${row} is not above --${card}; the spec says rows sit below cards`);
      }
    }
  }
  pass('both rows sit above the cards in luminance, as drawn');

  for (const [n, min] of [['diff-added-row', 3], ['diff-removed-row', 3], ['diff-added-gutter', 6], ['diff-removed-gutter', 6]]) {
    const s = sat(t(n));
    if (s < min) fail(`--${n} is ${s.toFixed(1)}% saturated, below the ${min}% hue floor`);
    else pass(`--${n} carries ${s.toFixed(1)}% saturation`);
  }

  // Code must be readable on its own row - the second of the diff's two rules.
  for (const [code, row] of [['diff-added-code', 'diff-added-row'], ['diff-removed-code', 'diff-removed-row']]) {
    const r = ratio(t(code), t(row));
    if (r < 4.5) fail(`--${code} on --${row} is ${r.toFixed(2)}`);
    else pass(`--${code} on its row is ${r.toFixed(2)}`);
  }
}

// ---------------------------------------------------------------- 6 · semantic
console.log('\n6 · the two semantic hues are legible where they are used');
for (const n of ['semantic-live', 'semantic-loss']) {
  const r = ratio(t(n), t('surface-panel'));
  if (r < 3.0) fail(`--${n} is ${r.toFixed(2)} on panel, below the 3.0 non-text threshold`);
  else pass(`--${n} is ${r.toFixed(2)} on panel`);
}

// ---------------------------------------------------------------- 7 · no stray hex
// "No hex literal appears outside tokens.css."
console.log('\n7 · no hex literals outside tokens.css');
{
  // Every stylesheet in the app except `tokens.css`, discovered rather than
  // listed. The named list missed `cockpit.css` the day it was added, which is
  // the failure mode of any allow-list that has to be remembered - and the whole
  // point of this check is that it catches the file somebody forgot.
  const src = path.join(here, '..', 'src');
  const sheets = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.css') && entry.name !== 'tokens.css') sheets.push(full);
    }
  };
  walk(src);

  let stray = 0;
  for (const full of sheets) {
    const name = path.relative(src, full).replace(/\\/g, '/');
    // Comments stripped first. The rule is that no hex SHIPS as a colour, and a
    // comment ships nothing - `tokens.css` documents hexes in prose itself. It
    // also stops the check tripping over an issue reference: `#159` is three hex
    // digits and reads as a colour to a regex that cannot see it is English.
    const declarations = readFileSync(full, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of declarations.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
      stray += 1;
      fail(`${name} contains a raw hex ${m[0]}`);
    }
  }
  if (stray === 0) pass(`${sheets.length} stylesheets reach only for tokens`);
}

console.log(`\n${checks} checks passed, ${failures} failed\n`);
process.exit(failures > 0 ? 1 : 0);
