# Repo map

Part of the working notes for this repo; [AGENTS.md](../../AGENTS.md) is the core and links here.
Moved out of AGENTS.md word for word on 2026-10-20, so where a note says *this file* it means
AGENTS.md and these companions together. Read this before changing the code it describes, and
update it in the same PR when that code changes.

```
src/main.ts          bin entry point — the thing package.json points at
src/cli.ts           argument parsing, the six commands, run summary
src/hostmain.ts      bin entry point for the app's sidecar — the second front end
src/updatecheck.ts   the update notice (#323) — the one network request in src/, called only by main.ts
src/serve.ts         the host session: NDJSON over stdio, gates as awaits
src/protocol.ts      the frames those two processes agree on
src/host.ts          what a host may be told at a boundary, and may answer
src/gates.ts         which boundaries hold a run, what a hold costs, and the two that cannot
src/orchestrator.ts  the loop: planPhase, reviewPhase, the guards, the prompt dispatch
src/run.ts           run state, artifacts, checkpoints, convergence maths (assessConvergence, planStall et al)
src/scorecard.ts     what the run archive says about the loop, and what it cannot
src/fork.ts          `vibe fork`: preflight that only reads, then a commit phase that creates
src/similarity.ts    the one similarity metric, its threshold, and the censuses behind it
src/finder-merge.ts  one review round's reports across finders, merged by claim, with foundBy (#388)
src/vote.ts          the review vote's fail-closed tally, pure: quorum, counted ballots, outcome (#388)
src/seat-group.ts    a round's finder or verifier turns, review.maxParallel at once; a turn that ends the round stops its siblings, never the run's latch (#403)
src/dispositions.ts  a review fix round's dispositions joined onto its findings, with seats, pure (#393)
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
src/cutoff.ts        a Codex answer cut off at its output limit: whole findings salvaged, blank runs shortened (#416)
src/appserver.ts     Codex app-server JSON-RPC client (rate limits only)
src/ratelimits.ts    rate-limit windows and the brake
src/charge.ts        the one seam every token and dollar is charged through
src/slots.ts         session-slot lifecycle (main = Claude, judge + review = Codex, write = one-shot Codex,
                     fresh-claude + fresh-codex = one-shot read-only review seats, where finders sit)
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
src/review-md.ts     the repository's REVIEW.md, read from the run's start commit, for the review seats (#389)
src/cancel.ts        stopping a turn that is already running - the latch, what it may kill, the wait it may cut short, and the scoped turn group (#403)
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
tests/release-verification.test.ts  the release's attestations and SHA256SUMS, and the pages that say how to check them

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
app/src/cockpit/seatform.ts    the review seats as a form: the finder and verifier lists, the quorum (#388)
app/src/cockpit/reviewmd.ts    the settings note on REVIEW.md at the next run's start, as one sentence (#389)
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
app/src/pilot/bound.ts     which run a conversation reads, by id (#438), and what the read says when there is none
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
app/src-tauri/src/remote/    a phone dialling this desktop: the device key, pairing, the paired list, the iroh endpoint
app/src-tauri/src/remote/bridge.rs  a paired phone's control stream: its calls, run through the window's own command bodies
app/src-tauri/src/remote/hub.rs     the one seam every event leaves through, to the window and the phones, and the live-run buffer
app/src-tauri/src/remote/settings.rs  remote.json: the switch, start at login, keep awake and the relay - Rust's file, never vibe's config
app/src-tauri/src/autostart.rs       start at login behind a trait, and whether a launch shows the window
app/src-tauri/src/awake.rs           keep awake: decided under the host lock, the OS calls on a thread of its own
app/remote/          what the phone and the desktop share: the pairing wire, the control wire, the framing, the ALPNs, the key rules, how to reach n0 - a path dependency of both, tested with `-p vibe-remote`
app/mobile/          the phone app: its Tauri crate, the mock desktop and its recorder, the launch checks
app/src/transport.ts where the window's commands go - Tauri on the desktop, the paired desktop on a phone
app/mobile-swaps.ts  the modules the phone build replaces, and nothing else
app/remote/src/client.rs  the phone's side of both ALPNs: the dial, pairing, the control stream, why it ended
app/remote/src/paired.rs  the phone's paired desktops: one file, one lock, never overwritten unread
app/mobile/src-tauri/src/link.rs     the iroh Desktop: the reconnect loop, the replay barrier, probes
app/mobile/src-tauri/src/pairing.rs  pairing's race with Back, and the code shown between its two steps
app/mobile/src-tauri/src/device.rs   the app lock: whether there is a screen lock, and asking for it
app/src/phone/       the phone's own screens - Desktops, Pair, the lock - and the reconnect resync
app/src/cockpit/notices.ts  which folded frames a phone announces, once each
app/src-tauri/src/pilot/sse.rs      the wire format both vendors share, and nothing else
app/src-tauri/src/pilot/event.rs    PilotEvent and Usage - every count an Option, on purpose
app/scripts/         contrast.mjs, stage-sidecar.mjs, make-icon.mjs, prune-appimage.mjs, app-build.mjs - all dependency-free
app/scripts/smoke-appimage.sh  launching the AppImage on six distributions, and failing on a blank screen

docs/                the docs site - VitePress, its own package.json, never in `files`
docs/.vitepress/config.mts  the site's config: BASE (the one place the path is written), sidebar, search
docs/phone.md        installing the phone apps without a store, pairing them, and building them from source
docs/images/         screenshots, shared by README.md and the site
docs/plans/          internal design notes, excluded from the site
.github/workflows/pages.yml    builds docs/ from main and deploys it to Pages
.github/workflows/ci.yml       the core, app and Rust gates on push and PR into main, and by hand
.github/workflows/mobile.yml   the phone app's tests and its emulator and simulator launches, on PR into main and v* tags
.github/workflows/release.yml  the desktop bundles and the phone apps on a v* tag, into one draft release
.github/actions/linux-deps/    the Linux packages a Tauri build needs, listed once
```
