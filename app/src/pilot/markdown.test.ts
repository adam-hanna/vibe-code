import { describe, expect, test } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown } from './Markdown';
import { systemPrompt } from './brief';
import { emptyRun } from '../cockpit/model';
import pane from './PilotPane.tsx?raw';

/**
 * The pilot's replies are Markdown and are drawn as Markdown. Reported as
 * *"Is it trying to print markdown? Do we not support markdown in the pilot
 * window?"* over a reply that arrived as rows of pipes.
 */

const draw = (text: string): string => renderToStaticMarkup(createElement(Markdown, { text }));

describe('the renderer', () => {
  test('a pipe table is a table, and bold and code are formatting', () => {
    const html = draw('| field | now |\n|---|---|\n| **pnl** | `204,468` |');
    expect(html).toContain('<table');
    expect(html).toContain('<th');
    expect(html).toMatch(/<strong[^>]*>pnl<\/strong>/);
    expect(html).toMatch(/<code[^>]*>204,468<\/code>/);
    expect(html).not.toContain('|');
  });

  test('raw HTML in a reply never becomes an element on the page', () => {
    const html = draw('before <img src=x onerror=alert(1)> <script>alert(2)</script> after');
    expect(html).not.toMatch(/<img|<script/);
  });

  test('a link is never something a click can follow, and says where it points', () => {
    const html = draw('see [the docs](https://example.com/a) and https://example.com/b');
    expect(html).not.toMatch(/<a[\s>]/);
    expect(html).toContain('(https://example.com/a)');
    expect(html).toContain('https://example.com/b');
  });

  test('a fenced block keeps its line breaks', () => {
    const html = draw('```ts\nconst a = 1;\nconst b = 2;\n```');
    expect(html).toMatch(/<pre[^>]*><code[^>]*>const a = 1;\nconst b = 2;\n<\/code><\/pre>/);
  });
});

describe('the route', () => {
  test('the pane draws a reply through it, and the person\'s own message stays as typed', () => {
    expect(pane).toMatch(/<Markdown text=\{visible\(reply\.text\)\} \/>/);
    expect(pane).toMatch(/whitespace-pre-wrap[^"]*"\>\s*\{reply\.asked\}/);
  });

  test('the pilot is told its replies are rendered as Markdown', () => {
    expect(systemPrompt(emptyRun(), null)).toMatch(/rendered as GitHub-flavoured Markdown/);
  });
});
