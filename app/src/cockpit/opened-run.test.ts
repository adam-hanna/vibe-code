import { describe, expect, test } from 'vitest';
import cockpit from './Cockpit.tsx?raw';
import replayHook from './useReplay.ts?raw';
import model from './model.ts?raw';
import settings from './Settings.tsx?raw';
import footer from './Footer.tsx?raw';
import column from './LoopColumn.tsx?raw';
import pilot from '../pilot/PilotPane.tsx?raw';
import saved from '../pilot/saved.ts?raw';
import hosts from './hosts.ts?raw';
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
    // A draft not yet started takes an empty run first (#294); the rest of the
    // expression is unchanged.
    expect(cockpit).toMatch(/const columnRun = draftHasNoRun\(drafting\) \? blank : past && opened\.run !== null \? opened\.run : run;/);
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
    // it. Since #246 the pid is the live run's own host, not the service host
    // the window connected to, and it is still withheld from a past run. Case 2
    // (#246): the pid is the entry's for the run on screen.
    expect(cockpit).toMatch(/hostPid=\{past \? null : \(shownLive\?\.pid \?\? null\)\}/);
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

  test('an opened run that has loaded does not say it is still reading (#236)', () => {
    // A static `reading` badge sat over every opened run for as long as it was
    // open, so a run that had loaded completely still looked as if it was
    // loading. The only `reading` left is the line drawn while the replay is in
    // flight.
    expect(cockpit).not.toContain('<Badge>reading</Badge>');
    expect(cockpit).toMatch(
      /\{opened\.loading && opened\.run === null && \(\s*<p[^>]*>Reading this run…<\/p>/,
    );
  });

  test('the way back from an opened run is in the column’s title row', () => {
    // It is the only way back when a live run exists, so it has to survive the
    // box it used to sit in — and it sits between the column's name and the
    // control that hides the column, not under the column's contents.
    const head = cockpit.slice(
      cockpit.indexOf('>Run status</span>'),
      cockpit.indexOf('aria-label="Hide run status"'),
    );
    expect(head).toContain('back to the live run');
    expect(head).toContain('past && viewing !== null');
    expect(cockpit.match(/back to the live run/g)?.length).toBe(1);
  });

  test('the pilot\'s log is told which run its conversation is about (#247)', () => {
    // The pane takes the live run for its tools and a separate run for its
    // log's round cards, decided once by `chatRun` beside `pilotRunId`. Handing
    // the log the live run is what put its cards in every chat.
    const pane = cockpit.slice(cockpit.indexOf('<PilotPane'), cockpit.indexOf('onEffect={onEffect}'));
    expect(pane).toContain('logRun={pilotLogRun}');
    expect(cockpit).toMatch(/const pilotLogRun = chatRun\(\{\s*runId: pilotRunId,/);
    expect(pilot).toContain('logOf(logRun, conversation.replies)');
    expect(pilot).not.toContain('logOf(run, conversation.replies)');
  });

  test('a failed replay leaves the live run drawn rather than an empty column', () => {
    // `columnRun` falls back to `run`, so the column never goes blank — and the
    // failure is said beside it rather than in place of everything.
    expect(cockpit).toMatch(/past && opened\.run !== null \? opened\.run : run/);
  });

  test('the Code tab diffs the opened run, in its own repository', () => {
    // *"in a run that produced code changes, when I go to the code tab, it
    // still says 'No base yet'"*. The pane was handed the LIVE run, whose base
    // is null when nothing is running, while every other pane followed the
    // opened one. The replay carries the opened run's base and each commit's
    // range, so the pane takes that run and diffs where its commits are.
    expect(cockpit).toMatch(/<CodePane run=\{opened\.run\} dir=\{shownDir\}/);
    expect(cockpit).toMatch(/!past \? \(\s*<CodePane run=\{run\} dir=\{liveRepo\}/);
    // And it never draws the live run's shas against the opened run's
    // repository while the replay is still being read.
    expect(cockpit).not.toMatch(/<CodePane run=\{columnRun\}/);
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
    expect(chatMove({ from: A, to: B, intoRun: true, opened: false, stored: false, holding: true })).toBe('adopt');
  });


  test('OPENING a run never adopts, however empty that run is', () => {
    // **The defect the `opened` clause is for** (#223). Every other argument
    // here is identical to the adopt case above - a run, nothing stored, a
    // conversation on screen - because from `chatMove`'s side the two acts are
    // indistinguishable without being told. One is a run this window launched,
    // which the conversation proposed; the other is a row somebody clicked.
    //
    // Adoption on the second one meant browsing the archive left the same chat
    // on screen whichever run was open, AND wrote it into that run's key on the
    // way past - so a read silently created a record. Reported as *"changing
    // runs doesn't change the pilot chat"*.
    expect(chatMove({ from: A, to: B, intoRun: true, opened: true, stored: false, holding: true })).toBe(
      'restore',
    );
  });

  test('opening a run that HAS a conversation restores it, as it always did', () => {
    // Unchanged by the clause, and worth pinning separately: the case that was
    // already right must not be fixed into a different answer.
    expect(chatMove({ from: A, to: B, intoRun: true, opened: true, stored: true, holding: true })).toBe(
      'restore',
    );
  });

  test('the project bucket is still adopted, which is the case that already worked', () => {
    expect(chatMove({ from: bucket, to: B, intoRun: true, opened: false, stored: false, holding: true })).toBe(
      'adopt',
    );
  });

  test('a RESUME restores rather than adopting over a real conversation', () => {
    // The guard the widening needs. That run has its own exchange and it is the
    // one worth keeping — adopting over it would destroy a real conversation to
    // save a stray one, which is strictly worse than the bug this fixes.
    expect(chatMove({ from: A, to: B, intoRun: true, opened: false, stored: true, holding: true })).toBe('restore');
  });

  test('an empty screen adopts nothing, so a run does not inherit a blank', () => {
    expect(chatMove({ from: A, to: B, intoRun: true, opened: false, stored: false, holding: false })).toBe(
      'restore',
    );
  });

  test('going back to the project bucket restores it, never adopts into it', () => {
    // `intoRun` is false, and it has to be: the bucket is where a conversation
    // waits for a run, not a run of its own.
    expect(chatMove({ from: A, to: bucket, intoRun: false, opened: false, stored: true, holding: true })).toBe(
      'restore',
    );
  });

  test('the first load of the window restores and cannot adopt', () => {
    // `from` is null because this window has shown nothing yet, so there is no
    // exchange that could have proposed anything.
    expect(chatMove({ from: null, to: B, intoRun: true, opened: false, stored: false, holding: true })).toBe(
      'restore',
    );
  });

  test('a key that has not moved does nothing at all', () => {
    // The loader must not run mid-conversation: a restore at that moment is a
    // conversation replaced by itself-from-disk, losing the turn in flight.
    expect(chatMove({ from: B, to: B, intoRun: true, opened: false, stored: true, holding: true })).toBe('stay');
  });

  test('only the project bucket is cleared after an adoption', () => {
    // Taking a *run's* key away would delete a real conversation to tidy up
    // after a move.
    // Through `putChat` since the store moved to the host's files (#223), and
    // decided in `cleanupWrites` since the cockpit became the one adopter (#246,
    // case 2: the rule moved, verbatim, out of the pane).
    expect(saved).toMatch(/if \(source === bucket\) return \[\{ key: bucket, value: null \}\];/);
    expect(hosts).toMatch(/cleanupWrites\(source, chatKey\(ref\.dir, null\), readChat\(from\)\)/);
  });

  test('the decision is pure, so it is this file that checks it', () => {
    // The app has no jsdom, so a rule living inside an effect is a rule nothing
    // tests — which is how the narrow adoption survived being written down.
    // Case 2 (#246): the call moved from the pane to `adoptionPlan`, which is
    // pure too, and the pane no longer adopts at all.
    expect(hosts).toMatch(/const move = chatMove\(\{/);
    expect(pilot).not.toMatch(/chatMove\(/);
  });

  test('a run with no stored conversation says so, rather than "nothing yet"', () => {
    // Two different emptinesses drawn as one. Beside a run, *"nothing yet"*
    // reads as the pane having failed to load something — which is exactly how
    // it was reported.
    expect(pilot).toMatch(/There is no saved chat here/);
    expect(pilot).toMatch(/runId === null \? \(/);
  });
});

describe('a model is picked from the list its CLI gave, and typed past it', () => {
  // Case 2 (#223): these pinned `known={frame.models[...]}` - a list the core
  // shipped as `KNOWN_MODELS`. The list is now asked of each CLI, so the
  // source moved; every rule these cases guarded still holds and is pinned
  // where it now lives. Keeping an unlisted value is `optionsFor`'s job and is
  // tested in `models.test.ts`.
  test('the cell is a select, fed by what the CLI said rather than by this build', () => {
    expect(settings).toMatch(/<ModelField/);
    expect(settings).toMatch(/listing=\{current\.provider === 'claude' \|\| current\.provider === 'codex' \? models\[current\.provider\] : null\}/);
    expect(settings).toMatch(/optionsFor\(listing, current\)/);
  });

  test('there is always a way to type one, and it is not the empty option', () => {
    // Empty already means *take the agent's default*; `other…` means *let me
    // type one*. Collapsing them would make clearing the box look like asking
    // to type, and the two are opposite intentions.
    expect(settings).toMatch(/const OTHER = ' other'/);
    expect(settings).toMatch(/<option value=\{OTHER\}>other/);
    expect(settings).toMatch(/<option value="">\{empty\}<\/option>/);
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
    // Case 2 (the UI rework): the unit's class is a named style now; the claim
    // that the field is typed in minutes is unchanged.
    expect(settings).toMatch(/<span className=\{S\.unit\}>minutes<\/span>/);
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
    //
    // Through `source` since the global layer (#223): there are three answers now
    // — the default, the person's setting for all projects, this project's — and
    // one helper gives all of them, so no row can draw the old two-way chip.
    expect(settings).toContain("{source('progress', 'maxQuietMs')}");
    const helper = settings.slice(settings.indexOf('const source = ('));
    // Case 2 (the UI rework): the chip is a Badge now; the claim that an unset
    // value is marked as the default is unchanged.
    expect(helper).toContain('<Badge>{unset}</Badge>');
    // Case 2 (owner's decision): the "all projects" and "this project overrides
    // it" chips were asked to go. A value set in either file draws no chip, so
    // only the default is ever marked.
    const body = helper.slice(0, helper.indexOf('\n  };'));
    expect(body).not.toContain('<Badge>all projects');
    expect(body).not.toContain('<Badge>this project overrides it');
    expect(body.match(/<Badge>/g)).toHaveLength(1);
  });

  test('a refusal stays on screen wherever the page is scrolled', () => {
    // *"I can't seem to change my implementer from claude to codex. No error
    // appears."* The core refused it - a writing Codex seat with
    // `codex.persistSession` on - and the sentence was drawn at the top of a
    // page scrolled to the role table. The core no longer refuses that table,
    // and any refusal now stays in view.
    expect(settings).toMatch(/cn\(S\.refused, 'sticky top-0/);
    // The key that refusal named has no control any more, because the core no
    // longer needs it: a Codex writer is one-shot by itself (\`SLOTS.write\`).
    expect(settings).not.toContain('persistSession');
  });

  test('changing a seat’s agent does not carry the old agent’s model onto it', () => {
    // Spreading the row carried `opus` onto a Codex seat: valid to the core,
    // since a model is any non-empty string, and a failure on the first turn.
    expect(settings).toContain('save({ roles: { [role]: { ...current, provider, model: own ?? CLI_DEFAULT } } });');
    // And "the agent's default" is sent as what it means, never as the empty
    // string `validateRoleSetting` refuses by name.
    expect(settings).toContain("const model = next === '' ? (agentModel ?? CLI_DEFAULT) : next;");
  });
});

describe('a resumed run keeps the column it already had', () => {
  test('the column is seeded from the run’s own narration', () => {
    // **The report:** *"the previous plan, critique, code, etc rounds don't show
    // up on the right bar. I want it to look as I just left it when I stopped
    // the run."* `reduce` builds a `Run` from the frames THIS process narrates,
    // and a resume narrates only what happens from the resume onwards — so a run
    // three plan rounds deep came back showing one.
    // Followed by the instant the open turn is closed at (#302).
    expect(cockpit).toMatch(/seed = forResume\(foldReplay\(got\.steps\), /);
    // Case 2 (#246): the seed is handed to `launch`, which makes it the new
    // run's own `Run`, rather than dispatched into the one reducer.
    expect(cockpit).toMatch(/launch\(argv, null, seed, task\);/);
    expect(cockpit).toMatch(/run: \{ \.\.\.\(seed \?\? emptyRun\(\)\), protocol: protocolRef\.current \}/);
  });

  test('the seed carries no ending, because a resume has not ended', () => {
    // **What happened without it:** the replay folds `run_escalated` like every
    // other line, so seeding put the PREVIOUS stop's reason on a run that was
    // starting — and the footer drew exactly what it was given, `ENDING — the
    // run is stopping`, quoting an hour-old stop where the pause and stop
    // controls belong.
    const strip = model.slice(model.indexOf('export function forResume'));
    for (const field of ['reason: null', 'ended: null', 'completed: null', 'running: null']) {
      expect(strip).toContain(field);
    }
  });

  test('the seed is the new run’s column from the start, so nothing can reset it', () => {
    // **Case 2 (#246).** This pinned that the seed was dispatched AFTER
    // `launch`, because `launch` opened with a reset of the one reducer and a
    // seed sent first was thrown away. There is no shared reducer to reset now:
    // each run is its own entry, created by `launch` with the seed as its `Run`,
    // before the invoke is sent - so no live frame can arrive ahead of it and
    // no reset can erase it. What the old pin guarded still holds, by
    // construction rather than by order.
    const body = cockpit.slice(cockpit.indexOf('const continueRun = useCallback'));
    // The fold's call gained the instant the open turn is closed at (#302), so
    // the anchor is the call's head rather than its whole argument list.
    const fold = body.indexOf('seed = forResume(foldReplay(got.steps), ');
    const launched = body.indexOf('launch(argv, null, seed, task);');
    expect(fold).toBeGreaterThan(-1);
    expect(launched).toBeGreaterThan(fold);
    expect(cockpit).not.toMatch(/type: 'reset'/);
  });

  test('a resume does NOT seed the ending, because the run has not ended', () => {
    // `useReplay` applies the `result` because a run you opened has ended and
    // must say so. Seeding `completed` here would draw a halt banner over a run
    // that is starting.
    const body = cockpit.slice(cockpit.indexOf('const continueRun = useCallback'));
    const upToLaunch = body.slice(0, body.indexOf('[launch],'));
    expect(upToLaunch).not.toMatch(/type: 'result'/);
  });

  test('a replay that fails still resumes the run', () => {
    // Losing the history must never cost somebody the resume — an empty column
    // is what every resume had until now, not a new failure worth a banner.
    const body = cockpit.slice(cockpit.indexOf('const continueRun = useCallback'));
    expect(body).toMatch(/\.catch\(\(\) => \{/);
    expect(body).toMatch(/\.finally\(\(\) => \{[\s\S]*?launch\(argv, null, seed, task\);/);
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

  test('implement continues in the repository too, and is seeded like a resume', () => {
    // The same mistake one button along (#246): implement passed `identity.dir`
    // as `-C`. Both carry-ons go through one `continueRun`, so the seed is the
    // same fold and the argv names the repository.
    expect(footer).toMatch(/onImplement\(at\.runId, at\.repo\)/);
    expect(footer).not.toMatch(/onImplement\(run\.identity\.runId, run\.identity\.dir\)/);
    expect(footer).toMatch(/run\.plannedOnly !== null && run\.identity !== null && run\.identity\.repo == null/);
    expect(cockpit).toMatch(/continueRun\(implementArgv\(runId, dir\), runId, dir, task\)/);
  });
});

describe('every round shows what ran in it', () => {
  test('an answerer turn is drawn even when its round has no questions block', () => {
    // **The defect.** Answerer turns were rendered ONLY inside the questions
    // block, and `Run.questions` holds one round at a time — so the moment a
    // second question round opened, the first round's answerer turn stopped
    // being drawn anywhere. A run with three question rounds showed one and
    // silently dropped two: *"only plan round 2 has full details... they all
    // should."*
    //
    // It is a turn — something that ran and was paid for — so nothing about
    // which round's questions happen to be on screen may decide whether it
    // appears, and it is a loss on a live run as much as on a replayed one.
    expect(column).toMatch(/questions === null &&\s*answerers\.map/);
  });

  test('the empty-phase line only shows when the phase really ran nothing', () => {
    // It counted `turns` alone, so a round holding only an answerer turn drew
    // BOTH the turn and "announced by the phase, with no turn line of its own".
    expect(column).toMatch(/turns\.length === 0 &&\s*answerers\.length === 0 &&/);
  });
});

describe('the pilot reads the repository on screen, not the one in the sidebar (#223)', () => {
  test('the pane is handed shownDir, like every other pane that reads a run', () => {
    // `shownDir` is the one expression deciding which repository is on screen -
    // `viewing?.dir ?? run.identity?.repo ?? repoDir` - and the six readers were
    // moved onto it when the live run and the opened run came apart. The pilot
    // was left on `repoDir`, which is where the SIDEBAR is pointed.
    //
    // It matters more here than on a reader. `dir` is the pilot's permission
    // boundary: the directory `claude -p --restricted` is spawned in and the
    // only one it may read, and where an accepted `run_command` runs. So the
    // pane could be reading one repository while the tabs beside it read
    // another, and with no project selected it refused to send at all -
    // reported as *"I just tried sending a chat to an old run's pilot but I
    // can't"*.
    const pane = cockpit.slice(cockpit.indexOf('<PilotPane'), cockpit.indexOf('onEffect={onEffect}'));
    // Through `pilotDir` since #223, which IS `shownDir` except for the seconds
    // a launch waits for its run id, when it holds the directory of the chat
    // that proposed the run (see `holdChat`).
    expect(pane).toContain('dir={pilotDir}');
    expect(cockpit).toContain('const pilotDir = holdChat?.dir ?? shownDir;');
    expect(pane).not.toContain('dir={repoDir}');
  });

  test('the launch bar keeps the window’s own directory, because a NEW run starts there', () => {
    // Not an oversight and not the same question. `Kickoff` is about the run
    // that does not exist yet, and `launch` sends `repoDir` - so pointing the
    // bar at an opened run's repository would make the two disagree about where
    // a run starts, which is a worse bug than the one above.
    expect(cockpit).toContain('<Kickoff dir={repoDir} />');
  });
});
