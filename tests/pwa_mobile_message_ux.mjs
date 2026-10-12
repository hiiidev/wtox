import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const app=readFileSync("frontend/src/App.jsx","utf8");
const welcome=readFileSync("frontend/src/PwaPushWelcome.jsx","utf8");
const css=readFileSync("frontend/src/refine.css","utf8");

// iOS cannot be prompted on ordinary page mount, so preload registration
// and call PushManager.subscribe synchronously on the next actual user gesture.
assert.ok(!welcome.includes("<Modal"),"No custom onboarding modal");
assert.ok(welcome.includes('document.addEventListener("click",onFirstGesture,true)'));
assert.ok(welcome.includes('document.addEventListener("keydown",onFirstGesture,true)'));
assert.ok(welcome.includes("registration.pushManager.subscribe({"));
assert.ok(welcome.includes('Notification.permission==="granted"'),
  "Already-authorized installations should restore push silently");
assert.ok(welcome.includes('Notification.permission==="denied"'),
  "Denied permission must never loop prompts");
assert.ok(welcome.includes('wtox-pwa-push-attempt-'),
  "Never repeatedly prompt one identity without another explicit settings action");
assert.ok(welcome.includes("removeListeners();"),
  "Prompt listeners should be removed after starting subscription");
assert.ok(app.includes('<PwaPushWelcome userId={user?.public_key}/>'));

// A mobile long press opens a context action menu. It does not immediately
// select a message into a batch. '多选' remains an explicit action.
const press=app.slice(app.indexOf("function startLongPress(item,event)"),
  app.indexOf("function messageSelectionClick"));
assert.ok(press.includes("if(isMobile){"));
assert.ok(press.includes("setMobileMessageMenuId(String(item.id))"));
assert.ok(!press.includes("setSelectedMessageIds(previous=>new Set([...previous,item.id]));") ||
  press.indexOf("setSelectedMessageIds(previous")>press.indexOf("}else{"),
  "Only desktop legacy long-press may enter selection directly");
assert.equal((app.match(/open=\{isMobile\?mobileMessageMenuId===String\(item\.id\):undefined\}/g)||[]).length,1);
assert.ok(app.includes('contextOpen={isMobile?mobileMessageMenuId===String(item.id):undefined}'));
assert.ok(app.includes('onContextMenu={event=>{') &&
  app.includes("event.preventDefault();setMobileMessageMenuId(String(item.id));"));
assert.ok(app.includes('if(key==="multi")setSelectedMessageIds('),
  "Multi-select is entered by explicit context menu action");
assert.ok(app.includes('document.addEventListener("pointerdown",outside,true)'));
assert.ok(app.includes('".wt-selectable-message, .wt-batch-toolbar, .ant-popconfirm, .ant-dropdown, .ant-modal"'));
assert.ok(app.includes("clearSelection();"),"Tap outside active multi-select cancels mode");
assert.ok(app.includes("Date.now()-suppressSelectionAt.current<1000"),
  "A missing synthesized tap after long press must not swallow future taps");

// Structural layout: message content is independent from wide full-date
// timestamp and translation. Both should share the same right-edge anchor.
assert.ok(app.includes("wt-message-main-stack")&&
  app.includes('wt-bubble-footer-stack'),
  "Separate original message body from meta and translation");
assert.ok(app.includes('shape="round" variant="filled"/>'));
assert.ok(!app.includes("footerPlacement={item.direction"),
  "Old AntD footer layout should not shift short outgoing bubbles left");
assert.ok(css.includes(".wt-message-outgoing>.wt-message-main-stack"));
assert.ok(css.includes(".wt-message-main-stack.out>.wt-conversation-bubble.ant-bubble"));
assert.ok(css.includes("align-items:flex-end!important")&&
  css.includes("align-self:flex-end!important"));
assert.ok(css.includes("font-variant-numeric:tabular-nums"));
console.log("Native PWA permission, mobile long-press menu and outgoing bubble alignment verified");
