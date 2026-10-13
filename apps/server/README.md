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
