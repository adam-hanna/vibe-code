/**
 * Whether the status bar draws the run's controls, or only its state (#264).
 *
 * **One set of controls on screen at a time.** The run column's footer and the
 * status bar under it each drew live/pause/stop, one directly above the other.
 * The status bar was given them so a held run could be answered *"without
 * finding the column"* - which is right exactly when the footer is not there to
 * answer it, and wrong the rest of the time.
 *
 * The footer answers for the live run only when the column is open **and**
 * showing the live run. It draws `columnRun`, which is the opened run while you
 * are browsing a past one, so in that case the status bar is the only place
 * left to pause or stop the run that is actually going. Hiding the bar's
 * controls whenever the column is open would have removed them there.
 *
 * Pure, because the app has no jsdom and a rule inside a component is a rule
 * nothing tests.
 */
export function statusBarControls(columnOpen: boolean, columnShowsLive: boolean): boolean {
  return !(columnOpen && columnShowsLive);
}
