#!/usr/bin/env node
// Count the blank space Codex wrote *between* JSON values in its structured
// answers, grouped by the key that follows each run (#416).
//
//   node scripts/count-schema-stalls.mjs              # .vibe/runs under the cwd
//   node scripts/count-schema-stalls.mjs <runs-dir>   # and another archive too
//
// Reads `<runs>/*/codex/*.out.json`. A blank run is counted only outside
// strings, so indentation quoted inside an `excerpt` is not one. The schema
// order is the fix this count confirms or refutes: before #416, 149 of 150
// runs sat just before `reproducer` or `ref`, the then-last keys of a finding
// and an evidence entry. A later archive whose runs moved to the new last key
// (`evidence`, `excerpt`) says the stall moved rather than went.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const roots = [path.join(process.cwd(), '.vibe', 'runs'), ...process.argv.slice(2).map((d) => path.resolve(d))];

function outputs(root) {
  if (!existsSync(root)) return [];
  const files = [];
  for (const run of readdirSync(root, { withFileTypes: true })) {
    if (!run.isDirectory()) continue;
    const dir = path.join(root, run.name, 'codex');
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) if (f.endsWith('.out.json')) files.push(path.join(dir, f));
  }
  return files;
}

const BLANK = new Set([' ', '\t', '\r', '\n']);

/** Each blank run between values: its length and what follows it. */
function blankRuns(text) {
  const runs = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      i = stringEnd(text, i);
      continue;
    }
    if (BLANK.has(c)) {
      const start = i;
      while (i < text.length && BLANK.has(text[i])) i += 1;
      // Leading and trailing blank space is the file's, not the answer's.
      if (start === 0 || i >= text.length) continue;
      runs.push({ length: i - start, next: following(text, i) });
      continue;
    }
    i += 1;
  }
  return runs;
}

function stringEnd(text, open) {
  for (let i = open + 1; i < text.length; i += 1) {
    if (text[i] === '\\') i += 1;
    else if (text[i] === '"') return i + 1;
  }
  return text.length;
}

/**
 * The key the run comes before, looking past a comma and more blank space -
 * `}] ,"reproducer"` and `}],  "reproducer"` are both a run before `reproducer` -
 * and otherwise the token that follows it.
 */
function following(text, at) {
  while (at < text.length && (text[at] === ',' || BLANK.has(text[at]))) at += 1;
  if (text[at] !== '"') return text[at] === undefined ? '(end)' : `'${text[at]}'`;
  const end = stringEnd(text, at);
  let j = end;
  while (j < text.length && BLANK.has(text[j])) j += 1;
  return text[j] === ':' ? JSON.parse(text.slice(at, end)) : '(a string value)';
}

const files = [...new Set(roots.flatMap(outputs))];
const byKey = new Map();
let withRuns = 0;
let total = 0;
for (const file of files) {
  const runs = blankRuns(readFileSync(file, 'utf8'));
  if (runs.length > 0) withRuns += 1;
  for (const { length, next } of runs) {
    total += 1;
    const row = byKey.get(next) ?? { count: 0, short: 0, longest: 0 };
    row.count += 1;
    if (length <= 2) row.short += 1;
    row.longest = Math.max(row.longest, length);
    byKey.set(next, row);
  }
}

console.log(`Read ${files.length} output(s) from ${roots.filter(existsSync).join(', ') || '(no archive found)'}`);
console.log(`${withRuns} of ${files.length} have blank space between JSON values: ${total} run(s).\n`);
if (total > 0) {
  const rows = [...byKey.entries()].sort((a, b) => b[1].count - a[1].count);
  const width = Math.max(14, ...rows.map(([k]) => k.length));
  console.log(`${'before'.padEnd(width)}  ${'runs'.padStart(5)}  ${'<=2 chars'.padStart(9)}  ${'longest'.padStart(7)}`);
  for (const [key, row] of rows) {
    console.log(
      `${key.padEnd(width)}  ${String(row.count).padStart(5)}  ${String(row.short).padStart(9)}  ${String(row.longest).padStart(7)}`,
    );
  }
  const short = rows.reduce((n, [, r]) => n + r.short, 0);
  const longest = rows.reduce((n, [, r]) => Math.max(n, r.longest), 0);
  console.log(`${'total'.padEnd(width)}  ${String(total).padStart(5)}  ${String(short).padStart(9)}  ${String(longest).padStart(7)}`);
}
