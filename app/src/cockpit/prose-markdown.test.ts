import { describe, expect, test } from 'vitest';
import report from './ReportPane.tsx?raw';
import plans from './PlansPane.tsx?raw';

/**
 * Agent prose is drawn as the Markdown it is written in (#530), through the one
 * renderer the pilot already used; what a person typed, a cited excerpt and a
 * file shown as it is on disk stay preformatted. The renderer's own rules (no
 * raw HTML, no followed link, an image as its alt text) are
 * `pilot/markdown.test.ts`.
 */

describe('the review and critique pane', () => {
  test('a finding’s detail and fix, and the round summary, go through the renderer', () => {
    expect(report).toMatch(/<Markdown text=\{finding\.detail\}/);
    expect(report).toMatch(/<Markdown text=\{finding\.suggestedFix\}/);
    expect(report).toMatch(/<Markdown text=\{report\.summary\}/);
  });

  test('so do ballot reasons, dispositions and confirmation reasons', () => {
    expect(report).toMatch(/<Markdown text=\{b\.reason\}/);
    expect(report).toMatch(/<Markdown text=\{o\.reason\}/);
    expect(report).toMatch(/<Markdown text=\{c\.reason\}/);
  });

  test('a citation’s excerpt and the unreadable fallback stay preformatted', () => {
    expect(report).toMatch(/<pre[^>]*>\s*\{c\.excerpt\}/);
    expect(report).toMatch(/<pre className=\{DOCUMENT\}>\{read\.text\}<\/pre>/);
    expect(report).not.toMatch(/whitespace-pre-wrap text-body text-secondary/);
  });
});

describe('the plan', () => {
  test('is rendered by default, with its exact text one toggle away', () => {
    expect(plans).toMatch(/<Markdown text=\{body\}/);
    expect(plans).toMatch(/<pre className=\{DOCUMENT\}>\{body\}<\/pre>/);
    expect(plans).toMatch(/useState\(false\)/);
    expect(plans).toMatch(/show raw text/);
  });
});
