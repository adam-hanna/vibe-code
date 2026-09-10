import { useCallback, useEffect, useMemo, useState } from 'react';
import { DiffRow, HunkHeader, MetaChip, StateKicker, TruncationBand } from '../design';
import * as host from '../host';
import { raiseBlock } from './raise';
import type { Severity } from '../design';

/**
 * The diff, and the composer that turns a line into a finding (`1d`, #223).
 *
 * ## The composer proposes; it does not raise
 *
 * **A human finding has no host frame, and that is settled** — `AGENTS.md` says
 * it in as many words: *"`src/host.ts` says every `Decision` member that mutates
 * run state needs its own validator before it is offered, and a `raise` member is
 * exactly that."* The mechanism #141 built is a block appended to
 * `NEEDS-INPUT.md`, parsed on the resume that reads the answers, merged into
 * `pendingFindings` and held to the same grounding rule the reviewer's findings
 * are.
 *
 * So this composes **exactly that block**, with the file and line filled in from
 * the hunk you clicked, and hands it to you to paste. That is the same
 * propose-only shape the pilot's tools use (#144), and the enforcement is the
 * same: nothing is sent, so nothing can be half-applied.
 *
 * It is not a lesser version of the feature. The severity, the evidence line and
 * the two quoted blocks are the finding — what a frame would add is saving one
 * paste, and it would add a mutation path with no validator behind it.
 *
 * ## What the diff is taken against
 *
 * `baseSha`, told on `phase_started`. **Never absent-and-guessed**: given no
 * base, `diffSince` runs `git add -A` before diffing and stages the whole
 * working tree, so a pane with no base says so and asks for nothing.
 */

/** A parsed hunk, enough to render and to cite. */
interface Hunk {
  file: string;
  /** The `@@` line, verbatim. */
  header: string;
  /** The first line number on the new side, for the `*File:*` citation. */
  line: number;
  rows: readonly { kind: 'add' | 'del' | 'ctx'; text: string }[];
}

/**
 * Split a unified diff into hunks, per file.
 *
 * Deliberately small: it recognises `diff --git`, `+++ b/`, `@@` and the three
 * line prefixes, and treats everything else as context. A parser that tried to
 * be complete would be a second opinion about what git produced; this only has
 * to be right enough to render lines and cite one.
 */
function parseDiff(patch: string): Hunk[] {
  const out: Hunk[] = [];
  let file = '';
  let current: Hunk | null = null;
  for (const raw of patch.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      current = null;
      file = '';
      continue;
    }
    if (raw.startsWith('+++ ')) {
      file = raw.slice(4).replace(/^b\//, '');
      continue;
    }
    if (raw.startsWith('@@')) {
      // `@@ -a,b +c,d @@` — `c` is the first line on the new side, which is the
      // number a citation has to carry.
      const at = /\+(\d+)/.exec(raw.split('@@')[1] ?? '');
      current = {
        file,
        header: raw,
        line: at === null ? 1 : Number(at[1]),
        rows: [],
      };
      out.push(current);
      continue;
    }
    if (current === null) continue;
    const kind = raw.startsWith('+') ? 'add' : raw.startsWith('-') ? 'del' : 'ctx';
    (current.rows as { kind: 'add' | 'del' | 'ctx'; text: string }[]).push({
      kind,
      text: raw.slice(kind === 'ctx' ? 0 : 1),
    });
  }
  return out;
}

const SEVERITIES: readonly Severity[] = ['P0', 'P1', 'P2', 'P3'];

export function DiffPane({
  dir,
  baseSha,
  headSha,
  revision = 0,
}: {
  dir: string;
  baseSha: string | null;
  /**
   * The far end of the range, which makes this **one round** rather than the
   * whole change (#223).
   *
   * Both shas come from `round_committed`, which reads HEAD before it commits -
   * so a round's range is measured rather than paired off the commit list, which
   * goes silently wrong on a resumed run whose earlier commits were narrated to
   * a process that has exited.
   *
   * Undefined is `1d`'s original question: everything since the base.
   */
  headSha?: string | undefined;
  /**
   * Something changed at the far end, so ask again (#223).
   *
   * **Only the open-ended diff needs it.** A range with both ends named can
   * never change - those two commits are in the history and stay what they were
   * - but *everything since the base* grows every time a round commits, and
   * without this it stayed whatever it was when the tab was opened.
   */
  revision?: number;
}) {
  const [patch, setPatch] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // The composer's state, and the citation it was opened against.
  const [at, setAt] = useState<{ file: string; line: number } | null>(null);
  const [title, setTitle] = useState('');
  const [detail, setDetail] = useState('');
  const [fix, setFix] = useState('');
  const [severity, setSeverity] = useState<Severity>('P2');
  const [copied, setCopied] = useState(false);

  const load = useCallback(() => {
    if (baseSha === null) return;
    if (!host.inShell()) {
      setFailure('the diff is read by the host, and there is no host in a browser');
      return;
    }
    void host
      .diff(dir, baseSha, headSha)
      .then((got) => {
        setPatch(got.patch);
        setTruncated(got.truncated);
        setFailure(null);
      })
      .catch((err: unknown) => setFailure(err instanceof Error ? err.message : String(err)));
  }, [dir, baseSha, headSha, revision]);

  useEffect(load, [load]);

  const hunks = useMemo(() => (patch === null ? [] : parseDiff(patch)), [patch]);

  if (baseSha === null) {
    // Named, with the reason. Asking for a diff with no base is the request that
    // would stage the user's whole working tree.
    return (
      <div className="v-dp v-dp--empty">
        <StateKicker tone="quiet">no base yet</StateKicker>
        <p>
          A diff is taken against the commit the implement phase marks, and this run has not
          reached it. Nothing is guessed here: a diff with no base would stage your whole working
          tree before it read anything.
        </p>
      </div>
    );
  }

  if (failure !== null) {
    return (
      <div className="v-dp v-dp--empty">
        <StateKicker tone="alarm">no diff</StateKicker>
        <p>{failure}</p>
        <button className="v-dp__again" onClick={load}>
          try again
        </button>
      </div>
    );
  }

  if (patch === null) {
    return (
      <div className="v-dp v-dp--empty">
        <StateKicker tone="quiet">reading</StateKicker>
        <p>asking the host for the diff since {baseSha.slice(0, 7)}…</p>
      </div>
    );
  }

  if (hunks.length === 0) {
    return (
      <div className="v-dp v-dp--empty">
        <StateKicker tone="quiet">nothing changed</StateKicker>
        <p>
          Nothing has changed since {baseSha.slice(0, 7)}. That is a measurement, not a failure to
          read one.
        </p>
      </div>
    );
  }

  const block = at === null ? '' : raiseBlock({ ...at, title, detail, fix, severity });

  return (
    <div className="v-dp">
      <div className="v-dp__head">
        <span>
          {hunks.length} hunk{hunks.length === 1 ? '' : 's'} since{' '}
          <code>{baseSha.slice(0, 7)}</code>
        </span>
        <button className="v-dp__again" onClick={load}>
          reread
        </button>
      </div>

      {/* The band is a judgement about what the REVIEWER read, so it is drawn
          from the flag the host sent rather than from anything found in the
          text. */}
      {truncated && (
        <TruncationBand>
          This diff was cut at the ceiling before it reached the reviewer, so the reviewer did not
          see all of it either. Read the working tree directly for the rest.
        </TruncationBand>
      )}

      {at !== null && (
        <form className="v-dp__composer" onSubmit={(e) => e.preventDefault()}>
          <div className="v-dp__head">
            <StateKicker tone="accent">a finding at</StateKicker>
            <code>
              {at.file}:{at.line}
            </code>
            <button type="button" className="v-dp__again" onClick={() => setAt(null)}>
              close
            </button>
          </div>

          <input
            className="v-dp__field"
            placeholder="one line saying what is wrong"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <div className="v-dp__sevs">
            {SEVERITIES.map((s) => (
              <label key={s} className="v-dp__sev">
                <input
                  type="radio"
                  name="severity"
                  checked={severity === s}
                  onChange={() => setSeverity(s)}
                />
                <span>{s}</span>
              </label>
            ))}
          </div>
          <textarea
            className="v-dp__field"
            rows={3}
            placeholder="what is wrong, in detail"
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
          />
          <textarea
            className="v-dp__field"
            rows={2}
            placeholder="what would fix it"
            value={fix}
            onChange={(e) => setFix(e.target.value)}
          />

          <pre className="v-dp__block">{block}</pre>

          {/*
            Propose only. There is no "raise" button because there is no frame
            behind one: a human finding goes into NEEDS-INPUT.md and is read on
            the resume that reads the answers, which is #141's mechanism and is
            where the grounding rule, the gate's count and `finding_reraised` all
            already live.
          */}
          <div className="v-dp__foot">
            <button
              type="button"
              className="v-dp__again"
              onClick={() => {
                void navigator.clipboard
                  .writeText(block)
                  .then(() => setCopied(true))
                  // A clipboard that refused is said out loud rather than
                  // swallowed: the block is on screen and can be selected, so
                  // the failure is recoverable.
                  .catch(() => setCopied(false));
              }}
            >
              {copied ? 'copied' : 'copy the block'}
            </button>
            <span className="v-dp__note">
              Paste this under <strong>Raise a finding</strong> in the run&apos;s{' '}
              <code>NEEDS-INPUT.md</code> and resume. A P0 or P1 whose <code>*File:*</code> line
              does not resolve is carried as a P2 with the reason recorded — the same rule the
              reviewer is held to.
            </span>
          </div>
        </form>
      )}

      {hunks.map((hunk, i) => (
        <section key={`${hunk.file}-${String(i)}`} className="v-dp__section">
          <HunkHeader>
            {hunk.file} <MetaChip>{hunk.header}</MetaChip>
          </HunkHeader>
          {hunk.rows.map((row, j) => {
            const number = hunk.line + j;
            const selected = at !== null && at.file === hunk.file && at.line === number;
            return (
              // The row is the design system's and stays untouched; the button
              // is this pane's. Wrapping rather than extending `DiffRow`: a
              // primitive that grew an `onComment` would carry a behaviour only
              // one screen wants into the gallery every screen is checked in.
              <button
                // eslint-disable-next-line react/no-array-index-key
                key={j}
                type="button"
                className="v-dp__line"
                onClick={() => {
                  setAt({ file: hunk.file, line: number });
                  setCopied(false);
                }}
              >
                <DiffRow
                  kind={row.kind === 'add' ? 'added' : row.kind === 'del' ? 'removed' : 'context'}
                  newNo={number}
                  code={row.text}
                  selected={selected}
                />
              </button>
            );
          })}
        </section>
      ))}
    </div>
  );
}
