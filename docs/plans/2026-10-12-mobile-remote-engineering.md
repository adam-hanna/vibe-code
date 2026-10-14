# vibe on your phone: engineering design

Drafted 2026-10-12 for #340. It builds on the [product spec](2026-10-12-mobile-remote-product.md)
(#338) and the iroh spike's measurements (#339).

## The shape in one paragraph

The phone runs the same React webview as the desktop. Its `invoke` and `listen`
calls go to the phone's own Rust side, which carries them over an iroh connection
to the desktop. There they call **the same Tauri command functions** the desktop
window calls, and every event the desktop emits to its window is also sent to each
connected phone. Nothing in `app/src/host.ts` or the cockpit knows which side it is
on. The Node hosts, the core and the frame protocol do not change, with one
exception: a write made by one client is announced to the others (see
[Several clients](#several-clients)).

```
phone webview ──invoke/listen──▶ phone Rust ══ iroh (QUIC, E2E) ══▶ desktop Rust ──▶ hosts (Node)
                                                                      ▲
desktop webview ──invoke/listen───────────────────────────────────────┘
```

## Rules this keeps

These are AGENTS.md's, restated for this surface:

- **All network code lives in `app/`, in Rust.** `src/` gains no network code. The
  desktop gets its third network client and its first **inbound** one.
- **The webview has no network.** The CSP does not move on either app. iroh runs in
  Rust on both ends.
- **Rust relays and does not decide.** The bridge carries commands and events. Rust
  already reads one field off an inbound line, an invoke's `id`, so it can close a
  run host on its `result`. The bridge adds two: the command name (to check it
  against the allowed list) and, for frames, the field described under
  [Attribution](#attribution).
- **A key never crosses into a webview.** The device keys get the treatment the
  pilot's API keys have: stored by Rust, never readable by any window. An API key
  typed on the phone travels phone Rust → desktop Rust → desktop keychain, and no
  command returns it.

## Where the code lives

| Path | What |
|---|---|
| `app/remote/` | A Rust crate shared by both apps: the wire types, pairing, the allowed-command list, and the iroh endpoint setup. A path dependency of both apps, so neither copies it. Not a workspace member, as first written here: a workspace at `app/` would move the desktop's `target/` to `app/target`, and `release.yml` names the old path (#345) |
| `app/src-tauri/src/remote/` | The desktop's side: the accepting endpoint, the bridge into the existing commands, the paired-phones store, and the remote-access settings |
| `app/mobile/` | The mobile app: its own Tauri 2 crate (`app/mobile/src-tauri`) and `package.json`, built from the same `app/src` with `VITE_TARGET=mobile` |

The mobile app is a **separate Tauri crate** rather than a mobile target of the
desktop crate, because nearly everything the desktop crate does is absent on a
phone: spawning hosts, the Node sidecar (`externalBin`), the tray, the updater, the
reaper and single-instance. Building those out with `cfg` would put the two
products' rules in one file.

`VITE_TARGET=mobile` swaps exactly the modules listed under
[Desktop-only pieces](#desktop-only-pieces) and adds the phone's own screens
(desktops list, pairing, phone settings). `copy.test.ts`, `audit:contrast` and
every cockpit test run against the same source.

## Identity

- **Each install has one iroh secret key** (ed25519). Its public half is the
  endpoint id, which is the address a phone dials.
- **On the desktop** the key is generated the first time remote access is turned
  on and stored in the OS keychain under its own entry, `remote-identity`. No
  command reads it, deletes it or names it. `keys.test.ts` pins that: the window's
  `key_*` commands still refuse anything but the two vendor providers.
- **On the phone** the key is wrapped by a key held in the Android Keystore or the
  iOS Keychain, because neither store hands out raw ed25519 bytes and iroh needs
  them. The wrapped key lives in the app's private storage.
- **A reinstall that keeps the keychain keeps the endpoint id.** A reset keychain
  means a new id. See [the spec correction](#corrections-to-the-product-spec) on
  what a phone can tell in that case.

## Discovery and relays

Decided on #340 after the spike:

- **n0's preset**: pkarr publishing to `dns.iroh.link` and DNS lookup, with n0's
  public relays. The publisher keeps its default `AddrFilter::relay_only`, so the
  public record carries the relay URL and **no IP address**. The spike checked
  this against the live record.
- **mDNS** (`iroh-mdns-address-lookup`) as a second lookup, so a phone on the same
  network connects with no internet at all. The spike measured 0.175s with no
  relay.
- **The user's own relay**: a setting naming one relay URL (a self-hosted
  `iroh-relay`). When it is set it replaces n0's relays and is published in the
  record, so phones find it with no change on their side.
- **When n0's relays rate-limit or are down**, a direct connection that is already
  established keeps working, because the relay only carried its setup. New
  connections between networks fail, and the phone says *Can't reach the relay
  servers* (the spec's sentence). The diagnostics name the relay in use.

Every connection starts through a relay and then hole-punches to direct. The spike
saw the switch about 0.2s after connecting.

## Protocols on the connection

Two ALPNs:

| ALPN | Who may open it | What for |
|---|---|---|
| `vibe/pair/1` | anyone holding a live pairing code | the pairing handshake, then closed |
| `vibe/remote/1` | paired endpoint ids only | everything else |

An endpoint id not on the paired list is refused on `vibe/remote/1` **before any
stream is read**, with close code `NOT_PAIRED`. That code is what lets the phone
say *`<desktop>` removed this phone* rather than *can't reach*.

On `vibe/remote/1`, the phone opens **one control stream** at connect. Messages are
length-prefixed JSON:

```text
phone → desktop   Hello   { remoteProtocol, appVersion, phoneName }
desktop → phone   Welcome { remoteProtocol, appVersion, desktopName, idBase }
                  or a close with VERSION_MISMATCH carrying both versions
phone → desktop   Call    { call, command, args }        an invoke
desktop → phone   Return  { call, ok | err }             its answer
desktop → phone   Event   { name, payload }              an emit
```

- **`remoteProtocol`** is a single integer in `app/remote/`. It changes when this
  wire changes *or* when the host frame protocol (`PROTOCOL_VERSION`) changes,
  since the phone's webview folds the desktop's frames. A mismatch closes the
  connection with both app versions, which is the spec's version sentence.
- **Calls are concurrent.** Each carries an id and its `Return` names it, so a slow
  `pilot_models` does not hold up a `host_send`.
- **Events are ordered**, on the one stream, in the order the desktop emitted them.

## The remote surface

Full parity, so the allowed list is the window's own list. It still exists as a
constant in `app/remote/`, and a test fails when a command is added to the desktop's
`generate_handler!` without a decision about remote access.

| Command | From a phone |
|---|---|
| `host_start`, `host_send`, `host_status` | allowed, as is |
| `key_set`, `key_clear`, `key_status` | allowed. `key_set` writes the desktop's keychain; nothing reads it back |
| `pilot_send`, `pilot_cancel`, `pilot_models` | allowed |
| `update_check`, `update_install` | allowed. `update_install`'s `Opened` outcome becomes `OpenOnPhone`, carrying the release page's constant URL, and the phone opens it |
| `app_quit` | allowed, with the spec's confirmation on the phone |
| `remote_*` (below) | allowed, including turning remote access off and revoking |

| Event | To phones |
|---|---|
| `host://frame`, `host://log`, `host://exit` | yes |
| `pilot://event` | yes |
| `app://update-progress` | yes |
| `app://quit-requested` | **no**. It is the desktop tray asking the desktop window |
| `remote://pair-request` | yes, because `remote_pair_answer` is allowed. Never to the phone being paired, which is not on the list yet |

### New desktop commands

All in `app/src-tauri/src/remote/`, and all on the allowed list:

- `remote_status`: on or off, the endpoint id, whether it is online, the relay in
  use, paired phones (name, paired at, last seen, connected now) and the
  connected clients.
- `remote_set`: the switch, start at login, keep awake, and the relay URL.
- `remote_pair_begin`: makes a pairing code and returns the QR payload.
- `remote_pair_answer`: the desktop window's yes or no to *Allow this phone?*. The
  prompt arrives as a `remote://pair-request` event carrying the phone's name and
  the six-digit matching code, both computed in Rust.
- `remote_revoke`: removes a phone and closes its connections at once.

Settings live in a Rust-owned file in the app's data directory (`remote.json`), not
in vibe's config. Rust must read them **before any window exists**, because start
at login opens to the tray, and a project's `vibe.config.json` must not be able to
reach them. This is the [third spec correction](#corrections-to-the-product-spec).

### Desktop-only pieces

| On the desktop | On the phone (`VITE_TARGET=mobile`) |
|---|---|
| `pick.ts` opens the OS folder picker (`plugin-dialog`) | a folder browser over the existing `fs` read frame. Its roots are the host's, so a phone can browse exactly what the pilot can |
| The tray, Quit, `app://quit-requested` | absent. `app_quit` is in the desktop's settings screen |
| `UpdatePopover`'s *Download* opens the desktop browser | `OpenOnPhone` opens the phone's |
| Keyboard shortcuts and the palette | absent |

## Pairing

1. The desktop window calls `remote_pair_begin`. Rust makes a 32-byte secret, keeps
   it with a five-minute expiry, and returns
   `vibe-pair:1?id=<endpoint id>&relay=<url>&s=<secret>&n=<desktop name>`, drawn as
   a QR code.
2. The phone dials the id on `vibe/pair/1`, using the relay URL as an address hint
   so it does not wait for discovery, and sends `{ secret, phoneName }`.
3. The desktop compares the secret in constant time. **Any answer, right or wrong,
   burns the code**, so a photographed code can be tried once and an attacker
   racing the owner makes the owner's attempt fail visibly.
4. On a right secret the desktop makes a fresh 16-byte nonce and sends it to the
   phone. Both sides then compute the **matching code**: six digits from
   `SHA-256("vibe-pair-code/1" ‖ desktop id ‖ phone id ‖ nonce)`, read as a
   big-endian integer mod 10⁶. Each side uses the phone id the QUIC handshake
   authenticated, never one a message claimed.
5. The phone shows the code and *Check that the desktop shows the same number*. The
   desktop window shows *Allow `<phoneName>`?* with the same six digits and the
   sentence *Press allow only if your phone shows this number*. On yes, Rust adds
   the phone's endpoint id to the paired list (`remote-paired.json` in the app's
   data directory) and answers the phone with `{ desktopName }`. On no, or after
   the code expires, it answers *declined* and closes.
6. The phone stores the desktop's id, relay hint and name, and opens
   `vibe/remote/1`.

**Why the matching code, and why the nonce.** The name in *Allow `<phoneName>`?* is
whatever the dialing phone chose. Somebody who photographs the QR code and dials
first can call their device by the owner's phone's name, and the owner, expecting
exactly that prompt, presses yes. Burning the code does not help: the attacker is
the one who used it. The six digits tie the yes to the device in the owner's hand,
because they are computed from the key that actually connected. An attacker's key
gives different digits, and the owner's own phone shows none at all, since its
attempt found the code burnt.

The nonce is what keeps six digits enough. Without it, the code would be a
function of two public keys, and an attacker who knew the owner's phone id could
generate keypairs offline until one matched, about a million tries, which takes
seconds. The nonce is made after the attacker's connection exists, so their key is
fixed before the digits can be known, and one attempt has a one-in-a-million
chance. The QR code never contains the digits.

**Revoking from the desktop** removes the id and closes its connections with
`NOT_PAIRED`. **Unpairing from the phone** sends an `Unpair` message first when the
desktop is reachable. When it is not, the desktop's list keeps the entry, with its
last-seen time, until somebody revokes it there.

## Several clients

The desktop window and any number of phones can be connected at once.

### Events fan out

Rust already emits each `host://frame` to the window. The bridge subscribes to the
same events with `app.listen_any` and forwards each to every connected phone, so
the window and the phones see the same frames in the same order.

### Request ids are partitioned

Every inbound frame carries a numeric `id`, allocated by the window's
`nextRequestId`, and every client sees every answer. So two clients counting from 1
would each take the other's answers. Each client gets **its own range**. The window
keeps counting from 1. Each phone connection's `Welcome` carries an `idBase`, a
multiple of 2^40 that the desktop has not handed out since it started, and the
phone's `nextRequestId` counts from there. A client ignores answers outside its own
range. This was already true of an id the window did not ask for.

The base is per **connection**, not per phone, because the AGENTS.md lesson about
`emit.ts` applies: an id is only as unique as the thing that seeds it, and a
reconnect restarts the phone's counter. Gate ids (`ask`) are allocated by the host
and are shared on purpose: whichever client answers first answers for all, and
`serve.ts` already refuses a second answer to a gate that is no longer asked.

### Joining a live run

A phone that connects mid-run has missed every frame before it. So that it draws
exactly what the desktop window draws, through the same `reduce`, the desktop's
Rust keeps **every frame each live run host has emitted, in order**, and sends a
new phone the buffer for each live host before the live stream. The buffer goes
with the host when Rust reaps it.

- It is a **copy**, not an interpretation. Rust stores bytes it already relays and
  parses nothing in them.
- It is **unbounded for the life of the run**, since the alternative is a cap,
  which is a number nobody measured. The cost is the run's own narration, mostly
  heartbeats and `model_said` text, held once in desktop memory.
- The **service host is not buffered**. Its frames answer requests, and a phone
  makes its own requests. The window's memory, chats and archive are read fresh,
  by the frames the window already uses.

### A write is announced

The window keeps synchronous caches of what it reads and writes through the
service host: `memory.ts` (pins, names, where it was pointed), the chat store, and
the config it shows on the settings screen. With one client that was safe. With
two, a phone's save would be overwritten by the window's stale cache on its next
save.

So the service host emits a **`changed`** frame after every write it performs,
naming what moved: `{ type: 'changed', what: 'memory' | 'chat' | 'config', key }`.
Every client's cache re-reads that key. This is the one change to the core, it
needs a test in `serve.ts` and a `PROTOCOL_VERSION` bump, and a window that ignores
it behaves exactly as today.

**Two writes to one key race, and the last one wins.** That is true of a person
with two desktop windows today, and nothing here needs it to be better. A gate is
the case where it matters, and a gate is protected by `serve.ts`'s own refusal.

### Attribution

The spec draws *Continued from Adam's iPhone*. A gate answer already carries an
`origin` (`readOrigin` in `src/host.ts`), and a `gate_released` that carries one is
recorded. For a phone, **the bridge sets that field**: on every frame a phone sends
through `host_send`, the desktop's Rust overwrites a top-level `origin` with
`phone:<phoneName>`, whatever the phone put there. `readOrigin` refuses an origin
over 40 characters, so the name is cut to fit. A phone therefore cannot claim to
be the desktop or another phone, and the desktop window's frames are unchanged.

This is the one field the bridge writes from what it carries, and it is a
write, so it is stated here rather than slipped in. Run starts and settings saves
gain an `origin` in the same way, which needs the core to read it there as it
already does for gates.

## Staying reachable

- **Start at login**: `tauri-plugin-autostart`, driven by `remote_set` from Rust.
  The window gets no permission for the plugin, as with the updater. It starts to
  the tray.
- **The endpoint starts in `setup`**, when remote access is on, whether or not a
  window is open.
- **Keep awake**: while a run host is alive and the setting is on, Rust holds the
  platform's sleep inhibitor (the `keepawake` crate) and releases it when the last
  run host is reaped.
- **Network changes**: iroh migrates the connection's path. The spike lost no pings
  across an IP change. The phone calls `endpoint.network_change()` when the OS
  reports one, which is iroh's hint for mobile.
- **The phone's own lifecycle**: iOS suspends a backgrounded app and its sockets go
  with it. The phone reconnects on foreground, receives the live-run buffers again,
  and redraws. Local notifications fire only while the app is still running, from
  the frames it is folding.

## Threat model

| Who | Can | Cannot |
|---|---|---|
| A relay, n0's or anyone's | see that two endpoint ids are talking, when, and roughly how much | read or change anything: QUIC is end-to-end encrypted and authenticated to both keys |
| The DNS and discovery server | see which endpoint ids are looked up; publish a false relay URL for an id | impersonate a desktop: the connection is authenticated to the id, so a false record only fails to connect |
| Anybody who looks up a desktop's record | learn its relay URL | learn its IP address: the record is relay-only |
| Somebody who photographs a QR code | try it once, within five minutes; the desktop then shows digits their device cannot make the owner's phone show | pair by naming their device after the owner's phone: the matching code differs, and the owner's phone shows none |
| Somebody who replays a pairing secret | nothing: one attempt burns it | |
| A stolen, unlocked phone with the app lock off | everything a paired phone can, until the desktop revokes it | read an API key: none is ever sent to a phone |
| A stolen phone with the app lock on | nothing without the owner's biometrics or PIN | |
| A project's `vibe.config.json` | nothing: remote settings are not in vibe's config | turn remote access on, or name a relay |
| A paired phone, by design | everything the desktop window can, which is the spec's full parity | claim to be the desktop or another phone in a recorded origin |

**The residual risk is the one the spec chose**: a paired, unlocked phone is as
powerful as the desktop's keyboard. Revoking is the answer, and it acts on
connected phones at once.

## Testing

In CI, with no network:

- **Two endpoints in one process** on the `Minimal` preset, dialed by direct
  address, with discovery off. Pairing, refusal of an unpaired id before a stream
  is read, a burnt code, an expired code, the matching code computed alike on both
  ends from the authenticated ids (and differently for a third key given the same
  secret), revocation closing a live connection,
  `VERSION_MISMATCH`, and a round trip of calls, returns and events.
- **The allowed list** against `generate_handler!`: a new desktop command without a
  remote decision fails by name, the way `keys.test.ts` pins the window's commands.
- **Id ranges**: two clients with overlapping counters never take each other's
  answers.
- **`changed`**: a memory write from one client invalidates the other's cache.
- **Attribution**: a phone frame claiming `origin: "desktop"` reaches the host as
  `phone:<name>`.
- **The live-run buffer**: a phone that joins after N frames folds to the same
  `Run` as the window. Both fold the same frames through the same `reduce`.
- **Remote access off**: no endpoint, no relay connection, no published record and
  no listening socket.

Only a real-device pass can show cellular paths, backgrounding on iOS and Android,
and local discovery between two physical devices. That is #346's done-when.

## Corrections to the product spec

Three things the spec says cannot be built, or are not safe, as written:

1. **"`<desktop>` no longer recognises this phone. It was reset or reinstalled."**
   A desktop whose keychain was reset has a new endpoint id, and nothing answers on
   the old one, so the phone sees exactly what it sees for a desktop that is off.
   What *can* be told apart is a desktop that kept its key but lost its paired list
   (its data directory was cleared): that answers `NOT_PAIRED`, which draws the
   *removed this phone* sentence. The spec's sentence for a reset desktop goes, and
   the *can't reach* sentence gains *or it was reset* once a desktop has been
   unreachable for a long time.
2. **"The confirmation on the desktop is what stops a photographed QR code from
   being enough by itself."** Not by itself: an attacker who dials first can name
   their device after the owner's phone, and a yes to a name is a yes to them. The
   desktop's prompt and the phone's pairing screen both show a six-digit matching
   code, and the yes means *these match*. Pairing gains one look at two screens.
3. **Remote access is not in vibe's config.** The spec says a project's
   `vibe.config.json` cannot turn it on. That stays true, more strongly: the
   settings are in a Rust-owned file, because Rust reads them before any window
   or host exists.

## Issue by issue

| Issue | Builds |
|---|---|
| #341 | identity in the keychain, `remote_pair_begin`/`answer`, the matching code, `remote_revoke`, `remote-paired.json` |
| #342 | the endpoint (n0 preset + mDNS + the relay setting), the two ALPNs, refusal before read, `remote_status` |
| #343 | the control stream, calls and events, the allowed list and its test, id ranges, attribution, the live-run buffer |
| #344 | `remote_set`, `remote.json`, autostart, keep awake, the connected-phone chip |
| #345 | `app/mobile/` and `app/remote/` crates, `VITE_TARGET=mobile` and the swapped modules, the phone's key storage |
| #346 | the phone's pairing, reconnecting, failure sentences, app lock, local notifications, and the device measurements |
| #347 | the phone's screens |
| #348 | mobile builds in CI and release |
| #354 | the `changed` frame in `serve.ts`, and `origin` read on run starts and settings saves (core, so it lands first, with no behaviour change) |
