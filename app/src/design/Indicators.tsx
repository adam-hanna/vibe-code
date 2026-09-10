import type { ReactNode } from 'react';

/** Tabs, the liveness dot, the proportion bar, and the diff rows. */

export function Tabs({
  tabs,
  value,
  onChange,
}: {
  tabs: readonly { value: string; label: ReactNode; count?: number }[];
  value: string;
  onChange?: ((v: string) => void) | undefined;
}) {
  return (
    <div className="v-tabs" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.value}
          type="button"
          role="tab"
          aria-selected={t.value === value}
          className={`v-tab${t.value === value ? ' is-on' : ''}`}
          onClick={() => onChange?.(t.value)}
        >
          {t.label}
          {t.count !== undefined && <span className="v-tab__count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

/**
 * Four states, because liveness is not two-valued.
 *
 * `src/lock.ts` reports `running | interrupted | not-running | unknown`, and the
 * fourth is the one that matters here: an unasked question and an unanswerable
 * one are the same thing, so `absent` claims nothing rather than claiming death.
 */
export type Liveness = 'live' | 'quiet' | 'waiting' | 'absent';

export function LivenessDot({ state }: { state: Liveness }) {
  return <span className={`v-dot v-dot--${state}`} aria-label={state} />;
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
export function ThinkingWave({ label = 'working' }: { label?: string }) {
  return (
    <span className="v-wave" role="status" aria-label={label}>
      <span className="v-wave__dot" />
      <span className="v-wave__dot" />
      <span className="v-wave__dot" />
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
export function Bar({
  segments,
}: {
  /** Null means unmeasurable - drawn dashed, not empty. */
  segments: readonly { share: number; step: 1 | 2 | 3 }[] | null;
}) {
  if (segments === null || segments.length === 0) {
    return <div className="v-bar v-bar--unavailable v-hatch" aria-label="not measured" />;
  }
  return (
    <div className="v-bar">
      {segments.map((s, i) => (
        <div
          // eslint-disable-next-line react/no-array-index-key
          key={i}
          className={`v-bar__seg--${s.step}`}
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
  const mod = kind === 'context' ? '' : ` v-diff__row--${kind}`;
  return (
    <div className={`v-diff__row${mod}${selected ? ' is-selected' : ''}`}>
      <span className="v-diff__num">{newNo ?? oldNo ?? ''}</span>
      <span className="v-diff__glyph">{glyph}</span>
      <span className="v-diff__code">{code}</span>
    </div>
  );
}

export function HunkHeader({ children }: { children: ReactNode }) {
  return <div className="v-diff__hunk">{children}</div>;
}

/**
 * What the reviewer WAS HANDED stopped here - not what it saw.
 *
 * The reviewer holds `Read · Glob · Grep · Bash` and can go looking, and whether
 * it did is recorded per turn in `TurnActivity`. So this band reports the tool
 * count rather than asserting blindness, which turns an alarm into a judgement.
 */
export function TruncationBand({ children }: { children: ReactNode }) {
  return <div className="v-diff__truncated">{children}</div>;
}
