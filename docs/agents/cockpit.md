# The cockpit

Part of the working notes for this repo; [AGENTS.md](../../AGENTS.md) is the core and links here.
Moved out of AGENTS.md word for word on 2026-10-20, so where a note says *this file* it means
AGENTS.md and these companions together. Read this before changing the code it describes, and
update it in the same PR when that code changes.

**The webview re-derives nothing.** Every card the cockpit draws comes from a frame it was
sent: no phase inferred from a sentence, no default filled in for a field a frame did not
carry, no quantity computed out of two others. `app/src/cockpit/model.ts` is the only file in
the app with logic and it is pure — the reducer is where a cockpit bug would otherwise be
invisible, which is why it has the tests and the components do not.

Two rules the cockpit inherits from the design and must not quietly drop:

- **If you cannot name the denominator, it is not a bar.** The one bar in the cockpit is Claude's
  context, because `promptTokens / contextWindow` is a real number over a known one — and it
  is drawn only when the heartbeat carried the window, since it omits the field rather than
  sending a zero. (The update popover draws a download bar by the same rule: only when the
  response sent a `Content-Length` to divide by, and a byte count otherwise.) `6a` has failed three times by inventing a denominator to make waiting feel
  measured.
- **A missing measurement is drawn as absent with its reason**, never as a blank and never as
  a zero. The two lines of `6a` that had no source named the issue that would supply them
  (#136, #114), so the row completed when they landed instead of being redesigned. The
  comparable-turns line is now a **token** distribution read from the archive; it is drawn
  as absent only until the scorecard has been read.
- **A diagnostic belongs in the chrome only while it is wrong.** `HOST 43804` and
  `PROTOCOL 1` sat permanently in the titlebar and a manual pass reported the obvious: they
  mean nothing to a user (#204). They are not deleted, because each becomes the most important
  thing on screen the moment it disagrees — so hi-fi 15 moves them into a `•••` popover
  (⌘⇧D) and leaves one **alarm** chip in the bar that names the disagreement rather than the
  value: `protocol 1 · expected 2`, never `PROTOCOL 1`. The panel holds four facts, each with
  the sentence that makes it usable, every value monospace with a copy control, because these
  are strings destined for a bug report. **A popover, not a modal — no scrim**, since
  diagnostics are read while looking at what went wrong; it is the only elevated surface in
  the product that does not block.
- **The build stamp is on `Status`, not on a command of its own** (#201). Two builds of one
  version are otherwise identical and single-instance makes that expensive — a fresh build
  launched while an installed copy runs raises the old window and exits, which has cost a test
  cycle here. `build.rs` reads `src-tauri/.build-stamp`, written by `stage:sidecar`, and falls
  back to asking git. The **file** is the mechanism rather than an env var for two reasons:
  `beforeBuildCommand` runs in a child, so nothing it exports reaches cargo; and
  `rerun-if-changed` on it is the accurate trigger, because cargo rebuilds when *Rust* changes
  and the thing that usually changes is the webview, which it cannot see. A tree with no git
  reports **no commit at all** rather than `unknown`. `keys.test.ts` still pins eight
  commands: a new door into this process should be a decision somebody makes on purpose, and
  three of the panel's four facts already arrive on `host_status`, so they cannot disagree
  about which process they describe. `Status` is `rename_all = "camelCase"` and a Rust test
  asserts the window's spelling of `uptimeSecs` — serde's default would arrive as `undefined`
  and render as *"up for an unknown time"* on a host that is up and fine, with nothing going
  red on either side.
- **The wait before the first phase is preflight, and it now says so.** `preflight` spawns a
  probe turn against each agent and narrated nothing while it did, so the seconds after the
  one action a new user knows how to take were seconds with nothing true to draw — reported
  from a manual pass as *"it appeared like nothing happened for a while"*. `preflight_started`
  carries `PROBE_ORDER` so the window draws the whole step before the first child starts,
  `probe_started` fires **before** each probe because the spawn is the wait, and
  `preflight_passed` ends it so the row does not sit mid-probe for the rest of the run (#205).
  There is no bar and no percentage: `2 of 2` is a position in a list the loop named. The
  announcement is a **parameter** on `preflight()` rather than a `log.*` call inside it,
  because `vibe doctor` shares that function and its output is scripted against.
- **Launching is the cockpit with one card in it, not a screen of its own** (hi-fi 16). The
  substitutions are the design: a progress bar becomes **three checkboxes** each carrying its
  own evidence (task reached the core · a timestamp; host alive · a pid; preflight probing · an
  elapsed), a spinner becomes the liveness dot plus that elapsed, a skeleton becomes **dashed
  hatched cycle rows**, and a zero becomes a named absence. **Preflight takes the live card
  while it runs** — accent border and the one pulse — because it is a real turn against a real
  CLI. The one thing the design asks for that is *not* built is its ETA line, *"preflight
  usually clears in under a minute"*: that is a claim about past runs, and the archive the
  window now reads (#114) records no preflight durations, so shipping it would be the same
  invention as `claude 38%` and `step 9/14`, both of which the design itself struck. The row
  says what it cannot say, and why.
- **While a gate is held there is no live card, and the turn before it is still drawn.** An
  `ask` closes the running turn, exactly as `phase_started`, `turn_started`, `gate_stopped`
  and `result` do — a gate holds *between* things, so nothing is executing while one is
  outstanding. (Since #403 a `turn_started` that carries a `label` closes only unlabelled turns,
  so review seats running at once stay live side by side, each drawn live; `ask`, a phase and a
  `result` still close every one. See `core-and-window.md`.) Leaving it open was not cosmetic: a run held overnight drew `5h40m · last
  activity 5h39m ago` on a turn that took a minute, two inches above a footer correctly
  saying the loop was waiting for a human. The card said kill it and the footer said press
  continue. The turn stays on screen with its measurements — that is what a person is
  deciding about — and gives up the accent border, the active ground, the accent on its label
  and **the liveness dot entirely**, because exactly one element on screen pulses and while a
  gate is held nothing should. A `held` kicker names why it is still, so a completely
  motionless card does not read as a failed one. `Gate.turnId` names the turn, so the column
  is told rather than picking the last one.
- **On a card that has stopped, every relative time becomes absolute** (hi-fi 17). Stopping the
  clocks was only half of #202: `last activity 6s ago` is a claim that has to keep being true,
  and on a still card it ages into a lie — which is literally how a run held overnight came to
  read `5h39m ago` about a turn that took a minute. `clock()` beside `elapsed()` is the pair,
  and `runningRow` carries `lastBeatAt` and `endedAt` **beside** `quietMs` rather than instead
  of it, because a live card wants the relative form and a settled one cannot have it.
- **A sidebar row's dot pulses while one of its turns is running** (#307). #246 made every
  row still, so that exactly one element on screen pulsed. The cost was reported directly:
  a run working looked the same as one idle, and the sidebar is where several live runs are
  compared. So the rule is now *a pulse means a turn is running*: `hostedMarks.working` is a
  run with `running` set and no gate held, and its row pulses, so several rows can. A gate,
  a held turn and an idle host all draw `LivenessDot still`.
- **Where the run is, said on every surface that draws it** (#409). A resume at `reviewing`
  re-runs the gates before the review, and for a core gate's minutes the window called the run
  idle: *Ready for the next turn · The run is between turns*, Code complete, Code review not
  started. A gate is not a turn, and the now card and the run path asked only about turns,
  although `reduce` already had the gate open at `running`. `runningGate` (`cockpit/rail.ts`) is
  the one answer: a gate at `running` in the latest pass, while no turn is open, no decision is
  held, and the run has not ended or lost its host. The now card says *Verifying · Running the
  core gate* with a clock from the gate's start, and the run path draws **Code** live, because
  the gates run between Code's turns and are drawn under it.
  - **The tab bar marks the tab for what is running**, from `liveTab`, which reads the same open
    turn the rail does through `STAGE_TAB` (the map the round cards' links use too), so the bar
    and the rail cannot disagree. A running gate marks **Verify**, the pane that draws it. A held
    decision marks nothing. The mark is the rail's live dot, pulsing under #307's rule, and it is
    an icon before the label, never `· n`: in this bar a `· n` is a count of what is behind the tab.
  - **Each stage's tab draws the round in flight** (`InFlight` in `Cockpit.tsx`, `inFlight` in
    `rounds.ts`). The four artifact panes are built from what rounds wrote, so a round still
    running was on none of them. It is the pilot log's `RoundCard`, from the same `rounds()`, for
    the card holding `run.running`. That is the turn the rail reads, so a pane cannot call a round
    live that the rail calls finished. It sits **below the pane's scroll**, not in it: a reader who
    opened round 0 is not moved, and every empty pane shows it, which is when it matters most. The
    wrapper is always drawn, so a round starting or ending never remounts the pane under it. The
    Verify pane already drew a running gate, and keeps doing so.
- **A row waiting on a person says so, and why** (#307). `cockpit/attention.ts` holds the
  rule: a held gate (`gate`); the archive's `needs-input`, `stalled` and `error`
  (`needs you`, `stopped`, `failed`), only for a run not running, since a running run's
  status may predate its resume; and a draft whose saved conversation ends on the pilot's
  message (`your turn`) or holds an unanswered proposal (`proposal`). A saved conversation
  never holds a turn in flight, so its shape is enough. The badge is a static `alarm` chip
  with the reason in its tooltip, never on the row on screen. A shut project shows one for a
  gate or a draft; its archive is not read while shut, so a stopped run is said only once it
  opens.
- **The pilot's open turn waves, and it is still one animation.** *"Exactly one element on
  screen pulses"* is the rule above, and the corpus lists the pilot chat's live round card
  among the screens allowed to — but between pressing send and the first token that card has
  no text, no model and no usage, so all it drew was a two-word kicker, and a manual pass
  reported it as a stall more than once. `ThinkingWave` is three dots taking **`v-pulse`** —
  the one keyframe this system has — at three offsets, so the count of animations does not
  change and reduced motion is inherited rather than re-handled: at `--wave-duration: 0s` the
  dots simply stand still, and the indicator is drawn only while a turn is open, so its
  presence was always the claim and the motion only ever the emphasis. It needs a second
  duration because 2.4s is chosen for a dot glanced at every few minutes, and at that period a
  wave reads as three dots fading independently rather than one thing moving.

  Two things travel with it, and the first is the one that matters. **The wave is a claim
  about the window, not about the turn** — a vendor that had silently stopped answering waves
  exactly as busily as one composing — so it never appears without a measured elapsed beside
  it, which is the half a person can judge. That elapsed is stamped **when the request is
  made**, not when it resolves: a turn has no id until `pilotTurn` comes back, and on the
  subscription path that is a `claude` child being spawned, so stamping at the resolution
  would restart the count from zero after the slowest part of the wait. `Reply.startedAt` is
  `number | null` and `transcript.ts` stays pure — the clock is passed in — so a reply from a
  build older than the field draws no elapsed rather than counting from the epoch. And
  `streaming` was being drawn from the instant the turn opened, including for the whole wait
  when nothing was streaming; empty text is now `thinking`, which is the honest word for it.
- **Every way a run can end has a phrase, and they are not eight flavours of failure.** The
  footer maps each of the eight exit codes to one sentence, and a code this build does not
  know renders as the number rather than as a phrase invented for it. Two of them must never
  say "failed": exit 7 is documented in `src/charge.ts` as *"not an error and not a stall"*,
  and exit 2 is how an ordinary long run pauses. `app/src/cockpit/format.ts` holds the map and
  `contract.test.ts` fails on the commit that adds a ninth code.

**A host is told how a run ended; it never picks the ending out of the log.** `run_escalated`
and `run_failed` are narration ids `execute` emits at the places it gives up, carrying the
exit code and the one-line reason. The alternative — selecting the most recent alarming line
from the output pane — is the English-matching #133 exists to prevent, and it picks the wrong
line: an escalation narrates at `warn`, and a healthy run is full of warnings that are not the
ending. `run_failed` also prints a stack while carrying the sentence separately, because a
terminal wants the frames and a footer wants the answer to "what now" (#162).

**The app was built from a transcription of the design and not from the design, and
`app/src/design/AUDIT.md` is what that cost.** The artwork has never been in this repo — a
decision this file states in its own words, *"the markdown is worth committing and the
artwork is not"* — so every screen came from `HANDOFF.md`. That predicts exactly the
divergence the audit found: **the rules `HANDOFF.md` states were implemented faithfully, and
the things only visible by looking were not.** Every colour in the spec is in `tokens.css`;
nothing in the audit is a colour, a font or a spacing value. What was missing was composition,
which does not survive being written down.

Read `AUDIT.md` before building from a frame. It is a walk of all fourteen hi-fi screens
against what exists, with a `### Closed` note under each finding saying what was built, what
was built **narrower** than the frame and why, and — for the two that are not built — what
they are waiting on. Four things in it are worth carrying:

- **The round card is the product's main object** (hi-fi 5). *"Every round leaves a card, and
  a card carries what happened, what it found and what you can do about it."* `rounds.ts`
  re-shapes what is already on `Run` and adds nothing; `log.ts` places the cards among the
  pilot's replies. **Replies keep their order and cards are placed among them**, never the
  other way round: `Reply.startedAt` is nullable by design, so sorting one mixed list by a key
  half of it lacks would reorder somebody's conversation to make a card fit. There is no
  `claude/opus` on it, because a turn frame carries no model.
- **The column and the log draw the same four groups, and that is the second half of one
  decision.** `CycleKind` is four — `plan`, `critique`, `code`, `review` — and `rounds()`
  produces one card per phase group, so a critique is an entry in the pilot's log rather than
  an in-place update to a card placed twenty minutes earlier.

  **It was the pair, and the pair is what broke.** Hi-fi 5 draws the round card as
  producer-and-judge in as many words — `plan v.b · claude/opus · 4m 40s · accepted after 1
  critique` — and `rounds.ts` was built that way, with a three-valued `RoundFamily` beside the
  column's four-valued `CycleKind`. A merged card is placed at the round's *start*, so the
  moment the loop entered `PLAN CRITIQUE` the log did not move: *"it moved to Group 2 · Plan
  Critique but that never updated the pilot chat like the plan rounds did."* A log that does
  not move when the loop moves is not a log.

  **The cost is stated rather than argued away.** Two cards cannot say *accepted after 1
  critique* in one line. What carries the pairing instead is the **round chip**, on both halves,
  which is only readable because the core now says the round on `planning` as well as on
  `critique` — the same mechanism that pairs the two groups in the column. If the sentence is
  ever wanted back it belongs in a summary above the cards, not in a card that hides half its
  own arrival.

  **The judge got a heading at the owner's decision, and the cost is written down rather than
  argued away.** The convergence model says a round is the *pair* — the planner produces a
  version, the critic judges it — and `CYCLE_OF` folded `critique` into the plan cycle for
  exactly that reason. What the folding cost was legibility: the column read
  `PLAN · CODE · REVIEW`, and the critique — half the plan cycle's work and every one of its
  Codex turns — had no heading anywhere on screen. Asked directly *"where does plan critique
  live?"*, and the only honest answer was *"inside cycle 1, as a row"*, which is not an answer
  anybody should need to be given.

  The objection stands and is not resolved: **four peers read as four stages, and the loop is
  not a pipeline.** Three things carry that weight instead. The labels say `GROUP`, not
  `CYCLE`, so the numbering does not claim a sequence. `status()` prints `re-runs on every fix`
  under both groups that genuinely re-open. And the **round chip** is load-bearing rather than
  decorative — with the halves in two groups it is the only thing saying which critique judged
  which draft, which is why the core now puts a round on `planning`.

  `rounds()` sorts by start rather than trusting cycle order, since a resume can open the
  critique group first.

- **The question loop is drawn on the round that opened it, and it is a count rather than a
  list.** `7a` nests it inside the plan cycle and it used to be drawn at the *foot* of the
  whole group — so the moment a second plan round opened, round 1's questions appeared beneath
  round 2's row. `questions_opened` carries an arrival time and `questionsByPhase()` places
  each round through the same `during()` a census goes through, so there is one definition of
  "by arrival" and not two. The question **text** is the Questions pane's job: this column is
  364px wide, a question is a paragraph, and a list of them pushed every later round off the
  screen.

  **`Run.questions` is a list, and the single field is what made placing them pointless**
  (#223). Fixing *where* a round was drawn left a second defect underneath it with the same
  symptom: the field held one round, each `questions_opened` replaced the one before, and
  `questionsPhase()` could therefore only ever answer for one round in the whole run. So a run
  that asked three rounds of questions drew the counts on one of them — *"only plan round 2 has
  full details… they all should"* — and rounds 1 and 2 were not stale, they were **gone**, with
  nothing on screen saying a round had had any. Two things about the shape of the fix:

  - **It is the move `verify` and `censuses` already made**, stated in their own comments in
    the same interface: *a list rather than the latest, because the pane's trend is a comparison
    ACROSS passes*. A column that reads as a history cannot be built out of fields that remember
    only the most recent thing, and this is the third field to learn it.
  - **"The latest" became a named expression rather than three index reads.** `latestQuestions`
    is what the Questions tab's badge, the halt banner and the pane all call. Three spellings
    of the same idea is how a badge and the pane behind it came to disagree about one run the
    last time, which was reported as two separate bugs.

  An answer lands on the **last round opened**, not on a round matched by number: the frame need
  not carry a round at all, and a null would then match whichever earlier round also had none.
  A round that opened before any phase of this session — real on a resume — still attaches to
  no card, and the column draws it at the foot rather than crediting an earlier session's
  questions to work that has not happened yet.

  The **replay** gets this for free and was wrong in exactly the same way: `src/replay.ts`
  emits one `questions_opened` per question round, and every one of them but the last was being
  folded on top of the one before.

- **A count is a control wherever it is drawn.** `Counts` is one component for the loop column,
  the findings pane and the pilot's round card, and clicking it opens the findings — the four
  chips are the largest thing on any of those surfaces and were inert while a text link three
  lines below did the navigating. The same applies one level down: a finding row in the
  findings pane was a `<button>` that set an `open` id nothing rendered, so the cursor promised
  a disclosure that did not exist. What is behind that fold is the **provenance** — author,
  citations, severity history, reproducer outcomes, and since #388 and #393 which seats found it,
  the vote and what the fixer did with it — and what stays out is the severity, the
  title and the id, which are what make a list of findings scannable.

- **No issue number reaches the screen, and `copy.test.ts` is the gate.** Seven components
  carried one, each individually defensible: naming the issue that would supply a missing
  figure is how this repo keeps a gap legible. That reasoning is right about the *source* and
  wrong about the screen — `#114` is unactionable to anybody not holding this repository open.
  The numbers stay in comments. The test **globs** `app/src/**/*.tsx` rather than naming files,
  for the reason `audit:contrast`'s hex check walks `src/`: a named list is something somebody
  has to remember to extend.

- **Three defects were found underneath that question, and two were core bugs.** A cycle
  counting phase groups called two plan rounds **three**; `revisePlan` announced no phase, so
  the planner turn producing the *next* version landed inside **the critique that caused it**;
  and `planning` carried no round at all. The first two are fixed in the core and are correct
  under either grouping. The third fixes itself once each group holds one phase per round.
- **A census and a verification pass attach to a round by arrival**, because a census carries
  no round of its own and a pass carries the *verify* round, which is a different counting
  from the one a phase group is keyed by. One that predates every phase — a real state on a
  resume — attaches to nothing. `rounds()` is the single answer, and the loop column takes its
  census through it rather than matching one itself, so the column and the pilot's log cannot
  disagree about one round.
- **The command palette matches by substring, and passes `cmdk` its filter to do it** (#397).
  `shell/paletteFilter.ts` is the match: case-insensitive, whitespace folded, every hit scoring
  1 so the rows keep the order `Palette` gave them. Leaving the `filter` prop off is not a
  neutral default: `cmdk` then runs `command-score`, a fuzzy scorer roughly cubic in the
  value's length, and a run's value is its id and its whole brief (6,825 to 20,386 characters
  in this repository's archive). That froze the window for every letter typed: 360 ms for `a`,
  11.0 s for `al` and 15.0 s for `all` over 20 runs, measured in Node. The query never leaves
  `cmdk`'s own state, so typing does not re-render `Cockpit`; the cost was all in the filter.
- **There is one sidebar, and the rail is its collapsed state.** A 54px rail headed `RUNS`
  beside a panel headed `Runs`, both drawing the same archive — reported in one line, *"there
  are two Runs bars on the left now"*, and it was not a rendering accident: two surfaces had
  been given one job, once by hi-fi 1 and once by moving the loop column. `Sidebar.tsx` is the
  merge. **What must survive it is `＋ ⌘K ⚙`**: `design/AUDIT.md` §1.1's finding was never
  *"there should be a strip"*, it was that those three had nowhere to live and ended up in the
  tab bar, so a panel that shut them away would put the finding straight back. They were the
  shut strip, which is why the old `SidePanel` took a `shut` slot at all; since the rework they
  live on the activity bar (`shell/ActivityBar.tsx`), at every width.
- **A row OPENS a run. It does not start one.** The first cut resumed on click and the report
  was immediate: *"clicking on a run automatically kicks off the pre-flight. I don't want
  that."* It is the sharper form of the narrowing the rail already made — that one said a
  square must not silently *force* a lock, and this says a click must not silently **spend**. A
  resume probes both CLIs, takes the lock and starts a turn, so putting it behind a row in a
  list makes browsing the archive cost money, which is the one thing browsing must not do. So
  `Cockpit.viewing` is where the window is *pointed*, every pane that reads a run's own
  directory follows it, and starting the loop is a separate labelled act in `1b` — which is
  also where a lock is overruled, with a confirmation. **Two places able to start a run is the
  same mistake as two able to force one**, which is why `1b` is a view with no tab of its own,
  the arrangement `settings` has had since the rail landed.
- **`viewing` is where the window is pointed, so starting a run points it there.** The
  corollary was missed, and it cost the whole of one manual pass: `launch` reset the column
  and left `viewing` aimed wherever it already was, so somebody who had opened a past run
  from the sidebar and then started a new one got six panes reading the old run while the
  column narrated the new one. Reported as four separate bugs — *"the planner is currently
  running plan 0, but I see nothing in the output tab… there is nothing under the plan and
  critiques tabs! No questions either, even though it says three raised"* — and the last of
  those is the one that identifies it: the Questions **tab** counts the live run and the
  **pane** was forced to null by `past`, so a badge and the pane behind it disagreed about
  one run. They were one defect.

  **And the sidebar had the same corollary, one field further out** (#223).
  `launch` moved `viewing` and left `repoDir` alone, so a run started somewhere
  the window was not pointed drew a sidebar still showing another project — and
  because a project section reads its archive only **while it is open**, that
  run was not merely in the wrong place in the list, it was never fetched at all.
  On top of that, `Project`'s `open` was seeded from `current` at mount and never
  followed it, so pointing the window at a project after launch left its section
  shut for ever. Together those are one report: *"after I started a run and had
  the pilot help, it didn't immediately show up in my runs."* Nothing was wrong
  with the start or with the read — the section it would have been drawn in was
  closed, and the only way to find that out was to open it.

  Two narrow fixes, and the shape of each is the point. `launch` now calls
  `rememberRepo` with the directory **off the argv it is sending**, because that
  is what was actually sent and a second source would be a second answer; a null
  parse leaves it alone, since guessing a directory out of an argv this build
  cannot read is worse than pointing at nothing. And a section opens when it
  **becomes** current rather than on the value, which is the gate watcher's shape:
  `setOpen(current)` every render would re-open a section somebody had just
  collapsed, once a second, for as long as the window stayed there. Arriving
  opens it; a collapse afterwards is respected.

  **Half of it was a second answer to *which repository*.** `shownDir` was
  `viewing?.dir ?? repoDir`, and `repoDir` is where the *window* is pointed — which the
  sidebar moves, on every project click and every add. So a live run's `.vibe/runs/<id>` was
  looked for under whichever project had most recently been clicked. `run_started` carries
  `repo` (#223) and it is the authoritative answer, so it goes in the middle:
  `viewing?.dir ?? run.identity?.repo ?? repoDir`. The failure was silent in the worst way —
  a pane that finds nothing says *no plans yet*, which is exactly what a planner that has not
  finished looks like. `CodePane` takes the live repository separately, because it diffs the
  shas on `Run` and has to run those commands where those objects are.
- **A run's row has four controls and exactly one of them reaches a disk, so exactly one
  confirms.** Pinning and **renaming** are this window's own memory; `＋` on a project opens
  the composer with that project's directory already settled — *"In this window, I shouldn't
  have to select the project folder, it's already known"*, which is the same rule that took
  the repository field out of the pilot: a project **is** a repository, so a second control
  setting it is the third spelling #211 warns about. Deleting is the one that removes a
  directory.

  **A rename is a label, and never a write to the run's record.** `projects.ts` says a pin may
  carry its task *because a run's task never changes*, and every pin rests on that sentence —
  so a rename that wrote the new text into `state.json` would falsify it, and would make the
  record report a brief the planner was never given. `nameOf` sits in front of the task at
  render time, keyed by `(project, run)` like a pin and a saved conversation, and an empty
  name **clears** rather than storing a blank, because those are one intention.

  **A project is renamed the same way, for the same reason one level up** (#223): *"I'd like
  to be able to rename projects and runs."* A project *is* its repository and every request
  names the directory, so `projectLabel` puts a name in front of the folder for display and the
  path is never touched; keyed through `dirKey`, cleared by an empty box, and forgotten when the
  project is removed. The run's ✎ had existed all along and was not found, because it shows only
  on hover — so the project row's ✎ is always drawn, like its other actions, and **double-click
  on either title renames it** as a second road.

  **And a project can be pointed somewhere else, from its own settings** (#223): *"We need to
  be able to edit the project root dir in the project settings."* The case is a project added
  one folder off — the parent of the repository — or a repository that moved. `moveProject` is
  pure and moves this window's memory of the project with it (its place in the list, its name,
  its pins and its runs' names; `Cockpit` moves its drafts) and nothing on disk; the screen then
  reads the new directory's own `vibe.config.json`. It refuses a path that is already a project
  rather than merging two rows. The sidebar takes an `epoch` and re-reads its lists when it
  moves, because those lists are otherwise read once. The field is drawn on the settings
  screen's empty state too, since a project pointed at the wrong place is the one whose
  configuration may not read.

  **The old `vibe.config.json` is offered, never carried.** After a move, if the new directory
  has no file and the old one has one, the screen offers to copy it — through the ordinary save,
  so it is validated like any other — and leaves the old file where it is. Never when the new
  directory has its own: that file is usually committed and is the repository's, and a move
  that merged into it would change a tracked file nobody asked to change. An offer rather than
  a step of the move, because the move otherwise writes nothing to disk.

  **The two deletions say opposite things and the confirmation is the only thing that can tell
  them apart.** Removing a *project* is a row in this window — nothing on disk is touched, and
  adding it back brings every run with it. Deleting a *run* removes `.vibe/runs/<id>` and is
  not recoverable, so the dialog states what survives it: the branch and every commit on it
  are in git, not in the archive.
- **`delete_run` is the first inbound frame that destroys something, and every guard is the
  core's.** A window is not a permission boundary — the confirmation is the window's half, and
  it is the half that is wrong when somebody mis-clicks. `deleteRun` refuses an id that is not
  a single entry under `.vibe/runs`, refuses a run directory that is a link (#53 — following
  one to delete *recursively* is the worst thing this process could be talked into), refuses a
  run whose lock names a live process, and refuses one whose lock it **cannot read**, which is
  `src/lock.ts`'s own fail-closed rule applied to a stronger act than writing. `interrupted` —
  a dead pid still holding a lock — is allowed through deliberately, because that wreck is the
  main case. All four arrive at the window as an `error` frame carrying the core's own
  sentence, shown verbatim: *"it is running, stop it first"* and *"vibe will not follow a link"*
  are acted on differently, and a window that collapsed them into *"could not delete"* would
  answer neither. It is answerable beside a run for a reason rather than by exemption — the
  live-lock refusal means **the running run is the one run this frame can never reach**.
- **Opening a run moves the column too, and it is the same column.** Six panes
  followed the opened run because each reads a file that run wrote; the loop
  column stayed with the live one and said so in a strip. That was honest and was
  still the wrong answer — *"when I click on an existing run, I don't see the
  right nav update"* — because it stayed for a reason nobody outside this
  repository can see: it had nothing to follow with.

  **The first fix was a summary, and it was wrong in a way worth recording.** It
  read `state.json`, shaped it into a `RunRecord`, and drew a second component
  from it: round counts, spend, findings, ending. Every number on it was real.
  It was still rejected, correctly: *"I want the right panel to look just as it
  would have when I click on an old run as if I had run it myself. You just added
  a summary or something and changed it entirely."* A person opening a run wants
  **the run**, not a report about it — and a second drawing of one object is two
  things to keep in step, which is the mistake `Counts` exists to avoid (and
  the old `SidePanel` did, before the rework's resizable panels replaced it).

  So the core says the run **again**. `src/replay.ts` reconstructs the narration
  and the window folds it through the **same `reduce`** a live run goes through,
  so `LoopColumn`, the round cards, `Summary` and `Footer` are the same
  components rendering the same `Run`. `columnRun` is one expression deciding
  which run that is, so the column and the footer cannot disagree about it.

  **The standing objection is answered rather than dropped.** This file said a
  replay *"would report finished work as running"*. That is true of a naive one
  and false of this one: every turn in an archive is a turn that **ended**,
  because `applyCharge` records it when it is charged, which is after it
  returned. Every `turn_started` is followed by the charge that closes it, the
  sequence ends with the ending the run actually had, and `run.running` is null
  when the fold finishes — so nothing pulses, because nothing is open.

  Four things make it a read rather than a reconstruction by guess:

  - **The labels are the loop's own ids.** `seatOf` is the inverse of the
    `label:` sites in `orchestrator.ts` — `plan`, `critique-0`, `revise-q2`,
    `fix-3` — and `run-replay.test.ts` reads that file as source and fails on the
    commit that respells one, which is the guarantee `artifacts.ts` gets the same
    way. This is not the English-matching #133 exists to prevent: #133 is about
    prose written for a human and read for a decision, and these are identifiers.
    A label this build cannot place is left out of the column rather than guessed
    into it — the rule `phase_started` already follows — and its **charge is
    still emitted**, so the replayed spend cannot disagree with the record.
  - **A turn's duration is recorded only sometimes, and the rest say so.**
    `state.turnStartedAt` is one field describing the turn in flight, so the only
    starts an archive keeps are the ones a checkpoint froze, plus the last turn's
    in `state.json` itself. A turn without one is emitted `unmeasured` and draws
    no duration. Deriving one from the gap between two charges would be a proxy
    wearing another measurement's clothes: that interval includes every gate the
    loop held at. The column says this **once**, in its head, rather than leaving
    a blank on each row.
  - **A heartbeat is not durable, so none is synthesised.** A replayed turn has
    no live token count and no activity count, because those measured a turn in
    flight. The totals are on the charge events, where they belong.
  - **A census is narration with no event, so the counts come from the artifact.**
    `plan-critique-<n>.json` and `code-review-<n>.json` are the durable record of
    what each judge produced, and the replay counts severities out of them. A
    severity moved afterwards (#142) is deliberately **not** applied: the round's
    report is the record of what the judge produced, and rewriting it here would
    make the column disagree with the artifact the pane beside it shows.
    **The counts are all a replayed census carries**: the artifact holds the
    report and not the gate's decision, so there is no `tolerance`, `pass` or
    `reason`. The fold keeps those **null**, and the round card and the Review
    pane then draw no tolerance badge and no gate sentence (`gateSentence`). It
    read them as `0` and `false` once, and an opened run's clean review said
    *tolerance P1≤0 · The gate blocked this round.* (#437).

  `exit` travels beside the steps rather than among them, because a `result` is
  not narration — it is the frame that answers a request — and a status this
  build does not recognise reports **null** rather than a guessed zero.

  **A record with no ending is the exception, and the lock is what answers it** (#396). A
  run whose status is still mid-loop (`planning`, `implementing`, `reviewing`) has no
  exit, so nothing closed the turn it was on. A machine shut down under a run held at
  `implemented`, which is not recorded, since `gate_waiting` never is. After the
  relaunch the opened run drew its implement turn running, with "code" blinking, Pause
  and Stop that did nothing, and no Resume. The archive listing already asked the lock
  and called the run interrupted. The run's own view did not ask, so the two
  disagreed.

  So `readRunReplay` asks `livenessOf`, and the replay carries `liveness` and `lost`.
  `lost` is the core's sentence: the status the record stops at, then
  `describeLiveness`. It is set only when there is no exit **and** the lock rules out
  a live process (`interrupted` or `not-running`). An `unknown` lock is left alone,
  for `src/lock.ts`'s reason: a lock that cannot be read, or one held on another
  machine, cannot rule out a live process. `openedEnding` in `model.ts` applies
  whichever ending there is. An exit is applied as a `result`. A `lost` sentence is
  applied through the same `hostLost` a live run's dead host goes through, so the
  turn ends and the footer says the process has gone.

  **The lost footer opens the runs list rather than resuming.** Reopening the run means
  taking back a lock a dead process left behind, and `1b` is the one place that may
  overrule a lock. So the footer's button goes there, in the run's own repository.
  It does not add a second place able to force. Before this, the footer's sentence
  named a screen that only the palette could open.
- **A conversation belongs to the run it is about, and *about* includes the run
  it proposed.** Adoption was allowed only out of the project bucket —
  `chatKey(dir, null)` — which is right about where a pre-run conversation lives
  and wrong about where one can be **typed**. Open a past run, type the brief for
  a new one into the composer, press the proposal: the exchange was saved under
  *that run's* key, because that is where the window was pointed, and the run it
  proposed started life with nothing. Opening that run then showed an empty pane,
  which is the report — *"nor do I see the pilot chat update"* — arriving one step
  removed from its cause. Confirmed rather than guessed: the only surviving run
  in the manual-pass archive had no `vibe.chat.` key at all, while three deleted
  ones did.

  `chatMove` in `saved.ts` is the widened rule and it is **pure**, which is the
  other half of the fix: the app has no jsdom, so a decision living inside an
  effect is a decision nothing tests, and that is how the narrow condition
  survived being written down. Adoption now takes the conversation on screen
  whatever key it was under — **unless the target already has one**, which is the
  guard a resume needs: that run has its own exchange, and adopting over it would
  destroy a real conversation to save a stray one, which is strictly worse than
  the bug being fixed. Only the project bucket is cleared afterwards; removing a
  *run's* key would delete a real conversation to tidy up after a move.

  And a run with no stored conversation now **says so**. *"Nothing yet"* is right
  before any run and reads as a failed load beside one — a run started from the
  terminal, or by a build older than `saved.ts`, never had a conversation here,
  and that is a fact about this window's memory rather than about the run.

  **And adoption is for a run this window *started*, never one it opened**
  (#223). The rule above is right and its condition was one clause short:
  `intoRun && holding && !stored` is true of two completely different acts —
  a run this window just launched, which the conversation on screen proposed,
  and a past run somebody **clicked on** that happens to have no conversation of
  its own. The second took the chat with it, so browsing the archive left the
  same exchange on screen whichever run was open, and wrote it into that run's
  key on the way past: **a read that silently created a record.** Reported as
  *"changing runs doesn't change the pilot chat"*, which is the symptom of every
  destination inheriting the same conversation.

  The two are indistinguishable from `chatMove`'s arguments, which is why it is
  told: only the cockpit knows whether `viewing` moved, and `opened` is that
  fact. The clause is a **narrowing** of adoption rather than a new mechanism —
  every case the widening was for still adopts, and `opened-run.test.ts` pins
  the two that differ only in this flag, because a pair that reads identically
  from inside the function is exactly what a future edit would collapse.
- **The pilot reads the request before it proposes a run, and that is a prompt
  rather than a gate** (#223). The pane had been the front door since #211 — the
  launch bar is gone and `start_run` is a proposal — and it still *behaved* like
  a form, because nothing in `brief.ts` ever said that reading the request was
  part of the job. One message in, an argv out. Reported as the change that
  matters most: *"I don't want the run to start automatically… I want the pilot
  to do diligence, think critically, uncover potential gotchas, ask the user
  clarifications, then once the pilot feels comfortable, kick off the run."*

  **Nothing structural moved.** `start_run` is still propose-only and the person
  still presses the card — decision 1 of #144, reaffirmed at the owner's
  decision, because a run is the most expensive thing in the product and a brief
  is the part that decides whether it converges. What changed is *when* the card
  arrives: at the end of an interrogation rather than at the start of one.

  **The first attempt shipped the doctrine with no route to it, and the mistake
  is worth more than the fix.** This note said the pane *"had been the front door
  since #211"* and it was wrong: what #211 deleted was the launch bar inside the
  pilot pane, and `1b` — `NewWorkstream`, the composer somebody actually reaches
  from `＋` — still built an argv and started the run. So the prompt was written,
  tested against `brief.test.ts`, and changed nothing at all, because nobody was
  talking to the model it instructed: *"in the pilot chat, my request didn't show
  up and the pilot isn't doing anything."* Checking the pane and concluding the
  front door had moved was reading one half of a two-door building.

  The general lesson: **a behaviour is only as real as its route**, and a test
  over a prompt cannot see who is sent it. `frontdoor.test.ts` pins the three
  hops instead — submit calls `onBrief` and the composer has no `onLaunch` at
  all, the cockpit carries the brief over and moves the tab with it, and the pane says it as something a
  *person* said rather than as a wake.

  **The direct launch went, and the reason it had stayed is what made that
  possible** (#223). It was kept as *forced rather than chosen*: `start_run`
  took a brief, a directory and plan-only, so a run needing `1b`'s overrides
  block had no conversational route, and deleting `skip the pilot` would have
  deleted a capability. The owner then asked for exactly that — *"There should
  only be one start button and it should follow the 'talk it through' path"* —
  so the capability **moved** instead: `start_run` now takes `gates`,
  `max_tokens` and `p1_tolerance` (and, since #356, `branch`, which the pilot
  fills with a name it proposes and the card shows as `--branch`), built by the same `launchArgv`, and `1b`'s one
  button is `start`. `briefFor` puts the composer's settings into the message
  under the brief, where the person can see them, and the pilot passes them on
  the call.

  The objection recorded against that route — *"the window would have to merge
  them into an accepted argv the card never showed"* — is answered rather than
  ignored: nothing is merged. The overrides are fields on the call, so they are
  in the argv the card **draws**, and *what runs is what was displayed* holds.
  What it costs is a model in the path between the toggle and the flag, which is
  why the settings travel as visible text and why `start_run` refuses a malformed
  one by name rather than coercing it — `--max-tokens 0` turns the ceiling off,
  so a value nobody meant is the opposite of leaving it alone. The modal's argv
  preview went with the button: it described a command nothing on that screen
  runs any more.

  **The enforced version was considered and declined**, and the reasoning is
  worth keeping because it is the general case. A gate would refuse `start_run`
  until some counter said questions had been asked — testable, and the weaker
  design twice over. A counter measures *that* a question was asked and can say
  nothing about whether it was worth asking, so the enforceable form of
  diligence is the **performance** of it, which is the ritual a model is best at
  faking. And a brief that is already unambiguous is a brief that should be run:
  a gate makes the good case pay for the bad one every time, and the escape
  hatch it then needs is a second way to start a run, which is the third
  spelling #211 warns about.

  What makes prose the right instrument is that the thing being asked for is
  judgement, and the standard it is held to is a **measurement rather than an
  opinion** — this file's own hardest-won lesson, from a census of runs that
  converged and runs that stalled: the ones that converge state the decisions
  already made and say *do not re-derive them*.

  **The bound is load-bearing and is the half a test can check.** Diligence that
  never ends spends the person's attention, which is the one budget in this
  product with no ceiling, so the doctrine carries a stopping rule — *could a
  competent implementer who never saw this conversation read the brief and not
  have to guess?* — explicit permission for one exchange to be a complete
  intake, and a structural limit: **the loop has its own question round**, so the
  pilot is not resolving everything, only what changes the *shape* of the plan
  and therefore has to be settled before a plan exists to critique.

  One thing it must say and nearly did not: **the planner never sees this
  chat.** A decision settled in conversation and left out of the brief is a
  decision the run makes again, differently — which from the outside is
  indistinguishable from the pilot never having asked. `brief.test.ts` pins the
  stopping rule, that hand-off sentence and the doctrine's position *above* the
  run block, since a doctrine under two hundred lines of JSON is one a model
  reads last.
- **The pilot reads the repository on screen, not the one in the sidebar**
  (#223). `shownDir` is the one expression deciding which repository is on
  screen and the six reading panes were moved onto it when the live run and the
  opened run came apart; the pilot was left on `repoDir`, which is where the
  *sidebar* is pointed. It matters more here than on a reader, because `dir` is
  the pilot's **permission boundary** — the directory `claude -p --restricted`
  is spawned in and the only one it may read, and where an accepted
  `run_command` runs. So the pane could be reading one repository while the tabs
  beside it read another, and with no project selected it refused to send at
  all: *"I just tried sending a chat to an old run's pilot but I can't"*.
  `Kickoff` deliberately keeps `repoDir`, because a **new** run starts where
  `launch` sends it and pointing the bar at an opened run's repository would
  make the two disagree about that.
- **Your half of the pilot chat is mirrored, and only your half** (#223). The
  first answer to *"it's too hard to tell which is which"* was a `you` chip and
  a tinted ground, and `pilot.css` (since deleted) recorded at the time that a mirrored layout
  was **deliberately** not wanted: the pilot's replies carry chips, prices and
  proposal cards, so putting the one un-annotated thing in the conversation on
  its own axis would be decoration. That reasoning is right about the *reply* and
  was wrong about the reader — a chip and a ground are read once you have found
  the block, and a long log needs something findable while scrolling past it. The
  second report settled it: *"maybe right justify my input and left justify the
  pilot's?"*

  The objection is answered rather than overruled, and the **asymmetry is the
  answer**: your half is bounded at 80% and pulled right, and the reply keeps the
  whole column, because a proposal card holding an argv has to stay readable and
  squeezing it to make a diagram of the conversation would trade the thing that
  matters for the thing that is pretty. The text inside stays left-aligned: a
  right-aligned paragraph has a ragged left edge, and the left edge is the one
  the eye returns to on every line.
- **The composer is always typeable, and every reason it will not *send* has a
  sentence** (#223). `ready` folded five conditions together, `blocked`
  explained two of them, and the `textarea` was disabled for all five — so a
  pane holding an undecided proposal, or one that had spent its daily ceiling,
  was a box that could not be clicked into, under a placeholder cheerfully
  inviting you to say what you wanted built. Reported as *"my pilot chat won't
  allow me to click inside of it and enter text"*, which is precisely what a
  disabled field looks like from outside: it cannot take focus, so there is
  nothing to click and no tooltip to read.

  Two halves, and the first is the one worth copying. **Composing and sending
  are two acts and only the second can be blocked** — a proposal waiting to be
  answered is a reason a message cannot go, not a reason it cannot be written,
  and disabling the field also threw away whatever was half-typed the moment a
  proposal arrived. So the field is never disabled, `submit` grew the `ready`
  check the button already had (Enter is the second road to it), and the send
  button is what refuses. And `ready` is now literally `blocked === null`, so a
  state that stops a send and a state with no sentence for it cannot come apart
  — which is how three of the five came to have no words in the first place.

  The sentence is drawn on its own line rather than in the placeholder, because
  a placeholder disappears the moment somebody types and this is the one thing
  they need while looking at a button that will not work.
- **The model lists are asked of the CLIs now, and no list ships in this repo** (#223). This
  supersedes the two notes below it about `KNOWN_MODELS`. Every list had aged: Opus 5.5 and
  Fable 5.1 could not be picked in the pilot, Codex's default had moved to `gpt-6-astra`, and
  `gpt-5.6-pro` was no longer in Codex's own list at all. The owner's line was *"What if claude
  introduces a new model, we have to change source code? I really want to avoid that."*
  - **Both CLIs list their models on the subscription, for free.** `claude` answers the
    stream-json `initialize` control request, the one the Agent SDK's `supportedModels()`
    reads, with every alias, what it resolves to and a description. Stdin is closed after the
    request, so it answers and exits without a turn: measured at 2.5s, exit 0, no `result`.
    `codex app-server` answers `model/list` and marks its default. `src/models.ts` asks both
    with `agentEnv`, so the list is the one the billed account can use.
  - **With a key, the vendor is asked instead.** `pilot_models` in `pilot/models.rs` is a
    ninth command, and it answers with model names only. It runs as `command(async)`, because a
    plain command runs on the main thread. OpenAI's listing is not filtered: no field says
    which models can chat, and every rule that could would be a list to keep current.
  - **There is no fallback list.** A fallback is a list somebody has to keep current. A
    listing that fails says why, the chosen value is kept, and a name can be typed.
  - **Neither call is a promised interface**, so both parsers fail closed to *no list*.
  - **Both run defaults are the CLI's own** (`model: "default"`), at the owner's decision:
    *"Follow both defaults unless changed by the user."* `modelArgs` in `src/modelflag.ts` is
    the one place that turns it into *no flag*, and `model-listing.test.ts` fails on a call
    site that writes the flag itself. A consequence worth knowing: a context measurement and
    the window seeded from an earlier run are keyed by the configured name, so after the CLI's
    default moves to a model with a different window the first turn's ratio can be wrong
    once, until `recordTurnContext` overwrites it.
  - **The host keeps a good listing and retries a failed one**, because the usual failure is a
    key that had not arrived yet. Settings has a *check again* control for a CLI updated since
    the window opened.
- **A model is picked from a list this build ships, and typed past it.** This
  reverses the decision one report above it, and the reversal is narrow rather
  than a change of mind about the rule. Free text was argued from the core's own
  sentence — *"guessing whether a model exists is the never-invent-a-number rule
  applied to a name"* — and the reply was *"the model should be a drop down and
  not a text input"*. Both are right about different halves: typing
  `gpt-5.6-luna` from memory to change one role is a bad control, and a list
  *claiming* to be a vendor's catalogue would be the invention.

  `KNOWN_MODELS` in `roles.ts` is what a window may **offer**, and it is not an
  allowlist: `validateRoleSetting` is unchanged and still takes any non-empty
  string. Every entry is a name this repository already ships — `opus` is
  `DEFAULTS.claude.model`, `haiku` is `preflight.ts`'s `PROBE_MODEL`, `sonnet` is
  the role-table example the README carried before it was cut down, `gpt-5.6-luna` is `DEFAULTS.codex.model`, and
  `gpt-5.6-pro` is what `--help` prints beside `--role` — so the list is a fact
  about this build rather than a claim about a catalogue. It lives in the core
  beside the defaults it has to agree with, for the reason `pilot.MODELS` gives
  about Rust: a list compiled into the surface that displays it goes stale on
  somebody else's schedule instead of ours. It is **per agent**, because a Claude
  model handed to Codex is a turn that fails after it has been spawned.

  Two rules keep the select from becoming the allowlist the list is not. A
  configured value it does not recognise is **kept as its own option, marked** —
  a select that could not represent its own value would rewrite a role's model by
  rendering, which is the worst kind of data loss because nobody pressed
  anything. And `other…` is always there, revealing the text field this replaced,
  so a model that shipped this morning is typeable this morning. `other…` is a
  sentinel rather than the empty option, because empty already means *take the
  agent's default* and the two are opposite intentions.
- **The reviewer was handed an empty diff, and then hung — two defects, and the
  second one hid behind the first.** Reported as *"the code review round 0 timed
  out after 45 min"*, which is what it looked like and is not what happened.

  **The diff was empty because `git diff --cached` compares the index to HEAD.**
  A greenfield run has no baseline commit, so `markBase` returns null — its
  contract is that null means *no commits when the implement phase began* — and
  the no-base branch of `resolveDiffMode` fell back to `git add -A` plus
  `git diff --cached`. That is right until the round commits, and the moment it
  does the index matches HEAD and the diff is **nothing**. Measured on the run:
  40 files and 5,915 insertions committed as `ceba37d`, `git diff --cached`
  returning 0 characters, and the same command against the **empty tree**
  returning 210,111. Naming the empty tree explicitly is safe there and nowhere
  else, and `markBase`'s contract is the whole reason: with no base, everything
  in the history is this run's work, so there is no earlier history to sweep up.
  It is asked for with `hash-object -t tree /dev/null` rather than written as
  `4b825dc…`, because a repository created with `--object-format=sha256` has a
  different one and a constant would be right here and silently wrong elsewhere.

  **A second route to the same emptiness turned up underneath it**, and the guard
  below is what surfaced it: with `git.commitEachRound: false` the round stays in
  the working tree, and the fallback `git diff HEAD` **cannot see a file git has
  never seen**. An implementation is mostly new files, so a round that only added
  them showed the reviewer nothing at all. `git add -N .` — intent-to-add —
  registers the paths so the diff describes them and stages no content
  (measured: `git diff --cached` stays empty after it). It is passed only by
  `diffChunks`, which is the review's read; `diffSince` is what the `diff` read
  frame reaches, and a read frame that touched the index would be the surprise
  `protocol.ts` refuses a null base to avoid.

  **And an empty diff is now refused rather than reviewed.** There was a guard
  for a diff too *big* for one turn and none for one with nothing in it, and
  `diffChunks` answers the empty case with a well-formed result — one chunk, no
  files, an empty string — so nothing downstream could tell *here is the change*
  from *there is no change to read*. It is the rule `reviewPhase` already applies
  to a directory that is not a repository, in almost the same words, and it takes
  the same `EXIT.PREFLIGHT`, whose own comment names this case: *"whose review
  phase has no diff to read"*.

- **The implement turn never announced itself, so the window drew an idle run
  while it spent fourteen million tokens.** Every other turn in the loop emits
  `turn_started` — plan, revise, critique, answer, review and all three fix
  kinds — and the implement turn, which `charge.ts` calls *"the single most
  expensive step in a run"*, did not. `narration-identity.test.ts` pinned the
  absence as deliberate, and its reasoning was sound as far as it went: *"adding
  a step line purely to make the vocabulary symmetrical would change what the
  terminal prints, and the CLI's output is a contract; symmetry is not worth
  that."*

  **It was never about symmetry.** `turn_started` is the only id `reduce` builds
  a `Turn` from, and `run.running` is what the cockpit draws a live card off. So
  with it missing the window showed `IDLE — no turn is open`, the CODE group had
  no row, and — worst — **every heartbeat was discarded**, because a beat with no
  turn open cannot be attributed and the reducer drops it by design.

  The evidence is a run of 2026-09-16 and it clears the bar this file sets for
  reopening a settled decision. The terminal printed `implement: 14m30s · 63 tool
  uses · Write …TodoToggle… · 13.7M tok · ctx 25%` every thirty seconds while the
  window showed an idle run, so the turn was stopped by hand by somebody who
  reasonably concluded it had hung: **14.2M tokens and 50 files of finished work,
  thrown away because the product said nothing was happening.** That is "one
  channel, two renderers" breaking in the one place it costs the most.

  The cost the old note named is accepted rather than dodged — the terminal gains
  one line per run — and it is not a host-only narration, because `model_said`'s
  rule is that a transcript disagreeing with the window breaks the same guarantee
  in the same place. `round` is `state.reviewRound`, the field the three fix
  kinds already carry, because the CODE group re-opens on every fix and the round
  is what tells one pass through it from the next.
- **A fix round is a code round, and it opens one** (#280). The review fix and the final
  fix announced a turn and no phase, so `reduce` filed each under the most recently opened
  group — the review it answered — and a run that went review, fix, review drew
  `review round 0 → review round 1` with the code nowhere: *"it did a review round 0, but then
  didn't code but just went straight to another round of review"*. The replay already filed
  `fix-N` under `implementing`, so the live column and the archived run disagreed about one
  run. `announceFixRound` opens `implementing` with the review round; `verify-fix` does not,
  because a failed gate's repair belongs in the code group that ran the gate.
- **The first implementation is not a round, and the rail calls it `implementation`** (#428).
  Its heading carries no round, and the rail's expanded Code stage drew that as *"unnumbered
  pass"* while the implement turn's chip said `round 0` (the turn carries `reviewRound`, 0, so
  the reducer can tell one pass through Code from the next). Fix rounds count from 1 and come
  after it. `passLabel` (`rounds.ts`) names each row: **`implementation`**, **`fix round N`**
  (the number `Implementing (fix round N)` prints), and **`round N` counted from one** for plan,
  critique and review, as `Plan critique (round N)` and `Code review (round N)` count. It drew
  the raw archive round before, so the first critique read `round 0` beside a heading saying
  round 1. A row whose frame carried no round reads as its phase's name (`planning`,
  `critique`, `review`). `isFirstImplementation` asks the group's turns first, an `implement`
  turn or a fix kind, because a replay files the first implementation under review round 0
  and the round alone cannot tell it apart. The core is not asked for `round: 0`, which would be
  a number nothing counted. The same answer takes `round 0` off the implement turn's chip
  (`turnRound`), the replayed group's chip and the Code pane's title (`code · implementation`).
- **Every round a person reads counts from one; every file, link and key counts from zero**
  (#428, the owner's decision on #433). The chips used to show the archive's round, on the
  reasoning that a row has to agree with the file, so the first critique read `round 0` under a
  heading saying `Plan critique (round 1)`. A person reads the chip and the heading and never
  the file name, so the display agrees with the heading. `shownRound` in `rounds.ts` is the one
  `+ 1`, and `phaseRound` and `turnRound` apply it to plan, critique and review groups and to
  `plan`, `revise`, `critique`, `review` and `vote` turns. Fix and verify-fix rounds are already
  counted from one by the core (each is incremented before its turn) and are drawn as they
  arrive. The loop column's round heads, turn rows, the live card, the Output strip, the pilot's
  round cards and the Plans, Critique, Review and Code pane titles all ask it, and
  `pass-label.test.ts` fails on a site that draws a raw round. Links, pane ids and `reveal` keep
  the raw round, so a `round 1` chip still opens `plan-critique-0.json`. The footer's `plan N of
  M` counts from one too, because the cap is checked against `planRound + 1`; its review and
  verify figures are counts of fix rounds done and are drawn as they arrive. The core's
  revision lines (`Plan round N`, `revising the plan (round N)`) and the replay's census line
  now count from one as well.
  The pilot's wake sentence names the counter of the gate it is held at (`wakeRound`): the plan
  round from one at a plan gate, the fix that just ran at `review-round` and `verify-round`,
  and nothing at a boundary with no round. It took `reviewRound ?? planRound`, and
  `reviewRound` is never null, so every plan gate was described by the review count.
- **A resume is pointed at the repository, and `dir` is not it.** `run_started`
  carries both and they are not interchangeable: `identity.dir` is the run's
  **own** directory — `<repo>/.vibe/runs/<id>` — and `identity.repo` is the
  repository. The footer's resume passed `dir`, so the command ran with
  `-C <run dir>` and the core looked for the run *inside itself*, answering
  `No run "20260915-201723-…" under .vibe\runs` about a run sitting there
  intact. `repo` was added to that frame for exactly this reason (#223) and this
  call site was never moved onto it; `1b`'s resume passes `repoDir` and was
  always right, which is why this survived — the footer's button is the one
  nobody had pressed.

  A run whose `repo` is null — an older core narrated it — is **told** rather
  than resumed into a guess, which is the existing "the loop never said which run
  it is" sentence widened by four words rather than a second mechanism.
- **A resumed run keeps the column it already had, and a stopped turn is part of
  it.** Two halves of one report: *"the previous plan, critique, code, etc rounds
  don't show up on the right bar. I want it to look as I just left it when I
  stopped the run."*

  `reduce` builds a `Run` from the frames **this process** narrates, and a resume
  narrates only what happens from the resume onward — so a run three plan rounds
  deep came back showing one, with every earlier round, census and turn simply
  gone. `resume` now **seeds** the column with `foldReplay` of the run's own
  narration before it sends the `invoke`, and the ordering is what makes that
  safe rather than racy: no live frame exists yet, so the seed cannot land on top
  of something the loop has already said. The ending is deliberately *not*
  seeded — `useReplay` applies it because a run you opened has ended and must say
  so, where a run you are resuming has not, and seeding `completed` would draw a
  halt banner over a run that is starting. A replay that fails costs the history
  and never the resume: the column simply begins empty, which is what every
  resume did before.

  `foldReplay` lives in `model.ts` and serves both callers, because two copies of
  that loop would be two answers to *"what did this run look like"* — the mistake
  the replay was built to avoid.

  And the replay now includes **failed** turns. A turn that was stopped, timed
  out or threw is charged through `chargeFailure` under `turn_failed` rather than
  as `claude_turn`, so a replay taking only the successful ones drew a run
  *missing the turn it stopped on*, which is the exact opposite of what was
  asked for. The killed implement turn above is the case: 14.2M tokens and
  fourteen minutes of work, absent from its own replay. A failed turn is
  attributed by the `provider` it records, and one whose provider this build
  cannot read is **skipped rather than misattributed** — putting a Codex turn's
  spend on Claude's side of the ledger is worse than a missing row.
- **A resume reads the project's file, and the rule that widens is recorded.**
  `state.config` exists so a resume does not silently revert a setting — a run
  started with `--max-question-rounds 5` used to come back at 3 the next time it
  was resumed without the flag — and that is still true and still worth
  preventing. What the stored config being the *only* base also did was make the
  settings screen useless at the one moment it is most wanted: *"if I adjust the
  number of maxQuestionRounds, maxPlanRounds, etc, that needs to apply to ALL
  runs (for example, if I need to bump that and continue)."* A run that stopped
  on a ceiling could not be resumed past it by raising that ceiling, which is the
  only reason anybody raises one.

  `withProjectFile` is the layering, and each layer is a stronger statement of
  intent than the one under it. The **stored** config is the run's memory,
  including flags from an earlier resume, and still supplies every key nobody has
  written down since. The **file** is a decision somebody wrote into a document
  their repository keeps, so a key it names wins over that memory — including
  over a flag from a previous resume, which was a one-off where this is standing.
  The **flags** on this invocation win over both, unchanged.

  It merges the **raw** object rather than a resolved config, which is what keeps
  it narrow: a file silent about `claude.model` leaves the run on the model it
  has been using, and `mergeSection` merges keys rather than replacing a section,
  so naming one cap does not reset the four beside it — that would be the silent
  revert this mechanism exists to prevent, arriving by a new route.

  Nothing is hidden by it, and the machinery for saying so already existed:
  `configDiff` compares this base against the effective config and records
  `resume_config` naming every key that moved, and `environmentStale` clears the
  probed facts when the role table shifts.
- **Every ceiling that can end a run is on the settings screen, and the pilot's
  is beside them.** A run stopped with *"a ceiling in `budget` was reached"*,
  named `budget.planShare`, and sat above a footer saying *"Settings has the
  caps"* — true of the round caps and false of these: *"I got this error but
  don't see anywhere to edit this in settings. All of these types of settings
  need to be editable."* The five `budget` keys are now a form beside the four
  `loop` caps.

  **Two of them are typed in units the file does not use**, and that is the same
  decision the quiet ceiling made: `maxTokens` is entered in **millions** because
  the run's own message quotes it as `25.0M` and a form demanding seven zeroes is
  the storage layer's units on the screen, and `planShare` is entered as a
  **percentage** because the message says `40% cap` while the file keeps a
  fraction.

  **The pilot's own ceiling moved here from beside the conversation** — *"move
  pilot tokens and pilot $/day out of pilot chat and into the same settings
  group"*. A ceiling is a setting, and one set beside the thing it limits was the
  only setting in the product with no home on this screen. What stays in the pane
  is the *reading* — what today has cost — because that is about the conversation
  in front of you. It is still `localStorage` and still this window's, which is
  the second of the three kinds the screen already names, and the copy says so:
  these bound the conversation, the two above bound the loop, and they never sum.

  `Cockpit` owns the value because the control and the enforcement are now in
  two sibling panes — the same arrangement the type scale has, and for the same
  reason: a change in Settings has to reach a pane that is already open.
- **A rate-limit wait is the one place a run spends real time with nothing to
  kill, and that made `stop` a no-op and the window unusable.** Reported as two
  symptoms that are one defect: *"I ended a run, and now I can't create a new
  one."* Codex hit 100% of its five-hour window, the loop narrated *"Waiting 15
  min"*, and the host log has nothing after that line.

  The wait was `new Promise((resolve) => setTimeout(resolve, ms))` — a bare
  timer with no knowledge of the cancel latch and no way to be woken. `cancel.ts`
  ends a turn by killing the **child** it is allowed to kill, and a sleeping loop
  has no child, so pressing stop set a flag nothing was reading. And because
  `serve.ts` holds its one-at-a-time gate for the whole of `main()`, the same
  fifteen minutes that ignored the stop also **refused every new run**. A wait
  the product will not interrupt locks the front door for exactly as long as it
  lasts.

  `sleepUnlessCancelled` lives in `cancel.ts` because that is where the latch is,
  and it returns **whether it slept** rather than throwing — so the decision
  stays at the call site in the loop, where every other ending is decided, rather
  than in a timer callback. A cancel that is *already* latched returns without
  sleeping at all, which is the fail-closed direction: a run being stopped must
  not spend fifteen minutes doing nothing first.

  **Waiters are deliberately not children**, though the shape is identical.
  `requestCancel` returns how many children it killed, and the whole meaning of
  zero is that the cancel arrived between turns and no work was discarded — a
  rate-limit wait *is* between turns, so counting one as a kill would report work
  destroyed where none was. So `registerWait` has its own set, woken after the
  kills and never counted among them.

  Two things travel with it. The loop **throws `Cancelled` itself** when the wait
  comes back woken, rather than letting the next turn's refusal do it: otherwise
  it would narrate `rate_limit_resumed` on a wait that did not resume, and
  announce a turn the latch is about to refuse to start — and `rate_limit_resumed`
  is half of what lets `7e` call this *waiting* rather than halted. And the timer
  is **cleared** on the way out, because a cancelled run holding an hour-long
  timer would keep the host from exiting, which is the same class of problem one
  layer down.
- **A stalled turn burned its whole ceiling, and the measurement to stop it was
  already on the wire.** The review turn wrote its last byte at 17:45:33 and was
  killed at 18:24:50 when `codex.timeoutMs` expired — **39m17s of total silence**
  during which the heartbeat fired seventy-eight times, each reporting the same
  `32 events`. Raising that ceiling would have bought a longer hang: the two
  limits answer different questions, one being how long a turn may *take* and the
  other how long it may say *nothing* while taking it.

  **The honest number came from measuring, not from picking.** The question that
  decides it is whether a long turn looks silent, and in that run it does not: an
  11m30 implement turn never went more than **32 seconds** without new activity,
  a 12m30 critique never more than **3m30**, and the stall was **39m**. An order
  of magnitude of separation. `progress.maxQuietMs` is **10 minutes** at the
  owner's decision — about three times the worst healthy gap — and the honesty is
  in saying what it rests on: one run, six healthy turns, which is enough to show
  the separation exists and is not the census `budget.maxTokens` earned its 25M
  from. That is why it is a setting, and why it is on the settings screen.

  `guardTurnQuiet` is `guardTurnSpend`'s shape exactly and inherits all three of
  its rules — it **cancels rather than throws**, so #209's latch kills the child
  and the loop turns it into the ending a round cap already takes; it kills only
  interruptible children, so `git` and the user's own verification gate are
  untouched and may be silent for as long as they like; and it introduces no new
  measurement, because `sinceOutputMs` has been on every beat since #223.
  `maxQuietMs: 0` disables it, the same shape `budget.maxTokens: 0` has, and a
  ceiling shorter than the interval that measures it is **refused by name**: a
  turn cannot be observed quiet for less time than the gap between observations.

  **The reporting half cost nothing and should have existed already.** The gap
  was measured, carried on the frame, and simply not in the sentence — so forty
  minutes of a dead turn printed `review-0: 23m30s · 32 events ·
  command_execution` every thirty seconds and the only evidence was a count that
  had stopped moving, readable by diffing two lines by eye. `formatHeartbeat`
  now says `quiet 18m20s`, second, right after elapsed. It appears only once the
  gap is `MISSED_TICKS` beats — **three, a shape rather than a duration**, the
  same constant and the same reasoning as `app/src/cockpit/model.ts`'s, which
  decides when `7c` calls a run stale. Duplicated across the two packages for the
  reason `src/raise.ts`'s markers are, and both comments name the other.
- **`externalBin` means every MSI build writes `%TEMP%\node.exe`, and anything
  running from there breaks the bundle.** `npm run app:build` failed four times
  with `failed to bundle project: The process cannot access the file because it
  is being used by another process. (os error 32)` — no path, no file name, and
  the exe itself built clean every time. It reads as a project problem and is
  not one.

  `bundle.externalBin` is `binaries/node`, and tauri-bundler's
  `generate_binaries_data` copies that 92.5 MB binary into the **temp directory
  with the target triple stripped** — `node-x86_64-pc-windows-msvc.exe` becomes
  `%TEMP%\node.exe` — before it writes `main.wxs` or copies the icon. `TEMP` here
  is cygwin's `C:\cygwin64\tmp`, and a Vite dev server was running out of exactly
  that image: `"C:\cygwin64\tmp\node.exe" node_modules\vite\bin\vite.js`. Windows
  holds a running executable's image against writes, so the copy is a sharing
  violation.

  **Three things about finding it are worth keeping.** The Restart Manager
  (`rstrtmgr.dll` — `RmStartSession`/`RmRegisterResources`/`RmGetList`, callable
  from PowerShell with `Add-Type`) names the holding process, which is the answer
  `os error 32` refuses to give; probing the project's own files found nothing
  held, which was the evidence that it was not the project. The one run that
  succeeded was nine minutes *before* that dev server started — so deleting
  `wix/` and `bundle/`, which is what got the credit at the time, had nothing to
  do with it. And the exe is unaffected either way: `tauri build` produces it
  before bundling, `cfg(dev)` is unset, and running
  `target/release/vibe-desktop.exe` is a real bundled build. The MSI only matters
  for updating an installed copy, which needs elevation anyway.
- **A console child spawned without `windowsHide` allocates a window, and the detach is why.**
  Reported as *"there are a whole bunch of windows that popup and quickly disappear when I
  run"*, and the count is exact: one `where.exe` per binary this resolves — claude, codex,
  git, node. Every long-lived spawn already passed the flag; the two PATH lookups in
  `proc.ts` and `commands.ts` did not, and before the host was `DETACHED_PROCESS` they
  inherited its window-less console and nothing showed. **So this is the second half of that
  change rather than a new defect** — the same reasoning `host.rs` records for why
  `CREATE_NO_WINDOW` is the wrong flag there is why `windowsHide` is the right one here. Worth
  remembering as a shape: **a detached parent means every console child must hide its own
  window, because there is no console to inherit.**
- **An interactive shell started in the background stops its whole process group** (#357).
  The login-shell probe (`shellenv.rs`, #272) runs `$SHELL -l -i`, and bash with `-i`, in the
  background of a terminal, sends `SIGTTIN` to its own group and waits for `fg`. An app
  started from a terminal shares that group with every host and run, so the first probe
  froze all of it: every process in state `T`, no CPU, nothing logged, and the probe's own
  timeout stopped with it. zsh does not do this, which is why it ran for an hour on a zsh
  account and froze when a test started `/bin/sh`. The probe now runs under `setsid()`, with
  no terminal at all. The shape to keep: **a child that may act interactive gets a session
  of its own**; when an app freezes with no CPU, check `ps -o stat` for `T` before suspecting
  a deadlock.
- **Prompts became configuration, and the reasoning that is being reversed is recorded.** The
  settings screen said they were *"deliberately not configuration: they are the product's
  behaviour, and a per-project override would mean two runs of the same version could not be
  compared."* That cost is real and is now paid on purpose — *"We need to be able to edit the
  prompts"* — because an owner who wants a reviewer under different standing instructions has
  no other way to get one, and the product knowing better is not an answer. What keeps the
  cost visible rather than merely accepted: `prompts.<block>` is a setting like any other, so
  `configDiff` names it and a run's record says its reviewer was told something different.

  **It is a module latch, not a parameter, and that is `cancel.ts`'s trade.** Every builder in
  `prompts.ts` takes a long positional list and three carry a comment saying an inserted
  parameter *"would silently reinterpret"* an existing call — so threading a config through
  seven of them is the change most likely to go wrong quietly. `execute` installs it beside
  `clearCancel()` and installs **unconditionally**, so an empty table is what clears it and no
  path leaves a previous run's overrides standing. Safe for the reason `cancel.ts` states:
  one run per process.

  Three rules travel with it. A **blank** override is ignored rather than sent — clearing the
  box means *give me the default back*, and an empty standing instruction is not a weaker one,
  it is a missing one. A **name this build does not have is refused by name**, because an
  unknown key would otherwise be an override that silently does nothing: `block()` finds no
  entry, renders the default, and somebody who believes they changed the reviewer's
  instructions finds out by reading a review that ignored them. And `promptBlockNames()` is
  **derived** from `promptBlocks()`, because a second list is one that can disagree.

  **Three storage places, and the screen says which is which.** The *default* is a constant in
  `src/prompts.ts`; the one *in force* is the project's config, because the loop has to read
  it; the *library* of saved versions is `localStorage`, because a draft nobody has adopted is
  not a fact about any run. Saving and adopting are separate controls for exactly that reason,
  and *use the default* **clears the key** rather than copying today's text into it — a cleared
  key follows the product forward when the default is improved.
- **The pilot's blocks are in the same section, and in-force is read off the config** (#420).
  `pilot: who`, `pilot: intake` and `pilot: how to read` are drawn under a *pilot* heading below
  the core's blocks, by the same `PromptBlock`, so adopt, *use the default*, the saved-version
  library and the "where it is stored" wording are one implementation, not two. Their defaults
  come from `app/src/pilot/brief.ts` rather than from the host, because the pilot's prompt is
  built in the webview and the core holds only their names; [pilot.md](pilot.md) has why each
  block is or is not editable.

  **What is in force is now taken from the config this screen read, for the core's blocks as
  well**, and that fixes a defect rather than restyling one. The `prompts` frame reports
  `promptBlocks()`, whose `text` and `overridden` are the core's run-time latch - and the host
  that answers Settings is the service host, which never runs a loop (processes.md), so its latch
  is always empty. Every block therefore read as *the default*, and after *use this* the reload
  re-seeded the box with the default text, as though the adopt had been refused. `inForce` in
  `brief.ts` resolves a block against `effective.prompts` with the host's `fallback`, the same
  rule `block()` applies (blank is the default) plus the fail-closed half: a value that is not
  text is not used, and the block says so with a *not used* badge.
- **Standing instructions are the person's text, not a prompt block** (#273). Asked for as *"a
  way to give vibe instructions it can remember across runs. Kind of like a global agents.md."*
  `instructions.text` is its own config key, empty by default, settable in the global file or a
  project's (a project's wins, and a cleared box writes `null` so the level below shows through).
  It is not a `prompts.*` block because a block is the product's text, with a default and a
  checked set of turns it reaches. `withStanding` in `prompts.ts` puts it in front of the prompt
  where it reaches stdin in **both adapters**, so every role and every kind of turn gets it with
  no builder edited, on every turn rather than a session's first, so a resume or a rotation
  cannot drop it. The pilot gets it in its system prompt on both roads. It is installed beside
  the prompt overrides, as the same kind of latch for the same reason, and `configDiff` names it,
  so a run's record says what its agents were told. What it adds over the vendors' own files is
  one text for both agents: Claude's seats read `~/.claude/CLAUDE.md`, Codex's read
  `~/.codex/AGENTS.md`, and the pilot reads neither.
- **A question is answered where it is shown, and the window writes the same file a text
  editor would.** The halt banner carried the CLI's own instruction — *"Answer the questions
  in NEEDS-INPUT.md, then resume the run"* — correct in a terminal and absurd in a window
  already displaying them: *"thats crazy, I should answer directly in the app on the questions
  page."*

  The tempting shape is a frame carrying answers straight into `state`, and it would be **a
  second definition of what an answer is**: one that skips `parseHumanAnswers`, skips the
  `answered-<n>.md` retirement and skips the raise and severity-move blocks in the same file,
  leaving `resumeRun` with two roads in that drift on the next change to either. So
  `src/answers.ts` fills in the blockquote the template already leaves empty, and the resume
  that follows is the ordinary one — **a person typing into the app and a person typing into
  vim produce the same file**.

  Matched on the **question text**, which is what both ends already hold: `writeEscalation`
  renders `### <n>. <question>` and `parseHumanAnswers` reads it back off that line. An index
  would be a third thing to keep in step and would silently answer the wrong question the
  first time a round's questions were reordered. A question the file does not ask is
  **reported, never appended** — the file is the record of what was *asked*.

  **The write does not resume.** Two acts, in that order, because a write that also spent
  tokens would be one nobody could take back and would put spending behind a Save button. The
  frame refuses a run with no `NEEDS-INPUT.md` (writing one would invent a halt) and a run
  whose lock names a live process (answering a file a running loop is about to read is a
  second writer). And the round trip is the only test that matters here: both halves of the
  format are in this repo, so checking the writer against a format written down in a comment
  would check nothing — every case drives `fillAnswers` output through the real parser.
- **A model is typed, never picked from a list**, and that is the core's own decision rather
  than a shortcut. `RoleSetting.model` is validated only for being a non-empty string because
  *"no allowlist and no default table: guessing whether a model exists is the
  never-invent-a-number rule applied to a name"*. A dropdown would be exactly that guess and
  would go stale the week either vendor ships a model — *"models are always evolving, we
  probably don't want these hard coded."* A typo is caught by the run summary before anything
  is spent, and by a turn failure naming `roles.<role>.model`.
- **The verification gates are a list on the settings screen** (#240). The one test-command
  field was the only control, so a two-package repository joined its suites with `&&` and lost
  everything named gates were built for (#47): which package broke, a flaky gate rerun on its
  own, a `required` and a timeout each. `app/src/cockpit/gateform.ts` holds the decisions and
  is pure. **Every save sends the whole list**, because `writeConfigPatch` merges one level
  deep and a list is replaced whole. **Converting is one write**: the command becomes the first
  gate, named `verification` like the gate the core synthesises from it, and the same patch
  clears `verify.command`, since the core refuses both at once; removing the last gate is the
  mirror. `tidyVerify` in `src/config.ts` drops the `null` the clearing leaves, so a converted
  file is byte-for-byte what a person would write. A new row is not sent until it has a name
  and a command; a saved row always is, so emptying it reaches the core and is refused in its
  words. `artifacts` stays file-only and survives a save. A command holding `\"` gets a
  warning showing what the shell would receive, because that is almost always a paste from JSON.
- **The review seats say what a blank field comes to, read from the config** (#448). The
  seats are `SeatList` over `app/src/cockpit/seatform.ts`, `GateList`'s shape. A blank
  minutes field shows the number it takes, by `seatResolved`'s rule in `src/roles.ts`:
  `claude.planTimeoutMs` for a Claude seat and `codex.timeoutMs` for a Codex seat. When that
  value cannot be read, the key is named and no number is shown. The quorum shows its count as
  it is typed (`2 of 3 (a majority)`, `quorumFor`'s `floor(n/2)+1`). The two quorums the core
  refuses are said beside the field, and the patch still sends what was typed. **Removing a
  verifier below a saved quorum resets the quorum to a majority in the same patch, and says
  so beside it.** The core checks the quorum against the list in the same config, so the
  remove on its own was refused and the row came back. Blocking the remove would make a person
  clear one field before they could take a row away. A finder's focus is a textarea on its own
  row, because squeezed into a column it showed three characters. The example chips add a
  phrase to it and the field stays free text, because `withFocus` hands it over as prose. The
  pane is capped at 96rem rather than 1024px; prose keeps its own measure through `S.note`.
- **The four caps and the tolerance are a form now, and P0 is stated as having no setting.**
  Every one was reachable only as a `--max-*` flag. `gate()` refuses a round with any P0
  before it looks at the tolerance at all — *P0 findings are never carried forward* — so a run
  cannot be configured to accept one, and a control would be a promise the loop does not keep.
  The numbers save **on blur**, because each save rewrites `vibe.config.json` and answers with
  the result: a patch per keystroke rewrites it five times to type `12`, and the intermediate
  `1` is a real, valid, wrong setting a run starting in that moment would take.
- **A plan-only run completes, and it now has somewhere to go.** The settled distinction
  stands — `planOnly` says there is no next phase, a `stop` gate is the resumable halt — and it
  left a dead end nobody had walked into until somebody did: *"after it stopped, I SHOULD have
  been able to continue, either with more planning or move on to implementation, but it didn't
  allow that. When I asked the pilot, it kicked off another run from scratch."* A new run is
  the **wrong** answer rather than a slow one: it re-derives a plan that already exists, and it
  carries none of what the plan phase settled.

  `continueIntoImplementation` in `run.ts` is the named act, reached by `vibe resume <id>
  --implement`, and it is deliberately not plan-only becoming resumable — folding the two
  together would make `vibe plan` report needing input on a run that produced exactly what it
  was asked for. It **changes what the run is**, once, so it is a decision somebody takes
  rather than a state the loop can wander into, and it refuses three ways with the reason: a
  run that was never plan-only, one whose plan has not cleared critique (converting it would
  skip the critique), and one reporting a finished plan while storing none. What travels with
  it is the whole point — the approved plan, the frozen acceptance bar, the P1s `carried` on
  tolerance and the findings the approving round `declined`.

  The rule lives in `run.ts` so both front ends check one copy; the `--implement` flag and the
  window's button only ask. `plan_only_stopped` is the narration that makes the offer
  possible — `planOnly` has been durable since `createRun` and was never said, so a window
  could not tell a plan-only run that **finished** from any other run that finished, and the
  two want opposite next actions. The offer is on the ending rather than by adding exit 0 to
  `RESUMABLE`: exit 0 is not a halt and must not start reading as one.
- **"Zero P1s" was being claimed over plans that carried some, and the guard was reading the
  wrong list.** `state.outstanding` is written by the final fix round, which a plan-only run
  never reaches — so it is empty on every one of them and the summary fell through to *"Plan
  cleared critique with zero P1s"*, four lines below its own `Plan accepted with 1 P1(s)
  carried into implementation`. The comment above that branch already stated the rule it
  broke: *"Never claim a spotless finish when a P1 was carried."* A plan-only run carries its
  P1s in `state.carried`; the two lists are about two phases and must stay apart.
- **The settings screen holds three kinds of setting and says which is which.** They are not
  interchangeable, and a screen that hid the difference would be lying about where a change
  goes: the **project's** (gates, roles) in `vibe.config.json`, meant to be committed; **this
  window's** (the type scale) in `localStorage`, this machine only; and **this machine's
  secrets** (the pilot's API keys) in the OS keychain — deliberately not the config file,
  which is committed and whose validator reports bad values *by name*.

  **And the project's kind has two files now** (#223). *"Some settings are global, like api
  keys, etc. Some are project specific, like the worktree command"* — the keys and the window's
  settings already were machine-wide, and what was missing was a way to say *my models, my
  budgets, my caps* once rather than in every repository. `globalConfigPath` is
  `%APPDATA%\vibe\config.json` or `$XDG_CONFIG_HOME/vibe/config.json` (else
  `~/.config/vibe/`), and it is **the same shape as `vibe.config.json`**, at the owner's
  decision: almost any key at either level, and the order is `DEFAULTS` → global → project →
  flags. A fixed split for **every** key was declined, because which settings are a person's and
  which are a repository's is not something this file can know for everybody — but the first cut
  let the test command and the worktree live in the global file too, and the report was *"we
  talked about moving some settings out of global and into project scope (e.g. test command,
  whether to use worktrees, etc)"*. `PROJECT_ONLY` in `src/config.ts` is the narrow answer:
  all of `verify` and the three `git.worktree*` keys describe how one repository builds and
  tests, so the global file refuses them by name, on read and on write. And the settings screen
  has **two doors rather than a switch**: *"I want the global settings to be accessed via the
  'settings' on the left bar… a settings icon on the project dropdown row… where project level
  settings live."* The left bar's ⚙ opens the settings for all projects, a project row's ⚙ opens
  that project's `vibe.config.json` (and points the window at it, so the row pressed is the
  project shown), and each draws only what may be set there — the test command and the worktree
  for a project, `auth`, `cli`, `pilot` and the type scale for all — with a line saying where the
  rest live. The ⚙ sits on the right with `＋ −`, because the arrow on the left is the disclosure.
- **A run a phone started, and a setting a phone saved, say so; nothing else gains a line**
  (#365). The other half of #344's gate attribution, and the same rule: only a `phone:` origin
  is named, read through `phoneOf` in `remote/origin.ts`, the app's one spelling of the prefix
  (`phone-attribution.test.ts` fails on a second one). The window's own invokes and saves carry
  no origin, and the pilot, the gate matrix and a terminal are not a person on another device,
  so calling any of them *from this desktop* would be inventing it (the phone's *from this
  desktop* is #347's).
  - **A run start** is folded off `run_started`'s `origin` into `identity.startedFrom`, absent
    rather than null as on the wire. It reads *Started from <name>*, or *Resumed from <name>*
    when the frame is a resume, because the frame is per invoke and a phone that resumed a run
    did not start it. It is drawn at the top of the rail, above the *Now* card, since the rail
    is what the cockpit draws of a run and the full column's identity header (which draws it
    too) is not on screen there. It stays for as long as the run is shown: it is a fact about
    the run, not a notice about a moment. A later `run_started` with no origin rebuilds the
    identity without it.
  - **A settings save** that arrives as `changed` for the file on screen (`configWriteFor`)
    reads *saved from <name>, and reread from the file*, under the heading where this window's
    own *saved to* line is drawn: the same fact with a different author, so the same place and
    weight. **It stays until something supersedes it, and never on a timer**: a save from a
    phone is made because nobody is at the desktop, so a note that faded would be gone before
    anybody came back to read it. It goes when the next save to that file lands (this window's,
    or another client's, which names that phone or nobody) and when the screen is left or
    pointed at another file, the lifetime the *saved to* line already has.

  Three things keep it honest. **The CLI reads it too**, through the one `loadConfig`, so a
  terminal and a window cannot disagree about what a run is configured to do; a resume layers it
  under the project's file over the run's memory, by `withProjectFile`'s own reasoning. **A
  global write is validated twice** — alone, so it is legal wherever it is read, and under the
  project in front of you, so a save cannot leave that project unloadable (a global
  `progress.maxQuietMs` shorter than a project's heartbeat interval is the case). And **the window computes
  nothing**: the `config` frame carries `globalRaw`, `globalPath` and `globalEffective` beside
  `raw` and `effective`, so the "all projects" view draws the defaults plus the global file
  without merging anything itself, and every value's chip — `default`, `all projects`, `this
  project overrides it` — reads two files the host sent. The global file is a machine's and is
  never committed; the project file still is.

  **Subscription against keys was two questions about two processes, and is now one per
  vendor.** It used to be that a run's agents were *always* your own subscriptions and only the
  pilot could take a key; that was reversed at the owner's word — *"we should use them
  everywhere"* — and `auth.<vendor>` now decides every child's billing (see the pilot notes
  below). `Credentials` said *"no provider configured — the pilot cannot run"* until #223, which
  stopped being true the moment the subscription backend landed and would have sent somebody
  to buy a key they do not need.
- **The type scale is a multiplier over the design's own sizes, not a second set of them.**
  Reported as *"the font is a little too small for me"*, and 13px body text is a decision the
  build spec made for one pair of eyes. `tokens.css` splits into `--size-*` (the design's
  stated px, which `audit:contrast` §8 reads and which any argument about type is about) and
  `--type-*` (the composed shorthand, `--size-*` times `--type-scale`). **Every size moves
  together**, so the ramp the spec chose survives being scaled and no two styles can drift.

  Browser zoom was the other answer and is worse here: it scales layout as well as type, and
  viewport units do not scale with it — so the `Modal`'s `max-h-[calc(100vh-44px)]` would
  compute in zoomed pixels and a dialog would be taller than the window at any zoom above 1,
  which is the exact defect that bound was added to fix.

  The auditor's parser had to move with the tokens, and the failure it was one edit away from
  is worth remembering: its old regex matched `600 13px/1.6` and would have matched **nothing**
  after the split — and "nothing" in a `Math.min(… ?? Infinity)` check is a **pass**. It now
  fails when a wrapping style cannot be measured, because a parser that silently stops finding
  its subject is worse than one that breaks.
- **`prompts` is a read frame that names no run, and what it declines to return is the
  design.** Asked for from the settings screen — *"the prompts being used for each turn should
  also go there"* — and a prompt in this repo is a **function of the run**: `planPrompt` takes
  the task and the prior-run index, `critiquePrompt` takes the plan it is judging, `fixPrompt`
  takes the findings and the diff. There is no "implement prompt" outside a run, and rendering
  one from invented inputs would be the fabrication everything else here is arranged against.

  What there is, and what a person reading a settings screen is actually asking about, is the
  **standing** part: the blocks every turn of a kind gets unchanged, returned verbatim from the
  same constants the prompts interpolate. So the screen quotes the product rather than
  describing it, and says plainly that the brief, the plan, the findings and the diff are
  assembled per turn and live in that run's own artifacts. They are not editable and are
  deliberately not configuration — a per-project override would mean two runs of the same
  version could not be compared.

  `usedBy` is the one claim a reader cannot check, because the interpolation sites are in five
  different template literals. `prompt-blocks.test.ts` reads `src/prompts.ts` as source and
  follows one hop through a helper — and it earned its place immediately, catching a `usedBy`
  that named the reviewer for `DEFERRED_MARK` when that block reaches the planner and the
  implementer through `formatFinding` and the reviewer never sees one.
- **A dialog cannot outgrow the window it is covering, and that is the other half of
  "Escape always leaves".** `.v-modal` had no `max-height` at all, so the height of a dialog
  was whatever its caller passed in — and a confirmation that put a run's whole brief in its
  title grew past the bottom of the screen and took its own Cancel button with it. A scrim is
  `position: fixed; inset: 0`, so that is not a stuck dialog, it is the stuck **application**
  the `Modal` header already warned about (#211), reached by a route that header did not
  cover: *"Trying to delete a run breaks the app. This screen pops up and I cant click out of
  it."*

  Three changes, and each is load-bearing on its own. `.v-modal` is bounded by the viewport
  and `.v-modal__body` scrolls inside it — **a wrapper rather than `overflow-y` on the dialog
  itself**, because the corner marks are positioned against `.v-modal` and a scrolling dialog
  would scroll two of the four out of view, and those marks plus the one shadow are what carry
  elevation in this palette. `min-height: 0` on the body is what actually lets it scroll: a
  flex item's automatic minimum size is its content, which is AGENTS.md's existing artifact-pane
  rule with the sign reversed — there the fix was to stop a child shrinking, here it is to let
  one. And **Escape moved to the window**, so the way out no longer depends on focus being
  inside the scrim, on layout, or on any control being reachable.

  **The bound is checked by `audit:contrast` §10 rather than by a vitest case**, because
  vitest stubs a CSS import to the empty string — `?raw` included — and that script reads the
  file. It is also the right home on the merits: a modal that bounds itself is a design-system
  invariant, not a fact about whichever screen last broke it. Same shape as §9, and found the
  same way: the rule that broke it was the **absence** of a declaration, invisible to a reader
  of the stylesheet. (`.v-modal` and `.v-modal__body` are utilities on `Modal` in
  `design/Surfaces.tsx` since the rework (#231), which is the file §10 reads now; the corner
  marks went with it, the scrolling wrapper and `min-h-0` did not.)
- **A run's name is its brief, so anywhere it becomes a heading it is previewed.** That is the
  text half of the bound above and the two are not alternatives — a modal that cannot outgrow
  the viewport is what stops the *next* long string breaking it, and a heading that is a
  preview is what makes this dialog readable. Every other surface drawing a task was already
  bounded by CSS (`.v-nav__title` and `.v-switch__task` by an ellipsis, `.v-ident__name` by a
  two-line clamp); a heading is the one case CSS could not cover, because the string *is* the
  heading.

  `preview()` in `projects.ts` takes the **first non-empty line** — a brief opens with its
  subject and the rest is the specification, which is what makes a first line a preview rather
  than an arbitrary prefix — and cuts that to `PREVIEW`, on a word boundary where one keeps
  most of the budget. It **only ever shortens**: a name already short enough comes back
  byte-identical, with no ellipsis to claim something was dropped. `PREVIEW` and `PLACEHOLDER`
  are truncations rather than measurements, the same standing as `SHOWN` beside them.

  **Nothing is hidden by it.** The delete confirmation shows the whole brief one row below the
  heading it previewed, in a box that scrolls — *"It should just be a preview and it needs to
  be scrollable just in case"* — and where a run has been renamed the dialog carries both, as
  two rows, because a name and a brief are two different facts. The rename box has the same
  rule applied one control along: it starts **empty** on a run that has never been renamed,
  with the preview as its placeholder, rather than seeding a one-line field with four thousand
  characters somebody then has to select-all-and-delete. Pressing ✓ on the empty box writes
  nothing, because empty already means *keep the task*.
- **An inline callback ref is not a one-off, and this one made a modal untypeable.** `Modal`
  focused its scrim with `ref={(el) => el?.focus()}` so Escape had somewhere to land. React
  detaches and re-attaches a callback ref on **every render**, because an inline arrow is a new
  identity each time — and the cockpit re-renders once a second off its own clock and again on
  every keystroke, since a controlled field's `onChange` sets state in the component above.
  One character landed and focus went straight back to the scrim: *"I can't type in the 'What
  are we doing' window, it keeps going out of focus when I try typing in it."* A mount effect
  is the fix, and Escape still works from inside the dialog because a keydown bubbles. Worth
  remembering as a shape rather than as a fact about one file: **a callback ref that does
  anything is a callback ref that does it on every render.**
- **Opening a run is reading files, and `viewing` is deliberately not a `Run`.** `reduce`
  builds one from frames, and a finished run's frames were narrated to a process that has
  exited — synthesising them would report finished work as running, which is the fabrication
  the whole model is arranged against. So the loop column, the spend readout and the footer
  stay with the live run, six panes follow the opened one, and a strip says which is which
  rather than leaving the window showing two runs and saying so nowhere. What repopulates:
  the plans, both reports, the questions and the code from the run's own artifacts; the output
  from its `transcript.log`; and the conversation from `localStorage`.
- **A project is a repository and a session is a run**, and that is the whole of the mapping.
  The sidebar's shape is borrowed — actions, **Pinned**, **Projects** with their runs nested
  and a `Show more` — but nothing the core owns is renamed: `archive` still answers per
  directory, `listRuns` still decides what a run is, and `rail()` in `squares.ts` is still the
  one place deciding which entries may be drawn at all. `app/src/cockpit/projects.ts` holds
  only what the *window* remembers, and it is allowed to because **which repositories you have
  open is not a fact about any run** — no run knows about a sibling project, and
  `vibe.config.json` is a file meant to be committed, so one machine's paths are the wrong
  thing to put in it. One repository typed three ways is one project: `dirKey` normalises case,
  separators and a trailing slash **for comparison only**, because what is stored is what gets
  sent to the host and the host has to open it.

  **A project inside another project's directory is drawn under it** (#223). A run
  started in a worktree points the window at the worktree, and `rememberRepo` added
  that path as a top-level project — so the run looked missing: *"it doesn't show
  up as a run under one of my projects"*, while it sat under a project named after
  a branch. `nestProjects` draws each one under its **nearest** containing project
  and changes nothing else: the nested row keeps its own archive, because
  `.vibe/runs` lives where the run was given, and a parent reading its children's
  archives would be a second answer to which runs a directory holds. The parent
  opens on `holds` — pointed here *or inside here* — or the run is in a closed
  folder exactly as before.

  **And the pilot can no longer make one.** `start_run` refuses any directory but
  the project's, with a sentence naming `git.worktree`, and the prompt says the
  same before it is needed. The hand-made worktree was the root of both halves of
  the report: the run's record landed in a tree somebody is about to prune, and
  the window followed the run into a directory with no conversation stored under
  it, so the chat that proposed the run **restored as empty** and the run then
  adopted nothing. Worktrees are vibe's job, and `src/worktree.ts` already keeps
  the archive at home. Nesting stays, for the projects an older build added.

- **A run exists from the moment somebody presses start** (#223). The core has
  nothing until the pilot's proposal is pressed and `createRun` allocates an id,
  and those two moments are a conversation apart — so the sidebar drew no row,
  and when the run started it arrived as a new one while the chat vanished:
  *"The run should appear on the left, under the project directly after hitting
  start… a new run shouldn't appear, its already there. Also, the previous chat
  history shouldnt go away."*

  `app/src/cockpit/pending.ts` is a **draft**: this window's memory, the same
  standing as a pin, never sent to the host and never a run id (`draft-…`). Its
  conversation is keyed by the draft id through the ordinary `chatKey`. Three
  rules carry it:

  - **Arriving at a draft is a read and leaving it for its run is a start**, so
    `opened` is true while a draft is on screen and false the moment it is let
    go of — which is exactly the pair `chatMove` already distinguishes: a new
    draft restores its own empty conversation instead of adopting the one on
    screen, and the run adopts the draft's. Nothing new was added to the rule.
  - **Only the pilot's `invoke` can claim a draft.** Resume and implement go
    through `launch` too, so the draft id is passed rather than read, held in a
    ref, and `bindDraft` refuses a draft that was not launched or is already
    claimed. A run started some other way never swallows a draft that happened
    to be open.
  - **The brief is said one commit later.** Pointing the pane at a new draft
    makes it load that draft's conversation in a child effect; a brief handed
    over in the same render would be sent on top of the previous conversation.
    `queued` holds it until the pane has switched.

  The draft row is drawn until the archive lists the run it became, then
  forgotten, so there is never a draft and its run side by side. Discarding one
  confirms, because the conversation is the only copy.
- **The output is cut into rounds, and every boundary is told.** `1c` asks for output filtered
  by phase, and a *filter* is not a *structure*: it shows one phase by hiding the rest, so
  reading a run end to end meant clicking through every phase and holding the order in your
  head. `outgroups.ts` cuts on `phase` **or** `round` changing, both stamped on the line by
  `reduce` from `phase_started` — never read out of a sentence, which is the English-matching
  #133 exists to prevent and which would cut a group wherever the word *plan* appeared. Groups
  are **consecutive**, so re-entering `implementing` after a review gives two code groups in
  the order they happened; gathering them under one heading is the merged-card mistake in a
  log. `OutputLine.round` is new and exists for exactly this: grouping on the phase alone puts
  every plan round of a long run under one heading.
- **A finished run's narration is prose, and is read as prose.** `transcript.log` carries no
  ids, no phases and no rounds, so it is one group and says so. What *is* parsed is the level
  and the timestamp, because `log.record` writes both and this repo controls that format —
  reading it back is not pattern-matching on English. A line matching neither is a
  continuation, a stack frame under an error, and is kept whole: dropping it would silently
  shorten the one record of a run nobody is narrating any more.
- **Conversations are files the host writes, because `localStorage` filled up and said
nothing** (#223). WebKit caps `localStorage` at about 5 MB per origin. A pilot chat that
reads files and runs commands grows by tool results, and one ERM chat alone reached
2.16 MB. At 5.24 MB in total every save failed inside a `try` that swallowed it. For
three days each reply lived only in memory, and a click on another run replaced it with
the last copy that had saved: *"Have I lost my pilot chats?!"* The CLIs' own session
logs still held every turn, and the chats were rebuilt from them by hand.

`src/chatstore.ts` keeps one file per conversation under `$VIBE_APP_DATA/chats`. Rust
sets that variable to the app's data directory. Files are named by a hash of the key,
so a key never becomes a path, and are written via a temporary file and a rename.
`app/src/pilot/chatstore.ts` is the window's synchronous cache in front of it, with
writes debounced per key. Three rules travel with it:
- **Nothing restores or saves before the first read.** Saving an empty conversation
  over one not yet read is the same loss by a new road.
- **The migration out of `localStorage` removes a key only after the host has
  confirmed it.**
- **A failed save is drawn in the pane.** The swallowed failure was the whole defect.
  This bullet once ended *"everything else in `localStorage` is small and stays where it
  is"*. That was wrong, and the next paragraph is why.

**Everything else the window remembers is files too, because a small store could still be
refused whole** (#223). On 2026-10-06 the app came up looking factory-reset: no projects, no
repository, an empty ledger. All eleven remaining keys were still on disk, 29 KB of values,
but WebKitGTK's storage file was **5,267,456 bytes**. Deleting the migrated chat keys had
freed 1,275 pages and sqlite never shrinks a file on its own, so the file stayed just over
the 5 MiB per-origin quota, and WebKit then refused the origin's **whole** storage: every
read came back empty. The page cannot compact that file, so the size of what is *stored*
was never the measure that mattered. `VACUUM` with the app closed brought it back, and the
durable fix is for nothing the product needs to live there.

`app/src/memory.ts` is the window's half and `memoryDir` in `src/chatstore.ts` the host's:
one file per key under `$VIBE_APP_DATA/memory`, the chats' format and rules exactly, in a
directory of its own so the `chats` read stays a list of conversations. The `memory_save`
frame refuses a `vibe.chat.` key, so one conversation cannot be reachable by two roads. Four
things carry it:
- **It loads before the cockpit mounts.** Every reader is a `useState` initialiser or an
  effect that wants the value now, so `main.tsx` awaits `loadMemory()` and renders after.
  `memory` keeps `localStorage`'s three methods, which made each call site a one-word change.
  Rewriting twelve reads around a promise would have been twelve chances to draw a default
  and save it over the stored value.
- **The move removes a `localStorage` key only after the host has confirmed it**, and an
  entry the host already holds wins. A key that will not move stays, is read from there,
  and the sidebar says so.
- **A host that cannot be read is the old behaviour, said.** After a few retries, because
  the host may still be starting, the window falls back to `localStorage` for that launch
  and writes nothing to the host it never read. The sentence is drawn at the foot of the
  sidebar.
- **The ledger's store is injected**, because `ledger.test.ts` pins its imports to keep any
  route to the core's charge seam out, and `memory.ts` reaches the host client.
  `memory.test.ts` globs the app's sources and fails on any other module that touches
  `localStorage`.

What this does **not** do is rescue an install whose storage file is already over the
quota: the page reads nothing from it, so there is nothing to move. Compacting the file from
Rust before the webview opens would. It was offered as the short-term fix and not built.

**A command's output is on disk too, and so is where the window was pointed** (#223). The
two other things that lived only in memory after the chats moved: the host held every
command's output in a 256 KB buffer and took it with it, so a relaunch emptied the Commands
tab and a dev server that fell over in the night left nothing to read; and every relaunch
landed on the pilot with no run open.
- **`src/commandlog.ts` writes `$VIBE_APP_DATA/commands/<id>.log`**, appended as output
  arrives and uncapped, plus `<id>.json`, the record without its output, rewritten
  atomically at start and at end. `serve()` reads them once, before anything starts, and
  `commands_past` answers with what it read. The newest `COMMAND_LOGS_KEPT` are kept: a
  retention choice, counted in commands because a reader looks for *the one from last night*.
- **Ids continue past the highest on disk**, so `cmd-3` means one command across launches. A
  restored conversation holds `read_command` calls by id, and without this they would have
  read whatever this process happened to start third.
- **`stopAllCommands` writes each ending itself**, because `process.exit` follows at once and
  no `close` handler will run. A record still marked running at start-up belongs to a host
  that died without a word, and it is `lost`: `endedAt` stays null, since nobody measured an
  ending, and `isRunning` is the question every caller asks.
- **A restored command never wakes the pilot.** Its ending was news to a conversation that is
  over.
- **`app/src/cockpit/where.ts` keeps the open run, the tab and an open draft** in
  `localStorage`, as a pointer: opening a run is a read, so coming back to one costs what a
  sidebar click costs. A draft is restored only while it still exists. Collapsed panels are
  still not kept, for the reason above.

**A conversation is kept between launches, and it is not run state.** `app/src/pilot/saved.ts`
  keys it by `(project, run)` — a run id is unique only inside one archive, the same reason a
  pin carries both. The conversation that exists *before* a run is the one that will **propose**
  it, so it lives under the project alone and is **adopted** when a run starts; restoring the
  new run's empty conversation at that moment would throw away the exchange that decided what
  to build, at the exact moment it succeeded. A turn that was streaming is never written and
  never restored: it has no vendor behind it, and drawing a pulsing card for a request nobody
  is waiting on is the stall the thinking indicator exists to avoid claiming. It is
  `localStorage` and never the run's directory — `src/charge.ts`, `src/types.ts` and
  `src/orchestrator.ts` contain no `pilot`, and a run's `state.json` is byte-identical whether
  the pane was open or shut (#145).
- **A pin carries its title, and that is not a cached measurement.** A pinned run is drawn
  whether or not its project is expanded, so storing the task with the pin is what avoids
  reading every archive at launch to render four rows. It is safe for one reason and it is
  worth stating: **a run's task never changes** — it is what the run was started with, written
  once. Nothing is computed from it and it is not a number.
- **The footer names the next place a run *can* stop, and the objection it overrules is
  answered rather than waved away.** The old comment refused a next stop because it *"would
  need a phase-to-boundary ordering written here"*. Both halves are still true and neither
  applies: the order arrives on the `config` frame as `GATEABLE` — whose own comment reads
  *"Order is the loop's, not the alphabet's"* — and the position is the last boundary that
  actually **held**, not a phase mapped onto one. What it can still be wrong about is that the
  loop may pass a boundary without reaching it, so the wording is *can stop* and never *will*.
- **The runs are a column and the loop is on the right, and both put away rather than
  vanish.** The window is `rail · runs · pane · groups`, at the owner's decision (#223). `1b`
  was a *tab*, which made the archive something you left the run to look at, and the loop
  column was on the left where the design draws it — the report was that the two were the
  wrong way round: the runs belong beside the rail they are drawn from, and the loop belongs
  beside the pane whose rounds it names. `SidePanel` was one component for both edges, because
  two implementations of *standing context you glance at* drift in the way nobody notices —
  you are never looking at both edges at once. **Collapsed is a state, not an absence**: a
  shut panel keeps its strip, its mark and its name, so the way back is where the panel was.
  Neither was persisted, deliberately — a collapse was a gesture for the next few minutes.
  The rework (#231) replaced `SidePanel` with resizable panels and reversed that half:
  with real drag handles an arrangement is a setting, so `cockpit/where.ts` keeps the sizes
  and which panels are shut.

  **The width is the exception, and it is on the same side of that line** (#223): *"The two
  side bars (left and right) should be width adjustable when open."* An open panel's inner edge
  is a handle — drag, arrow keys, double-click for the design's 364px — and the width **is**
  kept, per edge, because how wide you like a column is a preference set once, like the type
  scale. This overrides `HANDOFF.md`'s *"364px, fixed"* at the owner's word, so the comments
  that say *"a 364px column"* describe the default, not a guarantee: anything in a side column
  must still fit at 240px, the floor. The ceiling is half the window, so the main pane cannot
  be squeezed out, and a window made narrower pulls a wide panel back with it.
- **A tab's count is how many things are behind it, and never a property of them.**
  `Plan critique · 2` was two blocking findings and was read as two critiques, which is the
  reasonable reading, since every other count in that bar — Code, Questions, Verify, Commands
  — is a number of items. `blockingIn` went with it rather than being kept for a better badge:
  the four counts and the tolerance that decided them are already drawn on the round they
  belong to, which is the only place they mean anything specific.
- **`overflow: hidden` on a flex item is what stopped the artifact panes scrolling.** Every one
  of them sets `flex: 1; min-height: 0; overflow-y: auto` on itself and none of it did
  anything, because a section inside them is a flex item whose automatic minimum size the spec
  resolves to **zero** when `overflow` is not `visible` — so a section holding a nine-page plan
  shrank to the space left and clipped the rest, the pane never overflowed, and the pane
  therefore never scrolled. `flex: none` on the section is the fix — `flex-none` on
  `Disclosure.tsx`'s `<section>` since the rework, which replaced `.v-sect` — and the clip
  stays (`overflow-clip` there), because it is what clips the head's hover ground to the border. Worth remembering as a
  shape rather than as a rule about one class: **a scrolling column's children must not be
  allowed to shrink**, and one with `overflow` set will shrink to nothing without saying so.

**The planner never had a `ctx%`, and the fix borrows a denominator rather than inventing
one.** `promptTokens` is measured live off Claude's stream on every heartbeat; the context
**window** arrives only on a turn's *result* envelope. So the first Claude turn of a process
has a numerator and nothing to divide it by — which is the planner, every time — and context
occupancy only ever appeared from the second turn onwards. `seedContextWindows` in
`src/context.ts` walks `.vibe/runs` newest-first and takes the window off the first run that
recorded one.

It is allowed under *"never invent a number"* because it is a **measurement**: a figure Claude
reported on this machine, under this exact model name, written by vibe into `state.json` and
read back. It is not guessed from a model name, not scaled from another model's window, and
not read from a table. Three things keep it honest. It **stops at the first run that measured
anything** — that run is evidence about how this checkout is configured now, and if it names a
different model there is no evidence and none is taken. It **fills a gap and never
overwrites**, so a figure this process measured is never replaced by an older one. And the
first real turn overwrites it through `recordTurnContext`, so a window that moved between
releases is wrong for at most one turn.

**The scrollbar is global, and the class it replaced is why.** `.v-scroll` was an opt-in and
almost nothing opted in — every pane sets `overflow-y: auto` itself — so the product scrolled
with the platform's own light gutter down the side of a dark window. The rule is in
`design/theme.css` now (#237). This paragraph used to describe a 4px thumb in an 8px gutter,
clipped by `background-clip: padding-box`; that was `base.css`'s rule, and the 2026 redesign
(#226) laid a 6px gutter and a 6px `--rule-strong` thumb over it in `workspace.css`, which won
the cascade and reset the clip. The sweep merged the two into the one set that was actually on
screen rather than restoring the one this file described. The track is transparent: a
permanently drawn one is a vertical rule down every pane, which reads as structure.
