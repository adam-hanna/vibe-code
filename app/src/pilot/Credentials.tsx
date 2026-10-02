import { useEffect, useState } from 'react';
import { Button, MetaChip, Segmented, StateKicker } from '../design';
import * as keys from './keys';
import type { CliStatus } from '../host';
import type { KeyStatus, Provider } from './keys';

/**
 * How the pilot reaches each vendor, and the two things each road needs (#143,
 * #223).
 *
 * **Two choices per vendor, and nothing else on the card.** It used to be three
 * explanatory paragraphs above a key form, and the choice itself was made
 * somewhere else — in the pilot pane, per conversation, from a list that mixed a
 * CLI with two vendors. Asked for as *"two options for both anthropic and
 * openAI: (1) subscription, (2) api key"*, so each vendor is a card with that
 * switch, and the card shows what the chosen road needs:
 *
 * - **Subscription** — the CLI's own login: `claude` for Anthropic, `codex` for
 *   OpenAI. Nothing is billed.
 * - **API key** — a key from the OS keychain, billed to you, for runs and the
 *   pilot alike. The entry is the one this file has always had.
 *
 * Either way the card says how vibe finds the CLI and what it found, and takes a
 * path when the search is wrong.
 *
 * ## What the key entry may know
 *
 * Exactly three things: which provider, whether a key is stored, and — when it
 * could not tell — why not. **There is no field that displays a key**, not even
 * a masked one: a `sk-ant-…3f9a` in a screenshot is four more characters of a
 * secret than anybody needed. Replacing a key is entering a new one; there is no
 * edit affordance, because editing implies reading something back and nothing
 * here can.
 *
 * ## One road per vendor, for everything
 *
 * *"If we have api keys set, we should use them everywhere (pilot, runs, etc).
 * Same for subscriptions."* The road is not the pilot's: it decides how every
 * `claude` or `codex` child is authenticated as well (`src/auth.ts`). A run is
 * always one of those two CLIs whichever road is chosen, so where vibe found the
 * CLI is shown on both.
 */

const CLI_OF: Readonly<Record<Provider, 'claude' | 'codex'>> = { anthropic: 'claude', openai: 'codex' };
/** The variable a run's CLI is handed the key in (see `src/auth.ts`). */
const KEY_VAR: Readonly<Record<Provider, string>> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'CODEX_API_KEY',
};
const ENV_OF: Readonly<Record<Provider, string>> = {
  anthropic: 'VIBE_CLAUDE_BIN',
  openai: 'VIBE_CODEX_BIN',
};

/** The keychain row: whether a key is stored, and the field to store one. */
function KeyEntry({ status, onChanged }: { status: KeyStatus; onChanged: () => void }) {
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
    <>
      <div className="v-cred__head">
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
      {status.unreadable !== null && <div className="v-cred__note">{status.unreadable}</div>}
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
    </>
  );
}

/** Where the CLI is, said plainly: the path, and which look found it. */
function Found({ cli }: { cli: CliStatus }) {
  if (cli.found === null) {
    return (
      <div className="v-cred__error">
        <StateKicker tone="alarm">not found</StateKicker> {cli.problem}
      </div>
    );
  }
  const via =
    cli.via === 'env' ? 'from the environment variable' : cli.via === 'settings' ? 'from your path below' : 'by searching';
  return (
    <div className="v-cred__head">
      <MetaChip kind="checkable">found</MetaChip>
      <code className="v-cred__path">{cli.found}</code>
      <span className="v-cred__note">{via}</span>
    </div>
  );
}

/** The path field: blank means search, and saving it is the settings' write. */
function PathEntry({
  cli,
  disabled,
  onSave,
}: {
  cli: CliStatus;
  disabled: boolean;
  onSave: (next: string | null) => void;
}) {
  const [typed, setTyped] = useState(cli.configured ?? '');
  useEffect(() => setTyped(cli.configured ?? ''), [cli.configured]);
  const changed = typed.trim() !== (cli.configured ?? '');
  return (
    <form
      className="v-cred__entry"
      onSubmit={(e) => {
        e.preventDefault();
        if (changed) onSave(typed.trim() === '' ? null : typed.trim());
      }}
    >
      <input
        className="v-cred__field"
        spellCheck={false}
        value={typed}
        disabled={disabled}
        placeholder="blank — vibe finds it"
        onChange={(e) => setTyped(e.target.value)}
      />
      <Button level="primary" type="submit" disabled={disabled || !changed}>
        use this path
      </Button>
      {cli.configured !== null && (
        <Button level="secondary" disabled={disabled} onClick={() => onSave(null)}>
          search instead
        </Button>
      )}
    </form>
  );
}

export interface VendorProps {
  vendor: Provider;
  route: 'subscription' | 'api';
  onRoute: (next: 'subscription' | 'api') => void;
  cli: CliStatus;
  onCliPath: (next: string | null) => void;
  /** This vendor's keychain row, or null until the window has read it. */
  status: KeyStatus | null;
  onKeysChanged: () => void;
  /** Saving is impossible — global settings are off, or a save is in flight. */
  disabled: boolean;
}

/** One vendor: the two roads, and what the chosen one needs. */
export function Vendor({ vendor, route, onRoute, cli, onCliPath, status, onKeysChanged, disabled }: VendorProps) {
  const name = keys.PROVIDER_NAME[vendor];
  const bin = CLI_OF[vendor];
  return (
    <div className="v-cred">
      <div className="v-cred__head">
        <span className="v-cred__name">{name}</span>
        <Segmented
          cells={[
            { value: 'subscription', label: 'subscription', unavailable: disabled },
            { value: 'api', label: 'API key', unavailable: disabled },
          ]}
          value={route}
          onChange={(v) => onRoute(v === 'api' ? 'api' : 'subscription')}
        />
      </div>

      {route === 'subscription' ? (
        <div className="v-cred__note">
          Everything vibe does with {name} — every run turn and the pilot — goes through the{' '}
          <code>{bin}</code> CLI you are already logged into, and nothing is billed. An API key in
          your environment is removed from what <code>{bin}</code> sees, so it cannot quietly take
          over from the login.
        </div>
      ) : (
        <>
          <div className="v-cred__note">
            Everything vibe does with {name} is billed to this key: every run turn goes through{' '}
            <code>{bin}</code> with the key as <code>{KEY_VAR[vendor]}</code>, and the pilot calls
            the API with it directly. Keys are held in the OS keychain and never written to a
            project; nothing in this window can read one back. With no key stored here, a{' '}
            <code>{KEY_VAR[vendor]}</code> already in vibe&apos;s environment is used instead.
          </div>
          {status === null ? null : <KeyEntry status={status} onChanged={onKeysChanged} />}
        </>
      )}

      {/* The CLI on both roads: a run is always a `claude` or `codex` child,
          and the road only decides how that child is authenticated. */}
      <div className="v-cred__note">
        vibe looks for <code>{bin}</code> in this order: <code>{ENV_OF[vendor]}</code> if that is
        set, then the path below if you give one, then your <code>PATH</code> — preferring a real
        executable over a script shim — then the places {bin} usually installs to. If it found the
        wrong one, or none, give the path to the executable.
      </div>
      <Found cli={cli} />
      <PathEntry cli={cli} disabled={disabled} onSave={onCliPath} />
    </div>
  );
}

/** Why the keychain could not be read at all, when it could not. */
export function KeychainFailure({ failure }: { failure: string | null }) {
  if (failure === null) return null;
  return (
    <div className="v-cred__error">
      <StateKicker tone="alarm">keychain</StateKicker> {failure}
    </div>
  );
}
