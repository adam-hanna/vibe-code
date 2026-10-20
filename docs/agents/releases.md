# What a release carries

Part of the working notes for this repo; [AGENTS.md](../../AGENTS.md) is the core and links here.
Moved out of AGENTS.md word for word on 2026-10-20, so where a note says *this file* it means
AGENTS.md and these companions together. Read this before changing the code it describes, and
update it in the same PR when that code changes.

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
