/**
 * A form, to an argv.
 *
 * `Launch.tsx` claims this is a pure function so that the set of legal
 * invocations still has exactly one definition and it is `parseArgs`. That claim
 * stopped being free the moment a second caller appeared: the pilot's
 * `start_run` proposes a launch, and a launch it built its own way would be a
 * second definition of the form, drifting from the button's on the next flag
 * anybody adds (#144).
 *
 * So the button and the tool build the same argv here, and a test that pins the
 * shape pins both.
 */
export function launchArgv(task: string, dir: string, planOnly: boolean): readonly string[] {
  // `plan` and `run` are two commands rather than a flag, exactly as the CLI has
  // them. Trimmed here rather than by each caller, because a trailing newline in
  // a path is a directory that does not exist and the error it produces says so
  // in the least helpful possible way.
  return [planOnly ? 'plan' : 'run', task.trim(), '-C', dir.trim()];
}

/** What a launch asked for. Every field came out of the argv that was sent. */
export interface Launched {
  task: string;
  dir: string;
  planOnly: boolean;
}

/**
 * Read a launch back out of the argv that was sent (#191).
 *
 * The pilot has to be able to say what run it is sitting beside, and **the brief
 * is the one fact no frame carries** - the loop narrates phases, turns and gates,
 * and never the text it was given. But the window had it, in the argv it sent,
 * and remembering your own outbound message is not the re-derivation this app
 * refuses. Nothing here is inferred from a sentence or filled in for a missing
 * field.
 *
 * It lives beside `launchArgv` because the two have to agree about the shape, and
 * a reader written anywhere else would drift from the builder on the next flag
 * anybody adds. **It recognises only what `launchArgv` produces** - an argv from
 * a newer build, or one a pilot proposed with a flag this version has never seen,
 * is `null` rather than a partially-understood launch. Absent is a legal answer
 * here and a guess is not.
 */
export function readLaunchArgv(argv: readonly string[]): Launched | null {
  if (argv.length !== 4) return null;
  const [command, task, dash, dir] = argv;
  if (command !== 'plan' && command !== 'run') return null;
  if (dash !== '-C') return null;
  if (task === undefined || dir === undefined || task === '' || dir === '') return null;
  return { task, dir, planOnly: command === 'plan' };
}
