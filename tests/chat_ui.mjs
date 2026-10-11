import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

async function source(path) {
  const code=readFileSync(path,"utf8");
  return import("data:text/javascript;base64,"+Buffer.from(code).toString("base64"));
}
const {isNearBottom,countNewEntries}=await source("frontend/src/thread_scroll.js");
const {avatarLabel,avatarFallbackColor,ensureAvatarColors,AVATAR_PALETTE}=
  await source("frontend/src/avatar_utils.js");

assert.equal(isNearBottom({scrollHeight:1200,clientHeight:400,scrollTop:800}),true);
assert.equal(isNearBottom({scrollHeight:1200,clientHeight:400,scrollTop:740}),true);
assert.equal(isNearBottom({scrollHeight:1200,clientHeight:400,scrollTop:600}),false);
assert.equal(isNearBottom(null),true);
assert.equal(countNewEntries(["a","b"],["a","b"]),0,
  "An updated delivery receipt should not announce a new message");
assert.equal(countNewEntries(["a","b"],["b","c"]),1);
assert.equal(countNewEntries([],["a","b","c"]),3);

assert.equal(avatarLabel("张小明","ABC"),"张");
assert.equal(avatarLabel("Alice","ABC"),"AL");
assert.equal(avatarLabel("Alice Smith","ABC"),"AS");
assert.equal(avatarLabel("", "ABC"),"A");
assert.ok(AVATAR_PALETTE.includes(avatarFallbackColor("ABC")));

const account="A".repeat(64),friendA="B".repeat(64),friendB="C".repeat(64);
const data=new Map();
const storage={
  getItem:key=>data.get(key)||null,
  setItem:(key,value)=>data.set(key,value)
};
const first=ensureAvatarColors(account,[friendA],storage,()=>2);
assert.equal(first[friendA],AVATAR_PALETTE[2]);
const second=ensureAvatarColors(account,[friendA,friendB],storage,()=>5);
assert.equal(second[friendA],AVATAR_PALETTE[2],
  "Repeated friend-list refreshes must not reshuffle avatar backgrounds");
assert.equal(second[friendB],AVATAR_PALETTE[5]);
assert.equal(ensureAvatarColors("D".repeat(64),[friendA],storage,()=>8)[friendA],
  AVATAR_PALETTE[8],"Different Tox identities need isolated avatar preferences");
assert.deepEqual(JSON.parse(data.get("wtox-avatar-colors-"+account)),second);
console.log("Chat scroll anchoring and per-friend Avatar preferences OK");

const {shouldNotifyMessage,messageNotificationId}=await source("frontend/src/message_notifications.js");
const event={id:"abc",type:"message",direction:"incoming",
  public_key:friendA,text:"Hello",created:1999};
assert.equal(shouldNotifyMessage(event),true);
assert.equal(shouldNotifyMessage({...event,direction:"outgoing"}),false);
assert.equal(shouldNotifyMessage({...event,type:"message_receipt"}),false);
assert.equal(shouldNotifyMessage(event,{isViewing:true}),false);
assert.equal(shouldNotifyMessage(event,{recovered:true,now:2_000_000}),true);
assert.equal(shouldNotifyMessage(event,{recovered:true,now:2_200_001}),false);
assert.equal(messageNotificationId(event),"abc");
assert.equal(messageNotificationId({...event,id:null}),[friendA,1999,"Hello"].join(":"));

const {unreadCountsByPeer,totalUnreadForFriends}=await source("frontend/src/unread_counts.js");
const peers=[{public_key:friendA},{public_key:friendB}];
const chatItems=[
  {type:"message",direction:"incoming",public_key:friendA,at:100},
  {type:"message",direction:"incoming",public_key:friendA,at:200},
  {type:"message",direction:"incoming",public_key:friendB,at:230},
  {type:"message",direction:"outgoing",public_key:friendB,at:240},
  {type:"file",direction:"incoming",public_key:friendB,at:245},
  {type:"message",direction:"incoming",public_key:"removed-friend",at:250}
];
const counts=unreadCountsByPeer(chatItems,{[friendA]:100});
assert.equal(counts.get(friendA),1);
assert.equal(counts.get(friendB),1);
assert.equal(totalUnreadForFriends(counts,peers),2);
assert.equal(totalUnreadForFriends(unreadCountsByPeer(chatItems,
  {[friendA]:200,[friendB]:230}),peers),0);
