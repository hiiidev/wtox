# Milestones

## MVP: VPS native Toxcore for 2–3 trusted users

- [x] Private GitHub repository, Docker Compose skeleton
- [x] Caddy included for automatic HTTPS/WSS reverse proxy
- [x] Remove shared site password; use Tox identity session for private endpoints and WebSocket
- [x] Tox Savedata is the personal login credential (create/download or upload/import)
- [x] Remove public username/password authentication routes, retain safe legacy recovery export
- [x] Match raw Tox private-key proof rather than trust public Tox ID
- [ ] Verify Tox-only login against a running native VPS and old database migrations
- [x] AES-GCM encrypted SQLite profile storage foundation
- [x] Minimal responsive entrance/login UI
- [x] Native c-toxcore ctypes identity adapter (create/restore savedata), Docker smoke hook added
- [ ] Verified Docker build and native ABI test in GitHub Actions or clean VPS
- [x] API + browser UI for creating/importing/exporting raw Tox savedata (integration test pending)
- [x] Independent live Tox instances per account; startup/restart recovery (source implemented; live verification pending)
- [x] Add/accept friend requests, Bootstrap/relay connections, send/receive messages (source implemented; live verification pending)
- [x] Authenticated WebSocket push and reconnect (source implemented)
- [x] Seven-day encrypted pending message queue and browser ack processing (source implemented)
- [x] Browser IndexedDB AES-256-GCM histories, automatically unlocked using per-Tox-identity device keys (code implemented)
- [x] One-time safe conversion path for earlier password-encrypted history
- [ ] Verify automatic unlock and legacy history migration on real mobile/desktop browsers
- [x] Browser-local wtox JSON history export/import for another device (plaintext export; format validated)
- [x] wTox JSON history export/import with cross-identity validation (source implemented)
- [x] Remove qTox-specific history controls
- [ ] Verify aTox 0.8.x exported history schema and implement real aTox format conversion; do not label wTox JSON as native aTox format
- [ ] Optional password-encrypted portable history archive
- [ ] Confirm raw .tox identity compatibility using exported files from real aTox/qTox
- [ ] Real qTox/aTox bidirectional interoperability tests
- [ ] Security review, backup procedure and end-to-end VPS deployment tests

## Later

- [ ] Better mobile UI and PWA
- [x] Native c-toxcore file transfer send/receive/accept/download APIs and responsive UI (source code)
- [ ] Real qTox/aTox bidirectional file-transfer test and security review
- [ ] Reliability and audit work, safe database master-key rotation
- [ ] Voice/video optional
- [ ] Research: WebAssembly Toxcore browser-side identity/crypto (deferred)

## wTox current settings and CI

- [x] Tox-native nickname, status message and available/away/busy saved in Savedata
- [x] Mandatory VPS encrypted outbox for all outgoing text, without an optional browser queue switch
- [x] Backward migration of previously browser-queued messages on login
- [x] Updated API/outbox unit tests and Ant Design UI structural checks
- [ ] Verify a complete GitHub Actions build/install run and real aTox interoperability on VPS
