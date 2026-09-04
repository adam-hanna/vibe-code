import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Shell } from './Shell';
import './shell.css';

// The gallery is still what fills the window - it is the thing that either draws
// correctly or visibly does not, which is what makes a launch a verification
// rather than a hope. `Shell` puts the host strip above it (#154).
const root = document.getElementById('root');
if (root === null) throw new Error('#root is missing from index.html');

createRoot(root).render(
  <StrictMode>
    <Shell />
  </StrictMode>,
);
