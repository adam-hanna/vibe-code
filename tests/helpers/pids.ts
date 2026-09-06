/**
 * A pid this host is not using, for the handful of cases that must go through
 * the real probe.
 *
 * **Most cases should not call this.** `livenessOf` and `acquireLock` take a
 * `PidProbe`, so a case about what a *verdict* means can state its premise
 * instead of arranging for it; that is what #164 added and what the four
 * verdict cases in `process-endings.test.ts` now do. What is left here is the
 * cases that drive the real `main`, where the claim is about the command's
 * ordering and the probe is genuinely part of the path under test.
 *
 * This replaces the `deadPid` that spawned a Node process and took its pid once
 * it exited. That number is the OS's allocation pointer, which is the likeliest
 * value for the next spawn to be handed - and this suite spawns a great many, so
 * it duly came back and turned `develop` red for a night. Starting far ahead of
 * the pointer instead is not a proof, and the comment below says exactly what
 * residual is being accepted; it is a fixture that has to be *raced into*
 * rather than one that merely has to be waited for.
 *
 * Same class of defect as the epoch timestamp AGENTS.md already has a rule
 * about, with the process table as the clock rather than the calendar.
 */

/**
 * A pid that answers `ESRCH` right now, found by asking rather than assuming.
 *
 * Starts at `process.pid + 100_000`, which on a sequentially-allocating kernel
 * is a hundred thousand spawns ahead of anything this suite will reach, and on
 * Windows - where pids come from a reuse pool and are not sequential - is simply
 * a candidate like any other, which is why every candidate is probed.
 *
 * **The residual race is real and is not pretended away**: a process could in
 * principle be handed this pid between the probe returning and the assertion
 * running. It is microseconds against the milliseconds-wide window `deadPid`
 * left open at the one number the OS was about to reuse, and it is why the cases
 * that can avoid a real pid entirely now do.
 *
 * Bounded rather than `for (;;)`: a host with no free pid in the scanned range
 * should fail the case with a sentence, not hang the suite with no output.
 */
export function absentPid(): number {
  const start = process.pid + 100_000;
  for (let candidate = start; candidate < start + 10_000; candidate += 1) {
    try {
      process.kill(candidate, 0);
    } catch (err: unknown) {
      // Only ESRCH. EPERM is someone else's live process, and anything else is
      // a probe that failed - `probePid` calls both of those something other
      // than `interrupted`, so a fixture built on either would not be one.
      if ((err as { code?: unknown } | null)?.code === 'ESRCH') return candidate;
    }
  }
  throw new Error(
    `no pid in [${String(start)}, ${String(start + 10_000)}) answered ESRCH; ` +
      'this host has no absent pid to build the fixture from',
  );
}
