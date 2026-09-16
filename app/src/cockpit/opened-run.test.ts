import { describe, expect, test } from 'vitest';
import cockpit from './Cockpit.tsx?raw';
import replayHook from './useReplay.ts?raw';
import model from './model.ts?raw';
import settings from './Settings.tsx?raw';
import footer from './Footer.tsx?raw';
import pilot from '../pilot/PilotPane.tsx?raw';
import { chatKey, chatMove } from '../pilot/saved';
import { recorded } from './format';

/**
 * Opening a run, and what follows it (#223).
 *
 * Two reports in one line: *"when I click on an existing run, I don't see the
 * right nav update, nor do I see the pilot chat update."* They are separate
 * defects with one shape — the window is pointed at a run and something on
 * screen is still about a different one.
 */

describe('an opened run is drawn by the column that drew it live', () => {
  test('the column takes a Run, and the replayed one is the same type', () => {
    // **The correction to the first attempt.** That one built a *summary* — a
    // second screen from a second shape — and the report was exact: *"I want the
    // right panel to look just as it would have when I click on an old run as if
    // I had run it myself."* So there is one `LoopColumn`, taking one `Run`, and
    // which run it is is decided in one expression.
    expect(cockpit).toMatch(/const columnRun = past && opened\.run !== null \? opened\.run : run;/);
    expect(cockpit).toMatch(/<LoopColumn\s+run=\{columnRun\}/);
    // And there is no second column component to drift from the first.
    expect(cockpit).not.toMatch(/RecordColumn/);
  });

  test('the footer and the summary are about the same run as the column', () => {
    // A footer about the live run beside a column about an opened one is the
    // two-runs-at-once confusion this set out to end.
    expect(cockpit).toMatch(/<Footer\s+run=\{columnRun\}/);
    expect(cockpit).toMatch(/columnRun\.completed\?\.exit === 0 && <Summary run=\{columnRun\} \/>/);
  });

  test('a replayed run is folded through the SAME reducer', () => {
    // No second builder, so nothing can disagree with the first. This is what
    // makes "as if I had run it myself" true by construction rather than by
    // resemblance. The fold moved into `model.ts` when the resume began seeding
    // its column from the same steps: that is the only file in the app with
    // logic, and one fold serving both callers is what stops "what did this run
    // look like" having two answers.
    expect(model).toMatch(/reduce\(built, \{ type: 'narration', \.\.\.step\.narration \}, step\.at\)/);
    expect(replayHook).toMatch(/foldReplay\(got\.steps\)/);
  });

  test('each step is folded at its own time, never at arrival', () => {
    // A replay stamped with `Date.now()` would date a week-old run to this
    // afternoon and give every turn a duration of nothing.
    expect(model).toMatch(/foldReplay/);
    const fold = model.slice(model.indexOf('export function foldReplay'));
    expect(fold).not.toMatch(/Date\.now\(\)/);
    expect(fold).toMatch(/step\.at/);
  });

  test('the ending is applied as the frame it is', () => {
    // A `result` closes whatever turn was open and sets `completed`, which is
    // what makes the footer draw this run's ending — and it is why nothing is
    // left running when the fold finishes.
    expect(replayHook).toMatch(/type: 'result', id: 0, exit: got\.exit/);
    expect(replayHook).toMatch(/got\.exit !== null/);
  });

  test('the live host’s pid is withheld from a run this process is not running', () => {
    // A pid beside a finished run names a process that has nothing to do with
    // it.
    expect(cockpit).toMatch(/hostPid=\{past \? null : wire\.hostPid\}/);
  });

  test('the strip says the one thing an archive cannot say, once', () => {
    // `state.turnStartedAt` describes the turn in flight, so the only starts an
    // archive keeps are the ones a checkpoint froze. Said here rather than as a
    // blank on every turn row — and a duration invented from the gap between two
    // charges would include every gate the loop held at.
    expect(cockpit).toMatch(/Some turns have no duration/);
  });

  test('a refusal is shown in the core’s own words', () => {
    // A run whose id will not join onto a path, a directory vibe refuses to
    // follow (#53) and a `state.json` the validators reject are three findings
    // needing three responses, and *"could not read the run"* answers none.
    expect(cockpit).toMatch(/\{opened\.failure\}/);
  });

  test('a failed replay leaves the live run drawn rather than an empty column', () => {
    // `columnRun` falls back to `run`, so the column never goes blank — and the
    // failure is said beside it rather than in place of everything.
    expect(cockpit).toMatch(/past && opened\.run !== null \? opened\.run : run/);
  });

  test('an absolute stamp carries the day, not just the time', () => {
    // `clock` renders a moment inside the run you are watching, where the date
    // is today by construction. A record may be a week old, and `15:33` with no
    // day attached reads as this afternoon every time.
    const stamp = recorded('2026-01-05T15:33:00.000Z');
    expect(stamp).not.toBe('not recorded');
    expect(stamp.length).toBeGreaterThan('15:33'.length);
  });

  test('a timestamp another process wrote badly is said to be unrecorded', () => {
    // `Invalid Date` where a measurement goes reads as something somebody took.
    for (const bad of [null, '', 'the other day', '2026-13-45']) {
      expect(recorded(bad)).toBe('not recorded');
    }
  });
});

describe('a conversation belongs to the run it is about', () => {
  const dir = 'C:/repo';
  const A = chatKey(dir, 'run-a');
  const B = chatKey(dir, 'run-b');
  const bucket = chatKey(dir, null);

  test('a brief typed while a past run was open is adopted by the run it proposes', () => {
    // **The defect.** Adoption used to be allowed only out of the project
    // bucket, which is right about where a pre-run conversation lives and wrong
    // about where one can be typed: open run A, type the brief for a new run,
    // press the proposal — the exchange stayed under A's key and the run it
    // proposed started life with nothing. Opening that run then showed an empty
    // pane, which is the report one step removed from its cause.
    expect(chatMove({ from: A, to: B, intoRun: true, stored: false, holding: true })).toBe('adopt');
  });

  test('the project bucket is still adopted, which is the case that already worked', () => {
    expect(chatMove({ from: bucket, to: B, intoRun: true, stored: false, holding: true })).toBe(
      'adopt',
    );
  });

  test('a RESUME restores rather than adopting over a real conversation', () => {
    // The guard the widening needs. That run has its own exchange and it is the
    // one worth keeping — adopting over it would destroy a real conversation to
    // save a stray one, which is strictly worse than the bug this fixes.
    expect(chatMove({ from: A, to: B, intoRun: true, stored: true, holding: true })).toBe('restore');
  });

  test('an empty screen adopts nothing, so a run does not inherit a blank', () => {
    expect(chatMove({ from: A, to: B, intoRun: true, stored: false, holding: false })).toBe(
      'restore',
    );
  });

  test('going back to the project bucket restores it, never adopts into it', () => {
    // `intoRun` is false, and it has to be: the bucket is where a conversation
    // waits for a run, not a run of its own.
    expect(chatMove({ from: A, to: bucket, intoRun: false, stored: true, holding: true })).toBe(
      'restore',
    );
  });

  test('the first load of the window restores and cannot adopt', () => {
    // `from` is null because this window has shown nothing yet, so there is no
    // exchange that could have proposed anything.
    expect(chatMove({ from: null, to: B, intoRun: true, stored: false, holding: true })).toBe(
      'restore',
    );
  });

  test('a key that has not moved does nothing at all', () => {
    // The loader must not run mid-conversation: a restore at that moment is a
    // conversation replaced by itself-from-disk, losing the turn in flight.
    expect(chatMove({ from: B, to: B, intoRun: true, stored: true, holding: true })).toBe('stay');
  });

  test('only the project bucket is cleared after an adoption', () => {
    // Taking a *run's* key away would delete a real conversation to tidy up
    // after a move.
    expect(pilot).toMatch(/if \(before === bucket\) localStorage\.removeItem\(bucket\)/);
  });

  test('the decision is pure, so it is this file that checks it', () => {
    // The app has no jsdom, so a rule living inside an effect is a rule nothing
    // tests — which is how the narrow adoption survived being written down.
    expect(pilot).toMatch(/const move = chatMove\(\{/);
  });

  test('a run with no stored conversation says so, rather than "nothing yet"', () => {
    // Two different emptinesses drawn as one. Beside a run, *"nothing yet"*
    // reads as the pane having failed to load something — which is exactly how
    // it was reported.
    expect(pilot).toMatch(/No conversation was kept for this run/);
    expect(pilot).toMatch(/runId === null \? \(/);
  });
});

describe('a model is picked from a list this build ships, and typed past it', () => {
  test('the cell is a select, fed by the core rather than by the window', () => {
    // The list lives beside `DEFAULTS` in the core, for the reason
    // `pilot.MODELS` gives about Rust: a list compiled into the surface that
    // displays it goes stale on somebody else's schedule instead of ours.
    expect(settings).toMatch(/<ModelField/);
    expect(settings).toMatch(/known=\{frame\.models\[current\.provider \?\? ''\] \?\? \[\]\}/);
  });

  test('a configured model this build does not know is still offered', () => {
    // A select that could not represent its own value would rewrite a role's
    // model by rendering — the worst kind of data loss, because nobody pressed
    // anything. It may be a model that shipped after this build.
    expect(settings).toMatch(/!known\.includes\(current\)/);
  });

  test('there is always a way to type one, and it is not the empty option', () => {
    // Empty already means *take the agent's default*; `other…` means *let me
    // type one*. Collapsing them would make clearing the box look like asking
    // to type, and the two are opposite intentions.
    expect(settings).toMatch(/const OTHER = ' other'/);
    expect(settings).toMatch(/<option value=\{OTHER\}>other/);
    expect(settings).toMatch(/<option value="">— \{agent\} default —<\/option>/);
  });

  test('the list is per agent and never borrowed from the other one', () => {
    // A Claude model handed to Codex is a turn that fails after it has been
    // spawned.
    expect(settings).toMatch(/agent=\{current\.provider \?\? 'agent'\}/);
  });
});

describe('a turn that has gone quiet has a ceiling, and it is on the screen', () => {
  test('the silence ceiling is a control, not only a flag', () => {
    // Every other ceiling in this section was reachable only as a CLI flag until
    // it was put here; this one is new and starts here, because the number is a
    // decision somebody has to be able to revisit.
    expect(settings).toMatch(/progress-maxQuietMinutes/);
    expect(settings).toMatch(/save\(\{ progress: \{ maxQuietMs: n \* 60_000 \} \}\)/);
  });

  test('it is typed in minutes and stored in milliseconds', () => {
    // The config is in ms because everything timing-related in it is. A form
    // that made somebody type 600000 to mean ten minutes would be the storage
    // layer's units leaking onto the screen.
    expect(settings).toMatch(/Math\.round\(progress\['maxQuietMs'\] \/ 60_000\)/);
    expect(settings).toMatch(/<span className="v-set__unit">minutes<\/span>/);
  });

  test('it says what it measures, because a long turn is not a quiet turn', () => {
    // The distinction the whole setting rests on: measured from the child's last
    // line, not from how long the turn has been going. An 11m30 implement turn
    // never went more than 32 seconds without speaking.
    expect(settings).toMatch(/no output at all/);
    expect(settings).toMatch(/a long turn is not a quiet turn/);
  });

  test('a value the file does not claim is marked as the default', () => {
    // The same split every other row in this screen draws: what is in force
    // versus what the project actually chose.
    expect(settings).toMatch(/claimedProgress\['maxQuietMs'\] === undefined && <MetaChip>/);
  });
});

describe('a resumed run keeps the column it already had', () => {
  test('the column is seeded from the run’s own narration', () => {
    // **The report:** *"the previous plan, critique, code, etc rounds don't show
    // up on the right bar. I want it to look as I just left it when I stopped
    // the run."* `reduce` builds a `Run` from the frames THIS process narrates,
    // and a resume narrates only what happens from the resume onwards — so a run
    // three plan rounds deep came back showing one.
    expect(cockpit).toMatch(/seed = foldReplay\(got\.steps\)/);
    expect(cockpit).toMatch(/dispatch\(\{ type: 'seed', run: seed \}\)/);
  });

  test('the seed lands AFTER launch, because launch resets the column', () => {
    // **I had this backwards on the first cut, and it was invisible.** `launch`
    // opens with `dispatch({ type: 'reset' })`, so a seed dispatched *before* it
    // was thrown away by the very next action — and the symptom of a discarded
    // seed is an empty column, which is exactly what the bug looked like anyway.
    //
    // Both dispatches land in one batch and the reducer applies them in order:
    // reset, then seed. And it is still before any frame can arrive, because
    // `launch` ends at `void send(...)` and the wire delivers asynchronously —
    // so the seed can neither be erased by the reset nor overwrite something the
    // loop has already said.
    const body = cockpit.slice(cockpit.indexOf('const resume = useCallback'));
    const launched = body.indexOf('launch(argv);');
    const seeded = body.indexOf("dispatch({ type: 'seed'");
    expect(launched).toBeGreaterThan(-1);
    expect(seeded).toBeGreaterThan(launched);
  });

  test('a resume does NOT seed the ending, because the run has not ended', () => {
    // `useReplay` applies the `result` because a run you opened has ended and
    // must say so. Seeding `completed` here would draw a halt banner over a run
    // that is starting.
    const body = cockpit.slice(cockpit.indexOf('const resume = useCallback'));
    const upToLaunch = body.slice(0, body.indexOf('[launch],'));
    expect(upToLaunch).not.toMatch(/type: 'result'/);
  });

  test('a replay that fails still resumes the run', () => {
    // Losing the history must never cost somebody the resume — an empty column
    // is what every resume had until now, not a new failure worth a banner.
    const body = cockpit.slice(cockpit.indexOf('const resume = useCallback'));
    expect(body).toMatch(/\.catch\(\(\) => \{/);
    expect(body).toMatch(/\.finally\(\(\) => \{[\s\S]*?launch\(argv\);/);
  });

  test('one fold serves the opened run and the resumed one', () => {
    // Two copies of that loop would be two answers to "what did this run look
    // like", which is the mistake the replay was built to avoid.
    expect(replayHook).toMatch(/foldReplay\(got\.steps\)/);
    expect(cockpit).toMatch(/foldReplay\(got\.steps\)/);
  });
});

describe('a resume points at the repository, not at the run', () => {
  test('the footer resumes with identity.repo', () => {
    // **The two are both on `run_started` and are not interchangeable.**
    // `identity.dir` is the run's OWN directory — `<repo>/.vibe/runs/<id>` — and
    // `identity.repo` is the repository. Passing `dir` ran the resume with
    // `-C <run dir>`, so the core looked for the run *inside itself* and
    // answered `No run "..." under .vibe\runs` about a run sitting there intact.
    // `repo` was added to the frame for exactly this and this call site was
    // never moved onto it.
    expect(footer).toMatch(/onResume\(at\.runId, at\.repo\)/);
    expect(footer).toMatch(/onResume\(at\.runId, at\.repo, raise\.raise\)/);
    expect(footer).not.toMatch(/onResume\(run\.identity\.runId, run\.identity\.dir/);
  });

  test('a run whose repository is unknown is told, not resumed into a guess', () => {
    // The honest half. `repo` arrived later than the frame did, so a run
    // narrated by an older core has none — and the window cannot invent one.
    expect(footer).toMatch(/RESUMABLE\.has\(exit\) && run\.identity\?\.repo == null/);
    expect(footer).toMatch(/RESUMABLE\.has\(exit\) && run\.identity\?\.repo != null/);
  });

  test('the seed is dispatched AFTER launch, because launch resets', () => {
    // `launch` opens with `dispatch({ type: 'reset' })`, so a seed dispatched
    // before it is thrown away by the very next action — and invisibly, because
    // an empty column is exactly what the bug looked like anyway.
    const body = cockpit.slice(cockpit.indexOf('const resume = useCallback'));
    const launched = body.indexOf('launch(argv);\n          if (seed !== null)');
    expect(launched).toBeGreaterThan(-1);
  });
});
