import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `scripts/test.mjs` is what keeps the suite from filling `/tmp` (#234): about
 * 1,600 directories a run, 411 of them git repositories, and for a long time
 * none removed. These cases run the script for real, against a project of
 * their own made of tiny test files, and with `TMPDIR` pointed at a private
 * directory that stands in for the machine's `/tmp`. Private because this file
 * runs beside every other test file, all of which make `vibe-*` entries in the
 * suite's own temp directory, and the script would rightly report those as
 * having escaped.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, '..', '..', 'scripts', 'test.mjs');

interface Project {
  /** The project's own root, holding `dist/tests`. */
  cwd: string;
  /** What the script will take to be the machine's temp directory. */
  machineTmp: string;
}

function project(t: { after: (fn: () => void) => void }, tests: Record<string, string>): Project {
  const base = mkdtempSync(path.join(tmpdir(), 'vibe-sandbox-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const cwd = path.join(base, 'project');
  const machineTmp = path.join(base, 'machine-tmp');
  mkdirSync(path.join(cwd, 'dist', 'tests'), { recursive: true });
  mkdirSync(machineTmp);
  for (const [name, body] of Object.entries(tests)) {
    writeFileSync(path.join(cwd, 'dist', 'tests', name), body, 'utf8');
  }
  return { cwd, machineTmp };
}

function runScript(p: Project, extraEnv: Record<string, string> = {}): Promise<{ code: number | null; stderr: string }> {
  // `node --test` marks its children with NODE_TEST_CONTEXT, and a runner that
  // inherits it reports to the outer one instead of running its own files.
  // VIBE_KEEP_TEST_TMP is dropped too, or a kept outer run makes every inner one keep its root.
  const { NODE_TEST_CONTEXT: _context, VIBE_KEEP_TEST_TMP: _keep, ...inherited } = process.env;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: p.cwd,
      env: { ...inherited, TMPDIR: p.machineTmp, TMP: p.machineTmp, TEMP: p.machineTmp, ...extraEnv },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

// What the fixture tests write out, so the case can check the environment they
// actually saw rather than the one the script meant to give them.
const REPORTER = `
import { test } from 'node:test';
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
test('reports', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-fixture-'));
  execFileSync('git', ['init', '-q', dir]);
  writeFileSync(process.env.REPORT_PATH, JSON.stringify({
    tmp: tmpdir(),
    dir,
    hooks: existsSync(path.join(dir, '.git', 'hooks')),
    globalConfig: process.env.VIBE_GLOBAL_CONFIG,
  }));
});
`;

const ESCAPER = `
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
test('writes past the sandbox', () => {
  mkdtempSync(path.join(process.env.ESCAPE_TO, 'vibe-escaped-'));
});
`;

function entries(dir: string): string[] {
  return readdirSync(dir).sort();
}

test('a run gives its tests a temp directory of its own and removes it afterwards', async (t) => {
  const p = project(t, { 'report.test.js': REPORTER });
  const reportPath = path.join(p.cwd, 'report.json');
  const { code, stderr } = await runScript(p, { REPORT_PATH: reportPath });

  assert.equal(code, 0, stderr);
  const report = JSON.parse(readFileSync(reportPath, 'utf8')) as {
    tmp: string;
    dir: string;
    hooks: boolean;
    globalConfig: string;
  };
  // The tests saw a directory inside the machine's temp directory, not the
  // directory itself, and everything they made went inside it.
  assert.notEqual(path.resolve(report.tmp), path.resolve(p.machineTmp));
  assert.ok(report.tmp.startsWith(p.machineTmp + path.sep), report.tmp);
  assert.ok(report.dir.startsWith(report.tmp + path.sep), report.dir);
  // And the run left nothing at all behind it.
  assert.deepEqual(entries(p.machineTmp), []);
  assert.equal(existsSync(report.dir), false);
  // The global settings layer is still switched off (#223).
  assert.equal(report.globalConfig, '');
});

test('a repository a test makes is created from an empty template', async (t) => {
  const p = project(t, { 'report.test.js': REPORTER });
  const reportPath = path.join(p.cwd, 'report.json');
  const { code, stderr } = await runScript(p, { REPORT_PATH: reportPath });

  assert.equal(code, 0, stderr);
  const report = JSON.parse(readFileSync(reportPath, 'utf8')) as { hooks: boolean };
  // The sample hooks are most of what a fresh .git holds (27 entries against 9),
  // and no test runs one.
  assert.equal(report.hooks, false);
});

test('anything a test puts in the machine temp directory fails the run by name', async (t) => {
  const p = project(t, { 'escape.test.js': ESCAPER });
  const { code, stderr } = await runScript(p, { ESCAPE_TO: p.machineTmp });

  // The test itself passed; the run did not.
  assert.notEqual(code, 0);
  assert.match(stderr, /appeared in .* outside the run's own directory/);
  assert.match(stderr, /vibe-escaped-/);
  // Reported, not deleted: the evidence stays for whoever reads the failure.
  assert.equal(entries(p.machineTmp).filter((name) => name.startsWith('vibe-escaped-')).length, 1);
});

test('a run left behind by a killed suite is removed by the next one, and a live one is not', async (t) => {
  const p = project(t, { 'pass.test.js': `import { test } from 'node:test'; test('passes', () => {});` });

  // A pid that has certainly exited: a child that has already been reaped.
  const gone = spawnSync(process.execPath, ['-e', '']).pid;
  assert.ok(gone !== undefined && gone > 0);
  const abandoned = path.join(p.machineTmp, 'vibe-test-run-abandoned');
  mkdirSync(path.join(abandoned, 'tmp', 'vibe-stored-x'), { recursive: true });
  writeFileSync(path.join(abandoned, 'pid'), String(gone), 'utf8');

  const live = path.join(p.machineTmp, 'vibe-test-run-live');
  mkdirSync(live);
  writeFileSync(path.join(live, 'pid'), String(process.pid), 'utf8');

  const { code, stderr } = await runScript(p);

  assert.equal(code, 0, stderr);
  assert.equal(existsSync(abandoned), false);
  assert.match(stderr, /removed vibe-test-run-abandoned/);
  assert.equal(existsSync(live), true);
});

test('a directory a test left unreadable does not survive the run', { skip: process.platform === 'win32' }, async (t) => {
  // gate-artifacts.test.ts makes a mode-0 directory on purpose, and one of its
  // cases restored the mode on a path the directory had already been renamed
  // away from — so it outlived every run as something nobody could list.
  const p = project(t, {
    'locked.test.js': `
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
test('leaves a locked directory', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-locked-'));
  const locked = path.join(dir, 'a', 'b');
  mkdirSync(locked, { recursive: true });
  writeFileSync(path.join(locked, 'inner.txt'), 'x');
  chmodSync(locked, 0o000);
});
`,
  });
  const { code, stderr } = await runScript(p);

  assert.equal(code, 0, stderr);
  assert.deepEqual(entries(p.machineTmp), []);
});
