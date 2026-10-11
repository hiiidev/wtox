# Milestones

## MVP: VPS native Toxcore for 2–3 trusted users

- [x] Private GitHub repository, Docker Compose skeleton
- [x] Caddy included for automatic HTTPS/WSS reverse proxy
- [x] Shared website entrance password and signed HttpOnly cookie
- [x] Open personal account registration/login (no fixed registration cap)
- [x] AES-GCM encrypted SQLite profile storage foundation
- [x] Minimal responsive entrance/login UI
- [x] Native c-toxcore ctypes identity adapter (create/restore savedata), Docker smoke hook added
- [ ] Verified Docker build and native ABI test in GitHub Actions or clean VPS
- [x] API + browser UI for creating/importing/exporting raw Tox savedata (integration test pending)
- [ ] Independent live Tox instances per account; startup/restart recovery
- [ ] Add/accept friend requests, connect to network, send/receive messages
- [ ] Authenticated WebSocket push and reconnect
- [ ] Seven-day pending message queue and browser ack processing
- [ ] Browser encrypted IndexedDB histories
- [ ] Confirm raw .tox identity compatibility using exported files from real aTox/qTox
- [ ] Real qTox/aTox bidirectional interoperability tests
- [ ] Security review, backup procedure and end-to-end VPS deployment tests

## Later

- [ ] Better mobile UI and PWA
- [ ] File sending/receiving
- [ ] Reliability and audit work, safe database master-key rotation
- [ ] Voice/video optional
- [ ] Research: WebAssembly Toxcore browser-side identity/crypto (deferred)
