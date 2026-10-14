import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Boundary } from './Boundary';
import { Cockpit } from './cockpit/Cockpit';
import { prepareCockpit } from './prepare';

/**
 * What the window renders, and what has to be ready first (#346 moved it out of
 * `main.tsx`). The phone build swaps this module for `boot.mobile.tsx`, which
 * puts the paired desktops and the lock in front of the same cockpit.
 */

// `into` is passed in rather than closed over: the null check in `main.tsx`
// does not narrow across the await below.
export async function boot(into: HTMLElement): Promise<void> {
  await prepareCockpit();
  createRoot(into).render(
    <StrictMode>
      <Boundary>
        <Cockpit />
      </Boundary>
    </StrictMode>,
  );
}
