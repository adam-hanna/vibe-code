import { useEffect, useState } from 'react';
import { Badge } from '@/ui/badge';
import { STEPS, THEMES, type Theme } from '../cockpit/appearance';
import { PANE } from '../cockpit/pane';
import { CopyText } from '../pilot/CopyText';
import type { Build } from '../host';
import { local } from '../transport';

/**
 * The phone's own settings (#347): what is true of this device rather than of
 * the desktop it reaches. The settings for all projects are the desktop's
 * files, and a change there is a change on the desktop; everything here stays
 * on the phone.
 *
 * Four things, because four are real today:
 *
 * - **The text size and the palette**, which a phone keeps under its own keys
 *   (`deviceKey`), so they are set here and not among the desktop's settings.
 * - **This phone's id**: the public half of its device key, which is what a
 *   desktop knows it by, with a copy control because it is a string for a
 *   bug report or a comparison rather than for reading.
 * - **The desktop it is connected to**: whether it is, and the build it runs.
 *
 * The rest the product spec lists here - app lock, notifications, and the
 * paired desktops as a list with a way to forget one - arrive with pairing.
 * Nothing is drawn for them: a switch that does nothing would be a promise this
 * build does not keep.
 */
/**
 * This phone's id, asked of its own Rust: the id, the phone's sentence for why
 * it has none, or null while the answer is on its way.
 */
export function usePhoneIdentity(): { id: string } | { why: string } | null {
  const [identity, setIdentity] = useState<{ id: string } | { why: string } | null>(null);
  useEffect(() => {
    let live = true;
    local<{ endpointId: string }>('phone_identity').then(
      (r) => live && setIdentity({ id: r.endpointId }),
      (err: unknown) => live && setIdentity({ why: err instanceof Error ? err.message : String(err) }),
    );
    return () => {
      live = false;
    };
  }, []);
  return identity;
}

export function PhoneSettings({
  scale,
  onScale,
  theme,
  onTheme,
  connected,
  failure,
  build,
}: {
  scale: number;
  onScale: (next: number) => void;
  theme: Theme;
  onTheme: (next: Theme) => void;
  connected: boolean;
  /** Why the desktop cannot be reached, in the host's words, or null. */
  failure: string | null;
  /** The desktop's build, off its status, or null before one was read. */
  build: Build | null;
}) {
  const identity = usePhoneIdentity();

  return (
    <div className={`${PANE} gap-6 px-4`}>
      <h2 className="m-0 text-title font-semibold tracking-tight text-display">This phone</h2>

      <section className="flex flex-col gap-2">
        <h3 className={H}>text size</h3>
        <p className={NOTE}>This phone only — the desktop keeps a size of its own.</p>
        <div className="flex flex-wrap items-baseline gap-x-5 gap-y-3 py-2">
          {STEPS.map((step) => (
            <label key={step.scale} className="flex cursor-pointer items-baseline gap-2 text-secondary">
              <input type="radio" name="phone-type-scale" checked={scale === step.scale} onChange={() => onScale(step.scale)} />
              <span style={{ fontSize: `calc(var(--size-body) * ${String(step.scale)})` }}>{step.label}</span>
            </label>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className={H}>light or dark</h3>
        <p className={NOTE}>This phone only, like the text size.</p>
        <div className="flex flex-wrap items-baseline gap-x-5 gap-y-3 py-2">
          {THEMES.map((t) => (
            <label key={t.theme} className="flex cursor-pointer items-baseline gap-2 text-secondary">
              <input type="radio" name="phone-theme" checked={theme === t.theme} onChange={() => onTheme(t.theme)} />
              <span>{t.label}</span>
            </label>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className={H}>this phone&apos;s id</h3>
        {identity === null ? (
          <p className={NOTE}>reading…</p>
        ) : 'why' in identity ? (
          // The phone's own sentence for why it has no key.
          <p className="m-0 text-body-sm text-loss">{identity.why}</p>
        ) : (
          <>
            <div className="flex items-start gap-2">
              <code className="min-w-0 flex-1 break-all font-mono text-mono-sm text-primary select-text">{identity.id}</code>
              <CopyText text={identity.id} label="Copy this phone's id" />
            </div>
            <p className={NOTE}>
              What a desktop knows this phone by: the public half of its device key. It is safe to
              share — knowing it lets nobody connect as this phone, since that takes the private
              half, which never leaves it.
            </p>
          </>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className={H}>the desktop</h3>
        <div className="flex flex-wrap items-center gap-2 text-body-sm text-secondary">
          {connected ? <Badge>connected</Badge> : <Badge variant="alarm">not connected</Badge>}
          {connected && build !== null && (
            <span>
              Vibe <code className="font-mono text-mono-sm">{build.version}</code>
              {build.commit !== null && (
                <>
                  {' '}
                  · <code className="font-mono text-mono-sm">{build.commit}</code>
                </>
              )}
            </span>
          )}
        </div>
        {!connected && failure !== null && <p className="m-0 text-body-sm text-loss">{failure}</p>}
        <p className={NOTE}>
          The desktop this phone reaches. Pairing another, and forgetting one, are not in this build
          yet.
        </p>
      </section>
    </div>
  );
}

const H = 'm-0 font-bold text-label uppercase tracking-label text-tertiary';
const NOTE = 'm-0 text-body-sm text-tertiary';
