import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
}

/**
 * Its own type so the readiness failure cannot be mistaken for the assertion
 * failures around it, and so the caller can prove the child really is gone: a
 * message alone would leave "no orphan is left behind" as a claim in a comment.
 */
export class ReadinessTimeout extends Error {
  readonly pid: number | undefined;

  constructor(message: string, pid: number | undefined) {
    super(message);
    this.name = 'ReadinessTimeout';
    this.pid = pid;
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
 */
const READY_TIMEOUT_MS = 10_000;

/**
 * Spawn the kill helper in `mode` and resolve once it says it is ready.
 *
 * Three ways out, where there used to be two: the readiness line, the child
 * exiting first, and the child doing neither. The last one kills the child - its
 * `save` and `artifact` loops write forever, so an orphan would keep writing to a
 * temp directory nobody is reading - and names the mode, so the failure cannot be
 * read as one of the assertion failures around it.
 */
export function startKillHelper(
  targetDir: string,
  mode: KillMode,
  opts: { timeoutMs?: number } = {},
): Promise<Started> {
  const timeoutMs = opts.timeoutMs ?? READY_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    // All three piped so the child types as `ChildProcessWithoutNullStreams`;
    // stdin is written to only by the modes that wait on it.
    const child = spawn(process.execPath, [KILL_HELPER, targetDir, mode], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let stderr = '';

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
      const line = out.split('\n')[0] ?? '';
      if (!line.startsWith('ready ')) return;
      done();
      resolve({ child, ready: line.slice('ready '.length).trim() });
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
          `helper never reached readiness in ${mode} mode: no 'ready' line after ${String(timeoutMs)}ms ` +
            `(stdout ${JSON.stringify(out)}, stderr ${JSON.stringify(stderr)})`,
          pid,
        ),
      );
    }, timeoutMs);

    child.stdout.on('data', onOut);
    child.stderr.on('data', onErr);
    child.on('exit', onExit);
  });
}
