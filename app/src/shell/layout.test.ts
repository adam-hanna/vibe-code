import { describe, expect, test } from 'vitest';
import cockpit from '../cockpit/Cockpit.tsx?raw';
import bar from './ActivityBar.tsx?raw';
import palette from './Palette.tsx?raw';
import status from './StatusBar.tsx?raw';

/**
 * The shell (the UI rework): activity bar, resizable regions, bottom panel,
 * status bar, palette. Source-read, because the claims are about wiring and
 * the app has no jsdom.
 *
 * This replaces `sidepanel.test.ts`. Case 2 of AGENTS.md's two: the widths it
 * pinned were `SidePanel`'s own arithmetic, and `SidePanel` is gone - the
 * regions are `react-resizable-panels` groups now, and what is persisted is
 * every group's layout plus which panels are shut, through `where.ts`, which
 * has its own cases.
 */

describe('the activity bar', () => {
  test('keeps the rail’s three controls on screen at every width', () => {
    // `design/AUDIT.md` §1.1: `＋ ⌘K ⚙` had nowhere to live. They live here.
    expect(bar).toMatch(/label="New run"/);
    expect(bar).toMatch(/Find a run or action/);
    expect(bar).toMatch(/label="Settings for all projects"/);
    // Each is a labelled control, not a bare icon.
    expect(bar).toMatch(/aria-label=\{label\}/);
    expect(cockpit).toMatch(/<ActivityBar/);
    expect(cockpit).not.toMatch(/<SidePanel/);
  });
});

describe('the regions', () => {
  test('are resizable groups whose layout is saved on a user drag, never on a window resize', () => {
    expect(cockpit).toMatch(/<ResizableGroup\s+id="shell"\s+orientation="horizontal"/);
    expect(cockpit).toMatch(/<ResizableGroup\s+id="center"\s+orientation="vertical"/);
    // `isUserInteraction` is the guard: a layout the library recomputed after a
    // window resize is not a decision anybody made.
    expect(cockpit).toMatch(/if \(!meta\.isUserInteraction\) return;/);
  });

  test('output and commands are the bottom panel, and a round card can still open them', () => {
    expect(cockpit).toMatch(/panels\.bottom && \(/);
    expect(cockpit).toMatch(/bottom === 'output' && \(/);
    expect(cockpit).toMatch(/bottom === 'commands' && \(/);
    // `open('output')` from a card lands on the bottom panel rather than on a
    // main tab this build no longer has.
    expect(cockpit).toMatch(/if \(next === 'output' \|\| next === 'commands'\)/);
  });
});

describe('the status bar', () => {
  test('names a protocol disagreement and never the bare value', () => {
    expect(status).toMatch(/protocol \{protocol\} · expected \{expected\}/);
    expect(status).not.toMatch(/HOST \{/);
  });

  test('says nothing rather than zero before anything is charged', () => {
    expect(status).toMatch(/run\.spend\.tokens === null \? 'no usage reported'/);
  });

  test('answers a held gate from the bar, and the full card stays in the column', () => {
    expect(status).toMatch(/onDecide\(run\.gate\.askId, \{ kind: 'continue' \}\)/);
    expect(cockpit).toMatch(/<Footer\s+run=\{columnRun\}/);
  });
});

describe('the palette', () => {
  test('opens a run and never starts one', () => {
    // The switcher it replaces called `resume` on pick. A pick is a read.
    expect(palette).toMatch(/onOpenRun\(run\.id, run\.task\)/);
    expect(palette).not.toMatch(/resume\(/);
    expect(palette).not.toMatch(/invoke/);
    expect(cockpit).toMatch(/onOpenRun=\{\(runId, task\) => \{/);
  });
});
