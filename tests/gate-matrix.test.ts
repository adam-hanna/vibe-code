import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Escalation, EXIT, orchestrate } from '@src/orchestrator.js';
import { DEFAULT_GATES, describeGates, GATEABLE, gateMode, validateGates } from '@src/gates.js';
import { DEFAULTS, loadConfig } from '@src/config.js';
import { buildOverrides, parseArgs } from '@src/cli.js';
import {
  agents,
  answersReport,
  BLOCKING,
  committing,
  config,
  freshRun,
  planFixture,
  questionFixture,
  report,
  verifying,
  work,
} from './helpers/loop-harness.js';
import type { Handlers } from './helpers/loop-harness.js';
import type { GatesConfig, RunState } from '@src/types.js';
import type { GateContext, Host } from '@src/host.js';

/**
 * The gate matrix (#140): which boundaries hold a run, and what a hold costs.
 *
 * Before this there was exactly one gate in the product and it was a command
 * name. #134 made six boundaries holdable and held at every one of them for
 * anything that passed a host - so the app asked you to release every plan round
 * and every review round of every run - while a terminal could not be held at
 * all.
 *
 * The three modes differ in **what a hold costs**, not how often one happens:
 * `auto` runs through, `step` holds and asks somebody, `stop` ends the run. The
 * cases below are organised around the two halves that distinguishes: what each
 * mode does when there IS a host, and what it does when there is not.
 */

function fullRun(prefix: string): RunState {
  return freshRun({ prefix, task: 'gate matrix', planOnly: false, git: true, commit: true });
}

function passing(state: RunState): Handlers {
  return {
    claude: (label) =>
      label === 'plan' || label.startsWith('revise-') ? planFixture() : work(state, `${label}.txt`),
    codex: () => report([]),
  };
}

/**
 * An all-`auto` table with the named rows overridden.
 *
 * Written out rather than derived from `GATEABLE`, deliberately: a fixture built
 * by mapping over the list under test would still be an all-`auto` table if a
 * boundary were dropped from that list, and would prove nothing about which
 * boundaries exist.
 */
function matrix(over: Partial<GatesConfig> = {}): GatesConfig {
  return {
    'plan-round': 'auto',
    'question-round': 'auto',
    'plan-approved': 'auto',
    implemented: 'auto',
    'verify-round': 'auto',
    'review-round': 'auto',
    ...over,
  };
}

/** A host that answers immediately, recording what it was asked. */
function answering(answer: unknown): Host & { asked: GateContext[] } {
  const asked: GateContext[] = [];
  return { asked, decide: (ctx) => (asked.push(ctx), Promise.resolve(answer)) };
}

/**
 * A host that has been asked to hold once, and records what it was asked (#210).
 *
 * `takes` counts how many times the loop consumed the request, which is the
 * claim that matters: a pause is one hold, so a boundary that read it and ran
 * through would leave it armed against a later boundary nobody was watching.
 */
function paused(answer: unknown): Host & { asked: GateContext[]; takes: number } {
  const asked: GateContext[] = [];
  let armed = true;
  const host = {
    asked,
    takes: 0,
    decide: (ctx: GateContext) => (asked.push(ctx), Promise.resolve(answer)),
    takePause: () => {
      host.takes += 1;
      const was = armed;
      armed = false;
      return was;
    },
  };
  return host;
}

function muted<T>(body: () => Promise<T>): Promise<T> {
  const realLog = console.log;
  const realError = console.error;
  console.log = () => undefined;
  console.error = () => undefined;
  return body().finally(() => {
    console.log = realLog;
    console.error = realError;
  });
}

// ---- the table itself -------------------------------------------------------

test('the default holds where the run changes hands, and not mid-argument', () => {
  // This asserted every gateable boundary was `step` - the groundwork bar, and
  // exactly what the loop did before there was a table. That claim is no longer
  // the contract (#211). `DEFAULT_GATES` said so itself from the day it landed:
  // *"very probably not the default anyone wants to keep... changing it is a
  // decision for whoever has the settings screen in front of them"*, and the
  // report when somebody had one was "remove the holding at the end of a plan
  // round".
  //
  // Pinned per row rather than as "not all step", because *which* two moved is
  // the decision. The planning pair is the loop arguing with itself and is
  // followed by the critic reading the result; the other four are where code
  // gets written, a diff appears, a gate fails, or findings buy a fix turn.
  assert.deepEqual(DEFAULT_GATES, {
    'plan-round': 'auto',
    'question-round': 'auto',
    'plan-approved': 'step',
    implemented: 'step',
    'verify-round': 'step',
    'review-round': 'step',
  });
  // Nothing became `stop` by default, which is the sharper half: `step` holds
  // and asks, and a terminal runs through it, so a wrong `step` costs a pause a
  // person can release. A `stop` ENDS the run, whoever is listening, and a
  // default that did that would end CLI runs nobody was watching.
  for (const boundary of GATEABLE) assert.notEqual(DEFAULT_GATES[boundary], 'stop', boundary);
  assert.deepEqual(DEFAULTS.gates, DEFAULT_GATES);
  assert.deepEqual([...GATEABLE], [
    'plan-round',
    'question-round',
    'plan-approved',
    'implemented',
    'verify-round',
    'review-round',
  ]);
});

test('the two boundaries with no row read as auto rather than throwing', () => {
  // `gateMode` takes any `CheckpointBoundary` so a caller does not have to hold
  // a second copy of which ones are gateable - which is how `final-fix` stopped
  // being holdable without the call site having to know.
  assert.equal(gateMode(matrix({ 'plan-approved': 'stop' }), 'final-fix'), 'auto');
  assert.equal(gateMode(matrix({ 'plan-approved': 'stop' }), 'complete'), 'auto');
  assert.equal(gateMode(matrix({ 'plan-approved': 'stop' }), 'plan-approved'), 'stop');
});

test('a value nobody can read runs through rather than halting the run', () => {
  // Defence in depth over `state.config`, the one field `validateStoredState`
  // passes through unchecked - and the direction is the point. This follows
  // `readOrigin` rather than `readDecision`: a *setting* nobody could parse is
  // not an instruction, and stalling a run over a typo in a config file would
  // present a spelling mistake as a stall.
  const broken = { ...matrix(), implemented: 'halt' } as unknown as GatesConfig;
  assert.equal(gateMode(broken, 'implemented'), 'auto');
});

// ---- refusal ----------------------------------------------------------------

test('an ungateable boundary is refused by name, with its own reason', () => {
  // Two boundaries, two different reasons, so two different sentences. Telling
  // someone who wrote `"final-fix": "stop"` that it is "not a boundary" would be
  // false - it is one, and that is the only thing about it that did not change.
  assert.throws(
    () => validateGates({ ...matrix(), 'final-fix': 'stop' }),
    /gates\.final-fix cannot be gated:.*verification gate/s,
  );
  assert.throws(
    () => validateGates({ ...matrix(), complete: 'stop' }),
    /gates\.complete cannot be gated:.*no next thing/s,
  );
});

test('a misspelt boundary, a bad mode and a missing row are each refused', () => {
  // The reason `gates` gets its own merge instead of `mergeSection`: that one
  // iterates the base's keys and drops the rest, and a dropped gate is worse
  // than a dropped setting - the user's next act is to start a run and wait at a
  // boundary that will never hold.
  assert.throws(() => validateGates({ ...matrix(), plan_approved: 'stop' }), /gates\.plan_approved is not a boundary/);
  assert.throws(() => validateGates({ ...matrix(), implemented: 'never' }), /gates\.implemented must be one of auto, step, stop, not "never"/);
  const short = { ...matrix() } as Record<string, unknown>;
  delete short['review-round'];
  assert.throws(() => validateGates(short), /gates\.review-round is missing/);
  assert.throws(() => validateGates('stop'), /gates must be an object/);
});

/** A bare directory holding a `vibe.config.json`, which is all `loadConfig` reads. */
function project(contents: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-gates-cfg-'));
  writeFileSync(path.join(dir, 'vibe.config.json'), JSON.stringify(contents));
  return dir;
}

test('a config file is refused the same way, and by the same sentence', () => {
  // Through `loadConfig` rather than the validator alone: the merge has to keep
  // the bad key for the validator to see it, which is the half `mergeSection`
  // would have got wrong.
  assert.throws(() => loadConfig(project({ gates: { 'final-fix': 'stop' } })), /gates\.final-fix cannot be gated/);
  assert.throws(() => loadConfig(project({ gates: { implemented: 'never' } })), /gates\.implemented must be one of/);
  // A partial table is the ordinary way to write one: the rows named override,
  // the rest keep the default, and nothing is "missing" until the merge is done.
  //
  // The unnamed row is checked against `DEFAULT_GATES` rather than against a
  // literal. What this case is about is that the merge KEEPS a row nobody wrote,
  // and spelling the default here made it fail when the default moved (#211) -
  // which is a test failing for something it was not guarding.
  assert.equal(loadConfig(project({ gates: { implemented: 'stop' } })).gates.implemented, 'stop');
  assert.equal(
    loadConfig(project({ gates: { implemented: 'stop' } })).gates['plan-round'],
    DEFAULT_GATES['plan-round'],
  );
});

test('a config written before gates existed still loads, with the default table', () => {
  // The layering rule in `applyOverrides`, which is what stops every key added
  // to `Config` from breaking resume for every run already on disk.
  const cfg = loadConfig(project({ loop: { maxPlanRounds: 2 } }));
  assert.deepEqual(cfg.gates, DEFAULT_GATES);
  assert.equal(cfg.loop.maxPlanRounds, 2);
});

// ---- with a host ------------------------------------------------------------

test('a pause holds at the next auto boundary, and at exactly one', async () => {
  // #210. `AGENTS.md` has said since the app landed that pausing is free, and
  // the mechanism was real - the app runs the loop in its own process, so a hold
  // is an `await` and both sessions stay warm. What did not exist was any way to
  // ask for one without hand-editing `cfg.gates` before the run started.
  const state = fullRun('vibe-gates-pause-');
  const host = paused({ kind: 'continue' });
  await muted(() =>
    orchestrate(
      state,
      config({}, { ...committing(), ...verifying(state), gates: matrix() }),
      false,
      agents(passing(state), []),
      host,
    ),
  );

  // Exactly one hold, at the FIRST boundary the loop reached - not at all of
  // them, which is what a pause read as a mode would have done.
  assert.equal(host.asked.length, 1, 'a pause is one hold, not a mode');
  assert.equal(state.status, 'done');

  // And it was consulted at every boundary, so the one that took it is the one
  // that held. A request read once and left armed is the failure this pins.
  assert.ok(host.takes > 1, 'every boundary asks; only the first one gets a yes');
});

test('a pause changes nothing on a row that was already holding', async () => {
  // `step` holds anyway and `stop` ends the run anyway, so on those a pause is a
  // request the loop was about to honour. What it must not do is hold twice.
  const state = fullRun('vibe-gates-pause-step-');
  const host = paused({ kind: 'continue' });
  await muted(() =>
    orchestrate(
      state,
      config(
        {},
        { ...committing(), ...verifying(state), gates: matrix({ implemented: 'step' }) },
      ),
      false,
      agents(passing(state), []),
      host,
    ),
  );

  // One hold from the pause and one from the `implemented` row. They are two
  // different boundaries, which is the point: neither swallowed the other.
  assert.equal(host.asked.length, 2);
  assert.ok(host.asked.some((c) => c.boundary === 'implemented'));
});

test('the matrix is what arms a gate: auto is not asked, step is', async () => {
  // The behaviour #140 exists to add. Before this a host was asked at all six
  // whatever it wanted, and the only way to not be asked was to not be a host.
  const quiet = fullRun('vibe-gates-auto-');
  const ignored = answering({ kind: 'continue' });
  await muted(() =>
    orchestrate(
      quiet,
      config({}, { ...committing(), ...verifying(quiet), gates: matrix() }),
      false,
      agents(passing(quiet), []),
      ignored,
    ),
  );
  assert.deepEqual(ignored.asked, [], 'an all-auto table asked a host something');
  assert.equal(quiet.status, 'done');

  const armed = fullRun('vibe-gates-step-');
  const host = answering({ kind: 'continue' });
  await muted(() =>
    orchestrate(
      armed,
      config({}, { ...committing(), ...verifying(armed), gates: matrix({ implemented: 'step' }) }),
      false,
      agents(passing(armed), []),
      host,
    ),
  );
  assert.deepEqual(host.asked.map((c) => c.boundary), ['implemented']);
  assert.equal(armed.status, 'done');
});

test('stop asks nobody, so it means the same thing whoever is listening', async () => {
  // What makes `stop` the mode that serves both front ends. It does not consult
  // a host even when one is right there, which is why the CLI case below and
  // this one produce the same run.
  const state = fullRun('vibe-gates-stop-host-');
  const host = answering({ kind: 'continue' });
  const calls: string[] = [];

  const err = await muted(() =>
    orchestrate(
      state,
      config({}, { ...committing(), ...verifying(state), gates: matrix({ 'plan-approved': 'stop' }) }),
      false,
      agents(passing(state), calls),
      host,
    ).then(
      () => null,
      (e: unknown) => e,
    ),
  );

  assert.ok(err instanceof Escalation, String(err));
  assert.equal(err.code, EXIT.NEEDS_HUMAN);
  assert.deepEqual(host.asked, [], 'a stop gate consulted the host it was meant to overrule');
  assert.deepEqual(calls, ['plan', 'critique-0']);
});

test('question-round is holdable, and the context says which round it is', async () => {
  // The row #139 could not add: it made `question-round` a checkpoint and left
  // it ungateable on the grounds that `GateContext` carried no question counter,
  // so a host asked to hold at the second of three would have been told
  // everything except the number the decision turns on.
  const state = freshRun({ prefix: 'vibe-gates-question-', task: 'gate matrix' });
  const host = answering({ kind: 'continue' });

  await muted(() =>
    orchestrate(
      state,
      config({}, { gates: matrix({ 'question-round': 'step' }) }),
      false,
      agents(
        {
          claude: (label) =>
            label === 'plan' ? planFixture({ open_questions: [questionFixture()] }) : planFixture(),
          codex: (label) => (label === 'answers-0' ? answersReport([{}]) : report([])),
        },
        [],
      ),
      host,
    ),
  );

  assert.deepEqual(host.asked.map((c) => c.boundary), ['question-round']);
  assert.equal(host.asked[0]?.questionRound, 1);
  // Beside it and unchanged: the counter is added to the context, not swapped in.
  assert.equal(typeof host.asked[0]?.planRound, 'number');
  assert.equal(typeof host.asked[0]?.reviewRound, 'number');
});

test('stopping at a question round hands back the questions to answer', async () => {
  // The gap this closes, and it is the one that made `continue` the only usable
  // button. `writeEscalation` renders a *Your answer:* block per question and
  // the resume parses them back - but the gate's own stop carried no questions,
  // so `NEEDS-INPUT.md` omitted the section entirely at the one boundary whose
  // whole subject is questions. Stopping to answer them yourself produced a
  // document with nothing to answer.
  //
  // Not new machinery: `resolveQuestions` already throws with `[...blockers]`
  // when the answerer is off. This is the same field on the same error, reached
  // the other way.
  const state = freshRun({ prefix: 'vibe-gates-question-stop-', task: 'gate matrix' });
  const asked = questionFixture();

  const err = await muted(() =>
    orchestrate(
      state,
      config({}, { gates: matrix({ 'question-round': 'stop' }) }),
      false,
      agents(
        {
          claude: (label) =>
            label === 'plan' ? planFixture({ open_questions: [asked] }) : planFixture(),
          codex: (label) => (label === 'answers-0' ? answersReport([{}]) : report([])),
        },
        [],
      ),
    ).then(
      () => null,
      (e: unknown) => e,
    ),
  );

  assert.ok(err instanceof Escalation, String(err));
  assert.equal(err.code, EXIT.NEEDS_HUMAN);
  assert.match(err.message, /Stopped at the question-round boundary/);
  // The questions the round put, carried on the error that ends the run.
  assert.deepEqual(
    (err.questions ?? []).map((q) => q.question),
    [asked.question],
  );
});

// ---- with no host, which is every run from a terminal ------------------------

test('stop halts a terminal run at the boundary, resumably', async () => {
  // "That makes gates usable from the CLI too, which they are not today" - the
  // headline of #140, and the case that needs no host at all.
  const state = fullRun('vibe-gates-stop-cli-');
  const calls: string[] = [];

  const err = await muted(() =>
    orchestrate(
      state,
      config({}, { ...committing(), ...verifying(state), gates: matrix({ implemented: 'stop' }) }),
      false,
      agents(passing(state), calls),
    ).then(
      () => null,
      (e: unknown) => e,
    ),
  );

  assert.ok(err instanceof Escalation, String(err));
  assert.equal(err.code, EXIT.NEEDS_HUMAN);
  assert.match(err.message, /Stopped at the implemented boundary/);
  // The implementation happened and the review did not: the halt is at the
  // boundary, after the checkpoint, which is what makes "nothing is lost" true.
  assert.deepEqual(calls, ['plan', 'critique-0', 'implement']);

  const stopped = state.events.filter((e) => e.type === 'gate_stopped');
  assert.equal(stopped.length, 1);
  // Flat, as every `RunEvent` is: `recordAndSay`'s data is spread onto the row
  // rather than nested under it.
  const data = stopped[0];
  assert.equal(data?.['boundary'], 'implemented');
  // Attributed to the configuration rather than left absent. Nobody shaped this
  // decision at the time, so "who released this" has an answer and it is the
  // table; an absent origin would read as an operator whose identity was lost.
  assert.equal(data?.['origin'], 'gates');
});

test('and vibe resume carries on from it, on the same plan', async () => {
  // #140's own acceptance: "exits resumable, and `vibe resume` continues on the
  // same plan". The plan turn is the expensive one and a gate that made the run
  // buy it again would be a gate nobody could afford to arm.
  const state = fullRun('vibe-gates-resume-');
  const first: string[] = [];
  const settings = { ...committing(), ...verifying(state) };

  await assert.rejects(
    () =>
      muted(() =>
        orchestrate(
          state,
          config({}, { ...settings, gates: matrix({ implemented: 'stop' }) }),
          false,
          agents(passing(state), first),
        ),
      ),
    (err: unknown) => err instanceof Escalation && err.code === EXIT.NEEDS_HUMAN,
  );
  assert.deepEqual(first, ['plan', 'critique-0', 'implement']);
  const planned = state.plan;
  assert.ok(planned !== null);

  // Resumed with the gate disarmed, which is what answering it amounts to from a
  // terminal: the answer is the next command you type.
  const second: string[] = [];
  await muted(() =>
    orchestrate(
      state,
      config({}, { ...settings, gates: matrix() }),
      true,
      agents(passing(state), second),
    ),
  );

  // No second `plan` and no second `implement`: the resume picks up at the
  // review phase the checkpoint recorded, which is the whole of "nothing is
  // lost" for the CLI half of the matrix.
  assert.deepEqual(second, ['review-0']);
  assert.deepEqual(state.plan, planned);
  assert.equal(state.status, 'done');
});

test('step needs somebody to ask, so from a terminal it runs through', async () => {
  // The mode's definition rather than a failure of it: a terminal cannot resolve
  // a promise, and inventing an answer is the one thing a gate must not do.
  // `vibe doctor` prints this per row - see `describeGates` - because the only
  // other way to learn it is to run and not notice.
  const state = fullRun('vibe-gates-step-cli-');
  const calls: string[] = [];

  await muted(() =>
    orchestrate(
      state,
      config({}, { ...committing(), ...verifying(state), gates: DEFAULT_GATES }),
      false,
      agents(passing(state), calls),
    ),
  );

  assert.deepEqual(calls, ['plan', 'critique-0', 'implement', 'review-0']);
  assert.equal(state.status, 'done');
  assert.equal(state.events.some((e) => e.type === 'gate_stopped'), false);
});

test('a gate stop and a cap halt are different events', async () => {
  // #140 asks for these to be distinguishable, and they already are - both stop
  // the run and both resume, but a gate stop is expected and a cap halt is a
  // failure to converge. Pinned here rather than assumed, because the two share
  // `Escalation` and nothing else would catch them collapsing.
  const gated = fullRun('vibe-gates-vs-cap-gate-');
  const gateErr = await muted(() =>
    orchestrate(
      gated,
      config({}, { ...committing(), ...verifying(gated), gates: matrix({ 'plan-approved': 'stop' }) }),
      false,
      agents(passing(gated), []),
    ).then(
      () => null,
      (e: unknown) => e,
    ),
  );

  const capped = fullRun('vibe-gates-vs-cap-cap-');
  const capErr = await muted(() =>
    orchestrate(
      capped,
      config({ maxPlanRounds: 1 }, { ...committing(), ...verifying(capped), gates: matrix() }),
      false,
      agents({ claude: () => planFixture(), codex: () => report(BLOCKING) }, []),
    ).then(
      () => null,
      (e: unknown) => e,
    ),
  );

  assert.ok(gateErr instanceof Escalation && capErr instanceof Escalation);
  assert.equal(gateErr.code, EXIT.NEEDS_HUMAN);
  assert.equal(capErr.code, EXIT.NO_CONVERGENCE);
  // And in the archive, not only in the exit code: only one of them is a gate.
  assert.ok(gated.events.some((e) => e.type === 'gate_stopped'));
  assert.equal(capped.events.some((e) => e.type === 'gate_stopped'), false);
});

// ---- the readouts -----------------------------------------------------------

test('doctor names the rows that will stop you, and the ones that will not', () => {
  // `console.log` no test reaches, so the strings are checked here and printed
  // there. The `step` caveat rides beside the rows it applies to rather than
  // sitting in a footnote: it is the one setting in this table that does
  // nothing from the terminal reading it.
  assert.deepEqual(describeGates(matrix()), ['gates: none - every boundary runs through']);

  const mixed = describeGates(matrix({ implemented: 'stop', 'plan-approved': 'step' }));
  assert.equal(mixed.length, 2);
  assert.match(mixed[0] ?? '', /stop at implemented - the run ends there/);
  assert.match(mixed[1] ?? '', /step at plan-approved - held only where a host can answer/);
  assert.match(mixed[1] ?? '', /use stop for a halt you can resume/);

  // Loop order, not alphabetical: it is what a reader is matching against the
  // run they just watched. Built from `DEFAULT_GATES` rather than spelled out,
  // so this keeps checking the ORDER - which is the claim - when the table
  // changes, instead of failing because it did (#211).
  const stepping = GATEABLE.filter((b) => DEFAULT_GATES[b] === 'step');
  assert.ok(stepping.length > 0, 'the default holds nowhere, so this case proves nothing');
  assert.match(describeGates(DEFAULT_GATES)[0] ?? '', new RegExp(`step at ${stepping.join(', ')}`));
  // And the rows that run through are not listed as holding anywhere.
  for (const boundary of GATEABLE.filter((b) => DEFAULT_GATES[b] === 'auto')) {
    assert.doesNotMatch(describeGates(DEFAULT_GATES).join('\n'), new RegExp(`\\b${boundary}\\b`));
  }
});

test('--gate reaches the config, last wins, and a bad one is refused there', () => {
  const parsed = parseArgs(['run', 'x', '--gate', 'implemented=stop', '--gate', 'plan-round=auto']);
  assert.deepEqual(parsed.flags.gate, ['implemented=stop', 'plan-round=auto']);
  assert.deepEqual(buildOverrides(parsed.flags).gates, { implemented: 'stop', 'plan-round': 'auto' });

  // Last wins, as `--role` does.
  const twice = parseArgs(['run', 'x', '--gate', 'implemented=stop', '--gate', 'implemented=auto']);
  assert.deepEqual(buildOverrides(twice.flags).gates, { implemented: 'auto' });

  // Only the SHAPE is the parser's business. A bad boundary or a bad mode is
  // judged in config.ts, so the flag and the config key get the same sentence.
  assert.throws(
    () => buildOverrides(parseArgs(['run', 'x', '--gate', 'implemented']).flags),
    /--gate expects <boundary>=<mode>/,
  );
  assert.throws(
    () => buildOverrides(parseArgs(['run', 'x', '--gate', '=stop']).flags),
    /--gate expects <boundary>=<mode>/,
  );

  const dir = project({});
  const bad = parseArgs(['run', 'x', '--gate', 'implemented=never']);
  assert.throws(() => loadConfig(dir, buildOverrides(bad.flags)), /gates\.implemented must be one of/);
  const ok = parseArgs(['run', 'x', '--gate', 'implemented=stop']);
  assert.equal(loadConfig(dir, buildOverrides(ok.flags)).gates.implemented, 'stop');
});
