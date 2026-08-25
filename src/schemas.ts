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

/**
 * The evidence taxonomy and its consequence, in one place.
 *
 * Exported because `critiquePrompt` and `reviewPrompt` state the same rule, and
 * a model told the rule in two different wordings has to guess which one the
 * code implements. The consequence is stated as plainly as the rule: a model
 * told the cost complies, one told only the rule guesses (#48).
 */
export const EVIDENCE_RULE =
  'Every finding must cite something. Each entry names one kind of claim:\n' +
  '- `code` - this line does X. Needs `path` (a file); may add `line` and `excerpt`. ' +
  'Checked against the repository: the file must exist, `line` must be inside it, and ' +
  '`excerpt` must appear somewhere in it.\n' +
  '- `artifact` - the plan does not say what happens on resume. Needs `path`, the basename ' +
  'of a run artifact such as `PLAN.md` or `code-review-0.json`. Checked against the run ' +
  'directory.\n' +
  '- `absence` - no test covers this path. Needs `path`, naming the file **or directory** ' +
  'the thing is missing from. Only that the place exists is checked.\n' +
  '- `external` - a fact about another tool, a spec, or a URL that nothing here can check. ' +
  'Needs `ref`. Nothing is checked.\n\n' +
  'A path must name something inside the repository - or, for `artifact`, inside the run ' +
  'directory. Cite as many places as you like: the finding stands if **any one** entry ' +
  'resolves.\n\n' +
  'A P0 or P1 whose evidence does not resolve is downgraded to P2 and stops blocking. It is ' +
  'kept, not deleted, and the downgrade is recorded with the kinds it offered. So cite the ' +
  'place you actually looked: an unresolvable citation costs the finding its severity, and ' +
  '`external` on a claim you could have pointed at in the code is visible for what it is.';

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
        required: ['id', 'severity', 'title', 'detail', 'suggested_fix', 'defer', 'evidence'],
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
          evidence: {
            type: 'array',
            minItems: 1,
            description: EVIDENCE_RULE,
            items: {
              type: 'object',
              additionalProperties: false,
              // Only `kind` is required. The rest is per-kind - `path` for the
              // three filesystem kinds, `ref` for `external` - which needs
              // `oneOf`, and a schema either CLI rejects would kill every turn.
              // The runtime enforces it instead, where a miss costs one entry
              // rather than the whole report.
              required: ['kind'],
              properties: {
                kind: {
                  type: 'string',
                  enum: ['code', 'artifact', 'absence', 'external'],
                  description:
                    'Which kind of claim this citation makes. `code` and `absence` are checked ' +
                    'against the repository, `artifact` against the run directory, `external` ' +
                    'not at all.',
                },
                path: {
                  type: 'string',
                  description:
                    'Repo-relative, e.g. "src/run.ts". For `artifact`, the basename of a run ' +
                    'artifact ("PLAN.md", "code-review-0.json"). For `absence`, a file or a ' +
                    'directory. Required for `code`, `artifact` and `absence`.',
                },
                line: {
                  type: 'integer',
                  description:
                    'Optional, `code` only. Must be a real line of the file. Not required to ' +
                    'be where an `excerpt` appears.',
                },
                excerpt: {
                  type: 'string',
                  description:
                    'Optional, `code` only. Must appear somewhere in the file; whitespace is ' +
                    'normalised before comparing, so re-indenting is safe. Quote it exactly ' +
                    'otherwise - a paraphrase does not resolve.',
                },
                ref: {
                  type: 'string',
                  description:
                    '`external` only: the URL, spec, or tool documentation being relied on. ' +
                    'Required for `external`.',
                },
              },
            },
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
