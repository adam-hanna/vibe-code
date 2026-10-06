import type { ReactNode } from 'react';

import { Icon } from '../design/Icon';
import { MetaChip, StateKicker } from '../design';
import { tokens as fmtTokens, work as fmtWork } from './format';
import type { Run, Work } from './model';

/**
 * What the run did, once it has stopped doing it (`4g`, #223).
 *
 * **No merge UI, and that is the design's decision rather than an omission.**
 * DONE emits a summary card and everything after it is chat: the user asks the
 * pilot to open a PR, merge, clean up the worktree, and the pilot uses whatever
 * `gh` CLI or MCP tools are configured. The card reports the evidence the run
 * actually carried: spend, its last measured write, carried findings, commits,
 * and the branch when one was named.
 *
 * The layout is deliberately a scan rather than a definition list. Long paths
 * stay on one line with their full value available on hover, while measurements
 * remain peers so the completion state is legible at the narrowest panel width.
 */
export function Summary({ run }: { run: Run }) {
  // The last write turn's reading. Not a run-wide diffstat: `work_measured` is
  // per turn, and summing them would double-count a file two turns both touched.
  const lastWork = [...run.cycles]
    .flatMap((c) => c.phases)
    .flatMap((p) => p.turns)
    .filter((t) => t.work !== null)
    .pop()?.work ?? null;

  const carried = run.censuses
    .filter((c) => c.phase === 'plan')
    .flatMap((c) => c.tolerated);

  const spendValue = run.spend.tokens === null ? '—' : fmtTokens(run.spend.tokens);
  const spendDetail =
    run.spend.tokens === null
      ? 'no turn reported a charge'
      : `${run.spend.charges.length} turns${
          run.spend.codexTokens === null ? '' : ` · ${fmtTokens(run.spend.codexTokens)} Codex`
        }`;

  const workValue = workHeadline(lastWork);
  const workDetail = lastWork === null ? 'no turn measured the tree' : fmtWork(lastWork);

  const commitValue = run.commits.length === 0 ? 'None' : String(run.commits.length);
  const commitDetail =
    run.commits.length === 0
      ? run.branch?.why ?? 'no commits were recorded'
      : run.branch?.name === null || run.branch?.name === undefined
        ? 'commits recorded for this run'
        : `on ${run.branch.name}`;

  return (
    <section className="v-summary" aria-labelledby="v-summary-title">
      <div className="v-summary__head">
        <span className="v-summary__done" aria-hidden="true">
          <Icon name="check" size={16} />
        </span>
        <div className="v-summary__heading">
          <span className="v-summary__eyebrow">run complete</span>
          <h2 id="v-summary-title">What this run did</h2>
        </div>
        <StateKicker tone="quiet">done</StateKicker>
      </div>

      {run.identity !== null && (
        <div className="v-summary__identity" title={run.identity.dir}>
          <Icon name="folder" size={15} />
          <div className="v-summary__identitycopy">
            <span className="v-summary__identitylabel">run folder</span>
            <code>{run.identity.runId}</code>
          </div>
          <span className="v-summary__identitypath">{run.identity.dir}</span>
        </div>
      )}

      <div className="v-summary__metrics" role="list">
        <Metric icon="clock" label="Spent" value={spendValue} detail={spendDetail} />
        <Metric icon="code" label="Last write" value={workValue} detail={workDetail} />
        <Metric
          icon="bug"
          label="Carried findings"
          value={carried.length === 0 ? 'None' : String(carried.length)}
          detail={
            carried.length === 0 ? (
              'nothing carried forward'
            ) : (
              <span className="v-summary__chips">
                {carried.map((id) => (
                  <MetaChip key={id}>{id}</MetaChip>
                ))}
              </span>
            )
          }
        />
        <Metric icon="loop" label="Commits" value={commitValue} detail={commitDetail} />
      </div>

      <div className="v-summary__next">
        <div className="v-summary__nexthead">
          <Icon name="arrow" size={15} />
          <span>Next step</span>
        </div>
        <p>
          Ask the pilot to open a PR, merge, or clean up the worktree. Each request stays visible
          in the conversation.
        </p>
      </div>
    </section>
  );
}

function Metric({
  icon,
  label,
  value,
  detail,
}: {
  icon: 'clock' | 'code' | 'bug' | 'loop';
  label: string;
  value: string;
  detail: ReactNode;
}) {
  return (
    <div className="v-summary__metric" role="listitem">
      <div className="v-summary__metrichead">
        <Icon name={icon} size={14} />
        <span>{label}</span>
      </div>
      <strong>{value}</strong>
      <div className="v-summary__metricdetail">{detail}</div>
    </div>
  );
}

function workHeadline(work: Work | null): string {
  if (work === null) return '—';
  if (work.files === 0) return 'No files';
  return `${work.files} ${work.files === 1 ? 'file' : 'files'}`;
}
