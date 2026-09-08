import { useEffect, useState } from 'react';
import { Button, MetaChip, StateKicker } from '../design';
import { launchArgv } from './argv';
import { pickDirectory } from './pick';

/**
 * The front door (#211, `4a` §1, `4h`).
 *
 * The complaint this answers came from a manual pass and is exact: *"I thought
 * my initial prompt would be given to the pilot and the pilot would take
 * control."* The app did not meet it — the front door was a form and the pilot
 * was a tab beside the output pane.
 *
 * So the **composer is the front door**: what you type goes to the pilot, and
 * this is what sits around that conversation while no run exists. `4a` says the
 * same thing in the design's own words — the brief textarea *"is the user's
 * opening message to the pilot, not a brief for the planner"*.
 *
 * ## What is here, and why each piece is
 *
 * - **The repository**, because the pilot reads it. #193's subscription pilot is
 *   given `--restricted`, which confines the file tools to the working
 *   directory, so *which* directory is the difference between a pilot that can
 *   answer "what is this doing" and one that cannot.
 * - **The launch bar**, prefilled with the first thing you said and editable
 *   afterwards. That is `4h`'s brief card without the part this build cannot
 *   honestly do — see below.
 *
 * ## The pilot does not fire it, and on the subscription it cannot propose it
 *
 * **Propose only** is decision 1 of the five #144 asks for and it stands: the
 * thing that starts a run is a proposal a person accepts. On the API-backed
 * pilot that proposal is a real `start_run` tool call, drawn as a card with its
 * exact argv.
 *
 * On the **subscription** pilot there is no tool call at all, and that is not an
 * oversight — tool declaration is a vendor-API feature and `claude -p` takes no
 * schemas from us, which #193 recorded when it landed. So on the default backend
 * the conversation shapes the brief and **this bar is where a person commits
 * it**. That is the honest shape rather than a worse one: the alternative was
 * parsing a marker out of the model's prose to synthesise a proposal, which is
 * the English-matching #133 exists to prevent, applied to the one action that
 * spends money.
 *
 * `4h`'s automatic brief card — the pilot deciding it has heard enough and
 * emitting a tightened brief — is therefore **not built**, and the bar says so
 * rather than leaving somebody waiting for a card that is not coming.
 */
export function Kickoff({
  dir,
  onDir,
  opening,
  onLaunch,
  busy,
}: {
  dir: string;
  onDir: (dir: string) => void;
  /**
   * The first thing said to the pilot, or null.
   *
   * Prefills the brief once and then leaves it alone — an editable field that
   * kept being overwritten by the conversation would throw away what a person
   * typed into it, which is the one thing a brief field must never do.
   */
  opening: string | null;
  onLaunch: (argv: readonly string[]) => void;
  busy: boolean;
}) {
  const [brief, setBrief] = useState('');
  const [touched, setTouched] = useState(false);
  const [planOnly, setPlanOnly] = useState(true);
  const [open, setOpen] = useState(false);
  const [pickFailed, setPickFailed] = useState<string | null>(null);

  // Once, and only while the person has not typed here themselves.
  useEffect(() => {
    if (!touched && opening !== null && brief === '') setBrief(opening);
  }, [opening, touched, brief]);

  const ready = brief.trim() !== '' && dir.trim() !== '';
  const argv = launchArgv(brief, dir, planOnly);

  const choose = () => {
    void pickDirectory()
      .then((chosen) => {
        setPickFailed(null);
        if (chosen !== null) onDir(chosen);
      })
      .catch((err: unknown) => setPickFailed(err instanceof Error ? err.message : String(err)));
  };

  return (
    <div className="v-kick">
      <div className="v-kick__repo">
        <label className="v-kick__label" htmlFor="kickdir">
          repository
        </label>
        <input
          id="kickdir"
          className="v-kick__dir"
          value={dir}
          placeholder="an absolute path to a git worktree — the pilot reads this one and no other"
          onChange={(e) => onDir(e.target.value)}
        />
        <Button type="button" onClick={choose} disabled={busy}>
          choose…
        </Button>
      </div>
      {pickFailed !== null && (
        <p className="v-kick__note">the chooser did not open: {pickFailed} — type or paste</p>
      )}
      {dir.trim() === '' && (
        <p className="v-kick__note">
          Until this is set the pilot has no repository to read, so it can talk about your idea but
          not about your code — and there is nowhere to start a run.
        </p>
      )}

      <details className="v-kick__start" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary>
          <StateKicker tone="accent">start a run</StateKicker>
          <span className="v-kick__summary">
            when you have talked it through — or straight away, if you already know
          </span>
        </summary>

        <label className="v-kick__label" htmlFor="kickbrief">
          the brief the planner is given
        </label>
        <textarea
          id="kickbrief"
          className="v-kick__brief"
          rows={5}
          value={brief}
          placeholder="what the run should do — state the decisions already made and say not to re-derive them"
          onChange={(e) => {
            setTouched(true);
            setBrief(e.target.value);
          }}
        />
        {/* Said out loud, because the difference is the whole point of the
            screen: the conversation is not the brief. Nothing the pilot says
            reaches the planner unless it is in this box. */}
        <p className="v-kick__note">
          {opening === null
            ? 'This is what the planner receives. The conversation above is yours, not its.'
            : 'Prefilled with your first message. The conversation above is yours — only what is in this box reaches the planner, so paste anything the pilot tightened.'}
        </p>

        <label className="v-kick__toggle">
          <input
            type="checkbox"
            checked={planOnly}
            onChange={(e) => setPlanOnly(e.target.checked)}
          />
          <span>
            plan only — stop after the plan clears critique.{' '}
            <strong>Leave this on until you mean it:</strong> the other path writes code and
            commits.
          </span>
        </label>

        {ready && <pre className="v-kick__argv">vibe {argv.join(' ')}</pre>}

        <div className="v-kick__foot">
          <Button
            level="primary"
            type="button"
            disabled={!ready || busy}
            onClick={() => onLaunch(argv)}
          >
            {planOnly ? 'start planning' : 'start the run'}
          </Button>
          <MetaChip>the pilot never fires this</MetaChip>
        </div>
      </details>
    </div>
  );
}
