# Cross-runtime wTox v1 protocol

Pure TypeScript APIs and envelope shape validation, shared by Cloudflare
Workers and self-hosted Node.js. No Cloudflare or Node.js runtime imports.

`mailbox.ts`: 7-day ciphertext TTL, 500 pending cap, 100-message read cap,
message-ID validation and `MailboxStore` interface.

`router.ts`: stable health/capabilities API and explicit HTTP 501 stubs
for all security-sensitive operations. Public API parity does not imply
authorization or encryption has been implemented.
