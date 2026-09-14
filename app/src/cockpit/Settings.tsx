import { useCallback, useEffect, useState } from 'react';
import { MetaChip, StateKicker } from '../design';
import * as host from '../host';
import { Credentials } from '../pilot/Credentials';
import { Section } from './Disclosure';
import { STEPS } from './appearance';
import type { KeyStatus } from '../pilot/keys';
import type { ConfigFrame } from '../host';

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
 * The standing prompt blocks, fetched once when the section opens.
 *
 * Lazy for the reason every artifact pane is: the blocks are several pages and
 * nobody arriving at Settings is looking for them. One read, and it never
 * changes within a build — these are constants in `src/prompts.ts`, not
 * configuration.
 */
function usePromptBlocks(open: boolean): {
  blocks: readonly { name: string; usedBy: readonly string[]; text: string }[];
  failure: string | null;
  loading: boolean;
} {
  const [blocks, setBlocks] = useState<
    readonly { name: string; usedBy: readonly string[]; text: string }[]
  >([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !host.inShell() || blocks.length > 0) return;
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
  }, [open, blocks.length]);

  return { blocks, failure, loading };
}
export function Settings({
  dir,
  scale,
  onScale,
  statuses,
  keyFailure,
  onKeysChanged,
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
}) {
  const [frame, setFrame] = useState<ConfigFrame | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Whether the prompts section is open, which is what makes its read lazy. */
  const [showPrompts, setShowPrompts] = useState(false);
  const prompts = usePromptBlocks(showPrompts);

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
    roles?: Record<string, string | { provider?: string; effort?: string }>;
  };
  const gates = effective.gates ?? {};
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
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="v-set__note">
          {/* The refusal that is a rule rather than a bug, worth saying here
              because this is the form that can produce it. */}
          Two roles on the same agent is allowed; a <strong>writing</strong> role on a persisted
          Codex thread is refused outright rather than repaired, because{' '}
          <code>codex exec resume</code> takes no sandbox flag and the setting would silently
          revert after the first turn.
        </p>
        <p className="v-set__note">
          The rest of <code>1i</code> is not here: <strong>accounts</strong> want each CLI&apos;s
          detected version and its rate-limit headroom, and no frame carries either;{' '}
          <strong>MCP servers</strong> are not configurable here yet.
        </p>
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
        <p className="v-set__note">
          They are not editable here and are deliberately not configuration: they are the
          product&apos;s behaviour, and a per-project override would mean two runs of the same
          version could not be compared.
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
            <div className="v-set__prompt" key={block.name}>
              <div className="v-set__promptname">
                <span>{block.name}</span>
                {/* Which turns include it. Told by the core beside the block
                    rather than worked out here: the interpolation sites are in
                    five different template literals and a window has no way to
                    check a claim about them. */}
                {block.usedBy.map((role) => (
                  <MetaChip key={role}>{role}</MetaChip>
                ))}
              </div>
              <pre className="v-set__raw">{block.text}</pre>
            </div>
          ))}
        </Section>
      </section>

      <section className="v-set__block">
        <h3 className="v-set__h">the file itself</h3>
        {/* `1h`'s own answer to what the form does not cover: the form and the
            file are the same thing, so the file is a legitimate way to edit the
            rest. Read-only here — an editor that could write arbitrary JSON is a
            second path to the same file with different validation on it. */}
        <pre className="v-set__raw">{JSON.stringify(frame.raw, null, 2)}</pre>
        <p className="v-set__note">
          Shown rather than edited. Worktree scripts and MCP scoping have no form here yet;
          editing the file directly is the supported way to reach them, and it is the same file
          this screen writes.
        </p>
      </section>
    </div>
  );
}
