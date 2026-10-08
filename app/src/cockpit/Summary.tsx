import type { ReactNode } from 'react';
import { ArrowRight, Bug, Check, Clock, Code, Folder, RefreshCw } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Badge } from '@/ui/badge';
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

/** A small uppercase label over a figure or a section. */
const LABEL = 'text-label uppercase tracking-label text-tertiary';

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
    <section
      className="mx-4 mt-3 flex flex-col gap-3 rounded-md border border-rule-card bg-card p-3"
      aria-labelledby="v-summary-title"
    >
      <div className="flex items-center gap-2">
        <span
          className="grid size-7 flex-none place-items-center rounded-full border border-accent-border bg-accent-tint text-accent"
          aria-hidden="true"
        >
          <Check size={16} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className={LABEL}>run complete</span>
          <h2 id="v-summary-title" className="m-0 font-bold text-section text-primary">What this run did</h2>
        </div>
        <Badge>done</Badge>
      </div>

      {run.identity !== null && (
        <div
          className="flex min-w-0 items-center gap-2 rounded-sm border border-rule-inner bg-panel p-2 text-tertiary"
          title={run.identity.dir}
        >
          <Folder size={15} className="flex-none" aria-hidden="true" />
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className={LABEL}>run folder</span>
            <code className="max-w-[13ch] truncate font-mono text-mono-sm text-primary">{run.identity.runId}</code>
          </div>
          {/* Right-to-left so a long path keeps its tail - the run id - in view
              and loses its head to the ellipsis, which is the end nobody needs. */}
          <span className="min-w-0 flex-1 truncate text-left font-mono text-mono-sm text-tertiary [direction:rtl]">
            {run.identity.dir}
          </span>
        </div>
      )}

      <div className="grid grid-cols-[repeat(auto-fit,minmax(130px,1fr))] gap-2" role="list">
        <Metric icon={Clock} label="Spent" value={spendValue} detail={spendDetail} />
        <Metric icon={Code} label="Last write" value={workValue} detail={workDetail} />
        <Metric
          icon={Bug}
          label="Carried findings"
          value={carried.length === 0 ? 'None' : String(carried.length)}
          detail={
            carried.length === 0 ? (
              'nothing carried forward'
            ) : (
              <span className="flex flex-wrap gap-1">
                {carried.map((id) => (
                  <Badge key={id} className="font-mono normal-case tracking-normal">{id}</Badge>
                ))}
              </span>
            )
          }
        />
        <Metric icon={RefreshCw} label="Commits" value={commitValue} detail={commitDetail} />
      </div>

      <div className="border-t border-rule-inner pt-3 text-secondary">
        <div className={`${LABEL} flex items-center gap-1 text-accent-muted`}>
          <ArrowRight size={15} aria-hidden="true" />
          <span>Next step</span>
        </div>
        <p className="mt-1 mb-0 text-body-sm">
          Ask the pilot to open a PR, merge, or clean up the worktree. Each request stays visible
          in the conversation.
        </p>
      </div>
    </section>
  );
}

function Metric({
  icon: Icon,
  label,
  value,
  detail,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  detail: ReactNode;
}) {
  return (
    <div
      className="flex min-h-20 min-w-0 flex-col gap-1 rounded-sm border border-rule-inner bg-panel p-2"
      role="listitem"
    >
      <div className={`${LABEL} flex items-center gap-1 whitespace-nowrap`}>
        <Icon size={14} className="flex-none text-accent-muted" aria-hidden="true" />
        <span>{label}</span>
      </div>
      <strong className="min-w-0 truncate text-section text-emphasis">{value}</strong>
      <div className="min-w-0 text-body-sm text-secondary [overflow-wrap:anywhere]">{detail}</div>
    </div>
  );
}

function workHeadline(work: Work | null): string {
  if (work === null) return '—';
  if (work.files === 0) return 'No files';
  return `${work.files} ${work.files === 1 ? 'file' : 'files'}`;
}
