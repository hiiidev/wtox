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

# Independent DHT + Onion first-contact integration fixture: native original
# c-toxcore only; its networking callbacks reject non-loopback traffic.
cc -std=c11 -O2 -D_GNU_SOURCE \
  -I "$UPSTREAM" "$ROOT/native/tox_local_discovery.c" \
  "$archive" $(pkg-config --cflags --libs libsodium) -lm -pthread \
  -o "$DIST/tox-local-discovery"
test -s "$DIST/tox-local-discovery"
echo "Original c-toxcore local DHT/Onion discovery fixture built"

# An independently running original Toxcore bootstrap identity.
# This process is 127.0.0.1 UDP ONLY, with no production/public listener.
cc -std=c11 -O2 -D_GNU_SOURCE \
  -I "$UPSTREAM" "$ROOT/native/tox_udp_bootstrap.c" \
  "$archive" $(pkg-config --cflags --libs libsodium) -lm -pthread \
  -o "$DIST/tox-udp-bootstrap"
test -s "$DIST/tox-udp-bootstrap"
echo "Pinned original loopback-only UDP DHT bootstrap compiled"

# Native original receiver + independent original DHT bootstrap:
# test-only first-contact Onion callback through loopback OS UDP.
cc -std=c11 -O2 -D_GNU_SOURCE \
  -I "$UPSTREAM" "$ROOT/native/tox_udp_friend_receiver.c" \
  "$archive" $(pkg-config --cflags --libs libsodium) -lm -pthread \
  -o "$DIST/tox-udp-friend-receiver"
test -s "$DIST/tox-udp-friend-receiver"
echo "Pinned original local first-contact receiver built"

# Independent original Linux c-toxcore + ToxEncryptSave identity-file
# cross-runtime fixture. Does not run a GUI or connect to any network.
cc -std=c11 -O2 -D_GNU_SOURCE \
  -I "$UPSTREAM" "$ROOT/native/tox_save_interop.c" \
  "$archive" $(pkg-config --cflags --libs libsodium) -lm -pthread \
  -o "$DIST/tox-save-interop"
test -s "$DIST/tox-save-interop"
echo "Independent Linux Tox savedata/ToxEncryptSave fixture built"

# Stage 31: compile UNMODIFIED, exact-pinned TokTok/qTox ToxEncrypt Qt/C++
# source files, then independently prove bidirectional original WASM .tox
# compatibility. This does not build or run the full qTox GUI application.
QTOX_COMMIT="b4c8021cbc83f381eb62b2c995ee222390cf85d8"
QTOX="$ROOT/.build/qtox-upstream-crypto"
mkdir -p "$QTOX/src/core" "$QTOX/shims/tox"
pkg-config --exists Qt5Core || { echo "Requires qtbase5-dev for original qTox crypto"; exit 1; }
for source in toxencrypt.cpp toxencrypt.h; do
  curl -fsSL --retry 3 \
    "https://raw.githubusercontent.com/TokTok/qTox/$QTOX_COMMIT/src/core/$source" \
    -o "$QTOX/src/core/$source"
done
[[ "$(git hash-object "$QTOX/src/core/toxencrypt.cpp")" = \
  "1d5e750bb0c7d26031c39d6bd26d1cec47ebfae5" ]] || {
  echo "qTox upstream ToxEncrypt.cpp blob hash mismatch"; exit 1;
}
[[ "$(git hash-object "$QTOX/src/core/toxencrypt.h")" = \
  "f8cbe427478f9dd50c7522387a878bd564aac6b6" ]] || {
  echo "qTox upstream ToxEncrypt.h blob hash mismatch"; exit 1;
}
# The qTox project normally uses installed <tox/toxencryptsave.h>.
# This tiny CI-only INCLUDE PATH SHIM points to the already pinned original
# upstream c-toxcore source; neither project's source file is edited.
printf '#include "toxencryptsave/toxencryptsave.h"\n' \
  > "$QTOX/shims/tox/toxencryptsave.h"
g++ -std=c++17 -O2 -fPIC -D_GNU_SOURCE \
  -I "$UPSTREAM" -I "$QTOX" -I "$QTOX/shims" \
  "$QTOX/src/core/toxencrypt.cpp" \
  "$ROOT/native/qtox_profile_interop.cpp" \
  "$archive" $(pkg-config --cflags --libs Qt5Core libsodium) -lm -pthread \
  -o "$DIST/qtox-profile-interop"
test -s "$DIST/qtox-profile-interop"
echo "Unmodified upstream TokTok/qTox ToxEncrypt source + Qt5Core compiled"
