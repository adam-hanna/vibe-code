import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Button, MetaChip, StateKicker } from '../design';
import * as host from '../host';
import { KeychainFailure, Vendor } from '../pilot/Credentials';
import type { PilotLimits } from '../pilot/ledger';
import { Confirm } from './Confirm';
import { Section } from './Disclosure';
import { STEPS } from './appearance';
import { pickDirectory } from './pick';
import { projectName } from './projects';
import { DRAFTS_KEY, draftsFor, readDrafts, removeDraft, saveDraft } from './drafts';
import type { Draft } from './drafts';
import type { KeyStatus } from '../pilot/keys';
import type { ConfigFrame, PromptsFrame } from '../host';
import { CLI_DEFAULT, loadCliModels, optionsFor, useModels, whyNot } from './models';
import type { Listing } from './models';

/**
 * Everything that is a setting, in one screen (`1h`, `1i`, #223).
 *
 * **The form and the raw file are the same file the CLI reads, and this keeps
 * that true structurally rather than by promise.** Every save is a patch sent to
 * the host, merged into `vibe.config.json` by `writeConfigPatch`, validated by
 * the same `validate()` `loadConfig` runs — and **answered with the config that
 * resulted**. This screen never assumes its own save took effect.
 *
 * ## Three kinds of setting, and the sections say which is which
 *
 * They are not interchangeable and a screen that hid the difference would be
 * lying about where a change goes:
 *
 * - **The project's** — gates, roles. `vibe.config.json`, meant to be committed,
 *   and every run in this repository gets it.
 * - **This window's** — the type scale. `localStorage`, this machine only. How
 *   big you like your text is not a fact about any run, which is the same rule
 *   `projects.ts` states for the project list.
 * - **This machine's secrets** — the pilot's API keys. The OS keychain, and
 *   deliberately not `vibe.config.json`: that file is committed, and
 *   `validateConfig` reports bad values **by name**, which is the one thing that
 *   must never happen to a secret.
 *
 * ## Subscription against keys, which is one question per vendor
 *
 * It used to be two questions about two processes — a run's agents were always
 * your subscriptions and only the pilot could take a key — and the screen said
 * so. That was reversed at the owner's word (#223): *"If we have api keys set,
 * we should use them everywhere (pilot, runs, etc). Same for subscriptions."*
 * So each vendor has one road, `auth.<vendor>` in the settings for all
 * projects, and `src/auth.ts` applies it to every `claude` or `codex` child — a
 * run turn, a preflight probe, the subscription pilot. On a key, the pilot is an
 * HTTP request this app makes and `ledger.ts` prices it; a run on a key is still
 * counted in tokens, because the CLI is what reports it.
 *
 * ## Why the gate matrix is the centre of the project section
 *
 * #140 made the gate matrix configuration and left every row `step`, saying in
 * `DEFAULT_GATES`'s own comment that this was *"very probably not the default
 * anyone wants to keep — but changing it is a decision for whoever has the
 * settings screen in front of them"*. This is that screen, and #211 is that
 * decision being made: the two planning rounds now run through by default,
 * because they are the loop arguing with itself and the critic reads the result
 * either way. The four where code gets written, a diff appears, a gate fails or
 * findings buy a fix turn still hold.
 *
 * Which makes this screen's job the opposite one — putting the holds back. A
 * default that stops less is only safe if the person who wants more can see
 * where it stopped stopping, which is the `default` chip on every unnamed row.
 *
 * The rows, the modes and the two boundaries that **cannot** hold all come from
 * `src/gates.ts` over the wire, so this cannot offer a boundary the loop does
 * not have or a mode it does not honour.
 *
 * ## What each mode costs, said on the row
 *
 * The difference between the two holding modes is *what a hold costs*, and it is
 * not obvious from their names. `step` holds and asks, which is free here
 * because the app runs the loop in-process — but **a terminal cannot answer a
 * promise**, so from the CLI a `step` row runs straight through. `stop` asks
 * nobody: the run ends there, resumably, whoever is listening.
 */

/** What each mode does, and what it costs. The wording is `src/gates.ts`'s. */
const MODE_NOTE: Readonly<Record<string, string>> = {
  auto: 'runs through without asking',
  step: 'holds and asks — free here, ignored by a terminal',
  stop: 'ends the run, resumably, whoever is listening',
};

/**
 * The loop's caps, in the order a run reaches them.
 *
 * Every key here is a `loop.*` the config validator already knows and a
 * `--max-*` `parseArgs` already takes, so this is a form over settings that
 * existed rather than new configuration. The notes say what **reaching** one
 * costs, because that is the decision somebody is making when they raise it.
 */
const LIMITS: readonly { key: string; note: string }[] = [
  {
    key: 'maxQuestionRounds',
    note: 'how many times the planner may ask, and have the answerer answer, before it gives up and asks you',
  },
  {
    key: 'maxPlanRounds',
    note: 'how many times the plan may be sent back by the critique. A question round no longer spends one of these',
  },
  { key: 'maxReviewRounds', note: 'how many fix-and-re-review cycles the code gets' },
  { key: 'maxVerifyRounds', note: 'how many times a failing verification gate may be fixed' },
];

/**
 * A number that is saved when you leave it, never on every keystroke.
 *
 * **Each save is a round trip that rewrites `vibe.config.json` and answers with
 * the config that resulted**, so a patch per character would be a file rewritten
 * five times to type `12` — and the intermediate `1` is a real, valid, wrong
 * setting that a run starting in that moment would take.
 *
 * Empty is refused rather than sent. `Number('')` is 0, and 0 means something
 * specific in three of these five keys, so a cleared field must not arrive as a
 * ceiling nobody typed — the same rule `4a`'s override fields already follow.
 */
/**
 * How many saves have been refused on this screen (#223).
 *
 * A field re-seeds from what is in force when the saved value changes, and a
 * refused save changes nothing, so the field went on showing the number that
 * was typed at it - which read as a save that worked. *"I can't change
 * maxWaitMinutes in project settings"*: the write was refused because a run
 * was going, the sentence saying so was at the top of a long page, and the
 * field beside the cursor said the opposite. Every field resets on this.
 */
const Refusals = createContext(0);

/**
 * The setting's own name, beside its plain-language label (#223).
 *
 * The pilot, a stop message and `NEEDS-INPUT.md` all name a setting by its key
 * - *"set `progress.maxQuietMs` before you press it"* - and a row labelled only
 * "silence" in minutes left nothing on screen matching that name. The rows that
 * already lead with the key (the caps, the budget) do not need it.
 */
function Key({ name }: { name: string }) {
  return <code className="v-set__key">{name}</code>;
}

function NumberField({
  id,
  value,
  disabled,
  onSave,
}: {
  id: string;
  value: number | undefined;
  disabled: boolean;
  onSave: (next: number) => void;
}) {
  const [typed, setTyped] = useState(value === undefined ? '' : String(value));
  const refusals = useContext(Refusals);
  // Re-seeded when the saved value changes, and when a save is refused, so the
  // field shows what is actually in force rather than what was typed at it.
  useEffect(() => {
    setTyped(value === undefined ? '' : String(value));
  }, [value, refusals]);

  const commit = (): void => {
    const n = Number(typed);
    if (typed.trim() === '' || !Number.isFinite(n) || n < 0) {
      setTyped(value === undefined ? '' : String(value));
      return;
    }
    if (n !== value) onSave(n);
  };

  return (
    <input
      id={id}
      className="v-set__num"
      value={typed}
      disabled={disabled}
      inputMode="numeric"
      onChange={(e) => setTyped(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        // Escape puts back what is in force, which is the only way out of a
        // half-typed number that does not save it.
        if (e.key === 'Escape') setTyped(value === undefined ? '' : String(value));
      }}
    />
  );
}

/**
 * A string that is saved when you leave it, for `NumberField`'s reason.
 *
 * Empty **is** a value here and clears the key, which is the opposite of the
 * number fields: a role with no model takes its agent's default, and that is a
 * legal state somebody may want back. It is sent as an empty string rather than
 * omitted so `mergeSection`'s patch actually clears it.
 */
function TextField({
  id,
  value,
  placeholder,
  disabled,
  onSave,
}: {
  id: string;
  value: string | undefined;
  placeholder: string;
  disabled: boolean;
  onSave: (next: string) => void;
}) {
  const [typed, setTyped] = useState(value ?? '');
  const refusals = useContext(Refusals);
  useEffect(() => {
    setTyped(value ?? '');
  }, [value, refusals]);

  return (
    <input
      id={id}
      className="v-set__text"
      value={typed}
      disabled={disabled}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => setTyped(e.target.value)}
      onBlur={() => {
        if (typed.trim() !== (value ?? '').trim()) onSave(typed.trim());
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') setTyped(value ?? '');
      }}
    />
  );
}

/**
 * A list, one entry per line, saved when you leave it (#223).
 *
 * `TextField`'s rule for the same reason: a save per keystroke would rewrite the
 * settings file while somebody is half way through typing `git commit`, and the
 * half-typed `git` is a real, valid, much wider entry. Blank lines are dropped,
 * so a trailing newline is not an empty pattern.
 */
function ListField({
  id,
  value,
  placeholder,
  disabled,
  onSave,
}: {
  id: string;
  value: readonly string[];
  placeholder: string;
  disabled: boolean;
  onSave: (next: string[]) => void;
}) {
  const joined = value.join('\n');
  const [typed, setTyped] = useState(joined);
  const refusals = useContext(Refusals);
  useEffect(() => {
    setTyped(joined);
  }, [joined, refusals]);
  return (
    <textarea
      id={id}
      className="v-set__promptbox"
      rows={Math.max(3, Math.min(12, value.length + 1))}
      value={typed}
      disabled={disabled}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => setTyped(e.target.value)}
      onBlur={() => {
        const next = typed
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        if (next.join('\n') !== joined) onSave(next);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') setTyped(joined);
      }}
    />
  );
}

/**
 * The sentinel for *let me type one*.
 *
 * A string no model can be, rather than an empty value, because empty already
 * means *take the agent's default* and the two are opposite intentions.
 */
const OTHER = ' other';

/**
 * Which model a role runs on: the list its CLI gave, and a way past it (#223).
 *
 * **The list is asked of the CLI and no longer shipped here.** It was
 * `KNOWN_MODELS`, a list beside the defaults, and it aged on the vendors'
 * schedule: Opus 5.5 and Fable 5.1 were missing and Codex's default had moved
 * on. *"What if claude introduces a new model, we have to change source code?
 * I really want to avoid that."* `cockpit/models.ts` holds what `claude` and
 * `codex` said, and three things keep it from becoming an allowlist:
 *
 * - **A value not on the list is still shown**, as its own option, marked. A
 *   select that silently dropped it would rewrite a role's model by rendering.
 * - **`other…` is always there**, revealing a text field, so a name can be
 *   typed when the listing failed or is missing one.
 * - **Empty is offered, and means this agent's own setting** - which by default
 *   is the CLI's default, named with what it resolves to today.
 *
 * The listing's own `default` entry is not offered beside the empty one: on a
 * role row the two mean the same thing unless `claude.model` or `codex.model`
 * was set, and two options for one intention is one too many.
 */
function ModelField({
  id,
  value,
  agent,
  listing,
  inherited,
  disabled,
  onSave,
}: {
  id: string;
  value: string | undefined;
  agent: string;
  listing: Listing;
  /** What empty means here: the agent's own `model` setting, as configured. */
  inherited: string | undefined;
  disabled: boolean;
  onSave: (next: string) => void;
}) {
  const current = value ?? '';
  // `other…` is a mode, not a value. It is held here rather than derived from
  // `current` because somebody who has just chosen it has typed nothing yet, and
  // a derived flag would flip the control back the moment the box emptied.
  const [typing, setTyping] = useState(false);
  const why = whyNot(listing);
  const choices = optionsFor(listing, current).filter((c) => c.value !== CLI_DEFAULT || current === CLI_DEFAULT);
  const resolved =
    listing?.ok === true ? (listing.models.find((m) => m.value === CLI_DEFAULT) ?? null) : null;
  const empty =
    inherited === undefined || inherited === CLI_DEFAULT
      ? `— ${agent}'s default${resolved !== null ? ` · ${resolved.description || resolved.resolves || ''}` : ''} —`
      : `— ${agent}.model: ${inherited} —`;

  if (typing) {
    return (
      <div className="v-set__model">
        <TextField
          id={id}
          value={value}
          placeholder={`- ${agent} default -`}
          disabled={disabled}
          onSave={onSave}
        />
        <button className="v-doc__again" onClick={() => setTyping(false)} disabled={disabled}>
          pick from the list
        </button>
      </div>
    );
  }

  return (
    <div className="v-set__model">
      <select
        id={id}
        value={current}
        disabled={disabled}
        onChange={(e) => {
          if (e.target.value === OTHER) {
            setTyping(true);
            return;
          }
          onSave(e.target.value);
        }}
      >
        <option value="">{empty}</option>
        {choices.map((c) => (
          <option key={c.value} value={c.value}>
            {c.unlisted ? `${c.label} — not in ${agent}'s list` : c.label}
          </option>
        ))}
        <option value={OTHER}>other…</option>
      </select>
      {/* Said, rather than an empty select that looks like a CLI with no models. */}
      {listing === null && <span className="v-set__hint">asking {agent} for its models…</span>}
      {why !== null && <span className="v-set__hint">{why}</span>}
    </div>
  );
}

/**
 * One block: what it renders as, and the three ways to change it.
 *
 * **Saving and adopting are separate buttons, and that is the design.** A draft
 * in the library changes nothing about any run; adopting one writes
 * `prompts.<block>` into `vibe.config.json`, which is what a turn actually
 * reads. Collapsing them would mean every experiment landed in a file the whole
 * team commits.
 *
 * *Use the default* clears the key rather than writing the default text into it.
 * Those are different: a cleared key follows the product forward when the
 * default is improved, and a copy of today's text pins this project to today's.
 */
function PromptBlock({
  block,
  drafts,
  busy,
  onAdopt,
  onSaveDraft,
  onRemoveDraft,
}: {
  block: PromptsFrame['blocks'][number];
  drafts: readonly Draft[];
  busy: boolean;
  /** Empty adopts the default, because that is what clearing the key means. */
  onAdopt: (block: string, text: string) => void;
  onSaveDraft: (draft: Draft) => void;
  onRemoveDraft: (block: string, name: string) => void;
}) {
  const [typed, setTyped] = useState(block.text);
  const [name, setName] = useState('');
  const mine = draftsFor(drafts, block.name);
  // Re-seeded when what is in force changes, so a refused patch shows what the
  // config actually holds rather than what was typed at it.
  useEffect(() => {
    setTyped(block.text);
  }, [block.text]);

  const dirty = typed.trim() !== block.text.trim();

  return (
    <div className="v-set__prompt">
      <div className="v-set__promptname">
        <span>{block.name}</span>
        {block.usedBy.map((role) => (
          <MetaChip key={role}>{role}</MetaChip>
        ))}
        {block.overridden ? (
          <MetaChip kind="checkable">this project&apos;s</MetaChip>
        ) : (
          <MetaChip>the default</MetaChip>
        )}
      </div>

      <textarea
        className="v-set__promptbox"
        rows={12}
        value={typed}
        disabled={busy}
        spellCheck={false}
        onChange={(e) => setTyped(e.target.value)}
      />

      <div className="v-set__promptrow">
        <Button level="primary" disabled={busy || !dirty} onClick={() => onAdopt(block.name, typed)}>
          {dirty ? 'use this' : 'in force'}
        </Button>
        {/* Clears the key rather than writing the default in. See the header. */}
        <Button
          level="secondary"
          disabled={busy || !block.overridden}
          onClick={() => onAdopt(block.name, '')}
        >
          use the default
        </Button>
        {block.overridden && !dirty && (
          <button
            className="v-set__again"
            onClick={() => setTyped(block.fallback)}
            disabled={busy}
          >
            show me the default
          </button>
        )}
      </div>

      <div className="v-set__promptrow">
        <input
          className="v-set__text"
          value={name}
          disabled={busy}
          placeholder="name this version to save it"
          aria-label={`name a saved version of ${block.name}`}
          onChange={(e) => setName(e.target.value)}
        />
        {/* Saving touches no run. It is the library, not the config. */}
        <Button
          level="secondary"
          disabled={busy || name.trim() === '' || typed.trim() === ''}
          onClick={() => {
            onSaveDraft({ block: block.name, name, text: typed });
            setName('');
          }}
        >
          save this version
        </Button>
      </div>

      {mine.length > 0 && (
        <div className="v-set__drafts">
          <span className="v-set__factname">saved</span>
          {mine.map((d) => (
            <span className="v-set__draft" key={d.name}>
              <button className="v-set__again" disabled={busy} onClick={() => setTyped(d.text)}>
                {d.name}
              </button>
              <button
                className="v-nav__act v-nav__act--danger"
                disabled={busy}
                title={`forget "${d.name}"`}
                onClick={() => onRemoveDraft(block.name, d.name)}
              >
                −
              </button>
            </span>
          ))}
          <span className="v-set__note">
            Loading one puts it in the box. It is not in force until you press{' '}
            <strong>use this</strong>.
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * The standing prompt blocks, fetched once when the section opens.
 *
 * Lazy for the reason every artifact pane is: the blocks are several pages and
 * nobody arriving at Settings is looking for them. One read, and it never
 * changes within a build — these are constants in `src/prompts.ts`, not
 * configuration.
 */
function usePromptBlocks(open: boolean): {
  blocks: PromptsFrame['blocks'];
  failure: string | null;
  loading: boolean;
  /** Re-read after an adopt: only the core knows what a block now renders as. */
  reload: () => void;
} {
  const [attempt, setAttempt] = useState(0);
  const [blocks, setBlocks] = useState<
    PromptsFrame['blocks']
  >([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !host.inShell() || (blocks.length > 0 && attempt === 0)) return;
    let cancelled = false;
    setLoading(true);
    void host
      .prompts()
      .then((next) => {
        if (!cancelled) {
          setBlocks(next);
          setFailure(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setFailure(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, blocks.length, attempt]);

  return { blocks, failure, loading, reload: () => setAttempt((n) => n + 1) };
}
/**
 * Where this project is, and the control that points it somewhere else (#223):
 * *"We need to be able to edit the project root dir in the project settings."*
 *
 * The directory is what every request this window sends names, so this is the
 * one project setting that is not in `vibe.config.json` — it is which
 * `vibe.config.json` the rest of the screen reads. Changing it moves this
 * window's memory of the project (its name, pins and drafts) and nothing on
 * disk; the screen then reads the new directory's own file. Drawn on the empty
 * screen too, because a project pointed at the wrong place is exactly the one
 * whose configuration may not read.
 */
function WhereItIs({ dir, onRelocate }: { dir: string; onRelocate: (to: string) => string | null }) {
  const [typed, setTyped] = useState(dir);
  const [why, setWhy] = useState<string | null>(null);
  useEffect(() => setTyped(dir), [dir]);
  const point = (to: string): void => setWhy(onRelocate(to));
  return (
    <section className="v-set__block">
      <h3 className="v-set__h">where this project is</h3>
      <p className="v-set__note">
        The repository this project points at. Change it when the project was added one folder off —
        the parent of the repository rather than the repository — or when the repository moved. The
        project keeps its name, pins and drafts; the settings below are then read from the new
        directory&apos;s own <code>vibe.config.json</code>, and its runs from its own{' '}
        <code>.vibe/runs</code>. Nothing on disk is moved or copied.
      </p>
      <form
        className="v-set__promptrow"
        onSubmit={(e) => {
          e.preventDefault();
          point(typed);
        }}
      >
        <input
          className="v-set__text"
          value={typed}
          spellCheck={false}
          aria-label="the project's directory"
          onChange={(e) => setTyped(e.target.value)}
        />
        <Button
          level="secondary"
          type="button"
          onClick={() => {
            void pickDirectory()
              .then((chosen) => {
                if (chosen !== null) point(chosen);
              })
              .catch((err: unknown) =>
                setWhy(`the chooser did not open: ${err instanceof Error ? err.message : String(err)} — type a path instead`),
              );
          }}
        >
          choose…
        </Button>
        <Button level="primary" type="submit" disabled={typed.trim() === dir.trim()}>
          point here
        </Button>
      </form>
      {why !== null && (
        <div className="v-set__refused">
          <StateKicker tone="alarm">refused</StateKicker>
          <span>{why}</span>
        </div>
      )}
    </section>
  );
}

export function Settings({
  scope,
  onRelocate,
  movedFrom,
  dir,
  scale,
  onScale,
  statuses,
  keyFailure,
  onKeysChanged,
  limits,
  onLimits,
  onSaved,
}: {
  /**
   * Which file this screen edits (#223), decided by the door it was opened
   * from: the left bar's ⚙ is the settings for every project, a project row's
   * ⚙ is that project's `vibe.config.json`. It was a switch at the top of one
   * screen, and the reply was that the two belong in two places.
   */
  scope: 'project' | 'global';
  /** Point the project at another directory; the refusal, or null (#223). */
  onRelocate?: (to: string) => string | null;
  /** Where this project pointed before it was moved here, in this session. */
  movedFrom?: string | null;
  dir: string;
  /** How big the product is drawn. Window state — see `appearance.ts`. */
  scale: number;
  onScale: (next: number) => void;
  /**
   * Which providers hold a pilot key, read by the window and passed in (#188).
   *
   * Not fetched here, and that is the fix #188 made rather than an inconvenience:
   * two panes needed this fact and each held its own copy, so entering a key
   * updated the form while the pilot went on refusing to let anybody type,
   * correctly according to a snapshot from before the key existed. One reader,
   * one fact.
   */
  statuses: readonly KeyStatus[] | null;
  keyFailure: string | null;
  onKeysChanged: () => void;
  /**
   * The pilot's own daily ceiling, and the setter for it (#223).
   *
   * Owned by `Cockpit` because the pane that ENFORCES it is a sibling of this
   * one — the same arrangement the type scale has, and for the same reason: a
   * change here has to reach a pane that is already open.
   */
  limits: PilotLimits;
  onLimits: (next: PilotLimits) => void;
  /** Told after every save that took, so the window's own reads can follow. */
  onSaved?: (() => void) | undefined;
}) {
  const [frame, setFrame] = useState<ConfigFrame | null>(null);
  // Asked of the CLIs once per window, and again on request (#223).
  const models = useModels();
  useEffect(() => loadCliModels(), []);
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refusals, setRefusals] = useState(0);
  /** Whether the prompts section is open, which is what makes its read lazy. */
  const [showPrompts, setShowPrompts] = useState(false);
  const prompts = usePromptBlocks(showPrompts);
  /**
   * The saved prompt versions, this window's own library (#223).
   *
   * Read once. A draft nobody has adopted is not a fact about any run and has no
   * business in a file the whole team commits — the same reasoning `projects.ts`
   * gives for the project list.
   */
  const [drafts, setDrafts] = useState<readonly Draft[]>([]);
  useEffect(() => {
    try {
      setDrafts(readDrafts(localStorage.getItem(DRAFTS_KEY)));
    } catch {
      // Storage can be unavailable. An empty library is a smaller failure than
      // a settings screen that will not render.
    }
  }, []);
  const keep = useCallback((key: string, value: unknown) => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // The library still works for this session. See above.
    }
  }, []);

  /** Whether the dialog in front of switching YOLO on is open (#223). */
  const [askYolo, setAskYolo] = useState(false);

  const load = useCallback(() => {
    if (!host.inShell()) {
      setFailure('the configuration is read by the host, and there is no host in a browser');
      return;
    }
    void host
      .config(dir)
      .then((next) => {
        setFrame(next);
        setFailure(null);
      })
      .catch((err: unknown) => setFailure(err instanceof Error ? err.message : String(err)));
  }, [dir]);

  useEffect(load, [load]);

  const write = useCallback(
    (patch: Record<string, unknown>, to: 'project' | 'global') => {
      setBusy(true);
      setSaved(null);
      void host
        .config(dir, patch, to)
        .then((next) => {
          // The config that RESULTED, not the patch that was sent.
          setFrame(next);
          setFailure(null);
          setSaved(
            to === 'global' ? (next.globalPath ?? 'the global settings') : (next.path ?? 'vibe.config.json'),
          );
          onSaved?.();
        })
        .catch((err: unknown) => {
          // The core validator's own sentence, which names the field. Nothing
          // was written, so the screen still shows what is in force.
          setFailure(err instanceof Error ? err.message : String(err));
          setSaved(null);
          setRefusals((n) => n + 1);
        })
        .finally(() => setBusy(false));
    },
    [dir, onSaved],
  );
  /**
   * The old directory's `vibe.config.json`, offered to a project just moved to
   * a directory that has none (#223): *"lets copy it when there isn't already
   * one"*. Never when the new directory has its own — that file is usually
   * committed and belongs to the repository. A copy, so the old file stays.
   */
  const [carry, setCarry] = useState<{ path: string; raw: Record<string, unknown> } | null>(null);
  const noFileHere = frame !== null && frame.path === null;
  useEffect(() => {
    setCarry(null);
    if (scope !== 'project' || movedFrom === null || movedFrom === undefined || !noFileHere) return;
    let live = true;
    void host
      .config(movedFrom)
      .then((old) => {
        if (live && old.path !== null && Object.keys(old.raw).length > 0) setCarry({ path: old.path, raw: old.raw });
      })
      // An old directory whose file cannot be read has nothing to offer.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [scope, movedFrom, noFileHere]);

  /** A save to whichever file this screen was opened for. */
  const save = useCallback((patch: Record<string, unknown>) => write(patch, scope), [write, scope]);

  if (frame === null) {
    return (
      <div className="v-set v-set--empty">
        <StateKicker tone={failure === null ? 'quiet' : 'alarm'}>
          {failure === null ? 'reading' : 'no configuration'}
        </StateKicker>
        <p>{failure ?? 'asking the host what this repository is configured to do…'}</p>
        {failure !== null && (
          <button className="v-set__again" onClick={load}>
            try again
          </button>
        )}
        {scope === 'project' && onRelocate !== undefined && failure !== null && (
          <WhereItIs dir={dir} onRelocate={onRelocate} />
        )}
      </div>
    );
  }

  // The file being edited, and what is in force under it. In the global view
  // that is the defaults plus the global file alone — what a project that says
  // nothing gets — and never this project's values, which would put one
  // repository's choices in front of somebody editing all of them.
  const raw = scope === 'global' ? frame.globalRaw : frame.raw;
  const effective = (scope === 'global' ? frame.globalEffective : frame.effective) as {
    gates?: Record<string, string>;
    roles?: Record<string, string | { provider?: string; effort?: string; model?: string }>;
    loop?: Record<string, number | undefined>;
    progress?: Record<string, number | boolean | undefined>;
    budget?: Record<string, number | boolean | undefined>;
    git?: Record<string, string | number | boolean | null | undefined>;
    verify?: Record<string, unknown>;
    claude?: { model?: string };
    codex?: { model?: string };
  };
  const gates = effective.gates ?? {};
  const loop = effective.loop ?? {};
  const progress = effective.progress ?? {};
  const budget = effective.budget ?? {};
  const git = effective.git ?? {};
  const verify = effective.verify ?? {};
  // A project that lists its gates owns the command inside each one, and
  // `validateConfig` refuses `verify.command` beside a list — so this screen
  // says where to edit them rather than offering a field that cannot save.
  const listsGates = Array.isArray(verify['gates']);
  const roles = effective.roles ?? {};
  // Which rows the FILE claims, as opposed to which are in force, is `source`
  // below — the whole reason `raw` travels beside `effective`.

  /**
   * Where a value comes from, as a chip — or nothing, when the file being edited
   * sets it itself (#223). Three answers rather than two now there are two
   * files: the built-in default, the person's own setting for every project,
   * or this project's. In the global view a key the project overrides says so,
   * because editing it there changes nothing for the project in front of you.
   */
  const inFile = (file: Record<string, unknown>, section: string, key: string): boolean =>
    (file[section] as Record<string, unknown> | undefined)?.[key] !== undefined;
  const source = (section: string, key: string, unset = 'default'): ReactNode => {
    const own = inFile(raw, section, key);
    if (scope === 'global') {
      return (
        <>
          {!own && <MetaChip>{unset}</MetaChip>}
          {inFile(frame.raw, section, key) && <MetaChip>this project overrides it</MetaChip>}
        </>
      );
    }
    if (own) return null;
    return inFile(frame.globalRaw, section, key) ? (
      <MetaChip>all projects</MetaChip>
    ) : (
      <MetaChip>{unset}</MetaChip>
    );
  };

  return (
    <Refusals.Provider value={refusals}>
    <div className="v-set">
      {/* **Which file, said here** (#223). Chosen by the door this screen was
          opened from, so the heading and the line under it are what tell the two
          apart — nothing else on the screen looks different. */}
      <h2 className="v-set__title">
        {scope === 'global' ? 'Settings for all projects' : `Settings for ${projectName(dir)}`}
      </h2>
      <p className="v-set__note">
        {scope === 'project'
          ? 'This repository’s own settings, in its vibe.config.json. Anything left alone here comes from your settings for all projects, and failing that from vibe’s own default — the chip beside each value says which. The test command and the worktree are only ever set here.'
          : 'Your settings for every project on this machine. How each vendor is reached, the CLIs and the pilot’s permissions are only ever set here; for the rest, a project that sets a key in its own file wins, and the chip says when one does.'}
      </p>
      {scope === 'project' && onRelocate !== undefined && <WhereItIs dir={dir} onRelocate={onRelocate} />}
      {carry !== null && (
        <div className="v-set__fact">
          <span className="v-set__factname">bring the settings</span>
          <span>
            This directory has no <code>vibe.config.json</code>, and the one this project pointed at
            before does: <code>{carry.path}</code>. Copying it writes the same settings here, checked
            like any other save; the old file is left where it is.
            <span className="v-set__inline">
              <Button
                level="primary"
                disabled={busy}
                // The offer goes once the file exists, and stays on a refusal,
                // which is shown above with the field it named.
                onClick={() => write(carry.raw, 'project')}
              >
                copy it here
              </Button>
            </span>
          </span>
        </div>
      )}
      <div className="v-set__head">
        <span>
          {scope === 'global' ? (
            frame.globalPath === null ? (
              'global settings are switched off'
            ) : (
              <code>{frame.globalPath}</code>
            )
          ) : frame.path === null ? (
            <>
              no <code>vibe.config.json</code> — everything below comes from your global settings or
              a default, and saving creates the file
            </>
          ) : (
            <code>{frame.path}</code>
          )}
        </span>
        <button className="v-set__again" onClick={load}>
          reread
        </button>
      </div>

      {failure !== null && (
        <div className="v-set__refused">
          <StateKicker tone="alarm">refused</StateKicker>
          <span>{failure} — nothing was written.</span>
        </div>
      )}
      {saved !== null && failure === null && (
        <p className="v-set__note">saved to {saved}, and reread from it.</p>
      )}

      {/* **Each kind of setting in the one view it belongs to** (#223). This
          machine's — how the window is drawn, how each vendor is reached, what
          the pilot may do — appear only under "all projects", and how this
          repository builds and tests only under "this project". The rest can
          be set at either level, project winning. */}
      {scope === 'project' ? (
        <p className="v-set__note">
          How each vendor is reached, where the CLIs are, what the pilot may do without asking and
          how this window is drawn are this machine&apos;s, for every project — they are under
          Settings at the foot of the left bar.
        </p>
      ) : (
        <>
          {/* ---- this window ------------------------------------------------- */}
          <section className="v-set__block">
            <h3 className="v-set__h">how this is drawn</h3>
            <p className="v-set__note">
              This window, on this machine. It is not written to <code>vibe.config.json</code> — how
              big you like your text is not a fact about any run, and that file is meant to be
              committed.
            </p>
            <div className="v-set__scale">
              {STEPS.map((step) => (
                <label key={step.scale} className="v-set__radio">
                  <input
                    type="radio"
                    name="type-scale"
                    checked={scale === step.scale}
                    onChange={() => onScale(step.scale)}
                  />
                  <span style={{ fontSize: `calc(var(--size-body) * ${String(step.scale)})` }}>
                    {step.label}
                  </span>
                </label>
              ))}
            </div>
            {/* Every size at once, which is what keeps the ramp the spec chose. A
                control that moved body text alone would leave headings where they
                were and break the relationships that make a page readable. */}
            <p className="v-set__note">
              Every size moves together, so the proportions the design chose survive being scaled.
              Nothing else about the look is configurable: there is one palette, and it is the one the
              contrast gate is measured against.
            </p>
          </section>

          {/* ---- how each vendor is reached (#223) ---------------------------- */}
          <section className="v-set__block">
            <h3 className="v-set__h">Anthropic and OpenAI</h3>
            {/* **Two choices per vendor.** *"There should be two options for both
                anthropic and openAI: (1) subscription, (2) api key."* It replaced
                three paragraphs explaining that a run's agents and the pilot are two
                different processes. The choice covers both — *"we should use them
                everywhere (pilot, runs, etc)"* — and is this machine's, in the
                settings for all projects; keys stay in the OS keychain. */}
            <p className="v-set__note">
              How vibe reaches each vendor — for runs and the pilot alike, in every project on this
              machine — and where the <code>claude</code> and <code>codex</code> CLIs are when it
              cannot find them. <code>vibe doctor</code> checks both.
            </p>
            <KeychainFailure failure={keyFailure} />
            {(['anthropic', 'openai'] as const).map((vendor) => (
              <Vendor
                key={vendor}
                vendor={vendor}
                route={frame.pilot[vendor]}
                onRoute={(next) => write({ auth: { [vendor]: next } }, 'global')}
                cli={frame.clis[vendor === 'anthropic' ? 'claude' : 'codex']}
                onCliPath={(next) =>
                  write({ cli: { [vendor === 'anthropic' ? 'claude' : 'codex']: next } }, 'global')
                }
                status={statuses?.find((st) => st.provider === vendor) ?? null}
                onKeysChanged={onKeysChanged}
                disabled={busy || frame.globalPath === null}
              />
            ))}
            <h4 className="v-set__h4">the pilot&apos;s own ceiling</h4>
            {/* **Moved here from beside the conversation** (#145 built it there,
                #223 moved it): *"move pilot tokens and pilot $/day out of pilot chat
                and into the same settings group"*. A ceiling is a setting, and this
                was the only one in the product with no home on this screen. What
                stays in the pane is the *reading* — what today has cost — because
                that is about the conversation in front of you.

                It is a **third** kind of setting on a screen that already names
                three, and it lands in the second: this window's, in `localStorage`,
                this machine only. Not the project's file, which is committed, and
                not the keychain, which holds one kind of secret. */}
            <div className="v-set__fact">
              <span className="v-set__factname">not the run&apos;s</span>
              <span>
                These bound the <strong>conversation</strong>, not the loop. A pilot turn on an API key
                is the one place in this product where a dollar is a dollar — money moves and the vendor
                publishes the usage — where the run&apos;s two ceilings above are work-volume brakes on a
                subscription that bills nothing. The two never sum, and a run is never stopped by these.
                <span className="v-set__inline">
                  <NumberField
                    id="pilot-dailyTokens"
                    value={limits.dailyTokens ?? undefined}
                    disabled={false}
                    onSave={(n) => onLimits({ ...limits, dailyTokens: n > 0 ? n : null })}
                  />
                  <span className="v-set__unit">tokens/day</span>
                  <NumberField
                    id="pilot-dailyUsd"
                    value={limits.dailyUsd ?? undefined}
                    disabled={false}
                    onSave={(n) => onLimits({ ...limits, dailyUsd: n > 0 ? n : null })}
                  />
                  <span className="v-set__unit">$/day</span>
                </span>
              </span>
            </div>
            <div className="v-set__fact">
              <span className="v-set__factname">blank is no ceiling</span>
              <span>
                Both are off by default, and that is deliberate: a hard default cap on a conversation
                stops you mid-sentence for no good reason. <strong>Per day</strong> rather than per
                session, because a conversation has no natural end and a day is the window both
                vendors&apos; own dashboards use. It gates the tool loop as well as the composer — a
                chain answering itself is the unattended half, which is the half a spend limit is for.
              </span>
            </div>
          </section>

          {/* ---- what the pilot may do without asking (#223) ------------------ */}
          <section className="v-set__block">
            <h3 className="v-set__h">what the pilot may do without asking</h3>
            {/* **Only ever the settings for all projects.** A project's `vibe.config.json` is committed, so a repository
                you clone could otherwise put `rm` on its own pilot's safe list or
                switch YOLO on for itself; the core refuses a project file that sets
                any of this, by name. */}
            <p className="v-set__note">
              These are this machine&apos;s, for every project — a project&apos;s own file is committed, so a repository you clone cannot widen what its
              pilot may do. Everything here still runs without a shell: one program and its arguments,
              the same on Windows, Linux and macOS.
            </p>
            {frame.globalPath === null ? (
              <p className="v-set__note">Global settings are switched off, so none of this can be set.</p>
            ) : (
              <>
                <div className="v-set__row">
                  <label className="v-set__label" htmlFor="pilot-yolo">
                    YOLO mode
                  </label>
                  <select
                    id="pilot-yolo"
                    value={frame.pilot.yolo ? 'on' : 'off'}
                    disabled={busy}
                    onChange={(e) => {
                      // Switching it on confirms; switching it off never does,
                      // because narrowing what runs unasked costs nothing.
                      if (e.target.value === 'on') setAskYolo(true);
                      else write({ pilot: { yolo: false } }, 'global');
                    }}
                  >
                    <option value="off">off — the safe list below, and a card for everything else</option>
                    <option value="on">on — every command runs, and the whole disk is readable</option>
                  </select>
                </div>
                <div className="v-set__row">
                  {/* Was five minutes and fixed, from when the pilot only
                      answered; a full CLI editing files and running tests ran
                      out of it (#223). Minutes here, milliseconds in the file. */}
                  <label className="v-set__label" htmlFor="pilot-timeout">
                    pilot turn limit
                    {source('pilot', 'timeoutMs')}
                  </label>
                  <span className="v-set__inline">
                    <NumberField
                      id="pilot-timeout"
                      value={Math.round(frame.pilot.timeoutMs / 60_000)}
                      disabled={busy}
                      onSave={(n) => write({ pilot: { timeoutMs: n * 60_000 } }, 'global')}
                    />
                    <span className="v-set__unit">minutes</span>
                    <Key name="pilot.timeoutMs" />
                  </span>
                </div>
                <div className="v-set__row">
                  <label className="v-set__label" htmlFor="pilot-safe">
                    commands that run without a card
                    {/* `source` answers correctly in both views: a project file can
                        never set this, so "this project overrides it" never shows. */}
                    {source('pilot', 'safeCommands')}
                  </label>
                  <ListField
                    id="pilot-safe"
                    value={frame.pilot.safeCommands}
                    placeholder="one per line, such as git status"
                    disabled={busy || frame.pilot.yolo}
                    onSave={(next) => write({ pilot: { safeCommands: next } }, 'global')}
                  />
                </div>
                <p className="v-set__note">
                  One per line: a program and the arguments it starts with, so <code>git commit</code>{' '}
                  covers <code>git commit -m &quot;…&quot;</code>. A matching command still gets a card
                  if it names a path outside the directories below, or anything under <code>.git</code>.{' '}
                  <code>git commit</code> runs the repository&apos;s own hooks, which can be any code.{' '}
                  <code>ls</code>, <code>cat</code>, <code>cp</code> and the rest are the ordinary
                  programs, with no shell: Linux and macOS have them all, and Windows has them only
                  where something like Git for Windows put them on <code>PATH</code>.
                </p>
                <div className="v-set__promptrow">
                  <Button
                    level="secondary"
                    disabled={
                      busy ||
                      // Null is the default too: it is what this button writes.
                      ((frame.globalRaw['pilot'] as Record<string, unknown> | undefined)?.['safeCommands'] ??
                        null) === null
                    }
                    // Null clears it to the default, which then follows the
                    // product forward when the default changes.
                    onClick={() => write({ pilot: { safeCommands: null } }, 'global')}
                  >
                    use the default list
                  </Button>
                </div>
                <div className="v-set__row">
                  <label className="v-set__label" htmlFor="pilot-dirs">
                    directories it may also read and run in
                  </label>
                  <ListField
                    id="pilot-dirs"
                    value={
                      ((frame.globalRaw['pilot'] as Record<string, unknown> | undefined)?.['dirs'] as
                        | readonly string[]
                        | undefined) ?? []
                    }
                    placeholder="one absolute path per line, such as ~/code/shared"
                    disabled={busy || frame.pilot.yolo}
                    onSave={(next) => write({ pilot: { dirs: next } }, 'global')}
                  />
                </div>
                <p className="v-set__note">
                  The project it is talking about is always readable. These are added to it, for every
                  project. YOLO mode replaces both with every disk on this machine.
                </p>
              </>
            )}
            {askYolo && (
              <Confirm
                kicker="YOLO mode"
                title="Let the pilot run anything, anywhere?"
                lead="Every command the pilot asks for runs the moment it asks, with no card, and it can read any file on this machine. Nobody checks a command before it runs."
                facts={[
                  { label: 'still needs your press', value: 'starting a run, and answering a gate' },
                  { label: 'applies to', value: 'every project on this machine' },
                  { label: 'still true', value: 'no shell — one program and its arguments per command' },
                ]}
                confirm="turn YOLO on"
                onConfirm={() => {
                  setAskYolo(false);
                  write({ pilot: { yolo: true } }, 'global');
                }}
                onCancel={() => setAskYolo(false)}
              />
            )}
          </section>
        </>
      )}

      {/* ---- how hard it tries, and what it will accept ------------------- */}
      <section className="v-set__block">
        <h3 className="v-set__h">how many rounds, and what it will accept</h3>
        {/* **The four caps and the tolerance were reachable only as flags.**
            Every one of them is a `--max-*` or `--p1-tolerance` on the CLI and
            a `loop.*` key in the file, so this is a form over settings that
            already existed rather than new configuration — which is the rule
            the whole screen is built under. */}
        <p className="v-set__note">
          A cap is where the loop gives up and hands back, not where it is aiming. Reaching one
          stops the run <em>resumably</em> and writes what it was stuck on — nothing is lost, and
          a resume with a raised cap picks up from the same checkpoint.
        </p>
        <table className="v-set__matrix">
          <tbody>
            {LIMITS.map((limit) => (
              <tr key={limit.key}>
                <td>
                  <code>{limit.key}</code>
                  {source('loop', limit.key)}
                </td>
                <td>
                  <NumberField
                    id={`loop-${limit.key}`}
                    value={loop[limit.key]}
                    disabled={busy}
                    onSave={(n) => save({ loop: { [limit.key]: n } })}
                  />
                </td>
                <td className="v-set__why">{limit.note}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <h4 className="v-set__h4">what counts as good enough</h4>
        <div className="v-set__fact">
          <span className="v-set__factname">P0</span>
          <span>
            <strong>Always zero, and there is no setting for it.</strong> `gate()` refuses a round
            with any P0 before it looks at the tolerance at all —{' '}
            <em>P0 findings are never carried forward</em> — so a run cannot be configured to
            accept one. A P0 is the judge saying this is wrong, not that it is imperfect.
          </span>
        </div>
        <div className="v-set__fact">
          <span className="v-set__factname">P1</span>
          <span>
            How many the plan or the implementation may be <strong>accepted carrying</strong>,
            rather than sent back for another round. They are not forgiven: a carried P1 is
            stated in the next phase&apos;s prompt, listed in <code>OUTSTANDING.md</code>, and
            said on the run&apos;s summary. <code>0</code> demands a spotless verdict.
            <span className="v-set__inline">
              <NumberField
                id="loop-p1Tolerance"
                value={loop["p1Tolerance"]}
                disabled={busy}
                onSave={(n) => save({ loop: { p1Tolerance: n } })}
              />
              {source('loop', 'p1Tolerance')}
            </span>
          </span>
        </div>
        <div className="v-set__fact">
          <span className="v-set__factname">P2 and P3</span>
          <span>
            Never block anything. They are recorded on the round and carried into{' '}
            <code>FOLLOW-UPS.md</code>, which is what that file is for.
          </span>
        </div>
        <h4 className="v-set__h4">when a turn has gone quiet</h4>
        {/* **A ceiling on silence, and it is not the turn timeout.** The agent
            timeouts bound how long a turn may *take*; this bounds how long it
            may say nothing while taking it. A review turn went silent five
            minutes in and was killed thirty-nine minutes later when the Codex
            turn ceiling expired, having done nothing for any of it — raising
            that ceiling would only have bought a longer hang. */}
        <div className="v-set__fact">
          <span className="v-set__factname">silence</span>
          <span>
            Minutes a turn may produce <strong>no output at all</strong> before it is stopped.
            Measured from the child&apos;s last line, which is the finer of the two clocks and the
            one a stall trips first — a long turn is not a quiet turn, because a turn is long by
            doing many things. Stopping is <em>resumable</em>, like every other cap here.{' '}
            <code>0</code> switches it off.
            <span className="v-set__inline">
              <NumberField
                id="progress-maxQuietMinutes"
                // Minutes on screen, milliseconds in the file. The config is in
                // ms because everything else timing-related in it is, and a form
                // that made somebody type 600000 to mean ten minutes would be
                // the units leaking out of the storage layer.
                value={
                  typeof progress['maxQuietMs'] === 'number'
                    ? Math.round(progress['maxQuietMs'] / 60_000)
                    : undefined
                }
                disabled={busy}
                onSave={(n) => save({ progress: { maxQuietMs: n * 60_000 } })}
              />
              <span className="v-set__unit">minutes</span>
              <Key name="progress.maxQuietMs" />
                {source('progress', 'maxQuietMs')}
            </span>
          </span>
        </div>
      </section>

      {/* ---- what it may spend ------------------------------------------- */}
      <section className="v-set__block">
        <h3 className="v-set__h">what it may spend</h3>
        {/* **The ceilings that end a run, and they were not here.** A run
            stopped with *"a ceiling in `budget` was reached"* and pointed at
            `budget.planShare`, and the footer's own note said *"Settings has the
            caps"* — which was true of the round caps and false of these.
            Reported exactly that way: *"I got this error but don't see anywhere
            to edit this in settings. All of these types of settings need to be
            editable."* */}
        <p className="v-set__note">
          Every one of these stops the run <em>resumably</em> and says which it was. Raising one and
          resuming picks up from the last checkpoint: a resume reads this file, so a change here
          reaches a run that has already started.
        </p>
        <table className="v-set__matrix">
          <tbody>
            {/* Tokens in millions, because the ceiling is 25,000,000 and the
                run's own message quotes it as `25.0M`. The file keeps the whole
                number; a form that made somebody type seven zeroes would be the
                storage layer's units on the screen. */}
            <tr>
              <td>
                <code>maxTokens</code>
                {source('budget', 'maxTokens')}
              </td>
              <td>
                <span className="v-set__inline">
                  <NumberField
                    id="budget-maxTokens"
                    value={
                      typeof budget['maxTokens'] === 'number'
                        ? budget['maxTokens'] / 1_000_000
                        : undefined
                    }
                    disabled={busy}
                    onSave={(n) => save({ budget: { maxTokens: Math.round(n * 1_000_000) } })}
                  />
                  <span className="v-set__unit">million</span>
                </span>
              </td>
              <td className="v-set__why">
                the only ceiling that counts <strong>both</strong> agents, and so the one that
                actually bounds a run. <code>0</code> is no limit.
              </td>
            </tr>
            <tr>
              <td>
                <code>planShare</code>
                {source('budget', 'planShare')}
              </td>
              <td>
                {/* A fraction in the file and a percentage on screen, for the
                    reason the tokens are in millions: the run's own message says
                    `40% cap`. */}
                <span className="v-set__inline">
                  <NumberField
                    id="budget-planShare"
                    value={
                      typeof budget['planShare'] === 'number'
                        ? Math.round(budget['planShare'] * 100)
                        : undefined
                    }
                    disabled={busy}
                    onSave={(n) => save({ budget: { planShare: n / 100 } })}
                  />
                  <span className="v-set__unit">% of the ceiling</span>
                </span>
              </td>
              <td className="v-set__why">
                how much of it planning may use before stopping. Planning that will not converge is
                the most expensive way to fail — it produces nothing, and the whole-run ceiling only
                catches it once the budget is gone. <code>0</code> disables it.
              </td>
            </tr>
            <tr>
              <td>
                <code>maxCostUsd</code>
                {source('budget', 'maxCostUsd')}
              </td>
              <td>
                <span className="v-set__inline">
                  <NumberField
                    id="budget-maxCostUsd"
                    value={typeof budget['maxCostUsd'] === 'number' ? budget['maxCostUsd'] : undefined}
                    disabled={busy}
                    onSave={(n) => save({ budget: { maxCostUsd: n } })}
                  />
                  <span className="v-set__unit">$, Claude-side</span>
                </span>
              </td>
              <td className="v-set__why">
                <strong>Not money on a subscription.</strong> The Claude CLI derives it from token
                counts at API rates and nothing is billed; Codex reports no cost at all, so this
                covers half a run. Treat it as a second work-volume brake.
              </td>
            </tr>
            <tr>
              <td>
                <code>maxWaitMinutes</code>
                {source('budget', 'maxWaitMinutes')}
              </td>
              <td>
                <span className="v-set__inline">
                  <NumberField
                    id="budget-maxWaitMinutes"
                    value={
                      typeof budget['maxWaitMinutes'] === 'number'
                        ? budget['maxWaitMinutes']
                        : undefined
                    }
                    disabled={busy}
                    onSave={(n) => save({ budget: { maxWaitMinutes: n } })}
                  />
                  <span className="v-set__unit">minutes</span>
                </span>
              </td>
              <td className="v-set__why">
                the longest rate-limit window the loop will sit out rather than stopping. A wait can
                be stopped from the footer now, so this is where it gives up on its own.
              </td>
            </tr>
            <tr>
              <td>
                <code>codexLimitPercent</code>
                {source('budget', 'codexLimitPercent')}
              </td>
              <td>
                <span className="v-set__inline">
                  <NumberField
                    id="budget-codexLimitPercent"
                    value={
                      typeof budget['codexLimitPercent'] === 'number'
                        ? budget['codexLimitPercent']
                        : undefined
                    }
                    disabled={busy}
                    onSave={(n) => save({ budget: { codexLimitPercent: n } })}
                  />
                  <span className="v-set__unit">% used</span>
                </span>
              </td>
              <td className="v-set__why">
                stop before a Codex turn once its rate-limit window is this full. A whole-run brake,
                not per-turn metering — the figure is an integer percent of a rolling window and does
                not move measurably for one turn. <code>0</code> disables it.
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      {scope === 'global' ? (
        <p className="v-set__note">
          The test command and the worktree settings are set per project, because how a repository
          is built and tested is a fact about that repository — they are under the ⚙ on that
          project&apos;s row in the left bar.
        </p>
      ) : (
        <>
          <section className="v-set__block">
            <h3 className="v-set__h">how the run checks its work</h3>
            {/* **A required gate with nothing to run ends a finished run as
                unverified** (#223). The core auto-detects only `npm test` from a
                `package.json`, so on a Bazel or Make project the gate had no command,
                the run spent two and a half hours and 42M tokens, and it ended exit 7
                with nothing having tested the change. This field was reachable only
                by hand-editing `vibe.config.json`. */}
            <p className="v-set__note">
              After every implementation and fix round the loop runs this command and treats a
              non-zero exit as a failure to fix. Left empty, vibe looks for a <code>test</code> script
              in <code>package.json</code> and runs <code>npm test</code> — and finds nothing on any
              other kind of project, which ends the run <em>unverified</em> (exit 7) after all the work
              is done. Set it to whatever your suite is: <code>bazel test //tests/...</code>,{' '}
              <code>make test</code>, <code>pytest</code>, <code>cargo test</code>.
            </p>
            <div className="v-set__row">
              <label className="v-set__label" htmlFor="verify-enabled">
                verify each round
                <Key name="verify.enabled" />
                {source('verify', 'enabled')}
              </label>
              <select
                id="verify-enabled"
                value={verify['enabled'] === false ? 'off' : 'on'}
                disabled={busy}
                onChange={(e) => save({ verify: { enabled: e.target.value === 'on' } })}
              >
                <option value="on">on — run the command after every round</option>
                <option value="off">off — nothing checks the code</option>
              </select>
            </div>
            {listsGates ? (
              <p className="v-set__note">
                This project lists its gates under <code>verify.gates</code> in{' '}
                <code>vibe.config.json</code>, each with its own command, so they are edited there.
              </p>
            ) : (
              <div className="v-set__row">
                <label className="v-set__label" htmlFor="verify-command">
                  test command
                  <Key name="verify.command" />
                {source('verify', 'command', 'auto-detect')}
                </label>
                <TextField
                  id="verify-command"
                  value={typeof verify['command'] === 'string' ? verify['command'] : ''}
                  placeholder="empty — npm test, if package.json has a test script"
                  disabled={busy}
                  // Empty is null, which is auto-detect — never an empty command,
                  // which the core refuses by name.
                  onSave={(next) => save({ verify: { command: next === '' ? null : next } })}
                />
              </div>
            )}
            <div className="v-set__row">
              <label className="v-set__label" htmlFor="verify-runs">
                times it must pass
                <Key name="verify.runs" />
                {source('verify', 'runs')}
              </label>
              <NumberField
                id="verify-runs"
                value={typeof verify['runs'] === 'number' ? verify['runs'] : undefined}
                disabled={busy}
                onSave={(next) => save({ verify: { runs: next } })}
              />
            </div>
            <div className="v-set__row">
              <label className="v-set__label" htmlFor="verify-timeout">
                how long one run may take, in minutes
                <Key name="verify.timeoutMs" />
                {source('verify', 'timeoutMs')}
              </label>
              <NumberField
                id="verify-timeout"
                value={
                  typeof verify['timeoutMs'] === 'number'
                    ? Math.round(verify['timeoutMs'] / 60_000)
                    : undefined
                }
                disabled={busy}
                onSave={(next) => save({ verify: { timeoutMs: next * 60_000 } })}
              />
            </div>
            <p className="v-set__note">
              It runs through a shell in the directory the run works in — the worktree, when that is
              on below — so a worktree has to be able to build. That is what the worktree&apos;s setup
              command is for. More than one pass is how a flaky suite is told from a broken one; a
              suite that takes long can be set to one.
            </p>
          </section>

          <section className="v-set__block">
            <h3 className="v-set__h">where the run does its work</h3>
            {/* **A worktree is a thing AGENTS.md tells a human to do**, and doing it
                by hand is four commands and a cleanup nobody remembers. Asked for as
                *"the pilot should automatically start a worktree for the vibe session
                to run in"*.

                The section says what it costs as well as what it buys, because the
                cost is disk and nothing in the product reclaims it. */}
            <p className="v-set__note">
              With this on, a run works in <code>.worktrees/&lt;run-id&gt;</code> instead of in the
              repository — so the tree being edited is not the tree you are sitting in, and several
              runs can exist side by side on their own branches. The run&apos;s record stays in the
              repository either way: an archive written into a worktree is one the next run&apos;s
              planner cannot read.
            </p>
            <p className="v-set__note">
              Nothing removes them. One worktree per run, and a checkout that has built a large
              project is gigabytes — they are named after the run so the ones worth deleting can be
              told apart.
            </p>
            <div className="v-set__row">
              <label className="v-set__label" htmlFor="git-worktree">
                work in a worktree
                <Key name="git.worktree" />
                {source('git', 'worktree')}
              </label>
              {/* A two-option select rather than a checkbox, and that is a design
                  decision rather than laziness: this screen has no checkbox, and an
                  unstyled `input[type=checkbox]` takes the platform's own light
                  control on a dark window — which is precisely the class of defect
                  `audit:contrast` §9 exists to catch. The selects here are already
                  styled. */}
              <select
                id="git-worktree"
                value={git['worktree'] === true ? 'on' : 'off'}
                disabled={busy}
                onChange={(e) => save({ git: { worktree: e.target.value === 'on' } })}
              >
                <option value="off">off — run in the repository</option>
                <option value="on">on — a worktree per run</option>
              </select>
            </div>
            <div className="v-set__row">
              <label className="v-set__label" htmlFor="git-worktree-command">
                how to make one
                <Key name="git.worktreeCommand" />
                {source('git', 'worktreeCommand')}
              </label>
              <TextField
                id="git-worktree-command"
                value={typeof git['worktreeCommand'] === 'string' ? git['worktreeCommand'] : ''}
                placeholder={'git worktree add "$VIBE_WORKTREE" "$VIBE_BRANCH" && cd "$VIBE_WORKTREE" && make deps'}
                disabled={busy}
                onSave={(next) => save({ git: { worktreeCommand: next === '' ? null : next } })}
              />
            </div>
            <p className="v-set__note">
              Left empty, vibe runs <code>git worktree add --detach</code> and nothing else — which
              gives you a checkout with no dependencies installed, so on most projects the
              verification gate cannot run in it. That is what this field is for. It runs through a
              shell in the repository, so it can be a sequence, and these are its placeholders —
              environment variables, so quote them:
            </p>
            <ul className="v-set__note">
              <li>
                <code>$VIBE_WORKTREE</code> — the directory the worktree must be created at
              </li>
              <li>
                <code>$VIBE_BRANCH</code> — the run&apos;s branch, already created from HEAD, so{' '}
                <code>git worktree add &quot;$VIBE_WORKTREE&quot; &quot;$VIBE_BRANCH&quot;</code> puts
                the worktree on it. Not set when branch isolation is off.
              </li>
              <li>
                <code>$VIBE_REPO</code> — the repository, and <code>$VIBE_RUN_ID</code> — the run
              </li>
            </ul>
            <p className="v-set__note">
              On Windows they are <code>%VIBE_WORKTREE%</code> and so on. It must leave a git working
              tree at the worktree path; if it does not, the run refuses before spending anything.
            </p>
            <div className="v-set__row">
              <label className="v-set__label" htmlFor="git-worktree-timeout">
                how long that may take, in minutes
                <Key name="git.worktreeTimeoutMs" />
                {source('git', 'worktreeTimeoutMs')}
              </label>
              <NumberField
                id="git-worktree-timeout"
                value={
                  typeof git['worktreeTimeoutMs'] === 'number'
                    ? Math.round(git['worktreeTimeoutMs'] / 60_000)
                    : undefined
                }
                disabled={busy}
                onSave={(next) => save({ git: { worktreeTimeoutMs: next * 60_000 } })}
              />
            </div>
          </section>
        </>
      )}

      <section className="v-set__block">
        <h3 className="v-set__h">where the loop hands control back</h3>
        <table className="v-set__matrix">
          <thead>
            <tr>
              <th>boundary</th>
              {frame.modes.map((m) => (
                <th key={m}>{m}</th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody>
            {frame.gateable.map((boundary) => (
              <tr key={boundary}>
                <td>
                  <code>{boundary}</code>
                  {/* In force versus claimed. A row the file does not name is a
                      default, and saying so is what stops somebody believing
                      they chose it. */}
                  {source('gates', boundary)}
                </td>
                {frame.modes.map((mode) => (
                  <td key={mode}>
                    <label className="v-set__radio">
                      <input
                        type="radio"
                        name={boundary}
                        checked={gates[boundary] === mode}
                        disabled={busy}
                        onChange={() => save({ gates: { [boundary]: mode } })}
                      />
                      <span>{MODE_NOTE[mode] ?? mode}</span>
                    </label>
                  </td>
                ))}
                <td />
              </tr>
            ))}
            {/* The two with no row, named with their own reasons. `mergeSection`
                would have dropped a hand-written entry for either in silence,
                and somebody who believes they armed a gate finds out by
                watching a run go past it. */}
            {Object.entries(frame.ungateable).map(([boundary, why]) => (
              <tr key={boundary} className="v-set__row--off">
                <td>
                  <code>{boundary}</code>
                  <MetaChip kind="alarm">cannot hold</MetaChip>
                </td>
                <td colSpan={frame.modes.length + 1} className="v-set__why">
                  {why}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="v-set__block">
        <h3 className="v-set__h">who does what</h3>
        {/* The models are the CLIs' own lists, asked when the window opened. A
            CLI updated since then has a newer list, and this asks again. */}
        <p className="v-set__note">
          Models are listed by each CLI on your account.{' '}
          <button
            className="v-doc__again"
            disabled={models.claude === null || models.codex === null}
            onClick={() => loadCliModels(true)}
          >
            check again
          </button>
        </p>
        {/*
          `1i`'s roles table, and the only part of global settings that is real
          configuration with a real validator behind it. The other three things
          `1i` draws are absent for stated reasons rather than by omission — see
          the note under the table.

          A role object **patches** rather than replaces, exactly as `--role`
          does, so changing one field leaves a model `vibe.config.json` named
          alone. That is `roleSetting`'s behaviour and this sends the same shape.
        */}
        <table className="v-set__matrix">
          <thead>
            <tr>
              <th>role</th>
              <th>agent</th>
              <th>effort</th>
              <th>model</th>
            </tr>
          </thead>
          <tbody>
            {frame.roleNames.map((role) => {
              const seat = roles[role];
              const current = typeof seat === 'string' ? { provider: seat } : (seat ?? {});
              return (
                <tr key={role}>
                  <td>
                    <code>{role}</code>
                    {source('roles', role)}
                  </td>
                  <td>
                    <select
                      value={current.provider ?? ''}
                      disabled={busy}
                      onChange={(e) =>
                        save({ roles: { [role]: { ...current, provider: e.target.value } } })
                      }
                    >
                      {frame.providers.map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <select
                      value={current.effort ?? ''}
                      disabled={busy}
                      onChange={(e) =>
                        save({ roles: { [role]: { ...current, effort: e.target.value } } })
                      }
                    >
                      {/* An empty option, because "not set" is a legal state and
                          the role then takes its agent's default. Removing it
                          would make every row claim an effort somebody chose. */}
                      <option value="">— agent default —</option>
                      {frame.efforts.map((e) => (
                        <option key={e} value={e}>
                          {e}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    {/* **The list this build knows, and `other…` past it.** The
                        first cut was free text, argued from the core's own rule:
                        `RoleSetting.model` is validated only for being a
                        non-empty string, because "guessing whether a model
                        exists is the never-invent-a-number rule applied to a
                        name". The reply was *"the model should be a drop down
                        and not a text input"*, and both hold — so the select
                        offers what the core sent, keeps a configured value it
                        does not recognise, and has a way in for one that shipped
                        this morning. Nothing here narrows the validator.

                        A typo is still caught by the run summary before anything
                        is spent, and by a turn failure naming `roles.<role>
                        .model` rather than the provider key. */}
                    <ModelField
                      id={`model-${role}`}
                      value={current.model}
                      agent={current.provider ?? 'agent'}
                      // Per agent, because a Claude model handed to Codex is a
                      // turn that fails after it has been spawned. A row whose
                      // agent this build has no list for offers none rather than
                      // borrowing the other one's.
                      listing={current.provider === 'claude' || current.provider === 'codex' ? models[current.provider] : null}
                      inherited={
                        current.provider === 'claude'
                          ? effective.claude?.model
                          : current.provider === 'codex'
                            ? effective.codex?.model
                            : undefined
                      }
                      disabled={busy}
                      onSave={(next) =>
                        save({ roles: { [role]: { ...current, model: next } } })
                      }
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      {/* ---- what every turn is told ------------------------------------- */}
      <section className="v-set__block">
        <h3 className="v-set__h">what each turn is told</h3>
        {/* **What this can honestly show, and what it cannot.** A prompt here is
            a function of the run — `planPrompt` takes the task and the prior-run
            index, `critiquePrompt` takes the plan it is judging, `fixPrompt`
            takes the findings and the diff — so there is no such thing as "the
            implement prompt" outside a run, and rendering one from invented
            inputs would be the fabrication this repo refuses everywhere else.

            What does not vary are the standing blocks below, which is what
            somebody reading a settings screen is actually asking about: what
            instructions is the reviewer permanently under. They arrive verbatim
            from the same constants the prompts interpolate. */}
        <p className="v-set__note">
          These are the <strong>standing</strong> instructions — the blocks every turn of a kind
          gets unchanged, quoted from the source rather than described. What is assembled per
          turn — the brief, the plan being judged, the findings, the diff — is in that run&apos;s
          own artifacts, on the Plans, Plan critique and Code review tabs.
        </p>
        {/* **The reversal, stated rather than quietly dropped.** This said they
            were *deliberately not configuration*, and that a per-project
            override would mean two runs of one version could not be compared.
            That cost is real and is now paid on purpose — an owner who wants a
            reviewer under different standing instructions has no other way to
            get one. What keeps the cost visible is that an overridden block is
            named on the run's own config, like any other setting. */}
        <p className="v-set__note">
          Editing one changes what every turn of that kind is told,{' '}
          <strong>in this project</strong>: it is written to <code>vibe.config.json</code>, which
          is committed. A run whose reviewer was told something different says so on its own
          config — which is what keeps two runs comparable.
        </p>
        <p className="v-set__note">
          <strong>Saving a version and using it are separate.</strong> A saved version lives in
          this window and changes nothing about any run; <em>use this</em> is the one that writes
          the project&apos;s file. <em>Use the default</em> clears the key rather than copying
          today&apos;s text into it, so the block follows the product forward.
        </p>
        <Section
          id="prompt-blocks"
          open={showPrompts}
          onToggle={() => setShowPrompts((on) => !on)}
          title="the blocks, in full"
          meta={
            prompts.blocks.length > 0 ? (
              <MetaChip>{prompts.blocks.length} blocks</MetaChip>
            ) : undefined
          }
        >
          {prompts.failure !== null && (
            <p className="v-set__note">
              <StateKicker tone="alarm">not read</StateKicker> {prompts.failure}
            </p>
          )}
          {prompts.failure === null && prompts.loading && prompts.blocks.length === 0 && (
            <p className="v-set__note">asking the host what every turn is told…</p>
          )}
          {prompts.blocks.map((block) => (
            <PromptBlock
              key={block.name}
              block={block}
              drafts={drafts}
              busy={busy}
              // Empty clears the key, which is what "use the default" means: a
              // cleared key follows the product forward when the default is
              // improved, where a copy of today's text pins this project to it.
              onAdopt={(name, text) => {
                save({ prompts: { [name]: text } });
                // The section re-reads, because the blocks it is drawing are
                // what the core will now render — and only the core knows that.
                prompts.reload();
              }}
              onSaveDraft={(draft) =>
                setDrafts((cur) => {
                  const next = saveDraft(cur, draft);
                  keep(DRAFTS_KEY, next);
                  return next;
                })
              }
              onRemoveDraft={(name, which) =>
                setDrafts((cur) => {
                  const next = removeDraft(cur, name, which);
                  keep(DRAFTS_KEY, next);
                  return next;
                })
              }
            />
          ))}
        </Section>
      </section>

    </div>
    </Refusals.Provider>
  );
}
