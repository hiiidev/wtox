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
const profileStart=app.indexOf('<AntModal open={modal==="profile"}');
const settingsStart=app.indexOf('<Drawer open={modal==="settings"}',profileStart);
assert.ok(profileStart>0&&settingsStart>profileStart);
assert.doesNotMatch(app.slice(profileStart,settingsStart),/wtox-profile-header/);
assert.match(app,/className="wt-mobile-me-page"/);
assert.match(app,/aria-label="设置"/);
assert.doesNotMatch(app,/查看并修改我的 Tox 资料/);
assert.doesNotMatch(app,/prefix=\\{<Tooltip title="添加附件">/);
assert.match(app,/className="wt-compose-tools"/);
assert.match(app,/<AntModal open=\{modal==="profile"\}/);
assert.match(app,/<Drawer open=\{modal==="settings"\}/);
assert.match(app,/<AntModal open=\{modal==="requests"\}/);
assert.doesNotMatch(app,/\{modal==="settings"&&<Drawer/);
assert.match(app,/\{selected&&<div className="ant-chat-toolbar">/);
assert.match(app,/\{selected&&<div className="ant-compose-area">/);
assert.doesNotMatch(app,/wt-settings-overview|WTOX \/ PREFERENCES|你的聊天，由你掌控/);
assert.equal(app.split("centered={isMobile}").length-1,9,
  "All mobile modals should use centered positioning");
assert.doesNotMatch(app,/<Tooltip title="好友请求"|<Tooltip title="添加好友"/);
assert.ok(refined.includes("width:40px!important;height:40px!important;min-width:40px!important;"),
  "Desktop chat header buttons should use the compact 40px control size");
assert.match(app,/useLayoutEffect\(\(\)=>\{\s*if\(!user\?\.public_key\)/);
assert.match(app,/className="wt-compose-attach-button"/);
assert.match(app,/<Sender\.Header title="准备发送附件"/);
assert.match(app,/<FileCard name=\{uploadFile\.name\}/);
assert.match(app,/onPasteFile=\{files=>/);
assert.match(app,/<Upload showUploadList=\{false\} maxCount=\{1\} className="wt-chat-file-upload"/);
assert.doesNotMatch(app,/<input type="file" hidden ref=/);
assert.match(app,/await h\.persistFile\(transfer\)/);
assert.match(app,/await h\.cacheImage\(transfer\.id/);
assert.match(app,/<FileCard name=\{file\.file_name\}/);
assert.match(app,/<Image className="wtox-attachment-image"/);
assert.ok(app.includes("await decodedImage(blob)"),
  "Preview must decode real attachment bytes, not trust filename previews");
assert.ok(app.includes("setImageCacheRevision(n=>n+1)"),
  "Outgoing image should rerender once the encrypted image cache is written");
assert.ok(app.includes("file.previewBlob"),
  "A newly sent image should be previewable during upload");
assert.doesNotMatch(app,/已由 Toxcore 完成文件传输/,
  "Completed attachment should not show redundant Toxcore text");
assert.match(app,/wt-chat-presence-badge/,
  "Friend presence should appear on the avatar");
assert.ok(!app.includes('selectedFriend&&<Badge status={peerStatusColor} text={peerStatus}/>'),
  "Do not show redundant presence text next to the friend nickname");
assert.ok(refined.includes("padding-bottom:34px!important"),
  "Leave space after the last incoming message");
const sendBody=app.slice(app.indexOf("async function sendText("),
  app.indexOf("async function addFriend("));
assert.ok(sendBody.indexOf("setMessages(previous=>[...previous,optimistic])")>=0 &&
  sendBody.indexOf("setMessages(previous=>[...previous,optimistic])") <
  sendBody.indexOf('postJson("/api/messages"'),
  "Optimistic message must enter timeline before server roundtrip");
const fileBody=app.slice(app.indexOf("async function sendFile()"),
  app.indexOf("async function controlFile("));
assert.ok(fileBody.indexOf("setPendingFiles(previous=>[...previous,optimistic])")>=0 &&
  fileBody.indexOf("setPendingFiles(previous=>[...previous,optimistic])") <
  fileBody.indexOf("await api(url"),
  "Optimistic attachment must enter timeline before file upload");
assert.ok(!app.includes('sending?"正在发送请求"'),
  "Composer must not host the outgoing send status");
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


assert.doesNotMatch(app,/friendMessageApi\.open\(/);
assert.match(app,/className="wt-mobile-request-banner"/);
assert.match(app,/duration:0/);
assert.match(app,/dismissedFriendIds\.current=signature/);
assert.match(app,/friendRequests\.length>0&&<button type="button"/);
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
assert.ok(!refined.includes(".wechat-conversation.is-selected .wechat-presence.online"),
  "Selected friend status dots must not gain a separate border");
const dotRuleStart=refined.indexOf(".wechat-conversation .wechat-presence.online{");
assert.ok(dotRuleStart>=0,"Online dot rule must exist");
const dotRule=refined.slice(dotRuleStart,refined.indexOf("}",dotRuleStart));
assert.ok(dotRule.includes("border:0!important")&&
  dotRule.includes("box-shadow:none!important")&&
  dotRule.includes("outline:0!important"),
  "Online status dots must have no border, shadow or outline");
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

assert.ok(app.includes('if(record.delivery_status==="queued")return "等待发送"'));
assert.ok(app.includes('if(record.delivery_status==="queued_local")return "正在提交"'));
assert.match(app,/record\.delivery_status\)\)return "正在发送"/);
assert.match(app,/title="连接与消息队列"/);
assert.match(app,/networkDiagnostics\?\.queued/);
assert.match(app,/await refreshOutbox\(h\);\s*for\(const row of data\.pending/);

assert.match(app,/const migrateLegacyBrowserQueue=useCallback/);
assert.match(app,/if\(!pending\.length\)return/);
assert.match(app,/await migrateLegacyBrowserQueue\(h\)/);
assert.doesNotMatch(app,/flushBrowserQueue|浏览器待发队列检查失败/);
assert.doesNotMatch(app,/<Tooltip title=\{ownStatusLabel\}>/);
assert.doesNotMatch(app,/<Tooltip title="好友请求">/);
assert.doesNotMatch(app,/<Tooltip title="添加好友">/);
assert.doesNotMatch(app,/<Tooltip title="添加附件">/);
assert.match(app,/aria-label="添加附件"/);
assert.ok(app.includes("M12 2C6.49 2 2 6.49 2 12"),"Use supplied chat SVG path");
assert.ok(app.includes("M96 128a128 128 0 1 1 256 0"),"Use the new supplied contacts SVG path");
assert.ok(app.includes('viewBox="0 0 640 512"'),"Preserve contacts 1.25:1 aspect ratio");
assert.ok(app.includes("wt-rail-glyph-contacts")&&app.includes("wt-rail-glyph-chats")&&
  app.includes("wt-rail-glyph-settings"),"Icons should have per-shape optical sizing");
assert.match(app,/title="新消息通知"[\s\S]*?extra=\{<Badge/);
assert.match(app,/title="连接与消息队列"[\s\S]*?extra=\{<Badge/);
assert.match(app,/downloadToxFile\(await response\.blob\(\)/);
const pushSettings=readFileSync("frontend/src/PushSettings.jsx","utf8");
assert.match(pushSettings,/title="离线推送（PWA）"[\s\S]*?extra=\{<Badge/);
assert.ok(!app.includes("Enter 发送 · Shift + Enter 换行"),"No shortcut hint below chat");
assert.ok(app.includes('onClick={()=>setLogoutOpen(true)}'),"Exit must require choice");
assert.ok(app.includes("清除当前身份本地数据并退出"));
assert.ok(app.includes("保留本地数据并退出"));
const railCSS=readFileSync("frontend/src/refine.css","utf8");
assert.ok(railCSS.includes(".wechat-rail-button .wt-nav-chat-badge.ant-badge"),
  "Chat's Badge wrapper must inherit selected and unselected icon color");
assert.ok(railCSS.includes("color:inherit!important"),
  "Badge must pass through the parent button's color");
assert.ok(railCSS.includes(".wt-rail-glyph-chats")&&
  railCSS.includes(".wt-rail-glyph-contacts")&&
  railCSS.includes(".wt-rail-glyph-settings.anticon"),
  "Normalize chat, contacts, and settings icons by optical dimensions");
assert.ok(railCSS.includes("width:31px!important;height:25px!important"),
  "Desktop contacts icon must keep the supplied wide aspect ratio");
assert.ok(railCSS.includes(".wechat-rail-button.is-active:hover"),
  "Active desktop nav must still have hover feedback");
assert.ok(railCSS.includes("background:transparent!important;"),
  "Selected desktop icon should have no persistent tile");
assert.ok(railCSS.includes("height:35px;min-height:35px"),
  "Login segmented control should be compact");
const toastCSS=readFileSync("frontend/src/ant-style.css","utf8");
assert.match(toastCSS,/html\[data-wtox-theme="dark"\] \.ant-message \.ant-message-notice-content/);

const darkToastStart=toastCSS.indexOf('html[data-wtox-theme="dark"] .ant-message .ant-message-notice-content{');
assert.ok(darkToastStart>0,"Dark AntD Message is styled at the HTML portal level");
const darkToast=toastCSS.slice(darkToastStart,toastCSS.indexOf("}",darkToastStart));
assert.ok(darkToast.includes("#404146")&&darkToast.includes("#313236"),
  "Dark Message should float above the chat and sidebar using a brighter surface");
assert.ok(darkToast.includes("0 22px 58px rgba(0,0,0,.64)")&&
  darkToast.includes("inset 0 1px 0 rgba(255,255,255,.11)"),
  "Dark Message needs both a clear drop shadow and a light inner rim");
for(const kind of ["success","error","warning","info","loading"]){
  assert.ok(toastCSS.includes('.ant-message-'+kind+' .anticon{'),
    "Provide legible icon contrast for "+kind+" notices");
}
assert.ok(!toastCSS.includes('html[data-wtox-theme="light"] .ant-message'),
  "Do not override the native light theme Message design");


assert.doesNotMatch(app,/<Tooltip title=\{selectedFriend\?"查看好友资料":""\}>/);
assert.doesNotMatch(app,/<Tooltip title=\{selectedFriend\?"更多操作":""\}>/);
assert.doesNotMatch(app,/aria-label="设置与备份" title="设置"/);
assert.match(refined,/button\.active \.wt-nav-chat-badge\.ant-badge/);
assert.match(refined,/height:calc\(64px \+ env\(safe-area-inset-bottom\)\)!important/);
assert.match(refined,/\.wechat-mobile-tabs button svg\{[\s\S]*?width:24px!important/);

assert.match(app,/<Drawer open={modal==="settings"} title="设置" placement="right"/);
assert.match(app,/authMode==="create"/);
assert.match(app,/options=\{\[[\s\S]*?label:"创建身份"[\s\S]*?label:"导入身份"/);
assert.match(app,/<Upload\.Dragger accept="\.tox,application\/octet-stream"/);
assert.match(app,/<Form\.Item label="密码" required>/);
assert.match(app,/<Form\.Item label="密码" extra="未设置密码的 \.tox 文件可留空">/);
assert.doesNotMatch(app,/旧版账号迁移|wtox-old-backup\.tox|备份密码/);
assert.ok(app.includes("服务器上的当前 Tox 身份、好友列表、待发送消息和附件"),
  "Logout must clearly warn that VPS identity deletion is permanent");
assert.ok(app.includes('api("/api/profile",{')&&app.includes('method:"DELETE"'),
  "Both sign-out choices must delete the server identity before client cleanup");
assert.ok(!app.includes("两种方式都会结束当前登录并尝试取消本设备的离线推送"),
  "Do not retain the obsolete session-only logout promise");
assert.ok(!app.includes("确认永久删除服务器身份？"),
  "Do not introduce secondary confirmation after the logout dialog");
assert.ok(app.includes("头像颜色及其他与该身份关联的数据"),
  "Local cleanup must describe data scoped to the selected identity");
assert.ok(!app.includes("正在连接服务器…")&&!app.includes("连接中断，正在重新连接…"),
  "Never show a persistent connection message on first load or reconnect");
assert.ok(!app.includes("wtox-server-connection"),
  "Remove all keyed realtime connection toasts");
assert.ok(app.includes("retry=setTimeout(connect,3500)"),
  "WebSocket must still silently reconnect in the background");
assert.ok(app.includes("currentSocket.readyState===WebSocket.CONNECTING"),
  "Stalled WebSocket handshakes should still be closed and retried");
assert.ok(!app.includes('className="ant-compose-status"'),
  "No additional status row should appear below the attachment button");
assert.ok(!refined.includes(".ant-compose-status"),
  "Remove styles for deleted chat composer status");
assert.ok(app.includes('<span className="wtox-boot-ring" aria-hidden="true"/>'),
  "React loading screen should keep the pre-bundle boot spinner");
assert.ok(app.includes("selectedRef.current=null;")&&app.includes("setMobileChat(false);"),
  "Mobile chat return must clear the conversation selection");
assert.match(app,/suffix=\{\(_,info\)=>\{/);
assert.match(app,/SendButton disabled=\{!draft\.trim\(\)/);
assert.match(refined,/\.wt-chat-sender button:disabled/);
const logo=readFileSync("frontend/public/logo.svg","utf8");
assert.match(logo,/<svg[\s\S]*?<path/);
assert.doesNotMatch(logo,/<image|data:image\//);

assert.match(app,/<main className="wtox-auth-layout" data-theme=\{effectiveTheme\}>/);
assert.match(app,/<section className="wtox-auth-card" aria-label="进入 wTox">/);
assert.doesNotMatch(app,/wtox-auth-intro|wtox-auth-form-panel|wtox-auth-eyebrow/);
assert.match(refined,/display:grid;place-items:center/);
assert.match(refined,/background:#f5f5f5;color:#222326;color-scheme:light/);
assert.match(refined,/background:#1e1e1f;color:#f3f3f3;color-scheme:dark/);
assert.match(refined,/\[data-theme="dark"\] \.wtox-auth-card/);
assert.doesNotMatch(refined,/linear-gradient\(143deg|\.wtox-auth-intro\{/);

assert.doesNotMatch(app,/密码只用于加密 \.tox 身份文件/);
assert.doesNotMatch(app,/wtox-auth-hint/);
assert.match(refined,/\.wtox-auth-switch \.ant-segmented-item-label\{/);
assert.match(refined,/display:flex;align-items:center;justify-content:center;[\s\S]*?width:100%;height:100%;min-height:0/);
assert.doesNotMatch(refined,/\.wtox-auth-hint\{/);
