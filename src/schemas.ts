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
        'Material unresolved assumptions affecting correctness, scope, compatibility or ' +
        'verification. Check repository facts first. An empty array is valid when there ' +
        'are none; do not invent uncertainty or catalogue routine implementation choices.',
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
        'elsewhere. Record material scope exclusions without inventing work to exclude. ' +
        'The original task remains the scope reference even when this list is empty. ' +
        'When you revise a plan, restate the boundary in full: ' +
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
        'Derive them from the original task and explicit user decisions; do not add speculative ' +
        'requirements to satisfy a reviewer. State each so that two people would agree whether ' +
        'it holds - a criterion nobody can ' +
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

/**
 * The executable witness, its consequence, and the one thing it may not be
 * (#113).
 *
 * Exported for the same reason `EVIDENCE_RULE` is: `reviewPrompt` states it in
 * prose and the schema states it on the field, and a model told the same rule in
 * two wordings has to guess which one the code implements.
 *
 * It says **a file, never a command**, in the imperative, because the obvious
 * thing for a model to want is a command - the research review's own schema
 * example proposed one - and being told the shape without being told why leaves
 * a reviewer trying to smuggle a shell string into `contents`. It also says what
 * a wrong reproducer costs, because a model told only the rule guesses at the
 * cost and a model told the cost complies.
 */
export const REPRODUCER_RULE =
  'Always written: null unless this is a P0 or P1 in a **code review** and you have a ' +
  'failing test to offer - always null when critiquing a plan, since there is no ' +
  'implementation to run a test against.\n\n' +
  'A test that FAILS because of the defect you are describing and would pass once it is ' +
  'fixed. Give the file, not a command: you name a path and the whole contents, this ' +
  'orchestrator writes it and runs **the project\'s own already-configured verification ' +
  'command, unchanged**. You cannot choose what is executed, only which of the configured ' +
  'gates executes it. Nothing you write reaches a shell.\n\n' +
  'What it buys you: a finding whose reproducer fails before the fix is **proven**, and the ' +
  'fixer is told so. It is the difference between an assertion and an observation.\n\n' +
  'What it costs: if the test **passes** against the unfixed code, the finding did not ' +
  'reproduce and is downgraded to P2, exactly as an unresolvable citation is. So write one ' +
  'only when you are confident the defect is real and you can express it as a failing test. ' +
  'A null reproducer costs nothing - a finding without one is judged exactly as findings ' +
  'have always been judged.\n\n' +
  'The file must stand alone under this project\'s existing test setup, must not already ' +
  'exist, and must test the defect rather than the fix you have in mind. It is removed from ' +
  'the working tree after it has been run and kept in the run record.';

/**
 * How a finding ends, spelled out once, appended to the `evidence` array's
 * schema description and never to `EVIDENCE_RULE` (#416).
 *
 * `EVIDENCE_RULE` is rendered into the review prompts and so into frozen prompt
 * fixtures; the schema description is not. The example is the sequence the
 * reordered schema asks for - every key written, the null ones first, content
 * last - so the model has seen it end on `}]}` at least once.
 */
export const EVIDENCE_EXAMPLE_ENDING =
  'Each finding ends on its evidence, with every key written, for example: ' +
  '…,"defer":false,"reproducer":null,"evidence":[{"kind":"code","ref":null,"path":"src/x.ts","line":12,"excerpt":"…"}]}';

/** Shared shape for both plan critique and post-implementation code review. */
export const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'summary', 'findings'],
  properties: {
    verdict: {
      type: 'string',
      enum: ['APPROVE', 'REVISE'],
      // This used to read "APPROVE if and only if there are zero P0 and zero P1
      // findings", which was both an instruction about what the loop does and
      // false: `gate()` decides from the findings and `loop.p1Tolerance`, carries
      // up to that many P1s (default 1), and never reads this field (#115). It
      // states no threshold on purpose - a reviewer told how many P1s are free is
      // invited to grade toward the line rather than on the merits.
      description:
        'Your own judgement of whether this is right. It is recorded, not acted on: what ' +
        'happens next is decided from your findings and their severities under the ' +
        "project's settings. APPROVE is a correct and expected outcome when inspection " +
        'supports it. Grade each finding on its merits, never to reach or avoid a verdict.',
    },
    summary: { type: 'string' },
    findings: {
      type: 'array',
      description:
        'Only evidence-backed defects. An empty array is a successful review when inspection ' +
        'supports it; there is no quota and no requirement to find something beyond the implementer report.',
      items: {
        type: 'object',
        additionalProperties: false,
        // **Filler first, content last (#416).** The order of `required` and of
        // `properties` is the order the model writes the keys in, and it is the
        // whole of the fix for answers that stalled into blank space.
        //
        // Across the 136 `codex/*.out.json` in this repo's run archive, 67 had
        // blank space between JSON values: 150 runs, 89 of them just before
        // `"reproducer"` (then the last key of a finding, after `evidence`
        // closed) and 60 just before `"ref"` (then the last key of an evidence
        // entry, after `excerpt`), and 1 anywhere else. 132 of the 150 were one
        // or two characters and the longest was 17. Twice it never stopped: a
        // `review-0` and a `critique-1` each wrote 128,000 output tokens, the
        // limit, almost all of it blank, and the run died with no answer.
        //
        // Inferred, not measured: once the content is written the likeliest next
        // token is `}`, which the strict schema forbids while a required key is
        // still missing, so the only legal tokens are `,` and blank space - and
        // the field still owed is one that is almost always null (`reproducer` in
        // 259 of 261 findings, `ref` in 742 of 790 entries). A usually-null field
        // in the *middle* does not do it: 53 entries had `line` and `excerpt` both
        // null mid-object with no blank run before either. So **a nullable filler
        // field must never be the last one after content**, and here the null
        // ones come first. A finding now ends on its `evidence`, and a
        // reproducer on its `contents`.
        //
        // An evidence entry does only for `code`, where `path`, `line` and
        // `excerpt` are written last. One order cannot suit every kind: an
        // `external` entry now ends `ref:"https://…", path:null, line:null,
        // excerpt:null`, and an `absence` entry `path:"x", line:null,
        // excerpt:null`, so their content comes before nulls still owed. That is
        // 54 of the archive's 812 evidence entries (40 `external`, 14
        // `absence`), down from 742 of 790 that ended on a null `ref` before.
        // Whether they stall, and what to do if they do, is #429.
        //
        // Left alone on the same evidence: `test_verdicts` (last in
        // `REVIEW_SCHEMA`, often `[]`) shows no blank run before it in the
        // archive, and `ANSWERS_SCHEMA`, `FIX_SCHEMA` and `PLAN_SCHEMA` end on
        // fields that are not null. `scripts/count-schema-stalls.mjs` is how a
        // later archive confirms or refutes this, including whether the stall
        // simply moved to the new last key.
        required: [
          'id',
          'severity',
          'title',
          'detail',
          'suggested_fix',
          'defer',
          // Nullable rather than omitted, for the reason the evidence entry's
          // keys are: Codex refuses a closed object whose `required` does not
          // cover every property (#68), and `schema-shape.test.ts` is what
          // caught this one before a run did.
          'reproducer',
          'evidence',
        ],
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
          detail: {
            type: 'string',
            description:
              'For a substantive finding, give a concrete trigger in a supported scenario, the ' +
              'incorrect outcome, the affected task requirement or existing contract, and evidence ' +
              'connecting them. Explain why resolving it belongs in this change; separate work is deferred.',
          },
          suggested_fix: {
            type: 'string',
            description:
              'Advisory: the simplest coherent remedy for the demonstrated defect. The implementer ' +
              'may use another valid repair. Consider removing or simplifying unnecessary mechanisms ' +
              'before adding abstractions, dependencies, configuration, fallbacks or special cases.',
          },
          defer: {
            // Typed, not just required: with `additionalProperties: false` a
            // required property carrying no `type` still accepts a string or a
            // number, and `parseFindings` reads anything that is not literally
            // `true` as false - so malformed output would satisfy the schema
            // and silently fail to defer.
            type: 'boolean',
            description:
              'true = this is real and worth doing, but it belongs in separate work rather ' +
              'than in this change. The test: would this change be correct, complete and safe ' +
              'to ship without it? If yes, defer it. If no, it is not deferrable at any ' +
              'severity - raise it at its true severity instead. A deferred finding is by ' +
              'definition not blocking: it must be P2 or P3, never P0 or P1. That is ' +
              'deliberate - choosing to defer costs the same honesty as choosing a severity ' +
              'does. Not deferring costs too: separate work raised without this flag becomes ' +
              'part of the change, and the change is what gets built.',
          },
          reproducer: {
            // Nullable and required, for the reason the evidence entry's
            // optional keys are: Codex's `--output-schema` refuses an object
            // whose `required` does not cover all of `properties` (#68). A
            // finding with no reproducer sets this to null.
            type: ['object', 'null'],
            description: REPRODUCER_RULE,
            additionalProperties: false,
            // `gate` first: it is null when the run has one gate, and a null
            // last after the contents is the shape that stalled (#416).
            required: ['gate', 'path', 'contents'],
            properties: {
              gate: {
                type: ['string', 'null'],
                description:
                  'Which of the run\'s configured verification gates runs this file, by ' +
                  'name. Null is correct when the run has exactly one gate. This chooses ' +
                  'which existing command observes the file; it cannot change what that ' +
                  'command is.',
              },
              path: {
                type: ['string', 'null'],
                description:
                  'Repo-relative path for the new test file, e.g. ' +
                  '"tests/retry-backoff.test.ts". It must NOT already exist - an existing ' +
                  'path is refused rather than overwritten, and the reproducer is discarded. ' +
                  'Put it where this project keeps the tests the gate below already runs.',
              },
              contents: {
                type: ['string', 'null'],
                description:
                  'The whole file. It is written verbatim and nothing is added to it, so it ' +
                  'must compile and run under this project\'s existing test setup with no ' +
                  'further edits. Assert the defect: the test must FAIL against the code as ' +
                  'it stands.',
              },
            },
          },
          evidence: {
            type: 'array',
            minItems: 1,
            // The rule, then the example ending - appended here and not to
            // `EVIDENCE_RULE`, which the prompts render (#416).
            description: EVIDENCE_RULE + '\n\n' + EVIDENCE_EXAMPLE_ENDING,
            items: {
              type: 'object',
              additionalProperties: false,
              // EVERY key, not just `kind`, and the optional ones are nullable
              // instead. OpenAI structured outputs refuse an object with
              // `additionalProperties: false` whose `required` does not cover
              // all of `properties` - so `required: ['kind']` was a 400 on
              // `text.format.schema` before the model was ever reached, killing
              // every critique and every review on develop (#68).
              //
              // Which CLI is asked matters: Claude accepted the same schema
              // through `--json-schema` in the run that died, so the planner was
              // fine and only Codex's `--output-schema` refused it. The two do
              // not enforce the same subset, and the invariant test over these
              // schemas is what now holds the line offline.
              //
              // Per-kind requirements - `path` for the three filesystem kinds,
              // `ref` for `external` - are still NOT expressed here. That needs
              // `oneOf`, and the runtime enforces it instead, where a miss costs
              // one citation rather than the whole report (#48).
              //
              // `ref` second rather than last (#416): it is null in 742 of 790
              // entries, and as the last key after `excerpt` it was where 60 of
              // the archive's 150 blank runs sat. This ends a `code` entry on
              // its content, but not an `external` or `absence` one, which still
              // ends on null fields after it (54 of 812 entries; #429). See the
              // note on the finding.
              required: ['kind', 'ref', 'path', 'line', 'excerpt'],
              properties: {
                kind: {
                  type: 'string',
                  enum: ['code', 'artifact', 'absence', 'external'],
                  description:
                    'Which kind of claim this citation makes. `code` and `absence` are checked ' +
                    'against the repository, `artifact` against the run directory, `external` ' +
                    'not at all.',
                },
                ref: {
                  type: ['string', 'null'],
                  description:
                    'Always present. `external` only: the URL, spec, or tool documentation being ' +
                    'relied on. Required for `external`; null for the other kinds.',
                },
                path: {
                  type: ['string', 'null'],
                  description:
                    'Repo-relative, e.g. "src/run.ts". For `artifact`, the basename of a run ' +
                    'artifact ("PLAN.md", "code-review-0.json"). For `absence`, a file or a ' +
                    'directory. Required for `code`, `artifact` and `absence`; null for ' +
                    '`external`.',
                },
                line: {
                  type: ['integer', 'null'],
                  description:
                    'Always present; null unless the kind is `code`. Must be a real line of the file. ' +
                    'Not required to be where an `excerpt` appears.',
                },
                excerpt: {
                  type: ['string', 'null'],
                  description:
                    'Always present; null unless the kind is `code`. Must appear somewhere in the ' +
                    'file; whitespace is normalised before comparing, so re-indenting is safe. ' +
                    'Quote it exactly otherwise - a paraphrase does not resolve.',
                },
              },
            },
          },
        },
      },
    },
  },
} as const satisfies object;

/**
 * The reviewer's schema: the findings, plus one verdict per change to the judge
 * (#112).
 *
 * Its own constant rather than a field on `FINDINGS_SCHEMA`, because that one is
 * the plan critic's too and the critic has no diff and no judge files to rule
 * on. Required and an empty array when the prompt lists nothing, because Codex
 * refuses a closed object whose `required` does not cover every property (#68) -
 * so "optional" is spelled `[]`, never an absent key.
 */
export const REVIEW_SCHEMA = {
  ...FINDINGS_SCHEMA,
  required: [...FINDINGS_SCHEMA.required, 'test_verdicts'],
  properties: {
    ...FINDINGS_SCHEMA.properties,
    test_verdicts: {
      type: 'array',
      description:
        'One entry per file listed under "Changes to the judge" in the prompt, and an empty ' +
        'array when the prompt lists none. A listed file you leave out is recorded as unjudged.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['file', 'justified', 'reason'],
        properties: {
          file: {
            type: 'string',
            description: 'The path exactly as it is listed in the prompt.',
          },
          justified: {
            type: 'boolean',
            description:
              'True only when the change is justified under the definition in the prompt. ' +
              'Never true merely because the change makes the gate pass.',
          },
          reason: {
            type: 'string',
            description: 'Why, citing what in the plan or the code settles it.',
          },
        },
      },
    },
  },
} as const satisfies object;

/**
 * One verifier's vote on one finding (#388 Part C).
 *
 * Beside `FINDINGS_SCHEMA`, and its evidence item is that schema's own object
 * rather than a copy: a vote's citations are grounded by `groundFindings`, so
 * they have to be the same shape a finding's are, and a second spelling of the
 * item is one that drifts (#68 is what a drifted item cost). `evidence` may be
 * empty - a `real` vote needs none beyond the claim's own - so it has no
 * `minItems`, and the rule that a `not-real` vote must point at something is
 * enforced by the tally, where a miss costs one vote rather than the turn.
 */
export const VOTE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['vote', 'reason', 'evidence'],
  properties: {
    vote: {
      type: 'string',
      enum: ['real', 'not-real', 'cannot-tell'],
      description:
        'real = the defect the claim describes exists in this code. not-real = it does not, and ' +
        'you can show why. cannot-tell = anything in between, including any doubt.',
    },
    reason: {
      type: 'string',
      description: 'Why, in a few sentences. For not-real, the concrete reason the claim is false.',
    },
    evidence: {
      type: 'array',
      description:
        'Where to look. Needed for not-real: a not-real vote whose citations resolve to ' +
        'nothing is counted as cannot-tell. May be empty for real and cannot-tell.',
      items: FINDINGS_SCHEMA.properties.findings.items.properties.evidence.items,
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

/**
 * A review fix turn's final message (#393): the report, and what it did with
 * each finding.
 *
 * Only the two review fix turns - `fix-<n>` and `final-fix-<n>` - are given
 * this, as a per-turn `jsonSchema`. A `verify-fix` turn's one "finding" is a
 * gate failure, not a reviewer's claim, so it keeps its prose report.
 *
 * `report` is written to `fix-report-<n>.md` verbatim and read by the next
 * reviewer exactly as the prose report always was. `dispositions` is what the
 * prose used to say only in English. A writer's output that does not fit this
 * is not a failed turn - its edits are already in the tree - so the caller
 * keeps the text as the report and records no dispositions at all.
 */
export const FIX_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['report', 'dispositions'],
  properties: {
    report: {
      type: 'string',
      description:
        'Your whole report, as markdown with the headings the prompt asks for. It is handed to ' +
        'the next code reviewer as-is.',
    },
    dispositions: {
      type: 'array',
      description: 'One entry per finding id listed in the prompt, and only those ids.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'disposition', 'reason'],
        properties: {
          id: { type: 'string', description: 'The finding id, exactly as listed.' },
          disposition: {
            type: 'string',
            enum: ['fixed', 'rebutted', 'deferred', 'not-addressed'],
            description:
              'fixed = you changed the code to resolve it. rebutted = you believe it is incorrect ' +
              'and changed nothing for it. deferred = real, but separable work you did not do here. ' +
              'not-addressed = none of these.',
          },
          reason: { type: 'string', description: 'Why, in a sentence or two.' },
        },
      },
    },
  },
} as const satisfies object;
