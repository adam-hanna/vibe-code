/**
 * What the artifact panes share, named once (the UI rework).
 *
 * Plans, Plan critique, Code review, Code, Questions, Verify, Spend, Output and
 * Commands are one layout with nine subjects: a scrolling column of sections or
 * cards, a head row saying how many, a note tier for what is absent and why.
 * These were `.v-doc`, `.v-q`, `.v-verify`, `.v-spend`, `.v-dp` and `.v-cmds` in
 * the stylesheet, nine copies of one shape that had already drifted - three
 * paddings, two gaps. One definition here, and every colour is a token through
 * `theme.css`, so `audit:contrast` still decides whether a pairing is legible.
 */

/** The pane itself: the main region's scrolling column. */
export const PANE = 'flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto bg-page px-7 py-6';

/**
 * The pane with nothing to show: a kicker, a sentence, maybe a way to try
 * again. Centred, because an empty pane is a statement about the pane and not a
 * document to read from the top.
 */
export const EMPTY = 'flex min-h-0 flex-1 flex-col items-center justify-center gap-2 overflow-y-auto bg-page px-7 py-6 text-center text-body text-secondary';

/** The head row: how many of the thing there are, and the reread control. */
export const HEAD = 'mb-2 flex items-baseline justify-between gap-3 text-label uppercase tracking-label text-tertiary';

/** A small uppercase label over a figure or a block. */
export const LABEL = 'text-label uppercase tracking-label text-tertiary';

/** A sentence about the pane or a section: a reading state, a named absence. */
export const NOTE = 'm-0 text-body-sm text-tertiary';

/**
 * The file's own name, which is what makes a section and the artifact behind it
 * checkable against each other. Monospace because it is a string somebody may go
 * and type.
 */
export const FILE = 'font-mono text-mono-sm text-tertiary';

/**
 * A document, as it is on disk. `pre` because a plan IS markdown and rendering it
 * would mean shipping a parser to make prose prettier - the thing a person reads
 * a plan version for is the exact words the critic was shown.
 */
export const DOCUMENT =
  'm-0 whitespace-pre-wrap rounded-sm border border-rule-card bg-chrome p-4 font-mono text-mono-sm leading-relaxed text-secondary [overflow-wrap:anywhere]';

/** A monospace block that may be long: a command's output, a diff block, a payload. */
export const BLOCK =
  'm-0 overflow-auto whitespace-pre-wrap rounded-sm border border-rule-inner bg-panel px-3 py-2 font-mono text-mono-sm text-secondary [overflow-wrap:anywhere]';

/** A card inside a pane: one question, one gate, one command. */
export const CARD = 'rounded-md border border-rule-card bg-card p-4';

/** A field a person types into, inside a pane. */
export const FIELD =
  'rounded-sm border border-rule-control bg-panel px-3 py-1.5 font-sans text-body-sm text-primary outline-none placeholder:text-tertiary focus-visible:ring-1 focus-visible:ring-accent-border disabled:cursor-not-allowed disabled:opacity-50';
