import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {alignFullThreadBottom,scrollThreadToBottom,isNearBottom}
  from "../frontend/src/thread_scroll.js";

// Mimic the browser's clamping behavior of the one scrollable .ant-thread.
function viewport(width,height,scrollHeight,start=0){
  let top=start;
  return {
    clientWidth:width,clientHeight:height,scrollHeight,
    get scrollTop(){return top},
    set scrollTop(v){top=Math.max(0,Math.min(Number(v),Math.max(0,this.scrollHeight-this.clientHeight)))}
  };
}
const hidden=viewport(0,0,1700);
assert.equal(alignFullThreadBottom(hidden),false,
  "A display:none mobile chat cannot be considered aligned");
assert.equal(hidden.scrollTop,0);
hidden.clientWidth=390;hidden.clientHeight=520;
assert.equal(alignFullThreadBottom(hidden),true,
  "Revealed mobile viewport must align to the real bottom");
assert.equal(hidden.scrollTop,1180);

const desktop=viewport(900,620,3120,240);
assert.equal(alignFullThreadBottom(desktop),true);
assert.equal(desktop.scrollTop,2500,
  "Scroll to container max, NOT the bottom of the last message bubble");
desktop.scrollHeight+=42; // footer/padding outside the final bubble
assert.equal(alignFullThreadBottom(desktop),true);
assert.equal(desktop.scrollTop,2542,
  "Trailing time/status/padding must be visible");
desktop.clientHeight=450; // iOS keyboard or compose area changed height
assert.equal(alignFullThreadBottom(desktop),true);
assert.equal(desktop.scrollTop,2712);
const tiny=viewport(320,800,180);
assert.equal(alignFullThreadBottom(tiny),true);
assert.equal(tiny.scrollTop,0,"Short chats have a real bottom of 0");
const noOp=viewport(900,400,2500);
Object.defineProperty(noOp,"scrollTop",{get:()=>0,set:()=>{}});
assert.equal(alignFullThreadBottom(noOp),false,
  "An attempted but ineffective scroll must not mark viewport ready");
scrollThreadToBottom(null);
assert.equal(isNearBottom(desktop),true);

const app=readFileSync("frontend/src/App.jsx","utf8");
const css=readFileSync("frontend/src/refine.css","utf8");
assert.ok(app.includes("alignFullThreadBottom(element)"));
assert.ok(app.includes('element.style.visibility="visible"'));
assert.ok(app.includes('style={{visibility:selected?"hidden":"visible"}}'),
  "A new peer must remain hidden until its scroll viewport has measurable size");
assert.ok(app.includes('key={selected')&&
  app.includes('mobileChat?"open":"list"'),
  "Return to an already selected mobile peer must create a fresh scroll viewport");
assert.ok(app.includes('observer.observe(element.parentElement)'),
  "React/CSS pane size must trigger a recheck");
assert.ok(app.includes('observer.observe(content)')&&app.includes('observer.observe(element)'));
assert.ok(app.includes('useLayoutEffect(()=>{\n    const element=threadEl.current;'),
  "Observer must attach before first paint, not in an after-paint effect");
assert.ok(app.includes('window.addEventListener("pageshow",ensureBottom)'));
assert.ok(app.includes("requestAnimationFrame(ensureBottom)"));
assert.ok(css.includes("overflow-anchor:none!important"));
assert.ok(css.includes("scroll-behavior:auto!important"));
assert.ok(!app.includes("setTimeout(scroll,650)")&&!app.includes("setTimeout(scroll,240)"));
console.log("Full chat viewport, hidden/mobile layouts and asynchronous height changes verified");
