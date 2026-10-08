/**
 * The same mark at window and welcome sizes; it is artwork, never a run
 * measurement. It is all that is left of this file: the hand-drawn icon set
 * beside it was replaced by `lucide-react` in the rework and went with the
 * gallery, its last caller (#237).
 */
export function VibeMark({ large = false }: { large?: boolean }) {
  return <span
    className={`inline-flex flex-none items-center justify-center bg-accent-fill text-on-accent ${large ? 'size-11 rounded-[14px]' : 'size-8 rounded-[10px]'}`}
    aria-hidden="true"
  >
    <svg viewBox="0 0 40 40" fill="none" className="size-full">
      <path d="M10 12 20 29 30 12M15 12l5 9 5-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  </span>;
}
