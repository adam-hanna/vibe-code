import { useState } from 'react';
import { Check, Copy, X } from 'lucide-react';
import { buildStamp, uptime } from './format';
import type { Build, Status } from '../host';

/**
 * Hi-fi 15 — the four facts, out of the chrome (#201, #204, #207).
 *
 * `HOST 43804` and `PROTOCOL 1` sat permanently in the titlebar, and a manual
 * pass reported the obvious: *"That means nothing to a user."* They are
 * diagnostics. But each one becomes essential the moment it is **wrong** — a
 * protocol disagreement means the window and the core are two versions apart,
 * and the pid is what you hunt for when the host is wedged — so they are moved
 * rather than deleted, and the chrome keeps a chip for the wrong case only.
 *
 * Four facts, each with the sentence that makes it usable rather than the bare
 * value:
 *
 * - **run id and its directory.** The complaint that produced #207 was *"how can
 *   I inspect the plan"*, which is a question about finding a folder, not about
 *   seeing an id — so the path is here beside it.
 * - **build.** Two builds of one version are otherwise identical, and
 *   single-instance means a stale one silently absorbs the launch of a fresh one.
 * - **host pid and uptime.**
 * - **protocol, and what this window expected.**
 *
 * Every value is monospace with a copy control, because these are strings
 * destined for a bug report and retyping a run id is how the wrong run gets
 * investigated.
 *
 * **The body of a popover, not a modal: no scrim.** Diagnostics are read while
 * looking at the thing that went wrong, so this is the one elevated surface in
 * the product that does not block what is behind it. The status bar owns the
 * popover; this is what goes inside it.
 */

/** One fact: what it is, the value to copy, and why it is worth having. */
function Fact({ label, value, note }: { label: string; value: string | null; note: string }) {
  const [copied, setCopied] = useState<'yes' | 'no' | null>(null);

  const copy = (): void => {
    // Refuse, never repair. A clipboard write can be denied, and a control that
    // silently did nothing would have the reader pasting whatever was there
    // before - which for a run id is the worst possible failure of this panel.
    void navigator.clipboard
      .writeText(value ?? '')
      .then(() => setCopied('yes'))
      .catch(() => setCopied('no'));
  };

  return (
    <div className="grid grid-cols-[4.5rem_1fr_auto] items-baseline gap-x-2 gap-y-0.5 py-1.5 [&+&]:border-t [&+&]:border-rule-inner">
      <span className="text-chip font-bold uppercase tracking-wide text-tertiary">{label}</span>
      {value === null ? (
        // Absent with its reason, never blank and never a placeholder value.
        <span className="col-span-2 text-body-sm text-tertiary">{note}</span>
      ) : (
        <>
          <span className="break-all font-mono text-mono-sm text-emphasis">{value}</span>
          <button
            type="button"
            className="flex cursor-pointer items-center gap-1 rounded-sm border border-transparent bg-transparent px-1 text-label text-secondary hover:text-emphasis"
            onClick={copy}
            aria-label={`copy ${label}`}
          >
            {copied === 'yes' ? <Check className="size-3" aria-hidden /> : copied === 'no' ? <X className="size-3" aria-hidden /> : <Copy className="size-3" aria-hidden />}
            {copied === null ? 'copy' : copied === 'yes' ? 'copied' : 'could not copy'}
          </button>
          <span className="col-start-2 col-span-2 text-label text-tertiary">{note}</span>
        </>
      )}
    </div>
  );
}

export interface DiagnosticsProps {
  status: Status | null;
  /** The protocol this window was built against. */
  expected: number;
  /** The run's identity, or null before the loop has said which run it is. */
  identity: { runId: string; dir: string } | null;
}

export function Diagnostics({ status, expected, identity }: DiagnosticsProps) {
  const build: Build | null = status?.build ?? null;
  const protocol = status?.ready?.protocol ?? null;

  return (
    <div aria-label="diagnostics">
      <div className="mb-1 text-chip font-bold uppercase tracking-wide text-tertiary">Diagnostics</div>

      <Fact
        label="run"
        value={identity?.runId ?? null}
        note={
          identity === null
            ? 'no run has started in this window yet'
            : `artifacts in ${identity.dir}`
        }
      />
      <Fact
        label="build"
        value={build === null ? null : buildStamp(build)}
        note={
          build === null
            ? 'the host has not been asked yet'
            : build.commit === null
              ? 'this tree had no git to ask, so there is no commit to report'
              : 'two builds of one version are otherwise identical'
        }
      />
      <Fact
        label="host"
        value={status?.pid === undefined || status.pid === null ? null : String(status.pid)}
        note={
          status?.pid === undefined || status.pid === null
            ? (status?.failure ?? 'no host is running')
            : status.uptimeSecs === null
              ? 'up for an unknown time'
              : `up ${uptime(status.uptimeSecs)}`
        }
      />
      <Fact
        label="protocol"
        value={protocol === null ? null : String(protocol)}
        note={
          protocol === null
            ? 'the host has not said which protocol it speaks'
            : protocol === expected
              ? `this window expects ${String(expected)}`
              : `this window expects ${String(expected)} — they disagree`
        }
      />
      {/* Why killing the app would leave the host running, when it would (#157).
          Shown here rather than as a banner, which was removed at the owner's
          request: it is a fact that matters only when something has gone wrong. */}
      {status?.uncontained != null && (
        <p className="mt-2 text-label text-tertiary">{status.uncontained}</p>
      )}
    </div>
  );
}
