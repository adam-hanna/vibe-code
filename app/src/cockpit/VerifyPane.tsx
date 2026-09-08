import { Card, MetaChip, StateKicker } from '../design';
import { elapsed } from './format';
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

/**
 * One card per attempt, from what the loop recorded about each.
 *
 * **Drawn only when the attempts arrived.** A gate that reported `1 of 3 failed`
 * and no attempt list knows the fraction and not which run it was, and three
 * slots with one of them arbitrarily marked would be the pane inventing the
 * thing that distinguishes broken from noisy.
 */
function Attempts({ gate }: { gate: GateRun }) {
  if (gate.attempts.length === 0) {
    if (gate.runs === 0) return null;
    return (
      <p className="v-verify__absent">
        {gate.runs} attempt{gate.runs === 1 ? '' : 's'} ran and this build was not told what each
        one did — the fraction above is what the loop reported.
      </p>
    );
  }
  return (
    <ol className="v-verify__runs">
      {gate.attempts.map((a) => (
        <li key={a.run} className={`v-verify__run ${a.ok ? '' : 'v-verify__run--bad'}`}>
          <span className="v-verify__run-n">run {a.run}</span>
          <span className="v-verify__run-v">{a.ok ? 'passed' : 'failed'}</span>
          {/* The exit code only where there is one. A passing run has none to
              show and `exit 0` would be furniture. */}
          {!a.ok && a.exitCode !== null && <MetaChip>exit {a.exitCode}</MetaChip>}
        </li>
      ))}
    </ol>
  );
}

function GateCard({ gate }: { gate: GateRun }) {
  const reading = gate.verdict === null ? null : READING[gate.verdict];
  return (
    <Card state={gate.status === 'running' ? 'live' : 'settled'}>
      <div className="v-verify__head">
        <StateKicker tone={tone(gate)}>{gate.name}</StateKicker>
        <span className="v-verify__verdict">{verdictLine(gate)}</span>
        {gate.endedAt !== null && (
          <span className="v-verify__took">{elapsed(gate.endedAt - gate.startedAt)}</span>
        )}
      </div>

      {/* The plain-language reading, second and never instead of the verdict.
          Absent rather than invented when the loop reported a verdict word this
          build has no sentence for - the same rule `ending()` follows. */}
      {reading !== undefined && reading !== null && <p className="v-verify__reading">{reading}</p>}
      {gate.reason !== null && <p className="v-verify__reading">{gate.reason}</p>}

      {/* The command, because a verdict about a suite is not usable without
          knowing which command produced it. */}
      {gate.command !== null && <pre className="v-verify__cmd">{gate.command}</pre>}

      <Attempts gate={gate} />

      <p className="v-verify__means">
        <span className="v-verify__means-label">What this means for the loop</span>
        {consequence(gate)}
      </p>
    </Card>
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
    <p className="v-verify__trend">
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

export function VerifyPane({ passes }: { passes: readonly VerifyPass[] }) {
  if (passes.length === 0) {
    return (
      <div className="v-verify v-verify--empty">
        <StateKicker tone="quiet">no gate yet</StateKicker>
        <p>
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
    <div className="v-verify">
      <Trend passes={passes} />
      {ordered.map((pass, i) => (
        <section key={`${String(pass.round)}-${String(pass.at)}`} className="v-verify__pass">
          <h3 className="v-verify__round">
            {pass.round === null ? 'a verification pass' : `round ${pass.round + 1}`}
            {i === 0 && <MetaChip>most recent</MetaChip>}
          </h3>
          {pass.gates.map((gate) => (
            <GateCard key={`${gate.name}-${String(gate.startedAt)}`} gate={gate} />
          ))}
        </section>
      ))}
      {/* The one row worth keeping from the 4b draft, and the honest note about
          what is not here. Named rather than omitted: a pane that showed only
          what it has reads as a finished pane. */}
      <p className="v-verify__later">
        A per-test breakdown is not drawn, and will not be: it needs a reporter parser per
        toolchain, which is a maintenance commitment this repo has not taken on (#135).
      </p>
    </div>
  );
}
