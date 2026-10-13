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
