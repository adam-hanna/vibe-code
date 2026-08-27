/**
 * The values the kill-window child writes and the parent looks for.
 *
 * Their own module because `kill-during-save.ts` is a child entry point: it runs
 * `main()` on import, so a test that imported the markers from it would spawn a
 * run inside the test process instead of reading two strings.
 */
export const ALLOC_MODEL = 'marker-model';
export const ALLOC_CONTEXT_PREFIX = 'the brief:';
/** Large, so the single write it produces is wide enough to be cut in half. */
export const ALLOC_CONTEXT_PADDING = 4_000;
