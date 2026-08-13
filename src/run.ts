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
    p1History: [],
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
 * Fingerprint of a P1 set. If consecutive rounds produce the same fingerprint,
 * the reviewer and the implementer are deadlocked - asking again will not break
 * the tie, so the run escalates rather than burning its budget.
 */
export function p1Signature(findings: readonly Finding[]): string | null {
  const ids = findings
    .filter((f) => f.severity === 'P1')
    .map((f) => f.id)
    .sort();
  if (ids.length === 0) return null;
  return createHash('sha1').update(ids.join('|')).digest('hex').slice(0, 12);
}

export function detectOscillation(
  state: RunState,
  signature: string | null,
  threshold: number,
): boolean {
  if (!signature) return false;
  state.p1History.push(signature);
  const recent = state.p1History.slice(-threshold);
  return recent.length === threshold && recent.every((s) => s === signature);
}
