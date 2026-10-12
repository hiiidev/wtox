import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";

// Exercise the actual service worker, not a copied notification formatter.
const handlers=new Map();
const sent=[];
const opened=[];
const forwarded=[];
let visibleClients=[];
let skippedWaiting=0,claimed=0;
const self={
  location:{origin:"https://tox.example.test"},
  skipWaiting:async()=>{skippedWaiting++},
  addEventListener:(name,handler)=>handlers.set(name,handler),
  registration:{
    showNotification:async(title,options)=>sent.push({
      title,options:JSON.parse(JSON.stringify(options))
    })
  },
  clients:{
    matchAll:async()=>visibleClients,
    openWindow:async path=>opened.push(path),
    claim:async()=>{claimed++}
  }
};
runInNewContext(readFileSync("frontend/public/sw.js","utf8"),{self,URL});

for(const kind of ["install","activate"]){
  let promise;
  const event={waitUntil:task=>{promise=task}};
  handlers.get(kind)(event);
  assert.ok(promise,`${kind} handler must wait for SW takeover`);
  await promise;
}
assert.equal(skippedWaiting,1,"An updated worker should activate without a PWA reinstall");
assert.equal(claimed,1,"An updated worker should claim open PWA windows");

async function push(kind){
  let pending;
  handlers.get("push")({
    data:{json:()=>({kind,body:"不应显示的聊天正文",name:"测试好友"})},
    waitUntil:promise=>{pending=promise}
  });
  assert.ok(pending,"Service worker must extend the push event lifetime");
  await pending;
  return sent.at(-1);
}

let notification=await push("message");
assert.equal(notification.title,"你收到了一条新消息。");
assert.deepEqual(Object.keys(notification.options).sort(),["data","tag"],
  "No body, app name, image or sender text should be added to notification content");
assert.equal(notification.options.data.url,"/");

notification=await push("friend_request");
assert.equal(notification.title,"你有好友请求。");
assert.deepEqual(Object.keys(notification.options).sort(),["data","tag"]);

notification=await push("unexpected");
assert.equal(notification.title,"你收到了一条新消息。",
  "Unknown push kinds must not reveal unexpected content");

// Foreground clients get an in-page event; never send a phone OS banner.
visibleClients=[{
  url:"https://tox.example.test/",
  visibilityState:"visible",
  postMessage:value=>forwarded.push(JSON.parse(JSON.stringify(value)))
}];
const before=sent.length;
await push("message");
await push("friend_request");
assert.equal(sent.length,before,"Visible PWA must never duplicate OS notifications");
assert.deepEqual(forwarded,[
  {type:"wtox-foreground-push",kind:"message"},
  {type:"wtox-foreground-push",kind:"friend_request"},
]);
// Hidden, closed, and cross-origin clients cannot suppress real background push.
visibleClients=[{
  url:"https://tox.example.test/",visibilityState:"hidden",
  postMessage:()=>{throw Error("Must not send to hidden client")}
}];
await push("message");
assert.equal(sent.length,before+1,"Background PWA still receives native notification");
visibleClients=[{
  url:"https://other.example/",visibilityState:"visible",
  postMessage:()=>{throw Error("Must not send to foreign origin")}
}];
await push("friend_request");
assert.equal(sent.length,before+2,"Cross-origin pages cannot suppress our push");
visibleClients=[];


let clickPromise;
let closed=false;
handlers.get("notificationclick")({
  notification:{data:{url:"/"},close:()=>{closed=true}},
  waitUntil:promise=>{clickPromise=promise}
});
await clickPromise;
assert.ok(closed,"Click should dismiss notification");
assert.deepEqual(opened,["/"],"Click should continue opening the PWA");
console.log("Generic message and friend-request Web Push copy verified");
