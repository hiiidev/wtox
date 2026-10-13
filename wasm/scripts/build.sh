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
  -s ENVIRONMENT=web,worker,node \
  -s EXPORTED_FUNCTIONS='["_malloc","_free","_wtox_create_encrypted","_wtox_inspect_encrypted","_wtox_session_start_new","_wtox_session_restore_encrypted","_wtox_session_savedata_size","_wtox_session_export_encrypted","_wtox_session_set_name","_wtox_session_get_name","_wtox_session_iterate","_wtox_session_iteration_interval","_wtox_session_close","_wtox_session_friend_add","_wtox_session_friend_accept","_wtox_session_friend_count","_wtox_session_friend_list","_wtox_session_friend_public_key","_wtox_session_friend_delete","_wtox_session_send_text","_wtox_session_event_next","_wtox_session_events_dropped","_wtox_vtcp_reset","_wtox_vtcp_begin","_wtox_vtcp_connected","_wtox_vtcp_fail","_wtox_vtcp_close","_wtox_vtcp_state","_wtox_vtcp_send","_wtox_vtcp_tx_pending","_wtox_vtcp_tx_peek","_wtox_vtcp_tx_consume","_wtox_vtcp_rx_free","_wtox_vtcp_rx_push","_wtox_vtcp_recv","_wtox_vtcp_peer_closed","_wtox_network_injection_probe","_wtox_network_relay_dial_probe","_wtox_network_relay_rejection_probe","_wtox_network_relay_authenticated_probe","_wtox_research_start","_wtox_research_stop","_wtox_research_tick","_wtox_research_stats","_wtox_research_make_reply","_wtox_research_start_with_relay_public_key","_wtox_research_add_route","_wtox_research_route_online_count","_wtox_research_enable_route_capture","_wtox_research_send_route_packet","_wtox_research_take_route_packet","_wtox_research_get_dht_public","_wtox_research_connected_relays","_wtox_research_get_crypto_public","_wtox_research_begin_crypto","_wtox_research_crypto_status_get","_wtox_research_crypto_send","_wtox_research_crypto_recv","_wtox_research_add_native_friend","_wtox_research_native_friend_stats","_wtox_research_native_send_text","_wtox_research_native_take_message","_wtox_research_savedata_encrypted_size","_wtox_research_export_encrypted","_wtox_research_start_with_relay_encrypted","_wtox_research_resume_saved_friend","_wtox_research_get_tox_address","_wtox_research_queue_tox_id_request","_wtox_research_tox_request_status","_wtox_research_take_real_friend_request","_wtox_vudp_probe_start","_wtox_vudp_probe_stop","_wtox_vudp_probe_send","_wtox_vudp_probe_reject_remote","_wtox_vudp_probe_take","_wtox_vudp_probe_push","_wtox_vudp_probe_read","_wtox_vudp_probe_stats","_wtox_vudp_native_bootstrap","_wtox_vudp_native_tick","_wtox_vudp_native_connection","_wtox_vudp_native_dht_public"]' \
  -s EXPORTED_RUNTIME_METHODS='["HEAPU8"]' \
  -s ASSERTIONS=1
test -s "$DIST/tox_identity.wasm"
test -s "$DIST/tox_identity.mjs"
echo "WASM research artifact built in $DIST"
