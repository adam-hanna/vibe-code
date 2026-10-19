import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Boundary } from './Boundary';
import { PhoneApp } from './phone/PhoneApp';

/**
 * The phone's `boot` (#346): the paired desktops and the lock in front of the
 * same cockpit. Swapped in for `boot.tsx` by `vite build --mode mobile`.
 */

export async function boot(into: HTMLElement): Promise<void> {
  // Keeps the page inside the status and navigation bars (`theme.css`).
  document.documentElement.dataset['surface'] = 'phone';
  createRoot(into).render(
    <StrictMode>
      <Boundary>
        <PhoneApp />
      </Boundary>
    </StrictMode>,
  );
  return Promise.resolve();
}
