import { ArrowDown } from 'lucide-react';
import { Button } from '@/ui/button';

/**
 * The way back to the end of a log that has stopped following it (#366).
 *
 * Drawn only while `useFollow` says the view is not following, and placed as
 * the scroller's last child: `sticky` at the bottom of a zero-height row, so it
 * stays in view over the content wherever the reader has scrolled, and takes no
 * room when it is not drawn. Pressing it is `jump`, which goes to the end and
 * arms following again. It does not animate: exactly one element on screen
 * pulses, and this is not it.
 */
export function JumpToEnd({ shown, onJump }: { shown: boolean; onJump: () => void }) {
  if (!shown) return null;
  return (
    <div className="pointer-events-none sticky bottom-0 flex h-0 flex-none justify-end overflow-visible">
      <Button
        variant="secondary"
        size="icon"
        className="pointer-events-auto -translate-y-full"
        aria-label="Jump to the latest"
        title="Jump to the latest"
        onClick={onJump}
      >
        <ArrowDown size={14} aria-hidden />
      </Button>
    </div>
  );
}
