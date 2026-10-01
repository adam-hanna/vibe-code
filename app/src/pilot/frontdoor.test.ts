import { describe, expect, test } from 'vitest';
import composer from '../cockpit/NewWorkstream.tsx?raw';
import cockpit from '../cockpit/Cockpit.tsx?raw';
import pilotPane from './PilotPane.tsx?raw';

/**
 * Where a freshly typed brief goes (#223).
 *
 * **This file exists because the intake doctrine shipped unreachable.** The
 * prompt telling the pilot to interrogate a request before proposing a run
 * landed, was tested, and changed nothing — because `1b`'s composer went
 * straight to an argv and started the run, so a brief typed into the front door
 * never reached the pilot at all. Reported in one line: *"in the pilot chat, my
 * request didn't show up and the pilot isn't doing anything."*
 *
 * The lesson is the one worth keeping: **a behaviour is only as real as its
 * route**, and `brief.test.ts` could not have caught this, because every one of
 * its assertions is about the prompt rather than about who is sent it. So what
 * is pinned here is the wiring — three hops, each of which was absent.
 *
 * Read from source, like `composer.test.ts` and `saved.test.ts`: the app has no
 * jsdom, and what went wrong was a connection rather than a computation.
 */

describe('the composer hands the brief to the pilot', () => {
  test('submitting is a conversation, not a run', () => {
    // Enter in the brief field reaches the submit handler, so that gesture has
    // to land on the half that spends nothing.
    const onSubmit = composer.slice(
      composer.indexOf('onSubmit={(e) => {'),
      composer.indexOf('}}', composer.indexOf('onSubmit={(e) => {')),
    );
    expect(onSubmit).toContain('onBrief(task.trim())');
    expect(onSubmit).not.toContain('onLaunch(');
  });

  test('the direct launch survives, because the pilot cannot express an override', () => {
    // Not a hedge and not a leftover. `start_run` takes a brief, a directory and
    // plan-only; `launchArgv`'s gate overrides and caps have no field on that
    // tool, so a run needing the overrides block has no conversational route.
    // Removing this button would remove a capability rather than a shortcut —
    // which is why it is checked for, and checked to be clearly labelled.
    expect(composer).toContain('onLaunch(argv)');
    expect(composer).toMatch(/skip the pilot and/);
  });

  test('the primary control is the conversation', () => {
    // `level="primary"` is the one the eye lands on and the one Enter triggers.
    // A direct launch wearing it would make "I don't want the run to start
    // automatically" false again by default.
    const primary = composer.slice(composer.indexOf('level="primary"'));
    expect(primary).toContain('talk it through');
  });
});

describe('the cockpit carries it across', () => {
  test('the brief is handed over and the tab moves with it', () => {
    // A conversation nobody is looking at is the same as no conversation: the
    // report was partly that nothing appeared, and the pilot tab not being open
    // is one of the two ways that happens.
    const handler = cockpit.slice(cockpit.indexOf('onBrief={(task) => {'));
    expect(handler).toContain('setBrief(task)');
    expect(handler).toContain("open('pilot')");
  });

  test('the pane is given it, and given the way to clear it', () => {
    const pane = cockpit.slice(cockpit.indexOf('<PilotPane'), cockpit.indexOf('onPending='));
    expect(pane).toContain('ask={brief}');
    expect(cockpit).toContain('onAsked={() => setBrief(null)}');
  });
});

describe('the pane says it as something a person said', () => {
  test('it reaches `start` with the text as what was asked, never as a wake', () => {
    // `start(messages, said, woke)` decides how the reply is drawn: a `woke` turn
    // is labelled as one the app caused, and this one was typed. Drawing it as a
    // wake would put *"the app woke you"* above a brief somebody wrote.
    const effect = pilotPane.slice(
      pilotPane.indexOf('const asked = useRef<string | null>(null);'),
      pilotPane.indexOf('onAsked?.();'),
    );
    expect(effect).toContain("{ role: 'user' as const, content: want }");
    expect(effect).toContain('start([...conversation.messages');
    expect(effect).not.toMatch(/wakeReason|'wake'/);
  });

  test('it cannot say the same brief twice', () => {
    // Keyed on the VALUE rather than on having run, so StrictMode's second pass
    // finds it already said. A brief sent twice is two planner-sized
    // conversations and a proposal card for each.
    const effect = pilotPane.slice(
      pilotPane.indexOf('const asked = useRef<string | null>(null);'),
      pilotPane.indexOf('onAsked?.();'),
    );
    expect(effect).toContain('want === asked.current');
    expect(effect).toContain('asked.current = want');
  });

  test('it defers rather than dropping when the pane cannot send', () => {
    // No repository, an outstanding proposal, a spent ceiling. Clearing `ask` in
    // those states would lose the brief at the one moment somebody is watching
    // for it; leaving it alone means the effect fires when `ready` flips, and the
    // composer already draws the reason send is off.
    const effect = pilotPane.slice(
      pilotPane.indexOf('const asked = useRef<string | null>(null);'),
      pilotPane.indexOf('onAsked?.();'),
    );
    expect(effect).toContain('if (!ready || live !== null) return;');
    // `ready` in the deps is what makes "defer" true rather than aspirational.
    const deps = pilotPane.slice(pilotPane.indexOf('onAsked?.();'));
    expect(deps).toMatch(/\}, \[ask, ready, live, conversation\.messages, start, onAsked\]\);/);
  });
});
