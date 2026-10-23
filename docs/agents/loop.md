# The loop

Part of the working notes for this repo; [AGENTS.md](../../AGENTS.md) is the core and links here.
Moved out of AGENTS.md word for word on 2026-10-20, so where a note says *this file* it means
AGENTS.md and these companions together. Read this before changing the code it describes, and
update it in the same PR when that code changes.

**One setting decides where the loop hands control back, and it means the same thing in
both front ends.** `src/gates.ts` holds the matrix; `cfg.gates` is a mode per boundary, and
the difference between the two modes that hold is *what a hold costs*. `step` holds and asks
— free, because the app runs the loop in-process and the hold is an `await` — and a terminal
cannot answer a promise, so from the CLI a `step` row runs through. `stop` asks nobody: the
run ends there, resumably, whoever is listening, which is what makes gates usable from a
terminal for the first time. `vibe doctor` prints the effective table, including which rows a
terminal will honour, because the only other way to learn that is to run and not notice.

**The default holds in four of the six, and where that line falls is the decision** (#211).
#140 shipped every row `step` — what the loop did before there was a table — and said so in
`DEFAULT_GATES`'s own comment: *"very probably not the default anyone wants to keep, but
changing it is a decision for whoever has the settings screen in front of them."* The report
from somebody who had one was exact: *"remove the holding at the end of a plan round; we
should only do that if I choose to."*

The six are not one kind of decision. **`plan-round` and `question-round` are the loop
arguing with itself** — the planner rewriting after a critique, the answerer taking its turn —
and each is followed by another machine reading the result, because the critic reads every
revision. Holding there asks a person to referee a draft that is about to be refereed, on
every round of every run, with nothing written and nothing committed. **The other four are
where the run's cost or its output changes hands**: `plan-approved` is the last gate before
code is written, `implemented` the first sight of a diff, `verify-round` a gate that failed,
`review-round` findings and the fix turn they buy. Those keep `step`.

Nothing became `stop` by default, and a test pins that separately. A wrong `step` costs a
pause somebody releases; a `stop` **ends the run**, whoever is listening, so a default that
did it would end CLI runs nobody was watching.

Two boundaries have no row, and `GateableBoundary` makes that unrepresentable rather than
conventional: `complete`, because a gate holds before the next thing and there is none, and
`final-fix`, because the loop goes straight back to the verification gate to prove that fix
broke nothing. A `vibe.config.json` is not TypeScript, so both are also refused **by name and
with their own reason** — `mergeSection` would have dropped the key in silence, and someone
who believes they armed a gate finds out by watching a run go past it.

**A pause is one hold, and deliberately not a seventh mode** (#210). `AGENTS.md` has said
since the app landed that pausing is free — the loop runs in-process, so a hold is an `await`
at a boundary it was crossing anyway and both agent sessions stay warm. The mechanism was
real; **the control did not exist**, and the only way to make a run hold was to hand-edit
`cfg.gates` before starting it. The `pause` frame arms one hold, `Host.takePause()` consumes
it at the next boundary, and `holdAt` takes it **before** acting on the mode and **whatever**
the mode is — a boundary that read it, ran through on `auto` and left it armed would hold at
some later boundary nobody was looking at, which is indistinguishable from a stall.
**And it belongs to one run** (#253): `serve.ts` clears it when a run's command returns, so
a run that stops or finishes before any boundary does not leave the next run to hold for a
request nobody made of it. A pause asked for before a run starts still holds that run.
**And it can be taken back** (#276): `unpause` clears the armed hold and answers whether there
was one, `exit 0` or `1`, so *too late* (the boundary already took it, and the run is holding)
is told rather than raised. While a pause is armed, the window's control reads **Cancel pause**.

Three things it is not, each for its own reason. Not a **gate mode**: `cfg.gates` is the run's
standing answer to where control comes back, decided before the run starts, and a mode would
mean a run's configuration changed underneath it. Not a **`Decision` member**: a decision
answers an `ask` that is already open, and the point of a pause is to be asked for when no
gate is holding. And not a **stop**: `gate_waiting` carries `requested` so a window can tell
the two reasons for a hold apart, because a control that blurred *hold at the next boundary,
free* with *kill the turn in flight* would let somebody end a run believing they had paused it.

**A stop kills the turn in flight, and it is not a second way for a run to end** (#209).
Every other ending waits for a boundary — a `stop` gate row ends the run at the next
checkpoint, a round cap raises an `Escalation` between turns, `shutdown` is documented as *"not
a kill"* — so until now the only way to end a live turn was to kill the process.
`src/cancel.ts` is the latch, `RunOptions.interruptible` is what it may kill, and `execute`
turns it into the ending a round cap already takes: `needs-input`, `EXIT.NEEDS_HUMAN`, a
`NEEDS-INPUT.md` naming why, and a process that leaves under its own control so `ending.json`
says vibe stopped rather than that it died. A cancel exiting some other way would reopen the
exact ambiguity #131 closed, with a button attached.

Four things about it are load-bearing:

- **A module latch, not a token threaded down.** A cancel has to reach a child that is already
  spawned, several layers below whoever asked; a parameter on every function between them is a
  place for a future call site to forget it, and a turn silently uncancellable is worse than no
  cancel at all because the button is still there. It is safe because of a rule that already
  exists and is enforced elsewhere: **one run per process**, which `src/lock.ts` is written
  expecting and `serve.ts` enforces.
- **It kills only what it was told it may.** `git`, the verification gate and the app-server
  client all go through the same `run()` and none is interruptible. A `git commit` killed
  mid-write leaves an index a later resume has to recover from, and the gate is the **user's
  own command** — a suite killed half-way is a `failing` verdict about a run nobody completed.
- **It latches, and the next agent child refuses to start.** The killed turn's error travels up
  through the retry logic and the loop's handlers, any of which could decide to have another
  go. `execute` calls `clearCancel()` on the way in, so a latch never survives into the next
  run in the same process.
- **The confirmation states the cost in the tool's own units, and the cost is not a re-send.**
  A killed run resumes its conversation by session id. What a stop destroys is the turn in
  flight: its spend is charged anyway and the turn is redone. `"Unsaved work may be lost"` is
  the sentence people learn to click through; a token figure is checkable. A **Codex** turn
  killed mid-flight reports no usage at all, so that row says the spend is unknown and why
  rather than showing `0 tok`.

**A question round is not a plan round, and the loop column said so before the core did**
(#223). `revisePlan` advanced `state.planRound` on every revision, so a plan revised because
it answered the planner's *own* questions was counted as a round of the convergence loop — and
the report was exact: *"plan round 0 has a critique, then plan round 1 asked questions, and
when those questions were answered it moved to plan round 2."* The column's own question panel
has read *"a question round produces no critique, so it cannot advance the plan round"* since
it was drawn; the core disagreed with its own screen.

It was never only a renumbering. `guardProgress` measures `planRound` against
`loop.maxPlanRounds`, so **every question round spent one of the rounds the run had for
disagreeing with the critic** — a run allowed five plan rounds and asking three rounds of
questions had two critiques left, and nothing said so. `loop.maxQuestionRounds` already caps
that loop and is the cap that should.

`advancesRound` is the one-line rule: a revision answering **findings** is the producer's side
of the next round, because something judged version N and this is version N+1; a revision
answering **answers** is not, because nothing judged anything. Three things travel with it:

- **The answerer's turn is keyed by the question round now.** `answers-<planRound>.json` could
  only ever be unique because every question round advanced the plan round, so fixing the one
  broke the other: two question rounds under one plan round both wrote `answers-0.json` and
  the second silently replaced the first. The question round is monotonic for the whole run
  and is the counting the turn actually belongs to, so the first is `answers-1`. A
  non-advancing revision is labelled `revise-q<n>` for the same reason.
- **`plan-<n>.json` is the plan of record for round n**, which is the version the critic
  judges — so a non-advancing revision replaces it and `refusePlaceholderPlan` goes on citing a
  file whose contents are the ones it read. What that costs is the draft that raised the
  questions, stated rather than hidden: the questions and the answers that changed it are both
  durable in `answers-<question-round>.json`, which is the half a reader is actually asking
  about.
- **The checkpoint is named for the boundary it crossed**, so a question round leaves two
  `question-round` snapshots rather than a `question-round` and a `plan-round`. Two in a row is
  the honest shape — both are inside one question round, and the second is the only snapshot
  carrying the revised plan, which is what stops a fork buying that planner turn twice. It
  does not hold: the caller held at `question-round` a moment earlier with this round's
  questions attached, and the one path that reaches it without a hold in front of it is the
  resume consuming `NEEDS-INPUT.md`, where halting again before running anything is a resume
  that did not resume.

**And it is one card, because the loop re-enters the phase it is already in.** Fixing the
*number* left the *shape* wrong in the other direction: `revisePlan` announces `planning`
again when it revises against its own answers — correctly, a phase did start — and `reduce`
opened a second group for it, so the column and the pilot's log each drew two boxes for one
plan round. `reEntered` in `app/src/cockpit/model.ts` is the rule, and both of its clauses are
load-bearing. It tests **the most recently opened group**, never any group with a matching
round: a fix round re-opens `implementing` at the same review round and the review that asked
for it is in between, so nothing merges there. And it requires **both rounds stated**, because
a null round is the loop declining to number a phase rather than evidence that two groups are
one — which leaves an older core drawing exactly what it drew before.

What the merged card gains is the whole question round in one place: the draft, the answerer's
turn and the revision. What it costs is that the card now holds two planner turns with nothing
saying why, so `RoundCard.questions` is attached by arrival through the same `during()` a
census goes through. It is a count and a link rather than the text — the column is 364px and a
question is a paragraph — and the Questions tab is where the text is, one section per round.

**`vibe plan` is deliberately not a row.** #140 asked for `planOnly` to resolve to
`gates['plan-approved'] = 'stop'`; it does not, because they are two different things rather
than two mechanisms for one. `planOnly` says there is no next phase, so the run *completes* —
exit 0, `status: 'planned'`. A `stop` gate says a full run halts before implementing — exit 2,
`needs-input`, and `vibe resume` finishes it. Folding the first into the second would make
`vibe plan` report needing input on a run that produced exactly what it was asked for.

**A decision may say who shaped it, and only then is it recorded.** `readOrigin` in
`src/host.ts` reads an `origin` off the same answer `readDecision` reads, and the two fail in
opposite directions on purpose: an unreadable *decision* stops the run, an unreadable *origin*
is dropped. `gate_released` is narrated but not recorded — the durability rule in
`recordAndSay` — **except** when it carries an origin, because "who released this gate" is a
question a later reader has and an unattributed release cannot answer it. A person pressing
continue still leaves the archive exactly as it was.


**A severity is a claim with an owner, and until #141 nothing recorded the owner.** Every
`Finding` came from `parseFindings` reading a model's structured output, so "absent means an
agent said it" was true by construction and therefore never written down. `Finding.raisedBy`
is that field, stamped by `groundAndRecord` — the single point both writers pass through, and
the only place that knows which role produced the report. `refusePlaceholderPlan` stamps
`vibe`, because a mechanical fact about an artifact on disk was previously indistinguishable
from the critic's own P1 about the same defect. **Absent still means absent**: every finding
in every existing archive has none, so `authorOf` narrows and returns null rather than
guessing, and a renderer that cannot name the author names nobody.

**A pointer can be two pointers joined by a dash, and `isPlaceholderPlan` now splits before it
matches.** A run on 2026-09-10 returned `n/a — see below` as the whole of `plan_md`. Both
halves were already in `POINTER_BODIES` and the line matched neither, because the match is
whole-line — so the stub reached the critic, and the critic is not the thing that catches
this. The widening is to test **every clause** of a line rather than the line, and what makes
splitting safe is that *all* the clauses have to be pointers: `well-defined approach` divides
into two of which neither is one, so a real line is never refused for containing punctuation.
A dash counts as a divider only when surrounded by spaces, which is what keeps `n/a` and
`read-only` whole. It stays exact equality per clause for the reason the list gives in its own
comment: a real plan may say "see below" in a sentence, and a substring rule would refuse it.

That field is what makes a human finding possible without corrupting the record. `src/raise.ts`
holds the whole surface: a block appended to every `NEEDS-INPUT.md`, parsed on the same resume
that reads the answers, merged into `pendingFindings` rather than replacing them. Four things
about it are load-bearing:

- **Grounding runs; the inert guard does not.** A `*File:* src/run.ts:120` is an `Evidence`
  entry of kind `code`, so `checkEvidence` is nearly a no-op on one — but running it keeps one
  path instead of two and catches a line typed by hand that does not exist. `downgradeInert`
  is a statement about a *turn*, and a human finding has none behind it.
- **The gate counts it and the oscillation census does not.** A person can block their own
  run, so `p1Tolerance` is no longer purely a judgement about the reviewer. The census is taken
  from the review report and a raised finding is never in one, so the exclusion is structural;
  what replaces it is `finding_reraised`, one sentence naming an id a human has raised before.
- **Refuse, never repair, and note which way that points.** A block somebody began and did not
  finish stops the resume. Defaulting the severity would put a claim nobody made into the one
  record that exists to say who made which claim; dropping it would lose a person's work in
  silence. Nothing has been spent at that point and the file is still there.
- **No host frame.** `src/host.ts` says every `Decision` member that mutates run state needs
  its own validator before it is offered, and a `raise` member is exactly that. `acceptRaised`
  is the seam one would call, so there is one definition of what a raised finding costs and
  what it is checked against — not two.

**A severity can move both ways, and only a person moves it back** (#142). Until then it moved
in exactly one direction, was written by exactly one function, and could never be moved back:
every `Finding.downgraded` in the product came from `toP2` — a machine, always landing on P2,
always for a mechanical reason, permanent. That is right for a rule running unattended, and
it is also why a P1 that was **true** and cited a file the reviewer described from memory is
demoted for the same reason a false one is. The only thing that can tell those apart is a
person reading the finding, and they had no way to act on it. Four things carry the design:

- **`move` in `src/evidence.ts` is the one construction every severity change goes through**,
  and the reason it is shared is `from`: captured from the finding at the instant of the move,
  so no caller can name a severity it never had. `toP2` is now the guards' wrapper around it —
  widened rather than joined by a third path, which is what the issue asked for.
- **A restore is not a downgrade, and must not be written as one.** `downgraded` is the
  guards' field and is never rewritten or cleared; `severityChanges` is the person's,
  append-only. Two questions with two answers — *did a guard fire, and why* and *how did this
  reach the severity it has* — rather than one answer serving both. Overwriting `downgraded`
  on a restore would erase the fact the guard fired, which is what #48 added it for.
- **`by` is `FindingAuthor`, not a second vocabulary.** #141 answered "how does this record
  name a source" on the same record; a parallel enum a month later is how two fields come to
  disagree about what `human` means.
- **The same answers as #141 on the two shared questions.** The gate counts it — a restored P0
  blocks whatever the tolerance says. The oscillation census does not, and here for a
  different structural reason: it is taken from the review report at the moment the round was
  recorded, and a decision made afterwards does not rewrite history.

**The round's own `code-review-N.json` is deliberately not rewritten** when a severity moves.
It is the record of what the reviewer produced, and editing it afterwards makes it a record of
something else — the same reason #141 keeps a human's finding out of it. The changed findings
land on `state.pendingFindings`, which is what the next round reads, and in their own
artifact; both hold `downgraded` and `severityChanges` together, so the issue's *"shows both
transitions and names who made each one"* is satisfied on the artifact that holds the finding
after the change rather than on the one that predates it.

**A gate that fails has more than one sample, and a flaky suite is told apart from a broken
one** (#135). `verify.runs` has defaulted to 3 since the gate existed and `config.ts` argues
it as a coin flip — but that reasoning is about *catching* a flake, and the loop returned on
the first non-zero exit, so `runs: 3` meant *up to* three and **a failing run reported
`runs: 1`**. The failure path now runs the remaining attempts; the pass path keeps its
short-circuit and costs exactly what it did. Three things about it:

- **The verdict is whole-gate, and that is option 1 of the three #135 offered.** `vibe` reads
  exit codes and parses nobody's reporter. A per-test table means tracking TAP, JUnit XML and
  `node --test` output forever — a standing maintenance liability bought for a column in a UI,
  where the *prompt* is what saves the round. `verdictOf` answers `flaky` only on at least one
  pass and at least one failure of the same command against the same tree, `failing` on all
  failures, and **`unrun` on no attempts** — which is every gate outcome in every existing
  archive, and must read as "cannot tell" rather than as a verdict. A `runs: 1` gate that
  failed is `failing` and never `flaky`: one sample says nothing about determinism.
- **`describeFailure` and `suggestedFix` live in one module** so the detail and the fix cannot
  disagree about which kind of failure this is. The flaky fix names the three cheap ways to
  make a noisy gate green — loosen the assertion, add a retry, add a sleep — because a model
  asked to make a command pass will find all three, and all three leave the race in the
  product.
- **A flaky gate still blocks, and an unlaunchable one still short-circuits.** Retrying or
  excluding a flake hides a defect in the suite; re-running a command that could not start
  buys nothing, since no amount of retrying makes a mistyped path resolve.

**A failing gate can be read: the fixer is shown both ends, and every attempt keeps its
whole output** (#248). In the #169 run the `core` gate failed 3 of 3 and the fixer was
handed the last 8,000 characters of the first failing attempt, which held `# fail 2` and
none of the failures. Three things changed:

- **Every attempt of a gate that did not pass cleanly is a file**,
  `verify-<reviewRound>-<verifyRound>-<gate>-<n>.log`, passing attempts of a flaky gate
  included, uncapped. Keyed by the gate and the verify round because `runGate` stops at the
  first failing gate: two gates fail in *successive* passes under one review round, and so
  does one gate failing again after a verify-fix. The output stays off the event (#133);
  each attempt on `verify_failed` carries `log`, the file's name, and the Verify pane opens
  exactly that and never composes one. A gate that passed every attempt writes nothing.
- **The fixer gets the first 2,000 and the last 6,000 characters**, the same 8,000 as
  before, split. A cut is stated in one line naming the full log's absolute path, and
  `describeFailure` names the log of every failed attempt and tells the fixer to search it.
  **Head and tail alone cannot show a failure a runner printed mid-stream**, which is the
  #169 case: TAP writes each `not ok` where it happens and only a count at the end. The
  named log is what fixes that case; the head catches compile errors and crashes.
- **A turn's group is read from where `reduce` placed it, not from a kind table.** The run
  rail mapped `plan`, `critique`, `implement` and `review` to a group and nothing else, so
  `revise`, `answer`, `verify-fix`, `review-fix` and `final-fix` all drew the NOW card as
  *Ready for the next turn*, above a `Current activity` card showing the same turn's tool
  calls. `turnGroup` in `app/src/cockpit/rail.ts` reads the cycle holding the turn, which
  covers every kind the loop has or will have, and while `run.running` is set the card is
  never idle: a turn in no group is titled by its role.

The replay says the gate's verdicts again too, `verify_started` immediately before each
stored verdict, so an opened run's Verify tab draws that run's own attempts and opens that
run's own logs. Until it arrives the tab draws none, rather than the live run's attempts
read under another run's directory.

**A blocking finding can be asked to prove it, and the proof is a file rather than a
command** (#113). Both existing guards are about the *form* of a claim, and `evidence.ts`
says why in its own words: *"Nothing here can judge a claim; it can only check that the claim
names a real place."* A finding that is **wrong** and cites a real line passes both — #44's
P1 is the standing example, and it bought a fix round that edited working code to satisfy a
premise `tsc` refutes in four seconds. `Finding.reproducer` is a test the reviewer writes to
make its own finding fail, and `applyReproducerOutcomes` is the fourth guard in the same
module. Four things carry it:

- **A file, never a command, and that is the whole shape.** `src/verify.ts` states the rule
  at the one place a shell is used at all — *"Model-authored text is never passed to a
  shell"* — and the obvious implementation, the one the research review's own schema example
  proposed, is a reviewer-supplied `command` that would hand a Codex turn the user's
  privileges outside any sandbox. So the reviewer returns a path and contents, `vibe` writes
  it, and the command executed is byte-identical to the gate `resolveGates` produced. The
  reviewer picks **which** configured gate observes the file, by name, and nothing else.
  Writing a model-authored *file* is not new authority — the implementer does it every round
  — but **vibe** doing the writing is, so containment, the refusal to overwrite, the symlink
  refusal and the removal afterwards are written down instead of left to an agent's judgement.
  `resolveInside` is exported from `evidence.ts` rather than reimplemented, because two
  answers to "is this path inside the repo" is how they come to differ at the edges.
- **The two directions need different evidence, and the asymmetry is the design.** A **pass**
  certifies itself: the whole command exited 0 with the file present. A **failure** does not,
  because any other test could be what failed — it needs an observed pass of the same gate on
  the same tree without the file, and `state.gateOutcomes` is where that comes from. No
  baseline, no proof: the verdict is `unproven`, which is also where every other way this can
  go wrong lands. Nothing here ever *raises* a severity; that is the move #142 reserved for a
  person.
- **`runs: 1`, and no cap on how many findings get one.** `verify.runs` is 3 because three
  samples catch a flake in the project's own suite; this is a yes/no about one added file
  against a tree that just came back green, and the issue names the constraint directly. A
  cap on the number of reproducers would be an invented number, so the cost is stated
  instead — one gate run per blocking finding that carries one — and `verify.reproducers:
  false` is the off switch.
- **It is what finally makes OUTSTANDING.md able to say something.** A carried P1 is fixed in
  the round that is deliberately never re-reviewed, so the document has only ever been able
  to say the finding was *"worked on, and nobody has confirmed they are gone"*. A reproducer
  that failed before the fix and passes after it closes it by evidence, and the sentence
  changes — counted, so a run where one of three closed does not read as though all three did.

**A change that touches the run's own judge is recorded and judged, never silent** (#112).
PR #110's run rewrote an assertion in `tests/fork.test.ts`. The gate went green and the reviewer
said nothing; only a human noticed. The tests and `vibe.config.json` are what decide a run
passed, so a round that edits them is grading its own work. This is option 1 of the issue,
*record and surface*: nothing blocks, and nothing about the gate or APPROVE moved. What changed
is that such an edit can no longer pass in silence. `src/judge.ts` decides which files count,
`diffChunks` measures them and `runReview` asks for and records the verdicts in
`state.testChanges` and the round's `code-review-<n>.json`. Six decisions travel with it:

- **Facts, not a classifier.** Each file's status, old path and lines added and removed, read
  through the **same** resolved diff mode as the reviewer's diff (`resolveDiffMode`'s rule),
  so the list judged is the list read. Nothing counts assertions or test cases in any language,
  because recognising an assertion is the semantic classifier the issue rules out. There are no
  thresholds: *N removed lines is suspicious* is an invented number. A binary file's counts
  are `null`, never 0.
- **`vibe.config.json` is always in**, matched at the work directory's root, whatever
  `verify.testPaths` says, including `[]`. The gates live in it, so it is the most direct way to
  change the judge. The record's `patterns` name it beside the configured ones, so an empty
  result reads as *nothing matched these*, never as *no test was touched*. `verify.testPaths`
  **replaces** the default list, because those defaults are a naming convention rather than a
  measurement.
- **A rename counts if either side matches.** Otherwise moving a test out of `tests/` is how
  it would disappear.
- **"Justified" is defined in the prompt**, as this file's own rule for editing a test. An edit
  is justified only when the test's claim is no longer the contract: the behaviour genuinely
  moved, or the test asserted more than the thing it guards. It is never justified because it
  makes the gate pass. Adding a test is not suspicious. For `vibe.config.json`, the question is
  whether the plan called for the change.
- **`unjudged` is the fail-closed answer.** A listed file with no verdict from the part that
  showed it is recorded as `unjudged`, never as justified, because that is the case the issue
  exists to catch. A verdict naming an unlisted file attaches to nothing. If two verdicts name
  one file, the **first wins**: deterministic, and a later contradiction cannot quietly replace
  what the record already said.
- **The reviewer has its own schema.** `REVIEW_SCHEMA` is `FINDINGS_SCHEMA` plus a required
  `test_verdicts` array, which is `[]` when nothing is listed, because Codex requires every
  property to be listed in `required` (#68). The critic's schema and prompt are untouched.
  A round that touches no judge file gives the reviewer a byte-identical prompt and writes no
  field. `test_changes_judged` is narration with no event, because the record is already durable
  in two places. It is said at `warn` only when a file is unjudged or not justified.

**Nothing under `.vibe/runs/` is read through a link, and there is one predicate for all
three levels.** `linkageOf` in `src/run.ts` is `lstat(...).isSymbolicLink()`, which is true of
a POSIX symlink, a Node `'junction'` and an `mklink /J` junction alike — one measurement, no
platform split — and it **fails closed**: an `lstat` that threw is `unknown`, which refuses,
because an entry that cannot be classified cannot be ruled out as a link. Three callers name
what they are refusing, and the wording of each is the point: `linkedRunReason` for the run
entry and its `state.json` (#53), `linkedCheckpointReason` for `checkpoint-<n>.json` (#102),
`linkedArtifactReason` for everything else in the directory (#129). Two rules travel with it:

- **Refuse before `existsSync`**, which follows a link and would otherwise report a file
  present or absent according to its *target*, and then read through it. Every site does the
  link question first for that reason, and the comment at each says so.
- **"Unreadable" and "linked" are different findings and must never share a message.** One
  says a file was opened and could not be used; the other says vibe never looked inside it.
  That is why `readArtifact` has three answers rather than two, and why `latestReport` narrates
  `report_linked` rather than reusing `report_unreadable`.

**Where the artifacts differ from the two levels above them is what is on the other side of
the read.** A run entry and a checkpoint go through `loadRun`'s validators before anything
acts on them; an artifact's bytes go **straight into a prompt**, and `commitFork` copies one
into a child under a new identity. So the refusal is on the *live* path, and the choice #129
had to make is what a refusal costs there. It **degrades**: the reviewer is told there is no
report — the same notice a missing one produces, since the two differ in what went wrong and
not in what the reviewer should do — and the fork records a loss rather than standing down.
`planFork` can refuse outright because nothing has run; ending a healthy mid-flight run over
one artifact would cost more than the artifact is worth. TOCTOU is out of scope here exactly
as #53 declared it: a check-then-open race is a different design, not a stronger check.

**A rate is a fraction, and the denominator is part of the answer.** `src/scorecard.ts` reads
the archive `vibe list` walks, and every derived count is a `Measure` — what matched, what
could be asked, and what could not. The reason is arithmetic: fields were added to `RunState`
over time, so most runs in any real archive predate most fields. The census that shaped the
module found `toolItems` (#66) on **34 of 265 recorded turns**, so "1 of 27 review turns ran
no tools" over a population where 26 never recorded the fact is a fabrication that reads as
authoritative. A dimension nothing recorded renders as absent, never as `0%`, and a histogram
is printed rather than a mean because `2.7 plan rounds` describes no run that ever happened.

It runs **over `listRuns` rather than beside it**. That matters for more than duplication:
`listRuns` is the one thing that decides what an archive entry *is* — a real directory, a
symlink (#53), something `lstat` could not classify — so a scorecard doing its own
classification could disagree with `vibe list` about which runs exist. The cost is one extra
read of each readable `state.json`, on a command nobody runs in a loop. Skipped entries are
listed **with their reason**; a scorecard that quietly ignored three runs is the overclaim it
exists to prevent.

**The scratch a killed preservation leaves is swept by the run and *reported* by the archive,
and those are one definition** (#130). `sweepGateArtifacts` runs at the top of every pass, so
a run that resumes tidies itself; #111 wrote its own limit into its own comment, because a run
that never resumes never executes anything and nothing else was going to look. `walkScratch`
is the one walk both go through — `findGateScratch` reads it for `vibe list` and the sweep
acts on it — so what the listing names and what the sweep takes cannot drift apart.

**It reports and deletes nothing, and the census is why.** A sweep across `.vibe/runs` needs a
retention rule, every retention rule is a number, and the number could not be borrowed from
evidence either: across **349 run records in 28 archives**, 20 runs recorded a gate failure —
the trigger — and **not one had configured any gate `artifacts` paths**, so every one of those
preservations had nothing to copy. The 0 MB on disk is a fact about configuration, not about
accumulation. That is option 3 of the three #130 offered, it is #96's shape (notice first, act
later), and it composes with a `vibe prune` or a startup sweep later. Two things it must not
overstate, both pinned by tests: a run holding a live lock is *described differently* rather
than called a leftover or hidden, because #77's probe refuses to guess and the copy may be in
flight; and a superseded round with no `round-N` installed beside it is **never listed as
removable**, because it may be the only copy of that evidence.

**The agent CLIs are checked against what this build was tested with, and refused only on a
missing capability** (#298). vibe inherits whatever `claude` and `codex` are installed, and an
upstream change used to fail late: a turn broke after it was spawned, or a parser quietly read
nothing. `src/cliversions.ts` holds it, and five decisions travel with it, all the owner's:

- **Tested, not a floor.** `TESTED_CLI_VERSIONS` in `src/config.ts` is what this build was
  tested against. An older or newer version warns in `preflight` and `vibe doctor`, naming
  both versions and the command that moves to the tested one, and the run continues. There
  is no minimum and no ceiling: being older is not evidence of breakage, and a ceiling would
  refuse every user the day a vendor ships. The command is read off where the binary
  resolves - `claude install <v>` for the native installer, `npm i -g <pkg>@<v>` for an npm
  global - and every method is named when the path does not say which.
- **A refusal needs a missing capability, never a version number.** Preflight reads
  `claude --help`, `codex exec --help` and `codex exec resume --help` through `parseOptionTokens`,
  and refuses only when help that **was read** does not declare a flag a run passes. Help that
  could not be read warns, by `forkHelp`'s rule: it is not evidence that a flag is missing. A
  flag only the pilot passes warns and refuses nothing, because no run passes it; the pilot's
  own spawn reports the CLI's error. The lists are `CLI_FLAG_REQUIREMENTS`, and
  `cli-flags-source.test.ts` reads the adapter sources and fails on a flag literal they do not
  name, so the list checked is the list sent.
- **A plain child process, not the toolchain contract.** `<bin> --version` and the help reads
  run from vibe's own process, once each per process. `ToolRequirement.minVersion` is for
  tools the agents probe inside their own shells during a model turn, which is a different
  mechanism. `--skip-probe` skips this too, because it is the escape hatch for a false refusal.
- **Every run records what it ran under.** `state.cliVersions` is written when a run starts and
  again on every resume, `run_started` carries it, and a resume under a different version
  records `cli_versions_changed` naming the old and the new. Null is "not detected", never a
  guess.
- **An unknown Codex item type warns once per run and never fails a turn.** `KNOWN_CODEX_ITEMS`
  in `src/progress.ts` is a vocabulary for a warning, not an allow-list: Codex adds item kinds
  as it grows. `parseCodexLine` collects them and the line handler says them as each line
  arrives - the heartbeat's `onLine`, or `watchCodexItems` when progress is off - so a turn
  stopped or timed out a moment later has still said so. Claude's stream has no equivalent.

**The fixtures are recorded by hand, outside a run, and that is the point of them.** The
contract tests over `tests/fixtures/cli/` are what catch a changed event shape, which `--help`
cannot show. Recording one spawns real agents, and the suite never calls an agent; and a
sandboxed vibe turn spawning agents hangs or is blocked. So the run that built this could not
record them, and set `VIBE_CLI_FIXTURES=pending` on its own gate.

## More finders, and a vote (#388)

**Part A was configuration only.** `review` in `DEFAULTS` holds the
additional finders, the verifiers, the quorum and what an unconfirmed P0 does. It is validated
by `validateReview` in `src/config.ts`, and each seat goes through `roleSetting`, the reader
`roles.<role>` uses, which now takes a config path (`review.finders[1]`) for its messages.
The settings screen edits it (`app/src/cockpit/seatform.ts`) and `vibe doctor` lists it.
Part A changed no run; Parts B and C below are what read it.

**The slots a seat will use exist and are unused.** `fresh-claude` and `fresh-codex` in
`src/slots.ts` never persist and store nothing; `seatSlot` picks one. A Claude seat must never
sit on `main`, which is the implementer's own session, and no seat may resume `review` or
`judge`. They are left out of a fork's census because they hold no conversation to fork.
Part B seats the finders on them, and Part C the verifiers.

**Part B runs the finders.** A finder is a reviewer whose seat was swapped, not a second
dispatch path: `seatTable` in `src/roles.ts` returns the run's table with `reviewer` replaced
by a spec built from the finder's entry (through the same `specFor` `tableFor` uses) on
`seatSlot(provider)`. `runReview` then calls the ordinary `runTurn` with that table, so the
timeout, the path style, memory, the holder's name, the charge and the heartbeat follow the
seat with no code of their own. `roles.reviewer` is the first finder, byte for byte; with
`review.finders: []` the round is exactly what it was, with no `foundBy`, no new event and no
new narration. Finders run in sequence after the first has reviewed every part. Running them at
once needs the cancel latch, the charge seam, `saveState` and the heartbeat proven safe with two
children, and is its own change.

- **The dispatch guard.** `claudeDispatch` asks `perTurnSlot(slot)` (`src/slots.ts`) before
  `shouldRotate` and before `recordTurnContext`. Both are about `main`: asked with a finder's
  model, which `main` was never measured under, `shouldRotate` reads "unmeasured, so rotate"
  after any implement turn, and `recordTurnContext` would overwrite `main`'s occupancy with a
  fresh finder's. `fresh-slot-dispatch.test.ts` switches context on to prove it, with a control
  that does rotate a Claude reviewer on `main`.
- **Grounding is per turn, attribution stays the role.** Each finder turn goes through
  `groundAndRecord` as a chunk does, so the guards judge it by what it did, and `raisedBy` stays
  `reviewer`. A finder's own parts merge with `mergeReviewReports` first.
- **The merge across finders** (`src/finder-merge.ts`) is by claim, and on doubt it keeps both.
  Two findings from different finders are one defect when they share a `code` citation (same
  normalised path, same line, both present) or when `similarity(title) >= REPHRASE_THRESHOLD`.
  That threshold was measured for question rephrasing and recycled finding labels, not for this
  population, and is reused rather than tuned until runs with several finders exist to measure.
  Greedy in finder order; one finder is never merged with itself. The winner is the most
  blocking (`SEVERITY_RANK`, now in `src/validate.ts`), ties to the earliest; it brings its own
  text and its own `downgraded`, because a guard's record is never moved onto a finding it did
  not judge. The id is the earliest finder's; an unrelated finding that collides is re-keyed
  `<id>-f<k>`, since pending findings, `severityChanges` and the oscillation census are keyed by
  id. `foundBy` keeps the id each finder used, which is also the id its own downgrade events
  name. After the merge the pipeline is unchanged: `proveFindings`, then the artifact once, then
  `recordPendingFindings`.
- **The first finder owns `reviewCoverage` and `testChanges`** (decision 6). Additional
  finders' test verdicts are dropped: two judges' verdicts on one file would need a rule for
  disagreeing, and inventing one is out of scope.
- **A failed additional finder does not end the round** (decision 7). An `Escalation` or a
  `Cancelled` propagates as it would for the first finder; anything else is recorded as
  `review_finder_failed` and that finder contributes nothing. Losing an extra seat can only leave
  out what that seat alone would have raised, so the run falls back to what a default config
  does, and `review_finders_merged` says "2 of 3 reported".
- **The summary reads the last merge event, not a tally of failures.** `review_finders_merged`
  is recorded, and only an attempt that finished its merge writes one; a resumed round re-reviews
  from scratch, so a `review_finder_failed` from the attempt it replaced must not lower the
  count. The cost half comes from `chargedTurns`, `turn_failed` included. The window's "found by
  n of m" takes `m` from the same frame, which `replayRun` carries, and never the configured count.
- **⚑ The first finder keeps its memory.** `roles.reviewer` keeps its conversation across
  rounds (the Codex `review` thread by default, Claude's `main` session if it is seated on
  Claude) while additional finders are fresh every round, so it is less independent than the
  others. Accepted, because a fresh first seat would break the default run's identity.

**Part C runs the vote.** Inside `runReview`, after the merge and `proveFindings` and before
the return, so the caller still writes `code-review-<n>.json` once and the votes are in it
(#142: that file is never rewritten). The order is merge, then reproducers, then votes, then
the gate. With `review.verifiers: []` nothing runs: no turn, no `votes` key, no event.

- **What is voted on.** Every P0 and P1 left after the reproducers, except one whose own
  reproducer *reproduced* - that is an observation, and a vote has nothing to add to it; it
  blocks whatever `unconfirmedP0` says. A finding a guard already moved is P2 by then, and P2
  and P3 are never voted on. Each eligible finding goes to every verifier, in sequence (finding
  1 to every verifier, then finding 2), labelled `vote-<r>-<n>-v<k>`: `<n>` is the finding's
  1-based place in the report as voted on, `v1` is `review.verifiers[0]`. `seatOf` reads it
  back as `kind: 'vote'`, `verifier: k`.
- **A verifier is a reviewer whose seat was swapped and whose job is a vote.** `seatTable(roles,
  setting, VOTE_SCHEMA)` and `runTurn`, as a finder, and both providers take the schema off the
  spec. `votePrompt` takes the claim's title, detail, evidence and fix, the plan and its
  out-of-scope list, and the diff parts its evidence cites (every part when it cites none of
  them). It has no argument through which `foundBy`, the id, the severity, the id's history or
  another ballot could reach it: a verifier that knew how others voted would be counting heads.
- **The tally is fail-closed** (`src/vote.ts`, pure). With `n` verifiers and quorum `q`
  (`review.quorum`, or `floor(n/2)+1`): *confirmed* when `real >= q`; *unconfirmed* only when
  `notReal > n - q`, so the quorum is out of reach even if every `cannot-tell` had been `real`;
  otherwise *undecided*, which keeps blocking. **Why `cannot-tell` blocks:** the vote exists to
  stop a *wrong* blocker buying a fix round, and must never be what lets a *real* one through. A
  doubtful verifier, a turn that failed after `runTurn`'s own retries (recorded with the error's
  first line) and a `not-real` that points at nothing all count as not having voted against. An
  `Escalation`, a stop or the budget ceiling propagates; they are not votes.
- **A `not-real` must point at something** (#48's rule, turned round). Its evidence goes through
  `groundFindings` itself (`groundVoteEvidence` wraps it as a one-finding P1), by the seat's path
  style; one that resolves to nothing is recorded as cast and counted as `cannot-tell`, with
  `countedReason` saying why. A `real` vote needs no evidence of its own.
- **What unconfirmed does** (`applyVotes` in `src/evidence.ts`). A P1 goes to P2 through `toP2`,
  so it is a guard's downgrade: `downgraded.reason` names the tally, `finding_downgraded` is
  recorded, the gate stops counting it, and a person can restore it (#142). A P0 follows
  `unconfirmedP0`: `demote` moves it the same way, `block` leaves it, and `halt` leaves it and
  hands it back to `reviewPhase`, which writes the artifact and the pending findings and *then*
  throws a needs-input `Escalation`. The stop is thrown by the caller because the caller writes
  the record. NEEDS-INPUT.md lists every ballot, and the existing #142 *Change a severity* block
  is how a person demotes it - a person's change, through `move`, with no new parser. A resume
  goes straight to the fix round with the carried findings, so it never re-votes that round.
- **FOLLOW-UPS.md.** It listed only `defer: true` findings, and a vote-moved P2 is not one: the
  fixer's prompt reads a deferral as *real, and agreed to belong in separate work*, which an
  unconfirmed claim is not. So `isDeferrable` also takes a P2 the vote moved, and the file says
  `*Unconfirmed by vote:*` beside it.
- **Narration and the summary.** Each vote turn's `turn_started` carries `kind: 'vote'`,
  `verifier`, `seat` and `finding`. One `review_votes_tallied` event per round, only with
  verifiers, counts what was voted on and what it came to. The summary's `Votes:` line takes its
  cost from `chargedTurns` (`turn_failed` included) and its outcome from the last tally event,
  Part B's rule.
- **Preflight covers every seat.** `mcpRefusals` asks about each verifier's grants by path, and
  `adjudicate`'s Codex sandbox verdict counts a Codex that only a seat uses (`seatProviders`).
  Both agents were already probed on every run. A seat's turn that fails mid-turn names its own
  line (`TurnRequest.seatPath`), not `roles.reviewer`.

## What the fixer did with each finding (#393)

The fixer's `fix-report-<n>.md` always said, finding by finding, whether each was fixed,
rebutted or deferred, but only in prose, and nothing but a person or a regex over English could
read it. Now it is data, and it is recorded per round.

- **Only the two review fix turns are asked.** `fix-<n>` and `final-fix-<n>` are sent
  `FIX_SCHEMA` (`src/schemas.ts`) as their per-turn `jsonSchema`, the #407 seam, on either
  provider. The schema is `{ report, dispositions: [{ id, disposition, reason }] }`.
  `fixPrompt`'s `dispositions` argument appends one `## Dispositions` block naming every id.
  `verify-fix-<n>` passes nothing: its one "finding" is a gate failure, not a reviewer's claim,
  so its prompt and prose report are unchanged. So are `FIX_BREADTH` (shared with the implement
  turn, and overridable) and the implement turn.
- **The report is still the report.** `fix-report-<n>.md` is written from `report` verbatim, and
  the next reviewer reads it through `state.lastReport` exactly as before.
- **Missing is a fact; unreadable is not.** Output that parses, but leaves out a finding's id,
  records that finding `not-addressed`: the fixer answered and did not mention it. Output that
  does not parse, or parses but fails `parseFixOutput`, records **nothing** for the round. That
  covers a Claude text `parseStructured` cannot read, a Codex writer's `structured: null`, and
  any malformed entry. The text becomes the report as it always did, and
  `fix_dispositions_unreadable` is narrated and recorded. The turn is not failed and not
  retried, because its edits are made. Recording that round as `not-addressed` would turn "we
  could not read it" into "the fixer ignored every finding", which is a number nobody observed.
  An id the fixer was never shown is dropped, a repeated id keeps its first answer, and the
  narration names both.
- **Where it is recorded.** `fix-dispositions-<n>.json`, written once by the fix round, and a
  `fix_dispositions` event carrying the same thing: round, label, `answers` (the review round
  it answers), and per finding its id, the severity the fixer was shown, `raisedBy`, the
  disposition, the reason, `seats`, and the `at: 'review'` reproducer verdict.
  `code-review-<n>.json` is never touched (#142). The outcome is joined at read time by the
  scorecard and the findings pane, never written back onto a finding.
- **A fix round that dies is resumed as itself.** The round's increment was always persisted
  before its turn, and the findings consumed only after it. So a process that died anywhere in
  between resumed by numbering a *new* round: `fix-1`'s retry ran as `fix-2`, answering a review
  it did not answer and crediting no seat, and a final fix came back as an ordinary fix that
  never re-ran its reproducers. `state.fixInFlight` (`{ round, final }`) is set with the
  increment and cleared with the pending findings. A resume that finds it reuses the round, and
  a final one goes back through `runFinalFix`. Both sites record the report, then the
  dispositions, and only then consume the findings. So no stop can leave a consumed round
  without its record: a stop after the record redoes the same round under the same label, and
  that retry is the record. The artifact is rewritten, an unreadable retry removes the earlier
  file, and the scorecard and the window read the last event for the round.
- **Attribution.** A finding is credited to every seat in `foundBy` (#388 Part B), so a finding
  two finders raised counts for both. Without `foundBy`, it is credited to the seat that took
  that review round's own turn. `reviewPhase` stamps that seat on `state.reviewSeat` (round,
  provider, model or `"default"`) when it writes the round's artifact, because `resume_config`
  can change `roles.reviewer` between the review and the fix, and today's config would credit a
  model that never looked. A stamp for any other round, or none, credits nobody: `seats: null`.
  Only `raisedBy: 'reviewer'` findings are scored. A person's (#141) and vibe's own are recorded
  but excluded from every figure. Verifiers are not scored.
- **Later evidence sits beside the disposition, never folded into it.** For a carried P1, the
  `at: 'final-fix'` reproducer verdict `confirmFixed` appends is read from `state.outstanding`.
  "Same id raised again next round" reads the next `code-review-<n>.json`. A final fix round is
  never re-reviewed, so its findings read "not reviewed again", which is not "not raised again".
  A missing or unreadable next artifact is not recorded. The words are never "regressed" or
  "not fixed".
- **Why the scorecard says "rebutted by the fixer", and never precision.** A rebuttal records
  what happened, not a verdict: the fixer can be wrong too. So `vibe stats` names each figure for
  what was counted, prints every figure beside the others and the total ("56 fixed, 7 rebutted
  by the fixer, 3 deferred, 1 not addressed, of 67"), and prints no percentage for them. Totals
  and by-severity rows count each finding once per round. Per-seat rows count a multi-seat
  finding in each seat, so they add up to more. Fix rounds that recorded nothing, whether
  unreadable or from before this existed, are counted and said ("not recorded for 2 of 19 fix
  rounds"), so missing data does not read as a smaller sample. "Finding precision" stays in
  `UNMEASURABLE`, with this proxy named as the nearest and not the thing.
- **The window.** The findings pane joins `fix-dispositions-<n+1>.json` onto a finding in
  `code-review-<n>.json` and draws `outcomeLine` (`app/src/cockpit/artifacts.ts`) in the
  provenance, below `foundBy` and the vote. "Dispositions not recorded for this round" is said
  when no dispositions file is listed and either the `fix_dispositions_unreadable` frame says so
  (an opened run draws its own replayed frames), or `fix-report-<n+1>.md` is listed without one.
  The second case covers a run from before #393. The decision is `outcomeFor`, a pure function. The finding row, the round
  card and the stats view are unchanged.

## The repository's REVIEW.md (#389)

`src/review-md.ts`. A repository's owners add their own review standards in a root
`REVIEW.md`. The reviewer, every additional finder and the verifiers receive it, and no other role
does.

- **Read from the start commit, never the working tree.** The commit is `state.start.sha`, else
  `state.baseSha`. A run that edits `REVIEW.md` changes the next run's review, never its own,
  which is the point: a change cannot weaken the review it is about to get. It is the same rule
  Anthropic's Code Review uses with the base branch. The edit is still a judge file
  (`REVIEW_FILE` in `src/judge.ts`, root-exact like `vibe.config.json`), because it weakens the next
  run.
- **`ls-tree` then `cat-file blob`, never `git show <sha>:REVIEW.md`.** `show` prints a symlink's
  target path as though it were the text. A link or a submodule is refused, the link rule of #53.
- **Both git reads skip `run`'s redaction (`redact: false`), and the result is verbatim or refused.**
  With redaction on, a held key that happens to occur inside the hex object id turns it into
  `[redacted key]`, and the file fails to load. A redacted text would also not be what the owners
  committed, while the blob and size still describe the original. So a file that contains a key
  vibe holds is refused, never sent, and never sent redacted. Every reason the reader returns is
  redacted, because reasons reach logs and state.
- **Three outcomes, plus refused.** Absent renders nothing and is not a warning. Most repositories
  have none. Refused and unreadable are warned in the log and the summary, and the review goes
  ahead without the file. A missing optional file never halts a run, and it is never rendered as
  absent in silence either.
- **One write.** `state.reviewMd` is set in memory, and the single `review_md` `recordAndSay`
  persists it with its event, so the record never exists without the narration that discloses it.
- **Once per run per process, then a blob check on a resume.** `reviewStandardsFor` caches its answer
  in a `WeakMap` keyed by the state object. A later round in the same process reuses it, so a
  transient git failure on round three cannot withdraw the standards rounds one and two had. A
  resume loads a new state object. It re-reads the recorded commit and requires the recorded
  blob. A mismatch means the record and the repository disagree, so it fails closed: the outcome
  becomes `unreadable`, `review_md_mismatch` is said, and nothing is sent.
- **A fork drops the record.** The record describes the parent's start, and the child's first
  review reads its own `start ?? baseSha`.
- **Placement and framing.** The file goes after `SIMPLE_SOLUTION` in `reviewPrompt`, and after "How to
  vote" in `votePrompt`, so the severity definitions and `APPROVE_COST` still frame it. It sits
  under a heading naming it as the repository's. It is not a `block()`, so `prompts.<block>` cannot
  replace it. Absent renders nothing, which keeps the frozen prompts byte-identical.
- **32 KiB is borrowed, not measured.** It is the limit Codex applies to `AGENTS.md`, used here as
  "long enough that standing text is read less carefully". Over it, the log, the summary and
  doctor warn. It is never a cap, and the file is sent whole.
- **One resolver, two modes: `git.nextRunStart`.** It answers "`git.baseRef` if set, else HEAD" and
  sits on `resolveBase`.
  - The run's preflight calls it with `fetch: true`. That is `resolveBase` exactly, so a failed
    fetch still refuses and never falls back to the local copy (#249: the #169 run started from a
    stale tip). Every existing refusal and test of it is unchanged.
  - `fetch: false` still classifies the ref locally (`--symbolic-full-name`), so a caller can say
    "as last fetched". It skips only the network: listing remotes, the fetch, and the no-remote
    refusal. Its answer says `fetched: false`, and no code that decides where a run starts may
    use it.
- **Why doctor fetches and settings does not.** Doctor is a preview a person runs on purpose, so its
  answer should be the one the run would get. When the fetch fails, doctor says so and labels the
  local copy possibly stale. The settings screen opens often, and a fetch can block for up to
  `git.worktreeTimeoutMs`, so its `review_md` frame answers locally, says "as last fetched" for a
  remote-tracking ref, and calls itself a preview. Neither can know the commit a run will actually
  start at.

## A Codex answer cut off at its output limit (#416)

`src/schemas.ts` (the order), `src/cutoff.ts` (salvage and collapsing), `OutputCutOffError` in
`src/codex.ts`, `cutOffRetry` in `src/orchestrator.ts` (a retry inside `withRateLimitRetry`). Twice in 16 hours, a read-only Codex
turn (`review-0` in the #393 run, `critique-1` in the #389 run, both `gpt-5.6-luna` at `xhigh`)
wrote valid JSON for a while, then wrote only blank space until it reached 128,000 output tokens.
The run then died with `codex wrote no structured output … reason: max_output_tokens`.

- **It is a wobble at two fixed spots, and it happens all the time.** Of the 136 saved
  `codex/*.out.json` the brief measured, 67 had blank space between JSON values: 150 runs, 89 just
  before `"reproducer"`, 60 just before `"ref"`, and 1 anywhere else. 132 were one or two
  characters, and the longest was 17. `scripts/count-schema-stalls.mjs` prints that table. On
  2026-10-22 it read 138 outputs (68 with runs, 152 runs: 90, 61 and 1), the archive having grown
  by two outputs since the brief was measured.
- **A filler field must not be last after content.** `reproducer` was the last key of a finding
  and `ref` the last key of an evidence entry, both required by the strict schema and both
  almost always null (259 of 261, 742 of 790). The inferred mechanism: once the content is
  written, the model's likeliest token is `}`, which the schema forbids while a key is owed.
  That leaves `,` or blank space, and twice the blank space fed itself. A usually-null field in
  the *middle* does not do it: 53 entries had `line` and `excerpt` null mid-object, with no blank
  run before either. So the order is now `…, defer, reproducer, evidence`, `kind, ref, path, line,
  excerpt` and `gate, path, contents`. A finding ends on its evidence and a reproducer on its
  contents. An evidence entry ends on its content only for `code`. One order cannot suit every
  kind: an `external` entry now ends `ref:"https://…", path:null, line:null, excerpt:null`, and an
  `absence` entry `path:"x", line:null, excerpt:null`. That is 54 of the archive's 812 evidence
  entries (40 `external`, 14 `absence`), down from 742 of 790 that ended on a null `ref` before.
  Whether those stall, and what changes if they do, is #429.
  `test_verdicts` and the other schemas were left alone, because the archive shows no stall before
  their last fields. The count is how a later archive confirms this, including whether the stall
  simply moved to the new last key.
- **The wording says *always present*.** Every key of a strict schema is required, so
  "Optional" (on `REPRODUCER_RULE`, `line` and `excerpt`) and "Omitting it costs nothing" told the
  model it could leave out a key it could not. The costs stay: a null reproducer is judged as
  findings always were, and a passing one downgrades the finding. The one example ending is
  appended to the `evidence` array's schema description, never to `EVIDENCE_RULE`, which the
  review prompts render into frozen fixtures. There is no rule about whitespace. The model is not
  choosing a layout, and the reorder removes the forbidden `}`.
- **Only read-only seats retry, and only once.** The critic, the answerer, the reviewer, the
  finders and the verifiers can be asked again at no cost but the tokens. A writer may already
  have edited the tree, and running it again would edit it again. One retry, because the
  reordered schema should all but remove the wobble, so a second cut-off says something about
  this turn. It ends the turn as one did before, and the error names both attempts. A finder or
  a verifier gets its retry before the existing absorption. The ceilings are checked first: the
  first attempt has been charged, and a ceiling it reached escalates instead.
- **The retry stays on the same thread.** In the #389 thread's session log, the failed turn's
  answer is kept as an assistant message with `status: "incomplete"`, 124,034 characters long,
  and compaction carried it forward. The next two turns on that thread still succeeded. A fresh
  thread would cost the critic its memory of earlier rounds. A seat that runs fresh stays fresh.
- **A cut-off answer is never repaired into one.** The findings it wrote in full are kept: a
  bracket-aware scan takes each whole element of `findings` that `parseFinding` accepts, and stops
  at the first that is not whole. They go in `codex/<label>.cutoff.json` and in a note at the end
  of the retry's prompt, as unverified. Each cut-off keeps its own record: a later one of the same
  label (the retry, or a resumed run) takes `.cutoff-2.json`, `.cutoff-3.json` and on, never
  overwriting the one before, and the error for a second cut-off names both. Nothing closes a bracket or fills in `"ref":null`. That
  would be vibe writing the agent's answer, and it would have passed #389's REVISE with one finding
  of three, and #393's review with no `test_verdicts`, as whole. A cut-off turn has no verdict.
- **The retry is gated on the role's access, not on its sandbox.** A `codex.sandbox` that gives
  the read-only roles a writable sandbox therefore means a "read-only" turn can have side effects,
  and a cut-off one is still run again, side effects and all.
- **The retry note is in the schema's own shape, and worded for it** (#429). Salvaged findings
  are shown as the turn's schema puts them on the wire: the keys in its `properties` order, read
  from the schema rather than restated, with every key and its nulls, not `parseFinding`'s shape
  with `reproducer` after `evidence` and the nulls dropped. A schema with no `findings` (the
  answerer's, a verifier's vote) is told only that it was cut off, and salvage finds nothing in
  it. The error's stdout tail also collapses blank runs written as escapes (`\n`, `\r`, `\t`),
  because that is how a message's newlines arrive in the JSONL stream. Nothing that is parsed
  goes through it.
- **What is said.** `codex_cut_off` warns, `turn_retried` is recorded, and the summary prints one
  `Retries:` line when there were any. Codex reports no usage for a cut-off attempt, so none is
  charged and the warning says so. Reading the figure from the session log is a follow-up. The
  warning comes before the ceiling check, so a run the token ceiling ends still says its last turn
  was cut off; the escalation and its exit code are unchanged.
- **Counted only from the final message.** The counts in the error and the warning (characters of
  JSON, then of blank space) are taken from the last completed `agent_message`, and only when no
  other item started, moved or completed after it. In both failures the answer did arrive, as the
  last item. When no message arrived, or the last one was followed by more work, the final message
  never completed: the counts are null, not zero, nothing is salvaged, and the error and the
  warning say the turn was cut off before its final message arrived.
- **Blank runs of 1,000 or more are shortened** to `<… N blank characters …>` in `model_said`,
  in the error and in the `.cutoff.json` text. That is 40 times the longest legitimate blank run
  in the archive (25 characters of indentation inside an `excerpt`), and far below the 122,409 and
  756,893 characters of the two failures. A 757 KB `transcript.log` is what the uncollapsed line
  cost.

## Noticing a plan loop that stops converging (#394)

`planStall` in `src/run.ts`, beside `assessConvergence`. **It is groundwork: nothing calls it
yet.** A second PR adds `loop.stallAfter`, the step-back prompt block, the escalation and the
`plan_stalled` event. Two archived plan loops ran long, #246-b (19 critiques) and #346 (15), with
the critic finding new blocking problems almost every round. `assessConvergence` stopped each of
them. Each time the person raised the limit and resumed, #246-b six more times, because a stop
whose only lever is "raise the limit" changes nothing about what the planner does. And
`windowTurnedOver` lets a flat round through exactly when the ids all changed, which is the shape
of those runs.

- **The rule.** Stalled at the last record `r` when `stallAfter > 0` and `r >= stallAfter`; the
  blocking count is not falling (`count[r] >= count[r-2]`, `count[r] > 0`); strictly more than
  half of the last two rounds' blockers are new (`fresh[r-1] + fresh[r]`, where new means not
  blocking at any earlier position); and `r >= lastStall + 2`, so a step-back gets a full round
  before it is judged.
- **Record positions, not critique numbers.** `guardPlanBudget` throws before a round is recorded,
  and the consume branch after a resume revises without recording one, so `p1Rounds` can hold
  fewer entries than there are `plan-critique-<n>.json` files. The function judges the last record
  it is given and takes no round number. The archive cannot show how often the two differ,
  because `p1Rounds` is reset when implementation starts.
- **Counted from `ids`, never `count`.** The ids are de-duplicated, and the ids in the `human`
  argument are taken out of both counts, because a `RoundRecord` has no `raisedBy`. A record
  without `ids` fails closed. There is no deferral filter, because a P0 or P1 can never be
  deferred.
- **Measured.** `scripts/replay-plan-stall.mjs [runs-dir]` (after a build) replays the real
  function over an archive. On 2026-10-22, over the main checkout's archive:
  - #246-b stalls at positions 4, 7, 10, 12, 14 and 16 if a step-back never helps;
  - #346 stalls at 4, 6, 8 and 12;
  - none of the other eight runs with three or more critiques stalls, under `stallAfter` 2, 3 or 4.

  Only #246 part A (five critiques) ran long enough to be a real negative, so the evidence against
  false alarms is thin. That is why the first stall only asks the planner to step back.
  `tests/plan-stall.test.ts` asserts the same numbers from fixtures copied out of those critiques.
