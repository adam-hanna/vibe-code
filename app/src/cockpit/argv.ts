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
