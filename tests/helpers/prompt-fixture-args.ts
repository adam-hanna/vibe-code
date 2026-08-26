import type { AcceptanceCriterion, OutOfScopeItem } from '@src/types.js';

/**
 * The arguments the golden review prompts in `tests/fixtures/prompts/` were
 * generated from.
 *
 * Here, and imported by BOTH the generation script and the assertions, because
 * a fixture generated with one tuple and asserted against another proves
 * nothing at all: the test would be comparing two strings that were never meant
 * to match, and the compatibility bar #49 set - "for a small diff the prompt is
 * byte-identical to develop's" - would pass on a coincidence.
 *
 * Everything here is a fixed literal. Nothing time-dependent, nothing
 * path-dependent, and `environment` is passed as `null` at the call sites, so
 * the same call on any machine produces the same bytes.
 */
export const DIFF = `diff --git a/src/widget.ts b/src/widget.ts
index 1111111..2222222 100644
--- a/src/widget.ts
+++ b/src/widget.ts
@@ -1,3 +1,4 @@
 export function widget(): string {
-  return 'old';
+  return 'new';
 }
`;

export const FILES: readonly string[] = ['src/widget.ts', 'tests/widget.test.ts'];

export const PLAN_MD = `# Widget

Return the new string instead of the old one, and cover it with a test.`;

export const OUT_OF_SCOPE: readonly OutOfScopeItem[] = [
  { item: 'Renaming the widget module', why: 'Unrelated churn in a change about one string.' },
];

export const CRITERIA: readonly AcceptanceCriterion[] = [
  {
    id: 'returns-new',
    criterion: '`widget()` returns the new string.',
    check: 'command',
    how: 'npm test',
  },
];
