import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/ui/button';
import { confirmed } from '../confirm';
import { clock, dayOf } from '../cockpit/format';
import { listen } from '../transport';
import * as api from './api';
import type { PhoneSettings } from './boot';
import { lockWarning } from './pairing';
import { called } from './reason';
import type { Desktops as Listed } from './reason';
import { rowStatus } from './sentences';

/**
 * Desktops, the phone's home screen (#346): every paired desktop, each with
 * whether it can be reached and when it was last seen, and **This phone** at the
 * foot - its name, the app lock and notifications.
 *
 * The open desktop shows its live connection; every other one shows its last
 * probe, taken when this screen opens and when the app comes back to the
 * foreground. A list that cannot be read says so and is never drawn as empty.
 */

const H = 'm-0 font-bold text-label uppercase tracking-label text-tertiary';
const NOTE = 'm-0 text-body-sm text-tertiary';
const ROW = 'flex flex-col gap-1 border-b border-rule-inner py-3';
const TEXT =
  'w-full rounded-sm border border-rule-control bg-card p-2 text-body-sm text-primary outline-none focus-visible:ring-1 focus-visible:ring-accent-border';
const CHECK = 'flex cursor-pointer items-baseline gap-2 text-body-sm text-secondary';

export function Desktops({
  settings,
  problem,
  onSettings,
  onOpen,
  onPair,
}: {
  settings: PhoneSettings;
  problem: string | null;
  onSettings: (next: PhoneSettings) => void;
  onOpen: (id: string) => void;
  onPair: () => void;
}) {
  const [list, setList] = useState<Listed | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const read = useCallback(() => {
    void api
      .desktops()
      .then((l) => {
        setList(l);
        setNow(Date.now());
      })
      .catch((err: unknown) => setFailure(String(err)));
  }, []);

  useEffect(() => {
    read();
    void api.probe().catch(() => undefined);
    const linkChanged = listen('phone://link', read);
    const onVisible = () => {
      if (document.hidden) return;
      read();
      void api.probe().catch(() => undefined);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      void linkChanged.then((f) => f());
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [read]);

  const act = (work: Promise<unknown>) => {
    setFailure(null);
    void work.then(read).catch((err: unknown) => setFailure(err instanceof Error ? err.message : String(err)));
  };

  const unpair = (id: string) => act(confirmed('Unpair a desktop').then(() => api.unpair(id)));

  const set = (patch: Parameters<typeof api.setSettings>[0]) =>
    act(api.setSettings(patch).then(onSettings));

  const warning = lockWarning(settings.deviceLock);

  return (
    <main className="flex min-h-full flex-col gap-4 bg-page p-4 text-primary">
      <header className="flex items-center justify-between">
        <h1 className="m-0 text-emphasis font-bold">Desktops</h1>
        <Button variant="primary" onClick={onPair}>
          Pair a desktop
        </Button>
      </header>

      {problem !== null && <p className={NOTE}>{problem}</p>}
      {failure !== null && <p className={NOTE}>{failure}</p>}

      <section>
        {list === null ? null : list.problem !== null ? (
          <p className={NOTE}>{list.problem}</p>
        ) : list.desktops.length === 0 ? (
          <p className={NOTE}>No desktop is paired with this phone yet. Open Settings → Remote access on your desktop and press Pair a phone.</p>
        ) : (
          list.desktops.map((d) => {
            const name = called(d);
            const status = rowStatus(d.reach, list.current === d.id ? list.link : null, name, d.lastSeen, now);
            return (
              <div key={d.id} className={ROW}>
                <div className="flex items-center justify-between gap-2">
                  {renaming?.id === d.id ? (
                    <input
                      className={TEXT}
                      value={renaming.name}
                      placeholder={d.desktopName ?? ''}
                      onChange={(e) => setRenaming({ id: d.id, name: e.target.value })}
                    />
                  ) : (
                    <span className="text-body font-medium">{name}</span>
                  )}
                  <div className="flex gap-1">
                    {renaming?.id === d.id ? (
                      <Button
                        size="sm"
                        onClick={() => {
                          const next = renaming.name.trim();
                          setRenaming(null);
                          act(api.rename(d.id, next === '' ? null : next));
                        }}
                      >
                        Save
                      </Button>
                    ) : (
                      <Button size="sm" variant="quiet" onClick={() => setRenaming({ id: d.id, name: d.name ?? '' })}>
                        Rename
                      </Button>
                    )}
                    <Button size="sm" onClick={() => onOpen(d.id)}>
                      Open
                    </Button>
                    <Button size="sm" variant="loss" onClick={() => unpair(d.id)}>
                      Unpair
                    </Button>
                  </div>
                </div>
                <p className={status.error ? 'm-0 text-body-sm text-secondary' : NOTE}>{status.text}</p>
                {status.action === 'pairAgain' && (
                  <Button size="sm" className="self-start" onClick={onPair}>
                    Pair again
                  </Button>
                )}
                <p className={NOTE}>
                  {d.lastSeen === null ? 'Never connected' : `Last seen ${dayOf(d.lastSeen)}, ${clock(d.lastSeen)}`}
                </p>
                <details className="text-body-sm text-tertiary">
                  <summary className="cursor-pointer">Details</summary>
                  <p className="m-0 break-all font-mono text-mono-sm">{d.id}</p>
                  <p className="m-0 break-all font-mono text-mono-sm">{d.relay ?? 'no relay hint'}</p>
                </details>
              </div>
            );
          })
        )}
      </section>

      <ThisPhone settings={settings} warning={warning} onSet={set} />
    </main>
  );
}

/** The phone's own settings, at the foot of Desktops (#346). */
function ThisPhone({
  settings,
  warning,
  onSet,
}: {
  settings: PhoneSettings;
  warning: string | null;
  onSet: (patch: Parameters<typeof api.setSettings>[0]) => void;
}) {
  const [name, setName] = useState(settings.name);
  return (
    <section className="flex flex-col gap-3 border-t border-rule-structure pt-4">
      <h2 className={H}>This phone</h2>
      {settings.problem !== null && <p className={NOTE}>{settings.problem}</p>}
      <label className="flex flex-col gap-1 text-body-sm text-secondary">
        Name, as your desktops show it
        <input
          className={TEXT}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            if (name.trim() !== settings.name) onSet({ name });
          }}
        />
      </label>
      <label className={CHECK}>
        <input type="checkbox" checked={settings.lock} onChange={(e) => onSet({ lock: e.target.checked })} />
        App lock
      </label>
      <p className={NOTE}>
        {settings.lock
          ? 'Vibe asks for Face ID, Touch ID or your fingerprint or PIN when it opens, and again after five minutes in the background.'
          : 'With the app lock off, anybody who can open this phone can control your desktops: run, stop and delete runs, and spend on your API keys.'}
      </p>
      {warning !== null && <p className="m-0 text-body-sm text-secondary">{warning}</p>}
      <label className={CHECK}>
        <input type="checkbox" checked={settings.notify} onChange={(e) => onSet({ notify: e.target.checked })} />
        Notifications
      </label>
      <p className={NOTE}>
        A gate held, a run that needs you, finished or failed, and a pilot reply. Only while Vibe is still running on
        this phone: once the phone closes it, nothing arrives.
      </p>
    </section>
  );
}
