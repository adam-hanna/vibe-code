import { describe, expect, test } from 'vitest';
import cockpit from './Cockpit.tsx?raw';
import settings from './Settings.tsx?raw';
import footer from './Footer.tsx?raw';
import credentials from '../pilot/Credentials.tsx?raw';
import { MAX, MIN, STEPS, readScale, writable } from './appearance';
import { implementArgv } from './argv';

/**
 * The settings screen, and the two dead ends either side of it (#223).
 *
 * Five reports in one pass, and three of them are the same shape: a thing the
 * product knows and does not say. *"Fully build out the settings page… How are
 * we going to handle subscription vs keys in this pane?"*, *"add a section to
 * change the look… the font is a little too small for me"*, *"the prompts being
 * used for each turn should also go there"*, *"remove the prompt tab"*, and a
 * plan-only run that stopped with no way forward.
 */

describe('how big the product is drawn', () => {
  test('a stored scale comes back, and every failure is 1', () => {
    // `localStorage` is one namespace for the whole origin, so a value somebody
    // else wrote is not ours to interpret — and a window that would not render
    // because a string was not a number is worse than text at the size it
    // always was. 1 is exactly what the product shipped as.
    expect(readScale('1.3')).toBe(1.3);
    for (const bad of [null, 'not a number', '', '0', '-2', 'NaN']) {
      expect(readScale(bad)).toBe(1);
    }
  });

  test('a scale outside the range is clamped rather than refused', () => {
    // Still somebody's intention, just further than this offers. Refusing it
    // would silently reset a setting they had chosen.
    expect(readScale('9')).toBe(MAX);
    expect(readScale('0.1')).toBe(MIN);
  });

  test('every step offered is one a stored value round-trips to', () => {
    // The writer and the reader are one function, so a step this screen offers
    // can never be a value the next launch clamps away.
    for (const step of STEPS) {
      expect(readScale(writable(step.scale))).toBe(step.scale);
    }
    expect(STEPS.some((s) => s.scale === 1)).toBe(true);
  });

  test('it scales every size at once rather than body text alone', () => {
    // `tokens.css` multiplies each `--size-*` by `--type-scale`, so the ramp the
    // build spec chose survives being scaled. A control that moved body text
    // alone would leave headings where they were and break the relationships
    // that make a page readable.
    expect(cockpit).toMatch(/setProperty\(SCALE_VAR, String\(scale\)\)/);
  });

  test('the scale is held above the pane that changes it', () => {
    // The Settings pane is conditional and unmounts on every navigation, so a
    // scale that lived in it would snap back to 1 the moment you looked at
    // anything else.
    expect(settings).not.toMatch(/useState.*scale/);
    expect(settings).toMatch(/onScale: \(next: number\) => void/);
  });
});

describe('subscription against keys, which is two questions about two processes', () => {
  test('a run’s agents are stated as having nothing to configure', () => {
    // They are child processes inheriting your own logins. vibe installs
    // neither and holds no credential for either, so a control here would be a
    // promise the app cannot keep.
    expect(settings).toMatch(/Always your own subscriptions, and there is nothing here to set/);
    expect(settings).toMatch(/vibe doctor/);
  });

  test('the keys are named as the pilot’s, and only on the API road', () => {
    expect(settings).toMatch(/the pilot works with none of them/);
    expect(credentials).toMatch(/For the API-backed pilot only/);
  });

  test('no key never reads as “the pilot cannot run”', () => {
    // It said exactly that until #223, and it stopped being true the moment the
    // subscription backend landed — that one is a `claude -p` child and needs no
    // key at all. Telling somebody the pilot was unusable would send them to buy
    // something they do not need.
    //
    // Asserted on the rendered expression rather than the whole file: the
    // comment above it **quotes** the old sentence, on purpose, and a test that
    // matched the file would fail on the explanation of its own fix.
    const from = credentials.indexOf('<span className="v-creds__summary">');
    const summary = credentials.slice(from, credentials.indexOf('</span>', from));
    expect(summary).not.toMatch(/the pilot cannot run/);
    expect(summary).toMatch(/the pilot runs on the subscription/);
  });

  test('the screen says which of the three places a setting goes', () => {
    // A project file that is committed, this window on this machine, and the OS
    // keychain. They are not interchangeable, and a screen that hid the
    // difference would be lying about where a change lands.
    expect(settings).toMatch(/vibe\.config\.json/);
    expect(settings).toMatch(/OS keychain/);
    expect(settings).toMatch(/this machine/);
  });
});

describe('what each turn is told', () => {
  test('the blocks are read from the host, not written in the window', () => {
    // A window holding its own copy of the reviewer's standing instructions
    // would be a second definition of the product's behaviour, drifting from
    // `src/prompts.ts` on the next edit to either.
    expect(settings).toMatch(/host\s*\n?\s*\.prompts\(\)/);
    expect(settings).not.toMatch(/Review breadth/);
  });

  test('it says what it cannot show rather than rendering a prompt from nothing', () => {
    // A prompt is a function of the run — the task, the plan being judged, the
    // findings, the diff — so there is no "implement prompt" outside a run, and
    // one rendered from invented inputs would be the fabrication this repo
    // refuses everywhere else.
    expect(settings).toMatch(/assembled per\n\s*turn/);
    expect(settings).toMatch(/standing/);
  });

  test('the read is lazy, because the blocks are pages and nobody arrives for them', () => {
    expect(settings).toMatch(/usePromptBlocks\(showPrompts\)/);
  });

  test('the Prompt tab is gone, and what it stood for is a section here', () => {
    // *"remove the prompt tab"* and *"the prompts being used for each turn
    // should also go there"* are one instruction, not two.
    expect(cockpit).not.toMatch(/v-cockpit__tab--off/);
    expect(settings).toMatch(/what each turn is told/);
  });
});

describe('a finished plan-only run has somewhere to go', () => {
  test('it continues the run rather than starting one', () => {
    // *"When I asked the pilot, it kicked off another run from scratch"* — which
    // re-derives a plan that exists and carries none of what the plan phase
    // settled. This is a resume with one flag.
    expect(implementArgv('r1', '/repo')).toEqual(['resume', 'r1', '-C', '/repo', '--implement']);
  });

  test('the offer is made on the ending, never by making exit 0 resumable', () => {
    // Exit 0 is not a halt and must not start reading as one. This is a separate
    // labelled act on a run that finished exactly as it was asked to.
    expect(footer).toMatch(/run\.plannedOnly !== null && run\.identity !== null/);
    expect(footer).toMatch(/implement this plan/);
    expect(footer).not.toMatch(/RESUMABLE\.has\(exit\) \|\|/);
  });

  test('a plan carrying P1s says so, whether or not the button is pressed', () => {
    // The tolerance let them through: the plan was accepted DESPITE them. A
    // reader who thinks the plan is clean is reading the wrong thing — which is
    // the same false claim the CLI summary was making from the other side.
    expect(footer).toMatch(/accepted carrying \{run\.plannedOnly\.carried\} P1\(s\) on tolerance/);
    // Absent, not zero, when none were carried.
    expect(footer).toMatch(/run\.plannedOnly\.carried > 0 &&/);
  });

  test('the window is told it was plan-only rather than inferring it', () => {
    // `planOnly` has been durable since `createRun` and was never narrated, so a
    // window could not tell a plan-only run that finished from any other run
    // that finished — and the two want opposite next actions.
    expect(cockpit).toMatch(/implementArgv/);
  });
});
