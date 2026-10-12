import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {recoverableFriendRequests} from "../frontend/src/friend_requests.js";

const now=2_000_000_000_000;
const peer="C".repeat(64), other="D".repeat(64);
const historical={id:"old-request",type:"friend_request",at:now-1000,
  public_key:peer,text:"Can we connect?"};
let recovered=recoverableFriendRequests([historical],[],[],now);
assert.equal(recovered.length,1,
  "An old mistakenly acknowledged request stays recoverable from local encrypted history");
assert.deepEqual(recovered[0],{
  id:"old-request",public_key:peer,text:"Can we connect?",
  created:Math.floor((now-1000)/1000),recovered:true
});
assert.equal(recoverableFriendRequests([historical],
  [{id:"remote-id",public_key:peer}],[],now).length,0,
  "Live server inbox suppresses duplicate recovered entry for the same peer");
assert.equal(recoverableFriendRequests([historical],[],
  [{public_key:peer}],now).length,0,
  "Already added Tox friends must never appear as recovered requests");
assert.equal(recoverableFriendRequests([{...historical,at:now-8*86400000}],
  [],[],now).length,0,"Expired local requests must not be revived");
assert.equal(recoverableFriendRequests([{...historical,id:"malformed",public_key:"oops"}],
  [],[],now).length,0);
assert.equal(recoverableFriendRequests([
  historical,{...historical,id:"duplicate",at:now-500},
  {...historical,id:"different",public_key:other}
],[],[],now).length,2,"Deduplicate repeated requests by peer");

const app=readFileSync("frontend/src/App.jsx","utf8");
const store=readFileSync("backend/store.py","utf8");
const api=readFileSync("backend/tox_api.py","utf8");
const worker=readFileSync("frontend/public/sw.js","utf8");
assert.ok(app.includes('if(e.type==="friend_request"){') &&
  app.includes("await h.persist(e);") &&
  app.includes('}else if(e.type==="message"){'),
  "Requests must not follow the message ack path");
const requestHandler=app.slice(app.indexOf('if(e.type==="friend_request"){'),
  app.indexOf('}else if(e.type==="message"){'));
assert.ok(!requestHandler.includes('postJson("/api/ack"'),
  "Realtime request delivery cannot automatically acknowledge the server record");
assert.ok(store.includes("resolve_friend_requests: bool = False"));
assert.ok(api.includes("resolve_friend_requests=True"));
assert.ok(app.includes("recoverableFriendRequests(messages,friendRequests,friends)"));
assert.ok(app.includes('await postJson("/api/friends/accept",{public_key:item.public_key})'));
assert.ok(app.includes('refreshFriendRequests(),refreshTransfers()'),
  "PWA resume must re-fetch pending requests");
assert.ok(worker.includes('if(kind!=="test"){') &&
  worker.includes('kind === "test" ? "wTox · 测试离线通知"'),
  "Test notifications bypass foreground visibility checks");
console.log("Friend request persistence, local recovery and explicit test push verified");
