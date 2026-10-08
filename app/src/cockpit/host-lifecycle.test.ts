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

describe('status reads', () => {
  test('a read is applied only if it is still the latest issued', () => {
    expect(cockpit).toMatch(/const gen = \(statusGen\.current \+= 1\);/);
    expect(cockpit).toMatch(/if \(gen === statusGen\.current\) setWire/);
    // The startup read is stamped too, and a stale answer is asked again rather
    // than applied over a newer one.
    const startup = cockpit.slice(cockpit.indexOf('for (;;) {'), cockpit.indexOf('if (status.ready !== null)'));
    expect(startup).toMatch(/const gen = \(statusGen\.current \+= 1\);/);
    // Both outcomes are checked before they are written: a stale rejection
    // would otherwise put its sentence over a newer read's, or an exit's.
    const failed = startup.slice(startup.indexOf('} catch (err) {'), startup.indexOf('break;'));
    expect(failed).toMatch(/if \(gen !== statusGen\.current\) continue;/);
    expect(failed.indexOf('continue;')).toBeLessThan(failed.indexOf('setWire('));
    const answered = startup.slice(startup.indexOf('break;'));
    expect(answered).toMatch(/if \(gen !== statusGen\.current\) continue;/);
    expect(answered.indexOf('continue;')).toBeLessThan(answered.indexOf('setWire('));
  });

  test('re-read on every exit, when a run host starts and when diagnostics open — and not on a result', () => {
    const exit = cockpit.slice(cockpit.indexOf('exit: (from, code) =>'), cockpit.indexOf('if (cancelled) {'));
    expect(exit).toMatch(/refreshStatus\(\);/);
    expect(cockpit).toMatch(/if \(diagnostics\) refreshStatus\(\);/);
    const start = cockpit.slice(cockpit.indexOf('.startRunHost('), cockpit.indexOf('.finally(() => setBusy(false));'));
    // Case 2 (#246): the pid lands on that run's entry, not on a single field.
    const then = start.slice(start.indexOf('.then((pid) => {'), start.indexOf('.catch('));
    expect(then).toMatch(/setPid\(l, handle, pid\)/);
    expect(then).toMatch(/refreshStatus\(\);/);
    // The frame handler issues none: Rust still lists the host when its result
    // arrives, so a read then could only report something about to be false.
    const frame = cockpit.slice(cockpit.indexOf('frame: (from, frame) =>'), cockpit.indexOf('unknown: (from, raw)'));
    expect(frame).not.toMatch(/refreshStatus/);
  });
});

describe('launch', () => {
  // Case 2 (#246): the window no longer refuses a second run. What these pin
  // instead is the order `launch` documents - refusals, claims, the start, and
  // only then anything visible - because each step is safe only in that order.
  const launch = (): string => cockpit.slice(cockpit.indexOf('const launch = useCallback('), cockpit.indexOf('const continueRun = useCallback('));

  test('one run at a time is gone, and every refusal comes before any change', () => {
    expect(cockpit).not.toMatch(/one run at a time/);
    const body = launch();
    const claims = body.indexOf('updateDrafts((list) => markLaunched(');
    expect(claims).toBeGreaterThan(-1);
    for (const refusal of [
      'if (!host.inShell())',
      'if (!connectedRef.current)',
      'if (meta.dir === null)',
      'isLaunched(draftsRef.current, fromDraft)',
      'capRefusal(livesRef.current, capRef.current, labelOf)',
    ]) {
      const at = body.indexOf(refusal);
      expect(at, refusal).toBeGreaterThan(-1);
      expect(at, refusal).toBeLessThan(claims);
    }
  });

  test('the claims are synchronous and come before the start; the visible changes after it', () => {
    const body = launch();
    const add = body.indexOf('updateLives((l) => addRun(l, entry));');
    const start = body.indexOf('.startRunHost(');
    expect(add).toBeGreaterThan(body.indexOf('markLaunched('));
    expect(add).toBeLessThan(start);
    // Nothing visible is set before the host is proven: `point` does that.
    const before = body.slice(0, start);
    for (const visible of ['setViewing(', 'setOpenAt(', 'rememberRepo(', 'setFocus(', 'setStartRefused(null)']) {
      expect(before, visible).not.toContain(visible);
    }
    const then = body.slice(body.indexOf('.then((pid) => {'), body.indexOf('.catch('));
    expect(then).toMatch(/pruneEnded\(setPid\(l, handle, pid\), handle\)/);
    expect(then).toMatch(/point\(handle\);/);
  });

  test('the first frame points at the run too, because Rust relays before its start resolves', () => {
    const frame = cockpit.slice(cockpit.indexOf('frame: (from, frame) =>'), cockpit.indexOf('unknown: (from, raw)'));
    expect(frame).toMatch(/point\(from\);/);
    const point = cockpit.slice(cockpit.indexOf('const point = useCallback('), cockpit.indexOf('const refreshKeys'));
    expect(point).toMatch(/if \(!toPoint\.current\.delete\(handle\)\) return;/);
    for (const visible of ['setViewing(null)', 'setOpenAt(null)', 'rememberRepo(e.dir)', 'setFocus(handle)', 'setStartRefused(null)']) {
      expect(point, visible).toContain(visible);
    }
    // The strip clears only once a host is proven: nowhere else.
    expect(cockpit.split('setStartRefused(null)').length).toBe(3);
  });

  test('the invoke id comes from the one allocator, and there is no second counter', () => {
    expect(cockpit).toMatch(/const id = host\.nextRequestId\(\);\n\s*const handle = `run-\$\{String\(id\)\}`;/);
    expect(cockpit).not.toMatch(/requests\.current/);
  });

  test('a start Rust refuses reverses the claims exactly, and is never a lost run', () => {
    const body = launch();
    const failed = body.slice(body.indexOf('.catch((err: unknown) => {'), body.indexOf('.finally('));
    expect(failed).toMatch(/updateLives\(\(l\) => dropRun\(l, handle\)\);/);
    expect(failed).toMatch(/unmarkLaunched\(list, draft\.id\)/);
    expect(failed).toMatch(/setStartRefused\(/);
    expect(failed).not.toMatch(/hostLost\(/);
  });

  test('one writer each for the runs and the drafts, and each writes its ref first', () => {
    expect(cockpit).toMatch(/const next = change\(livesRef\.current\);\n\s*livesRef\.current = next;\n\s*setLives\(next\);/);
    expect(cockpit).toMatch(/const next = change\(draftsRef\.current\);\n\s*draftsRef\.current = next;\n\s*setDrafts\(next\);/);
    expect(cockpit.match(/setLives\(/g)).toHaveLength(1);
    expect(cockpit.match(/livesRef\.current = /g)).toHaveLength(1);
    expect(cockpit.match(/setDrafts\(/g)).toHaveLength(1);
    // An entry's id and repository are read off its run, never stored beside it.
    expect(cockpit).not.toMatch(/shownLive\.runId|\be\.runId\b|entry\.runId/);
  });

  test('the service host going is written to the ref launch reads, before the render', () => {
    const exit = cockpit.slice(cockpit.indexOf('exit: (from, code) =>'), cockpit.indexOf('if (cancelled) {'));
    expect(exit.indexOf('connectedRef.current = false;')).toBeGreaterThan(-1);
    expect(exit.indexOf('connectedRef.current = false;')).toBeLessThan(exit.indexOf('setWire('));
    expect(cockpit).toMatch(/connectedRef\.current = status\.running;/);
  });
});

describe('a run host’s frames', () => {
  test("only the invoke's own result reaches the reducer", () => {
    // `reduce` reads any `result` as the command returning, and a pause, an
    // unpause and a cancel are each answered with one on the same host.
    // Case 2 (#246): folded into the run its handle names, through `updateRun`.
    expect(cockpit).toMatch(/const folds = frame\.type !== 'result' \|\| outcome === 'completed';/);
    expect(cockpit).toMatch(/updateRun\(l, from, \(r\) => \(folds \? reduce\(r, frame, at\) : r\)\)/);
  });
});

describe('controls', () => {
  test('a gate is answered through mayAnswer, on the handle of the run on screen', () => {
    const answer = cockpit.slice(cockpit.indexOf('const answer = useCallback('), cockpit.indexOf('const pause = useCallback('));
    expect(answer).toMatch(/mayAnswer\(livesRef\.current, shown\.handle, askId\)/);
    expect(answer).toMatch(/markAnswered\(l, shown\.handle, askId\)/);
    expect(answer).toMatch(/shown\.handle\)/);
  });

  test('pause, unpause and stop act on the run on screen, by its handle', () => {
    const controls = cockpit.slice(cockpit.indexOf('const pause = useCallback('), cockpit.indexOf('const runCommand = useCallback('));
    expect(controls).toMatch(/host\.pause\(shown\.handle\)/);
    expect(controls).toMatch(/host\.unpause\(shown\.handle\)/);
    expect(controls).toMatch(/host\.cancel\(shown\.handle, reason\)/);
    expect(cockpit).toMatch(/shownRef\.current = shownLive;/);
  });
});

describe('a lost run is over everywhere it is asked', () => {
  test('every "is the command over" site reads settled()', () => {
    // Case 2 (#246): both sites moved into `updateRun` in hosts.ts, which
    // asks `settled(run) || run.reason !== null` per run; the cockpit's
    // remaining "over" sites are the kickoff and the brief.
    expect(cockpit).toMatch(/\(shownLive === null \|\| settled\(run\)\) && repoDir\.trim\(\) !== ''/);
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

describe('several runs (#246)', () => {
  test('the panes for a live run read its repository, never the sidebar’s', () => {
    expect(cockpit).toMatch(/const liveRepo = shownLive !== null \? repoOf\(shownLive\) : shownDir;/);
    expect(cockpit).toMatch(/<CodePane run=\{run\} dir=\{liveRepo\}/);
    expect(cockpit).toMatch(/passes: run\.verify, dir: liveRepo,/);
    expect(cockpit).not.toContain('run.identity?.repo ?? repoDir');
    expect(cockpit).not.toContain('run.identity?.repo ?? shownDir');
    expect(cockpit).toMatch(/const shownDir = viewing\?\.dir \?\? drafting\?\.dir \?\? \(shownLive !== null \? repoOf\(shownLive\) : null\) \?\? repoDir;/);
  });

  test('a pilot command runs where its card said; the Commands pane where the sidebar is; kickoff stays', () => {
    expect(cockpit).toMatch(/runCommand\(effect\.dir, effect\.program, effect\.args\)/);
    expect(cockpit).toMatch(/onRun=\{\(program, args\) => runCommand\(repoDir, program, args\)\}/);
    expect(cockpit).toMatch(/<Kickoff dir=\{repoDir\} \/>/);
  });

  test('the pane is held on the proposing conversation, from the runs', () => {
    expect(cockpit).toMatch(/const holdChat = heldChat\(lives, shownLive, viewing, drafting\);/);
    expect(cockpit).toMatch(/const pilotDir = holdChat\?\.dir \?\? shownDir;/);
    expect(cockpit).toMatch(/const pilotRunId = holdChat !== null \? holdChat\.runId : /);
  });

  test('the cockpit is the one adopter: not before the store is read, chats before marks', () => {
    const effect = cockpit.slice(cockpit.indexOf('const plan = adoptionPlan('), cockpit.indexOf('}, [lives, chats.ready, drafts'));
    expect(cockpit.slice(cockpit.indexOf('const plan = adoptionPlan(') - 80)).toMatch(/if \(!chats\.ready\) return;\n\s*const plan = adoptionPlan\(/);
    expect(effect.indexOf('putChat(write.key, write.value)')).toBeGreaterThan(-1);
    expect(effect.indexOf('putChat(write.key, write.value)')).toBeLessThan(effect.indexOf('markAdopted('));
    expect(effect.indexOf('putChat(write.key, write.value)')).toBeLessThan(effect.indexOf('bindDraft('));
  });

  test('quit lists every live run, read off the ref', () => {
    expect(cockpit).toMatch(/if \(quitList\(livesRef\.current, labelOf\)\.length === 0\) void host\.appQuit\(\);/);
    expect(cockpit).toMatch(/const going = quitList\(lives, labelOf\);/);
  });
});
