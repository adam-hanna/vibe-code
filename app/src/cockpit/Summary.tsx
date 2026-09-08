import { MetaChip, StateKicker } from '../design';
import { tokens as fmtTokens, work as fmtWork } from './format';
import type { Run } from './model';

/**
 * What the run did, once it has stopped doing it (`4g`, #223).
 *
 * **No merge UI, and that is the design's decision rather than an omission.**
 * DONE emits a summary card and everything after it is chat: the user asks the
 * pilot to open a PR, merge, clean up the worktree, and the pilot uses whatever
 * `gh` CLI or MCP tools are configured. That keeps vibe out of the git-client
 * business and makes the tool inventory the thing that decides what the pilot
 * can do.
 *
 * The design lists six things on the card. **Four are drawn and two are named as
 * absent**, because no frame carries them:
 *
 * - commits — the loop commits per round and narrates none of it. A count would
 *   have to come from `git`, which this window has no access to by design.
 * - the deferred/declined findings — `plan_approved` carries the declined ids,
 *   so those are here; the *deferred* set is a disposition nothing has recorded
 *   yet, and #114's archive reader is where it would come from.
 *
 * Naming them is the point. A card that showed only what it had would read as a
 * complete summary of a run that did more than it says.
 */
export function Summary({ run }: { run: Run }) {
  // The last write turn's reading. Not a run-wide diffstat: `work_measured` is
  // per turn, and summing them would double-count a file two turns both touched.
  const lastWork = [...run.cycles]
    .flatMap((c) => c.phases)
    .flatMap((p) => p.turns)
    .filter((t) => t.work !== null)
    .pop();

  const declined = run.censuses
    .filter((c) => c.phase === 'plan')
    .flatMap((c) => c.tolerated);

  return (
    <div className="v-summary">
      <div className="v-summary__head">
        <StateKicker tone="quiet">done</StateKicker>
        <span className="v-summary__title">what this run did</span>
      </div>

      <dl className="v-summary__facts">
        {run.identity !== null && (
          <>
            <dt>run</dt>
            <dd>
              <code>{run.identity.runId}</code>
            </dd>
            <dt>worktree</dt>
            <dd>
              <code>{run.identity.dir}</code>
            </dd>
          </>
        )}

        <dt>spent</dt>
        <dd>
          {run.spend.tokens === null ? (
            <span className="v-summary__absent">no turn reported a charge</span>
          ) : (
            <>
              {fmtTokens(run.spend.tokens)} tokens across {run.spend.charges.length} turns
              {/* Both agents under one ceiling, which is the one honest ceiling
                  the tool has. The Codex share is named rather than folded in,
                  because a reader asking "which agent spent this" has no other
                  way to find out. */}
              {run.spend.codexTokens !== null && (
                <> · {fmtTokens(run.spend.codexTokens)} of it Codex</>
              )}
            </>
          )}
        </dd>

        <dt>last write turn</dt>
        <dd>
          {lastWork?.work === undefined || lastWork.work === null ? (
            <span className="v-summary__absent">no turn measured the tree</span>
          ) : (
            fmtWork(lastWork.work)
          )}
        </dd>

        <dt>carried findings</dt>
        <dd>
          {declined.length === 0 ? (
            'none were carried forward'
          ) : (
            <>
              {declined.map((id) => (
                <MetaChip key={id}>{id}</MetaChip>
              ))}
            </>
          )}
        </dd>

        {/* Absent with the reason, never blank and never zero. */}
        <dt>commits</dt>
        <dd className="v-summary__absent">
          the loop commits each round and narrates none of it — this window has no git access, by
          design
        </dd>
      </dl>

      <p className="v-summary__next">
        There is no merge button on purpose. Ask the pilot to open a PR, merge, or clean up the
        worktree — it uses whatever git tooling you have configured, and every call it makes is
        drawn as a card.
      </p>
    </div>
  );
}
