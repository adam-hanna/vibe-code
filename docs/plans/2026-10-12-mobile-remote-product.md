# vibe on your phone: product spec

Drafted 2026-10-12 for #338. The engineering design follows in #340.

## What it is

iOS and Android apps that control the vibe desktop app running on your own computers,
the way the Claude and ChatGPT apps can drive a session on a desktop. The phone runs
nothing: no agent, no host, no run. Every run, every file and every key stays on the
desktop, and the phone is a remote control for it.

A phone can be paired with several desktops, and a desktop with several phones. Each
desktop stays reachable across reboots and new IP addresses, as long as the desktop
app is running.

## Decided

These were settled before the spec was written. The spec builds on them and does not
reopen them.

- **Transport is iroh.** The phone dials a desktop by its public key over QUIC. iroh
  connects directly when hole punching works and falls back to a relay when it does
  not. To start with, discovery and relays are n0's public ones, and we run nothing.
  Everything is end-to-end encrypted, so a relay only ever sees ciphertext.
- **Addressing is by key, never by IP.** A reboot, a new DHCP lease or a move to
  another network changes nothing the phone has stored.
- **The phone is a thin client.** It draws what a desktop sends it and sends back what
  the person pressed. It holds no run state of its own beyond what it needs to draw.
- **Full parity.** Anything the desktop window can do, the phone can do. That
  includes settings, prompts, API keys and deleting runs. The few exceptions are
  things that only make sense on a particular screen, listed under
  [Parity](#parity).
- **Many to many.** Any number of phones per desktop, and any number of desktops per
  phone. Each pairing can be revoked from either end.
- **Notifications are local only in 1.7.0.** A phone notifies only while the app is
  still alive in the background. Push notifications, which reach a locked phone at
  any time, are a follow-up.
- **Distribution in 1.7.0 is TestFlight and a signed APK.** Store listings and desktop
  code signing are follow-ups.
- **The desktop app must be running.** It starts at login. A computer that has
  rebooted with nobody logged in, or one that is asleep, cannot be reached, and the
  phone says which.

## Parity

The phone draws the same cockpit from the same frames, laid out for one column. These
all work from the phone exactly as they do on the desktop:

- Projects and their runs, pins, renames and the attention badges.
- Starting a run through the pilot, and resuming, implementing and forking one.
- A live run: the loop column, the running card, output, spend and the footer.
- Gates: continue, stop, answer the questions, pause, cancel a pause, and stop a turn
  in flight. The confirmations are the same, worded the same way.
- Every artifact pane: plans, critiques, reviews, code, questions, verify and output.
- The pilot: conversation, the composer, proposal cards, compact and clear.
- Commands: following output, stopping a command.
- Settings, both the settings for all projects and a project's own, including
  prompts, standing instructions, gates, caps, budgets, models and the pilot's
  access settings (YOLO, allowed directories, the safe list).
- API keys: storing and forgetting them. A key typed on the phone goes into the
  **desktop's** keychain and, as on the desktop, can never be read back by any
  window.
- Deleting a run, removing or moving a project.
- The update tool: checking for a new version, and installing it on the desktop.

What the window remembers (pins, names, drafts, conversations, where it was pointed)
is the desktop's, so a phone and the desktop window see the same pins and the same
conversations. Only appearance (the type scale and the theme) belongs to each screen.

### What does not carry over, and what replaces it

| On the desktop | On the phone |
|---|---|
| Adding a project with the OS folder picker | A folder browser over the desktop's disk, rooted where the pilot's `fs` read is rooted |
| Opening a link in the desktop's browser (the Download button, the release page) | Opens on the phone |
| The tray, Quit and closing the window | Not drawn. Quitting the desktop app is in the desktop's settings on the phone, behind a confirmation that says the phone cannot reconnect until somebody starts it again |
| Keyboard shortcuts and the command palette | Not drawn |
| The type-scale slider | The phone's own appearance setting |

### Things that cut the phone off

Two controls can leave the phone with no way back: **turning remote access off**, and
**quitting the desktop app**. Both are allowed, because that is what full parity
means, and both confirm with a sentence saying that the only way back is at the
desktop. Revoking *this* phone from its own settings is the same as unpairing it.

## Pairing

- **Remote access is off by default.** With it off, the desktop has no iroh endpoint,
  publishes no address record and holds no relay connection.
- **To pair**, open Settings → Remote access on the desktop and press *Pair a phone*.
  It shows a QR code that expires after five minutes and works once. The phone scans
  it, the desktop shows the phone's name and asks *Allow this phone?*, and pairing
  finishes on yes. The confirmation on the desktop is what stops a photographed QR
  code from being enough by itself.
- **On the desktop**, Settings → Remote access lists every paired phone: its name,
  when it paired, when it was last connected, and whether it is connected now, with a
  revoke button. Revoking drops a connected phone at once.
- **On the phone**, the desktops list shows each desktop by name (the computer's name
  to start with, renamable on the phone), whether it is reachable, and when it was
  last seen, with an unpair action.
- A desktop that is reinstalled, or whose keychain is reset, has a new key and has to
  be paired again. The phone shows the old entry as *no longer recognised by this
  desktop* rather than as offline.

## Locking the phone app

Full parity means a paired phone is as powerful as sitting at the desktop's keyboard,
including spending money and running commands. So the phone app is locked:

- **Face ID, Touch ID or the device's fingerprint or PIN** to open the app, and again
  after it has been in the background for five minutes. On by default; the phone's
  own settings can turn it off, with a sentence saying what that exposes.
- **Asked again**, whatever the timeout, before storing an API key, turning YOLO on,
  deleting a run, and pairing or unpairing.
- A phone with no device lock set up can still pair, but the phone app says plainly
  that anybody holding the phone can control the desktop.

## Several desktops, several phones

- **The desktops list is the phone's home screen.** Each row shows reachability and,
  while the app is open, an attention badge when one of that desktop's runs holds a
  gate or needs input. Tapping a row opens that desktop's projects.
- **Several clients at once.** The desktop window and any number of phones can be on
  the same desktop at the same moment, and all of them draw the same live runs.
- **The first answer to a gate wins.** The others see the gate close, with who
  answered it and where: *Continued from Adam's iPhone*, or *from this desktop*. The
  same attribution appears on the desktop when a phone answers.
- **A phone is visible on the desktop.** While any phone is connected, the desktop's
  title bar has a chip naming it, and the diagnostics popover lists every connected
  phone.

## Staying reachable

- **Start at login.** Turning remote access on offers to start the desktop app at
  login, to the tray. It is its own switch, so somebody can have one without the
  other.
- **Reboots and new IP addresses** need nothing from the person. Once the desktop app
  is up after a login, a phone reaches it again within seconds.
- **Network changes on either side** (Wi-Fi to cellular, a different Wi-Fi) keep the
  connection, or reconnect it without anybody pressing anything.
- **Keep awake.** Optional and off by default: stop the desktop from sleeping while a
  run is going, so a phone can still reach it mid-run.

### What the phone says when it cannot connect

Each case gets its own sentence, because each one is fixed differently:

| Case | The phone says |
|---|---|
| The phone has no network | *This phone is offline.* |
| The desktop has not been seen since it went quiet | *Can't reach `<desktop>`. It may be off, asleep or not logged in, or vibe isn't running. Last seen `<time>`.* |
| Remote access was turned off on the desktop | *Remote access is off on `<desktop>`. Turn it on in Settings → Remote access.* (when the desktop said so before going) |
| The relays cannot be reached, but the network can | *Can't reach the relay servers. Connections on the same network still work.* |
| This phone was revoked | *`<desktop>` removed this phone.* With *Pair again*. |
| The desktop has a new key | *`<desktop>` no longer recognises this phone. It was reset or reinstalled.* With *Pair again*. |
| The desktop's vibe is a version the phone can't talk to | *`<desktop>` is running vibe `<v>`, which this app can't control. Update `<the older one>`.* |

A connection that is relayed rather than direct is not an error and is not drawn as
one. It appears only in diagnostics.

## Notifications in 1.7.0

Local notifications only. While the phone app is still running in the background, it
notifies when a run holds a gate, needs input, finishes or fails, and when a pilot
turn finishes. iOS suspends a backgrounded app within minutes, after which nothing
arrives until the app is opened again. The phone's settings say so in those words,
beside the switch, so nobody relies on it overnight.

Push notifications, which reach a locked phone at any time, need a sender holding the
APNs and FCM keys and are a follow-up outside 1.7.0 (#350).

## Screens

For #347. Each is one column at phone width, in light and dark.

1. **Desktops**, the home screen: paired desktops with reachability, last seen and
   attention badges; *Pair a desktop*.
2. **Pair**: the camera, then *waiting for the desktop to allow this phone*, then done.
3. **Desktop**: its projects, each with its runs, pins and badges, as in the sidebar;
   a ＋ to start a run through the pilot; the desktop's name and connection state at
   the top.
4. **Run**: the loop column as the main view, with the running card and the footer
   pinned to the bottom. The artifact panes as tabs across the top: Plans, Plan
   critique, Code review, Code, Questions, Verify, Output.
5. **Gate**: a sheet over the run with the question, its evidence and the choices,
   using the desktop's confirmations.
6. **Pilot**: the conversation with the composer at the bottom, proposal cards and
   the thinking indicator.
7. **Commands**: the list, and one command's output followed live.
8. **Settings for the desktop**: the desktop's two kinds of settings (all projects,
   and this project), the keys, remote access, and quitting the desktop app.
9. **Folder browser**: for adding or moving a project.
10. **Phone settings**: app lock, notifications, appearance, and the paired desktops.
11. **Diagnostics**: per desktop, the connection (direct or relayed), the desktop's
    version and build, and the host facts the desktop's diagnostics popover shows.

The cockpit's rules still hold at this size: no invented numbers, a missing
measurement drawn as absent with its reason, exactly one element pulsing, and no issue
numbers on screen.

## What the desktop gains

- **Settings → Remote access**, in the settings for all projects: the switch, start
  at login, keep awake, *Pair a phone*, and the paired phones with revoke. It is the
  machine's setting, so a project's `vibe.config.json` cannot turn it on.
- **The connected-phone chip** in the title bar, and the phones in diagnostics.
- **Attribution** on gates, on the start of a run, and on settings saved from a phone.
- **Nothing at all while remote access is off.**

## Out of 1.7.0

Each of these has its own follow-up issue outside the milestone:

- **Push notifications** to a locked phone (#350).
- **App Store and Play Store listings** (#351).
- **Code signing for the desktop on macOS and Windows**, so the app installs without
  security warnings and without `xattr -cr` (#352).

Also out, with no issue yet:

- Waking a sleeping desktop, or reaching one that rebooted with nobody logged in.
- A tablet layout. The phone layout runs on a tablet, stretched.
- Running anything on the phone.

## Questions for the engineering design

Product questions this spec leaves to #340, because the answer depends on
measurements:

- Whether n0's public relays and DNS server may carry a shipped app's traffic, and if
  not, what running our own costs. If we have to run one, that reverses "nothing we
  run" and comes back here.
- What the published address record reveals, and whether it can be limited to the
  relay URL so a desktop's IP address is never published.
- How the phone and the desktop agree on a protocol version, so the version-mismatch
  sentence above can be accurate.
