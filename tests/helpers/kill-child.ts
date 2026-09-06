import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STARTING_LINE } from './kill-markers.js';

/**
 * Spawning `kill-during-save.js` and waiting for it to say `ready`.
 *
 * One copy rather than two. `atomic-state-write.test.ts` and `fork.test.ts` each
 * had their own, identical, and both had the same missing branch (#100): a child
 * that printed nothing and did not exit satisfied neither of the two ways out, so
 * the promise stayed pending forever. `node --test` applies no default timeout -
 * `--test-timeout` is `Infinity` - and there is no CI here to kill it, so that is
 * the whole suite stopped, looking exactly like a slow machine.
 *
 * Its own module for the same reason `kill-markers.ts` is one: `kill-during-save.ts`
 * runs `main()` on import, so anything a test imports has to sit beside it rather
 * than in it.
 */

export const KILL_HELPER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'kill-during-save.js',
);

/** The modes `kill-during-save.ts` implements. */
export type KillMode = 'save' | 'alloc' | 'artifact' | 'fork' | 'hang';

export interface Started {
  child: ChildProcessWithoutNullStreams;
  /** Whatever the child printed after `ready ` - a run directory, or a run id. */
  ready: string;
  /**
   * How many children were spawned to get here: 1 ordinarily, 2 when the first
   * never reached its first line and was retried. Reported rather than hidden,
   * for the reason #135 gives about a flaky gate - the observation is worth more
   * than the tidy result, and a case can assert on it.
   */
  attempts: number;
}

/**
 * Its own type so the readiness failure cannot be mistaken for the assertion
 * failures around it, and so the caller can prove the child really is gone: a
 * message alone would leave "no orphan is left behind" as a claim in a comment.
 */
export class ReadinessTimeout extends Error {
  readonly pid: number | undefined;

  /**
   * Whether the child printed `STARTING_LINE` before it stopped short.
   *
   * Measured, not inferred: `false` means the line never arrived, which is the
   * one thing that says the child had not begun. It is what decides whether a
   * retry is safe, and it is deliberately on the error rather than in its
   * message, because a caller matching English for it would be #133's defect
   * wearing a test harness.
   */
  readonly started: boolean;

  constructor(message: string, pid: number | undefined, started: boolean) {
    super(message);
    this.name = 'ReadinessTimeout';
    this.pid = pid;
    this.started = started;
  }
}

/**
 * Measured rather than picked: 2026-09-02, this machine, time from `spawn` to the
 * `ready` line, 20 spawns per mode. Unloaded, every mode landed between 83ms and
 * 113ms - almost all of it Node start-up, since the work before `ready` is one
 * `createRun` and at most one 17KB artifact write. Run 16 children at once, which
 * is past what the suite does, and the worst was 391ms.
 *
 * Ten seconds is ~25x that worst loaded case. It is deliberately not tight: this
 * exists to turn an infinite hang into a diagnosis, not to police latency, and a
 * timeout that can fire on a busy laptop would be a flake in a suite whose job is
 * to spawn 100 processes.
 *
 * That last sentence is exactly what then happened (#181), and the number is
 * still not the answer: every second added to it is a second a genuine hang
 * spends looking like a slow machine, times the 24 children one case spawns. So
 * it stays at ten, and what changed is that the child now says when it has
 * arrived - see `retryable`.
 */
const READY_TIMEOUT_MS = 10_000;

/** How a child is produced. A seam with a real default, so a case can decide what it gets. */
export type SpawnHelper = (targetDir: string, mode: KillMode) => ChildProcessWithoutNullStreams;

/**
 * The real one.
 *
 * All three streams piped so the child types as `ChildProcessWithoutNullStreams`;
 * stdin is written to only by the modes that wait on it.
 */
export const spawnKillHelper: SpawnHelper = (targetDir, mode) =>
  spawn(process.execPath, [KILL_HELPER, targetDir, mode], { stdio: ['pipe', 'pipe', 'pipe'] });

/**
 * Whether this failure may be spawned again.
 *
 * The whole rule, in one place and exported so it can be asserted directly. Only
 * a readiness timeout whose child never printed its first line qualifies, and the
 * two halves carry different weight:
 *
 * - **Never started** is positive evidence that nothing was attempted. The
 *   modes are not idempotent - `save` creates a run, `fork` creates two - so
 *   "probably harmless" would not be good enough; what makes a second spawn safe
 *   is knowing the first did no work at all.
 * - **Started and then stalled** is the outcome #100 built this wait for, and
 *   retrying it would be the worst available move: it doubles the wait, it can
 *   double the side effects, and it turns the diagnosis back into the flake.
 *   `hang` mode prints the line, so the case that asserts a stall is diagnosed
 *   still spends one timeout and not two.
 *
 * A child that *exited* is not retried either. An exit code is already an
 * answer, and a helper that cannot run is not a helper that was unlucky.
 */
export function retryable(err: unknown): boolean {
  return err instanceof ReadinessTimeout && !err.started;
}

/**
 * Spawn the kill helper in `mode` and resolve once it says it is ready.
 *
 * Three ways out, where there used to be two: the readiness line, the child
 * exiting first, and the child doing neither. The last one kills the child - its
 * `save` and `artifact` loops write forever, so an orphan would keep writing to a
 * temp directory nobody is reading - and names the mode, so the failure cannot be
 * read as one of the assertion failures around it.
 */
function attemptStart(
  targetDir: string,
  mode: KillMode,
  timeoutMs: number,
  spawnHelper: SpawnHelper,
): Promise<Omit<Started, 'attempts'>> {
  return new Promise((resolve, reject) => {
    const child = spawnHelper(targetDir, mode);
    let out = '';
    let stderr = '';
    let started = false;

    // Every path through here runs this first. A timer left armed after the test
    // has its child keeps the event loop alive and would trade one hang for
    // another, and a listener left attached would fire against a settled promise.
    const done = (): void => {
      clearTimeout(timer);
      child.stdout.off('data', onOut);
      child.stderr.off('data', onErr);
      child.off('exit', onExit);
    };
    const onErr = (chunk: Buffer): void => {
      stderr += chunk.toString();
    };
    const onOut = (chunk: Buffer): void => {
      out += chunk.toString();
      // Whole lines only - the last split is whatever has arrived of the next
      // one - and every line is looked at rather than only the first, because
      // `ready` is now the child's second line and a chunk boundary can fall
      // anywhere.
      const lines = out.split('\n');
      for (const raw of lines.slice(0, -1)) {
        const line = raw.replace(/\r$/, '');
        if (line === STARTING_LINE) {
          started = true;
          continue;
        }
        if (!line.startsWith('ready ')) continue;
        done();
        resolve({ child, ready: line.slice('ready '.length).trim() });
        return;
      }
    };
    const onExit = (code: number | null): void => {
      done();
      reject(new Error(`helper exited ${String(code)} before saying ready in ${mode} mode: ${stderr}`));
    };
    const timer = setTimeout(() => {
      done();
      const { pid } = child;
      child.kill('SIGKILL');
      reject(
        new ReadinessTimeout(
          `helper never reached readiness in ${mode} mode: no 'ready' line after ${String(timeoutMs)}ms - ` +
            (started
              ? `it printed ${JSON.stringify(STARTING_LINE)} and then stopped short, so it was running and did not arrive`
              : 'it never printed its first line, so it had not begun running') +
            ` (stdout ${JSON.stringify(out)}, stderr ${JSON.stringify(stderr)})`,
          pid,
          started,
        ),
      );
    }, timeoutMs);

    child.stdout.on('data', onOut);
    child.stderr.on('data', onErr);
    child.on('exit', onExit);
  });
}

export interface StartOptions {
  timeoutMs?: number;
  /** What produces the child. Defaults to the real helper. */
  spawn?: SpawnHelper;
}

/**
 * `attemptStart`, once more if the first child never got as far as running.
 *
 * One retry and not a loop: a second silence is a fact about the machine rather
 * than a moment of bad luck, and a loop would restore the unbounded wait #100
 * removed. The retry is announced on stderr as well as counted on the result, so
 * a suite that passed because of one says so in its own output - the observation
 * is the thing worth keeping, and hiding it would make this the retry that turns
 * a real defect green.
 */
export async function startKillHelper(
  targetDir: string,
  mode: KillMode,
  opts: StartOptions = {},
): Promise<Started> {
  const timeoutMs = opts.timeoutMs ?? READY_TIMEOUT_MS;
  const spawnHelper = opts.spawn ?? spawnKillHelper;

  const first = await attemptStart(targetDir, mode, timeoutMs, spawnHelper).then(
    (started) => ({ ok: true as const, started }),
    (err: unknown) => ({ ok: false as const, err }),
  );
  if (first.ok) return { ...first.started, attempts: 1 };
  if (!retryable(first.err)) throw first.err;

  process.stderr.write(
    `kill-child: the ${mode} helper never printed its first line within ${String(timeoutMs)}ms ` +
      'and had done nothing, so it was spawned once more (#181)\n',
  );

  try {
    return { ...(await attemptStart(targetDir, mode, timeoutMs, spawnHelper)), attempts: 2 };
  } catch (err) {
    // Same failure twice says something the first one could not, so the message
    // says it rather than reading as a single unlucky spawn.
    if (err instanceof ReadinessTimeout) {
      throw new ReadinessTimeout(
        `${err.message} - and this was the second attempt: the first never printed its first line either`,
        err.pid,
        err.started,
      );
    }
    throw err;
  }
}
