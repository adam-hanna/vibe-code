import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

/**
 * The last thing between a thrown render and an inert window (#211).
 *
 * There was no error boundary anywhere in this app. A throw during render
 * therefore reached the root, and React unmounts the whole tree when that
 * happens — so a single bad frame, a field a build did not expect, or one
 * `undefined` read a level too deep took the entire window with it. Everything
 * still on screen at that moment stops responding, including the conversation,
 * which is the report this exists to answer.
 *
 * **It is deliberately not a retry.** Re-rendering the tree that just threw
 * re-runs the same reducer over the same frames and throws again, so a
 * `try again` button would be a loop with a button on it. The way out is a
 * reload, which re-opens the wire and starts from an empty run — the run itself
 * is on disk and in the host, neither of which this window owns.
 *
 * **Nothing here goes to the app log**, and that is the standing rule rather
 * than an omission: `applog` takes nothing from the webview, because a pilot
 * conversation passes through it and a vendor's error can quote the API key it
 * was sent. So the failure is put on screen, monospace and selectable, in the
 * same shape the diagnostics popover uses — these are strings destined for a bug
 * report.
 */
/*
 * Utilities since #237, from the old `.v-crash` rules. Several of those named
 * tokens that do not exist - `--surface-app`, `--text-alarm`, `--surface-inset`,
 * `--surface-control`, `--type-control` - and a `var()` naming nothing leaves the
 * property at its inherited or initial value, so those declarations drew
 * nothing. They are left out here rather than replaced with a token somebody
 * chose today: this screen has never had a ground of its own, and the sweep is
 * not the change that should give it one.
 */
const KICKER = 'uppercase tracking-kicker [font:var(--type-kicker)]';
const LABEL = 'mt-(--space-3) uppercase tracking-kicker text-tertiary [font:var(--type-kicker)]';
const PRE =
  'm-0 overflow-x-auto whitespace-pre-wrap border border-rule-inner p-(--space-3) text-primary [font:var(--type-mono-sm)]';

interface State {
  error: Error | null;
  stack: string | null;
}

export class Boundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null, stack: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // The component stack is the half that says *where*, and it arrives here
    // rather than in `getDerivedStateFromError`. Kept separately because the
    // two are separately absent: a minified build may have one and not the
    // other, and a missing one must not blank the one that survived.
    this.setState({ error, stack: info.componentStack ?? null });
  }

  override render(): ReactNode {
    const { error, stack } = this.state;
    if (error === null) return this.props.children;

    return (
      <div className="flex h-screen select-text flex-col gap-(--space-3) overflow-y-auto p-(--space-6)">
        <div className="flex flex-col gap-(--space-2)">
          <span className={KICKER}>the window stopped</span>
          <span className="max-w-[76ch] text-emphasis [font:var(--type-body)]">
            Something in this window threw while drawing. The run is not affected — it lives in the
            host process and on disk, and reloading re-attaches to it.
          </span>
        </div>

        <button
          className="cursor-pointer self-start border border-rule-control px-(--space-4) py-(--space-2) text-emphasis"
          onClick={() => window.location.reload()}
        >
          Reload the window
        </button>

        <div className={LABEL}>what threw</div>
        <pre className={PRE}>{error.message}</pre>

        {error.stack !== undefined && (
          <>
            <div className={LABEL}>stack</div>
            <pre className={PRE}>{error.stack}</pre>
          </>
        )}

        {stack !== null && (
          <>
            <div className={LABEL}>components</div>
            <pre className={PRE}>{stack}</pre>
          </>
        )}

        <p className="m-0 max-w-[76ch] text-tertiary [font:var(--type-body-sm)]">
          Nothing on this screen is written to vibe-desktop.log — the webview never writes to it,
          because a pilot conversation passes through this window and a vendor error can quote the
          key it was sent. Copy what you need from here.
        </p>
      </div>
    );
  }
}
