# On your phone

The phone app is a remote for the desktop app: it shows the same runs, the same pilot chat and the same settings, and everything you do on one shows on the other at once. Nothing runs on the phone. The work still happens on the desktop, so the desktop app has to be running, with remote access on.

It is not in the App Store or Google Play. You install it yourself, from the same release as the desktop app.

| Phone | Download |
|---|---|
| Android 7 or later | [`Vibe-android.apk`](https://github.com/adam-hanna/vibe-code/releases/latest/download/Vibe-android.apk) |
| iPhone (iOS 15 or later) | [`Vibe-ios-unsigned.ipa`](https://github.com/adam-hanna/vibe-code/releases/latest/download/Vibe-ios-unsigned.ipa), installed with a sideloading tool (below) |

These links always point at the newest version. Each release also carries the same files under versioned names, such as `Vibe_1.7.0_android.apk`, and older versions are on the [releases page](https://github.com/adam-hanna/vibe-code/releases). To check a download came from this repository, run `gh attestation verify Vibe-android.apk --repo adam-hanna/vibe-code` ([more](./app.md#verifying-a-download)).

## Android

1. On the phone, open the [`.apk` link](https://github.com/adam-hanna/vibe-code/releases/latest/download/Vibe-android.apk) in the browser and download it.
2. Open the downloaded file. Android asks you to allow your browser (or file manager) to **install unknown apps**. Allow it, go back and press **Install**.
3. If Play Protect warns about an unknown developer, press **More details**, then **Install anyway**.

You can also install it from a computer, with USB debugging on and the phone plugged in: `adb install Vibe-android.apk`.

**To update**, install the new `.apk` the same way. Every release is signed with the same key, so it installs over the old one and keeps your paired desktops. If Android ever says the app "conflicts with an existing package", you have a build signed by another key, such as one you built yourself: uninstall it first, then pair again.

## iPhone

Apple lets nothing onto an iPhone without an Apple signature, so the release ships the app **unsigned**, and a sideloading tool signs it with **your own Apple ID**. A free Apple ID is enough. Its signature lasts **7 days**, after which the app will not open until it is signed again; the tools below do that for you, or you can do it with one tap.

### With AltStore or SideStore (recommended)

[AltStore](https://altstore.io) and [SideStore](https://sidestore.io) are free and re-sign the app in the background before the 7 days run out.

1. Install AltStore (it needs AltServer on a Mac or Windows PC once) or SideStore, following its own guide.
2. On the iPhone, download [`Vibe-ios-unsigned.ipa`](https://github.com/adam-hanna/vibe-code/releases/latest/download/Vibe-ios-unsigned.ipa) and open it with AltStore or SideStore (**Share → AltStore**, or **My Apps → +** in the app).
3. Sign in with your Apple ID when asked. The ID is sent only to Apple.
4. The first time, go to **Settings → General → VPN & Device Management**, tap your Apple ID and **Trust** it. On iOS 16 or later, also turn on **Settings → Privacy & Security → Developer Mode** and restart.

### With Sideloadly

[Sideloadly](https://sideloadly.io) runs on a Mac or Windows PC. Plug the iPhone in, drag the `.ipa` into Sideloadly, enter your Apple ID and press **Start**, then trust it on the phone as in step 4 above. Sideloadly does not re-sign on its own: after 7 days, plug in and press **Start** again.

**To update**, open the new `.ipa` the same way. It replaces the old one and keeps your paired desktops.

## Pairing it with your desktop

1. On the desktop, open **Settings → Remote access**, turn on **Let paired phones reach this desktop** and press **Pair a phone**. A QR code appears.
2. On the phone, open Vibe, press **Pair a desktop** and point the camera at the code.
3. Both screens show the same six-digit number. Check that they match, then press **Allow** on the desktop.

The phone reaches the desktop by its key, directly when it can and through a relay when it cannot, and never by its IP address. The desktop does not need a port opened. To stop a phone, remove it from the list in **Settings → Remote access**, or turn remote access off.

## More than one desktop

A phone can be paired with as many desktops as you like, and is open on one at a time.

- **To pair another**, go back to the **Desktops** screen (the **Desktops** button at the top of the cockpit) and press **Pair a desktop**, then follow the steps above on the new desktop.
- **To switch**, go back to **Desktops** and press **Open** on the one you want. The phone closes its connection to the desktop it was on and connects to the new one.
- **Each row says whether that desktop can be reached** and when it was last seen. **Rename** changes the name on this phone only, and **Unpair** forgets the desktop and tells it to forget this phone. A desktop that is off or out of reach cannot be told, so remove the phone in its **Settings → Remote access** as well.

The phone shows the runs, gates and pilot chat of the desktop it is open on. The others keep running as usual and show on the phone when you open them.

## Building it yourself

You need the desktop app's build setup first: Node 22, Rust and the [Tauri prerequisites](https://tauri.app/start/prerequisites/). Then, from a checkout:

```bash
npm ci && npm run build
cd app && npm ci
cd mobile && npm ci
```

### Android

You need JDK 21 (Gradle 8.14 does not run on 25), the [Android SDK and NDK](https://v2.tauri.app/start/prerequisites/#android), and the Rust targets:

```bash
rustup target add aarch64-linux-android armv7-linux-androideabi
export JAVA_HOME=/path/to/jdk-21
export ANDROID_HOME=$HOME/Android/Sdk
export NDK_HOME=$ANDROID_HOME/ndk/<version>
npx tauri android init --ci
npx tauri android build --apk --target aarch64 --debug
adb install -r src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
```

A debug build is signed with your machine's debug key, so it will not install over a release build (or the other way round) until you uninstall the one that is there. For a release build of your own, drop `--debug`, add `armv7` after `aarch64` if you like, and sign the result with your own key: `ANDROID_KEYSTORE_FILE=… ANDROID_KEYSTORE_PASSWORD=… ANDROID_KEY_ALIAS=… ANDROID_KEY_PASSWORD=… scripts/sign-apk.sh src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk Vibe.apk`.

### iPhone

You need a Mac with Xcode, and an Apple ID added in **Xcode → Settings → Accounts** (a free one works, with the same 7-day limit).

```bash
rustup target add aarch64-apple-ios
npx tauri ios init --ci
npx tauri ios build --target aarch64 --open
```

`--open` opens the project in Xcode. Select the app's iOS target, then **Signing & Capabilities → Team** and pick your Apple ID; if Xcode says the bundle identifier is taken, change `dev.vibecode.mobile` to something of your own. Plug in the iPhone, choose it as the run destination and press **Run**. Trust your Apple ID on the phone as in step 4 of the AltStore steps. To build the same unsigned `.ipa` the release ships, run `npx tauri ios build --target aarch64 --no-sign` instead, and sideload it as above.
