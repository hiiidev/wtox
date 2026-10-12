import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";

// Exercise the actual service worker, not a copied notification formatter.
const handlers=new Map();
const sent=[];
const opened=[];
const self={
  location:{origin:"https://tox.example.test"},
  addEventListener:(name,handler)=>handlers.set(name,handler),
  registration:{
    showNotification:async(title,options)=>sent.push({
      title,options:JSON.parse(JSON.stringify(options))
    })
  },
  clients:{
    matchAll:async()=>[],
    openWindow:async path=>opened.push(path)
  }
};
runInNewContext(readFileSync("frontend/public/sw.js","utf8"),{self,URL});

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
