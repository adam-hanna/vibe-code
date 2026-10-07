import { useSyncExternalStore } from 'react';
import * as host from '../host';
import * as pilot from '../pilot/pilot';
import type { Provider } from '../pilot/keys';

/**
 * Which models each road offers, as the vendors said (#223).
 *
 * Every picker read a list this repository shipped and every one had aged:
 * Opus 5.5 and Fable 5.1 could not be picked, and Codex's default had moved
 * on. *"What if claude introduces a new model, we have to change source code?
 * I really want to avoid that."* So nothing here is a model name. The two CLI
 * listings come from the host (`src/models.ts`), which asks `claude` and
 * `codex` on the subscription; the two API listings come from Rust
 * (`pilot/models.rs`), which asks each vendor with the stored key.
 *
 * **No fallback list**, because a fallback is a list somebody has to keep
 * current. A listing that failed says why, the value already chosen is kept,
 * and a name can be typed.
 *
 * The pure half is `optionsFor`; the store around it is the shape
 * `pilot/chatstore.ts` has, for the same reason - read synchronously by two
 * panes, filled once.
 */

/** The value that sends no model flag, so the CLI picks. `src/modelflag.ts`. */
export const CLI_DEFAULT = 'default';

export interface ModelOption {
  value: string;
  /** What the value runs today, when the source said. */
  resolves: string | null;
  name: string;
  description: string;
}

/** Null while it is being asked. */
export type Listing = { ok: true; models: readonly ModelOption[] } | { ok: false; why: string } | null;

/** The four roads: the two CLIs, and the two vendors' APIs. */
export type Source = 'claude' | 'codex' | 'anthropic' | 'openai';

export interface Choice {
  value: string;
  label: string;
  /** Not in the listing: kept so a select can represent its own value. */
  unlisted: boolean;
}

/**
 * What a picker draws: the listing as the source gave it, and the current value
 * appended when the listing does not hold it - never dropped, because a select
 * that cannot represent its value rewrites it by rendering.
 */
export function optionsFor(listing: Listing, current: string): readonly Choice[] {
  const models = listing?.ok === true ? listing.models : [];
  const out: Choice[] = models.map((m) => ({
    value: m.value,
    label: labelOf(m),
    unlisted: false,
  }));
  if (current !== '' && !models.some((m) => m.value === current)) {
    out.push({
      value: current,
      label: current === CLI_DEFAULT ? 'Default' : current,
      unlisted: listing?.ok === true,
    });
  }
  return out;
}

/** `Opus 5.5 · opus`, `Default · Fable 5.1`, `GPT-6-Luna`. */
export function labelOf(m: ModelOption): string {
  if (m.value === CLI_DEFAULT) return m.resolves === null ? 'Default' : `Default · ${m.description || m.resolves}`;
  return m.name === m.value ? m.value : `${m.name} · ${m.value}`;
}

/** The value a fresh picker starts on: the source's first, which for a CLI is its default. */
export function firstOf(listing: Listing): string | null {
  return listing?.ok === true ? (listing.models[0]?.value ?? null) : null;
}

/** Why there is no list, or null when there is one or it is still being asked. */
export function whyNot(listing: Listing): string | null {
  return listing?.ok === false ? listing.why : null;
}

// ---- the store --------------------------------------------------------------

type State = Readonly<Record<Source, Listing>>;

let state: State = { claude: null, codex: null, anthropic: null, openai: null };
const asking = new Set<Source>();
const listeners = new Set<() => void>();

function set(source: Source, listing: Listing): void {
  state = { ...state, [source]: listing };
  for (const l of listeners) l();
}

/**
 * Ask `source` once, through `ask`, unless it is already answered or being
 * asked. `fresh` asks again. A failure is kept until asked again, so a picker
 * can say why.
 */
export function ask(source: Source, run: () => Promise<Listing>, fresh = false): void {
  if (asking.has(source)) return;
  if (!fresh && state[source]?.ok === true) return;
  asking.add(source);
  if (fresh) set(source, null);
  run()
    .then((listing) => set(source, listing))
    .catch((err: unknown) => set(source, { ok: false, why: err instanceof Error ? err.message : String(err) }))
    .finally(() => asking.delete(source));
}

let askingCli = false;

/**
 * Ask the host what both CLIs offer. Once per window; `fresh` asks the CLIs
 * again, which is the refresh control's job after a CLI is updated.
 */
export function loadCliModels(fresh = false): void {
  if (askingCli) return;
  if (!fresh && state.claude?.ok === true && state.codex?.ok === true) return;
  askingCli = true;
  if (fresh) state = { ...state, claude: null, codex: null };
  host
    .models(fresh)
    .then((got) => {
      state = { ...state, claude: got.claude, codex: got.codex };
    })
    .catch((err: unknown) => {
      const failed: Listing = { ok: false, why: err instanceof Error ? err.message : String(err) };
      state = { ...state, claude: failed, codex: failed };
    })
    .finally(() => {
      askingCli = false;
      for (const l of listeners) l();
    });
  for (const l of listeners) l();
}

/** Ask a vendor what the stored key may use. Only called once a key is stored. */
export function loadApiModels(provider: Provider, fresh = false): void {
  ask(
    provider,
    () =>
      pilot.listModels(provider).then(
        (models): Listing => ({
          ok: true,
          models: models.map((m) => ({ value: m.id, resolves: m.id, name: m.name, description: '' })),
        }),
      ),
    fresh,
  );
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useModels(): State {
  return useSyncExternalStore(subscribe, () => state);
}

/** Test seam: forget everything. */
export function resetModels(): void {
  state = { claude: null, codex: null, anthropic: null, openai: null };
  asking.clear();
  askingCli = false;
}
