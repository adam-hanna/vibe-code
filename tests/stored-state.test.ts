import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRun, listRuns, loadRun, resumePhase } from '@src/run.js';
import { KNOWN_KEYS, REDERIVED_KEYS, StoredStateError } from '@src/stored.js';
import type { RunState, RunStatus } from '@src/types.js';

/**
 * What `loadRun` does with a `state.json` that is not what it claims to be.
 *
 * The rule under test is the one in `src/stored.ts`: repair what is only a
 * record, refuse what is a promise, and leave an absent optional or a legal
 * `null` alone. Every case here writes a real file into a real run directory and
 * loads it through the real `loadRun`, because the defect being fixed was
 * precisely that the boundary was not exercised.
 *
 * Nothing cleans up its temp directory - the same reason `loop-harness.ts` gives:
 * `rmSync` over a directory a child process has just touched is a Windows flake
 * source in a suite that has to pass three times running.
 */

const RUNS = path.join('.vibe', 'runs');

/** A healthy run on disk, and the handles to corrupt it. */
function fresh(task = 'stored state'): { targetDir: string; id: string; file: string } {
  const targetDir = mkdtempSync(path.join(tmpdir(), 'vibe-stored-'));
  const state = createRun(targetDir, task, true);
  return { targetDir, id: state.id, file: path.join(state.dir, 'state.json') };
}

/** Rewrite the stored state through a mutation, as a corrupt file would look. */
function corrupt(
  mutate: (raw: Record<string, unknown>) => void,
  task?: string,
): { targetDir: string; id: string; file: string } {
  const run = fresh(task);
  const raw: unknown = JSON.parse(readFileSync(run.file, 'utf8'));
  assert.ok(raw !== null && typeof raw === 'object');
  const rec = raw as Record<string, unknown>;
  mutate(rec);
  writeFileSync(run.file, JSON.stringify(rec, null, 2), 'utf8');
  return run;
}

/** Load a state built by one mutation. */
function load(mutate: (raw: Record<string, unknown>) => void): RunState {
  const run = corrupt(mutate);
  return loadRun(run.targetDir, run.id);
}

/** The `state_repaired` events a load recorded, by field. */
function repairs(state: RunState): string[] {
  return state.events.filter((e) => e.type === 'state_repaired').map((e) => String(e['field']));
}

/** A load that must refuse, returning the message so a case can read it. */
function refusal(run: { targetDir: string; id: string; file: string }, id = run.id): string {
  const before = readFileSync(run.file, 'utf8');
  let message = '';
  try {
    loadRun(run.targetDir, id);
    assert.fail('expected the load to refuse');
  } catch (err) {
    assert.ok(err instanceof StoredStateError, `expected StoredStateError, got ${String(err)}`);
    message = err.message;
  }
  // The refusal claims nothing was rewritten. That is only true if it is true.
  assert.equal(readFileSync(run.file, 'utf8'), before);
  return message;
}

/** A finding, an answer and a round the readers must all accept. */
const FINDING = {
  id: 'good-finding',
  severity: 'P2',
  title: 'Title',
  detail: 'Detail',
  suggested_fix: 'Fix',
};
const ANSWER = {
  question: 'Lazy or eager?',
  answer: 'Lazy.',
  confidence: 'high',
  defer_to_human: false,
  rationale: 'Because.',
};
const QUESTION = {
  question: 'Lazy or eager?',
  options: ['lazy', 'eager'],
  recommended: 'lazy',
  kind: 'product',
  blocking: true,
};
const ASSUMPTION = { assumption: 'A', why: 'B', blast_radius: 'C' };
const AGENT = {
  provider: 'claude',
  shell: 'bash',
  pathStyle: 'msys',
  repaired: false,
  tools: [{ name: 'git', available: true, version: 'git version 2.31.1' }],
};
const ENVIRONMENT = { agents: [AGENT], verifyCommand: 'npm test', verifyRuns: 3 };
const RATE_LIMIT = {
  window: 'primary',
  windowFromServer: true,
  usedPercent: 42,
  windowDurationMins: 10080,
  resetsAt: new Date(Date.now() + 3_600_000).toISOString(),
  reachedType: null,
  planType: 'pro',
  capturedAt: new Date().toISOString(),
};

// ---- the id becomes a path, so it is checked first --------------------------

test('an id that is not a single directory name is refused before anything is read', () => {
  const run = fresh();
  for (const id of ['..', '../outside', '..\\outside', 'a/b', 'a\\b', '', '.', 'C:\\tmp']) {
    const message = refusal(run, id);
    assert.match(message, /not a run id|resolves outside/);
    assert.match(message, /Nothing was read or written/);
  }
  // The legal id still loads, so the guard is not simply rejecting everything.
  assert.equal(loadRun(run.targetDir, run.id).id, run.id);
});

test('a traversal id does not read a valid state file outside the runs root', () => {
  // A run whose sibling directory holds a state.json that would otherwise load.
  const run = fresh();
  const outside = path.join(run.targetDir, RUNS, '..', '..', 'escape');
  mkdirSync(outside, { recursive: true });
  const planted = path.join(outside, 'state.json');
  copyFileSync(run.file, planted);
  const before = readFileSync(planted, 'utf8');

  assert.throws(
    () => loadRun(run.targetDir, path.join('..', '..', 'escape')),
    (err: unknown) => err instanceof StoredStateError,
  );
  assert.equal(readFileSync(planted, 'utf8'), before);
});

// ---- getting to a record at all ---------------------------------------------

test('unparseable JSON refuses with a message, not a SyntaxError', () => {
  for (const text of ['{', '', '{"id": "half']) {
    const run = fresh();
    writeFileSync(run.file, text, 'utf8');
    const message = refusal(run);
    assert.match(message, /state\.json is not valid JSON/);
    assert.match(message, /run directory is intact/);
  }
});

test('a truncated state file refuses rather than throwing from inside a phase', () => {
  const run = fresh();
  writeFileSync(run.file, readFileSync(run.file, 'utf8').slice(0, 120), 'utf8');
  assert.match(refusal(run), /not valid JSON/);
});

test('a JSON root that is not an object refuses, naming what was found', () => {
  for (const text of ['null', '[]', '"a string"', '7', 'true']) {
    const run = fresh();
    writeFileSync(run.file, text, 'utf8');
    const message = refusal(run);
    assert.match(message, /does not contain a run/);
    assert.match(message, /top level/);
  }
});

test('a stored id that disagrees with its directory refuses, naming both', () => {
  const run = corrupt((raw) => {
    raw['id'] = 'some-other-run';
    // Corrupt beside it, to prove repairs collected before the refusal are lost
    // with the throw rather than reaching disk.
    raw['events'] = 'not an array';
  });
  const message = refusal(run);
  assert.match(message, /some-other-run/);
  assert.ok(message.includes(run.id), 'the requested id is named too');
  assert.match(message, /vibe\/some-other-run/);
});

test('an empty or non-string id refuses', () => {
  for (const value of ['', 7, null]) {
    const run = corrupt((raw) => {
      raw['id'] = value;
    });
    assert.match(refusal(run), /"id"/);
  }
});

// ---- promises are refused ---------------------------------------------------

test('a corrupt cost or token total refuses and is never zeroed', () => {
  for (const [field, value] of [
    ['costUsd', 'lots'],
    ['costUsd', -1],
    ['tokensUsed', 'many'],
  ] as const) {
    const run = corrupt((raw) => {
      raw[field] = value;
    });
    const message = refusal(run);
    assert.match(message, new RegExp(`"${field}"`));
    assert.match(message, /run budget is/);
    // The corrupt value is still on disk: nothing was reset behind the user.
    const stored: unknown = JSON.parse(readFileSync(run.file, 'utf8'));
    assert.deepEqual((stored as Record<string, unknown>)[field], value);
  }
});

test('a missing accounting field refuses', () => {
  const run = corrupt((raw) => {
    delete raw['tokensUsed'];
  });
  assert.match(refusal(run), /"tokensUsed"/);
});

test('identity and counter fields refuse when they are the wrong type', () => {
  const cases: [string, unknown][] = [
    ['task', 7],
    ['sessionId', 5],
    ['createdAt', null],
    ['createdAt', 'not-a-date'],
    ['status', 3],
    ['planOnly', 'yes'],
    ['planRound', '3'],
    ['planRound', 1.5],
    ['sessionRotations', -1],
    ['reviewRound', Number.NaN],
  ];
  for (const [field, value] of cases) {
    const run = corrupt((raw) => {
      raw[field] = value;
    });
    const message = refusal(run);
    assert.match(message, new RegExp(`"${field}"`), `${field} is named`);
    assert.match(message, /run directory is intact/);
  }
});

test('an unrecognised status refuses, and lists the ones this version knows', () => {
  const run = corrupt((raw) => {
    raw['status'] = 'a-new-status';
  });
  const message = refusal(run);
  assert.match(message, /a-new-status/);
  assert.match(message, /planning, implementing, reviewing, planned, done/);
});

test('every legal status loads, beside a planOnly that permits it', () => {
  // Was one loop over all eight statuses. It could be, while `status` was
  // validated alone - but `fresh()` builds PLAN-ONLY runs, and since #54 three
  // of those eight triples are ones no writer can produce: only the plan-only
  // exit writes 'planned', and only the path past it writes 'implementing',
  // 'reviewing' and 'done'. So there is no single `planOnly` under which all
  // eight are legal, and asserting otherwise asserted the defect.
  //
  // Split rather than narrowed, so the original claim survives in full: every
  // value of the enum is still accepted by the reader, each beside the
  // `planOnly` its own writer runs under, and the two lists still union to all
  // eight. The phase stays 'planning' from `createRun` throughout, so nothing
  // here resolves to 'complete' and rule C never enters into it.
  const byPlanOnly: [boolean, RunStatus[]][] = [
    [false, ['planning', 'implementing', 'reviewing', 'done', 'needs-input', 'stalled', 'error']],
    [true, ['planning', 'planned', 'needs-input', 'stalled', 'error']],
  ];

  const seen = new Set<RunStatus>();
  for (const [planOnly, statuses] of byPlanOnly) {
    for (const status of statuses) {
      const loaded = load((raw) => {
        raw['status'] = status;
        raw['planOnly'] = planOnly;
      });
      assert.equal(loaded.status, status);
      assert.equal(loaded.planOnly, planOnly);
      assert.deepEqual(repairs(loaded), [], `${status}/planOnly=${planOnly} produces no repair`);
      assert.equal(loaded.phase, 'planning', `${status} keeps the phase it was stored with`);
      seen.add(status);
    }
  }
  assert.equal(seen.size, 8, 'between them the two lists still cover every legal status');
});

// ---- records are repaired ---------------------------------------------------

test('a present non-array becomes the empty list, with an event naming the field', () => {
  const cases: [string, unknown][] = [
    ['events', 'nope'],
    ['p1Rounds', {}],
    ['verifyRounds', 3],
    ['answeredQuestions', 5],
    ['deferredQuestions', 'x'],
    ['carried', 'x'],
    ['deferred', 3],
    ['outstanding', 'x'],
  ];
  for (const [field, value] of cases) {
    const loaded = load((raw) => {
      raw[field] = value;
    });
    // `events` is the one field that is not empty afterwards: the repair events
    // themselves land in the array the load just rebuilt, which is the point.
    const remaining =
      field === 'events'
        ? loaded.events.filter((e) => e.type !== 'state_repaired')
        : loaded[field as 'p1Rounds'];
    assert.deepEqual(remaining, [], `${field} is empty`);
    assert.deepEqual(repairs(loaded), [field]);
  }
});

test('a wrong-typed nullable becomes null, and a stored null is left alone', () => {
  for (const field of ['baseSha', 'branch', 'handoff', 'extraContext', 'codexSessionId']) {
    const repaired = load((raw) => {
      raw[field] = 7;
    });
    assert.equal(repaired[field as 'branch'], null);
    assert.deepEqual(repairs(repaired), [field]);
  }
});

test('a corrupt sessionStarted or contextRatio takes its empty value', () => {
  const started = load((raw) => {
    raw['sessionStarted'] = 'yes';
  });
  assert.equal(started.sessionStarted, false);
  assert.deepEqual(repairs(started), ['sessionStarted']);

  const ratio = load((raw) => {
    raw['contextRatio'] = 'half';
  });
  assert.equal(ratio.contextRatio, 0);
  assert.deepEqual(repairs(ratio), ['contextRatio']);
});

test('a stored string in pendingAnswers never reaches the planner as characters', () => {
  const loaded = load((raw) => {
    raw['pendingAnswers'] = 'lazy';
  });
  assert.equal(loaded.pendingAnswers, null);
  assert.deepEqual(repairs(loaded), ['pendingAnswers']);
});

test('unusable elements are dropped while their valid siblings survive', () => {
  const loaded = load((raw) => {
    raw['p1Rounds'] = [
      { signature: 'abc', count: 2, ids: ['one', 'two'] },
      'junk',
      { signature: null, count: 1, ids: 'abc' },
      { signature: null, count: 1.5 },
    ];
    raw['answeredQuestions'] = ['ok', 5];
    raw['carried'] = [FINDING, { id: 'junk' }];
    raw['events'] = [{ at: 'now', type: 'created' }, 5, { at: 'x' }];
    raw['pendingAnswers'] = [ANSWER, { question: 7 }];
  });

  assert.deepEqual(loaded.p1Rounds, [
    { signature: 'abc', count: 2, ids: ['one', 'two'] },
    // A string `ids` reads as absent - "cannot tell" - rather than iterating as
    // characters; the count beside it is still the round's real one.
    { signature: null, count: 1 },
  ]);
  assert.ok(repairs(loaded).includes('p1Rounds[2].ids'));
  assert.deepEqual(loaded.answeredQuestions, ['ok']);
  assert.deepEqual(loaded.carried?.map((f) => f.id), ['good-finding']);
  assert.equal(loaded.pendingAnswers?.length, 1);
  assert.equal(loaded.pendingAnswers?.[0]?.question, ANSWER.question);
  // The repair events land in the event array the load rebuilt.
  assert.ok(repairs(loaded).includes('events'));
  assert.ok(repairs(loaded).includes('p1Rounds'));
});

test('one event per field carries an exact dropped count and bounded paths', () => {
  const loaded = load((raw) => {
    raw['plan'] = {
      plan_md: '# plan',
      assumptions: [],
      open_questions: Array.from({ length: 60 }, () => ({ question: 7 })),
    };
  });
  const events = loaded.events.filter((e) => e.type === 'state_repaired');
  const questions = events.filter((e) => e['field'] === 'plan.open_questions');
  assert.equal(questions.length, 1, 'one event for the field, not sixty');
  assert.equal(questions[0]?.['droppedCount'], 60);
  assert.deepEqual((questions[0]?.['droppedPaths'] as string[]).length, 50);
});

test('repairs are on disk, not only in memory', () => {
  const run = corrupt((raw) => {
    raw['events'] = 'nope';
  });
  loadRun(run.targetDir, run.id);
  const stored: unknown = JSON.parse(readFileSync(run.file, 'utf8'));
  const events = (stored as { events: { type: string; field?: string }[] }).events;
  assert.ok(events.some((e) => e.type === 'state_repaired' && e.field === 'events'));
});

// ---- absence and legal nulls are not corruption ------------------------------

test('every nullable field holding null loads with no repair at all', () => {
  const loaded = load((raw) => {
    for (const field of [
      'plan',
      'pendingAnswers',
      'pendingFindings',
      'baseSha',
      'branch',
      'codexSessionId',
      'handoff',
      'extraContext',
      'codexRateLimit',
      'environment',
    ]) {
      raw[field] = null;
    }
  });
  assert.deepEqual(repairs(loaded), []);
  assert.equal(loaded.plan, null);
  assert.equal(loaded.pendingFindings, null);
  assert.equal(loaded.codexRateLimit, null);
  assert.equal(loaded.environment, null);
});

test('pendingFindings null is the ordinary post-consumption value, not damage', () => {
  const loaded = load((raw) => {
    raw['pendingFindings'] = null;
  });
  assert.equal(loaded.pendingFindings, null);
  assert.deepEqual(repairs(loaded), []);
});

test('an absent optional is never corruption', () => {
  const loaded = load((raw) => {
    for (const field of ['phase', 'codexTokens', 'pendingFindings', 'config', 'environment']) {
      delete raw[field];
    }
  });
  assert.deepEqual(repairs(loaded), []);
  assert.equal('phase' in loaded, false);
  assert.equal('config' in loaded, false);
});

// ---- per-field only: no cross-field rule ships here (#54) --------------------

test('a phase this version does not know is dropped, and status inference takes over', () => {
  // `planOnly: false` added by #54, and it is the fixture that moved, not the
  // claim. `fresh()` builds plan-only runs, and status 'implementing' is written
  // only past the plan-only exit - so this used to describe a triple no writer
  // produces, and is now refused as one. The behaviour under test is the reader
  // dropping an unrecognised phase and `resumePhase` falling back to the status,
  // which is unchanged and is what the assertions below still check.
  const loaded = load((raw) => {
    raw['phase'] = 'banana';
    raw['status'] = 'implementing';
    raw['planOnly'] = false;
  });
  assert.equal('phase' in loaded, false);
  assert.deepEqual(repairs(loaded), ['phase']);
  assert.equal(resumePhase(loaded), 'implementing');
});

test('a TERMINAL status is trusted beside any phase, complete included - see #54', () => {
  // Regression guard for a rule that was proposed twice and refuted twice. A
  // failed preflight sets status 'error' without touching the phase, so
  // error+complete is writer-generated: "repairing" it would make resumePhase
  // infer planning and re-run finished work.
  //
  // Narrowed by #54, and this is the substantive edit that change makes to an
  // existing test. The list used to hold five triples under the title "trusted
  // whatever status and planOnly hold". Three of those five were not
  // counterexamples to the refuted rule at all - they were the states #54 was
  // filed to catch:
  //
  //   ['planning', 'complete',     false]  no writer leaves a completed phase here
  //   ['planned',  'complete',     false]  only the plan-only exit writes 'planned'
  //   ['planning', 'implementing', true ]  a plan-only run cannot reach implementing
  //
  // The guard was right about what it was defending and over-general about how.
  // What actually refutes the rejected rule is a TERMINAL status beside a
  // phase - `cli.ts` writes those without touching the phase - and that is what
  // the two surviving rows are and what the title now says. The three removed
  // rows are not untested: `tests/state-consistency.test.ts` asserts the exact
  // rule each one trips and the message it produces, which is strictly more than
  // "it loads clean" ever said.
  const pairs: [string, string, boolean][] = [
    ['error', 'complete', false],
    ['stalled', 'complete', true],
  ];
  for (const [status, phase, planOnly] of pairs) {
    const loaded = load((raw) => {
      raw['status'] = status;
      raw['phase'] = phase;
      raw['planOnly'] = planOnly;
    });
    assert.equal(loaded.phase, phase, `${status}/${phase} is kept`);
    assert.equal(loaded.planOnly, planOnly);
    assert.deepEqual(repairs(loaded), [], `${status}/${phase} produces no repair`);
  }
});

test('the token share is not policed here either - see #54', () => {
  const loaded = load((raw) => {
    raw['tokensUsed'] = 10;
    raw['codexTokens'] = 100;
  });
  assert.equal(loaded.tokensUsed, 10);
  assert.equal(loaded.codexTokens, 100);
  assert.deepEqual(repairs(loaded), []);
});

// ---- the reader's domain is the writer's range ------------------------------

test('an overfull context ratio survives, because rotation acts on it', () => {
  const loaded = load((raw) => {
    raw['contextRatio'] = 1.8;
  });
  assert.equal(loaded.contextRatio, 1.8);
  assert.deepEqual(repairs(loaded), []);
});

test('a non-integer window or token total survives', () => {
  const loaded = load((raw) => {
    raw['contextWindow'] = 1_000_000.5;
    raw['tokensUsed'] = 12.5;
  });
  assert.equal(loaded.contextWindow, 1_000_000.5);
  assert.equal(loaded.tokensUsed, 12.5);
  assert.deepEqual(repairs(loaded), []);
});

test('optional measurements outside their writer range are dropped', () => {
  for (const [field, value] of [
    ['judgeContextTokens', 0],
    ['judgeContextTokens', 1.5],
    ['contextWindow', 0],
    ['codexTokens', -1],
    ['lastActivityAt', 'not-a-date'],
    ['turnStartedAt', 5],
  ] as const) {
    const loaded = load((raw) => {
      raw[field] = value;
    });
    assert.equal(field in loaded, false, `${field} is absent`);
    assert.deepEqual(repairs(loaded), [field]);
  }
});

// ---- the rate-limit record --------------------------------------------------

test('a complete rate-limit record loads untouched, including above 100 percent', () => {
  const loaded = load((raw) => {
    raw['codexRateLimit'] = { ...RATE_LIMIT, usedPercent: 120 };
  });
  assert.equal(loaded.codexRateLimit?.usedPercent, 120);
  assert.deepEqual(repairs(loaded), []);
});

test('a percentage that is not a usable number drops the record', () => {
  for (const value of ['lots', -5, null]) {
    const loaded = load((raw) => {
      raw['codexRateLimit'] = { ...RATE_LIMIT, usedPercent: value };
    });
    assert.equal('codexRateLimit' in loaded, false);
    assert.deepEqual(repairs(loaded), ['codexRateLimit']);
  }
});

test('a junk duration or reset time is repaired in place, keeping the record', () => {
  const duration = load((raw) => {
    raw['codexRateLimit'] = { ...RATE_LIMIT, windowDurationMins: -5 };
  });
  assert.equal(duration.codexRateLimit?.usedPercent, 42);
  assert.equal(duration.codexRateLimit?.windowDurationMins, null);
  assert.deepEqual(repairs(duration), ['codexRateLimit.windowDurationMins']);

  const reset = load((raw) => {
    raw['codexRateLimit'] = { ...RATE_LIMIT, resetsAt: 'nope' };
  });
  assert.equal(reset.codexRateLimit?.usedPercent, 42);
  assert.equal(reset.codexRateLimit?.resetsAt, null);
  assert.deepEqual(repairs(reset), ['codexRateLimit.resetsAt']);
});

// ---- compounds --------------------------------------------------------------

test('a malformed plan becomes null; a plan with junk entries keeps its good ones', () => {
  const dropped = load((raw) => {
    raw['plan'] = { plan_md: 3 };
  });
  assert.equal(dropped.plan, null);
  assert.deepEqual(repairs(dropped), ['plan']);

  const filtered = load((raw) => {
    raw['plan'] = {
      plan_md: '# the plan',
      assumptions: [ASSUMPTION, null],
      open_questions: [QUESTION, { question: 7 }, { ...QUESTION, options: 'lazy' }],
      out_of_scope: [{ item: 'later', why: 'separate' }, 'x'],
    };
  });
  assert.equal(filtered.plan?.plan_md, '# the plan');
  assert.deepEqual(filtered.plan?.assumptions, [ASSUMPTION]);
  assert.equal(filtered.plan?.open_questions.length, 2);
  assert.deepEqual(filtered.plan?.open_questions[1]?.options, []);
  assert.equal(filtered.plan?.out_of_scope?.length, 1);
});

test('an absent out_of_scope stays absent, and an empty one stays empty', () => {
  const absent = load((raw) => {
    raw['plan'] = { plan_md: '# p', assumptions: [], open_questions: [] };
  });
  assert.equal('out_of_scope' in (absent.plan ?? {}), false);

  const empty = load((raw) => {
    raw['plan'] = { plan_md: '# p', assumptions: [], open_questions: [], out_of_scope: [] };
  });
  assert.deepEqual(empty.plan?.out_of_scope, []);
});

test('an agent whose descriptors are not real members is dropped, not renamed', () => {
  for (const bad of [
    { ...AGENT, provider: 'other' },
    { ...AGENT, shell: 'fish' },
    { ...AGENT, pathStyle: 'nt' },
    { ...AGENT, repaired: 'yes' },
    { ...AGENT, tools: 'x' },
  ]) {
    const loaded = load((raw) => {
      raw['environment'] = { ...ENVIRONMENT, agents: [AGENT, bad] };
    });
    // The field survives with its verified facts; only the bad agent goes.
    assert.equal(loaded.environment?.verifyCommand, 'npm test');
    assert.equal(loaded.environment?.verifyRuns, 3);
    assert.equal(loaded.environment?.agents.length, 1);
    assert.equal(loaded.environment?.agents[0]?.provider, 'claude');
    assert.deepEqual(repairs(loaded), ['environment']);
  }
});

test('a tool entry that is not a tool is dropped from its agent', () => {
  const loaded = load((raw) => {
    raw['environment'] = {
      ...ENVIRONMENT,
      agents: [{ ...AGENT, tools: [AGENT.tools[0], { name: 'node', available: true, version: 7 }] }],
    };
  });
  assert.equal(loaded.environment?.agents[0]?.tools.length, 1);
});

test('an environment container that is not one is dropped whole', () => {
  for (const value of ['x', { agents: 'x' }, { ...ENVIRONMENT, verifyRuns: 'three' }]) {
    const loaded = load((raw) => {
      raw['environment'] = value;
    });
    assert.equal('environment' in loaded, false);
    assert.deepEqual(repairs(loaded), ['environment']);
  }
});

test('pendingFindings keeps its findings and drops the rest', () => {
  const loaded = load((raw) => {
    raw['pendingFindings'] = { phase: 'review', findings: [FINDING, { id: 'junk' }] };
  });
  assert.equal(loaded.pendingFindings?.phase, 'review');
  assert.deepEqual(loaded.pendingFindings?.findings.map((f) => f.id), ['good-finding']);

  const dropped = load((raw) => {
    raw['pendingFindings'] = { phase: 'nonsense', findings: [] };
  });
  assert.equal('pendingFindings' in dropped, false);
});

// ---- what the validator must not touch --------------------------------------

test('config passes through untouched, however odd it looks', () => {
  const loaded = load((raw) => {
    raw['config'] = { claude: 'nonsense' };
  });
  assert.deepEqual(loaded.config, { claude: 'nonsense' } as unknown as RunState['config']);
  assert.deepEqual(repairs(loaded), []);
});

test('a key this version has never heard of survives the round trip', () => {
  const loaded = load((raw) => {
    raw['futureField'] = { added: 'by a later vibe' };
  });
  assert.deepEqual((loaded as unknown as Record<string, unknown>)['futureField'], {
    added: 'by a later vibe',
  });
  assert.deepEqual(repairs(loaded), []);
});

test('dir and targetDir are re-derived, and the stored ones are ignored', () => {
  const run = corrupt((raw) => {
    raw['dir'] = 'C:\\somewhere\\else';
    raw['targetDir'] = 'C:\\gone';
  });
  const loaded = loadRun(run.targetDir, run.id);
  assert.equal(loaded.targetDir, run.targetDir);
  assert.equal(loaded.dir, path.join(run.targetDir, RUNS, run.id));
  assert.deepEqual(repairs(loaded), []);
});

// ---- the registry cannot drift ----------------------------------------------

test('every field a fresh run writes is one the validator decides', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-stored-keys-'));
  const state = createRun(dir, 'key coverage', false);
  const missing = Object.keys(state).filter(
    (k) => !REDERIVED_KEYS.has(k) && !KNOWN_KEYS.has(k),
  );
  assert.deepEqual(missing, []);
  for (const key of REDERIVED_KEYS) assert.equal(KNOWN_KEYS.has(key), false);
});

// ---- real states from older versions ----------------------------------------

const FIXTURES = [
  'oldest-planning',
  'stalled-planning',
  'done-pendingfindings-null',
  'done-widest',
] as const;

/**
 * The four fixtures are real post-run states copied verbatim from runs this repo
 * made on itself - not constructed, and never edited to suit a test. If one of
 * them trips a predicate, the predicate is wrong.
 */
for (const name of FIXTURES) {
  test(`${name}.json loads unchanged, with no repairs`, () => {
    const file = fileURLToPath(new URL(`../../tests/fixtures/state/${name}.json`, import.meta.url));
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    const stored = raw as Record<string, unknown>;
    const id = String(stored['id']);

    const targetDir = mkdtempSync(path.join(tmpdir(), 'vibe-fixture-'));
    const dir = path.join(targetDir, RUNS, id);
    mkdirSync(dir, { recursive: true });
    copyFileSync(file, path.join(dir, 'state.json'));

    const loaded = loadRun(targetDir, id);
    assert.deepEqual(repairs(loaded), [], 'a real state file needs no repair');
    for (const [key, value] of Object.entries(stored)) {
      if (REDERIVED_KEYS.has(key)) continue;
      assert.deepEqual(
        (loaded as unknown as Record<string, unknown>)[key],
        value,
        `${key} survived the round trip`,
      );
    }
  });
}

test('every key the fixtures carry is one the registry knows', () => {
  for (const name of FIXTURES) {
    const file = fileURLToPath(new URL(`../../tests/fixtures/state/${name}.json`, import.meta.url));
    const stored = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const unknownKeys = Object.keys(stored).filter(
      (k) => !REDERIVED_KEYS.has(k) && !KNOWN_KEYS.has(k),
    );
    assert.deepEqual(unknownKeys, [], `${name} has no field the validator forgot`);
  }
});

// ---- the listing survives anything ------------------------------------------

test('vibe list shows every run, healthy or not, and invents no cost', () => {
  const targetDir = mkdtempSync(path.join(tmpdir(), 'vibe-list-'));
  const healthy = createRun(targetDir, 'healthy', true);

  const plant = (id: string, text: string): void => {
    const dir = path.join(targetDir, RUNS, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'state.json'), text, 'utf8');
  };
  const good = JSON.parse(readFileSync(path.join(healthy.dir, 'state.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  plant('bad-cost', JSON.stringify({ ...good, id: 'bad-cost', costUsd: -1 }));
  plant('new-status', JSON.stringify({ ...good, id: 'new-status', status: 'a-new-status' }));
  plant('wrong-id', JSON.stringify({ ...good, id: 'somebody-else' }));
  plant('null-root', 'null');
  plant('unparseable', '{');

  const before = new Map(
    ['bad-cost', 'new-status', 'wrong-id', 'null-root', 'unparseable'].map((id) => [
      id,
      readFileSync(path.join(targetDir, RUNS, id, 'state.json'), 'utf8'),
    ]),
  );

  const runs = listRuns(targetDir);
  assert.equal(runs.length, 6);

  const row = (id: string): (typeof runs)[number] => {
    const found = runs.find((r) => r.id === id);
    assert.ok(found, `${id} is listed`);
    return found;
  };
  assert.equal(row(healthy.id).task, 'healthy');
  assert.equal(row(healthy.id).costUsd, 0);
  // A cost that would refuse on resume must not print as money here either.
  assert.equal(row('bad-cost').costUsd, null);
  // Listing prints a status it does not recognise; only resume acts on it.
  assert.equal(row('new-status').status, 'a-new-status');
  // A mismatched id is an ordinary row: the listing is keyed by directory.
  assert.equal(row('wrong-id').status, good['status']);
  assert.equal(row('null-root').status, 'unreadable');
  assert.equal(row('null-root').costUsd, null);
  assert.equal(row('unparseable').status, 'unreadable');
  assert.equal(row('unparseable').costUsd, null);

  // The listing never writes.
  for (const [id, text] of before) {
    assert.equal(readFileSync(path.join(targetDir, RUNS, id, 'state.json'), 'utf8'), text);
  }
});
