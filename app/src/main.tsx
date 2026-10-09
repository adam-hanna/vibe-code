import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Boundary } from './Boundary';
import { Cockpit } from './cockpit/Cockpit';
import { flushMemory, loadMemory, memory } from './memory';
import { keepLedgerIn } from './pilot/ledger';
// The whole stylesheet: `tokens.css` (through `./design`) and Tailwind over it.
// Every rule the app draws with is a utility in the component that uses it, or
// one of the few global rules in `theme.css` (#237).
import './design/theme.css';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';

// The cockpit is the window (#159). The specimen gallery that used to live at
// `?gallery` went with the old primitives it drew (#237).
const root = document.getElementById('root');
if (root === null) throw new Error('#root is missing from index.html');

// `root` is passed in rather than closed over: the null check above does not
// narrow across the await below, and asserting past it would be exactly the
// thing the check exists to stop.
async function render(into: HTMLElement): Promise<void> {
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
