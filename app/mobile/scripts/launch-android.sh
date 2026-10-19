#!/bin/sh
# Install a mock-desktop APK on a running emulator, launch it, and fail unless
# the cockpit came up and read the recorded run (#345).
#
#   launch-android.sh path/to/app.apk out-dir
#
# "Came up" is measured from the app's own log, not guessed from a delay: the
# phone's Rust logs its endpoint id at start, and the mock desktop logs each
# read the cockpit makes. A `replay` read happens only once the cockpit has
# mounted, loaded the window's memory and opened the run it points at, so it
# is the line that says the webview is drawing frames.
set -eu
apk=$1
out=$2
mkdir -p "$out"
adb install -r "$apk"
adb logcat -c
adb shell am start -W -n dev.vibecode.mobile/.MainActivity
i=0
while [ $i -lt 90 ]; do
  adb logcat -d > "$out/logcat.txt"
  if grep -q 'mock desktop: answered "replay"' "$out/logcat.txt"; then break; fi
  i=$((i + 1))
  sleep 2
done
# Settle, so the screenshot is of the drawn run rather than the first paint.
sleep 5
adb logcat -d > "$out/logcat.txt"
adb exec-out screencap -p > "$out/android.png"
grep 'vibe-mobile: device key ready' "$out/logcat.txt"
grep 'mock desktop: answered "replay"' "$out/logcat.txt"
