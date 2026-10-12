import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {
  formatLastOnline,lastOnlineText,isFriendOnline,contactPresenceText,chatPresenceText
} from "../frontend/src/friend_presence.js";

const DAY=24*60*60;
const now=Date.UTC(2026,9,13,4,0,0);
const unix=now/1000;
const timestamp=secondsAgo=>unix-secondsAgo;
const old=timestamp(8*DAY);
const exact=formatLastOnline(old,now);
assert.match(exact,/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
for(const invalid of [0,null,"1760000000",-100,1000000000000000,unix+301]){
  assert.equal(formatLastOnline(invalid,now),"");
  assert.equal(lastOnlineText(invalid,now),"");
}
assert.equal(lastOnlineText(timestamp(0),now),"近期在线");
assert.equal(lastOnlineText(timestamp(60),now),"近期在线");
assert.equal(lastOnlineText(timestamp(DAY-1),now),"近期在线");
assert.equal(lastOnlineText(timestamp(DAY),now),"1天前在线");
assert.equal(lastOnlineText(timestamp(2*DAY-1),now),"1天前在线");
assert.equal(lastOnlineText(timestamp(2*DAY),now),"2天前在线");
assert.equal(lastOnlineText(timestamp(6*DAY+86399),now),"6天前在线");
assert.equal(lastOnlineText(timestamp(7*DAY),now),"7天前在线");
assert.equal(lastOnlineText(timestamp(7*DAY+1),now),
  "最后在线："+formatLastOnline(timestamp(7*DAY+1),now));
assert.equal(lastOnlineText(old,now),"最后在线："+exact);
assert.equal(lastOnlineText(unix+60,now),"近期在线",
  "Allow a small difference between backend and browser clocks");

const online={status:2,last_online:timestamp(60),status_message:"Chatting on wTox"};
const offline={...online,status:0};
assert.equal(isFriendOnline(online),true);
assert.equal(isFriendOnline(offline),false);
assert.equal(contactPresenceText(online,now),"Chatting on wTox");
assert.equal(chatPresenceText(online,now),"Chatting on wTox");
assert.equal(contactPresenceText(offline,now),"近期在线");
assert.equal(chatPresenceText(offline,now),"近期在线 · Chatting on wTox");
const twoDays={...offline,last_online:timestamp(2*DAY)};
assert.equal(contactPresenceText(twoDays,now),"2天前在线");
assert.equal(chatPresenceText(twoDays,now),"2天前在线 · Chatting on wTox");
const older={...offline,last_online:old};
assert.equal(contactPresenceText(older,now),"最后在线："+exact);
assert.equal(chatPresenceText(older,now),"最后在线："+exact+" · Chatting on wTox");
assert.equal(contactPresenceText({...offline,last_online:null},now),"Chatting on wTox");
assert.equal(chatPresenceText({...offline,last_online:null},now),"Chatting on wTox");
assert.equal(chatPresenceText(null,now),"wTox");

const app=readFileSync("frontend/src/App.jsx","utf8");
const css=readFileSync("frontend/src/refine.css","utf8");
const native=readFileSync("backend/tox_runtime.py","utf8");
assert.match(native,/tox_friend_get_last_online/);
assert.match(native,/"last_online": last_online/);
assert.match(app,/contactPresenceText\(friend\)/);
assert.match(app,/chatPresenceText\(selectedFriend\)/);
assert.match(app,/\{lastOnlineText\(selectedFriend\.last_online\)\}/);
assert.match(app,/!online\(selectedFriend\)&&lastOnlineText\(selectedFriend\.last_online\)/);
assert.match(app,/if\(section==="contacts"\)setDeleteFriendPeer\(peer\)/);
assert.match(app,/setDeleteFriendPeer\(friend.public_key\)/);
assert.match(app,/onSelectStart=\{event=>\{if\(isMobile\)event.preventDefault\(\)\}\}/);
assert.match(app,/onDragStart=\{event=>event.preventDefault\(\)\}/);
assert.match(css,/-webkit-user-select:none!important/);
assert.match(css,/-webkit-touch-callout:none!important/);
assert.match(css,/touch-action:pan-y/);
assert.match(app,/if\(key==="delete"\)setConversationDeletePeer\(selected\)/);
assert.match(app,/if\(selectedRef.current===peer\)/);
assert.match(app,/clearMobileConversation\(\)/);
assert.match(app,/open=\{!!deleteFriendPeer\} title="删除好友"/);
assert.match(app,/const publicKey=deleteFriendPeer/);
assert.doesNotMatch(app,/setDeleteFriendOpen|deleteFriendOpen/);
assert.equal(app.split(" centered\n").length-1 +
             (app.match(/ centered\s*\w/g)||[]).length>=0,true);
assert.equal((app.match(/<AntModal[^\n]*\bcentered\b/g)||[]).length,10);
assert.match(css,/\.ant-modal-root \.ant-modal-wrap\.ant-modal-centered\{/);
assert.match(css,/align-items:center!important;/);
assert.match(css,/\.ant-modal-wrap\.ant-modal-centered::before\{display:none!important;\}/);
console.log("Tox last-online, separate long-press deletion and mobile modal centering verified");
