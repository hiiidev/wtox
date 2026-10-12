/* wTox Web Push service worker. Do not cache identity, chat or API responses. */
// Activate updated notification wording without requiring users to remove
// and reinstall their Home Screen app. Existing push subscriptions remain.
self.addEventListener("install",event=>{
  event.waitUntil(self.skipWaiting());
});
self.addEventListener("activate",event=>{
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", event => {
  event.waitUntil((async () => {
    let data = {};
    try { data = event.data?.json() || {}; } catch {}
    const kind = data.kind === "friend_request" ? "friend_request" : "message";
    // When the PWA is visible, use its in-page websocket/inbox + badges
    // instead of producing a duplicate phone/OS notification. Service workers
    // cannot keep a closed page alive; background pushes keep OS delivery.
    const windows=await self.clients.matchAll({type:"window",includeUncontrolled:true});
    const visible=windows.filter(client=>
      new URL(client.url).origin===self.location.origin&&
      client.visibilityState==="visible");
    if(visible.length){
      for(const client of visible){
        client.postMessage({type:"wtox-foreground-push",kind});
      }
      return;
    }
    // Background-only OS notification: never include plaintext message data.
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
