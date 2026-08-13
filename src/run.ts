import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import type { Finding, RunState, RunSummary } from '@src/types.js';

const RUNS_DIR = path.join('.vibe', 'runs');

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'run'
  );
}

function stamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function createRun(targetDir: string, task: string, planOnly: boolean): RunState {
  const id = `${stamp()}-${slugify(task)}`;
  const dir = path.join(targetDir, RUNS_DIR, id);
  mkdirSync(dir, { recursive: true });

  const state: RunState = {
    id,
    dir,
    targetDir,
    task,
    sessionId: randomUUID(),
    createdAt: new Date().toISOString(),
    status: 'planning',
    planRound: 0,
    reviewRound: 0,
    costUsd: 0,
    tokensUsed: 0,
    rateLimitWaits: 0,
    baseSha: null,
    branch: null,
    p1Rounds: [],
    events: [],
    sessionStarted: false,
    planOnly,
    answeredQuestions: [],
    deferredQuestions: [],
    sessionRotations: 0,
    codexSessionId: null,
    handoff: null,
    contextRatio: 0,
    plan: null,
    pendingAnswers: null,
    extraContext: null,
  };
  saveState(state);
  return state;
}

export function loadRun(targetDir: string, id: string): RunState {
  const dir = path.join(targetDir, RUNS_DIR, id);
  const file = path.join(dir, 'state.json');
  if (!existsSync(file)) throw new Error(`No run "${id}" under ${RUNS_DIR}`);

  const parsed = JSON.parse(readFileSync(file, 'utf8')) as RunState;
  // Paths are re-derived so a run directory stays valid if the repo moves.
  return { ...parsed, dir, targetDir };
}

export function listRuns(targetDir: string): RunSummary[] {
  const root = path.join(targetDir, RUNS_DIR);
  if (!existsSync(root)) return [];

  return readdirSync(root)
    .filter((d) => existsSync(path.join(root, d, 'state.json')))
    .sort()
    .reverse()
    .map((d): RunSummary => {
      try {
        const s = JSON.parse(readFileSync(path.join(root, d, 'state.json'), 'utf8')) as Partial<RunState>;
        return {
          id: d,
          status: s.status ?? 'unknown',
          task: s.task ?? '',
          costUsd: typeof s.costUsd === 'number' ? s.costUsd : 0,
        };
      } catch {
        return { id: d, status: 'unreadable', task: '', costUsd: 0 };
      }
    });
}

export function saveState(state: RunState): void {
  writeFileSync(path.join(state.dir, 'state.json'), JSON.stringify(state, null, 2), 'utf8');
}

export function recordEvent(state: RunState, type: string, data: Record<string, unknown> = {}): void {
  state.events.push({ at: new Date().toISOString(), type, ...data });
  saveState(state);
}

export function artifact(state: RunState, name: string, content: string | object): string {
  const file = path.join(state.dir, name);
  const body = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  writeFileSync(file, body, 'utf8');
  return file;
}

export function artifactDir(state: RunState, name: string): string {
  const dir = path.join(state.dir, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Fingerprint of a P1 set, used to tell a repeated round from a new one.
 *
 * A repeat is evidence but not a verdict on its own - see `assessConvergence`,
 * which tolerates repetition early and judges the trend late.
 */
export function p1Signature(findings: readonly Finding[]): string | null {
  const ids = findings
    .filter((f) => f.severity === 'P1')
    .map((f) => f.id)
    .sort();
  if (ids.length === 0) return null;
  return createHash('sha1').update(ids.join('|')).digest('hex').slice(0, 12);
}

/**
 * Rounds only count as late once this much of the cap is spent.
 *
 * Before that the loop is left alone: a review cycle churning early is normal,
 * and two models trading revisions is how it converges. The question worth
 * asking near the cap is different - not "did this round repeat?" but "is this
 * heading anywhere?"
 *
 * Set from replaying round sequences: at 0.6 a five-round cap treats round
 * three as late, and a run that went 2 -> 2 -> 2 -> 1 was cut off one round
 * before it converged. Three quarters leaves room for early churn while still
 * reclaiming the rounds at the end that a stalled run would waste.
 */
const LATE_ROUND_FRACTION = 0.75;

export function recordRound(state: RunState, signature: string | null, count: number): void {
  state.p1Rounds.push({ signature, count });
}

export interface ConvergenceArgs {
  /** Identical P1 set this many rounds running is a hard stop at any point. */
  repeatThreshold: number;
  /** How many recent rounds the trend is judged over. */
  window: number;
  cap: number;
  round: number;
}

/**
 * Decide whether to stop, returning the reason or null to continue.
 *
 * Deliberately tolerant early and strict late. Some oscillation is a healthy
 * part of review - the reviewer raises something, the fix shifts the problem,
 * the next round catches the shift - and aborting on the first repeat throws
 * away runs that would have converged. What matters is whether the trend is
 * downward by the time the budget is nearly spent.
 */
export function assessConvergence(state: RunState, args: ConvergenceArgs): string | null {
  const { repeatThreshold, window, cap, round } = args;
  const history = state.p1Rounds;

  // Identical findings N rounds running means no new information is being
  // produced at all. More rounds cannot help, whenever it happens.
  const repeats = history.slice(-repeatThreshold);
  const first = repeats[0];
  if (
    repeats.length === repeatThreshold &&
    first?.signature != null &&
    repeats.every((r) => r.signature === first.signature)
  ) {
    return `the same P1 set came back ${repeatThreshold} rounds running`;
  }

  if (round < Math.ceil(cap * LATE_ROUND_FRACTION)) return null;

  // Late phase: require evidence of progress. Findings may be new every round
  // and still be going nowhere - a run that went 1 -> 1 -> 3 was producing
  // correct, distinct findings while getting further from done, and spent its
  // remaining rounds doing it.
  const recent = history.slice(-window);
  if (recent.length < window) return null;
  const improved = recent.some((r, idx) => idx > 0 && r.count < (recent[idx - 1]?.count ?? r.count));
  if (!improved) {
    const trail = recent.map((r) => r.count).join(' -> ');
    return `the P1 count has not fallen in ${window} rounds (${trail}) with ${cap - round} round(s) left`;
  }

  return null;
}
