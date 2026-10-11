# Milestones

## Stage 1: native bridge, authentication and UI (work in progress)

- [x] Create private repository and bootstrap architecture
- [x] Native c-toxcore FFI integration source
- [x] Account storage / encrypted savedata design
- [x] Friend/message REST and WebSocket endpoints
- [x] Minimal responsive browser UI and encrypted IndexedDB history
- [ ] Build Docker image in CI and verify library ABI
- [ ] qTox/aTox live two-way interop test
- [ ] Thorough security review / tests on a clean VPS

## Stage 2: hardening

- [ ] Stable upstream toxcore commit pin and upgrade workflow
- [ ] Password-reset/recovery design that does not expose private keys
- [ ] Stronger anti-abuse rate limits, quotas, resource isolation
- [ ] Robust multi-user restart/queue recovery testing and long-run soak tests
- [ ] Browser history export / import and password changes
- [ ] Optional per-user encrypted message queue with user-controlled keys

## Stage 3

- [ ] Files, images, notifications, voice/video
- [ ] Better mobile UI / PWA
- [ ] Profile formats beyond raw tox savedata (including aTox variants if needed)
