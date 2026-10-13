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

## Tenth increment: native Toxcore originates a TCP relay connection

The isolated `wtox_network_relay_dial_probe()` creates original
c-toxcore v0.2.23 with a custom `Tox_System.ns` and calls
`tox_add_tcp_relay()` using IANA TEST-NET-2 address `198.51.100.7`.
Only one synthetic TCP socket is permitted. The injected table rejects
DNS, UDP, arbitrary destination ports and OS sockets. It counts **calls
originating from Toxcore**, simulates the gateway's nonblocking connect
completion and runs `tox_iterate()` until c-toxcore itself writes its TCP
relay handshake into the virtual TX FIFO. No real network call is made.

This is a narrower but deeper networking test: it demonstrates that the
native TCP client takes the virtual socket path, NOT that a remote relay
responds, validates a key or delivers messages. Internal Toxcore socket
life-cycle, readiness/backpressure handling, real handshake and multi-relay
support are still pending. The default persistent browser Tox instance
continues to be offline-only.

### Gate before any live transport

CI must verify the *internal-relay* probe on the exact pinned WASM:
original Toxcore's own TCP code must create the virtual socket, request
nonblocking connect and write handshake bytes into the capped native TX
queue. A successful result is only an **offline synthetic relay-dial gate**,
not proof of a completed, authenticated Tox relay handshake. No Cloudflare
Worker, browser identity traffic, public TCP proxy or qTox messaging should
be enabled on the strength of that test alone.

## Eleventh increment: inbound invalid TCP Relay handshake (offline-only)

The native synthetic-relay probe now tests inbound server data from the
**original Toxcore TCP client**: a 17-byte partial reply must remain buffered
without a read; a full 96-byte forged reply must be consumed and rejected;
and a 31+65-byte fragmented forged reply must also be rejected. Original
c-toxcore crypto verifies the response, not the JavaScript transport.
The test additionally verifies Tox stays offline and closes the invalid
connection. All data remains in WASM and the destination is IANA TEST-NET
with a fake Socket; no real network traffic or secrets leave the runner.

Passing these tests is a *negative-case* security result only. It does not
yet confirm a legitimate remote relay handshake or peer interoperability.

## Twelfth increment: locally authenticated TCP Relay response

The isolated `wtox_network_relay_authenticated_probe` reads a real native
Tox client hello, derives the correct Curve25519 shared key from a locally
generated Relay private/public keypair, and encrypts a matching server
response using original Toxcore primitives. The original client must
accept valid full and fragmented responses, while rejecting mismatched
relay private keys or altered authentication tags.

This runs entirely in WASM using a fake TEST-NET-2 socket. No public TCP
relay, actual remote authentication, or qTox/aTox online messaging occurs.

## Thirteenth increment: persistent synthetic Relay client and async transport

`native/tox_research_session.inc` uses an **isolated, persistent**
original c-toxcore instance whose injected `Network_Funcs` objects
remain valid until explicit shutdown. It connects only to the fake
`198.51.100.7:33445` endpoint in memory: OS DNS, UDP, listening
and arbitrary TCP targets remain disallowed.

`browser/relay-research-client.mjs` connects the original native client's
already-CONNECTING socket to an asynchronous test transport using
`NativeVirtualTcp.attachNativeConnect()`, without issuing a second
native begin call. Between discrete `tox_iterate()` invocations,
the transport may deliver a local synthetic encrypted Relay response.
Matching keys keep the test TCP session alive; wrong keys and altered MACs
must close the connection. The native local Relay private key never
leaves WASM and is wiped on close.

`tests/relay-research.test.mjs` validates those steps with real
compiled c-toxcore and asynchronous JS callbacks, including shutdown
while transport readiness is pending. **There is no real external
Relay server, browser app login integration or verified qTox/aTox peer.**
This experiment is not imported by the normal identity Dedicated Worker.

To rerun the full isolated gate locally after compiling original dependencies:
`cd wasm && npm run build && npm run test:unit && npm run test:wasm &&
npm run test:browser`. The GitHub workflow builds and tests in separate
jobs, with the compiled WASM artifact passed between them. No Cloudflare
secrets or deployment steps are needed.

## Fourteenth increment: genuine Chromium Worker / WebSocket / Node TCP Relay fixture

`browser/relay-browser-research.worker.mjs` runs the persistent original
Toxcore with injected `Network_Funcs` in a real **Chromium Dedicated
Worker**. After Toxcore itself requests TCP and creates a 128-byte native
hello, the browser attaches an authenticated localhost WebSocket tunnel.
A strictly local test-only Node TCP fixture returns 96 bytes of synthetic
encrypted Relay ciphertext through the **actual** WS → Node TCP → WS path,
where original Toxcore reads/verifies it on subsequent `tox_iterate` calls.

The test covers matching Relay key, a fragmented valid reply, a wrong
private key and a tampered MAC, in separate Workers. The browser-side
WASM creates the synthetic reply and sends **ciphertext only** to the
loopback fixture before transmitting the client hello. No long-term
private key crosses to Node; neither does any real user identity.
The test-only server is bound to `127.0.0.1`, validates exact origin,
fixed route and fixture token, and **never dials arbitrary destinations**.

**Limitation:** this fixture does not independently possess a real Relay
private key and cannot prove a live remote Relay accepted a connection.
It is research instrumentation, NOT a production gateway or general
proxy. The normal identity Worker and production site do not import it.

## Fifteenth increment: independently keyed Node TCP handshake fixture

`tests/relay-independent.test.mjs` creates an **independent ephemeral
Curve25519 keypair in Node**, keeps its long-term relay secret in Node
memory, and publishes **only the public key** to a single-use Chromium
Dedicated Worker. The pinned native Toxcore client is bootstrapped with
that public key via `wtox_research_start_with_relay_public_key`. Unlike
the prior synthetic echo fixture, **the Node TCP endpoint itself decrypts
the native Toxcore client hello**, using the standard NaCl
X25519/XSalsa20-Poly1305 `crypto_box` primitives, and returns a freshly
authenticated native-format 96-byte Relay handshake response.

The browser's Toxcore verifies the response across the real localhost
WebSocket → Node TCP → WebSocket path, with four independent tests:
successful response, TCP-fragmented successful response, an incorrect
server secret, and a tampered MAC. The latter two must close the native
connection. Native client Tox keys stay in browser WASM; the Node server
private key stays in Node and is zeroized after the test. The test also
asserts that Node independently decrypts all four original client hellos.

**This is stronger than browser-precomputed ciphertext**, but it is still
a minimal research-only cryptographic TCP handshake fixture, not the
full original Tox TCP Relay server state machine or a public relay.
It doesn't prove DHT, relay routing, peer messaging, or qTox/aTox
interoperability. All listeners and TCP destinations are restricted to
`127.0.0.1`; the normal identity Worker and production server remain
unchanged. The fake Tox destination (`198.51.100.7`) is never dialed.

## Sixteenth increment: independently authenticated post-handshake heartbeat

After a valid *independently keyed* TCP Relay handshake in Chromium, the
localhost Node TCP fixture now derives a separate ephemeral session key,
tracks both direction-specific 24-byte big-endian nonces, and sends a
**length-prefixed, NaCl-authenticated TCP PING** (packet type 4). The
original browser Toxcore must decrypt it and return an encrypted TCP
PONG (type 5) containing the **identical 8-byte identifier**. Node
independently decrypts and validates that native PONG, with separate
tests for standard and TCP-fragmented handshake replies.

The browser research Worker waits until the Node-side post-handshake
PONG proof is confirmed, rather than treating an open socket as a
successful protocol test. Existing wrong-key and tampered-MAC handshake
negative cases remain mandatory. All sockets remain bound to
`127.0.0.1`; no actual public Relay, forwarding connection, friend
request or qTox/aTox exchange is claimed. The normal identity Worker
and production system never load the fixture.

### Bidirectional heartbeat correction

In the first post-handshake browser run, original c-toxcore immediately
initiated its own encrypted TCP PING. The minimal Node fixture initially
treated that legitimate packet as unexpected and disconnected. The
independent Node fixture now decrypts a client-initiated PING and returns
an authenticated PONG with the same 8-byte identifier, incrementing the
Node-to-client nonce. It then initiates its **own** PING using the next
nonce; original Toxcore returns its own authenticated PONG using the
next client-to-server nonce. The browser and Node assertions require
both independent directions to succeed.

This remains local loopback Tox TCP control-plane research, not peer
message or public Relay interoperability.

## Seventeenth increment: encrypted TCP route-request and synthetic notification gate

The test-only persistent original Toxcore instance now uses
`nc_get_tcp_c` and **original** `new_tcp_connection_to` /
`add_tcp_number_relay_connection` to register a single synthetic peer
against the already-confirmed virtual TCP Relay. Native Toxcore itself
sends the encrypted `ROUTING_REQUEST` (packet type 0) from the TCP
connection machinery; the independent Node fixture authenticates the
target key and replies with `ROUTING_RESPONSE` (1, route id 16) and
`CONNECTION_NOTIFICATION` (2, id 16), with distinct encrypted frames
and incremented nonces. The Chromium test waits for the original native
TCP route state to report one registered connected relay.

This is a deliberately **artificial route notification** from one
localhost fixture. There is no second actual Tox client, no real friend
online status, no payload forwarding or end-to-end messaging. The
normal browser identity Worker still has no connected native route.

## Eighteenth increment: independently authenticated routed binary round-trip

After the independently keyed Relay handshake, bidirectional encrypted
PING/PONG and synthetic route registration, original c-toxcore
`TCP_Connections` now calls `send_packet_tcp_connection` to send a
six-byte binary payload (including NUL and high-bit bytes). The independent
localhost Node Relay decrypts it using its own ephemeral session key, checks
the exact route id and binary payload, and sends a separately encrypted
routed data response. Original c-toxcore dispatches that response to an
isolated test-only bounded callback, where the Chromium Worker verifies
all six bytes without text decoding.

The research runner temporarily replaces the normal Net_Crypto TCP data
callback **after** the synthetic route is online. This cannot be used for
real friend messaging and is never imported into the normal identity
Worker. The fixture intentionally has access to the routed plaintext:
TCP Relay session encryption is NOT Tox end-to-end friend encryption.
This proves bidirectional **transport data framing and dispatch**, not
full Tox peer handshaking, end-to-end messages or qTox/aTox compatibility.
All TCP/WS listeners remain loopback-only and no Cloudflare/VPS is used.

## Nineteenth increment: two independent native Tox TCP route endpoints (test only)

A NEW, separate `relay-dual.test.mjs` test launches **two Chromium Dedicated
Workers**, each with its own WASM module, freshly generated native c-toxcore
Tox instance and original DHT key. The localhost Node TCP fixture holds
only its own ephemeral Relay secret. Each original native Toxcore authenticates
that Relay, registers a route to the *other* client's real native DHT public
key, and receives a server-generated connection notification only after both
reciprocal routes have registered.

Each original `TCP_Connections` sends a unique binary payload; the Node
fixture decrypts the Relay transport wrapper, forwards the data to the
*opposite* authenticated TCP socket with the receiver's session key, and each
original native TCP data callback verifies the opposite client's bytes in
Chromium. The fixture explicitly fails unexpected packets and forbids
arbitrary destinations; two separate clients must authenticate and route.

This is **two native WASM client transport endpoints**, NOT two full online
Tox friends. Both research clients deliberately replace the normal
`Net_Crypto` TCP callback with a small test inbox. The Node Relay can inspect
the routed payload, which is **not** end-to-end encrypted as friend text.
No qTox/aTox interoperability, DHT discovery, user-facing login, production
gateway or remote TCP network is enabled or implied.

## Twentieth increment: original Net_Crypto end-to-end connection gate

A separate `crypto` mode of the localhost dual-Chromium fixture creates
two independent original c-toxcore `Net_Crypto` instances. Both clients
publish only their native DHT and real public keys to the test orchestrator,
authenticate to the Node-owned TCP Relay, then invoke original
`new_crypto_connection` and register reciprocal TCP routes.

Unlike the prior transport-only binary proof, the original Net_Crypto TCP
data callback remains installed. The research runner observes original
connection-status callbacks and only allows lossless
`write_cryptpacket` payloads after authenticated peer-to-peer crypto status.
The test-owned Node Relay decrypts the outer transport layer to route packets
but does **not** receive either client's ephemeral Net_Crypto secret key or
decrypt the inner cookie/handshake/session payload. Each native client's
Net_Crypto data callback must receive the other client's binary data.

**This is an isolated low-level E2E research gate**, not the public Tox
friend API: `tox_friend_send_message`, `tox_friend_message`, friend
acceptance, restart/persistence and qTox/aTox online interoperation remain
separate acceptance criteria. Original online friend status is not claimed,
and no production Worker or VPS is modified.

## Twenty-first increment: original Tox friend text over dual native clients

An isolated third Chromium test mode builds on the authenticated two-client
TCP Relay test. Both independent native Tox instances use the **public**
identity and DHT keys that each Toxcore itself generates. Each adds the
other with original `tox_friend_add_norequest`, and supplies the other native
DHT key to the existing `Friend_Connections` discovery callback. Once
the native friend manager creates its own `Net_Crypto` connection, the
existing research Relay is attached to that connection, with all original
Messenger and `Net_Crypto` packet handlers left installed.

The test waits for original `tox_friend_get_connection_status` and a
genuine `tox_callback_friend_connection_status` online event on BOTH
clients before calling `tox_friend_send_message`. It then requires the
opposite client to receive the exact text through original
`tox_callback_friend_message` (not a transport or crypto test callback).

This establishes a **local two-native-client friend message acceptance
gate**, not Internet-discovered or public-client interop. The test deliberately
injects public DHT discovery information, allows only two loopback clients,
and uses a Node-owned, test-only TCP Relay. No browser production transport
or Cloudflare worker is added; no qTox/aTox interoperability, remote Relay,
savedata reconnect or arbitrary contact discovery is claimed.

## Twenty-second increment: encrypted identity restart and friend reconnection

The fourth `relay-dual` test mode (`restart`) exercises a genuine
**destroy → restore → reconnect** lifecycle for **two independent original
c-toxcore instances** inside separate Chromium Workers. Round one adds one
real native friend per identity, establishes original Messenger friend-online
callbacks and exchanges authenticated native friend text.

Each instance exports only a **standard ToxEncryptSave encrypted .tox**
savedata blob. The temporary plaintext savedata and the password in native
memory are wiped after use. The Worker is terminated, and the localhost Relay
test waits for *all* original WebSocket/TCP sockets and sessions to drain.
Round two creates **new Workers and new WASM modules**, rejects an incorrect
backup password, decrypts each standard encrypted backup **inside WASM**,
and reconstructs an original `tox_new_testing` instance with the restored
savedata. The test verifies unchanged native real public identity keys,
exactly one persisted native friend with the matching public key, and does
not call `tox_friend_add_norequest` on the restored instance.

The fixture supplies only the fresh peer **public** DHT key to normal
`Friend_Connections` discovery, requires a new encrypted Relay handshake,
both original Messenger friend-online callbacks, and a *different* second
round of bidirectional `tox_friend_send_message` text delivered through
`tox_callback_friend_message`. Node must observe two new original TCP
handshakes and reciprocal routes each round and no rejected protocol packets.

This is a strictly isolated two-browser-native-client test. A fixed
test-only password and a Node-owned localhost Relay are used only for CI;
no production identity secrets, public Relay access, remote qTox/aTox
interop, Cloudflare Worker deployment or VPS operations are involved.
Restoring friends in this controlled scenario does not prove public
network peer discovery or cross-client interoperability.

## Twenty-third increment: independent ORIGINAL c-toxcore TCP Relay compatibility gate

The previous `relay-dual.test.mjs` proves native browser Toxcore's behavior
against a separately written Node TCP Relay protocol fixture. To distinguish
a fixture-specific success from interoperability, the new
`relay-upstream.test.mjs` builds an **unmodified upstream c-toxcore
v0.2.23 `TCP_server.c`** into a Linux-native executable, independently
of the already-built browser WASM `tox_identity.wasm`.

The harness in `native/tox_relay_loopback.c` calls original
`new_tcp_server` and `do_tcp_server` and changes only the native
`Network_Funcs.bind` callback to restrict listening to `127.0.0.1`.
Its private Relay key never leaves the native process; only the
32-byte public Relay key is given to the two isolated Chromium Workers.

Node serves test-only local HTML/JS and bridges authenticated browser
WebSocket frames byte-for-byte to independent TCP sockets connected to that
native server. Crucially, this bridge **does not derive session keys,
authenticate Tox clients, decrypt Tox frames, synthesize a routing success
notification, echo application payloads or route Tox packets**. All such
operations are performed by the unmodified native upstream Relay.

The fixture then reuses the existing real Messenger friend-mode test and
the two-round encrypted savedata `restart` test, requiring true original
friend-online callbacks and both directions of
`tox_friend_send_message` / `tox_callback_friend_message`. The
restored-round test requires four independently authenticated native TCP
sessions across two separate Worker lifecycles.

Both upstream source pins are verified before the build, and the native
executable is built only inside CI. No public listener, Cloudflare Worker,
production VPS or normal web UI import is required. This test does **not**
establish qTox/aTox interoperability, remote Relay accessibility, or
public DHT/onion peer discovery: those remain explicit future gates.

## Twenty-fourth increment: independent Linux Tox ↔ Chromium WASM friend messaging

This new cross-runtime fixture complements rather than replaces the earlier
two-WASM-client and original native TCP Relay tests. CI builds three separately
executing endpoints from fixed upstream c-toxcore v0.2.23:

- The original `TCP_Server.c` Linux process with a loopback-only listener.
- An independent `tox-linux-peer` Linux process using public
  `tox_new`, `tox_add_tcp_relay`, `tox_friend_add_norequest`,
  `tox_friend_send_message` and native friend callbacks, using REAL OS TCP.
- A fresh Chromium Dedicated Worker with the original c-toxcore WASM client,
  using browser WebSocket and virtual TCP Network_Funcs.

Node is only a loopback WebSocket-to-TCP byte tunnel for the WASM side. The
Linux client connects directly to the original native Relay without a Node
Tox protocol handler. It is **not** an emulated second browser client and
neither Node nor the Relay decrypts Tox end-to-end friend text.

The test exchanges each peer's **public** DHT and identity keys over the
isolated fixture, verifies distinct native identities, waits for both real
friend-online callbacks, and requires cross-runtime bidirectional real Tox
friend text from the original receive callbacks. The test keeps public
peer discovery artificially seeded because browser UDP/DHT/Onion is not
implemented yet. Thus **it does not prove qTox/aTox binary interoperability,
unsupervised public discovery or production gateway readiness**. No Cloudflare
or VPS is involved. The fixture is loopback-only and never available in the
normal production application.
