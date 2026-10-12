import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {activeConversationPeer,unreadCountsByPeer,totalUnreadForFriends}
  from "../frontend/src/unread_counts.js";
import {scrollThreadToBottom,isNearBottom,countNewEntries}
  from "../frontend/src/thread_scroll.js";

const a="A".repeat(64), b="B".repeat(64);
const events=[
  {id:"old",type:"message",public_key:a,direction:"incoming",at:100},
  {id:"new",type:"message",public_key:a,direction:"incoming",at:300},
  {id:"other",type:"message",public_key:b,direction:"incoming",at:400},
  {id:"sent",type:"message",public_key:a,direction:"outgoing",at:700},
];
const friends=[{public_key:a},{public_key:b}];
const seen={[a]:120,[b]:0};

function active(overrides={}) {
  return activeConversationPeer({
    selected:a,section:"chats",isMobile:false,mobileChat:false,
    pageVisible:true,...overrides
  });
}
assert.equal(active(),a,"Desktop open chat is an active conversation");
assert.equal(active({isMobile:true,mobileChat:true}),a,
  "Mobile open chat is an active conversation");
assert.equal(active({isMobile:true,mobileChat:false}),null,
  "Mobile conversation list must not mark a previously selected chat read");
assert.equal(active({pageVisible:false}),null,
  "Hidden tab must not mark new incoming messages read");
assert.equal(active({section:"contacts"}),null,
  "Contacts section is not a visible chat");
assert.equal(active({selected:null}),null);

let counts=unreadCountsByPeer(events,seen,active());
assert.equal(counts.get(a)||0,0,"Active desktop chat has no red badge");
assert.equal(counts.get(b),1,"Another conversation remains unread");
assert.equal(totalUnreadForFriends(counts,friends),1,
  "Main chat badge excludes messages in the current conversation");
counts=unreadCountsByPeer(events,seen,active({pageVisible:false}));
assert.equal(counts.get(a),1,"Hidden chat retains unread messages");
counts=unreadCountsByPeer(events,seen,active({isMobile:true,mobileChat:false}));
assert.equal(counts.get(a),1,"Mobile chat list retains unread messages");
counts=unreadCountsByPeer(events,seen,active({isMobile:true,mobileChat:true}));
assert.equal(counts.get(a)||0,0);
assert.equal(totalUnreadForFriends(counts,friends),1);
assert.equal(countNewEntries(["old","new"],["old","new"]),0);
assert.equal(countNewEntries(["old"],["old","new"]),1);

const container={scrollHeight:1200,clientHeight:400,scrollTop:0};
scrollThreadToBottom(container);
assert.equal(container.scrollTop,800,"Scroll to the actual maximum including footer");
assert.equal(isNearBottom(container),true);
container.scrollHeight=1540; // translated footer or image expanded after paint
scrollThreadToBottom(container);
assert.equal(container.scrollTop,1140);
container.clientHeight=240; // virtual keyboard opens on mobile
scrollThreadToBottom(container);
assert.equal(container.scrollTop,1300);
container.scrollHeight=100;container.clientHeight=300;
scrollThreadToBottom(container);
assert.equal(container.scrollTop,0,"Short conversation cannot scroll negative");
scrollThreadToBottom(null);

const app=readFileSync("frontend/src/App.jsx","utf8");
assert.ok(app.includes("unreadCountsByPeer(messages,seen,activeChatPeer)"));
assert.ok(app.includes("section===\"chats\"&&<span className=\"wechat-conversation-side\""),
  "Contacts cards must not contain a chat-timestamp column");
assert.ok(!app.includes("selected&&mobileChat&&messages.length"),
  "Legacy mobile-only mark-as-read effect must be gone");
assert.ok(app.includes('document.addEventListener("visibilitychange",refresh)'));
assert.ok(app.includes("observer.observe(content)")&&app.includes("observer.observe(element)"));
assert.ok(app.includes('window.visualViewport?.addEventListener("resize",ensureBottom)'));
assert.ok(app.includes("alignFullThreadBottom(element)"),
  "Actual full-container bottom is measured before the new viewport is shown");
assert.ok(!app.includes("setTimeout(scroll,650)") && !app.includes("const second=requestAnimationFrame("),
  "Initial bottom alignment must happen synchronously before first paint");
assert.ok(!app.includes("requestAnimationFrame(scrollToLatest)"),
  "Do not scroll the previous conversation before React renders the new one");
console.log("Desktop/mobile read state, contacts dates, real bottom and late layout verified");
