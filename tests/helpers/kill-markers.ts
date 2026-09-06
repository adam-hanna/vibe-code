/**
 * The values the kill-window child writes and the parent looks for.
 *
 * Their own module because `kill-during-save.ts` is a child entry point: it runs
 * `main()` on import, so a test that imported the markers from it would spawn a
 * run inside the test process instead of reading two strings.
 */
/**
 * The first line every mode prints, before it reads argv or touches a disk.
 *
 * Without it, a child that had not reached its first line and a child that
 * started and then stalled are the same observation from outside - both are
 * `stdout ""` when the parent's readiness wait gives up - and they want opposite
 * responses: the first has done nothing and can simply be spawned again, the
 * second is the hang #100 added that wait to diagnose and must never be retried
 * past. #181 is the run where that mattered: two failures, `stdout ""` both
 * times, and no way to tell which of the two had happened.
 */
export const STARTING_LINE = 'starting';

export const ALLOC_MODEL = 'marker-model';
export const ALLOC_CONTEXT_PREFIX = 'the brief:';
/** Large, so the single write it produces is wide enough to be cut in half. */
export const ALLOC_CONTEXT_PADDING = 4_000;

/**
 * The size of the artifact fixture: a real `PLAN.md` from this repo's own runs
 * is 17,729 bytes, and lifelike is deliberate here. See the note beside
 * `artifactMode` in `kill-during-save.ts` for why this one is NOT sized like
 * the state.json fixture.
 */
export const ARTIFACT_BODY_BYTES = 17_729;

/**
 * One generator rather than two literals, so the pair cannot drift into
 * differing by something other than their marker.
 *
 * The marker appears at BOTH ends. The parent compares for equality, so a
 * spliced file is already caught - but a body whose two halves are
 * indistinguishable would make a torn file that happened to keep the first half
 * of A and the second half of A equal to A, and there would be nothing to see.
 */
function artifactBody(marker: 'A' | 'B'): string {
  const head = `# artifact ${marker}\n`;
  const tail = `\n<!-- end ${marker} -->\n`;
  const fill = marker.toLowerCase().repeat(ARTIFACT_BODY_BYTES - head.length - tail.length);
  return `${head}${fill}${tail}`;
}

export const ARTIFACT_BODY_A = artifactBody('A');
export const ARTIFACT_BODY_B = artifactBody('B');
