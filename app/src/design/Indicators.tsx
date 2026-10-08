import type { ReactNode } from 'react';

/**
 * The liveness dot, the thinking wave, the proportion bar, and the diff rows.
 *
 * Each draws with utilities over the tokens (#237) - the rules that were in
 * `components.css`, moved into the component that is their only user, with the
 * same token in every declaration. The spacing tokens are off Tailwind's scale,
 * so they are referenced (`px-(--space-2)`) rather than rounded to a step, and a
 * composed type style is the token itself (`[font:var(--type-mono-sm)]`) rather
 * than a size utility that would leave its weight and leading behind.
 */

/**
 * Four states, because liveness is not two-valued.
 *
 * `src/lock.ts` reports `running | interrupted | not-running | unknown`, and the
 * fourth is the one that matters here: an unasked question and an unanswerable
 * one are the same thing, so `absent` claims nothing rather than claiming death.
 */
export type Liveness = 'live' | 'quiet' | 'waiting' | 'absent';

const DOT = 'inline-block size-(--dim-liveness-dot) flex-none rounded-full';

/** Stale (`absent`): the dot is not filled at all. Nothing is claimed, because nothing is known. */
const DOT_STATE: Record<Liveness, string> = {
  live: 'bg-live animate-[v-pulse_var(--pulse-duration)_ease-in-out_infinite]',
  quiet: 'border border-live',
  waiting: 'border border-accent',
  absent: 'border border-dashed border-rule-strong',
};

export function LivenessDot({ state }: { state: Liveness }) {
  return <span className={`${DOT} ${DOT_STATE[state]}`} aria-label={state} />;
}

/**
 * Three dots taking the pulse in turn, for a wait with nothing else to show.
 *
 * The gap the pilot had: between pressing send and the first token there is a
 * card with no text, no model and no usage, and a two-word kicker was the whole
 * of it - repeatedly read as a stall. Motion is what says the wait is being
 * waited on.
 *
 * **It is a claim about this window, not about the turn.** All it proves is that
 * the pane is still rendering; a vendor that has silently stopped answering
 * waves exactly as busily as one that is composing. That is why every caller
 * puts a measured elapsed beside it - the dots say *something is open*, the
 * elapsed is the part a person can judge - and why nothing here counts, guesses
 * a duration, or draws a proportion of anything.
 *
 * `aria-label` rather than the dots: three bullets are not a word, and a screen
 * reader landing on them should hear what they mean. `role="status"` so it is
 * announced when it appears and not focus-stealing.
 */
/**
 * **The one animation, at three offsets** - not a second keyframe. That is what
 * keeps `theme.css`'s "the one animation" heading true, and it is also why the
 * wave inherits reduced motion for free: at `--wave-duration: 0s` the three dots
 * simply stand still and the indicator still says what it says.
 *
 * Sized off `--dim-liveness-dot` rather than a number of its own, because these
 * are the same dot doing a different job and two sizes would have to be kept in
 * step by somebody remembering to.
 */
const WAVE_DOT =
  'size-(--dim-liveness-dot) rounded-full bg-accent animate-[v-pulse_var(--wave-duration)_ease-in-out_infinite]';

/**
 * A third of the period each, so the trough travels along the row once per
 * cycle - the stadium wave. Even spacing is the whole effect: any other offset
 * reads as three dots blinking at each other. Inline, because the delay must
 * beat the `animation` shorthand the utility sets, whatever order the two
 * utilities would be emitted in.
 */
const WAVE_DELAY = ['0s', 'calc(var(--wave-duration) / 3)', 'calc(var(--wave-duration) / 3 * 2)'] as const;

export function ThinkingWave({ label = 'working' }: { label?: string }) {
  return (
    <span className="inline-flex flex-none items-center gap-[3px]" role="status" aria-label={label}>
      {WAVE_DELAY.map((delay) => (
        <span key={delay} className={WAVE_DOT} style={{ animationDelay: delay }} />
      ))}
    </span>
  );
}

/**
 * A proportion, never a severity.
 *
 * Never renders a bar at 0%: a zero-width fill and "we cannot measure this" look
 * identical, so an unmeasurable quantity takes the dashed unavailable track
 * instead. That is the absence rule applied to a number.
 */
const BAR = 'flex h-(--dim-bar-track) overflow-hidden';
/** The quantity ramp, and nothing else - a bar is never a severity. */
const SEGMENT = { 1: 'bg-quantity-1', 2: 'bg-quantity-2', 3: 'bg-quantity-3' } as const;

export function Bar({
  segments,
}: {
  /** Null means unmeasurable - drawn dashed, not empty. */
  segments: readonly { share: number; step: 1 | 2 | 3 }[] | null;
}) {
  if (segments === null || segments.length === 0) {
    // Dashed with no ground. The old rule also asked for the hatch, and never
    // drew it: `.v-bar--unavailable`'s `background: none` came later in the
    // cascade than `.v-hatch` and reset its image. This is what was on screen.
    return <div className={`${BAR} border border-dashed border-rule-strong`} aria-label="not measured" />;
  }
  return (
    <div className={`${BAR} bg-quantity-track`}>
      {segments.map((s, i) => (
        <div
          // eslint-disable-next-line react/no-array-index-key
          key={i}
          className={SEGMENT[s.step]}
          style={{ width: `${s.share * 100}%` }}
        />
      ))}
    </div>
  );
}

export function DiffRow({
  kind,
  oldNo,
  newNo,
  code,
  selected = false,
}: {
  kind: 'context' | 'added' | 'removed';
  oldNo?: number | undefined;
  newNo?: number | undefined;
  code: string;
  selected?: boolean;
}) {
  const glyph = kind === 'added' ? '+' : kind === 'removed' ? '−' : ' ';
  const tone = ROW[kind];
  // Selection is a 2px accent left rule plus the active wash. An added or removed
  // row keeps its own ground under the selection, which is what the old cascade
  // did - the row's rule came after the global `.is-selected` and won.
  const ground = kind === 'context' ? (selected ? 'bg-active' : '') : tone.row;
  return (
    <div className={`flex items-baseline ${ground} ${selected ? 'border-l-2 border-accent' : ''}`}>
      <span className={`w-[46px] flex-none px-(--space-2) text-right ${tone.num}`}>{newNo ?? oldNo ?? ''}</span>
      <span className={`w-[18px] flex-none text-center ${tone.glyph}`}>{glyph}</span>
      <span className={`whitespace-pre pl-(--space-2) ${tone.code}`}>{code}</span>
    </div>
  );
}

/** Each part of a diff row, per kind. A context row's glyph is a space and takes the inherited colour. */
const ROW = {
  context: { row: '', num: 'bg-column text-tertiary', glyph: '', code: 'text-secondary' },
  added: {
    row: 'bg-diff-added-row',
    num: 'bg-diff-added-gutter text-diff-added-number',
    glyph: 'text-diff-added-glyph',
    code: 'text-diff-added-code',
  },
  removed: {
    row: 'bg-diff-removed-row',
    num: 'bg-diff-removed-gutter text-diff-removed-number',
    glyph: 'text-diff-removed-glyph',
    code: 'text-diff-removed-code',
  },
} as const;

export function HunkHeader({ children }: { children: ReactNode }) {
  return (
    <div className="border-y border-rule-inner bg-column px-(--space-4) py-(--space-1) text-tertiary [font:var(--type-mono-sm)]">
      {children}
    </div>
  );
}

/**
 * What the reviewer WAS HANDED stopped here - not what it saw.
 *
 * The reviewer holds `Read · Glob · Grep · Bash` and can go looking, and whether
 * it did is recorded per turn in `TurnActivity`. So this band reports the tool
 * count rather than asserting blindness, which turns an alarm into a judgement.
 */
export function TruncationBand({ children }: { children: ReactNode }) {
  return (
    <div className="border-y border-dashed border-rule-strong bg-alarm px-(--space-4) py-(--space-3) text-secondary [font:var(--type-body-sm)]">
      {children}
    </div>
  );
}
