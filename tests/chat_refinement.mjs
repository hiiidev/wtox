import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const app=readFileSync("frontend/src/App.jsx","utf8");
const refined=readFileSync("frontend/src/refine.css","utf8");
const entry=readFileSync("frontend/src/main.jsx","utf8");
const pkg=JSON.parse(readFileSync("frontend/package.json","utf8"));

assert.ok(pkg.dependencies["@ant-design/x"]&&pkg.dependencies.antd);
assert.match(entry,/import "\.\/refine\.css"/);
assert.match(app,/visualStyle==="system"/);
assert.match(app,/matchMedia\("\(prefers-color-scheme: dark\)"\)/);
assert.match(app,/options=\{\[\{label:"跟随系统",value:"system"\}/);
assert.doesNotMatch(app,/风格只保存在当前浏览器|消息传输/);
assert.ok(app.includes('setModal("");')&&app.includes('alert("Tox 个人资料已保存")'),
  "Saving the native profile should close the popup");
const profileStart=app.indexOf('{modal==="profile"&&');
const settingsStart=app.indexOf('{modal==="settings"&&',profileStart);
assert.ok(profileStart>0&&settingsStart>profileStart);
assert.doesNotMatch(app.slice(profileStart,settingsStart),/wtox-profile-header/);
assert.match(app,/className="wt-mobile-me-page"/);
assert.match(app,/aria-label="设置"/);
assert.doesNotMatch(app,/查看并修改我的 Tox 资料/);
assert.doesNotMatch(app,/prefix=\\{<Tooltip title="添加附件">/);
assert.match(app,/className="wt-compose-tools"/);
assert.match(app,/className="wt-compose-attach-button"/);
assert.match(app,/<Sender\.Header title="准备发送附件"/);
assert.match(app,/<FileCard name=\{uploadFile\.name\}/);
assert.match(app,/onPasteFile=\{files=>/);
assert.match(app,/<input type="file" hidden ref=\{attachmentInput\}/);
assert.match(app,/await h\.persistFile\(transfer\)/);
assert.match(app,/await h\.cacheImage\(transfer\.id/);
assert.match(app,/<FileCard name=\{file\.file_name\}/);
assert.match(app,/<Image className="wtox-attachment-image"/);
assert.match(refined,/max-width:none!important/);
assert.ok(refined.includes("wt-message-outgoing") &&
  refined.includes("justify-content:flex-end"),
  "Outgoing messages should align to the right");
assert.match(refined,/background:var\(--wt-bg\)/);
assert.match(refined,/scrollbar-gutter:stable/);
console.log("System themes, settings, Sender attachments, timeline images and token-based layout checks OK");

assert.match(app,/aria-label="好友请求"/);
assert.match(app,/onClick=\{\(\)=>setModal\("requests"\)\}/);
assert.match(app,/friend\.status_message\?\.trim\(\)/);
assert.match(app,/selfAvatarText=avatarLabel\(ownProfile\.name\?\.trim\(\)\|\|"我",user\?\.public_key\)/);
assert.equal((app.match(/\{selfAvatarText\}/g)||[]).length,2);
assert.match(app,/selectedMessageIds\.size>0/);
assert.match(app,/onClickCapture=\{event=>messageSelectionClick\(event,item\.id\)\}/);
assert.match(app,/wt-empty-conversation/);
assert.match(refined,/\.wt-batch-toolbar/);
assert.match(refined,/html\[data-wtox-theme="light"\]/);
assert.match(refined,/html\[data-wtox-theme="dark"\]/);
assert.match(refined,/\.wt-message-row \.ant-bubble-content/);

assert.doesNotMatch(app,/对方离线，VPS 已准备好离线队列/);
assert.match(app,/\(f\.name\|\|""\)\.toLocaleLowerCase\(\)\.includes\(filter\.trim\(\)\.toLocaleLowerCase\(\)\)/);
assert.doesNotMatch(app,/\(f\.name\|\|""\)\+" "\+f\.public_key/);
for(const variable of ["--wt-rail","--wt-sidebar","--wt-chat","--wt-search","--wt-own-text"]){
  assert.ok(app.includes(variable),"Missing messenger palette variable: "+variable);
}
assert.match(refined,/scrollbar-gutter:stable/);
assert.match(refined,/scrollbar-color:transparent transparent/);
assert.match(refined,/\.ant-messenger\[data-theme\] \.wt-thread-shell>\.ant-thread/);
assert.match(refined,/\.ant-messenger\[data-theme\] \.wechat-conversation\.is-selected/);
assert.match(refined,/max-width:none!important;\s*margin-inline:0!important/);
assert.match(refined,/background:var\(--wt-chat\)!important/);

assert.match(app,/aria-label="更多操作"/);
assert.match(app,/label:"删除好友",danger:true/);
assert.match(app,/open=\{deleteFriendOpen&&!!selectedFriend\}/);
assert.match(app,/okButtonProps=\{\{danger:true,loading:removingFriend\}\}/);
assert.doesNotMatch(app,/if\(!selected\|\|!confirm\(/);
assert.match(app,/--wt-scroll-thumb/);
assert.match(app,/--wt-scroll-hover/);
assert.match(refined,/scrollbar-color:var\(--wt-scroll-thumb\)/);
assert.match(refined,/scrollbar-color:var\(--wt-scroll-hover\)/);
assert.match(refined,/\.wt-chat-more-button\.ant-btn/);


assert.match(app,/message\.useMessage\(\{top:24,maxCount:2\}\)/);
assert.match(app,/duration:0/);
assert.match(app,/dismissedFriendIds\.current=signature/);
assert.match(app,/aria-label="关闭好友请求提示"/);
assert.match(app,/color="#ef4444"/);
assert.match(app,/kind="chats"/);
assert.match(app,/kind="contacts"/);
assert.match(app,/kind="settings"/);
// Mobile bottom navigation intentionally retains text labels and standard icons.
assert.match(app,/className="wt-peer-profile-presence"/);
assert.match(refined,/\.wt-peer-avatar-button\.ant-btn:active/);
assert.doesNotMatch(refined,/\.wt-select-indicator/);
assert.match(app,/api\("\/api\/tox\/create",\{method:"POST",/);
assert.match(app,/password:createPassword/);
assert.match(app,/X-Tox-Password-Bytes/);
assert.match(app,/password:backupPassword/);
assert.match(app,/\/api\/profile\/export\/encrypted/);

const encryptedHistory=readFileSync("frontend/src/history.js","utf8");
assert.match(encryptedHistory,/await meta\(db,"deleted-"\+id\)/);
assert.match(encryptedHistory,/db\.transaction\(\["events","meta"\],"readwrite"\)/);
assert.match(encryptedHistory,/tx\.objectStore\("meta"\)\.put\(\{id:"deleted-"\+id/);
assert.doesNotMatch(app,/wt-select-indicator" aria-hidden/);

assert.match(app,/requestPermission\(\)/);
assert.match(app,/toggleBrowserNotifications/);
assert.match(app,/notificationPermission==="denied"/);
assert.match(app,/notifyIncoming\(e,true\)/);
assert.match(app,/notifyIncoming\(e\)/);
assert.match(app,/className="wt-conversation-bubble"/);
assert.match(refined,/\.wt-conversation-bubble \.ant-bubble-body/);
assert.match(refined,/width:max-content!important/);
assert.match(refined,/\.wechat-conversation\.is-selected \.wechat-presence\.online/);

assert.match(refined,/height:calc\(76px \+ env\(safe-area-inset-top\)\)!important/);
assert.match(refined,/\.ant-messenger\[data-theme\] \.ant-chat-avatar\{/);
assert.match(refined,/\.ant-messenger\[data-theme\] \.wechat-mobile-avatar \.ant-avatar\{/);
assert.match(refined,/\.ant-messenger\[data-theme\] \.ant-peer-title strong\{/);
assert.match(app,/size=\{40\} shape="square" gap=\{3\}/);

assert.match(app,/QRCode value=\{user\.tox_id\}/);
assert.match(app,/modal==="qrcode"/);
assert.match(app,/aria-label="显示 Tox ID 二维码"/);
assert.match(app,/message\.useMessage\(\{top:76,maxCount:4\}\)/);
assert.match(app,/uiMessageApi\.open\(\{type:level,content,duration:4\}\)/);
assert.match(app,/notificationPromptShown\.current=true/);
assert.match(app,/key:"notification-permission-invite",type:"info",duration:0/);
assert.doesNotMatch(app,/wtox-toast/);
assert.match(app,/wt-peer-profile-heading-main/);
assert.match(app,/wt-peer-profile-name/);
assert.match(refined,/\.wt-peer-profile-heading-main\{/);
assert.match(refined,/\.wt-chat-more-button\.ant-btn svg\{/);
assert.match(refined,/\.ant-mobile-back\.ant-btn:active/);
assert.match(refined,/\.wechat-mobile-tabs button svg\{/);
assert.match(refined,/\.wechat-conversation\.is-selected \.wechat-presence\.online/);
assert.match(refined,/\.wechat-conversation \.wechat-presence\.online\{[\s\S]*?outline:none!important/);
assert.equal((app.match(/<RailIcon kind="chats"\/>/g)||[]).length,3);
assert.equal((app.match(/<RailIcon kind="contacts"\/>/g)||[]).length,3);
assert.equal((app.match(/<RailIcon kind="settings"\/>/g)||[]).length,3);

assert.equal((app.match(/trigger=\{\["contextMenu"\]\}/g)||[]).length,2);
assert.match(app,/const messageMenu=item=>\(\{/);
assert.match(app,/key:"copy",label:item\.type==="file"\?"复制文件名":"复制"/);
assert.match(app,/key:"delete",label:"删除",icon:<DeleteOutlined\/>/);
assert.match(app,/key:"multi",label:"多选",icon:<CheckSquareOutlined\/>/);
assert.match(app,/open=\{!!singleDeleteId\} title="删除聊天记录"/);
assert.match(app,/onOk=\{deleteSingleMessage\}/);
assert.match(app,/await h\.deleteEvent\(item\.id\)/);
assert.match(app,/await h\.deleteCachedImage\(item\.file_id\)/);
assert.doesNotMatch(app,/onContextMenu=\{event=>\{event\.preventDefault\(\);setSelectedMessageIds/);

assert.match(app,/<span className="wechat-search-icon" aria-hidden="true">/);
assert.match(app,/<circle cx="10\.8" cy="10\.8" r="6\.7"\/>/);
assert.match(refined,/\.wechat-search \.ant-input-prefix/);
assert.doesNotMatch(app,/margin-top:-4px/);

assert.doesNotMatch(refined,/\.ant-sender-prefix/);

assert.match(app,/e\.type==="friend_profile"/);
assert.match(refined,/@supports \(-webkit-touch-callout: none\)/);
assert.match(refined,/font-size:16px!important/);
assert.match(refined,/\.ant-select-selection-search-input/);
assert.match(refined,/\.ant-sender textarea/);

assert.match(app,/unreadCountsByPeer\(messages,seen\)/);
assert.match(app,/totalUnreadForFriends\(unreadByPeer,friends\)/);
assert.match(app,/section==="chats"&&selected===friend\.public_key\?"is-selected":""/);
assert.equal((app.match(/count=\{totalUnread\} overflowCount=\{99\}/g)||[]).length,3);
assert.equal((app.match(/className="wt-nav-chat-badge"/g)||[]).length,3);
assert.match(refined,/\.wt-nav-chat-badge \.ant-badge-count/);
assert.match(app,/seenHydration\.current=\{owner:user\.public_key,initial,ready:false\}/);
assert.match(app,/selected&&mobileChat&&messages\.length/);

assert.match(app,/await recoverPending\(h\);[\s\S]*?await refreshTransfers\(\)/);
assert.match(app,/const transferTimer=setInterval\(\(\)=>\{/);
assert.match(app,/clearInterval\(transferTimer\)/);
assert.match(app,/recoverPending\(\),refreshTransfers\(\)/);
