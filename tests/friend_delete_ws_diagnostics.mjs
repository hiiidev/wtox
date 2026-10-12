import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const app=readFileSync("frontend/src/App.jsx","utf8");
const store=readFileSync("frontend/src/history.js","utf8");
const api=readFileSync("backend/tox_api.py","utf8");

const removed=app.slice(app.indexOf("async function removeFriend()"),
  app.indexOf("async function saveOwnProfile()"));
assert.ok(removed.includes("const h=history.current"));
assert.ok(removed.includes("if(!h?.ready())"));
assert.ok(removed.includes('method:"DELETE"'));
assert.ok(removed.indexOf('method:"DELETE"')<removed.indexOf("await h.deleteConversation(publicKey)"),
  "Failed Tox deletion must not erase local history");
assert.ok(removed.includes("localDeleted=true"));
assert.ok(removed.includes("setConversationDeletePeer(publicKey)"),
  "A failed IndexedDB cleanup must remain retryable");
assert.ok(removed.includes("setMessages(previous=>previous.filter("));
assert.ok(removed.includes("setPendingFiles(previous=>previous.filter("));
assert.ok(removed.includes("drafts.current.delete(publicKey)"));
assert.ok(removed.includes("delete next[publicKey]"));
assert.ok(removed.includes("clearMobileConversation()"));
assert.ok(app.includes("将删除该 Tox 好友，同时清除当前浏览器里与其有关的加密聊天记录及图片缓存"));
assert.ok(!app.includes("本地聊天记录仍然保留"));
assert.ok(store.includes('db.transaction(["events","meta","attachments"],"readwrite")'));
assert.ok(store.includes("tombstones.put({id:\"deleted-\"+id"));
assert.ok(store.includes("attachments.delete(fileId)"));

const ws=app.slice(app.indexOf("const scheduleRetry=()=>"),
  app.indexOf("const friendTimer=setInterval("));
assert.ok(ws.includes("currentSocket.onerror=()=>"));
assert.ok(ws.includes("currentSocket.onclose=event=>"));
assert.ok(ws.includes('phase:"before_open"'));
assert.ok(ws.includes('phase:"after_open"'));
assert.ok(ws.includes("closeCode:event.code"));
assert.ok(ws.includes("wasClean:event.wasClean"));
assert.ok(ws.includes("timedOut:handshakeTimedOut"));
assert.ok(ws.includes("attempt:failures+1"));
assert.ok(ws.includes("networkError:hadSocketError"));
assert.ok(ws.includes("failures<2||failures%5===0"),
  "Avoid flooding console on every failed handshake");
assert.ok(!ws.includes("document.cookie"));
assert.ok(!ws.includes("location.href"));
assert.ok(!ws.includes("JSON.stringify(msg.data)"));
assert.ok(api.includes('wTox /ws upgrade reached application'));
assert.ok(api.includes('wTox /ws upgrade accepted'));
for(const label of ["site_access_required","tox_session_missing_or_expired","origin_host_mismatch"])
  assert.ok(api.includes(label));
assert.ok(!api.includes('_ws_log.warning(f"'),"Do not log untrusted headers or secrets");
console.log("Friend removal clears encrypted history and websocket logs are redacted and actionable");
