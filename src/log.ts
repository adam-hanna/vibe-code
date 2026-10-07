import { appendFileSync } from 'node:fs';

/**
 * What the run says, and the two places it can be said to.
 *
 * The loop narrates twice, through channels that know nothing about each other:
 * this module writes prose to the terminal, and `recordEvent` in `@src/run.js`
 * writes structured facts into `state.events`. Almost every sentence a human
 * reads comes from here - `Fixing 3 finding(s) carried across the stop`,
 * `Review clean - 4 non-blocking finding(s)` - and until now none of it
 * survived the process.
 *
 * The desktop app links this same source and calls `orchestrate()` in its own
 * process, so everything the loop says has to arrive as *data* rather than as a
 * line on a terminal. Otherwise the app re-derives state by parsing our own log
 * lines, which is the worst possible coupling and the one that breaks silently
 * on every wording change (#133).
 *
 * **One channel, two renderers.** A `Narration` carries a level, the human
 * sentence, an optional stable id and its structured data. The console renderer
 * below formats it exactly as it always has - byte-identical output is the
 * acceptance test, because people read it and `vibe doctor` is scripted against
 * it. A host renderer builds a card from the same event.
 */

const COLOR = process.stdout.isTTY && !process.env['NO_COLOR'];
const ESC = '\u001b';
const c = (code: string, s: string): string => (COLOR ? `${ESC}[${code}m${s}${ESC}[0m` : s);

export const dim = (s: string): string => c('2', s);
export const bold = (s: string): string => c('1', s);
export const green = (s: string): string => c('32', s);
export const yellow = (s: string): string => c('33', s);
export const red = (s: string): string => c('31', s);
export const cyan = (s: string): string => c('36', s);

/**
 * The level each function already encoded in its prefix, named.
 *
 * These are the levels that existed before this seam did; nothing was added or
 * merged. `error` is the one whose name differs from its function (`fail`),
 * because `fail` reads better at a call site and `error` reads better in a
 * switch.
 */
export type Level = 'step' | 'info' | 'detail' | 'ok' | 'warn' | 'error' | 'heading';

export interface Narration {
  level: Level;
  /** The sentence the console renderer prints. */
  message: string;
  /**
   * A stable identity a host can act on without matching English.
   *
   * **Null is the honest default.** Most lines are prose a host displays and
   * never branches on, and inventing an id for each of them would be 219
   * identifiers nobody consumes and every one of them a thing to keep in sync.
   * A line gains an id when something needs to act on it - `gate_waiting` being
   * the case #134 will need - and until then absent is what is true.
   */
  id: string | null;
  /**
   * Whatever the sentence was built from. Flat, like `state.events`, for the
   * same reason: everything that reads it was written before this existed.
   */
  data: Record<string, unknown> | null;
}

/** What a call site may add beyond the sentence. Both optional; both default to null. */
export interface Meta {
  id?: string;
  data?: Record<string, unknown>;
}

export type Sink = (n: Narration) => void;

let transcriptPath: string | null = null;
let sink: Sink | null = null;

export function attachTranscript(p: string): void {
  transcriptPath = p;
}

/**
 * Install a destination for narration. `null` removes it.
 *
 * Additive, never a replacement: the console renderer keeps running whatever is
 * installed. A host that wants the terminal quiet redirects the process's own
 * stdout, which is a decision about the process rather than about this module -
 * and it keeps `vibe run` piped to a file behaving as it does today.
 */
export function setSink(s: Sink | null): void {
  sink = s;
}

function record(line: string): void {
  if (!transcriptPath) return;
  try {
    appendFileSync(transcriptPath, `[${new Date().toISOString()}] ${line}\n`, 'utf8');
  } catch {
    // A broken transcript must never take down a run.
  }
}

/**
 * Console first, then the transcript, then the sink.
 *
 * The order is the priority order. Console output is a contract and must not
 * wait on anything; the transcript is the durable record; the sink is a guest.
 *
 * A throwing sink is swallowed for the reason the transcript's is, and the
 * reason `progress.ts` wraps its own emit: a host that throws while rendering
 * is a host bug, not a run failure. Nothing is logged about it, because the only
 * channel available to report it is the one that just failed.
 */
function narrate(level: Level, message: string, meta?: Meta): void {
  if (sink === null) return;
  try {
    sink({
      level,
      message,
      id: meta?.id ?? null,
      data: meta?.data ?? null,
    });
  } catch {
    // See above.
  }
}

export function step(msg: string, meta?: Meta): void {
  console.log(`${cyan('>')} ${bold(msg)}`);
  record(`STEP  ${msg}`);
  narrate('step', msg, meta);
}

export function info(msg: string, meta?: Meta): void {
  console.log(`  ${msg}`);
  record(`INFO  ${msg}`);
  narrate('info', msg, meta);
}

export function detail(msg: string, meta?: Meta): void {
  console.log(dim(`  ${msg}`));
  record(`DEBUG ${msg}`);
  narrate('detail', msg, meta);
}

export function ok(msg: string, meta?: Meta): void {
  console.log(`  ${green('OK')} ${msg}`);
  record(`OK    ${msg}`);
  narrate('ok', msg, meta);
}

export function warn(msg: string, meta?: Meta): void {
  console.log(`  ${yellow('!')} ${msg}`);
  record(`WARN  ${msg}`);
  narrate('warn', msg, meta);
}

export function fail(msg: string, meta?: Meta): void {
  console.error(`  ${red('x')} ${msg}`);
  record(`ERROR ${msg}`);
  narrate('error', msg, meta);
}

export function heading(msg: string, meta?: Meta): void {
  console.log(`\n${bold(msg)}`);
  record(`\n=== ${msg} ===`);
  narrate('heading', msg, meta);
}
