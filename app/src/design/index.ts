import './tokens.css';

// Extensionless, unlike `src/` in this repo. The core is NodeNext ESM and needs
// explicit `.js`; the app is a bundler target where extensionless is the idiom
// and `.js` would ask Vite to resolve a file that does not exist.
//
// What is left of the original sixteen primitives is what a screen still draws
// (#237). Their look is utilities over the tokens, in the component itself; the
// controls and chrome are `src/ui/` now.
export { SeverityChip } from './Chips';
export type { Severity } from './Chips';
export { Modal, Table } from './Surfaces';
export { LivenessDot, ThinkingWave, Bar, DiffRow, HunkHeader, TruncationBand } from './Indicators';
export type { Liveness } from './Indicators';
