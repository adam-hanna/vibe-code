import { createRun, saveState } from '@src/run.js';

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
 *   `alloc` - allocate and initialise once, print `ready <dir>`, then idle.
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

function main(): void {
  const targetDir = process.argv[2];
  const mode = process.argv[3] ?? 'save';
  if (targetDir === undefined) throw new Error('usage: kill-during-save <targetDir> [mode]');

  const state = createRun(targetDir, 'kill during save', true);
  for (let i = 0; i < PADDING_EVENTS; i++) {
    state.events.push({ at: new Date().toISOString(), type: 'padding', note: PADDING_TEXT });
  }
  state.task = 'A';
  saveState(state);

  process.stdout.write(`ready ${state.dir}\n`);
  if (mode !== 'save') {
    // Nothing further to do: the parent is killing this to see what the run
    // directory looks like at rest.
    setInterval(() => {}, 1_000);
    return;
  }

  // Alternate the marker so the parent can tell which whole file it recovered.
  // No pause between writes: the kill has to be able to land inside one.
  for (let i = 0; ; i++) {
    state.task = i % 2 === 0 ? 'B' : 'A';
    saveState(state);
  }
}

main();
