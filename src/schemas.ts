/**
 * Schemas are the loop's control plane. Every stop/continue decision reads a
 * typed field, never prose - grepping model output for the string "P1" is how
 * these loops silently run forever.
 */

/** Claude's planning turn. Questions come back as data, not as an interaction. */
export const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['plan_md', 'assumptions', 'open_questions'],
  properties: {
    plan_md: {
      type: 'string',
      description:
        'The full implementation plan as GitHub-flavored markdown. Self-contained: ' +
        'a reader with no other context can execute it.',
    },
    assumptions: {
      type: 'array',
      description:
        'Every judgement call you made that a reviewer could reasonably dispute. ' +
        'Be exhaustive - an unstated assumption is how a plan passes review and still ships the wrong thing.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['assumption', 'why', 'blast_radius'],
        properties: {
          assumption: { type: 'string' },
          why: { type: 'string', description: 'Why you chose this over the alternative.' },
          blast_radius: {
            type: 'string',
            description: 'What has to be redone if this assumption is wrong.',
          },
        },
      },
    },
    open_questions: {
      type: 'array',
      description: 'Questions you would have asked a human interactively.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['question', 'options', 'recommended', 'blocking', 'kind'],
        properties: {
          question: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
          recommended: { type: 'string', description: 'Your best answer if nobody replies.' },
          kind: {
            type: 'string',
            enum: ['technical', 'product'],
            description:
              'technical = answerable from the codebase, ecosystem, or engineering judgement. ' +
              'product = depends on user intent, business priorities, or taste. Be honest here.',
          },
          blocking: {
            type: 'boolean',
            description:
              'true only if proceeding on your recommended answer risks wasted or wrong work.',
          },
        },
      },
    },
  },
} as const satisfies object;

/** Shared shape for both plan critique and post-implementation code review. */
export const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'summary', 'findings'],
  properties: {
    verdict: {
      type: 'string',
      enum: ['APPROVE', 'REVISE'],
      description: 'APPROVE if and only if there are zero P1 findings.',
    },
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'severity', 'title', 'detail', 'suggested_fix'],
        properties: {
          id: {
            type: 'string',
            description:
              'Stable kebab-case slug for this issue, e.g. "unbounded-retry-loop". ' +
              'Reuse the same id if you are re-raising an issue from a previous round.',
          },
          severity: {
            type: 'string',
            enum: ['P1', 'P2', 'P3'],
            description:
              'P1 = must fix; correctness, security, data loss, or the plan cannot work as written. ' +
              'P2 = should fix. P3 = nit. Reserve P1 for real blockers.',
          },
          title: { type: 'string' },
          detail: { type: 'string' },
          suggested_fix: { type: 'string' },
        },
      },
    },
  },
} as const satisfies object;

/** Codex answering Claude's blocking questions. */
export const ANSWERS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['answers'],
  properties: {
    answers: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['question', 'answer', 'confidence', 'defer_to_human', 'rationale'],
        properties: {
          question: { type: 'string', description: 'Echo the question verbatim.' },
          answer: { type: 'string' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          defer_to_human: {
            type: 'boolean',
            description:
              'true if this depends on product intent, business context, or personal taste that ' +
              'you cannot derive from the codebase. Do not guess at what the user wants - say so.',
          },
          rationale: { type: 'string' },
        },
      },
    },
  },
} as const satisfies object;
