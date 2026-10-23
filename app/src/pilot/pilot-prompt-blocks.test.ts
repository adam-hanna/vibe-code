import { describe, expect, test } from 'vitest';
import { PILOT_BLOCK, inForce, pilotPromptBlocks, resolvePilotBlock, systemPrompt } from './brief';
import { emptyRun } from '../cockpit/model';
import type { Launched } from '../cockpit/argv';
import settings from '../cockpit/Settings.tsx?raw';
import cockpit from '../cockpit/Cockpit.tsx?raw';
import pane from './PilotPane.tsx?raw';

/**
 * The pilot's own prompt is edited in Settings -> Prompts like the core's
 * blocks (#420).
 *
 * #356 decided a project's branch-naming standard is something the person
 * tells the pilot, and nothing the pilot was told could be edited. The fixed
 * prose became `pilot: <block>` entries in the same `prompts` table; what is
 * assembled per turn stays code.
 */

const launched: Launched = { task: 'add a dark mode', dir: '/repo', planOnly: false };
const built = (prompts: unknown = null): string =>
  systemPrompt(emptyRun(), launched, 'emitted', null, 'claude', 'Use gh for GitHub.', prompts);

const RULE = 'Branches are named feat/<issue>-<slug>; propose --branch with that name.';

describe('an adopted block replaces the built-in one', () => {
  test('each block, alone, and the built-in text is gone rather than appended to', () => {
    for (const block of pilotPromptBlocks(null)) {
      const prompt = built({ [block.name]: RULE });
      expect(prompt).toContain(RULE);
      expect(prompt).not.toContain(block.fallback);
      // The other two are still the built-ins.
      for (const other of pilotPromptBlocks(null)) {
        if (other.name !== block.name) expect(prompt).toContain(other.fallback);
      }
    }
  });

  test('an edited intake keeps its place: before the run block', () => {
    const prompt = built({ [PILOT_BLOCK.intake]: RULE });
    expect(prompt.indexOf(RULE)).toBeLessThan(prompt.indexOf('## The run, as this window holds it'));
  });

  test('with nothing stored, the prompt is byte-identical to the one before this existed', () => {
    const before = systemPrompt(emptyRun(), launched, 'emitted', null, 'claude', 'Use gh for GitHub.');
    expect(built(null)).toBe(before);
    expect(built({})).toBe(before);
    // A table holding only the core's blocks reaches no pilot block.
    expect(built({ 'review breadth': 'only what I named' })).toBe(before);
  });
});

describe('clearing restores the built-in', () => {
  test('a blank entry is the built-in, as a blank core override is', () => {
    const none = built(null);
    expect(built({ [PILOT_BLOCK.who]: '' })).toBe(none);
    expect(built({ [PILOT_BLOCK.intake]: '  \n ' })).toBe(none);
    const r = resolvePilotBlock(PILOT_BLOCK.intake, { [PILOT_BLOCK.intake]: '' });
    expect(r.overridden).toBe(false);
    expect(r.problem).toBeNull();
  });
});

describe('an invalid stored value falls back to the built-in, and says so', () => {
  test('never to an empty prompt', () => {
    const none = built(null);
    for (const bad of [42, true, ['x'], { nested: 'x' }]) {
      expect(built({ [PILOT_BLOCK.intake]: bad })).toBe(none);
      const r = resolvePilotBlock(PILOT_BLOCK.intake, { [PILOT_BLOCK.intake]: bad });
      expect(r.text).toBe(r.fallback);
      expect(r.overridden).toBe(false);
      expect(r.problem).toMatch(/pilot: intake.*built-in/);
    }
  });

  test('a prompts setting that is not a table is every built-in, said once per block', () => {
    for (const bad of ['a string', 7, ['pilot: who']]) {
      expect(built(bad)).toBe(built(null));
      for (const block of pilotPromptBlocks(bad)) expect(block.problem).toMatch(/not a table/);
    }
  });

  test('the same rule answers for a core block', () => {
    expect(inForce('review breadth', 'DEFAULT', { 'review breadth': 3 }).text).toBe('DEFAULT');
    expect(inForce('review breadth', 'DEFAULT', { 'review breadth': 'mine' })).toEqual({
      text: 'mine',
      overridden: true,
      problem: null,
    });
  });
});

describe('the dynamic parts are never replaced', () => {
  test('a table naming them changes nothing, and they are still built from the window', () => {
    // These are the names a person might guess at. None is a pilot block, so
    // none can stand in for what is assembled per turn.
    const guesses = {
      'pilot: run': 'X',
      'pilot: tools': 'X',
      'pilot: access': 'X',
      'pilot: how to call': 'X',
      'pilot: what was asked': 'X',
      'pilot: standing': 'X',
    };
    const prompt = built(guesses);
    expect(prompt).toBe(built(null));
    expect(prompt).toContain('add a dark mode');
    expect(prompt).toContain('## The run, as this window holds it');
    expect(prompt).toContain('## What runs without asking');
    expect(prompt).toContain('## Calling a tool');
    expect(prompt).toContain('## What you can do yourself');
    expect(prompt).toContain('Use gh for GitHub.');
  });

  test('every block replaced at once still leaves every dynamic part', () => {
    const all = Object.fromEntries(pilotPromptBlocks(null).map((b) => [b.name, RULE]));
    const prompt = built(all);
    for (const part of [
      '## What was asked for',
      'add a dark mode',
      '## The run, as this window holds it',
      '## What you can do yourself',
      '## What runs without asking',
      '## Calling a tool',
      '## Standing instructions',
    ]) {
      expect(prompt).toContain(part);
    }
  });

  test('exactly three blocks, named as the pilot’s', () => {
    expect(pilotPromptBlocks(null).map((b) => b.name)).toEqual([
      'pilot: who',
      'pilot: intake',
      'pilot: how to read',
    ]);
    for (const b of pilotPromptBlocks(null)) {
      expect(b.usedBy).toEqual(['pilot']);
      expect(b.fallback.trim()).not.toBe('');
    }
  });
});

describe('the window carries the table to the pilot and the screen', () => {
  test('from the config read the pilot already takes its standing instructions from', () => {
    expect(cockpit).toContain('setPilotPrompts(effective.prompts ?? null)');
    expect(cockpit).toContain('pilotPrompts={pilotPrompts}');
    // Case 2 (#438): the call gained the conversation's binding after the
    // blocks, so both are matched up to their comma rather than to the end.
    expect(pane).toContain('standing ?? null, pilotPrompts ?? null,');
    // A change in Settings reaches a conversation already open.
    expect(pane).toContain('[model, provider, run, launched, dir, access, standing, pilotPrompts,');
  });

  test('Settings lists the pilot blocks under a heading of their own', () => {
    expect(settings).toContain('<h4 className={S.h}>pilot</h4>');
    expect(settings).toContain('pilotPromptBlocks(effective.prompts).map(drawPromptBlock)');
    // Adopted, cleared and saved the same way as the core's: one renderer.
    expect(settings.match(/<PromptBlock\b/g)).toHaveLength(1);
    expect(settings).toContain('save({ prompts: { [name]: text } })');
    // And the screen says where a branch-naming standard goes.
    expect(settings).toContain('<code>pilot: intake</code>');
  });

  test('what is in force is read off the config, for the core blocks too', () => {
    expect(settings).toContain('inForce(b.name, b.fallback, effective.prompts)');
    expect(settings).toContain('<Badge variant="alarm">not used</Badge>');
  });
});
