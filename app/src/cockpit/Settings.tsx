import { useCallback, useEffect, useState } from 'react';
import { Button, MetaChip, StateKicker } from '../design';
import * as host from '../host';
import { Credentials } from '../pilot/Credentials';
import type { PilotLimits } from '../pilot/ledger';
import { Section } from './Disclosure';
import { STEPS } from './appearance';
import { DRAFTS_KEY, draftsFor, readDrafts, removeDraft, saveDraft } from './drafts';
import type { Draft } from './drafts';
import type { KeyStatus } from '../pilot/keys';
import type { ConfigFrame, PromptsFrame } from '../host';

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
 * ## Subscription against keys, which is the question this screen has to answer
 *
 * It is not one question, it is two, about two different things, and conflating
 * them is what made the old Keys tab read as though the product needed an API
 * key to work at all:
 *
 * - **A run's agents are always the subscription.** `claude` and `codex` are
 *   child processes that inherit whatever you are already logged into — vibe
 *   installs neither and holds no credential for either. There is no key to
 *   enter and nothing on this screen to set, which is why the section states it
 *   rather than offering a control.
 * - **The pilot chooses, per conversation.** On the subscription it is a
 *   `claude -p` child like any turn, and bills nothing. On an API key it is an
 *   HTTP request this app makes, money moves, and `ledger.ts` is the only place
 *   in the product where a dollar is a dollar. The keys below are for that
 *   second case **only** — the pilot works with none of them.
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
  // Re-seeded when the saved value changes, so a refused patch shows what is
  // actually in force rather than what was typed at it.
  useEffect(() => {
    setTyped(value === undefined ? '' : String(value));
  }, [value]);

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
  useEffect(() => {
    setTyped(value ?? '');
  }, [value]);

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
 * The sentinel for *let me type one*.
 *
 * A string no model can be, rather than an empty value, because empty already
 * means *take the agent's default* and the two are opposite intentions.
 */
const OTHER = ' other';

/**
 * Which model a role runs on: a list of the ones this build knows, and a way
 * past it (#223).
 *
 * **This reverses a decision made one report ago, and the reversal is narrow.**
 * The field was free text, argued from the core's own rule - *"no allowlist and
 * no default table: guessing whether a model exists is the never-invent-a-number
 * rule applied to a name"* - and the reply was *"the model should be a drop down
 * and not a text input"*. Both are right about different halves. Typing
 * `gpt-5.6-luna` from memory to change one role is a bad control; a list that
 * *claimed* to be the vendor's catalogue would be the invention.
 *
 * So the list is what this build **knows a name for**, sent by the core from
 * `KNOWN_MODELS` beside the defaults it has to agree with, and three things keep
 * it from becoming an allowlist:
 *
 * - **A value not on the list is still shown**, as its own option, marked. A
 *   select that silently dropped it would rewrite a role's model by rendering,
 *   which is the worst kind of data loss because nobody pressed anything.
 * - **`other…` is always there**, and it reveals the text field this replaced.
 *   A model that shipped this morning is typeable this morning; the core still
 *   validates it as any non-empty string, so nothing here can refuse one.
 * - **Empty is a legal state and is offered**, because a role with no model
 *   takes its agent's own default, which is what every unconfigured row is.
 */
function ModelField({
  id,
  value,
  agent,
  known,
  disabled,
  onSave,
}: {
  id: string;
  value: string | undefined;
  agent: string;
  known: readonly string[];
  disabled: boolean;
  onSave: (next: string) => void;
}) {
  const current = value ?? '';
  // `other…` is a mode, not a value. It is held here rather than derived from
  // `current` because somebody who has just chosen it has typed nothing yet, and
  // a derived flag would flip the control back the moment the box emptied.
  const [typing, setTyping] = useState(false);

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
      {/* Not set, which is what an unconfigured row is and a legal thing to go
          back to. Removing it would make every row claim a model somebody
          chose. */}
      <option value="">— {agent} default —</option>
      {known.map((m) => (
        <option key={m} value={m}>
          {m}
        </option>
      ))}
      {/* Configured, and not one this build has a name for. Kept rather than
          dropped: it may be a model that shipped after this build, and a select
          that could not represent its own value would overwrite it. */}
      {current !== '' && !known.includes(current) && (
        <option value={current}>{current} — not one this build knows</option>
      )}
      <option value={OTHER}>other…</option>
    </select>
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
export function Settings({
  dir,
  scale,
  onScale,
  statuses,
  keyFailure,
  onKeysChanged,
  limits,
  onLimits,
}: {
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
}) {
  const [frame, setFrame] = useState<ConfigFrame | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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

  const save = useCallback(
    (patch: Record<string, unknown>) => {
      setBusy(true);
      setSaved(null);
      void host
        .config(dir, patch)
        .then((next) => {
          // The config that RESULTED, not the patch that was sent.
          setFrame(next);
          setFailure(null);
          setSaved(next.path ?? 'vibe.config.json');
        })
        .catch((err: unknown) => {
          // The core validator's own sentence, which names the field. Nothing
          // was written, so the screen still shows what is in force.
          setFailure(err instanceof Error ? err.message : String(err));
          setSaved(null);
        })
        .finally(() => setBusy(false));
    },
    [dir],
  );

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
      </div>
    );
  }

  const effective = frame.effective as {
    gates?: Record<string, string>;
    roles?: Record<string, string | { provider?: string; effort?: string; model?: string }>;
    loop?: Record<string, number | undefined>;
    progress?: Record<string, number | boolean | undefined>;
    budget?: Record<string, number | boolean | undefined>;
  };
  const gates = effective.gates ?? {};
  const loop = effective.loop ?? {};
  // Which loop keys the FILE claims, as opposed to which are in force — the
  // same split the gate matrix draws its `default` chip from.
  const claimedLoop = (frame.raw['loop'] ?? {}) as Record<string, unknown>;
  const progress = effective.progress ?? {};
  const claimedProgress = (frame.raw['progress'] ?? {}) as Record<string, unknown>;
  const budget = effective.budget ?? {};
  const claimedBudget = (frame.raw['budget'] ?? {}) as Record<string, unknown>;
  const roles = effective.roles ?? {};
  // Which rows the FILE claims, as opposed to which are in force. That is the
  // whole reason `raw` travels beside `effective`.
  const claimed = (frame.raw['gates'] ?? {}) as Record<string, unknown>;

  return (
    <div className="v-set">
      <div className="v-set__head">
        <span>
          {frame.path === null ? (
            <>
              no <code>vibe.config.json</code> — everything below is a default, and saving creates
              the file
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

      {/* ---- who is logged in, and who holds a key ------------------------ */}
      <section className="v-set__block">
        <h3 className="v-set__h">agents, and the pilot&apos;s credentials</h3>
        {/* The answer to "subscription or keys": they are two different things
            about two different processes, and only one of them has a control. */}
        <div className="v-set__fact">
          <span className="v-set__factname">a run&apos;s agents</span>
          <span>
            <strong>Always your own subscriptions, and there is nothing here to set.</strong>{' '}
            <code>claude</code> and <code>codex</code> are child processes that inherit whatever
            you are already logged into — vibe installs neither and holds no credential for
            either. If a run cannot reach one, that is a login in your terminal, not a setting in
            this window; <code>vibe doctor</code> is what checks it.
          </span>
        </div>
        <div className="v-set__fact">
          <span className="v-set__factname">the pilot</span>
          <span>
            <strong>Chooses, per conversation.</strong> On the subscription it is a{' '}
            <code>claude -p</code> child like any turn and bills nothing at all. On an API key it
            is an HTTP request this app makes — money moves, and the pilot&apos;s reply says what
            it estimates and the date the price was read. The keys below are for that second case
            only: <strong>the pilot works with none of them.</strong>
          </span>
        </div>
        <div className="v-set__fact">
          <span className="v-set__factname">where keys live</span>
          <span>
            The OS keychain, never <code>vibe.config.json</code> — that file is committed, and the
            config validator reports bad values <em>by name</em>, which is the one thing that must
            never happen to a secret. Nothing in this window can read a key back.
          </span>
        </div>
        <Credentials statuses={statuses} failure={keyFailure} onChanged={onKeysChanged} />
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
                  {claimedLoop[limit.key] === undefined && <MetaChip>default</MetaChip>}
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
              {claimedLoop['p1Tolerance'] === undefined && <MetaChip>default</MetaChip>}
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
              {claimedProgress['maxQuietMs'] === undefined && <MetaChip>default</MetaChip>}
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
                {claimedBudget['maxTokens'] === undefined && <MetaChip>default</MetaChip>}
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
                {claimedBudget['planShare'] === undefined && <MetaChip>default</MetaChip>}
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
                {claimedBudget['maxCostUsd'] === undefined && <MetaChip>default</MetaChip>}
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
                {claimedBudget['maxWaitMinutes'] === undefined && <MetaChip>default</MetaChip>}
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
                {claimedBudget['codexLimitPercent'] === undefined && <MetaChip>default</MetaChip>}
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
                  {claimed[boundary] === undefined && <MetaChip>default</MetaChip>}
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
                    {(frame.raw['roles'] as Record<string, unknown> | undefined)?.[role] ===
                      undefined && <MetaChip>default</MetaChip>}
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
                      known={frame.models[current.provider ?? ''] ?? []}
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
  );
}
