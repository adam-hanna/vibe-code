import { describe, expect, test } from 'vitest';
import cockpit from './Cockpit.tsx?raw';
import sidebar from './Sidebar.tsx?raw';
import pane from '../pilot/PilotPane.tsx?raw';
import {
  addDraft,
  bindDraft,
  draftsIn,
  isDraftId,
  draftTitle,
  markLaunched,
  namesAfterStart,
  newDraft,
  readDrafts,
  removeDraft,
  settled,
} from './pending';
import { chatKey, chatMove, isDraftKey } from '../pilot/saved';

/**
 * A run exists from the moment somebody presses start (#223).
 *
 * Reported as three symptoms of one gap: *"The run should appear on the left,
 * under the project directly after hitting start. Then, when the agent actually
 * starts the vibe run or vibe plan command, a new run shouldn't appear, its
 * already there. Also, the previous chat history shouldnt go away at that point
 * either."* The core has nothing until the pilot's proposal is pressed, so the
 * window draws a draft in between and hands it to the run when it starts.
 */

const repo = '/home/me/apps/erm';

describe('a draft is this window\'s memory of a run not started yet', () => {
  test('its id can never be mistaken for a run id', () => {
    const d = newDraft(repo, '  fix 236\n', 1000, 'abc');
    expect(isDraftId(d.id)).toBe(true);
    expect(isDraftId('20261001-105056-fix-github-issue-236')).toBe(false);
    expect(d.task).toBe('fix 236');
    expect(d).toMatchObject({ launched: false, runId: null });
  });

  test('a list survives a round trip, and anything unreadable is dropped', () => {
    const d = newDraft(repo, 't', 1, 'x');
    expect(readDrafts(JSON.stringify([d]))).toEqual([d]);
    expect(readDrafts('not json')).toEqual([]);
    expect(readDrafts(JSON.stringify([{ ...d, id: 'not-a-draft' }, { dir: 3 }]))).toEqual([]);
  });

  test('only a launched, unclaimed draft can be bound to a run', () => {
    const d = newDraft(repo, 't', 1, 'x');
    // Not launched: a run that started some other way does not swallow it.
    expect(bindDraft([d], d.id, 'R')[0]?.runId).toBeNull();
    const launched = markLaunched([d], d.id);
    expect(bindDraft(launched, d.id, 'R')[0]?.runId).toBe('R');
    // Claimed once; a second run cannot take it over.
    const bound = bindDraft(launched, d.id, 'R');
    expect(bindDraft(bound, d.id, 'S')[0]?.runId).toBe('R');
  });

  test('one draft is waiting at a time', () => {
    const a = newDraft(repo, 'a', 1, 'a');
    const b = newDraft(repo, 'b', 2, 'b');
    const list = markLaunched(markLaunched([a, b], a.id), b.id);
    expect(list.map((d) => d.launched)).toEqual([false, true]);
  });

  test('a project draws its drafts until the archive lists the run, then lets go', () => {
    const d = { ...newDraft(repo, 't', 1, 'x'), launched: true, runId: 'R' };
    const other = newDraft('/elsewhere', 'u', 2, 'y');
    const list = addDraft([other], d);
    // Before the archive has it: drawn, in its own project only.
    expect(draftsIn(list, `${repo}/`, [])).toEqual([d]);
    expect(settled(list, repo, [])).toEqual([]);
    // Once it does: the archive's row is the run, so the draft is not drawn
    // beside it, and it is settled.
    expect(draftsIn(list, repo, ['R'])).toEqual([]);
    expect(settled(list, repo, ['R'])).toEqual([d.id]);
    expect(removeDraft(list, d.id)).toEqual([other]);
  });
});

describe('the conversation goes with it', () => {
  const draftKey = chatKey(repo, 'draft-1-x');
  const runKey = chatKey(repo, 'R');

  test('arriving at a draft restores ITS conversation, never adopts the one on screen', () => {
    // A new draft starts empty: the previous chat must not ride into it.
    expect(
      chatMove({ from: chatKey(repo, null), to: draftKey, intoRun: true, opened: true, stored: false, holding: true }),
    ).toBe('restore');
  });

  test('leaving a draft for the run it started is a start, so the run adopts', () => {
    expect(
      chatMove({ from: draftKey, to: runKey, intoRun: true, opened: false, stored: false, holding: true }),
    ).toBe('adopt');
    expect(isDraftKey(draftKey)).toBe(true);
    expect(isDraftKey(runKey)).toBe(false);
  });

  test('the pane removes the draft\'s copy once the run holds it', () => {
    const adopt = pane.slice(pane.indexOf("if (move === 'adopt') {"));
    // Through `putChat` since the store moved to the host's files (#223).
    expect(adopt).toContain('isDraftKey(before)) putChat(before, null)');
  });
});

describe('the cockpit wires it', () => {
  test('start makes the draft and points the pane at it before the brief is said', () => {
    // `title` joined the signature in #262; the handler is found by its new one.
    const at = cockpit.indexOf('onBrief={(message, task, title) => {');
    expect(at).toBeGreaterThan(-1);
    const handler = cockpit.slice(at);
    expect(handler).toMatch(/slice\(2, 8\),\s*title,\s*\);/);
    expect(handler).toContain('saveDrafts((list) => addDraft(list, draft))');
    expect(handler).toContain('setDraftId(draft.id)');
    expect(handler).toContain('setQueued(message)');
  });

  test('the pilot pane is keyed by the draft, and a draft counts as pointed-at', () => {
    // Through `pilotRunId` since #223: outside a launch's hold it is exactly the
    // draft first and then the run on screen, and `opened` is unchanged there.
    expect(cockpit).toContain('runId={pilotRunId}');
    expect(cockpit).toContain(
      'const pilotRunId = holdChat !== null ? holdChat.runId : (drafting?.id ?? shownRunId);',
    );
    expect(cockpit).toContain('opened={holdChat === null && (viewing !== null || drafting !== null)}');
  });

  test('only the pilot\'s invoke can claim a draft', () => {
    // A resume or an implement also go through `launch`; neither is the run a
    // draft asked for.
    expect(cockpit).toContain("if (effect.kind === 'invoke') launch(effect.argv, draftId);");
    expect(cockpit).toMatch(/resumeArgv[\s\S]*launch\(argv\);/);
    const bind = cockpit.slice(cockpit.indexOf('const startedId = '));
    expect(bind).toContain('if (launchedFrom.current !== drafting.id) return;');
  });

  test('the sidebar draws a draft among the project\'s runs, and discarding confirms', () => {
    expect(sidebar).toContain('<DraftRow');
    expect(sidebar).toContain("pending.kind === 'draft'");
  });
});

describe('a run can be named when it is started, and keeps the name (#262)', () => {
  test('a typed title names the row, and an empty one leaves it named from the brief', () => {
    const named = newDraft(repo, 'fix the flaky gate\nlots more detail', 1, 'x', '  Gate flake  ');
    expect(named.name).toBe('Gate flake');
    expect(draftTitle(named)).toBe('Gate flake');
    const plain = newDraft(repo, 'fix the flaky gate\nlots more detail', 1, 'x', '   ');
    expect(plain.name).toBeNull();
    expect(draftTitle(plain)).toBe('fix the flaky gate');
  });

  test('the title survives a round trip, and an old draft without one reads as none', () => {
    const named = newDraft(repo, 't', 1, 'x', 'mine');
    expect(readDrafts(JSON.stringify([named]))).toEqual([named]);
    const { name: _gone, ...old } = newDraft(repo, 't', 1, 'y');
    expect(readDrafts(JSON.stringify([old]))[0]?.name).toBeNull();
  });

  test('when the draft becomes a run, its title becomes the run\'s name, and only then', () => {
    const named = { ...newDraft(repo, 't', 1, 'x', 'mine'), launched: true };
    expect(namesAfterStart([], named, 'R1')).toEqual([{ dir: repo, runId: 'R1', name: 'mine' }]);
    const plain = { ...newDraft(repo, 't', 1, 'y'), launched: true };
    const existing = [{ dir: repo, runId: 'R0', name: 'older' }];
    expect(namesAfterStart(existing, plain, 'R1')).toBe(existing);
  });

  test('the cockpit writes it when the draft is bound, and the rows draw it', () => {
    const bind = cockpit.slice(cockpit.indexOf('bindDraft(list, drafting.id, startedId)'));
    expect(bind).toMatch(/namesAfterStart\(readNames\(memory\.getItem\(NAMES_KEY\)\), drafting, startedId\)/);
    expect(sidebar).toContain('title={draftTitle(d)}');
  });
});
