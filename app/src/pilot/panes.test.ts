import { describe, expect, test } from 'vitest';
import cockpit from '../cockpit/Cockpit.tsx?raw';
import pane from './PilotPane.tsx?raw';
import { markLaunched, newDraft } from '../cockpit/pending';
import type { Draft } from '../cockpit/pending';
import { askFor, draftOfPane, mountedPanes, paneOf } from './panes';
import { chatKey } from './saved';

/**
 * Two drafts' pilot conversations no longer cross (#305).
 *
 * The report: two runs started from the dialog twenty seconds apart, #298 and
 * then #230. Both briefs were stored as the first draft's two messages, the
 * second draft had no conversation at all, and the one reply that came back
 * was saved nowhere. One pane held one conversation and one turn, and every
 * result landed in whichever conversation it held when the result arrived.
 */

const DIR = '/home/me/repo';
const a = newDraft(DIR, 'Tackle github issue 298', 1_000, 'aaaaaa');
const b = newDraft(DIR, 'Tackle github issue 230', 21_000, 'bbbbbb');
const keyA = chatKey(DIR, a.id);
const keyB = chatKey(DIR, b.id);

describe('each conversation is its own pane', () => {
  test('two drafts are two panes', () => {
    expect(paneOf({ dir: DIR, runId: a.id }, [a, b])).toBe(keyA);
    expect(paneOf({ dir: DIR, runId: b.id }, [a, b])).toBe(keyB);
  });

  test('a run that started from a draft stays in the draft’s pane', () => {
    // So a reply still streaming when the run adopts the conversation lands
    // in the pane that is now showing the run, not one nobody will open again.
    const bound: Draft = { ...markLaunched([a], a.id)[0]!, runId: '20261008-run' };
    expect(paneOf({ dir: DIR, runId: '20261008-run' }, [bound])).toBe(keyA);
    expect(paneOf({ dir: `${DIR}/`, runId: '20261008-run' }, [bound])).toBe(keyA);
  });

  test('any other run is its own key', () => {
    expect(paneOf({ dir: DIR, runId: 'some-run' }, [a])).toBe(chatKey(DIR, 'some-run'));
    expect(paneOf({ dir: DIR, runId: null }, [a])).toBe(chatKey(DIR, null));
  });
});

describe('which panes stay mounted', () => {
  test('switching from one draft to the other keeps the first', () => {
    // The first draft's turn is still out; unmounting its pane would lose it.
    expect(mountedPanes(keyB, [keyA, keyB], new Set(), [a, b])).toEqual([keyB, keyA]);
  });

  test('a busy pane stays mounted, an idle one that is not a draft is let go', () => {
    const run = chatKey(DIR, 'some-run');
    const other = chatKey(DIR, 'other-run');
    expect(mountedPanes(keyA, [run, other, keyA], new Set([run]), [a])).toEqual([keyA, run]);
  });

  test('a discarded draft is let go even while busy', () => {
    // Its conversation was deleted with it; a reply saved afterwards would
    // bring the conversation back under a key nothing points at.
    expect(mountedPanes(keyB, [keyA, keyB], new Set([keyA]), [b])).toEqual([keyB]);
  });

  test('the pane on screen is always first and never doubled', () => {
    expect(mountedPanes(keyA, [keyA, keyB], new Set([keyA]), [a, b])).toEqual([keyA, keyB]);
    expect(mountedPanes(keyA, [], new Set(), [])).toEqual([keyA]);
  });
});

describe('what reaches each pane', () => {
  test('a brief goes only to the draft it was typed for', () => {
    const brief = { id: b.id, message: 'Tackle github issue 230' };
    expect(askFor(brief, { dir: DIR, runId: b.id })).toBe(brief);
    expect(askFor(brief, { dir: DIR, runId: a.id })).toBeNull();
    expect(askFor(null, { dir: DIR, runId: b.id })).toBeNull();
  });

  test('a proposal starts the run its own draft asked for, never the one on screen', () => {
    expect(draftOfPane(keyA, [a, b])).toBe(a.id);
    expect(draftOfPane(keyB, [a, b])).toBe(b.id);
    expect(draftOfPane(chatKey(DIR, 'some-run'), [a, b])).toBeNull();
  });

  test('a draft that already became a run is not claimed again', () => {
    const bound: Draft = { ...markLaunched([a], a.id)[0]!, runId: '20261008-run' };
    expect(draftOfPane(keyA, [bound])).toBeNull();
  });
});

describe('the wiring that the pure half depends on', () => {
  // The app has no jsdom, so the two components are pinned as source.
  test('the cockpit mounts a pane per conversation and routes by pane', () => {
    expect(cockpit).toMatch(/panes\.map\(\(pane\) =>/);
    expect(cockpit).toMatch(/background=\{!visible\}/);
    expect(cockpit).toMatch(/ask=\{askFor\(brief, at\)\}/);
    expect(cockpit).toMatch(/onEffect=\{hooksFor\(pane\)\.effect\}/);
    expect(cockpit).toMatch(/onPending=\{visible \? setProposals : undefined\}/);
    // One `<PilotPane`, inside the map: never a second, unrouted one.
    expect(cockpit.match(/<PilotPane\b/g)).toHaveLength(1);
  });

  test('an API turn’s end stops only the pane holding that turn', () => {
    expect(pane).toMatch(/setLive\(\(at\) => \(at === event\.turn \? null : at\)\)/);
    expect(pane).not.toMatch(/if \(pilot\.isFinal\(event\)\) setLive\(null\)/);
  });

  test('a background pane wakes for nothing', () => {
    expect(pane).toMatch(/if \(background \|\| !ready \|\| live !== null\) return;/);
    expect(pane).toMatch(/if \(background\) \{/);
  });

  test('the books are read fresh before a turn is recorded', () => {
    // Two panes each holding a copy of the ledger would erase each other's spend.
    expect(pane).toMatch(/let next = readLedger\(\);/);
  });

  test('a pane is busy from the request, not only from the id', () => {
    expect(pane).toMatch(/setOpening\(\(n\) => n \+ 1\)/);
    expect(pane.match(/\.finally\(\(\) => setOpening\(\(n\) => n - 1\)\)/g)).toHaveLength(2);
  });
});
