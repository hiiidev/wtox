import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {realtimeRetryDelay,realtimeConnectionState}
  from "../frontend/src/realtime_backoff.js";

assert.equal(realtimeRetryDelay(0),3500);
assert.equal(realtimeRetryDelay(1),3500);
assert.equal(realtimeRetryDelay(2),7000);
assert.equal(realtimeRetryDelay(3),14000);
assert.equal(realtimeRetryDelay(4),28000);
assert.equal(realtimeRetryDelay(5),56000);
assert.equal(realtimeRetryDelay(6),60000);
assert.equal(realtimeRetryDelay(100),60000);
assert.equal(realtimeConnectionState(1),"reconnecting");
assert.equal(realtimeConnectionState(2),"reconnecting");
assert.equal(realtimeConnectionState(3),"polling");
assert.equal(realtimeConnectionState(100),"polling");

const app=readFileSync("frontend/src/App.jsx","utf8");
const backend=readFileSync("backend/tox_api.py","utf8");
assert.ok(app.includes("const scheduleRetry=()=>{"));
assert.ok(app.includes("failures++;"));
assert.ok(app.includes("setSocketState(realtimeConnectionState(failures))"));
assert.ok(app.includes("retry=setTimeout(connect,realtimeRetryDelay(failures))"));
assert.ok(app.includes('setSocketState("connected")'));
assert.ok(app.includes("failures=0;"));
assert.ok(app.includes('polling?"轮询中":"正在重连"'));
assert.ok(app.includes('socketState==="polling"'));
assert.ok(app.includes("<DisconnectOutlined"));
assert.ok(app.includes("const friendTimer=setInterval("));
assert.ok(app.includes("const pendingTimer=setInterval("));
assert.ok(app.includes("const wake=()=>{"));
assert.ok(app.includes('window.addEventListener("pageshow",wake)'));
assert.ok(app.includes("clearTimeout(retry);retry=null;"));
assert.ok(!app.includes("retry=setTimeout(connect,3500)"),
  "A permanently blocked websocket must not retry every 3.5 seconds");
for(const reason of [
  "site_access_required","tox_session_missing_or_expired","origin_host_mismatch"
])assert.ok(backend.includes(reason));
assert.ok(!backend.includes("_ws_log.warning(f"),
  "Never log untrusted Origin/Cookie values");
console.log("Websocket exponential backoff, HTTP polling fallback and safe diagnostics OK");
