import { useState } from 'react';
import { Button, MetaChip, StateKicker } from '../design';
import * as keys from './keys';
import type { KeyStatus, Provider } from './keys';

/**
 * Entering the pilot's credentials (#143).
 *
 * One row per provider, and each row shows exactly three things it is allowed to
 * know: which provider, whether a key is stored, and — when it could not tell —
 * why not. **There is no field that displays a key**, not even a masked one: a
 * `sk-ant-…3f9a` in a screenshot is four more characters of a secret than
 * anybody needed, and the only decision this UI drives is whether to offer the
 * provider.
 *
 * Replacing a key is entering a new one. There is no edit affordance, because
 * editing implies reading something back and nothing here can.
 */

function Row({
  status,
  onChanged,
}: {
  status: KeyStatus;
  onChanged: () => void;
}) {
  const [entry, setEntry] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = keys.PROVIDER_NAME[status.provider];

  const run = (work: () => Promise<void>): void => {
    setBusy(true);
    setError(null);
    void work()
      .then(() => {
        setEntry('');
        onChanged();
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="v-cred">
      <div className="v-cred__head">
        <span className="v-cred__name">{name}</span>
        {status.unreadable !== null ? (
          // Not "no key". The keychain could not be read, and saying "none"
          // would have the user enter one they already gave.
          <MetaChip>cannot tell</MetaChip>
        ) : status.present ? (
          <MetaChip kind="checkable">key stored</MetaChip>
        ) : (
          <MetaChip>no key</MetaChip>
        )}
        {status.present && (
          <Button level="secondary" disabled={busy} onClick={() => run(() => keys.clear(status.provider))}>
            forget
          </Button>
        )}
      </div>

      {status.unreadable !== null && (
        <div className="v-cred__note">{status.unreadable}</div>
      )}

      <form
        className="v-cred__entry"
        onSubmit={(e) => {
          e.preventDefault();
          if (entry.trim() === '' || busy) return;
          run(() => keys.set(status.provider, entry));
        }}
      >
        <input
          className="v-cred__field"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={entry}
          placeholder={status.present ? `replace the ${name} key` : `${name} API key`}
          onChange={(e) => setEntry(e.target.value)}
        />
        <Button level="primary" type="submit" disabled={busy || entry.trim() === ''}>
          {status.present ? 'replace' : 'store'}
        </Button>
      </form>

      {error !== null && <div className="v-cred__error">{error}</div>}
    </div>
  );
}

/**
 * What this form is given and what it hands back.
 *
 * Neither is state it owns. Storing a key changes a fact the pilot pane needs as
 * much as this form does, and #188 is what happened when each held its own copy:
 * this one refreshed, the pilot did not, and the composer stayed disabled behind
 * a snapshot taken at launch. The window reads the keychain in one place now.
 */
export interface CredentialsProps {
  statuses: readonly KeyStatus[] | null;
  /** Why presence could not be read at all, or null. */
  failure: string | null;
  /** Something changed; ask the keychain again. */
  onChanged: () => void;
}

export function Credentials({ statuses, failure, onChanged }: CredentialsProps) {
  if (failure !== null) {
    return (
      <div className="v-creds">
        <StateKicker tone="alarm">keychain</StateKicker> {failure}
      </div>
    );
  }
  if (statuses === null) return <div className="v-creds" />;

  const ready: readonly Provider[] = keys.usable(statuses);

  return (
    <div className="v-creds">
      <div className="v-creds__head">
        <span className="v-creds__title">pilot credentials</span>
        {/* One provider is a supported state and is said so, plainly. It is
            probably the likeliest first run: somebody with one subscription
            trying this before buying a second. */}
        <span className="v-creds__summary">
          {ready.length === 0
            ? 'no provider configured — the pilot cannot run'
            : ready.length === 1
              ? `${keys.PROVIDER_NAME[ready[0] as Provider]} only, which is enough`
              : 'both providers configured'}
        </span>
      </div>

      {statuses.map((status) => (
        <Row key={status.provider} status={status} onChanged={onChanged} />
      ))}

      <div className="v-creds__note">
        Keys are held in the OS keychain and never written to the project. Nothing in this window
        can read one back — the request is made by the app itself.
      </div>
    </div>
  );
}
