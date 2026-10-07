import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { StopConfirm } from './StopConfirm';
import { turnSentence } from './format';
import type { Turn } from './model';

/**
 * The stop confirmation, in words a person deciding can use (#253).
 *
 * It was reported from a screenshot: a red `ends the run` badge over a sentence
 * saying the turn is redone on resume, a title of `Stop implementer · verify-fix
 * now`, a badge reading `the honest middle`, and a row explaining that *"no frame
 * carries which one"*. Every one of those was the design's or the protocol's
 * vocabulary rather than the person's.
 */

function render(turn: Turn | null): string {
  return renderToStaticMarkup(
    createElement(StopConfirm, { turn, busy: false, onStop: () => {}, onPause: () => {}, onKeep: () => {} }),
  );
}

const turn = (over: Partial<Turn> = {}): Turn => ({
  id: 1,
  role: 'implementer',
  kind: 'verify-fix',
  round: 1,
  startedAt: 0,
  endedAt: null,
  beat: null,
  work: null,
  ...over,
});

describe('the stop confirmation', () => {
  test('asks a question and says the run can be resumed, never that it ends', () => {
    const html = render(turn());
    expect(html).toContain('Stop the run?');
    expect(html).toContain('You can resume it later');
    expect(html).not.toMatch(/ends the run/i);
  });

  test('says what the agent is doing in words, not the frame’s two fields', () => {
    const html = render(turn());
    expect(html).toContain('The implementer is fixing the failing checks.');
    expect(html).not.toContain('verify-fix');
  });

  test('carries none of the internal vocabulary it shipped with', () => {
    const html = render(turn());
    for (const phrase of ['honest middle', 'session id', 'frame', 'checkpoint']) {
      expect(html.toLowerCase()).not.toContain(phrase);
    }
  });

  test('one name for stopping, and the buttons can wrap rather than run off the edge', () => {
    const html = render(turn());
    expect(html).toContain('Stop run');
    expect(html).not.toContain('Stop the turn');
    expect(html).toContain('flex-wrap');
  });

  test('between turns there is no cost table, because nothing is in flight', () => {
    const html = render(null);
    expect(html).toContain('No agent turn is running right now.');
    expect(html).not.toMatch(/work lost|already spent/i);
  });
});

describe('turnSentence', () => {
  test('every turn kind the loop narrates has a sentence', () => {
    for (const kind of ['plan', 'revise', 'critique', 'answer', 'implement', 'verify-fix', 'review', 'review-fix', 'final-fix']) {
      // The fallback is the only sentence shaped `is running a … turn`.
      expect(turnSentence({ role: 'r', kind })).not.toMatch(/is running an? .* turn\.$/);
    }
  });

  test('a kind this build does not know is said as itself, not as an invented phrase', () => {
    expect(turnSentence({ role: 'reviewer', kind: 'audit' })).toBe('The reviewer is running an audit turn.');
  });
});
