import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cancelRequested,
  clearCancel,
  registerInterruptible,
  registerWait,
  requestCancel,
  sleepUnlessCancelled,
} from '@src/cancel.js';

/**
 * Stopping a run that is waiting out a rate limit (#223).
 *
 * **Reported as two symptoms and it is one defect:** *"I ended a run, and now I
 * can't create a new one."* Codex hit 100% of its five-hour window, the loop
 * went into a fifteen-minute wait, and the wait was a bare
 * `new Promise((r) => setTimeout(r, ms))` — a timer with no knowledge of the
 * cancel latch and no way to be woken.
 *
 * So `stop` did nothing: `cancel.ts` ends a turn by killing the **child** it is
 * allowed to kill, and a sleeping loop has no child. And because `serve.ts`
 * holds its one-at-a-time gate for the whole of `main()`, the same fifteen
 * minutes that ignored the stop also refused every new run. A wait the product
 * will not interrupt locks the front door for as long as it lasts.
 *
 * A rate-limit wait is the one place a run spends real time with nothing to
 * kill, which is exactly why it needed its own way out.
 */

function afterEach(): void {
  clearCancel();
}

test('a wait ends the moment the run is cancelled, not when the timer expires', async () => {
  clearCancel();
  // An hour, so a pass cannot come from the timer: if this resolves at all, it
  // resolved because the cancel woke it.
  const waited = sleepUnlessCancelled(60 * 60_000);
  requestCancel('stopped from the window');
  assert.equal(await waited, false, 'false means woken rather than slept');
  afterEach();
});

test('the wait reports that it slept when nothing interrupted it', async () => {
  clearCancel();
  assert.equal(await sleepUnlessCancelled(1), true);
  afterEach();
});

test('a cancel already latched does not sleep at all', async () => {
  // The fail-closed direction: a run being stopped must not spend fifteen
  // minutes doing nothing first. An hour again, so only the early return can
  // make this finish.
  clearCancel();
  requestCancel('stopped before the wait began');
  assert.equal(await sleepUnlessCancelled(60 * 60_000), false);
  afterEach();
});

test('waking is not ending, so the reason is still there to read', async () => {
  // The wake resolves the wait; the latch is what ends the run. Keeping those
  // apart is what lets the decision stay in the loop rather than in a timer
  // callback.
  clearCancel();
  const waited = sleepUnlessCancelled(60 * 60_000);
  requestCancel('because I said so');
  await waited;
  assert.equal(cancelRequested(), 'because I said so');
  afterEach();
});

test('a woken wait is NOT counted as a child that was killed', async () => {
  // `requestCancel` returns how many children it killed, and the whole meaning
  // of zero is that the cancel arrived between turns and no work was discarded.
  // A rate-limit wait IS between turns, so counting one would report work
  // destroyed where none was.
  clearCancel();
  const waited = sleepUnlessCancelled(60 * 60_000);
  assert.equal(requestCancel('nothing was running'), 0);
  await waited;
  afterEach();
});

test('a real child is still counted beside a woken wait', async () => {
  clearCancel();
  let killed = false;
  const unregister = registerInterruptible(() => {
    killed = true;
  });
  const waited = sleepUnlessCancelled(60 * 60_000);
  assert.equal(requestCancel('both'), 1, 'the child counts, the wait does not');
  assert.equal(killed, true);
  await waited;
  unregister();
  afterEach();
});

test('a waiter that throws does not stop the others being woken', async () => {
  // The same rule a kill that failed follows: the latch is the mechanism and the
  // wake is the courtesy.
  clearCancel();
  const unregister = registerWait(() => {
    throw new Error('this waiter is broken');
  });
  const waited = sleepUnlessCancelled(60 * 60_000);
  assert.doesNotThrow(() => requestCancel('one broken waiter'));
  assert.equal(await waited, false);
  unregister();
  afterEach();
});

test('a wait that finished unregisters itself', async () => {
  // A stale entry wakes nothing, but it is a reference the process keeps for no
  // reason — the same `finally` discipline `registerInterruptible` documents.
  clearCancel();
  await sleepUnlessCancelled(1);
  // Nothing to observe directly, so this asserts the consequence: a later
  // cancel must not try to settle a promise that is already settled.
  assert.doesNotThrow(() => requestCancel('after the wait ended'));
  afterEach();
});

test('the timer is cleared, so a woken wait does not hold the process open', async (t) => {
  // Without `clearTimeout` a cancelled run would keep an hour-long timer alive
  // and the host would not exit until it fired — which is the same class of
  // problem as the lock this fixes, one layer down.
  clearCancel();
  const timers: { cleared: number[] } = { cleared: [] };
  let handle = 0;
  const fake = {
    setTimeout: () => {
      handle += 1;
      return handle;
    },
    clearTimeout: (id: number) => {
      timers.cleared.push(id);
    },
  } as unknown as typeof globalThis;
  const waited = sleepUnlessCancelled(60 * 60_000, fake);
  requestCancel('stop');
  await waited;
  assert.deepEqual(timers.cleared, [1]);
  t.diagnostic('the injected clock is what makes this observable without waiting an hour');
  afterEach();
});

// ---- the loop's side --------------------------------------------------------

test('the rate-limit wait goes through the cancellable sleep, and there is no bare timer left', () => {
  // Source-read, because the claim is about which sleep the loop calls and a
  // behavioural test would need a real rate limit. The bare
  // `setTimeout`-in-a-promise is what made `stop` a no-op, so its absence is
  // the property worth pinning.
  let at = path.dirname(fileURLToPath(import.meta.url));
  while (!existsSync(path.join(at, 'src', 'orchestrator.ts')) && path.dirname(at) !== at) {
    at = path.dirname(at);
  }
  const source = readFileSync(path.join(at, 'src', 'orchestrator.ts'), 'utf8');
  assert.match(source, /const slept = await sleepUnlessCancelled\(waitMs\)/);
  assert.doesNotMatch(
    source,
    /new Promise\(\(resolve\) => setTimeout\(resolve/,
    'a bare timer here is a wait nothing can interrupt',
  );
});

test('a wait cut short does not narrate that it resumed', () => {
  // `rate_limit_resumed` is half of what lets `7e` call this *waiting* rather
  // than halted — a window told when the wait began and when it ended needs no
  // decision in between. Saying it on a wait that was stopped would report a
  // resumption that never happened, and would announce a turn the latch is
  // about to refuse to start.
  let at = path.dirname(fileURLToPath(import.meta.url));
  while (!existsSync(path.join(at, 'src', 'orchestrator.ts')) && path.dirname(at) !== at) {
    at = path.dirname(at);
  }
  const source = readFileSync(path.join(at, 'src', 'orchestrator.ts'), 'utf8');
  const wait = source.slice(source.indexOf('const slept = await sleepUnlessCancelled'));
  const thrown = wait.indexOf('throw new Cancelled');
  const resumed = wait.indexOf("id: 'rate_limit_resumed'");
  assert.ok(thrown > -1 && resumed > -1);
  assert.ok(thrown < resumed, 'the cancel must return before the resumed line is said');
});
