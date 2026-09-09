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
/**
 * What `4a`'s overrides block can express, and nothing it cannot.
 *
 * Every field here is a flag `parseArgs` already takes. That is the constraint
 * the whole modal is built under: a control with no flag behind it would be a
 * promise the app cannot keep, and the design's own overrides block is described
 * as *"only what differs from project defaults"* — which means the form has to
 * be able to send a difference, not a whole configuration.
 */
export interface Overrides {
  /** `--max-tokens`. The one ceiling that bounds Codex work. Null leaves it alone. */
  maxTokens?: number | null;
  /** `--gate <boundary>=<mode>`, repeatable. Only the rows that differ. */
  gates?: Readonly<Record<string, string>>;
  /** `--role <role>:<key>=<value>`, repeatable, and it PATCHES rather than replaces. */
  roles?: readonly { role: string; key: string; value: string }[];
  /** `--p1-tolerance`. How many P1s a phase may carry rather than fix. */
  p1Tolerance?: number | null;
}

export function launchArgv(
  task: string,
  dir: string,
  planOnly: boolean,
  over: Overrides = {},
): readonly string[] {
  // `plan` and `run` are two commands rather than a flag, exactly as the CLI has
  // them. Trimmed here rather than by each caller, because a trailing newline in
  // a path is a directory that does not exist and the error it produces says so
  // in the least helpful possible way.
  const argv: string[] = [planOnly ? 'plan' : 'run', task.trim(), '-C', dir.trim()];

  // Sorted, so the same overrides always build the same argv. Two forms that
  // differ only in the order a person clicked would otherwise produce two
  // different commands, and one of them would be the one in a bug report.
  for (const [boundary, mode] of Object.entries(over.gates ?? {}).sort()) {
    argv.push('--gate', `${boundary}=${mode}`);
  }
  for (const r of [...(over.roles ?? [])].sort((a, b) =>
    `${a.role}:${a.key}`.localeCompare(`${b.role}:${b.key}`),
  )) {
    argv.push('--role', `${r.role}:${r.key}=${r.value}`);
  }
  // Null and undefined both mean "leave it alone", and neither becomes a zero:
  // `--max-tokens 0` turns the ceiling OFF, which is the opposite of not saying.
  if (typeof over.maxTokens === 'number') argv.push('--max-tokens', String(over.maxTokens));
  if (typeof over.p1Tolerance === 'number') {
    argv.push('--p1-tolerance', String(over.p1Tolerance));
  }
  return argv;
}

/**
 * Pick a halted run back up (`4d`, #223).
 *
 * **The one action a halt banner can actually offer**, and it is what makes the
 * design's rule — *"every halt names a next action, never just a reason"* —
 * something this app does rather than something it prints. Every other choice
 * `4d` draws (`+2 rounds`, `implement anyway`, `swap the reviewer`) would have
 * to change the run's configuration on the way in, and `src/host.ts` is explicit
 * that anything mutating run state needs its own validator before it is offered.
 *
 * Same four-slot shape as `launchArgv`, and here for the same reason: two places
 * building a `vibe` invocation is how they come to disagree about one. The run
 * id is the one #207 put on the wire, so this is the window repeating a fact it
 * was told rather than reconstructing a path.
 */
export function resumeArgv(
  runId: string,
  dir: string,
  raise: Raise = {},
  /**
   * Take the lock even though one is already held (#211).
   *
   * **Only for a lock whose holder is gone.** `--force` describes one
   * invocation's willingness to take a lock and is deliberately not a config
   * setting; here it is deliberately not a default either, because two writers
   * on one run is the state `src/lock.ts` exists to prevent and a window that
   * always forced would defeat it.
   *
   * The caller offers it on `liveness: 'interrupted'` - a dead pid with no
   * `ending.json` beside it - which is exactly the state a killed host leaves
   * and the only one where nothing is being overruled. Before this the app had
   * no way to send it at all, so a run whose host was killed could not be
   * reopened from the window that killed it.
   */
  force = false,
): readonly string[] {
  const argv = ['resume', runId.trim(), '-C', dir.trim()];
  // Before the raises, so the argv a person reads groups the thing that changes
  // *whether* this runs ahead of the things that change what it may spend.
  if (force) argv.push('--force');
  // Sorted for the reason `launchArgv`'s overrides are: the same choice must
  // always build the same command, or the one in a bug report is not the one
  // that ran.
  for (const [flag, value] of Object.entries(raise).sort()) {
    if (typeof value === 'number') argv.push(`--${flag}`, String(value));
  }
  return argv;
}

/**
 * What a halt banner may raise on the way back in (`4d`, #223).
 *
 * `4d` gives every halt a choice — `+2 rounds`, `+2M and resume` — and each of
 * those is a **cap raised on the resume**, which is exactly what AGENTS.md
 * already tells a human to do by hand: *"`vibe resume <run-id>`, usually with a
 * raised `--max-tokens`."* So the button does the documented thing rather than a
 * new one.
 *
 * The keys are flag names without their dashes, so nothing here can name a flag
 * `parseArgs` does not take without it being visible at the call site.
 */
export interface Raise {
  'max-plan-rounds'?: number;
  'max-review-rounds'?: number;
  'max-tokens'?: number;
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
/**
 * The flags `launchArgv` can emit, each taking one value.
 *
 * **The reader accounts for every one rather than skipping the tail**, which is
 * what keeps the round trip a real guard: a flag added to the builder and not
 * added here makes this return `null`, and the test that pins the round trip
 * fails. Ignoring anything after the fourth slot would have made the two halves
 * silently free to drift, which is the failure this pair exists to catch.
 */
const KNOWN_FLAGS: ReadonlySet<string> = new Set([
  '--gate',
  '--role',
  '--max-tokens',
  '--p1-tolerance',
]);

export function readLaunchArgv(argv: readonly string[]): Launched | null {
  if (argv.length < 4) return null;
  const [command, task, dash, dir] = argv;
  if (command !== 'plan' && command !== 'run') return null;
  if (dash !== '-C') return null;
  if (task === undefined || dir === undefined || task === '' || dir === '') return null;

  // Everything after the four positional slots must be a `--flag value` pair
  // this build knows. An argv from a newer build, or one a pilot proposed with a
  // flag this version has never seen, is `null` rather than a partially
  // understood launch - absent is a legal answer here and a guess is not.
  for (let i = 4; i < argv.length; i += 2) {
    const flag = argv[i];
    if (flag === undefined || !KNOWN_FLAGS.has(flag)) return null;
    if (argv[i + 1] === undefined) return null;
  }
  return { task, dir, planOnly: command === 'plan' };
}
