import { describe, expect, test } from 'vitest';
import {
  adoptionPlan,
  addRun,
  capOf,
  capRefusal,
  dropRun,
  endRun,
  exitMeans,
  gatesWaiting,
  heldChat,
  hostExitWording,
  hostedMarks,
  invokeOutcome,
  launchMeta,
  markAdopted,
  mayAnswer,
  onScreen,
  pruneEnded,
  quitList,
  repoOf,
  routeFrame,
  runIdOf,
  runLabel,
  setFlag,
  setPid,
  started,
  updateRun,
  writeRefusal,
} from './hosts';
import type { LiveRun, LiveRuns } from './hosts';
import { emptyRun, hostLost, reduce } from './model';
import type { Run } from './model';
import { CONFIG_WRITE_DURING_RUN, SERVICE_HOST } from '../host';
import type { Frame } from '../host';
import { chatKey, readChat, writable } from '../pilot/saved';
import { emptyConversation } from '../pilot/transcript';
import serve from '../../../src/serve.ts?raw';
import config from '../../../src/config.ts?raw';

/**
 * Several live runs, routed by host handle (#246).
 *
 * One host process per run: the service host answers everything that is not a
 * run, and each `invoke` has a run host of its own. The window now hosts
 * several at once, and these are its decisions about them - routing, endings,
 * which one is drawn, the cap, the write rule, the quit list, the sidebar's
 * marks and who adopts which conversation. None of them is "the current run".
 *
 * Rewritten from the single-host version (case 2: one live run became many).
 * Every claim that file made is kept, per handle.
 */

const result = (id: number): Frame => ({ type: 'result', id, exit: 0 });
const error = (id: number): Frame => ({ type: 'error', id, message: 'refused' });
const say = (id: string, data: Record<string, unknown>): Frame => ({ type: 'narration', level: 'info', message: 'x', id, data });
const startedFrame = (runId: string, repo: string | null, task = 'build it'): Frame =>
  say('run_started', { runId, dir: `${repo ?? '/x'}/.vibe/runs/${runId}`, repo, task });
const ask = (askId: number): Frame =>
  ({ type: 'ask', id: askId, context: { boundary: 'plan-approved', planRound: 0, reviewRound: 0, verifyRound: 0 } }) as Frame;

function entry(over: Partial<LiveRun> = {}): LiveRun {
  return {
    handle: 'run-7',
    invokeId: 7,
    answered: new Set(),
    live: true,
    dir: '/repo/a',
    asked: null,
    task: 'build it',
    sent: null,
    draft: null,
    held: null,
    adopted: null,
    pid: 100,
    heard: false,
    pausing: false,
    stopping: false,
    run: emptyRun(),
    ...over,
  };
}

/** An entry whose run has said who it is. */
function told(runId: string, repo: string | null, over: Partial<LiveRun> = {}): LiveRun {
  return { ...entry(over), run: reduce(over.run ?? emptyRun(), startedFrame(runId, repo), 1) };
}

const fold = (lives: LiveRuns, handle: string, frame: Frame): LiveRuns =>
  updateRun(lives, handle, (r: Run) => reduce(r, frame, 2));

const label = (e: LiveRun): string => runLabel(e, []);

describe('a frame goes where its handle says', () => {
  const lives = [entry(), entry({ handle: 'run-9', invokeId: 9 })];

  test('the service host, each live run host, and anything else', () => {
    expect(routeFrame(lives, SERVICE_HOST)).toBe('service');
    expect(routeFrame(lives, 'run-7')).toBe('run');
    expect(routeFrame(lives, 'run-9')).toBe('run');
    expect(routeFrame(lives, 'run-2')).toBe('stale');
    // With no run live, a run host's frame belongs to nobody.
    expect(routeFrame([], 'run-7')).toBe('stale');
    expect(routeFrame(endRun(lives, 'run-7'), 'run-7')).toBe('stale');
  });

  test('an entry routes before it has started, so a frame that beats the pid lands', () => {
    expect(routeFrame([entry({ pid: null })], 'run-7')).toBe('run');
  });

  test('a frame reaches its own run and no other', () => {
    const next = fold(lives, 'run-9', startedFrame('20261008-b', '/repo/b'));
    expect(next[0]?.run.identity).toBeNull();
    expect(next[1]?.run.identity?.runId).toBe('20261008-b');
  });
});

describe('what ends a live invoke', () => {
  const lives = [entry({ answered: new Set([3]) }), entry({ handle: 'run-9', invokeId: 9 })];

  test("its own result completes it; a pause's result does not", () => {
    expect(invokeOutcome(lives, 'run-7', result(7))).toBe('completed');
    expect(invokeOutcome(lives, 'run-7', result(8))).toBeNull();
    // The same id on another host is that host's business.
    expect(invokeOutcome(lives, 'run-9', result(7))).toBeNull();
    expect(invokeOutcome(lives, 'run-9', result(9))).toBe('completed');
    expect(invokeOutcome([], 'run-7', result(7))).toBeNull();
  });

  test('an error with its id fails it, even when that id is a gate already answered', () => {
    expect(invokeOutcome(lives, 'run-7', error(7))).toBe('failed');
    // Gate ids are the host's counter and invoke ids the window's, so they can
    // coincide. Answer-once is what keeps this unambiguous, not membership.
    const coincide = [entry({ handle: 'run-1', invokeId: 1, answered: new Set([1]) })];
    expect(invokeOutcome(coincide, 'run-1', error(1))).toBe('failed');
    expect(invokeOutcome(lives, 'run-7', error(9))).toBeNull();
  });

  test('a gate is answered once, only on its own run, and only the gate that run holds', () => {
    const held = fold(lives, 'run-7', ask(4));
    expect(mayAnswer(held, 'run-7', 4)).toBe(true);
    // Not the gate the run is holding.
    expect(mayAnswer(held, 'run-7', 5)).toBe(false);
    // Another run holds no gate.
    expect(mayAnswer(held, 'run-9', 4)).toBe(false);
    const answered = fold(lives, 'run-7', ask(3));
    expect(mayAnswer(answered, 'run-7', 3)).toBe(false);
    expect(mayAnswer(endRun(held, 'run-7'), 'run-7', 4)).toBe(false);
  });
});

describe('what an exit means', () => {
  const lives = [entry(), entry({ handle: 'run-9', invokeId: 9 })];

  test('the service host, that run lost, or the expected close', () => {
    expect(exitMeans(lives, SERVICE_HOST)).toBe('service');
    expect(exitMeans(lives, 'run-7')).toBe('run-lost');
    // After its result the window has let it go, so its exit is expected.
    expect(exitMeans(endRun(lives, 'run-7'), 'run-7')).toBe('expected');
    expect(exitMeans(lives, 'run-2')).toBe('expected');
  });

  test('a lost run is that run, and the others keep going', () => {
    const lost = endRun(updateRun(lives, 'run-7', (r) => hostLost(r, 3, hostExitWording(1))), 'run-7');
    expect(lost[0]?.run.lost).toBe('the host exited 1');
    expect(lost[0]?.live).toBe(false);
    expect(lost[1]?.run.lost).toBeNull();
    expect(routeFrame(lost, 'run-9')).toBe('run');
  });

  test('the two sentences the cockpit always said', () => {
    expect(hostExitWording(3)).toBe('the host exited 3');
    expect(hostExitWording(null)).toBe('the host was signalled and reported no exit code');
  });
});

describe('the collection', () => {
  test('addRun appends and dropRun is its exact inverse', () => {
    const before = [entry({ handle: 'run-1' })];
    const added = addRun(before, entry({ handle: 'run-2' }));
    expect(added.map((e) => e.handle)).toEqual(['run-1', 'run-2']);
    expect(dropRun(added, 'run-2')).toEqual(before);
  });

  test('pruneEnded keeps the live, the unadopted and the one kept, and only those', () => {
    const lives = [
      entry({ handle: 'live' }),
      entry({ handle: 'ended-pending', live: false }),
      entry({ handle: 'ended-adopted', live: false, adopted: 'moved' }),
      entry({ handle: 'kept', live: false, adopted: 'skipped' }),
    ];
    expect(pruneEnded(lives, 'kept').map((e) => e.handle)).toEqual(['live', 'ended-pending', 'kept']);
  });

  test('updateRun marks it heard, and clears its flags when a gate opens or it ends', () => {
    let lives: LiveRuns = [entry({ pid: null, pausing: true, stopping: true })];
    lives = fold(lives, 'run-7', say('phase_started', { phase: 'planning' }));
    expect(lives[0]?.heard).toBe(true);
    expect(lives[0]?.pausing).toBe(true);
    lives = fold(lives, 'run-7', ask(2));
    expect(lives[0]?.pausing).toBe(false);
    expect(lives[0]?.stopping).toBe(true);
    lives = fold(lives, 'run-7', result(7));
    expect(lives[0]?.stopping).toBe(false);
    expect(setFlag(lives, 'run-7', 'pausing', true)[0]?.pausing).toBe(true);
  });
});

describe('identity comes from the run, and the argv is only the fallback', () => {
  test('launchMeta reads the directory and, for a resume, the run id', () => {
    expect(launchMeta(['run', 'task', '-C', '/repo/a'])).toEqual({ dir: '/repo/a', asked: null });
    expect(launchMeta(['plan', 'task', '-C', '/repo/a', '--gate', 'x=y'])).toEqual({ dir: '/repo/a', asked: null });
    expect(launchMeta(['resume', '2026-x', '-C', '/repo/a', '--implement'])).toEqual({ dir: '/repo/a', asked: '2026-x' });
    expect(launchMeta(['run', 'task', '/repo/a']).dir).toBeNull();
    expect(launchMeta(['run', 'task', '-C', '  ']).dir).toBeNull();
    expect(launchMeta(['fork', 'x', '-C', '/repo/a']).dir).toBeNull();
  });

  test('runIdOf and repoOf read run_started, else the argv', () => {
    const resume = entry({ asked: '2026-x', dir: '/repo/a' });
    expect(runIdOf(resume)).toBe('2026-x');
    expect(repoOf(resume)).toBe('/repo/a');
    const after = told('2026-y', '/repo/b', { dir: '/repo/a' });
    expect(runIdOf(after)).toBe('2026-y');
    expect(repoOf(after)).toBe('/repo/b');
    // An older core says no repo: the argv's directory stands.
    expect(repoOf(told('2026-z', null, { dir: '/repo/a' }))).toBe('/repo/a');
    expect(runIdOf(entry())).toBeNull();
  });

  test('a label is the rename, else the brief, else a run still starting', () => {
    const e = told('2026-y', '/repo/b');
    expect(runLabel(e, [{ dir: '/repo/b', runId: '2026-y', name: 'Named' }])).toBe('Named');
    // A rename in another repository is not this run's.
    expect(runLabel(e, [{ dir: '/repo/c', runId: '2026-y', name: 'Named' }])).toBe('build it');
    expect(runLabel(entry({ task: 'first line\nthe rest' }), [])).toBe('first line');
    expect(runLabel(entry({ task: null }), [])).toBe('a run still starting');
  });
});

describe('which run is drawn', () => {
  const viewing = (runId: string, dir: string) => ({ runId, dir, task: '' });

  test('an entry is drawn once a pid or any frame proves its host', () => {
    expect(started(entry({ pid: null }))).toBe(false);
    expect(started(entry({ pid: 4 }))).toBe(true);
    // Rust relays frames before its start resolves.
    const heard = fold([entry({ pid: null })], 'run-7', startedFrame('2026-a', '/repo/a'));
    expect(started(heard[0] as LiveRun)).toBe(true);
    expect(onScreen(heard, null, 'run-7')?.handle).toBe('run-7');
    expect(onScreen(heard, viewing('2026-a', '/repo/a'), null)?.handle).toBe('run-7');
    expect(hostedMarks(heard, '/repo/a', null).live.has('2026-a')).toBe(true);
  });

  test('an unstarted resume is not drawn and not marked, but is routed, counted and listed for quit', () => {
    const resume = [entry({ pid: null, asked: '2026-a' })];
    expect(onScreen(resume, viewing('2026-a', '/repo/a'), null)).toBeNull();
    expect(onScreen(resume, null, 'run-7')).toBeNull();
    expect(hostedMarks(resume, '/repo/a', null).live.size).toBe(0);
    expect(routeFrame(resume, 'run-7')).toBe('run');
    expect(capRefusal(resume, { cap: 1 }, label)).not.toBeNull();
    expect(quitList(resume, label)).toEqual(['build it']);
  });

  test('a live run opened by id and repository draws live; an ended one is replayed', () => {
    const lives = [told('2026-a', '/repo/a'), told('2026-a', '/repo/b', { handle: 'run-9', invokeId: 9 })];
    expect(onScreen(lives, viewing('2026-a', '/Repo/B/'), null)?.handle).toBe('run-9');
    expect(onScreen(endRun(lives, 'run-9'), viewing('2026-a', '/repo/b'), null)).toBeNull();
    // With nothing opened, the focus - including after it ends.
    expect(onScreen(endRun(lives, 'run-7'), null, 'run-7')?.handle).toBe('run-7');
    expect(onScreen(lives, null, null)).toBeNull();
  });
});

describe('the pane is held on the proposing conversation until adoption settles', () => {
  const held = { dir: '/repo/a', runId: null };
  const viewing = (runId: string, dir: string) => ({ runId, dir, task: '' });

  test('the run drawn because it was just started', () => {
    const e = told('2026-a', '/repo/a', { held });
    expect(heldChat([e], e, null, null)).toEqual(held);
    expect(heldChat([markAdopted([e], 'run-7', 'moved')[0] as LiveRun], { ...e, adopted: 'moved' }, null, null)).toBeNull();
  });

  test('the run opened from the sidebar the moment it appeared, started or ended', () => {
    const e = told('2026-a', '/repo/a', { held });
    expect(heldChat([e], e, viewing('2026-a', '/repo/a'), null)).toEqual(held);
    const ended = endRun([e], 'run-7');
    expect(heldChat(ended, null, viewing('2026-a', '/repo/a'), null)).toEqual(held);
    expect(heldChat(ended, null, viewing('2026-a', '/repo/b'), null)).toBeNull();
  });

  test('a run with no source holds nothing, and a draft on screen holds itself', () => {
    const e = told('2026-a', '/repo/a');
    expect(heldChat([e], e, null, null)).toBeNull();
    const d = told('2026-a', '/repo/a', { draft: { id: 'draft-1', dir: '/repo/a' } });
    expect(heldChat([d], d, null, { id: 'draft-1' })).toBeNull();
    expect(heldChat([d], d, null, null)).toEqual({ dir: '/repo/a', runId: 'draft-1' });
  });
});

describe('the cap, runs.maxConcurrent', () => {
  test('read off the global file in the core’s own sentences', () => {
    expect(capOf({})).toEqual({ cap: 0 });
    expect(capOf({ runs: { maxConcurrent: 2 } })).toEqual({ cap: 2 });
    for (const [raw, problem] of [
      [{ runs: 3 }, 'runs must be an object'],
      [{ runs: { other: 1 } }, 'runs.other is not a setting; the one is maxConcurrent'],
      [{ runs: { maxConcurrent: null } }, 'runs.maxConcurrent must be 0 (no limit) or a whole number of runs'],
      [{ runs: { maxConcurrent: 1.5 } }, 'runs.maxConcurrent must be 0 (no limit) or a whole number of runs'],
    ] as const) {
      expect(capOf(raw)).toEqual({ problem });
      // The two packages share no code; the sentences have to agree.
      expect(config).toContain(problem.replace(/runs\.other/, 'runs.${key}'));
    }
  });

  test('refuses at the cap by name, naming the runs holding it, and not at 0', () => {
    const lives = [told('2026-a', '/repo/a'), entry({ handle: 'run-9', pid: null, task: 'second' })];
    const why = capRefusal(lives, { cap: 2 }, label);
    expect(why).toContain('runs.maxConcurrent is 2');
    expect(why).toContain('build it; second');
    expect(capRefusal(lives, { cap: 3 }, label)).toBeNull();
    expect(capRefusal(lives, { cap: 0 }, label)).toBeNull();
    // Ended runs hold nothing.
    expect(capRefusal(endRun(lives, 'run-9'), { cap: 2 }, label)).toBeNull();
  });

  test('a value it cannot use refuses every start; a cap not read refuses only while runs are live', () => {
    expect(capRefusal([], { problem: 'runs must be an object' }, label)).toContain('runs must be an object');
    expect(capRefusal([], null, label)).toBeNull();
    expect(capRefusal([entry()], null, label)).toContain('has not been read yet');
  });
});

describe('a config write while runs are going', () => {
  const lives = [told('2026-a', '/repo/a'), entry({ handle: 'run-9', pid: null, dir: '/repo/c' })];

  test('a project write is refused only while that project has a live run', () => {
    expect(writeRefusal(lives, { loop: {} }, 'project', '/Repo/A/', label)).toBe(
      `${CONFIG_WRITE_DURING_RUN}. Held by: build it`,
    );
    // A start still in flight counts, by the directory it was sent for.
    expect(writeRefusal(lives, { loop: {} }, 'project', '/repo/c', label)).not.toBeNull();
    expect(writeRefusal(lives, { loop: {} }, 'project', '/repo/b', label)).toBeNull();
    expect(writeRefusal(endRun(lives, 'run-7'), { loop: {} }, 'project', '/repo/a', label)).toBeNull();
    // A read is never refused.
    expect(writeRefusal(lives, undefined, 'project', '/repo/a', label)).toBeNull();
  });

  test('a global write is refused while any run is live, unless it only touches the cap', () => {
    expect(writeRefusal(lives, { auth: { openai: 'api' } }, 'global', '/repo/z', label)).toContain('Held by: build it; build it');
    expect(writeRefusal(lives, { runs: { maxConcurrent: 4 } }, 'global', '/repo/z', label)).toBeNull();
    expect(writeRefusal(lives, { runs: { maxConcurrent: 4 }, cli: {} }, 'global', '/repo/z', label)).not.toBeNull();
    expect(writeRefusal([], { auth: {} }, 'global', '/repo/z', label)).toBeNull();
  });

  test('the sentence is the core’s own, word for word', () => {
    // Moved rather than reworded: the service host no longer sees a run, and a
    // person who saw the old refusal should see the same one.
    const quoted = CONFIG_WRITE_DURING_RUN.split(' ').slice(0, 8).join(' ');
    expect(serve).toContain(quoted);
    expect(serve.replace(/'\s*\+\s*'/g, '')).toContain(CONFIG_WRITE_DURING_RUN);
  });
});

describe('quit and the sidebar', () => {
  test('quit lists every live run, started or not, and no ended one', () => {
    const lives = [told('2026-a', '/repo/a'), entry({ handle: 'run-9', pid: null, task: null })];
    expect(quitList(lives, label)).toEqual(['build it', 'a run still starting']);
    expect(quitList(endRun(lives, 'run-7'), label)).toEqual(['a run still starting']);
  });

  test('marks are per project: two repositories sharing a run id do not mark each other', () => {
    const lives = fold(
      [told('2026-a', '/repo/a'), told('2026-a', '/repo/b', { handle: 'run-9', invokeId: 9 })],
      'run-9',
      ask(1),
    );
    const a = hostedMarks(lives, '/repo/a', null);
    const b = hostedMarks(lives, '/repo/b', null);
    expect([...a.live]).toEqual(['2026-a']);
    expect(a.gates.size).toBe(0);
    expect(gatesWaiting(a)).toBe(false);
    expect([...b.gates]).toEqual(['2026-a']);
    expect(gatesWaiting(b)).toBe(true);
    // The run on screen draws its own gate; no badge for it.
    expect(hostedMarks(lives, '/repo/b', 'run-9').gates.size).toBe(0);
    expect(hostedMarks(endRun(lives, 'run-9'), '/repo/b', null).live.size).toBe(0);
  });
});

describe('who adopts which conversation', () => {
  const bucket = chatKey('/repo/a', null);
  const saved = (text: string, session: string | null = 'sess-1'): string =>
    writable({
      ...emptyConversation(),
      messages: [{ role: 'user', content: text }] as never,
      session: session === null ? null : { backend: 'subscription', id: session },
    });
  const store = (entries: Record<string, string>) => (key: string) => entries[key] ?? null;
  const written = (plan: ReturnType<typeof adoptionPlan>, key: string) =>
    plan.writes.find((w) => w.key === key)?.value;
  const target = (runId: string, repo = '/repo/a') => chatKey(repo, runId);
  const fromBucket = { dir: '/repo/a', runId: null };

  test('1. a sole source adopts with its session, and the bucket is cleared', () => {
    const plan = adoptionPlan([told('r1', '/repo/a', { held: fromBucket })], store({ [bucket]: saved('hi') }));
    expect(readChat(written(plan, target('r1')) ?? null).session?.id).toBe('sess-1');
    expect(plan.writes).toContainEqual({ key: bucket, value: null });
    expect(plan.marks).toEqual([{ handle: 'run-7', adopted: 'moved' }]);
  });

  test('2. a draft source moves, and the draft’s copy is cleared', () => {
    const key = chatKey('/repo/a', 'draft-1');
    const plan = adoptionPlan(
      [told('r1', '/repo/a', { draft: { id: 'draft-1', dir: '/repo/a' } })],
      store({ [key]: saved('brief') }),
    );
    expect(written(plan, target('r1'))).toBe(saved('brief'));
    expect(plan.writes).toContainEqual({ key, value: null });
  });

  test('3. a run’s own chat that proposed one keeps its messages and gives up its session', () => {
    const source = chatKey('/repo/a', 'old');
    const plan = adoptionPlan([told('r1', '/repo/a', { held: { dir: '/repo/a', runId: 'old' } })], store({ [source]: saved('talk') }));
    const left = readChat(written(plan, source) ?? null);
    expect(left.messages).toHaveLength(1);
    expect(left.session).toBeNull();
    expect(readChat(written(plan, target('r1')) ?? null).session?.id).toBe('sess-1');
  });

  test('4. a shared source: each run that adopts gets the exchange, none the session; one already stored restores', () => {
    const lives = [
      told('r1', '/repo/a', { held: fromBucket }),
      told('r2', '/repo/a', { handle: 'run-9', held: fromBucket }),
    ];
    const plan = adoptionPlan(lives, store({ [bucket]: saved('hi'), [target('r2')]: saved('own') }));
    const r1 = readChat(written(plan, target('r1')) ?? null);
    expect(r1.messages).toHaveLength(1);
    expect(r1.session).toBeNull();
    expect(written(plan, target('r2'))).toBeUndefined();
    expect(plan.marks).toEqual([
      { handle: 'run-7', adopted: 'moved' },
      { handle: 'run-9', adopted: 'skipped' },
    ]);
    expect(plan.writes).toContainEqual({ key: bucket, value: null });
  });

  test('5. a shared source with a sibling not yet started defers the cleanup', () => {
    const lives = [told('r1', '/repo/a', { held: fromBucket }), entry({ handle: 'run-9', pid: null, held: fromBucket })];
    const plan = adoptionPlan(lives, store({ [bucket]: saved('hi') }));
    expect(readChat(written(plan, target('r1')) ?? null).session).toBeNull();
    expect(plan.writes.some((w) => w.key === bucket)).toBe(false);
    expect(plan.marks).toEqual([{ handle: 'run-7', adopted: 'moved' }]);
  });

  test('6. an earlier pass’s move: the sibling adopts later, alone, and then the source is cleaned', () => {
    const lives = [
      { ...told('r1', '/repo/a', { held: fromBucket }), adopted: 'moved' as const },
      told('r2', '/repo/a', { handle: 'run-9', held: fromBucket }),
    ];
    const plan = adoptionPlan(lives, store({ [bucket]: saved('hi') }));
    expect(readChat(written(plan, target('r2')) ?? null).session?.id).toBe('sess-1');
    expect(plan.writes).toContainEqual({ key: bucket, value: null });
    expect(plan.marks).toEqual([{ handle: 'run-9', adopted: 'moved' }]);
  });

  test('7. a run whose target already has a conversation restores, and the source is untouched', () => {
    const plan = adoptionPlan([told('r1', '/repo/a', { held: fromBucket })], store({ [bucket]: saved('hi'), [target('r1')]: saved('own') }));
    expect(plan.writes).toEqual([]);
    expect(plan.marks).toEqual([{ handle: 'run-7', adopted: 'skipped' }]);
  });

  test('8. a resume has no source and is skipped', () => {
    const plan = adoptionPlan([told('r1', '/repo/a', { asked: 'r1' })], store({ [bucket]: saved('hi') }));
    expect(plan).toEqual({ writes: [], marks: [{ handle: 'run-7', adopted: 'skipped' }] });
  });

  test('9. a run that ended with no id is skipped; 10. a live one with no id waits', () => {
    const ended = adoptionPlan([entry({ live: false, held: fromBucket })], store({ [bucket]: saved('hi') }));
    expect(ended).toEqual({ writes: [], marks: [{ handle: 'run-7', adopted: 'skipped' }] });
    const waiting = adoptionPlan([entry({ held: fromBucket })], store({ [bucket]: saved('hi') }));
    expect(waiting).toEqual({ writes: [], marks: [] });
  });

  test('11. a run whose core sent no repo adopts into the directory it was started in', () => {
    const plan = adoptionPlan([told('r1', null, { dir: '/repo/a', held: fromBucket })], store({ [bucket]: saved('hi') }));
    expect(written(plan, target('r1', '/repo/a'))).toBeDefined();
  });

  test('12. an early run_started binds its draft: the mark is made as soon as the id is there', () => {
    const lives = fold([entry({ pid: null, draft: { id: 'draft-1', dir: '/repo/a' } })], 'run-7', startedFrame('r1', '/repo/a'));
    const key = chatKey('/repo/a', 'draft-1');
    const plan = adoptionPlan(lives, store({ [key]: saved('brief') }));
    expect(plan.marks).toEqual([{ handle: 'run-7', adopted: 'moved' }]);
  });

  test('13. a fresh run adopts only after run_started, and only once', () => {
    let lives: LiveRuns = [entry({ held: fromBucket })];
    const stored = store({ [bucket]: saved('hi') });
    expect(adoptionPlan(lives, stored).marks).toEqual([]);
    lives = fold(lives, 'run-7', startedFrame('r1', '/repo/a'));
    const plan = adoptionPlan(lives, stored);
    expect(plan.marks).toEqual([{ handle: 'run-7', adopted: 'moved' }]);
    lives = markAdopted(lives, 'run-7', 'moved');
    expect(adoptionPlan(lives, stored)).toEqual({ writes: [], marks: [] });
  });
});

test('setPid proves the host started', () => {
  expect(started(setPid([entry({ pid: null })], 'run-7', 9)[0] as LiveRun)).toBe(true);
});
