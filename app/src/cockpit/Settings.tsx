import { useCallback, useEffect, useState } from 'react';
import { MetaChip, StateKicker } from '../design';
import * as host from '../host';
import type { ConfigFrame } from '../host';

/**
 * Project settings, and the gate matrix at the centre of them (`1h`, #223).
 *
 * **The form and the raw file are the same file the CLI reads, and this keeps
 * that true structurally rather than by promise.** Every save is a patch sent to
 * the host, merged into `vibe.config.json` by `writeConfigPatch`, validated by
 * the same `validate()` `loadConfig` runs — and **answered with the config that
 * resulted**. This screen never assumes its own save took effect.
 *
 * ## Why the matrix is the centre
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
 * not have or a mode it does not honour. The two ungateable boundaries are shown
 * **with their reasons** rather than omitted: somebody looking for `final-fix`
 * and not finding it learns nothing, and `mergeSection` would have dropped a
 * hand-written row for it in silence.
 *
 * ## What each mode costs, said on the row
 *
 * The difference between the two holding modes is *what a hold costs*, and it is
 * not obvious from their names. `step` holds and asks, which is free here
 * because the app runs the loop in-process — but **a terminal cannot answer a
 * promise**, so from the CLI a `step` row runs straight through. `stop` asks
 * nobody: the run ends there, resumably, whoever is listening. A matrix that did
 * not say that would let somebody arm a gate their terminal ignores.
 *
 * ## What is not built
 *
 * The rest of `1h`'s sidebar — worktree scripts, MCP, prompts — is either a
 * v1.5 issue (#137, #138) or has no configuration behind it yet. The **raw
 * JSON** is shown instead of pretending otherwise, which is `1h`'s own answer:
 * the form and the file are the same thing, so the file is a legitimate way to
 * edit what the form does not cover.
 */

/** What each mode does, and what it costs. The wording is `src/gates.ts`'s. */
const MODE_NOTE: Readonly<Record<string, string>> = {
  auto: 'runs through without asking',
  step: 'holds and asks — free here, ignored by a terminal',
  stop: 'ends the run, resumably, whoever is listening',
};

export function Settings({ dir }: { dir: string }) {
  const [frame, setFrame] = useState<ConfigFrame | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
          <strong>MCP servers</strong> are #138 and v1.5.
        </p>
      </section>

      <section className="v-set__block">
        <h3 className="v-set__h">the file itself</h3>
        {/* `1h`'s own answer to what the form does not cover: the form and the
            file are the same thing, so the file is a legitimate way to edit the
            rest. Read-only here — an editor that could write arbitrary JSON is a
            second path to the same file with different validation on it. */}
        <pre className="v-set__raw">{JSON.stringify(frame.raw, null, 2)}</pre>
        <p className="v-set__note">
          Shown rather than edited. Worktree scripts, MCP scoping and the prompt templates are
          v1.5 (#137, #138) and have no form here; editing the file directly is the supported way
          to reach them, and it is the same file this screen writes.
        </p>
      </section>
    </div>
  );
}
