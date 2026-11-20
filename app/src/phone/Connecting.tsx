import { useEffect, useState } from 'react';
import { Button } from '@/ui/button';
import { ThinkingWave } from '../design/Indicators';

/**
 * What the phone draws between the unlock and the cockpit.
 *
 * It was an empty cover, and the wait behind it is a dial: up to about twenty
 * seconds for a desktop that is off, a couple for one that is up. A blank page
 * that long reads as a hang. So it says what it is doing - *Starting…* until the
 * phone knows which desktop it is opening, then *Connecting to* that desktop -
 * with the one animation (`ThinkingWave`, which stands still under reduced
 * motion), and while it dials it offers the way out to the desktops list, which
 * nothing else on the phone reaches until the dial gives up.
 *
 * **The slow line is a claim about time, not about the dial.** The webview
 * cannot see which step the Rust is on; it knows only how long it has waited.
 * Past `HINT_WAIT_MS` the first, stored-address step would have given up, so it
 * says it is still trying, and promises nothing about how much longer.
 */

/**
 * `HINT_DIAL_TIMEOUT` in `app/remote/src/client.rs`, the budget for the stored
 * relay hint before the dial falls back to the id alone. Pinned to it by
 * `connecting.test.ts`, so the two cannot drift apart.
 */
export const HINT_WAIT_MS = 5_000;

export const COVER = 'fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-page p-6 text-center';
export const NOTE = 'm-0 max-w-[40ch] text-body-sm text-tertiary';

export interface ConnectingProps {
  /** The desktop being dialled, as this phone calls it; `null` before that is known. */
  dialling: string | null;
  /** The dial has run past the stored address's budget. */
  slow: boolean;
  problem: string | null;
  onChoose: () => void;
}

/** The screen itself, with no clock, so each state can be rendered by a test. */
export function ConnectingView({ dialling, slow, problem, onChoose }: ConnectingProps) {
  const doing = dialling === null ? 'Starting…' : `Connecting to ${dialling}…`;
  return (
    <div className={COVER}>
      <ThinkingWave label={doing} />
      <p className="m-0 max-w-[40ch] text-body text-primary">
        {doing}
      </p>
      {dialling !== null && slow && (
        <p className={NOTE}>Still trying. If it does not answer, the list of desktops opens.</p>
      )}
      {dialling !== null && (
        <Button variant="secondary" onClick={onChoose}>
          Choose another desktop
        </Button>
      )}
      {problem !== null && <p className={NOTE}>{problem}</p>}
    </div>
  );
}

/** The screen, with the clock that turns the slow line on for each dial. */
export function Connecting({ dialling, problem, onChoose }: Omit<ConnectingProps, 'slow'>) {
  const [slowFor, setSlowFor] = useState<string | null>(null);
  useEffect(() => {
    if (dialling === null) return;
    const timer = setTimeout(() => setSlowFor(dialling), HINT_WAIT_MS);
    return () => clearTimeout(timer);
  }, [dialling]);
  return (
    <ConnectingView dialling={dialling} slow={dialling !== null && slowFor === dialling} problem={problem} onChoose={onChoose} />
  );
}
