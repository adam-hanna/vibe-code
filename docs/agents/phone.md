# The phone

Part of the working notes for this repo; [AGENTS.md](../../AGENTS.md) is the core and links here.
Moved out of AGENTS.md word for word on 2026-10-20, so where a note says *this file* it means
AGENTS.md and these companions together. Read this before changing the code it describes, and
update it in the same PR when that code changes.

**A phone is another window, over iroh, and it is being built in 1.7.0** (#338–#349). The
design is `docs/plans/2026-10-12-mobile-remote-engineering.md`, the product decisions are
its sibling `-product.md`, and the measurements are on #339. Until the code lands, these
are the rules the code is held to:

- **The phone's webview is `app/src`, and its `invoke` and `listen` go over the
  connection** to the same Tauri command functions the desktop window calls. The cockpit
  never knows which side it is on, so there is one cockpit, not two. Only the modules a
  phone cannot run are swapped, under `vite build --mode mobile` (#345).
- **Full parity, and the list is still closed.** A phone may call every command the
  window may, and the allowed list in `app/remote/` is pinned against `generate_handler!`,
  so a new command is a decision about remote access made on purpose.
- **Addressed by key, never by IP.** The published record is relay-only (iroh's default
  `AddrFilter::relay_only`, checked against the live record), so no desktop's IP address
  is ever published.
- **Every client has its own range of request ids**, handed out per connection, because
  every client sees every answer. Gate ids stay shared, and the first answer wins.
- **A phone's frames are stamped by the desktop**: the bridge overwrites `origin` with
  the paired phone's name, so a phone cannot claim to be the desktop. It is the one field
  the bridge writes.
- **Remote access off means nothing at all**: no endpoint, no relay connection, no
  published record, no listening socket. Its settings are a Rust-owned file, not vibe's
  config, because Rust reads them before any window exists and no project file may reach
  them.

**The bridge is `app/src-tauri/src/remote/bridge.rs`, and the hub beside it is the one seam
every event leaves through** (#343). The wire is `app/remote/src/control.rs`. The design
named `app.listen_any` for the fan-out, and it was not used: in Tauri 2.11 a Rust listener
is not called in emit order (a contended emit is parked in a pending queue and drained
after a later one), so a phone could fold one host's frames in another order than the
window. So every emit goes through `remote::hub`, which keeps a run host's frame, queues it
for every phone and emits it to the window **under one lock**. Four things travel with it:

- **The live-run buffer is one list in emission order**, not one per host, so a phone that
  joins mid-run replays cross-host order too. It always runs, whether or not remote access
  is on, and a host's frames go when its exit is emitted, which is after the reap.
- **A run start is stamped as well as a `host_send`**, because since #246 the invoke
  travels as `host_start`'s `line`.
- **A revoke or an `Unpair` aborts every task the bridge started for that connection.**
  Work a call had already started (a run, a pilot turn) goes on, exactly as when the window
  that started it goes away.
- **`remote://pair-ended` is forwarded beside `remote://pair-request`**, though the issue's
  event list named only the second: it is what closes the *Allow?* prompt, so without it a
  phone's copy would stay up after the desktop answered. A test fails on any event name the
  desktop's sources emit that is neither in `REMOTE_EVENTS` nor in `DESKTOP_ONLY_EVENTS`.
- **An Unpair ends the phone's access at once**: nothing read after it runs, and a call read
  after the connection was closed is dropped. A control stream that cannot be written closes
  the connection.

**The switch is `remote.json`, and `remote_set` is the one command that changes it** (#344).
The file sits beside the paired list (`remote/settings.rs`): `enabled`, `startAtLogin`,
`keepAwake` and `relay`. Rust reads it in `setup`, before any window or host exists. A missing
file is the defaults. A file that cannot be read is **off, with the sentence**, and is never
overwritten, which is `store.rs`'s rule. No key of it is in vibe's config. Six things travel
with it:

- **One reconcile, under one async lock.** `reconcile_locked` makes the endpoint match the
  settings. It stops an old endpoint **completely** before it binds a new one, so a relay
  change never leaves two. Off turns `NoKey` and `Failed` into `Off` as well as stopping an
  endpoint that is up. The window's `remote_set` answers once that has happened. **Every
  `remote_set` writes its patch under that lock** (`patch_locked`), so a patch and the change
  it decides are one step: written before the lock, a phone's *off* could be acted on by the
  window's reconcile first, closing the phone before its answer.
- **A phone's closing change answers first.** Turning access off from a phone closes that
  phone's own connection. So the phone's call takes the lock before it answers. It answers
  with the decided state. The stop then waits on `Written` until the peer has acknowledged
  the answer, or the connection closed, or 3s passed. Nothing else can stop or start the
  endpoint in between.
- **The connection's own guard is the only source of `remote://connections`.** `Announced`
  is held across the bridge for a paired phone, so a connect and a disconnect are each one
  event, however the connection ends. Nothing emits after a stop. The event carries
  nothing. A client listens first, then reads `remote_status`, and again on each event, drawing only
  the newest read (`followStatus` in the window). No
  timer polls.
- **Start at login is a plugin behind a trait.** `autostart.rs` holds the plugin behind a
  trait, and no test reaches the plugin. The plugin launches the app with `--autostart`.
  `main` is `visible: false`, and `shows_window(argv)` is the one rule `setup` and the
  single-instance callback apply. Without the argument the window is shown. The switch
  shows what the OS says, not what the file says. The plugin is pinned to 2.5, because 2.6
  needs tauri 2.12. 2.5.1 already points the Linux entry at `$APPIMAGE`.
- **Keep awake is decided under the host lock and done on its own thread.**
  `HostProcess::decide_awake` runs where `spawn` inserts and where `reap` and `stop` remove.
  It sends `Take` or `Release` to `awake.rs`'s thread, which owns the `keepawake` guard. It
  holds idle and system sleep, never the display. A stalled D-Bus never blocks a spawn, and
  a failed take is a log line and a sentence. It never stops a run.
- **Attribution in the window is gates only, and only a phone.** `reduce` folds
  `gate_released`/`gate_stopped`'s `origin` into `Run.decidedFrom`. The footer then says
  *Continued from* or *Stopped from* the phone. `remote/origin.ts` is the app's one spelling
  of `phone:`, and a test reads it out of `bridge.rs`.

**The phone app is `app/mobile/`, and it is a client only** (#345). Its own Tauri crate
and `package.json`, built from the same `app/src`; no Node host, no agent CLI, nothing
that runs a turn. Four things carry it:

- **One seam, `app/src/transport.ts`.** Every module that reaches Rust imports `invoke`
  and `listen` from it. The phone build swaps in `transport.mobile.ts`, which wraps each
  desktop command as a `remote_call` naming it; events are re-emitted by the phone's Rust
  under the desktop's own names, so `listen` is unchanged. The phone checks nothing
  against an allowed list: the desktop's is the one that decides. `local` reaches the
  phone's own commands (`phone_identity`, `phone_open_release_page`).
- **The swaps are a list, `app/mobile-swaps.ts`**: the transport, the folder chooser
  (`pick.mobile.tsx` browses the desktop over the `fs` frame, inside the pilot's roots),
  `surface.ts` (no keyboard chords, no palette), and `boot.tsx` (the paired desktops and
  the lock in front of the cockpit, #346). `mobile.test.ts` fails on a
  `*.mobile.ts` the list does not name, and on a swap missing an export of what it
  replaces.
- **The phone's key follows the desktop's rules**, which moved into
  `vibe_remote::identity`: made only when the store says there is none, never written
  over one it could not read. Android keeps it encrypted by a Keystore AES key; iOS in
  the Keychain, `AfterFirstUnlockThisDeviceOnly`, so it is in no backup.
- **A mock desktop is how the cockpit is seen on a simulator.** `--features
  mock-desktop` answers from `src-tauri/fixtures/desktop.json`, which
  `scripts/record-mock-desktop.mjs` records from the real host over a run the loop
  harness makes with fake agents. Re-record after a protocol change. No release build
  turns it on.

```bash
cd app/mobile && npm install
npm run test:rust                                          # the phone crate's tests
npx tauri android init --ci                                # gen/android - generated, not committed
npx tauri android build --apk --target aarch64 --debug --features mock-desktop
node scripts/record-mock-desktop.mjs                       # after `npm run build` at the root
```

Gradle 8.14 does not run on JDK 25, so point `JAVA_HOME` at a 21. On iOS, iroh's network
watcher and DNS resolver need Apple's SystemConfiguration framework, which Tauri's generated
Xcode project does not link unless `bundle.iOS.frameworks` names it: without it the link
fails on fifty `_SC*` symbols. `gen/` is generated
by `tauri <platform> init` on each machine and in CI, because iOS's needs macOS to make.
`.github/workflows/mobile.yml` launches both mock builds - an Android emulator and an iOS
simulator - and fails unless the cockpit read the recorded run. It runs on a pull request into
`main`, on every `v*` tag, or by hand with `gh workflow run mobile.yml --ref <branch>`, never on
`develop`.

**The phone pairs, connects and reconnects through `vibe_remote::client`** (#346). It is in the
shared crate, so the desktop crate's tests run the **real** pairing handler and bridge against
the **real** client in one process: they are child modules of `handshake.rs`'s and `bridge.rs`'s
private `mod tests` (`mod tests { mod client }`), because a sibling file cannot reach those
helpers, and `vibe-remote` has no tokio runtime of its own to test with. A phone finds a test
desktop by id through iroh's in-memory lookup (`phone_finding`), the stand-in for n0 and mDNS.
The phone's `Desktop` is `app/mobile/src-tauri/src/link.rs`, a thin wrapper over it. Ten things
travel with it:

- **`REMOTE_OFF` (3) is the one desktop change.** Both roads to *off* close every bridged phone
  with it before the endpoint stops: the window's at once, a phone's own `remote_set` only after
  its `Return` has arrived (`Written` names the asker, which is closed first, by id). A relay
  change closes with no code, since the endpoint comes straight back under the same id.
- **Every ending has a sentence, and there is no "dropped".** The three codes read as themselves;
  anything else - code 0, an unknown code, a dial nobody answered - goes through `classify`, which
  reads what the phone can see at that moment. `online` is the OS's word, sent by the webview from
  `navigator.onLine`, **never** `Endpoint::addr`, which is what the phone advertises.
  `RelaysUnreachable` needs a path that was not direct, the desktop's relay known and one of the
  phone's own, and that relay (or every relay) failed; everything else is `Unreachable`. A desktop
  on a relay of its own may be off or its relay may be down, and nothing the phone can observe
  separates the two, so *can't reach* is the honest sentence for both.
- **One dial for every caller**: the stored relay hint under `Timeouts::hint`, then the id alone
  through lookup under a budget of its own. Connect and probe use `dial`, unpair `unpair_dial`,
  and **pairing none**: the desktop bounds an attempt by its code's own life, and a second, shorter
  clock on the phone would end one the desktop still meant to finish. The timeouts are injected,
  so no test needs tokio's `test-util`. Every interval is a named choice in `client.rs`, and none
  is a measurement; the device checks on #346 are what will say whether they were right.
- **Pairing is two steps so the code can be shown between them.** `pair` reads the phone's list
  first (an unreadable one dials nothing and burns no code), sends the secret and returns a
  `Challenged` once the desktop's *Allow?* is up; `phone://pair-code` carries the six digits with
  the screen's own `attempt` number. Then `read_result` and `commit`, split so **an answer the phone
  has already read beats Back** (`pair_flow`'s biased select): the desktop stores a phone before it
  sends `Paired`, so dropping a `Paired` in hand would leave the desktop paired and the phone not.
  The window that remains - the answer in flight as Back hangs up - needs the desktop to wait for
  an acknowledgement, which is a desktop change #346 did not make; the cancel sentence says how to
  recover. A yes the phone cannot save is `PairedNotSaved`, and says so even after Back.
- **The replay barrier.** The desktop replays every live run's frames to a phone on every new
  connection. Each connection has a generation; its events wait in an `EventGate` from the
  `Welcome` until the webview says it is ready for that generation (`phone_release`), and
  `phone://connected` carries the generation and nothing else. The webview pauses its requests
  (`pauseRequests`: they reject, never throw), starts each live run again from its `base`
  (`rejoin` in `hosts.ts`; a resume's base is its seeded history), counts ids from the new range
  through a **monotonic** resync (`phone/link.ts`), releases, and settles once `host_status` says
  which hosts are alive (`settleRejoin`). Nothing marks the end of a replay - that would be a
  second desktop change - and a refolded turn's times are its arrival times, as for any phone
  joining mid-run.
- **The reconnect loop** checks the desktop is still paired and still the one open before every
  dial, re-reads its entry each time, and waits `retry_after`'s backoff cut short by a poke. **Every
  network signal pokes**, whether or not `online` moved (a Wi-Fi to cellular handover is online
  both sides), and calls `endpoint.network_change()`; so does every return to the foreground. A
  close the desktop explained (`NOT_PAIRED`, `VERSION_MISMATCH`, `REMOTE_OFF`) waits for a poke only.
- **The phone's list is a file its Rust owns** (`vibe_remote::paired`), written by temporary file
  and rename, every read-modify-write under one lock, and never overwritten when it cannot be read.
  `seen` and `set_relay` never bring back a desktop an unpair removed while a probe was out.
- **The app opens locked** when its lock is on and the device has, or may have, a screen lock, and
  when `phone.json` cannot be read; the Rust guard refuses every desktop command until
  `phone_unlock`, `phone_session` and `phone_release` included, and refuses a settings write, so a
  webview under the cover cannot turn the lock off for the next launch. A reconnect while locked is
  kept by the link and held at its gate; the webview's `lockGate` makes both reads wait for the
  unlock, and the cockpit stays mounted under the cover so the runs it folded are not lost.
  Leaving the pairing screen, by Back or by the lock, ends the attempt: a scan that resolves
  late pairs nothing, and `phone_pair_cancel` names its attempt, so a Back that reaches Rust
  before `phone_pair` is waiting is kept (`PairSlot`) and the dial never happens. Only the plugin's explicit `passcodeNotSet` is *no lock*: biometrics being
  unavailable is not, because a PIN is still a lock. The mock build opens unlocked, since no CI
  emulator can answer a prompt. `confirmOnDevice` is the transport seam's fourth function: the
  cockpit asks before storing a key, turning YOLO on, deleting a run and pairing or unpairing, and
  the phone's Rust never reads a frame to decide.
- **Plugins are driven from Rust** - biometric, notification - **except the barcode scanner**,
  which has no Rust API. `capabilities/scan.json` grants its four permissions on phones only, and
  `Pair.tsx` is the one module that imports it; `mobile.test.ts` pins both.
- **Notifications are on by default, so the OS is asked at the first `phone_settings` of a
  launch** (and when the switch is turned on), never from `phone_notify`, which shows a
  notification only once the OS has granted it. The mock build does not ask.
- **Notifications are offered off frames the cockpit already folds** (`cockpit/notices.ts`), by
  type and id after `invokeOutcome`, once per key, and fired by the phone's Rust only while the app
  is hidden with notifications on - and only while it is alive. An ask held and released during a
  disconnect is announced once on reconnect; a run whose host ended during one is drawn lost and
  is not announced.

The measurements the device checks read are in the phone's log: `vibe-mobile: connected to <id>
in <ms> ms`, `vibe-mobile: path to <id> is now direct|relayed after <ms> ms`, and `vibe-mobile:
connection to <id> closed: <raw>`. `phone_desktops` carries the path and the connect time too.
