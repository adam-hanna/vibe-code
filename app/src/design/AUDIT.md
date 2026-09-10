# The built app against the hi-fi — a divergence audit

**Status: findings only. No code has been changed on the strength of this document.**

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

### 1.5 · The loop column is missing its identity header

Hi-fi 1 opens the loop column with three lines: the workstream name
(`add-appserver-auth`), the branch (`vibe/add-appserver-auth`), and the path
(`~/wt/vibe-code/add-appserver-auth`). The app starts at the cycles.

Small, cheap, and it is the only place the window says which repository you are
looking at once the titlebar is scrolled past.

**Verdict: the design is right; this is an afternoon.**

### 1.6 · The footer states the mode; the app states the boundary

Hi-fi 1's footer is a mode readout — `mode · auto ● · step · next stop: verify
gate` — with `⏸ pause after this turn` and `⏹ stop` beside it. The app's footer
draws the gate that is currently holding and its two buttons.

These are not the same claim. The design's says *where control will next come
back to you*; the app's says *where it has come back to you now*. The first is
useful when nothing is holding, which is most of the time.

**Verdict: both are right and the app is missing one of them.** `gates.ts` has
the matrix, so `next stop` is derivable without inventing anything.

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

### 1.8 · Frames I have read but not yet compared line by line

Stated rather than left implied. I have read each frame's caption and structure
but have not walked the built screen against it:

- **Hi-fi 2 · the blocking cockpit.** Halt banner takes the footer's place; the
  severity ramp at full load.
- **Hi-fi 6 · the verify pane.** The verdict is the run-to-run *variance*, not a
  test list; it names the one test that disagreed with itself and stops.
- **Hi-fi 7 · project settings.** The form vocabulary the design says everything
  else inherits.
- **Hi-fi 8 · the diff.** Added and removed need *backgrounds*, not the two
  inline label colours; must hold at 12px mono.
- **Hi-fi 10 · the launch modal.** Now partly moot — the launch form moved into
  the pilot in #211 — so this frame needs a decision, not an implementation.
- **Hi-fi 11 · hide vs quit.**
- **Hi-fi 12 · nothing here yet.** *"The only screens with no data, which makes
  them the only screens that are entirely tone. Each teaches one idea and ends
  in one action. No tour, no checklist, no progress ring."*
- **Hi-fi 13 · staleness.** Two clocks, three states; *"silence is not a
  threshold."*
- **Hi-fi 14 · the question loop.** A nested group inside cycle 1 with its own
  counter and cap. *"The loop column's job while one runs is to not read as a
  stall — the run is waiting on an answer, which is a different thing from
  being stuck."*

---

## 2 · What I would do, in order

1. **The round card** (§1.3). It is the product's main object and its absence is
   what makes the app feel like a different application from the design.
2. **The rail** (§1.1), which then empties the tab bar (§1.2) without anything
   having to be deleted outright.
3. **Findings with provenance** (§1.7) — all the data is already recorded.
4. **The loop column header and the mode footer** (§1.5, §1.6) — both small.
5. **Decide the output pane** (§1.4) before building anything there.

Nothing in §1 is a colour, a font or a spacing value. The design system was
transcribed correctly; what was never transcribed is the composition, because
composition does not survive being written down.
