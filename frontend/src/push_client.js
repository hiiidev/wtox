import {api, getJson, postJson} from "./api.js";

export function isIPhoneOrIPad() {
  return /iPad|iPhone|iPod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

export function isStandalone() {
  return window.matchMedia?.("(display-mode: standalone)")?.matches ||
    navigator.standalone === true;
}

export function supportsWebPush() {
  return window.isSecureContext &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window;
}

function base64Key(encoded) {
  const text = (encoded + "=".repeat((4 - encoded.length % 4) % 4))
    .replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(text), char => char.charCodeAt(0));
}

export async function preparePush() {
  if (!supportsWebPush()) throw new Error("此浏览器不支持 Web Push");
  if (isIPhoneOrIPad() && !isStandalone()) {
    throw new Error("请先在 Safari 中将 wTox 添加到主屏幕，再从主屏幕打开");
  }
  const registration = await navigator.serviceWorker.register("/sw.js", {scope: "/"});
  const {public_key} = await getJson("/api/push/public-key");
  const subscription = await registration.pushManager.getSubscription();
  return {registration, applicationServerKey: base64Key(public_key), subscription};
}

export async function savePushSubscription(subscription) {
  await postJson("/api/push/subscription", subscription.toJSON());
  try { localStorage.setItem("wtox-web-push-enabled", "1"); } catch {}
}

export async function disablePush(registration) {
  const subscription = await registration.pushManager.getSubscription();
  if (subscription) {
    await api("/api/push/subscription", {
      method: "DELETE",
      body: JSON.stringify({endpoint: subscription.endpoint}),
      headers: {"Content-Type": "application/json"}
    });
    await subscription.unsubscribe();
  }
  try { localStorage.setItem("wtox-web-push-enabled", "0"); } catch {}
}

/* Explicitly signing out a Tox identity must not leave its push on this phone. */
export async function disablePushBeforeLogout() {
  if (!supportsWebPush()) return;
  const registration = await navigator.serviceWorker.getRegistration("/");
  if (registration) await disablePush(registration);
}
