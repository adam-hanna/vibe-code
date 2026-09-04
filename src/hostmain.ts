#!/usr/bin/env node
import { serve } from '@src/serve.js';

/**
 * The bin entry the desktop app's sidecar invokes, mirroring `src/main.ts`.
 *
 * Deliberately a separate file rather than a `vibe serve` subcommand. A
 * subcommand would put a JSON-RPC server in the published CLI's surface, where
 * it would have to be documented, versioned and supported for people who will
 * never run it - and `main()` prints usage to stdout on a bad argv, which is the
 * one stream this process cannot afford to have prose on.
 *
 * Nothing here writes to stdout. `serve()` takes it for the protocol on its
 * first line, and the catch below reports to stderr for the same reason.
 */
serve().catch((err: unknown) => {
  process.stderr.write(
    `${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exitCode = 1;
});
