# wtox

A small self-hosted multi-user browser client for the **original Tox network**.
Target deployment: **VPS + Docker Compose + Caddy HTTPS/WSS + native c-toxcore**.
No Cloudflare Worker is required.

> **Current status (prototype, unverified):** Native c-toxcore long-running sessions, friend requests, friend list/removal, one-to-one text API, WebSocket events, encrypted pending queue and browser encrypted IndexedDB history are now in source. **Docker native smoke test and real qTox/aTox interoperability have not been confirmed on an actual VPS.** Do not treat this as production-ready or deploy to untrusted users.

See [VPS installation and test plan](docs/DEPLOY.md) before attempting to run it.

## Agreed product decisions

- **One shared website access password** before any private app UI/API.
- After entering it, **any visitor who knows the password** may create their own web account; no invite list or fixed registration count.
- Each web account will own its **own independent Tox identity**, created or imported from **raw Tox savedata** (often a `.tox` export from aTox/qTox).
- Web account authentication stays separate from the shared site password; users cannot access each other's savedata.
- No fixed application-enforced number of accounts, but actual concurrent Tox sessions will be limited by VPS RAM, CPU and available ports. Rate-limits and queue-size protections still apply.
- Encrypted Tox savedata stays on VPS; message history is planned for encrypted browser IndexedDB, plus **short-lived encrypted pending message queue** on VPS. Server admins can still read plaintext while native Toxcore runs.
- 2–3 trusted users, text messaging first, no files or calls in the first phase.
- **WASM/browser-held keys deferred**, described in [browser research](docs/BROWSER_ONLY.md).

## VPS sizing

Start with **1 vCPU, 2GB RAM, 20GB SSD**, Ubuntu 24.04 (estimate, not benchmarked). Allow outbound UDP/TCP for Tox, inbound TCP 80/443 for Caddy. You only need **one** VPS for three people.

## Deploy on your own VPS (unverified interoperability)

For step-by-step instructions and a real-client test checklist see [VPS_DEPLOY.md](docs/VPS_DEPLOY.md).

### Deployment configuration

1. Set DNS of `chat.example.com` to VPS public IP. Ensure port 80/443 is reachable for Caddy's automatic certificate.
2. `cp .env.example .env`.
3. In `.env`, set `SITE_DOMAIN`, a strong `WTOX_ACCESS_PASSWORD` (minimum 16 characters), and `WTOX_MASTER_KEY` as 64 random hex characters:

   ```sh
   python3 -c 'import secrets; print(secrets.token_hex(32))'
   ```

4. Keep `.env` private (`chmod 600 .env`) and back up the master key securely off-VPS.
5. `docker compose up -d --build`. The build runs `python -m backend.tox_smoke` to check identity creation/restore, callbacks, native event loop and basic friend-list access. If this fails, **do not bypass the check**. Build success does not prove network interoperability.
6. Open `https://chat.example.com`: enter the shared website access password, register or sign into a personal account, then create or import a **raw unencrypted** Tox savedata file and download an encrypted-at-rest but **raw on export** private backup. Encrypted aTox-specific file formats and historic messages cannot be imported yet.

Caddy is a full part of `compose.yml`; it automatically obtains TLS certificates and proxies WebSocket upgrades to the internal app. The app port 8000 is *not published* to the public internet.

For local development only, run `docker compose -f compose.dev.yml up --build` and use `http://localhost:8000`. Plain HTTP must **never** be exposed publicly.

## Trust / security

- The shared site password is **not** a replacement for per-user login. Knowing it grants registration access, not access to another user's messages or profile.
- The shared password and encryption master key are loaded from server environment variables, **never embedded in frontend JavaScript**.
- The shared password must be high entropy. Rate limits reduce guessing but do not eliminate DoS risk.
- The backend stores hashed per-account passwords using Argon2, issues separate HttpOnly cookies, and encrypts Tox savedata and unclaimed message events using AES-256-GCM.
- Toxcore running on a VPS can see plaintext and hold private Tox identity keys while the account is online; this architecture is **not zero-knowledge**.
- Do **not** run the same imported Tox identity in aTox/qTox and wtox simultaneously.
- Backend must stay single-process (`uvicorn --workers 1`) if in-memory native Tox sessions are used.
- Protect VPS backups, apply updates, and never commit real `.env` files. This repository is **not** production-ready.

## API endpoints (implemented, real-network testing pending)

- `GET /gate` — site password page
- `POST /api/gate/login` — check website password, set signed entrance cookie
- `POST /api/register` — open account registration (after site password)
- `POST /api/login` / `POST /api/logout` — personal web account session
- `GET /api/me` / `GET /api/profile/status` — personal account and Tox identity status
- `POST /api/profile/create` — generate and save a new native Tox identity
- `POST /api/profile/import` — upload raw binary `.tox` savedata (up to 8 MiB, only if account has no identity)
- `GET /api/profile/export` — download raw identity backup (contains private key)
- `GET /api/network` — 0 offline / 1 TCP / 2 UDP
- `GET /api/friends`, `POST /api/friends`, `POST /api/friends/accept` — friend management
- `POST /api/messages` — direct text send to a friend public key
- `GET /api/pending`, `POST /api/ack` — encrypted pending queue with browser acknowledgement
- `WS /ws` — same-origin authenticated message/friend/connection event stream
- `GET /api/network` — per-user Tox network status
- `GET /api/friends`, `POST /api/friends`, `POST /api/friends/accept` — native friend operations
- `DELETE /api/friends/{public_key}` — remove friend and save profile
- `POST /api/messages` — send Tox one-to-one text
- `GET /api/pending`, `POST /api/ack` — encrypted temporary message delivery and ACK
- `WS /ws` — per-account authenticated messages / requests / status events
- `GET /health` — minimal container health check

See [development milestones](docs/MILESTONES.md). GitHub Actions checks Python/API tests, frontend JavaScript syntax and Compose syntax. The full native Docker build test remains to be confirmed. **Passing mocked Python tests does not prove native library interoperability.**
