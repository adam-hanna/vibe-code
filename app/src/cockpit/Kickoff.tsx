import { useState } from 'react';
import { Button } from '../design';
import { pickDirectory } from './pick';

/**
 * The front door (#211, `4a` §1, `4h`).
 *
 * The complaint this answers came from a manual pass and is exact: *"I thought
 * my initial prompt would be given to the pilot and the pilot would take
 * control."* The first attempt moved the conversation to the front and left a
 * launch bar under it, and the second report was as exact as the first: *"I
 * shouldn't have a button to start a run — the pilot should control that."*
 *
 * It was right, and the bar is gone. **The only thing here now is the
 * repository**, because that is the one fact the conversation cannot supply
 * about itself: the subscription pilot is a `claude -p` child spawned *in* that
 * directory under `--restricted`, so the path is its permission boundary rather
 * than a field on a form. Everything else — the brief, plan-only, the flags —
 * comes out of the conversation and arrives as a proposal card with the exact
 * argv on it.
 *
 * ## What made deleting the bar possible
 *
 * Not a decision to hide it. The subscription backend genuinely could not
 * propose anything when this pane was built — tool declaration is a vendor-API
 * feature and `claude -p` takes no schemas — so on the default backend the bar
 * was the only way to start a run and removing it would have shipped a front
 * door that does not open. `emit.ts` is what changed: the table goes into the
 * system prompt and a call comes back in a fenced block, through the same
 * `execute` and onto the same proposal card the API-backed pilot produces.
 *
 * **Propose only still stands**, and it is why this is not a loss of control.
 * The thing that starts a run is a card showing the exact argv, and a person
 * presses it. What is gone is the *second* way to build that argv, which is the
 * third spelling #211 warns about — `launchArgv` is now reached from one place
 * in this window and one place in the pilot's table, and they are the same
 * function.
 *
 * `4h`'s automatic brief card — the pilot deciding it has heard enough — is what
 * this now is, with the difference that the pilot has to *say so* by making a
 * call rather than by us reading its prose for intent.
 */
export function Kickoff({
  dir,
  onDir,
  busy,
}: {
  dir: string;
  onDir: (dir: string) => void;
  busy: boolean;
}) {
  const [pickFailed, setPickFailed] = useState<string | null>(null);

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
      <p className="v-kick__note">
        {dir.trim() === ''
          ? 'The pilot runs in this directory and can read only this one, so it needs one before it can say anything. Nothing here starts a run — ask for one in the conversation and it will propose the command.'
          : 'Ask for what you want above. When the pilot has enough, it proposes the exact command and you press it — there is no start button, on purpose.'}
      </p>
    </div>
  );
}
