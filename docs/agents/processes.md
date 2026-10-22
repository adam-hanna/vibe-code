# Processes

Part of the working notes for this repo; [AGENTS.md](../../AGENTS.md) is the core and links here.
Moved out of AGENTS.md word for word on 2026-10-20, so where a note says *this file* it means
AGENTS.md and these companions together. Read this before changing the code it describes, and
update it in the same PR when that code changes.

**The app and the CLI are two front ends over one core.** The app links `src/` and calls
`orchestrate()` in its own process; it does not shell out to `vibe`. That is what makes a
gate an `await` at a phase boundary rather than an exit-and-resume, and it is why pausing
keeps the agent session warm.

Concretely: `src/main.ts → cli.ts` renders the loop to a terminal, and `src/hostmain.ts →
serve.ts` renders it to a pipe. **Both call `main()`** — a host request carries the same argv
the CLI takes, so which flags exist, when the lock is taken relative to the first state write
and what a resume does with `NEEDS-INPUT.md` all have exactly one definition.

The third process is Rust, and what it owns is **window, tray, single instance, spawning and
relaying — nothing else**. The core is Node ESM that spawns `claude` and `codex` through
`node:child_process`: it cannot run in a webview and it cannot run in Rust, so every line of
judgement about a run stays on the Node side. The relay parses exactly one thing — whether a
line of stdout is JSON at all — and only so a line that is not can be labelled rather than
passed off as a frame. **The moment Rust decides something about a run there are two
definitions of a legal run.**

**One host process per run, and the handle that routes it** (#246). The app used to be
one Node host running one run at a time: `serve.ts` kept one `running` id and refused a
second `invoke`. The fix is **a second process, never a second run inside one process** —
`src/cancel.ts` and `src/prompts.ts` hold per-process latches, and `src/lock.ts` is written
expecting one run per process, so all three stay exactly as they were.

- **A service host and a run host per invoke.** The service host starts at launch, as the
  single host did, and answers everything that is not a run: the reads, config writes,
  `delete_run`, `answer_questions`, the pilot and commands. Every `invoke` — a new run, a
  resume, an `--implement` — spawns a run host that serves that one invoke. `answer`,
  `pause`, `unpause`, `cancel` and `shutdown` go to the run's own host.
- **Every host is contained alike.** One builder, `host_command`, for every spawn:
  `DETACHED_PROCESS`, the reaper's job, `strip_verbatim`, and applog lines that name the
  host. **A run host has `VIBE_APP_DATA` removed, not merely unset** — it is inherited and a
  login shell can export it, and a run host that saw it would adopt the service host's
  command logs, two hosts following and able to stop one dev server.
- **The envelope is the relay's, and PROTOCOL did not move.** Every `host://frame`, `log`
  and `exit` carries `host`, the handle. A run id on the core's frames could never route a
  run's first frames — preflight narrates before any run id exists — and the handle can,
  because the window chose it (`run-<invoke id>`) before the host was spawned.
  `run_started` is what maps a handle to a run. Nothing in the window is matched by "the
  current run": a run frame reaches its run's reducer because its handle is that run's, and
  a run host's `result` reaches it only if it carries the invoke's id, since a pause, an
  unpause and a cancel are answered with `result` frames too.
- **How a run host is closed, every way.** Rust closes it — the same stdin close a quit
  uses (#206), then a kill after the grace — on the `result` carrying its invoke's id, which
  `send` read off the invoke line; that is the one field Rust learns from an inbound line.
  Only a `result`: every `result` id on a run host comes from the window's one allocator,
  `nextRequestId`, where an `error`'s id may be a gate id the host allocated, so Rust never
  correlates errors. An invoke that fails with an `error` is closed by the window sending
  `shutdown`. A host that cannot be handed its keys or its invoke is closed by Rust before
  `host_start` returns — the invoke travels *with* the start for exactly that reason, and a
  run handle with no invoke, or a first line that is not one with an id, is refused before
  anything is spawned. A host whose stdout ends is closed too, since nobody can hear it any
  more.
- **The window answers each gate once**, and that is what makes an `error` carrying the
  invoke's id unambiguous: `serve.ts` refuses an answer only when its gate is not in `asks`,
  and a gate leaves `asks` only by being answered or by the clear that runs after the
  invoke's own outcome frame. The two counters can coincide; no range fences them apart.
- **A host stays in the set until it has been reaped**, still listed by `host_status` and
  still killable, and its exit is relayed only after it has been removed. So the status
  read the window issues on an exit is the authoritative one, and reads carry a generation
  so an older answer cannot overwrite it. `Status` keeps describing the service host and
  lists run hosts under `runs`, so it never states a fact about a process it does not name.
- **`Run.lost`, and `settled()`.** A run host that exits before its invoke returned ends
  that run with the host-exit sentence: the turn, any gate and an unfinished preflight are
  closed, because nothing is executing. It is neither `completed` — a host's exit code is
  not one of a run's eight — nor `reason`, whose footer says the command has not returned
  yet. `settled(run)` is the one spelling of *the command is over*, because `lost` is a
  second way to be over and every site that asked only about `completed` would have held a
  dead run open. The service host exiting is what "the host exited" has always meant.
- **The config-write guard moved to the window**, because separate processes share no
  variable, and it says `serve.ts`'s own sentence. `serve.ts` keeps both its guards; inside
  one process they are still true. The pilot is never refused for a run. The window's
  second guard, *one run at a time*, is gone: see below.

**The window hosts several live runs at once** (#246, part B). Part A gave every run a
process; this is the window using them. `liveHost` and the one `useReducer` `Run` became
`lives`, a list of `LiveRun` in `app/src/cockpit/hosts.ts`, each carrying its own `Run`
folded by the **unchanged** `reduce` — there is no multi-run reducer. Every decision about the
list is a pure function in that file with a test beside it, because the app has no jsdom.

- **Keyed by handle until `run_started`, and by `(repo, runId)` after it — and both are read
  off the `Run`.** `runIdOf` and `repoOf` are `identity` first and the argv second (`asked`,
  `dir`). A copy of the id taken at launch is a copy `run_started` never updates, which is how
  an earlier draft of this drew a resume under the wrong run.
- **Routable is not drawable.** An entry routes from the moment `launch` adds it, so a frame
  that beats the start's promise lands on its run. It is drawn, and marked in the sidebar,
  only once `started`: a pid has arrived **or any frame has been routed to it**. Rust relays
  frames before `host_start` resolves, so the pid alone was too late — a run that had already
  said `run_started` stayed hidden behind whatever was on screen. A start Rust refuses
  produces neither, so it is never drawn. The first frame also **points** the window at the
  run (`point`), once, whichever of it and the pid comes first.
- **`viewing` picks what is drawn.** `onScreen` is the live, started entry `viewing` names by
  id and `dirKey` repository — so opening a run this window is hosting draws its live `Run`,
  not a replay — or, with nothing opened, `focus`, the run last started, including after it
  ends. Null means replay, and `columnRun` is still the one expression. `past` is now
  *opened and not live here*. Every control — answer, pause, unpause, stop — acts on the run
  on screen by its handle, and `mayAnswer` also requires that the gate is the one that run
  holds. A dead host marks only its own run `lost`.
- **Ended entries are pruned after a start succeeds, never before**, and only once their
  proposing conversation has been dealt with and they are not the one being drawn. Pruning
  ahead of a start Rust then refused would have erased the finished run on screen.
- **One writer each, ref first.** `updateLives` and `updateDrafts` assign the ref and then
  set state, and nothing else assigns either. The frame handler is registered once and reads
  the ref, and a second launch in the same tick has to count the first against the cap and
  see its draft as claimed.
- **`launch` has four steps and the order is the safety.** Refusals before anything changes —
  outside the app, the service host not connected (`connectedRef`, written in the exit
  handler before `setWire`), an argv whose `-C` it cannot read, a draft already starting, the
  cap. Then the claims, synchronously: the draft is marked and the entry appended. Then the
  start; a refusal from Rust reverses the claims exactly (`dropRun`, `unmarkLaunched`), says
  Rust's sentence in a strip, and **never** marks a run lost, because there was never a run.
  Only then anything visible: viewing, the repository, focus, and clearing the strip.
- **Rust refuses a run host while no service host is in its set**, a poisoned lock included,
  and checks it in `spawn` under the lock that admits the child — checked earlier, the service
  host could exit in between.
  The window learns the service host has gone from an event, and an event can be late; a run
  host beside no service host is a run whose window can read nothing about it.
- **The cap is `runs.maxConcurrent`, the machine's, and the window enforces it.** 0, the
  default, is no limit — `budget.maxTokens: 0`'s shape, because any other default is a number
  nobody measured. A project file that sets `runs` is refused by name on every road
  (`refuseProjectRuns`, beside `refuseProjectAuth`); `readGlobalConfig` does **not** read it,
  because no run does and a malformed value must not stop every run on the machine. The
  window reads it off `globalRaw` (`capOf`, sentence for sentence with `readMaxConcurrent`,
  and `hosts.test.ts` reads `src/config.ts` to keep them so) and has three states: a value it
  cannot use refuses every start, since reading *no limit* out of a value somebody wrote is
  the silent revert the cap exists to prevent; a cap not read yet refuses only while runs are
  live; and a number refuses at that many live entries, started or not, by name, naming the
  runs. Refused, never queued. Terminal runs are not counted.
- **A config write is refused per project.** A project write only while one of that
  project's runs is live, by `dirKey`, a start in flight included; a global write while any
  run is live, **except a patch touching only `runs.maxConcurrent`**, which no run reads and
  which is wanted exactly while runs are going. `auth` and `cli` are not exempt: `agentEnv`
  and `configuredBin` read them for every agent child a run spawns. The refusal names the
  runs. `host.setConfigGuard` is how the window's `writeRefusal` reaches `host.config`.
- **An effect says where it acts.** A pilot `run_command` runs in `effect.dir`, the directory
  its card displayed — what runs is what was displayed — and the Commands pane in the
  sidebar's project. With several runs on screen in turn, "where the window is pointed" was a
  second answer that could differ from the card somebody pressed. Kickoff stays on `repoDir`.
- **The cockpit is the one adopter, and the pane is held until adoption settles.** The pilot
  pane only restores now. `adoptionPlan` decides, for every unadopted run at once, with
  `chatMove`'s rule unchanged; the effect writes the chats first and marks afterwards, and not
  before the store is ready. Several runs proposed from one conversation each get the
  exchange and none gets the CLI session; the source is cleaned once, when nothing proposed
  from it is still waiting for an id. `heldChat` keeps the pane on the proposing conversation
  until that run's mark lands, **however the run reached the screen** — a run clicked in the
  sidebar the moment it appeared restored an empty chat and saved it over the one about to
  arrive. Following a run onto its adopted copy keeps a pilot turn still streaming
  (`sameExchange`), which adoption in the pane always did. **Adoption survives a relaunch no
  better than before**: the join was in memory on develop too, and a quit between pressing a
  proposal and adoption leaves the proposal under its draft or bucket key, not lost.
- **Hosted marks are per project.** A run id is unique only inside one repository's
  `.vibe/runs`, so `hostedMarks` takes the section's directory: marks keyed by id alone lit,
  and badged, a row with the same id in another project. A gate held by a run nobody is
  looking at is a static `alarm` badge on its row, and on its project's row while that section
  is shut, so a run cannot wait for a person who cannot see it.
- **Quit lists every live entry, started or not.** The tray's Quit, with run hosts in Rust's
  set, shows the window and emits `app://quit-requested`; the window draws one `Confirm`
  naming every run, worded as what it is — each stops where it is and can be resumed, only the
  turn in flight is redone — and calls `app_quit` on yes. Quit asks *which hosts will this
  kill*, and any live entry may have one; filtering by the drawing rule once let a quit skip
  its own confirmation while a run host was going. A host Rust still holds after its run
  returned, or after its invoke could not be written, is on no list and is quit without
  asking: nothing is running in it, and `stop()` closes it the way Rust already was. The
  guarantee is that no *run* is stopped unasked. A second Quit while that is unanswered is
  asked natively, since Rust knows handles and not names; a Cancel is an answer, and calls
  `app_quit` with `quit: false` so the next Quit asks through the window again. **`app_quit` is a deliberate new
  door**: it only exits, through the same `stop()` the tray uses, which is narrower than a
  process-exit permission that could skip the stop; `keys.test.ts` pins it. `stop()` drains a
  poisoned set rather than returning early, and closing the window still only hides it.
- **Implement continues in `identity.repo`**, as resume always did: `identity.dir` is the
  run's own directory, and `-C` there looks for the run inside itself. A run whose core sent
  no repo is not offered implement, and the footer says why.

**And the core refuses a second run in one checkout.** `sameRepositoryRefusal` in
`src/worktree.ts` runs in `main()` before the lock — before `allocateRun` on a start, so a
refusal leaves no run directory, and before `acquireLock` on a resume. It reads every
other run's lock under this repository's `.vibe/runs` through `livenessOf`, so a run
started from a terminal counts too:

| verdict | counts? |
|---|---|
| `running` | yes, named with its pid |
| `unknown` | yes, and the refusal names the lock file — a lock vibe cannot read cannot be ruled out |
| `interrupted`, `not-running` | no |
| the run being resumed | never, against itself |

It refuses only when either run would work in the repository itself: the live run has no
worktree (`state.worktree`, read off its record — a record that cannot be read counts as
none) or the new run would not get one. Both in worktrees is allowed. The sentence names
the runs and `git.worktree`, with `EXIT.PREFLIGHT`, and it is a refusal, never a queue.
**It looks twice.** The first look and the claim are two steps, so two starts could both
pass the first; each looks again once its own lock is on disk, so whichever looks second
sees the other, and a refusal then releases the lock (and on a start removes the directory
it made). Two exactly simultaneous starts may both refuse, which is the fail-closed side —
and it needs no repository-wide lock, a second kind of lock this file would have to
explain.
**It fails closed**: a runs directory that exists and cannot be read refuses, and so does
an entry `lstat` cannot classify; only an absent directory and a measured link are passed
over. `--force` does not reach it — it overrides the run's own lock, not another run's
claim on the checkout. **`vibe fork` is not checked**: it creates a directory, a lock and
a branch ref and stops, touching no working tree, and the fork runs only through a resume,
which is checked. **A nested `-C` is not caught**: a run given `repo/sub` keeps its archive
in `repo/sub/.vibe/runs`, by the settled rule that `.vibe/runs` lives where the run was
given, and finding it from `repo` would need an unbounded walk of descendant archives and
a second answer to which runs a directory holds.

**The update check is the terminal's alone, and the core's one network request** (#323).
AGENTS.md used to say the core has no network code and that every external call is a child
process. The owner's decision on #323 (2026-10-20) reversed that for exactly one thing: at the
end of `vibe run`, `vibe plan` and `vibe doctor`, a terminal user is told when npm has a newer
vibe, and the version is asked for with an HTTP GET in `src/updatecheck.ts` rather than with
`npm view` as a child. Why the GET: a child process depends on `npm` being on PATH, which a vibe
installed by another package manager, or run under a version manager's node, need not have; and
`npm view` starts a second Node process, measured on the dev machine (2026-10-22) at 0.59-0.95s
over three tries, where the GET took 0.24-0.34s over five.

How narrow the exception is, and every part of it is what makes it acceptable:

- **One unauthenticated GET of public metadata**,
  `https://registry.npmjs.org/@adam-hanna/vibe-code/latest`. No query, no identifier, no
  cookie, no credential, an `Accept` header and nothing else.
- **Node's own `fetch`, no dependency.** `app/src/pilot/keys.test.ts` still pins the core's
  `dependencies` to `{}` and its lockfile to nothing outside `devDependencies`.
- **Bounded**: a 2-second `AbortSignal.timeout`, about six times the slowest GET measured, and
  at most one request a day, cached in `update-check.json` next to the global config
  (`globalConfigPath`'s directory). A failed request is cached too, so a machine with no
  network pays the timeout once a day. A corrupt cache is no cache. With the global layer
  switched off (`VIBE_GLOBAL_CONFIG` empty, as `npm test` sets it) there is nowhere to record
  a check, so none is made.
- **After the command, in the terminal's entry only.** `src/main.ts` calls `runWithNotice`,
  which sets the exit code from `main()` before the check starts, so it can neither delay a
  run's first output nor change how it ended. It is **not** in `main()`, because the host calls
  `main()` too, and a line printed there would land on the protocol's stdout. Nothing imports
  `main.ts`, so `hostmain.ts → serve.ts → cli.ts` cannot reach the check, and no frame can carry
  it; `update-check-guard.test.ts` asserts both, and that no other file in `src/` calls `fetch(`
  or imports `http`, `https`, `http2`, `net`, `tls`, `dgram` or `undici`.
- **Off** under `CI`, when stdout is not a TTY, with `VIBE_NO_UPDATE_CHECK=1`, with
  `updates.check: false`, and when the config cannot be read (fail closed). Each of these
  stops the request, not only the line.

A version is compared by semver 2.0.0 precedence (`compareVersions`, no dependency): a
pre-release sorts below its release and above the release before it, build metadata is
ignored, and anything that does not parse is never newer, so an odd registry answer prints
nothing rather than a wrong line.

The webview is given **no shell permission at all**. The host is spawned from Rust with a
path Rust resolved, and `host_send` writes one line to a process that is already running.
No Tauri command takes a program name, and none ever should: a window that could spawn is a
window whose renderer can spawn.
