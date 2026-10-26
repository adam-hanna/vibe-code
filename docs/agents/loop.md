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

**A person settles the assumptions; the threshold does not move (#465).** A run defers an
advisory question the answerer declines and carries on with the planner's fallback. A round
later the planner can ask the same thing in other words, now blocking, and the person answers
that. `reconcileAssumed` retires an assumption only when a person answered *the same question*,
exactly or at `REPHRASE_THRESHOLD`. In the bench run (`lru-h`) the two wordings scored
**0.395**, so `ASSUMED.md` called a decision made one round later a guess. The plan was right
and the record was wrong. Lowering the threshold is not the fix: it was measured
(`src/similarity.ts`), and the highest-scoring pair in the #65 census that was *not* one
question scored 0.4. A threshold that caught 0.395 would match questions that differ.

So the person decides, in the file they are already editing. `writeEscalation` lists the
assumptions still in force under `## Assumptions the run is already making`, on every kind of
stop, before `## Change a severity`. Each is `### A<n>. <question>` with a
`**Your decision:**` blockquote. The rules that keep it from disturbing anything else:

- **The marker is not `**Your answer:**`.** `cmdResume` picks its path by whether the file
  holds that string *anywhere*, and `parseHumanAnswers`, `src/answers.ts` and the app's reader
  key on it. A different marker leaves all of them as they were, and a findings stop stays a
  findings stop.
- **Planner text is rendered inert.** The question and its fallback are free strings, so
  `inert` puts each on one line and collapses every run of asterisks to one. Nothing can begin
  a `### ` or `>` line, and no `**Your answer:**` survives at any asterisk count.
  `normalize(inert(q)) === normalize(q)`, so the heading still matches.
- **`parseDecisions` reads only that section,** from its heading to the next `## `. Finding
  titles are rendered verbatim as `### ` headings, so a finding titled `A1. …` would otherwise
  be read as a decision nobody wrote.
- **Refuse, never repair (#141).** The resume stops with nothing spent and the file in place
  when a block has:
  - text off the `> ` lines;
  - a heading that matches no deferred question (a stale file);
  - two blocks for one question;
  - a `**Your answer:**` typed anywhere in the section.
- **The heading text is the key, never the number.** Answers in the same file change which
  assumptions remain before decisions are read.
- **A decision is a human answer to that exact question.** It goes through
  `recordHumanAnswers` under the deferred question's own stored wording, so it is retired by
  the exact rule and `REPHRASED.md` says nothing. On the answers path it joins the person's
  answers in `pendingAnswers`. On the findings and moves-only paths it does not, because that
  would buy a revision the stop did not ask for; `userDecisions` carries it to every turn.
  Decisions never stand in for a blocking answer: a question stop with only decisions filled
  is still "No answers found".

`ASSUMED.md` meanwhile lists the person's answers after the assumptions, under
`## Your answers in this run`, verbatim and **matched to nothing**. It is where a reader checks
whether one already settles an assumption the run could not pair it with. Showing and filling
decisions in the window or on the phone is a follow-up.

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
that reads the answers, merged into `pendingFindings` rather than replacing them. Five things
about it are load-bearing:

- **Agent text in the file cannot carry a marker** (#472). Every parser of `NEEDS-INPUT.md` keys
  on markers: `cmdResume` on `**Your answer:**` anywhere in the file, `parseHumanAnswers` on
  line-initial `### `, this module on its `**…:**` and `*…:*` labels, and `parseDecisions` on the
  assumptions heading. The rest of the file is the agents' words, which used to be written as
  they came, so a finding quoting `**Your answer:**` sent a findings stop down the answers path,
  which refused with *No answers found*. Of 501 findings in the archive and the bench, 5 quoted
  it, all from #465's own run reviewing that feature. `literal()` (`src/literal.ts`) now goes
  over every agent-written field `writeEscalation`, `describeVotes` and `moveSection` render: the
  task, the stop message, each question's text, options and default, each finding's title,
  detail and fix, the guard's reason and the vote reasons. It escapes the asterisks of each
  marker in `MARKERS` and puts a backslash before a `#`, `>` or `*` that starts a line (after up
  to three spaces), and changes nothing else, so text holding none of these renders byte for
  byte as before. A field rendered after other text on its line is escaped only after a
  newline, so a title such as `#flush drains #pending` is untouched. The parsers did not move.
  `MARKERS` is checked against the parsers' own constants and every `**Label:**` the raise and
  move templates print, so a new marker there fails a test until it is listed.

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

**On a plan stop, a demotion that passes the gate approves the plan** (#394). Until #394 a move on
a plan stop bought one more revise-and-critique round: the consume branch sent every pending
finding, P2s included, to the planner, and nothing applied the gate to the stored findings again.
That round is where the stalled runs' critics found new P1s, so the stall question's "accept the
remaining P1s" could not have done what it says. Now, at the top of `planPhase`'s consume branch:

- **It needs a person's move since the last critique, read from state.** A pending plan finding
  with a `severityChanges` entry `by: 'human'` is exactly that, because every critique replaces
  `pendingFindings`. `takeRequestedMoves` discards what `acceptMoves` returns, and a flag held in
  memory would not survive a death between the move's save and the approval. A plain resume moves
  nothing and revises as before.
- **The real gate decides**: `gate(pending, loop.p1Tolerance)`, not "no P0 or P1 remains". So
  demoting all but a tolerated number of P1s also passes, and those are carried.
- **One approval path.** The gate-pass branch was moved, unchanged, into `approvePlan`, and both
  call it. The accepted approval's `plan_approved` adds one field, `byPerson: true`. There is no
  second approval event.
- **An answer wins.** If the same resume carries a free-text answer, the answer revises, the
  demoted findings travel to the findings revision, and a critic reads the result. The answers
  revision clears `pendingAnswers` on its plan write, so a death after that write would look
  answer-free. `state.planRevisedByAnswer` is set on that same write, whenever plan findings are
  pending, and cleared by the findings revision. While it is set, nothing is accepted.
- **An empty answer with moves resumes.** The stall question says to demote and leave the answer
  empty, so `resumeRun` takes a plan-phase `NEEDS-INPUT.md` with at least one move and no
  answers (`resumesOnMovesAlone`). Every other unanswered file is refused as before.
- **Plan phase only.** A move on a review or verify stop is unchanged.

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

  **"Added" is measured from where the run started, so the prompt says what that hides**
  (#463). A test file the run itself created is listed as `added` in every review round, so a
  later commit of the same run that weakens it, such as a fix round loosening an expected
  value to agree with the code, used to read as a new file and be judged justified. On the
  bench (commits that weakened tests to hide planted bugs, reviewed with no finders) the
  reviewer judged them justified 4 times in 4, while noting the assertions "miss several
  defects". The prompt now tells it to read the file's history on the branch (`git log -p`)
  and to judge every change after the commit that first added it by the editing rule. With
  that sentence: 3 of 4 judged not justified, and 4 of 4 legitimate fix-round edits to such
  files (two lru, two retry, with deletions) still judged justified. It is a sentence, not a
  record: the facts listed stay the diff from the base, and the history is read by the
  reviewer, so a file whose history it does not read is judged as before.
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

A round with review finders records every reporting seat's verdict, not only the reviewer's
(#404): each file gains `verdicts`, one entry per seat in config order, and `verdict` becomes
their combination, failing closed (the rule is under the finders, below). A round with no
finders has no `verdicts` key anywhere, so its record is byte-for-byte what it was.

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
new narration. Finders run after the first has reviewed every part, up to `review.maxParallel`
of them at once (#403; `1`, the default, is one after another) - see *Seats at once* below.

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
  **Near citations are flagged to the fixer, never merged** (#462). The bench's panel reviews
  showed one bug reported by two seats under two ids, cited lines a step apart (153 against
  154, 267 against 266). A census of every cross-seat pair the merge kept apart while citing
  one file, 31 of them labelled by hand, found a 1-line gap was the same defect 6 times and two
  different ones 2 times; 2-3 lines, 2 and 0; 5 or more, 0 and 8. Titles did not separate the
  1-line pairs. So any window that merges the duplicates also merges real defects, which hides
  one from the fixer, and the merge rule stays as it was. `nearPairs` finds pairs from disjoint
  seats within `NEAR_LINES` (3, the widest same-defect gap) and `fixPrompt` names them under
  *Findings that may be one defect*; the fixer, which reads the code, decides. Only findings
  with `foundBy` take part, so a review without finders renders the prompt it always did. What
  it does not reach: a pair with no line on one side (the semver operator pair cited a path
  only), and the vote, which still votes each finding of a pair on its own.
  Greedy in finder order; one finder is never merged with itself. The winner is the most
  blocking (`SEVERITY_RANK`, now in `src/validate.ts`), ties to the earliest; it brings its own
  text and its own `downgraded`, because a guard's record is never moved onto a finding it did
  not judge. The id is the earliest finder's; an unrelated finding that collides is re-keyed
  `<id>-f<k>`, since pending findings, `severityChanges` and the oscillation census are keyed by
  id. `foundBy` keeps the id each finder used, which is also the id its own downgrade events
  name. After the merge the pipeline is unchanged: `proveFindings`, then the artifact once, then
  `recordPendingFindings`.
- **The first finder owns `reviewCoverage`** (decision 6).
- **Every seat's test verdict is kept, and combined failing closed** (#404, which supplies the
  rule decision 6 declined to invent). Per file, over the seats that reported - the reviewer and
  every finder that did not fail: any *not justified* makes it not justified; otherwise any
  *unjudged* makes it unjudged; only a unanimous *justified* is justified. A dissent is never
  outvoted, because a verdict is one judge's statement about the judge, and #112 records it
  rather than adjudicating it; a majority waving a rewritten assertion through is the silence
  the record exists to break. A failed finder contributes nothing, as it contributes no
  findings, so it cannot make a file unjudged. Each seat's verdicts are attached per diff part
  by `attachVerdicts`, so "first wins" still holds within a seat. The combined record is written,
  and `test_changes_judged` said with `seats` and `disagreed`, only after the finders return;
  until then `state.testChanges` is the reviewer's own, so a stop during the finders leaves
  what a round without them would have. `disagreed` counts files where one seat said justified
  and another not justified. The end-of-run warning names each not-justified file's seats as
  `<seat> <provider>/<model>`.
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
- **The first finder keeps its memory, and that stays** (#435). `roles.reviewer` keeps its conversation across
  rounds (the Codex `review` thread by default, Claude's `main` session if it is seated on
  Claude) while additional finders are fresh every round, so it is less independent than the
  others. Accepted, because a fresh first seat would break the default run's identity.
  **Decided, on a measurement that cannot settle it** (2026-10-26). The trade is memory of what
  it raised and of the fixer's reports against independence from its own last round. The test
  was to be how often, from round 2 on, the first finder re-raises a finding the fixer reported
  fixed or rebutted, against how often a fresh finder does. The 27 archived runs had no finder
  turn, so a bench was built to produce them: 45 review loops on a throwaway library, 24 with a
  finder, some on commits with planted bugs and a weaker fixer to provoke incomplete fixes. It
  gave 12 findings in rounds 2 and later. The reviewer re-raised 2 under the same id, both after
  the fixer reported them fixed, and both were then fixed in the next round. A fresh finder's
  re-raise cannot be counted: it never has the old id, and matching by citation counted
  neighbouring bugs as the same one. Nothing measured favours a fresh first seat, and making it
  fresh would change the default run, so it stays. The user-facing pages (`configuration.md`,
  `how-it-works.md`, the README's `review.finders` row) say so. The facts they
  state: a Codex reviewer is on `SLOTS.review`, carried under `codex.persistSession`, and
  `--no-codex-session` makes it fresh along with every Codex role; a Claude reviewer is on
  `main`, the planner's and implementer's session, whose `persists` is constant; additional
  finders are on `fresh-claude`/`fresh-codex` and get `hasMemory: false`. Every seat gets the
  same `latestReport`; only the carried reviewer also has its earlier findings and earlier
  reports in context, and no reviewer is shown the dispositions. Reopening it needs a way to
  count a fresh finder's re-raise, and then the bench in #435's comments is the place to run it.
- **One finder by default, and no vote** (#447, the owner's decision of 2026-10-26). The same
  bench measured the panel: the finder caught 3 bugs the reviewer missed, and 3 of 4 reviews
  with it flagged a test edit that hid bugs against 0 of 4 without it; all 8 bench votes
  confirmed their finding, 1 of the archive's 2 demotions was wrong, and the votes cost 3.8M
  tokens. The finder added 6.9M tokens to the reviewer's 29.6M. So a run with no
  `review.finders` in any layer gets one seat on the vendor `roles.reviewer` is not on, no
  model, `high` when it is Claude and no effort (so `codex.effort`) when it is Codex, and the
  bench's focus. **Resolved, not stored:** `DEFAULTS.review.finders` stays `[]` because the
  seat depends on the reviewer's provider, which any layer or `--role` moves, so
  `withDefaultFinders` in `src/config.ts` applies `defaultReviewFinders(roles)` once the layers
  are merged and `--role` applied, unless a layer *named* the key (present in its `review`,
  `[]` included). `loadConfig` calls it, and so does `serve.ts` for `globalEffective`, which
  does not go through `loadConfig`. A table on one provider gets none: a default must not add
  a CLI nobody chose. **Never resolved on a resume or a fork:** a run's finders are fixed when
  it starts. The stored-config road (`withProjectFile`/`applyOverrides`) never calls it, and
  the fallback for a run with no stored config passes `loadConfig`'s
  `{ defaultFinders: false }`, from `resumeConfig` and `fork.ts` only. **Where the
  `(default)` mark comes from:** `LoadedConfig.findersDefaulted`, outside `Config`. Since
  `configPath` already reaches `state.json` (`startRun` stores the `LoadedConfig`),
  `storedConfig` strips the new field at every store. `seat-runners-pin`'s
  `explicit-empty-finders` case, recorded before the change, pins that a loop naming `[]` does
  exactly what it did and that `storedConfig` of its config is the bytes stored before; it
  drives `orchestrate` directly, so what `startRun` actually writes is read off disk by
  `default-review-finder.test.ts`, as the resume and fork fallbacks are. The mark is not inferred by comparing against
  `defaultReviewFinders`, so a hand-written seat equal to the default is not labelled. The
  settings screen's "use the default" sends `review.finders: null`, which
  `tidyReviewFinders` turns into a deleted key (and drops an emptied `review`); `null` means
  nothing new at load time.

**Part C runs the vote.** Inside `runReview`, after the merge and `proveFindings` and before
the return, so the caller still writes `code-review-<n>.json` once and the votes are in it
(#142: that file is never rewritten). The order is merge, then reproducers, then votes, then
the gate. With `review.verifiers: []` nothing runs: no turn, no `votes` key, no event.

- **What is voted on.** Every P0 and P1 left after the reproducers, except one whose own
  reproducer *reproduced* - that is an observation, and a vote has nothing to add to it; it
  blocks whatever `unconfirmedP0` says. A finding a guard already moved is P2 by then, and P2
  and P3 are never voted on. Each eligible finding goes to every verifier - every ballot of the
  round in one pool of up to `review.maxParallel` at once, which at `1` is finding 1 to every
  verifier, then finding 2 (#403, *Seats at once* below) - labelled `vote-<r>-<n>-v<k>`: `<n>` is the finding's
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
- **The summary names what the vote moved** (#436). Beside `Votes:`, `reportUnconfirmedByVote`
  lists each finding FOLLOW-UPS.md holds as unconfirmed by vote - `voteMovedFollowUps` in
  `src/orchestrator.ts` is `writeFollowUps`' own filter and dedupe, so the two cannot disagree -
  with its id, title and tally. The tally is `readTally` (`src/vote.ts`) over the recorded
  `votes`, which ride unvalidated: counts that are not whole numbers, do not add up to `n`, or
  disagree with the ballots' `counted` values read as *votes unreadable*, never as a count. A run
  that moved nothing prints nothing. The window shows no list of its own: `review_votes_tallied`
  carries counts and no ids, and the report pane already badges each vote-moved finding with its
  tally from `code-review-<n>.json`; the summary lines reach the window as narration.
- **Preflight covers every seat.** `mcpRefusals` asks about each verifier's grants by path, and
  `adjudicate`'s Codex sandbox verdict counts a Codex that only a seat uses (`seatProviders`).
  Both agents were already probed on every run. A seat's turn that fails mid-turn names its own
  line (`TurnRequest.seatPath`), not `roles.reviewer`.

### One finder runner and one vote runner, for two phases (#452)

The review's finders and vote (#388) and the plan critique's (#405) are one mechanism:
`runFinderSeats` and `runVoteSeats`, module-level in `src/orchestrator.ts`. #405 first built the
critique's beside the review's, because #403 was rewriting the review's at the time, and the two
had already drifted (the review's through `runSeatGroup` with labelled frames, the critique's in
plain loops). Each runner takes a phase descriptor, `FinderPhase` or `VotePhase`, of data and
small callbacks, so the shared code never asks which phase it is running for. Running a seat,
absorbing its failure, merging in config order, filling ballot slots and tallying them in order
are written once. The descriptor holds the rest:

| | Review (built in `runReview`) | Critique (`critiqueFinderPhase`, `critiqueVotePhase`) |
|---|---|---|
| `role`, first seat | `reviewer`, `roles.reviewer` | `critic`, `roles.critic` |
| `round` | `state.reviewRound` | `state.planRound` |
| `parts` (a finder's turns) | one per diff chunk, `review-<n>-f<k>[-part<i>]` | one, `critique-<n>-f<k>` |
| finder prompt | `withFocus(reviewPromptFor(i, false, false), focus)` | `withFocus(critiquePromptFor(…, false), focus)` |
| `table` | `seatTable(roles, setting)`, and `VOTE_SCHEMA` for a verifier | `seatTable(roles, setting, undefined, 'critic')`, `PLAN_VOTE_SCHEMA` for a verifier |
| `failed`, `merged` | `review_finder_failed`, `review_finders_merged` (data has `parts`) | `critique_finder_failed`, `critique_finders_merged` |
| `exempt` from the vote | a P0/P1 whose reproducer reproduced | a P0/P1 marked `defer: true` |
| vote `prompt` | `votePrompt`, with the diff parts its evidence cites | `critiqueVotePrompt`, with the plan and `plan-<n>.json` |
| vote `label` | `vote-<n>-<i>-v<k>` | `critique-<n>-vote-<i>-v<k>` |
| `tallied` | `review_votes_tallied`, `…; N reproduced, not voted` | `critique_votes_tallied`, `…; N deferred, not voted` only when N > 0 |
| `quorum`, `unconfirmedP0` | `cfg.review.*` | `cfg.critique.*` |
| `maxParallel`, `setting` | `cfg.review.maxParallel` | `cfg.critique.maxParallel` |

The sentences and `data` of the merged and tallied events come from the descriptor, so each
phase keeps its own words and keys byte for byte. A `FinderPhase` may also name an `extra`, a
reading of each part's output that the runner keeps per part in the finder's slot without
interpreting it (#404): the review sets `parseTestVerdicts`, the critique sets none.
`runFinderSeats` returns `{ report, slots }` - the merged report and the reporting finders'
slots in config order - and both callers unwrap `report`; only the review reads `slots`, to
combine the test verdicts itself. A finder's parts are always a list: the
review's chunks and the critique's single turn have the same shape, and more than one part is
merged by `mergeReviewReports`. The step line is `<holder> <doing> (finder <k>)`, and a seat's
`turn_started` and `turn_finished` carry the phase's `kind` (`review` or `critique`), or `vote`.
`seat-runners-pin.test.ts` pins a whole round of each phase at `maxParallel: 1`: every
narration, event, label, prompt and artifact. It was recorded on the code from before the
runners were unified, under `tests/fixtures/seat-runners-pin/`.

### Seats at once (#403)

#388 ran the seats in sequence on purpose: several live children of one run first needed the
cancel latch, the charge seam, `saveState` and the heartbeat proven safe. #403 is that proof,
and `review.maxParallel` (a whole number from 1, default `1`) is the bound. At `1` everything
here is the sequential order, byte for byte - labels, prompts, events, narration and artifacts -
because the groundwork rule says the setting changes nothing until somebody raises it.

The plan critique has the same bound under its own name, `critique.maxParallel` (#452, default
`1`), and everything below holds for its group as it does for the review's. It is a setting of
its own, not a reuse of `review.maxParallel`: each section already has its own `quorum` and
`unconfirmedP0`, the two panels can differ, and sharing the bound would silently have changed the
critique for anyone who had already raised the review's. That is a behaviour change to an
existing config, which the groundwork rule forbids. `runSeatGroup` takes the setting's name, so
its backstop says which bound it refused.

- **What overlaps.** `roles.reviewer` reviews every part first, **alone** (as `roles.critic`
  critiques the plan first, alone): it keeps a
  conversation, it can rotate, and it already overlaps a compaction under
  `withConcurrentCompaction`; keeping it alone keeps all three paths exactly as they were. Then
  the finders run as one group, up to `maxParallel` at once - each finder's own parts still in
  sequence. Then the reproducers (`proveFindings`), in order, as before. Then every ballot of the
  round - each eligible finding times each verifier - as a second group.
- **`runSeatGroup` (`src/seat-group.ts`) decides when, never what.** Each task writes into a slot
  its caller owns, indexed by config order: a finder's report by `k`, a ballot by (finding,
  verifier). The merge reads the finder slots in order and the tally reads the ballot slots in
  order, so `code-review-<n>.json`, `foundBy`, `votes` and its ballot order, the renamed
  `-f<k>` ids, FOLLOW-UPS.md and NEEDS-INPUT.md are the same whichever turn finished first
  (`review-parallel.test.ts` releases them in reverse and compares bytes). Events
  (`turn_started`, `heartbeat`, `turn_finished`, the charges) stay in real time: they describe
  what happened.
- **One failure stays local**, as before: a finder's is `review_finder_failed` and contributes
  nothing; a verifier's is a `cannot-tell` ballot. The others carry on.
- **A ceiling or an escalation stops the group, not the run's latch.** A task that rejects -
  an `Escalation` from `enforceCeilings` after a charge, a `Cancelled`, a rate limit past its
  cap - stops the group: `stopTurnGroup` (`src/cancel.ts`) kills the group's live children and
  wakes its waits, nothing more starts, every sibling is awaited (`withConcurrentCompaction`'s
  `allSettled` rule), and the first error is rethrown. Each killed sibling is charged on its
  way out by `withRateLimitRetry`'s `chargeFailure`, so its `turn_failed` and `child_ended` are
  recorded before the `escalation` `cli.ts` records. No report or ballot from the round counts:
  nothing is merged or tallied, and no `code-review-<n>.json` is written. A budget escalation
  with siblings live keeps `enforceCeilings`' sentence and adds how many seat turns were live,
  counting the one that crossed, and the run's totals after all of them were charged. **Why not
  `requestCancel`:** a ceiling is not a stop. The latch would end the run as *"The run was
  stopped"*, with the wrong exit code and the wrong reason. A group is found through
  `AsyncLocalStorage`, for the reason the latch is a module variable: no token is threaded
  through `runTurn`, the adapters and `run()`.
- **A stop is the latch, unchanged.** `requestCancel` kills every registered child, so a stop
  with three verifiers live kills all three, `proc.ts` refuses a fourth, and the run ends
  `needs-input` with nothing tallied.
- **A critique's group runs beside a rotation, and a group stop cannot reach it.** The critic,
  the critique's finders and its vote all run inside `withConcurrentCompaction`'s callback, so a
  rotation of the planner's conversation (`compact`) can be live beside the group. The rotation
  is started from `planPhase`'s async context, before `runSeatGroup` creates the group, so it
  never joins the group's `AsyncLocalStorage` scope: `stopTurnGroup` kills only the seats.
  `withConcurrentCompaction` is unchanged. Its `allSettled` waits for the rotation to settle,
  the seat group's error wins, and a ceiling the rotation crosses is outranked and said, so the
  run records exactly one escalation (`critique-parallel.test.ts`).
- **The two in-flight guards stay run-level.** `guardTurnSpend` now counts the run's spend plus
  every live turn's in-flight spend in the run's scope, not just its own; tripping it is still a
  run stop through the latch, and with several turns live its reason names the combined figure
  and the turns it counted. **Codex reports nothing in flight**, so concurrent Codex turns count
  as zero until they are charged and can carry the run past `budget.maxTokens` by up to
  `maxParallel` turns' spend. That is stated in `docs/configuration.md`, never estimated.
  `guardTurnQuiet` is unchanged: **a silent finder or verifier stops the whole run**, as a silent
  sequential one did; it does not become one `cannot-tell` ballot.
- **Why it is safe.** `applyCharge` is synchronous and runs in the provider result's own
  continuation, so two turns finishing together are both charged whole. `saveState` is
  synchronous and atomic over the one in-memory `RunState`, and `inFlight` keys stay unique
  because seat labels are unique per round. The heartbeat's live-turn map was built for
  overlap already. Finders and verifiers sit on per-turn fresh slots, with no session and no
  rotation. The one shared thing that was not safe was the Codex rate-limit monitor's connect,
  which a second read could use mid-handshake; every read now waits on the one connect.
- **What tells the window.** Only above `1`, a seat's `turn_started` carries its `label` and a
  `turn_finished` follows it; the window keeps live turns by label (see
  `core-and-window.md`). A `model_said` line is prefixed with its turn's label whenever another
  turn is live in the run, so interleaved prose in the transcript stays readable; every other
  per-turn line already names its turn.

## Finders and a vote for the plan critique (#405)

#388 gave the review its panel and marked the critique out of scope (⚑2). This gives the critique
the same panel, under a `critique` section of its own: the owner may want a different panel for
plans, or none, and a plan vote costs one turn per blocking finding per verifier while a review's
scales with what the diff turned up. The section takes `review`'s keys (four, and
`maxParallel` since #452) and is validated by the same `validateSeats` under `critique.` paths, merged by the same `mergeReview` (a project's list
replaces the global one whole), and read by `readFinders(cfg, 'critique')` and
`readVerifiers(cfg, 'critique')`. With both lists empty a plan round is exactly what it was: no
turn, no `foundBy`, no `votes`, no event, and the critic's prompt is `critique-round1.txt` byte for
byte. Nothing here measures how often a critique finding is wrong, so it ships off and the docs say
nothing about accuracy: the archive has no record of what the planner did with each finding.

- **Through the review's runners** (#452). `critiqueFinderPhase` and `critiqueVotePhase` build
  the descriptors `runFinderSeats` and `runVoteSeats` run, so the critique's seats share the
  review's code for running a seat, absorbing its failure, merging and tallying (*One finder
  runner and one vote runner* above). They run in a `runSeatGroup` bounded by
  `critique.maxParallel`, never by `review.maxParallel`, and at `1`, the default, a plan round is
  byte for byte what it was before #452.
- **The order within a plan round.** Critic, then finders, then the merge, then the vote, then
  `refusePlaceholderPlan`, then `plan-critique-<n>.json`, `collectDeferred`, FOLLOW-UPS.md and
  `recordPendingFindings`, all inside `withConcurrentCompaction`'s callback; then the gate. The
  artifact holds the merged, voted findings, so everything downstream reads one report.
- **A critique seat is a critic whose seat was swapped.** `seatTable(roles, setting, schema,
  'critic')` copies the critic's row onto the seat's agent and a fresh slot (`seatSlot`), so the
  timeout, charge, heartbeat, path style and holder's name follow it. `roles.critic` stays the
  first finder (`foundBy` seat `roles.critic`) and keeps its `judge` thread. A finder is one turn
  per plan round, `critique-<n>-f<k>`, handed `critiquePromptFor` with `hasMemory: false` plus its
  focus (`withFocus`, whose heading still says "review" so the review's prompts do not move). From
  round 2 that is the no-memory `continuityNote`: the #435 asymmetry, documented and not solved.
  A failed finder turn is `critique_finder_failed`; `critique_finders_merged` counts who reported.
- **What is voted on.** Every P0 and P1 after the merge, except `defer: true` and anything a guard
  already moved to P2. There is no reproducer exemption: the critique has none. The `defer`
  exclusion is defence only, because `parseFindings` clears `defer` on every P0 and P1 a turn
  returns; `critique-votes-loop.test.ts` pins that a "deferred" P1 reaches the vote as a P1.
- **Its own prompt and schema.** `critiqueVotePrompt` and `PLAN_VOTE_SCHEMA`, not `votePrompt` and
  `VOTE_SCHEMA`: the review's are sent to the review's verifiers and `vote-basic.txt` pins them, and
  the question differs. *Does this defect exist in this plan* covers the plan contradicting the
  repository, missing what the task requires, getting a step wrong, or taking on what the task rules
  out, and none of those is a diff. A verifier is shown the claim, the task, `plan_md`, the
  assumptions, `out_of_scope`, the acceptance criteria, REVIEW.md and the read-only repository; by
  construction never the id, the severity, `foundBy`, the author, how many raised it or another
  ballot. Labels are `critique-<n>-vote-<i>-v<k>`, `<i>` the finding's place in the merged report.
- **The outcomes are `applyVotes`'**, under `critique.quorum` and `critique.unconfirmedP0`. An
  unconfirmed P1 goes to P2 with the tally as its reason (`movedByVote`). The revision prompt marks
  it `*Unconfirmed by vote:* <tally> - non-blocking.` (`voteNote`, plan side only - `fixPrompt`
  still shows a vote-moved review finding as a plain P2). On approval it goes to the implementer
  through `planNonBlocking` under `loop.fixNonBlocking`: `isPlanToAddress` takes it although
  `isDeferrable` does too, and `approvePlan` leaves it out of `declined`, because `declined` tells
  the implementer a finding is real and belongs elsewhere. It is listed in FOLLOW-UPS.md as
  unconfirmed by vote either way.
- **`halt`.** `planPhase` throws the needs-input `Escalation` after `sayFindings` and before the
  gate's branches, once the artifact and the pending findings are written. A plain resume takes the
  pending findings to the revision with the P0 blocking; a resume after a person demoted it under
  *Change a severity* takes #394's accept-on-demotion path. Neither votes on that round again.
- **The guards see what actually blocked.** The gate, `blockingFindings`, `p1Rounds` through
  `guardProgress` (with `planStall`, the repeat census and `maxPlanRounds`) and `guardPlanBudget`
  all read the voted report, so a vote-moved P1 is never a blocker id in `p1Rounds` and churn the
  vote rejects never trips `loop.stallAfter`. Finder and verifier turns are not plan rounds:
  `planRound` moves only with a revision. Question rounds come before the critique and are
  unchanged.
- **Every round votes afresh.** A finding raised again under the same id is voted on again by
  fresh verifiers that know no earlier tally; nothing remembers one.
- **Everything that names the review names the critique.** Events `critique_finders_merged`,
  `critique_finder_failed` and `critique_votes_tallied`, carried by the replay; `seatOf` reads the
  finder and vote labels into the `critique` phase, and the summary's review lines count only
  `review`-phase seats; `Critique finders:`/`Critique votes:` summary lines; unconfirmed plan
  findings are listed under their own sentence (split by `raisedBy: 'critic'`); doctor's critique
  block and the pre-run `Critique finders:`/`Critique verifiers:`/`Critique vote:` lines (the last giving the quorum and `unconfirmedP0`); `describeMcp`'s critique
  rows and `mcpRefusals`' critique grantees; `seatProviders` for the sandbox preflight; and the
  Settings section "who else critiques the plan, and who votes". The window folds the two critique
  frames into the same `finderMerges` and `voteTallies` as the review's, so a critique card carries
  its merge and `ReportPane` draws `foundBy` and votes from `plan-critique-<n>.json` as it does for
  a review.
- **Cost.** One turn per plan round per finder; one turn per voted finding per verifier per round;
  all under `budget.maxTokens`, with no separate ceiling.

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

## What the planner did with each critique finding (#453)

`critique.verifiers` votes on whether a critique finding is real, but nothing measured how often
one is wrong. The planner was told to "fix the plan, or say so explicitly in the plan", so a
rebuttal was prose in `plan_md` with no finding id on it. The archive on 2026-10-23 held 74
"rebut*" across 24 `plan-<n>.json` files, all prose, and 142 of the 151 P1s with a following
critique simply stopped being raised, which says nothing about whether they were fixed or
rebutted. #393's record is now kept for the plan side too.

- **Only the findings revision is asked.** `revise-<n>` is sent `REVISE_SCHEMA`
  (`src/schemas.ts`) as its per-turn `jsonSchema`. That is `PLAN_SCHEMA`'s properties in their
  order, plus a required `dispositions: [{ id, disposition, reason }]` with `FIX_SCHEMA`'s enum
  worded for a plan. It ends on `reason`, a non-null string, per the key-order note. The first
  plan turn, an answers-only `revise-q<n>`, and every critique that approves send `PLAN_SCHEMA`
  and the prompt they always did. `revisePlanPrompt`'s findings branch swaps "say so explicitly
  in the plan" for the `plan dispositions` block (overridable under `prompts`): answer each id,
  and still explain a rebuttal in the plan, because `plan_md` is what the implementer reads.
  `revise-answers.txt` and `revise-findings.txt` pin both renderings against develop's.
- **The plan keeps its shape.** The turn's output is read once. `parsePlan` reads the plan half
  unchanged, and `parsePlanDispositions` reads the list. `plan-<n>.json`, `state.plan` and
  everything downstream never see `dispositions`. An unreadable plan fails the turn as before. A
  readable plan with an unreadable list stands: `plan_dispositions_unreadable` is narrated and
  recorded, nothing is recorded as `not-addressed`, and a stale `plan-dispositions-<n>.json`
  is removed. That is #393's rule. A readable list that leaves an id out records it
  `not-addressed`. An id the planner was never shown is dropped, and a repeated id keeps its
  first answer. The narration names both.
- **Where it is recorded.** `plan-dispositions-<n>.json` and a `plan_dispositions` event, with
  the same shape as `FixDispositions` plus a `vote` per finding. `<n>` is the revision's round,
  the number in `revise-<n>` and in the `plan-<n>.json` it wrote. `answers` is `n-1`, because
  `revise-<n>` answers `plan-critique-<n-1>.json`. Every finding the planner was shown is
  answered, at every severity, including carried, human-raised and vibe-raised findings.
  `reproducer` is always null, because nothing reproduces a plan finding.
- **Order against the save.** `recordDispositions`' order: the record is written after the plan
  parses and before the one `saveState` that persists the plan and consumes the findings it
  answers. A revision is therefore never consumed without its record. A death in between leaves
  the findings pending, and the resume revises them in a new plan round (`revisePlan` advances
  `planRound` again), so the redo is `revise-<n+1>`, not `revise-<n>`. The scorecard keeps the last
  event per label, so it counts both records. Nothing between the record and the save awaits, so
  the window is a few synchronous statements wide; the double count is stated, not guarded.
- **Attribution.** Every seat in `foundBy` when critique finders ran. Otherwise the stamp
  `state.criticSeat` (round, provider, model or `"default"`), which the critique callback writes
  beside `plan-critique-<n>.json`, `state.reviewSeat`'s pattern. A resume that moved
  `roles.critic` therefore credits the model that looked. A stamp for another round, or none,
  credits nobody. `settleDispositions` was generalized rather than copied: the author whose
  findings fall back to the stamp, the seat name and the stamp are parameters. So the review path
  is byte-identical, and only `raisedBy: 'critic'` reaches `roles.critic`. A person's and vibe's
  findings (the placeholder refusal is one) are credited to nobody and excluded from every figure.
- **The vote rides along.** Each disposition carries the finding's stored `votes.outcome`
  (`confirmed | unconfirmed | undecided`), or null when it was not voted on or `readTally` cannot
  read the record. It is never recounted. This is the cross-tab #405 shipped without.
- **Raised again.** When the critique of plan `n` is recorded, still inside the callback,
  `recordRebuttalsRaisedAgain` reads `plan-dispositions-<n>.json` and records
  `critique_rebuttal_disputed` with the rebutted ids, those raised again under the **same id**
  (`disputed`), and those not raised again. It is recorded at critique time because a critique
  that approves has no next revision, and that is exactly when the rebuttal stood. Same id only:
  a finding raised again under a new id is not seen, and memoryless finders rename ids
  (`<id>-f<k>`), so for their findings this undercounts. It is never matched by title.
- **Why the scorecard says "rebutted by the planner", and never precision.** For #393's
  reason: a rebuttal is the planner's call, not a verdict, and the planner can be wrong too.
  `vibe stats` prints "Critique findings, by what the planner did" beside the fixer's section:
  - revisions recorded, unreadable and silent;
  - rows by seat and by severity;
  - rebutted and raised again against rebutted and not raised again, with the same-id caveat
    in the line itself;
  - the vote outcome × disposition rows.

  Every figure stands beside its `of`, and no percentage is printed. A rebuttal whose next
  critique recorded no comparison is "could not say", never "not raised again": a critique that
  stopped before recording it looks the same. "Finding precision" stays in `UNMEASURABLE`,
  naming both rebuttal rates as the nearest proxies.
- **The window does not draw it yet.** The events and artifacts are durable. Neither the
  findings pane nor the replay reads them.

## Non-blocking findings on a passing round (#425)

Run `20261022-224848` passed its review with the verdict REVISE and two P2s in the task's own
files, said `Review clean - 2 non-blocking finding(s)`, and ended `complete`. No fix turn ran and
neither finding reached `FOLLOW-UPS.md`; a person found both in `code-review-0.json`. The gate was
right that P2s do not block. Nothing after the gate read them. `loop.fixNonBlocking` (default on)
is what does now; `false` restores the earlier loop exactly, on both sides.

- **To address** is `isToAddress` (`src/stored.ts`): a P2 or P3 that is not `isDeferrable`.
  Deferred and vote-moved findings keep going to FOLLOW-UPS.md as before and trigger nothing. A
  P1 a guard downgraded (uncited, or from a review turn that ran nothing, #48/#66) is a P2 like any
  other here: the guard still decides it is never carried as a P1, and its reason stays in the
  round's artifact and `finding_downgraded` event, but a passing review with one now buys the
  final round, where the fixer can rebut it. With `loop.fixNonBlocking` off it buys nothing, as
  before - `final-fix-round.test.ts` pins both.
- **Review: one final round, never two, never re-reviewed.** A pass with tolerated P1s, *or* with
  at least one P2 to address, buys the carried-P1 final round. The turn gets every finding of the
  review, as it always did. It is not reviewed again for the reason the carried-P1 round is not:
  another review could raise something new, and the loop would never end. The gates run after it.
- **#228's scope rule still governs it.** Nothing was added to `fixPrompt` or `FIX_BREADTH`. The
  fixer judges each finding, fixes what belongs to the task, and gives a disposition for the rest.
  What changes is where the rest goes: everything it did not mark `fixed` is put on
  `state.unaddressed` with its disposition and reason, and rendered as **Left by the final fix
  round** in FOLLOW-UPS.md, so a rebuttal can be judged by a person. An unreadable answer puts
  every non-blocking finding there as *the fixer's answer could not be read*, never as not
  addressed, which `recordDispositions` forbids. It is written after `recordDispositions` and
  before the findings are consumed, so a stop after the turn keeps it and a resumed round writes it
  again.
- **P3s alone buy no turn.** The fix prompt tells the fixer to skip P3s unless they are incidental
  to required work, so a turn for P3s only would buy nothing. They go straight to the new section,
  marked *not attempted: P3s only*, and the `review_approved` sentence no longer says clean.
  The findings are consumed on the same state write that records them, before the approval is
  said, so a stop in between cannot leave them pending for a resume to hand to `runFixRound`.
- **`confirmFixed` stays over the tolerated P1s.** The non-blocking findings are recorded by
  `recordDispositions`, which already says what the fixer did with each. **OUTSTANDING.md is only
  written when P1s were carried**: it says the review raised P1s within `loop.p1Tolerance`, and the
  gate-time rewrites already do nothing on an empty `outstanding`.
- **Exactly one `review_approved` per approving review**, because the cockpit reads it as the run
  ending. When the round runs it is the one at the end of `runFinalFix`, counted from the
  dispositions record, and it names FOLLOW-UPS.md only when something was put there. A round for
  tolerated P1s alone, and a review with nothing to address, say and record exactly what they did
  before.
- **Plan: no extra revision.** The owner's decision, so the plan loop's round count does not move.
  The approving round's findings to address (P2s and P3s alike, since no turn is bought) are stored
  on `state.planNonBlocking`, on the same save as `declined`, and `implementPrompt` renders them as
  **Non-blocking findings from the plan critique**, between the report request and the carried
  section, which stays where `declined-findings.test.ts` pins it. What the implementer leaves gets
  no follow-up entry: the review sees the code and raises it again if it still matters.
- **An acceptance hands them on too.** The hand-off is in `approvePlan`, so a person's acceptance
  on demotion (#394) stores `planNonBlocking` exactly as a gate pass does. A P1 the person demoted
  is a P2 or P3 with a `by: 'human'` move and no guard's `downgraded`, so it is not deferrable and
  goes to the implementer: accepting says the finding need not block the plan, not that it is no
  longer work. `loop.fixNonBlocking: false` hands nothing on here either.
- **`state.finalFixNonBlocking` is the second witness.** A round for P2s alone leaves `outstanding`
  empty on purpose, so the resumed round, the completion line and the CLI summary
  (`finalFixSummary` in `src/cli.ts`) read these ids to tell it from a repaired state. The summary
  fails closed on `unaddressed`: absent, or repaired on load, is said to be unknown rather than
  read as "every one fixed". For the same reason `reconcileFollowUps` keeps an existing FOLLOW-UPS.md as it
  is when `unaddressed` was repaired, rather than deleting or shortening it from what survived.
- **The setting and a resume.** Every new decision reads the effective config, so a plan approved
  with the setting on and resumed with it off gets the old implement prompt. A final round already
  in flight resumes as itself, from the ids it persisted (#393's `fixInFlight`), and
  `unaddressed` is a record of what happened, rendered whatever the setting now says.
- **Forks copy all three fields**, as they copy `carried`: `fork.ts` copies the checkpoint's state
  whole. `unaddressed` is only present in a checkpoint at or after the final fix, whose tree and
  dispositions the fork shares.

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
  **They don't stall, so the order stays** (#429). After #424, 152 Codex outputs were counted:
  35 from this repo's archive and 117 from a throwaway bench project whose briefs required spec
  links and left edge cases open, so reviewers would write `external` and `absence` evidence.
  They held 62 such entries (39 `external`, 23 `absence`), with no blank run before `path`,
  `line` or `excerpt` in any of them, and no blank run longer than 2 characters anywhere. A
  separate evidence object per kind in an `anyOf` was the fix on offer, and it would put Codex's
  strict output at risk for a stall that was never observed. If one appears, the count above is
  how to see it.
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

`planStall` in `src/run.ts`, beside `assessConvergence`, called by `guardProgress` for the plan
loop only. Two archived plan loops ran long, #246-b (19 critiques) and #346 (15), with
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

What calls it, and what a stall does:

- **Where it runs.** In `guardProgress`, after `recordRound` and before `assessConvergence`. The
  plan caller passes `GuardArgs.stall` (the state and the human ids), and that field being present
  is the whole gate. The review and verify callers pass nothing and never consult it. `human` is
  built from this critique's findings and the run's pending ones; it is empty in the plan loop
  today.
- **The order.** The stall check runs first. A round that stalls skips `assessConvergence`, so
  when both would fire the stall wins. `maxPlanRounds` stays the hard ceiling: the cap round exits
  3 whether or not it stalled. A step-back on that round is already saved, so a resume with a
  raised cap sends its block. An escalation on that round rides along: the cap's message gains the
  stall's sentences and the stop carries the stall's question.
- **`lastStall` and the action are one function**, `stallAction(state.planStalls)`. `lastStall` is
  the position of the latest entry of any kind, so an escalation windows the next round exactly as
  a step-back does, and no stall can fire on the round right after a resume from one. A stall
  escalates only if a step-back sits after the latest escalation. So the first stall steps back,
  the second asks a person, and the first stall after a person has steered steps back again.
- **The record.** Each stall appends `{position, action, counts, fresh}` to `state.planStalls` and
  is narrated as `plan_stalled`. Both are on the same `saveState`, which also persists the round
  just recorded. `planStalls` is removed with `p1Rounds` when implementation starts, because its
  positions point into it. `counts` and `fresh` are kept because re-running the rule after a
  resume would find that stall in its own window and return null. A fork copies both fields with
  the rest of the state.
- **A step-back** does not stop the run. The next *findings* revision reads
  `pendingStepBack(state.planStalls)` and carries a `## Stepping back` section after the findings.
  The section is a counts line written by code, then the `stall` prompt block, which is overridable
  as `prompts.stall`. The counts line is outside `block()`, so an override cannot drop it. The
  entry's `sent` is set on the write that persists that revision's plan, so a stop before that
  write sends the block again and a stop after it does not. An answers-only revision neither
  carries it nor marks it sent.
- **An escalation** stops with `EXIT.NEEDS_HUMAN` and is the first `OpenQuestion` vibe writes
  itself. The message gives the per-record counts since the step-back, counted the way `planStall`
  counts. The one product question, with no recommended default, offers to narrow the brief,
  accept the remaining P1s, or continue. Its blockers fill *Outstanding P1 findings* and *Change a
  severity*. There is no answer interpreter. Free text goes to the planner through
  `pendingAnswers`, and "accept" is a demotion, which approves the plan (see #142's section).
- **`loop.stallAfter`**, default 3, `0` turns it off, and it has no CLI flag. The end-of-run
  summary prints how many step-backs a run took, and only when there were any.
