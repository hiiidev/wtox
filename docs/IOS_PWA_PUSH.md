# iPhone / Android PWA · Web Push

wTox provides an installable PWA on iOS and Android, using a shared Service Worker and Web Push backend.

- **iPhone (iOS 16.4+)**: in Safari, choose **Share → Add to Home Screen**, open wTox from its Home Screen icon, sign in and open **设置 → 离线推送（PWA） → 开启离线推送**.
- **Android (Chrome and compatible browsers)**: choose **Install app** (or **Add to Home screen**, depending on the browser) from the browser menu, launch wTox as the installed app, sign in and open **设置 → 离线推送（PWA） → 开启离线推送**.
- The offline-push settings card is deliberately **hidden in regular browser tabs**. Launch the installed standalone PWA to access it. Grant notification permission when the browser requests it after tapping the enable button; allow notifications in device settings if needed.

Desktop browsers can support Web Push, but wTox currently only surfaces the subscription control in standalone-installed PWAs for a consistent experience.

The existing browser-only notification switch is independent: it works only while the page is open. The new Web Push subscription can deliver generic new-message and friend-request notifications while the phone is locked or the web app is closed, provided the VPS, toxcore, and push service remain reachable.

## Server configuration

The Python backend uses `pywebpush`. VAPID private key is generated once at `WTOX_DATA_DIR/vapid-private.pem` and is kept on the existing persistent volume; **do not commit this private key**. Back up that file together with the rest of the data volume. Losing the key invalidates existing device subscriptions.

Set `WTOX_VAPID_SUBJECT=mailto:your-real-email@example.com` in the existing server .env if desired, before rebuilding. Keep `WTOX_MASTER_KEY` unchanged. No new ports are needed: HTTPS routes run behind the existing Caddy proxy. The container must be able to reach Apple/Firefox/Google push services over HTTPS.

For the current **Docker Caddy** deployment (the repository default `compose.yml`), back up `.env` and the persistent volumes before rebuilding:

```bash
docker compose -f compose.yml up -d --build
curl -fsS https://YOUR-DOMAIN/manifest.webmanifest
curl -fsS https://YOUR-DOMAIN/sw.js
```

**Never run `docker compose down -v`.**

## Important privacy and security behavior

- A Push subscription is associated with the currently authenticated Tox identity, not a publicly submitted user ID.
- Subscriptions are persisted in encrypted SQLite data using the existing `WTOX_MASTER_KEY`.
- Payloads only contain the type of alert; no message body, peer name, Tox public key or Tox private key.
- The settings include a test push. A successful HTTP submission is not an Apple delivery receipt.
- Disabling the subscription removes its server mapping. Signing out tries to unregister the current device before removing the Tox session; if offline, revoke the notification permission or clear the PWA data on that device.
- iOS cannot keep JavaScript running continuously in the background. Push delivery depends on the VPS's existing persistent Toxcore session.
- The PWA does not cache private chats, identity responses, or authentication APIs.
- Do not expose the database, VAPID key, or Tox identity backups.
- Push is best-effort and does not guarantee that every message will generate a delivered notification.

## Validation checklist

1. Confirm the app icon appears when added to the home screen.
2. Sign in from the installed icon and enable push using the direct button.
3. Use **发送测试通知** and lock the screen on both an iPhone and an Android device. Allow wTox notifications in system settings.
4. Send a message from another Tox client with the wTox page closed.
5. Tap a notification to reopen the app and check the normal encrypted message sync.
6. Disable push or sign out, then verify the old Tox identity receives no more push on that device.
7. Test upgrading with a backed-up volume and ensure existing Tox identities and chats remain intact.

PWA icons are generated from the original SVG by `npm run build`: PNG 180×180, 192×192, 512×512 and 1024×1024 are written into the built site. Do not manually modify the PNG artifacts; change `frontend/public/logo.svg` and regenerate.
