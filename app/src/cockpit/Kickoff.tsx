/**
 * What the pilot is pointed at, said once (#211, #223, `4a` §1, `4h`).
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
 *
 * ## The field went when the sidebar grew projects (#223)
 *
 * Reported as redundant, and it was: a project **is** a repository, selecting one
 * points the window at it, and adding one opens the native chooser. Two fields
 * setting `repoDir` is the same third-spelling problem #211 warns about one
 * level down — and the one that was left is the one with a list beside it, so
 * the path a person picks is a path they can get back to.
 *
 * What survives is the **sentence**, because the fact it states is not obvious
 * and not visible anywhere else: the pilot is a `claude -p` child spawned in
 * that directory under `--restricted`, so the path is its permission boundary
 * rather than a setting. A person needs to know which repository the thing
 * reading their code can see.
 */
export function Kickoff({ dir }: { dir: string }) {
  return (
    <div className="v-kick">
      <p className="v-kick__note">
        {dir.trim() === '' ? (
          <>
            The pilot runs <strong>inside a repository</strong> and can read only that one, so it
            needs a project before it can say anything. Add one in the sidebar.
          </>
        ) : (
          <>
            The pilot is reading <code className="v-kick__where">{dir}</code> and nothing else.
            Ask for what you want above — when it has enough it proposes the exact command and you
            press it. There is no start button, on purpose.
          </>
        )}
      </p>
    </div>
  );
}
