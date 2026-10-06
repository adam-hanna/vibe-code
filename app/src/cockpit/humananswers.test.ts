import { describe, expect, test } from 'vitest';
import cli from '../../../src/cli.ts?raw';
import pane from './QuestionsPane.tsx?raw';
import { answerFiles, humanAnswers, parseAnswered, questionKey } from './humananswers';

// *"I answered, but then my answer was immediately overwritten by some agent's
// answer"* (#223). The run used the answer; the pane only ever drew the
// answerer's `answers-<n>.json`.
const FILE = [
  '# Needs your input',
  '',
  '### 1. Does the eight-file budget count the duplicate schema files?',
  '',
  'Why it matters: something',
  '',
  '**Your answer:**',
  '',
  '> Just implementation and its not a hard limit',
  '',
  '### 2. A question nobody answered',
  '',
  '**Your answer:**',
  '',
  '> ',
].join('\n');

describe('a person\'s answers, read from the files the loop keeps', () => {
  test('an answered question is read, and an empty blockquote is not an answer', () => {
    expect(parseAnswered(FILE)).toEqual([
      { question: 'Does the eight-file budget count the duplicate schema files?', answer: 'Just implementation and its not a hard limit' },
    ]);
  });

  test('a question matches with or without the number the answerer echoes', () => {
    const mine = humanAnswers([FILE]);
    expect(mine.get(questionKey('1. Does the eight-file budget count the duplicate schema files?'))).toBe(
      'Just implementation and its not a hard limit',
    );
  });

  test('retired files in order, then the one still waiting, and the later answer wins', () => {
    expect(answerFiles(['plan-0.json', 'answered-10.md', 'NEEDS-INPUT.md', 'answered-2.md'])).toEqual([
      'answered-2.md',
      'answered-10.md',
      'NEEDS-INPUT.md',
    ]);
    const later = FILE.replace('Just implementation and its not a hard limit', 'changed my mind');
    expect([...humanAnswers([FILE, later]).values()]).toEqual(['changed my mind']);
  });

  test('the format is the core\'s own parser, read as source', () => {
    // `parseHumanAnswers` in src/cli.ts is what the run actually reads. If its
    // marker or its heading rule moves, the pane must move with it.
    expect(cli).toContain("const marker = '**Your answer:**';");
    expect(cli).toContain("split(/^### /m)");
    expect(cli).toContain(String.raw`firstLine.replace(/^\d+\.\s*/, '')`);
  });

  test('the pane draws yours first, on both the live round and the recorded ones', () => {
    expect(pane.match(/mine=\{mine\.get\(questionKey\(/g)).toHaveLength(2);
    expect(pane).toMatch(/your answer/);
  });
});
