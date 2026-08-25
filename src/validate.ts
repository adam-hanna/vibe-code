import type {
  AcceptanceCriterion,
  Answer,
  AnswersReport,
  Assumption,
  CheckKind,
  Confidence,
  Evidence,
  EvidenceKind,
  Finding,
  FindingsReport,
  OpenQuestion,
  OutOfScopeItem,
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

const EVIDENCE_KINDS: readonly EvidenceKind[] = ['code', 'artifact', 'absence', 'external'];

/**
 * One citation, or null when the entry is not one.
 *
 * The codebase's single answer to "is this stored object a citation", the way
 * `hasFindingShape` is its single answer to "is this stored object a finding" -
 * and for the same reason. `evidence` is never validated on the way into
 * state.json (deliberately: a bad citation must not delete a finding from
 * FOLLOW-UPS.md), so every consumer meets raw `unknown` and each one has to ask
 * this question. Asking it in two places is how they come to disagree.
 *
 * What each consumer *does* with a null is its own business: `parseFindings`
 * and the prompt renderers drop it, `groundFindings` counts it as a citation
 * that did not resolve.
 *
 * Every optional field is written with a conditional spread rather than a
 * possibly-`undefined` value, because `exactOptionalPropertyTypes` makes those
 * different types - and because an explicit `path: undefined` would serialise
 * into state.json as a key that was never cited.
 */
export function readEvidenceEntry(raw: unknown): Evidence | null {
  if (!isRecord(raw)) return null;
  const kind = raw['kind'];
  if (typeof kind !== 'string' || !(EVIDENCE_KINDS as readonly string[]).includes(kind)) {
    return null;
  }
  const path = raw['path'];
  const line = raw['line'];
  const excerpt = raw['excerpt'];
  const ref = raw['ref'];
  return {
    kind: kind as EvidenceKind,
    ...(typeof path === 'string' ? { path } : {}),
    ...(typeof line === 'number' && Number.isInteger(line) ? { line } : {}),
    ...(typeof excerpt === 'string' ? { excerpt } : {}),
    ...(typeof ref === 'string' ? { ref } : {}),
  };
}

/**
 * Every usable citation in a value that claims to be a list of them.
 *
 * Tolerant like `defer` and for a sharper reason: the schema marks `evidence`
 * required, and this parser cannot afford to. Throwing would destroy a whole
 * round's output - 3M tokens on the #47 review - because one finding in ten
 * omitted a field. A non-array reads as none, a malformed entry is dropped, and
 * `groundFindings` then treats "cited nothing" and "cited something that does
 * not resolve" as the same case: the finding is downgraded, never deleted (#48).
 */
export function readEvidence(raw: unknown): Evidence[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry): Evidence | null => readEvidenceEntry(entry))
    .filter((e): e is Evidence => e !== null);
}

const SEVERITIES: readonly Severity[] = ['P0', 'P1', 'P2', 'P3'];
const VERDICTS: readonly Verdict[] = ['APPROVE', 'REVISE'];
const KINDS: readonly QuestionKind[] = ['technical', 'product'];
const CONFIDENCES: readonly Confidence[] = ['high', 'medium', 'low'];
const CHECKS: readonly CheckKind[] = ['command', 'inspection', 'qa'];

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

  // Strict, unlike the tolerant reads elsewhere in this file: this parser only
  // ever sees fresh model output, and the whole point of the field is that the
  // planner draws a boundary *before* the critic tests one. A plan that omitted
  // it would be a plan defending a boundary it never stated.
  const outOfScope: OutOfScopeItem[] = arr(o, 'out_of_scope', 'plan', raw).map((s, i) => {
    const r = record(s, `plan.out_of_scope[${i}]`, raw);
    return {
      item: str(r, 'item', `plan.out_of_scope[${i}]`, raw),
      why: str(r, 'why', `plan.out_of_scope[${i}]`, raw),
    };
  });

  // Strict for the same reason, and it is the same argument one field along: a
  // plan that omitted this would be a plan with no definition of done, and the
  // critic would have nothing to attack but the approach. Tolerance belongs in
  // `readPlan`, which is the reader that meets state written before this field
  // existed.
  const acceptanceCriteria: AcceptanceCriterion[] = arr(
    o,
    'acceptance_criteria',
    'plan',
    raw,
  ).map((c, i) => {
    const r = record(c, `plan.acceptance_criteria[${i}]`, raw);
    return {
      id: str(r, 'id', `plan.acceptance_criteria[${i}]`, raw),
      criterion: str(r, 'criterion', `plan.acceptance_criteria[${i}]`, raw),
      check: oneOf(r, 'check', CHECKS, `plan.acceptance_criteria[${i}]`, raw),
      how: str(r, 'how', `plan.acceptance_criteria[${i}]`, raw),
    };
  });

  return {
    plan_md: str(o, 'plan_md', 'plan', raw),
    assumptions,
    open_questions: openQuestions,
    out_of_scope: outOfScope,
    acceptance_criteria: acceptanceCriteria,
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
    // Tolerant on read, for two different reasons. A report stored before this
    // field existed carries none, and must still parse. And a blocking finding
    // can never be a follow-up whatever the model claimed, so `defer` on a
    // P0/P1 is dropped here - the schema states the constraint, this makes it
    // true on our side of the wire. Both defaults only ever make a finding more
    // blocking, and `gate` reads severity alone, so no control flow changes.
    const defer = r['defer'] === true && severity !== 'P0' && severity !== 'P1';
    // Absent rather than `[]` when nothing usable came back: "cited nothing" is
    // what actually happened, and an empty list would assert the model offered
    // a list. Both read the same downstream - `groundFindings` downgrades a
    // blocker either way - but only one of them is true.
    const evidence = readEvidence(r['evidence']);
    return {
      id,
      severity,
      title,
      detail: str(r, 'detail', `report.findings[${i}]`, raw),
      suggested_fix: str(r, 'suggested_fix', `report.findings[${i}]`, raw),
      defer,
      ...(evidence.length > 0 ? { evidence } : {}),
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

export const p0s = (findings: readonly Finding[]): Finding[] =>
  findings.filter((f) => f.severity === 'P0');

/**
 * Everything that could stop the loop, worst first.
 *
 * Used for the round fingerprint and the round-by-round count, so a run that
 * trades a P1 for a P0 is not recorded as having stayed still.
 */
export const blockers = (findings: readonly Finding[]): Finding[] =>
  findings.filter((f) => f.severity === 'P0' || f.severity === 'P1');

export interface Gate {
  /** True when the loop may move on. */
  pass: boolean;
  p0: Finding[];
  p1: Finding[];
  /** P1s being carried forward, which the next phase is told about. */
  tolerated: Finding[];
  /** Why the loop stopped, or null when it may proceed. */
  reason: string | null;
}

/**
 * Decide whether a set of findings lets the loop move forward.
 *
 * Any P0 blocks. Beyond that, up to `tolerance` P1s are carried rather than
 * fixed: a finding that is real but only settleable by running the code is
 * cheaper to hand to the next phase than to argue about in prose. Measured on a
 * plan for a 1416-line parser that spent eight rounds and $24 without ever
 * reaching implementation, while a definitive test suite sat unused.
 */
export function gate(findings: readonly Finding[], tolerance: number): Gate {
  const p0 = p0s(findings);
  const p1 = p1s(findings);
  if (p0.length > 0) {
    return {
      pass: false,
      p0,
      p1,
      tolerated: [],
      reason: `${p0.length} P0 finding(s), which are never carried forward`,
    };
  }
  if (p1.length > tolerance) {
    return {
      pass: false,
      p0,
      p1,
      tolerated: [],
      reason: `${p1.length} P1 finding(s), above the tolerance of ${tolerance}`,
    };
  }
  return { pass: true, p0, p1, tolerated: [...p1], reason: null };
}
