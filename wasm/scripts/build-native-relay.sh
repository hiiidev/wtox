#!/usr/bin/env bash
# Compile unmodified pinned c-toxcore TCP_Server as an isolated native
# loopback-only executable for independent Chromium/WASM interop CI.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UPSTREAM="$ROOT/.build/c-toxcore"
BUILD="$ROOT/.build/native-relay"
DIST="$ROOT/dist"
[[ -f "$UPSTREAM/toxcore/TCP_server.c" ]] || {
  echo "Pinned c-toxcore source missing; first run npm run build"; exit 1;
}
[[ "$(git -C "$UPSTREAM" rev-parse HEAD)" = "d9ca3c577e5abd4303d180eb5270167b4133ea4c" ]] || {
  echo "Pinned c-toxcore mismatch"; exit 1;
}
command -v cc >/dev/null
command -v cmake >/dev/null
pkg-config --exists libsodium || {
  echo "Requires system libsodium-dev for native independent Relay"; exit 1;
}
cmake -S "$UPSTREAM" -B "$BUILD" \
  -DCMAKE_BUILD_TYPE=Release -DENABLE_SHARED=OFF -DENABLE_STATIC=ON \
  -DBUILD_TOXAV=OFF -DDHT_BOOTSTRAP=OFF -DBOOTSTRAP_DAEMON=OFF \
  -DUNITTEST=OFF -DAUTOTEST=OFF -DBUILD_TESTING=OFF
cmake --build "$BUILD" --target toxcore_static -j2
archive="$(find "$BUILD" -name libtoxcore.a -print -quit)"
[[ -n "$archive" && -s "$archive" ]] || { echo "Original static toxcore archive missing"; exit 1; }
mkdir -p "$DIST"
cc -std=c11 -O2 -D_GNU_SOURCE \
  -I "$UPSTREAM" "$ROOT/native/tox_relay_loopback.c" \
  "$archive" $(pkg-config --cflags --libs libsodium) -lm -pthread \
  -o "$DIST/tox-relay-loopback"
test -s "$DIST/tox-relay-loopback"
echo "Pinned original c-toxcore TCP_Server native fixture built"

# Build the OTHER endpoint as a standalone Linux Tox client. It uses the
# original public tox_new/tox_friend_* APIs with a real native TCP socket,
# not the browser's WASM virtual network or a synthetic Node protocol client.
cc -std=c11 -O2 -D_GNU_SOURCE \
  -I "$UPSTREAM" "$ROOT/native/tox_linux_peer.c" \
  "$archive" $(pkg-config --cflags --libs libsodium) -lm -pthread \
  -o "$DIST/tox-linux-peer"
test -s "$DIST/tox-linux-peer"
echo "Pinned Linux Tox client built for browser/native interop"
