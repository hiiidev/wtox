# Browser-side Toxcore (research track — NOT implemented)

**Goal:** run actual protocol and cryptography in the browser, interoperate with qTox/aTox, while allowing a minimal VPS proxy to move ciphertext without holding Tox identity keys.

## Why a normal webpage cannot run native Tox directly

c-toxcore expects networking facilities to initiate UDP and TCP sessions with Tox peers/bootstrap nodes and TCP relays. The conventional browser sandbox does **not** expose unrestricted TCP/UDP sockets to normal webpages. WebSocket is a browser-to-*WebSocket server* protocol, not a way to talk directly to a native Tox relay. WebRTC peers do not speak the Tox protocol, and WebTransport datagrams do not grant arbitrary raw UDP socket access.

An exception worth investigating is Chrome's **Isolated Web Apps + Direct Sockets API**, which can expose TCP/UDP to specially installed isolated apps, but that would **not** be an ordinary website and is not cross-browser.

References:
- https://developer.chrome.com/docs/iwa/direct-sockets
- https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API
- https://developer.mozilla.org/en-US/docs/Web/API/WebTransport_API
- https://github.com/TokTok/c-toxcore/blob/master/toxcore/tox.h

## Candidate architecture

```text
Browser:
  WASM c-toxcore + libsodium + virtual TCP/socket adapter
  Tox identity/private keys in browser-only encrypted storage
  local history in encrypted IndexedDB
        |
     WSS/HTTPS (opaque encrypted Tox transport frames)
        |
VPS:
  authenticated TCP tunnel / protocol-aware relay WITHOUT Tox private keys
        |
  original Tox TCP relay + peers qTox/aTox
```

This is a **design direction, not a claim of interoperability**. Successful migration needs a fully functional network adapter for toxcore’s socket abstraction, compatibility with Tox TCP relay framing and bootstrap behavior, and actual end-to-end testing against qTox/aTox. WASM compilation by itself is *not* enough. Prefer reusing c-toxcore's transport abstraction over ad hoc changes to security-critical protocol handling.

## Validation milestones

1. Build libsodium and c-toxcore (or a protocol-compatible core) for browser WASM, with unit tests.
2. Demonstrate stable encrypted Tox TCP relay connection via virtual networking/WSS-to-TCP bridge.
3. Generate and restore Tox savedata solely in browser storage; keys never transmitted to the bridge.
4. Verify sending/receiving an authenticated friend request with qTox.
5. Verify bidirectional text messages against qTox and aTox and cross-browser restart behavior.
6. Harden the relay: per-user authorization, destination allowlist, abuse limits, isolation, quotas, egress audit, no plaintext logging.
7. Account for background limitations: closing/suspending the browser drops transport. No guaranteed offline delivery unless some other encrypted mailbox design is introduced.

## Decision

The current VPS Toxcore path remains the MVP until these milestones are met. Avoid storing a raw private key in a third-party WebSocket relay, even temporarily.
