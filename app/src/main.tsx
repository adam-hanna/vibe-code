import { boot } from './boot';
// The whole stylesheet: `tokens.css` (through `./design`) and Tailwind over it.
// Every rule the app draws with is a utility in the component that uses it, or
// one of the few global rules in `theme.css` (#237).
import './design/theme.css';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';

// The cockpit is the window (#159); on a phone, the paired desktops and the
// lock come first (`boot.mobile.tsx`, #346). The specimen gallery that used to
// live at `?gallery` went with the old primitives it drew (#237).
const root = document.getElementById('root');
if (root === null) throw new Error('#root is missing from index.html');

void boot(root);
