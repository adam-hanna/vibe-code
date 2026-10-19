#!/bin/sh
# Boot an iPhone simulator, install a mock-desktop build, launch it, and fail
# unless the cockpit came up and read the recorded run (#345). The same two
# log lines as `launch-android.sh`, read from the simulator's unified log.
#
#   launch-ios.sh path/to/Vibe.app out-dir
set -eu
app=$1
out=$2
mkdir -p "$out"
device=$(xcrun simctl list devices available -j | python3 -c '
import json, sys
devices = json.load(sys.stdin)["devices"]
phones = [d for runtime, ds in devices.items() if "iOS" in runtime for d in ds if d["name"].startswith("iPhone")]
print(phones[-1]["udid"])')
xcrun simctl boot "$device" || true
xcrun simctl bootstatus "$device" -b
xcrun simctl install "$device" "$app"
started=$(date '+%Y-%m-%d %H:%M:%S')
xcrun simctl launch "$device" dev.vibecode.mobile
i=0
while [ $i -lt 90 ]; do
  xcrun simctl spawn "$device" log show --style compact --start "$started" \
    --predicate 'eventMessage CONTAINS "vibe-mobile" OR eventMessage CONTAINS "mock desktop"' > "$out/log.txt" 2>&1 || true
  if grep -q 'mock desktop: answered "replay"' "$out/log.txt"; then break; fi
  i=$((i + 1))
  sleep 2
done
sleep 5
xcrun simctl io "$device" screenshot "$out/ios.png"
grep 'vibe-mobile: device key ready' "$out/log.txt"
grep 'mock desktop: answered "replay"' "$out/log.txt"
