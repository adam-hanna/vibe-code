import { useEffect, useRef, useState } from 'react';
import { Check, Copy, X } from 'lucide-react';
import { cn } from '@/lib/utils';

/** How long the ✓ or ✗ stays before the control is a copy icon again. */
const SETTLE_MS = 1500;

/**
 * One copy control for a block of chat text (#256).
 *
 * **It says whether it worked**, the rule `Diagnostics.tsx` follows for the same
 * reason: a clipboard write can be refused, and a control that silently did
 * nothing has the reader pasting whatever was on the clipboard before. So the
 * icon becomes ✓ or ✗ and the label says which, then settles back - unlike a
 * diagnostics fact, a chat has dozens of these and a permanent ✓ on every one
 * pressed would stop meaning *just now*.
 *
 * An icon and a tooltip rather than a word: the chat is the front door and the
 * text is what it is for, so a control on every message stays quiet.
 */
export function CopyText({ text, label, className }: { text: string; label: string; className?: string }) {
  const [copied, setCopied] = useState<'yes' | 'no' | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  const settle = (result: 'yes' | 'no'): void => {
    setCopied(result);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(null), SETTLE_MS);
  };

  const copy = (): void => {
    // `navigator.clipboard` can be absent as well as refuse, so both are a ✗.
    const write = navigator.clipboard?.writeText(text);
    if (write === undefined) {
      settle('no');
      return;
    }
    void write.then(() => settle('yes')).catch(() => settle('no'));
  };

  const said = copied === 'yes' ? 'copied' : copied === 'no' ? 'could not copy' : label;
  return (
    <button
      type="button"
      className={cn(
        'flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm border border-transparent bg-transparent text-tertiary hover:text-emphasis focus-visible:text-emphasis',
        copied === 'no' && 'text-alarm',
        className,
      )}
      onClick={copy}
      aria-label={said}
      title={said}
    >
      {copied === 'yes' ? (
        <Check className="size-3.5" aria-hidden />
      ) : copied === 'no' ? (
        <X className="size-3.5" aria-hidden />
      ) : (
        <Copy className="size-3.5" aria-hidden />
      )}
    </button>
  );
}
