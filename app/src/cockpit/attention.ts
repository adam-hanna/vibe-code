import type { Conversation } from '../pilot/transcript';
import { unanswered } from '../pilot/transcript';

/**
 * Which rows in the sidebar are waiting on a person, and why (#307).
 *
 * A run could hold at a gate, stop on a question, stop on a ceiling or fail,
 * and a draft's pilot could ask something - and only the gate said so anywhere
 * outside the run itself. Everything here is read off a fact somebody else
 * already decided: the archive's `status`, the live run's `gate`, and the saved
 * conversation. Nothing is inferred from a sentence.
 *
 * Pure, because the app has no jsdom.
 */
export type Attention = 'gate' | 'needs-input' | 'stalled' | 'failed' | 'proposal' | 'reply';

/** What each one says on the badge, and in its tooltip. */
export const ATTENTION: Readonly<Record<Attention, { label: string; why: string }>> = {
  gate: { label: 'gate', why: 'waiting for a decision - open the run to answer it' },
  'needs-input': { label: 'needs you', why: 'stopped and waiting for your input - open the run to answer or resume it' },
  stalled: { label: 'stopped', why: 'stopped at a limit - open the run to raise it or resume' },
  failed: { label: 'failed', why: 'the run failed - open it to see why' },
  proposal: { label: 'proposal', why: 'the pilot proposed something - open the draft to decide' },
  reply: { label: 'your turn', why: 'the pilot replied and is waiting for you' },
};

/**
 * A run row's attention, or null.
 *
 * A held gate first: it is the one that is live. Then the archive's verdict, but
 * **only for a run that is not running** - a running run's status is the phase
 * it is in, and a status read before it was resumed would be stale. Never on the
 * row on screen, which draws its own ending and its own gate.
 */
export function runAttention(row: {
  gate: boolean;
  status: string | null;
  live: boolean;
  current: boolean;
}): Attention | null {
  if (row.current) return null;
  if (row.gate) return 'gate';
  if (row.live || row.status === null) return null;
  return statusAttention(row.status);
}

/** The archive's statuses that ask somebody to act, and what each is called. */
export function statusAttention(status: string): Attention | null {
  // `RunStatus` in `src/types.ts`. The other five are a run going or a run done.
  if (status === 'needs-input') return 'needs-input';
  if (status === 'stalled') return 'stalled';
  if (status === 'error') return 'failed';
  return null;
}

/**
 * A draft's attention, read from its saved conversation, or null.
 *
 * A saved conversation never holds a turn in flight (`writable` drops it), so
 * its shape alone says whose turn it is. **A proposal with no result** is a
 * decision waiting. **The last message being the pilot's** is the pilot having
 * finished and handed the conversation back. Anything else - nothing said yet,
 * the person's message last (the pilot is working on it), or a tool result last
 * (the pilot is carrying on) - is not waiting on anybody.
 */
export function draftAttention(conversation: Conversation): Attention | null {
  const proposals = unanswered(conversation).filter((call) => call.settlement?.kind === 'proposes');
  if (proposals.length > 0) return 'proposal';
  const last = conversation.messages[conversation.messages.length - 1];
  return last?.role === 'assistant' ? 'reply' : null;
}
