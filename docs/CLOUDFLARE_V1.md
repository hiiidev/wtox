# v1 branch — Cloudflare-first, browser-held Tox keys

Status: **initial Worker foundation only; not a secure chat release.**
This branch is independent of `main`: do not merge, overwrite production,
or decommission the VPS while the interoperability experiments are incomplete.

## Non-negotiable requirements

- Browser/PWA is the client; no required native app.
- Retain standard .tox identity backup compatibility and test against real
  qTox/aTox clients.
- No user's native Tox private key, raw .tox savedata, message decryption key,
  or decrypted attachment goes into the Cloudflare environment.
- Two modes: native Tox compatibility via browser WASM + TCP bridging,
  and wTox-only authenticated E2EE mailboxes for asynchronous delivery.
- Never silently downgrade an established E2EE conversation to another mode.
- Push notifications contain no sender identity or message text.
- Preserve existing .env, WTOX_MASTER_KEY, SQLite, and Docker volumes in main.

## Server/runtime boundaries

- TypeScript/ES modules and Node.js tooling; deploy to Workers runtime.
- Browser: c-toxcore/libsodium WASM, adapter for TCP-only Tox transport,
  local .tox import/export, non-extractable device encryption keys as an
  additional protection layer, encrypted IndexedDB.
- Cloudflare Workers: API, authenticated key directory, narrow WSS/TCP bridge.
- Durable Objects: per-recipient encrypted inbox, ACK, replay defense, quotas,
  expiry alarms and eventually online device signaling.
- D1: authenticated public device key directory (no private keys).
- R2: client-encrypted attachment chunks; keys sent only via E2EE envelope.
- Web Push: generic notification only; no content in push payload.

## Next milestones and hard acceptance criteria

1. **WASM feasibility**: build toxcore with libsodium and a browser TCP adapter.
   Check real TCP-only friend requests, bidirectional text, reconnection and
   file transfer with qTox and aTox. No claim of compatibility before tests.
2. **Authenticated mailbox**: client device registration and key verification,
   recipient-signed allowlist, authenticated & replay-resistant requests;
   only then connect the public Worker routes to internal Durable Objects.
3. **E2EE**: reviewed authenticated session protocol, encryption before upload,
   per-device key lifecycle and safe failure behavior; no homebrew cipher.
4. **Push/R2**: server receives opaque message event, sends generic Web Push,
   stores encrypted attachment; push/browser background delivery best effort.
5. **Migration**: local legacy .tox export/import, history transfer testing,
   protect old savedata, device trust prompts, rollback drills.
6. **Security/reliability**: CSP, hostile-server JS delivery limitation,
   egress abuse testing, DNS rebinding defenses, origin policies, load
   limits, Cloudflare quotas/pricing tests, native interop CI.

### Fundamental limitation

When the wTox webpage is closed and no user's Tox endpoint remains online,
a native qTox/aTox friend cannot deliver a normal Tox message to a Cloudflare
encrypted mailbox unless an additional sender-side protocol exists. Only
wTox-to-wTox enhanced mode can guarantee the *design ability* to enqueue
asynchronous ciphertext (actual service availability still depends on
Cloudflare and push platform behavior).

Cloudflare Workers are not a native UDP Tox node or unrestricted server
socket listener. Their outbound TCP and WebSocket APIs must be tested with
real relays; a successful WASM compilation alone does not establish support.

## Second increment: portable internal mailbox and Node.js adapter

Added `packages/protocol` for common API and envelope validation;
Cloudflare Durable Objects still use local SQLite, while self-hosted
`apps/server` implements the same store contract using node:sqlite.
Both have the same public health/capabilities API and **both keep private
mailbox and Tox bridge endpoints disabled** until cryptographic auth exists.

Self-hosted Compose: `docker compose -f deploy/compose.v1.yml up --build -d`.
It binds to 127.0.0.1 and is not a production chat server. Test compilation,
mailbox isolation, expiration, idempotency, quotas, and fail-closed routing
via branch-specific CI. No existing Python storage is migrated.

Next gate: build an emscripten c-toxcore WASM proof and test real TCP-only
Tox relay interoperability against native qTox/aTox. Until then there is
no legitimate claim of browser-side native Tox compatibility.
