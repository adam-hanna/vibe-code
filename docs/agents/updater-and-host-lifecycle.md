# The updater, and how a host lives and dies

Part of the working notes for this repo; [AGENTS.md](../../AGENTS.md) is the core and links here.
Moved out of AGENTS.md word for word on 2026-10-20, so where a note says *this file* it means
AGENTS.md and these companions together. Read this before changing the code it describes, and
update it in the same PR when that code changes.

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
- **An AppImage installs only over a file that is there** (#390). The plugin's AppImage
  installer overwrites `$APPIMAGE` and starts by reading that path's metadata, so an app whose
  file was deleted after launch - started from a worktree's `target/release/bundle/appimage/`,
  and the worktree pruned while it ran; Linux keeps the open file alive, so nothing else looks
  wrong - downloaded the whole bundle, stopped every host, and failed with a bare `No such file
  or directory (os error 2)`. `action_for` now decides on the file, not the variable:
  `appimage_file` reads `$APPIMAGE` through two probes (a regular file; its folder writable by
  `access(W_OK)`, since the plugin renames the old file aside and writes the new one there) and
  anything but `Ready` gets **Download**. That holds for a patched AppImage binary without
  `APPIMAGE` too, because the plugin then falls back to `current_exe()`, inside the read-only
  mount. `update_install` asks before the download and **again after it, before any host is
  stopped**, since a download takes minutes. A refusal, and an `install()` failure when the file
  has since gone, is a sentence naming the path and saying to download from the release page and
  put it somewhere permanent; the raw error goes to the log, and a check that offers Download
  for this reason says why there too. The window's popover is unchanged: it draws Download.
- **Rust decides whether to ask, by `has_run_hosts()`.** With runs going, `update_install`
  answers `confirm` before downloading or stopping anything - a host set it cannot read counts
  as runs going - and the window draws the quit confirmation's shape and words, listing its
  runs or saying that runs are still going, and calls again only on a press. This is stricter
  than Quit, which skips a host whose run already returned; asking once too often is the safe
  side. **And no run can start once an install is under way.** The question is asked
  by `freeze_runs`, which in the same step under the host lock makes `spawn` refuse every new
  run host until the restart (or until the update gives up, which thaws it). Asked once at
  the press, a run started during a ten-minute download would have been stopped by the
  install with nobody asked about it. `claim` takes the install slot **before** it freezes,
  so a second press is refused before touching the freeze: when each press froze first, the
  losing one thawed on its way out and lifted the freeze the first install's download relied on.
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
