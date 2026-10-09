import { useState } from 'react';
import { Badge } from '@/ui/badge';
import { cn } from '@/lib/utils';
import { elapsed } from './format';
import { CARD, EMPTY, FILE, LABEL, PANE } from './pane';
import { attemptAction } from './rail';
import { noText, useArtifact } from './useArtifacts';
import type { GateRun, VerifyPass } from './model';

/**
 * The verification gate, at gate level (`5d`, #223).
 *
 * **Built around a whole-gate verdict and deliberately not a per-test table.**
 * That is option 1 of the three #135 offered and it was chosen on cost: `vibe`
 * reads exit codes and parses nobody's reporter, so a per-test table means
 * tracking TAP, JUnit XML and `node --test` output for ever - a standing
 * maintenance commitment bought for a column in a UI, where it is the *prompt*
 * that saves the round. The design says the same thing in its own words: draw
 * the per-test table as a clearly-marked later state, and *"the pane must not
 * imply data it doesn't have"*.
 *
 * So every number here was measured by the loop, and the one the pane leans on -
 * `verdict` - is carried rather than derived. A window computing `failed < runs`
 * would call a single failing run **flaky**, and one sample says nothing about
 * determinism; `verdictOf` answers `failing` there and this draws what it said.
 */

/** `failing` and `flaky` send the fixer opposite instructions. */
const READING: Readonly<Record<string, string>> = {
  passing: 'Every attempt passed.',
  failing: 'This suite failed every attempt. The gate is reporting a defect in the code.',
  flaky: 'This suite is not deterministic. The same command against the same tree did both.',
  // The verdict for a gate with no attempts at all, which is every gate outcome
  // in every archive written before #135. It has to read as "cannot tell" and
  // never as a verdict about the suite.
  unrun: 'Nothing ran, so there is nothing to conclude.',
};

/**
 * What the loop does next, and it is the sentence the design insists on.
 *
 * The flaky wording names the three cheap ways to make a noisy gate green -
 * loosen the assertion, add a retry, add a sleep - because a model asked to make
 * a command pass will find all three and all three leave the race in the
 * product. Naming them is what stops the round buying one.
 */
function consequence(gate: GateRun): string {
  if (gate.status === 'passed') return 'All attempts passed, so the loop moves on.';
  if (gate.status === 'unavailable') {
    return 'Nothing ran here, and the loop carried on to the next gate rather than reading silence as a pass.';
  }
  if (gate.status === 'disabled') return 'Verification is off, so no gate ran and none will.';
  if (gate.verdict === 'flaky') {
    return (
      'All attempts must pass, so this counts as a failure and the round goes to FIX — and the ' +
      'fixer is told the suite is non-deterministic, not that a particular test is broken. ' +
      'Loosening the assertion, adding a retry or adding a sleep would all make it green and ' +
      'leave the race in the product.'
    );
  }
  return 'All attempts must pass, so this counts as a failure and the round goes to FIX.';
}

function verdictLine(gate: GateRun): string {
  if (gate.status === 'passed') return `PASSED ${gate.runs} OF ${gate.runs} RUNS`;
  if (gate.status === 'unavailable') return 'DID NOT RUN';
  if (gate.status === 'disabled') return 'DISABLED';
  if (gate.status === 'running') return 'RUNNING';
  // `failed` is the count the loop reported. It is not `runs - passes` computed
  // here, so a frame that carried one and not the other cannot produce a
  // fraction nobody measured.
  if (gate.failed === null) return 'FAILED';
  return `FAILED ${gate.failed} OF ${gate.runs} RUNS`;
}

function tone(gate: GateRun): 'alarm' | 'accent' | 'quiet' {
  if (gate.status === 'failed') return 'alarm';
  if (gate.status === 'unavailable') return 'accent';
  return 'quiet';
}

/** A named absence, never a blank and never a zero. */
const ABSENT = 'mt-3 mb-0 text-body-sm text-tertiary';

/**
 * One card per attempt, from what the loop recorded about each.
 *
 * **Drawn only when the attempts arrived.** A gate that reported `1 of 3 failed`
 * and no attempt list knows the fraction and not which run it was, and three
 * slots with one of them arbitrarily marked would be the pane inventing the
 * thing that distinguishes broken from noisy.
 *
 * **An attempt that names a log is a control that opens it** (#248). A count is a
 * control wherever it is drawn, and these were the most obvious thing on the
 * pane to press and did nothing. What opens is the file the loop named on the
 * event - `attemptAction` decides, and nothing here composes a filename.
 */
function Attempts({
  gate,
  open,
  onOpen,
}: {
  gate: GateRun;
  open: string | null;
  onOpen: (name: string | null) => void;
}) {
  if (gate.attempts.length === 0) {
    if (gate.runs === 0) return null;
    return (
      <p className={ABSENT}>
        {gate.runs} attempt{gate.runs === 1 ? '' : 's'} ran and this build was not told what each
        one did — the fraction above is what the loop reported.
      </p>
    );
  }
  return (
    <ol className="mt-3 mb-0 flex list-none flex-wrap gap-2 p-0">
      {gate.attempts.map((a) => {
        const action = attemptAction(gate, a);
        const body = (
          <>
            <span className="font-mono text-mono-sm text-tertiary">run {a.run}</span>
            <span className={LABEL}>{a.ok ? 'passed' : 'failed'}</span>
            {/* The exit code only where there is one. A passing run has none to
                show and `exit 0` would be furniture. */}
            {!a.ok && a.exitCode !== null && <Badge>exit {a.exitCode}</Badge>}
          </>
        );
        // Weight, not hue - the same rule the severity chips follow: a failed
        // attempt takes the P0 rule's width.
        const frame = cn(
          'flex items-center gap-2 rounded-sm border px-3 py-2 text-body-sm',
          a.ok ? 'border-rule-control text-secondary' : 'border-2 border-emphasis text-primary',
        );
        if (action.kind === 'open') {
          const shown = open === action.name;
          return (
            <li key={a.run}>
              <button
                type="button"
                className={cn(
                  frame,
                  'cursor-pointer bg-transparent text-left outline-none hover:bg-active-hdr focus-visible:ring-1 focus-visible:ring-accent',
                  shown && 'bg-active',
                )}
                aria-expanded={shown}
                title={shown ? 'Hide this attempt’s output' : 'Show this attempt’s whole output'}
                onClick={() => onOpen(shown ? null : action.name)}
              >
                {body}
                <span className="text-tertiary">{shown ? 'hide log' : 'open log'}</span>
              </button>
            </li>
          );
        }
        return (
          <li key={a.run} className={cn(frame, 'flex-col items-start gap-1')}>
            <span className="flex items-center gap-2">{body}</span>
            {action.kind === 'absent' && <span className="text-tertiary">{action.sentence}</span>}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * One attempt's whole output, read from the run's own directory when it is
 * asked for - never before, so a pane of ten passes costs one read.
 */
function AttemptLog({ dir, runId, name }: { dir: string; runId: string | null; name: string }) {
  const { read, failure, loading } = useArtifact(dir, runId, name);
  const missing = noText(read, failure);
  return (
    <div className="mt-3 flex flex-col gap-1">
      <span className={FILE}>{name}</span>
      {loading && read === null ? (
        <p className={ABSENT}>reading…</p>
      ) : missing !== null ? (
        <p className={ABSENT}>{missing}</p>
      ) : read?.kind === 'text' ? (
        <pre className="m-0 max-h-96 overflow-auto whitespace-pre rounded-sm border border-rule-inner bg-panel px-3 py-2 font-mono text-mono-sm text-secondary">
          {read.text === '' ? 'This attempt printed nothing.' : read.text}
        </pre>
      ) : null}
    </div>
  );
}

function GateCard({ gate, dir, runId }: { gate: GateRun; dir: string; runId: string | null }) {
  const [open, setOpen] = useState<string | null>(null);
  const reading = gate.verdict === null ? null : READING[gate.verdict];
  // The live gate takes the accent border and the active ground, as every
  // running card does; a settled one takes the card ground.
  return (
    <div className={cn(CARD, gate.status === 'running' && 'border-accent-border bg-active')}>
      <div className="flex flex-wrap items-baseline gap-3">
        <Badge variant={tone(gate)}>{gate.name}</Badge>
        {/* The verdict, large and first. 4b's draft gave it a 64px right-aligned
            label while its annotation called it primary; this is the correction. */}
        <span className="text-title font-medium tracking-tight text-display">{verdictLine(gate)}</span>
        {gate.endedAt !== null && (
          <span className="ml-auto font-mono text-mono-sm tabular-nums text-tertiary">{elapsed(gate.endedAt - gate.startedAt)}</span>
        )}
      </div>

      {/* The plain-language reading, second and never instead of the verdict.
          Absent rather than invented when the loop reported a verdict word this
          build has no sentence for - the same rule `ending()` follows. */}
      {reading !== undefined && reading !== null && <p className="mt-2 mb-0 text-body text-primary">{reading}</p>}
      {gate.reason !== null && <p className="mt-2 mb-0 text-body text-primary">{gate.reason}</p>}

      {/* The command, because a verdict about a suite is not usable without
          knowing which command produced it. */}
      {gate.command !== null && (
        <pre className="mt-3 mb-0 overflow-x-auto whitespace-pre rounded-sm border border-rule-inner bg-panel px-3 py-2 font-mono text-mono-sm text-secondary">
          {gate.command}
        </pre>
      )}

      <Attempts gate={gate} open={open} onOpen={setOpen} />
      {open !== null && <AttemptLog dir={dir} runId={runId} name={open} />}

      <p className="mt-3 mb-0 text-body-sm text-secondary">
        <span className={cn(LABEL, 'mb-1 block')}>What this means for the loop</span>
        {consequence(gate)}
      </p>
    </div>
  );
}

/**
 * The failed-runs trend, which is a comparison across passes.
 *
 * The round is what separates them and it is told rather than guessed - see
 * `openGate`. A pass whose round is unknown still draws, labelled as such,
 * because dropping it would silently shorten a trend.
 */
function Trend({ passes }: { passes: readonly VerifyPass[] }) {
  const failed = passes.filter((p) => p.gates.some((g) => g.status === 'failed'));
  if (passes.length < 2) return null;
  return (
    <p className="m-0 text-body-sm text-secondary">
      {failed.length} of {passes.length} verification passes have failed so far
      {failed.length > 0 && (
        <>
          {' '}
          — rounds{' '}
          {failed.map((p) => (p.round === null ? 'unnumbered' : String(p.round + 1))).join(', ')}
        </>
      )}
      .
    </p>
  );
}

export function VerifyPane({
  passes,
  dir,
  runId,
  waiting = null,
}: {
  passes: readonly VerifyPass[];
  /** Where the run that wrote these passes lives - the logs are read from it (#248). */
  dir: string;
  runId: string | null;
  /**
   * Why there are no passes to draw yet, or null when the empty list is the
   * run's own answer. An opened run's passes come from its replay, and until
   * that arrives - or if it fails - an empty list is not *nothing reached the
   * gate*; saying so would be a claim about the run this pane cannot make.
   */
  waiting?: string | null;
}) {
  if (passes.length === 0 && waiting !== null) {
    return (
      <div className={EMPTY}>
        <Badge>not read yet</Badge>
        <p className="m-0 max-w-md">{waiting}</p>
      </div>
    );
  }
  if (passes.length === 0) {
    return (
      <div className={EMPTY}>
        <Badge>no gate yet</Badge>
        <p className="m-0 max-w-md">
          The verification gate runs after an implementation or a fix turn. Nothing has reached it
          in this run.
        </p>
      </div>
    );
  }

  // Newest first: the pane's subject is the decision in front of you, and the
  // older passes are the trend behind it.
  const ordered = [...passes].reverse();
  return (
    <div className={cn(PANE, 'gap-4')}>
      <Trend passes={passes} />
      {ordered.map((pass, i) => (
        <section key={`${String(pass.round)}-${String(pass.at)}`} className="flex flex-col gap-3">
          <h3 className={cn(LABEL, 'm-0 flex items-center gap-2 font-bold text-body-sm')}>
            {pass.round === null ? 'a verification pass' : `round ${pass.round + 1}`}
            {i === 0 && <Badge>most recent</Badge>}
          </h3>
          {pass.gates.map((gate) => (
            <GateCard key={`${gate.name}-${String(gate.startedAt)}`} gate={gate} dir={dir} runId={runId} />
          ))}
        </section>
      ))}
      {/* The one row worth keeping from the 4b draft, and the honest note about
          what is not here. Named rather than omitted: a pane that showed only
          what it has reads as a finished pane. */}
      <p className={ABSENT}>
        A per-test breakdown is not drawn, and will not be: it needs a reporter parser per
        toolchain, which is a maintenance commitment this repo has not taken on.
      </p>
    </div>
  );
}
