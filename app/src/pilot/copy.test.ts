import { describe, expect, test } from 'vitest';
import { copyOf } from './copy';
import { briefFor } from '../cockpit/argv';
import pilotPane from './PilotPane.tsx?raw';
import copyText from './CopyText.tsx?raw';

/**
 * Copying a message out of the pilot chat (#256).
 *
 * The app has no jsdom, so the decision is a pure function and the wiring is
 * pinned by reading the component as source - the shape `opened-run.test.ts`
 * and `frontdoor.test.ts` already use.
 */

const FENCE = '```';

describe('what each half copies', () => {
  test('your message is copied exactly as typed, newlines included', () => {
    expect(copyOf({ asked: 'first line\n\n  second, indented', text: '' }).asked).toBe('first line\n\n  second, indented');
  });

  test("the new-run dialog's settings are not copied as yours (#258)", () => {
    const asked = briefFor('fix the flaky gate', false, { maxTokens: 40_000_000 });
    expect(copyOf({ asked, text: '' }).asked).toBe('fix the flaky gate');
  });

  test("the pilot's reply is its Markdown source, so a fence survives a paste", () => {
    const text = `Here is the plan:\n\n- one\n- two\n\n${FENCE}ts\nconst x = 1;\n${FENCE}`;
    expect(copyOf({ asked: null, text }).said).toBe(text);
  });

  test('an emitted tool call is left out, as it is on screen', () => {
    const text = `I'll start the run.\n\n${FENCE}vibe-tool\n{"name":"start_run","arguments":{}}\n${FENCE}\n\nPress the card.`;
    const said = copyOf({ asked: null, text }).said;
    expect(said).not.toContain('vibe-tool');
    expect(said).not.toContain('start_run');
    expect(said).toContain("I'll start the run.");
    expect(said).toContain('Press the card.');
  });

  test('nothing to copy is no control: a turn still thinking, a woken turn, a reply that was only a call', () => {
    expect(copyOf({ asked: null, text: '' })).toEqual({ asked: null, said: null });
    expect(copyOf({ asked: '   \n ', text: '  ' })).toEqual({ asked: null, said: null });
    expect(copyOf({ asked: null, text: `${FENCE}vibe-tool\n{"name":"read_run","arguments":{}}\n${FENCE}` }).said).toBeNull();
  });
});

describe('the controls are drawn, and say what happened', () => {
  test('both halves of a reply card carry one', () => {
    const pane = pilotPane;
    expect(pane).toMatch(/copyOf\(reply\)/);
    expect(pane).toMatch(/<CopyText text=\{copy\.asked\}/);
    expect(pane).toMatch(/<CopyText text=\{copy\.said\}/);
  });

  test('a refused or missing clipboard is a visible failure, never silence', () => {
    const control = copyText;
    expect(control).toMatch(/\.catch\(\(\) => settle\('no'\)\)/);
    expect(control).toMatch(/navigator\.clipboard\?\.writeText/);
    expect(control).toMatch(/could not copy/);
  });
});
