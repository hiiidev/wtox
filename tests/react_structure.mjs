import assert from "node:assert/strict";
import {readFileSync,existsSync} from "node:fs";

const app=readFileSync("frontend/src/App.jsx","utf8");
const history=readFileSync("frontend/src/history.js","utf8");
const html=readFileSync("frontend/index.html","utf8");
const css=readFileSync("frontend/src/style.css","utf8");
const docker=readFileSync("Dockerfile","utf8");
const python=readFileSync("backend/tox_api.py","utf8");
const store=readFileSync("backend/store.py","utf8");
const mgr=readFileSync("backend/session_manager.py","utf8");

for(const component of ["MainContainer","Sidebar","ConversationList","Conversation",
                        "ChatContainer","MessageList","Message","MessageInput"]){
  assert.ok(app.includes(component),"Missing ChatScope UI component: "+component);
}
for(const path of ["frontend/src/main.jsx","frontend/src/api.js","frontend/src/history.js",
                   "frontend/src/App.jsx","frontend/src/style.css","frontend/history_io.js"]){
  assert.ok(existsSync(path),"Missing React module: "+path);
}
assert.match(html,/id="root"/);
assert.match(docker,/npm run build/);
assert.match(docker,/COPY --from=frontendbuild/);
assert.match(css,/@media\(max-width:700px\)/);
assert.match(app,/setInterval\([\s\S]*?12000\)/);
assert.match(app,/setInterval\([\s\S]*?8000\)/);
assert.match(app,/visibilitychange/);
assert.match(app,/document\.visibilityState==="visible"/);
assert.match(app,/WebSocket/);
assert.match(app,/recoverPending/);
assert.match(app,/refreshOutbox/);
assert.match(app,/正在发送/);
assert.match(app,/已送达/);
assert.match(app,/offline_queue/);
assert.match(app,/onChange=\{e=>changeOfflineQueue\(e.target.checked\)\}/);
assert.match(history,/indexedDB\.open\("wtox-local-"/);
assert.match(history,/device-key-v2/);
assert.match(history,/applyOutboxStatuses/);
assert.match(python,/@router\.get\("\/api\/outbox"\)/);
assert.match(python,/@router\.put\("\/api\/settings"\)/);
assert.match(store,/encrypt\(text\.encode\("utf-8"\)\)/);
assert.match(mgr,/await asyncio\.sleep\(3\)/);
assert.ok(app.includes('const [offlineQueue,setOfflineQueue]=useState(false)'),
  "VPS offline queue must be opt-in; browser is default");
assert.ok(app.includes('delivery_status:"queued_local"'),
  "Browser-local encrypted offline queue is missing");
assert.ok(app.includes('flushBrowserQueue'),
  "Browser queue must flush while page is active");
assert.ok(app.includes('patchEvent(item.id'),
  "Browser queued send status must be updated in IndexedDB");
assert.ok(app.includes('modal==="settings"') && !app.includes('modal==="identity"') &&
  !app.includes('modal==="history"'),"Account and chat-history management must be in one settings modal");
assert.ok(app.includes('AttachmentBubble') && app.includes('wtox-attachment-image'),
  "Native Tox files should appear in chat bubbles with image preview");
assert.ok(!app.includes("MessageList.Content"),"Unsupported ChatScope MessageList.Content can render a blank page");
assert.ok(!app.includes("Message.Footer"),"Unsupported ChatScope Message.Footer can render a blank page");
assert.ok(existsSync("frontend/public/logo.svg"),"Generated wtox logo missing");
assert.ok(html.includes('href="/logo.svg"'),"Generated logo not registered as favicon");
console.log("React responsive messenger, encrypted offline queue and real-time fallback structural checks OK");
