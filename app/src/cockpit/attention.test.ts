import { describe, expect, test } from 'vitest';
import sidebar from './Sidebar.tsx?raw';
import types from '../../../src/types.ts?raw';
import { ATTENTION, draftAttention, runAttention, statusAttention } from './attention';
import { emptyConversation } from '../pilot/transcript';
import type { Conversation, Reply } from '../pilot/transcript';

/**
 * Which sidebar rows are waiting on a person, and which are working (#307).
 *
 * The report: *"we need a way for a user to know that a run requires a user
 * input or action. Either the pilot is asking questions during the draft phase,
 * or a question has been asked requiring user input, or a run has paused
 * because it hit some limit"* - and, beside it, that a run's dot had stopped
 * blinking while it worked.
 */

const row = { gate: false, status: null as string | null, live: false, current: false };

describe('a run row', () => {
  test('a held gate is said first', () => {
    expect(runAttention({ ...row, gate: true, live: true })).toBe('gate');
    expect(runAttention({ ...row, gate: true, status: 'stalled' })).toBe('gate');
  });

  test('a run that stopped says how', () => {
    expect(runAttention({ ...row, status: 'needs-input' })).toBe('needs-input');
    expect(runAttention({ ...row, status: 'stalled' })).toBe('stalled');
    expect(runAttention({ ...row, status: 'error' })).toBe('failed');
  });

  test('a run going, or done, asks nothing', () => {
    for (const status of ['planning', 'implementing', 'reviewing', 'planned', 'done']) {
      expect(runAttention({ ...row, status })).toBeNull();
    }
  });

  test('a running run’s status is not read - it may predate the resume', () => {
    expect(runAttention({ ...row, status: 'stalled', live: true })).toBeNull();
  });

  test('the row on screen draws its own state, so it gets no badge', () => {
    expect(runAttention({ ...row, gate: true, current: true })).toBeNull();
    expect(runAttention({ ...row, status: 'needs-input', current: true })).toBeNull();
  });

  test('every RunStatus the core has is either named here or deliberately not', () => {
    // A sixth halting status added in the core must be decided here, not
    // silently drawn as nothing.
    const block = types.slice(types.indexOf('export type RunStatus ='), types.indexOf(';', types.indexOf('export type RunStatus =')));
    const statuses = [...block.matchAll(/'([a-z-]+)'/g)].map((m) => m[1] ?? '');
    expect(statuses.sort()).toEqual(
      ['done', 'error', 'implementing', 'needs-input', 'planned', 'planning', 'reviewing', 'stalled'].sort(),
    );
    expect(statuses.filter((s) => statusAttention(s) !== null).sort()).toEqual(['error', 'needs-input', 'stalled']);
  });
});

const reply = (calls: Reply['calls'] = []): Reply =>
  ({
    turn: 1,
    provider: 'subscription',
    model: null,
    text: 'x',
    calls,
    usage: null,
    outcome: { kind: 'ended', stop: null },
    startedAt: null,
  }) as unknown as Reply;

const conv = (patch: Partial<Conversation>): Conversation => ({ ...emptyConversation(), ...patch });

describe('a draft', () => {
  test('nothing said yet asks nothing', () => {
    expect(draftAttention(emptyConversation())).toBeNull();
  });

  test('the person’s message last means the pilot is on it', () => {
    expect(draftAttention(conv({ messages: [{ role: 'user', content: 'Tackle #298' }] }))).toBeNull();
  });

  test('the pilot’s reply last means it is your turn', () => {
    const c = conv({
      messages: [
        { role: 'user', content: 'Tackle #298' },
        { role: 'assistant', content: 'Two questions first…' },
      ],
      replies: [reply()],
    });
    expect(draftAttention(c)).toBe('reply');
  });

  test('a tool result last means the pilot is carrying on', () => {
    const c = conv({
      messages: [
        { role: 'user', content: 'Tackle #298' },
        { role: 'assistant', content: '', calls: [] },
        { role: 'tool', id: 'c1', name: 'read_file', content: '…' },
      ],
    });
    expect(draftAttention(c)).toBeNull();
  });

  test('a proposal with no result is a decision waiting', () => {
    const call = { id: 'c1', name: 'start_run', arguments: '{}', input: {}, unreadable: null, settlement: { kind: 'proposes' } };
    const c = conv({
      messages: [
        { role: 'user', content: 'Tackle #298' },
        { role: 'assistant', content: 'Here is the run.' },
      ],
      replies: [reply([call] as unknown as Reply['calls'])],
    });
    expect(draftAttention(c)).toBe('proposal');
  });
});

describe('the sidebar draws it', () => {
  test('every attention has a label and a reason', () => {
    for (const { label, why } of Object.values(ATTENTION)) {
      expect(label).not.toBe('');
      expect(why).not.toBe('');
    }
  });

  test('a row pulses while a turn is running, and is still otherwise', () => {
    expect(sidebar).toContain('<LivenessDot state="live" still={!working} />');
    expect(sidebar).not.toContain('<LivenessDot state="live" still />');
  });

  test('run rows, pinned rows, drafts and a shut project all take it', () => {
    expect(sidebar).toMatch(/attention=\{runAttention\(\{ gate: marks\.gates\.has\(r\.id\), status: r\.status/);
    expect(sidebar).toMatch(/attention=\{runAttention\(\{\s*gate: marks\.gates\.has\(p\.runId\),\s*status: null,/);
    expect(sidebar).toContain('attention={draftNeeds(d)}');
    expect(sidebar).toContain('<NeedsBadge attention="gate" />');
  });
});
