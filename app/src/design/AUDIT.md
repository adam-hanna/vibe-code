# The built app against the hi-fi — a divergence audit

**Status: closed. Every finding below has been acted on or answered.** The
verdicts are unchanged from the day they were written; what has been added under
each is a `### Closed` note saying what was built, what was deliberately built
narrower than the frame, and — where the answer was *no* — the reason. Read the
finding first and the note second: the note is only meaningful against the claim
it settles.

Where a fix is narrower than the design, it is narrower for a reason stated in
the source as well as here, and the two say the same thing. Nothing was closed by
deciding the design was wrong.

Read against `Vibe Cockpit hi-fi.dc.html` (14 frames, 1440×900) and
`Vibe Design Spec.dc.html`, both in
`C:\Users\Adam\Documents\apps\vibe mockups\high fi\final\Vibe Code UI Mockups\`.
Those files stay where they are by decision; this file is the part of them that
belongs in the repo, in the same spirit as `HANDOFF.md`.

---

## 0 · Why there is a gap at all

**The artwork has never been in this repository.** `find` returns no `.dc.html`
anywhere in the tree; `app/src/design/` holds `HANDOFF.md` and nothing else.
`AGENTS.md` records that as deliberate — *"the markdown is worth committing and
the artwork is not"* — so every screen in this app was built from a **prose
transcription of the design rather than from the design**.

That is the structural cause, and it predicts exactly the kind of divergence
found below: the things `HANDOFF.md` states as rules were implemented
faithfully, and the things that are only visible by *looking* — what is on
screen at once, in what order, at what density — were not.

Two consequences worth stating before the list:

- **The token layer is faithful and is not the problem.** Every colour in the
  design spec — `#c3c8cc`, `#9aa0a5`, `#8f9498`, `#232a30`, `#dbe4ec`,
  `#4a6b8c`, `#94bce3`, `#b5d9fd`, `#7fb069`, `#7fa3c4`, `#c07a6a`, `#e0a596` —
  is present in `tokens.css`. Type, spacing and the one pulse match. Nothing
  below is a colour problem.
- **Frames 15–18 exist only as prose.** `AGENTS.md` cites hi-fi 15 (diagnostics
  popover), 16 (launching), 17 (absolute times on a stopped card) and 18 (the
  stop confirmation). The hi-fi file ends at 14. Those four were specified in
  writing after the artwork was closed, so for them `HANDOFF.md` *is* the
  design and there is nothing to diverge from.

---

## 1 · The findings, worst first

### 1.1 · There is no left rail, and the design's navigation is built on it

**Hi-fi 1 and 5, present in every frame that shows the whole window.** A
collapsed vertical rail on the far left holding one square per workstream —
`VC`, `TS`, `MS`, initials, with a liveness dot on the running one — and three
controls pinned at its foot: `＋` (new workstream), `⌘K` (switcher), `⚙`
(settings).

**The app has no rail at all.** Everything it carries has been pushed into the
tab bar or into overlays reached from elsewhere.

This is the single largest structural divergence and most of §1.2 follows from
it. The rail is not decoration: it is where *multiple concurrent workstreams*
live, which is the product's premise.

**Verdict: the design is right and this should be built.** Nothing has changed
since the design that removes the need for it.

### Closed — built, with the squares narrower than the frame

`Rail.tsx` and `squares.ts`. The strip, the squares with their liveness dots, the
selection, and `＋ ⌘K ⚙` at the foot. `--dim-rail: 54px` was already in
`tokens.css` — the token layer transcribed a rail a year before anything drew one.

**A square navigates; it does not reopen**, and that is the one deliberate
narrowing. `serve.ts` runs one run at a time, so there is never a second *live*
workstream to switch to — which is the argument the cockpit had been making
against the rail all along, and it survives. What it does not support is the
conclusion: it argues for the squares being navigation, not for having no rail
and pushing its three controls into the tab bar. A square that silently reopened
would be a second definition of what reopening costs, and `1b` is where the
lock's verdict is stated and a force confirms.

Entries the archive refused — a symlink (#53), something `lstat` could not
classify — get no square at all, because a square is an invitation to open
something.

### Diverged on purpose — the window is four columns, and the loop is on the right (#223)

Every frame that shows the whole window draws `rail · loop · pane`. The built
window is now `rail · runs · pane · groups`, and this is an **owner's decision
about this product**, not a correction to the artwork — recorded here so the next
person building from a frame knows the frame is not current on this point.

Two moves, and the second follows from the first. `1b` was a *tab*, which made
the archive something you leave the run to look at, when it is the thing you
triage from after a night of unattended work — so it became a standing column,
next to the rail it is drawn from and whose `RUNS` button now opens it. That
leaves the loop column with a side to go to, and the right is the correct one:
the loop names the rounds the pane beside it draws — Plans, Plan critique, Code,
Code review — so a card and its artifact are adjacent, which is the shortest path
in the product.

**Collapsed is a state, not an absence**, which is the part worth copying.
`SidePanel` is one component for both edges, and a shut panel keeps its strip,
its mark and its name — the way back is where the panel was, and what changes is
the main pane's width rather than the window's structure. Neither is persisted:
a collapse is a gesture for the next few minutes, and a window that opened three
days later still folded would be answering a question nobody asked twice.

### 1.2 · The tab bar has twelve tabs where the design has seven

| hi-fi 1 · in order | built app · in order |
|---|---|
| Pilot chat | Output |
| Output | Pilot |
| Versions `3` | Verify |
| Diff `8` | Keys |
| Findings `1` | Findings `3` |
| Questions | Runs |
| Prompt | Commands |
| *(right-aligned)* `1.9M tok · codex 5h 41%` | Questions |
| | Spend |
| | Settings |
| | Diff |
| | Prompt |

Five separate problems in one control:

- **`Pilot chat` is the first tab and the default view.** Hi-fi 5 says so in as
  many words. The app opens on `Output` and puts Pilot second — so the front
  door the pilot is supposed to be is not the thing you land on.
- **`Versions` does not exist in the app.** Hi-fi 3 is the version history of an
  artifact, and the loop's whole shape is *versions of an artifact until the
  adversary stops objecting*. There is no tab for it.
- **`Spend` is a readout, not a tab.** The design puts `1.9M tok · codex 5h 41%`
  right-aligned in the tab bar itself, always visible. The app spends a whole
  tab on it and shows it nowhere otherwise.
- **`Settings` is `⚙` on the rail** (§1.1), and `HANDOFF.md` already says
  project settings are *one scrolling page* whose nav is its table of contents.
  A tab in the run's own pane row is a different thing.
- **`Runs` is the rail plus `⌘K`.** Same cause.

`Keys` and `Commands` are genuinely new — the API-key pilot (#143) and the
command runner (#211) postdate the artwork — so the design cannot be consulted
about them and they are not counted as divergences. But they are two more tabs
on a bar that was already four too long.

**Verdict: the design is right about the seven, the two new ones need a home,
and the bar as built is the visible symptom of the missing rail.**

### Closed — nine tabs and a readout, in the design's order

`Pilot chat · Output · Versions · Diff · Findings · Questions · Verify ·
Commands · Keys · Prompt`, with spend right-aligned. `Pilot chat` is first and is
where the window lands, which is hi-fi 5 in as many words.

- **`Settings` and `Runs` moved to the rail** — the `⚙` and the squares. Neither
  pane was deleted; only the door moved.
- **`Spend` is the readout**, in the place hi-fi 1 draws it, and the readout is
  also the way into the pane. Losing a per-phase breakdown to match a frame
  would be deleting a screen to fix a bar. It reads *nothing charged yet* rather
  than `0 tok` before the first charge.
- **`Versions` is named and dashed**, with what would fill it. Hi-fi 3 is a
  version history of an artifact and this window has no filesystem; #207 is
  explicit that reading one is its own decision, with #129's link refusal
  attached.
- `Verify`, `Commands` and `Keys` sit after the seven the design names. They
  postdate the artwork, so the least they can be wrong by is to not displace it.

`squares.test.ts` fails in the repo that puts a `Settings` or `Runs` tab back on
the bar, or moves `Pilot chat` off the front — each one drifting back is how
twelve tabs happened the first time.

### Reopened, and closed differently — the bar names four artifact panes (#223)

The count above is now eleven and a readout, and three of the design's own seven
labels are gone. That is not drift; it is the dashed `Versions` tab being built,
and it turned one position into four:

`Pilot chat · Output · Plans · Plan critique · Code · Code review · Questions ·
Verify · Commands · Keys · Prompt`.

- **`Versions` is `Plans`.** The reason it was dashed — *"this window has no
  filesystem"* — stopped being true when the `artifacts` read frame landed, and
  #207's condition was met rather than waived: reading an artifact is its own
  decision, taken on the core side, with #129's link refusal attached to it and
  `assertUsableRunId` in front of that.
- **`Findings` is `Plan critique` and `Code review`.** It was always one round of
  one of the two, drawn from the four counts and a title the wire carries, so a
  reader asking *why did the loop fix again* got half the evidence and could not
  reach the rest. The panes read the judge's own report, so a finding opens onto
  what is wrong, what would fix it and every place it cites.
- **`Diff` is `Code`.** The cumulative diff is that pane's first section,
  unchanged and still what it opens on before any round has committed; what is
  new is a section per round, from the range `round_committed` carries.

**Four positions became six, so something had to decide the interleaving.** The
rule is `CycleKind`'s order — plan, critique, code, review — which is the loop's
own and is the order the column beside the bar draws its groups in. Keeping
`Diff` between the plan and the findings because that is where the artwork put it
would be a coincidence somebody has to remember; making the bar agree with the
column is a rule. `squares.test.ts` pins it, and pins that neither `Findings` nor
a `Diff` tab comes back — two answers to one question is how twelve tabs happened.

**Ten and a readout, since `Runs` became a column.** And the two report tabs lost
their counts: `Plan critique · 2` meant two blocking findings and was read as two
critiques, which is the reasonable reading, because every other count in the bar
is how many things are behind the tab. A tab's badge is a quantity of items or it
is nothing; the severities are drawn on the round they belong to, beside the
tolerance that decided them, which is the only place they mean anything specific.

**And they are live now.** Every one of the four artifact panes was a snapshot
taken when the tab was mounted — a critique round finishing while you watched the
critique tab changed nothing, and the only way to see it was to navigate away and
back. `artifact_written` is the signal and `Run.artifacts.length` is what the
panes take as their revision. A pane **follows the run until the reader touches
it**: the newest section opens as rounds land, and the first manual toggle stops
that, because a pane that always jumped to the newest would move the document out
from under somebody reading round 0. A navigation from another surface still
wins — that is somebody asking for a particular round, which is the same act.

### 1.3 · The pilot pane is a chat; the design's is the run's log

**The most consequential finding, and the one that explains the reports.**
Hi-fi 5: *"It has to be a usable log of the run on its own — every round leaves
a card, and a card carries what happened, what it found and what you can do
about it."*

The design's pilot pane interleaves three things in one scroll:

1. **Round cards** — `plan v.b · claude/opus · 4m 40s · accepted after 1
   critique`, then one sentence of what happened, then the round's own evidence.
   A code round carries `11 files · +604 −71` and a `verify · passed · 3 runs, 3
   clean · 41s median` strip with an `open verify` link. A review round carries
   the severity row `P0 1 · P1 2 · P2 3 · P3 0 · tolerance P1≤1 · over by 1` and
   the findings themselves — `F-07 · Token write is not atomic · src/auth.ts:43`
   — with the actions under them.
2. **What you said**, timestamped: `you · 13:48`.
3. **What the pilot said back.**

The app draws only (2) and (3). **The round cards are entirely absent.**

Every complaint about not being able to tell what the loop is doing or what to
inspect is this finding. The design's answer to *"what am I supposed to do after
a question round"* is that the round left a card in the log saying what it
found and what the options are. The app's answer is a narration line in a
different tab.

**Verdict: the design is right, and this is the thing to build first.** It also
subsumes several patches already made — the questions tab, the findings tab and
half the loop column are round-card content that has been scattered into panes
because the card does not exist.

### Closed — the card exists, and the log is one scroll

`cockpit/rounds.ts` derives a card per phase group from what is already on `Run`;
`pilot/log.ts` places the cards among the replies; `pilot/RoundCard.tsx` draws
one. Both derivations are pure and tested, because a rule that only lives in a
`.map` cannot be.

Two things are narrower than the frame, each for a reason on the wire:

- **No `claude/opus`.** A turn frame carries a role and a kind and no model.
- **No `accepted after 1 critique`.** Nothing says which critique approved which
  draft.

**A third caveat has been removed, and the removal is worth recording.** This
section originally read *"a card is a phase group, not a lettered version —
collapsing `planning` and `critique` into `plan v.b` would mean deciding here
which critique belongs to which draft, and no frame says."* That was accurate
about the wire and wrong about the domain, and a reader spotted it from the
screen: the loop column drew `plan`, `code` and `review` with no visible critique,
and asked where it lived.

It lived in cycle 1 as a row. What was actually wrong was worse than that, and
all three were the same mistake — grouping by **phase** where the loop converges
by **round**:

- A cycle counting its phase groups called two plan rounds **three rounds**.
- `revisePlan` announced no phase, so the planner turn producing the *next*
  version landed inside the **critique that caused it**.
- `planning` carried no round at all, so the first row was unnumbered.

The last two were core defects and are fixed there, and both are correct under
any grouping. With both halves of a round now carrying the round number, *"no
frame says"* stopped being true — which is what makes the round **chip** readable,
and the chip is what pairs the halves now.

### The loop column draws four peer groups, and that is an owner's decision

The frame in this section is the pilot's log and it is unchanged. The **loop
column** now draws `PLAN · PLAN CRITIQUE · CODE · CODE REVIEW`, which is not in
the hi-fi and is not derived from it. It was asked for directly, after the
alternative was built and looked at.

**The objection was raised, and it stands rather than having been answered.**
Four peers read as four stages, and the loop is not a pipeline — it is three
nested convergence cycles, which is the claim the three-group column existed to
make. What the three-group column cost was legibility: the critique is half the
plan cycle's work and every one of its Codex turns, and it had no heading
anywhere on screen. *"Where does plan critique live?"* had no good answer.

Three things carry the weight the headings gave up, and none is decoration:

- The labels say **`GROUP`**, not `CYCLE`, so the numbering does not claim a
  sequence.
- **`re-runs on every fix`** prints under both groups that genuinely re-open.
- The **round chip** is what pairs a row with its other half one group away. With
  the halves in two groups it is the only thing saying which critique judged
  which draft, which is why the core now puts a round on `planning`.

### The pair did not survive in the log, and the reason is measured

The first cut kept hi-fi 5's card intact: `rounds()` gathered across the two
column groups and produced one card per round, `plan v.b · accepted after 1
critique`, with a three-valued `RoundFamily` beside the column's four-valued
`CycleKind`.

**It made the critique invisible in the log.** A merged card is placed at the
round's *start*, so a critique beginning twenty minutes later updated a card that
was already off the top of the scroll — and the next report was exact: *"it moved
to Group 2 · Plan Critique but that never updated the pilot chat like the plan
rounds did."* A log that does not move when the loop moves is not a log, which is
this section's own complaint one level down.

So `rounds()` produces one card per phase group and `RoundFamily` is gone. The
cost is the sentence: two cards cannot say *accepted after 1 critique* in one
line. The **round chip** carries the pairing on both halves instead, which is the
same mechanism the column uses one column over. If the sentence is wanted back it
belongs in a summary above the cards, not in a card that hides half its own
arrival.

A census and a verification pass attach **by arrival**, because a census carries
no round of its own and a pass carries the *verify* round — a different counting
from the one a phase group is keyed by. One that predates every phase, which is a
real state on a resume, attaches to nothing.

The interleave never reorders the conversation: `Reply.startedAt` is nullable by
design, so replies keep their order and cards are placed among them.

**And a card's heading is now the way into its own round** (#223). Hi-fi 5's card
is a *summary* — the prose lives in the round's artifact — so the shortest path
between the two is the name of the round, and it was not a link: only the counts
navigated, and only to a Findings tab that showed the latest round of whichever
judge spoke last. Reported as *"clicking on any of the plan, critique etc boxes
should take me to that tab and that relevant section expanded on that tab."*

Two things make that a link rather than a jump. `PANE` is a **closed map keyed by
`CycleKind`**, so a fifth group fails to compile here rather than producing a card
whose heading goes nowhere — the rule `format.ts` already follows for boundaries
and exit codes. And the **round travels with the tab**: a card summarises one
round, so a link that opened the pane at whichever round happened to be newest
would be the wrong one every time except the last. It is the round number rather
than a filename, because both ends already hold the round and a filename would
put the loop's naming convention in a third place.

### 1.4 · The output pane is narration; the design's is a tool timeline

Hi-fi 1's Output pane is a timestamped record of what the agent *did*:

```
14:02:11  ▸ read src/appserver.ts (612 lines)
14:03:04  ✎ edit src/appserver.ts   +48 −6
14:03:52  ✎ new  src/auth.ts        +121
14:04:58  ✓ typecheck clean
14:05:10  ✎ edit tests/appserver.test.ts +30
```

Above it, a strip naming the turn: `implement · claude/opus · medium ·
bypassPermissions · follow ✓`. Below it, the liveness dot and `working · last
activity 8s ago`.

The app draws the loop's **narration stream** — prose lines with an id and a
level — filtered by phase. That is a different artifact: it is what `vibe` said,
not what the agent did.

**Verdict: unresolved, and it needs a decision rather than a fix.** The design's
timeline needs per-tool-call events with timestamps and edit sizes. `#66`'s
`toolItems` is the nearest thing the core records, and the scorecard census
found it on **34 of 265 turns** — so the data to draw the design's pane mostly
does not exist. Either the core starts recording it, or this pane is
deliberately a different pane and the design should be marked as unbuildable
here. **What it must not become is the timeline drawn from narration text**,
which is the English-matching #133 exists to prevent.

### Closed — the two ends built, the middle refused and named

Hi-fi 1's Output pane is three parts: a strip naming the turn, the timeline, and
a liveness line. The app had the middle one and neither end.

**Both ends are built**, because both are measured. `TurnStrip` draws the role,
the kind and the round `turn_started` named, plus `7c`'s output clock. The model,
the effort and the permission mode are **not** filled in from the config's role
table, which is the obvious source: that table says what a run *will* do, and a
session rotation or an alias resolving elsewhere would leave the strip
confidently describing a turn that is not the one on screen. The absence is named.

**The timeline is refused, and the pane says so.** 34 of 265 recorded turns carry
`toolItems`, so drawing it from the archive would be drawing 13% of a pane
presented as all of it — and reconstructing it by reading these sentences is
exactly #133's failure. The footnote names #66 and #133, the way the launching
row names #114 for its missing ETA.

### 1.5 · The loop column is missing its identity header

Hi-fi 1 opens the loop column with three lines: the workstream name
(`add-appserver-auth`), the branch (`vibe/add-appserver-auth`), and the path
(`~/wt/vibe-code/add-appserver-auth`). The app starts at the cycles.

Small, cheap, and it is the only place the window says which repository you are
looking at once the titlebar is scrolled past.

**Verdict: the design is right; this is an afternoon.**

### Closed — three lines, and the branch is told rather than derived

`Identity` in `LoopColumn.tsx`. The task and the repository now ride on
`run_started`; `dir` is the *run's* directory and was never the repository, so
the two are separate fields rather than one guessed from the other by trimming
`.vibe/runs/<id>` off the end.

The branch is a new narration id, `run_branch`, at each of the seven places
`prepareGit` settles the question. **It is not `vibe/<run-id>` derived here**:
that is a convention `git.branchPrefix` can change and `--no-branch` can remove.
A run with no branch of its own says which kind of none it is — isolation off,
never had one, the recorded branch deleted — and a core older than the id leaves
the line as a named absence rather than blank.

Nothing new became durable: `state.branch` was already in `state.json`, so this
is narration with no event, on the `findings_reported` precedent.

### 1.6 · The footer states the mode; the app states the boundary

Hi-fi 1's footer is a mode readout — `mode · auto ● · step · next stop: verify
gate` — with `⏸ pause after this turn` and `⏹ stop` beside it. The app's footer
draws the gate that is currently holding and its two buttons.

These are not the same claim. The design's says *where control will next come
back to you*; the app's says *where it has come back to you now*. The first is
useful when nothing is holding, which is most of the time.

**Verdict: both are right and the app is missing one of them.** `gates.ts` has
the matrix, so `next stop` is derivable without inventing anything.

### Closed — and the objection it overrules is answered, not waved away

The footer refused this in its own comment: *"which one comes next would need a
phase-to-boundary ordering written here, and a wrong one is a promise the app
cannot keep."* Both halves are still true and neither applies to `nextHold`:

- **The order is told.** It arrives on the `config` frame as `GATEABLE`, whose
  own comment reads *"Order is the loop's, not the alphabet's."*
- **The position is told.** It is `run.lastGate` — the last boundary that
  actually held, recorded from an `ask`. No phase is mapped onto anything.

What it can still be wrong about is that the loop may **pass** a boundary without
reaching it: a plan the critic clears first time never has a second plan round.
So the wording is *the next place it can stop*, never a prediction that it will.
Wrapping is the answer rather than a fallback — cycle 2 re-opens on every review
fix. `nexthold.test.ts` reads `GATEABLE` out of `src/gates.ts`, so a seventh
boundary fails in the repo that adds it.

### 1.7 · Findings are drawn as facts, not as claims with provenance

Hi-fi 9 is explicit: *"Every other screen shows findings as facts. This one
shows them as claims with provenance — who said it, what it rests on, whether
that checked out, and which of two very different guards demoted it."* Its five
cases are grounded-and-blocking, downgraded-by-grounding, grounded-but-
uncheckable, human-authored, and declined-with-reason.

The core has all of this — `Finding.raisedBy` (#141), `downgraded`,
`severityChanges` (#142), `reproducer` (#113). The pane does not draw the
distinctions.

**Verdict: the design is right and the data exists.** This is the best
ratio of value to work in the audit.

### Closed — and the finding was half wrong, which is worth recording

Four of hi-fi 9's five cases were **already drawn**: the author (#141), the
citation count and its ungrounded flag, a guard's downgrade and a person's
restore, each in its own line and never sharing one. The audit was written from
the frame rather than from the pane and overstated the gap. That is the finding
corrected rather than removed — the correction is the record.

What was genuinely missing was the third case, *grounded but uncheckable*.
`Finding.reproducerOutcomes` has been durable since #113 and was never narrated,
so the pane could not tell a claim nobody could check from a claim nobody tried
to check. `sayFindings` now carries the whole list — both moments, because the
same test run at `review` and after the final fix answers two different questions
— with the `unproven` reason, which is most of the value of `unproven`. `defer`
travels with it for the fifth case.

A finding with no reproducer says so in words. #113 is explicit that it behaves
exactly as every finding did before reproducers existed, so the absence is drawn
as provenance and never as a mark against the claim.

### And the claim itself, which the pane could not reach (#223)

Everything above is *provenance* — who said it, what it rests on, whether that
checked out. What none of it could show is the **claim**: what is actually wrong
and what would fix it. `Finding.detail` and `Finding.suggested_fix` were never on
the wire, deliberately, because a frame carrying every finding in full would put
a review's whole report on the wire every round — so the pane had a severity, a
title and an id, and the argument was in a file it could not open. Reported as
*"can we provide any more additional information beyond just the title and some
meta data?"*, which is the same gap read from the other side.

`ReportPane` reads the round's own artifact, so a finding opens onto the detail,
the suggested fix and **every citation with its excerpt** — the places it says to
look, in the form a person can go and check. The judge's `summary` comes with it,
which is the paragraph a reader wants before any individual finding and which no
frame has ever carried.

**Two sources, one screen, and the split is not incidental.** The round's own
`code-review-<n>.json` is deliberately not rewritten when a severity moves
(#142) — it is the record of what the reviewer produced — so the file holds the
prose and the census holds what happened to the finding afterwards. The pane
reads both and matches them on the finding id. A pane reading only one would be
missing half, and which half would depend on which round you opened.

### 1.8 · The nine remaining frames, walked

These were listed unwalked in the first pass and are walked here. Four were
already right, three had a gap that has been closed, and two are unbuilt for
reasons that are not about the design.

**Hi-fi 8 · the diff — already right, exactly.** The frame publishes its values
and `tokens.css` holds them: `--diff-added-row: #343c34`, `--diff-removed-row:
#3f3737`, both gutters, both code tiers. The one subsystem the design worried
would break the palette is the one that was transcribed most precisely.

**Hi-fi 6 · the verify pane — already right.** `VerifyPane` carries the loop's
own verdict word rather than deriving it, the per-attempt cards, the command, and
the plain-language reading of `flaky` versus `failing`. It does not name *the one
test that disagreed with itself*, and it cannot: #135 chose a whole-gate verdict
on purpose, because a per-test table means tracking TAP, JUnit XML and `node
--test` output for ever. That is a settled decision, not a divergence.

**Hi-fi 13 · staleness — right in its states, one gap closed.** The three states,
the two clocks and the refusal to threshold on one were all built. What was
missing is that the design draws **both clocks on the stale strip as well as the
quiet one**, and says why: they are the same two numbers the code branched on, so
they are the cheapest explanation of why it reached this conclusion rather than
the other. `Clocks` adds them, with the host pid beside them — labelled as the
host's, because the window is told nothing about the agent child and an unlabelled
pid is one a reader will attribute to the turn.

**Hi-fi 2 · the blocking cockpit — one gap closed.** The halt banner in the
footer's place, its actions and the severity ramp were built. What was missing is
that the design puts the **four counts on the round card in the loop column**, not
only in the findings pane — and it says why: the peripheral scan, where a run in
trouble should look different from across the room before any text is read. The
counts are drawn twice on purpose. `Phase` takes its census through `rounds()`
rather than matching one itself, so the column and the pilot's log cannot
disagree about which round a census belongs to.

**Hi-fi 14 · the question loop — one gap closed.** The nested group was there; its
own counter, its checkboxes and its *not stalled* sentence were not.
`questions_opened` now carries the round and the cap — hi-fi 14's *"its own
counter and its own cap"*, and `round 3/3` is the state the escalation is about.
The waiting line is drawn only while something is genuinely outstanding so it
cannot become a reassurance nobody reads.

Two things about it changed after a manual pass, and both were reported. The
group was drawn at the **foot of the whole `PLAN` group**, so the moment a second
plan round opened, round 1's questions appeared beneath round 2's row; it is now
placed on the round it opened during, through the same `during()` a census goes
through. And the **per-question list is gone**: hi-fi 14's checkbox marks were
built, and in a 364px column a list of paragraphs pushed every later round off the
screen. The row is a count — `4 raised · 1 blocking · 2 unanswered` — and clicking
it opens the Questions pane, which is where the wording, the answerer's draft and
the composer already live. The *"· not stalled"* half of the kicker also went: the
sentence under it says the same thing in words a person reads once.

Two more came out of the next manual pass (#223). **The whole box is the control
now, not the count inside it** — *"clicking anywhere on the Questions box should
lead to the questions tab, not just the N raised text"* — which is the finding the
severity chips one level up had already earned: the largest thing on the surface
was inert while something smaller beside it did the navigating. It is a
`role="button"` on the container rather than a `<button>` around it, because the
box holds the answerer's turn rows and a control inside a control is one a
keyboard cannot reach; Enter and Space are handled where the role promises them.

And **the pane behind it is one section per round**. It drew the round in flight
and nothing else, so every earlier round was gone — including on a resume, where
*every* round is an earlier one and the pane opened empty on a run that had asked
nine questions. `answers-<n>.json` was on disk the whole time. The live round is
drawn from the wire and the settled ones from their files, through **one** card
component: a round read from disk must not be drawable in a way a live one is
not, or the two drift and the drift is invisible on whichever half nobody is
looking at.

**Hi-fi 7 · project settings — three of eight sections, and a nav for three is
navigation for nothing.** The frame's table of contents lists Repository, Verify,
Gates, Budget, Loop limits, Roles & models, MCP servers and Prompts. The app has
Gates, Roles and the raw file. The five missing ones are **new capability, not a
divergence**: each needs its own validated writer through `writeConfigPatch`, and
the frame's own chips say as much about them. The form vocabulary the design
settles here — square hairline controls, the two-cell switch, dashed-for-locked —
is what the built sections already use.

**Hi-fi 10 · the launch modal — superseded, and the part that survived is built.**
The frame is a modal whose task field, pilot exchange and derived brief are now
the pilot pane itself (#211); rebuilding it would restore the front door the
complaint was about. What survived is the overrides block, and its rule — *"list
only what differs; forty rows where two matter is a list nobody reads"* — is what
`NewWorkstream` is. It also sets the elevation rule, which `Modal` follows and is
still the only shadow in the product.

**Hi-fi 11 · hide vs quit — unbuilt, and it needs a Rust decision rather than a
component.** The dialog's job is to state the cost of quitting mid-turn, and
`StopConfirm` already states exactly that cost for a stop, in the same words and
with the same *unknown, never estimated* rule for a killed Codex turn. What does
not exist is the **window-close interception** that would put it on screen, and
that is a `src-tauri` change to close-requested handling plus a tray story. Named
here rather than half-built: a dialog with nothing calling it is worse than none.

**Hi-fi 12 · nothing here yet — one of four built, and the other three are
onboarding.** *"No findings yet"* exists, as does the loop column's waiting state.
The other three — no providers, one provider, no workstreams — are a first-run
flow, and the first of them cannot be drawn honestly yet: *"Claude found. Codex
not"* is a preflight probe result, and nothing runs a probe before a run exists.
That is `vibe doctor`'s answer and there is no frame that carries it.

---

## 2 · What was done, in the order it was done

1. **The round card** (§1.3) — `rounds.ts`, `log.ts`, `RoundCard.tsx`.
2. **The rail** (§1.1), which emptied the tab bar (§1.2) with nothing deleted.
3. **The loop column header and the mode footer** (§1.5, §1.6), which needed two
   new narration ids in the core — `run_branch`, and `repo`/`task` on
   `run_started`.
4. **Findings with provenance** (§1.7) — the reproducer verdict promoted onto
   `findings_reported`.
5. **The output pane decided** (§1.4) — both ends built, the timeline refused in
   writing.
6. **The nine frames walked** (§1.8).

Nothing in §1 was a colour, a font or a spacing value. The design system was
transcribed correctly; what was never transcribed is the composition, because
composition does not survive being written down — which is the case for keeping
this file beside `HANDOFF.md` rather than treating either as finished.
