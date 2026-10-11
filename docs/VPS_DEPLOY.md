# VPS deploy and interop checklist

This is for the private **wtox** repository: https://github.com/hiiidev/wtox

## Requirements

- Ubuntu 24.04 LTS, recommended 1 vCPU / 2 GiB RAM / 20 GiB disk (unbenchmarked).
- Docker Engine + Compose plugin installed.
- DNS A/AAAA pointing `SITE_DOMAIN` at the VPS.
- Firewall allows inbound TCP **80/443**, outgoing TCP/UDP for the original Tox network.
- For a host that already runs Caddy, use `compose.host-caddy.yml` and the guide in `docs/HOST_CADDY.md` (do not start Docker Caddy).
- Authorize private repository access **on your VPS** using a read-only GitHub deploy key or your own approved checkout method. Never paste private keys into chat.

## Deploy

```sh
# after cloning the private repository on the VPS
cd wtox
test -f .env || cp .env.example .env
python3 -c 'import secrets; print(secrets.token_hex(32))'
# edit .env; set real SITE_DOMAIN and WTOX_MASTER_KEY
chmod 600 .env
bash scripts/deploy.sh
docker compose -f compose.host-caddy.yml logs --tail=80 web
```

**The generated 32-byte hex value is the encrypted database master key; back it up securely.** Never commit the real `.env` or send it to anyone.

Host-native Caddy handles HTTPS/WebSocket and proxies to host-local port 6066. Never publish 6066 to the internet.

## Smoke tests

1. Visit `https://YOUR_DOMAIN/` directly. No site-entry password is required.
2. Create Tox identity A and save the downloaded raw `.tox` backup.
3. Log out, upload A's `.tox` file, and confirm it reopens exactly the same identity without a username/password.
4. Import a different raw aTox/qTox export as identity B and verify it restores the same Tox public key.
5. Check that uploading a file with only A's public key cannot authenticate as A; the private key must match.
6. In Tox identity A add qTox/aTox friend (76-char Tox ID); in qTox/aTox accept request.
7. Both directions: send UTF-8 messages, confirm encrypted IndexedDB storage and 7-day pending queue clearing after browser ack.
8. Close browser for several minutes while VPS stays online; on reopening, unlock history to retrieve queued messages.
9. Restart the running web service with the Compose file used for deployment; confirm identity and friend list survive restart.
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
docker compose -f compose.host-caddy.yml ps
docker compose -f compose.host-caddy.yml logs --tail=100 web
sudo journalctl -u caddy -n 100 --no-pager
docker compose -f compose.host-caddy.yml exec web python -m backend.tox_identity
```

Do not publish full logs containing security tokens or private identity dumps.
