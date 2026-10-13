# wTox v1 — browser-native c-toxcore WASM identity research

**Not production ready.** This is a real C-to-WASM build experiment using
the same pinned c-toxcore version as the Python server. It is **not**
a network-capable Tox client. The existing React/Python frontend is unchanged.

## Goal of this increment

1. Compile c-toxcore v0.2.23 and libsodium 1.0.20 for WebAssembly.
2. Generate a genuine 76-hex-character native Tox ID in browser memory.
3. Export a standard ToxEncryptSave-encrypted .tox backup, not raw private keys.
4. Re-open the encrypted backup **inside the same WASM binary**, and verify
   the same public Tox ID; reject a wrong password.
5. Scrub temporary WASM memory regions after JS copies data.
6. Prove the same operations in an automated Node.js WASM smoke test.
7. Only after the build passes, connect the Dedicated Worker entrypoint into
   a new opt-in browser UI. Do not integrate with the existing login APIs.

## How to build

Dependencies: bash, git, cmake, make, pkg-config, emsdk/Emscripten (emcc,
emcmake, emconfigure, emmake), Node.js >=22.

```sh
cd wasm
npm run test:unit
npm run build
npm run test:wasm
npm run test:browser  # requires npm install + system Chrome/Chromium
```

The script checks exact upstream commits:
- TokTok/c-toxcore `v0.2.23` (`d9ca3c577e5abd4303d180eb5270167b4133ea4c`)
- jedisct1/libsodium `1.0.20-RELEASE` (`9511c982fb1d046470a8b42aa36556cdb7da15de`)

Outputs `dist/tox_identity.mjs` and `dist/tox_identity.wasm` should be
kept as build artifacts until CI succeeds. Do not commit generated binary
files or publish production builds before reproducibility and browser tests.

## Intended browser boundary

The `browser/tox-identity.worker.mjs` Dedicated Worker runs identity
operations in WASM and returns only a public Tox ID or an **encrypted** .tox
backup. No server API is used; passwords are not sent to Cloudflare. The JS
worker code is currently an unconnected experiment, not yet integrated into
the existing React UI or Caddy frontend.

Caveat: JS password strings and temporary decrypted Toxcore memory cannot
be guaranteed absent from runtime snapshots, and the page publisher could
deliver malicious JS. Export is encrypted via the standard original
ToxEncryptSave format, not a new homemade cipher.

## Next risk

A successful identity WASM test does **not** prove TCP or UDP messaging.
Normal browsers have no native socket APIs. The follow-up is a separately
audited virtual-socket adapter plus WSS network bridge and native qTox/aTox
friend request/text tests. Until then, neither the Cloudflare nor Node API
exposes relay routes publicly; no private key moves to a server.

## Browser gate

The Chromium gate launches a **real dedicated browser worker** loading the
compiled Emscripten ES module and .wasm via a loopback HTTP server with a
strict CSP. It checks encrypted backup creation, same-ID restoration and
wrong-password rejection. It never contacts Cloudflare or a Tox relay.
This does not claim network/Tox interoperability and is not integrated into
the existing React login.

## Fifth increment: persistent browser Toxcore instance (offline-only)

`native/tox_session.inc` and `browser/session-client.mjs` expose a
singleton live C `Tox*` with browser-only operations: create, restore
from standard encrypted `.tox`, set/get UTF-8 nickname, calculate the
native iteration interval, call `tox_iterate`, encrypt and export savedata,
and close the instance. The Dedicated Worker runs a bounded timer loop
and stops it on explicit close. Native decrypted savedata is zeroized after
load/save and never sent as a Worker response.

The `test:wasm` suite loads real Emscripten/c-toxcore and verifies
identity and nickname persistence through export/close/reimport; Chromium
`test:browser` repeats it in a real Dedicated Worker, including rejection
of a wrong password.

**Still intentionally offline.** The constructor disables Tox UDP and
provides no working TCP virtual socket / bootstrap nodes. Iteration
alone does not imply peer connectivity. The old Python chat service and
production React login remain untouched. Never advertise this as a
native qTox/aTox-compatible browser messenger until real-network tests pass.

## Sixth increment: native friend-list and outbound text interface

The singleton WASM Tox instance now exposes original `tox_friend_add`,
`tox_friend_add_norequest`, `tox_self_get_friend_list`,
`tox_friend_get_public_key`, `tox_friend_delete` and
`tox_friend_send_message`. The browser wrapper validates Tox address/key
hex lengths, byte-bounds friend requests (921) and messages (1372), and
copies buffers only through the isolated WASM Worker.

Test gates create **two real Tox identities**, add a genuine friend offline,
export encrypted `.tox`, close, reopen, and verify the friend public key
survives. Browser Chromium tests repeat the flow and assert that a message
sent while offline **throws an error rather than claiming delivery**.
`SESSION_ACCEPT_FRIEND` requires explicit user acceptance in the future
UI; the raw API is only for research. Incoming callbacks and native online
messaging are still unimplemented; no claim of qTox/aTox networking.

## Seventh increment: bounded native callback queue

Native friend requests, normal/action text messages, self connection
status, and friend connection status are now registered on the persistent
`Tox*` instance. The C callbacks copy into a **bounded 32-event FIFO**
(1372-byte max payload, zeroized after reading). Drop counts are reported
to the browser rather than silently overwriting events.

`BrowserToxSession.pollEvents()` validates the versioned fixed header,
returns opaque `Uint8Array` payloads (not unsafe implicit UTF-8), and
reports overflow. The Dedicated Worker schedules `tox_iterate()` and
forwards `TOX_EVENT` / `TOX_EVENTS_DROPPED` messages asynchronously.

The real WASM and browser smoke tests currently assert that the callbacks
are registered and polling does not crash *offline*. **No inbound event has
been verified from a real qTox/aTox network peer yet.**

## Eighth increment: native-WASM single-stream virtual TCP proof

`native/tox_virtual_tcp.inc` defines a real, exported C/WASM **single-stream**
virtual TCP FIFO. Native `send` and `recv` have synchronous
nonblocking semantics, explicit partial writes/reads, and `-11` would-block.
Each RX and TX FIFO is capped at 64 KiB. Browser code cannot forge a remote
connection-ready state: `_wtox_vtcp_connected()` runs only after the async
WebSocket gateway handshake. Clean remote EOF allows pending RX to drain;
explicit close/failure zeroizes the buffers. TCP queue acceptance is **not**
Tox delivery acknowledgement.

`browser/native-virtual-tcp.mjs` bridges synchronous WASM I/O to the
existing `openExperimentalTcpTunnel()` asynchronous byte transport.
It retains native TX when the WebSocket send buffer reports backpressure;
it fails closed on RX buffer overflow and protocol/transport errors.
The browser test uses an **isolated research-only Worker**, not the Tox
identity Worker, to avoid turning on arbitrary network egress in the app.

`test:wasm` tests original compiled WASM FIFO ordering, partial reads,
backpressure, clean EOF and failed connection cancellation.
`test:browser` also tests original WASM inside real Chromium Dedicated
Worker through real localhost WebSocket byte framing and echo. The echo
endpoint is loopback-only and never dials external hosts.

**Important limitation:** the original Toxcore `Network_Funcs` is
**not yet injected**. The native FIFO is the auditable primitive on which
that adapter can be built. This does not perform an actual Tox TCP relay
handshake; it does not make the messenger qTox/aTox compatible yet.

## Ninth increment: genuine Toxcore Network_Funcs injection probe

`native/tox_net_probe.inc` creates a **separate test-only Tox instance**
using the pinned original `tox_new_testing()` and custom `Tox_System.ns`
(`Network_Funcs`). Every OS network path (UDP, DNS, listen, arbitrary
system connect) is fail-closed. The single supported fake IPv4/TCP handle
forwards synchronous native `send` / `recv` into the bounded
`tox_virtual_tcp.inc` FIFO with `EWOULDBLOCK` semantics. The native test
calls `ns_socket` / `ns_connect` / `ns_send` / `ns_recv` through
`tox_get_system(tox)->ns`, validates exact byte integrity, and invokes
`tox_iterate()` before closing the Tox instance.

This validates **injection wiring and callback ABI only**: it does not
yet prove that Toxcore's TCP relay machinery opened this socket itself.
The live browser identity remains on the existing offline constructor;
no production network flags are enabled. Real relay handshake, async
socket readiness, destination allowlisting and multi-socket handling
remain future work. The testing API is private and pinned to v0.2.23.
