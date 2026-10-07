import { useEffect, useState } from 'react';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { cn } from '@/lib/utils';
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

/* The card's recurring styles, named once. Every colour is a token through `theme.css`. */
/** A row of the card: a chip, a control, a word beside them. */
const HEAD = 'flex flex-wrap items-center gap-3';
/**
 * Prose, so it is on the prose tier. `--text-tertiary` is documented as "labels,
 * timestamps" and this is a two-sentence paragraph about where a credential
 * lives - the tier was wrong independently of what its value is (#190).
 */
const NOTE = 'text-body-sm text-secondary';
/** A failure, in the keychain's or the search's own words. */
const ERROR = 'flex flex-wrap items-center gap-2 rounded-sm border border-rule-card bg-alarm px-3 py-1.5 text-body-sm text-primary';
/** A field and the button that submits it. */
const ENTRY = 'flex gap-2';
/**
 * A key or a path: typed, never read back. Monospace, because what goes in it
 * has to be recognised character by character.
 */
const FIELD =
  'min-w-0 flex-1 rounded-sm border border-rule-control bg-panel px-3 py-1.5 font-mono text-mono-sm text-primary outline-none placeholder:text-tertiary focus-visible:ring-1 focus-visible:ring-accent-border disabled:cursor-not-allowed disabled:opacity-50';

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
      <div className={HEAD}>
        {status.unreadable !== null ? (
          // Not "no key". The keychain could not be read, and saying "none"
          // would have the user enter one they already gave.
          <Badge>cannot tell</Badge>
        ) : status.present ? (
          <Badge variant="live">key stored</Badge>
        ) : (
          <Badge>no key</Badge>
        )}
        {status.present && (
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => run(() => keys.clear(status.provider))}>
            forget
          </Button>
        )}
      </div>
      {status.unreadable !== null && <div className={NOTE}>{status.unreadable}</div>}
      {/* `type="password"`, and it stays that way. There is no reveal toggle,
          because revealing implies reading something back and nothing in this
          window can - what is in this field is what the user just typed, and it
          is gone on submit. */}
      <form
        className={ENTRY}
        onSubmit={(e) => {
          e.preventDefault();
          if (entry.trim() === '' || busy) return;
          run(() => keys.set(status.provider, entry));
        }}
      >
        <input
          className={FIELD}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={entry}
          placeholder={status.present ? `replace the ${name} key` : `${name} API key`}
          onChange={(e) => setEntry(e.target.value)}
        />
        <Button variant="primary" type="submit" disabled={busy || entry.trim() === ''}>
          {status.present ? 'replace' : 'store'}
        </Button>
      </form>
      {error !== null && <div className={ERROR}>{error}</div>}
    </>
  );
}

/** Where the CLI is, said plainly: the path, and which look found it. */
function Found({ cli }: { cli: CliStatus }) {
  if (cli.found === null) {
    return (
      <div className={ERROR}>
        <Badge variant="alarm">not found</Badge> {cli.problem}
      </div>
    );
  }
  const via =
    cli.via === 'env' ? 'from the environment variable' : cli.via === 'settings' ? 'from your path below' : 'by searching';
  // A path someone has to recognise, so it is monospace and wraps anywhere - a
  // Windows install path is one unbroken word.
  return (
    <div className={HEAD}>
      <Badge variant="live">found</Badge>
      <code className="min-w-0 font-mono text-mono-sm text-primary [overflow-wrap:anywhere]">{cli.found}</code>
      <span className={NOTE}>{via}</span>
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
      className={ENTRY}
      onSubmit={(e) => {
        e.preventDefault();
        if (changed) onSave(typed.trim() === '' ? null : typed.trim());
      }}
    >
      <input
        className={FIELD}
        spellCheck={false}
        value={typed}
        disabled={disabled}
        placeholder="blank — vibe finds it"
        onChange={(e) => setTyped(e.target.value)}
      />
      <Button variant="primary" type="submit" disabled={disabled || !changed}>
        use this path
      </Button>
      {cli.configured !== null && (
        <Button variant="secondary" disabled={disabled} onClick={() => onSave(null)}>
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
    <div className="flex flex-col gap-3 rounded-md border border-rule-card bg-card p-4">
      <div className={HEAD}>
        <span className="text-section text-emphasis">{name}</span>
        {/* The two roads, as a segmented pair: the selected one takes the accent
            tint, which is the one place in the product a tint means "chosen". */}
        <div role="group" aria-label={`How ${name} is reached`} className="ml-auto inline-flex rounded-sm border border-rule-control-dim">
          {(['subscription', 'api'] as const).map((v) => (
            <button
              key={v}
              type="button"
              disabled={disabled}
              aria-pressed={route === v}
              onClick={() => onRoute(v)}
              className={cn(
                'h-7 cursor-pointer border-0 px-2.5 font-sans text-label font-medium first:rounded-l-sm last:rounded-r-sm',
                route === v ? 'bg-accent-tint text-accent-on-tint' : 'bg-card text-secondary hover:text-emphasis',
                disabled && 'cursor-not-allowed opacity-50',
              )}
            >
              {v === 'api' ? 'API key' : 'subscription'}
            </button>
          ))}
        </div>
      </div>

      {route === 'subscription' ? (
        <div className={NOTE}>
          Everything vibe does with {name} — every run turn and the pilot — goes through the{' '}
          <code>{bin}</code> CLI you are already logged into, and nothing is billed. An API key in
          your environment is removed from what <code>{bin}</code> sees, so it cannot quietly take
          over from the login.
        </div>
      ) : (
        <>
          <div className={NOTE}>
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
      <div className={NOTE}>
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
    <div className={ERROR}>
      <Badge variant="alarm">keychain</Badge> {failure}
    </div>
  );
}
