import { expect, test } from 'vitest';
// The core's source as a string, through Vite's `?raw`. Deliberately not
// `node:fs`: adding node types to the app's tsconfig would let any component in
// a webview import a filesystem, and no test is worth that.
import orchestrator from '../../../src/orchestrator.ts?raw';
import charge from '../../../src/charge.ts?raw';
import cli from '../../../src/cli.ts?raw';
import preflight from '../../../src/preflight.ts?raw';
import protocol from '../../../src/protocol.ts?raw';
import gates from '../../../src/gates.ts?raw';
import work from '../../../src/work.ts?raw';
// Aliased: `work` is already the core's source above, and this is the renderer
// that has to agree with it. Two things named for one measurement is the
// confusion this whole file exists to catch.
import { ending, hold, work as render } from './format';
import { CYCLE_OF } from './model';

/**
 * The one place the app reaches across into the core, and it reaches for a
 * contract rather than for code (#159).
 *
 * The cockpit places a phase into a cycle through a **closed map**, because a
 * phase it cannot place is left out of the column rather than guessed into one -
 * which is the right behaviour, and also a silent one. A fifth phase added to
 * the loop would simply never appear, and nobody would find out from the app.
 *
 * So: read the phases the core actually narrates, and require every one of them
 * to have a home. This fails on the commit that adds a phase, in the repo that
 * added it, which is the only moment anybody is in a position to decide where it
 * belongs.
 *
 * A **grep for a literal**, not an import of the module. `orchestrator.ts` is
 * NodeNext ESM with `@src/*` aliases; importing it here would drag the whole
 * loop into a webview test to learn four strings.
 */

/** Phases named in a `phase_started` payload. */
function narratedPhases(): string[] {
  // Comments stripped, so a phase discussed in prose is not mistaken for one
  // that is emitted - `phase: 'complete'` appears in a comment about
  // `consistency.ts` and is not a phase the loop ever narrates.
  const code = orchestrator.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const found = new Set<string>();
  for (const m of code.matchAll(/id:\s*'phase_started'[\s\S]{0,200}?phase:\s*'([a-z-]+)'/g)) {
    if (m[1] !== undefined) found.add(m[1]);
  }
  return [...found].sort();
}

test('the core narrates the four phases this version knows about', () => {
  // Pinned so the set is visible here rather than only in the loop. If this
  // fails, read the diff before touching it: a new phase is a decision about
  // which cycle it belongs to, not a list to extend.
  expect(narratedPhases()).toEqual(['critique', 'implementing', 'planning', 'review']);
});

test('every phase the core narrates has a cycle to sit in', () => {
  for (const phase of narratedPhases()) {
    expect(Object.keys(CYCLE_OF)).toContain(phase);
  }
});

/** The `EXIT` table in `src/charge.ts`, as `[name, code]` pairs. */
function exitCodes(): Array<[string, number]> {
  const table = /export const EXIT = \{([\s\S]*?)\n\} as const;/.exec(charge)?.[1];
  // A hard failure rather than an empty list. An empty one would make every
  // assertion below vacuously pass, which is the shape of guard that reports
  // green for years after the thing it watched moved.
  if (table === undefined) throw new Error('EXIT table not found in src/charge.ts');
  const found: Array<[string, number]> = [];
  for (const m of table.matchAll(/^\s{2}([A-Z_]+): (\d+),$/gm)) {
    const [, name, code] = m;
    if (name !== undefined && code !== undefined) found.push([name, Number(code)]);
  }
  return found;
}

test('the eight exit codes this build has phrases for', () => {
  // Pinned so the set is visible here and not only in the core. A ninth code is
  // a decision about what to tell somebody it happened to - read the diff before
  // extending this.
  expect(exitCodes()).toEqual([
    ['OK', 0],
    ['ERROR', 1],
    ['NEEDS_HUMAN', 2],
    ['NO_CONVERGENCE', 3],
    ['BUDGET', 4],
    ['RATE_LIMITED', 5],
    ['PREFLIGHT', 6],
    ['UNVERIFIED', 7],
  ]);
});

test('every exit code the core can return has a phrase in the footer', () => {
  for (const [name, code] of exitCodes()) {
    expect(ending(code), `${name} (${code}) has no phrase`).not.toBeNull();
  }
});

test('neither of the two endings that are not failures uses the word failed', () => {
  // `UNVERIFIED` is documented in the core as "not an error and not a stall",
  // and `NEEDS_HUMAN` is how an ordinary long run pauses. Calling either a
  // failure sends somebody looking for a bug in work that is fine, which is the
  // specific smoothing #162 was filed to prevent.
  for (const code of [2, 7]) {
    const how = ending(code);
    expect(how).not.toBeNull();
    const text = `${how?.kicker} ${how?.detail} ${how?.next ?? ''}`.toLowerCase();
    expect(text).not.toContain('fail');
    expect(text).not.toContain('error');
  }
});

test('a code from a newer core has no phrase invented for it', () => {
  expect(ending(8)).toBeNull();
  expect(ending(-1)).toBeNull();
});

/** The `GATEABLE` list in `src/gates.ts` — every boundary a run can hold at. */
function gateable(): string[] {
  const list = /export const GATEABLE: readonly GateableBoundary\[\] = \[([\s\S]*?)\];/.exec(
    gates,
  )?.[1];
  // Hard failure rather than an empty list, for `exitCodes`'s reason: an empty
  // one makes every assertion below vacuously pass.
  if (list === undefined) throw new Error('GATEABLE not found in src/gates.ts');
  return [...list.matchAll(/'([a-z-]+)'/g)].map((m) => m[1] ?? '');
}

test('every boundary a run can hold at says what it is asking', () => {
  // The silent failure this catches is the one #211 was reported as: a footer
  // that names the boundary and nothing else leaves somebody pressing continue
  // without knowing what it buys. A seventh gateable boundary would draw that
  // same bare card, and nobody would find out from the app — so this fails in
  // the repo that adds one, which is the only moment anybody can decide what to
  // tell a person about it.
  for (const boundary of gateable()) {
    const held = hold(boundary);
    expect(held, `${boundary} has no description`).not.toBeNull();
    // All three, because a card missing any one of them is the bare card again:
    // what finished, where to look, and what continuing spends.
    expect(held?.what.length, `${boundary} says nothing about what finished`).toBeGreaterThan(0);
    expect(held?.inspect.length, `${boundary} says nothing to inspect`).toBeGreaterThan(0);
    expect(held?.cost.length, `${boundary} says nothing about the cost`).toBeGreaterThan(0);
  }
});

test('the six this build describes, and no phrase invented for a seventh', () => {
  expect(gateable()).toEqual([
    'plan-round',
    'question-round',
    'plan-approved',
    'implemented',
    'verify-round',
    'review-round',
  ]);
  // The two ungateable boundaries have no card either, and that is right: a run
  // never holds at them, so a description of what to do there would describe a
  // decision nobody is ever offered.
  expect(hold('final-fix')).toBeNull();
  expect(hold('complete')).toBeNull();
});

/**
 * The two narration ids the footer's reason line depends on.
 *
 * Reading the core's source rather than trusting a comment, because the failure
 * mode is silent in exactly the way #159's phase map was: drop the id from
 * `cli.ts` and the footer simply stops showing why a run failed, with nothing
 * anywhere going red. This fails in the repo that removed it.
 */
test('the core still marks the two places a run ends badly', () => {
  expect(cli).toContain("id: 'run_escalated'");
  expect(cli).toContain("id: 'run_failed'");
});

/**
 * The two frames the footer's controls send (#209, #210).
 *
 * `host.pause()` and `host.cancel()` put a line on a wire the core has to
 * recognise, and the failure is quiet in a way a user would never diagnose: an
 * unknown `type` is refused with an `error` frame, which lands in the log pane
 * rather than anywhere near the button that was pressed. So the button appears
 * to do nothing, twice, and the run carries on.
 *
 * Read from `decode`'s own switch rather than from the `Inbound` union, because
 * the union is a type and the switch is what actually runs.
 */
test('the core still accepts the two frames the footer sends', () => {
  const body = /export function decode\([\s\S]*?\n\}/.exec(protocol)?.[0];
  if (body === undefined) throw new Error('decode not found in src/protocol.ts');
  expect(body).toContain("case 'pause':");
  expect(body).toContain("case 'cancel':");
});

/**
 * The three ids the preflight row reads (#205).
 *
 * The row exists to fill the one stretch of a run where the window had nothing
 * true to say, so an id dropped from the core puts the silence back — and the
 * row would sit on "checking…" for the rest of the run if only the ending went.
 * The order claim matters as much: `PROBE_ORDER` is what the announcement is
 * built from, so the list a window draws cannot describe a different sequence
 * from the one that runs.
 */
test('the core narrates preflight starting, each probe, and the verdict', () => {
  expect(cli).toContain("id: 'preflight_started'");
  expect(cli).toContain("id: 'probe_started'");
  expect(cli).toContain("id: 'preflight_passed'");
  expect(cli).toContain('agents: [...PROBE_ORDER]');
  expect(preflight).toContain('export const PROBE_ORDER');
  // Announced immediately before each probe rather than after, which is the
  // whole point: the child process is the wait.
  const body = /export async function preflight\([\s\S]*?\n\}/.exec(preflight)?.[0];
  if (body === undefined) throw new Error('preflight not found in src/preflight.ts');
  expect(body.indexOf("announce('claude')")).toBeLessThan(body.indexOf('probes.claude('));
  expect(body.indexOf("announce('codex')")).toBeLessThan(body.indexOf('probes.codex('));
});

/**
 * The id that says which run this is (#207).
 *
 * Three sites, and the count is the claim worth pinning: one start and two
 * resume paths, because a resumed run is the one a person is most likely to be
 * looking for on disk and the one that would silently have no identity if a
 * path were missed. `runId` and `dir` are required by the reducer together, so
 * a site that carried only one would produce a run the window still cannot
 * name.
 */
test('every path that begins a run says which run it is', () => {
  const sites = [...cli.matchAll(/id: 'run_started'/g)];
  expect(sites.length, 'one start and two resume paths').toBe(3);
  for (const field of ['runId:', 'dir:', 'resumed:']) {
    const carried = [...cli.matchAll(/id: 'run_started',\s*data: \{([^}]*)\}/g)];
    expect(carried.length).toBe(3);
    for (const m of carried) expect(m[1] ?? '', `run_started no longer sends ${field}`).toContain(field);
  }
});

/**
 * The two ids the diffstat line depends on, and the fields it reads (#198).
 *
 * The same silent failure mode as the phase map, and it already happened once:
 * the row named #136 as the issue that would supply it, #136 landed, and nobody
 * connected the two - so for the whole of v1.4 the row said the loop reported no
 * file counts while the loop narrated them every thirty seconds. Nothing went
 * red, because an id the reducer does not recognise reaches the output pane and
 * that is correct behaviour.
 *
 * This fails in the repo that renames either id or drops a field, which is the
 * only moment anybody is in a position to notice.
 */
test('the core narrates the two work ids the running row reads', () => {
  expect(work).toContain("id: 'work_progress'");
  expect(orchestrator).toContain("'work_measured'");
});

test('the record still carries the fields the row reads out of it', () => {
  // Read from `workData`'s own body rather than from a comment about it. `files`
  // is the one the reducer requires; the rest are optional on the wire and
  // optional here, which is the distinction that keeps absent from becoming
  // zero.
  const body = /export function workData\([\s\S]*?\n\}/.exec(work)?.[0];
  if (body === undefined) throw new Error('workData not found in src/work.ts');
  for (const field of ['files', 'insertions', 'deletions', 'uncounted', 'planNamed', 'planTouched']) {
    expect(body, `workData no longer sends ${field}`).toContain(field);
  }
});

test('the proxy is worded as a count of files, never as a position in the plan', () => {
  // `src/work.ts` states the rule and `implement-progress.test.ts` guards the
  // terminal's half of it. This is the cockpit's half, and it matters more here:
  // `9/14` on the primary screen, beside a duration, during the phase somebody
  // watches for ninety minutes, is the most prominent fabricated number the
  // product could show. It is a count of files that happen to be named in the
  // plan - not step nine of fourteen.
  const line = render({
    files: 9,
    insertions: 412,
    deletions: 38,
    uncounted: 2,
    plan: { named: 14, touched: 9 },
  });
  expect(line).toContain('9 of the 14 files the plan names');
  expect(line).not.toMatch(/step/i);
  expect(line).not.toContain('%');
  expect(line).not.toContain('9/14');
});

test('a turn that changed nothing says so, and a diffstat half-measured is omitted', () => {
  expect(render({ files: 0, insertions: null, deletions: null, uncounted: 0, plan: null })).toBe(
    'changed nothing in the tree',
  );
  // One half of a diffstat is not a diffstat. Supplying the other as zero would
  // be a count nobody took.
  expect(
    render({ files: 3, insertions: 40, deletions: null, uncounted: 0, plan: null }),
  ).toBe('3 files changed');
});
