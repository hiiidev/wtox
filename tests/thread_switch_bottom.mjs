import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {scrollThreadToBottom,isNearBottom}
  from "../frontend/src/thread_scroll.js";

const pane={scrollHeight:980,clientHeight:400,scrollTop:580};
assert.equal(isNearBottom(pane),true);
// Newly selected conversation's DOM is already committed when layout effect
// synchronously moves to the bottom, BEFORE the browser paints it.
pane.scrollHeight=2450;
scrollThreadToBottom(pane);
assert.equal(pane.scrollTop,2050,"First visible frame ends after the last footer");
assert.equal(isNearBottom(pane),true);
// If a photo, time label or translation changes size, ResizeObserver follows.
pane.scrollHeight=2640;
scrollThreadToBottom(pane);
assert.equal(pane.scrollTop,2240);
pane.clientHeight=250;
scrollThreadToBottom(pane);
assert.equal(pane.scrollTop,2390);

const app=readFileSync("frontend/src/App.jsx","utf8");
assert.ok(app.includes('useLayoutEffect(()=>{\n    const ids=thread.map(item=>item.id)'));
assert.ok(app.includes("previous.peer!==selected"));
assert.ok(app.includes("alignFullThreadBottom(element)"),
  "The full scroll container must reach its maximum before the pane is revealed");
assert.ok(app.includes("observer.observe(content)"));
assert.ok(app.includes("observer.observe(element)"));
assert.ok(app.includes('window.visualViewport?.addEventListener("resize",ensureBottom)'));
assert.ok(!app.includes("setTimeout(scroll,240)"));
assert.ok(!app.includes("setTimeout(scroll,650)"));
assert.ok(!app.includes("setTimeout(()=>{scroll()"));
assert.ok(!app.includes("const second=requestAnimationFrame("));
assert.ok(!app.includes("scrollToLatest();\n    setSeen("),
  "Selection must not scroll the old thread before React commits the new one");
assert.ok(app.includes("onTouchMove={event=>{"));
assert.ok(app.includes("dy>10&&dy>Math.abs(dx)"),
  "Horizontal touch gestures must not pause following");
assert.ok(app.includes('onWheel={event=>{if(event.deltaY<0)noteManualUpIntent()}'));
assert.ok(app.includes("didUserScrollUp(lastThreadScrollTop.current,element.scrollTop"),
  "Following pauses only after measured upward scroll");
console.log("Peer switch aligns at bottom before paint and only real scrolling cancels follow");
