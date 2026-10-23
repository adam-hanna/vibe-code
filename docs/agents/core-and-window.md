# What the core tells a window

Part of the working notes for this repo; [AGENTS.md](../../AGENTS.md) is the core and links here.
Moved out of AGENTS.md word for word on 2026-10-20, so where a note says *this file* it means
AGENTS.md and these companions together. Read this before changing the code it describes, and
update it in the same PR when that code changes.

**A fact the run records and never says is a screen that cannot be built** (#223). The loop
has always known whether the verification gate passed, what a round's four severity counts
were and how they compared to the tolerance — it wrote every one of them to `state.events`
and said none of them, so a host could watch a run for ninety minutes and never learn the
verdict. Half the design corpus was blocked on that and not on a missing measurement.

Three more of those were found by the audit and promoted the same way, all narration with no
event because each is already durable in `state.json` or in a round's own artifact:
**`run_branch`**, said at each of the seven places `prepareGit` settles the question — not
derived as `vibe/<run-id>`, because that is a convention `git.branchPrefix` can change and
`--no-branch` can remove, and a run with no branch says *which kind* of none it is;
**`repo` and `task` on `run_started`**, because `dir` is the run's directory and was never the
repository; and **`round`/`cap` on `questions_opened`**, which is hi-fi 14's nested counter
and the state its escalation is about. A fourth is `reproducer` on `findings_reported`:
`reproducerOutcomes` has been durable since #113 and was never narrated, so the findings pane
could not tell *a claim nobody could check* from *a claim nobody tried to check* — hi-fi 9's
third case, and the only one of its five that was genuinely missing.

A fifth is **`round_committed`** (#223). `maybeCommit` has always printed `Committed abc1234`
and the sha has always reached the checkpoint's own meta; what had no id was the **pair** of
shas, so nothing watching a run could show what one round changed while the run was going. It
carries `since` as well as `sha`, and `since` is read from HEAD *before* the commit — the
alternative a host is otherwise left with is pairing consecutive commits in narration order,
which is a derivation that goes silently wrong the first time a run is resumed and the earlier
commits were narrated to a process that has exited. Null `since` is a first commit in a
repository that had none, which is a real range and not a missing field.

A sixth is **`artifact_written`** (#223), and it is the clearest case of the rule: the file
*is* the durable record, so recording that it was written would store one fact twice.
`artifact()` says it after the bytes are on disk, at `detail`, carrying the name. Without it
every pane that reads a run's own directory is a **snapshot taken when the tab was opened** —
a critique round finishing while you watched the critique tab changed nothing on screen, and
the only way to see it was to navigate away and back. The alternative a window is otherwise
left with is deciding that `findings_reported` implies `code-review-2.json` now exists, which
is the loop's naming convention copied into the one process that cannot be kept in step with
it, and which fails *silently* — as a pane that stays on the previous round. It is said after
the write for the same reason `round_committed` reads HEAD before the commit: a signal that
can beat the thing it signals is not a signal. `Run.artifacts` holds the names rather than a
counter, and a name written twice is appended twice, because a plan round that answers its own
questions rewrites `plan-<n>.json` under the name it already had and that second write is
exactly the event a pane holding the first one needs.

**`model_said` is the seventh, and it is the one that is not a promotion** (#223). Everything
above was a fact the run already held and did not say; this is a fact that was on the stream
and thrown away. `lastActivity` is a *tool name* — `Read src/gates.ts` — so the output pane
could say what vibe was doing and which tools ran, and never what the model was reasoning
about: *"Output needs to be more verbose about the model and what it's thinking. Right now
it's more like what vibe is doing."*

`parseClaudeLine` collects `text` blocks on the same walk that tallies `tool_use`, and
`parseCodexLine` takes `agent_message` on `item.completed` — **only** that item, because
`reasoning` has never been seen carrying text here and reading a field off an item nobody has
observed is guessing at a shape. The parsers **collect into `snapshot.said` and never narrate**,
because `onLine` is documented as the only site in `progress.ts` that emits and a parser with a
side effect is one that cannot be driven in a loop by a test.

Three decisions travel with it, all the owner's. It goes **everywhere** — pane, terminal and
`transcript.log` — rather than only to the host sink, because a transcript that disagreed with
what the app showed would break *"one channel, two renderers"* in the one place it matters.
It is **on by default**, with no config key, so there is no second way for two installs to
disagree about what a run said. And a block is **uncapped**: a model that writes four thousand
words puts four thousand words in the pane, since the alternative needs a character limit,
which is a number with nothing behind it, and a truncated thought is the half not worth
reading. `detail` is the level, so the agent's prose reads dimmed beside the loop's own steps,
and the pane draws it as a quotation **off the id** — never off the sentence, because a line
the model wrote and a line the loop wrote are different kinds of claim.

The move is a **promotion, never an invention**, and `recordAndSay`'s own rule is what makes
it safe: *"narration never creates an event."* The durable set is exactly what `recordEvent`
records, so turning `recordEvent` + `log.*` into one `recordAndSay` adds nothing to
`state.json` — and where the two calls already sat beside each other, the terminal does not
change by a byte. `narration-identity.test.ts` pins the id sequence of a clean pass and
`durable-narration.test.ts` pins the event set, so the two halves of that claim fail
separately.

Two things travel with it. **A census is narration with no event**: `findings_reported` and
`questions_answered` carry a round's counts and the answerer's confidence, and neither is in
`state.events`, because both are derivable from the round's own artifact and a resume needs
neither — #133 measured what happens when that question is answered casually, and the answer
is that the run's memory roughly quadruples on the shortest possible run. And **the id is the
event type**, never a name of its own: `applyCharge` narrates under `claude_turn` /
`codex_turn`, the same string it just recorded, so a host acting on the fact and an archive
holding it agree about one fact rather than two spellings of it.

**Nine frames are reads, and a read runs beside a run** (#223). `archive`, `stats`, `config`, `diff`,
`artifacts`, `artifact`, `prompts`, `replay` and `fs` answer a question rather than describing something
that happened,
which is a shape the wire did not have — every other outbound frame is pushed. They are exempt
from `serve.ts`'s one-at-a-time rule for a stronger reason than the pilot is: that rule exists
because two *runs* would interleave their narration, and `listRuns` is documented as never
throwing and never writing. A second `invoke` is still refused, which is what keeps the
exemption honest.

Five things about them are load-bearing:

- **A config *write* is refused during a run, and a read is not.** A run reads
  `vibe.config.json` once, at the top of `main`, so saving mid-run cannot affect the run in
  flight — but it would leave the settings screen and the running loop describing different
  configurations with nothing on screen saying so.
- **`diff` requires its base and there is no default.** `diffSince(cwd, null)` runs `git add
  -A` before it diffs, staging the user's whole working tree; a read frame that modified the
  index would be the worst kind of surprise, so the decoder refuses a request that cannot
  name a base rather than letting it reach that path. The base comes from `phase_started`,
  which carries it from the moment the implement phase marks it.
- **`writeConfigPatch` merges into the *raw* file, never the effective config.** A form
  editing what `loadConfig` returns and writing it back would bake every current default into
  the project file, so the next release's improved default would never reach that repository
  — and nobody could tell which values were chosen from which were merely observed. Both
  travel on the frame for that reason. It runs the same pipeline `loadConfig` runs and writes
  only if the whole candidate validates, so a refusal leaves the file exactly as it was.
- **A `diff` that names both ends is one round; one that names only its base is the whole
  change.** `headSha` is optional and the two are different questions, so the frame says which
  is being asked rather than defaulting into either. It takes `diffRange`, which runs exactly
  one command and answers an empty round emptily — `diffSince`'s fallbacks are written to hand
  the *reviewer* something, and a round that changed nothing answered with the working tree
  would show a person their own edits under a round's label.
- **`artifact` names a run and then a file inside it, so it has a containment story the other
  three do not need.** `assertUsableRunId` closes the first and `isArtifactBasename` the
  second, both refusing rather than repairing, and the refusal reaches the sender as an
  `error` frame naming what it refused — an empty read would be indistinguishable from a file
  that is not there, and those need opposite responses. `linkedArtifactReason` runs before
  anything reads through the path, which is #53's rule, and the three-answer `ArtifactRead`
  travels whole so a pane can say *this was never written* rather than *this could not be
  read*.

**Every write is announced, because a second client's stale cache would overwrite it**
(#354). `memory_save`, `chat_save` and a `config` patch each make the service host send
`changed` - what, key, the write's own id, and its `origin` when it had one - once the file is
on disk and after the write's reply. A read, a refusal and a failed write send nothing, and
`delete_run`, `answer_questions` and command output are not announced, since the panes re-read
those when opened. The frame carries no value: `memory.ts` and the chat store re-read with the
reads they already use (`app/src/changed.ts` holds the decisions), the writer ignores an id it
allocated, a key with a write of its own debounced or in flight keeps its local value, and a
store reconciles what was announced while it was loading. **Two writes to one key race and the
last one wins**, a start-up migration included; what is guaranteed is that the cache agrees
with the disk, which is what stops a stale save. A config write's origin travels on `changed`
and is never written - `vibe.config.json` is committed - while an invoke's is recorded once as
`run_origin`, by `gate_released`'s carve-out, so a run with none is byte-identical. **An
invoke's origin is also said on `run_started`** (#365), on the start and both resume paths,
with the key absent rather than null when there was none (`originData`). It is said there and
**not recorded again**: `run_origin` is already the durable row a later reader asks, and a
second one would be two records of one fact; `run_started` is the frame a window builds a run's
identity from, so carrying it there is what lets *Started from <phone>* be drawn without joining
narration to `state.events`. A replayed run (`src/replay.ts`) does not carry it yet: the
replay says one `run_started` for the whole run, while `run_origin` is one row per invoke, so
choosing which row to put on it is a decision #365 left alone.

**And what is on screen follows it, both ways** (#371). #354 kept the caches right and nothing
read them again: every reader took its value once, so a project added on the phone, a message
sent from it or a model picked on it reached the desktop's cache and not its screen until
somebody navigated away and back. The owner's line: *"EVERYTHING needs to be in sync and
updated bidirectionally in real time."* Four rules carry it:

- **A store says which keys moved, and only on a change of value.** `memory.ts` and the chat
  store count each key another client changed (`useMemoryRevision`, `useChatRevision`), and
  `useFollowedMemory` is `useState(read)` that reads again when its key moves. A re-read
  writes nothing, so a client's own write coming back moves nothing and nothing loops. The
  drafts are re-read through their one writer, unsaved.
- **The conversation on screen is restored again when another client saved it**, never over a
  turn this pane is streaming. The pilot's vendor, model and effort are one pick in memory
  (`pilot/pick.ts`), shared by every client, as they were within one window.
- **A pilot turn is announced** (`pilot_started`, naming the chat and what was sent), so a
  second client showing that conversation draws it as it streams and can stop it
  (`pilot/elsewhere.ts`); it is drawn and never kept, since the asker saves it. `pilot_turns`
  answers a client that opens mid-turn. **One conversation takes one turn at a time**: the
  host refuses a second, because two turns resuming one session would each answer blind to the
  other. Not a protocol bump, by the rule above `PROTOCOL_VERSION`: a host that never
  announces leaves a window drawing what it drew before. **An API-key turn is announced by
  Rust**, the same way on its own road: `pilot_send` takes an `announce`, emits an `announced`
  pilot event before the thread starts, keeps the text so far for `pilot_turns` (a new command,
  answering only what every client was already sent) and refuses a second
  turn in one conversation. The id comes back after the announcement has gone out, so the
  asker knows its own turn by `asker`, a token of its window, rather than by id. The two
  roads' ids are two counters, so a drawn turn folds only what came down its own road, and
  is stopped back down it.
- **Settings, commands, deletions and answers follow too.** A config save bumps the cockpit's
  own read, the composer's and the Settings screen's; a field somebody is typing in keeps its
  text (`useTyped`), and a refusal always puts back what is in force. A `command_started`
  reaches every client and folds once per id, and `run_deleted` and `questions_answered` make
  the sidebar and the Questions pane read again. What stays per screen: unsent text, unsaved
  edits, scroll, and what each device has open (`deviceKey`, at the owner's decision).
- **And a new setting cannot be forgotten, because each place a change lives has a closed
  list.** Asked as *"What happens if we add a new setting or a new tab?"* A tab needs nothing:
  the phone runs this `src`. What can be missed is who hears a change, so `sync-guard.test.ts`
  fails on a `vibe.` key not in `MEMORY_KEYS` (shared or per device), on a device key not read
  through `deviceKey`, on a component reading a shared key without following it, and on an
  inbound frame not classified as a read or by the frame every client hears it on. In Rust,
  `COMMAND_REACH` in `control.rs` does the same for every allowed command. Writing them found
  three gaps, now closed: a key stored or forgotten, and remote access changed or a phone
  revoked, are announced as `desktop://changed` (`keys` or `remote`) and re-read; and a pause
  or stop is announced as `controls`, said before the asker's answer and only when it moved.
  A config key needs nothing: a save is `changed`, and the settings re-read it.

**The window predicts no filename, and `artifacts` is why that was possible** (#223). Four
tabs — Plans, Plan critique, Code review and Code — draw a run's own artifacts, and the
dangerous shape they could have taken is composing `plan-${round}.json` from a round number
the column already has. That is a copy of the loop's naming convention living in a process
that cannot be kept in step with it, and it fails *silently*: a renamed artifact does not
throw, it shows an empty tab, which is the failure nobody reports because it looks like a run
that has not got there yet.

So the listing is asked for and `app/src/cockpit/artifacts.ts` only **classifies what came
back**. The patterns are still a duplicate of the core's naming and are still not shared — the
app and the core are two packages, exactly as with `app/src/cockpit/raise.ts` — and what makes
that safe is the same thing: `artifacts.test.ts` reads `src/orchestrator.ts` as source and
fails on the commit that renames one. A name it does not recognise is `other` and is still
listed, because the loop is free to write an artifact this build has never heard of and the
honest drawing of one is its own name.

**Two tabs went, and each showed strictly less than what replaced it.** `Findings` was one
round of whichever judge spoke last, drawn from the four counts and a title the wire carries —
so a reader asking *why did the loop fix again* got half the evidence and no way to reach the
rest, because the detail and the suggested fix are in the artifact and a frame carrying every
finding in full would put a review's whole report on the wire every round. `Diff` showed one
cumulative diff, which is the right answer to *what has this changed* and cannot answer *what
did the fix round do*. Both questions still have a home: the second is `Code`'s first section,
still first and still what it opens on before any round has committed.

What the two panes must keep between them is the split over **where a fact lives**. A round's
`code-review-<n>.json` is deliberately not rewritten when a severity moves (#142), so the file
has the prose and the census has what happened to the finding afterwards — the reproducer
outcomes and the severity history. `ReportPane` reads both and matches them on the finding id;
a pane reading only one of them would be missing half, and which half depends on which round
you opened.

**A human finding still has no host frame, and the diff pane is what that looks like built.**
`1d`'s composer fills in `src/raise.ts`'s block — the citation taken from the hunk, so the
finding is grounded by construction — and hands it over to be pasted into `NEEDS-INPUT.md`.
That is propose-only in the #144 sense, and the markers are duplicated in `app/src/cockpit/raise.ts`
rather than imported, so a drift produces a block the resume **refuses with a reason** rather
than one it misreads. A test reads `src/raise.ts` as source and fails on the commit that
renames a marker.

**A ceiling that only fires between turns cannot stop the turn that is spending** (#211).
`applyCharge` enforces `budget.maxTokens` when a turn returns and is charged — so a turn that
never returns is invisible to it, and one was: a 27-minute implement turn reporting **8.8M
tokens** against a 25M ceiling, whose host then died mid-turn. That spend is not in
`state.json` at all, because the turn was never charged.

The heartbeat is the only thing that watches a turn *while* it spends, so `ProgressOptions.onSpend`
reports the running total each beat and `guardTurnSpend` calls `requestCancel` when the run's
total plus this turn's crosses the ceiling. Three things keep it honest: it **cancels rather
than throws**, so #209's latch kills the child and the loop turns it into the ending a round
cap already takes; it inherits `cancel.ts`'s rule that **only interruptible children die**,
never `git` and never the user's own verification gate; and the arithmetic is `applyCharge`'s
own, so **no new number is introduced** — `maxTokens: 0` still means no limit.

**A silent death now leaves a curve behind it.** That host died with no stack, no narration
and nothing on stderr — `host exited with code -1`, and a lock with no `ending.json`, which is
#131's signature for terminated-from-outside and says nothing about what did the terminating.
The heartbeat carries `rssBytes` (this process, not the agent's — the child is its own
process) and `outputBytes` from `RunOptions.onBytes`, because `run()` builds a child's stdout
by concatenation and every reader splits it again, so a turn that talks for half an hour holds
at least two copies of everything it said. **Both are measurements with no threshold
attached**: nothing here decides a number is too big, because nothing has measured what too
big is on this platform, and `budget.maxTokens` earned its 25M from a census this has no
equivalent of.

**That covers the endings vibe chooses. `run.lock` plus `ending.json` covers the ones it
does not.** A dead pid holding a lock has always meant two opposite things at once — vibe
decided to stop and never tidied up, or something killed it mid-turn — and #131 is what
separates them. Every ending vibe is *capable* of choosing writes a stamp beside the lock, so
a lock with no stamp beside it rules all of them out. That is not a diagnosis and does not
try to be one; it eliminates a class of causes, which is what the #87 investigation could not
do and therefore could not look past.

Two things about it are load-bearing and neither is obvious:

- **`SIGINT` is deliberately not stamped**, for the reason `acquireLock` gives in the same
  words: Ctrl-C keeps working exactly as it does. `SIGTERM`, `SIGBREAK` and `SIGHUP` are
  stamped and then **re-raised** rather than exited — the listener is removed before it runs,
  so the raise finds the default disposition and the process dies exactly as it would have.
  If the re-raise ever goes, this becomes the handler `acquireLock` refuses and that refusal
  applies to it.
- **The re-raise is allowed to fail, and the handler is not.** On Windows
  `process.kill(self, 'SIGHUP')` is `ENOSYS` — Node emulates the *delivery* of all three and
  can re-raise none of them — so the throw escaped the one handler whose header promises
  nothing here throws, and closing the app during a run killed the host with a stack in
  `vibe-desktop.log`. Every time, on the platform this repo is developed on. **Nothing was
  lost**: `write` runs before the raise, so `ending.json` was already on disk naming the
  signal, which is the whole of what #131 wanted; what was wrong was how the process left.
  The raise is now attempted, its failure swallowed, and `EXIT_UNRAISED` taken — because a
  process told to terminate and still running is the state `reaper.rs` exists for, and on a
  platform where the raise works that line is unreachable.
- **The host is spawned with no console, and that is what stops a stray SIGHUP killing a
  run.** `node.exe` is a console-subsystem binary, so `Command::spawn` with no creation flags
  attaches it to a console — the parent's if there is one, a freshly allocated one if not —
  and redirecting all three streams does not prevent that. Tearing down that console sends
  `CTRL_CLOSE_EVENT` to everything attached to it, and libuv delivers that to Node as
  **SIGHUP**, which the stamp above handles correctly and fatally. A run died four minutes
  into a plan turn at 314k tokens for exactly this: `ending.json` reading `"how": "signal",
  "signal": "SIGHUP"`, the window reporting `host exited with code 1`, and nothing on stderr —
  and a `node` spawned with the same options was then confirmed to have a console attached.
  `DETACHED_PROCESS` in `host.rs` is the fix.

  **`CREATE_NO_WINDOW` is the wrong flag, and it is the obvious one.** It suppresses the
  console *window*; the process still holds a console and can still be sent a control event.
  It was tried first, shipped, and disproved by measurement — `AttachConsole` against four
  children spawned with all stdio piped: no flags **has** a console, `CREATE_NO_WINDOW`
  **has** one, `DETACHED_PROCESS` does not. Note the consequence for `src/proc.ts`, which
  passes `windowsHide: true` for `claude` and `codex` — that is Node's name for
  `CREATE_NO_WINDOW`, so those children *do* hold a console. That is fine and is a different
  situation: with the host detached, each gets its own fresh window-less console rather than
  sharing one whose teardown would take the run with it.

  Two things this episode is worth remembering for beyond the flag. **The stamp did its job**:
  a lock plus `ending.json` naming a signal took this from #87's unexplained stop to a named
  cause in one read, which is precisely the class-elimination #131 was built to do. And **the
  exit code was the diagnosis** — 1 is `EXIT_UNRAISED`, outside `EXIT`'s 0–7, so it could only
  have come from the signal handler's failed re-raise, and nothing else in `src/` produces it.
- **The window can take a lock back, and only from a holder that is gone** (#211). `--force`
  had no control at all in the app, so a run whose host was killed could not be reopened from
  the window that killed it — and that is exactly the state a hard kill leaves. `Workstreams`
  offers it on `liveness: 'interrupted'` (dead pid, no stamp) and on `'unknown'` labelled as
  the guess it is, and **never on `'running'`**, which says so rather than going quiet: two
  writers on one `state.json` is what `src/lock.ts` exists to prevent. The verdict is
  `livenessOf`'s, not one the window derives, and a test reads the `Liveness` union out of
  `src/lock.ts` so a fifth verdict fails in the repo that adds it.
- **On Windows a child killed from outside is not observable as killed.** There are no
  signals: Task Manager, `Stop-Process` and any `process.kill` against a process this one did
  not spawn all become `TerminateProcess`, and the child closes with an exit code and no
  signal. `RunResult.signal` is the sharper answer where it exists and never the complete
  one, so the recording site asks `isAbnormal`, not `signal !== null` — and on the platform
  this repo is developed on the *parent's* stamp is the half that carries the finding.
