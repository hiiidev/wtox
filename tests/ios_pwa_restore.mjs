import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const app=readFileSync("frontend/src/App.jsx","utf8");
const history=readFileSync("frontend/src/history.js","utf8");
const css=readFileSync("frontend/src/refine.css","utf8");
const check=(needle,message)=>assert.ok(app.includes(needle),message||"Missing "+needle);

// Native back and custom swipe must not each navigate to a different page.
check("const swipeFallbackTimer=useRef(null)");
check("const backNavigationPending=useRef(false)");
check("if(backNavigationPending.current)return");
check("clearTimeout(swipeFallbackTimer.current);");
check("window.history.state?.wtoxChat");
check("mobileChatRef.current&&window.history.state?.wtoxChat");
check("},550);");
check('window.addEventListener("popstate",onPop)');
check('window.removeEventListener("popstate",onPop)');

// The connection spinner is inline rather than a repeating toast. It tracks
// WebSocket, not native Tox friend connectivity.
check('const [socketState,setSocketState]=useState("connecting")');
check('setSocketState("connected")');
check('setSocketState("reconnecting")');
check('setTimeout(()=>setSlowReconnect(true),10000)');
check('socketState!=="connected"&&<span className="wt-connection-indicator"');
check('slowReconnect&&<span className="wt-reconnect-label">正在重连</span>');
check('<LoadingOutlined spin aria-hidden="true"/>');
const markup=app.indexOf('className="wt-connection-indicator"');
assert.ok(markup > app.indexOf("wechat-desktop-heading"));
assert.ok(markup < app.indexOf('className="wt-list-actions"'));
assert.match(css,/\.wt-connection-indicator\{/);
assert.match(css,/\.wt-reconnect-label\{/);
assert.ok(!app.includes('message.open({content:"连接成功"'),
  "Transient connection status should never generate success toasts");

// Restore before remote catch-up: network failure must not flash an empty
// chat history while local AES-GCM history is already available.
const load=app.slice(app.indexOf('const previous=history.current'),
  app.indexOf('// Encrypted image previews are temporary browser data too'));
assert.ok(load.includes("if(restoredIdentity.current&&restoredIdentity.current!==owner){"),
  "An actual identity switch must explicitly clear the previous identity");
assert.ok(load.includes("setFriends([])")&&load.includes("setMessages([])"),
  "Do not expose previous account data when switching identities");
assert.ok(!load.includes("setHistoryReady(false);setMigrateRequired(false);setMessages([])"),
  "Do not unconditionally clear the same account during a reconnect");
assert.ok(load.indexOf("const cached=await h.read()")>=0);
assert.ok(load.indexOf("setMessages(cached)")>=0);
assert.ok(load.indexOf("setMessages(cached)") <
  load.indexOf("await recoverPending(h)"),
  "Encrypted history should render before network-dependent pending recovery");
assert.ok(load.includes("await h.readFriendsSnapshot()"));
assert.ok(load.includes("friendsSyncedIdentity.current!==owner"),
  "Do not overwrite a fresh server friend list with an old local snapshot");
assert.ok(app.includes("h.saveFriendsSnapshot(result)"));
assert.ok(app.includes("activeIdentity.current!==owner"),
  "Ignore a previous identity's network response");
assert.ok(app.includes('window.addEventListener("pageshow",wake)'));
assert.ok(app.includes('window.removeEventListener("pageshow",wake)'));
assert.ok(app.includes("Date.now()-lastMessage.current>60000"));

// The contact snapshot is AES-GCM encrypted in the existing per-identity
// IndexedDB, never copied in plain JSON to localStorage.
assert.match(history,/async function readFriendsSnapshot\(\)/);
assert.match(history,/async function saveFriendsSnapshot\(friends\)/);
const saveStart=history.indexOf("async function saveFriendsSnapshot(friends)");
const saveEnd=history.indexOf("async function persist(event)",saveStart);
const save=history.slice(saveStart,saveEnd);
assert.ok(save.includes('await cryptoSeal({friends:safe},key)'));
assert.ok(save.includes('db.transaction("meta","readwrite")'));
assert.ok(save.includes('id:"friends-snapshot",value:encrypted'));
assert.ok(!save.includes("localStorage"));
assert.ok(history.includes("readFriendsSnapshot,saveFriendsSnapshot"));
assert.ok(history.includes("status:0 // Do not show stale green online indicators"));
assert.ok(history.includes("requireKey()"));

console.log("iOS back gesture, encrypted friend snapshot, instant local history and WS spinner OK");
