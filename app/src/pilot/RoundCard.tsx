import { MetaChip, SeverityChip, StateKicker } from '../design';
import { elapsed, work as describeWork } from '../cockpit/format';
import { SEVERITIES } from '../cockpit/model';
import { title } from '../cockpit/rounds';
import type { Severity } from '../design';
import type { RoundCard as Round } from '../cockpit/rounds';
import type { GateRun } from '../cockpit/model';

/**
 * What a round left behind, in the log (hi-fi 5, #223).
 *
 * *"Every round leaves a card, and a card carries what happened, what it found
 * and what you can do about it."* The three halves of that sentence are the three
 * blocks below: the turns that ran, the evidence the round produced, and — where
 * there is one — the tab that has the detail.
 *
 * **It is a summary and it says so by being one.** The findings are here in the
 * shape `1e` draws them, four counts against a tolerance, because that is the
 * question a person has at a review boundary; the finding *prose* stays in the
 * round's artifact and behind the Findings tab, because a frame carrying every
 * finding in full would put a review's whole report on the wire every round.
 *
 * Nothing here is computed from anything else. A round with no work reading says
 * so, a round nobody numbered has no round chip, and a card whose turns have not
 * all ended shows no duration rather than one measured to now.
 */

/** A severity this build knows how to weight, or null for the zero variant. */
function weight(severity: string): Severity | null {
  return (SEVERITIES as readonly string[]).includes(severity) ? (severity as Severity) : null;
}

/**
 * The verification strip: `verify · passed · 3 runs, 3 clean`.
 *
 * The verdict is the loop's own word and never recomputed from the fraction —
 * `flaky` and `failing` are different findings about a suite and only one of them
 * is about the code, and a card deriving `failed < runs` would call a one-sample
 * failure flaky. `5d` has the per-attempt detail; this says which way it went.
 */
function gateLine(gate: GateRun): string {
  const parts = [gate.name, gate.verdict ?? gate.status];
  if (gate.runs > 0) {
    const clean = gate.runs - (gate.failed ?? 0);
    parts.push(`${String(gate.runs)} run${gate.runs === 1 ? '' : 's'}, ${String(clean)} clean`);
  } else if (gate.reason !== null) {
    // A gate that could not start says why. No amount of retrying makes a
    // mistyped path resolve, so this is the useful half.
    parts.push(gate.reason);
  }
  return parts.join(' · ');
}

export function RoundCard({
  card,
  onOpen,
}: {
  card: Round;
  /** Undefined where there is nowhere to send the reader. The link is omitted. */
  onOpen?: ((tab: string) => void) | undefined;
}) {
  const open = card.endedAt === null;
  const counts = card.census?.counts ?? null;

  return (
    <article className={`v-round v-round--${card.cycle}${open ? ' v-round--open' : ''}`}>
      <header className="v-round__head">
        <span className="v-round__what">{title(card.phase)}</span>
        {/* The archive's round, which is the number that names the artifact
            behind it — the file is `plan-critique-0.json`, and a card has to
            agree with the file. */}
        {card.round !== null && <MetaChip kind="checkable">round {card.round}</MetaChip>}
        {card.endedAt !== null && (
          <span className="v-round__took">{elapsed(card.endedAt - card.startedAt)}</span>
        )}
        {open && <StateKicker tone="accent">running</StateKicker>}
      </header>

      {/* What ran. Roles and kinds as the loop named them — there is no model on
          a turn frame, so a card does not claim one. The design's
          `claude/opus` is a fact this wire does not carry (#136). */}
      {card.turns.length > 0 && (
        <ul className="v-round__turns">
          {card.turns.map((t) => (
            <li key={t.id}>
              <span className="v-round__who">
                {t.role} · {t.kind}
              </span>
              {t.ms !== null && <span className="v-round__ms">{elapsed(t.ms)}</span>}
            </li>
          ))}
        </ul>
      )}

      {/* `11 files · +604 −71`, in `src/work.ts`'s own words rather than
          re-composed here. Absent when no reading arrived, and a real zero gets
          the sentence the loop uses for it. */}
      {card.work !== null && <div className="v-round__work">{describeWork(card.work)}</div>}

      {card.verify !== null && (
        <div className="v-round__verify">
          {card.verify.gates.map((g) => (
            <div className="v-round__gate" key={g.name}>
              {gateLine(g)}
            </div>
          ))}
          {card.verify.gates.length === 0 && (
            <div className="v-round__gate">a verification pass with no gates in it</div>
          )}
          {onOpen !== undefined && (
            <button className="v-round__open" onClick={() => onOpen('verify')}>
              open verify
            </button>
          )}
        </div>
      )}

      {counts !== null && card.census !== null && (
        <div className="v-round__findings">
          {/* Four chips, zeros shown. Where a gate decision is being made an
              absence is information, and `no P0s` is the most important thing
              on the row. */}
          <div className="v-round__chips">
            {SEVERITIES.map((s) => {
              const n = counts[s] ?? 0;
              return (
                <SeverityChip key={s} severity={n === 0 ? null : weight(s)} label={s} count={n} />
              );
            })}
            <MetaChip>tolerance P1≤{card.census.tolerance}</MetaChip>
          </div>
          {/* The loop's own sentence where it blocked, because `gate()` names
              the exact arithmetic that stopped the round. Never one composed
              here from the counts. */}
          <div className="v-round__verdict">
            {card.census.pass
              ? 'The gate passed.'
              : (card.census.reason ?? 'The gate blocked this round.')}
          </div>
          {card.census.findings.slice(0, 3).map((f) => (
            <div className="v-round__finding" key={f.id}>
              <SeverityChip severity={weight(f.severity)} label={f.severity} />
              <code className="v-round__fid">{f.id}</code>
              <span className="v-round__ftitle">{f.title}</span>
            </div>
          ))}
          {card.census.findings.length > 3 && (
            <div className="v-round__more">
              {card.census.findings.length - 3} more in this round
            </div>
          )}
          {onOpen !== undefined && (
            <button className="v-round__open" onClick={() => onOpen('findings')}>
              open findings
            </button>
          )}
        </div>
      )}
    </article>
  );
}
