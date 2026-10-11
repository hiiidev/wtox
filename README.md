# wtox

A small self-hosted multi-user browser client for the **original Tox network**.
Target deployment: **VPS + Docker Compose + Caddy HTTPS/WSS + native c-toxcore**.
No Cloudflare Worker is required.

> **Current status (work in progress):** Caddy deployment, website access password, independent web accounts and encrypted SQLite profile storage foundations have been committed. A basic browser login UI exists. **The native Toxcore bridge, Tox profile create/import/export endpoints and messaging are NOT implemented yet. This is not a usable Tox chat client and must not be deployed publicly without hardening and live interop testing.**

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

## Deployment configuration (backend not yet usable for Tox)

1. Set DNS of `chat.example.com` to VPS public IP. Ensure port 80/443 is reachable for Caddy's automatic certificate.
2. `cp .env.example .env`.
3. In `.env`, set `SITE_DOMAIN`, a strong `WTOX_ACCESS_PASSWORD` (minimum 16 characters), and `WTOX_MASTER_KEY` as 64 random hex characters:

   ```sh
   python3 -c 'import secrets; print(secrets.token_hex(32))'
   ```

4. Keep `.env` private (`chmod 600 .env`) and back up the master key securely off-VPS.
5. `docker compose up -d --build` (currently a work-in-progress prototype; Tox functionality is not ready).
6. Open `https://chat.example.com`: enter the shared website access password, then register or sign into a personal account.

Caddy is a full part of `compose.yml`; it automatically obtains TLS certificates and proxies WebSocket upgrades to the internal app. The app port 8000 is *not published* to the public internet.

For local development only, run `WTOX_INSECURE_HTTP=1 docker compose -f compose.dev.yml up --build` and use `http://localhost:8000`. Plain HTTP must **never** be exposed publicly.

## Trust / security

- The shared site password is **not** a replacement for per-user login. Knowing it grants registration access, not access to another user's messages or profile.
- The shared password and encryption master key are loaded from server environment variables, **never embedded in frontend JavaScript**.
- The shared password must be high entropy. Rate limits reduce guessing but do not eliminate DoS risk.
- The backend currently stores hashed per-account passwords using Argon2, issues separate HttpOnly cookies, and encrypts Tox savedata using AES-256-GCM.
- Toxcore running on a VPS can see plaintext and hold private Tox identity keys while the account is online; this architecture is **not zero-knowledge**.
- Do **not** run the same imported Tox identity in aTox/qTox and wtox simultaneously.
- Backend must stay single-process (`uvicorn --workers 1`) if in-memory native Tox sessions are used.
- Protect VPS backups, apply updates, and never commit real `.env` files. This repository is **not** production-ready.

## Current HTTP endpoints

- `GET /gate` — site password page
- `POST /api/gate/login` — check website password, set signed entrance cookie
- `POST /api/register` — open account registration (after site password)
- `POST /api/login` / `POST /api/logout` — personal web account session
- `GET /api/me` / `GET /api/profile/status` — personal account and preliminary profile status
- `GET /health` — minimal container health check

See [development milestones](docs/MILESTONES.md). GitHub Actions runs Python syntax/tests and Compose syntax checks.
