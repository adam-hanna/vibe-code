import { DEFAULT_EFFORT } from './effort';

/**
 * Which vendor, model and effort the pilot is asked with (#371).
 *
 * They were the pane's own state, kept for the window session only (#296), so
 * a phone and the desktop beside it could be talking to the same conversation
 * through two different models with nothing saying so. They are the window's
 * memory now, under one key every client reads and follows. Still one choice
 * for every conversation, as it was within a window.
 *
 * `model` null is *the road's own default*: the first its listing offers. An
 * entry that does not read is the default pick rather than a refusal, since a
 * pick is a preference and the pane draws what it is using.
 */
export const PICK_KEY = 'vibe.pilot.pick';

export interface Pick {
  vendor: 'anthropic' | 'openai';
  model: string | null;
  effort: string;
}

export const DEFAULT_PICK: Pick = { vendor: 'anthropic', model: null, effort: DEFAULT_EFFORT };

export function readPick(stored: string | null): Pick {
  if (stored === null) return DEFAULT_PICK;
  let raw: unknown;
  try {
    raw = JSON.parse(stored);
  } catch {
    return DEFAULT_PICK;
  }
  if (typeof raw !== 'object' || raw === null) return DEFAULT_PICK;
  const r = raw as Record<string, unknown>;
  return {
    vendor: r['vendor'] === 'openai' ? 'openai' : 'anthropic',
    model: typeof r['model'] === 'string' && r['model'].trim() !== '' ? r['model'] : null,
    effort: typeof r['effort'] === 'string' && r['effort'] !== '' ? r['effort'] : DEFAULT_EFFORT,
  };
}

export function writePick(pick: Pick): string {
  return JSON.stringify(pick);
}
