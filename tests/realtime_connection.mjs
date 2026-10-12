import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createConnectionNotice} from "../frontend/src/connection_notice.js";

const calls=[];
const timers=new Map();
let nextTimer=1;
const messageApi={
  open:options=>calls.push({type:"open",...options}),
  destroy:key=>calls.push({type:"destroy",key})
};
const schedule=(fn,ms)=>{
  const id=nextTimer++;
  timers.set(id,{fn,ms});
  return id;
};
const cancel=id=>timers.delete(id);
function advance(){
  const entries=[...timers.entries()];
  timers.clear();
  for(const [,value] of entries)value.fn();
}
const c=createConnectionNotice(messageApi,{timeoutMs:8000,schedule,cancel});

c.connecting();
assert.equal(calls.length,1);
assert.equal(calls[0].type,"loading");
assert.equal(calls[0].content,"正在连接服务器…");
assert.equal(calls[0].duration,0);
assert.equal(timers.size,1);
assert.equal([...timers.values()][0].ms,8000);

c.connecting();
c.connecting();
assert.equal(calls.length,1,"Repeated retries cannot reset the timeout or duplicate a toast");

advance();
assert.equal(calls.length,2);
assert.equal(calls[1].type,"warning");
assert.equal(calls[1].content,"实时连接暂不可用，正在后台重试");
assert.equal(calls[1].duration,4,"The failed connection notice must dismiss on its own");
assert.equal(calls[1].key,calls[0].key,"Update one existing toast, not stack notices");

c.connecting();
assert.equal(calls.length,2,"Background retries after the warning remain silent");

c.connected();
assert.equal(calls.at(-1).type,"destroy","WebSocket open must remove the notice");
assert.equal(timers.size,0);

c.connecting();
assert.equal(calls.at(-1).type,"loading");
assert.equal(calls.at(-1).content,"连接中断，正在重新连接…");
assert.equal(timers.size,1);
const count=calls.length;
c.connected();
assert.equal(calls.length,count+1);
assert.equal(timers.size,0,"Successful reconnection cancels fallback timer");

c.connecting();
c.stop();
assert.equal(timers.size,0,"Unmount must cancel all warning timers");
const afterStop=calls.length;
c.connecting();
c.connected();
advance();
assert.equal(calls.length,afterStop,"Unmounted connector must not create new toasts");

const app=readFileSync("frontend/src/App.jsx","utf8");
assert.match(app,/notice\.connecting\(\)/);
assert.match(app,/notice\.connected\(\)/);
assert.match(app,/notice\.stop\(\)/);
assert.match(app,/currentSocket\.readyState===WebSocket\.CONNECTING/);
assert.match(app,/clearTimeout\(handshakeTimeout\)/);
assert.match(app,/retry=setTimeout\(connect,3500\)/);
console.log("Bounded connection notices, cancellation and retry behavior OK");
