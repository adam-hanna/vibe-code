#!/usr/bin/env node
// Replay the plan-stall detector over a run archive (#394).
//
//   npm run build
//   node scripts/replay-plan-stall.mjs              # .vibe/runs under the cwd
//   node scripts/replay-plan-stall.mjs <runs-dir>   # another archive
//
// For every run with `plan-critique-<n>.json` files, builds one round record per
// critique the way `guardProgress` builds `p1Rounds` (`blockers()`, then
// `recordRound`), and asks the real `planStall` from `dist/` at every position,
// assuming a step-back never helps. Prints, per run, the blocking/new count of
// each critique and the stall positions under `stallAfter` 2, 3 and 4. Human-
// raised ids are excluded, as the caller will exclude them.
//
// Build first: it imports the compiled function, so a stale `dist/` replays the
// last change rather than this one. Run by hand, never by `npm test`, which
// reads no `.vibe/`. Dependency-free, like every script here.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const dist = new URL('../dist/src/', import.meta.url);
if (!existsSync(new URL('run.js', dist))) {
  console.error('dist/src/run.js is missing: run `npm run build` first.');
  process.exit(1);
}
const { planStall, recordRound, p1Signature } = await import(new URL('run.js', dist).href);
const { blockers, authorOf } = await import(new URL('validate.js', dist).href);

const root = path.resolve(process.argv[2] ?? path.join('.vibe', 'runs'));
if (!existsSync(root)) {
  console.error(`No runs directory at ${root}.`);
  process.exit(1);
}

const AFTER = [2, 3, 4];

function critiqueFiles(dir) {
  return readdirSync(dir)
    .map((f) => /^plan-critique-(\d+)\.json$/.exec(f))
    .filter((m) => m !== null)
    .sort((a, b) => Number(a[1]) - Number(b[1]))
    .map((m) => path.join(dir, m[0]));
}

function replay(history, stallAfter, human) {
  const stalls = [];
  let lastStall = null;
  for (let r = 0; r < history.length; r += 1) {
    if (planStall(history.slice(0, r + 1), { stallAfter, lastStall, human }) !== null) {
      stalls.push(r);
      lastStall = r;
    }
  }
  return stalls;
}

const rows = [];
for (const entry of readdirSync(root, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const files = critiqueFiles(path.join(root, entry.name));
  if (files.length === 0) continue;

  const history = [];
  const human = new Set();
  let broken = null;
  for (const file of files) {
    let findings;
    try {
      findings = JSON.parse(readFileSync(file, 'utf8')).findings;
    } catch (err) {
      broken = `${path.basename(file)}: ${err instanceof Error ? err.message : String(err)}`;
      break;
    }
    if (!Array.isArray(findings)) {
      broken = `${path.basename(file)}: no findings array`;
      break;
    }
    for (const f of findings) if (authorOf(f) === 'human') human.add(f.id);
    const b = blockers(findings);
    recordRound(
      history,
      p1Signature(findings),
      b.length,
      b.map((f) => f.id),
      b.map((f) => ({ id: f.id, title: f.title })),
    );
  }
  if (broken !== null) {
    rows.push({ run: entry.name, critiques: files.length, perCritique: `skipped (${broken})`, stalls: [] });
    continue;
  }

  // The same counts planStall computes: ids de-duplicated, minus human ones.
  const seen = new Set();
  const perCritique = history
    .map((rec) => {
      const blocking = [...new Set(rec.ids)].filter((id) => !human.has(id));
      const fresh = blocking.filter((id) => !seen.has(id)).length;
      for (const id of blocking) seen.add(id);
      return `${blocking.length}/${fresh}`;
    })
    .join(' ');
  const stalls = files.length < 3 ? null : AFTER.map((n) => replay(history, n, human));
  rows.push({ run: entry.name, critiques: files.length, perCritique, stalls });
}

rows.sort((a, b) => a.run.localeCompare(b.run));
const fmt = (s) => (s === undefined ? '-' : s.length === 0 ? 'none' : s.join(','));
console.log(['run', 'critiques', 'blocking/new per critique', ...AFTER.map((n) => `stalls@${n}`)].join('\t'));
for (const row of rows) {
  const stalls = row.stalls === null ? AFTER.map(() => '-') : AFTER.map((_, i) => fmt(row.stalls[i]));
  console.log([row.run, row.critiques, row.perCritique, ...stalls].join('\t'));
}
