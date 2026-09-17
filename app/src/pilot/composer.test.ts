import { describe, expect, test } from 'vitest';
import pilotPane from './PilotPane.tsx?raw';

/**
 * Why the composer will not send, and why it can always be typed in (#223).
 *
 * **The app has no jsdom**, so this reads the source the way `saved.test.ts`
 * and `keys.test.ts` do. That is a weaker guarantee than rendering and it is
 * the one available; what it can check is exactly what went wrong here, which
 * was a control's *shape* rather than its behaviour.
 *
 * The defect: `ready` folded five conditions together, `blocked` explained two
 * of them, and the textarea was disabled for all five. So a pane holding an
 * undecided proposal was a box that could not be clicked into, under a
 * placeholder inviting you to say what you wanted built — reported as *"my
 * pilot chat won't allow me to click inside of it and enter text"*, which is
 * what a disabled `textarea` looks like from outside, since it cannot even take
 * focus to show a tooltip.
 */

/** The composer's textarea, from its class to the tag that closes it. */
function entry(): string {
  const from = pilotPane.indexOf('className="v-pilot__entry"');
  expect(from).toBeGreaterThan(-1);
  return pilotPane.slice(from, pilotPane.indexOf('/>', from));
}

describe('the composer', () => {
  test('the field is never disabled, so what is half-typed survives a proposal', () => {
    // Composing and sending are two acts and only the second can be blocked. A
    // field disabled the moment a proposal arrived also threw away whatever was
    // in it, which is a message somebody wrote and nobody can get back.
    expect(entry()).not.toMatch(/disabled=/);
  });

  test('the placeholder is the instruction, never the reason', () => {
    // The reason moved out to its own line. A placeholder disappears the moment
    // somebody types, which makes it the wrong place for the one sentence they
    // need while looking at a send button that will not work.
    expect(entry()).toMatch(/placeholder="say what you want built/);
  });

  test('send is what refuses, and it refuses on the same value the handler checks', () => {
    // Two roads reach `start`: the button and Enter. The button was guarded and
    // the key handler was not - which mattered nothing while the field was
    // disabled, and would be a live hole now that it is not.
    expect(pilotPane).toMatch(/disabled=\{!ready \|\| entry\.trim\(\) === ''\}/);
    expect(pilotPane).toMatch(/if \(content === '' \|\| live !== null \|\| !ready\) return;/);
  });

  test('every reason send is off has a sentence, not just the two about setup', () => {
    // The five states `ready` is false in. A missing key and a missing
    // repository always had words; a spent ceiling, an outstanding proposal and
    // the frame between a turn ending and its calls settling did not, and those
    // are the three somebody actually hits mid-conversation.
    const reasons = pilotPane.slice(
      pilotPane.indexOf('const blocked: string | null ='),
      pilotPane.indexOf('const ready ='),
    );
    expect(reasons).toMatch(/keys\.PROVIDER_NAME\[provider\]/);
    expect(reasons).toMatch(/choose a repository first/);
    expect(reasons).toMatch(/verdict\.why/);
    expect(reasons).toMatch(/proposals\.length/);
    expect(reasons).toMatch(/owed\.length/);
    // And `ready` is that answer rather than a second list of the same
    // conditions, so a state that is blocked and a state with no sentence for it
    // cannot come apart.
    expect(pilotPane).toMatch(/const ready = blocked === null;/);
  });

  test('the reason is drawn, or the sentence is one nobody reads', () => {
    expect(pilotPane).toMatch(/blocked !== null && <div className="v-pilot__blocked">/);
  });
});
