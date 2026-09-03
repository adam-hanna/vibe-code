import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Gallery } from './Gallery';

// Until the cockpit exists, the gallery IS the app: it is what the contrast
// audit runs against and what proves a component has every state it claims.
const root = document.getElementById('root');
if (root === null) throw new Error('#root is missing from index.html');

createRoot(root).render(
  <StrictMode>
    <Gallery />
  </StrictMode>,
);
