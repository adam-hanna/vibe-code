# The pilot

Part of the working notes for this repo; [AGENTS.md](../../AGENTS.md) is the core and links here.
Moved out of AGENTS.md word for word on 2026-10-20, so where a note says *this file* it means
AGENTS.md and these companions together. Read this before changing the code it describes, and
update it in the same PR when that code changes.

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


**The pilot's keys live in the OS keychain, and the webview can never read one.** Three
commands exist — store, forget, ask whether one is present — and the absence of a fourth is
the design: `keys::read` is `pub(crate)`, called by Rust, unreachable from the window, so the
key never crosses the IPC boundary. The CSP agrees from the other side, since `connect-src
'self' ipc: http://ipc.localhost` means the page could not reach a vendor even holding one.
Not `vibe.config.json`: that is a project file meant to be committed, and `validateConfig`
reports bad values *by name*, which is the one thing that must never happen to a secret.

**The device key is a third keychain entry, and no command reaches it** (#341). One ed25519
secret per install, under the same service as the vendor keys and the account
`remote-identity`; its public half is the endpoint id a phone dials. No command reads it,
deletes it or names it - `remote_status` reports the public id only - and its reader,
`remote::identity::read`, is `pub(crate)` like `keys::read`. `key_set`, `key_clear` and
`key_status` refuse it, because `Provider` is still the two vendors. **A keychain that cannot
be read refuses pairing rather than making a new key**: a new key is a new endpoint id, and
would silently orphan every paired phone. `keys.test.ts` pins all of it.

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

**The pilot names the run's branch, on the card** (#356). `start_run` takes an optional
`branch`, which `launchArgv` sends as `--branch <name>`, so the name is in the argv the card
draws and in its summary line (*"…, on branch fix/x"*). The prompt asks for a short,
descriptive name on every proposal, a naming rule from the person's instructions where there
is one, and a fresh proposal when the person asks for another name. vibe enforces no
convention: the tool refuses only shapes git would refuse (`branchShapeRefusal`, a cheap
abridgement), and the core's `git check-ref-format` and its refusal of an existing branch are
the authority. The rejected alternative - the planner naming it and vibe renaming the branch at
plan approval - is recorded in `docs/plans/2026-10-21-branch-naming-design.md`.

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
which fetches one public file and, when a person asks, the bundle it names. A third piece is
coming, and it is the first **inbound** one: the iroh endpoint a phone dials
(`src-tauri/src/remote/endpoint.rs`, #342). It starts only while the switch in `remote.json`
is on (#344), and only once a device key exists; with it off, or with a file that cannot be
read, nothing binds and nothing is published. Its rules are in the phone section above. The core keeps
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
