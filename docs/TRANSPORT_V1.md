# wTox v1 transport research: self-host UDP vs Cloudflare TCP

Status: **internal transport primitives only** (NOT integrated with browser
Toxcore, NOT a working Tox gateway, NOT a production UDP relay).

## Underlying constraints

- A regular browser cannot dial arbitrary native TCP or UDP sockets. The
  browser's WASM Toxcore needs a virtual socket adapter using a secure,
  authenticated WSS transport; WSS is its browser-to-gateway connection,
  not native Tox UDP.
- A self-hosted Node.js server can open native UDP (node:dgram) and TCP
  (node:net) sockets. Outbound UDP is available in Docker by default,
  but P2P UDP on a publicly reachable socket needs firewall/port/NAT mapping
  and per-client addressing design.
- Cloudflare Workers `connect()` supports outbound TCP, not general purpose
  native UDP socket egress or arbitrary UDP listeners for Workers.
- Toxcore permits UDP and TCP-only relay mode. Native Tox UDP uses DHT,
  peer discovery and NAT traversal; TCP is a fallback/relay transport.
  A TCP tunnel carrying *browser protocol frames* over TLS/WebSocket is
  not a native Tox TCP connection until translated into Tox TCP wire bytes.

## What has been built

- `packages/protocol/src/transport-frame.ts`:
  version 1 binary frame: `u8 version | u8 type | u32 big-endian length |
  exact bytes`. Type 1 is TCP *stream fragment* (<=64 KiB), type 2 is
  an atomic UDP *datagram* (<=1400 bytes). One frame per WS binary message.
  UDP destination is intentionally not user-selected per packet.
  There is no handshake/authentication in this version.
- `apps/server/src/udp-transport.ts`:
  an internal-only, short-lived, connected UDP socket to a **single operator
  allowlisted public IPv4 Tox endpoint**, with strict sender IP/port checks,
  datagram size cap, per-second rate caps and a two-minute max lifetime.
  It never accepts an arbitrary user-supplied endpoint from the public API.
  The endpoint public key is an allowlist identifier; this module does not
  cryptographically verify Tox peers on the network. That must happen in
  WASM Toxcore.
- Tests exercise size limits, safe destinations, rate/expiry, binary
  framing and a real **localhost UDP echo** using Node dgram.

## Limits and security gates

1. No public UDP or WSS endpoint is enabled. The API returns 501 for relay.
2. Exact allowlisted bootstrap/relay endpoints do NOT yet allow arbitrary
   DHT-discovered peers, hole punching, or fully compatible UDP Tox.
3. Session-level authentication, origin checks, byte quotas across concurrent
   sessions, per-IP quotas, replay defense and endpoint permissions must be
   implemented before opening WSS-to-UDP.
4. The session takes one fixed UDP destination; a full native Tox virtual
   UDP socket needs dynamic destination metadata safely bound to Toxcore,
   validation of incoming mappings and anti-abuse controls. The browser
   virtual socket/WASM integration does not exist yet.
5. Do not open arbitrary UDP forwarding. It can enable SSRF, reflection,
   amplified DDoS, and cloud-network egress abuse.
6. End-to-end encryption happens in browser Toxcore; WSS should still use
   TLS and authenticate the gateway access, but the gateway must not
   receive user Tox private keys or plaintext.
7. A localhost UDP echo test demonstrates the Node runtime and basic
   datagram I/O only. It is **not** proof of Tox protocol interoperability.

## Real interoperability acceptance test

- Emulation/proof: native toxcore encrypted UDP bootstrap through the
  virtual socket via WSS to self-hosted gateway, keys held only in browser.
- Functional: native qTox/aTox friend requests and bidirectional text.
- Network: UDP-capable path, NAT traversal, loss/reorder, disconnect/retry,
  UDP-blocked fallback to native TCP relay.
- Platform: Linux VPS and Docker with explicit exposed UDP port, modern
  desktop browsers and mobile PWA behavior.
- Security: no secrets or readable chat in Node/Workers logs, authenticated
  device access, packet rate limits, anti-replay and independent review.

Further information:
https://github.com/TokTok/c-toxcore/blob/master/toxcore/tox.h
https://developers.cloudflare.com/workers/reference/protocols/
https://developer.mozilla.org/en-US/docs/Web/API/WebTransport_API

## Fourth increment: local WebSocket to TCP echo test

`apps/server/src/experimental-tcp-bridge.ts` is a **disabled-by-default**,
localhost-only bearer-protected experimental WSS/TCP forwarding route.
`wasm/browser/tcp-tunnel.mjs` implements the binary byte-stream
browser API. An integration test verifies real Node WebSocket connections
and byte fidelity through a loopback TCP echo server. The real Tox TCP relay
destination remains operator-fixed and public-IP allowlisted. None of this
connects to c-toxcore's native socket abstraction, and no real Tox peer
handshake has been validated. Cloudflare's public relay endpoint is disabled.
