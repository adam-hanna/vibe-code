# AGENTS.md

Working notes for anyone — human or agent — making changes in this repo. `README.md` is for
people *using* `vibe`; this file is for people *changing* it.

## What this is

A TypeScript CLI that automates the plan → critique → implement → review loop between the
Claude Code CLI and the Codex CLI. It installs neither; it shells out to both and inherits
whatever you are already logged into. There is no server, no daemon and no network code of
its own — every external call is a child process.

## Commands

```bash
npm install
npm run build       # tsc && tsc-alias — emits to dist/
npm run typecheck   # tsc --noEmit, no emit, fastest correctness check
npm test            # builds first (pretest), then node --test dist/tests/**/*.test.js
npm run doctor      # builds, then runs `vibe doctor` against this repo
npm run watch       # tsc --watch
```

**`npm test` runs the compiled output, not the sources.** `pretest` builds, so a stale `dist/`
is never what you tested — but if you invoke `node --test` directly, build first or you are
testing the last change rather than this one.

There is **no linter and no formatter**, and no CI. `npm run typecheck && npm test` before
every commit is the whole gate, and it is on you to run it. Node 20+ (`engines`).

### The desktop app — `app/`

```bash
cd app
npm install
npm run typecheck      # tsc --noEmit, same strictness as the core
npm run build          # typecheck, then vite build
npm run dev            # vite on :1420 — the webview alone, no host
npm run audit:contrast # the design system's own gate
npm run app:test       # vitest + cargo test — both sides
npm run test:web       # vitest — the cockpit's reducer
npm run test:rust      # cargo test — the shell
npm run stage:sidecar  # copy `dist/src` + a node runtime into the bundle
npm run app:build      # the whole thing: vite, staging, cargo, installer
```

**The app has its own `package.json` and its own gate.** `npm run typecheck && npm test` at
the root still covers the core and does not see `app/`; run the app's commands as well when
you touch it. `app/` is *not* in `files`, so it never ships to npm — the published package
stays the CLI, and the app ships as a Tauri bundle.

**Verify the app from `npm run app:build`, never from a `cargo build` or `tauri dev`.** This
has now cost time twice, for two different reasons, and both are invisible until you build
properly:

- **Resource paths.** Under a dev build, resources resolve to an ordinary relative path; in a
  bundle they come back as `\\?\C:\...`, which Node refuses as a main module (`EISDIR ...
  lstat 'C:'`). `strip_verbatim` in `src-tauri/src/host.rs` fixes it.
- **`cargo build --release` is still a dev build.** `tauri-build` sets `cfg(dev)` unless the
  build went through `tauri build`, so the exe in `target/release/` loads `devUrl` —
  `http://localhost:1420`. With no Vite server running that is a blank error page, and every
  symptom looks like a broken front end: the window opens, nothing invokes, nothing logs.
  A bundled build is on `http://tauri.localhost/`; check the webview URL first when the app
  seems inert.

`npm run app:build` needs Rust on PATH (`~/.cargo/bin`) and runs `stage:sidecar` itself. The
staged tree is ~92 MB of Node plus ~1.5 MB of compiled core, and both are gitignored — they
are copies of things the repo already has.

`npm run audit:contrast` is the design system's equivalent of `npm test`: it parses
`tokens.css` and checks the two rules the build spec names as most likely to slip — the text
floor across every surface, and the ramps — plus that no hex literal exists outside
`tokens.css`. It takes no dependencies and it should stay that way. The hex check **walks
`src/` rather than naming files**; the named list missed `cockpit.css` the day it appeared,
which is the failure mode of any allow-list somebody has to remember to extend.

**The screens the source keeps citing are in `app/src/design/HANDOFF.md`.** Twelve comments
name a frame — `3a`, `4a`, `4h`, `5c`, `6a`, `7a`, `7c`, `7d`, `hi-fi 5`, `hi-fi 11` — and
until it landed, none of those references could be followed from a checkout: `tokens.css`
cites a `Vibe Design Spec.dc.html` this repo has never had. **The annotations are the spec**,
which is why the markdown is worth committing and the artwork is not.

Two things it is not. It is **not the palette** — the wireframe greys and `#5980a6` it lists
are the low-fidelity convention and the document disowns them in its own "Fidelity" section;
`tokens.css` is the design system and the only file here allowed to hold a hex. And it is
**not current**: `7i — Provenance` sorts every frame into *real today* / *app-side* /
*unbuilt*, and every issue that lands moves a name between those. Read that section as a claim
about the day it was written, and check it before building from a frame rather than after.

**The webview re-derives nothing.** Every card the cockpit draws comes from a frame it was
sent: no phase inferred from a sentence, no default filled in for a field a frame did not
carry, no quantity computed out of two others. `app/src/cockpit/model.ts` is the only file in
the app with logic and it is pure — the reducer is where a cockpit bug would otherwise be
invisible, which is why it has the tests and the components do not.

Two rules the cockpit inherits from the design and must not quietly drop:

- **If you cannot name the denominator, it is not a bar.** The one bar in the app is Claude's
  context, because `promptTokens / contextWindow` is a real number over a known one — and it
  is drawn only when the heartbeat carried the window, since it omits the field rather than
  sending a zero. `6a` has failed three times by inventing a denominator to make waiting feel
  measured.
- **A missing measurement is drawn as absent with its reason**, never as a blank and never as
  a zero. The two lines of `6a` that have no source name the issue that would supply them
  (#136, #114), so the row completes when they land instead of being redesigned.
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
  usually clears in under a minute"*: that is a claim about past runs and nothing here has read
  one, so shipping it would be the same invention as `claude 38%` and `step 9/14`, both of
  which the design itself struck. The row says what it cannot say and names #114.
- **While a gate is held there is no live card, and the turn before it is still drawn.** An
  `ask` closes the running turn, exactly as `phase_started`, `turn_started`, `gate_stopped`
  and `result` do — a gate holds *between* things, so nothing is executing while one is
  outstanding. Leaving it open was not cosmetic: a run held overnight drew `5h40m · last
  activity 5h39m ago` on a turn that took a minute, two inches above a footer correctly
  saying the loop was waiting for a human. The card said kill it and the footer said press
  continue. The turn stays on screen with its measurements — that is what a person is
  deciding about — and gives up the accent border, the active ground and the pulsing dot
  (#202). `Gate.turnId` names it, so the column is told rather than picking the last one.
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
- **On Windows a child killed from outside is not observable as killed.** There are no
  signals: Task Manager, `Stop-Process` and any `process.kill` against a process this one did
  not spawn all become `TerminateProcess`, and the child closes with an exit code and no
  signal. `RunResult.signal` is the sharper answer where it exists and never the complete
  one, so the recording site asks `isAbnormal`, not `signal !== null` — and on the platform
  this repo is developed on the *parent's* stamp is the half that carries the finding.

## Repo map

```
src/main.ts          bin entry point — the thing package.json points at
src/cli.ts           argument parsing, the six commands, run summary
src/hostmain.ts      bin entry point for the app's sidecar — the second front end
src/serve.ts         the host session: NDJSON over stdio, gates as awaits
src/protocol.ts      the frames those two processes agree on
src/host.ts          what a host may be told at a boundary, and may answer
src/gates.ts         which boundaries hold a run, what a hold costs, and the two that cannot
src/orchestrator.ts  the loop: planPhase, reviewPhase, the guards, the prompt dispatch
src/run.ts           run state, artifacts, checkpoints, convergence maths (assessConvergence et al)
src/scorecard.ts     what the run archive says about the loop, and what it cannot
src/fork.ts          `vibe fork`: preflight that only reads, then a commit phase that creates
src/similarity.ts    the one similarity metric, its threshold, and the censuses behind it
src/questions.ts     when two wordings are one question: the threshold, and REPHRASED.md
src/raise.ts         what a person does to a run's findings: raise one, move a severity
src/roles.ts         who does what: the role table, refusals, warnings
src/config.ts        DEFAULTS, config merge, validation
src/consistency.ts   cross-field rules over status/phase/planOnly, applied by loadRun
src/types.ts         shared types, including RunState
src/prompts.ts       every prompt the agents receive
src/claude.ts        Claude Code adapter (stream-json)
src/pilotchat.ts     one pilot chat turn on the subscription - a child process, not a client
src/codex.ts         Codex adapter (codex exec --json)
src/appserver.ts     Codex app-server JSON-RPC client (rate limits only)
src/ratelimits.ts    rate-limit windows and the brake
src/charge.ts        the one seam every token and dollar is charged through
src/slots.ts         session-slot lifecycle (main = Claude, judge + review = Codex)
src/context.ts       context measurement, compaction, session rotation
src/preflight.ts     toolchain contract enforcement, `vibe doctor`
src/verify.ts        the verification gates — the list, every run, and broken vs flaky
src/reproducer.ts    a reviewer's test: placed, run by the user's own gate, taken back out
src/progress.ts      in-turn heartbeat
src/work.ts          how far a write turn has got - measured, and labelled a proxy
src/schemas.ts       the JSON schemas both CLIs are pinned to
src/validate.ts      parser vocabulary for model output
src/proc.ts          child-process plumbing, and how a child ended
src/ending.ts        how this process ended - the stamp beside the lock
src/git.ts           branch and commit operations
tests/               node:test, one file per concern

app/                 the desktop app - Vite + React, its own package.json and gate
app/src/design/      tokens.css, base.css, components.css, and the sixteen primitives
app/src/design/HANDOFF.md  the design corpus - every screen a source comment cites, by name
app/src/Gallery.tsx  every component in every state - the design system's acceptance test
app/src/host.ts      the webview's end of the wire: typed frames, and nothing re-derived
app/src/cockpit/model.ts   frames in, a run out - the ONLY logic in the app, and it is pure
app/src/cockpit/format.ts  durations, counts, and the closed maps: boundaries and exit codes
app/src/cockpit/           the loop column, the running row, the output pane, the gate footer
app/src-tauri/       Rust: window, tray, single instance, spawning and relaying
app/src/pilot/       credentials, the wire, and the pane - transcript.ts is the pure part
app/src/pilot/tools.ts     what the pilot may touch: the table, its executors, and propose-only
app/src/pilot/ledger.ts    the pilot's own books - the one place a dollar is a dollar
app/src/cockpit/argv.ts    a form to an argv - the button and the pilot build the same one
app/src-tauri/src/host.rs    supervising the host process, and the \\?\ path fix
app/src-tauri/src/reaper.rs  making a killed app take the host with it
app/src-tauri/src/keys.rs    the OS keychain, and the read the window cannot reach
app/src-tauri/src/pilot/     the only network code in the product - two adapters, one vocabulary
app/src-tauri/src/pilot/sse.rs      the wire format both vendors share, and nothing else
app/src-tauri/src/pilot/event.rs    PilotEvent and Usage - every count an Option, on purpose
app/scripts/         contrast.mjs, stage-sidecar.mjs, make-icon.mjs - all dependency-free
```

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

The webview is given **no shell permission at all**. The host is spawned from Rust with a
path Rust resolved, and `host_send` writes one line to a process that is already running.
There is deliberately no command that takes a program name — the pilot chat can drive the
session, and "run this program" must never be in reach of it.

**Every pilot capability is a host request the app already makes** (#144). The four tools in
`app/src/pilot/tools.ts` produce an `invoke` or an `answer` — the two inbound frames in
`src/protocol.ts` — built by the same `launchArgv` the Launch form uses and handed *up* to
`Cockpit`, which owns the one `host.send` in the window. So `consistency.ts` stays the only
definition of a legal run, and a pilot capability the UI does not also have is a missing
control rather than a pilot feature. `keys.test.ts` fails on a third effect kind.

**Declared on this side, executed on this side.** Rust forwards a tool declaration and parses
a call; it never runs one, for the same reason the relay never decides what a frame means.
Because the table and its executors are one file, a tool cannot exist without an
implementation — a stronger guarantee than a list somebody has to keep in step.

**Propose only.** A tool that would change a run returns a `proposes` settlement instead of
doing it: the pane draws the exact argv or the exact decision and a person fires it. The
enforcement is not in the component — a proposal appends no tool result, so the call stays in
`unanswered()` and the conversation is unsendable until somebody answers. This is decision 1
of the five #144 asks for, and the wireframe's 45-second auto-answer is deliberately not
built: if a proposal should ever fire on its own, that is one more column on #140's gate
matrix. There is **no config tool** (decision 3) and **no archive tool** until #114 lands
(decision 4), and both absences are pinned by a test rather than left as an omission.

**One setting decides where the loop hands control back, and it means the same thing in
both front ends.** `src/gates.ts` holds the matrix; `cfg.gates` is a mode per boundary, and
the difference between the two modes that hold is *what a hold costs*. `step` holds and asks
— free, because the app runs the loop in-process and the hold is an `await` — and a terminal
cannot answer a promise, so from the CLI a `step` row runs through. `stop` asks nobody: the
run ends there, resumably, whoever is listening, which is what makes gates usable from a
terminal for the first time. `vibe doctor` prints the effective table, including which rows a
terminal will honour, because the only other way to learn that is to run and not notice.

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

Three things it is not, each for its own reason. Not a **gate mode**: `cfg.gates` is the run's
standing answer to where control comes back, decided before the run starts, and a mode would
mean a run's configuration changed underneath it. Not a **`Decision` member**: a decision
answers an `ask` that is already open, and the point of a pause is to be asked for when no
gate is holding. And not a **stop**: `gate_waiting` carries `requested` so a window can tell
the two reasons for a hold apart, because a control that blurred *hold at the next boundary,
free* with *kill the turn in flight* would let somebody end a run believing they had paused it.

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

**The pilot's keys live in the OS keychain, and the webview can never read one.** Three
commands exist — store, forget, ask whether one is present — and the absence of a fourth is
the design: `keys::read` is `pub(crate)`, called by Rust, unreachable from the window, so the
key never crosses the IPC boundary. The CSP agrees from the other side, since `connect-src
'self' ipc: http://ipc.localhost` means the page could not reach a vendor even holding one.
Not `vibe.config.json`: that is a project file meant to be committed, and `validateConfig`
reports bad values *by name*, which is the one thing that must never happen to a secret.

**A pilot turn can also be a child process, and that is not a hole in the rule
below — it is the rule** (#193). `src/pilotchat.ts` spawns the same `claude` the
loop spawns, so the pilot can run on the subscription the user already pays for
instead of a second bill. It ships as groundwork with nothing calling it. Three
things about it are load-bearing:

- **It is deliberately not `claudeTurn`.** That function narrates through
  `log.ts`, and in the host that sink *is* the run's narration stream — a pilot
  turn would put its own prose in the output pane and, through `recordAndSay`, in
  `state.json`. A conversation about a run is not part of the run's record. It
  also carries `sessionArgs`, the fork/resume dispatch and a heartbeat that
  reports into the run's progress, none of which a chat wants. What the two
  *share* is where two answers would be one too many: `claudeBin`,
  `extractTokens`, `detectRateLimit`.
- **`PilotChatResult` has no money field and there is nowhere to invent one.** A
  subscription turn bills nothing at all, so a dollar figure has no quantity to be
  an estimate *of* — the same sentence that makes Codex cost unreportable, and the
  same one #145 uses to explain why the API-backed pilot's price table is not a
  counter-example. The tokens are real and are reported.
- **The real cost is contention, and it is named rather than solved.** These
  tokens come out of the same subscription window the run draws on, so a long
  conversation beside a long run can push that run into a `ratelimits.ts` wait.
  Today the pilot cannot do that because it spends different money. Whoever wires
  this up owes that an answer; the module's part is to raise a `RateLimitError` as
  itself so there is something to act on.

**It may read the repository and nothing else, and the four layers are named in
the argv.** #193 decided the read: a pilot that can open `PLAN.md` and the diff is
what somebody asking *"what is this doing"* wants, and it is what makes this
better than a generic assistant. The two providers are therefore asymmetric — the
API-backed pilot has no filesystem at all — and that is accepted and written down
rather than discovered.

Deciding it is what made the **closed** form possible, which is the part worth
copying. The first cut denied seven built-ins by name and said so as a weakness:
a deny-list is open at the top, and a tool a future release adds would not be on
it. Knowing exactly what to permit means naming that instead:

- **`--tools Read Glob Grep`** — the built-in allow-list. Anything unnamed is
  unavailable, including tools that do not exist yet.
- **`--restricted`** — drops the built-ins that run commands or code, and
  **confines the file tools to the working directory**, so "read the repository"
  means *that* repository. It also ignores user, project and local settings, so
  what a turn can do is decided in this argv rather than by the machine.
- **`--strict-mcp-config`** with no `--mcp-config` — **no MCP servers at all**.
  #138 is open because every role reaches whatever the user configured globally
  and a read-only seat can hold a write tool that way; the pilot is the last
  surface that should inherit it.
- **`--permission-mode plan`** — the permission layer under all of it.

**`Bash` is absent, so this list is narrower than `READ_ONLY_TOOLS` in
`roles.ts`.** That set is read-only in the sense a *run's* seats are — a shell
under a sandbox, in work a person launched. This is a chat surface the model
drives turn by turn, and the standing rule was written about exactly it: *"'run
this program' must never be in reach of it"* (#144). A shell is not what "read the
repo" means.

**All the network code lives in `app/` and none of it in `src/`.** The core keeps *"every
external call is a child process"* exactly, and the published package gains no HTTP
dependency and no credential handling. If this ever moves into `src/` "because the CLI might
want it too", that sentence stops being true of everything shipped — and it is a sentence
people choose this tool for. `keys.test.ts` checks both halves: `dependencies` is `{}` *and*
the lockfile installs nothing outside `devDependencies`, because a manifest cannot prove what
a transitive dependency would drag in.

**Two named adapters, and deliberately not an abstraction over them.** `pilot/anthropic.rs`
and `pilot/openai.rs` each turn one vendor's stream into `PilotEvent`, and each says what its
own vendor actually does — a system prompt is a top-level field for one and a message for the
other; usage arrives in two events for one and one for the other; **OpenAI has no cache-write
count to report at all**, so `Usage.cache_write` is `None` on every OpenAI turn. Every one of
those differences survives into the vocabulary as an absent field rather than a smoothed one,
for the same reason Codex cost is unreported: an abstraction that hides a difference has to
invent the thing it hid. `sse.rs` *is* shared, and that is not a contradiction — it parses a
wire format both vendors implement to the same specification, and sharing a format is not
sharing a meaning.

**Rust parses a tool call and never runs one.** A `tool_call` event carries the vendor's id,
the name and its arguments **unparsed**; the window executes it, through the same code path
its own buttons use. That is what makes *"every pilot capability is a host request the app
already makes"* structural rather than a promise — a tool cannot exist without an
implementation on the window's side, and a tool run from Rust would be this crate deciding
something about a run (#144).

The two vendors disagree about tool calls in four ways, and all four are in the adapters
rather than smoothed away: the schema field is `input_schema` for one and a nested
`parameters` inside a `function` envelope for the other; a result rides on a **user** message
for one and a `tool` message for the other; **Anthropic requires every result for a turn in a
single message and OpenAI requires one message each** (both are a 400 if broken); and a call
closes with its own event for one while the other says nothing until the whole turn ends.

**The pilot spends money and the run does not, so they are two sets of books and
never one** (#145). `app/src/pilot/ledger.ts` is the second accounting path, parallel to
`src/charge.ts` and never through it. Two rules, both structural rather than promised, and
`ledger.test.ts` fails on either:

- The ledger imports exactly `./keys` and `./pilot` — nothing from the core, so there is no
  path to `applyCharge` even by accident. A pilot conversation counting toward
  `budget.maxTokens` would stop the thing being built because of a discussion about what to
  build, reported as `EXIT.BUDGET`, which already means something else.
- `src/types.ts`, `src/charge.ts` and `src/orchestrator.ts` contain no `pilot`. A run's
  `state.json` is byte-identical whether the pane was open or closed.

**This is the one place in the product where a dollar is a dollar, and it is not a
contradiction with the settled decision.** *"Codex cost is not reported and will not be
estimated"* stands, because a Codex turn runs on a subscription where **nothing is billed at
all** — so a dollar figure is fictional in kind, with no quantity to be an estimate *of*, and
`budget.maxCostUsd` says exactly that about itself. A pilot turn runs on an API key: money
moves, the vendor publishes the usage on every response, and the price is published too. The
rule was never *don't report cost*, it was **never invent a number**.

What that buys, and what it costs: every `Price` entry carries the URL it was read from and
the date it was read, the UI shows that date beside the figure, and a model with no entry
reports **no figure at all**. Longest matching prefix wins, so `gpt-5-mini` can never be
answered by `gpt-5`'s price — without that the table's *order* would decide what a turn cost.
A turn still streaming is not priced from the half that arrived. The word used is
*estimated*, never *billed*.

The ceiling is `dailyTokens`/`dailyUsd`, deliberately not spelled `maxTokens`/`maxCostUsd`,
and it is **off by default** — a hard default cap on a conversation stops you mid-sentence for
no good reason. Per day rather than per session, because a conversation has no natural end and
a day is the window both vendors' dashboards use. It gates the tool loop as well as the
composer: a chain answering itself is the unattended half, which is the half a spend limit is
for. It lives in `localStorage` and not in `vibe.config.json`, which is a project file meant
to be committed, and not in the keychain, which holds one kind of secret.

**A vendor's error message can contain the key you sent it.** OpenAI's 401 reads `Incorrect
API key provided: sk-proj-…`, quoting it back in full — found by the live reachability test,
which asserts no failure carries the key it was given. Redaction is at the single seam every
pilot event leaves through, not in an adapter, because Anthropic not echoing today is not a
promise either vendor is making.

**The host dies when the app does, and the kernel is what enforces it.** `stop()` handles the
graceful endings by closing stdin; a Windows Job Object with
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` handles the ones that run no user code at all — `End
task`, `Stop-Process -Force`, a panic. There is nothing to hook for those by design, so the
mechanism has to be declared in advance and left to the OS. macOS and Linux have no
equivalent yet and **say so** through `Status.uncontained`, which the window shows: an
unenforced guarantee nobody can see is the same as no guarantee.

**A closed stdin means the supervisor has gone, and that is stronger than a `shutdown`**
(#206). Both used to call the same thing, and the equivalence was wrong in a way that made
the graceful path unreachable: `running` in `serve.ts` covers the whole of `main()`, so
"finish the turn you are in" was really "finish the run", tens of minutes against a
`QUIT_GRACE` of five seconds. Every quit during a run expired it and was a kill. Worse, a run
*holding at a gate* would have waited for ever — `host.decide` resolves only on an `answer`
frame, and the stream that carries one has closed.

So `closing()` abandons the request and names it, `finished()` resolves at once, and the
process leaves under its own control with `HOST_EXIT_ABANDONED`. **Leaving under its own
control is the whole point**: that is what runs the exit hook `installEndingStamp` registered,
so the archive says vibe chose to stop rather than showing a lock with no stamp beside it,
which is #131's "something terminated it without running a line of its code". The five
seconds remain as a ceiling for a host that will not go, and reaching them is now an
`applog` line, because after this it should not happen. Nothing is lost that the CLI does not
already lose: the run is resumable from its last checkpoint.

`HOST_EXIT_ABANDONED` is **outside `EXIT`'s 0–7 on purpose**, and a test pins it there. Those
eight are a *run's* endings, arriving on a `result` frame and mapped to a sentence by the
footer; this is the *process* saying how it left, on `host://exit`, answering a different
question.

Two rules the host process depends on, and neither is optional:

- **stdout is the protocol; stderr is the prose.** `installProtocolStdout` moves `console.log`
  to stderr before anything can narrate. One `log.step()` sharing stdout with the protocol
  puts an unparseable frame in the stream — the packaging spike reproduced it.
- **Refuse, never repair.** An unreadable frame is reported back to the id that sent it, and
  an unreadable *decision* becomes `stop`. Continuing on an instruction nobody could parse
  spends tokens on the strength of a message that may have said the opposite.

**Where to look when the app is the thing that is wrong.** There are two logs and they cover
different halves. `<repo>/.vibe/runs/<run-id>/transcript.log` covers a *run*, and it exists
under the app for free because `serve.ts` hands its argv to the same `main()` the CLI uses.
`%LOCALAPPDATA%\dev.vibecode.desktop\logs\vibe-desktop.log` covers everything either side of
one — the host spawn and the two paths it resolved, containment, an unparseable line on the
protocol stream, the exit code — because `attachTranscript` happens once a run exists and a
release build is `windows_subsystem = "windows"`, so before #186 those sentences went to a
console that is not there. Four things about `applog` are load-bearing:

- **Prose, never protocol**, the same split the host depends on one layer down. A frame is
  never written; a line of stdout that *failed* to parse is, because failing is what makes
  it prose.
- **Nothing from the pilot.** A vendor's error can quote the API key it was sent — OpenAI's
  401 does, in full — and `redact` covers the path to the window. A durable file is a second
  destination, and an absence is a stronger guarantee than a second redaction.
- **Appended, never rotated**, and that is #130's answer rather than an oversight: a cap
  needs a size or an age, and there is no measurement here to choose one from.
- **A force-killed app writes no exit line**, by construction — that path runs no user code
  at all, which is the same reason `reaper.rs` exists. An exit line means the host died while
  the app was alive, which is the case worth reading.

**A severity is a claim with an owner, and until #141 nothing recorded the owner.** Every
`Finding` came from `parseFindings` reading a model's structured output, so "absent means an
agent said it" was true by construction and therefore never written down. `Finding.raisedBy`
is that field, stamped by `groundAndRecord` — the single point both writers pass through, and
the only place that knows which role produced the report. `refusePlaceholderPlan` stamps
`vibe`, because a mechanical fact about an artifact on disk was previously indistinguishable
from the critic's own P1 about the same defect. **Absent still means absent**: every finding
in every existing archive has none, so `authorOf` narrows and returns null rather than
guessing, and a renderer that cannot name the author names nobody.

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

`src/orchestrator.ts` is the biggest file by a wide margin and is where most changes land.
Read the phase you are touching end to end before editing it; the guards interact.

## Code style

These are enforced by `tsconfig.json` (`strict`, plus `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`, `noUnusedLocals`,
`verbatimModuleSyntax`) and are not negotiable:

- **No `any` in `src/`.** Use `unknown` and narrow. `src/validate.ts` has the vocabulary.
- **Internal imports go through `@src/*`**, rewritten to relative paths at build time by
  `tsc-alias`. No `../../` chains anywhere.
- **`import type` for type-only imports** — `verbatimModuleSyntax` requires it.
- **Explicit `.js` extensions** on relative/aliased imports (NodeNext ESM).

Beyond the compiler:

- **Never invent a number.** This is the repo's one recurring rule. An unknown context window
  stays `null` rather than being guessed from a model name; Codex cost is reported as absent
  rather than derived from a price table; a missing progress field is omitted rather than
  filled in. Partial information beats a convincing fabrication, and most of the design notes
  in `README.md` exist to explain a place this rule was applied.
- **A proxy is allowed; a proxy wearing another measurement's clothes is not.** `src/work.ts`
  is the worked example. The wireframes draw `step 9/14` over an implement turn and no such
  number exists, so what ships is *"9 of the 14 files the plan names"* — every part of it
  measured, and worded as a count of files so it cannot be read as a position in the plan's
  list of steps. The words are the labelling, and `implement-progress.test.ts` asserts the
  line contains no `step` and no `%`. If you add a proxy, the sentence has to say what it
  actually counted.
- **Comments explain *why*, and cite the run that taught it.** The defaults in
  `src/config.ts` are the model: each non-obvious number says what was measured to pick it.
  Do not strip these; they are the institutional memory.
- **Fail closed.** A measurement that cannot be attributed is not recorded. A guard that
  cannot read its input treats it as absent, not as zero.

## Tests

`node:test` with `node:assert/strict`. One file per concern, named for the concern rather
than the module (`convergence.test.ts`, `failure-accounting.test.ts`,
`preflight-enforcement.test.ts`).

- **Prefer adding tests. Editing an existing one is allowed, but never to make it pass.**
  When a test breaks, the failure is evidence and the first job is to find out what of. There
  are only two answers and they need opposite responses:

  1. **The change broke something.** The test is right and the code is wrong. Fix the code.
  2. **The test's claim is no longer the contract.** The behaviour genuinely moved, or - as in
     #54 - the test asserted more than the thing it was guarding and part of what it pinned was
     the defect. Then rewrite it, keeping every part of the claim that still holds.

  Deciding which of the two it is *is* the work. A test edited into green without that
  investigation destroys the one signal that would have caught the regression, and it does it
  silently. So: say in the PR which existing tests you changed, which of the two cases each was,
  and what evidence settled it. If coverage moves to another file, say where. Never delete a
  case because it is inconvenient; if it is genuinely wrong, the reason it was ever written is
  worth understanding before it goes.
- **No wall-clock fixtures.** A test that hardcodes an epoch timestamp passes until it
  doesn't — one in `ratelimits-monitor.test.ts` went off in August 2026 and made `develop`
  look broken. Compute times relative to now.
- **No network, no real agent invocations.** `tests/helpers/fake-transport.ts` and
  `tests/helpers/stub-server.ts` are the injection points.
- **A wait on a child process must be able to say which way it failed.** The suite spawns
  around a hundred children per run, and "the child printed nothing" covered two opposite
  states: one that had not begun running, and one that stalled after it did (#181). They
  need opposite responses — the first can simply be spawned again, the second is the hang
  `startKillHelper`'s timeout exists to diagnose and must never be retried past — so the
  child prints a first line before it reads argv, and `retryable()` is the one place that
  rule lives. **Raising the timeout is not the fix**: it is already 25× the worst loaded
  start-up measured, and every second added is a second a real hang looks like a slow
  machine, times the 24 children one case spawns.
- **A fixture that shells out says what the command said.** `initGit` ran four `git`
  invocations under `stdio: 'ignore'`, so the day two of them failed the suite went red
  with `Command failed: git config user.email …`, `stderr: null`, and no way to choose
  between an index lock, a held handle and a scanner (#182). Capturing stderr is the
  prerequisite for deciding anything else on evidence. **A retry is allowed only where
  running the command twice leaves the same repository** — `gitRetryable` is that rule, and
  `commit` is deliberately outside it — and a retry that fires **says so on stderr**, because
  a suite that went green because of one has to admit it. Note the direction this points:
  `commitAll` already tolerates a git failure, so the harness was stricter than the product.

The phase loop **is** drivable from a test: `tests/helpers/loop-harness.ts` runs `orchestrate`
end to end with injected agents that record every turn's label in order, a run state in a
temp directory, a real `git` repo it can commit to, and a `verify.command` the case controls
— so the verification gate, the carried-P1 final round, the per-round commits and the
question/escalation/resume path are all reachable. `full-loop.test.ts`,
`verification-gate.test.ts`, `final-fix-round.test.ts`, `question-escalation.test.ts` and
`pending-findings.test.ts` are the callers; start from whichever is closest to the phase you
are changing. Git and verification are deliberately real, not seams — see the harness header
for why. Anything it still cannot reach (a rate-limit wait, a session rotation) gets a
throwaway script against `dist/`, with the results in the PR body.

## Branches, commits and pull requests

**`main` is the default branch and only ever receives release merges. `develop` is where
work integrates.** Branch off `develop`, PR back into `develop`.

```
feat/<issue>-<slug>     new capability          feat/22-deferred-only-rounds
fix/<issue>-<slug>      defect                  fix/23-validate-stored-state
docs/<slug>             documentation only      docs/agents-and-readme
release/<version>       release into main       release/1.2.0
vibe/<run-id>           created by vibe itself  vibe/20260820-002345-implement-…
```

**Never stack a PR on another feature branch.** It was tried once: PR #35 was based on
`feat/role-table`, its parent merged into `develop` three hours before it did, and the fix
landed on a branch nobody was running from — `develop` stayed broken and the work had to be
cherry-picked onto #36. If the work genuinely depends on unmerged work, wait, or target
`develop` and rebase.

### Closing issues automatically

**GitHub only auto-closes on a merge into the *default* branch, which here is `main`.** A PR
into `develop` with `Closes #12` in its body closes nothing, ever. So:

- **Per-issue PRs (into `develop`) use `Refs #12`.** It cross-links without making a promise
  the merge cannot keep.
- **The release PR (into `main`) does the closing**, and lists every issue the release
  contains.

**Repeat the keyword before every number.** GitHub parses `Closes #1, #2, #3` as closing
`#1` and nothing else — the release of 1.1.0 named sixteen issues and closed zero, and all
nine outstanding ones had to be closed by hand afterwards.

```markdown
Closes #2, closes #16, closes #18, closes #20, closes #27
```

Commit messages: imperative mood, describing the behaviour change rather than the edit —
"Charge what failed turns spend, and enforce before retrying", not "update charge.ts".
Commits written by `vibe` itself are titled `vibe: implement approved plan`.

## Working in `.worktrees/`

This repo is developed on itself. Each issue gets a git worktree under `.worktrees/`, and
`vibe` is run inside it — so the tool changing the code is a *published* build, not the
working tree it is editing.

```bash
git worktree add .worktrees/issue-22 -b feat/22-deferred-only-rounds develop
cd .worktrees/issue-22 && npm install && npm run build
vibe run "$(cat ../../brief.md)" -C .
```

`.worktrees/` is in `.gitignore` — worktrees live inside the repo and must never be tracked
by it. So is `.vibe/`, which is where each run's artifacts land inside the worktree:
`PLAN.md`, every plan revision and critique, `FOLLOW-UPS.md`, `state.json`, `transcript.log`.
**Those artifacts are the record of why a change is shaped the way it is** — read
`FOLLOW-UPS.md` from a related run before proposing work, because it usually already says
whether the idea was considered and declined, and why.

A few things learned the expensive way:

- **Write the brief to a file and pass it in full.** The runs that converged had briefs that
  stated the decisions already made and said "do not re-derive them". The runs that stalled
  had briefs that left the design open.
- **A stall is not a failure.** Exit code 2 writes `NEEDS-INPUT.md`; answer inline under
  **Your answer:** (a `### ` heading and `> ` blockquote lines — the parser needs both) and
  `vibe resume <run-id>`, usually with a raised `--max-tokens`.
- **The run commits to `vibe/<run-id>`, not to your branch.** Point the branch at the run's
  final commit before opening the PR: `git branch -f feat/22-… <sha>`.
- **Archive the run record before pruning the worktree.** `git worktree remove` takes `.vibe/`
  with it, and since #52 the planner reads `.vibe/runs/` in the repo it is run against — so a
  pruned worktree destroys the record the next run would have read. `vibe` only ever creates
  `.vibe/` under the directory it ran in (`createRun`), which is the worktree, so the main
  checkout's copy has to be made:

  ```bash
  # from the main checkout
  mkdir -p .vibe/runs
  [ -f .vibe/.gitignore ] || printf '*\n' > .vibe/.gitignore   # never overwrite an existing one
  cp -r .worktrees/issue-52/.vibe/runs/<run-id> .vibe/runs/
  git worktree remove .worktrees/issue-52
  ```

  Seed a new worktree from the archive when the past matters:

  ```bash
  mkdir -p .worktrees/issue-N/.vibe/runs
  [ -f .worktrees/issue-N/.vibe/.gitignore ] || printf '*\n' > .worktrees/issue-N/.vibe/.gitignore
  cp -r .vibe/runs/. .worktrees/issue-N/.vibe/runs/
  ```

  The `.vibe/.gitignore` containing `*` is what `ensureVibeIgnored` writes, and it is why the
  archive is self-ignoring wherever it sits — this repo's `.gitignore` also lists `.vibe/`, but
  a copy made by hand cannot rely on that in someone else's checkout. The archive survives
  because the main checkout is long-lived, not because it is tracked. The seven runs up to #50
  were preserved this way by hand. There is no command for this and there is not meant to be:
  for an ordinary user `.vibe/runs/` already persists in their repo across runs.
- **What the past-run index reaches.** The planner is the only role *given* the index, but
  Claude has one conversation — the implementer resumes `main` and inherits the planner's
  history, that section included, exactly as it already inherits the plan prompt. The
  Codex-seated roles (critic, answerer, reviewer) never see it.
- **Prune when done**, after archiving the run above:
  `git worktree remove .worktrees/issue-22`.

## Releases

1. Branch `release/<version>` off `develop`.
2. Bump `version` in `package.json`. Semver as stated in `CHANGELOG.md`: minor for new
   capability, patch for fixes, major only for a change that breaks an existing config or an
   existing run.
3. Add the `CHANGELOG.md` section — grouped Added / Fixed / Internal / Upgrading, every entry
   linking its PR and issue.
4. PR into `main`, with the `closes` keyword repeated per issue (see above).
5. Verify from a clean checkout: `npm run typecheck`, `npm test`, `npm pack --dry-run`.
6. Merge, then tag: `git tag -a v<version> -m "..." && git push origin v<version>`.
7. `npm publish`. **This needs a real interactive terminal** — the OTP flow hands off to a
   browser and cannot be driven from a headless shell. A granular automation token in
   `.npmrc` avoids the prompt.
8. **Merge `main` back into `develop`.** The release PR is squash-merged, so the version bump
   and the changelog exist only on `main` until you do. After 1.1.0 this was missed and
   `develop` sat at version 1.0.1 with no `CHANGELOG.md` — which is the branch the next
   release would have been cut from.

Anything added to the published package must be listed in `files` in `package.json`;
`CHANGELOG.md` was nearly shipped missing for exactly this reason.

## Settled decisions — do not re-litigate

Each of these was argued once, at length, and the reasoning is recorded. Reopening them
needs new evidence, not a fresh opinion.

- **Codex cost is not reported and will not be estimated.** No output mode returns one, and
  no app-server endpoint returns money. `budget.maxTokens` is the ceiling that covers both
  agents. See "Notes and limitations" in `README.md`. **The pilot's price table is not a
  counter-example** (#145): a subscription bills nothing at all, so a dollar figure for a
  Codex turn has no quantity to be an estimate *of*, while a pilot turn on an API key does.
  The rule stands and is the reason the pilot's figure says *estimated* and carries the date
  its price was read.
- **The Codex context window is a setting, not a derivation.** `modelContextWindow` exists
  only on an app-server push notification, and `vibe` drives Codex as a plain child process.
- **A persisted Codex thread cannot hold a writing role.** `codex exec resume` takes no `-s`
  flag, so the sandbox silently reverts after the first turn. The config is refused, not
  repaired.
- **`/compact` does not work headless.** It is a CLI command, not a model instruction.
  Compaction is explicit session rotation with a handoff briefing.
- **Prompts go over stdin, never argv.** Claude's variadic flags swallow positional
  arguments.
- **Groundwork ships separately, with no behaviour change.** The role table took four
  preparatory PRs (#15, #17, #28, #31), each landing with the table still hardcoded so that
  nothing about a default run changed until the last step. It is the pattern that works here;
  use it for anything touching the loop.
