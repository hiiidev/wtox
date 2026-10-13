#!/usr/bin/env bash
# Reproducible research build. Uses c-toxcore and libsodium source pins;
# do not use untrusted prebuilt .wasm binaries for user identity operations.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${ROOT}/.build"
DIST="${ROOT}/dist"
mkdir -p "${WORK}" "${DIST}"

for binary in git emcc emconfigure emmake emcmake cmake pkg-config make; do
  command -v "$binary" >/dev/null || { echo "Missing $binary"; exit 1; }
done
SODIUM_REF="1.0.20-RELEASE"
SODIUM_SHA="9511c982fb1d046470a8b42aa36556cdb7da15de"
TOX_REF="v0.2.23"
TOX_SHA="d9ca3c577e5abd4303d180eb5270167b4133ea4c"

checkout_tag() {
  local url="$1" tag="$2" sha="$3" dir="$4"
  if [[ ! -d "$dir/.git" ]]; then
    git clone --depth 1 --branch "$tag" --recurse-submodules "$url" "$dir"
  fi
  [[ "$(git -C "$dir" rev-parse HEAD)" = "$sha" ]] || {
    echo "Upstream SHA mismatch: $dir"; exit 1;
  }
}
checkout_tag https://github.com/jedisct1/libsodium.git "$SODIUM_REF" "$SODIUM_SHA" "$WORK/libsodium"
checkout_tag https://github.com/TokTok/c-toxcore.git "$TOX_REF" "$TOX_SHA" "$WORK/c-toxcore"

PREFIX="$WORK/prefix"
if [[ ! -f "$PREFIX/lib/libsodium.a" ]]; then
  (
    cd "$WORK/libsodium"
    emconfigure ./configure --host=wasm32-unknown-emscripten --disable-shared --enable-static --disable-asm \
      --without-pthreads --disable-ssp --disable-pie --prefix="$PREFIX"
    emmake make -j2
    emmake make install
  )
fi

export PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig"
export PKG_CONFIG_LIBDIR="$PREFIX/lib/pkgconfig"
export PKG_CONFIG_ALLOW_CROSS=1
emcmake cmake -S "$WORK/c-toxcore" -B "$WORK/toxcore-build" \
  -DCMAKE_BUILD_TYPE=Release -DENABLE_SHARED=OFF -DENABLE_STATIC=ON \
  -DBUILD_TOXAV=OFF -DDHT_BOOTSTRAP=OFF -DBOOTSTRAP_DAEMON=OFF \
  -DUNITTEST=OFF -DAUTOTEST=OFF -DBUILD_TESTING=OFF
cmake --build "$WORK/toxcore-build" --target toxcore_static -j2
TOX_ARCHIVE="$(find "$WORK/toxcore-build" -name libtoxcore.a -print -quit)"
[[ -n "$TOX_ARCHIVE" && -s "$TOX_ARCHIVE" ]] || {
  echo "toxcore static library not found"; exit 1;
}

emcc "$ROOT/native/tox_identity.c" -I "$WORK/c-toxcore" -I "$PREFIX/include" \
  "$TOX_ARCHIVE" "$PREFIX/lib/libsodium.a" -O2 -o "$DIST/tox_identity.mjs" \
  -s MODULARIZE=1 -s EXPORT_ES6=1 -s ALLOW_MEMORY_GROWTH=1 \
  -s ENVIRONMENT=web,worker,node -s FILESYSTEM=0 \
  -s EXPORTED_FUNCTIONS='["_malloc","_free","_wtox_create_encrypted","_wtox_inspect_encrypted"]' \
  -s EXPORTED_RUNTIME_METHODS='["HEAPU8"]' \
  -s ASSERTIONS=1
test -s "$DIST/tox_identity.wasm"
test -s "$DIST/tox_identity.mjs"
echo "WASM research artifact built in $DIST"
