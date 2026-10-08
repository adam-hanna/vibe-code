import { describe, expect, test } from 'vitest';
import { standingBlock, systemPrompt } from './brief';
import { emptyRun } from '../cockpit/model';
import settings from '../cockpit/Settings.tsx?raw';
import cockpit from '../cockpit/Cockpit.tsx?raw';
import pane from './PilotPane.tsx?raw';

/**
 * Standing instructions reach the pilot as well as the run's agents (#273).
 *
 * The pilot runs `--restricted` on the subscription road, which ignores the
 * user's own CLAUDE.md, and on the API road it has no files at all, so without
 * this it was the one agent that never saw the person's rules.
 */
const RULE = 'Use the gh CLI for GitHub. Never push to main.';

describe('the pilot is told them', () => {
  test('in its system prompt, right after who it is', () => {
    const prompt = systemPrompt(emptyRun(), null, 'native', null, null, RULE);
    expect(prompt).toContain('## Standing instructions');
    expect(prompt).toContain(RULE);
    expect(prompt.indexOf(RULE)).toBeLessThan(prompt.indexOf('## The run, as this window holds it'));
  });

  test('and nothing changes when there are none', () => {
    const none = systemPrompt(emptyRun(), null, 'native', null, null);
    expect(systemPrompt(emptyRun(), null, 'native', null, null, null)).toBe(none);
    expect(systemPrompt(emptyRun(), null, 'native', null, null, '  \n ')).toBe(none);
    expect(standingBlock('')).toEqual([]);
  });

  test('on both roads, from the settings the window already reads', () => {
    expect(pane).toMatch(/systemPrompt\(run, launched, 'emitted', access, agentOf\(provider\), standing \?\? null\)/);
    expect(pane).toMatch(/systemPrompt\(run, launched, 'native', access, null, standing \?\? null\)/);
    // A change in Settings has to reach a conversation already open.
    expect(pane).toContain('[model, provider, run, launched, dir, access, standing]');
    expect(cockpit).toContain('setStanding(typeof text === \'string\' ? text : null)');
    expect(cockpit).toContain('standing={standing}');
  });
});

describe('the settings screen', () => {
  test('has the box, saved on blur, and a cleared box writes null so the level below shows', () => {
    expect(settings).toContain('<h3 className={S.h}>standing instructions</h3>');
    expect(settings).toContain('<Key name="instructions.text" />');
    expect(settings).toContain("save({ instructions: { text: next.trim() === '' ? null : next } })");
  });
});
