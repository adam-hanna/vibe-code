#!/usr/bin/env node
import { main } from '@src/cli.js';
import { defaultNoticeDeps, noticeFor, runWithNotice } from '@src/updatecheck.js';

const argv = process.argv.slice(2);

// The update notice (#323) lives here, in the terminal's entry, and not in
// `main()`: the host calls `main()` too (`serve.ts`), and a line printed there
// would land on the protocol's stdout. `runWithNotice` sets the exit code
// before the check starts, so the check can neither delay a run's first output
// nor change how it ended.
runWithNotice(
  () =>
    main(argv).catch((err: unknown) => {
      console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
      return 1;
    }),
  () => noticeFor(argv, defaultNoticeDeps()),
  {
    setExitCode: (code) => {
      process.exitCode = code;
    },
    write: (line) => console.log(line),
  },
).catch(() => {
  // Unreachable by construction - `runWithNotice` swallows the notice's own
  // failures - and kept so a surprise there can never become an exit code.
});
