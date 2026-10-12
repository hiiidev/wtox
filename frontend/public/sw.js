/* wTox Web Push service worker. Do not cache identity, chat or API responses. */
self.addEventListener("push", event => {
  event.waitUntil((async () => {
    let data = {};
    try { data = event.data?.json() || {}; } catch {}
    const kind = data.kind === "friend_request" ? "friend_request" : "message";
    await self.registration.showNotification(
      kind === "friend_request" ? "wTox · 好友请求" : "wTox · 新消息",
      {
        body: kind === "friend_request" ? "有人向你发送了好友请求" : "你收到了一条新消息",
        icon: "/icons/icon-192.png",
        badge: "/icons/icon-192.png",
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
