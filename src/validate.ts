import type {
  Answer,
  AnswersReport,
  Assumption,
  Confidence,
  Finding,
  FindingsReport,
  OpenQuestion,
  Plan,
  QuestionKind,
  Severity,
  Verdict,
} from '@src/types.js';

/**
 * Model output crosses a trust boundary. A schema is attached to every call, but
 * schema enforcement lives in the provider — these guards make the shape a fact
 * on our side of the wire rather than an assumption, and fail loudly with the
 * offending payload when it is not.
 */

export class ShapeError extends Error {
  constructor(message: string, readonly payload: unknown) {
    super(message);
    this.name = 'ShapeError';
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function fail(path: string, expected: string, payload: unknown): never {
  throw new ShapeError(`${path}: expected ${expected}`, payload);
}

function str(obj: Record<string, unknown>, key: string, path: string, payload: unknown): string {
  const v = obj[key];
  if (typeof v !== 'string') fail(`${path}.${key}`, 'string', payload);
  return v;
}

function bool(obj: Record<string, unknown>, key: string, path: string, payload: unknown): boolean {
  const v = obj[key];
  if (typeof v !== 'boolean') fail(`${path}.${key}`, 'boolean', payload);
  return v;
}

function arr(obj: Record<string, unknown>, key: string, path: string, payload: unknown): unknown[] {
  const v = obj[key];
  if (!Array.isArray(v)) fail(`${path}.${key}`, 'array', payload);
  return v;
}

function oneOf<T extends string>(
  obj: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  path: string,
  payload: unknown,
): T {
  const v = obj[key];
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    fail(`${path}.${key}`, `one of ${allowed.join(' | ')}`, payload);
  }
  return v as T;
}

function record(v: unknown, path: string, payload: unknown): Record<string, unknown> {
  if (!isRecord(v)) fail(path, 'object', payload);
  return v;
}

/** Optional string array — tolerated as absent because it carries no decision weight. */
function stringList(obj: Record<string, unknown>, key: string): string[] {
  const v = obj[key];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

const SEVERITIES: readonly Severity[] = ['P1', 'P2', 'P3'];
const VERDICTS: readonly Verdict[] = ['APPROVE', 'REVISE'];
const KINDS: readonly QuestionKind[] = ['technical', 'product'];
const CONFIDENCES: readonly Confidence[] = ['high', 'medium', 'low'];

export function parsePlan(raw: unknown): Plan {
  const o = record(raw, 'plan', raw);
  const assumptions: Assumption[] = arr(o, 'assumptions', 'plan', raw).map((a, i) => {
    const r = record(a, `plan.assumptions[${i}]`, raw);
    return {
      assumption: str(r, 'assumption', `plan.assumptions[${i}]`, raw),
      why: str(r, 'why', `plan.assumptions[${i}]`, raw),
      blast_radius: str(r, 'blast_radius', `plan.assumptions[${i}]`, raw),
    };
  });

  const openQuestions: OpenQuestion[] = arr(o, 'open_questions', 'plan', raw).map((q, i) => {
    const r = record(q, `plan.open_questions[${i}]`, raw);
    return {
      question: str(r, 'question', `plan.open_questions[${i}]`, raw),
      options: stringList(r, 'options'),
      recommended: str(r, 'recommended', `plan.open_questions[${i}]`, raw),
      kind: oneOf(r, 'kind', KINDS, `plan.open_questions[${i}]`, raw),
      blocking: bool(r, 'blocking', `plan.open_questions[${i}]`, raw),
    };
  });

  return {
    plan_md: str(o, 'plan_md', 'plan', raw),
    assumptions,
    open_questions: openQuestions,
  };
}

export function parseFindings(raw: unknown): FindingsReport {
  const o = record(raw, 'report', raw);
  const findings: Finding[] = arr(o, 'findings', 'report', raw).map((f, i) => {
    const r = record(f, `report.findings[${i}]`, raw);
    const severity = oneOf(r, 'severity', SEVERITIES, `report.findings[${i}]`, raw);
    const title = str(r, 'title', `report.findings[${i}]`, raw);
    // An id is the oscillation guard's primary key; derive a stable one rather
    // than dropping a finding that omitted it.
    const rawId = r['id'];
    const id = typeof rawId === 'string' && rawId.trim() ? rawId.trim() : slug(title);
    return {
      id,
      severity,
      title,
      detail: str(r, 'detail', `report.findings[${i}]`, raw),
      suggested_fix: str(r, 'suggested_fix', `report.findings[${i}]`, raw),
    };
  });

  const summaryRaw = o['summary'];
  return {
    verdict: oneOf(o, 'verdict', VERDICTS, 'report', raw),
    summary: typeof summaryRaw === 'string' ? summaryRaw : '',
    findings,
  };
}

export function parseAnswers(raw: unknown): AnswersReport {
  const o = record(raw, 'answers', raw);
  const answers: Answer[] = arr(o, 'answers', 'answers', raw).map((a, i) => {
    const r = record(a, `answers.answers[${i}]`, raw);
    const rationale = r['rationale'];
    return {
      question: str(r, 'question', `answers.answers[${i}]`, raw),
      answer: str(r, 'answer', `answers.answers[${i}]`, raw),
      confidence: oneOf(r, 'confidence', CONFIDENCES, `answers.answers[${i}]`, raw),
      defer_to_human: bool(r, 'defer_to_human', `answers.answers[${i}]`, raw),
      rationale: typeof rationale === 'string' ? rationale : '',
    };
  });
  return { answers };
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'unnamed-finding'
  );
}

export const p1s = (findings: readonly Finding[]): Finding[] =>
  findings.filter((f) => f.severity === 'P1');
