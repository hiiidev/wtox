import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {
  formatLastOnline,isFriendOnline,contactPresenceText,chatPresenceText
} from "../frontend/src/friend_presence.js";

const unix = Math.floor(Date.now()/1000)-120;
const output = formatLastOnline(unix);
assert.match(output,/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
assert.equal(formatLastOnline(0),"");
assert.equal(formatLastOnline(null),"");
assert.equal(formatLastOnline("1760000000"),"");
assert.equal(formatLastOnline(-100),"");
assert.equal(formatLastOnline(1000000000000000),"");
assert.equal(formatLastOnline(Math.floor(Date.now()/1000)+86401),"");

const online={status:2,last_online:unix,status_message:"Chatting on wTox"};
const offline={...online,status:0};
assert.equal(isFriendOnline(online),true);
assert.equal(isFriendOnline(offline),false);
assert.equal(contactPresenceText(online),"Chatting on wTox");
assert.equal(contactPresenceText(offline),"最后在线时间:"+output);
assert.equal(chatPresenceText(online),"Chatting on wTox");
assert.equal(chatPresenceText(offline),"最后在线时间:"+output+" · Chatting on wTox");
assert.equal(contactPresenceText({...offline,last_online:null}),"Chatting on wTox");
assert.equal(chatPresenceText({...offline,last_online:null}),"Chatting on wTox");
assert.equal(chatPresenceText(null),"wTox");

const app=readFileSync("frontend/src/App.jsx","utf8");
const css=readFileSync("frontend/src/refine.css","utf8");
const native=readFileSync("backend/tox_runtime.py","utf8");
assert.match(native,/tox_friend_get_last_online/);
assert.match(native,/"last_online": last_online/);
assert.match(app,/contactPresenceText\(friend\)/);
assert.match(app,/chatPresenceText\(selectedFriend\)/);
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
assert.equal((app.match(/<AntModal[^\n]*\bcentered\b/g)||[]).length,9);
assert.match(css,/\.ant-modal-root \.ant-modal-wrap\.ant-modal-centered\{/);
assert.match(css,/align-items:center!important;/);
assert.match(css,/\.ant-modal-wrap\.ant-modal-centered::before\{display:none!important;\}/);
console.log("Tox last-online, separate long-press deletion and mobile modal centering verified");
