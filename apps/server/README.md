# wTox v1: self-hosted Node.js adapter

This is the **parallel development implementation**, on branch v1 only.
It shares the public API and ciphertext mailbox contract with Cloudflare.
The only currently public routes are:
- GET /api/v1/health
- GET /api/v1/capabilities

Identity, mailbox and Tox relay routes return HTTP 501 until authenticated
device signatures and client-side end-to-end encryption are finished.

## Local

Requirements: Node.js >=22.13, npm for development TypeScript tools.
Node 22 has experimental built-in node:sqlite; the Docker image uses Node 24.

```sh
cd apps/server
npm install
npm run typecheck
npm test
npm start
curl http://127.0.0.1:8787/api/v1/health
```

## Docker Compose

From repository root:

```sh
docker compose -f deploy/compose.v1.yml up --build -d
curl http://127.0.0.1:8787/api/v1/capabilities
```

By default ports only bind to 127.0.0.1. No public chat is enabled.
Add a hardened TLS reverse proxy only after auth and routing are complete.

Data is stored in named volume `wtox_v1_data` at /data/mailbox.sqlite.
Do not delete the volume after adding real encrypted messages. The existing
Python backend's SQLite data is unrelated and is **not migrated**.

## Security boundary

SQLite only receives envelope-shaped opaque data through an *internal*
store and no public mailbox endpoint. This is not E2EE by itself:
the client encryption protocol, verified recipient keys, anti-replay and
authenticated sender/recipient access are still unimplemented.

Switching between Cloudflare and self-hosting requires later data export,
key-directory migration and inbox replay/ACK strategy. The shared types
only guarantee API shape parity, not completed seamless migration.

## Local TCP-only WebSocket research bridge

By default `/__wtox_v1_experimental/tcp` is **disabled**, and public
`/api/v1/relay` still returns 501. The experiment is permitted ONLY if
`WTOX_EXPERIMENTAL_TCP_BRIDGE=1` AND `HOST=127.0.0.1`.
Set `WTOX_EXPERIMENTAL_ORIGIN=http://127.0.0.1:<page-port>`,
`WTOX_EXPERIMENTAL_TOKEN=<32 random bytes as 64 hex>`,
`WTOX_RELAY_HOST=<admin-approved public IPv4 literal>`,
`WTOX_RELAY_PORT=<port>`, `WTOX_RELAY_PUBLIC_KEY=<64 hex>`.

The WebSocket handshake validates exact Origin; a token must be received as
the first message before dialing a fixed operator-approved TCP endpoint.
Do not put the token in a URL or public website bundle.
Limits: 4 concurrent sessions, 5s authentication deadline, 120s connection
lifetime, 8MiB total traffic/session, 64KiB binary chunks, 512KiB backlog
cap. This is insufficient for public deployment without device-signed auth,
per-IP controls, and security review.

The test connects the `wasm/browser/tcp-tunnel.mjs` byte adapter through
the bridge to a localhost TCP echo server using test-only socket injection.
That is NOT a Toxcore socket adapter, and does not prove qTox/aTox interop.
