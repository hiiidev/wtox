# Milestones

## MVP: VPS native Toxcore for 2–3 trusted users

- [x] Private GitHub repository, Docker Compose skeleton
- [x] Caddy included for automatic HTTPS/WSS reverse proxy
- [x] Shared website entrance password and signed HttpOnly cookie
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
- [x] Browser encrypted IndexedDB histories (source implemented; browser verification pending)
- [ ] Confirm raw .tox identity compatibility using exported files from real aTox/qTox
- [ ] Real qTox/aTox bidirectional interoperability tests
- [ ] Security review, backup procedure and end-to-end VPS deployment tests

## Later

- [ ] Better mobile UI and PWA
- [ ] File sending/receiving
- [ ] Reliability and audit work, safe database master-key rotation
- [ ] Voice/video optional
- [ ] Research: WebAssembly Toxcore browser-side identity/crypto (deferred)
