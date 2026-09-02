import { allocateRun, artifact, createRun, saveState, writeCheckpoint } from '@src/run.js';
import { commitFork, planFork } from '@src/fork.js';
import { DEFAULTS } from '@src/config.js';
import {
  ALLOC_CONTEXT_PADDING,
  ALLOC_CONTEXT_PREFIX,
  ALLOC_MODEL,
  ARTIFACT_BODY_A,
  ARTIFACT_BODY_B,
} from './kill-markers.js';

/**
 * A child that does nothing but call the real `saveState`, so a parent can kill
 * it mid-write.
 *
 * The whole point is that this is not a fake. `renameSync` being called proves
 * nothing about what a `SIGKILL` between two syscalls leaves on disk, and the
 * bug this guards - a truncate-then-write cut in half - only ever appeared in a
 * process that stopped without unwinding. So the parent kills a real Node
 * process at points spread across a real write of a realistically large state,
 * and reads the file back.
 *
 * Argv: `<targetDir> <mode>`.
 *   `save`  - create a run, print `ready <dir>`, then rewrite it in a loop.
 *   `alloc` - allocate the directory, print `ready <dir>` while it is still
 *             empty, then initialise it in a loop. The parent's kill lands in
 *             the window between allocation and the first state write, which is
 *             the window this mode exists to open: the previous version of this
 *             helper called `createRun` before printing `ready`, so every kill
 *             landed after the state was already whole and the assertion held
 *             for reasons that had nothing to do with the code under test.
 *   `artifact` - the same shape as `save`, but through `artifact()` and at a
 *             lifelike size. A different failure mode; see `artifactMode`.
 *   `hang`  - never prints `ready` and never exits. Not a kill window: it is the
 *             third outcome the parent's readiness wait has to survive (#100),
 *             and the only way to assert that is a child that really does hang.
 *
 * Each save carries a marker: the parent asserts the file it recovers parses AND
 * holds one of the two legal markers, which is what "the whole previous file or
 * the whole new one" means. A file that parsed but held a spliced-together
 * marker would be corruption this test could see.
 */

/**
 * Big enough that the write this guards against can actually be caught in half.
 *
 * A real run's state.json is ~96KB, and at that size a measurement on Windows
 * found the OLD truncate-then-write surviving 40 kills out of 40: `writeFileSync`
 * reaches the filesystem as one write that `TerminateProcess` cannot split. At
 * ~1.1MB the same measurement tore 2 times in 40. So the payload here is ~1.1MB
 * rather than lifelike: a fixture sized to the average case would have passed
 * against the very bug it exists to catch, which is worse than no fixture.
 *
 * What that measurement also says, and the reason this is not merely a bigger
 * number: the ~96KB window is narrow on this platform, not absent. It is one
 * write every five seconds for the length of a run, and #60's kill landed in it.
 */
const PADDING_EVENTS = 4_000;
const PADDING_TEXT = 'x'.repeat(250);

/**
 * What the parent checks the first persisted state carries, and the reason this
 * mode passes them explicitly: a run initialised without them is a run that
 * resumes on the defaults, which is the failure the split into
 * `allocateRun` + `createRun` exists to prevent.
 */
const ALLOC_CONTEXT = `${ALLOC_CONTEXT_PREFIX}${PADDING_TEXT.repeat(ALLOC_CONTEXT_PADDING)}`;

function saveMode(targetDir: string): void {
  const state = createRun(targetDir, 'kill during save', true);
  for (let i = 0; i < PADDING_EVENTS; i++) {
    state.events.push({ at: new Date().toISOString(), type: 'padding', note: PADDING_TEXT });
  }
  state.task = 'A';
  saveState(state);

  process.stdout.write(`ready ${state.dir}\n`);
  // Alternate the marker so the parent can tell which whole file it recovered.
  // No pause between writes: the kill has to be able to land inside one.
  for (let i = 0; ; i++) {
    state.task = i % 2 === 0 ? 'B' : 'A';
    saveState(state);
  }
}

/**
 * The same shape as `saveMode`, through `artifact()` instead - and deliberately
 * NOT sized like the state.json fixture above.
 *
 * `PADDING_EVENTS` is ~1.1MB because state.json's failure is *tearing*, and
 * tearing needed a write long enough for `TerminateProcess` to land inside. That
 * note is still right about that. This is the other failure mode: `writeFileSync`
 * opens `O_TRUNC`, so the file is emptied at open and a kill in that window
 * leaves ZERO bytes, not a splice. The truncate window is roughly fixed while
 * the write after it grows, so a smaller artifact is damaged more often, not
 * less: measured on 2026-08-28 against `develop` at `99eca2e`, 40 kills per
 * size, a 17KB body was destroyed 5 times in 40 where a 1.1MB one was destroyed
 * 2. Inflating this fixture would make the test *less* sensitive, which is why
 * ~17KB - the size of a real `PLAN.md` - is the honest number here.
 *
 * `PLAN.md` and not `OUTSTANDING.md`: `artifact()` is one seam with no
 * name-specific behaviour. The reason the bug matters most for OUTSTANDING.md is
 * that `recoverOutstanding` skips it on `existsSync` and
 * `settlePendingOutstanding` skips it for want of its marker, so an empty one is
 * stuck permanently between the two - but that is the motivation, not a second
 * thing to test.
 */
function artifactMode(targetDir: string): void {
  const state = createRun(targetDir, 'kill during artifact', true);
  artifact(state, 'PLAN.md', ARTIFACT_BODY_A);

  process.stdout.write(`ready ${state.dir}\n`);
  // Alternate the body so the parent can tell which whole file it recovered.
  // No pause between writes: the kill has to be able to land inside one.
  for (let i = 0; ; i++) {
    artifact(state, 'PLAN.md', i % 2 === 0 ? ARTIFACT_BODY_B : ARTIFACT_BODY_A);
  }
}

/**
 * Allocated but not yet initialised, and it stays that way until the parent says
 * otherwise.
 *
 * The pause is a line on stdin rather than a timer, so the parent can decide
 * which of the two windows it is testing: kill without writing anything and the
 * child has only ever allocated, which proves allocation alone persists no
 * state; write `go` and kill after a delay and the kill lands somewhere in the
 * first state write.
 */
function allocMode(targetDir: string): void {
  const allocated = allocateRun(targetDir, 'kill during save');
  process.stdout.write(`ready ${allocated.dir}\n`);

  process.stdin.once('data', () => {
    createRun(targetDir, 'kill during save', true, {
      allocated,
      config: { ...DEFAULTS, claude: { ...DEFAULTS.claude, model: ALLOC_MODEL } },
      extraContext: ALLOC_CONTEXT,
    });
    // Idle: the parent is killing this to see what the directory looks like at
    // rest, whenever its kill happens to land.
    setInterval(() => {}, 1_000);
  });
  process.stdin.resume();
}

/**
 * A parent run with one checkpoint, then a fork of it - with the parent process
 * free to kill this one anywhere inside `commitFork`.
 *
 * The property under test is that the child run is complete or absent: there is
 * no moment at which a directory under `.vibe/runs` holds a run that points at
 * an artifact nobody wrote. `commitFork` writes the child's `state.json` last
 * for exactly that reason, and only a real kill can show it - asserting the
 * order of the calls would be asserting the implementation back at itself.
 *
 * The checkpoint is padded to ~1.1MB for the reason `PADDING_EVENTS` gives one
 * function up: at a lifelike size the final write is a single syscall that
 * `TerminateProcess` does not split, so the kill would land in the window
 * without ever exercising it.
 */
function forkMode(targetDir: string): void {
  const parent = createRun(targetDir, 'kill during fork', true, {
    config: { ...DEFAULTS, git: { ...DEFAULTS.git, useBranch: false } },
  });
  for (let i = 0; i < PADDING_EVENTS; i++) {
    parent.events.push({ at: new Date().toISOString(), type: 'padding', note: PADDING_TEXT });
  }
  parent.plan = {
    plan_md: '# the plan',
    assumptions: [],
    open_questions: [],
    out_of_scope: [],
    acceptance_criteria: [],
  };
  saveState(parent);
  writeCheckpoint(parent, 'plan-round', { sha: null, note: 'no-commit-in-round' });

  process.stdout.write(`ready ${parent.id}\n`);
  process.stdin.once('data', () => {
    void (async (): Promise<void> => {
      const plan = await planFork(targetDir, parent.id, 1, { git: { useBranch: false } });
      await commitFork(targetDir, plan);
      // Idle: the parent is killing this to see what the runs root looks like at
      // rest, whenever its kill happens to land.
      setInterval(() => {}, 1_000);
    })();
  });
  process.stdin.resume();
}

/**
 * Neither of the two things the parent waits for.
 *
 * Nothing on stdout, no exit, and no filesystem work at all - the point is the
 * shape a stalled child has from outside, not any particular way of stalling.
 * The real ones this stands for stall inside `createRun` or the first artifact
 * write: a contended temp directory, a scanner holding a handle, a full disk.
 */
function hangMode(): void {
  setInterval(() => {}, 1_000);
}

function main(): void {
  const targetDir = process.argv[2];
  const mode = process.argv[3] ?? 'save';
  if (targetDir === undefined) throw new Error('usage: kill-during-save <targetDir> [mode]');

  if (mode === 'alloc') allocMode(targetDir);
  else if (mode === 'fork') forkMode(targetDir);
  else if (mode === 'artifact') artifactMode(targetDir);
  else if (mode === 'hang') hangMode();
  else saveMode(targetDir);
}

main();
