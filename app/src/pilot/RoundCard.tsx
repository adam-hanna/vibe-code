import { SeverityChip } from '../design';
import { Badge } from '@/ui/badge';
import { cn } from '@/lib/utils';
import { Counts } from '../cockpit/Counts';
import { elapsed, work as describeWork } from '../cockpit/format';
import { SEVERITIES } from '../cockpit/model';
import { roundTitle } from '../cockpit/rounds';
import type { Severity } from '../design';
import type { RoundCard as Round } from '../cockpit/rounds';
import type { GateRun } from '../cockpit/model';
import type { OpenAt } from '../cockpit/LoopColumn';
import type { Tab } from '../cockpit/where';

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
 *
 * Visually it is a card and NOT a reply: the reply is a conversation and this is
 * a record, so it takes the card ground and the card rule rather than the
 * reply's indentation. The one live treatment is the accent border and the
 * active ground, the same a live turn takes - and no pulse, because *exactly one
 * element on screen pulses* and while a round is running the turn card in the
 * loop column already has it. The cycle is deliberately not a colour: three
 * cycles reading as three hues would be hue carrying meaning, which this system
 * does not do.
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

/**
 * Which pane holds this round's own detail (#223).
 *
 * **A closed map keyed by the group, which is the one thing a card always
 * knows.** `CycleKind` is four and so is this, so a fifth group fails to compile
 * here rather than producing a card whose heading is a link to nowhere — the same
 * reason `format.ts` holds the boundary and exit-code maps and `contract.test.ts`
 * fails on the commit that adds a ninth code.
 *
 * The round travels with it. A card is a summary of *one* round, so a link that
 * opened the pane at whichever round happened to be newest would be the wrong
 * one every time except the last — which is the complaint the counts one level
 * up already earned: the largest thing on the surface was inert while something
 * smaller beside it did the navigating.
 */
const PANE: Readonly<Record<Round['cycle'], Tab>> = {
  plan: 'plans',
  critique: 'critique',
  code: 'code',
  review: 'review',
};

/** A measured duration on the card: monospace and tabular, so a column of them lines up. */
const TOOK = 'font-mono text-mono-sm tabular-nums text-tertiary';
/** A block of evidence under the turns, ruled off from what is above it. */
const EVIDENCE = 'flex flex-col gap-2 border-t border-rule-inner pt-2';
/**
 * The design's `open verify` - a text link, because it goes somewhere rather
 * than doing something. A button styled as a button here would compete with the
 * proposal cards, which are the only controls in this scroll that spend.
 */
const OPEN =
  'cursor-pointer self-start border-0 bg-transparent p-0 text-left text-body-sm text-accent underline underline-offset-2 hover:text-accent-on-tint';

export function RoundCard({
  card,
  onOpen,
}: {
  card: Round;
  /** Undefined where there is nowhere to send the reader. The link is omitted. */
  onOpen?: OpenAt | undefined;
}) {
  const open = card.endedAt === null;
  const counts = card.census?.counts ?? null;
  const go = onOpen === undefined ? null : () => { onOpen(PANE[card.cycle], card.round); };

  return (
    <article
      className={cn(
        'mb-4 flex flex-col gap-2 rounded-md border border-rule-card border-l-2 border-l-rule-strong bg-chrome p-4',
        open && 'border-l-accent-border bg-active',
      )}
      data-cycle={card.cycle}
    >
      {/* The heading is the control. A card is the round's summary and the pane
          behind it is the round's detail, so the name of the round is the
          shortest path between the two - and a card whose title was not a link
          taught you to go looking for one at the bottom. A button reset rather
          than a link, because it navigates within the window; only the linked
          form takes a cursor, since a heading that looks clickable on a card
          with nowhere to send anybody is the defect this pattern keeps fixing. */}
      <header className="flex items-center gap-2">
        {go === null ? (
          <span className="text-kicker font-semibold text-display">{roundTitle(card)}</span>
        ) : (
          <button
            type="button"
            className="cursor-pointer border-0 bg-transparent p-0 text-left text-kicker font-semibold text-display hover:underline hover:underline-offset-4"
            onClick={go}
            title={`Open this ${roundTitle(card)} round`}
          >
            {roundTitle(card)}
          </button>
        )}
        {/* The archive's round, which is the number that names the artifact
            behind it — the file is `plan-critique-0.json`, and a card has to
            agree with the file. It is also what the link above carries, so the
            pane opens at this round rather than at the newest one. */}
        {card.round !== null && <Badge className="font-mono normal-case tracking-normal">round {card.round}</Badge>}
        {card.endedAt !== null && (
          <span className={cn(TOOK, 'ml-auto')}>{elapsed(card.endedAt - card.startedAt)}</span>
        )}
        {open && <Badge variant="accent">running</Badge>}
      </header>

      {/* What ran. Roles and kinds as the loop named them — there is no model on
          a turn frame, so a card does not claim one. The design's
          `claude/opus` is a fact this wire does not carry (#136). */}
      {card.turns.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {card.turns.map((t) => (
            <li key={t.id} className="flex items-baseline gap-3">
              <span className="text-body-sm text-primary">
                {t.role} · {t.kind}
              </span>
              {/* Absent while the turn is open rather than measured to now: a
                  duration on a turn that has not finished is a number that
                  keeps changing about a fact that has not happened. */}
              {t.endedAt !== null && (
                <span className={cn(TOOK, 'ml-auto')}>{elapsed(t.endedAt - t.startedAt)}</span>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* **Why this round has two planner turns in it.** A plan round that
          answers its own questions is one round and is now one card, so the
          questions are the only thing that explains the second turn — without
          them the card reads as a planner that ran twice for no reason.

          A count and a link, not the questions themselves: this card is 364px
          of a log and a question is a paragraph. The Questions tab is where the
          text is, one section per round. A row rather than a column: it is
          chips and one link, and stacking three chips would give the questions
          more vertical weight than the findings above them. */}
      {card.questions !== null && (
        <div className="flex flex-wrap items-center gap-2 border-t border-rule-inner pt-2">
          <Badge>
            {card.questions.round === null
              ? 'questions'
              : `question round ${String(card.questions.round)}`}
          </Badge>
          <Badge>{card.questions.total} raised</Badge>
          {card.questions.blocking > 0 && (
            <Badge variant="alarm">{card.questions.blocking} blocking</Badge>
          )}
          {onOpen !== undefined && (
            <button type="button" className={OPEN} onClick={() => onOpen('questions')}>
              open questions
            </button>
          )}
        </div>
      )}

      {/* `11 files · +604 −71`, in `src/work.ts`'s own words rather than
          re-composed here. Absent when no reading arrived, and a real zero gets
          the sentence the loop uses for it. */}
      {card.work !== null && <div className="text-body-sm text-emphasis">{describeWork(card.work)}</div>}

      {card.verify !== null && (
        <div className={EVIDENCE}>
          {card.verify.gates.map((g) => (
            <div className="text-body-sm text-secondary" key={g.name}>
              {gateLine(g)}
            </div>
          ))}
          {card.verify.gates.length === 0 && (
            <div className="text-body-sm text-secondary">a verification pass with no gates in it</div>
          )}
          {onOpen !== undefined && (
            <button type="button" className={OPEN} onClick={() => onOpen('verify')}>
              open verify
            </button>
          )}
        </div>
      )}

      {counts !== null && card.census !== null && (
        <div className={EVIDENCE}>
          {/* Four chips, zeros shown. Where a gate decision is being made an
              absence is information, and `no P0s` is the most important thing
              on the row.

              The row is the control. A count is the thing a reader reaches for
              first, and it was inert while a text link three lines below it did
              the navigating - so the chips take the click and the link stays for
              anyone reading top to bottom. */}
          <Counts
            counts={counts}
            tolerance={card.census.tolerance}
            onOpen={go ?? undefined}
          />
          {/* The loop's own sentence where it blocked, because `gate()` names
              the exact arithmetic that stopped the round. Never one composed
              here from the counts. */}
          <div className="text-body-sm text-primary">
            {card.census.pass
              ? 'The gate passed.'
              : (card.census.reason ?? 'The gate blocked this round.')}
          </div>
          {card.census.findings.slice(0, 3).map((f) => (
            <div className="flex items-baseline gap-2" key={f.id}>
              <SeverityChip severity={weight(f.severity)} label={f.severity} />
              <code className="font-mono text-mono-sm text-tertiary">{f.id}</code>
              <span className="text-body-sm text-primary">{f.title}</span>
            </div>
          ))}
          {card.census.findings.length > 3 && (
            <div className="text-body-sm text-secondary">
              {card.census.findings.length - 3} more in this round
            </div>
          )}
          {go !== null && (
            <button type="button" className={OPEN} onClick={go}>
              open this {roundTitle(card)}
            </button>
          )}
        </div>
      )}
    </article>
  );
}
