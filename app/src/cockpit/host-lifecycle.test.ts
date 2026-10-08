import { describe, expect, test } from 'vitest';
import cockpit from './Cockpit.tsx?raw';
import footer from './Footer.tsx?raw';
import statusBar from '../shell/StatusBar.tsx?raw';

/**
 * The cockpit's half of one host per run (#246), read as source.
 *
 * The app has no jsdom, so the effects in `Cockpit` are pinned the way
 * `launch-hold.test.ts` pins its own: by the lines that carry each decision. The
 * decisions themselves are pure and tested in `hosts.test.ts` and `model.test.ts`.
 */

function body(of: string, start: string): string {
  const at = cockpit.indexOf(start);
  expect(at, start).toBeGreaterThan(-1);
  return cockpit.slice(at, at + of.length);
}

describe('status reads', () => {
  test('a read is applied only if it is still the latest issued', () => {
    expect(cockpit).toMatch(/const gen = \(statusGen\.current \+= 1\);/);
    expect(cockpit).toMatch(/if \(gen === statusGen\.current\) setWire/);
    // The startup read is stamped too, and a stale answer is asked again rather
    // than applied over a newer one.
    const startup = cockpit.slice(cockpit.indexOf('for (;;) {'), cockpit.indexOf('break;\n        }'));
    expect(startup).toMatch(/const gen = \(statusGen\.current \+= 1\);/);
    expect(startup).toMatch(/if \(gen !== statusGen\.current\) continue;/);
    expect(startup.indexOf('continue;')).toBeLessThan(startup.indexOf('setWire('));
  });

  test('re-read on every exit, when a run host starts and when diagnostics open — and not on a result', () => {
    const exit = cockpit.slice(cockpit.indexOf('exit: (from, code) =>'), cockpit.indexOf('if (cancelled) {'));
    expect(exit).toMatch(/refreshStatus\(\);/);
    expect(cockpit).toMatch(/if \(diagnostics\) refreshStatus\(\);/);
    const start = cockpit.slice(cockpit.indexOf('.startRunHost('), cockpit.indexOf('.finally(() => setBusy(false));'));
    expect(start).toMatch(/\.then\(\(pid\) => \{\n\s*if \(liveHost\.current\?\.handle === handle\) setRunHostPid\(pid\);\n\s*refreshStatus\(\);/);
    // The frame handler issues none: Rust still lists the host when its result
    // arrives, so a read then could only report something about to be false.
    const frame = cockpit.slice(cockpit.indexOf('frame: (from, frame) =>'), cockpit.indexOf('unknown: (from, raw)'));
    expect(frame).not.toMatch(/refreshStatus/);
  });
});

describe('launch', () => {
  test('a second run is refused before the column is reset', () => {
    const launch = cockpit.slice(cockpit.indexOf('const launch = useCallback('));
    const guard = launch.indexOf('if (liveHost.current !== null)');
    const reset = launch.indexOf("dispatch({ type: 'reset' })");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(reset);
  });

  test('the invoke id comes from the one allocator, and there is no second counter', () => {
    expect(cockpit).toMatch(/const id = host\.nextRequestId\(\);\n\s*const handle = `run-\$\{String\(id\)\}`;/);
    expect(cockpit).not.toMatch(/requests\.current/);
  });

  test('a start that fails ends the run as lost, only if it is still the live one', () => {
    const failed = body('x'.repeat(400), '.catch((err: unknown) => {\n          // Rust has already closed');
    expect(failed).toMatch(/if \(liveHost\.current\?\.handle !== handle\) return;/);
    expect(failed).toMatch(/type: 'lost'/);
  });
});

describe('a run host’s frames', () => {
  test("only the invoke's own result reaches the reducer", () => {
    // `reduce` reads any `result` as the command returning, and a pause, an
    // unpause and a cancel are each answered with one on the same host.
    expect(cockpit).toMatch(/if \(frame\.type !== 'result' \|\| outcome === 'completed'\) dispatch\(frame\);/);
  });
});

describe('controls', () => {
  test('a gate is answered through mayAnswer, on the live handle', () => {
    const answer = cockpit.slice(cockpit.indexOf('const answer = useCallback('), cockpit.indexOf('const pause = useCallback('));
    expect(answer).toMatch(/mayAnswer\(live, askId\)/);
    expect(answer).toMatch(/live\.handle\)/);
  });
});

describe('a lost run is over everywhere it is asked', () => {
  test('every "is the command over" site reads settled()', () => {
    expect(cockpit).toMatch(/const launchSettled = startedId !== null \|\| settled\(run\);/);
    expect(cockpit).toMatch(/const ended = settled\(run\) \|\| run\.reason !== null;/);
    expect(cockpit).not.toMatch(/run\.completed !== null/);
    expect(cockpit).not.toMatch(/run\.completed === null/);
  });

  test('the footer and the status bar say so before offering anything', () => {
    const lost = footer.indexOf('if (run.lost !== null)');
    expect(lost).toBeGreaterThan(-1);
    expect(lost).toBeLessThan(footer.indexOf('if (run.gate !== null)'));
    expect(lost).toBeLessThan(footer.indexOf('const canControl'));
    const bar = statusBar.indexOf('run.lost !== null ?');
    expect(bar).toBeGreaterThan(-1);
    expect(bar).toBeLessThan(statusBar.indexOf('run.gate !== null ?'));
    expect(bar).toBeLessThan(statusBar.indexOf('run.completed !== null ?'));
  });
});
