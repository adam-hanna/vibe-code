#!/usr/bin/env bash
# Launch a built AppImage on other Linux distributions and check that it draws.
#
#   app/scripts/smoke-appimage.sh <AppImage> [image ...]
#
# Each image gets the libraries a desktop with GTK 3 already has, a virtual X
# server (Xvfb, so Mesa's software renderer, not a GPU), and the AppImage. The
# check fails on any of three things:
#
#   - the process exiting before the screenshot,
#   - WebKit aborting (`EGL_BAD_*`, `Aborting`) in the output,
#   - a screen that is one colour.
#
# The last one exists because the failure this was written for (#331) was a
# white window with the process still running. v1.6.0's AppImage bundled
# Ubuntu 22.04's libwayland, the host's Mesa could not create an EGL display
# against it, and WebKit drew nothing. A live process alone proves nothing.
#
# Xvfb is not a GPU, so a pass here does not prove the app renders on real
# hardware. It does load the same libraries, in the same order, against each
# distribution's own Mesa, which is where #331 broke.
#
# Needs podman or docker, and ImageMagick (`magick` or `convert`) on the host
# to count the screenshot's colours.
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "usage: $0 <AppImage> [image ...]" >&2
  exit 64
fi
appimage=$(realpath "$1")
shift
if [ $# -eq 0 ]; then
  set -- \
    docker.io/library/ubuntu:22.04 \
    docker.io/library/ubuntu:24.04 \
    docker.io/library/debian:12 \
    registry.fedoraproject.org/fedora:latest \
    docker.io/library/archlinux:latest \
    registry.opensuse.org/opensuse/tumbleweed:latest
fi

engine=${CONTAINER_ENGINE:-}
if [ -z "$engine" ]; then
  if command -v podman >/dev/null; then engine=podman; else engine=docker; fi
fi
if command -v magick >/dev/null; then
  colours() { magick "$1" -format '%k' info:; }
elif command -v convert >/dev/null; then
  colours() { convert "$1" -format '%k' info:; }
else
  echo "ImageMagick is needed to read the screenshots (magick or convert)." >&2
  exit 69
fi

out=${SMOKE_OUT:-$(mktemp -d)}
mkdir -p "$out"

# Runs inside the container. The package lists are the GTK 3 runtime, Mesa's
# EGL and DRI drivers, Xvfb and xwd: what a desktop has, and nothing the
# AppImage should be bringing itself.
probe='
set -eu
if command -v apt-get >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  gtk=libgtk-3-0
  if apt-cache show libgtk-3-0t64 >/dev/null 2>&1; then gtk=libgtk-3-0t64; fi
  apt-get install -y -qq --no-install-recommends "$gtk" libegl1 libgl1-mesa-dri \
    xvfb x11-apps dbus-x11 >/dev/null
elif command -v dnf >/dev/null; then
  dnf install -y -q gtk3 mesa-dri-drivers mesa-libEGL xorg-x11-server-Xvfb xwd dbus-x11 >/dev/null
elif command -v pacman >/dev/null; then
  pacman -Sy --noconfirm --needed gtk3 mesa xorg-server-xvfb xorg-xwd >/dev/null
elif command -v zypper >/dev/null; then
  zypper -q -n install gtk3-tools libgtk-3-0 Mesa-dri Mesa-libEGL1 xorg-x11-server-Xvfb xwd >/dev/null
else
  echo "no package manager this script knows" >&2
  exit 1
fi

Xvfb :99 -screen 0 1440x900x24 >/dev/null 2>&1 &
sleep 2
export DISPLAY=:99 APPIMAGE_EXTRACT_AND_RUN=1 HOME=/tmp/home
mkdir -p "$HOME"
cp /in/app.AppImage /tmp/app.AppImage
cd /tmp
if command -v dbus-launch >/dev/null; then eval "$(dbus-launch --sh-syntax)"; fi
/tmp/app.AppImage >/out/app.log 2>&1 &
pid=$!
sleep "${SMOKE_WAIT:-30}"
xwd -root -display :99 -out /out/screen.xwd
if kill -0 "$pid" 2>/dev/null; then echo alive >/out/state; else echo exited >/out/state; fi
'

failed=0
for image in "$@"; do
  name=$(printf '%s' "$image" | tr '/:' '__')
  dir="$out/$name"
  mkdir -p "$dir"
  echo "== $image"
  if ! "$engine" run --rm \
      -e SMOKE_WAIT="${SMOKE_WAIT:-30}" \
      -v "$appimage:/in/app.AppImage:ro" -v "$dir:/out" \
      "$image" sh -c "$probe" >"$dir/container.log" 2>&1; then
    echo "   FAIL: the container did not finish; see $dir/container.log"
    failed=1
    continue
  fi
  state=$(cat "$dir/state")
  if [ "$state" != alive ]; then
    echo "   FAIL: the app exited before the screenshot; see $dir/app.log"
    failed=1
    continue
  fi
  if grep -E -q 'EGL_BAD_|Aborting' "$dir/app.log"; then
    echo "   FAIL: WebKit aborted: $(grep -E -m1 'EGL_BAD_|Aborting' "$dir/app.log")"
    failed=1
    continue
  fi
  n=$(colours "$dir/screen.xwd")
  # A drawn window has text, borders and accents: hundreds of colours. An
  # undrawn one is the one background colour, plus at most Xvfb's black.
  if [ "$n" -lt 16 ]; then
    echo "   FAIL: the screen has $n colours, so nothing was drawn; see $dir/screen.xwd"
    failed=1
    continue
  fi
  echo "   ok: running, no abort, $n colours on screen"
done

echo "screenshots and logs: $out"
exit "$failed"
