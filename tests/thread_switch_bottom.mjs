import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {scrollThreadToBottom,shouldFollowThreadScroll,isNearBottom}
  from "../frontend/src/thread_scroll.js";
const app=readFileSync("frontend/src/App.jsx","utf8");

const pane={scrollHeight:980,clientHeight:400,scrollTop:580};
assert.equal(isNearBottom(pane),true);
pane.scrollHeight=2450; // React renders a long next conversation at old offset.
assert.equal(isNearBottom(pane),false);
assert.equal(shouldFollowThreadScroll(pane,1500,1200),true,
  "Programmatic scroll during a peer switch cannot cancel bottom following");
scrollThreadToBottom(pane);
assert.equal(pane.scrollTop,2050,"Scroll to the end of the container, below timestamps");
assert.equal(isNearBottom(pane),true);
pane.scrollHeight=2640; // Late image/translation/footer layout.
scrollThreadToBottom(pane);
assert.equal(pane.scrollTop,2240);
pane.scrollTop=100;
assert.equal(shouldFollowThreadScroll(pane,0,1500),false,
  "Deliberately scrolling up must stop bottom-follow");
assert.equal(shouldFollowThreadScroll(pane,1300,1500),false,
  "A finished settling window must not override manual reading");
assert.equal(shouldFollowThreadScroll(pane,2000,1500),true,
  "Programmatic scroll cannot undo active peer-switch lock");

assert.ok(app.includes("const autoScrollLockUntil=useRef(0)"));
assert.ok(app.includes("settleThreadBottom(1000)"),
  "Every newly selected peer gets a layout-stabilization window");
assert.ok(app.includes("shouldFollowThreadScroll(element,autoScrollLockUntil.current)"));
assert.ok(app.includes("onTouchStart={cancelFollowForManualScroll}"));
assert.ok(app.includes("event.deltaY<0"));
assert.ok(app.includes('["ArrowUp","PageUp","Home"]'));
assert.ok(app.includes("setTimeout(scroll,650)"),
  "iOS layout may settle after two animation frames");
assert.ok(app.includes("for(const timer of scrollSettleTimers.current)clearTimeout(timer)"));
assert.ok(app.includes("if(lockMs>0){"),
  "ResizeObserver may retry scroll, but must not cancel delayed stabilization");
assert.ok(app.includes("observer.observe(content)")&&app.includes("observer.observe(element)"));
console.log("Conversation switch respects last-message footer, iOS late layout and user scroll intent");
