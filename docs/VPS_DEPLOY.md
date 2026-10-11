# VPS deploy and interop checklist

This is for the private **wtox** repository: https://github.com/hiiidev/wtox

## Requirements

- Ubuntu 24.04 LTS, recommended 1 vCPU / 2 GiB RAM / 20 GiB disk (unbenchmarked).
- Docker Engine + Compose plugin installed.
- DNS A/AAAA pointing `SITE_DOMAIN` at the VPS.
- Firewall allows inbound TCP **80/443**, outgoing TCP/UDP for the original Tox network.
- Caddy is bundled in `compose.yml`; do not install a second listener on 80/443.
- Authorize private repository access **on your VPS** using a read-only GitHub deploy key or your own approved checkout method. Never paste private keys into chat.

## Deploy

```sh
# after cloning the private repository on the VPS
cd wtox
cp .env.example .env
python3 -c 'import secrets; print(secrets.token_hex(32))'
# edit .env; set real SITE_DOMAIN, WTOX_MASTER_KEY, WTOX_ACCESS_PASSWORD
chmod 600 .env
bash scripts/deploy.sh
docker compose logs --tail=80 web caddy
```

**The generated 32-byte hex value is the encrypted database master key; back it up securely.** Never commit the real `.env` or send it to anyone.

Caddy automatically provisions HTTPS for the configured hostname and forwards WebSocket. The backend does not publish port 8000.

## Smoke tests

1. Visit `https://YOUR_DOMAIN/gate` and enter site password.
2. Register two *different* web accounts.
3. Create a fresh Tox ID in account A and download its raw `.tox` backup.
4. Attempt to import the same Tox profile into account B: must be **rejected** (duplicate identity).
5. Import a DIFFERENT raw aTox/qTox export into B; ensure the profile restores to exactly the same Tox ID.
6. In A add qTox/aTox friend (76-char Tox ID); in qTox/aTox accept request.
7. Both directions: send UTF-8 messages, confirm encrypted IndexedDB storage and 7-day pending queue clearing after browser ack.
8. Close browser for several minutes while VPS stays online; on reopening, unlock history to retrieve queued messages.
9. `docker compose restart web`; confirm identity and friend list survive restart.
10. Confirm same original Tox profile is NOT simultaneously running in aTox/qTox and wtox.

Check connection `GET /api/network` after login: 0 offline, 1 TCP relay, 2 UDP. If always offline, inspect bootstrap node values and VPS outbound network rules. Public bootstrap node lists change; see https://nodes.tox.chat/.

## Operational limitations

- Running the VPS Toxcore service lets the server read message plaintext/private Tox identity data.
- A browser closing does not disconnect VPS-side Toxcore, **provided the VPS is running**.
- No guaranteed offline delivery when VPS is down, nor when the queue expires/fills.
- Browser history belongs to the browser profile and is encrypted with a **separate local passphrase**. Losing that passphrase or clearing browser data loses local history.
- The exported raw `.tox` backup contains private keys even though profiles stored on VPS are encrypted.
- No automated backups, load tests or independent security audit have been completed.
- Native qTox/aTox compatibility is a test goal, not yet a verified result.

## Diagnostics

```sh
docker compose ps
docker compose logs --tail=100 web
docker compose logs --tail=100 caddy
docker compose exec web python -m backend.tox_identity
```

Do not publish full logs containing security tokens or private identity dumps.
