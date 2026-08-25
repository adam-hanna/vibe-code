/**
 * Schemas are the loop's control plane. Every stop/continue decision reads a
 * typed field, never prose - grepping model output for the string "P1" is how
 * these loops silently run forever.
 */

/** Claude's planning turn. Questions come back as data, not as an interaction. */
export const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['plan_md', 'assumptions', 'open_questions', 'out_of_scope', 'acceptance_criteria'],
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
    out_of_scope: {
      type: 'array',
      description:
        'Real work you are deliberately NOT doing in this change, and why it belongs ' +
        'elsewhere. Draw the boundary before a reviewer tests one: a plan that never stated ' +
        'a boundary can only defend one it does not have, so every legitimate finding outside ' +
        'the change has to be absorbed, and each absorption enlarges what there is to critique. ' +
        'An empty array is legal, but it is a claim that this change has no interesting edges - ' +
        'make it only when that is true. When you revise a plan, restate the boundary in full: ' +
        'this field is the whole boundary, not a delta.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['item', 'why'],
        properties: {
          item: { type: 'string', description: 'The work you are not doing.' },
          why: { type: 'string', description: 'Why it is separable from this change.' },
        },
      },
    },
    acceptance_criteria: {
      type: 'array',
      description:
        'How anyone can tell this change worked: the observable conditions that make it done. ' +
        'State each so that two people would agree whether it holds - a criterion nobody can ' +
        'check is not one. An empty array is legal, but it is a claim that done-ness here is ' +
        'unobservable, so make it only when that is true. When you revise a plan, restate the ' +
        'bar in full: this field is the whole bar, not a delta.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'criterion', 'check', 'how'],
        properties: {
          id: {
            type: 'string',
            description:
              'Stable kebab-case slug, unique within the plan, e.g. "resumes-without-repair". ' +
              'A finding cites this rather than quoting the criterion.',
          },
          criterion: {
            type: 'string',
            description: 'The observable condition, stated so that two people would agree whether it holds.',
          },
          check: {
            // Typed and enumerated for the reason `defer` is: with
            // `additionalProperties: false` a required property carrying no
            // `type` still accepts a number, and nothing downstream would say so.
            type: 'string',
            enum: ['command', 'inspection', 'qa'],
            description:
              'How it is checked: a command to run, something to inspect, or a named QA ' +
              'scenario. Descriptive - nothing here runs it.',
          },
          how: {
            type: 'string',
            description: 'The command to run, what to inspect, or the named scenario.',
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
      description: 'APPROVE if and only if there are zero P0 and zero P1 findings.',
    },
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'severity', 'title', 'detail', 'suggested_fix', 'defer'],
        properties: {
          id: {
            type: 'string',
            description:
              'Stable kebab-case slug for this issue, e.g. "unbounded-retry-loop". ' +
              'Reuse the same id if you are re-raising an issue from a previous round.',
          },
          severity: {
            type: 'string',
            enum: ['P0', 'P1', 'P2', 'P3'],
            description:
              'P0 = stop everything; the work cannot proceed with this outstanding. Data loss, a ' +
              'security hole, or an approach that cannot be made to work. A P0 halts the run for a ' +
              'human even if it is the only finding, so use it only when carrying on would be ' +
              'worse than stopping. ' +
              'P1 = must fix; correctness or a real defect, but the run may carry a small number ' +
              'forward and settle them against the tests rather than in discussion. ' +
              'P2 = should fix. P3 = nit. ' +
              'If a finding is only answerable by running the code, it is a P1, not a P0.',
          },
          title: { type: 'string' },
          detail: { type: 'string' },
          suggested_fix: { type: 'string' },
          defer: {
            // Typed, not just required: with `additionalProperties: false` a
            // required property carrying no `type` still accepts a string or a
            // number, and `parseFindings` reads anything that is not literally
            // `true` as false - so malformed output would satisfy the schema
            // and silently fail to defer.
            type: 'boolean',
            description:
              'true = this is real and worth doing, but it belongs in separate work rather ' +
              'than in this change. A deferred finding is by definition not blocking: it must ' +
              'be P2 or P3, never P0 or P1. That is deliberate - choosing to defer costs the ' +
              'same honesty as choosing a severity does. If the work has to happen inside this ' +
              'change for it to be correct, do not defer it; raise it at its true severity.',
          },
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
