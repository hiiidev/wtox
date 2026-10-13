# wTox v1: Cloudflare Workers backend (initial foundation)

This directory is **only in the `v1` branch**. It does not replace the
running Python/FastAPI backend in `main` and is not production chat software.

## Runtime decision

Use Node.js 22+ for developer tooling (npm, tests, Wrangler, TypeScript), but
deploy the backend into the **Cloudflare Workers runtime**, not an Express or
Node.js HTTP server. For compatibility dates after 2026-08-04, Workers provide
Node.js API compatibility by default; prefer native Web APIs and Workers
bindings, because not every Node.js API is operational on Cloudflare.

## Implemented now

- `GET /api/v1/health`: public backend health response.
- `GET /api/v1/capabilities`: truthful feature status.
- `EncryptedMailbox` Durable Object: **internal-only** SQLite-backed opaque
  envelope storage, duplicate IDs, 500 pending message cap, seven-day TTL,
  confirmation delete, expiry alarm.
- Fail-closed behavior: public mailbox, relay, identity, and push routes return
  HTTP 501. NO authentication, public mailbox upload, or end-to-end encryption
  is implied to be implemented.
- Node.js routing unit tests; development can run without existing VPS keys.

## Local development

From `cloudflare/`:

```bash
npm install
npm run typecheck
npm test
npm run dev
# open http://localhost:8787/api/v1/health
```

Cloudflare account access is needed for deployment:

```bash
npx wrangler login
npm run deploy
```

Deploy is **manual**. This project deliberately does NOT bind the existing
production hostname, import VPS credentials, or deploy the old UI. There is
no static assets binding yet; serving the existing frontend would present an
incompatible, unsafe login experience. A future release will integrate the
rebuilt WASM/PWA client after authenticated APIs exist.

The first `npm install` creates `package-lock.json`. Commit that lockfile
before using this as a production build pipeline.

## Security boundaries and next gates

1. Tox savedata generation and decryption run in browser WASM; no `.tox`
   upload to Workers, no `WTOX_MASTER_KEY` on Cloudflare.
2. The Worker-to-Tox TCP bridge must remain disabled until allowed relay
   destinations, TCP frame streaming, rate limiting, egress controls, and
   actual qTox/aTox interoperability are verified.
3. Before exposing any `EncryptedMailbox` method publicly, add signed device
   identities, recipient-approved sender keys, request nonce/replay defenses,
   quotas, and external security review. The server cannot establish E2EE
   solely because the payload field is named ciphertext.
4. Do not auto-fallback from an authenticated E2EE session to native Tox
   plaintext-as-seen-by-the-user without the user's explicit consent.
5. Real Web Push is future work. A generic event is **not** proof that native
   Tox delivered a message when all original Tox clients are offline.
6. Cloudflare has access to some metadata (network requests and timestamps),
   and malicious delivered JavaScript could still compromise browser data.

See `docs/CLOUDFLARE_V1.md` for the migration and acceptance plan.

## GitHub Actions 测试环境部署\n\n在 v1 分支使用 GitHub Actions 手动部署到独立 Worker，具体步骤见\n[Cloudflare staging 部署手册](../docs/CLOUDFLARE_STAGING_DEPLOY.md)。\n