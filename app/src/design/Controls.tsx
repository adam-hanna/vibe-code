import type { ButtonHTMLAttributes, ReactNode } from 'react';

/**
 * Button, field, radio, checkbox, segmented switch.
 *
 * Every interaction state these have is in `components.css`, stated once. None
 * of them is expressed here, on purpose: a hover rule written in a component is
 * a hover rule that will be written differently in the next component.
 */

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  level?: 'primary' | 'secondary' | 'tertiary';
};

/** One primary per region. That is a design rule this cannot enforce, only obey. */
export function Button({ level = 'secondary', className = '', ...rest }: ButtonProps) {
  return <button className={`v-btn v-btn--${level} ${className}`.trim()} {...rest} />;
}

export function Field({
  value,
  unit,
  state = 'rest',
  onChange,
}: {
  value: string;
  unit?: string | undefined;
  /** `empty` is dashed; `locked` is dashed AND dim - unavailable by rule. */
  state?: 'rest' | 'empty' | 'locked';
  onChange?: ((v: string) => void) | undefined;
}) {
  const mod = state === 'rest' ? '' : ` v-field--${state}`;
  return (
    <label className={`v-field${mod}`}>
      <input
        value={value}
        readOnly={state === 'locked' || onChange === undefined}
        onChange={(e) => onChange?.(e.target.value)}
        style={{ all: 'unset', flex: 1, minWidth: 0 }}
      />
      {unit !== undefined && <span className="v-field__unit">{unit}</span>}
    </label>
  );
}

/** Chevrons at 12, per the icon rule. Steppers are the only numeric affordance. */
export function Stepper({ onStep }: { onStep?: ((delta: 1 | -1) => void) | undefined }) {
  return (
    <span className="v-stepper">
      <button type="button" aria-label="increase" onClick={() => onStep?.(1)}>
        ▴
      </button>
      <button type="button" aria-label="decrease" onClick={() => onStep?.(-1)}>
        ▾
      </button>
    </span>
  );
}

/**
 * Square, 12 and 13px. A locked mark drops to rule grey rather than
 * disappearing: the answer is still visible, it just stops claiming to be
 * actionable.
 */
export function Radio({ on, locked = false }: { on: boolean; locked?: boolean }) {
  return (
    <span
      role="radio"
      aria-checked={on}
      className={`v-radio${on ? ' is-on' : ''}${locked ? ' is-locked' : ''}`}
      tabIndex={locked ? -1 : 0}
    />
  );
}

export function Checkbox({ on, locked = false }: { on: boolean; locked?: boolean }) {
  return (
    <span
      role="checkbox"
      aria-checked={on}
      className={`v-check${on ? ' is-on' : ''}${locked ? ' is-locked' : ''}`}
      tabIndex={locked ? -1 : 0}
    >
      ✓
    </span>
  );
}

/**
 * Two or three cells. The only toggle in the system - there is no pill, and
 * adding one would mean two things that look different and do the same job.
 */
export function Segmented({
  cells,
  value,
  onChange,
}: {
  cells: readonly { value: string; label: ReactNode; unavailable?: boolean }[];
  value: string;
  onChange?: ((v: string) => void) | undefined;
}) {
  return (
    <div className="v-seg" role="group">
      {cells.map((c) => (
        <button
          key={c.value}
          type="button"
          className={c.value === value ? 'is-on' : ''}
          disabled={c.unavailable === true}
          aria-pressed={c.value === value}
          onClick={() => onChange?.(c.value)}
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}
