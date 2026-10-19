#!/usr/bin/env bash
# Sign a release APK for sideloading (#348): zipalign it, sign it with the
# release key, and check the signature. Used by release.yml and by hand.
#
#   sign-apk.sh <unsigned.apk> <signed.apk>
#
# The key comes from the environment and is never echoed:
#   ANDROID_KEYSTORE_FILE      path to the .jks
#   ANDROID_KEYSTORE_PASSWORD  the store's password
#   ANDROID_KEY_ALIAS          the key's alias in it
#   ANDROID_KEY_PASSWORD       the key's password (often the store's)
#
# **Every release must be signed by the same key.** Android refuses to install
# an APK over one signed by another, so a new key means every phone has to
# uninstall the app - and lose its pairing - before it can take an update.
set -euo pipefail
# Under `set -e` a failing command ends the script with nothing said: rc.1's
# signing step died with exit 1 and no message at all. Every failure now says
# which line it was. The trap prints the command, never a password: those are
# read by apksigner from the environment (`env:` below), never passed as words.
trap 'echo "sign-apk: line $LINENO exited $?: $BASH_COMMAND" >&2' ERR

in="${1:?usage: sign-apk.sh <unsigned.apk> <signed.apk>}"
out="${2:?usage: sign-apk.sh <unsigned.apk> <signed.apk>}"
for v in ANDROID_KEYSTORE_FILE ANDROID_KEYSTORE_PASSWORD ANDROID_KEY_ALIAS ANDROID_KEY_PASSWORD; do
  if [ -z "${!v:-}" ]; then echo "sign-apk: $v is not set" >&2; exit 1; fi
done

sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}"
# The newest build-tools that has both tools, by version order rather than by
# directory order. A glob and a test per entry, not `ls | sort`: under
# `pipefail` one entry `ls` cannot read (a dangling link, say) fails the whole
# lookup, and `set -e` ends the script without a word.
tools=""
for d in "$sdk"/build-tools/*/; do
  [ -x "${d}zipalign" ] && [ -x "${d}apksigner" ] || continue
  if [ -z "$tools" ] || [ "$(printf '%s\n%s\n' "$tools" "$d" | sort -V | tail -n 1)" = "$d" ]; then
    tools="$d"
  fi
done
if [ -z "$tools" ]; then echo "sign-apk: no build-tools with zipalign and apksigner under $sdk" >&2; exit 1; fi
echo "sign-apk: using ${tools%/}"

aligned="$(mktemp -d)/aligned.apk"
"${tools}zipalign" -p -f 4 "$in" "$aligned"
# `env:` names the variable, so no password is ever on a command line.
"${tools}apksigner" sign \
  --ks "$ANDROID_KEYSTORE_FILE" --ks-pass env:ANDROID_KEYSTORE_PASSWORD \
  --ks-key-alias "$ANDROID_KEY_ALIAS" --key-pass env:ANDROID_KEY_PASSWORD \
  --out "$out" "$aligned"
# The whole report, not a grep of it. This was rc.1's failure: the script
# grepped for `Signer #1 certificate`, which build-tools 35 and 36 print, and
# the runner's 37.0.0 prints `V3.0 Signer: certificate` instead. The grep
# matched nothing, exited 1, and under `set -e` the step died with no message
# over a correctly signed APK.
"${tools}apksigner" verify --print-certs "$out"
rm -rf "$(dirname "$aligned")"
