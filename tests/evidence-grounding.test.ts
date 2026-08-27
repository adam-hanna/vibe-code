import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkEvidence, groundFindings } from '@src/evidence.js';
import { toAgentPath } from '@src/pathstyle.js';
import type { PathStyle } from '@src/pathstyle.js';
import type { Evidence, Finding, FindingsReport, Severity } from '@src/types.js';

/**
 * The grounding check, unit by unit: does a citation resolve, and what happens
 * to a blocking finding when none of its citations do.
 *
 * Every case builds its own tree under `mkdtemp` rather than citing this
 * repository - the check is `existsSync` and a substring, so a fixture file
 * with known contents settles more than a real one whose lines move. Nothing
 * here is cleaned up, matching the rest of the suite: `rmSync` over a directory
 * on Windows is a flake source in a run that has to pass three times.
 */

// ---- fixtures ---------------------------------------------------------------

interface Tree {
  cwd: string;
  runDir: string;
  outside: string;
}

/** A repo, a run directory beside it, and a directory outside both. */
function tree(): Tree {
  const base = mkdtempSync(path.join(tmpdir(), 'vibe-evidence-'));
  const cwd = path.join(base, 'repo');
  const runDir = path.join(base, 'run');
  const outside = path.join(base, 'elsewhere');
  mkdirSync(cwd);
  mkdirSync(runDir);
  mkdirSync(outside);
  mkdirSync(path.join(cwd, 'tests'));
  writeFileSync(path.join(cwd, 'src.ts'), 'one\ntwo\n  const x = 1;\nfour\n', 'utf8');
  writeFileSync(path.join(runDir, 'PLAN.md'), '# plan\n', 'utf8');
  writeFileSync(path.join(outside, 'secret.txt'), 'not yours\n', 'utf8');
  return { cwd, runDir, outside };
}

function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: 'a-finding',
    severity: 'P1',
    title: 'A finding',
    detail: 'Detail.',
    suggested_fix: 'Fix it.',
    defer: false,
    ...over,
  };
}

function reportOf(findings: readonly Finding[]): FindingsReport {
  return { verdict: 'REVISE', summary: 'summary', findings: [...findings] };
}

/** The severity a finding comes out at, and what it recorded about the change. */
function ground(
  t: Tree,
  f: Finding,
  style: PathStyle | null = null,
): { severity: Severity; from: Severity | null; reason: string; count: number; out: Finding } {
  const { report, downgraded } = groundFindings(reportOf([f]), t.cwd, t.runDir, style);
  const out = report.findings[0];
  assert.ok(out !== undefined, 'a finding must survive grounding');
  return {
    severity: out.severity,
    from: out.downgraded?.from ?? null,
    reason: out.downgraded?.reason ?? '',
    count: downgraded.length,
    out,
  };
}

const check = (t: Tree, e: Evidence, style: PathStyle | null = null): string | null =>
  checkEvidence(e, t.cwd, t.runDir, style);

// ---- the ordinary case ------------------------------------------------------

test('a code citation that resolves leaves a P1 blocking', () => {
  const t = tree();
  const r = ground(t, finding({ evidence: [{ kind: 'code', path: 'src.ts' }] }));
  assert.equal(r.severity, 'P1');
  assert.equal(r.from, null);
  assert.equal(r.count, 0);
  assert.equal(r.out.downgraded, undefined);
});

test('a line inside the file and a re-indented excerpt both resolve', () => {
  const t = tree();
  assert.equal(check(t, { kind: 'code', path: 'src.ts', line: 4 }), null);
  // Whitespace-normalised, so a quotation that lost its indentation still
  // matches: the model re-indents what it quotes as a matter of course.
  assert.equal(check(t, { kind: 'code', path: 'src.ts', excerpt: 'const x = 1;' }), null);
  assert.equal(check(t, { kind: 'code', path: 'src.ts', excerpt: '  const   x = 1;  ' }), null);
});

// ---- the downgrade ----------------------------------------------------------

test('a P1 citing a path that does not exist becomes P2', () => {
  const t = tree();
  const r = ground(t, finding({ evidence: [{ kind: 'code', path: 'nope.ts' }] }));
  assert.equal(r.severity, 'P2');
  assert.equal(r.from, 'P1');
  assert.equal(r.count, 1);
  assert.match(r.reason, /nope\.ts/);
});

test('a line past the end of the file downgrades', () => {
  const t = tree();
  const r = ground(t, finding({ evidence: [{ kind: 'code', path: 'src.ts', line: 99 }] }));
  assert.equal(r.severity, 'P2');
  assert.equal(r.from, 'P1');
  assert.match(r.reason, /no line 99/);
  // The file has four lines and a trailing newline: a trailing newline ends the
  // last line rather than starting a fifth.
  assert.equal(check(t, { kind: 'code', path: 'src.ts', line: 4 }), null);
  assert.notEqual(check(t, { kind: 'code', path: 'src.ts', line: 5 }), null);
  assert.notEqual(check(t, { kind: 'code', path: 'src.ts', line: 0 }), null);
});

test('an excerpt that is not in the file downgrades', () => {
  const t = tree();
  const r = ground(
    t,
    finding({ evidence: [{ kind: 'code', path: 'src.ts', excerpt: 'const y = 2;' }] }),
  );
  assert.equal(r.severity, 'P2');
  assert.equal(r.from, 'P1');
  assert.match(r.reason, /excerpt/);
});

test('a P1 with no evidence at all becomes P2 by the same path', () => {
  const t = tree();
  const r = ground(t, finding({}));
  assert.equal(r.severity, 'P2');
  assert.equal(r.from, 'P1');
  assert.equal(r.count, 1);
  assert.match(r.reason, /cited no evidence/);
  // Absent, not `[]`: the finding is recorded as having offered nothing.
  assert.equal(r.out.evidence, undefined);
});

test('an empty evidence list is the same case as no evidence', () => {
  const t = tree();
  const r = ground(t, finding({ evidence: [] }));
  assert.equal(r.severity, 'P2');
  assert.match(r.reason, /cited no evidence/);
});

test('a P0 is downgraded on the same terms as a P1', () => {
  const t = tree();
  const r = ground(t, finding({ severity: 'P0', evidence: [{ kind: 'code', path: 'nope.ts' }] }));
  assert.equal(r.severity, 'P2');
  assert.equal(r.from, 'P0');
  assert.equal(r.count, 1);
});

test('a P2 with a broken citation is left alone', () => {
  const t = tree();
  const r = ground(t, finding({ severity: 'P2', evidence: [{ kind: 'code', path: 'nope.ts' }] }));
  assert.equal(r.severity, 'P2');
  assert.equal(r.from, null);
  assert.equal(r.out.downgraded, undefined);
  // Nothing to downgrade means nothing to record: no event, no warning.
  assert.equal(r.count, 0);
});

test('a P3 with a broken citation is left alone too', () => {
  const t = tree();
  const r = ground(t, finding({ severity: 'P3', evidence: [{ kind: 'absence', path: 'nope' }] }));
  assert.equal(r.severity, 'P3');
  assert.equal(r.count, 0);
});

test('one good entry beside one broken entry keeps the finding blocking', () => {
  const t = tree();
  const r = ground(
    t,
    finding({
      evidence: [
        { kind: 'code', path: 'nope.ts' },
        { kind: 'code', path: 'src.ts' },
      ],
    }),
  );
  assert.equal(r.severity, 'P1');
  assert.equal(r.count, 0);
});

test('the reason names every citation that failed', () => {
  const t = tree();
  const r = ground(
    t,
    finding({
      evidence: [
        { kind: 'code', path: 'nope.ts' },
        { kind: 'artifact', path: 'MISSING.md' },
      ],
    }),
  );
  assert.match(r.reason, /nope\.ts/);
  assert.match(r.reason, /MISSING\.md/);
});

// ---- the kinds --------------------------------------------------------------

test('external is accepted with no filesystem access', () => {
  // A cwd and a run directory that do not exist: if this kind touched the
  // filesystem at all, it could not pass.
  const nowhere = path.join(tmpdir(), 'vibe-evidence-does-not-exist', 'nor-this');
  assert.equal(
    checkEvidence({ kind: 'external', ref: 'codex exec resume takes no -s flag' }, nowhere, nowhere, null),
    null,
  );
  const { report } = groundFindings(
    reportOf([finding({ evidence: [{ kind: 'external', ref: 'https://example.invalid/spec' }] })]),
    nowhere,
    nowhere,
    null,
  );
  assert.equal(report.findings[0]?.severity, 'P1');
});

test('external with no ref does not resolve', () => {
  const t = tree();
  assert.notEqual(check(t, { kind: 'external' }), null);
  assert.notEqual(check(t, { kind: 'external', ref: '   ' }), null);
});

test('absence accepts a directory, and refuses a path that is not there', () => {
  const t = tree();
  assert.equal(check(t, { kind: 'absence', path: 'tests' }), null);
  assert.equal(check(t, { kind: 'absence', path: 'src.ts' }), null);
  assert.notEqual(check(t, { kind: 'absence', path: 'tests/carried-p1.test.ts' }), null);
});

test('an excerpt on an absence citation is ignored', () => {
  const t = tree();
  // Checking that an excerpt is NOT found would let a loose quotation downgrade
  // a true finding, so the place existing is the whole check.
  assert.equal(
    check(t, { kind: 'absence', path: 'tests', excerpt: 'nothing like this exists' }),
    null,
  );
});

test('artifact resolves against the run directory, not the repo', () => {
  const t = tree();
  assert.equal(check(t, { kind: 'artifact', path: 'PLAN.md' }), null);
  // Present in the repo, absent from the run directory: an artifact citation
  // must not be satisfied by a same-named file in the tree under review.
  assert.notEqual(check(t, { kind: 'artifact', path: 'src.ts' }), null);
});

test('a directory cited as code or artifact is not a file', () => {
  const t = tree();
  assert.notEqual(check(t, { kind: 'code', path: 'tests' }), null);
  assert.notEqual(check(t, { kind: 'artifact', path: '.' }), null);
});

test('a filesystem kind with no path does not resolve', () => {
  const t = tree();
  for (const kind of ['code', 'artifact', 'absence'] as const) {
    assert.notEqual(check(t, { kind }), null, `${kind} with no path`);
    assert.notEqual(check(t, { kind, path: '  ' }), null, `${kind} with a blank path`);
  }
});

// ---- containment and path conversion ---------------------------------------

test('.. escapes do not resolve, with or without a path style', () => {
  const t = tree();
  for (const style of [null, 'msys', 'win32'] as const) {
    assert.notEqual(check(t, { kind: 'code', path: '../elsewhere/secret.txt' }, style), null);
    assert.notEqual(check(t, { kind: 'absence', path: '..' }, style), null);
    assert.notEqual(check(t, { kind: 'artifact', path: '../repo/src.ts' }, style), null);
  }
});

test('an absolute path inside the root resolves; one outside it does not', () => {
  const t = tree();
  // Accepted deliberately: a reviewer running in PowerShell cites `C:\repo\...`,
  // and refusing that would downgrade a finding for being right. Containment is
  // what makes it safe.
  assert.equal(check(t, { kind: 'code', path: path.join(t.cwd, 'src.ts') }), null);
  assert.notEqual(check(t, { kind: 'code', path: path.join(t.outside, 'secret.txt') }), null);
});

test('an msys citation resolves when the reporting agent is msys, and not when no style is known', () => {
  const t = tree();
  const real = path.join(t.cwd, 'src.ts');
  const cited = toAgentPath(real, 'msys');
  if (cited === real) {
    // A posix host: `/c/...` is not a form this path can take, so there is
    // nothing to convert and nothing to assert about the difference.
    assert.equal(check(t, { kind: 'code', path: cited }, 'msys'), null);
    return;
  }
  assert.equal(check(t, { kind: 'code', path: cited }, 'msys'), null);
  // No probe on this run means no conversion: guessing a style would be
  // inventing a fact the run never observed, so the citation simply fails.
  assert.notEqual(check(t, { kind: 'code', path: cited }, null), null);
});

test('a resolved path is canonicalised to repo-relative for whoever reads it next', () => {
  const t = tree();
  const absolute = path.join(t.cwd, 'src.ts');
  const { report } = groundFindings(
    reportOf([finding({ evidence: [{ kind: 'code', path: absolute, line: 3 }] })]),
    t.cwd,
    t.runDir,
    null,
  );
  const e = report.findings[0]?.evidence?.[0];
  // The fixer's shell is not the reviewer's. Repo-relative is the one form both
  // can open, and the line is untouched.
  assert.equal(e?.path, 'src.ts');
  assert.equal(e?.line, 3);
});

test('a citation that does not resolve is left exactly as it was written', () => {
  const t = tree();
  const { report } = groundFindings(
    reportOf([finding({ evidence: [{ kind: 'code', path: '../elsewhere/secret.txt' }] })]),
    t.cwd,
    t.runDir,
    null,
  );
  // No basis to restate it, and the reader should see what was claimed.
  assert.equal(report.findings[0]?.evidence?.[0]?.path, '../elsewhere/secret.txt');
});

// ---- the report itself ------------------------------------------------------

test('groundFindings does not mutate the report it was handed', () => {
  const t = tree();
  const original = finding({ evidence: [{ kind: 'code', path: path.join(t.cwd, 'src.ts') }] });
  const input = reportOf([original, finding({ id: 'uncited', severity: 'P0' })]);
  const before = JSON.stringify(input);

  const { report } = groundFindings(input, t.cwd, t.runDir, null);

  assert.equal(JSON.stringify(input), before, 'the input report must be untouched');
  assert.notEqual(report, input);
  assert.equal(report.findings[1]?.severity, 'P2');
  assert.equal(input.findings[1]?.severity, 'P0');
});

test('verdict and summary are copied through untouched', () => {
  const t = tree();
  // Nothing in the loop reads `verdict`, and reconciling it with the
  // post-downgrade blocking count is not this check's business.
  const { report } = groundFindings(reportOf([finding({})]), t.cwd, t.runDir, null);
  assert.equal(report.verdict, 'REVISE');
  assert.equal(report.summary, 'summary');
});

test('every downgraded finding is returned, and only those', () => {
  const t = tree();
  const { downgraded } = groundFindings(
    reportOf([
      finding({ id: 'grounded', evidence: [{ kind: 'code', path: 'src.ts' }] }),
      finding({ id: 'floating-p1' }),
      finding({ id: 'floating-p0', severity: 'P0' }),
      finding({ id: 'floating-p2', severity: 'P2' }),
    ]),
    t.cwd,
    t.runDir,
    null,
  );
  assert.deepEqual(
    downgraded.map((f) => f.id),
    ['floating-p1', 'floating-p0'],
  );
  assert.deepEqual(
    downgraded.map((f) => f.severity),
    ['P2', 'P2'],
  );
});

// ---- evidence nothing has validated -----------------------------------------

/**
 * `hasFindingShape` deliberately does not check `evidence`, so a stored finding
 * can carry anything at all under that key and still be loaded, carried and
 * rendered. Every consumer therefore meets raw `unknown`, and none of them may
 * throw on it: the finding survives, the citation does not.
 */
const JUNK: readonly unknown[] = [
  {},
  { evidence: null },
  { evidence: 'src/run.ts' },
  { evidence: {} },
  { evidence: [null] },
  { evidence: [undefined] },
  { evidence: ['src/run.ts'] },
  { evidence: [{ kind: 'invented' }] },
  { evidence: [{ kind: 'code', path: 42 }] },
];
// Deliberately not in that list: `{kind: 'code', path: 'src.ts', line: 'three'}`
// names a real file, so the unusable `line` is dropped and the citation still
// resolves on the path. That case has its own test below.

test('unusable stored evidence downgrades a blocker instead of throwing', () => {
  const t = tree();
  for (const junk of JUNK) {
    const f = { ...finding(), ...(junk as object) } as Finding;
    const r = ground(t, f);
    assert.equal(r.severity, 'P2', `${JSON.stringify(junk)} must not stay blocking`);
    assert.equal(r.from, 'P1');
  }
});

test('an unusable entry beside a good one still leaves the finding blocking', () => {
  const t = tree();
  const f = {
    ...finding(),
    evidence: [null, { kind: 'code', path: 'src.ts' }],
  } as unknown as Finding;
  assert.equal(ground(t, f).severity, 'P1');
});

test('an unusable citation is kept exactly as stored, not erased', () => {
  const t = tree();
  const f = { ...finding(), evidence: [null] } as unknown as Finding;
  // Erasing it would take the record of what was claimed with it. The renderers
  // refuse to print it; the artifact still says it was there.
  assert.deepEqual(ground(t, f).out.evidence, [null]);
});

test('a line that is not an integer is dropped, not rounded and not fatal', () => {
  const t = tree();
  // Neither `3.5` nor `'3'` is a line number, and neither may be coerced into a
  // claim the model did not make. The rest of the citation is untouched: the
  // file is real, so the entry still resolves on it - tolerant in the direction
  // that cannot cause a false downgrade.
  assert.equal(check(t, { kind: 'code', path: 'src.ts', line: 3.5 }), null);
  assert.equal(
    checkEvidence(
      { kind: 'code', path: 'src.ts', line: '3' } as unknown as Evidence,
      t.cwd,
      t.runDir,
      null,
    ),
    null,
  );
  // And a bad line on a path that is not real still fails on the path.
  assert.notEqual(check(t, { kind: 'code', path: 'nope.ts', line: 3.5 }), null);
});

// ---- a repository at a filesystem root --------------------------------------

test('a repo at a filesystem root does not reject its own children', () => {
  const t = tree();
  // `/` and `C:\` already end in a separator, so a containment prefix built as
  // `base + path.sep` looks for `//` or `C:\\` and matches nothing real.
  const root = path.parse(t.cwd).root;
  const inside = path.relative(root, path.join(t.cwd, 'src.ts'));
  assert.equal(checkEvidence({ kind: 'code', path: inside }, root, root, null), null);
  assert.equal(
    checkEvidence({ kind: 'code', path: path.join(t.cwd, 'src.ts') }, root, root, null),
    null,
  );
  // Climbing out of a root goes nowhere - there is nothing above it - so this
  // resolves back inside and fails on existence instead. Either way it does not
  // pass, and either way nothing outside the root was read.
  assert.notEqual(checkEvidence({ kind: 'code', path: '../nope.ts' }, root, root, null), null);
});

test('a downgrade keeps everything else about the finding', () => {
  const t = tree();
  const r = ground(t, finding({ id: 'kept', title: 'Kept', detail: 'Why.', defer: false }));
  assert.equal(r.out.id, 'kept');
  assert.equal(r.out.title, 'Kept');
  assert.equal(r.out.detail, 'Why.');
  assert.equal(r.out.suggested_fix, 'Fix it.');
  // The downgrade does not defer: `parseFindings` stripped `defer` from the
  // blocking finding before this ran, and re-adding it here would put words in
  // the reviewer's mouth.
  assert.equal(r.out.defer, false);
});
