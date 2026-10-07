import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Boundary } from './Boundary';
import { Cockpit } from './cockpit/Cockpit';
import { flushMemory, loadMemory, memory } from './memory';
import { keepLedgerIn } from './pilot/ledger';
import './cockpit/cockpit.css';
import './design/workspace.css';
// Tailwind over the tokens, and the two typefaces the rework moves to. Neither
// changes a pixel yet: no utility is used, and `tokens.css` still names the old
// fonts. Groundwork, so the shell that follows is one change rather than two.
import './design/theme.css';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';

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
        <Boundary>
          <Gallery />
        </Boundary>
      </StrictMode>,
    );
    return;
  }
  // The window's memory is read before the cockpit exists (#223, `memory.ts`):
  // every setting is read synchronously at mount, and a mount that ran first
  // would draw defaults and then save them over what was stored.
  await loadMemory();
  keepLedgerIn(memory);
  window.addEventListener('pagehide', flushMemory);
  createRoot(into).render(
    <StrictMode>
      <Boundary>
        <Cockpit />
      </Boundary>
    </StrictMode>,
  );
}

void render(root);
