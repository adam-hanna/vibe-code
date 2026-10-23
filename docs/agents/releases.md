# What a release carries

Part of the working notes for this repo; [AGENTS.md](../../AGENTS.md) is the core and links here.
Moved out of AGENTS.md word for word on 2026-10-20, so where a note says *this file* it means
AGENTS.md and these companions together. Read this before changing the code it describes, and
update it in the same PR when that code changes.

**A release carries two names for each installer and the files an installed app updates
from** (#239). The README and `docs/app.md` link to
`releases/latest/download/<stable name>` — `Vibe-macos-universal.dmg` and the rest — so no link
moves per release; the names are written once, in `release.yml`'s matrix, and
`download-names.test.ts` fails when a page and the workflow disagree. With the
`TAURI_SIGNING_PRIVATE_KEY` secrets set, the build also produces the signed update bundles and
`latest.json`, which #299's updater reads. `tauri.conf.json` leaves `createUpdaterArtifacts`
off and the workflow switches it on, so a local `npm run app:build` never needs the key. **That
key cannot be replaced**: a release signed with a new one is refused by every installed copy,
whose only way forward is a manual reinstall.

**The Mac build is one universal bundle, for Apple Silicon and Intel** (#325, at the owner's
decision: *"Universal build"*). It is built on the arm64 `macos-14` runner with `--target
universal-apple-darwin`, so it does not depend on GitHub's Intel runners, which are being retired.
The Rust side is two cargo builds and a `lipo`, which is why that matrix entry installs both
darwin targets. The sidecar is the hard half: on every other build `stage-sidecar.mjs` copies the
node running it, and that is one architecture. Under `VIBE_SIDECAR_TARGET=universal-apple-darwin`
(set by the workflow; `TAURI_ENV_TARGET_TRIPLE` from the Tauri CLI also counts) it downloads the
official `darwin-arm64` and `darwin-x64` archives of **that same Node version**, refuses either one
unless its SHA-256 matches the single line `SHASUMS256.txt` gives it, `lipo -create`s the two, and
checks the result holds both slices and runs. It stages the fat file under three names, because
`tauri-build` looks for `node-aarch64-apple-darwin` and `node-x86_64-apple-darwin` in its two
cargo builds and the bundler takes `node-universal-apple-darwin`. Node 22's x64 build is linked for
macOS 11.0 (`LC_BUILD_VERSION` minos of the official v22.23.4 binary, read on 2026-10-21), so
`bundle.macOS.minimumSystemVersion` is `11.0`: an older Intel Mac is refused by the OS at launch
rather than opening a window whose host can never start. The step that starts the host from the
built `.app` checks every binary in `Contents/MacOS` holds both slices, then runs the host twice,
natively and under Rosetta (`arch -x86_64`), installing Rosetta if the image lacks it. Rosetta is
the closest CI gets to an Intel Mac; nobody here has one.

**Two stable names point at that one `.dmg`.** `Vibe-macos-universal.dmg` is what the pages link.
`Vibe-macos-arm64.dmg` is still uploaded, as the same universal file, because every page before
#325 linked it, the README of each published npm version among them, and those cannot be edited.
`download-names.test.ts` keeps it uploaded and keeps the pages from linking it. **The updater
serves the universal bundle under both `darwin-aarch64` and `darwin-x86_64`** in `latest.json`.
`tauri-plugin-updater` looks up `darwin-<arch>` (after `darwin-<arch>-<installer>`), where `<arch>`
is fixed when the running slice was compiled, so an Apple Silicon install made before #325 finds
the key it always read, now naming a bundle that also holds its slice, and an Intel install finds
its own. Dropping either key strands that kind of Mac on the version it has.

**The phone apps are on the same release, and there is no store** (#348, at the owner's
decision: *"Lets not release in the app store"*). The `mobile` job builds an APK signed with the
`ANDROID_KEYSTORE` secrets and an **unsigned** `.ipa` (`tauri ios build --no-sign`, tauri-cli
2.11), each under a versioned name and a stable one, `Vibe-android.apk` and
`Vibe-ios-unsigned.ipa`, attested like the installers and listed in `SHA256SUMS`. A person
installs the APK by hand and signs the `.ipa` with their own Apple ID through AltStore, SideStore
or Sideloadly; `docs/phone.md` says how, and how to build both from source.
`app/mobile/scripts/sign-apk.sh` is the one signing step, by hand or in CI. **The Android key
cannot be replaced either**: Android refuses an update signed by another key, so a new one means
every phone uninstalls the app, and loses its pairing, before it can update. It lives outside
every checkout (`~/.android/vibe-release.jks` on the owner's machine, with a backup) and in the
four repository secrets, and is never printed. Without the secrets the job builds no APK and
says so, as a fork's release has no updater files.
