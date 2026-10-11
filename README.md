# wtox

Self-hosted multi-account **Web Tox** prototype using native [TokTok/c-toxcore](https://github.com/TokTok/c-toxcore), Python/FastAPI and an ordinary VPS. No Cloudflare Workers required.

**Status: early MVP / security review and end-to-end interoperability testing still required. Do not expose to untrusted users yet.**

## Scope

- Each account owns one independent native Tox identity; create a new ID or import/export raw Tox savedata (often `.tox`).
- Friends, incoming friend requests, one-to-one text messages and online state.
- HTTP API + authenticated WebSocket push; mobile-friendly static frontend.
- Encrypted savedata at rest on the VPS; seven-day encrypted delivery queue, deleted after browser acknowledgement.
- No permanent server-side chat-history database. The browser stores its local history using IndexedDB and AES-GCM, unlocked with the user's password.
- Multiple accounts in **one** process; instance-count cap for small VPS machines.
- Deliberately *not yet included*: voice/video, file transfer, encrypted aTox-specific profile formats, history migration, multi-device synchronization.

## Trust boundary

The VPS runs native Toxcore and **holds the decrypted Tox identity and message plaintext while running**. TLS secures browser ↔ VPS, but this is *not* zero-knowledge or browser-to-friend end-to-end encryption. A hostile VPS can read messages. Do not run the same Tox identity concurrently in aTox/qTox and wtox.

## First start (Docker Compose)

1. Provide an existing HTTPS/WSS terminator (e.g. your host Nginx, a managed TLS ingress or Cloudflare Tunnel) for `chat.example.com`. The backend binds **only** to VPS loopback `127.0.0.1:8000`. Direct public HTTP access is unsafe because the app uses session cookies, private Tox files and WebSocket authentication. Toxcore needs outbound UDP and/or TCP.
2. Copy `.env.example` to `.env` and generate a random 32-byte master key:

   ```sh
   cp .env.example .env
   python3 -c 'import secrets; print(secrets.token_hex(32))'
   # paste into WTOX_MASTER_KEY in .env; keep a backed-up copy OFF the VPS
   chmod 600 .env
   ```

3. `docker compose up -d --build`. Initial toxcore build may take several minutes.
4. Configure your existing TLS frontend to reverse-proxy the site and `/ws` WebSocket upgrade to `http://127.0.0.1:8000`; **do not publish port 8000**. Then open `https://chat.example.com`, create an account if `WTOX_ALLOW_SIGNUP=1`, or temporarily enable signup for the first account then disable it and restart.
5. Import a **raw unencrypted** Tox savedata file, or generate a new Tox ID. Back up the exported Tox identity.

For localhost-only development (no public TLS), use `docker compose -f compose.dev.yml up --build` then visit `http://localhost:8000` (development only; no TLS).

### Example: existing host Nginx (optional, no Caddy dependency)

If your VPS already has Nginx handling HTTPS, add a location block under its existing TLS virtual host. This is an example only; bring your own certificates and existing server configuration:

```nginx
location / {
  proxy_pass http://127.0.0.1:8000;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto https;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_read_timeout 3600;
}
```

When deploying through Cloudflare Tunnel or another existing proxy, ensure HTTPS/WSS and WebSocket upgrades work end to end. No Caddy, Worker, or extra proxy container is part of `compose.yml`.

## Pure-browser architecture research

See [docs/BROWSER_ONLY.md](docs/BROWSER_ONLY.md). Standard browsers lack unrestricted raw TCP/UDP sockets. A WebAssembly Toxcore plus WebSocket-to-Tox transport tunnel is **research**, not an implemented feature. Browser-held keys reduce VPS plaintext exposure but do not give background availability after closing the page.

## API surface (same origin)

- `POST /api/register`, `POST /api/login`, `POST /api/logout`, `GET /api/me`
- `GET /api/friends`, `POST /api/friends`, `POST /api/friends/accept`
- `POST /api/messages`, `GET /api/pending`, `POST /api/ack`
- `GET /api/profile/export`, `POST /api/profile/import` (only before a Tox identity is created for that account)
- `WS /ws` sends `message`, `friend_request`, `friend_connection`, `connection` and queued events

## Architecture

```text
Web browser (HTML/JS + encrypted IndexedDB)
    HTTPS/WSS
Your existing HTTPS ingress (not bundled)
    |
FastAPI (session cookie, accounts, short-lived encrypted delivery queue)
    |
ctypes FFI
    |
one native c-toxcore instance per user → public Tox DHT/TCP relay → qTox / aTox
```

One FastAPI/Uvicorn worker only. Do not scale it to multiple workers: each profile must have **exactly one live Toxcore instance**. On boot, active Tox profiles are loaded, with a configurable hard limit.

## Security / operational notes

- `WTOX_MASTER_KEY` is essential. Losing it loses all encrypted Tox profiles; rotating it without re-encrypting stored blobs is not supported.
- Login passwords authenticate the web account and unlock encrypted browser history; **they do not replace VPS trust**.
- Local browser history is encrypted via Web Crypto AES-GCM using a PBKDF2-derived key. Clearing site data or forgetting the password can make it inaccessible. There is no automatic historical import from aTox.
- Registration should be switched off after provisioning; a public multiuser service needs additional abuse protection, quotas, DoS resistance and independent security audit.
- A delivery queue only stores messages successfully received while the VPS-side Tox instance is online. Tox itself does not guarantee offline messages when the VPS is unavailable.
- Queue messages expire after 7 days and are capped per account. Pending items are deleted when the browser confirms local persistence.
- Bootstrap servers can change: see https://nodes.tox.chat/ and update `WTOX_BOOTSTRAP` as needed.
- Currently builds upstream c-toxcore from its default branch; pin a reviewed commit before production. Respect GPLv3 obligations if distributing linked software.

## Development / CI

`python -m compileall backend` and `python -m unittest discover -s tests` run syntax and helper tests. GitHub Actions runs these checks. Native interop requires a Linux VPS and a second real Tox client.

See [docs/MILESTONES.md](docs/MILESTONES.md) for remaining work.
