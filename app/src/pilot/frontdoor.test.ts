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
    // Enter in the brief field reaches the submit handler, and so does the one
    // button, so that gesture has to land on the half that spends nothing. The
    // settings go WITH the brief, which is how the overrides block still reaches
    // a run now that this modal launches nothing itself.
    const onSubmit = composer.slice(
      composer.indexOf('onSubmit={(e) => {'),
      composer.indexOf('}}', composer.indexOf('onSubmit={(e) => {')),
    );
    expect(onSubmit).toContain('onBrief(briefFor(task, planOnly, overrides), task.trim())');
    expect(onSubmit).not.toContain('onLaunch(');
  });

  test('there is one way out, and it is not a launch', () => {
    // **Reversed at the owner's decision**, and the old case is worth stating
    // because it was right when it was written: `skip the pilot` was kept since
    // `start_run` could not carry an override, so removing it removed a
    // capability. Asked for directly — *"There should only be one start button
    // and it should follow the 'talk it through' path"* — and `start_run` now
    // takes the overrides, so the capability moved rather than went. What is
    // pinned is the absence: no launch callback, no argv, nothing a person could
    // press here that starts a run without the pilot's card in between.
    expect(composer).not.toMatch(/onLaunch/);
    expect(composer).not.toMatch(/launchArgv/);
    // The button's own wording; the comment above `onBrief` names it as history.
    expect(composer).not.toMatch(/skip the pilot and/);
    expect(composer).not.toMatch(/v-new__argv/);
    // And the cockpit no longer hands the composer a way to launch.
    const wiring = cockpit.slice(
      cockpit.indexOf('<NewWorkstream'),
      cockpit.indexOf('/>', cockpit.indexOf('<NewWorkstream')),
    );
    expect(wiring).not.toContain('onLaunch');
  });

  test('the one control describes the conversation it actually starts', () => {
    // `variant="primary"` is the one the eye lands on and the one Enter
    // triggers, and it is the only button besides cancel. Case 2 (the UI
    // rework): the foot is found by its utilities and the button by the new
    // Button's `variant` prop; the claim is unchanged.
    const foot = composer.slice(composer.indexOf('className="flex justify-end gap-2 border-t'));
    expect(foot.length).toBeGreaterThan(0);
    // A run starts later, on the pilot's proposal. Calling this "start" hid
    // that distinction; the new wording makes the existing behavior explicit.
    expect(foot).toMatch(/variant="primary" type="submit"[^>]*>\s*Discuss with pilot\s*</);
    expect(foot.match(/<Button/g)).toHaveLength(2);
  });
});

describe('the cockpit carries it across', () => {
  test('the brief is handed over and the tab moves with it', () => {
    // A conversation nobody is looking at is the same as no conversation: the
    // report was partly that nothing appeared, and the pilot tab not being open
    // is one of the two ways that happens.
    // Through `queued`, one commit later, so the pane is already holding the
    // new draft's conversation when the brief is said into it.
    const handler = cockpit.slice(cockpit.indexOf('onBrief={(message, task) => {'));
    expect(handler).toContain('setQueued(message)');
    expect(cockpit).toContain('setBrief(queued)');
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
