import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const app=readFileSync("frontend/src/App.jsx","utf8");
const welcome=readFileSync("frontend/src/PwaPushWelcome.jsx","utf8");
const settings=readFileSync("frontend/src/PushSettings.jsx","utf8");
const html=readFileSync("frontend/index.html","utf8");
const css=readFileSync("frontend/src/refine.css","utf8");
const api=readFileSync("frontend/src/api.js","utf8");
const toast=readFileSync("frontend/src/ant-style.css","utf8");

assert.match(app,/const installedPwa=isStandalone\(\)/);
assert.match(app,/\{!installedPwa&&<Card size="small" title="新消息通知"/,
  "Ordinary in-page browser notifications must not appear in installed PWA settings");
assert.match(app,/if\(isStandalone\(\)\)return;/,
  "PWA must not trigger ordinary browser Notification");
assert.match(app,/if\(isStandalone\(\) \|\| !user\?\.public_key/,
  "Do not offer old browser notification permission in PWA");
assert.match(app,/<PwaPushWelcome userId=\{user\?\.public_key\}\/>/);
assert.match(welcome,/title="开启离线通知"/);
assert.match(welcome,/wtox-pwa-push-prompt-/);
assert.match(welcome,/if\(!userId\|\|!isStandalone\(\)\)/);
assert.match(welcome,/context\.registration\.pushManager\.subscribe\(/);
assert.match(welcome,/onClick=\{enable\}/,
  "Permission subscription must be initiated directly by click");
assert.match(settings,/开启后，即使离开应用或锁定屏幕/);
assert.doesNotMatch(settings,/VPS|iPhone|iPad|离线推送已关闭/);
assert.match(settings,/setDetail\("null"\)|setDetail\(""\)/);
assert.match(settings,/wtox-push-changed/);
assert.match(app,/notification\.useNotification/);
assert.match(app,/friendNotificationApi\.open\(/);
assert.match(app,/window\.matchMedia\("\(min-width:768px\)"\)/);
assert.match(toast,/ant-notification-notice/);

assert.match(html,/class="wtox-boot"/,
  "Display the initial spinner even before React loads");
assert.match(html,/apple-mobile-web-app-status-bar-style" content="black-translucent"/);
assert.match(css,/height:env\(safe-area-inset-top/);
assert.match(app,/AbortSignal\.timeout\(12000\)/);
assert.match(api,/getJson\(url,init=\{\}\)/);
assert.match(app,/if\(bootstrapError\)return/);
assert.match(app,/window\.history\.pushState/);
assert.match(app,/addEventListener\("popstate"/);
assert.match(app,/onTouchStart=\{onChatTouchStart\}/);
assert.match(app,/icon=\{<ArrowLeftOutlined\/>\} onClick=\{returnFromMobileChat\}/);

assert.match(app,/新备份的加密密码/);
assert.match(app,/并非验证创建身份时的旧密码/);
console.log("PWA welcome, browser notice separation, iOS safe areas/back navigation and backup password clarity OK");
