import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {didUserScrollUp,alignFullThreadBottom,isNearBottom}
  from "../frontend/src/thread_scroll.js";

// A gesture alone is not evidence that the reader left the bottom.
assert.equal(didUserScrollUp(800,800,true),false);
assert.equal(didUserScrollUp(800,798.5,true),false);
assert.equal(didUserScrollUp(800,760,false),false);
assert.equal(didUserScrollUp(800,760,true),true);
assert.equal(didUserScrollUp(760,800,true),false);

// Delayed image and translation expansion must update the true viewport end.
const pane={clientWidth:390,clientHeight:520,scrollHeight:1200,scrollTop:680};
assert.equal(isNearBottom(pane),true);
pane.scrollHeight+=190;
assert.equal(alignFullThreadBottom(pane),true);
assert.equal(pane.scrollTop,870);
pane.clientHeight=400; // keyboard or composer size changes
assert.equal(alignFullThreadBottom(pane),true);
assert.equal(pane.scrollTop,990);

const app=readFileSync("frontend/src/App.jsx","utf8");
const css=readFileSync("frontend/src/refine.css","utf8");
assert.ok(css.includes("flex:0 0 auto!important;min-height:100%"),
  "ResizeObserver must observe content whose box grows with attachments");
assert.ok(app.includes("onImageLayoutChange={settleThreadBottom}"),
  "Decoded images recheck the full scroll container");
assert.ok(app.includes("onLoad={()=>onImageLayoutChange?.()}"));
assert.ok(css.includes(".wt-attachment-image-slot")&&
  css.includes("height:190px"),"Reserve thumbnail space before preview renders");
assert.ok(app.includes("setShowJumpToLatest(true)"),
  "Scrolling history exposes the jump-to-latest control even without new messages");
assert.ok(app.includes("manualUpIntentUntil.current=0"),
  "Changing peers and deliberate bottom jumps reset pending gestures");
console.log("Delayed image, keyboard resize and measured user scroll verified");
