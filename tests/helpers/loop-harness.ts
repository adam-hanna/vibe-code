import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ClaudeTurnOptions } from '@src/claude.js';
import { parseHumanAnswers } from '@src/cli.js';
import type { CodexTurnOptions } from '@src/codex.js';
import { DEFAULTS } from '@src/config.js';
import { Escalation, EXIT, orchestrate, writeEscalation } from '@src/orchestrator.js';
import type { AgentTurns } from '@src/orchestrator.js';
import { createRun, saveState } from '@src/run.js';
import type {
  Answer,
  ClaudeTurnResult,
  Config,
  Finding,
  LoopConfig,
  OpenQuestion,
  Plan,
  RunState,
  TokenUsage,
} from '@src/types.js';

/**
 * Everything needed to drive the whole loop - plan, critique, implement,
 * verify, review - without spawning a real `claude` or a real `codex`.
 *
 * `orchestrate(state, cfg, resume, turns)` has taken an `AgentTurns` seam since
 * #34, so the expensive, non-deterministic half of a run is already injectable.
 * What was missing was somewhere to keep the *other* half: the neutered config,
 * the temp-directory run state, the git repo, and a verification command a test
 * controls. Two files had built all four independently.
 *
 * Not all of it was unreachable before. `pending-findings.test.ts` already drove
 * a real marker-file `verify.command` in two of its cases, so a *passing* gate
 * and a gate that fails once were covered. What no test could reach was the
 * verification failure feeding the fix loop and its own round cap, the
 * unlaunchable-command escalation, the carried-P1 final round, the per-round
 * commits, and the question/escalation/resume path - because the shared config
 * builder in both files switched `verify`, `context` and `git.commitEachRound`
 * off and only individual cases opted back in.
 *
 * Git and verification are deliberately real. The turn seam covers the part
 * that costs money and cannot be relied on to repeat; a temp directory and a
 * one-line `.mjs` script are neither, and faking them would thread a new
 * parameter through every call site in `src/orchestrator.ts` only to end up
 * asserting against the fake.
 *
 * Nothing here cleans up its temp directory. That matches every existing test
 * in this suite, and `rmSync` over a directory a child process has just touched
 * is a Windows flake source in a suite that has to pass three times running.
 */

// ---- fixtures --------------------------------------------------------------

export function tokens(total: number): TokenUsage {
  return { input: total, output: 0, cacheRead: 0, cacheCreation: 0, total };
}

export function planFixture(over: Partial<Plan> = {}): Plan {
  return {
    plan_md: '# the plan\n\nDo the thing.',
    assumptions: [],
    open_questions: [],
    out_of_scope: [],
    // Both strict fields carry an explicit empty claim: this fixture is fed
    // back through `parsePlan` by every case that drives the loop, and that
    // parser refuses a plan missing either.
    acceptance_criteria: [],
    ...over,
  };
}

export function p1(id: string): Finding {
  return {
    id,
    severity: 'P1',
    title: `Finding ${id}`,
    detail: 'Detail.',
    suggested_fix: 'Fix it.',
  };
}

/** A finding of any severity, for a case that is not about blocking. */
export function findingFixture(over: Partial<Finding> = {}): Finding {
  return {
    id: 'some-finding',
    severity: 'P2',
    title: 'Some finding',
    detail: 'Detail.',
    suggested_fix: 'Fix it.',
    ...over,
  };
}

/** What the critic or the reviewer returns. Two P1s beat the default tolerance of one. */
export function report(findings: readonly Finding[]): object {
  return {
    verdict: findings.length > 0 ? 'REVISE' : 'APPROVE',
    summary: 'summary',
    findings: [...findings],
  };
}

export const BLOCKING = [p1('finding-one'), p1('finding-two')];

/** A blocking open question, which is what sends the plan loop to the answerer. */
export function questionFixture(over: Partial<OpenQuestion> = {}): OpenQuestion {
  return {
    question: 'Should the widget be lazy or eager?',
    options: ['lazy', 'eager'],
    recommended: 'lazy',
    kind: 'product',
    blocking: true,
    ...over,
  };
}

/**
 * What the answerer turn returns, in the shape `parseAnswers` requires.
 *
 * The `report([])` a codex handler falls back to has no `answers` key at all,
 * so it throws in `parseAnswers` - which is one reason nothing had driven the
 * question path end to end.
 */
export function answersReport(answers: readonly Partial<Answer>[]): object {
  return {
    answers: answers.map((a) => ({
      question: a.question ?? questionFixture().question,
      answer: a.answer ?? 'Lazy.',
      confidence: a.confidence ?? 'high',
      defer_to_human: a.defer_to_human ?? false,
      rationale: a.rationale ?? 'Because.',
    })),
  };
}

// ---- the agents ------------------------------------------------------------

export interface Handlers {
  /**
   * Claude's turn: an object is returned as JSON, a string as raw text. The
   * options are handed over too, for a case asserting on the prompt rather than
   * on the order.
   */
  claude?: (label: string, options: ClaudeTurnOptions) => unknown;
  /** Codex's turn: the structured report. */
  codex?: (label: string, options: CodexTurnOptions) => unknown;
  /**
   * The thread id this Codex turn ran on. Defaults to `'thread-1'` for every
   * turn, which is what the fake returned before there was more than one Codex
   * conversation to name.
   *
   * Since #45 the plan-side judge and the reviewer hold separate threads, and a
   * fake that names them both `thread-1` cannot show the difference between two
   * conversations and one: every resume id would match whichever slot was asked.
   * Returning a different id per family is what makes "the reviewer was never
   * handed the critique's id" an assertion rather than a coincidence.
   */
  codexSessionId?: (label: string, options: CodexTurnOptions) => string | null;
}

/**
 * Both providers, recording the label of every turn in order.
 *
 * The order *is* the assertion in most cases: a resumed loop that revises
 * before it critiques is the fix, and one that critiques first is the defect.
 * Claude's label comes from `options.progress?.label`, which is why `config`
 * below leaves progress enabled; Codex's is its `schemaName`.
 *
 * A handler that throws surfaces as a rejected turn, so `() => assert.fail(...)`
 * is a usable way to say "this provider must not be reached again".
 */
export function agents(handlers: Handlers, calls: string[]): AgentTurns {
  return {
    claude: (options): Promise<ClaudeTurnResult> => {
      const label = options.progress?.label ?? '(unlabelled)';
      calls.push(label);
      const produced = handlers.claude?.(label, options) ?? 'claude said so';
      return Promise.resolve({
        text: typeof produced === 'string' ? produced : JSON.stringify(produced),
        costUsd: 0.01,
        sessionId: options.sessionId,
        denials: [],
        numTurns: 1,
        usage: null,
        tokens: tokens(1000),
      });
    },
    codex: (options) => {
      calls.push(options.schemaName);
      const structured = handlers.codex?.(options.schemaName, options) ?? report([]);
      return Promise.resolve({
        structured,
        raw: JSON.stringify(structured),
        // Not `?? 'thread-1'`: a handler that returns null is saying this turn
        // named no thread, which is a different fact from having no handler.
        sessionId:
          handlers.codexSessionId === undefined
            ? 'thread-1'
            : handlers.codexSessionId(options.schemaName, options),
        tokens: tokens(500),
      });
    },
  };
}

/** A judge that fails the case if it is asked twice. */
export function onceThenApprove(calledTwice: () => never): (label: string) => unknown {
  let calls = 0;
  return () => {
    calls += 1;
    if (calls > 1) calledTwice();
    return report([]);
  };
}

// ---- the run state ---------------------------------------------------------

export interface RunOptions {
  /** mkdtemp prefix, so a leaked directory says which suite left it. */
  prefix?: string;
  task?: string;
  /**
   * Defaults to true, which is what both migrated files create. `runPhases`
   * returns straight after the plan phase on a plan-only run, so a case that
   * needs implementation or review must pass false.
   */
  planOnly?: boolean;
  /** `git init` in the target directory. */
  git?: boolean;
  /** Also make a base commit, so `markBase` has a sha to return. */
  commit?: boolean;
}

/**
 * A git repo the loop can be pointed at.
 *
 * The identity is set locally rather than left to the machine's global config:
 * `commitAll` warns and returns null when `git commit` fails, so a missing
 * `user.email` would make a commit assertion read as "the loop did not commit"
 * instead of "the fixture is broken".
 */
export function initGit(targetDir: string, options: { commit?: boolean } = {}): void {
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: targetDir, stdio: 'ignore' });
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'vibe@example.invalid');
  git('config', 'user.name', 'vibe tests');
  git('config', 'commit.gpgsign', 'false');
  if (options.commit === true) {
    writeFileSync(path.join(targetDir, 'README.md'), '# base\n', 'utf8');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
  }
}

export function freshRun(options: RunOptions = {}): RunState {
  const dir = mkdtempSync(path.join(tmpdir(), options.prefix ?? 'vibe-loop-'));
  if (options.git === true) initGit(dir, { commit: options.commit === true });
  return createRun(dir, options.task ?? 'loop harness', options.planOnly ?? true);
}

/** A run parked at the review phase, in a repo `git diff` can be asked about. */
export function reviewingRun(options: RunOptions = {}): RunState {
  const state = freshRun({ ...options, git: options.git ?? true, planOnly: options.planOnly ?? false });
  state.plan = planFixture();
  state.phase = 'reviewing';
  state.baseSha = null;
  return state;
}

// ---- the target tree -------------------------------------------------------

/**
 * Write a file into the target tree, so the round that follows has something to
 * commit.
 *
 * `commitAll` asks what is *staged*, so a fake turn that changes nothing makes
 * every commit a no-op and every commit assertion vacuous. Give each round its
 * own file name: rewriting the same bytes is also nothing to commit.
 */
export function work(state: RunState, name = 'work.txt', body?: string): string {
  const file = path.join(state.targetDir, name);
  writeFileSync(file, body ?? `${name}\n`, 'utf8');
  return file;
}

/** `git log --format=%s`, newest first. Empty in a repo with no commits. */
export function commits(state: RunState): string[] {
  try {
    return execFileSync('git', ['log', '--format=%s'], { cwd: state.targetDir, encoding: 'utf8' })
      .split(/\r?\n/)
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** What HEAD names, or null outside a repo. */
export function branchOf(state: RunState): string | null {
  try {
    return (
      execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: state.targetDir,
        encoding: 'utf8',
      }).trim() || null
    );
  } catch {
    return null;
  }
}

/** The files a commit touched, so a case can prove `.vibe` stayed out of it. */
export function committedFiles(state: RunState, rev = 'HEAD'): string[] {
  return execFileSync('git', ['show', '--format=', '--name-only', rev], {
    cwd: state.targetDir,
    encoding: 'utf8',
  })
    .split(/\r?\n/)
    .filter(Boolean);
}

// ---- the config ------------------------------------------------------------

/**
 * `DEFAULTS`, with everything that would reach the network or a real child
 * process switched off.
 *
 * Progress is *enabled*, unlike the other seam tests: `ProgressOptions` is the
 * only place a turn's label reaches a provider on the Claude side, and the
 * recorded order is what most cases assert on. Nothing in the progress
 * machinery runs - it lives inside the real adapters, which the injected turns
 * replace.
 *
 * Note that `verify.enabled` and `git.commitEachRound` are both true in
 * production and false here. `verifying()` and `committing()` put them back for
 * the cases that are about them.
 */
export function config(loop: Partial<LoopConfig> = {}, over: Partial<Config> = {}): Config {
  return {
    ...DEFAULTS,
    codex: { ...DEFAULTS.codex, readRateLimits: false },
    context: { ...DEFAULTS.context, enabled: false },
    progress: { ...DEFAULTS.progress, enabled: true, intervalMs: 60_000 },
    verify: { ...DEFAULTS.verify, enabled: false },
    git: { ...DEFAULTS.git, commitEachRound: false },
    // The plan-budget guard is not what these cases are about; the round cap is.
    budget: { ...DEFAULTS.budget, planShare: 0 },
    loop: { ...DEFAULTS.loop, ...loop },
    ...over,
  };
}

/** Commit per round, as a real run does. */
export function committing(): Partial<Config> {
  return { git: { ...DEFAULTS.git, commitEachRound: true } };
}

const VERIFY_SCRIPT = 'vibe-verify.mjs';
const VERIFY_LOG = 'vibe-verify-runs.txt';

/**
 * A verification command the test controls.
 *
 * It records every execution and fails the ones the case names, so a case can
 * watch the gate fail, be fixed and pass again without stubbing anything - and
 * can see *where in the loop* the gate sits, which is the thing an interface
 * for verification would have hidden. `failures: n` fails the first n runs;
 * `failRuns` names them individually, for the case that needs a gate which
 * passes before a fix round and fails after it. `runs: 1` by default:
 * `DEFAULTS.verify.runs` is 3, which would triple every count below.
 */
export function verifying(
  state: RunState,
  options: { failures?: number; failRuns?: readonly number[]; runs?: number } = {},
): Partial<Config> {
  const failing =
    options.failRuns ?? Array.from({ length: options.failures ?? 0 }, (_unused, i) => i + 1);
  writeFileSync(
    path.join(state.targetDir, VERIFY_SCRIPT),
    "import { appendFileSync, readFileSync } from 'node:fs';\n" +
      `const log = ${JSON.stringify(VERIFY_LOG)};\n` +
      "appendFileSync(log, 'ran\\n');\n" +
      "const runs = readFileSync(log, 'utf8').split('\\n').filter(Boolean).length;\n" +
      `process.exit(${JSON.stringify([...failing])}.includes(runs) ? 1 : 0);\n`,
    'utf8',
  );
  return {
    verify: {
      ...DEFAULTS.verify,
      enabled: true,
      // Relative, and no spaces: src/verify.ts shells out through
      // `cmd.exe /d /c` with verbatim arguments on Windows.
      command: `node ${VERIFY_SCRIPT}`,
      runs: options.runs ?? 1,
      timeoutMs: 30_000,
    },
  };
}

/** How many times the command `verifying` wrote has run. */
export function verifyRuns(state: RunState): number {
  const log = path.join(state.targetDir, VERIFY_LOG);
  if (!existsSync(log)) return 0;
  return readFileSync(log, 'utf8').split('\n').filter(Boolean).length;
}

/**
 * A verification command that cannot start at all.
 *
 * A name no shell can resolve, rather than a missing script: `cmd.exe` exits
 * 9009 and `/bin/sh` exits 127, and `launchFailure` recognises both on the exit
 * code alone - no dependence on how an interpreter words its own error.
 */
export function unlaunchableVerify(): Partial<Config> {
  return {
    verify: {
      ...DEFAULTS.verify,
      enabled: true,
      command: 'vibe-definitely-not-a-command',
      runs: 1,
      timeoutMs: 30_000,
    },
  };
}

// ---- stopping and resuming -------------------------------------------------

/** What cli.ts does with an `Escalation`: the human-facing handoff. */
export function escalationFile(state: RunState, err: Escalation): string {
  return writeEscalation(state, err);
}

/**
 * What `vibe resume` does with a filled-in NEEDS-INPUT.md.
 *
 * Mirrors src/cli.ts:413-439 rather than calling it: `cmdResume` is not
 * exported and reaches `execute`, which runs the real preflight and spawns. So
 * this fills every "**Your answer:**" blockquote, parses the file through the
 * exported `parseHumanAnswers`, hangs the answers on the state and retires the
 * file so they cannot be replayed - and the CLI glue around those steps stays
 * uncovered, deliberately.
 */
export function answerNeedsInput(
  state: RunState,
  answer: (question: string) => string,
): Answer[] {
  const file = path.join(state.dir, 'NEEDS-INPUT.md');
  const raw = readFileSync(file, 'utf8');

  // The template is "**Your answer:**\n\n> \n" - an empty blockquote line, so
  // an untouched file is distinguishable from a real answer.
  let index = 0;
  const questions = [...raw.matchAll(/^### \d+\. (.*)$/gm)].map((m) => m[1] ?? '');
  const filled = raw.replace(/\*\*Your answer:\*\*\n\n> /g, () => {
    const question = questions[index] ?? '';
    index += 1;
    // Every line carries its own "> ". `parseHumanAnswers` reads blockquote
    // lines, so a multiline answer written under a single marker keeps its
    // first line and silently loses the rest - and a case asserting on a
    // multi-sentence answer would be asserting on a truncation.
    const quoted = answer(question).split('\n').join('\n> ');
    return `**Your answer:**\n\n> ${quoted}`;
  });
  writeFileSync(file, filled, 'utf8');

  const answers = parseHumanAnswers(filled);
  // `cmdResume` refuses at src/cli.ts:428 - it returns EXIT.NEEDS_HUMAN before
  // touching the state or retiring the file, so an unanswered escalation stays
  // answerable. Mirroring that matters more here than it looks: a harness that
  // saved and renamed anyway would let a case resume against no answers at all
  // and still read as though it had exercised the path.
  if (answers.length === 0) {
    throw new Error(
      'answerNeedsInput parsed no answers - NEEDS-INPUT.md is left in place, as cmdResume leaves it',
    );
  }
  state.pendingAnswers = answers;
  saveState(state);
  renameSync(file, path.join(state.dir, `answered-${state.planRound}.md`));
  return answers;
}

// ---- known stalls ----------------------------------------------------------

/**
 * A plan run stopped at the round cap with two P1s outstanding.
 *
 * The cap is the cheapest deterministic stall: `guardProgress` records its
 * `RoundRecord` and *then* throws, which is the exact shape of the defect the
 * carried findings exist to answer.
 */
export async function stalledPlan(): Promise<{ state: RunState; calls: string[] }> {
  const state = freshRun({ prefix: 'vibe-pending-', task: 'pending findings' });
  state.plan = planFixture();
  const calls: string[] = [];
  const turns = agents({ codex: () => report(BLOCKING) }, calls);

  await rejectsNoConvergence(() => orchestrate(state, config({ maxPlanRounds: 1 }), true, turns));
  return { state, calls };
}

/** A review run stopped at the round cap with two P1s outstanding. */
export async function stalledReview(): Promise<{ state: RunState; calls: string[] }> {
  const state = reviewingRun({ prefix: 'vibe-pending-', task: 'pending findings' });
  const calls: string[] = [];
  const turns = agents({ codex: () => report(BLOCKING) }, calls);

  await rejectsNoConvergence(() => orchestrate(state, config({ maxReviewRounds: 1 }), true, turns));
  return { state, calls };
}

/**
 * The stall drivers assert their own stop, so a harness that stopped for some
 * other reason cannot quietly hand back a state the case then misreads.
 * Written without `node:assert` so this file stays a fixture rather than a
 * suite.
 */
async function rejectsNoConvergence(work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch (err) {
    if (err instanceof Escalation && err.code === EXIT.NO_CONVERGENCE) return;
    throw err;
  }
  throw new Error('expected the loop to stop at the round cap, and it did not');
}
