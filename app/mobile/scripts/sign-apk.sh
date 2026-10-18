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

in="${1:?usage: sign-apk.sh <unsigned.apk> <signed.apk>}"
out="${2:?usage: sign-apk.sh <unsigned.apk> <signed.apk>}"
for v in ANDROID_KEYSTORE_FILE ANDROID_KEYSTORE_PASSWORD ANDROID_KEY_ALIAS ANDROID_KEY_PASSWORD; do
  if [ -z "${!v:-}" ]; then echo "sign-apk: $v is not set" >&2; exit 1; fi
done

sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}"
# The newest build-tools, by version order rather than by directory order.
tools=$(ls -1d "$sdk"/build-tools/*/ 2>/dev/null | sort -V | tail -1)
if [ -z "$tools" ]; then echo "sign-apk: no build-tools under $sdk" >&2; exit 1; fi

aligned="$(mktemp -d)/aligned.apk"
"$tools/zipalign" -p -f 4 "$in" "$aligned"
# `env:` names the variable, so no password is ever on a command line.
"$tools/apksigner" sign \
  --ks "$ANDROID_KEYSTORE_FILE" --ks-pass env:ANDROID_KEYSTORE_PASSWORD \
  --ks-key-alias "$ANDROID_KEY_ALIAS" --key-pass env:ANDROID_KEY_PASSWORD \
  --out "$out" "$aligned"
"$tools/apksigner" verify --print-certs "$out" | grep -E 'Signer #1 certificate (DN|SHA-256)'
rm -rf "$(dirname "$aligned")"
