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
console.log("React responsive messenger, encrypted offline queue and real-time fallback structural checks OK");
