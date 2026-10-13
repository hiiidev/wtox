# wTox v1 — Toxcore WASM virtual network RFC (research, not implemented)

**Status:** design proposal on `v1`; not a connected Tox client.
**Security boundary:** the browser owns the Tox long-term key and runs
original Tox packet crypto. Gateways only see Tox transport ciphertext and
connection metadata; they must not accept .tox savedata or plaintext.

## What upstream actually provides

c-toxcore **v0.2.23** separates OS socket operations behind
`toxcore/net.h`'s `Network` / `Network_Funcs`. The callbacks include
`socket`, `connect`, `send`, `recv`, `recvbuf`, `close`,
`socket_nonblock`, `getsockopt`, `setsockopt`, `getaddrinfo`,
`freeaddrinfo` and UDP-oriented `sendto` / `recvfrom`. Their concrete
native implementation is in `toxcore/os_network.c`.

`toxcore/tox_private.h` exposes `Tox_System.ns` and
`tox_new_testing()`, which can inject a different `Network` instance.
**This is a private/testing API, not a stable public extension point.**
The experiment should first verify the exact pinned release at compile
and runtime. For a durable production solution, audit an upstream change
or a narrow, documented source patch; do not silently depend on private
ABI across c-toxcore upgrades.

Upstream source of truth:
- https://github.com/TokTok/c-toxcore/blob/v0.2.23/toxcore/net.h
- https://github.com/TokTok/c-toxcore/blob/v0.2.23/toxcore/tox_private.h
- https://github.com/TokTok/c-toxcore/blob/v0.2.23/toxcore/os_network.c

## Browser side: nonblocking virtual TCP sockets

1. All native socket calls executed inside WASM return **synchronously**.
   JavaScript WebSockets are asynchronous. Never `await` a WebSocket
   from a synchronous C `send()`, `recv()` or `connect()` call.
2. Maintain a bounded per-socket state machine:
   `CREATED -> CONNECTING -> CONNECTED -> CLOSING -> CLOSED`.
   `connect()` queues an operation and returns the platform-equivalent
   nonblocking in-progress result. The callback must not claim CONNECTED
   until the gateway confirms a TCP connection is established.
3. `send()` queues raw **native Tox TCP bytes**, not wTox message JSON,
   respecting partial-write semantics and a per-socket high-water mark.
   `recv()` drains previously received bytes in order, or reports
   would-block if no bytes are available. Preserve exact stream ordering.
4. The browser WebSocket receives bytes asynchronously and fills bounded
   receive buffers **between** invocations of `tox_iterate()`. Do not
   reenter Toxcore from an asynchronous WebSocket callback.
5. Expose only a small, integer, local socket handle to C. Never pass a
   JavaScript object pointer, credential, hostname or arbitrary destination
   from untrusted web UI directly to the gateway.
6. Explicitly model half-close, failed connection, timeouts, retries,
   socket reuse, buffer high-water marks, malformed frames and peer close.

The existing `wasm/browser/tcp-tunnel.mjs` and
`apps/server/src/experimental-tcp-bridge.ts` prove byte fidelity to
a loopback TCP echo server, but **only one fixed connection per WebSocket**,
with no virtual OS socket table and no native `Network_Funcs` injection.
Those tests do not prove native Tox relay interoperability.

## Gateway: do not build an arbitrary socket proxy

First experiment: one **operator-approved** public IPv4 literal + port +
Tox relay key; no URLs, DNS hostnames, private/local IP targets, or
user-supplied arbitrary destinations. A per-device authenticated,
one-time access grant (NOT an embedded long-term bearer token) authorizes
a bounded session with origin checks, byte/connection quotas and expiry.

For multi-relay support, define protocol **v2** instead of repurposing the
current v1 TCP payload type. V2 must include session ID, socket ID,
`OPEN` / `OPEN_RESULT` / `DATA` / `CLOSE` / `ERROR` control
messages, a strictly validated relay-directory entry ID, and explicit
backpressure. The gateway must never trust a requested address and must
pin destination host+port+key to a server-maintained allowlist.

A server-approved relay *key* must also be verified by native Toxcore's
encrypted handshake. The gateway's allowlist is an authorization rule,
not proof that the remote peer possesses that key.

Cloudflare: outgoing TCP only, subject to Workers socket limits and
lifetime; there is no raw native UDP socket API in Workers. Self-hosted
Node may later support UDP/DHT/NAT traversal through a **separately
designed** per-destination virtual datagram transport. A fixed-destination
UDP echo module alone cannot support DHT peer discovery.

## Suggested incremental proof gates

A. `Network_Funcs` mock, compiled with original Toxcore WASM: verify
   constructor, connect-in-progress, buffered read/write, close and
   would-block semantics with deterministic fake events.
B. Genuine TCP socket via localhost test relay and an isolated Worker
   session, checking byte ordering, connection failure, reconnection and
   no browser-side secrets sent to the gateway.
C. Connect to an independently configured **real** Tox TCP relay with
   native handshake/key verification and `tox_self_connection_status`.
D. Interoperate with a genuine qTox/aTox peer: request, acceptance,
   both directions text and restart/recovery using the same .tox ID.
E. Hardening: concurrent peers, 3G/mobile wake/suspend, connection loss,
   quotas, origin/device auth, SSRF/abuse checks, and a security review.

**Never mark qTox/aTox compatibility complete at gates A or B.**

## Operator deployment plan

- Continue local CI development on `v1`. Do **not** deploy Cloudflare
  automatically or retry authorization error 10000.
- When a live test is essential, the project maintainer will create
  a separate `wtox-v1-staging` Worker in the intended account and
  authorize only that Worker for deployments.
- No changes to `main`, the production VPS/domain, or existing Tox keys.

## Implemented standalone primitive (not yet Network_Funcs)

The single-stream `wasm/native/tox_virtual_tcp.inc` exported from original
c-toxcore/libsodium WASM implements bounded synchronous nonblocking read/write
queues. `wasm/browser/native-virtual-tcp.mjs` connects the queues to the
existing explicit opt-in browser WebSocket tunnel. Genuine compiled WASM and
Chromium tests drive loopback bytes through the adapter, covering EWOULDBLOCK,
backpressure, packet ordering, EOF and failed connections.

Next step: inspect c-toxcore's private `Tox_System.ns` injection contract,
provide a **separate test-only** `Network_Funcs` table backed by virtual
handles, and test real Toxcore calling these operations. No browser networking
will be enabled in the production identity Worker before that audit.

## First injected Network_Funcs test gate

Added a separate `wtox_network_injection_probe` inside original compiled
WASM. It creates a temporary `tox_new_testing` with custom
`Tox_System.ns` and a complete, closed-by-default `Network_Funcs` table.
Only a fake TCP socket handle can call the bounded WASM virtual TCP queue;
no host DNS, native OS TCP or UDP are ever reached. All calls are through
the `Network` pointer attached to a real Tox instance, and `tox_iterate`
still executes on that instance.

This is intentionally below the *real handshake* milestone: Toxcore's
internal TCP client has not initiated an actual connection, and the
nonblocking connect completion/get- and set-sockopt semantics still need
to be implemented and tested for it.

## Internal Toxcore TCP-client-originated test gate

After verifying `tox_new_testing` callback ABI, a second isolated probe
calls original `tox_add_tcp_relay()` with TEST-NET-2 `198.51.100.7`
and a synthetic key. Its custom `Network_Funcs` permits only one fake
TCP socket and port 33445. The JS/browser bridge does not open and
no OS egress occurs. Native c-toxcore is expected to initiate the connect,
transition through EWOULDBLOCK, and emit encrypted handshake bytes into
the bounded WASM transmit FIFO. This stops short of receiving a real
relay handshake or authenticating a remote key.

## Negative-case relay response gate

A test-only C function pushes incomplete, forged-complete and fragmented
forged-complete server handshake frames (fixed 96 bytes for the pinned
c-toxcore version) into the injected virtual receive FIFO and then lets
the original Toxcore client execute its normal TCP state machine. A
partial handshake must wait; malformed complete handshakes must be read,
rejected and disconnected. This is a bounded deterministic test with no
OS network access and **not** a successful encrypted handshake.

## Offline positive cryptographic handshake gate

Original Toxcore should verify an authenticated synthetic server response
from a local private key matching the advertised fake Relay public key.
A fragmented valid response must also work, while responses encrypted
under a different private key or modified MAC must be disconnected. This
proves local crypto protocol handling, not remote TCP or peer interop.

## Persistent research handshake runner

A long-lived, strictly single-socket Tox research instance now keeps its
custom `Tox_System.ns` allocated for its entire lifetime. JS attaches an
async transport **after** native Toxcore initiates connect, pumps the
client's authentic handshake, and asynchronously injects a locally
generated encrypted Relay response before the next native iterate.
Tests cover valid reply, wrong secret, altered MAC and cancelled async
readiness. This validates asynchronous scheduling and native socket
ownership; it remains a synthetic offline Relay, not production WSS
or a real remote TCP relay.

## Dedicated Chromium Worker + real local WS/TCP handshake gate

A new isolated browser test runs original c-toxcore WASM with persistent
injected `Network_Funcs`. Its native Relay client sends the actual client
handshake into a real WebSocket which forwards through a localhost Node
TCP socket. That test-only TCP endpoint returns locally prepared synthetic
authenticated ciphertext via the reverse WebSocket path. Original Toxcore
then processes it on a later iteration. Negative controls use wrong key
and altered MAC; a split valid frame also exercises asynchronous delivery.

The synthetic response is constructed inside browser WASM and uploaded as
**ciphertext-only** to a same-origin, loopback test fixture. This proves
transport scheduling and native validation but expressly does **not**
constitute a remotely independently authenticated Tox Relay handshake.

## Independent cryptographic peer gate

After the browser-generated synthetic-response test, a separate
loopback Node TCP process must now own a newly generated Relay
long-term X25519 secret, publish only its matching public key, decrypt
the original WASM Tox TCP client's 128-byte authenticated hello, and
send its own 96-byte response over WebSocket/TCP. Positive and negative
tests cover valid, fragmented, wrong-secret, and tampered-MAC responses.
No Node-owned private key, user identity, savedata or decryption key is
transferred to the browser; no client secret is sent to Node beyond the
public-key-encrypted original protocol bytes.

This remains a **minimal independent handshaking test fixture**,
not a production Tox relay daemon; full routing and genuine qTox/aTox
peer interoperability are separate future acceptance gates.
