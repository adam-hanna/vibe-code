import { describe, expect, test } from 'vitest';
import lock from '../../../src/lock.ts?raw';
import { forcing } from './Workstreams';
import type { ArchiveRun } from '../host';

/**
 * When reopening a run has to take a lock somebody else is holding (#211).
 *
 * The window could not send `--force` at all, so a run whose host had been
 * killed was unreopenable from the window that killed it - and that is not a
 * rare state: a stale lock with no `ending.json` beside it is #131's signature
 * for a host terminated without running a line of its own code, which is what
 * every hard kill of the app leaves behind.
 *
 * **The decision is `liveness`, and it is the core's verdict rather than one
 * derived here.** `livenessOf` reads the lock, probes the pid and reads the
 * ending stamp; this only decides what to offer for each of its four answers.
 * The one that must never be offered is `running`: forcing there puts two
 * writers on one `state.json`, which is the thing `src/lock.ts` exists to
 * prevent.
 */

const run = (over: Partial<ArchiveRun> = {}): ArchiveRun => ({
  id: '20260908-163330-build-a-todo-app',
  status: 'implementing',
  task: 'build a todo app',
  costUsd: 1.95,
  ...over,
});

describe('what reopening costs, per liveness verdict', () => {
  test('an interrupted run offers the force, because there is nothing to overrule', () => {
    // The state a killed host leaves: dead pid, no ending stamp. This is the
    // case the whole change exists for.
    const lock = forcing(run({ liveness: 'interrupted' }));
    expect(lock?.needed).toBe(true);
    // And it says what it is taking, in the lock's own terms rather than as a
    // warning glyph - the generic sentence is the one people click through.
    expect(lock?.why).toMatch(/killed|gone/);
  });

  test('a running run is refused, and says why rather than going quiet', () => {
    // Two writers on one state file is the thing the lock exists to prevent, so
    // this is never offered. A disabled control with no explanation would leave
    // somebody assuming the app was broken.
    const lock = forcing(run({ liveness: 'running' }));
    expect(lock?.needed).toBe(false);
    expect(lock?.why).toMatch(/two writers|holding/);
  });

  test('an unknown verdict offers it, labelled as the guess it is', () => {
    // #77's probe refuses to guess, so `unknown` is a real answer - and a run
    // nobody can classify would otherwise be permanently unreopenable.
    const lock = forcing(run({ liveness: 'unknown' }));
    expect(lock?.needed).toBe(true);
    expect(lock?.why).toMatch(/could not tell/);
  });

  test('a free lock needs no force at all', () => {
    expect(forcing(run({ liveness: 'not-running' }))).toBeNull();
    // And a summary with no verdict on it - which `listRuns` always fills, but a
    // caller building one by hand need not - takes the ordinary path rather than
    // being offered a force against a lock nobody looked at.
    expect(forcing(run())).toBeNull();
  });
});

test('the four verdicts this build handles are the four the core can return', () => {
  // The silent-failure shape `contract.test.ts` is built around: a fifth
  // liveness would fall through `forcing` to null and quietly take the ordinary
  // reopen, which for a live holder is the one outcome that must never happen.
  // This fails in the repo that adds one.
  const declared = /export type Liveness =([^;]+);/.exec(lock)?.[1];
  expect(declared, 'Liveness is no longer a union in src/lock.ts').toBeTruthy();
  const verdicts = [...(declared ?? '').matchAll(/'([a-z-]+)'/g)].map((m) => m[1] ?? '');
  expect(verdicts.sort()).toEqual(['interrupted', 'not-running', 'running', 'unknown']);
});
