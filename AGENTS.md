# AGENTS.md

Working notes for anyone — human or agent — making changes in this repo. `README.md` is for
people *using* `vibe`; this file is for people *changing* it.

## What this is

A TypeScript CLI that automates the plan → critique → implement → review loop between the
Claude Code CLI and the Codex CLI. It installs neither; it shells out to both and inherits
whatever you are already logged into. There is no server, no daemon and no network code in
the core — every external call `src/` makes is a child process. The desktop app has two
network clients of its own, both in Rust under `app/`: the pilot's vendor adapters and the
updater (#299).

## Commands

```bash
npm install
npm run build       # tsc && tsc-alias — emits to dist/
npm run typecheck   # tsc --noEmit, no emit, fastest correctness check
npm test            # builds first (pretest), then scripts/test.mjs runs node --test dist/tests/**/*.test.js
npm run doctor      # builds, then runs `vibe doctor` against this repo
npm run watch       # tsc --watch
```

**`npm test` runs with the global settings layer switched off.** `scripts/test.mjs` sets
`VIBE_GLOBAL_CONFIG` empty before it starts `node --test`, because `loadConfig` reads
`~/.config/vibe/config.json` under every project and a suite that read the developer's own file
would pass or fail by machine. A case about the global layer points the variable at a file of
its own and puts it back (`global-config.test.ts`). Running `node --test` directly skips this.

**`npm test` also owns where the suite's temporary files go, and removes them** (#234). The
suite makes about 1,600 temporary directories a run, 411 of them git repositories, and for a
long time removed none: on the Linux dev machine's tmpfs that used up a million inodes in about
thirty runs, and the next run failed 673 tests with `ENOSPC`, which looks like a broken suite
rather than a full disk. The fix is where a directory comes from, not 225 `mkdtempSync` sites
each remembering `rmSync`: `scripts/test.mjs` points `TMPDIR`, `TMP` and `TEMP` at one
`vibe-test-run-*` root, so `os.tmpdir()` answers that root in every test file and every child,
and the root is removed when the run ends. Three rules travel with it, pinned by
`test-sandbox.test.ts`:

- **`GIT_TEMPLATE_DIR` is an empty directory**, so a fixture repository holds 9 entries
  rather than 27. The sample hooks were two-thirds of what a test repository cost, and no test
  runs one. A run fell from about 30,000 inodes and 174 MB to about 22,800 and 148 MB; most of
  what is left is the deliberately large states in `fork-kill` and the chat-store cases.
- **Ctrl-C, SIGTERM and a closed terminal still remove the root**; the script waits for the runner and then cleans up. **A SIGKILL or a crash is swept by the next run**: each root holds the pid that made it,
  and a root whose pid has gone is removed at the start of the next run.
- **Anything that appears in the real temp directory fails the run, by name.** That is a test
  writing to a hard-coded `/tmp` or spawning a child with a hand-built environment, and it would
  otherwise bring the leak back silently. Put a new fixture under `os.tmpdir()` and it is
  covered without any cleanup of its own; `VIBE_KEEP_TEST_TMP=1` keeps the root and prints it.

**`npm test` runs the compiled output, not the sources.** `pretest` builds, so a stale `dist/`
is never what you tested — but if you invoke `node --test` directly, build first or you are
testing the last change rather than this one.

**`npm test` fails until the agent CLIs' fixtures are recorded** (#298).
`cli-fixtures-contract.test.ts` feeds a real turn of each CLI, recorded under
`tests/fixtures/cli/<cli>-<version>/`, through the real parsers, and a missing fixture for a
version in `TESTED_CLI_VERSIONS` fails by name. Recording spawns real agents, so it is done by
hand and never by the suite:

```bash
node scripts/record-cli-fixtures.mjs           # writes tests/fixtures/cli/claude-<v>/ and codex-<v>/
node scripts/record-cli-fixtures.mjs --force   # re-record a version that already has one
```

`VIBE_CLI_FIXTURES=pending` skips those tests, and says so; it exists for the run that
introduced them, which could not record fixtures from inside a sandboxed turn. There is no
other way past the check.

There is **no linter and no formatter**. There are three workflows. `pages.yml` deploys the
docs site from `main`. `ci.yml` runs on every push and pull request into `develop` and `main`:
the core gate (`npm run typecheck && npm test`), the app gate (typecheck, vitest,
`audit:contrast`) and the Rust tests, all on Ubuntu 22.04 with Node 22. `release.yml` builds the
desktop bundles on a `v*` tag into a draft GitHub release (#239). What CI does **not** run: a
linter or formatter, the tests on macOS or Windows, and `npm publish`. **`npm run typecheck &&
npm test` before every commit is still the rule**, and it is still on you to run it: CI only
reports after you push. A test that fails only on CI is a finding about the test or the code,
never something to retry past or skip. Node 20+ (`engines`).

**A release carries two names for each installer and the files an installed app updates
from** (#239). The README and `docs/app.md` link to
`releases/latest/download/<stable name>` — `Vibe-macos-arm64.dmg` and the rest — so no link
moves per release; the names are written once, in `release.yml`'s matrix, and
`download-names.test.ts` fails when a page and the workflow disagree. With the
`TAURI_SIGNING_PRIVATE_KEY` secrets set, the build also produces the signed update bundles and
`latest.json`, which #299's updater reads. `tauri.conf.json` leaves `createUpdaterArtifacts`
off and the workflow switches it on, so a local `npm run app:build` never needs the key. **That
key cannot be replaced**: a release signed with a new one is refused by every installed copy,
whose only way forward is a manual reinstall.

### The docs site — `docs/`

```bash
cd docs
npm install
npm run docs:build     # vitepress build - fails on a dead link, and that check stays on
npm run docs:dev       # vitepress dev - the site with live reload
npm run docs:preview   # serve the built site, under its real base path
```

**`docs/` has its own `package.json` and lockfile**, the arrangement `app/` has: the root
package gains no dependency, `docs/` is not in `files`, and the root gate neither builds it nor
sees it. It is a VitePress site published at `https://adam-hanna.github.io/vibe-code/` by the
Pages workflow, which builds from `main` so the site describes the latest release. `BASE` in
`docs/.vitepress/config.mts` is the only place the path is written; a custom domain is a
`docs/public/CNAME` and that one line. `docs/images/` is shared with `README.md`, and
`docs/plans/` is internal and excluded from the site (`srcExclude`).

**The reference pages are hand-written, and guarded only for what is missing.**
`tests/docs-drift.test.ts`, run by `npm test`, fails when a `DEFAULTS` key path, a section,
a `verify.gates[]` field, an `EXIT` code or a command `src/cli.ts` dispatches is absent from
`docs/configuration.md`, `docs/exit-codes.md` or `docs/cli.md` (and when the last two name one
the source lacks). It checks no description, no default value and no flag, so a green run
means nothing is missing, never that the page is right. A change to any of those in `src/`
updates the page in the same PR, written against the code rather than an older page.

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
- **A blank white window on Linux is the renderer, not the page.** WebKitGTK's DMABUF
  renderer paints nothing under some GPUs - measured on 2026-10-06 on the VMware VM this repo
  is developed on (Fedora 44, X11, webkit2gtk 2.54): three plain launches blank, the previous
  build blank the same way, the same binary painting normally with
  `WEBKIT_DISABLE_DMABUF_RENDERER=1`, and the page itself rendering in Firefox. Nothing is
  logged, by either side. `main.rs` sets that variable on Linux before `run()`, and only when
  it is unset, so somebody who needs the renderer on can still say so. It cost half a day as
  a suspected front-end bug, which is why it is here beside the other two.

`npm run app:build` needs Rust on PATH (`~/.cargo/bin`) and runs `stage:sidecar` itself. The
staged tree is ~92 MB of Node plus ~1.5 MB of compiled core, and both are gitignored — they
are copies of things the repo already has.

`npm run audit:contrast` is the design system's equivalent of `npm test`: it parses
`tokens.css` and checks the two rules the build spec names as most likely to slip — the text
floor across every surface, and the ramps — plus that no hex literal exists outside
`tokens.css`. It takes no dependencies and it should stay that way. The hex check **walks
`src/` rather than naming files**; the named list missed `cockpit.css` the day it appeared,
which is the failure mode of any allow-list somebody has to remember to extend.

**Its last two sections are a different kind of check and are there for a reason vitest
cannot cover.** §9 and §10 are both about a rule broken by the **absence** of a declaration —
a `button` with no background taking the platform's near-white, and a dialog with no
`max-height` growing past the bottom of the screen — which is invisible to a reader of the
stylesheet and unreachable from a token pairing. They live here rather than in a vitest case
because **vitest stubs a CSS import to the empty string, `?raw` included**, so a test cannot
read a stylesheet at all; this script reads the file. Anything asserting the *content* of CSS
belongs here. Each check reads the file its rule lives in, and moves when the rule does:
§9's reset is Tailwind's preflight since #237, so it checks that `theme.css` imports
`tailwindcss/preflight.css` into the base layer and that the installed preflight still has a
`button` rule clearing the background; §10 reads the `Modal`'s utilities off `Surfaces.tsx`;
§8 reads `--size-*` off `tokens.css`.

**The app draws with Tailwind over the tokens, and there is no other stylesheet** (#231,
#237). `tokens.css` holds every value and is still the only file allowed a hex;
`design/theme.css` maps the tokens into Tailwind's theme *by reference*, imports preflight,
and holds the handful of rules that are global by nature — the page's ground and type, body
`select-none`, focus, the scrollbar, and the one `v-pulse` keyframe. Everything a component
draws is a utility in that component. What it reverses is the original design system's one
rule about itself — *"Class names are `v-` prefixed and flat. No nesting, no CSS-in-JS, no
runtime"*, sixteen primitives in `components.css` — and the reason is the one
`design/AUDIT.md` already gave: composition does not survive being transcribed into a
stylesheet, and 6,589 lines of hand-written CSS had drifted into nine copies of the artifact
pane's layout. Three things the
move had to keep, and did:

- **Preflight came in with the sweep, in `base`, so a utility always wins.** The old resets were
  unlayered, and an unlayered rule beats every layered one whatever its specificity — which
  is how `button { background: none; border: none }` silently erased every new button's
  ground (#231). The few platform defaults the screens were drawn against are put back by
  name in `theme.css` with `revert` (native selects, radios and checkboxes, inline icons,
  placeholder grey, eight-column tabs), and a heading or paragraph that leaned on the user
  agent's weight or margin says so in its own utilities.
- **The off-scale tokens are referenced, not rounded.** `--space-2` is 6px, and the root
  font size is `--type-body`, so `rem` here is 13px — a `px-1.5` or a `pl-10` is not the
  number it looks like. The moved primitives write `px-(--space-2)` and
  `[font:var(--type-mono-sm)]`.
- **`Modal` stayed this repo's own component rather than becoming a radix `Dialog`**, though
  the rework's plan named one. Its safety properties are the point of it — Escape on the
  *window*, no dismiss on a scrim click because every dialog guards something expensive, focus
  to the scrim once on mount, a viewport bound and a body that is the flex item that scrolls —
  and a library dialog closes on an outside click. The command palette *is* a radix dialog
  (`ui/command.tsx`), because it guards nothing.

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
  outstanding. Leaving it open was not cosmetic: a run held overnight drew `5h40m · last
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
  citations, severity history, reproducer outcomes — and what stays out is the severity, the
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

  `exit` travels beside the steps rather than among them, because a `result` is
  not narration — it is the frame that answers a request — and a status this
  build does not recognise reports **null** rather than a guessed zero.
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
  `max_tokens` and `p1_tolerance`, built by the same `launchArgv`, and `1b`'s one
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


**A run can work in a worktree of its own, and the archive deliberately stays at home** (#223).
Working in `.worktrees/<issue>` is a thing this file has told a *human* to do since the repo was
developed on itself — so the tool changing the code is a published build rather than the tree it
is editing — and doing it by hand is four commands plus a cleanup nobody remembers. Asked for as
*"the pilot should automatically start a worktree for the vibe session to run in"*, with a toggle
and a custom script.

**The whole feature is one distinction**, and `src/worktree.ts` holds it:

- **`state.targetDir` is the run's home.** The archive, the lock and the planner's past-run index
  all live there, and none of them move.
- **`workDirOf(state)` is where the work happens** — every git operation, the verification gate,
  and the cwd of every agent child.

They are the same directory unless the run has a worktree, which is what makes this inert when it
is off. In the loop it costs **one line**: `runPhases` resolves `cwd` once and threads it to
ninety-odd call sites, and that comment — *"resolved once and threaded"* — is why redirecting a
run into another tree is a one-line change rather than an audit.

**Putting the archive in the worktree was the obvious shape and is the wrong one.** It was
offered and declined: a run's record would land in a tree somebody is about to prune, and this
file carries a hand-written `cp -r` recipe for exactly that loss because `git worktree remove`
takes `.vibe/` with it. Worse, the next run's planner reads `.vibe/runs` in the tree it is given,
so every auto-worktree run would start blind to a history it had itself produced — #52 going
quietly dead. Keeping the archive at home costs one indirection and deletes the whole class.

Five things are load-bearing:

- **A decision is stored; the path is derived.** `state.worktree` is a boolean and the location
  comes back out of `worktreePath(targetDir, id)`, for the reason `loadRun` re-derives `dir` and
  `targetDir`: a repository legitimately moves, and a stored absolute path is the thing that
  breaks when it does. What cannot be re-derived is whether the run *started* with the setting
  on, since it may have been toggled since — so that is what is kept, in the **first** state
  write, because `allocateRun` requires it: a run that came back believing it had no worktree
  would work in the repository while its branch is checked out elsewhere.
- **It is created detached, and `prepareGit` still names the branch.** `git worktree add -b`
  here would be a second answer to a question seven call sites and `run_branch` already settle,
  and the two would disagree the first time somebody set `git.branchPrefix` or passed
  `--no-branch`. This decides *where*; that decides *which branch*, inside it.

  **The script is told the branch, and it is still one answer** (#223). It was given
  `VIBE_WORKTREE`, `VIBE_REPO` and `VIBE_RUN_ID` and deliberately no branch, and that left a
  project's own script unable to do the obvious thing — *"we need to be able to have a
  placeholder for the directory path and branch name"*. So `runBranch` in `src/git.ts` is the
  one expression for the run's branch, the worktree site creates it as a **ref** from HEAD
  before the script runs and passes it as `VIBE_BRANCH`, and `prepareGit`'s fresh path
  **adopts** a branch that already exists instead of `checkout -b`-ing it again. Creating the
  ref first is what makes one line of script right on a fresh run and a resume alike: `git
  worktree add "$VIBE_WORKTREE" "$VIBE_BRANCH"`. With branch isolation off the variable is
  **unset**, not empty, because an empty string is a name a script could hand to git; a
  repository with no commit has no HEAD to put the ref at, so it is unset there too and
  `prepareGit` makes the branch as it always has. They are environment variables rather than
  `{dir}`-style text substitution because a path pasted into a shell line breaks on a space,
  and a quoted variable does not.

  **A run starts from the base it was told, and a worktree is never moved silently** (#249).
  The #169 run started from the root checkout's stale `fix/223` tip instead of
  `origin/develop`: its script detached at the commit it wanted, and `prepareGit` checked the
  branch — made at HEAD — out over it without a word. Four decisions, all the owner's:

  - **A base is a setting.** `git.baseRef` (project-only, default null) is resolved **once**,
    in the preflight gate, on a fresh run only, before anything is spent. A remote-tracking ref
    is fetched first. **A fetch that fails or outlives `git.worktreeTimeoutMs` refuses the run
    — there is no fallback to the local tracking ref**, because a possibly stale base is the
    defect. The bound is the existing setup budget rather than a new number, and it is needed
    at all because a `git fetch` hung for over 120s on the owner's machine and a `git` child is
    never interruptible under `cancel.ts`. `--no-branch` with a base, an unresolvable ref, and
    a dirty repository with no worktree whose base is not HEAD are each refused by name. **Null
    is today's behaviour**: the branch at HEAD. A resume never resolves, fetches or moves
    anything, and a fork's branch comes from its checkpoint.
  - **Refuse, never move.** When `prepareGit` adopts a pre-made branch it compares the
    worktree's HEAD with the branch's commit: equal is the default path and the checkout moves
    nothing; different is an `Escalation` naming both shas. This holds with `baseRef` unset,
    and it is the one behaviour change when it is: a script should check `$VIBE_BRANCH` out,
    not choose a commit. The default `git worktree add --detach` now detaches at the branch's
    commit rather than HEAD, so it passes.
  - **One creation site per path, and nothing durable in preflight.** With a worktree the ref
    is made in preflight (the script must be told it); with none, `prepareGit` makes the branch
    with `checkout -b <branch> <sha>`. The sha travels from the gate to `prepareGit` through a
    run-id-keyed module latch (`chooseBase`), not a state field and not a second read of the
    ref — a fetch in between would otherwise start the branch at a commit the dirty check never
    saw, and a stored base would outlive a run stopped before it took its branch.
  - **The start is recorded.** `state.start = { sha, ref }` (ref null for HEAD) is written by
    `prepareGit` in the **same save** as `state.branch`, so neither is on disk without the
    other; `run_branch` carries `startSha`/`startRef` on that path only, the sentence says
    `from origin/develop (a7b5f9b)`, and the summary prints a `Start:` line when the field
    exists. Absent on older runs and never back-filled; a fork drops its parent's.
- **The script goes through a shell, and that is `verify.command`'s rule rather than a hole in
  `commands.ts`'s.** `verify.ts` states it at the one place a shell is used at all — *"Model-
  authored text is never passed to a shell"* — and this is the same category: a line a **person**
  wrote into a file they commit, whose whole purpose is to be a sequence, because a worktree
  nobody installed into cannot run the gate. `runUserCommand` is **exported and shared** rather
  than copied, so "a shell is used in exactly one place" stays true and the hard-won Windows
  branch — `cmd.exe /d /c` with `windowsVerbatimArguments`, because `shell: true` adds a layer of
  quoting that mangles an already-quoted argument — is not written twice. No model can reach the
  key: there is no config tool (#144 decision 3).
- **A script that reports success is checked anyway.** `createWorktree` asks git whether there is
  a working tree at the path afterwards, because a script that exits 0 and leaves nothing would
  otherwise hand the loop a directory that is not a checkout, and every git command after it
  would fail one at a time with nothing naming the cause. It refuses before the first turn, where
  a refusal costs a sentence — the same bargain `gitPrecondition` strikes four lines below it,
  and for the reason #71 records: that run spent 30M tokens before the review phase discovered
  its own directory could not host it.
- **Creation lives in the preflight gate, which is the one site a resume also passes.** So a run
  whose worktree was pruned between sessions gets it back, and `createWorktree` is idempotent by
  asking whether the tree is usable rather than whether the directory exists — a half-made one is
  what a killed creation leaves, and reusing that would put the run somewhere git does not know
  about.

**Off by default, and that is not timidity.** A bare `git worktree add` produces a checkout with
no dependencies installed, so on most projects the verification gate cannot run in it — turning
it on without `git.worktreeCommand` would break runs that work today. The feature is only useful
*with* its setup command, so the default cannot be on; this file states the general rule as
*"groundwork ships separately, with no behaviour change"*, and the proof it was followed is that
the threading landed with 1870 tests green and `worktree` never set.

**What it costs is disk, and nothing here reclaims it.** This file already measures a worktree
that has built the app at gigabytes, and auto-creating one per run makes that faster rather than
different. Nothing deletes them and nothing pretends to — the directory is named after the run so
the ones worth pruning can be told apart, and the section on the settings screen says so in the
same words rather than leaving somebody to find out.

**`.worktrees/` is self-ignoring wherever it sits.** `ensureWorktreesIgnored` is
`ensureVibeIgnored`'s shape and its reason: this repo's own `.gitignore` lists `.worktrees/`, but
a directory vibe creates in **somebody else's** checkout cannot rely on that, and a tree full of
untracked worktrees is a `git status` nobody can read. It never overwrites an existing file.

**And `workDir` reaches the window, because the pilot reads a directory.** `run_started` carries
it beside `repo`, which is this file's own rule about a fact the run holds and never says: with a
worktree the loop writes in a subdirectory and the repository root still holds whatever was there
before, so a pilot pointed at the root would describe a tree the run is not touching and report
that nothing is changing while a great deal is. The root is its permission boundary and the
worktree is inside it, so `--restricted` already allowed the read — what was missing was any
reason to look. The prompt says it **only when the two differ**, since a sentence about working in
the repository would be noise on every run that has no worktree, which is all of them by default.

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
src/config.ts        DEFAULTS, config merge, validation, and the global file under the project's
src/consistency.ts   cross-field rules over status/phase/planOnly, applied by loadRun
src/types.ts         shared types, including RunState
src/prompts.ts       every prompt the agents receive
src/claude.ts        Claude Code adapter (stream-json)
src/pilotchat.ts     one pilot chat turn on the subscription - a child process, not a client
src/pilotcodex.ts    the same on the OpenAI subscription - `codex exec`, its own tools switched off
src/clipaths.ts      where the two CLIs are when the settings say so, and what the search found
src/auth.ts          how each vendor is reached, for runs and the pilot: the routes and a child's env
src/heldkeys.ts      the API keys the app handed the host - in memory, and redacted from everything
src/codex.ts         Codex adapter (codex exec --json)
src/appserver.ts     Codex app-server JSON-RPC client (rate limits only)
src/ratelimits.ts    rate-limit windows and the brake
src/charge.ts        the one seam every token and dollar is charged through
src/slots.ts         session-slot lifecycle (main = Claude, judge + review = Codex, write = one-shot Codex)
src/context.ts       context measurement, compaction, session rotation
src/preflight.ts     toolchain contract enforcement, `vibe doctor`
src/cliversions.ts   the installed claude/codex against the tested versions, and the flags vibe passes
src/verify.ts        the verification gates — the list, every run, and broken vs flaky
src/judge.ts         which changed files are the run's own judge, and the reviewer's verdict on each
src/reproducer.ts    a reviewer's test: placed, run by the user's own gate, taken back out
src/progress.ts      in-turn heartbeat
src/work.ts          how far a write turn has got - measured, and labelled a proxy
src/schemas.ts       the JSON schemas both CLIs are pinned to
src/validate.ts      parser vocabulary for model output
src/proc.ts          child-process plumbing, and how a child ended
src/cancel.ts        stopping a turn that is already running - the latch, what it may kill, and the wait it may cut short
src/commands.ts      a command a person pressed - no shell, no shim, and where it runs
src/commandlog.ts    a command's output on disk, and what the last launch left there
src/models.ts        which models each CLI offers, asked of the CLI - never a list here
src/modelflag.ts     `default` means no model flag, so the CLI picks
src/ending.ts        how this process ended - the stamp beside the lock
src/git.ts           branch and commit operations
src/worktree.ts      a checkout of its own: where the work happens, and where it does not
src/pilotaccess.ts   what the pilot may do unasked: the safe list, YOLO, its directories, its reads
src/mcp.ts           which MCP servers a run's children reach: none unless a role names one
tests/               node:test, one file per concern
tests/docs-drift.test.ts  the docs' reference pages against DEFAULTS, EXIT and the commands - nothing missing, not accuracy

app/                 the desktop app - Vite + React, its own package.json and gate
app/src/design/      tokens.css, theme.css (Tailwind over the tokens), and the primitives still drawn
app/src/design/HANDOFF.md  the design corpus - every screen a source comment cites, by name
app/src/design/AUDIT.md    the built app walked against all fourteen hi-fi frames, and closed
app/src/cockpit/rounds.ts  a round as one card, and which round a thing arrived during
app/src/cockpit/rail.ts    what the run rail says: a turn's group, the now card, the verify row
app/src/cockpit/Counts.tsx the four severity counts, and the one place they are a control
app/src/cockpit/squares.ts what the navigator may draw, and the two letters standing for a run
app/src/cockpit/Sidebar.tsx  projects, their runs, and the pins - the rail merged into one
app/src/cockpit/projects.ts  which repositories are open, which runs are pinned, and renamed
app/src/cockpit/pending.ts   a run asked for and not started yet - the row between start and run_started
app/src/cockpit/Confirm.tsx  the dialog in front of anything that cannot be undone
app/src/cockpit/appearance.ts  how big the product is drawn, and nothing else about the look
app/src/cockpit/drafts.ts      saved prompt versions - the window's library, not the project's
src/answers.ts          filling in NEEDS-INPUT.md from somewhere that is not a text editor
app/src/cockpit/Settings.tsx   every setting, and which of the three places each one goes
app/src/cockpit/outgroups.ts the output cut into rounds, and a finished run's transcript
app/src/pilot/saved.ts       a conversation kept between launches, and which run it is about
src/replay.ts           a finished run, said again - and what an archive cannot say
app/src/cockpit/useReplay.ts   folding a finished run through the reducer that drew it live
app/src/cockpit/artifacts.ts what a run wrote: classifying a listing, and reading a report
app/src/cockpit/useArtifacts.ts asking the host for a listing, and for one file when it opens
app/src/cockpit/useStats.ts    asking the host for the archive's scorecard, and again when a run ends
app/src/cockpit/Disclosure.tsx the one section-that-opens, at every level it appears
app/src/cockpit/PlansPane.tsx  every version of the plan, one section per round
app/src/cockpit/ReportPane.tsx a judge's own report - the critique and the review, one screen
app/src/cockpit/CodePane.tsx   what each round changed, from the range its commit carries
app/src/pilot/log.ts       rounds and conversation in one scroll, and who may reorder whom
app/src/shell/       the editor-shaped frame: activity bar, status bar, palette, and their pure tables
app/src/shell/update.ts      what the window decides about an update: the skip, the setting, the bar
app/src/shell/UpdatePopover.tsx  the ⬆ tool above ⚙, and what it opens
app/src/ui/          the shadcn components, over the tokens - button, badge, command, popover, tooltip, resizable
app/src/cockpit/pane.ts    the artifact panes' shared layout, named once - nine subjects, one shape
app/src/host.ts      the webview's end of the wire: typed frames, and nothing re-derived
app/src/cockpit/model.ts   frames in, a run out - the ONLY logic in the app, and it is pure
app/src/cockpit/hosts.ts   the live runs: routing by handle, what is drawn, the cap, the write rule, adoption
app/src/cockpit/format.ts  durations, counts, and the closed maps: boundaries and exit codes
app/src/cockpit/           the loop column, the running row, the output pane, the gate footer
app/src-tauri/       Rust: window, tray, single instance, spawning and relaying
app/src/pilot/       credentials, the wire, and the pane - transcript.ts is the pure part
app/src/pilot/tools.ts     what the pilot may touch: the table, its executors, and propose-only
app/src/pilot/access.ts    which proposals the person's settings run without a card
app/src/pilot/ledger.ts    the pilot's own books - the one place a dollar is a dollar
app/src/cockpit/argv.ts    a form to an argv, and the composer's settings as the pilot is told them
app/src/cockpit/commands.ts  commands this window ran - pure, and not part of any run
app/src/cockpit/where.ts     where the window was pointed, kept between launches
app/src/memory.ts            what the window remembers - host files behind a synchronous cache
app/src/cockpit/models.ts    the four model listings the pickers draw, and nothing else
app/src-tauri/src/pilot/models.rs  which models a stored key may use, asked of the vendor
app/src-tauri/src/host.rs    supervising the hosts - the service host and one per run - and the \\?\ path fix
app/src-tauri/src/reaper.rs  making a killed app take the host with it
app/src-tauri/src/keys.rs    the OS keychain, and the read the window cannot reach
app/src-tauri/src/pilot/     one of the app's two network clients - two adapters, one vocabulary
app/src-tauri/src/update.rs  the other: checking for a newer app, and installing it when asked
app/src-tauri/src/pilot/sse.rs      the wire format both vendors share, and nothing else
app/src-tauri/src/pilot/event.rs    PilotEvent and Usage - every count an Option, on purpose
app/scripts/         contrast.mjs, stage-sidecar.mjs, make-icon.mjs - all dependency-free

docs/                the docs site - VitePress, its own package.json, never in `files`
docs/.vitepress/config.mts  the site's config: BASE (the one place the path is written), sidebar, search
docs/images/         screenshots, shared by README.md and the site
docs/plans/          internal design notes, excluded from the site
.github/workflows/pages.yml    builds docs/ from main and deploys it to Pages
.github/workflows/ci.yml       the core, app and Rust gates on push and PR into develop and main
.github/workflows/release.yml  the desktop bundles on a v* tag, into one draft release
.github/actions/linux-deps/    the Linux packages a Tauri build needs, listed once
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

The webview is given **no shell permission at all**. The host is spawned from Rust with a
path Rust resolved, and `host_send` writes one line to a process that is already running.
No Tauri command takes a program name, and none ever should: a window that could spawn is a
window whose renderer can spawn.

**Running a command is a host request now, and the rule it reverses is worth stating** (#211).
This file said *"there is deliberately no command that takes a program name — the pilot chat
can drive the session, and 'run this program' must never be in reach of it"*, and
`pilotchat.ts` explained why `Bash` is absent from the pilot where a *run's* read-only seats
have it: *"That set is read-only in the sense a run's seats are — a shell under a sandbox, in
work a person launched. This is a chat surface the model drives turn by turn."*

That was written when the pilot was a tab beside a form. It is now the front door, and it
could not check whether the thing it had just built starts — so it answered *"here is exactly
what to type"* and handed the last mile back to a terminal. That is the evidence that
reopened it, not a fresh opinion.

**What is reversed is narrow.** The model still runs nothing: `run_command` is a *proposal*
drawn with the exact program, arguments and directory, and a person presses it — the same
shape `start_run` takes, and #144's decision 1 unchanged. What is new is where an accepted
proposal goes: a `command` frame to the **host**, which is Node and already spawns children,
on the road `invoke` and `diff` take. Rust is still transport, the webview still has no shell,
and the window has its own command control — so this stays a host request the app makes rather
than a pilot power.

`src/commands.ts` has one invariant and every rule below serves it: **what runs is what was
displayed.**

- **No shell, ever.** `program` and `args` are separate from the schema to the spawn and are
  never joined, so there is no line for a `;` or a backtick to be in. `run_command` refuses
  shell metacharacters *with the reason*, because a model told why sends two calls rather than
  guessing.
- **A shim is refused, not shelled.** On Windows `npm` is `npm.cmd`, and running a `.cmd`
  means `cmd.exe`, which means quoting rules that decide what the arguments were. So the
  Node-family CLIs resolve to the JavaScript they are — `npm install` spawns as
  `node …/npm-cli.js install` — and anything else resolving to a `.cmd`, `.bat` or `.ps1` is
  refused by name. A command whose arguments could be re-read is not the command anybody
  pressed.
- **It runs where the window is pointed**, checked to exist first and never defaulted to
  `process.cwd()` — the defaulting that put the pilot in a home directory.
- **A dev server is the point, so it survives — including a relaunch** (#223). This said a
  server left listening after its window had gone was *"a port with no owner"*, and the host
  killed every command on its way out. That was true while nothing could find it again; once
  the log was on disk the next launch could, and what the old rule cost was every server the
  pilot had started, on every rebuild — the pilot then reported, correctly, *"they stopped when
  the previous session ended"*. So on POSIX, with a log directory, a command is spawned
  **detached, writing straight into its log file**, and the host follows the file rather than a
  pipe. `keepCommandLogs` takes back any record still marked running whose pid is alive **and
  started when the record says** (`ps -o lstart`) — a live pid alone could be a stranger, and
  the next stop would signal it. A picked-up command is not the host's child, so its ending
  carries no exit code and the window says *exit code not seen* rather than calling it a
  failure. A stop signals the **process group**, so `npm run dev` takes Vite with it.
  `stopTiedCommands` still stops what cannot be picked up — Windows, where the host's children
  sit in the app's job object and leaving it has not been measured, and a host with no log
  directory.


**A process the pilot starts is one it can follow, and one it can turn off** (#223). Running a
command landed without the three things that make a *background* process usable, and a manual
pass found all three in one exchange. Asked to start the app, the pilot proposed `npm run dev`,
said *"I'll read it back with read_command to confirm both processes bound their ports"* — and
then could not. Three reads in a row came back as **waiting to be run**, it reported that
honestly twice, and the person watching wrote: *"I need the pilot to be smarter. I need it to
be able to know when things started up. I need it to be able to tail logs from processes it
starts so it can debug."*

- **The reads were a defect, and it is the one worth remembering.** `emit.ts` numbered a call
  `emit:<turn>:<n>`, and its own comment claimed that kept ids unique "across a conversation".
  It does not: a **turn id is unique within one window session and a conversation outlives
  one**. `nextRequestId` is a module counter starting at 0, so every launch walks the same
  numbers again, and `saved.ts` restores the conversation from `localStorage` with its tool
  results in it. `settle` then refused — correctly, since two results for one id is a 400 from
  both vendors — and the call was never settled at all. **Nothing anywhere said so**: no error,
  no refusal, just a card reading *waiting to be run* for ever and a model told nothing. The id
  now carries an `origin` for the window session, passed in rather than generated inside, so
  `readEmitted` stays pure and the randomness lives at the one call site whose lifetime is the
  window's. The shape to carry away is the general one: **an id is only as unique as the thing
  that seeds it is long-lived**, and this one was seeded by something shorter than the record
  it was written into.
- **A read has a cursor, because a log is followed rather than re-read.** `read_command`
  answered with the whole buffer every time, so a dev server's answer grew without bound and
  nothing in it said which part was new. Every answer now carries `cursor`, passed back as
  `since`, and `tail()` in `app/src/cockpit/commands.ts` is where the arithmetic lives — pure,
  for `model.ts`'s reason, because it has two off-by-one edges and a truncation case. `bytes`
  counts what was **written** rather than what is kept, so a cursor cannot rewind when the
  buffer drops from the front, and a read that starts before the oldest byte still held reports
  how much it **missed** rather than presenting a tail as the whole. A `since` with no `id` is
  refused: one position cannot describe two commands.
- **The app says when a process changes state, so the pilot stops guessing.** Two wakes, once
  each per command, and they are different facts: one that **ended** has an outcome, and one
  still running that has written nothing for `SETTLED_MS` has **finished starting up** — which
  is the only measurable form of *"it came up"*, and the wake says that rather than claiming the
  server works. It carries **no output**: it says a command moved and tells the model to read
  it, so what gets reported is something read rather than something the app asserted.

  **This one is on where the gate watcher is off**, and the line between them is the whole
  argument. A gate opens when the loop reaches it, possibly hours later with nobody in the
  room — which is why that watcher is *"the first turn in the product that nobody asked for"*.
  A command exists because somebody pressed **run it** in this window seconds earlier, on a
  proposal that usually says in as many words that the pilot will read it back. Finishing that
  sentence is the second half of an attended turn, not an unattended one. It is bounded by the
  same `ready`, `MAX_CHAIN` and daily ledger as everything else here.
- **`stop_command` exists because the absence of it got improvised around.** Asked to stop the
  server, the pilot said *"I have no tool that kills a command"* and proposed `npx kill-port
  5173 4000` — which killed a stale process on a port it had guessed from `package.json`, left
  the real server running on the port Vite had **actually** fallen back to, and took an
  unrelated `node --watch` down with it. A capability with no off switch is not a narrower
  capability; it is one whose off switch gets improvised, on a port rather than on a process.
  It names a command by the id `read_command` reports, it is propose-only exactly as starting
  one is, and a command that has already ended is refused **with its outcome**, because
  *stopped* and *exited on its own* are different facts and a model told the second will not
  report the first.
- **The prompt now says to name a port from what the process printed**, never from a config
  file. This is the finding underneath the whole exchange: the pilot read `5173` out of
  `package.json`, Vite found that port taken and fell back to `5174` and said so in its output,
  and a person sent to the first address would have been looking at a different process than
  the one they had just started.

**A stop already takes the whole tree, and that is the platform rather than this code.** It was
worth asking, because `npm run dev` is `node npm-cli.js` spawning a script that spawns
`concurrently` that spawns Vite and a watcher — and `child.kill()` on Windows is
`TerminateProcess` against exactly the pid it names. A `taskkill /T /F` was written into
`stopCommand` for it and then **removed**: the test passed identically without it, because
**libuv assigns every child a Node process spawns to a global Job Object with
`KILL_ON_JOB_CLOSE`** and job membership is inherited down the tree. A fix that changes no
outcome is a fix with no evidence behind it. What survives is the measurement —
`command-runner.test.ts` pins that a grandchild this process holds no handle to dies with the
command — because it is load-bearing for the dev-server story and it is somebody else's
behaviour, not ours.

`Effect` has four kinds now and `keys.test.ts` moved with each of them. The sentence it tested
was never "there are two" — it was *every effect is a request the window also makes*, which
still holds of all four: `stop_command` routes to the `stopCommand` the card's own stop control
already called, and adds nothing to the wire.

**Every pilot capability is a host request the app already makes** (#144). The tools in
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
matrix. There is **no config tool** (decision 3), pinned by a test rather than left as an
omission. Decision 4's archive tool landed with #114 as `read_archive`, a **read** rather than
an effect: it returns the run listing and the scorecard for the repository on screen, asked
fresh on every call.

**What the window and the pilot read from the archive, and why each piece lives where it does**
(#114). The issue said to fill both placeholders "from the scorecard", and neither could be:
`scoreArchive` is cross-run aggregates, with nothing per run and nothing about time.

- **The rounds fingerprint is on `RunSummary`.** `rounds` is filled by `summariseStored` from
  the state.json `listRuns` already parses, so the `archive` frame carries it with no second
  read and no second route. A counter a run never recorded is `null`, drawn `–`, never 0; an
  entry nothing was read from has no fingerprint. `q<n>` is shown only when non-zero, because
  since #223 a question round no longer advances the plan round.
- **The comparable-turns line is tokens, never time.** A charge event carries no duration and
  no model, and a gap between charges includes every gate held. So `turns.byKind` in the
  scorecard is a token distribution keyed by `seatOf(label).kind` — the one inverse of the
  labels — over successful charges only, median and p90 by nearest rank, and the line always
  says `across models` and always names n, with **no minimum sample**: a threshold would be an
  invented number. Labels `seatOf` cannot place are counted as `unplaced`.
  `SCORECARD_VERSION` stays 1, because an added field changes no existing meaning.
- **`stats` is its own read frame, kept off `archive`.** The sidebar asks for `archive` every
  time a section opens, and scoring reads every state.json. `useStats` asks when the window
  points at a project and again when the live run ends (`statsEpoch`), and never on a timer.

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
instead of a second bill. Three things about it are load-bearing:

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
  The module's part is to raise a `RateLimitError` as itself so there is
  something to act on; the wiring's part is that the two sets of books stay
  separate — `ledger.ts` is the pilot's own, precisely so a conversation cannot
  stop a run by spending its ceiling. A **shared** budget is what is not built,
  and that is the honest state of it rather than a solved problem.

**It is wired in, and a pilot turn is not a run.** The `pilot` frame goes to
`serve.ts`, which runs it **outside the one-at-a-time gate and outside
`finished()`**. That rule is about *runs*: `src/lock.ts` expects one process per
run and two runs would interleave their narration. A pilot turn takes no lock,
writes no state and narrates nothing — and a conversation about a run is most
useful *during* one, so refusing it then would refuse it exactly when it is
wanted. A second `invoke` is still refused, which is what keeps the exemption
honest.

**A backend is not a provider** (`app/src/pilot/backend.ts`). `Provider` is the
*keychain's* vocabulary — `key_set` and `key_status` refuse anything but the two,
and `keys.test.ts` pins the list — so widening it would mean a third key slot for
a backend that has no key. `Backend` is the wider axis and `needsKey` is the one
place they meet, as a type guard rather than a boolean so a caller that has
checked cannot then hand `'subscription'` to the keychain.

**The two are asymmetric in both directions, and both are on purpose.** The
API-backed pilot has no filesystem at all; the subscription one can read the
repository. In the other direction the subscription pilot used to have **no vibe
tools** — no `start_run`, no proposals — because tool declaration is a vendor-API
feature and `claude -p` takes no schemas from us.

**That limitation is closed, and closing it is what let the launch form go**
(#211). The complaint was exact — *"I shouldn't have a button to start a run, the
pilot should control that"* — and it could not be answered while the default
backend, the one that needs no key, was the one that could not propose anything:
deleting the bar would have shipped a front door that does not open.
`app/src/pilot/emit.ts` is the channel. `declare()` goes into the system prompt
instead of onto the wire, a call comes back in a ```` ```vibe-tool ```` block, and
it is parsed into the same `Call` a vendor streams — so `execute`, the proposal
card and the button underneath it are untouched. **One table, two channels**, and
a tool cannot exist on one backend and not the other.

Three things keep it honest, and the first is why it is not the English-matching
#133 exists to prevent. **The block is authored for this reader**, described to
the model in as many words, the same way a JSON schema is on the API path — where
#133's failure was prose written for a human and read for a decision. **Reading it
wrong decides nothing**: every tool that acts is propose-only, so a misparse is a
card with a visibly wrong argv that nobody presses. And it **fails closed in the
cheap direction** — a block that is not JSON becomes a call that says it cannot be
run, and one that names no tool is refused by name with the real list, which is
the only way the model corrects itself. `src/raise.ts` is the same shape already:
declared markers, parsed on resume, refused rather than repaired.

What is still asymmetric is the wire and not the capability: a vendor validates a
call against a schema before it arrives, and an emitted one is validated here on
arrival. `BACKEND_NOTE` says which road this backend is on, because what comes
back looks the same and how it got there does not.

**A turn is read whole, and reading only its last message silently ate calls**
(#223). `readDelta` yields **every** assistant block in a turn — including the
interstitials the model writes between its own `Read` and `Glob` calls — while
`result.result` is only the final message. The parse read `frame.text` alone, and
its comment called that *"the whole reply"*, which it is not. So a model that
wrote a `vibe-tool` block, went on reading files and then summarised had its call
**thrown away**: no card, no refusal, nothing drawn at all.

**It is the worst shape of failure this channel can have, because it is silent on
both sides.** The model does not know its block was dropped, so it says what it
did — *"I put up two `gh` cards and you want the second one"* — over a transcript
with no cards in it, and the person reading has no way to tell which of the two
is lying. Reported as *"it said run the second gh card… but nothing happened? I
had to nudge it and then it finally tried to run the github cli"*: the nudge
worked because by then the model was not reading files, so its block landed in
the final message.

The old reason for reading the final message was real and is **kept rather than
traded**: a block split across two deltas is one block in the whole. Concatenating
the deltas satisfies that too, so this is a strict improvement. What it adds is a
model repeating its own block in the summary, and `unique` answers that — keyed on
the **name and the arguments together**, because the case that produced the report
was two different `gh` cards, one with an empty `--repo ""` that would only error
and one correct, with the model naming which to press. Collapsing by tool name
would have hidden the one it was pointing at.

The accumulation is a **ref keyed by turn**, for the reason `hostTurn` is one: the
frame handler is registered once and reducer state read inside it would be stale.
It feeds the parse only — the pane still shows the final message, because the
interstitials are the model talking to itself, and `retext` replacing the
accumulated text is a display decision that was always right.

**The stop button has two roads, because a pilot turn does** (#223). It called
`pilot.cancel`, the Rust pilot's, which only knows API-backed turns — and the default
backend's turn is a `claude` child of the **host**. Rust refused, the click handler swallowed
the refusal by design (*"the turn ended between the render and the click"*), and the child ran
to completion: *"The stop button on the pilot chat doesn't actually do anything."* A swallowed
refusal is only safe when the refusal can only mean the benign thing, and this one could also
mean *wrong road*.

`pilot_stop` names the turn by its request id, and the host holds one `AbortController` per
turn in flight. `RunOptions.signal` is **one child's own off switch**, deliberately not
`interruptible`: that is the run's latch and kills every agent child of the run, and stopping
a conversation must not stop the run it is about. A stopped turn answers `pilot_stopped`, never
`error`, so the pane draws it as stopped — the word the API road already uses for the same
act. The pane clears its host turn whenever an API turn starts, because Rust's turn ids and the
host's request ids are two counters and a stale match would send the button down the wrong road
again.

**Some commands run without a card, and the line that reverses is narrow** (#223). This file
said *"'run this program' must never be in reach of it"*, and #211 kept that true by making every
command a proposal a person presses. Then: *"It's completely safe for it to run 'ls', 'cat',
'echo', 'git add|commit', etc… we should give it a toggle for 'YOLO' mode… a setting to add dirs
that it's allowed to operate in."* `src/pilotaccess.ts` and `app/src/pilot/access.ts` are the two
halves, and four things carry it:

- **The safe list changes who presses, never what runs.** A matching `run_command` is fired through
  `onEffect`, the road a pressed card takes, into `commands.ts` — so there is still no shell, which
  is what makes one list mean the same thing on Windows, Linux and macOS. `ls`, `cat`, `cp` and the
  other file commands **are** defaults, and that reverses the first cut: it left them out because
  Windows has them only as shell built-ins, and the reply was *"where are commands like ls, cat,
  cp, etc?"*. They are the POSIX programs, so on Windows they work where something like Git for
  Windows put them on `PATH` and otherwise fail as not found — never as something else. `cp` and
  `mkdir` write, which is why **an argument touching `.git` falls back to a card**: `cp evil.sh
  .git/hooks/pre-commit` followed by a safe-listed `git commit` would otherwise run code nobody
  approved. `rm`, `mv` and `find` (which has `-delete` and `-exec`) are not on the list.
  `list_dir` and `read_file` are the pilot's own reading tools, answered by the host on **both** backends, so the
  API-backed pilot is no longer without a filesystem. A pattern is a program and its leading
  arguments as a prefix; a program named by path never matches, and an argument naming a path
  outside the allowed directories, or a `..`, falls back to a card. `git branch` is listed only in
  its listing forms because the prefix would otherwise cover `-D`.
- **It is the machine's setting and never a project's.** `vibe.config.json` is committed, so a
  repository you clone could otherwise put `rm` on its own safe list or switch YOLO on; `loadConfig`,
  `withProjectFile` and a project write all refuse a `pilot` key by name. It lives in the global file
  and is deliberately **not** part of `Config`, because a run's `state.json` stores its config and
  `ledger.test.ts` pins that `src/types.ts` says nothing about the pilot.
- **The boundary is the host's.** The subscription pilot gets each allowed directory as `--add-dir`
  — `--restricted` confines the file tools to the working directories, `--add-dir` included, so
  this widens the read and nothing else — and YOLO is the root of every disk. Measured rather than
  assumed: a `Read` outside the cwd came back `DENIED` with no `--add-dir`, and succeeded with the
  directory or with `/`. The `fs` frame resolves its own roots from the same file, so a window
  cannot name its way out.
- **YOLO still leaves two things behind a press**: `start_run` and `answer_gate`, which are not
  commands, and a run is the most expensive thing in the product. And a conversation **restored from
  storage never auto-runs anything** — yesterday's `git commit` must not fire because the window
  reopened. The model is told *"ran without asking"* rather than *"the user accepted this"*, because
  nobody pressed anything, and the answered card draws the exact command, since an auto-run is the
  one command that was never displayed before it ran.

**Each vendor has two roads, and Settings picks one** (#223). *"There should be two options
for both anthropic and openAI: (1) subscription, (2) api key."* The pilot pane used to choose from
`Claude (subscription) · Anthropic · OpenAI`, a list mixing a CLI with two vendors and offering no
way to OpenAI without a key. Now the conversation picks the **vendor** — the picker says
`Anthropic` or `OpenAI` and nothing else, because the road is said once, in Settings —
`auth.anthropic` and `auth.openai` in the settings for all projects pick the **road**, and
`backendFor` in `app/src/pilot/backend.ts` is the one place the two become a backend. Three things
carry it:

- **`src/pilotcodex.ts` is the OpenAI subscription road**, `pilotchat.ts`'s twin on `codex exec`.
  Codex has no closed tool allow-list, so this one is a deny-list — the shape `pilotchat.ts`
  replaced — held up by what sits under it: `OFF` switches off the shell, code mode, the browser,
  apps, plugins, sub-agents and the rest; `web_search="disabled"`; `-s read-only` (and `resume`'s
  default, which is the same); and `--ignore-user-config`, so no MCP servers. Measured on 0.157.1,
  the turn is left with `exec` (which fails closed with code mode off), `wait` and
  `request_user_input`, and cannot read a file — so it reads through `list_dir`/`read_file` like a
  vendor, inside the host's roots. The system prompt goes in `model_instructions_file`, which
  replaces Codex's base instructions as `--system-prompt` replaces Claude's (input fell from ~12K to
  ~7.6K tokens) and is re-read on a resume; a file rather than `-c developer_instructions`, because
  Windows caps a command line at 32,767 characters. Both a new thread and a resume were run for real
  while building it, and `pilot-codex.test.ts` pins that shape. `Backend` keeps `subscription` as
  the Claude CLI's spelling because every saved reply stores it; the Codex one is `codex`.
- **Where each CLI is can be said, and it is the machine's.** `cli.claude` and `cli.codex` in the
  global file sit between the environment variable (which still wins — it is the more specific act)
  and the search. A project file that sets `cli` is refused by name, for `pilot`'s reason and a
  sharper one: a repository naming the executable every agent turn is spawned from is a repository
  choosing what runs on your machine. Not cached, so a change in Settings reaches the next turn; only
  the search is, because it spawns `which`. The `config` frame carries `clis` — what was found, and
  by which look — so the card can explain the search and show its answer without re-deriving it.
- **The road is not the pilot's: it is every child's** (#223). The first cut said *"runs are
  unchanged — a run's agents are always the two CLIs on your subscriptions"*, and the reply was
  *"If we have api keys set, we should use them everywhere (pilot, runs, etc). Same for
  subscriptions."* So the routes moved from `pilot` to their own global-only `auth` section, and
  `agentEnv` in `src/auth.ts` builds the environment of **every** `claude` and `codex` child — run
  turns, the fork mint, preflight probes, the app-server, the subscription pilot. Subscription
  **removes** the vendor's key variables, because both CLIs prefer a key to the login (measured
  with a bogus key each: `claude` warns that the key takes precedence, `codex exec` answers a 401),
  so a key lying in a shell would otherwise bill somebody under a setting that says nothing is
  billed. API sets `ANTHROPIC_API_KEY` or `CODEX_API_KEY` — `codex exec`'s own variable — from the
  app's key, else from the process's own environment, which is a terminal user's road; with
  neither, the turn is refused before the spawn rather than quietly falling back to the login.

  **The key now reaches Node, and how is the part to keep.** The keychain is still read only by
  Rust and never by the window. `HostProcess::send_keys` writes a `keys` line to the host's stdin
  at spawn and after every `key_set`/`key_clear`, carrying a secret put in the host's environment
  at spawn and never sent to the window — so the window, which can write frames, cannot forge one.
  `serve.ts` takes it **before** `decode`, answers nothing and never echoes it, and the secret is
  deleted from `process.env` on first read so no child inherits it. The keys live in
  `src/heldkeys.ts`, a leaf because `proc.ts` redacts with it: `run()` replaces every key it could
  have handed a child in that child's stdout, stderr and lines, because Codex's 401 quotes the key
  in full and every caller hands stderr to a log. `keys.test.ts` pins the second reader.

**A pilot turn's limit is a setting, `pilot.timeoutMs`** (#223). It was a fixed five minutes in
`serve.ts`, chosen when the pilot only read and answered, and a full CLI editing files ran out of
it: *"claude timed out after 300000ms. Can we change that anywhere in the settings?"* The default
is thirty minutes, borrowed from `claude.planTimeoutMs` rather than invented, and anything under a
minute is refused by name. It is the machine's, beside YOLO and the safe list. A turn that fails
having run its full limit says where the limit is set. That is decided by the clock, not by
reading the error's sentence.

**A launch holds the chat that proposed it until the run has an id** (#223).
`launch` points the window at the new run before `run_started` has named it, so for
those seconds the pilot pane had no run id to key its chat by. It fell back to the
project bucket, `chatKey(dir, null)`, and restored whatever stale exchange was
stored there. The new run then **adopted that** under the widened rule above. The
reports were *"the pilot chat, progress etc gets confused with a previous run"* and
*"it's like some key isn't unique somewhere"*. They were right in spirit: the key
was unique, but for a moment the pane was using the wrong one. `holdChat` keeps the
proposing key through the gap, so the gap is a `stay` and the adoption is of the
right conversation. A draft already held itself, which is why only a non-draft
launch sets it. When the proposer was a *run's* own chat, that chat keeps its record
and gives up its CLI session, because two chats resuming one session would each
answer from the other's messages.

**A stop pressed during preflight ends the run there** (#223). The probes were not
interruptible and nothing checked the latch after them or after the worktree
script. So a stop pressed in the minutes between launching and the first turn
waited all of it out, and the run ended the instant planning began. On screen that
reads as a run that stalls and then dies on its own. The probes now register as
interruptible. `stopIfCancelled` runs after the worktree script, after the probes
and after the gate, and throws `Cancelled` into `execute`'s one handler. The
worktree script itself is still not killed: it is the person's own command, and a
half-made tree is what `createWorktree` repairs on resume.

**The pilot reports how full its context is, and can compact or clear it** (#223).
Asked for as *"report context remaining for the pilot and offer some way to compact
it"*. Three things are worth keeping:

- **The figure is the last request's prompt, never `tokens`.** The reply already
  carried `tokens`, and it is what the turn *moved*, summed over every request: a
  Codex pilot turn measured 40,078 input tokens against a last prompt of 14,280.
  Claude's comes from the last assistant message plus `modelUsage.contextWindow`
  (`promptContext`, the arithmetic `extractUsage` already uses). **Codex's comes
  from its own rollout file**, `$CODEX_HOME/sessions/…/rollout-…-<thread>.jsonl`,
  because `codex exec --json` says neither the prompt size nor the window. That
  file's `token_count` event carries both, and its window is the one Codex itself
  compacts against. It is a format nobody promised, so `rolloutContext` fails
  closed to *no figure*. The API road has a count and no window, and says so
  rather than dividing by a guess.
- **Compaction is session rotation with a handoff, on every backend.** `/compact`
  does not work headless (settled above), and `codex exec` has nothing like it.
  So the pilot is asked for its own handoff summary in one turn, and then the
  wire is replaced. A CLI chat gives up its session and **carries** the summary
  into the first message of the next one; `carry` is cleared only when a new
  session has taken it, so a failed turn sends it again. An API chat re-sends
  only the request and the summary. **The log is never shortened**: `messages` is
  the wire and `replies` is the record, so both compact and clear change the
  first and leave the second alone. A clear leaves a divider in the log.
- **The session moved into the conversation, and that fixed two defects.** It was
  a ref in the pane. A relaunch therefore restored the transcript and forgot the
  session, so the pilot answered the next message from nothing. Opening another
  run's chat kept the ref, so that chat continued inside the previous one's
  session. `Conversation.session` names its backend and is saved with the chat. A
  turn on another backend retires it, because that session never saw the turn.

**The pilot runs in the repository the window named, and that path is a
permission boundary.** `--restricted` confines `Read`, `Glob` and `Grep` to the
child's working directory, so `cwd` is not incidental the way it is for a process
that writes nothing. `serve.ts` passed `process.cwd()` until #211 — under the app
that is whatever directory Rust spawned the host in, and a manual pass got a pilot
walking a home directory, timing out at 20s on every search and reporting that it
could not see the workspace. `dir` is now required on the `pilot` frame and
**refused rather than defaulted**, for the reason `diff` refuses a missing base: a
directory this process picked is a directory nobody chose.

**A subscription turn is counted in tokens and never in money**, and its `why` is
deliberately not the unpriced-model sentence. Those are two different nulls: one
is missing information, and this is a statement that there is no price to have.
Collapsing them would make the second read as an omission somebody should fix.

**The subscription pilot is a full CLI now, bounded by the settings for all projects**
(#223, at the owner's decision). This reverses the read-only pilot described below.
The pilot was truthfully telling people *"I can't edit files … Code gets written by the
loop, not by me"*, and the answer was *"The pilot should be a full fledged cli (claude or
codex) it should be able to do everything that cli can do. So long as it follows the
sandbox rules."* The limits are now `pilot.yolo`, `pilot.dirs` and
`pilot.safeCommands`, stated in the argv and enforced by each CLI's own layer:

- **Claude, outside YOLO:** `--restricted` keeps the file tools inside the repository
  and the allowed directories. `--tools` is the closed list `Read Glob Grep Edit Write
  Bash`. The permission mode is `dontAsk`, with `--allowedTools` granting the file
  tools and one `Bash(<command>:*)` per safe command, so any other command is denied
  rather than prompted. **In YOLO** it is `bypassPermissions` with every tool, which
  is why `--restricted` goes, since it refuses that mode. Measured against the real CLI:
  a `Write` inside the repository and a safe-listed `ls` ran, a `touch` was denied,
  and a `Write` to the home directory was refused.
- **Codex, outside YOLO:** its shell is back on, and it runs under
  `sandbox_mode="workspace-write"` with the allowed directories as `writable_roots`.
  That is set with `-c` on a resume too, because `resume` takes no `-s`. **The safe list
  cannot bound Codex's own commands**: `codex exec` has no per-command allow-list, so
  the sandbox is the boundary, and the prompt says so. **In YOLO** it runs with
  `--dangerously-bypass-approvals-and-sandbox`. Measured on 0.157.1: a write inside
  the repository succeeded, and one to the home directory failed with `read-only file
  system`, on a resumed thread as well. That last result is also new evidence against
  the settled *"a persisted Codex thread cannot hold a writing role"*, which has not
  been revisited for runs.

What a person presses is unchanged: `start_run`, `answer_gate`, `run_command` and
`stop_command` are still the window's proposals (#144). The prompt tells the pilot to
make a change itself rather than propose a run for it, and to use `run_command` for
long-running processes, since only those can be followed and stopped by the window.

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

**All the network code lives in `app/` and none of it in `src/`.** There are two clients, both
in Rust: the pilot's vendor adapters below, and the updater (`src-tauri/src/update.rs`, #299),
which fetches one public file and, when a person asks, the bundle it names. The core keeps
*"every external call is a child process"* exactly, and the published package gains no HTTP
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

**The app tells you when a newer version of itself exists, and installs it when asked**
(#299). It is the first network request the app makes on its own, so the shape is narrow on
purpose. `src-tauri/src/update.rs` holds all of it, behind two commands:

- **`update_check` and `update_install`, and nothing in the window.** `tauri-plugin-updater` is
  registered so Rust can drive it; there is no `@tauri-apps/plugin-updater` package and no
  updater permission in `capabilities/default.json`, so the page still has no network access
  and the CSP did not move. `keys.test.ts` pins both commands and the plugin. The check is a
  plain HTTPS GET of `latest.json` on the newest published release, with no identifiers, at
  launch and every six hours (a choice, not a measurement); a Settings switch in *this
  window's* section turns it off, and off means no request at all. Pre-releases are never
  offered, because `releases/latest` never serves one, and the plugin's own semver comparison
  decides what is newer.
- **A check never fails on screen.** No manifest (a 404 - which the newest release answers
  until one ships with the updater), no network, a manifest that will not parse: each is one
  line in `vibe-desktop.log` and `null` to the window, which draws exactly what "no update"
  draws. Both requests are bounded at ten minutes: the plugin builds each `Update` with no
  timeout, so `update_check` sets one before storing it.
- **A `.deb` never self-updates.** The plugin *can* install a `.deb`, but it looks up
  `linux-x86_64-deb` and falls back to `linux-x86_64`, which in our manifest is the AppImage,
  and would `dpkg -i` those bytes. `action_for` reads the bundle type Tauri patches into the
  binary (`tauri::utils::platform::bundle_type()`) plus `APPIMAGE` on Linux, and fails closed:
  a deb, an rpm, an unidentified Linux build without `APPIMAGE` and an unpatched Windows build
  all get **Download**, which opens the release page in the system browser - a URL that is a
  constant in Rust, spawned with `xdg-open`, `open` or `explorer.exe`, because the app had no
  link opener and the window must never name a URL. `update_install` asks again rather than
  trusting what the window drew.
- **Rust decides whether to ask, by `has_run_hosts()`.** With runs going, `update_install`
  answers `confirm` before downloading or stopping anything - a host set it cannot read counts
  as runs going - and the window draws the quit confirmation's shape and words, listing its
  runs or saying that runs are still going, and calls again only on a press. This is stricter
  than Quit, which skips a host whose run already returned; asking once too often is the safe
  side. **And no run can start once an install is under way.** The question is asked
  by `freeze_runs`, which in the same step under the host lock makes `spawn` refuse every new
  run host until the restart (or until the update gives up, which thaws it). Asked once at
  the press, a run started during a ten-minute download would have been stopped by the
  install with nobody asked about it.
- **Every host stops before the installer runs, on every platform, by the one `stop()`.** The
  plugin's `on_before_exit` hook only exists on Windows - where it matters most, since a running
  host holds `node.exe` and NSIS/MSI overwrite it - so the hook is wired for that case and
  `update_install` also awaits the same `before_install` after the download and before
  `install()`, everywhere. A run stopped this way leaves through `HOST_EXIT_ABANDONED` and
  writes `ending.json` (#206), so it is resumable. An install that fails after the stop
  relaunches the service host so the runs can be resumed.
- **One install at a time, and a failure can be retried.** `Slot` holds the update the last
  check found and an `installing` flag, both under **one** lock, with a drop guard - a flag
  read outside the lock let a check overwrite the update an install had just begun. A second press is refused, a check
  that returns during an install cannot replace what is being installed and reports that one
  instead, and the install works
  on a clone so a failed attempt leaves the update for the next press. Progress is the running
  sum of the plugin's chunk lengths (`Tally`), because the plugin reports each chunk, not a
  total.
- **The old process exits before the new one starts.** `restart()` is called from the command's
  async thread, so Tauri requests an exit and spawns the new process only after
  `RunEvent::Exit` - which is where single-instance releases its lock and `lib.rs` runs
  `stop()`. Called from the main thread it would restart without those events, and the new
  process could find the old one and raise its window instead.
- **Windows installs are `passive`.** NSIS is per-user and needs no elevation; MSI updates from
  `windows-x86_64-msi` and shows a UAC prompt. The macOS path replaces one ad-hoc-signed `.app`
  with another and is unproven.
- **The skip is this window's.** *Skip this version* writes `vibe.update.skipped` in the
  window's memory; a newer version is a different string and shows the ⬆ tool again. There is
  no remind-me-later: closing the popover is that.

**`VIBE_UPDATE_ENDPOINT` is how to test the updater.** It replaces the endpoint at runtime
through the plugin builder, never by editing `tauri.conf.json`, and must be an `https` URL (a
release build of the plugin refuses anything else); a value that is not one is ignored and the
built-in endpoint is used. Either way the app logs it at start-up, naming the URL, so a stray
value cannot go unnoticed. The signature is still verified against the built-in key, so it can
only point at bundles the owner signed. A real update needs a published release newer than
the installed build: build an older version, point the variable at a release's `latest.json`
(an `-rc` draft's, or a hand-made copy), and press Update & restart.

**The host dies when the app does, and the kernel is what enforces it.** `stop()` handles the
graceful endings by closing stdin; a Windows Job Object with
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` handles the ones that run no user code at all — `End
task`, `Stop-Process -Force`, a panic. There is nothing to hook for those by design, so the
mechanism has to be declared in advance and left to the OS. macOS and Linux have no
equivalent yet and **say so** through `Status.uncontained`. The window drew it as a
permanent banner until the owner asked for it gone, since on Linux and macOS it showed on
every launch and said nothing actionable. The field is still on `Status`; if it is drawn
again, the diagnostics popover is the place, beside the other facts that matter only
when something has gone wrong.

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
  in this file exist to explain a place this rule was applied.
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
- **A test that starts a process which never exits must stop it in a hook, not at the end of
  the body.** `command-runner.test.ts` slept a fixed 120ms and then asserted its child had
  ticked. Under the full suite — which spawns around a hundred children — that is not enough
  for `node -e` to boot, so the assertion failed; and because the `stopCommand` was the last
  line of the body, a failure skipped it. The live child then kept that file's event loop
  alive, so **an ordinary assertion failure arrived as a hang with the real failure buffered
  behind it**, and the whole suite sat there. It cost three cycles before anybody read the
  process tree, and both times before that it was written off as a teardown race.

  Two rules come out of it and they are the same two the bullets above already state. The wait
  is a **poll with a deadline** that says which way it failed — *ended before it wrote* and
  *wrote nothing within* are different findings — because a fixed sleep is a guess about the
  machine, made while ninety-nine other children are starting. And the cleanup is `t.after`,
  which runs whatever happened, including a throw from the spawn itself. Diagnosing it is
  `Get-CimInstance Win32_Process -Filter "ParentProcessId=<runner>"`: a runner with one live
  child that has a live grandchild is this shape, and killing the grandchild releases the
  buffered failure immediately, which is how it was confirmed rather than guessed.

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

### Clean up after yourself — a worktree that built the app costs gigabytes

**This is the one piece of housekeeping nothing in the tooling does for you**, and it is not
proportionate to how it feels: a worktree looks like a checkout, and a checkout that has built
the desktop app is several gigabytes of Rust object files. Nothing warns, nothing rotates, and
`.worktrees/` is gitignored so it never shows up in a `git status` you were going to read
anyway. Measured on 2026-09-10, with the repo about a year old:

| what | size |
|---|---|
| `app/src-tauri/target` in **two** worktrees | 9.07 GB |
| `app/src-tauri/target/debug` in the main tree | 5.89 GB |
| the other 40 worktrees, mostly `node_modules` | ~2.4 GB |
| `app/src-tauri/target/release` — the live build | 1.72 GB |

Three rules come out of it, and the first two cost nothing at all.

- **A `target/debug` here is always residue.** This file already says to verify the app from
  `npm run app:build` and never from a `cargo build` or `tauri dev`, and the corollary is that
  nothing in this repo ever *uses* a debug tree. It was the single largest item on the disk
  and deleting it changes nothing. If one exists, something was built the way the section
  above says not to.
- **Delete a worktree's `app/src-tauri/target` the moment its issue lands**, even if you are
  keeping the worktree. It is a cache: the only thing losing it costs is one cold rebuild in a
  tree you have finished with. Check for `CACHEDIR.TAG` inside before removing, which is what
  makes it a cargo target rather than a directory that happens to be called `target`.
- **Prune the worktree itself**, per the bullet above. Two things make that safe and both were
  checked rather than assumed: every run under a worktree's `.vibe/runs` was already in the
  main checkout's archive — 323 directories, 26 distinct runs, 0 at risk — which is the
  seeding recipe above doing exactly what it is for; and a worktree with uncommitted work
  makes `git worktree remove` refuse rather than proceed.

**`git branch --merged develop` cannot tell you whether a worktree's work has landed here**,
and it will confidently say *no* for every one of them. PRs into `develop` are squash-merged,
so the branch's commits are not ancestors of anything and the merge-base test has nothing to
find. Read `CHANGELOG.md` or the issue, or diff the branch against `develop`; do not delete a
branch on the strength of that flag. Removing the *worktree* is the low-risk half — the branch
and its commits survive it.

## Releases

1. Branch `release/<version>` off `develop`.
2. Bump `version` in `package.json`. Semver as stated in `CHANGELOG.md`: minor for new
   capability, patch for fixes, major only for a change that breaks an existing config or an
   existing run.
3. Add the `CHANGELOG.md` section — grouped Added / Fixed / Internal / Upgrading, every entry
   linking its PR and issue.
4. PR into `main`, with the `closes` keyword repeated per issue (see above).
5. Re-measure the agent CLIs this release was tested against: `claude --version` and
   `codex --version`. Bump `TESTED_CLI_VERSIONS` in `src/config.ts` to what they print, and
   re-record the fixtures with `node scripts/record-cli-fixtures.mjs` (#298). Commit both.
6. Verify from a clean checkout: `npm run typecheck`, `npm test`, `npm pack --dry-run`.
7. Merge, then tag: `git tag -a v<version> -m "..." && git push origin v<version>`.
8. **Wait for `release.yml` on the tag, install the draft on at least one machine, then publish
   the draft release.** The workflow builds the Windows, macOS (Apple Silicon) and Linux bundles
   into one draft and never publishes it. A tag that is not `package.json`'s version still
   builds, with a warning, and the bundles carry `package.json`'s version - so a throwaway
   `v<version>-rc.N` tag is how to try the workflow, and it yields a draft pre-release. A tag
   whose release is already published is refused rather than uploaded into.
9. `npm publish`. **This needs a real interactive terminal** — the OTP flow hands off to a
   browser and cannot be driven from a headless shell. A granular automation token in
   `.npmrc` avoids the prompt.
10. **Merge `main` back into `develop`.** The release PR is squash-merged, so the version bump
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
  flag, so the sandbox silently reverts after the first turn. What changed is where a writer
  sits, not the rule: a Codex implementer used to be *refused* while `codex.persistSession`
  was on, so choosing one cost the critic and the reviewer their threads too, and the
  settings screen had no way to say why (*"explain this keeping session between turns?!"*).
  It is now seated on `SLOTS.write`, which never carries a thread — every writer turn is a
  fresh `codex exec` with its sandbox set, handed the plan of record like any memoryless
  generative seat — and the read-only seats keep theirs. `roleRefusals` still refuses a
  table that puts a writer on a carried thread, asked of the slot rather than the setting.
- **`/compact` does not work headless.** It is a CLI command, not a model instruction.
  Compaction is explicit session rotation with a handoff briefing.
- **Prompts go over stdin, never argv.** Claude's variadic flags swallow positional
  arguments.
- **Groundwork ships separately, with no behaviour change.** The role table took four
  preparatory PRs (#15, #17, #28, #31), each landing with the table still hardcoded so that
  nothing about a default run changed until the last step. It is the pattern that works here;
  use it for anything touching the loop.
