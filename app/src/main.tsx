import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Cockpit } from './cockpit/Cockpit';
import './cockpit/cockpit.css';
import './pilot/pilot.css';

// The cockpit is the window now (#159). The specimen gallery is still the design
// system's acceptance test and still what `audit:contrast` is written against -
// it moved to `?gallery`, because the thing that proves every component has the
// states it claims should not need a build to reach.
const root = document.getElementById('root');
if (root === null) throw new Error('#root is missing from index.html');

const gallery = new URLSearchParams(window.location.search).has('gallery');

// `root` is passed in rather than closed over: the null check above does not
// narrow across the await below, and asserting past it would be exactly the
// thing the check exists to stop.
async function render(into: HTMLElement): Promise<void> {
  if (gallery) {
    // Imported only on that path, so the cockpit's bundle does not carry a page
    // nobody opens in the app.
    const { Gallery } = await import('./Gallery');
    createRoot(into).render(
      <StrictMode>
        <Gallery />
      </StrictMode>,
    );
    return;
  }
  createRoot(into).render(
    <StrictMode>
      <Cockpit />
    </StrictMode>,
  );
}

void render(root);
