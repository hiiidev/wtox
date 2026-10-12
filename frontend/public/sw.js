/* wTox Web Push service worker. Do not cache identity, chat or API responses. */
self.addEventListener("push", event => {
  event.waitUntil((async () => {
    let data = {};
    try { data = event.data?.json() || {}; } catch {}
    const kind = data.kind === "friend_request" ? "friend_request" : "message";
    // Show only the requested notification text. The OS can still display
    // the installed app name/icon as system-generated notification metadata.
    await self.registration.showNotification(
      kind === "friend_request" ? "你有好友请求。" : "你收到了一条新消息。",
      {
        tag: "wtox-push-" + kind,
        data: {url: "/"}
      }
    );
  })());
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({type: "window", includeUncontrolled: true});
    const active = windows.find(client => new URL(client.url).origin === self.location.origin);
    if (active && "focus" in active) return active.focus();
    if (self.clients.openWindow) return self.clients.openWindow("/");
  })());
});
