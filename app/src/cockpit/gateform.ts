/**
 * The verification gates as a form, and the patch a form edit becomes (#240).
 *
 * Pure, for `model.ts`'s reason: the app has no jsdom, so a decision living in
 * a component is a decision nothing tests, and this one has three edges worth
 * pinning - which rows are ready to send, what a hand-written file would hold
 * for each, and the one write that changes the file's shape.
 *
 * **The patch carries the whole list.** `writeConfigPatch` merges a section one
 * level deep, so `verify.gates` is replaced whole by whatever is sent - which is
 * the honest shape for an ordered list anyway. A single gate's edit is therefore
 * a save of every gate, in order.
 *
 * **The conversion is one write, never two.** `validateConfig` refuses
 * `verify.command` beside `verify.gates`, so turning the single test command
 * into the first gate has to clear the one in the same patch that adds the
 * other. Two saves would leave the file, between them, in a state the core
 * refuses - and a run starting in that moment would be refused with it. Going
 * back is the mirror: removing the last gate puts its command back as the test
 * command, because an empty list is refused too.
 *
 * What this never does is check a gate. The core's refusals - kebab-case,
 * unique names, a non-empty command - arrive through the refusal banner in the
 * core's own words, and a second copy of those rules here would be a second
 * answer to *what is a legal gate*.
 */

/** A gate as the core holds it. Mirrors `VerifyGate` in `src/types.ts`. */
export interface Gate {
  name: string;
  command: string | null;
  runs?: number;
  timeoutMs?: number;
  required?: boolean;
  artifacts?: string[];
}

/** One row as it is being typed - every field a string until it is sent. */
export interface GateRow {
  /** Stable across edits, so React keeps focus in the row being typed in. */
  key: string;
  name: string;
  command: string;
  required: boolean;
  /** Blank means the section's `verify.runs`. */
  runs: string;
  /** In minutes, as the section's own field is. Blank means `verify.timeoutMs`. */
  minutes: string;
  /**
   * The saved gate this row came from, kept so a save does not drop what the
   * form does not edit (`artifacts`) or rewrite what it does not need to (an
   * explicit `required: true`). Null for a row added here and not yet saved.
   */
  saved: Gate | null;
}

const MINUTE = 60_000;

let counter = 0;
const nextKey = (): string => `g${String((counter += 1))}`;

/** Read whatever the effective config says `verify.gates` is, refusing nothing. */
export function readGates(value: unknown): Gate[] | null {
  if (!Array.isArray(value)) return null;
  const gates: Gate[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const gate: Gate = {
      name: typeof e['name'] === 'string' ? e['name'] : '',
      command: typeof e['command'] === 'string' ? e['command'] : null,
    };
    if (typeof e['runs'] === 'number') gate.runs = e['runs'];
    if (typeof e['timeoutMs'] === 'number') gate.timeoutMs = e['timeoutMs'];
    if (typeof e['required'] === 'boolean') gate.required = e['required'];
    if (Array.isArray(e['artifacts'])) {
      gate.artifacts = e['artifacts'].filter((a): a is string => typeof a === 'string');
    }
    gates.push(gate);
  }
  return gates;
}

export function toRow(gate: Gate): GateRow {
  return {
    key: nextKey(),
    name: gate.name,
    command: gate.command ?? '',
    required: gate.required !== false,
    runs: gate.runs === undefined ? '' : String(gate.runs),
    minutes: gate.timeoutMs === undefined ? '' : String(Math.round(gate.timeoutMs / MINUTE)),
    saved: gate,
  };
}

export function blankRow(): GateRow {
  return { key: nextKey(), name: '', command: '', required: true, runs: '', minutes: '', saved: null };
}

/**
 * Whether a row goes out on the next save.
 *
 * A row that was saved before always does, whatever it now holds - emptying a
 * saved gate's command is an edit, and the core's refusal of it is the answer.
 * A new row waits until it has a name and a command: sending a blank one would
 * have every save refused over a row somebody has only just added.
 */
export function ready(row: GateRow): boolean {
  return row.saved !== null || (row.name.trim() !== '' && row.command.trim() !== '');
}

/** A number field's text as the core wants it, or the text itself to be refused. */
function count(text: string): number | string | undefined {
  const t = text.trim();
  if (t === '') return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : t;
}

/**
 * A row as a hand-written file would hold it: only the keys that say
 * something. `required` is written when it is false, or when the file already
 * said `true` - removing a line somebody wrote is not this form's business.
 */
export function toGate(row: GateRow): Record<string, unknown> {
  const gate: Record<string, unknown> = { name: row.name.trim(), command: row.command.trim() };
  const runs = count(row.runs);
  if (runs !== undefined) gate['runs'] = runs;
  const minutes = count(row.minutes);
  if (minutes !== undefined) gate['timeoutMs'] = typeof minutes === 'number' ? minutes * MINUTE : minutes;
  if (!row.required || row.saved?.required === true) gate['required'] = row.required;
  if (row.saved?.artifacts !== undefined) gate['artifacts'] = row.saved.artifacts;
  return gate;
}

/**
 * The patch for a list of rows, or null when there is nothing to send.
 *
 * `fileHasCommand` is whether `vibe.config.json` itself sets `verify.command`.
 * Only then is it cleared - `null` is auto-detect, which is what an absent key
 * already means, so a file that never named a command is not given a line
 * saying so.
 */
export function gatesPatch(rows: readonly GateRow[], fileHasCommand: boolean): Record<string, unknown> | null {
  const out = rows.filter(ready).map(toGate);
  if (out.length === 0) return null;
  return { verify: { gates: out, ...(fileHasCommand ? { command: null } : {}) } };
}

/**
 * The first rows of a project that had one test command.
 *
 * The command becomes the first gate, named `verification` - the name the core
 * already gives the gate it synthesises from `verify.command`, so a run's
 * findings and its Verify tab say the same thing before and after. With no
 * command (auto-detect) there is nothing to carry over, and the list starts
 * with one blank row.
 */
export function convert(command: string | null): GateRow[] {
  if (command === null || command.trim() === '') return [blankRow()];
  return [toRow({ name: 'verification', command }), blankRow()];
}

/**
 * The patch that removes the last gate: back to one test command, in one write.
 * An empty list is refused by the core, and leaving the gate's command behind is
 * what a person removing the list would expect to keep.
 */
export function backToCommand(last: GateRow): Record<string, unknown> {
  const command = last.command.trim();
  return { verify: { gates: null, command: command === '' ? null : command } };
}

/**
 * A command that still holds JSON's escapes (#240).
 *
 * A worktree command was pasted from a JSON snippet, so `\"$VIBE_WORKTREE\"`
 * was saved with its backslashes - and a shell would have created a worktree at
 * a path with literal quote characters in it. In a shell command line `\"` is
 * almost always that paste, so it is worth one sentence before it is a refused
 * run. A warning and never a refusal: it is legal shell, and occasionally meant.
 */
export function pastedEscapes(command: string): string | null {
  if (!command.includes('\\"')) return null;
  return (
    'This holds \\" - JSON’s escaped quote. If it was pasted from a JSON file, the shell ' +
    `receives the backslashes too. Without them it reads: ${command.replace(/\\"/g, '"')}`
  );
}
